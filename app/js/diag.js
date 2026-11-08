/*
 * Diagnostics log: unusual events (playback failures and fallbacks, retries, stalls, script errors, F1 TV
 * request failures, the app ending while a video played), kept on the TV so a later look can tell what
 * went wrong, when, and in what state.
 *
 * Each warning or error carries what led up to it (`trail`: the last steps the app and player took), a
 * snapshot of the state then (`s`: player, app, account, network, memory; filled by Diag.provide), and
 * shortly after, the helper's recent requests (Diag.provideAsync). Each app run starts with the TV's
 * capabilities; each video played is an entry with what F1 offered (codecs, ladder, DRM).
 *
 * It records only when the build turns it on (js/diag-build.js; personal builds override that file) or
 * the viewer has opted in (setting 'diagnostics', not in the menus yet). Otherwise nothing is kept, and
 * callers skip their diagnostic work (Diag.recording()).
 *
 * Entries are made shareable when they are written: no tokens, keys or licence data (also not written
 * into text), URLs cut down to their host and a known file name, no e-mail addresses. Free text from
 * servers and the TV is kept short. report() is the whole log in the form an opt-in upload will send;
 * nothing is sent anywhere yet.
 */
var Diag = (function () {
  var KEY = 'f1tv.diag', ALIVE_KEY = 'f1tv.diag.alive';
  var FORMAT = 2;
  var MAX_ENTRIES = 400, MAX_CHARS = 400000, MAX_ENTRY_CHARS = 12000;
  var KIND_PER_MIN = 10;      // entries of one kind per minute; more are counted, not kept
  var HEARTBEAT_MS = 15000;
  var MAX_TEXT = 300;
  var CLEAN_BUDGET = 800;     // values one clean() call looks at; the rest become '[…]'
  var TRAIL_KEEP = 30, TRAIL_ATTACH = 20;
  var ASYNC_EVERY_MS = 5000;  // one helper-log request serves every warning within this time
  var DRM_PROBE_MS = 10000;

  var build = (typeof DIAG_BUILD !== 'undefined' && DIAG_BUILD) || {};
  var run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var entries = [];
  var bursts = {};
  var trailList = [];
  var providers = {}, asyncProviders = {}, asyncAsked = {};
  var playing = null, playingShort = null, playingSince = 0;
  var info = null;
  var started = false;

  function recording() {
    if (build.record) return true;
    try { return typeof Settings !== 'undefined' && !!Settings.get('diagnostics'); } catch (e) { return false; }
  }

  function storage() { try { return window.localStorage || null; } catch (e) { return null; } }

  function read(key) {
    var s = storage();
    try { return s ? JSON.parse(s.getItem(key)) : null; } catch (e) { return null; }
  }

  function write(key, value) {
    var s = storage();
    try { if (s) s.setItem(key, JSON.stringify(value)); } catch (e) { /* full or disabled */ }
  }

  function round(n, places) { var f = Math.pow(10, places || 0); return Math.round(n * f) / f; }

  function hidden() { try { return !!document.hidden; } catch (e) { return false; } }

  // ---- making data shareable -------------------------------------------------------------

  var SECRET_KEY = /token|auth|pass|secret|cookie|pssh|challenge|licen[cs]e(data|body)?$|^key$|keyid|apikey|ascendon|entitlementtoken|subscri|email|name$|drm(token|data)|session_?id|^headers$|^body$|customdata|^entitlement$/i;
  var URL_RE = /\b(https?|wss?|file):\/\/[^\s"'<>]+/gi;
  // Secrets written into text: "Bearer x", "token=x", "customdata: x", '"drmToken":"x"', query parameters.
  var BEARER_RE = /\b(bearer|basic)\s+[^\s"',;]+/gi;
  var SECRET_TEXT_RE = /\b([\w-]*(?:token|auth\w*|customdata|secret|passw\w*|ascendon\w*|entitlement\w*|cookie|session_?id|key_?id|api_?key|signature|sig|hdnts|hmac|policy|key-pair-id|drmtoken|drm_?data|pssh))(["']?\s*[:=]\s*["']?)[^\s"',;&}\])]+/gi;
  var QUERY_RE = /(\/[^\s"'<>?]*|\.[a-z0-9]{2,5})\?[^\s"'<>]*/gi;
  var JWT_RE = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g;
  var EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
  var LONG_RE = /[A-Za-z0-9+\/=_-]{40,}/g;
  var HEX_RE = /\b[0-9a-f]{20,}\b/gi;
  // File names worth keeping in a URL; anything else there could be an id or a signed part.
  var FILE_RE = /^[\w.-]{1,48}\.(m3u8|mpd|mp4|m4s|m4v|m4a|ts|aac|ac3|ec3|vtt|webvtt|ttml|xml|json|js|html|css|png|jpg|wgt)(:\d+(:\d+)?)?$/i;

  /** A URL as scheme://host/…/file: no query, no path, the file name only if it is a plain media or code file. */
  function shortUrl(u) {
    var tail = /[)\].,;]+$/.exec(u);
    if (tail && !(tail[0].charAt(0) === ')' && u.indexOf('(') >= 0)) u = u.slice(0, -tail[0].length); else tail = null;
    var m = /^([a-z]+):\/\/([^\/?#]*)([^?#]*)/i.exec(u);
    if (!m) return '[url]';
    var host = m[2].replace(/^[^@]*@/, '');
    if (!/^[\w.-]*(:\d+)?$/.test(host)) host = '[host]';
    var parts = m[3].split('/').filter(Boolean);
    var file = parts.length ? parts[parts.length - 1] : '';
    if (file && (!FILE_RE.test(file) || /[A-Za-z0-9_-]{24,}/.test(file))) file = '[…]';
    return m[1].toLowerCase() + '://' + host + (parts.length > 1 ? '/…/' : '/') + file + (tail ? tail[0] : '');
  }

  function cleanText(s) {
    s = String(s);
    if (s.length > 4 * MAX_TEXT) s = s.slice(0, 4 * MAX_TEXT);
    s = s.replace(URL_RE, shortUrl)
      .replace(BEARER_RE, '$1 [redacted]')
      .replace(SECRET_TEXT_RE, '$1$2[redacted]')
      .replace(QUERY_RE, '$1')
      .replace(JWT_RE, '[jwt]')
      .replace(EMAIL_RE, '[email]')
      .replace(LONG_RE, '[…]')
      .replace(HEX_RE, '[…]');
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
  }

  function cleanError(e, budget) {
    var o = { error: cleanText(e.name || 'Error'), message: cleanText(e.message || '') };
    if (e.code != null) o.code = cleanValue(e.code, 3, budget);
    if (e.status != null) o.status = cleanValue(e.status, 3, budget);
    if (e.category != null) o.category = cleanValue(e.category, 3, budget);
    if (e.stack) {
      o.stack = String(e.stack).split('\n').slice(1, 5).map(function (l) {
        return cleanText(l.trim()).replace(/\(?[a-z]+:\/\/[^)]*?\/([^\/)]+:\d+:\d+)\)?/i, '$1');
      });
    }
    return o;
  }

  function cleanValue(v, depth, budget) {
    if (--budget.n < 0) return '[…]';
    if (v == null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return isFinite(v) ? round(v, 3) : String(v);
    if (typeof v === 'string') return cleanText(v);
    if (typeof v === 'function') return undefined;
    if (v instanceof Error || (typeof v === 'object' && typeof v.message === 'string' && 'stack' in v)) return cleanError(v, budget);
    if (depth >= 4) return '[…]';
    if (Array.isArray(v)) {
      var a = v.slice(0, 16).map(function (x) { return cleanValue(x, depth + 1, budget); });
      if (v.length > 16) a.push('… ' + (v.length - 16) + ' more');
      return a;
    }
    if (typeof v === 'object') {
      var o = {}, keys = Object.keys(v).slice(0, 30);
      keys.forEach(function (k) {
        if (SECRET_KEY.test(k)) { if (v[k] != null) o[k] = '[redacted]'; return; }
        var c = cleanValue(v[k], depth + 1, budget);
        if (c !== undefined) o[k] = c;
      });
      return o;
    }
    return cleanText(v);
  }

  /** A copy of `v` that is safe to keep and share: limited in depth and size, secrets left out. */
  function clean(v, depth) { return cleanValue(v, depth || 0, { n: CLEAN_BUDGET }); }

  /**
   * What a stream is, without its URLs or DRM data: F1's stream type and platform, which request gave it
   * (device), the DRM scheme, the engine, and what the manifest offered (stream.info.offer).
   */
  function stream(s) {
    if (!s) return null;
    var o = {};
    ['contentId', 'channelId', 'feed', 'streamType', 'platform', 'live', 'hdr', 'hdrEncrypted', 'cenc', 'multiFeed'].forEach(function (k) {
      if (s[k] != null && s[k] !== false) o[k] = s[k];
    });
    if (s.grid) o.multiview = true;
    o.device = s.hdr ? 'tvos' : s.cenc ? 'chromecast' : 'web';
    o.drm = s.cenc ? 'cenc' : s.licenseUrl ? 'cbcs' : 'clear';
    if (s.info) {
      if (s.info.encrypted) o.encrypted = true;
      if (s.info.dynamic) o.dynamic = true;
      if (s.info.segDur) o.segDur = s.info.segDur;
      if (s.info.offer) o.offer = s.info.offer;
    }
    if (s.url) o.url = shortUrl(String(s.url));
    try { if (typeof Player !== 'undefined' && Player.engineName) o.engine = Player.engineName(); } catch (e) { /* none yet */ }
    return clean(o);
  }

  // ---- the log ----------------------------------------------------------------------------

  function persist() {
    while (entries.length > MAX_ENTRIES) entries.shift();
    var text = JSON.stringify(entries);
    while (text.length > MAX_CHARS && entries.length > 1) {
      entries.splice(0, Math.max(1, Math.ceil(entries.length / 10)));
      text = JSON.stringify(entries);
    }
    var s = storage();
    try { if (s) s.setItem(KEY, text); } catch (e) { /* full or disabled */ }
  }

  /** An entry over MAX_ENTRY_CHARS loses its trail, then its snapshots, then its data. */
  function fit(entry) {
    var steps = ['trail', 's', 'd'];
    for (var i = 0; i < steps.length && JSON.stringify(entry).length > MAX_ENTRY_CHARS; i++) {
      entry[steps[i]] = { tooLarge: true };
    }
    return entry;
  }

  /** Counts of left-out entries go in as 'diag.dropped' once their minute is over (or now, `all`). */
  function flushDropped(now, all) {
    var minute = Math.floor(now / 60000), added = false;
    Object.keys(bursts).forEach(function (kind) {
      var b = bursts[kind];
      if (!all && b.minute === minute) return;
      if (b.dropped) {
        entries.push({ t: now, r: run, k: 'diag.dropped', l: 'info', d: { kind: kind, count: b.dropped } });
        added = true;
      }
      if (b.minute === minute) b.dropped = 0; else delete bursts[kind];
    });
    return added;
  }

  /** Allowed by the per-kind limit; more of one kind in a minute are counted (flushDropped). */
  function admit(kind, now) {
    var minute = Math.floor(now / 60000), b = bursts[kind];
    if (!b || b.minute !== minute) b = bursts[kind] = { minute: minute, n: 0, dropped: 0 };
    if (b.n >= KIND_PER_MIN) { b.dropped++; return false; }
    b.n++;
    return true;
  }

  function addTrail(kind, data) {
    var t = { t: Date.now(), k: String(kind) };
    if (data !== undefined) { var d = clean(data, 1); if (d !== undefined && d !== null) t.d = d; }
    trailList.push(t);
    if (trailList.length > TRAIL_KEEP) trailList.splice(0, trailList.length - TRAIL_KEEP);
  }

  /**
   * A step worth knowing when something goes wrong later (a feed asked for, a seek, a track change).
   * Kept in memory only; the last ones go with the next warning or error.
   */
  function trail(kind, data) {
    try { if (recording()) addTrail(kind, data); } catch (e) { /* logging must never break the app */ }
  }

  /** State for warnings and errors: `fn` returns a snapshot (cleaned here) each time one is recorded. */
  function provide(name, fn) { providers[name] = fn; }

  /** Like provide(), for state that takes a request (the helper's log): added to the entry when it answers. */
  function provideAsync(name, fn) { asyncProviders[name] = fn; }

  function network() {
    var o = {};
    // (webapis.network's connection type needs a privilege this app doesn't ask for.)
    try { o.online = navigator.onLine; } catch (e) { /* unknown */ }
    return o;
  }

  function memory() {
    try {
      var m = performance.memory;
      return m ? { usedMB: round(m.usedJSHeapSize / 1048576, 1), limitMB: round(m.jsHeapSizeLimit / 1048576) } : null;
    } catch (e) { return null; }
  }

  /** One answer per provider for every warning within ASYNC_EVERY_MS: a burst shares the first request. */
  function askAsync(name, now) {
    var a = asyncAsked[name];
    if (a && now - a.at < ASYNC_EVERY_MS) return a.promise;
    var promise;
    try { promise = Promise.resolve(asyncProviders[name]()); } catch (e) { promise = Promise.resolve(null); }
    asyncAsked[name] = { at: now, promise: promise };
    return promise;
  }

  /** The trail and snapshots a warning or error carries. */
  function detail(entry) {
    var now = entry.t;
    // The last steps before this one (seconds before it); the entry itself is not among them yet.
    if (trailList.length) {
      entry.trail = trailList.slice(-TRAIL_ATTACH).map(function (x) {
        var o = { ago: round((now - x.t) / 1000, 1), k: x.k };
        if (x.d !== undefined) o.d = x.d;
        return o;
      });
    }
    var s = {};
    Object.keys(providers).forEach(function (name) {
      try {
        var v = clean(providers[name]());
        if (v !== undefined && v !== null) s[name] = v;
      } catch (e) { s[name] = { failed: cleanText((e && e.message) || e) }; }
    });
    if (playing && playingSince) s.playingFor = round((now - playingSince) / 1000, 1);
    s.network = clean(network());
    var mem = memory();
    if (mem) s.memory = mem;
    entry.s = s;
    Object.keys(asyncProviders).forEach(function (name) {
      askAsync(name, now).then(function (v) {
        if (v === undefined || v === null || !recording() || !entry.s || entry.s.tooLarge) return;
        entry.s[name] = clean(v);
        fit(entry);
        persist();
      }, function () { /* no answer: the entry stays as it is */ });
    });
  }

  /**
   * Records an event. kind: 'area.what' (e.g. 'play.failed'); data: anything (cleaned here);
   * level: 'error' | 'warn' (default) | 'info'. Warnings and errors also carry the trail and snapshots.
   */
  function note(kind, data, level) {
    try {
      if (!recording()) return;
      start();
      var now = Date.now();
      level = level || 'warn';
      flushDropped(now);
      if (!admit(kind, now)) { addTrail(kind); return; }
      var entry = { t: now, r: run, k: String(kind), l: level };
      var d = clean(data);
      if (d !== undefined && d !== null) entry.d = d;
      if (playingShort && kind !== 'play') entry.p = playingShort;
      if (level !== 'info') detail(entry);
      entries.push(fit(entry));
      addTrail(kind);
      persist();
    } catch (e) { /* logging must never break the app */ }
  }

  // ---- the app and the TV ------------------------------------------------------------------

  function supports(type) {
    try { return MediaSource.isTypeSupported(type) === true; } catch (e) { return null; }
  }

  /** 'Chromium 76.0.3809.146': Samsung's user agent gives the version bare ("… Gecko) 76.0.3809.146/6.0 TV Safari"). */
  function chromium(ua) {
    var m = /Chrome\/(\d+[\d.]*)/.exec(ua) || /\)\s+(\d+\.\d+\.\d+\.\d+)\/[\d.]+\s+TV\b/.exec(ua);
    return m ? 'Chromium ' + m[1] : null;
  }

  function tvInfo() {
    if (info) return info;
    var o = { format: FORMAT, build: build.label || (build.record ? 'record' : 'release') };
    try { o.version = tizen.application.getCurrentApplication().appInfo.version; } catch (e) { /* not a TV */ }
    try { o.model = webapis.productinfo.getRealModel() || webapis.productinfo.getModel(); } catch (e) { /* unknown */ }
    try { o.firmware = webapis.productinfo.getFirmware(); } catch (e) { /* unknown */ }
    try { o.tizen = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'); } catch (e) { /* unknown */ }
    try { o.browser = chromium(navigator.userAgent); o.userAgent = navigator.userAgent; } catch (e) { /* unknown */ }
    try { o.screen = screen.width + 'x' + screen.height; } catch (e) { /* unknown */ }
    try { o.hdrTv = !!webapis.avinfo.isHdrTvSupport(); } catch (e) { /* unknown */ }
    try { o.uhdPanel = !!webapis.productinfo.isUdPanelSupported(); } catch (e) { /* unknown */ }
    try { o.avplay = !!(webapis.avplay && webapis.avplay.open); } catch (e) { o.avplay = false; }
    o.codecs = {
      avcHigh: supports('video/mp4; codecs="avc1.640028"'),
      hevcMain: supports('video/mp4; codecs="hvc1.1.6.L120.B0"'),
      hevcMain10: supports('video/mp4; codecs="hvc1.2.4.L153.B0"'),
      // This TV's MSE ignores HEVC levels but honours sizes and frame rates (multiview notes, 2026-11-03).
      hevc2160p50: supports('video/mp4; codecs="hvc1.2.4.L153.B0"; width=3840; height=2160; framerate=50'),
      aac: supports('audio/mp4; codecs="mp4a.40.2"'),
      ac3: supports('audio/mp4; codecs="ac-3"'),
      eac3: supports('audio/mp4; codecs="ec-3"')
    };
    try { o.wasm = typeof WebAssembly === 'object'; } catch (e) { /* unknown */ }
    o.network = network();
    info = clean(o);
    return info;
  }

  /**
   * Which Widevine schemes the browser decrypts video with (F1 uses cbcs; its Chromecast offer cenc). Video
   * only: given audio too, the browser grants the audio part alone and the answer looks like a yes (Tizen 6).
   * Asked a while after the start: right at launch, Tizen 6 granted cbcs too, which it refuses later.
   * true only when the granted configuration names the scheme; what it said otherwise is kept.
   */
  function probeDrm() {
    var schemes = ['cenc', 'cbcs'], result = {};
    if (!navigator.requestMediaKeySystemAccess) return;
    var asks = schemes.map(function (scheme) {
      return navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.4d402a"', encryptionScheme: scheme }] }])
        .then(function (access) {
          var caps = access.getConfiguration().videoCapabilities || [];
          var named = caps.map(function (c) { return c.encryptionScheme || 'none'; });
          result[scheme] = named.indexOf(scheme) >= 0 ? true : 'granted as ' + (named.join(',') || 'no video');
        }, function (e) { result[scheme] = (e && e.name) || false; });
    });
    Promise.all(asks).then(function () { note('app.drm', { widevine: result }, 'info'); });
  }

  function beat(left) {
    write(ALIVE_KEY, { r: run, at: Date.now(), p: playing, clean: !!left });
  }

  /**
   * The previous run's last heartbeat: a video playing and no sign that the app was left
   * (hidden, closed) means it ended unexpectedly: a crash, the TV killing it, or power cut.
   */
  function checkLastRun() {
    var last = read(ALIVE_KEY);
    if (!last || typeof last !== 'object' || last.r === run || !last.p || last.clean) return;
    var at = +last.at;
    note('app.ended-while-playing', { lastSeen: at > 0 && isFinite(at) ? new Date(at).toISOString() : null,
      video: last.p, run: String(last.r) }, 'error');
  }

  function stored() {
    var list = read(KEY);
    return Array.isArray(list) ? list.filter(function (e) { return e && typeof e === 'object' && isFinite(e.t); }) : [];
  }

  /** Starts recording: once, when the first entry is written (at load, or after the viewer opts in). */
  function start() {
    if (started) return;
    started = true;
    entries = stored();
    note('app.start', tvInfo(), 'info');
    checkLastRun();
    setTimeout(function () { try { probeDrm(); } catch (e) { /* no EME */ } }, DRM_PROBE_MS);
    beat(hidden());
    // Hidden, the app keeps its "left cleanly" mark: a background app the TV closes later didn't crash.
    setInterval(function () { if (recording() && !hidden()) beat(false); }, HEARTBEAT_MS);
    var leave = function () {
      if (!recording()) return;
      beat(true);
      if (flushDropped(Date.now(), true)) persist();
    };
    window.addEventListener('pagehide', leave);
    window.addEventListener('beforeunload', leave);
    document.addEventListener('visibilitychange', function () {
      if (!recording()) return;
      if (hidden()) leave(); else beat(false);
      trail(hidden() ? 'app.hidden' : 'app.visible');
    });
  }

  /** The video the app plays now (a stream from F1Api.play), or null when it plays nothing. */
  function setPlaying(s) {
    try {
      if (!recording()) return;
      start();
      playing = s ? stream(s) : null;
      playingSince = s ? Date.now() : 0;
      playingShort = playing && clean({ id: playing.contentId, ch: playing.channelId, type: playing.streamType,
        engine: playing.engine, drm: playing.drm, live: playing.live });
      if (s) note('play', playing, 'info'); else addTrail('play.stop');
      beat(hidden());
    } catch (e) { /* logging must never break the app */ }
  }

  function init() {
    // Always listening (cheap): note() keeps nothing unless recording, which can start after load.
    window.addEventListener('error', function (ev) {
      // Resources that failed to load (an <img>) also come here, without a message.
      if (!ev || !ev.message || !recording()) return;
      note('js.error', { message: ev.message, file: ev.filename ? shortUrl(ev.filename) : null,
        line: ev.lineno, col: ev.colno, error: ev.error || null }, 'error');
    });
    window.addEventListener('unhandledrejection', function (ev) {
      if (recording()) note('js.rejection', { reason: ev && ev.reason });
    });
    if (recording()) start();
  }

  /** The log as an opt-in upload will send it. */
  function report() {
    if (started && flushDropped(Date.now(), true)) persist();
    var list = started ? entries : stored();
    return { format: FORMAT, tv: tvInfo(), run: run, at: Date.now(), entries: list.slice() };
  }

  function clear() {
    entries = [];
    bursts = {};
    trailList = [];
    var s = storage();
    try { if (s) s.removeItem(KEY); } catch (e) { /* disabled */ }
  }

  try { init(); } catch (e) { /* logging must never break the app */ }

  return {
    note: note,
    trail: trail,
    provide: provide,
    provideAsync: provideAsync,
    playing: setPlaying,
    stream: stream,
    report: report,
    clear: clear,
    recording: recording,
    clean: clean
  };
})();
