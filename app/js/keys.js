/* Samsung remote key codes and registration of the media keys we use. */
var Keys = (function () {
  var codes = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, EXIT: 10182,
    PLAY: 415, PAUSE: 19, PLAY_PAUSE: 10252, STOP: 413,
    FF: 417, RW: 412, NEXT: 10233, PREV: 10232,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    CH_UP: 427, CH_DOWN: 428
  };

  var toRegister = [
    'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop',
    'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious',
    'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
    'ChannelUp', 'ChannelDown'
  ];

  function register() {
    if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
    toRegister.forEach(function (name) {
      try { tizen.tvinputdevice.registerKey(name); } catch (e) { /* not on this model */ }
    });
  }

  // Desktop-browser fallbacks so the UI can be tried with a keyboard.
  function normalize(e) {
    if (e.keyCode === 8 || e.keyCode === 27) return codes.BACK;
    if (e.keyCode === 32) return codes.PLAY_PAUSE;
    return e.keyCode;
  }

  return { codes: codes, register: register, normalize: normalize };
})();
