/*
 * Multiview by HEVC tiles (experiment). F1's HEVC feeds (the Premium tvOS offer: HLG, plus SDR variants)
 * are encoded in lockstep with 32-pixel CTBs, temporal motion vector prediction off, and one key and
 * constant IV (cbcs) for every feed. A 540p frame is one 960x544 slice; a 1080p frame is four 960x544
 * tiles, each its own slice with its own encryption subsample. So every feed is made of 960x544 pieces,
 * and a layout is a grid of such cells, each taken from (feed, tile).
 *
 * The parameter sets get the grid's size and tile layout; each slice header gets its cell's address,
 * and loop filtering across its left/top edge only where that neighbour is the same feed (as in the
 * original). The encrypted slice data is copied unchanged and decrypted by the TV's Widevine.
 */
'use strict';

var h = require('./stitch');
var u32 = h.u32, concat = h.concat, bytes = h.bytes, boxes = h.boxes, child = h.child, box = h.box;
var Reader = h.Reader, Writer = h.Writer, escape = h.escape, unescape = h.unescape;

function fail(why) { throw new Error('HEVC grid: ' + why); }
function bit(a, p) { return (a[p >> 3] >> (7 - (p & 7))) & 1; }
function sameBits(a, from, to, b, bFrom) { for (var i = 0; i < to - from; i++) if (bit(a, from + i) !== bit(b, bFrom + i)) return false; return true; }
function stopBit(a) { var p = a.length * 8 - 1; while (p > 0 && !bit(a, p)) p--; return p; }
function finish(w) { w.u(1, 1); while (w.bits.length % 8) w.bits.push(0); return w.bytes(); }
function log2ceil(n) { var b = 0; while ((1 << b) < n) b++; return b; }

// --- parameter sets (rbsp includes the 2-byte NAL header) ---

/** st_ref_pic_set(); returns NumDeltaPocs for this set. */
function refPicSet(r, idx, num, deltaPocs) {
  if (idx !== 0 && r.u(1)) {
    var deltaIdx = idx === num ? r.ue() + 1 : 1;
    r.u(1); r.ue();
    var ref = deltaPocs[idx - deltaIdx], count = 0;
    for (var j = 0; j <= ref; j++) { var used = r.u(1), useDelta = used ? 1 : r.u(1); if (useDelta) count++; }
    return count;
  }
  var neg = r.ue(), pos = r.ue();
  for (var k = 0; k < neg + pos; k++) { r.ue(); r.u(1); }
  return neg + pos;
}

function parseSps(rbsp) {
  var r = new Reader(rbsp), s = {};
  r.u(16); r.u(4); s.maxSub = r.u(3); r.u(1);
  if (s.maxSub) fail('sub-layers are not handled');
  s.levelAt = r.p + 88; r.u(96);
  s.id = r.ue(); s.chroma = r.ue();
  if (s.chroma === 3) s.separateColour = r.u(1);
  s.sizeAt = r.p; s.width = r.ue(); s.height = r.ue(); s.sizeEnd = r.p;
  s.cropBottom = 0; s.confAt = r.p;
  if (r.u(1)) { if (r.ue() || r.ue() || r.ue()) fail('only bottom cropping is handled'); s.cropBottom = r.ue() * (s.chroma === 1 ? 2 : 1); }
  s.confEnd = r.p;
  r.ue(); r.ue(); s.log2Poc = r.ue() + 4;
  var ordering = r.u(1); for (var i = ordering ? 0 : s.maxSub; i <= s.maxSub; i++) { r.ue(); r.ue(); r.ue(); }
  var minCb = r.ue() + 3; s.minCb = 1 << minCb; s.ctb = 1 << (minCb + r.ue());
  s.minTb = 1 << (r.ue() + 2); s.maxTb = s.minTb << r.ue(); s.depthInter = r.ue(); s.depthIntra = r.ue();
  if (r.u(1) && r.u(1)) fail('scaling lists are not handled');
  s.amp = r.u(1); s.sao = r.u(1);
  if (r.u(1)) { r.u(4); r.u(4); r.ue(); r.ue(); r.u(1); }
  s.numRps = r.ue(); s.deltaPocs = [];
  for (i = 0; i < s.numRps; i++) s.deltaPocs.push(refPicSet(r, i, s.numRps, s.deltaPocs));
  if (r.u(1)) fail('long-term references are not handled');
  s.tmvp = r.u(1);
  if (s.tmvp) fail('temporal motion vector prediction is not handled');
  if (s.width % s.ctb) fail('picture width is not a whole number of CTBs');
  s.wCtb = s.width / s.ctb; s.hCtb = Math.ceil(s.height / s.ctb);
  s.addressBits = log2ceil(s.wCtb * s.hCtb);
  return s;
}

function parsePps(rbsp) {
  var r = new Reader(rbsp), p = {};
  r.u(16); p.id = r.ue(); p.sps = r.ue();
  p.dependentSlices = r.u(1); p.outputFlag = r.u(1); p.extraBits = r.u(3); r.u(1); p.cabacInitPresent = r.u(1);
  r.ue(); r.ue(); p.initQp = 26 + r.se(); r.u(1); r.u(1);
  if (r.u(1)) r.ue();
  r.se(); r.se(); p.chromaQpOffsets = r.u(1);
  p.weighted = r.u(1); p.weightedBi = r.u(1); r.u(1);
  p.tilesAt = r.p; p.tiles = r.u(1); p.wpp = r.u(1);
  p.tileCols = 1; p.tileRows = 1; p.uniform = 1; p.loopAcrossTiles = 1;
  if (p.tiles) {
    p.tileCols = r.ue() + 1; p.tileRows = r.ue() + 1; p.uniform = r.u(1);
    if (!p.uniform) fail('non-uniform tiles are not handled');
    p.loopAcrossTiles = r.u(1);
  }
  p.tilesEnd = r.p;
  p.loopAcrossSlices = r.u(1);
  p.deblockOverride = 0; p.deblockDisabled = 0; p.beta = 0; p.tc = 0;
  if (r.u(1)) { p.deblockOverride = r.u(1); p.deblockDisabled = r.u(1); if (!p.deblockDisabled) { p.beta = r.se(); p.tc = r.se(); } }
  if (r.u(1)) fail('PPS scaling lists are not handled');
  p.listsModification = r.u(1); r.ue(); p.headerExtension = r.u(1);
  if (r.u(1)) fail('PPS extensions are not handled');
  if (p.weighted || p.weightedBi) fail('weighted prediction is not handled');
  if (p.listsModification) fail('reference list modification is not handled');
  if (p.wpp) fail('wavefront parallel processing is not handled');
  return p;
}

var LEVELS = [[93, 983040, 33177600], [120, 2228224, 66846720], [123, 2228224, 133693440], [150, 8912896, 267386880],
  [153, 8912896, 534773760], [156, 8912896, 1069547520], [183, 35651584, 2139095040]];
function levelFor(w, hgt, fps) {
  for (var i = 0; i < LEVELS.length; i++) if (w * hgt <= LEVELS[i][1] && w * hgt * fps <= LEVELS[i][2]) return LEVELS[i][0];
  return fail('grid too large');
}

function withLevel(rbsp, at, level) { var out = rbsp.slice(); out[at >> 3] = level; return out; }

function gridSps(rbsp, s, g) {
  var w = new Writer(), unit = s.chroma === 1 ? 2 : 1;
  w.copy(withLevel(rbsp, s.levelAt, g.level), 0, s.sizeAt);
  w.ue(g.width); w.ue(g.height);
  w.copy(rbsp, s.sizeEnd, s.confAt);
  var crop = g.height - g.display;
  if (crop) { w.u(1, 1); w.ue(0); w.ue(0); w.ue(0); w.ue(crop / unit); } else w.u(1, 0);
  w.copy(rbsp, s.confEnd, stopBit(rbsp));
  return finish(w);
}

/** The grid's PPS: uniform tiles of one cell each; filtering across them is decided per slice. */
function gridPps(rbsp, p, g) {
  var w = new Writer();
  w.copy(rbsp, 0, p.tilesAt);
  w.u(1, 1); w.u(1, 0);
  w.ue(g.cols - 1); w.ue(g.rows - 1); w.u(1, 1);
  w.u(1, 1);                                     // loop filter across tiles: slice flags stop it at seams
  w.copy(rbsp, p.tilesEnd, stopBit(rbsp));
  return finish(w);
}

/** VPS: only the level changes (vps header is 32 bits, then general profile_tier_level). */
function gridVps(rbsp, g) { return withLevel(rbsp, 16 + 32 + 88, g.level); }

/** Parameter sets from a list of rbsp NAL units: { vps: [rbsp], sps: {id}, pps: {id} }. */
function paramSets(list, into) {
  var out = into || { vps: [], sps: {}, pps: {} };
  list.forEach(function (rbsp) {
    var t = (rbsp[0] >> 1) & 63;
    if (t === 32) out.vps = [rbsp];
    if (t === 33) { var s = parseSps(rbsp); s.rbsp = rbsp; out.sps[s.id] = s; }
    if (t === 34) { var p = parsePps(rbsp); p.rbsp = rbsp; out.pps[p.id] = p; }
  });
  return out;
}

// --- slice segment headers ---

function ppsIdOf(rbsp, type) { var r = new Reader(rbsp); r.u(17); if (type >= 16 && type <= 23) r.u(1); return r.ue(); }

function parseSlice(rbsp, type, sps, pps) {
  var r = new Reader(rbsp), s = { type: type, address: 0 };
  r.u(16);
  s.first = r.u(1);
  s.irapAt = r.p; if (type >= 16 && type <= 23) r.u(1);
  s.ppsAt = r.p; r.ue(); s.ppsEnd = r.p;
  if (!s.first) {
    if (pps.dependentSlices && r.u(1)) fail('dependent slice segments are not handled');
    s.address = r.u(sps.addressBits);
  }
  s.bodyAt = r.p;
  r.u(pps.extraBits);
  s.sliceType = r.ue();
  if (pps.outputFlag) r.u(1);
  if (sps.separateColour) r.u(2);
  s.poc = 0; s.rpsAt = s.rpsEnd = r.p;
  if (type !== 19 && type !== 20) {
    s.poc = r.u(sps.log2Poc);
    s.rpsAt = r.p;
    if (!r.u(1)) refPicSet(r, sps.numRps, sps.numRps, sps.deltaPocs);
    else if (sps.numRps > 1) r.u(log2ceil(sps.numRps));
    s.rpsEnd = r.p;
  }
  s.saoLuma = 0; s.saoChroma = 0;
  if (sps.sao) { s.saoLuma = r.u(1); if (sps.chroma) s.saoChroma = r.u(1); }
  var P = s.sliceType === 1, B = s.sliceType === 0;
  if (P || B) {
    if (r.u(1)) { r.ue(); if (B) r.ue(); }
    if (B) r.u(1);
    if (pps.cabacInitPresent) r.u(1);
    r.ue();
  }
  r.se();
  if (pps.chromaQpOffsets) { r.se(); r.se(); }
  s.deblockAt = r.p;
  s.deblockDisabled = pps.deblockDisabled; s.beta = pps.beta; s.tc = pps.tc;
  if (pps.deblockOverride && r.u(1)) { s.deblockDisabled = r.u(1); if (!s.deblockDisabled) { s.beta = r.se(); s.tc = r.se(); } }
  s.loopAcross = pps.loopAcrossSlices;
  if (pps.loopAcrossSlices && (s.saoLuma || s.saoChroma || !s.deblockDisabled)) s.loopAcross = r.u(1);
  if (pps.tiles || pps.wpp) { if (r.ue()) fail('slices spanning several tiles are not handled'); }
  s.extAt = r.p;
  if (pps.headerExtension) { var n = r.ue(); r.u(8 * n); }
  s.end = r.p;
  s.dataStart = (s.end >> 3) + 1;   // byte_alignment() is at least one bit
  return s;
}

/**
 * The slice header for a grid cell: its address, the grid PPS's id, the deblocking written out explicitly
 * (the source PPS's default may differ from the grid's), and loop filtering across its left/top edges
 * only if `filterEdges` (same feed on both sides there) and the source allowed it.
 */
function cellHeader(rbsp, s, address, grid, filterEdges) {
  var w = new Writer(), pps = grid.pps, first = address === 0;
  w.copy(rbsp, 0, 16);
  w.u(1, first ? 1 : 0);
  w.copy(rbsp, s.irapAt, s.ppsAt);
  w.ue(pps.id);
  if (!first) { if (pps.dependentSlices) w.u(1, 0); w.u(grid.addressBits, address); }
  w.copy(rbsp, s.bodyAt, s.deblockAt);
  if (pps.deblockOverride) {
    w.u(1, 1); w.u(1, s.deblockDisabled);
    if (!s.deblockDisabled) { w.se(s.beta); w.se(s.tc); }
  } else if (s.deblockDisabled !== pps.deblockDisabled || s.beta !== pps.beta || s.tc !== pps.tc) fail('deblocking differs between feeds');
  if (pps.loopAcrossSlices && (s.saoLuma || s.saoChroma || !s.deblockDisabled)) w.u(1, filterEdges && s.loopAcross ? 1 : 0);
  w.ue(0);                                       // one tile per slice: no entry points
  w.copy(rbsp, s.extAt, s.end);
  return finish(w);
}

// --- layouts ---

// Layouts: { feeds, cols, rows, cells: [[feed, tile], ...] in reading order } (shared with the app).
var LAYOUTS = require('../js/layouts.js').layouts;

function validLayout(l) {
  if (!l || !(l.cols >= 1 && l.rows >= 1) || !l.cells || l.cells.length !== l.cols * l.rows) fail('bad layout');
  return l;
}

/**
 * Whether a cell's left and top neighbours in the grid are the tiles beside and above it in its own feed
 * (or the picture edge). tileCols: each feed's number of tile columns.
 */
function edgesOwn(l, k, tileCols) {
  var col = k % l.cols, row = Math.floor(k / l.cols), c = l.cells[k], n = tileCols[c[0]];
  function same(other, tile) { return other && other[0] === c[0] && other[1] === tile; }
  var left = col === 0 || (c[1] % n !== 0 && same(l.cells[k - 1], c[1] - 1));
  var top = row === 0 || (c[1] >= n && same(l.cells[k - l.cols], c[1] - n));
  return left && top;
}

// --- init segment ---

function sampleEntry(init) {
  var moov = boxes(init, 0, init.length).filter(function (x) { return x.type === 'moov'; })[0];
  var trak = child(init, moov, 'trak'), mdia = child(init, trak, 'mdia'), minf = child(init, mdia, 'minf');
  var stbl = child(init, minf, 'stbl'), stsd = child(init, stbl, 'stsd');
  var entry = boxes(init, stsd.d + 8, stsd.e)[0];
  var hvcC = boxes(init, entry.d + 78, entry.e).filter(function (x) { return x.type === 'hvcC'; })[0];
  if (!hvcC) fail('no hvcC');
  return { path: [moov, trak, mdia, minf, stbl, stsd, entry], entry: entry, hvcC: hvcC, tkhd: child(init, trak, 'tkhd'),
    nalLength: (init[hvcC.d + 21] & 3) + 1 };
}

function hvcCParamSets(init, e) {
  var a = e.hvcC.d, p = a + 23, list = [];
  for (var i = 0; i < init[a + 22]; i++) {
    var n = (init[p + 1] << 8) | init[p + 2]; p += 3;
    for (var k = 0; k < n; k++) { var len = (init[p] << 8) | init[p + 1]; list.push(unescape(init, p + 2, p + 2 + len).rbsp); p += 2 + len; }
  }
  return list;
}

function rewriteParam(rbsp, g) {
  var t = (rbsp[0] >> 1) & 63;
  if (t === 32) return gridVps(rbsp, g);
  if (t === 33) return gridSps(rbsp, parseSps(rbsp), g);
  if (t === 34) return gridPps(rbsp, parsePps(rbsp), g);
  return rbsp;
}

function gridInit(init, g) {
  var e = sampleEntry(init), a = e.hvcC.d, old = init.slice(a, e.hvcC.e);
  var head = Array.prototype.slice.call(old, 0, 22), p = 23, arrays = [];
  head[12] = g.level;
  for (var i = 0; i < old[22]; i++) {
    var kind = old[p], n = (old[p + 1] << 8) | old[p + 2], nals = []; p += 3;
    for (var k = 0; k < n; k++) {
      var len = (old[p] << 8) | old[p + 1], raw = old.slice(p + 2, p + 2 + len); p += 2 + len;
      var out = escape(rewriteParam(unescape(raw, 0, raw.length).rbsp, g), -1);
      nals = nals.concat([out.length >> 8, out.length & 255], out);
    }
    arrays = arrays.concat([kind, n >> 8, n & 255], nals);
  }
  var hvcC = box('hvcC', bytes(head.concat([old[22]], arrays)));
  var outInit = concat([init.slice(0, e.hvcC.s), hvcC, init.slice(e.hvcC.e)]);
  var delta = hvcC.length - (e.hvcC.e - e.hvcC.s);
  e.path.forEach(function (bx) { h.w32(outInit, bx.s, u32(outInit, bx.s) + delta); });
  h.w16(outInit, e.entry.s + 32, g.width); h.w16(outInit, e.entry.s + 34, g.display);
  h.w32(outInit, e.tkhd.e - 8, g.width * 65536); h.w32(outInit, e.tkhd.e - 4, g.display * 65536);
  return outInit;
}

// --- media segments ---

/** A sample's NAL units with the protected byte range of each (from the subsample map). */
function units(seg, s, nalLength) {
  var out = [], p = s.at, end = s.at + s.size;
  while (p + nalLength < end) {
    var len = 0; for (var i = 0; i < nalLength; i++) len = len * 256 + seg[p + i];
    out.push({ at: p, body: p + nalLength, end: p + nalLength + len, type: (seg[p + nalLength] >> 1) & 63, protStart: -1 });
    p += nalLength + len;
  }
  if (p !== end) fail('NAL units do not fill the sample');
  if (s.subs) {
    var q = s.at;
    s.subs.forEach(function (sub) {
      q += sub[0];
      if (sub[1]) {
        var unit = out.filter(function (u) { return q >= u.body && q + sub[1] <= u.end; })[0];
        if (!unit || unit.type >= 32 || unit.protStart >= 0 || q + sub[1] !== unit.end) fail('unexpected encryption layout');
        unit.protStart = q;
      }
      q += sub[1];
    });
  }
  return out;
}

function lengthPrefix(n, nalLength) { var out = []; for (var b = nalLength - 1; b >= 0; b--) out.push(Math.floor(n / Math.pow(256, b)) & 255); return out; }

/**
 * One feed's frame: its slices by tile (in the feed's own tile scan), parsed, plus its non-VCL units.
 * `sets` holds the feed's parameter sets and is updated from in-band ones.
 */
function feedFrame(seg, sample, nalLength, sets) {
  var list = units(seg, sample, nalLength), params = [];
  list.forEach(function (u) { if (u.type >= 32 && u.type <= 34) params.push(unescape(seg, u.body, u.end).rbsp); });
  if (params.length) paramSets(params, sets);
  var slices = list.filter(function (u) { return u.type < 32; }).map(function (u) {
    var protStart = u.protStart >= 0 ? u.protStart : u.end;
    var clear = unescape(seg, u.body, protStart).rbsp;
    var pps = sets.pps[ppsIdOf(clear, u.type)];
    if (!pps) fail('unknown PPS');
    var sps = sets.sps[pps.sps], hd = parseSlice(clear, u.type, sps, pps);
    if (hd.dataStart > clear.length) fail('slice header reaches the encrypted bytes');
    var tileW = sps.wCtb / pps.tileCols, tileH = Math.ceil(sps.hCtb / pps.tileRows);
    var tile = Math.floor(Math.floor(hd.address / sps.wCtb) / tileH) * pps.tileCols + Math.floor((hd.address % sps.wCtb) / tileW);
    return { unit: u, rbsp: clear, h: hd, tile: tile, protStart: protStart };
  });
  return { units: list, slices: slices };
}

/**
 * Builds a layout's segment from the feeds' segments (same number, same structure).
 * cfg: { g (geometry), layout, nalLength, sets: [per feed] }.
 */
function gridSegment(segs, cfg) {
  var g = cfg.g, l = cfg.layout, nl = cfg.nalLength;
  var frags = segs.map(h.fragment), A = frags[0], count = A.samples.length, encrypted = !!A.get('senc'), i, k;
  frags.forEach(function (f) { if (f.samples.length !== count) fail('feeds differ in frame count'); });
  var data = [], sizes = [], subs = [];
  for (i = 0; i < count; i++) {
    var frames = frags.map(function (f, n) { return feedFrame(f.seg, f.samples[i], nl, cfg.sets[n]); });
    var ref = frames[l.cells[0][0]].slices[0];
    var chunks = [], sampleSubs = [], pendingClear = 0;
    // Non-VCL units of the first cell's feed before its first slice: delimiter, parameter sets, SEI.
    var lead = frames[l.cells[0][0]];
    lead.units.forEach(function (u) {
      if (u.type < 32 || u.type === 38 || u.at > lead.slices[0].unit.at) return;
      var f = frags[l.cells[0][0]], raw = f.seg.slice(u.body, u.end), out = raw;
      if (u.type >= 32 && u.type <= 34) out = bytes(escape(rewriteParam(unescape(raw, 0, raw.length).rbsp, g), -1));
      var part = bytes(lengthPrefix(out.length, nl)); chunks.push(part, out); pendingClear += part.length + out.length;
    });
    for (k = 0; k < l.cells.length; k++) {
      var c = l.cells[k], f = frags[c[0]];
      var sl = frames[c[0]].slices.filter(function (x) { return x.tile === c[1]; })[0];
      if (!sl) fail('feed ' + c[0] + ' has no tile ' + c[1] + ' at frame ' + i);
      var hd = sl.h;
      if (hd.type !== ref.h.type || hd.poc !== ref.h.poc || (sl.rbsp[1] & 7) !== (ref.rbsp[1] & 7) ||
        hd.rpsEnd - hd.rpsAt !== ref.h.rpsEnd - ref.h.rpsAt || !sameBits(sl.rbsp, hd.rpsAt, hd.rpsEnd, ref.rbsp, ref.h.rpsAt))
        fail('cell ' + k + ' differs from cell 0 at frame ' + i);
      var col = k % l.cols, row = Math.floor(k / l.cols);
      var address = row * g.cellH * g.wCtb + col * g.cellW;
      var header = cellHeader(sl.rbsp, hd, address, g, edgesOwn(l, k, cfg.tileCols));
      var next = sl.protStart < sl.unit.end ? f.seg[sl.protStart] : -1;
      var body = escape(header.concat(sl.rbsp.slice(hd.dataStart)), next);
      var protectedBytes = f.seg.slice(sl.protStart, sl.unit.end);
      var head = bytes(lengthPrefix(body.length + protectedBytes.length, nl).concat(body));
      chunks.push(head, protectedBytes);
      pendingClear += head.length;
      if (encrypted && pendingClear > 65535) fail('clear part too long');
      sampleSubs.push([pendingClear, protectedBytes.length]);
      pendingClear = 0;
    }
    var sample = concat(chunks);
    data.push(sample); sizes.push(sample.length); subs.push(sampleSubs);
  }
  return h.buildSegment(A, sizes, subs, concat(data));
}

/**
 * Prepares a layout from the feeds' init segments and first media segments (for their in-band
 * parameter sets). layout: a LAYOUTS name or { cols, rows, cells }. Returns { init, cfg, width, height, codecs }.
 */
function prepare(inits, firstSegments, layout, fps) {
  var l = validLayout(typeof layout === 'string' ? LAYOUTS[layout] : layout);
  var entries = inits.map(sampleEntry), nl = entries[0].nalLength;
  var sets = inits.map(function (init, n) {
    var s = paramSets(hvcCParamSets(init, entries[n]));
    var f = h.fragment(firstSegments[n]);
    feedFrame(firstSegments[n], f.samples[0], nl, s);
    return s;
  });
  // Every cell must be one 960x544-style tile of the same size.
  var cell = null, tileCols = [];
  sets.forEach(function (s, n) {
    var pps = s.pps[Object.keys(s.pps)[0]], sps = s.sps[pps.sps];
    tileCols.push(pps.tileCols);
    if (sps.hCtb % pps.tileRows || sps.wCtb % pps.tileCols) fail('feed ' + n + ' tiles are not whole CTBs');
    var size = { w: sps.wCtb / pps.tileCols, h: sps.hCtb / pps.tileRows, ctb: sps.ctb };
    if (!cell) cell = size;
    else if (size.w !== cell.w || size.h !== cell.h || size.ctb !== cell.ctb) fail('feed ' + n + ' tiles differ in size');
  });
  var lead = sets[l.cells[0][0]], leadPps = lead.pps[Object.keys(lead.pps)[0]], leadSps = lead.sps[leadPps.sps];
  var g = { cols: l.cols, rows: l.rows, cellW: cell.w, cellH: cell.h, wCtb: cell.w * l.cols, ctb: cell.ctb,
    width: cell.w * l.cols * cell.ctb, height: cell.h * l.rows * cell.ctb };
  // The TV's 4K path refuses pictures taller than 2160 (F1's own 2160p is 2176 coded, 16 cropped).
  g.display = Math.min(g.height - leadSps.cropBottom, 2160);
  g.level = levelFor(g.width, g.height, fps || 50);
  g.addressBits = log2ceil(cell.w * l.cols * cell.h * l.rows);
  g.pps = { id: leadPps.id, dependentSlices: leadPps.dependentSlices, deblockOverride: leadPps.deblockOverride, deblockDisabled: leadPps.deblockDisabled,
    beta: leadPps.beta, tc: leadPps.tc, loopAcrossSlices: leadPps.loopAcrossSlices };
  var e = entries[l.cells[0][0]], init = inits[l.cells[0][0]];
  var profile = init[e.hvcC.d + 1] & 31, tier = (init[e.hvcC.d + 1] >> 5) & 1;
  return { init: gridInit(init, g), cfg: { g: g, layout: l, nalLength: nl, sets: sets, tileCols: tileCols },
    width: g.width, height: g.display, codecs: 'hev1.' + profile + '.' + ({ 1: '6', 2: '4' }[profile] || '4') + '.' + (tier ? 'H' : 'L') + g.level + '.B0' };
}

module.exports = { prepare: prepare, gridSegment: gridSegment, LAYOUTS: LAYOUTS, parseSps: parseSps, parsePps: parsePps, parseSlice: parseSlice };
