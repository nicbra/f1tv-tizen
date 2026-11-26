/*
 * Multiview for H.264 replays (2018-2024: no HEVC to tile, see layouts.js). The big feed plays on AVPlay (the TV's
 * hardware decoder) like any feed; the small ones are decoded in software and drawn on a canvas under the multiview
 * mask (#mv-frames draws the rounded corners and names, as for the HEVC grids). Two engines:
 *   wasm  our own decoder (native/f1dec, js/f1dec.wasm; js/f1dec-simd.wasm where the TV has WebAssembly SIMD), one
 *         worker per small feed (mvdec-worker.js: it fetches and decodes F1's TS segments itself), drawn by
 *         mvdraw-worker.js on the big feed's clock. For two or three small feeds: the TV's cores decode in parallel,
 *         50 fps each. The size is the most lines that fit what this TV's decoders keep up with (learned while they
 *         play: WASM_BUDGET, f1tv.mvbudget), with the B pictures unfiltered when only that fits: 288p for three and two
 *         on the QE55Q77A (2026-11-26, Monaco 2021). No helper, no EMSS: the browser's MediaSource stays usable.
 *   emss  Samsung's software decoder (EMSS, window.tizentvwasm, decodingMode 'software') on ONE stream the stream
 *         helper interleaves (service/stitchx: the feeds' frames one after another, each picture marked with its feed
 *         in an extra coded row), drawn by mvsoft-worker.js. For one small feed (picture in picture: 540p at 50 fps),
 *         and in place of ours when it can't (a stream it refuses: this time; any other failure: until the app
 *         restarts). Every feed goes through one serial budget (~7 ms a picture plus decoding, ~95 pictures/s in all):
 *         two or three small feeds show only F1's reference frames (every third: an even 16.7 fps; any other rate
 *         below 50 moves unevenly, the references must stay), at the rung of the place (640x360: 360p).
 * Only one EMSS source plays at a time, and it runs beside AVPlay.
 */
var MvSoftware = (function () {
  'use strict';
  var LOCAL = 'http://127.0.0.1:18765', ID = 'mvsoft', DELAY = 0.1;   // DELAY: the helper's pts offset
  var LEAD = 6;        // seconds ahead of the big feed the small ones start (the helper builds ~1.5 s per segment)
  var QUEUE = 400;     // packets waiting to be appended before the next segment is fetched
  var cur = null;      // the running column
  var stopping = Promise.resolve(true); // serialize decoder/canvas ownership across replacements
  var gen = 0;         // bumped by every start and outside stop: a restart waiting for its stop only goes on if unchanged
  var wasmOff = false; // our decoder failed in this app run: Samsung's decodes from then on
  var assets = null;   // Promise of { wasm: ArrayBuffer, demux: source text } for the decoder workers

  function note(kind, data) {
    try { if (typeof Diag !== 'undefined' && Diag.note) Diag.note(kind, data, 'warn'); } catch (e) { /* no log */ }
  }

  /**
   * An error with its code for the diagnostics upload and its cause for the recovery (js/failure.js): the network is
   * transient; the helper refusing these feeds, or no H.264 to decode, is this video's; others count as decoding failures.
   */
  function failure(message, code) {
    var e = new Error(message);
    e.diag = { code: code, platform: null };
    e.failure = code === 'NETWORK_ERROR' ? 'transient' : code === 'HELPER_ERROR' || code === 'UNSUPPORTED' ? 'content' : 'way';
    return e;
  }

  /** The stream helper refused (answer r): HELPER_ERROR, with where it failed for the diagnostics (Failure.helperSite). */
  function helperFailure(r, text) {
    var e = failure('helper: ' + text, 'HELPER_ERROR'), h = r && r.headers;
    var site = h && h.get && typeof Failure !== 'undefined' ? Failure.helperSite(function (k) { return h.get(k); }) : null;
    if (site) e.diag.site = site;
    return e;
  }

  /** Worker canvases for the frames, workers and message channels: what both engines need. */
  function canvasWorkers(w) {
    return typeof w.OffscreenCanvas === 'function' && typeof w.HTMLCanvasElement !== 'undefined' &&
      !!w.HTMLCanvasElement.prototype.transferControlToOffscreen && typeof w.MessageChannel === 'function' && typeof w.Worker === 'function';
  }

  /** Samsung's EMSS with side-thread pictures (engine 'emss'). */
  function emssSupported(w) {
    var api = w.tizentvwasm;
    return !!(api && api.ElementaryMediaStreamSource && api.SideThreadElementaryMediaTrack) && canvasWorkers(w);
  }

  /** Our own decoder (native/f1dec, WebAssembly) in one worker per small feed (engine 'wasm'). */
  function wasmSupported(w) {
    return typeof w.WebAssembly === 'object' && typeof w.performance === 'object' && typeof w.performance.timeOrigin === 'number' && canvasWorkers(w);
  }

  /** Whether this TV can play it, with either engine. */
  function supported() {
    var w = typeof window !== 'undefined' ? window : {};
    return wasmSupported(w) || emssSupported(w);
  }

  /**
   * The engine for n small feeds: ours for two or three (one core each), unless it failed in this app run or `forced`
   * says otherwise; Samsung's for one (it shows one feed at 540p and 50 fps, ours would need more than a core) and
   * when ours can't.
   */
  function engineFor(n, forced) {
    var w = typeof window !== 'undefined' ? window : {};
    var ours = !wasmOff && wasmSupported(w), theirs = emssSupported(w);
    if (forced === 'emss' && theirs) return 'emss';
    if (ours && (n >= 2 || !theirs)) return 'wasm';
    return theirs ? 'emss' : ours ? 'wasm' : null;
  }

  /*
   * What our decoder keeps up with per small feed, in macroblocks a second: each decodes on one core beside the big
   * feed's (QE55Q77A, Monaco 2021, 2026-11-26): three at 270p50 (25,500 each) took ~15 ms a picture, CPU 86%; two at
   * 288p50 (28,800) ~15.5 ms, CPU 75%; 360p50 (46,000) took 24-31 ms a picture, too slow. A 2019 onboard at 30 fps
   * fits 288p for three, 360p for two.
   */
  var WASM_BUDGET = { 1: 46000, 2: 28800, 3: 25500 };
  var UNFILTERED = 1.13;   // as much more with the B pictures left unfiltered (QE55Q77A, 360p: 59 -> 68 pictures/s)

  /*
   * What this TV's decoders keep up with, learned while they play (localStorage f1tv.mvbudget, by feed count:
   * { full, unfiltered } macroblocks a second each): a faster TV gets more lines at its next start, a slower one fewer.
   */
  var BUDGET_KEY = 'f1tv.mvbudget', budgets = null;   // kept here; localStorage only carries them to the next app start
  function learned() {
    if (!budgets) {
      try { budgets = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null'); } catch (e) { budgets = null; }
      if (!budgets || typeof budgets !== 'object') budgets = {};
    }
    return budgets;
  }
  function wasmBudget(n) {
    var l = learned()[n] || {}, base = WASM_BUDGET[n] || WASM_BUDGET[3];
    var full = l.full > 0 ? l.full : l.unfiltered > 0 ? l.unfiltered / UNFILTERED : base;
    return { full: full, unfiltered: l.unfiltered > 0 ? l.unfiltered : full * UNFILTERED };
  }
  function learn(n, unfiltered, capacity, behind) {
    var all = learned(), old = wasmBudget(n);
    // Both from one measurement (they differ by UNFILTERED); a step at most 25% from what was known (one busy minute
    // doesn't halve it), within sane bounds; decoders that fell behind are believed at once.
    var full = unfiltered ? capacity / UNFILTERED : capacity;
    if (!behind) full = Math.max(old.full * 0.75, Math.min(old.full * 1.25, full));
    full = Math.max(12000, Math.min(200000, full));
    var l = all[n] = { full: Math.round(full), unfiltered: Math.round(full * UNFILTERED) };
    try { localStorage.setItem(BUDGET_KEY, JSON.stringify(all)); } catch (e) { /* kept for this app run only */ }
    return unfiltered ? l.unfiltered : l.full;
  }

  /** Whether n small feeds show only their reference frames (16.7 fps, even): two or more; one shows every frame. */
  function refsOnly(n) { return n >= 2; }

  function attrs(s) {
    var o = {};
    s.replace(/([A-Z-]+)=("[^"]*"|[^,]*)/g, function (m, k, v) { o[k] = v.replace(/^"|"$/g, ''); });
    return o;
  }

  /**
   * A feed's H.264 variant playlists from its offer's master playlist: { lines (rows): { url, rate: macroblocks a
   * second (50 fps where the playlist doesn't say) } }.
   */
  function ladder(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw failure('feed playlist: HTTP ' + r.status, 'NETWORK_ERROR');
      return r.text().then(function (text) {
        var lines = text.split(/\r?\n/), out = {};
        lines.forEach(function (line, i) {
          if (!/^#EXT-X-STREAM-INF:/.test(line)) return;
          var a = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || ''), h = size ? +size[2] : 0;
          var fps = parseFloat(a['FRAME-RATE']) || 50;
          if (/avc1/.test(a.CODECS || '') && h && !out[h]) {
            var mbs = Math.ceil(+size[1] / 16) * Math.ceil(h / 16);
            out[h] = { url: new URL((lines[i + 1] || '').trim(), r.url).toString(), rate: mbs * fps, mbs: mbs, fps: fps };
          }
        });
        return out;
      });
    });
  }

  /**
   * The small feeds' playlists, all of one size (the helper interleaves one size only): the fewest lines that every
   * feed has and that fill `rows` screen lines (within `budget`), else the most lines they all have. { rows, playlists }
   */
  function rungs(streams, rows, budget) {
    return Promise.all(streams.map(function (s) { return ladder(s.url); })).then(function (ladders) {
      var shared = Object.keys(ladders[0]).map(Number).filter(function (h) { return ladders.every(function (l) { return l[h]; }); });
      if (!shared.length) throw failure('no H.264 size every feed has', 'UNSUPPORTED');
      // budget: macroblocks a second the decoder keeps up with (none within it: the smallest there is)
      var fit = budget ? shared.filter(function (h) { return ladders.every(function (l) { return l[h].rate <= budget; }); }) : shared;
      if (!fit.length) fit = [Math.min.apply(null, shared)];
      var filling = fit.filter(function (h) { return h >= rows; });
      var h = filling.length ? Math.min.apply(null, filling) : Math.max.apply(null, fit);
      return { rows: h, playlists: ladders.map(function (l) { return l[h].url; }),
        rate: Math.max.apply(null, ladders.map(function (l) { return l[h].rate; })), mbs: Math.max.apply(null, ladders.map(function (l) { return l[h].mbs; })),
        least: h === Math.min.apply(null, shared) };
    });
  }

  /** A media playlist's segment start times (seconds), for the segment the small feeds start at. */
  function starts(url) {
    return fetch(url).then(function (r) {
      // An error body has no segment times: reject, or the start clock becomes NaN and never settles.
      if (!r.ok) throw failure('segment playlist ' + r.status, 'NETWORK_ERROR');
      return r.text();
    }).then(function (text) {
      var out = [], t = 0;
      text.split(/\r?\n/).forEach(function (line) {
        var m = /^#EXTINF:([\d.]+)/.exec(line), d = m ? parseFloat(m[1]) : 0;
        if (m && d > 0 && isFinite(d)) { out.push(t); t += d; }
      });
      if (!out.length) throw new Error('segment playlist without segments');
      return out;
    });
  }

  function post(body) {
    return fetch(LOCAL + '/stitch/' + ID, { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      return r.text().then(function (text) { if (r.status !== 201) throw helperFailure(r, text.slice(0, 160)); return JSON.parse(text); });
    });
  }

  function bytes(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw helperFailure(r, 'HTTP ' + r.status + ' ' + t.slice(0, 120)); });
      return r.arrayBuffer();
    }).then(function (b) { return new Uint8Array(b); });
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * Starts the small feeds. opts: { streams: the small feeds' offers (layout order), rects: [{ left, top, width,
   * height }] where each shows (screen pixels), clock: { position() (s, the big feed's), playing() },
   * canvas: the element to draw on, onError(e), onShown() (the first picture is drawn) }. Resolves once it plays (or failed: onError).
   */
  function start(opts) {
    var requested = ++gen;
    return halt().then(function (safe) {
      if (requested !== gen) return;
      if (!safe) {
        note('mv.h264.restart-required', {});
        if (opts.onError) opts.onError(new Error('Restart the app before starting multiview again'));
        return;
      }
      return begin(opts);
    });
  }

  function begin(opts) {
    var engine = engineFor(opts.streams.length, opts.engine);
    if (engine === 'wasm') return beginWasm(opts);
    var run = cur = { engine: 'emss', opts: opts, stopped: false, queue: [], appended: 0, src: null, video: null, worker: null, timers: [],
      stats: null, drift: null, at: null };
    var n = opts.streams.length, refs = refsOnly(n), api = window.tizentvwasm, info, track, segStarts, first, rows;
    var box = bounds(opts.rects);
    // The canvas is a whole number of pixels: the places are given relative to that.
    box = { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
    box.width = Math.min(box.width, 1920 - box.left);
    box.height = Math.min(box.height, 1080 - box.top);
    run.key = key(opts.rects);
    var live = function () { if (run.stopped || cur !== run) throw new Error('cancelled'); };
    var place = Math.round(Math.max.apply(null, opts.rects.map(function (r) { return r.height; })));
    return StreamProxy.ensure().then(function () {
      return rungs(opts.streams, place);
    }).then(function (r) {
      live();
      rows = r.rows;
      var playlists = r.playlists;
      return starts(playlists[0]).then(function (s) {
        segStarts = s;
        // The first segment that starts LEAD seconds ahead of the big feed: the small feeds join it there.
        var want = opts.clock.position() + LEAD;
        first = 0;
        while (first + 1 < segStarts.length && segStarts[first] < want) first++;
        return post({ kind: 'h264x', feeds: playlists.map(function (p) { return { playlist: p }; }), audio: null, interleave: true,
          dropB: playlists.map(function () { return refs; }), feedTag: true, decodeOrder: 'unlock', reorder: 4, maxDpb: 9, level: 51,
          probe: first });
      });
    }).then(function (i) {
      live();
      info = i;
      run.count = i.segments;
      return bytes(LOCAL + '/stitch/' + ID + '/init.mp4');
    }).then(function (initBytes) {
      live();
      track = CmafDash.videoTrack(initBytes);
      run.timescale = track.timescale;
      // From here on the browser's MediaSource (Shaka) won't open again until the app restarts (Player.engineLost).
      if (typeof Player !== 'undefined' && Player.engineLost) Player.engineLost('shaka', true);
      var src = run.src = new api.ElementaryMediaStreamSource('latency-mode-normal', 'rendering-mode-video-texture');
      var v = run.video = document.createElement('video');
      v.muted = true;
      v.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px';
      opts.canvas.parentNode.insertBefore(v, opts.canvas);
      v.src = run.url = URL.createObjectURL(src);
      return new Promise(function (ok) { src.onsourceopenpending = ok; setTimeout(ok, 2000); });
    }).then(function () {
      live();
      var t = track, src = run.src;
      var tr = src.addVideoTrack({ mimeType: 'video/mp4; codecs="' + t.codec + '"', extradata: t.extradata, width: t.width, height: t.height,
        framerateNum: 25, framerateDen: 1, decodingMode: 'software' });
      run.trackId = tr.trackId; run.sessionId = tr.sessionId;
      try { src.duration = segStarts.length ? segStarts[segStarts.length - 1] + 10 : 7200; } catch (e) { /* kept */ }
      return src.open();
    }).then(function () {
      live();
      // A transferred canvas has one owner for its lifetime. Replace the old DOM
      // element only after the previous decoder acknowledged its stop.
      var old = opts.canvas, c = old.cloneNode(false);
      old.parentNode.replaceChild(c, old);
      opts = run.opts = Object.assign({}, opts, { canvas: c });
      c.width = box.width; c.height = box.height;
      c.style.left = box.left + 'px'; c.style.top = box.top + 'px';
      c.style.width = box.width + 'px'; c.style.height = box.height + 'px';
      var offscreen = c.transferControlToOffscreen();
      var w = run.worker = (typeof Launcher !== 'undefined' ? Launcher.worker('js/mvsoft-worker.js') : new Worker('js/mvsoft-worker.js'));
      run.ready = new Promise(function (ok) { run.readyNow = ok; });
      run.stoppedAck = new Promise(function (ok) { run.ackNow = ok; });
      w.onmessage = function (e) {
        var d = e.data;
        if (d.stats) run.stats = d.stats;
        // The canvas shows from the first picture on (until then the page says the feeds are loading: onShown).
        if (d.stats && d.stats.pulled > 0 && !run.shown && cur === run && !run.stopped) {
          run.shown = true;
          c.classList.remove('hidden');
          if (opts.onShown) opts.onShown();
        }
        if (d.ready) run.readyNow();
        if (d.stopped) run.ackNow();
        if (d.error) fail(run, new Error('worker: ' + d.error));
      };
      w.onerror = function (e) { fail(run, new Error('worker: ' + e.message)); };
      var rects = opts.rects.map(function (r) { return [(r.left - box.left) / box.width, (r.top - box.top) / box.height, r.width / box.width, r.height / box.height]; });
      w.postMessage({ start: true, canvas: offscreen, trackId: run.trackId, width: track.width, height: track.height,
        visibleRows: info.visibleRows, feeds: n, rects: rects, feedTag: info.feedTag }, [offscreen]);
      run.next = first;
      run.base = null;
      return fetchSegment(run).then(function () { return fetchSegment(run); });
    }).then(function () {
      live();
      pump(run);
      run.timers.push(setInterval(function () { pump(run); }, 15));
      return Promise.race([run.ready, wait(3000)]);
    }).then(function () {
      live();
      // The small feeds' picture at segment time T shows at their clock T - start + DELAY: start that clock when the big
      // feed is DELAY before the segment's start.
      run.at = segStarts[first] - DELAY;
      return untilClock(run, run.at);
    }).then(function (jumped) {
      live();
      // The big feed jumped while the small ones waited for it (a seek back, or far ahead): start them there.
      if (jumped) return restart(run, 'jump while starting');
      run.video.play().catch(function (e) { fail(run, e); });
      run.timers.push(setInterval(function () { follow(run); }, 250));
      feedSegments(run);
      note('mv.h264.start', { feeds: n, rows: rows, frames: refs ? 'references' : 'all', segment: first });
    }).catch(function (e) {
      if (e && e.message === 'cancelled') return;
      fail(run, e);
    });
  }

  /* ---------------------------------------------------------------- engine 'wasm' */

  /** A file of the running bundle (a downloaded one is checked against its signed manifest, shell/boot.js). */
  function bundleFile(relative) {
    return new Promise(function (resolve, reject) {
      if (typeof Launcher !== 'undefined' && Launcher.file) {
        return Launcher.file(relative, function (err, bytes) { if (err) reject(err); else resolve(bytes); });
      }
      var x = new XMLHttpRequest();
      x.open('GET', relative);
      x.responseType = 'arraybuffer';
      x.onload = function () { if (x.status === 200 || (x.status === 0 && x.response)) resolve(new Uint8Array(x.response)); else reject(new Error('HTTP ' + x.status)); };
      x.onerror = function () { reject(new Error(relative + ' not readable')); };
      x.send();
    });
  }

  /** Whether this TV's WebAssembly has SIMD (Chromium 91+): a module of one SIMD instruction validates. */
  var SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];
  function hasSimd() {
    try { return WebAssembly.validate(new Uint8Array(SIMD_PROBE)); } catch (e) { return false; }
  }

  /**
   * The decoder (js/f1dec-simd.wasm where the TV has WebAssembly SIMD: ~25% quicker; else js/f1dec.wasm) and the TS
   * demuxer's source for the decoder workers, read once.
   */
  function loadAssets() {
    if (!assets) {
      var simd = hasSimd();
      assets = Promise.all([bundleFile(simd ? 'js/f1dec-simd.wasm' : 'js/f1dec.wasm'), bundleFile('service/stitchx/tsdemux.js')]).then(function (got) {
        return { wasm: got[0], demux: new TextDecoder('utf-8').decode(got[1]), simd: simd };
      });
      assets.catch(function () { assets = null; });
    }
    return assets;
  }

  /** A media playlist's segments: [{ url, start (s, from the playlist's start), duration }]. */
  function segmentsOf(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw failure('segment playlist ' + r.status, 'NETWORK_ERROR');
      return r.text().then(function (text) {
        var out = [], t = 0, d = 0;
        text.split(/\r?\n/).forEach(function (line) {
          line = line.trim();
          var m = /^#EXTINF:([\d.]+)/.exec(line);
          if (m) { d = parseFloat(m[1]); return; }
          if (!line || line[0] === '#' || !(d > 0 && isFinite(d))) return;
          out.push({ url: new URL(line, r.url).toString(), start: t, duration: d });
          t += d; d = 0;
        });
        if (!out.length) throw new Error('segment playlist without segments');
        return out;
      });
    });
  }

  function workerFor(name) { return typeof Launcher !== 'undefined' ? Launcher.worker(name) : new Worker(name); }

  /**
   * Engine 'wasm': each small feed decoded by our own decoder in a worker of its own (mvdec-worker.js: the TV's cores
   * work in parallel, Samsung's software decoder took ~7 ms of one serial budget per picture), drawn by
   * mvdraw-worker.js on the big feed's clock. No helper, no EMSS: the browser's MediaSource stays usable.
   */
  function beginWasm(opts) {
    var run = cur = { engine: 'wasm', opts: opts, stopped: false, timers: [], workers: [], draw: null, stats: null, decStats: [],
      drift: null, at: null };
    var n = opts.streams.length, box = bounds(opts.rects), rows;
    box = { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
    box.width = Math.min(box.width, 1920 - box.left);
    box.height = Math.min(box.height, 1080 - box.top);
    run.key = key(opts.rects);
    var live = function () { if (run.stopped || cur !== run) throw new Error('cancelled'); };
    var place = Math.round(Math.max.apply(null, opts.rects.map(function (r) { return r.height; })));
    var lists, asset, budget = wasmBudget(n);
    // The most lines that fit with the B pictures unfiltered; filtered too when that fits as well.
    return Promise.all([loadAssets(), rungs(opts.streams, place, budget.unfiltered)]).then(function (got) {
      live();
      asset = got[0];
      rows = got[1].rows;
      run.rung = { rate: got[1].rate, mbs: got[1].mbs, unfiltered: got[1].rate > budget.full, least: got[1].least };
      return Promise.all(got[1].playlists.map(segmentsOf));
    }).then(function (l) {
      live();
      lists = l;
      var old = opts.canvas, c = old.cloneNode(false);
      old.parentNode.replaceChild(c, old);
      opts = run.opts = Object.assign({}, opts, { canvas: c });
      c.width = box.width; c.height = box.height;
      c.style.left = box.left + 'px'; c.style.top = box.top + 'px';
      c.style.width = box.width + 'px'; c.style.height = box.height + 'px';
      var offscreen = c.transferControlToOffscreen();
      var rects = opts.rects.map(function (r) { return [(r.left - box.left) / box.width, (r.top - box.top) / box.height, r.width / box.width, r.height / box.height]; });
      var draw = run.draw = workerFor('js/mvdraw-worker.js'), ports = [], ready = [];
      ready.push(new Promise(function (ok, no) {
        draw.onmessage = function (e) {
          var d = e.data;
          if (d.ready) ok();
          if (d.error) { no(new Error('draw: ' + d.error)); fail(run, new Error('draw: ' + d.error)); }
          if (d.stats) run.stats = d.stats;
          if (d.shown && !run.shown && cur === run && !run.stopped) {
            run.shown = true;
            c.classList.remove('hidden');
            if (opts.onShown) opts.onShown();
          }
        };
      }));
      for (var k = 0; k < n; k++) {
        var ch = new MessageChannel(), w = workerFor('js/mvdec-worker.js');
        ports.push(ch.port2);
        run.workers.push(w);
        (function (k, w) {
          ready.push(new Promise(function (ok, no) {
            w.onmessage = function (e) {
              var d = e.data;
              if (d.ready) ok();
              if (d.stats) run.decStats[k] = d.stats;
              if (d.error) {
                var err = d.network ? failure('decoder ' + k + ': ' + d.error, 'NETWORK_ERROR') : new Error('decoder ' + k + ': ' + d.error);
                err.unsupported = !!d.unsupported;
                no(err); fail(run, err);
              }
            };
            w.onerror = function (e) { fail(run, new Error('decoder ' + k + ': ' + (e.message || 'error'))); };
          }));
          w.postMessage({ op: 'init', wasm: asset.wasm, demux: asset.demux, feed: k, port: ch.port1, unfiltered: run.rung.unfiltered }, [ch.port1]);
        })(k, w);
      }
      draw.onerror = function (e) { fail(run, new Error('draw: ' + (e.message || 'error'))); };
      draw.postMessage({ start: true, canvas: offscreen, rects: rects, ports: ports }, [offscreen].concat(ports));
      return Promise.race([Promise.all(ready), wait(10000).then(function () { throw new Error('workers did not start'); })]);
    }).then(function () {
      live();
      // From the segment the big feed is in: the decoders catch up on reference frames, B frames come once in time.
      var pos = opts.clock.position();
      lists.forEach(function (list, k) {
        var from = 0;
        while (from + 1 < list.length && list[from + 1].start <= pos) from++;
        run.workers[k].postMessage({ op: 'play', segments: list, from: from });
      });
      // The big feed's exact position is a synchronous call into AVPlay (3-12 ms on this TV, the page waits; asked every
      // 50 ms it held the page ~14% of the time): asked twice a second and whenever it pauses or plays again. The
      // drawing worker runs the clock on in between (AVPlay's clock stays within a few ms of that).
      var last = null;
      run.timers.push(setInterval(function () {
        if (run.stopped) return;
        var t = performance.timeOrigin + performance.now(), playing = opts.clock.playing();
        if (!last || playing !== last.playing || t - last.t >= CLOCK_EVERY) {
          var p = opts.clock.position();
          // A jump (a seek): the decoders start over where the big feed is.
          if (last && Math.abs(p - (last.p + (last.playing ? (t - last.t) / 1000 : 0))) > 2) return restart(run, 'jump');
          last = { p: p, t: t, playing: playing };
          run.draw.postMessage({ clock: { pos: p, at: t, playing: playing, rate: 1 } });
        }
        run.drift = run.stats ? run.stats.drift : null;
      }, 50));
      run.timers.push(setInterval(function () {
        run.workers.forEach(function (w) { w.postMessage({ op: 'stats' }); });
        measure(run);
      }, 1000));
      note('mv.h264.start', { feeds: n, rows: rows, engine: 'wasm', frames: 'all', unfiltered: run.rung.unfiltered, simd: asset.simd });
    }).catch(function (e) {
      if (e && e.message === 'cancelled') return;
      fail(run, e);
    });
  }

  /**
   * Engine 'wasm' learns what this TV's decoders keep up with: over 10 s windows (from 8 s after the first picture, the
   * big feed playing) the slowest decoder's time per picture gives the macroblocks a second it could take, kept with
   * 15% to spare. Decoders that fall behind (more than one picture in ten left out) start over at a size that fits.
   */
  var WARMUP = 8, WINDOW = 10, CLOCK_EVERY = 500;
  function measure(run) {
    if (run.stopped || run.decStats.length !== run.workers.length) return;
    var w = run.window, t = Date.now() / 1000;
    // Only while it plays: a pause (or the first picture not yet shown) starts the warm-up over.
    if (!run.shown || !run.opts.clock.playing()) { run.shownAt = null; run.window = null; return; }
    var sum = function (k) { return run.decStats.map(function (d) { return d[k] || 0; }); };
    if (run.shownAt == null) run.shownAt = t;
    if (t - run.shownAt < WARMUP) return;
    if (!w) { run.window = { t: t, decoded: sum('decoded'), ms: sum('decodeMs'), skipped: sum('skipped') }; return; }
    if (t - w.t < WINDOW) return;
    var decoded = sum('decoded'), ms = sum('decodeMs'), skipped = sum('skipped'), worst = 0, late = 0, enough = true;
    // Every decoder needs a real sample (a stalled one says nothing about the others' speed): a third of 25 fps.
    decoded.forEach(function (n, k) {
      var d = n - w.decoded[k], gone = skipped[k] - w.skipped[k], per = d > 0 ? (ms[k] - w.ms[k]) / d : 0;
      if (d + gone < (t - w.t) * 8) enough = false;
      worst = Math.max(worst, per);
      late = Math.max(late, gone / Math.max(1, d + gone));
    });
    run.window = { t: t, decoded: decoded, ms: ms, skipped: skipped };
    if (!enough || !(worst > 0)) return;
    var n = run.workers.length, capacity = 0.85 * run.rung.mbs * 1000 / worst, kept = learn(n, run.rung.unfiltered, capacity, late > 0.1);
    run.learned = { msPerPicture: Math.round(worst * 10) / 10, capacity: Math.round(capacity), kept: kept, late: Math.round(late * 100) };
    // (at the smallest size there is nothing smaller to start over with)
    if (late > 0.1 && run.rung.rate > kept && !run.rung.least) {
      note('mv.h264.budget', { feeds: n, rate: run.rung.rate, kept: kept, late: Math.round(late * 100) });
      restart(run, 'too slow for this size');
    }
  }

  /** Waits for the big feed to reach `t`; resolves true if it jumped instead (more than 2 s back, or past `t`). */
  function untilClock(run, t) {
    var last = run.opts.clock.position();
    return new Promise(function (ok) {
      (function check() {
        if (run.stopped) return ok(false);
        var p = run.opts.clock.position();
        if (p < last - 2 || p > t + 2) return ok(true);
        last = Math.max(last, p);
        if (p >= t - 0.03) return ok(false);
        setTimeout(check, t - p > 0.5 ? 100 : 5);
      })();
    });
  }

  /**
   * Which of a segment's pictures (CmafDash samples) end a moment, in display order: the helper marks them in the PTS
   * (modulo 8, + 4 on the last picture of a frame time). 1 where the worker shows the canvas, else 0.
   */
  function moments(list, timescale) {
    var ticks = list.map(function (s) { return Math.round(s.pts * timescale); }).sort(function (a, b) { return a - b; });
    var out = new Uint8Array(ticks.length);
    ticks.forEach(function (t, i) { out[i] = t % 8 >= 4 ? 1 : 0; });
    return out;
  }

  /** Fetches the next interleaved segment and queues its packets (times from the first segment's start). */
  function fetchSegment(run) {
    var k = run.next;
    return bytes(LOCAL + '/stitch/' + ID + '/' + k + '.m4s').then(function (b) {
      if (run.stopped) return;
      var list = CmafDash.samples(b, run.timescale);
      if (!list.length) throw new Error('segment ' + k + ': no pictures');
      // Before its packets go in: the worker meets these pictures only after the ones already queued.
      run.worker.postMessage({ moments: moments(list, run.timescale) });
      if (run.base === null) run.base = Math.min.apply(null, list.map(function (s) { return s.dts; }));
      list.forEach(function (s) {
        run.queue.push({ packet: { pts: s.pts - run.base, dts: s.dts - run.base, duration: s.duration, isKeyFrame: s.key, isEncrypted: false,
          sessionId: run.sessionId }, data: s.data.slice() });
      });
      run.next = k + 1;
    });
  }

  function feedSegments(run) {
    (function more() {
      if (run.stopped) return;
      if (run.count != null && run.next >= run.count) return;   // the end of the replay
      var need = run.queue.length < QUEUE;
      (need ? fetchSegment(run) : Promise.resolve()).then(function () { setTimeout(more, need ? 0 : 200); }, function (e) {
        // The end of the replay: the helper has no next segment.
        if (/HTTP 404/.test(e && e.message || '')) return;
        fail(run, e);
      });
    })();
  }

  /** Appends queued packets until the decoder's buffer is full (it opens only once playing: retried). */
  function pump(run) {
    var T = window.tizentvwasm.SideThreadElementaryMediaTrack;
    while (run.queue.length && !run.stopped) {
      var s = run.queue[0];
      try { T.appendPacketAsync(run.trackId, s.packet, s.data); }
      catch (e) {
        if (e.name !== 'AppendBufferFullError' && !/not open/.test(e.message || '')) fail(run, new Error('append: ' + (e.message || e.name)));
        return;
      }
      run.queue.shift();
      run.appended++;
    }
  }

  /** Keeps the small feeds with the big one: pauses with it, waits for it, starts over after a jump (a seek). */
  function follow(run) {
    if (run.stopped) return;
    var v = run.video, p = run.opts.clock.position(), drift = p - (run.at + v.currentTime);
    run.drift = drift;
    if (Math.abs(drift) > 2) return restart(run, 'drift ' + Math.round(drift * 10) / 10);
    var hold = !run.opts.clock.playing() || drift < -0.3;
    if (hold && !v.paused) v.pause();
    else if (!hold && v.paused && drift > -0.05) v.play().catch(function () { /* next tick */ });
    // While held, look again sooner than the 250 ms beat: the small feeds go on with the big one within ~40 ms.
    if (v.paused && !run.quick) { run.quick = true; setTimeout(function () { run.quick = false; follow(run); }, 40); }
  }

  /**
   * Starts the small feeds over where the big one is (after a seek, or in new places). Waits for the old run's stop;
   * a start or stop from outside meanwhile (the viewer left, another video) cancels it.
   */
  function restart(run, why, opts) {
    if (run.stopped || cur !== run) return;
    note('mv.h264.restart', { why: why });
    var o = opts || run.opts, g = gen;
    return halt().then(function () { if (gen === g && !cur) return start(o); });
  }

  function fail(run, e) {
    if (run.stopped || cur !== run) return;
    note('mv.h264.failed', { error: String(e && e.message || e).slice(0, 200), engine: run.engine });
    // (a network failure isn't the decoder's: the app starts the feeds again, as for Samsung's)
    if (run.engine === 'wasm' && emssSupported(window) && !(e && e.failure === 'transient')) {
      // Our decoder: Samsung's takes over (fewer pictures a second, but it plays). For a stream ours doesn't decode
      // (CAVLC, 8x8 transforms) only this time; any other failure for the rest of the app run.
      if (!(e && e.unsupported)) wasmOff = true;
      return restart(run, e && e.unsupported ? 'wasm unsupported' : 'wasm failed', Object.assign({}, run.opts, { engine: 'emss' }));
    }
    var cb = run.opts.onError;
    stop();
    if (cb) cb(e);
  }

  function bounds(rects) {
    var l = Math.min.apply(null, rects.map(function (r) { return r.left; })), t = Math.min.apply(null, rects.map(function (r) { return r.top; }));
    var r = Math.max.apply(null, rects.map(function (x) { return x.left + x.width; })), b = Math.max.apply(null, rects.map(function (x) { return x.top + x.height; }));
    return { left: l, top: t, width: r - l, height: b - t };
  }

  function key(rects) { return rects.map(function (r) { return [r.left, r.top, r.width, r.height].map(Math.round).join(','); }).join(';'); }

  /** The small feeds' places changed (the timing data took or gave room): start them again there. */
  function place(rects) {
    if (!cur || cur.stopped || key(rects) === cur.key) return;
    restart(cur, 'places', Object.assign({}, cur.opts, { rects: rects }));
  }

  /** Stops the small feeds (the viewer left, another video or feed): also cancels a restart waiting to start. */
  function stop() {
    gen++;
    return halt();
  }

  /**
   * Stops the running column. The worker waits inside getPictureSync for each picture, so it is asked to stop while
   * pictures still come (terminating a worker blocked there hangs the page): the small feeds' clock runs (also if it
   * was paused or not started yet) and the queued packets go in; then the source goes.
   */
  function halt() {
    var run = cur;
    cur = null;
    if (!run || run.stopped) return stopping;
    run.stopped = true;
    run.timers.forEach(clearInterval);
    run.opts.canvas.classList.add('hidden');
    if (run.engine === 'wasm') {
      // Nothing of the TV's media is borrowed: the workers can just end.
      run.workers.forEach(function (x) { try { x.terminate(); } catch (e) { /* gone */ } });
      if (run.draw) try { run.draw.terminate(); } catch (e) { /* gone */ }
      stopping = Promise.resolve(true);
      return stopping;
    }
    var w = run.worker, done = Promise.resolve(true), keep = null, cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true; clearInterval(keep);
      if (w) w.terminate(); // Only after the worker returned every borrowed picture.
      try { if (run.src) run.src.destroy(); } catch (e) { /* gone */ }
      if (run.video) { try { run.video.removeAttribute('src'); run.video.load(); } catch (e) { /* gone */ } run.video.remove(); }
      if (run.url) URL.revokeObjectURL(run.url);
    }
    if (w) {
      w.postMessage({ stop: true });
      if (run.video && run.video.paused) run.video.play().catch(function () { /* keep feeding until ACK */ });
      var T = window.tizentvwasm && window.tizentvwasm.SideThreadElementaryMediaTrack;
      keep = setInterval(function () {
        while (run.queue.length && T) {
          try { T.appendPacketAsync(run.trackId, run.queue[0].packet, run.queue[0].data); run.queue.shift(); } catch (e) { break; }
        }
      }, 15);
      done = Promise.race([run.stoppedAck.then(function () { return true; }), wait(1500).then(function () { return false; })]);
    }
    stopping = done.then(function (acked) {
      if (acked) cleanup();
      else {
        note('mv.h264.stuck-worker', {});
        // Do not destroy the source or transfer another canvas under a blocked
        // worker. A late ACK may still release it; otherwise an app restart is required.
        run.stoppedAck.then(function () { cleanup(); stopping = Promise.resolve(true); });
      }
      return acked;
    });
    return stopping;
  }

  return {
    supported: supported,
    start: start,
    stop: stop,
    place: place,
    running: function () { return !!cur; },
    /** What the column does now (diagnostics, the tests): { stats from the worker, drift to the big feed (s) }. */
    status: function () {
      return cur ? { engine: cur.engine, stats: cur.stats, drift: cur.drift, appended: cur.appended, decoders: cur.decStats, rung: cur.rung, learned: cur.learned } : null;
    }
  };
})();
