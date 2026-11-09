/*
 * Fragmented MP4 for a stitched H.264 stream and its sound (MSE, AVPlay through a DASH manifest).
 * Fmp4.init({ sps, pps, width, height, track }) -> video init segment (ftyp + moov, avcC from the SPS/PPS), 90 kHz
 * Fmp4.initAudio({ config: { objectType, rateIndex, rate, channels }, track }) -> AAC init segment (mp4a + esds),
 *   timescale = the sample rate
 * Fmp4.fragment(seq, baseDts, samples, { track, raw }) -> moof + mdat; samples: [{ data, duration, cto, sync }]:
 *   data is an Annex B access unit (video), or a raw AAC frame with `raw` (audio: every sample a sync sample).
 * Composition offsets are signed (trun version 1). Fmp4.audioCodec(config) -> 'mp4a.40.2'.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fmp4 = factory();
})(this, function () {
  'use strict';
  var TIMESCALE = 90000;

  function u32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
  function u16(v) { return [(v >>> 8) & 255, v & 255]; }
  function str(s) { return s.split('').map(function (c) { return c.charCodeAt(0); }); }
  function cat(parts) {
    var n = 0, k = 0; parts.forEach(function (p) { n += p.length; });
    var out = new Uint8Array(n); parts.forEach(function (p) { out.set(p, k); k += p.length; });
    return out;
  }
  function box(type) {
    var parts = [].slice.call(arguments, 1).map(function (p) { return p instanceof Uint8Array ? p : new Uint8Array(p); });
    var body = cat(parts);
    return cat([new Uint8Array(u32(8 + body.length).concat(str(type))), body]);
  }
  function full(type, version, flags) {
    return box.apply(null, [type, [version].concat(u32(flags).slice(1))].concat([].slice.call(arguments, 3)));
  }

  // Annex B access unit -> NAL units without start codes (SPS/PPS/AUD dropped: they live in avcC).
  function nalUnits(au) {
    var starts = [];
    for (var i = 0; i + 2 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) { starts.push(i + 3); i += 2; }
    return starts.map(function (s, k) {
      var e = k + 1 < starts.length ? starts[k + 1] - 3 : au.length;
      while (e > s && au[e - 1] === 0) e--;
      return au.subarray(s, e);
    }).filter(function (n) { var t = n[0] & 31; return t !== 7 && t !== 8 && t !== 9; });
  }
  function avcc(au) {
    return cat(nalUnits(au).map(function (n) { return cat([new Uint8Array(u32(n.length)), n]); }));
  }

  var MATRIX = [].concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

  // ftyp + moov with one track: `media` = { handler, timescale, entry (the sample entry box), header (vmhd/smhd box) }.
  function movie(track, media, w, h, volume) {
    var stbl = box('stbl', full('stsd', 0, 0, u32(1), media.entry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
      full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
    var minf = box('minf', media.header, box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    var mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(media.timescale), u32(0), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), str(media.handler), new Array(12).fill(0), str('stitched'), [0]), minf);
    var tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(track), u32(0), u32(0), new Array(8).fill(0), u16(0), u16(0), u16(volume), u16(0), MATRIX,
      u32(w << 16), u32(h << 16));
    var mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(media.timescale), u32(0), u32(0x10000), u16(0x100), new Array(10).fill(0), MATRIX,
      new Array(24).fill(0), u32(track + 1));
    var mvex = box('mvex', full('trex', 0, 0, u32(track), u32(1), u32(0), u32(0), u32(0)));
    return cat([box('ftyp', str('isom'), u32(512), str('isom'), str('iso6'), str(media.handler === 'vide' ? 'avc1' : 'mp41'), str('mp41')),
      box('moov', mvhd, box('trak', tkhd, mdia), mvex)]);
  }

  function audioConfig(c) { return [(c.objectType << 3) | (c.rateIndex >> 1), ((c.rateIndex & 1) << 7) | (c.channels << 3)]; }
  function audioCodec(c) { return 'mp4a.40.' + c.objectType; }

  function initAudio(o) {
    var c = o.config, asc = audioConfig(c), track = o.track || 2;
    var dsi = [5, asc.length].concat(asc);
    var dcd = [4, 13 + dsi.length, 0x40, 0x15, 0, 0, 0].concat(u32(0), u32(0), dsi);
    var esd = [3, 3 + dcd.length + 3].concat(u16(track), [0], dcd, [6, 1, 2]);
    var esds = full('esds', 0, 0, esd);
    var mp4a = box('mp4a', [0, 0, 0, 0, 0, 0, 0, 1].concat(u32(0), u32(0), u16(c.channels), u16(16), u16(0), u16(0), u32(c.rate << 16)), esds);
    return movie(track, { handler: 'soun', timescale: c.rate, entry: mp4a, header: full('smhd', 0, 0, u16(0), u16(0)) }, 0, 0, 0x100);
  }

  function init(o) {
    var sps = o.sps, pps = o.pps, w = o.width, h = o.height;
    // profile_idc, constraint flags, level_idc: SPS bytes 1-3 (byte 0 is the NAL header). Decoders that read them
    // (Tizen's MSE: "Unrecognized video codec profile") refuse the stream otherwise; FFmpeg and Firefox ignore them.
    var avcC = box('avcC', [1, sps[1], sps[2], sps[3], 0xff, 0xe1].concat(u16(sps.length)), sps, [1].concat(u16(pps.length)), pps);
    var avc1 = box('avc1', [0, 0, 0, 0, 0, 0, 0, 1].concat(new Array(16).fill(0), u16(w), u16(h), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
      new Array(32).fill(0), u16(0x18), u16(0xffff)), avcC);
    return movie(o.track || 1, { handler: 'vide', timescale: TIMESCALE, entry: avc1, header: full('vmhd', 0, 1, new Array(8).fill(0)) }, w, h, 0);
  }

  function fragment(seq, baseDts, samples, o) {
    var track = (o && o.track) || 1, raw = o && o.raw;
    var datas = samples.map(function (s) { return raw ? s.data : avcc(s.data); });
    function moof(dataOffset) {
      var rows = [];
      samples.forEach(function (s, i) {
        rows = rows.concat(u32(s.duration), u32(datas[i].length), u32(raw || s.sync ? 0x02000000 : 0x01010000), u32((s.cto || 0) >>> 0));
      });
      var trun = full('trun', 1, 0x000f01, u32(samples.length), u32(dataOffset), rows);
      var tfdt = full('tfdt', 1, 0, u32(Math.floor(baseDts / 4294967296)), u32(baseDts >>> 0));
      return box('moof', full('mfhd', 0, 0, u32(seq)), box('traf', full('tfhd', 0, 0x020000, u32(track)), tfdt, trun));
    }
    var first = moof(0), mdat = box('mdat', cat(datas));
    return cat([moof(first.length + 8), mdat]);
  }

  return { TIMESCALE: TIMESCALE, init: init, initAudio: initAudio, audioCodec: audioCodec, fragment: fragment, avcc: avcc };
});
