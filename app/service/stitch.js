/* Shared MP4 and bitstream helpers for the HEVC multiview grids (stitch-hevc.js). */
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
function escape(rbsp, next, nextIsData) {
  var out = [], zeros = 0;
  for (var i = 0; i < rbsp.length; i++) {
    if (zeros >= 2 && rbsp[i] <= 3) { out.push(3); zeros = 0; }
    out.push(rbsp[i]);
    zeros = rbsp[i] === 0 ? zeros + 1 : 0;
  }
  // nextIsData: `next` is the following payload byte itself (then a 3 needs one too).
  if (zeros >= 2 && next >= 0 && next <= (nextIsData ? 3 : 2)) out.push(3);
  return out;
}

/** How far into a slice NAL unit its header is read: headers are short, the data is copied as it is. */
var HEADER_WINDOW = 512;

/**
 * A slice with a rewritten header, without escaping all of its data again: the new header and the first two
 * data bytes are escaped anew, and the rest is copied unchanged from `restAt` (from there on, escaping
 * depends only on data bytes, which are the same). win: the unescaped window from the NAL body ({ rbsp, map });
 * whole: whether it reaches the end of the clear bytes. Returns { head (escaped bytes), restAt (index in seg) }.
 */
function spliceHeader(seg, win, header, dataStart, winEnd, whole) {
  var k = dataStart + 2;
  if (k < win.rbsp.length) return { head: escape(header.concat(win.rbsp.slice(dataStart, k)), win.rbsp[k], true), restAt: win.map[k] };
  if (!whole) throw new Error('slice header too long');
  // The clear bytes end right after the header: all of them anew, before the encrypted ones.
  return { head: escape(header.concat(win.rbsp.slice(dataStart)), winEnd < seg.length ? seg[winEnd] : -1), restAt: winEnd };
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

module.exports = { fragment: fragment,
  u16: u16, u32: u32, w16: w16, w32: w32, alloc: alloc, concat: concat, bytes: bytes, boxes: boxes, child: child, box: box,
  Reader: Reader, Writer: Writer, buildSegment: buildSegment, spliceHeader: spliceHeader, HEADER_WINDOW: HEADER_WINDOW,
  escape: escape, unescape: unescape };
