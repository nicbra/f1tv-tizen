/*
 * MPEG-TS on Shaka without freezing the page (2026-11-22). F1's Tiledmedia offer (player_tm) is AES-128 TS: 11 MB
 * per 5.76 s at 2160p. Shaka turns each segment into MP4 on the page's thread (~480 ms on the QE55Q77A), and reads
 * the whole segment once more just for its first time stamp. Key presses waited up to 484 ms (p95 276 ms).
 *
 * 1. Shaka's own TsTransmuxer runs in a worker (ts-worker.js), behind a transmuxer plugin of the highest priority.
 *    Same code, same output; the segment is handed over (transferred), not copied, where nothing else reads it.
 * 2. Shaka's TsParser reads only the first PES header for the start time, and skips the ID3 scan when the
 *    segment has no packet on an ID3 stream (F1 declares one and leaves it empty). Anything else still gets
 *    Shaka's full parse.
 * Measured with prototypes of both: key presses p95 4 ms, max 36 ms; no task over 50 ms; 2160p 5.1, 0 dropped.
 *
 * If the worker can't start or fails, Shaka's own transmuxer on the page takes over for the rest of the app's run.
 */
var TsOffload = (function () {
  var READY_MS = 15000;     // the worker's start (reading and running Shaka's 600 KB once)
  var SEGMENT_MS = 20000;   // one segment (the TV took ~0.5 s for 11 MB)
  var worker = null, ready = null, disabled = false, why = '', seq = 0, ids = 0, waiting = {};
  var counts = { segments: 0, transferred: 0, copied: 0, local: 0, failures: 0, lazyStarts: 0, fullParses: 0, ms: 0, maxMs: 0,
    lastError: '' };

  function note(what, data) { try { if (typeof Diag !== 'undefined') Diag.note(what, data, 'info'); } catch (e) { /* no log */ } }

  // -- the worker --

  function source() {
    var relative = 'vendor/shaka-player.compiled.js';
    return new Promise(function (resolve, reject) {
      // A downloaded bundle: checked against its signed manifest (shell/boot.js), like the worker itself.
      if (typeof Launcher !== 'undefined' && Launcher.file) {
        return Launcher.file(relative, function (err, bytes) {
          if (err) return reject(err);
          try { resolve(new TextDecoder('utf-8').decode(bytes)); } catch (e) { reject(e); }
        });
      }
      var x = new XMLHttpRequest();
      x.open('GET', relative);
      x.onload = function () { if (x.status === 200 || (x.status === 0 && x.responseText)) resolve(x.responseText); else reject(new Error('HTTP ' + x.status)); };
      x.onerror = function () { reject(new Error('Shaka not readable')); };
      x.send();
    });
  }

  function giveUp(reason) {
    if (disabled) return;
    disabled = true;
    why = String(reason || 'failed').slice(0, 120);
    note('player.ts_worker_off', { reason: why });
    var w = worker;
    worker = null;
    try { if (w) w.terminate(); } catch (e) { /* gone already */ }
    Object.keys(waiting).forEach(function (k) {
      var cb = waiting[k];
      delete waiting[k];
      try { cb({ err: { stopped: true, message: why } }); } catch (e) { /* each waiter settles itself */ }
    });
  }

  function start() {
    if (ready) return ready;
    ready = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('TS worker start timed out')); }, READY_MS);
      try {
        worker = typeof Launcher !== 'undefined' && Launcher.worker ? Launcher.worker('js/ts-worker.js') : new Worker('js/ts-worker.js');
      } catch (e) { clearTimeout(timer); return reject(e); }
      worker.onerror = function (ev) {
        var message = 'TS worker error: ' + ((ev && ev.message) || '');
        clearTimeout(timer);
        reject(new Error(message));
        giveUp(message);
      };
      worker.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.op === 'ready') {
          clearTimeout(timer);
          return m.err ? reject(new Error(m.err.message)) : resolve(true);
        }
        var key = m.op === 'stats' ? 'stats' : m.seq, cb = waiting[key];
        if (cb) { delete waiting[key]; try { cb(m); } catch (e) { /* the waiter settles itself */ } }
      };
      source().then(function (text) {
        if (worker) worker.postMessage({ op: 'init', source: text });
      }, function (e) { clearTimeout(timer); reject(e); });
    });
    ready.catch(function (e) { giveUp(e && e.message); });
    return ready;
  }

  // -- the plugin --

  /**
   * Plain values of an object (what a worker can receive): Shaka's stream and segment reference hold Maps and functions.
   * `drmInfos` stays an (empty) list: Shaka marks AES-128 HLS streams `encrypted` and its transmuxer then reads
   * drmInfos.length (only streams without DRM infos go to the worker).
   */
  function plain(o) {
    var c = { drmInfos: [] };
    for (var k in o) {
      var v = o[k];
      if (v == null || /^(string|number|boolean)$/.test(typeof v)) c[k] = v;
    }
    return c;
  }

  /** The names Shaka's build gives SegmentReference.getUris (the minified one is what its transmuxer calls). */
  function uriNames(reference) {
    var names = [], proto = reference && Object.getPrototypeOf(reference);
    if (!proto || typeof proto.getUris !== 'function') return ['getUris'];
    Object.getOwnPropertyNames(proto).forEach(function (k) { if (proto[k] === proto.getUris) names.push(k); });
    return names;
  }

  /**
   * Shaka's own error where the worker had one, else Shaka's "transmuxing failed" (3018). A worker that stopped (not the
   * segment's fault) says "TS worker stopped" in the error's first data field, which app.js treats as no verdict on the
   * stream's route.
   */
  function errorFrom(err, uri) {
    counts.lastError = String((err && (err.message || err.code)) || 'failed').slice(0, 200);
    if (err && err.code) return new shaka.util.Error(err.severity, err.category, err.code, (err.data && err.data[0]) || uri);
    if (err && err.stopped) return new shaka.util.Error(2, 3, 3018, 'TS worker stopped: ' + counts.lastError, uri);
    return new shaka.util.Error(2, 3, 3018, uri, counts.lastError);   // CRITICAL, MEDIA, TRANSMUXING_FAILED
  }

  /** The segment's bytes may be handed over: nothing else of Shaka's still holds them (a reference's own copy). */
  function exclusive(u8, reference) {
    if (u8.byteOffset !== 0 || u8.byteLength !== u8.buffer.byteLength) return false;
    var own = null;
    try { own = typeof reference.getSegmentData === 'function' ? reference.getSegmentData() : null; } catch (e) { return false; }
    return !own || (own !== u8.buffer && own.buffer !== u8.buffer);
  }

  function WorkerTs(mime) {
    this.mime = mime;
    this.local = new shaka.transmuxer.TsTransmuxer(mime);   // support checks, codec names, and the fallback
    this.id = 0;   // given at the first segment: Shaka also builds one just to ask isSupported
    this.destroyed = false;
  }
  WorkerTs.prototype.isSupported = function (mimeType, contentType) { return this.local.isSupported(mimeType, contentType); };
  WorkerTs.prototype.convertCodecs = function (contentType, mimeType) { return this.local.convertCodecs(contentType, mimeType); };
  WorkerTs.prototype.getOriginalMimeType = function () { return this.local.getOriginalMimeType(); };
  WorkerTs.prototype.destroy = function () {
    this.destroyed = true;
    if (this.id && worker) worker.postMessage({ op: 'destroy', id: this.id });
    this.local.destroy();
  };
  WorkerTs.prototype.transmux = function (data, stream, reference, duration, contentType) {
    var self = this;
    // Streams with DRM infos (sample encryption the transmuxer describes in the MP4) stay on the page.
    if (disabled || !reference || (stream.drmInfos && stream.drmInfos.length)) return this.localTransmux(data, stream, reference, duration, contentType);
    return start().then(function () {
      if (self.destroyed) return Promise.reject(new shaka.util.Error(1, 7, 7000));   // RECOVERABLE, PLAYER, LOAD_INTERRUPTED
      if (disabled) return self.localTransmux(data, stream, reference, duration, contentType);
      if (!self.id) self.id = ++ids;
      var u8 = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      // Handed over when only this call reads it: a video segment (audio muxed in video comes in the same call) whose
      // whole buffer is Shaka's download, not a reference's cached copy. Otherwise a copy goes, and Shaka's stays.
      var hand = contentType === 'video' && exclusive(u8, reference);
      var buf = hand ? u8.buffer : u8.slice().buffer;
      counts[hand ? 'transferred' : 'copied']++;
      var n = ++seq, uris = reference.getUris(), uri = uris[0] || null;
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { giveUp('segment timed out'); }, SEGMENT_MS);
        waiting[n] = function (m) {
          clearTimeout(timer);
          try {
            // The worker stopped under this segment: Shaka's own transmuxer does it, if its bytes are still here.
            if (m.err && m.err.stopped && !hand) return resolve(self.localTransmux(data, stream, reference, duration, contentType));
            if (m.err) { counts.failures++; return reject(errorFrom(m.err, uri)); }
            counts.segments++; counts.ms += m.ms || 0; counts.maxMs = Math.max(counts.maxMs, m.ms || 0);
            Object.keys(m.learned || {}).forEach(function (k) { stream[k] = m.learned[k]; });
            resolve(new Uint8Array(m.out));
          } catch (e) { reject(e); }
        };
        try {
          worker.postMessage({ op: 'transmux', seq: n, id: self.id, mime: self.mime, data: buf, duration: duration,
            contentType: contentType, stream: plain(stream),
            ref: { fields: plain(reference), uris: uris, uriNames: uriNames(reference) } }, [buf]);
        } catch (e) {
          delete waiting[n];
          clearTimeout(timer);
          giveUp('post: ' + e.message);
          if (!hand) resolve(self.localTransmux(data, stream, reference, duration, contentType));
          else reject(errorFrom({ stopped: true, message: e.message }, uri));
        }
      });
    }, function () {
      return self.localTransmux(data, stream, reference, duration, contentType);
    });
  };
  WorkerTs.prototype.localTransmux = function (data, stream, reference, duration, contentType) {
    counts.local++;
    return this.local.transmux(data, stream, reference, duration, contentType);
  };

  // -- the start time without parsing the whole segment --

  var VIDEO_TYPES = { 0x1b: true, 0x24: true };                                   // H.264, HEVC
  var AUDIO_TYPES = { 0x0f: true, 0x11: true, 0x81: true, 0x87: true, 0x03: true, 0x04: true };   // AAC, LATM, AC-3, E-AC-3, MP3

  /**
   * One walk over the packets' 4-byte headers. Returns null where Shaka's own full parse must decide: not plain 188-byte
   * packets from the first byte, no PAT and PMT before the first elementary-stream packet (Shaka then uses PIDs from an
   * earlier segment, or revisits packets that came before the PMT), or (audio) private streams Shaka may take as audio.
   * Else { prefix: bytes up to the end of the first PES of the wanted kind (-1 if none), id3: whether a packet of an
   * ID3 stream (0x15) appears }. With `metadataOnly` it walks the whole segment for ID3 packets.
   */
  function scan(d, kind, metadataOnly) {
    var pmt = -1, ready = false, want = -1, starts = 0, id3 = {}, sawId3 = false, privateStream = false, prefix = -1;
    if (!d || d.length < 188 || d[0] !== 0x47) return null;
    for (var i = 0; i + 188 <= d.length; i += 188) {
      if (d[i] !== 0x47) return null;
      var pusi = d[i + 1] & 0x40, pid = ((d[i + 1] & 0x1f) << 8) | d[i + 2], afc = (d[i + 3] & 0x30) >> 4;
      if (pid === 0x11 || pid === 0x1fff) continue;
      var p = afc > 1 ? i + 5 + d[i + 4] : i + 4;
      if (pid === 0) {
        if (pusi && afc !== 2 && p < i + 188) { p += d[p] + 1; if (p + 12 <= i + 188) pmt = ((d[p + 10] & 0x1f) << 8) | d[p + 11]; }
        continue;
      }
      if (pid === pmt) {
        if (!pusi || afc === 2 || p >= i + 188) continue;
        p += d[p] + 1;
        if (p + 12 > i + 188) return null;
        var end = p + 3 + (((d[p + 1] & 0x0f) << 8) | d[p + 2]) - 4;
        if (end > i + 188) return null;   // a PMT over several packets: Shaka's
        var q = p + 12 + (((d[p + 10] & 0x0f) << 8) | d[p + 11]);
        while (q + 5 <= end) {
          var type = d[q], es = ((d[q + 1] & 0x1f) << 8) | d[q + 2];
          if (type === 0x15) id3[es] = true;
          else if (type === 0x06) privateStream = true;
          else if (want < 0 && (kind === 'video' ? VIDEO_TYPES[type] : AUDIO_TYPES[type])) want = es;
          q += 5 + (((d[q + 3] & 0x0f) << 8) | d[q + 4]);
        }
        ready = true;
        continue;
      }
      if (!ready) return null;
      if (id3[pid]) { sawId3 = true; continue; }
      if (pid === want && pusi && ++starts === 2 && prefix < 0) {
        prefix = i;
        if (!metadataOnly) break;
      }
    }
    if (!ready || (kind === 'audio' && privateStream)) return null;
    return { prefix: want < 0 ? -1 : prefix < 0 ? d.length : prefix, id3: sawId3 };
  }

  function lazyParser() {
    var P = shaka.util.TsParser && shaka.util.TsParser.prototype;
    if (!P || P.f1Lazy || typeof P.parse !== 'function' || typeof P.getStartTime !== 'function' || typeof P.getMetadata !== 'function') return;
    var parse = P.parse, clearData = P.clearData, getStartTime = P.getStartTime, getMetadata = P.getMetadata;
    // The segment as Shaka would have parsed it. After a prefix parse its data lists go first; the PIDs and time stamp
    // history it learned stay, as after any of Shaka's own clearData().
    function full(self) {
      if (!self.f1Raw) return;
      var raw = self.f1Raw;
      self.f1Raw = null;
      if (self.f1Prefix) clearData.call(self);
      self.f1Prefix = false;
      counts.fullParses++;
      parse.call(self, raw);
    }
    // Whatever else is asked (the transmuxer's own parser, codecs, NAL units): the full parse first.
    Object.getOwnPropertyNames(P).forEach(function (k) {
      var f = P[k];
      if (typeof f !== 'function' || /^(constructor|parse|clearData|getStartTime|getMetadata)$/.test(k)) return;
      P[k] = function () { if (!this.f1Inside) full(this); return f.apply(this, arguments); };
    });
    P.parse = function (data) {
      full(this);   // an earlier segment given without clearData: parsed as Shaka would have (never in Shaka 4.12)
      this.f1Raw = data;
      this.f1Prefix = false;
      return this;
    };
    P.clearData = function () { this.f1Raw = null; this.f1Prefix = false; return clearData.apply(this, arguments); };
    // Shaka's own parser, on the segment up to the end of its first PES of that kind (its start time is that PES's).
    P.getStartTime = function (contentType) {
      if (this.f1Raw && !this.f1Prefix && (contentType === 'video' || contentType === 'audio')) {
        var s = scan(this.f1Raw, contentType, false);
        if (s && s.prefix > 0) {
          this.f1Prefix = true;
          counts.lazyStarts++;
          parse.call(this, this.f1Raw.subarray(0, Math.min(this.f1Raw.length, Math.max(s.prefix, 752))));
          // Shaka's getStartTime reads its PES lists through the methods wrapped above: on the prefix, not the segment.
          this.f1Inside = true;
          try { return getStartTime.apply(this, arguments); } finally { this.f1Inside = false; }
        }
      }
      full(this);
      return getStartTime.apply(this, arguments);
    };
    // Shaka's metadata is the segment's ID3 packets: none when the PMT came first and no packet is on an ID3 stream.
    P.getMetadata = function () {
      if (this.f1Raw) {
        var s = scan(this.f1Raw, 'video', true);
        if (s && !s.id3) return [];
      }
      full(this);
      return getMetadata.apply(this, arguments);
    };
    P.f1Lazy = true;
  }

  function install() {
    if (typeof shaka === 'undefined' || !shaka.transmuxer || !shaka.transmuxer.TsTransmuxer || !shaka.util || !shaka.util.TsParser) return false;
    lazyParser();
    var E = shaka.transmuxer.TransmuxerEngine;
    if (typeof Worker === 'undefined' || !E || !E.registerTransmuxer || !E.PluginPriority) return false;
    E.registerTransmuxer('video/mp2t', function () { return new WorkerTs('video/mp2t'); }, E.PluginPriority.APPLICATION);
    return true;
  }

  var installed = false;
  try { installed = install(); } catch (e) { note('player.ts_worker_off', { reason: 'install: ' + e.message }); }

  return {
    installed: function () { return installed; },
    /** For DevTools: counts on the page, and the worker's own when asked with { worker: true } (a promise then). */
    status: function (opts) {
      var s = Object.assign({ installed: installed, started: !!worker, disabled: disabled, reason: why,
        avgMs: counts.segments ? Math.round(counts.ms / counts.segments) : 0 }, counts);
      if (!(opts && opts.worker) || !worker) return s;
      return new Promise(function (resolve) {
        var timer = setTimeout(function () { delete waiting.stats; resolve(s); }, 2000);
        waiting.stats = function (m) { clearTimeout(timer); s.worker = m.stats; resolve(s); };
        worker.postMessage({ op: 'stats' });
      });
    },
    /** Shaka's own transmuxer on the page from now on (comparisons in DevTools). */
    disable: function () { giveUp('turned off'); },
    // for tests
    _scan: scan
  };
})();
