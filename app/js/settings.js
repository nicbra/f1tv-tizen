/* Viewer preferences, kept in localStorage. */
var Settings = (function () {
  var KEY = 'f1tv.settings';
  var defaults = {
    timing: true,        // timing tower overlay in the player
    tower: '',           // what the tower shows (see TOWER_VIEWS in app.js); '' = the session's default
    audio: 'eng',        // preferred commentary track (language code, 'fx' = track sound only)
    onboardAudio: 'teamradio',   // an onboard's sound: its team radio, or what the viewer picked on an onboard
    subtitles: '',       // subtitle language, '' = off
    spoilerFree: false,  // blur the artwork of replays and highlights
    hdr: true,           // 4K HDR where the subscription and TV allow it; off: always SDR
    multiview: 'side2',  // the multiview layout offered first (HdrStream.layouts; experiment)
    updates: 'automatic', // automatic | off (legacy booleans are read below)
    diagnostics: 'off',  // opt-in upload of diagnostics events: 'off' | 'basic' (js/diag-upload.js)
    diagnosticsAsked: false   // the one-time question about diagnostics was answered
  };
  var values = {};

  try { values = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { values = {}; }

  function get(k) {
    var v = values[k] !== undefined ? values[k] : defaults[k];
    if (k === 'updates') return v === false || v === 'off' ? 'off' : 'automatic';
    return v;
  }

  function set(k, v) {
    values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(values)); } catch (e) { /* storage disabled */ }
  }

  return { get: get, set: set };
})();
