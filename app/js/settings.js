/* Viewer preferences, kept in localStorage. */
var Settings = (function () {
  var KEY = 'f1tv.settings';
  var defaults = {
    timing: true,        // timing tower overlay in the player
    tower: '',           // what the tower shows (see TOWER_VIEWS in app.js); '' = the session's default
    audio: 'eng',        // preferred commentary track (language code, 'fx' = track sound only)
    subtitles: '',       // subtitle language, '' = off
    spoilerFree: false,  // blur the artwork of replays and highlights
    updates: true        // look for a newer release on GitHub once a day
  };
  var values = {};

  try { values = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { values = {}; }

  function get(k) { return values[k] !== undefined ? values[k] : defaults[k]; }

  function set(k, v) {
    values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(values)); } catch (e) { /* storage disabled */ }
  }

  return { get: get, set: set };
})();
