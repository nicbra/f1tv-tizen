// One small feed of the H.264 multiview (mvsoft.js, engine 'wasm'): fetches its TS segments, takes the video out
// (TsDemux, sent as source by the page: a launcher bundle's worker gets only its own verified file, see shell/boot.js)
// and decodes it with f1dec (our own H.264 decoder, native/f1dec, WebAssembly). Each picture goes to the drawing
// worker (mvdraw-worker.js) with its time on the feed's timeline, as one buffer (Y, then U, then V; buffers come back
// for reuse). It decodes up to LEAD seconds ahead of the drawing worker's clock. A B frame (nothing predicts from
// it) that would come too late is left out: a feed that can't keep up moves at its reference frames' rate instead of
// falling behind.
var LEAD = 1.0, LATE = 0.06, RETRIES = 2;
var dec = null, demux = null, port = null, feed = 0, gen = 0, pool = [], clock = { t: 0, at: 0, rate: 0 };
var stats = { decoded: 0, skipped: 0, errors: 0, fetchMs: 0, decodeMs: 0, segments: 0, behind: 0 };

function now() { return performance.timeOrigin + performance.now(); }
function clockNow() { return clock.t + (now() - clock.at) / 1000 * clock.rate; }
function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
// A turn of the event loop without a timer: chained setTimeout(0)s are clamped to 4 ms after five (HTML timers), which
// left a decoder idle ~4 ms every few pictures. Messages (the clock, buffers, a stop) still get in between.
var turn = new MessageChannel(), turns = [];
turn.port1.onmessage = function () { var f = turns.shift(); if (f) f(); };
function yieldNow() { return new Promise(function (ok) { turns.push(ok); turn.port2.postMessage(0); }); }

/* ---------------------------------------------------------------- the decoder (f1dec.wasm) */

function Decoder(module) {
  var self = this;
  var imports = {
    env: { emscripten_notify_memory_growth: function () { self.heap = new Uint8Array(self.x.memory.buffer); } },
    wasi_snapshot_preview1: { environ_sizes_get: function () { return 0; }, environ_get: function () { return 0; },
      proc_exit: function () {}, fd_write: function () { return 0; }, fd_close: function () { return 0; }, fd_seek: function () { return 0; } }
  };
  this.x = new WebAssembly.Instance(module, imports).exports;
  if (this.x._initialize) this.x._initialize();
  this.heap = new Uint8Array(this.x.memory.buffer);
  this.d = this.x.f1dec_create();
  this.cap = 0; this.ptr = 0;
  this.out = 0; this.outCap = 0;
}
/** Decodes one access unit; true when it gave a picture (then copyTo can take it). Throws on a stream error. */
Decoder.prototype.decode = function (au) {
  var x = this.x;
  if (au.length + 64 > this.cap) {
    if (this.ptr) x.free(this.ptr);
    this.cap = au.length + 64 + (au.length >> 1);
    this.ptr = x.malloc(this.cap);
  }
  if (this.heap.buffer !== x.memory.buffer) this.heap = new Uint8Array(x.memory.buffer);
  this.heap.set(au, this.ptr);
  var r = x.f1dec_decode(this.d, this.ptr, au.length);
  if (r < 0) { var e = new Error('f1dec ' + r); e.code = r; throw e; }
  if (this.heap.buffer !== x.memory.buffer) this.heap = new Uint8Array(x.memory.buffer);
  return r === 1;
};
Decoder.prototype.size = function () { return { w: this.x.f1dec_width(this.d), h: this.x.f1dec_height(this.d) }; };
/** The last picture into buf (w * h * 3 / 2 bytes: Y, U, V without padding). */
Decoder.prototype.copyTo = function (buf, w, h) {
  var x = this.x, n = w * h * 3 / 2;
  if (this.outCap < n) { if (this.out) x.free(this.out); this.out = x.malloc(n); this.outCap = n; }
  x.f1dec_copy(this.d, this.out);
  if (this.heap.buffer !== x.memory.buffer) this.heap = new Uint8Array(x.memory.buffer);
  new Uint8Array(buf).set(this.heap.subarray(this.out, this.out + n));
};
Decoder.prototype.destroy = function () { if (this.d) this.x.f1dec_destroy(this.d); this.d = 0; };

/* ---------------------------------------------------------------- segments */

function fetchBytes(url) {
  var tries = 0;
  return (function attempt() {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('segment: HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (b) { return new Uint8Array(b); }, function (e) {
      if (++tries > RETRIES) { e.network = true; throw e; }
      return wait(500 * tries).then(attempt);
    });
  })();
}

function buffer(size) {
  for (var i = 0; i < pool.length; i++) if (pool[i].byteLength === size) return pool.splice(i, 1)[0];
  return new ArrayBuffer(size);
}

/** Decodes the segments from `from` on, until stopped (gen changes) or the list ends. */
function play(segments, from, g) {
  var k = from, next = null;
  function get(i) {
    var p = i < segments.length ? fetchBytes(segments[i].url) : Promise.resolve(null);
    p.catch(function () { /* seen where it is used; not at all after a stop */ });
    return p;
  }
  next = get(k);
  return (function segment() {
    if (g !== gen) return null;
    var t0 = now();
    return next.then(function (bytes) {
      if (g !== gen || !bytes) return null;
      stats.fetchMs += now() - t0;
      var seg = segments[k];
      next = get(k + 1);   // the next one comes while this one decodes
      var aus = demux.video(bytes);
      if (!aus.length) throw new Error('segment ' + k + ': no video');
      // PTS (90 kHz, 33 bits) relative to the segment's first access unit: a wrap inside the segment stays continuous.
      var p0 = aus[0].pts, first = Infinity;
      aus.forEach(function (a) {
        var d = a.pts - p0;
        if (d < -4294967296) d += 8589934592; else if (d > 4294967296) d -= 8589934592;
        a.rel = d;
        if (d < first) first = d;
      });
      stats.segments++;
      var i = 0;
      return (function more() {
        while (i < aus.length) {
          if (g !== gen) return null;
          var au = aus[i], t = seg.start + (au.rel - first) / 90000;
          // Ahead enough: wait for the clock (it runs once the big feed plays).
          if (t > clockNow() + LEAD) return wait(15).then(more);
          i++;
          // (while the clock runs, one due within LATE won't make it: decoding and drawing take that long)
          if (au.nonRef && t < clockNow() + (clock.rate ? LATE : 0)) { stats.skipped++; continue; }
          var d0 = now(), got;
          try { got = dec.decode(au.data); }
          catch (e) {
            // A stream it doesn't decode fails at once; a damaged picture is left out (later ones decode from the
            // pictures before it until the next IDR picture).
            if (e.code === -2 || ++stats.errors > 50) throw e;
            got = false;
          }
          if (got) {
            var s = dec.size(), buf = buffer(s.w * s.h * 3 / 2);
            dec.copyTo(buf, s.w, s.h);
            stats.decodeMs += now() - d0;
            stats.decoded++;
            if (t < clockNow()) stats.behind++;
            port.postMessage({ pic: { t: t, w: s.w, h: s.h, data: buf } }, [buf]);
          }
          // Let messages in (the clock, returned buffers, a stop) every few pictures.
          if ((stats.decoded & 3) === 0) return yieldNow().then(more);
        }
        k++;
        return segment();
      })();
    });
  })();
}

function report() { postMessage({ stats: stats }); }

onmessage = function (e) {
  var m = e.data;
  if (m.op === 'init') {
    try {
      (0, eval)(m.demux + '\n//# sourceURL=tsdemux.js');
      demux = self.TsDemux;
      dec = new Decoder(new WebAssembly.Module(m.wasm));
      // Non-reference pictures (B) unfiltered: ~13% quicker, 42-55 dB from the filtered picture, nothing drifts.
      if (m.unfiltered) dec.x.f1dec_option(dec.d, 1);
      feed = m.feed;
      port = m.port;
      port.onmessage = function (ev) {
        var d = ev.data;
        if (d.clock) clock = { t: d.clock.t, at: d.clock.at, rate: d.clock.rate };
        if (d.free) pool.push(d.free);
        if (pool.length > 40) pool.length = 40;
      };
      postMessage({ ready: true });
    } catch (err) { postMessage({ error: 'init: ' + (err && err.message || err) }); }
    return;
  }
  if (m.op === 'play') {
    var g = ++gen;
    clock = { t: m.segments[m.from].start, at: now(), rate: 0 };
    play(m.segments, m.from, g).then(function () { if (g === gen) postMessage({ ended: true }); }, function (err) {
      if (g === gen) postMessage({ error: String(err && err.message || err).slice(0, 200), unsupported: !!(err && err.code === -2), network: !!(err && err.network) });
    });
    return;
  }
  if (m.op === 'stats') { report(); return; }
  if (m.op === 'stop') { gen++; if (dec) dec.destroy(); dec = null; postMessage({ stopped: true }); }
};
