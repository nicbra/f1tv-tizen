/*
 * Multiview for H.264 replays (2018-2024: no HEVC to tile, see layouts.js). The big feed plays on AVPlay (the TV's
 * hardware decoder) like any feed; the small ones come from ONE stream the stream helper interleaves
 * (service/stitchx: their frames one after another, each picture marked with its feed in an extra coded row), decoded
 * by Samsung's own software decoder (EMSS, window.tizentvwasm, decodingMode 'software'). Only one EMSS source plays at
 * a time, and it runs beside AVPlay. A worker (mvsoft-worker.js) draws each picture into its feed's place on a canvas
 * under the multiview mask (#mv-frames draws the rounded corners and names, as for the HEVC grids).
 * Measured on the QE55Q77A (2026-11-09): three 540p feeds at 25 fps each (75 pictures/s) beside a 1080p50 main feed;
 * more pictures per second starve the drawing worker. Research: research/h264 in the astra-h264 worktree.
 */
var MvSoftware = (function () {
  'use strict';
  var LOCAL = 'http://127.0.0.1:18765', ID = 'mvsoft', HEIGHT = 540, DELAY = 0.1;   // DELAY: the helper's pts offset
  var LEAD = 6;        // seconds ahead of the big feed the small ones start (the helper builds ~1.5 s per segment)
  var QUEUE = 400;     // packets waiting to be appended before the next segment is fetched
  var cur = null;      // the running column
  var stopping = Promise.resolve(true); // serialize decoder/canvas ownership across replacements
  var gen = 0;         // bumped by every start and outside stop: a restart waiting for its stop only goes on if unchanged

  function note(kind, data) {
    try { if (typeof Diag !== 'undefined' && Diag.note) Diag.note(kind, data, 'warn'); } catch (e) { /* no log */ }
  }

  /** Whether this TV can play it: Samsung's EMSS with side-thread pictures, and worker canvases for the frames. */
  function supported() {
    var w = typeof window !== 'undefined' ? window : {};
    var api = w.tizentvwasm;
    return !!(api && api.ElementaryMediaStreamSource && api.SideThreadElementaryMediaTrack && typeof w.OffscreenCanvas === 'function' &&
      typeof w.HTMLCanvasElement !== 'undefined' && w.HTMLCanvasElement.prototype.transferControlToOffscreen &&
      typeof w.MessageChannel === 'function' && typeof w.Worker === 'function');
  }

  /** Pictures per second each small feed gets: ~75 in all fit beside the big feed (three: 25 fps; two: 33; one: 50). */
  function fpsFor(n) { return n >= 3 ? 25 : n === 2 ? 33 : 50; }

  function attrs(s) {
    var o = {};
    s.replace(/([A-Z-]+)=("[^"]*"|[^,]*)/g, function (m, k, v) { o[k] = v.replace(/^"|"$/g, ''); });
    return o;
  }

  /** A small feed's H.264 variant playlist of `height` lines (else the nearest below) from its offer's master playlist. */
  function variant(url, height) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('feed playlist: HTTP ' + r.status);
      return r.text().then(function (text) {
        var lines = text.split(/\r?\n/), best = null;
        lines.forEach(function (line, i) {
          if (!/^#EXT-X-STREAM-INF:/.test(line)) return;
          var a = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || ''), h = size ? +size[2] : 0;
          if (!/avc1/.test(a.CODECS || '') || !h || h > height || (best && best.h >= h)) return;
          best = { h: h, url: new URL((lines[i + 1] || '').trim(), r.url).toString() };
        });
        if (!best) throw new Error('no H.264 variant');
        return best.url;
      });
    });
  }

  /** A media playlist's segment start times (seconds), for the segment the small feeds start at. */
  function starts(url) {
    return fetch(url).then(function (r) { return r.text(); }).then(function (text) {
      var out = [], t = 0;
      text.split(/\r?\n/).forEach(function (line) {
        var m = /^#EXTINF:([\d.]+)/.exec(line);
        if (m) { out.push(t); t += parseFloat(m[1]); }
      });
      return out;
    });
  }

  function post(body) {
    return fetch(LOCAL + '/stitch/' + ID, { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      return r.text().then(function (text) { if (r.status !== 201) throw new Error('helper: ' + text.slice(0, 160)); return JSON.parse(text); });
    });
  }

  function bytes(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('helper: HTTP ' + r.status + ' ' + t.slice(0, 120)); });
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
    var run = cur = { opts: opts, stopped: false, queue: [], appended: 0, src: null, video: null, worker: null, timers: [],
      stats: null, drift: null, at: null };
    var n = opts.streams.length, fps = fpsFor(n), api = window.tizentvwasm, info, track, segStarts, first;
    var box = bounds(opts.rects);
    // The canvas is a whole number of pixels: the places are given relative to that.
    box = { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
    box.width = Math.min(box.width, 1920 - box.left);
    box.height = Math.min(box.height, 1080 - box.top);
    run.key = key(opts.rects);
    var live = function () { if (run.stopped || cur !== run) throw new Error('cancelled'); };
    return StreamProxy.ensure().then(function () {
      return Promise.all(opts.streams.map(function (s) { return variant(s.url, HEIGHT); }));
    }).then(function (playlists) {
      live();
      return starts(playlists[0]).then(function (s) {
        segStarts = s;
        // The first segment that starts LEAD seconds ahead of the big feed: the small feeds join it there.
        var want = opts.clock.position() + LEAD;
        first = 0;
        while (first + 1 < segStarts.length && segStarts[first] < want) first++;
        return post({ kind: 'h264x', feeds: playlists.map(function (p) { return { playlist: p }; }), audio: null, interleave: true,
          dropB: playlists.map(function () { return false; }), targetFps: playlists.map(function () { return fps; }), feedTag: true,
          spread: true, decodeOrder: 'unlock', reorder: 4, maxDpb: 9, level: 51, probe: first });
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
      var w = run.worker = new Worker('js/mvsoft-worker.js');
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
      note('mv.h264.start', { feeds: n, fps: fps, segment: first });
    }).catch(function (e) {
      if (e && e.message === 'cancelled') return;
      fail(run, e);
    });
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

  /** Fetches the next interleaved segment and queues its packets (times from the first segment's start). */
  function fetchSegment(run) {
    var k = run.next;
    return bytes(LOCAL + '/stitch/' + ID + '/' + k + '.m4s').then(function (b) {
      if (run.stopped) return;
      var list = CmafDash.samples(b, run.timescale);
      if (!list.length) throw new Error('segment ' + k + ': no pictures');
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
    note('mv.h264.failed', { error: String(e && e.message || e).slice(0, 200) });
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
    fpsFor: fpsFor,
    start: start,
    stop: stop,
    place: place,
    running: function () { return !!cur; },
    /** What the column does now (diagnostics, the tests): { stats from the worker, drift to the big feed (s) }. */
    status: function () { return cur ? { stats: cur.stats, drift: cur.drift, appended: cur.appended } : null; }
  };
})();
