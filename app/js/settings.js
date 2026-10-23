/* Viewer preferences, kept in localStorage. */
var Settings = (function () {
  var KEY = 'f1tv.settings';
  var defaults = {
    timing: true,        // timing tower overlay in the player
    audio: 'eng',        // preferred commentary track (language code, 'fx' = track sound only)
    subtitles: '',       // subtitle language, '' = off
    spoilerFree: false   // hide result-revealing artwork and timing on replays
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
