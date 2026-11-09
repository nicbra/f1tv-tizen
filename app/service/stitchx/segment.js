/*
 * One stitched segment, ready to play: the feeds' TS segments (and the sound's) -> fMP4 fragments (video, audio) and,
 * when asked, the init segments. Shared by stitch-worker.js (MSE in the page) and serve-dash.js (DASH, served the way
 * the app's helper would serve it to AVPlay).
 *
 *   StitchSegment.build(bytes, { segment, start, delay, level, timing, feeds, audio, init })
 *     bytes: one TS segment (Uint8Array) per feed, then the sound's own segment if audio.separate
 *     segment: the index (fragment sequence number - 1); start: its start in the playlist (s); delay: presentation
 *     minus media time (s, default 0.1); level: the stream's fixed H.264 level (default: StitchX.streamLevel); timing: StitchX.samples
 *     mode; feeds: how many of `bytes` are feeds; audio: { feed, separate } or null; init: also make the init segments;
 *     lanes: StitchX lanes (exact and conforming: one picture per feed and display time); stamp: frame stamps
 *   -> { video, audio (or null), info, duration (s), init: { video, codec, audio, audioCodec, meta } (with `init`) }
 *
 * Sound: AAC from the TS of feed `audio.feed` (muxed) or from its own segment (TS or packed .aac, aligned with the
 * feeds'), on the clock of feed `audio.feed`: its time = start + delay + (audio PTS - that feed's first video PTS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tsdemux.js'), require('./stitchx.js'), require('./fmp4.js'));
  else root.StitchSegment = factory(root.TsDemux, root.StitchX, root.Fmp4);
})(this, function (TsDemux, StitchX, Fmp4) {
  'use strict';
  var TS = 90000;

  function hex2(b) { return (b < 16 ? '0' : '') + b.toString(16).toUpperCase(); }

  function sound(bytes, videoUnits, k, start, delay) {
    var a = TsDemux.audio(bytes);
    if (!a) return null;
    var pts0 = Infinity;
    videoUnits.forEach(function (u) { if (u.pts !== null && u.pts < pts0) pts0 = u.pts; });
    var rate = a.config.rate, t = start + delay + (a.frames[0].pts - pts0) / TS;
    var samples = a.frames.map(function (f) { return { data: f.data, duration: 1024 }; });
    return { config: a.config, frames: a.frames.length,
      frag: Fmp4.fragment(k + 1, Math.max(0, Math.round(t * rate)), samples, { track: 2, raw: true }) };
  }

  function build(bytes, o) {
    var n = o.feeds || bytes.length, k = o.segment || 0, delay = o.delay || 0.1, t0 = Date.now();
    var units = bytes.slice(0, n).map(function (b) { return TsDemux.video(b); });
    // The timeline (frame count, duration) from all frames, before any are left out.
    var base = StitchX.analyse(units[0]);
    // o.dropNonRef: leave out every feed's non-reference frames (B frames: nothing predicts from them), e.g. for decoders
    // that take no B slices.
    if (o.dropNonRef) units = units.map(function (us) { return us.filter(function (u) { return !u.nonRef; }); });
    // One SPS for the whole stream: the level from the size and the feed count (the same for every segment).
    // o.maxDpb: the decoder's reference cap (SPS max_num_ref_frames / max_dec_frame_buffering at most this).
    var gap = Math.max(0, Math.min(1, Math.floor(+o.gap || 0)));   // StitchX takes one gray macroblock row at most
    var level = o.level || (o.interleave ? StitchX.interleaveLevel(base.sps.widthMbs, base.sps.heightMbs + (o.feedTag ? 1 : 0), n, 90000 / (base.frameDur || 1800)) : StitchX.streamLevel(base.sps.widthMbs, base.sps.heightMbs, n, 90000 / (base.frameDur || 1800) * (o.edges ? 2 : 1),
      (o.stamp ? 1 : 0) + (o.edges ? 2 * (o.edges === true ? 1 : o.edges) + 1 : gap) * (n - 1)));   // edges: band rows, and up to an edge picture per picture
    if (!level) throw new Error('no H.264 level fits ' + n + ' feeds of ' + base.sps.widthMbs * 16 + 'x' + base.sps.heightMbs * 16);
    // o.interleave: the feeds' frames one after another (each picture one whole feed frame; no seams), for a renderer
    // that gets every decoded picture (EMSS video texture).
    var st = o.interleave ? StitchX.interleaveSegment(units, { segment: k, fixedLevel: level, maxDpb: o.maxDpb || null, reorder: o.reorder != null ? o.reorder : null, dropB: o.dropB || null, targetFps: o.targetFps || null, feedTag: !!o.feedTag, decodeOrder: o.decodeOrder }) :
      StitchX.stitchSegment(units, { segment: k, fixedLevel: level, lanes: !!o.lanes, stamp: !!o.stamp, maxDpb: o.maxDpb || null, reorder: o.reorder != null ? o.reorder : null, gap: gap, fmo: o.fmo || null, edges: !!o.edges });
    var start = Math.round(o.start * TS), frameDur = base.frameDur || 1800, frames = base.frames.length;
    var samples = StitchX.samples(st, { start: start, frameDur: frameDur, frames: frames, delay: Math.round(delay * TS), mode: o.timing, stepMs: o.stepMs || null, spread: !!o.spread, markEvery: o.markEvery || 0, markMs: o.markMs || 0 });
    var out = { video: Fmp4.fragment(k + 1, start, samples), audio: null, info: st.info, duration: frames * frameDur / TS };
    var snd = null;
    if (o.audio) {
      var af = o.audio.feed || 0;
      snd = sound(o.audio.separate ? bytes[n] : bytes[af], units[af], k, o.start, delay);
      if (snd) out.audio = snd.frag;
    }
    if (o.init) {
      var nal = function (t) { return StitchX.nals(st.aus[0]).filter(function (x) { return x.type === t; })[0]; };
      var sps = new Uint8Array([0x67].concat(Array.prototype.slice.call(StitchX.escape(nal(7).rbsp))));
      var pps = new Uint8Array([0x68].concat(Array.prototype.slice.call(StitchX.escape(nal(8).rbsp))));
      var w = st.sps.widthMbs * 16, h = st.sps.heightMbs * 16, rows = base.sps.heightMbs * 16;
      out.init = {
        video: Fmp4.init({ sps: sps, pps: pps, width: w, height: h }),
        codec: 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]),
        audio: snd ? Fmp4.initAudio({ config: snd.config }) : null,
        audioCodec: snd ? Fmp4.audioCodec(snd.config) : null,
        audioConfig: snd ? snd.config : null,
        meta: { width: w, height: h, regions: n, regionRows: rows, gapRows: st.info.gapRows || 0, visibleRows: base.sps.crop ? rows - base.sps.crop[3] * 2 : rows, delay: delay, stamp: !!o.stamp, interleaved: o.interleave ? n : 0, feedTag: st.info.feedTag || null }
      };
    }
    out.info.ms = Date.now() - t0;
    return out;
  }

  return { build: build };
});
