/* Per-firmware playback evidence. No model/version guesses: the same engine differs between TVs. */
var Caps = (function () {
  var KEY = 'f1tv.caps', firmware = 'unknown', timer = null;
  var DAY = 86400000;
  // A path ruled out comes back for one try after a while (a bad evening, F1's servers or a since fixed bug should not
  // turn something off for good): 3 days after failures, 14 after a crash, twice as long after each try that went wrong
  // again, at most 60 days.
  var RETRY_FAILED = 3 * DAY, RETRY_CRASHED = 14 * DAY, RETRY_MAX = 60 * DAY;
  // A crash wears off after three clean runs of at least 10 minutes on the same path.
  var CLEAN_RUN = 10 * 60000, CLEAN_RUNS = 3;
  /**
   * Paths a release fixed, with a label for that release: { 'avplay:hdr': '1.3.0' } forgets the path's crashes once
   * on every TV that runs it. Failures are forgotten with every app update anyway (see below).
   */
  var FIXED = {};
  try { firmware = String(webapis.productinfo.getFirmware()); } catch (e) { /* desktop or unavailable */ }
  var record;
  try { record = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* unavailable or corrupt */ }
  if (!record || record.version !== 1 || record.firmware !== firmware || !record.paths || !record.browser) {
    record = { version: 1, firmware: firmware, browser: { cenc: null, cbcs: null }, paths: {} };
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(record)); } catch (e) { /* full or disabled */ }
  }

  // Told when the evidence changes ('paths' or 'browser'), not on heartbeats: the diagnostics logs follow it.
  var listeners = [];
  function changed(kind) {
    listeners.forEach(function (fn) { try { fn(kind); } catch (e) { /* a listener never breaks playback */ } });
  }

  function entry(path) {
    return record.paths[path] || (record.paths[path] = { ok: 0, failed: 0, crashed: 0, last: 0 });
  }

  function count(path, outcome) {
    var p = entry(path), wasOut = ruledOut(p);
    p.streak = failures(p);
    p[outcome]++;
    // A good start clears the failures, not a crash's longer wait: the Tizen 9 crash came seconds after good starts.
    if (outcome === 'ok') { p.streak = 0; if (!crashes(p)) p.retries = 0; }
    else {
      if (outcome === 'failed') p.streak++;
      p.badAt = Date.now();
      // A second chance that went wrong too: the next one waits longer.
      if (wasOut) p.retries = (p.retries || 0) + 1;
    }
    p.last = Date.now();
    save();
    changed('paths');
  }

  /**
   * A failure that says nothing about the path (the network, F1's servers or the licence server: see
   * js/failure.js 'transient'): kept as a number, never towards ruling the path out.
   */
  function unclear(path) {
    var p = entry(path);
    p.unclear = (p.unclear || 0) + 1;
    p.last = Date.now();
    save();
    changed('paths');
  }

  // A heartbeat left from the last run means it ended while protected video played on AVPlay: a crash (the app
  // vanishes, issue #1), a kill or a power cut. Counted only when the app is started again within 10 minutes (after a
  // power cut the TV is usually off for longer); one alone never rules out a path (see avoided).
  var marker = record.playing, previous = null;
  delete record.playing;
  if (marker && marker.path && Date.now() >= marker.at && Date.now() - marker.at < 10 * 60000) {
    count(marker.path, 'crashed');
    previous = { path: marker.path, minutes: Math.floor((Date.now() - marker.at) / 60000) };
  }

  // A new app version (an installed package or a downloaded bundle, rollbacks too) forgets the failures: they may have
  // been the app's. Crashes stay (the TV's own player is the usual cause) unless the release lists the path in FIXED.
  var version = '';
  try { version = String((typeof Launcher !== 'undefined' && Launcher.version) || tizen.application.getCurrentApplication().appInfo.version || ''); }
  catch (e) { /* desktop or unavailable: no version, nothing forgotten */ }
  if (version && record.appVersion !== version) {
    Object.keys(record.paths).forEach(function (k) {
      var p = record.paths[k];
      p.streak = 0;
      if (!crashes(p)) p.retries = 0;
    });
    record.appVersion = version;
  }
  // Records from before `badAt`: their last outcome was the bad one (only adverse evidence restarts a wait from now on).
  Object.keys(record.paths).forEach(function (k) {
    var p = record.paths[k];
    if (p.badAt == null && (p.failed || p.crashed)) p.badAt = p.last || 0;
  });
  record.fixed = record.fixed || {};
  Object.keys(FIXED).forEach(function (k) {
    if (record.fixed[k] === FIXED[k]) return;
    var p = record.paths[k];
    if (p) { p.forgiven = p.crashed; p.streak = 0; p.retries = 0; p.cleanRuns = 0; }
    record.fixed[k] = FIXED[k];
  });
  save();

  /**
   * Failed starts since the path last started fine. A start that fails now and then (a CDN or licence blip) is no
   * evidence against a path that works: lifetime counts turned 4K HDR off on this TV after 31 good starts and 2
   * connection failures (Las Vegas FP2, 2026-11-20). Crashes stay counted for good: on the Tizen 9 TV (issue #1)
   * playback started fine and crashed seconds later, so a good start says nothing about them. Records from before
   * `streak` existed don't tell the order: any success there counts as the latest outcome.
   */
  function failures(p) {
    return p.streak != null ? p.streak : (p.ok > 0 ? 0 : p.failed);
  }

  /** Crashes still held against the path: those not worn off by clean runs or forgotten by a fix (`crashed` is all of them). */
  function crashes(p) {
    return Math.max(0, p.crashed - (p.forgiven || 0));
  }

  function ruledOut(p) {
    var c = crashes(p), f = failures(p);
    return c >= 2 || (c >= 1 && f >= 1) || f >= 2;
  }

  /** Ruled out and not yet due for its next try (records from before `badAt` count from their last outcome). */
  function avoided(path) {
    var p = record.paths[path];
    if (!p || !ruledOut(p)) return false;
    var wait = Math.min(RETRY_MAX, (crashes(p) ? RETRY_CRASHED : RETRY_FAILED) * Math.pow(2, p.retries || 0));
    return Date.now() - (p.badAt || 0) < wait;
  }

  function score(path) {
    var p = record.paths[path];
    return p ? crashes(p) * 2 + failures(p) : 0;
  }

  function usable(path) {
    var way = Ways.get(path);
    // A way that depends on another (native 4K HDR on native cbcs) is out with it, even when that one is a last resort.
    if (way && way.needs && avoided(way.needs)) return false;
    if (!avoided(path)) return true;
    // Keep a last resort of each group (js/ways.js: protected SDR, unprotected video) even if all of it has failed.
    // Optional ways (4K HDR, 5.1, multiview) are never one. Only ways this TV has: with the browser's cenc refused, an
    // untried Shaka way would otherwise leave no native way usable, and the app would take the first one even if it
    // crashed (2 crashes) and the other only failed.
    if (!way || !way.group) return false;
    var members = Ways.group(way.group).filter(function (p) { var b = Ways.get(p).browser; return !b || record.browser[b] !== false; });
    var best = members[0];
    for (var i = 0; i < members.length; i++) {
      if (!avoided(members[i])) return false;
      if (score(members[i]) < score(best)) best = members[i];
    }
    return path === best;
  }

  /**
   * The protected AVPlay video stopped playing. Unless it ended in a failure (`failed`), a run of at least 10 minutes is a
   * clean one, and every third clean run wears one crash off.
   */
  function crashEnd(failed) {
    clearInterval(timer);
    timer = null;
    var run = record.playing;
    if (!run) return;
    delete record.playing;
    var p = record.paths[run.path];
    // Only while a crash is held against the path: earlier good evenings don't cancel a crash that comes later.
    if (failed !== true && p && crashes(p) && Date.now() - run.since >= CLEAN_RUN) {
      p.cleanRuns = (p.cleanRuns || 0) + 1;
      if (p.cleanRuns >= CLEAN_RUNS) {
        p.forgiven = (p.forgiven || 0) + 1;
        p.cleanRuns = 0;
        if (!crashes(p)) p.retries = 0;
        changed('paths');
      }
    }
    save();
  }

  function crashStart(path) {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (record.playing && record.playing.path === path) return;
    crashEnd();
    var since = Date.now();
    function beat() { record.playing = { path: path, since: since, at: Date.now() }; save(); }
    beat();
    timer = setInterval(beat, 5000);
  }

  function probe(scheme) {
    // Measured on QE55Q77A/Tizen 6: cenc is granted, cbcs refused. Including audio grants just audio;
    // an early/lenient probe also lied. Ask video-only after 10 s and inspect the granted scheme.
    function result(supported) { record.browser[scheme] = supported; save(); changed('browser'); }
    try {
      navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.4d402a"', encryptionScheme: scheme }] }])
        .then(function (access) {
          var granted = access.getConfiguration().videoCapabilities || [];
          if (!granted.length) return result(false);   // video was not granted for this scheme
          // Engines before Chromium 58 drop the unknown encryptionScheme member: a granted video
          // capability without it is "unknown" (null), not "no"; the TV's own playback evidence
          // (ok/failed) still prunes the path if it really does not work there.
          var known = granted.some(function (v) { return v.encryptionScheme != null; });
          result(known ? granted.some(function (v) { return v.encryptionScheme === scheme; }) : null);
        }, function () { result(false); }).catch(function () { result(false); });
    } catch (e) { result(false); }
  }

  setTimeout(function () { probe('cenc'); probe('cbcs'); }, 10000);
  if (typeof window !== 'undefined') {
    ['pagehide', 'beforeunload', 'unload'].forEach(function (name) { window.addEventListener(name, function () { crashEnd(); }); });
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', function () {
    if (document.hidden) crashEnd();
  });

  /** Forgets everything learned on this TV (the settings' Playback on this TV). */
  function reset() {
    crashEnd();
    var browser = record.browser;
    record = { version: 1, firmware: firmware, browser: browser, paths: {}, appVersion: record.appVersion, fixed: record.fixed };
    save();
    changed('paths');
  }

  return {
    ok: function (path) { count(path, 'ok'); },
    avoided: avoided, reset: reset,
    /** A failed start or playback on the path; `unclear` when the cause was the network or a server (not counted against it). */
    failed: function (path, isUnclear) { if (isUnclear) unclear(path); else count(path, 'failed'); },
    crashStart: crashStart, crashEnd: crashEnd, usable: usable,
    browser: function (scheme) { return record.browser[scheme]; },
    report: function () { return JSON.parse(JSON.stringify(record)); },
    /** The heartbeat this start found (the app ended while protected video played): { path, minutes } or null. */
    previousRun: function () { return previous; },
    onChange: function (fn) { listeners.push(fn); }
  };
})();

// The diagnostics upload sends what this TV can play when it changes (projected; no counts or times).
if (typeof DiagUpload !== 'undefined') Caps.onChange(function () { DiagUpload.caps(); });

// The local diagnostics log (developer builds) shows the evidence with every warning and notes probe results.
if (typeof Diag !== 'undefined') {
  Diag.provide('caps', function () { var r = Caps.report(); delete r.playing; return r; });
  Caps.onChange(function (kind) { if (kind === 'browser') Diag.note('caps.browser', { widevine: Caps.report().browser }, 'info'); });
}
