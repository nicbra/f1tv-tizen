/*
 * Every way of playing the app learns per TV (js/caps.js), in one list: a new way is added here and nowhere else.
 *   label    how the settings' "Playback on this TV" names it
 *   engine   the engine that plays it ('avplay' or 'shaka'; H.264 multiview's big feed plays on AVPlay)
 *   group    ways of which one must stay usable on every TV (Caps.usable keeps the best of a group when all are
 *            ruled out): the protected SDR ways, and unprotected video. Optional ways (4K HDR, 5.1, multiview) have
 *            none: when ruled out, the app plays without them.
 *   needs    a way it depends on: native 4K HDR is decrypted the same way as native CBCS
 *   browser  the browser protection it needs: a TV whose browser refuses cenc has no Shaka CENC
 *   report   how the diagnostics upload names it (its contract's vocabulary): 'engine' for the engine with clear input
 *            ('shaka:clear' / 'avplay:clear'), 'drm' for the copy-protected grid's DRM; missing: its own name
 */
var Ways = (function () {
  'use strict';

  var LIST = {
    'shaka:cenc': { label: 'Shaka, CENC', engine: 'shaka', group: 'sdr', browser: 'cenc' },
    'avplay:cbcs': { label: 'AVPlay, CBCS', engine: 'avplay', group: 'sdr' },
    'avplay:cenc': { label: 'AVPlay, CENC', engine: 'avplay', group: 'sdr' },
    'avplay:clear': { label: 'AVPlay, unprotected video', engine: 'avplay', group: 'clear' },
    'shaka:clear': { label: 'Shaka, unprotected video', engine: 'shaka', group: 'clear' },
    'avplay:hdr': { label: 'AVPlay, 4K HDR', engine: 'avplay', needs: 'avplay:cbcs' },
    'shaka:hdr': { label: 'Shaka, unprotected 4K HDR', engine: 'shaka', report: 'engine' },
    'avplay:ac3': { label: 'AVPlay, 5.1 sound in 4K HDR', engine: 'avplay' },
    'shaka:hlsaes': { label: 'Shaka, 4K HDR (AES-128 HLS)', engine: 'shaka' },
    'shaka:tmgrid': { label: 'Shaka, 4K HDR multiview (AES-128 HLS)', engine: 'shaka', multiview: true },
    'avplay:grid': { label: 'AVPlay, multiview', engine: 'avplay', multiview: true, report: 'engine' },
    'shaka:grid': { label: 'Shaka, multiview', engine: 'shaka', multiview: true, report: 'engine' },
    'avplay:drmgrid': { label: 'AVPlay, copy-protected multiview', engine: 'avplay', multiview: true, report: 'drm' },
    'mvsoft:h264': { label: 'Software decoding, H.264 multiview', engine: 'avplay', multiview: true, report: 'engine' }
  };

  function get(name) { return Object.prototype.hasOwnProperty.call(LIST, name) ? LIST[name] : null; }

  /** The ways of a group, in the order listed. */
  function group(name) { return Object.keys(LIST).filter(function (k) { return LIST[k].group === name; }); }

  /**
   * The way a stream plays by its own kind, before anything failed or was ruled out (app.js wayFor starts from it, and
   * player.js choose runs it for a stream the app gave no way): a multiview by its kind (clear grids on `grid.player`),
   * F1's Tiledmedia offer, native or clear 4K HDR, F1's Chromecast cenc (on AVPlay when that route was asked for), other
   * protected SDR (native cbcs), unprotected video (one feed on AVPlay, quicker to start; several feeds or a combined
   * master on Shaka, which loads the next feed beside the playing one).
   */
  function preferred(s) {
    var g = s.grid;
    if (g) {
      if (g.engine === 'tm') return 'shaka:tmgrid';
      if (g.engine === 'h264') return 'mvsoft:h264';
      return s.hdrEncrypted || s.licenseUrl || s.live ? 'avplay:drmgrid' : (g.player || 'avplay') + ':grid';
    }
    if (s.hlsAes) return 'shaka:hlsaes';
    if (s.hdrEncrypted) return 'avplay:hdr';
    if (s.cenc) return s.cencAvplay ? 'avplay:cenc' : 'shaka:cenc';
    if (s.licenseUrl) return 'avplay:cbcs';
    if (s.hdr) return 'shaka:hdr';   // AVPlay picks SDR variants from an HDR playlist
    return s.combo || s.multiFeed ? 'shaka:clear' : 'avplay:clear';
  }

  /** The engine of a way ('avplay' / 'shaka'), or null for an unknown one. */
  function engine(name) { var w = get(name); return w ? w.engine : null; }

  /**
   * How the diagnostics upload names the way a stream plays: its own name, or as the contract has it (the engine with
   * clear input; the copy-protected grid by its DRM). `engineName`: the engine that played it.
   */
  function report(name, stream, engineName) {
    var w = get(name);
    if (!w || !w.report) return name || null;
    if (w.report === 'drm') return stream && stream.hdrEncrypted ? 'avplay:hdr' : stream && stream.cenc ? 'avplay:cenc' : 'avplay:cbcs';
    return stream && stream.licenseUrl ? name : (engineName || w.engine) + ':clear';
  }

  return { list: function () { return Object.keys(LIST); }, get: get, group: group, engine: engine, preferred: preferred, report: report };
})();
