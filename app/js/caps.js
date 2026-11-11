/* Per-firmware playback evidence. No model/version guesses: the same engine differs between TVs. */
var Caps = (function () {
  var KEY = 'f1tv.caps', firmware = 'unknown', timer = null;
  var SDR = ['shaka:cenc', 'avplay:cbcs', 'avplay:cenc'];
  try { firmware = String(webapis.productinfo.getFirmware()); } catch (e) { /* desktop or unavailable */ }
  var record;
  try { record = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* unavailable or corrupt */ }
  if (!record || record.version !== 1 || record.firmware !== firmware || !record.paths || !record.browser) {
    record = { version: 1, firmware: firmware, browser: { cenc: null, cbcs: null }, paths: {} };
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(record)); } catch (e) { /* full or disabled */ }
  }

  function count(path, outcome) {
    var p = record.paths[path] || (record.paths[path] = { ok: 0, failed: 0, crashed: 0, last: 0 });
    p[outcome]++;
    p.last = Date.now();
    save();
  }

  // A heartbeat left from the last run means it ended while protected video played on AVPlay: a crash (the app
  // vanishes, issue #1), a kill or a power cut. Counted only when the app is started again within 10 minutes (after a
  // power cut the TV is usually off for longer); one alone never rules out a path (see avoided).
  var marker = record.playing;
  delete record.playing;
  if (marker && marker.path && Date.now() >= marker.at && Date.now() - marker.at < 10 * 60000) count(marker.path, 'crashed');
  save();

  function avoided(path) {
    var p = record.paths[path];
    return !!p && (p.crashed >= 2 || (p.crashed >= 1 && p.failed >= 1) || p.failed >= 2);
  }

  function score(path) {
    var p = record.paths[path];
    return p ? p.crashed * 2 + p.failed : 0;
  }

  function usable(path) {
    // HDR is optional and depends on native cbcs, even when cbcs is the only SDR last resort left.
    if (path === 'avplay:hdr' && avoided('avplay:cbcs')) return false;
    if (!avoided(path)) return true;
    // Keep a last resort even if every SDR path has failed. HDR is optional, never the last resort.
    var best = SDR[0];
    for (var i = 0; i < SDR.length; i++) {
      if (!avoided(SDR[i])) return false;
      if (score(SDR[i]) < score(best)) best = SDR[i];
    }
    return path === best;
  }

  function crashEnd() {
    clearInterval(timer);
    timer = null;
    if (record.playing) { delete record.playing; save(); }
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
    function result(supported) { record.browser[scheme] = supported; save(); }
    try {
      navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.4d402a"', encryptionScheme: scheme }] }])
        .then(function (access) {
          var config = access.getConfiguration();
          result(!!config.videoCapabilities && config.videoCapabilities.some(function (v) { return v.encryptionScheme === scheme; }));
        }, function () { result(false); }).catch(function () { result(false); });
    } catch (e) { result(false); }
  }

  setTimeout(function () { probe('cenc'); probe('cbcs'); }, 10000);
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', crashEnd);
    window.addEventListener('beforeunload', crashEnd);
    window.addEventListener('unload', crashEnd);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', function () {
    if (document.hidden) crashEnd();
  });

  /** Forgets everything learned on this TV (the settings' Playback on this TV). */
  function reset() {
    crashEnd();
    var browser = record.browser;
    record = { version: 1, firmware: firmware, browser: browser, paths: {} };
    save();
  }

  return {
    ok: function (path) { count(path, 'ok'); },
    avoided: avoided, reset: reset,
    failed: function (path) { count(path, 'failed'); },
    crashStart: crashStart, crashEnd: crashEnd, usable: usable,
    browser: function (scheme) { return record.browser[scheme]; },
    report: function () { return JSON.parse(JSON.stringify(record)); }
  };
})();
