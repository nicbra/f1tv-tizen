/*
 * MPEG-TS -> H.264 access units (F1's 2018-2024 replays are HLS with TS segments, one PES per access unit), and AAC.
 * TsDemux.video(bytes) -> [{ pts (90 kHz), data (Annex B access unit), nonRef }]
 * nonRef: nal_ref_idc 0 on the access unit's first slice: no other frame predicts from it (the B frames).
 * TsDemux.audio(bytes) -> { frames: [{ pts (90 kHz), data (raw AAC frame) }], config: { objectType, rateIndex, rate,
 *   channels } } or null: ADTS AAC from a TS segment (stream type 0x0f) or from packed audio (HLS .aac: an ID3 tag
 *   with the transportStreamTimestamp, then ADTS frames).
 * A PES is assembled from its packets before its header is read (the header may continue in the next packet).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TsDemux = factory();
})(this, function () {
  'use strict';

  // The PES packets of the first elementary stream of `streamType` in the PMT: [{ pts, data }].
  function pesOf(ts, streamType) {
    var pmt = -1, vid = -1, pes = [], cur = null;
    for (var p = 0; p + 188 <= ts.length; p += 188) {
      if (ts[p] !== 0x47) continue;
      var pusi = ts[p + 1] & 0x40, pid = ((ts[p + 1] & 31) << 8) | ts[p + 2], afc = (ts[p + 3] >> 4) & 3, o = p + 4;
      if (afc & 2) o += 1 + ts[o];
      if (!(afc & 1) || o >= p + 188) continue;
      if (pid === 0 && pusi) { o += 1 + ts[o]; pmt = ((ts[o + 10] & 31) << 8) | ts[o + 11]; continue; }
      if (pid === pmt && pusi) {
        o += 1 + ts[o];
        var secLen = ((ts[o + 1] & 15) << 8) | ts[o + 2], piLen = ((ts[o + 10] & 15) << 8) | ts[o + 11], q = o + 12 + piLen, end = o + 3 + secLen - 4;
        while (q < end) { if (ts[q] === streamType && vid < 0) vid = ((ts[q + 1] & 31) << 8) | ts[q + 2]; q += 5 + (((ts[q + 3] & 15) << 8) | ts[q + 4]); }
        continue;
      }
      if (pid !== vid) continue;
      if (pusi) { if (cur) pes.push(cur); cur = { parts: [], size: 0 }; }
      if (cur) { cur.parts.push(ts.subarray(o, p + 188)); cur.size += p + 188 - o; }
    }
    if (cur) pes.push(cur);
    var out = [];
    pes.forEach(function (x) {
      var b = new Uint8Array(x.size), k = 0;
      x.parts.forEach(function (a) { b.set(a, k); k += a.length; });
      if (b.length < 9 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1) return;   // not a PES start: skip
      var flags = b[7], hl = b[8], pts = null;
      if (9 + hl > b.length) return;
      if ((flags & 0x80) && hl >= 5) pts = ((b[9] >> 1) & 7) * 1073741824 + ((b[10] << 7) | (b[11] >> 1)) * 32768 + ((b[12] << 7) | (b[13] >> 1));
      out.push({ pts: pts, data: b.subarray(9 + hl) });
    });
    return out;
  }

  function video(ts) {
    return pesOf(ts, 0x1b).map(function (x) { return { pts: x.pts, data: x.data, nonRef: nonRef(x.data) }; });
  }

  var RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  // ADTS frames from `d` starting at `pts` (90 kHz), 1024 samples each; appended to `out.frames`.
  function adts(d, pts, out) {
    for (var i = 0; i + 7 <= d.length;) {
      if (d[i] !== 0xff || (d[i + 1] & 0xf6) !== 0xf0) { i++; continue; }   // resync
      var protectionAbsent = d[i + 1] & 1, len = ((d[i + 3] & 3) << 11) | (d[i + 4] << 3) | (d[i + 5] >> 5);
      var head = protectionAbsent ? 7 : 9;
      if (len < head || i + len > d.length) break;
      if (!out.config) {
        var ri = (d[i + 2] >> 2) & 15;
        out.config = { objectType: (d[i + 2] >> 6) + 1, rateIndex: ri, rate: RATES[ri], channels: ((d[i + 2] & 1) << 2) | (d[i + 3] >> 6) };
      }
      out.frames.push({ pts: Math.round(pts + out.n * 1024 * 90000 / out.config.rate), data: d.subarray(i + head, i + len) });
      out.n++;
      i += len;
    }
  }

  function audio(bytes) {
    var out = { frames: [], config: null, n: 0 };
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {   // 'ID3': packed audio
      var size = ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127), pts = 0;
      for (var p = 10; p + 10 <= 10 + size;) {
        var id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
        var fs = (bytes[p + 4] << 24 | bytes[p + 5] << 16 | bytes[p + 6] << 8 | bytes[p + 7]) >>> 0;
        if (!fs || id === '\0\0\0\0') break;
        if (id === 'PRIV') {
          var body = bytes.subarray(p + 10, p + 10 + fs), owner = '', k = 0;
          while (k < body.length && body[k]) owner += String.fromCharCode(body[k++]);
          if (owner === 'com.apple.streaming.transportStreamTimestamp' && k + 9 <= body.length) {
            var t = body.subarray(k + 1, k + 9);
            pts = (t[3] & 1) * 4294967296 + ((t[4] << 24 | t[5] << 16 | t[6] << 8 | t[7]) >>> 0);
          }
        }
        p += 10 + fs;
      }
      adts(bytes.subarray(10 + size), pts, out);
    } else {
      // Each PES restarts the count from its own PTS.
      pesOf(bytes, 0x0f).forEach(function (x) { if (x.pts !== null) { out.n = 0; adts(x.data, x.pts, out); } });
    }
    delete out.n;
    return out.frames.length ? out : null;
  }

  function nonRef(d) {
    for (var i = 0; i + 3 < d.length; i++) {
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
        var t = d[i + 3] & 31;
        if (t === 1 || t === 5) return ((d[i + 3] >> 5) & 3) === 0;
        i += 2;
      }
    }
    return false;
  }

  return { video: video, audio: audio, nonRef: nonRef };
});
