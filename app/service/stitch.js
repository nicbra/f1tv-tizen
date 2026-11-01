/*
 * Multiview by stitching (experiment). F1 encodes every feed of a session in lockstep: the same
 * SPS/PPS, frame types, frame numbers and picture order, one CABAC slice per frame, and the same
 * Widevine key and constant IV (cbcs). The feeds' frames can therefore be stacked into one taller
 * picture by rewriting only the unencrypted slice headers: each slice gets its position in the
 * stack, and deblocking stops at slice edges (as it did at the original picture edges). The
 * encrypted slice data is copied unchanged; the TV's Widevine decrypts it with the usual licence.
 *
 * H.264 Main slices run in raster order, so the feeds stack vertically.
 */
'use strict';

function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function w16(b, o, v) { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; }
function w32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

function alloc(n) { return typeof Buffer !== 'undefined' ? (Buffer.alloc ? Buffer.alloc(n) : new Buffer(n).fill(0)) : new Uint8Array(n); }
function concat(list) {
  var n = 0, i; for (i = 0; i < list.length; i++) n += list[i].length;
  var out = alloc(n), p = 0;
  for (i = 0; i < list.length; i++) { out.set(list[i], p); p += list[i].length; }
  return out;
}
function bytes(arr) { var b = alloc(arr.length); b.set(arr); return b; }

/** The boxes in [s, e): { type, s (start), e (end), d (payload start) }. */
function boxes(b, s, e) {
  var out = [];
  while (s + 8 <= e) {
    var size = u32(b, s);
    if (size === 1 || size < 8 || s + size > e) break;   // 64-bit or broken sizes: not in F1's segments
    out.push({ type: fourcc(b, s + 4), s: s, e: s + size, d: s + 8 });
    s += size;
  }
  return out;
}
function child(b, parent, type, skip) {
  var found = boxes(b, parent.d + (skip || 0), parent.e).filter(function (x) { return x.type === type; })[0];
  if (!found) throw new Error('no ' + type + ' box');
  return found;
}
function box(type, payload) {
  var out = alloc(8 + payload.length);
  w32(out, 0, out.length);
  for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

// --- bits ---

function Reader(a) { this.a = a; this.p = 0; }
Reader.prototype.u = function (n) {
  var v = 0;
  for (var i = 0; i < n; i++) { v = v * 2 + ((this.a[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; }
  return v;
};
Reader.prototype.ue = function () {
  var z = 0;
  while (this.u(1) === 0) { if (++z > 31) throw new Error('bad exp-Golomb code'); }
  return Math.pow(2, z) - 1 + this.u(z);
};
Reader.prototype.se = function () { var k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };

function Writer() { this.bits = []; }
Writer.prototype.u = function (n, v) { for (var i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / Math.pow(2, i)) & 1); };
Writer.prototype.ue = function (v) {
  var x = v + 1, n = 0; while (Math.pow(2, n + 1) <= x) n++;
  this.u(n, 0); this.u(n + 1, x);
};
Writer.prototype.se = function (v) { this.ue(v > 0 ? 2 * v - 1 : -2 * v); };
Writer.prototype.copy = function (a, from, to) { for (var p = from; p < to; p++) this.bits.push((a[p >> 3] >> (7 - (p & 7))) & 1); };
Writer.prototype.bytes = function () {
  var out = [];
  for (var i = 0; i < this.bits.length; i += 8) {
    var v = 0; for (var k = 0; k < 8; k++) v = v * 2 + (this.bits[i + k] || 0);
    out.push(v);
  }
  return out;
};

/** NAL payload without emulation prevention bytes; map[i] = index in the escaped input of rbsp byte i. */
function unescape(b, s, e) {
  var rbsp = [], map = [], zeros = 0;
  for (var i = s; i < e; i++) {
    if (zeros >= 2 && b[i] === 3) { zeros = 0; continue; }
    rbsp.push(b[i]); map.push(i);
    zeros = b[i] === 0 ? zeros + 1 : 0;
  }
  return { rbsp: rbsp, map: map };
}
/**
 * Adds emulation prevention bytes; `next` is the escaped byte that follows (or -1). After two zeros an
 * escaped 3 is already an emulation prevention byte, so only 0-2 need one here.
 */
function escape(rbsp, next) {
  var out = [], zeros = 0;
  for (var i = 0; i < rbsp.length; i++) {
    if (zeros >= 2 && rbsp[i] <= 3) { out.push(3); zeros = 0; }
    out.push(rbsp[i]);
    zeros = rbsp[i] === 0 ? zeros + 1 : 0;
  }
  if (zeros >= 2 && next >= 0 && next <= 2) out.push(3);
  return out;
}

// --- parameter sets ---

var HIGH = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

function parseSps(rbsp) {
  var r = new Reader(rbsp.slice(1)), s = {};
  s.profile = r.u(8); s.constraints = r.u(8); s.levelAt = 16; s.level = r.u(8); s.id = r.ue();
  if (HIGH.indexOf(s.profile) >= 0) throw new Error('High profile streams are not handled');
  s.log2FrameNum = r.ue() + 4;
  s.pocType = r.ue();
  if (s.pocType === 0) s.log2PocLsb = r.ue() + 4;
  else if (s.pocType === 1) throw new Error('POC type 1 is not handled');
  s.refFrames = r.ue(); r.u(1);
  s.widthMbs = r.ue() + 1;
  s.heightAt = r.p; s.heightMapUnits = r.ue() + 1; s.heightEnd = r.p;
  s.frameMbsOnly = r.u(1);
  if (!s.frameMbsOnly) throw new Error('interlaced streams are not handled');
  r.u(1);
  s.cropBottom = 0;
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); s.cropBottom = r.ue() * 2; }
  return s;
}

/** The SPS with a new height (in map units) and level. */
function stackSps(rbsp, sps, units, level) {
  var body = rbsp.slice(1), w = new Writer(), stop = body.length * 8 - 1;
  while (stop > 0 && !((body[stop >> 3] >> (7 - (stop & 7))) & 1)) stop--;   // rbsp_stop_one_bit
  w.copy(body, 0, 16); w.u(8, level);
  w.copy(body, 24, sps.heightAt);
  w.ue(units - 1);
  w.copy(body, sps.heightEnd, stop);
  w.u(1, 1);
  while (w.bits.length % 8) w.bits.push(0);
  return [rbsp[0]].concat(w.bytes());
}

function parsePps(rbsp) {
  var r = new Reader(rbsp.slice(1)), p = {};
  p.id = r.ue(); p.sps = r.ue(); p.cabac = r.u(1); p.bottomPoc = r.u(1);
  if (r.ue() !== 0) throw new Error('slice groups are not handled');
  p.l0 = r.ue() + 1; p.l1 = r.ue() + 1; p.weighted = r.u(1); p.bipred = r.u(2);
  p.initQp = r.se() + 26; r.se(); r.se();
  p.deblockControl = r.u(1); r.u(1); p.redundant = r.u(1);
  if (!p.cabac) throw new Error('CAVLC streams are not handled');
  return p;
}

/**
 * Parses a slice header (Main profile, frames only). Returns the fields that must match across the
 * stacked slices, the bit ranges to rewrite, and where the slice data starts (CABAC: byte aligned).
 */
function parseSlice(rbsp, nalType, refIdc, sps, pps) {
  var r = new Reader(rbsp), h = { type: nalType, refIdc: refIdc };
  h.firstMb = r.ue(); h.firstMbEnd = r.p;
  h.sliceType = r.ue() % 5;
  r.ue();
  h.frameNum = r.u(sps.log2FrameNum);
  if (nalType === 5) { h.idrAt = r.p; h.idr = r.ue(); h.idrEnd = r.p; }
  if (sps.pocType === 0) { h.poc = r.u(sps.log2PocLsb); if (pps.bottomPoc) h.pocBottom = r.se(); }
  if (pps.redundant) r.ue();
  var P = h.sliceType === 0, B = h.sliceType === 1, l0 = pps.l0, l1 = pps.l1, i, op;
  if (B) r.u(1);
  if (P || B) { if (r.u(1)) { l0 = r.ue() + 1; if (B) l1 = r.ue() + 1; } }
  function modifications() { if (r.u(1)) { do { op = r.ue(); if (op === 0 || op === 1 || op === 2) r.ue(); } while (op !== 3); } }
  if (P || B) modifications();
  if (B) modifications();
  function weights(count) {
    for (var k = 0; k < count; k++) {
      if (r.u(1)) { r.se(); r.se(); }
      if (r.u(1)) { r.se(); r.se(); r.se(); r.se(); }
    }
  }
  if ((pps.weighted && P) || (pps.bipred === 1 && B)) { r.ue(); r.ue(); weights(l0); if (B) weights(l1); }
  h.markingAt = r.p;
  if (refIdc) {
    if (nalType === 5) r.u(2);
    else if (r.u(1)) {
      do {
        op = r.ue();
        if (op === 1 || op === 3) r.ue();
        if (op === 2) r.ue();
        if (op === 3 || op === 6) r.ue();
        if (op === 4) r.ue();
      } while (op !== 0);
    }
  }
  h.markingEnd = r.p;
  h.cabacInit = h.sliceType !== 2 ? r.ue() : -1;
  h.qpDelta = r.se();
  h.qp = pps.initQp + h.qpDelta;
  h.deblockAt = h.deblockEnd = r.p; h.deblock = -1;
  if (pps.deblockControl) { h.deblock = r.ue(); h.deblockEnd = r.p; if (h.deblock !== 1) { r.se(); r.se(); } }
  h.end = r.p;
  h.dataStart = Math.ceil(h.end / 8);
  return h;
}

/** The header bits with a new first_mb_in_slice and idr_pic_id, deblocking stopped at slice edges. */
function rewriteHeader(rbsp, h, firstMb, idr) {
  var w = new Writer();
  w.ue(firstMb);
  if (h.type === 5) { w.copy(rbsp, h.firstMbEnd, h.idrAt); w.ue(idr); w.copy(rbsp, h.idrEnd, h.deblockAt); }
  else w.copy(rbsp, h.firstMbEnd, h.deblockAt);
  if (h.deblock >= 0) w.ue(h.deblock === 1 ? 1 : 2);
  w.copy(rbsp, h.deblockEnd, h.end);
  while (w.bits.length % 8) w.bits.push(1);   // cabac_alignment_one_bit
  return w.bytes();
}

// --- gap between feeds ---

/*
 * Flat gray slices, two macroblock rows of a 960-wide picture, from x264 (qp 26, Main, CABAC), without
 * emulation prevention bytes: an I slice for keyframes and all-skip P and B slices. Between feeds they
 * stand in for the picture edge: an encoder may predict from up to ~32 px beyond a picture's edge,
 * which in a stack would otherwise read the neighbouring feed.
 */
var GAP = { widthMbs: 60, rows: 2,
  I: { qp: 23, data: 'fed906fe1ca8824e442be57355fbb948d1b600000000000000011d01738d947e44a9a00000000153' },
  P: { qp: 26, cabacInit: 0, data: '0003ba' },
  B: { qp: 28, cabacInit: 0, data: '044d' } };

function hexBytes(h) { var out = []; for (var i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16)); return out; }

/** A gray gap slice for the picture whose first slice is `a` (header fields copied from it). */
function gapNal(a, aRbsp, cfg, firstMb) {
  var sps = cfg.sps, pps = cfg.pps, t = GAP['PBI'.charAt(a.sliceType)], w = new Writer(), i;
  var P = a.sliceType === 0, B = a.sliceType === 1;
  w.ue(firstMb); w.ue(a.sliceType); w.ue(pps.id); w.u(sps.log2FrameNum, a.frameNum);
  if (a.type === 5) w.ue(a.idr);
  if (sps.pocType === 0) { w.u(sps.log2PocLsb, a.poc); if (pps.bottomPoc) w.se(a.pocBottom); }
  if (B) w.u(1, 1);                                  // direct_spatial_mv_pred_flag
  if (P || B) w.u(1, 0);                             // no num_ref_idx override
  if (P || B) w.u(1, 0);                             // no list modification
  if (B) w.u(1, 0);
  if ((pps.weighted && P) || (pps.bipred === 1 && B)) {
    w.ue(0); w.ue(0);
    for (i = 0; i < pps.l0; i++) { w.u(1, 0); w.u(1, 0); }
    if (B) for (i = 0; i < pps.l1; i++) { w.u(1, 0); w.u(1, 0); }
  }
  if (a.refIdc) w.copy(aRbsp, a.markingAt, a.markingEnd);   // the picture's reference marking
  if (!(a.sliceType === 2)) w.ue(t.cabacInit);
  w.se(t.qp - pps.initQp);
  if (pps.deblockControl) w.ue(1);
  while (w.bits.length % 8) w.bits.push(1);
  return [(a.refIdc << 5) | a.type].concat(escape(w.bytes().concat(hexBytes(t.data)), -1));
}

// --- init segment ---

function avcConfig(init) {
  var moov = boxes(init, 0, init.length).filter(function (x) { return x.type === 'moov'; })[0];
  var trak = child(init, moov, 'trak'), mdia = child(init, trak, 'mdia'), minf = child(init, mdia, 'minf');
  var stbl = child(init, minf, 'stbl'), stsd = child(init, stbl, 'stsd');
  var entry = boxes(init, stsd.d + 8, stsd.e)[0];
  if (entry.type !== 'encv' && entry.type !== 'avc1') throw new Error('unexpected sample entry ' + entry.type);
  var avcC = boxes(init, entry.d + 78, entry.e).filter(function (x) { return x.type === 'avcC'; })[0];
  var a = avcC.d, p = a + 6, spsList = [], ppsList = [], i, l;
  for (i = 0; i < (init[a + 5] & 31); i++) { l = u16(init, p); spsList.push(init.slice(p + 2, p + 2 + l)); p += 2 + l; }
  var nPps = init[p++];
  for (i = 0; i < nPps; i++) { l = u16(init, p); ppsList.push(init.slice(p + 2, p + 2 + l)); p += 2 + l; }
  var spsRbsp = unescape(spsList[0], 0, spsList[0].length).rbsp, ppsRbsp = unescape(ppsList[0], 0, ppsList[0].length).rbsp;
  var tkhd = child(init, trak, 'tkhd');
  return { path: [moov, trak, mdia, minf, stbl, stsd, entry], avcC: avcC, entry: entry, tkhd: tkhd, nalLength: (init[a + 4] & 3) + 1,
    spsRaw: spsList[0], ppsRaw: ppsList[0], spsRbsp: spsRbsp, sps: parseSps(spsRbsp), pps: parsePps(ppsRbsp) };
}

/** Level for one frame of `mbs` macroblocks at `fps` (H.264 Table A-1). */
function levelFor(mbs, fps) {
  var levels = [[30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760], [42, 8704, 522240],
    [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600]];
  for (var i = 0; i < levels.length; i++) if (mbs <= levels[i][1] && mbs * fps <= levels[i][2]) return levels[i][0];
  throw new Error('stack too large for H.264');
}

/** The init segment for n stacked feeds (from the first feed's). */
function stackInit(init, n, fps, gapRows) {
  var c = avcConfig(init), sps = c.sps, g = gapRows || 0;
  if (g && (g !== GAP.rows || sps.widthMbs !== GAP.widthMbs)) throw new Error('no gap slices for this size');
  var units = sps.heightMapUnits * n + g * (n - 1);
  var level = levelFor(sps.widthMbs * units, fps || 50);
  var spsNew = escape(stackSps(c.spsRbsp, sps, units, level), -1);
  var a = c.avcC.d, old = init.slice(a, c.avcC.e);
  var head = [old[0], old[1], old[2], level, old[4], 0xe1, spsNew.length >> 8, spsNew.length & 255].concat(spsNew);
  var tail = [1, c.ppsRaw.length >> 8, c.ppsRaw.length & 255].concat(Array.prototype.slice.call(c.ppsRaw));
  var avcC = box('avcC', bytes(head.concat(tail)));
  var out = concat([init.slice(0, c.avcC.s), avcC, init.slice(c.avcC.e)]);
  var delta = avcC.length - (c.avcC.e - c.avcC.s);
  c.path.forEach(function (bx) { w32(out, bx.s, u32(out, bx.s) + delta); });   // every ancestor grows by delta
  var height = units * 16 - sps.cropBottom;
  w16(out, c.entry.s + 8 + 26, height);                       // VisualSampleEntry height
  w32(out, c.tkhd.e - 4, height * 65536);                     // tkhd height (16.16), before the avcC splice
  return { init: out, width: sps.widthMbs * 16, height: height, level: level, gapRows: g, feedHeight: sps.heightMapUnits * 16,
    codecs: 'avc1.' + [sps.profile, sps.constraints, level].map(function (v) { return (v < 16 ? '0' : '') + v.toString(16).toUpperCase(); }).join('') };
}

// --- media segments ---

function fragment(seg) {
  var top = boxes(seg, 0, seg.length);
  var moof = top.filter(function (x) { return x.type === 'moof'; });
  if (moof.length !== 1) throw new Error('expected one moof, got ' + moof.length);
  moof = moof[0];
  var inMoof = boxes(seg, moof.d, moof.e), traf = inMoof.filter(function (x) { return x.type === 'traf'; })[0];
  var parts = boxes(seg, traf.d, traf.e), get = function (t) { return parts.filter(function (x) { return x.type === t; })[0]; };
  var tfhd = get('tfhd'), trun = get('trun'), senc = get('senc');
  var tf = u32(seg, tfhd.d) & 0xffffff, q = tfhd.d + 8, defDur = 0, defSize = 0, defFlags = 0;
  if (tf & 1) q += 8; if (tf & 2) q += 4;
  if (tf & 8) { defDur = u32(seg, q); q += 4; } if (tf & 16) { defSize = u32(seg, q); q += 4; } if (tf & 32) { defFlags = u32(seg, q); q += 4; }
  if (!(tf & 0x20000)) throw new Error('tfhd without default-base-is-moof');
  var fl = u32(seg, trun.d) & 0xffffff, count = u32(seg, trun.d + 4), offset = 0, firstFlags = null;
  q = trun.d + 8;
  if (fl & 1) { offset = u32(seg, q) | 0; q += 4; }
  if (fl & 4) { firstFlags = u32(seg, q); q += 4; }
  var samples = [], pos = moof.s + offset, i;
  for (i = 0; i < count; i++) {
    var s = { dur: defDur, size: defSize, flags: i === 0 && firstFlags !== null ? firstFlags : defFlags, cto: 0, subs: null };
    if (fl & 0x100) { s.dur = u32(seg, q); q += 4; }
    if (fl & 0x200) { s.size = u32(seg, q); q += 4; }
    if (fl & 0x400) { s.flags = u32(seg, q); q += 4; }
    if (fl & 0x800) { s.cto = u32(seg, q) | 0; q += 4; }
    s.at = pos; pos += s.size;
    samples.push(s);
  }
  if (senc) {
    var sf = u32(seg, senc.d) & 0xffffff, r = senc.d + 8;
    if (!(sf & 2) && u32(seg, senc.d + 4)) throw new Error('senc without subsamples');
    for (i = 0; i < u32(seg, senc.d + 4) && i < count; i++) {
      samples[i].subs = [];
      var k = u16(seg, r); r += 2;
      for (var j = 0; j < k; j++) { samples[i].subs.push([u16(seg, r), u32(seg, r + 2)]); r += 6; }
    }
  }
  return { seg: seg, top: top, moof: moof, inMoof: inMoof, traf: traf, parts: parts, get: get, samples: samples, trunFlags: fl };
}

/** A sample's NAL units: { at, end (escaped, incl. length prefix), type, refIdc }. */
function nalUnits(seg, s, nalLength) {
  var out = [], p = s.at, end = s.at + s.size;
  while (p + nalLength <= end) {
    var len = 0; for (var i = 0; i < nalLength; i++) len = len * 256 + seg[p + i];
    out.push({ at: p, end: p + nalLength + len, type: seg[p + nalLength] & 31, refIdc: (seg[p + nalLength] >> 5) & 3 });
    p += nalLength + len;
  }
  if (p !== end) throw new Error('NAL units do not fill the sample');
  return out;
}

/**
 * One feed's slice of a sample, re-addressed: { prefix (non-slice NALs, clear), clear (bytes), protectedBytes,
 * header (parsed) }. The encrypted bytes are the protected range of the sample's single subsample.
 */
function feedSlice(f, s, cfg) {
  var nals = nalUnits(f.seg, s, cfg.nalLength);
  var slices = nals.filter(function (n) { return n.type === 1 || n.type === 5; });
  if (slices.length !== 1) throw new Error('expected one slice per frame, got ' + slices.length);
  var sl = slices[0];
  if (sl !== nals[nals.length - 1]) throw new Error('slice is not the last NAL unit');
  var protectedLen = 0;
  if (s.subs && s.subs.length) {
    if (s.subs.length !== 1) throw new Error('expected one subsample, got ' + s.subs.length);
    protectedLen = s.subs[0][1];
    if (s.subs[0][0] + protectedLen !== s.size) throw new Error('subsample does not cover the sample');
  }
  var protStart = sl.end - protectedLen, bodyStart = sl.at + cfg.nalLength + 1;
  var clear = unescape(f.seg, bodyStart, protStart);
  var h = parseSlice(clear.rbsp, sl.type, sl.refIdc, cfg.sps, cfg.pps);
  if (h.dataStart > clear.rbsp.length) throw new Error('slice header reaches the encrypted bytes');
  return { nals: nals, slice: sl, h: h, rbsp: clear.rbsp, protStart: protStart, prefix: f.seg.slice(s.at, sl.at) };
}

/**
 * Stacks the feeds' segments (same number) into one segment. segs[0] gives the timing, SEI and
 * encryption boxes; all feeds must share the structure, key and IV (checked per frame).
 */
function stackSegment(segs, cfg, gapRows) {
  var frags = segs.map(fragment), A = frags[0], n = frags.length, g = gapRows || 0;
  var encrypted = !!A.get('senc'), count = A.samples.length, w = cfg.sps.widthMbs, hMb = cfg.sps.heightMapUnits, i, k;
  frags.forEach(function (f) { if (f.samples.length !== count) throw new Error('feeds differ in frame count'); });
  var data = [], sizes = [], subs = [];
  for (i = 0; i < count; i++) {
    var parts = frags.map(function (f) { return feedSlice(f, f.samples[i], cfg); });
    var a = parts[0].h, sampleSubs = [], chunks = [parts[0].prefix];
    for (k = 0; k < n; k++) {
      var p = parts[k], h = p.h;
      if (h.type !== a.type || h.frameNum !== a.frameNum || h.poc !== a.poc || h.pocBottom !== a.pocBottom || h.refIdc !== a.refIdc)
        throw new Error('feed ' + k + ' differs from feed 0 at frame ' + i);
      var markA = parts[0].rbsp, same = h.markingEnd - h.markingAt === a.markingEnd - a.markingAt;
      for (var bit = 0; same && bit < h.markingEnd - h.markingAt; bit++) {
        var x = h.markingAt + bit, y = a.markingAt + bit;
        same = ((p.rbsp[x >> 3] >> (7 - (x & 7))) & 1) === ((markA[y >> 3] >> (7 - (y & 7))) & 1);
      }
      if (!same) throw new Error('feed ' + k + ' marks references differently at frame ' + i);
      var gap = [];
      if (k > 0 && g) {
        var gn = gapNal(a, parts[0].rbsp, cfg, (k * hMb + (k - 1) * g) * w), gl = [];
        for (var gb = cfg.nalLength - 1; gb >= 0; gb--) gl.push(Math.floor(gn.length / Math.pow(256, gb)) & 255);
        gap = gl.concat(gn);
      }
      var header = rewriteHeader(p.rbsp, h, k * (hMb + g) * w, a.idr);
      var clearRbsp = header.concat(p.rbsp.slice(h.dataStart));
      var nextByte = p.protStart < p.slice.end ? segs[k][p.protStart] : -1;
      var nalBody = [segs[k][p.slice.at + cfg.nalLength]].concat(escape(clearRbsp, nextByte));
      var protectedBytes = segs[k].slice(p.protStart, p.slice.end);
      var len = nalBody.length + protectedBytes.length, lenBytes = [];
      for (var b = cfg.nalLength - 1; b >= 0; b--) lenBytes.push(Math.floor(len / Math.pow(256, b)) & 255);
      var clearPart = bytes(gap.concat(lenBytes, nalBody));
      chunks.push(clearPart, protectedBytes);
      var clearLen = clearPart.length + (k === 0 ? parts[0].prefix.length : 0);
      if (encrypted && clearLen > 65535) throw new Error('clear part too long');
      sampleSubs.push([clearLen, protectedBytes.length]);
    }
    var sample = concat(chunks);
    data.push(sample); sizes.push(sample.length); subs.push(sampleSubs);
  }
  return buildSegment(A, sizes, subs, concat(data));
}

function fullBox(type, version, flags, payload) {
  var head = alloc(4); head[0] = version; head[1] = (flags >> 16) & 255; head[2] = (flags >> 8) & 255; head[3] = flags & 255;
  return box(type, concat([head, payload]));
}

function buildSegment(A, sizes, subs, mdatData) {
  var seg = A.seg, count = sizes.length, i, k, encrypted = !!A.get('senc');
  var trunP = alloc(8 + count * 16);
  w32(trunP, 0, count); // data offset patched below
  for (i = 0; i < count; i++) {
    var s = A.samples[i], o = 8 + i * 16;
    w32(trunP, o, s.dur); w32(trunP, o + 4, sizes[i]); w32(trunP, o + 8, s.flags); w32(trunP, o + 12, s.cto >>> 0);
  }
  var trun = fullBox('trun', A.trunFlags & 0x800 ? (u32(seg, A.get('trun').d) >>> 24) : 0, 0xf01, trunP);
  var boxesInTraf = [seg.slice(A.get('tfhd').s, A.get('tfhd').e), seg.slice(A.get('tfdt').s, A.get('tfdt').e), trun];
  var senc = null, saiz = null, saio = null;
  if (encrypted) {
    var sencParts = [], sizesAux = alloc(count);
    var hdr = alloc(4); w32(hdr, 0, count); sencParts.push(hdr);
    for (i = 0; i < count; i++) {
      var e = alloc(2 + 6 * subs[i].length); w16(e, 0, subs[i].length);
      for (k = 0; k < subs[i].length; k++) { w16(e, 2 + 6 * k, subs[i][k][0]); w32(e, 4 + 6 * k, subs[i][k][1]); }
      sencParts.push(e); sizesAux[i] = e.length;
    }
    senc = fullBox('senc', 0, 2, concat(sencParts));
    var oldSaiz = A.get('saiz'), oldSaio = A.get('saio');
    var saizFlags = oldSaiz ? u32(seg, oldSaiz.d) & 0xffffff : 0, saioFlags = oldSaio ? u32(seg, oldSaio.d) & 0xffffff : 0;
    var auxType = saizFlags & 1 ? seg.slice(oldSaiz.d + 4, oldSaiz.d + 12) : alloc(0);
    var zHead = alloc(5); zHead[0] = 0; w32(zHead, 1, count);
    saiz = fullBox('saiz', 0, saizFlags & 1, concat([auxType, zHead, sizesAux]));
    var oHead = alloc(8); w32(oHead, 0, 1);
    saio = fullBox('saio', 0, saioFlags & 1, concat([saioFlags & 1 ? seg.slice(oldSaio.d + 4, oldSaio.d + 12) : alloc(0), oHead]));
    boxesInTraf.push(senc, saio, saiz);
  }
  ['sbgp', 'sgpd'].forEach(function (t) { var b = A.get(t); if (b) boxesInTraf.push(seg.slice(b.s, b.e)); });
  var traf = box('traf', concat(boxesInTraf));
  var moofParts = A.inMoof.filter(function (b) { return b.type !== 'traf'; }).map(function (b) { return seg.slice(b.s, b.e); });
  var moof = box('moof', concat(moofParts.concat([traf])));
  // Patch the offsets now that the sizes are known.
  var trafAt = moof.length - traf.length, inTraf = boxes(moof, trafAt + 8, moof.length);
  var trunAt = inTraf.filter(function (b) { return b.type === 'trun'; })[0].s;
  w32(moof, trunAt + 16, moof.length + 8);   // data_offset: the first sample, right after mdat's header
  if (encrypted) {
    var sencAt = inTraf.filter(function (b) { return b.type === 'senc'; })[0].s;
    var saioBox = inTraf.filter(function (b) { return b.type === 'saio'; })[0];
    w32(moof, saioBox.e - 4, sencAt + 16);    // offset of the first sample's aux info from moof's start
  }
  var styp = A.top.filter(function (b) { return b.type === 'styp'; }).map(function (b) { return seg.slice(b.s, b.e); });
  return concat(styp.concat([moof, box('mdat', mdatData)]));
}

module.exports = { stackInit: stackInit, stackSegment: stackSegment, avcConfig: avcConfig, fragment: fragment,
  // shared with stitch-hevc.js
  u16: u16, u32: u32, w16: w16, w32: w32, alloc: alloc, concat: concat, bytes: bytes, boxes: boxes, child: child, box: box,
  Reader: Reader, Writer: Writer, buildSegment: buildSegment,
  parseSps: parseSps, stackSps: stackSps, parseSlice: parseSlice, rewriteHeader: rewriteHeader, escape: escape, unescape: unescape, levelFor: levelFor };
