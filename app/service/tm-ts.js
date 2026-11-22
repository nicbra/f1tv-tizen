/*
 * F1's player_tm feeds (HDR_UHD_HLSCK) for the multiview stitcher: MPEG-TS segments, whole-segment AES-128-CBC with
 * the key and IV the playlist names, HEVC with in-band VPS/SPS/PPS (hev1). This turns a segment into the CMAF-style
 * fMP4 fragment stitch-hevc.js reads (and an init segment from its parameter sets), so the grid is built exactly as
 * for the CMAF offers: player_tm is the same encode, repackaged (research, 2026-11-22). Node 12 (the TV's), ES5.
 *
 * Every feed of a session has the same segment numbers, timestamps, key and IV (Las Vegas 2026), so a grid's
 * segment n is the feeds' segments n, as with CMAF.
 */
'use strict';

var crypto = require('crypto');
var h = require('./stitch');
var hevc = require('./stitch-hevc');
var box = h.box, concat = h.concat, alloc = h.alloc, w16 = h.w16, w32 = h.w32;

var WRAP = 8589934592;   // 2^33: the TS clock (90 kHz) wraps every ~26.5 h
var FRAME = 1800;        // 50 fps in 90 kHz ticks: the last picture's duration when nothing follows it

function fail(why) { throw new Error('player_tm: ' + why); }

/** HLS METHOD=AES-128: AES-128-CBC over the whole segment, PKCS7 padding. iv: 16 bytes (Buffer). */
function decrypt(data, key, iv) {
  var d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

/** The IV of a segment: the playlist's IV= (hex), else its media sequence number as a 128-bit big-endian value. */
function ivFor(hex, number) {
  if (hex) {
    var b = Buffer.from(String(hex).replace(/^0x/i, ''), 'hex');
    if (b.length !== 16) fail('IV is not 16 bytes');
    return b;
  }
  var out = alloc(16), n = Math.floor(number);
  for (var i = 15; i >= 8 && n > 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); }
  return out;
}

function pts33(b, o) {
  return ((b[o] >> 1) & 7) * 1073741824 + ((b[o + 1] << 7) | (b[o + 2] >> 1)) * 32768 + ((b[o + 3] << 7) | (b[o + 4] >> 1));
}

/**
 * Demuxes a TS segment: { types: { pid: streamType }, streams: { pid: [{ pts, dts, data }] } }. PES packets are
 * put together by payload_unit_start_indicator; packets before the PMT names their PID are ignored (F1 sends PAT and
 * PMT first in every segment).
 */
function demux(buf) {
  var pmtPid = -1, types = {}, open = {}, out = {};
  function flush(pid) {
    var parts = open[pid];
    if (!parts || !parts.length) return;
    var pes = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    open[pid] = [];
    if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return;
    var flags = pes[7], hl = pes[8], pts = -1, dts;
    if (flags & 0x80) pts = pts33(pes, 9);
    dts = flags & 0x40 ? pts33(pes, 14) : pts;
    (out[pid] = out[pid] || []).push({ pts: pts, dts: dts, data: pes.slice(9 + hl) });
  }
  if (buf.length % 188) fail('segment is not whole TS packets');
  for (var p = 0; p + 188 <= buf.length; p += 188) {
    if (buf[p] !== 0x47) fail('TS sync lost at byte ' + p);
    var pusi = buf[p + 1] & 0x40, pid = ((buf[p + 1] & 31) << 8) | buf[p + 2], afc = (buf[p + 3] >> 4) & 3, q = p + 4;
    if (afc & 2) q += 1 + buf[q];
    if (!(afc & 1) || q >= p + 188) continue;
    if (pid === 0) {
      if (!pusi) continue;
      q += 1 + buf[q];
      // The first program's PMT (skipping the network PID entry, program 0).
      var secEnd = q + 3 + (((buf[q + 1] & 15) << 8) | buf[q + 2]) - 4;
      for (var e = q + 8; e + 4 <= secEnd && e + 4 <= p + 188; e += 4) {
        if (((buf[e] << 8) | buf[e + 1]) !== 0) { pmtPid = ((buf[e + 2] & 31) << 8) | buf[e + 3]; break; }
      }
      continue;
    }
    if (pid === pmtPid) {
      if (!pusi) continue;
      q += 1 + buf[q];
      var end = q + 3 + (((buf[q + 1] & 15) << 8) | buf[q + 2]) - 4, info = ((buf[q + 10] & 15) << 8) | buf[q + 11];
      for (var s = q + 12 + info; s + 5 <= end && s + 5 <= p + 188;) {
        types[((buf[s + 1] & 31) << 8) | buf[s + 2]] = buf[s];
        s += 5 + (((buf[s + 3] & 15) << 8) | buf[s + 4]);
      }
      continue;
    }
    if (!(pid in types)) continue;
    if (pusi) flush(pid);
    (open[pid] = open[pid] || []).push(buf.slice(q, p + 188));
  }
  Object.keys(open).forEach(flush);
  return { types: types, streams: out };
}

/** Annex B start-code split: [{ type, body, end }] (indices into buf; trailing zero bytes belong to the next code). */
function nals(buf) {
  var out = [], i = 0, n = buf.length, last = null;
  while (i + 3 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (last) last.end = i;
      last = { type: (buf[i + 3] >> 1) & 63, body: i + 3, end: n };
      out.push(last);
      i += 3;
    } else i++;
  }
  out.forEach(function (u) { while (u.end > u.body && buf[u.end - 1] === 0) u.end--; });
  return out;
}

/**
 * The HEVC access units of a decrypted segment, decode order: [{ pts, dts, data, nals }]. `base`: a DTS from an
 * earlier segment of the stream; times are unwrapped around it (33-bit rollover), so a grid's clock never jumps back.
 */
function videoAccessUnits(buf, base) {
  var d = demux(buf), pid = Object.keys(d.types).filter(function (k) { return d.types[k] === 0x24; })[0];
  if (pid === undefined) fail('no HEVC stream in the segment');
  var list = (d.streams[pid] || []).filter(function (pes) { return pes.dts >= 0; });
  if (!list.length) fail('no HEVC pictures in the segment');
  var ref = base != null ? base : list[0].dts;
  function unwrap(t) {
    while (t - ref > WRAP / 2) t -= WRAP;
    while (ref - t > WRAP / 2) t += WRAP;
    return t;
  }
  return list.map(function (pes) {
    var dts = unwrap(pes.dts), pts = dts + ((pes.pts - pes.dts + WRAP) % WRAP);
    return { pts: pts, dts: dts, data: pes.data, nals: nals(pes.data) };
  });
}

function fullBox(type, version, flags, payload) {
  var head = alloc(4);
  head[0] = version; head[1] = (flags >> 16) & 255; head[2] = (flags >> 8) & 255; head[3] = flags & 255;
  return box(type, concat([head, payload]));
}
function u32b(v) { var b = alloc(4); w32(b, 0, v); return b; }
function u16b(v) { var b = alloc(2); w16(b, 0, v); return b; }
function u64b(v) { var b = alloc(8); w32(b, 0, Math.floor(v / 4294967296)); w32(b, 4, v % 4294967296); return b; }
function str(s) { return Buffer.from(s, 'latin1'); }

/** The first VPS, SPS and PPS of a segment's access units (escaped, NAL header included). */
function paramSetsOf(aus) {
  var out = {};
  aus.some(function (au) {
    au.nals.forEach(function (u) {
      var k = u.type === 32 ? 'vps' : u.type === 33 ? 'sps' : u.type === 34 ? 'pps' : null;
      if (k && !out[k]) out[k] = au.data.slice(u.body, u.end);
    });
    return out.vps && out.sps && out.pps;
  });
  if (!out.vps || !out.sps || !out.pps) fail('no parameter sets in the segment');
  return out;
}

/** hvcC (ISO/IEC 14496-15) from the parameter sets. */
function hvcC(p, s) {
  var ptl = h.unescape(p.sps, 0, p.sps.length).rbsp.slice(3, 15);   // profile_tier_level: 12 bytes after the NAL header and one byte
  var head = [1, ptl[0], ptl[1], ptl[2], ptl[3], ptl[4], ptl[5], ptl[6], ptl[7], ptl[8], ptl[9], ptl[10], ptl[11],
    0xf0, 0x00, 0xfc, 0xfc | s.chroma, 0xf8 | (s.bitDepth - 8), 0xf8 | (s.bitDepthC - 8), 0, 0, (1 << 3) | (1 << 2) | 3, 3];
  var body = [];
  [[32, p.vps], [33, p.sps], [34, p.pps]].forEach(function (a) {
    body.push(0x80 | a[0], 0, 1, a[1].length >> 8, a[1].length & 255);
    for (var i = 0; i < a[1].length; i++) body.push(a[1][i]);
  });
  return box('hvcC', Buffer.from(head.concat(body)));
}

/** An init segment (ftyp + moov, one hev1 track on the TS clock) for the parameter sets of `aus`. */
function init(aus) {
  var p = paramSetsOf(aus), s = hevc.parseSps(h.unescape(p.sps, 0, p.sps.length).rbsp);
  var w = s.width, ht = s.height - s.cropBottom;
  var matrix = concat([u32b(0x10000), u32b(0), u32b(0), u32b(0), u32b(0x10000), u32b(0), u32b(0), u32b(0), u32b(0x40000000)]);
  var ftyp = box('ftyp', concat([str('iso6'), u32b(0), str('iso6cmfcdashhlsf')]));
  var mvhd = fullBox('mvhd', 0, 0, concat([u32b(0), u32b(0), u32b(90000), u32b(0), u32b(0x10000), u16b(0x100), alloc(10), matrix, alloc(24), u32b(2)]));
  var tkhd = fullBox('tkhd', 0, 3, concat([u32b(0), u32b(0), u32b(1), u32b(0), u32b(0), alloc(8), u16b(0), u16b(0), u16b(0), u16b(0), matrix, u32b(w * 65536), u32b(ht * 65536)]));
  var mdhd = fullBox('mdhd', 0, 0, concat([u32b(0), u32b(0), u32b(90000), u32b(0), u16b(0x55c4), u16b(0)]));
  var hdlr = fullBox('hdlr', 0, 0, concat([u32b(0), str('vide'), alloc(12), str('video\0')]));
  var dinf = box('dinf', fullBox('dref', 0, 0, concat([u32b(1), fullBox('url ', 0, 1, alloc(0))])));
  // HLG, BT.2020 (F1's player_tm video); the stitched picture copies this.
  var colr = box('colr', concat([str('nclx'), u16b(9), u16b(18), u16b(9), Buffer.from([0])]));
  var entry = box('hev1', concat([alloc(6), u16b(1), alloc(16), u16b(w), u16b(ht), u32b(0x480000), u32b(0x480000), u32b(0), u16b(1),
    alloc(32), u16b(0x18), u16b(0xffff), hvcC(p, s), colr]));
  var stbl = box('stbl', concat([fullBox('stsd', 0, 0, concat([u32b(1), entry])), fullBox('stts', 0, 0, u32b(0)), fullBox('stsc', 0, 0, u32b(0)),
    fullBox('stsz', 0, 0, concat([u32b(0), u32b(0)])), fullBox('stco', 0, 0, u32b(0))]));
  var trak = box('trak', concat([tkhd, box('mdia', concat([mdhd, hdlr, box('minf', concat([fullBox('vmhd', 0, 1, alloc(8)), dinf, stbl]))]))]));
  var mvex = box('mvex', fullBox('trex', 0, 0, concat([u32b(1), u32b(1), u32b(0), u32b(0), u32b(0)])));
  return concat([ftyp, box('moov', concat([mvhd, trak, mvex]))]);
}

function isIrap(au) { return au.nals.some(function (u) { return u.type >= 16 && u.type <= 23; }); }

/** An fMP4 fragment (styp + moof + mdat) of access units in decode order: tfdt = first DTS, 4-byte NAL lengths. */
function fragment(aus, seq) {
  var n = aus.length, samples = aus.map(function (au) {
    var parts = [];
    au.nals.forEach(function (u) { parts.push(u32b(u.end - u.body), au.data.slice(u.body, u.end)); });
    return concat(parts);
  });
  var table = [u32b(n), u32b(0)];
  aus.forEach(function (au, i) {
    var dur = i + 1 < n ? aus[i + 1].dts - au.dts : (n > 1 ? au.dts - aus[i - 1].dts : FRAME);
    table.push(u32b(dur > 0 ? dur : FRAME), u32b(samples[i].length), u32b(isIrap(au) ? 0x02000000 : 0x01010000), u32b(Math.max(0, au.pts - au.dts)));
  });
  var trun = fullBox('trun', 0, 0xf01, concat(table));
  var traf = box('traf', concat([fullBox('tfhd', 0, 0x020000, u32b(1)), fullBox('tfdt', 1, 0, u64b(aus[0].dts)), trun]));
  var moof = box('moof', concat([fullBox('mfhd', 0, 0, u32b(seq >>> 0)), traf]));
  w32(moof, moof.length - trun.length + 16, moof.length + 8);   // trun data_offset: moof start to the first sample
  return concat([box('styp', concat([str('msdh'), u32b(0), str('msdhmsix')])), moof, box('mdat', concat(samples))]);
}

/**
 * A player_tm segment as the stitcher reads it. feed: { key (hex), iv (hex or null) }; number: its media sequence
 * number; base: an earlier DTS of the feed (unwrapping), or null. Returns { segment, aus, firstDts }.
 */
function convert(raw, feed, number, base) {
  var key = Buffer.from(String(feed.key || ''), 'hex');
  if (key.length !== 16) fail('need a 16-byte key');
  var aus = videoAccessUnits(decrypt(raw, key, ivFor(feed.iv, number)), base);
  return { segment: fragment(aus, number), aus: aus, firstDts: aus[0].dts };
}

module.exports = { decrypt: decrypt, ivFor: ivFor, demux: demux, nals: nals, videoAccessUnits: videoAccessUnits,
  init: init, fragment: fragment, convert: convert, paramSetsOf: paramSetsOf,
  WRAP: WRAP, SEGMENT: 518400 };   // F1's player_tm segments: 5.76 s in 90 kHz ticks
