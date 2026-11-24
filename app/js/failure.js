/*
 * What a playback failure means, decided in one place. Two answers:
 *   Failure.info(e)   { code, platform }: a stable code for the diagnostics upload (never display text).
 *   Failure.cause(e)  what the recovery (app.js recover) does about it:
 *     'cancelled'  the viewer or a newer load stopped it: nothing to do
 *     'transient'  the network, a server, a licence download, the stream helper being busy, the app's own worker: it
 *                  says nothing about the way of playing (Caps counts it as unclear); that way gets one more try
 *     'unsure'     either a blip or the way (AVPlay's CONNECTION_FAILED): one more try, and if that fails too, it
 *                  counts against the way
 *     'content'    this video's offer or feeds can't play this way (an offer the app can't use, feeds the helper can't
 *                  combine): the way is off for this video, nothing is learned about the TV
 *     'stuck'      AVPlay's preparation hung, or its player won't open again
 *     'way'        the engine failed with this stream: the way is off for this video and counts against it on this TV
 * Errors the app makes carry their cause (`e.failure`, set where they are thrown: hdr.js, mvsoft.js, proxy.js) and
 * their code (`e.diag`); the engines' own errors are read by their codes. Message text is read only for the few
 * fixed messages listed below.
 */
var Failure = (function () {
  'use strict';

  // AVPlay's error types the diagnostics contract keeps as they are (others: AVPLAY_ERROR without a platform code).
  var AV_ERRORS = { PLAYER_ERROR_CONNECTION_FAILED: 'NETWORK_ERROR', PLAYER_ERROR_NOT_SUPPORTED_FORMAT: 'UNSUPPORTED',
    PLAYER_ERROR_NOT_SUPPORTED_FILE: 'UNSUPPORTED', PLAYER_ERROR_INVALID_STATE: 'AVPLAY_ERROR', PLAYER_ERROR_INVALID_OPERATION: 'AVPLAY_ERROR',
    PLAYER_ERROR_INVALID_PARAMETER: 'AVPLAY_ERROR', PLAYER_ERROR_NO_SUCH_FILE: 'AVPLAY_ERROR', PLAYER_ERROR_SEEK_FAILED: 'AVPLAY_ERROR',
    PLAYER_ERROR_NONE: 'AVPLAY_ERROR' };

  function avError(type) {
    var t = String(type == null ? '' : type).trim();
    return AV_ERRORS[t] ? { code: AV_ERRORS[t], platform: t } : { code: 'AVPLAY_ERROR', platform: null };
  }

  // Shaka's error categories (shaka.util.Error.Category): NETWORK 1, DRM 6; the rest is SHAKA_ERROR.
  var SHAKA_CODES = { 1: 'NETWORK_ERROR', 6: 'DRM_ERROR' };

  /**
   * A stable error code and the engine's own identifier for a playback failure, taken from the error itself:
   * { code: 'SHAKA_ERROR' | 'AVPLAY_ERROR' | 'DRM_ERROR' | ..., platform: '6007' | 'PLAYER_ERROR_...' | null }.
   */
  function info(e) {
    if (!e) return { code: 'UNKNOWN', platform: null };
    if (e.diag && e.diag.code) return e.diag;
    if (e.code === 'PREPARE_TIMEOUT' || e.code === 'PLAYER_STUCK') return { code: e.code, platform: null };
    if (typeof e.code === 'number' && typeof e.category === 'number') {
      // 4032: CONTENT_UNSUPPORTED_BY_BROWSER (no playable variant); 3016 with media error 3: MEDIA_ERR_DECODE.
      var shaka = e.code === 4032 ? 'UNSUPPORTED' : e.code === 3016 && e.data && e.data[0] === 3 ? 'DECODE_ERROR'
        : SHAKA_CODES[e.category] || 'SHAKA_ERROR';
      return { code: shaka, platform: e.code >= 0 && e.code % 1 === 0 ? String(e.code) : null };
    }
    if (typeof e === 'string' && /^PLAYER_ERROR_[A-Z_]+$/.test(e.trim())) return avError(e);
    if (e.name && /^PLAYER_ERROR_[A-Z_]+$/.test(e.name)) return avError(e.name);
    // An HTTP answer (F1's API): a server failure is a network problem; a refusal (4xx) is something else.
    if (typeof e.status === 'number') return { code: e.status >= 500 ? 'NETWORK_ERROR' : 'OTHER', platform: null };
    var m = String(e.message || '');
    // This app's own fixed messages (never text from a server).
    if (/^encrypted HDR stream$|^HDR: (?!media request failed)/.test(m)) return { code: 'UNSUPPORTED', platform: null };
    if (/^HDR: media request failed|^HDR preparation timed out/.test(m)) return { code: 'NETWORK_ERROR', platform: null };
    if (/^helper did not answer$|^Stream helper service did not start$|^Could not prepare (HDR manifest|multiview)$/.test(m)) return { code: 'HELPER_ERROR', platform: null };
    if (e instanceof TypeError && /fetch|network/i.test(m)) return { code: 'NETWORK_ERROR', platform: null };
    return { code: 'OTHER', platform: null };
  }

  /** An error of this app's own, with its cause and code: Failure.make('…', 'content', 'UNSUPPORTED'). */
  function make(message, cause, code, platform) {
    var e = new Error(message);
    e.failure = cause;
    e.diag = { code: code || 'OTHER', platform: platform || null };
    return e;
  }

  /**
   * What the recovery does about a failure (see above). `e`: the error (or an engine's error type); `known`: its
   * { code, platform } when the engine reported that instead (Player 'error' events); `message`: their text.
   */
  function cause(e, known, message) {
    var m = String(message != null ? message : (e && e.message) || (typeof e === 'string' ? e : ''));
    if (m === 'cancelled') return 'cancelled';
    if (e && e.failure) return e.failure;
    if (e && (e.code === 'PREPARE_TIMEOUT' || e.code === 'PLAYER_STUCK')) return 'stuck';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'transient';
    // The TS worker stopped under a segment (ts-offload.js): the app's own; later loads transmux on the page.
    if (/TS worker stopped/.test(m)) return 'transient';
    var i = known || info(e);
    // AVPlay's CONNECTION_FAILED: mostly a blip (2 between 31 good 4K HDR starts, Las Vegas FP2), but also what it says
    // about media it can't read (Tizen 6, unpatched senc).
    if (i.code === 'NETWORK_ERROR') return i.platform === 'PLAYER_ERROR_CONNECTION_FAILED' ? 'unsure' : 'transient';
    if (/PLAYER_ERROR_CONNECTION_FAILED/.test(m)) return 'unsure';
    // AVPlay's licence download ('License: '), except a refusal (4xx: this TV or account may never get one).
    if (i.code === 'DRM_ERROR' && (i.platform === '6007' || (/^License: /.test(m) && !/answered 4\d\d/.test(m)))) return 'transient';
    if (i.code === 'HELPER_ERROR') return /did not (answer|start)$/.test(m) ? 'transient' : 'content';
    // A clear HDR answer whose playlist has keys (app.js), or an HDR answer hdr.js couldn't use.
    if (i.code === 'UNSUPPORTED' && (m === 'encrypted HDR stream' || /^HDR: /.test(m))) return 'content';
    return 'way';
  }

  return { info: info, make: make, cause: cause, avError: avError };
})();
