/*
 * StitchX: interleave H.264 feeds into one stream, each picture a whole frame of one feed. The feeds may have
 * different frame types, decode orders and references. Slice payloads are copied unchanged; headers carry the
 * new frame numbers, picture order, explicit reference lists and reference marking. Each segment starts with
 * an intra frame in every feed and is planned independently. An optional coded row identifies the picture's feed.
 *
 * StitchX.interleaveSegment(feeds, opts) -> { aus: [Uint8Array Annex B access units], pictures: plan, sps, info }
 *   feeds[f]: access units of one segment in decode order, as TsDemux gives them: [{ data (Annex B), pts }].
 *   Display times come from PTS (the feeds share one clock; POC restarts at every IDR, PTS does not).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StitchX = factory();
})(this, function () {
  'use strict';

  // ---------------------------------------------------------------- bits
  function Reader(a) { this.a = a; this.p = 0; }
  Reader.prototype.u = function (n) {
    var v = 0;
    for (var i = 0; i < n; i++) { v = v * 2 + ((this.a[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; }
    return v;
  };
  Reader.prototype.ue = function () {
    var z = 0;
    while (this.u(1) === 0) { if (++z > 31) throw new Error('bad exp-golomb'); }
    return z ? Math.pow(2, z) - 1 + this.u(z) : 0;
  };
  Reader.prototype.se = function () { var k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); };
  Reader.prototype.more = function () {   // more_rbsp_data
    var last = this.a.length * 8 - 1;
    while (last >= 0 && !((this.a[last >> 3] >> (7 - (last & 7))) & 1)) last--;
    return this.p < last;
  };

  function Writer() { this.bits = []; }
  Writer.prototype.u = function (n, v) { for (var i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / Math.pow(2, i)) & 1); };
  Writer.prototype.ue = function (v) {
    var x = v + 1, n = 0;
    while (Math.pow(2, n + 1) <= x) n++;
    this.u(n, 0); this.u(n + 1, x);
  };
  Writer.prototype.se = function (v) { this.ue(v > 0 ? 2 * v - 1 : -2 * v); };
  Writer.prototype.align = function (bit) { while (this.bits.length % 8) this.bits.push(bit); };
  Writer.prototype.trailing = function () { this.bits.push(1); this.align(0); };   // rbsp_trailing_bits
  Writer.prototype.bytes = function () {
    var out = new Uint8Array(this.bits.length >> 3);
    for (var i = 0; i < out.length; i++) { var b = 0; for (var k = 0; k < 8; k++) b = (b << 1) | this.bits[i * 8 + k]; out[i] = b; }
    return out;
  };

  // ---------------------------------------------------------------- NAL units
  function unescape(b, s, e) {
    var out = new Uint8Array(e - s), n = 0, zeros = 0;
    for (var i = s; i < e; i++) {
      if (zeros >= 2 && b[i] === 3) { zeros = 0; continue; }
      out[n++] = b[i];
      zeros = b[i] === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, n);
  }
  // Emulation prevention for a whole RBSP (header + payload).
  function escape(rbsp) {
    var out = new Uint8Array(rbsp.length + (rbsp.length >> 1) + 4), n = 0, zeros = 0;
    for (var i = 0; i < rbsp.length; i++) {
      var b = rbsp[i];
      if (zeros >= 2 && b <= 3) { out[n++] = 3; zeros = 0; }
      out[n++] = b;
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, n);
  }
  // Annex B access unit -> [{ type, refIdc, rbsp (without the 1-byte NAL header), raw (escaped payload) }].
  // Slices: only the start is unescaped (`head`, enough for the header); their payload is copied escaped (spliceNal).
  var HEAD_BYTES = 128;
  function nals(au) {
    var starts = [], i;
    for (i = 0; i + 2 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) { starts.push(i + 3); i += 2; }
    return starts.map(function (s, k) {
      var e = k + 1 < starts.length ? starts[k + 1] - 3 : au.length;
      while (e > s && au[e - 1] === 0) e--;   // trailing zero bytes / the zero of a 4-byte start code
      var type = au[s] & 31, raw = au.subarray(s + 1, e), slice = type === 1 || type === 5;
      var n = { type: type, refIdc: (au[s] >> 5) & 3, raw: raw };
      if (slice && raw.length > HEAD_BYTES * 2) n.rbsp = unescape(raw, 0, HEAD_BYTES), n.partial = true;
      else n.rbsp = unescape(raw, 0, raw.length);
      return n;
    });
  }
  // The escaped byte offset in `raw` where unescaped byte `k` starts.
  function rawOffset(raw, k) {
    var zeros = 0, n = 0;
    for (var i = 0; i < raw.length; i++) {
      if (zeros >= 2 && raw[i] === 3) { zeros = 0; continue; }
      if (n === k) return i;
      n++;
      zeros = raw[i] === 0 ? zeros + 1 : 0;
    }
    return raw.length;
  }
  // A slice NAL: the new header, then the original payload from byte `dataStart` on, copied escaped. Only the header and
  // the payload up to just after its first non-zero byte (from dataStart + 2) are escaped anew: past a non-zero byte
  // the escaping state is the same as in the original.
  function spliceNal(type, refIdc, header, nal, dataStart) {
    var r = nal.rbsp, k = dataStart + 2;
    while (k < r.length && r[k - 1] === 0) k++;
    if (k >= r.length) {   // header region only: unescape it all
      var full = nal.partial ? unescape(nal.raw, 0, nal.raw.length) : r;
      return nalBytes(type, refIdc, concat([header, full.subarray(dataStart)]));
    }
    var head = escape(concat([header, r.subarray(dataStart, k)])), rest = nal.raw.subarray(rawOffset(nal.raw, k));
    var out = new Uint8Array(5 + head.length + rest.length);
    out.set([0, 0, 0, 1, (refIdc << 5) | type]); out.set(head, 5); out.set(rest, 5 + head.length);
    return out;
  }
  function nalBytes(type, refIdc, rbsp) {
    var body = escape(rbsp), out = new Uint8Array(4 + 1 + body.length);
    out.set([0, 0, 0, 1, (refIdc << 5) | type]); out.set(body, 5);
    return out;
  }
  function concat(list) {
    var n = 0, k = 0; list.forEach(function (a) { n += a.length; });
    var out = new Uint8Array(n); list.forEach(function (a) { out.set(a, k); k += a.length; });
    return out;
  }

  // ---------------------------------------------------------------- parameter sets (Main profile, frames)
  function parseSps(rbsp) {
    var r = new Reader(rbsp), s = {};
    s.profile = r.u(8); s.constraints = r.u(8); s.level = r.u(8); s.id = r.ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(s.profile) >= 0) throw new Error('High profiles not handled');
    s.log2FrameNum = r.ue() + 4;
    s.pocType = r.ue();
    if (s.pocType !== 0) throw new Error('POC type ' + s.pocType + ' not handled');
    s.log2PocLsb = r.ue() + 4;
    s.refFrames = r.ue(); s.gaps = r.u(1);
    s.widthMbs = r.ue() + 1; s.heightMbs = r.ue() + 1;
    s.frameMbsOnly = r.u(1);
    if (!s.frameMbsOnly) throw new Error('interlaced not handled');
    s.direct8x8 = r.u(1);
    s.crop = r.u(1) ? [r.ue(), r.ue(), r.ue(), r.ue()] : null;
    // Preserve source appearance; timing/DPB below are regenerated for the new stream.
    if (r.u(1)) {
      if (r.u(1)) {
        s.vuiAspect = { id: r.u(8) };
        if (s.vuiAspect.id === 255) { s.vuiAspect.width = r.u(16); s.vuiAspect.height = r.u(16); }
      }
      if (r.u(1)) s.vuiOverscan = r.u(1);
      if (r.u(1)) {
        s.videoSignal = { format: r.u(3), fullRange: r.u(1), descriptionPresent: r.u(1) };
        if (s.videoSignal.descriptionPresent) {
          s.videoSignal.primaries = r.u(8); s.videoSignal.transfer = r.u(8); s.videoSignal.matrix = r.u(8);
        }
      }
      if (r.u(1)) s.chromaLoc = [r.ue(), r.ue()];
    }
    return s;
  }
  function parsePps(rbsp) {
    var r = new Reader(rbsp), p = {};
    p.id = r.ue(); p.spsId = r.ue(); p.cabac = r.u(1); p.bottomPoc = r.u(1);
    if (r.ue() !== 0) throw new Error('slice groups not handled');
    p.l0 = r.ue() + 1; p.l1 = r.ue() + 1; p.weighted = r.u(1); p.bipred = r.u(2);
    p.initQpMinus26 = r.se(); p.initQsMinus26 = r.se(); p.chromaQpOffset = r.se();
    p.deblockControl = r.u(1); p.constrainedIntra = r.u(1); p.redundant = r.u(1);
    if (r.more()) throw new Error('PPS extensions (High profile) not handled');
    if (!p.cabac) throw new Error('CAVLC not handled');
    return p;
  }
  function writeSps(s) {
    var w = new Writer();
    w.u(8, s.profile); w.u(8, s.constraints); w.u(8, s.level); w.ue(0);
    w.ue(s.log2FrameNum - 4); w.ue(0); w.ue(s.log2PocLsb - 4);
    w.ue(s.refFrames); w.u(1, 0);
    w.ue(s.widthMbs - 1); w.ue(s.heightMbs - 1);
    w.u(1, 1); w.u(1, s.direct8x8);
    w.u(1, 0);                     // no cropping: the regions are cut out after decoding
    w.u(1, 1);                     // VUI: timing and bitstream_restriction (reordering depth, DPB size)

    w.u(1, s.vuiAspect ? 1 : 0);
    if (s.vuiAspect) {
      w.u(8, s.vuiAspect.id);
      if (s.vuiAspect.id === 255) { w.u(16, s.vuiAspect.width); w.u(16, s.vuiAspect.height); }
    }
    w.u(1, s.vuiOverscan === undefined ? 0 : 1);
    if (s.vuiOverscan !== undefined) w.u(1, s.vuiOverscan);
    w.u(1, s.videoSignal ? 1 : 0);
    if (s.videoSignal) {
      w.u(3, s.videoSignal.format); w.u(1, s.videoSignal.fullRange); w.u(1, s.videoSignal.descriptionPresent);
      if (s.videoSignal.descriptionPresent) {
        w.u(8, s.videoSignal.primaries); w.u(8, s.videoSignal.transfer); w.u(8, s.videoSignal.matrix);
      }
    }
    w.u(1, s.chromaLoc ? 1 : 0);
    if (s.chromaLoc) { w.ue(s.chromaLoc[0]); w.ue(s.chromaLoc[1]); }
    // timing_info: the feeds' frame rate (a tick is half a frame: 90 kHz frame duration over 180 kHz), not fixed (the
    // in-between pictures). Samsung's AVPlay refuses H.264 without it (PLAYER_ERROR_NOT_SUPPORTED_FORMAT, 2026-11-08).
    w.u(1, 1); w.u(32, s.frameDur || 1800); w.u(32, 180000); w.u(1, 0);
    w.u(1, 0); w.u(1, 0); w.u(1, 0);
    w.u(1, 1);                     // bitstream_restriction_flag
    w.u(1, 1); w.ue(0); w.ue(0); w.ue(16); w.ue(16);
    w.ue(s.reorder); w.ue(s.dpb);
    w.trailing();
    return w.bytes();
  }
  function writePps(p) {
    var w = new Writer();
    w.ue(0); w.ue(0); w.u(1, 1); w.u(1, 0);
    w.ue(0);                     // no slice groups
    w.ue(p.l0 - 1); w.ue(p.l1 - 1); w.u(1, p.weighted); w.u(2, p.bipred);
    w.se(p.initQpMinus26); w.se(p.initQsMinus26); w.se(p.chromaQpOffset);
    w.u(1, 1); w.u(1, p.constrainedIntra); w.u(1, 0);
    w.trailing();
    return w.bytes();
  }

  // ---------------------------------------------------------------- slice headers
  function parseSlice(rbsp, nal, sps, pps) {
    var r = new Reader(rbsp), h = { nalType: nal.type, refIdc: nal.refIdc };
    h.firstMb = r.ue(); h.sliceType = r.ue() % 5; h.ppsId = r.ue();
    h.frameNum = r.u(sps.log2FrameNum);
    if (nal.type === 5) h.idr = r.ue();
    h.pocLsb = r.u(sps.log2PocLsb);
    h.pocBottom = pps.bottomPoc ? r.se() : 0;
    if (pps.redundant) r.ue();
    var P = h.sliceType === 0, B = h.sliceType === 1;
    if (h.sliceType > 2) throw new Error('SP/SI slices not handled');
    if (B) h.directSpatial = r.u(1);
    h.count = [pps.l0, pps.l1];
    if (P || B) { if (r.u(1)) { h.count[0] = r.ue() + 1; if (B) h.count[1] = r.ue() + 1; } }
    h.mods = [[], []];
    for (var l = 0; l < (B ? 2 : P ? 1 : 0); l++) {
      if (r.u(1)) {
        for (;;) {
          var op = r.ue();
          if (op === 3) break;
          if (op > 2) throw new Error('bad list modification');
          h.mods[l].push([op, r.ue()]);
        }
      }
    }
    // Explicit weights (pred_weight_table) follow the reference indices, which keep their order: copied bit for bit.
    h.weights = null;
    if ((pps.weighted && P) || (pps.bipred === 1 && B)) {
      var w0 = r.p;
      r.ue(); r.ue();   // luma/chroma log2 denominators (4:2:0)
      for (var wl = 0; wl < (B ? 2 : 1); wl++) {
        for (var wi = 0; wi < h.count[wl]; wi++) {
          if (r.u(1)) { r.se(); r.se(); }
          if (r.u(1)) { r.se(); r.se(); r.se(); r.se(); }
        }
      }
      h.weights = []; for (var wb = w0; wb < r.p; wb++) h.weights.push((rbsp[wb >> 3] >> (7 - (wb & 7))) & 1);
    }
    h.mmco = null; h.longTerm = 0; h.noOutput = 0;
    if (nal.refIdc) {
      if (nal.type === 5) { h.noOutput = r.u(1); h.longTerm = r.u(1); }
      else if (r.u(1)) {
        h.mmco = [];
        for (;;) {
          var m = r.ue();
          if (m === 0) break;
          var e = [m];
          if (m === 1 || m === 3) e.push(r.ue());
          if (m === 2) e.push(r.ue());
          if (m === 3 || m === 6) e.push(r.ue());
          if (m === 4) e.push(r.ue());
          h.mmco.push(e);
        }
      }
    }
    h.cabacInit = h.sliceType !== 2 ? r.ue() : 0;
    h.qpDelta = r.se();
    h.deblock = 0; h.alpha = 0; h.beta = 0;
    if (pps.deblockControl) { h.deblock = r.ue(); if (h.deblock !== 1) { h.alpha = r.se(); h.beta = r.se(); } }
    h.dataStart = (r.p + 7) >> 3;   // CABAC slice data starts byte aligned
    return h;
  }

  // A slice header for the stitched stream. f: { firstMb, sliceType, frameNum, idr, poc, directSpatial, lists: [[picNum..],[..]],
  //   currPicNum, refIdc, nalType, mmco: [[1, diff]..] | null, noOutput, cabacInit, qpDelta, deblock, alpha, beta }
  function writeSliceHeader(f, sps) {
    var w = new Writer(), P = f.sliceType === 0, B = f.sliceType === 1;
    w.ue(f.firstMb); w.ue(f.sliceType); w.ue(0);
    w.u(sps.log2FrameNum, f.frameNum);
    if (f.nalType === 5) w.ue(f.idr);
    w.u(sps.log2PocLsb, f.poc);
    if (B) w.u(1, f.directSpatial);
    if (P || B) {
      w.u(1, 1); w.ue(f.lists[0].length - 1); if (B) w.ue(f.lists[1].length - 1);
      for (var l = 0; l < (B ? 2 : 1); l++) {
        w.u(1, 1);
        var pred = f.currPicNum;
        var maxPicNum = Math.pow(2, sps.log2FrameNum);
        f.lists[l].forEach(function (pn) {
          var d = pn - pred;
          // The same picture again (explicit weighted prediction lists it once per weight): a whole MaxPicNum ahead
          // wraps around to it (8.2.4.3.1).
          if (d === 0) { w.ue(1); w.ue(maxPicNum - 1); }
          else if (d < 0) { w.ue(0); w.ue(-d - 1); } else { w.ue(1); w.ue(d - 1); }
          pred = pn;
        });
        w.ue(3);
      }
    }
    if (f.weights) f.weights.forEach(function (b) { w.bits.push(b); });
    if (f.refIdc) {
      if (f.nalType === 5) { w.u(1, f.noOutput || 0); w.u(1, 0); }
      else {
        w.u(1, 1);
        (f.mmco || []).forEach(function (m) { w.ue(m[0]); w.ue(m[1]); });
        w.ue(0);
      }
    }
    if (f.sliceType !== 2) w.ue(f.cabacInit);
    w.se(f.qpDelta);
    w.ue(f.deblock); if (f.deblock !== 1) { w.se(f.alpha); w.se(f.beta); }
    w.align(1);   // cabac_alignment_one_bit
    return w.bytes();
  }

  // ---------------------------------------------------------------- CABAC for the feed identity row
  var RANGE_LPS = null, TRANS_LPS = null, INIT_I = null, INIT_PB = null;
  function tables(t) { RANGE_LPS = t.rangeTabLPS; TRANS_LPS = t.transIdxLPS; INIT_I = t.initI; INIT_PB = t.initPB; }

  function Cabac() { this.low = 0; this.range = 510; this.first = true; this.outstanding = 0; this.w = new Writer(); }
  Cabac.prototype.put = function (b) {
    if (this.first) this.first = false; else this.w.bits.push(b);
    for (; this.outstanding > 0; this.outstanding--) this.w.bits.push(1 - b);
  };
  Cabac.prototype.renorm = function () {
    while (this.range < 256) {
      if (this.low < 256) this.put(0);
      else if (this.low >= 512) { this.low -= 512; this.put(1); }
      else { this.low -= 256; this.outstanding++; }
      this.range <<= 1; this.low <<= 1;
    }
  };
  Cabac.prototype.decision = function (ctx, bin) {
    var lps = RANGE_LPS[ctx.state][(this.range >> 6) & 3];
    this.range -= lps;
    if (bin !== ctx.mps) {
      this.low += this.range; this.range = lps;
      if (ctx.state === 0) ctx.mps = 1 - ctx.mps;
      ctx.state = TRANS_LPS[ctx.state];
    } else if (ctx.state < 62) ctx.state++;
    this.renorm();
  };
  Cabac.prototype.terminate = function (bin) {
    this.range -= 2;
    if (bin) {
      this.low += this.range;
      this.range = 2; this.renorm();                        // EncodeFlush (9.3.4.5)
      this.put((this.low >> 9) & 1);
      this.w.u(2, ((this.low >> 7) & 3) | 1);              // its last 1 is the rbsp_stop_one_bit
      this.w.align(0);
    } else this.renorm();
  };
  function context(mn, qp) {
    var pre = Math.max(1, Math.min(126, ((mn[0] * Math.max(0, Math.min(51, qp))) >> 4) + mn[1]));
    return pre <= 63 ? { state: 63 - pre, mps: 0 } : { state: pre - 64, mps: 1 };
  }
  // Feed identity: the first macroblock is I_PCM with the feed's luma value, the rest stay gray. The first picture
  // uses an intra row; later pictures copy gray with P_Skip. The slice above is separate, so its neighbours are unavailable.
  var tagCache = {};
  function feedTagData(mbs, value, qp, intra) {
    var key = mbs + '/' + value + '/' + qp + '/' + (intra ? 'I' : 'P');
    if (tagCache[key]) return tagCache[key];
    var c = new Cabac(), init = intra ? INIT_I : INIT_PB[0];
    var ctx = function (i) { return context(init[i], qp); };
    var skip = [ctx(11), ctx(12)], intraInP = ctx(14), notNxN = ctx(17), iType = [ctx(3), ctx(4)];
    function pcm(luma) {
      c.terminate(1);
      for (var i = 0; i < 256; i++) c.w.u(8, luma);
      for (i = 0; i < 128; i++) c.w.u(8, 128);
      c.low = 0; c.range = 510; c.first = true; c.outstanding = 0;
    }
    for (var m = 0; m < mbs; m++) {
      if (intra) {
        c.decision(iType[m ? 1 : 0], 1);   // mb_type: only the left I_PCM neighbour is available in this row
        pcm(m === 0 ? value : 128);
      } else if (m === 0) {
        c.decision(skip[0], 0);                    // mb_skip_flag 0
        c.decision(intraInP, 1);                   // mb_type prefix: intra macroblock in a P slice
        c.decision(notNxN, 1);                     // suffix bin 0: not I_NxN
        pcm(value);                                // suffix bin 1 (terminate) 1: I_PCM
      } else {
        c.decision(skip[m === 1 ? 1 : 0], 1);      // mb_skip_flag 1 (macroblock 1: its left neighbour was not skipped)
      }
      c.terminate(m === mbs - 1 ? 1 : 0);          // end_of_slice_flag
    }
    return (tagCache[key] = c.w.bytes());
  }

  // ---------------------------------------------------------------- a feed's frames, references and POCs
  /*
   * Decodes what H.264's reference handling needs from one feed's segment: for every frame (access unit) its POC,
   * reference status and, per slice, the frames its reference lists hold (8.2.1, 8.2.4, 8.2.5).
   */
  function analyse(units) {
    var sps = null, pps = null, frames = [], refs = [], prev = { msb: 0, lsb: 0, frameNum: 0 };
    units.forEach(function (unit, idx) {
      var au = unit.data || unit, list = nals(au), slices = [];
      list.forEach(function (n) {
        if (n.type === 7) { sps = parseSps(n.rbsp); sps.raw = n.rbsp; }
        else if (n.type === 8) { pps = parsePps(n.rbsp); pps.raw = n.rbsp; }
        else if (n.type === 1 || n.type === 5) slices.push(n);
      });
      if (!slices.length) return;
      if (!sps || !pps) throw new Error('no SPS/PPS before the first slice');
      var heads = slices.map(function (n) { return parseSlice(n.rbsp, n, sps, pps); }), h = heads[0];
      // An IDR marked long-term would stay in the DPB outside the sliding window: not modelled (like MMCO 2-6).
      if (h.nalType === 5 && h.longTerm) throw new Error('an IDR marked as a long-term reference is not handled');
      var maxFrameNum = Math.pow(2, sps.log2FrameNum), maxLsb = Math.pow(2, sps.log2PocLsb);
      if (h.nalType === 5) { refs = []; prev = { msb: 0, lsb: 0, frameNum: 0 }; }
      var msb = prev.msb;
      if (h.pocLsb < prev.lsb && prev.lsb - h.pocLsb >= maxLsb / 2) msb = prev.msb + maxLsb;
      else if (h.pocLsb > prev.lsb && h.pocLsb - prev.lsb > maxLsb / 2) msb = prev.msb - maxLsb;
      var top = msb + h.pocLsb, poc = Math.min(top, top + h.pocBottom);
      var frame = { idx: idx, idr: h.nalType === 5, ref: h.refIdc !== 0, frameNum: h.frameNum, poc: poc, pts: unit.pts, slices: [] };
      refs.forEach(function (r) { r.picNum = r.frameNum > h.frameNum ? r.frameNum - maxFrameNum : r.frameNum; });
      heads.forEach(function (sh, k) {
        var lists = [[], []];
        if (sh.sliceType !== 2) {
          var init;
          if (sh.sliceType === 0) init = [refs.slice().sort(function (a, b) { return b.picNum - a.picNum; })];
          else {
            var before = refs.filter(function (r) { return r.poc < poc; }).sort(function (a, b) { return b.poc - a.poc; });
            var after = refs.filter(function (r) { return r.poc > poc; }).sort(function (a, b) { return a.poc - b.poc; });
            var l0 = before.concat(after), l1 = after.concat(before);
            if (l1.length > 1 && l1.every(function (r, i) { return r === l0[i]; })) { var t = l1[0]; l1[0] = l1[1]; l1[1] = t; }
            init = [l0, l1];
          }
          for (var l = 0; l < init.length; l++) lists[l] = modify(init[l], sh.mods[l], sh.count[l], h.frameNum, maxFrameNum, refs);
        }
        frame.slices.push({ head: sh, nal: slices[k], lists: lists.map(function (L) { return L.map(function (r) { return r ? r.frame : null; }); }) });
      });
      // Reference marking after the frame (8.2.5): IDR, sliding window or the frame's own MMCOs.
      if (frame.ref) {
        if (h.mmco) h.mmco.forEach(function (m) {
          if (m[0] === 1) {
            var pn = h.frameNum - (m[1] + 1);
            refs = refs.filter(function (r) { return r.picNum !== pn; });
          } else throw new Error('MMCO ' + m[0] + ' not handled');   // 5 resets frame_num/POC too: not supported
        });
        else if (!frame.idr && refs.length >= Math.max(1, sps.refFrames)) {
          var oldest = refs.reduce(function (a, b) { return b.picNum < a.picNum ? b : a; });
          refs = refs.filter(function (r) { return r !== oldest; });
        }
        refs.push({ frame: frame, frameNum: h.frameNum, poc: poc });
        prev = { msb: msb, lsb: h.pocLsb, frameNum: h.frameNum };
      }
      frames.push(frame);
    });
    // Display index from the PTS (frame duration: the smallest step between them), else from the POC.
    var sorted = frames.map(function (f) { return f.pts; }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
    var dur = Infinity;
    for (var i = 1; i < sorted.length; i++) if (sorted[i] > sorted[i - 1]) dur = Math.min(dur, sorted[i] - sorted[i - 1]);
    var step = frames.reduce(function (g, f) { var a = Math.abs(f.poc), b = g; while (b) { var t = a % b; a = b; b = t; } return a; }, 0) || 1;
    if (sorted.length === frames.length && dur !== Infinity) frames.forEach(function (f) { f.T = Math.round((f.pts - sorted[0]) / dur); });
    else frames.forEach(function (f) { f.T = f.poc / step; });
    return { frames: frames, sps: sps, pps: pps, pocStep: step, frameDur: dur, firstPts: sorted[0] };
  }

  // 8.2.4.3.1: list modification of short-term references (long-term ones are not handled).
  function modify(init, mods, count, currPicNum, maxPicNum, refs) {
    var list = init.slice(0, count);
    while (list.length < count) list.push(null);
    var pred = currPicNum, idx = 0;
    mods.forEach(function (m) {
      if (m[0] === 2) throw new Error('long-term references not handled');
      var noWrap = m[0] === 0 ? pred - (m[1] + 1) : pred + (m[1] + 1);
      if (noWrap < 0) noWrap += maxPicNum;
      if (noWrap >= maxPicNum) noWrap -= maxPicNum;
      pred = noWrap;
      var pn = noWrap > currPicNum ? noWrap - maxPicNum : noWrap;
      var pic = refs.filter(function (r) { return r.picNum === pn; })[0] || null;
      list.splice(idx, 0, pic);
      idx++;
      for (var c = idx; c < list.length; c++) if (list[c] === pic) { list.splice(c, 1); c--; }
      list.length = Math.max(list.length, count);
      list = list.slice(0, count);
    });
    return list;
  }

  function implicitWeight(tb, td) {
    var clip = function (a, b, x) { return Math.max(a, Math.min(b, x)); };
    tb = clip(-128, 127, tb); td = clip(-128, 127, td);
    if (td === 0) return { w: 32, dsf: 0 };
    var tx = ((16384 + Math.abs((td / 2) | 0)) / td) | 0, dsf = clip(-1024, 1023, (tb * tx + 32) >> 6);
    return { w: (dsf >> 2) < -64 || (dsf >> 2) > 128 ? 32 : dsf >> 2, dsf: dsf };
  }
  // Which pictures each picture uses (its slices' references), and from that: reference status,
  // the MMCOs that drop pictures once their last user is decoded, and the DPB sizes needed.
  function lifetimes(pics) {
    var last = pics.map(function (p, i) { return i === 0 ? 0 : -1; });
    pics.forEach(function (p, j) {
      p.uses = [];
      p.regions[0].real.slices.forEach(function (s) {
        s.lists.forEach(function (L) { L.forEach(function (fr) { if (fr) p.uses.push(fr.pic); }); });
      });
      p.uses.forEach(function (u) { last[u] = Math.max(last[u], j); });
    });
    var marked = [], peak = 0, frameNum = 0;
    pics.forEach(function (p, j) {
      p.ref = j === 0 || last[j] > j;
      p.frameNum = frameNum;
      p.mmco = [];
      if (p.ref) {
        // After this picture: drop every marked picture whose last user is this one or earlier.
        marked = marked.filter(function (m) {
          if (last[m] <= j) { p.mmco.push(m); return false; }
          return true;
        });
        marked.push(j);
        frameNum++;
      }
      peak = Math.max(peak, marked.length);
      p.marked = marked.slice();
    });
    return { peakRefs: peak };
  }

  // Pictures held at once (C.4.5.3): reference pictures plus decoded pictures still waiting for output, outputting the
  // smallest POC first whenever more than `reorder` wait. `marks[j]`: the pictures still marked as reference after
  // picture j.
  function dpbPeak(pics, reorder, marks) {
    var waiting = [], peak = 0;
    pics.forEach(function (p, j) {
      waiting.push(j);
      while (waiting.length > reorder) {
        var best = 0;
        for (var i = 1; i < waiting.length; i++) if (pics[waiting[i]].poc < pics[waiting[best]].poc) best = i;
        waiting.splice(best, 1);
      }
      var held = {};
      waiting.forEach(function (w) { held[w] = true; });
      marks[j].forEach(function (m) { held[m] = true; });
      peak = Math.max(peak, Object.keys(held).length);
    });
    return peak;
  }

  // Reordering depth: the most pictures that precede one in decode order and follow it in output (POC) order.
  function reorderDepth(pics) {
    var depth = 0;
    pics.forEach(function (p, j) {
      var k = 0;
      for (var i = 0; i < j; i++) if (pics[i].poc > p.poc) k++;
      depth = Math.max(depth, k);
    });
    return depth;
  }

  // H.264 Table A-1 (level: [MaxMBPS, MaxFS, MaxDpbMbs]); a stream's DPB holds Min(MaxDpbMbs / frame MBs, 16) frames.
  var LEVELS = [[40, 245760, 8192, 32768], [41, 245760, 8192, 32768], [42, 522240, 8704, 34816], [50, 589824, 22080, 110400],
    [51, 983040, 36864, 184320], [52, 2073600, 36864, 184320]];
  // The fixed level of an interleaved stream: one feed's picture size, n feeds' pictures per second, DPB room for two
  // references per feed and the reordering (the same for every segment, so one SPS serves the stream).
  function interleaveLevel(widthMbs, heightMbs, feeds, fps) {
    var frameMbs = widthMbs * heightMbs, mbps = frameMbs * feeds * fps, dpb = Math.min(16, 2 * feeds + 1);
    for (var i = 0; i < LEVELS.length; i++) {
      var L = LEVELS[i];
      if (frameMbs <= L[2] && mbps <= L[1] && Math.min(16, Math.floor(L[3] / frameMbs)) >= dpb) return L[0];
    }
    return null;
  }
  function levelFor(frameMbs, mbps, needDpb) {
    for (var i = 0; i < LEVELS.length; i++) {
      var L = LEVELS[i], dpb = Math.min(16, Math.floor(L[3] / frameMbs));
      if (frameMbs <= L[2] && mbps <= L[1] && dpb >= needDpb) return { level: L[0], dpb: dpb, mbps: L[1] };
    }
    return null;
  }

  // ---------------------------------------------------------------- interleaving in time
  /*
   * The feeds' frames one after another in ONE stream, each picture a whole frame of one feed (no stacking): every feed
   * keeps its own picture edges, so nothing bleeds across feeds and each picture decodes exactly as in its own stream
   * (headers rewritten only: frame_num, POC, explicit reference lists, MMCOs). Feed k's frame at display time T gets
   * POC max(2, n) * T + k (implicit weights are checked per B slice). A renderer that gets every decoded picture (Samsung's EMSS video texture mode) puts each feed's latest
   * frame where the layout wants it: any layout from one hardware decoder. All feeds share one resolution.
   * Order: by display time, feed by feed, each feed's frames in their own decode order (a frame waits for the feed's
   * earlier ones in decode order).
   */
  function planInterleave(feeds, decodeOrder) {
    var n = feeds.length, scale = Math.max(2, n), next = feeds.map(function () { return 0; }), pics = [];
    if (decodeOrder && decodeOrder !== 'head' && decodeOrder !== 'unlock') throw new Error('decodeOrder: expected head or unlock');
    // 'unlock': prioritize the earliest not-yet-decoded display picture, decoding its future reference first when
    // required. Preserve every feed's decode chain. This lowers reordering for Big+3, but may increase live refs on
    // other workloads; still apply the usual reference/reorder/DPB checks to the resulting plan.
    var priority = feeds.map(function (f) {
      var out = [], min = Infinity;
      for (var i = f.frames.length - 1; i >= 0; i--) {
        min = Math.min(min, f.frames[i].T); out[i] = decodeOrder === 'unlock' ? min : f.frames[i].T;
      }
      return out;
    });
    feeds.forEach(function (f, k) {
      var tIdr = 0;
      f.frames.forEach(function (fr) {
        if (fr.idr) tIdr = fr.T;
        if (fr.poc !== 2 * (fr.T - tIdr)) throw new Error('interleave: feed ' + k + ' POC ' + fr.poc + ' at display index ' + fr.T + ' (needs 2 x the index since its IDR)');
      });
      if (f.frames[0].slices.some(function (sl) { return sl.head.sliceType !== 2; })) throw new Error('feeds must all start with an intra frame');
    });
    while (feeds.some(function (f, k) { return next[k] < f.frames.length; })) {
      var pick = -1;
      feeds.forEach(function (f, k) {
        if (next[k] >= f.frames.length) return;
        if (pick < 0 || priority[k][next[k]] < priority[pick][next[pick]]) pick = k;
      });
      var fr = feeds[pick].frames[next[pick]++];
      fr.pic = pics.length;
      pics.push({ T: fr.T, d: pick, feed: pick, regions: [{ real: fr }], complete: true, lanePoc: scale * fr.T + pick });
    }
    var mismatch = 0;
    feeds.forEach(function (f) {
      f.frames.forEach(function (fr) {
        fr.slices.forEach(function (sl) {
          if (sl.head.sliceType !== 1) return;
          (sl.lists[0] || []).forEach(function (r0) {
            (sl.lists[1] || []).forEach(function (r1) {
              if (!r0 || !r1) return;
              var a = implicitWeight(2 * (fr.T - r0.T), 2 * (r1.T - r0.T)), b = implicitWeight(scale * (fr.T - r0.T), scale * (r1.T - r0.T));
              if (a.w !== b.w || (!sl.head.directSpatial && a.dsf !== b.dsf)) mismatch++;
            });
          });
        });
      });
    });
    pics.mismatch = mismatch;
    return pics;
  }

  // Choose exactly `budget` pictures, retaining every reference. Dynamic programming minimizes squared distance
  // from an even presentation grid. A simple "keep every nth B" would cluster retained B pictures around scene cuts.
  // This only selects pictures; their original POC, timing and references remain intact.
  function budgetFrames(frames, budget) {
    var refs = frames.filter(function (f) { return f.ref; }).length;
    if (refs > budget) throw new Error('targetFps budget ' + budget + ' is below ' + refs + ' reference pictures');
    if (budget >= frames.length) return frames;
    var sorted = frames.slice().sort(function (a, b) { return a.T - b.T; }), N = sorted.length;
    var costs = [0], choices = [], i, j;
    for (j = 1; j <= budget; j++) costs[j] = Infinity;
    for (i = 0; i < N; i++) {
      var next = [], take = [];
      for (j = 0; j <= budget; j++) {
        var skipCost = sorted[i].ref ? Infinity : costs[j];
        var target = budget > 1 ? sorted[0].T + (sorted[N - 1].T - sorted[0].T) * (j - 1) / (budget - 1) : sorted[0].T;
        var delta = sorted[i].T - target, takeCost = j ? costs[j - 1] + delta * delta : Infinity;
        take[j] = takeCost < skipCost;
        next[j] = take[j] ? takeCost : skipCost;
      }
      choices.push(take); costs = next;
    }
    var keep = {}, count = budget;
    for (i = N - 1; i >= 0; i--) if (choices[i][count]) { keep[sorted[i].T] = true; count--; }
    if (count || !isFinite(costs[budget])) throw new Error('targetFps: no reference-safe selection');
    return frames.filter(function (f) { return keep[f.T]; });
  }

  // opts: { segment, fixedLevel, maxDpb, reorder, dropB, targetFps, feedTag, decodeOrder }.
  // Returns { aus, pictures, sps, info }; picture j's feed is pictures[j].feed. dropB[k] leaves out feed k's
  // non-reference frames (F1's B frames: nothing predicts from them, so the rest decodes the same).
  function interleaveSegment(feedAus, opts) {
    opts = opts || {};
    var feeds = feedAus.map(analyse), base = feeds[0];
    var segFrames = Math.max.apply(null, feeds.map(function (f) { return f.frames.length; }));
    var seconds = segFrames * (base.frameDur || 1800) / 90000;
    if (opts.targetFps && (!Array.isArray(opts.targetFps) || opts.targetFps.length !== feeds.length)) throw new Error('targetFps: one rate per feed required');
    feeds.forEach(function (f, k) { if (opts.dropB && opts.dropB[k]) f.frames = f.frames.filter(function (fr) { return fr.ref; }); });
    feeds.forEach(function (f, k) {
      if (!opts.targetFps || opts.targetFps[k] == null) return;
      var rate = opts.targetFps[k];
      if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0 || rate > 90000 / base.frameDur) throw new Error('targetFps: invalid rate for feed ' + k);
      f.frames = budgetFrames(f.frames, Math.floor(rate * seconds + 0.000001));
    });
    feeds.forEach(function (f, k) {
      if (f.sps.widthMbs !== base.sps.widthMbs || f.sps.heightMbs !== base.sps.heightMbs) throw new Error('feed ' + k + ': other size');
      if (f.sps.raw && base.sps.raw && f.sps.direct8x8 !== base.sps.direct8x8) throw new Error('feed ' + k + ': direct_8x8_inference differs');
      ['initQpMinus26', 'chromaQpOffset', 'weighted', 'bipred', 'constrainedIntra', 'l0', 'l1'].forEach(function (key) {
        if (f.pps[key] !== base.pps[key]) throw new Error('feed ' + k + ': PPS ' + key + ' differs');
      });
      if (f.frameDur !== base.frameDur) throw new Error('feed ' + k + ': other frame rate');
      ['vuiAspect', 'vuiOverscan', 'videoSignal', 'chromaLoc'].forEach(function (key) {
        if (JSON.stringify(f.sps[key]) !== JSON.stringify(base.sps[key])) throw new Error('feed ' + k + ': VUI ' + key + ' differs');
      });
      if (Math.abs(f.firstPts - base.firstPts) >= base.frameDur / 2) throw new Error('feed ' + k + ': segment starts at another time');
    });
    var pics = planInterleave(feeds, opts.decodeOrder), life = lifetimes(pics), n = feeds.length;
    pics.forEach(function (p) { p.poc = p.lanePoc; });
    var W = base.sps.widthMbs, H = base.sps.heightMbs, tagRows = opts.feedTag ? 1 : 0, frameMbs = W * (H + tagRows);
    var mbps = frameMbs * pics.length / seconds, lv;
    if (opts.fixedLevel) {
      var L = LEVELS.filter(function (x) { return x[0] === opts.fixedLevel; })[0];
      if (!L) throw new Error('unknown level ' + opts.fixedLevel);
      lv = { level: L[0], dpb: Math.min(16, Math.floor(L[3] / frameMbs)), mbps: L[1] };
    } else lv = levelFor(frameMbs, mbps, life.peakRefs);
    if (!lv) throw new Error('no H.264 level fits ' + frameMbs + ' MBs x ' + Math.round(pics.length / seconds) + ' pictures/s');
    if (opts.maxDpb && lv.dpb > opts.maxDpb) lv = { level: lv.level, dpb: opts.maxDpb, mbps: lv.mbps };
    if (life.peakRefs > lv.dpb) throw new Error('needs ' + life.peakRefs + ' reference pictures (' + lv.dpb + ' allowed)');
    var needed = reorderDepth(pics), reorder = Math.min(opts.reorder != null ? opts.reorder : Math.max(needed, 2 * n), lv.dpb);
    if (needed > reorder) throw new Error('this segment reorders ' + needed + ' pictures deep (SPS says ' + reorder + ')');
    var sps = { profile: base.sps.profile, constraints: base.sps.constraints, level: Math.max(opts.level || 0, lv.level), log2FrameNum: 16, log2PocLsb: 16,
      frameDur: isFinite(base.frameDur) && base.frameDur > 0 ? base.frameDur : 1800, refFrames: lv.dpb, widthMbs: W, heightMbs: H + tagRows,
      vuiAspect: base.sps.vuiAspect, vuiOverscan: base.sps.vuiOverscan, videoSignal: base.sps.videoSignal, chromaLoc: base.sps.chromaLoc, direct8x8: base.sps.direct8x8, reorder: reorder, dpb: lv.dpb };
    var dpb = dpbPeak(pics, sps.reorder, pics.map(function (p) { return p.marked; }));
    if (dpb > sps.dpb) throw new Error('needs ' + dpb + ' pictures in the DPB at once (' + sps.dpb + ' allowed)');
    var pps = { l0: base.pps.l0, l1: base.pps.l1, weighted: base.pps.weighted, bipred: base.pps.bipred, initQpMinus26: base.pps.initQpMinus26,
      initQsMinus26: base.pps.initQsMinus26, chromaQpOffset: base.pps.chromaQpOffset, constrainedIntra: base.pps.constrainedIntra };
    var spsNal = nalBytes(7, 3, writeSps(sps)), ppsNal = nalBytes(8, 3, writePps(pps)), idr = (opts.segment || 0) & 0xffff;
    var tagValues = [32, 96, 160, 224];
    if (tagRows && n > tagValues.length) throw new Error('feedTag: at most four feeds');
    var aus = pics.map(function (p, j) {
      var nalType = j === 0 ? 5 : 1, refIdc = p.ref ? (j === 0 ? 3 : 2) : 0, out = j === 0 ? [spsNal, ppsNal] : [];
      var common = { frameNum: p.frameNum, poc: p.poc, idr: idr, nalType: nalType, refIdc: refIdc, currPicNum: p.frameNum,
        mmco: p.mmco.map(function (m) { return [1, p.frameNum - pics[m].frameNum - 1]; }) };
      p.regions[0].real.slices.forEach(function (s) {
        var h = s.head;
        var lists = s.lists.slice(0, h.sliceType === 1 ? 2 : h.sliceType === 0 ? 1 : 0).map(function (L) {
          var spare = p.uses.filter(function (u) { return pics[u].ref; });
          return L.map(function (fr, i) {
            if (fr) return pics[fr.pic].frameNum;
            var alt = spare.filter(function (u) { return L.every(function (x) { return !x || x.pic !== u; }); })[i % Math.max(1, spare.length)];
            if (alt === undefined) {
              // An entry the original list left empty and nothing else is live: any marked picture will do (never used).
              alt = j > 0 ? pics[j - 1].marked[0] : undefined;
              if (alt === undefined) throw new Error('no spare reference for an unused list entry');
            }
            return pics[alt].frameNum;
          });
        });
        var head = writeSliceHeader(Object.assign({}, common, { firstMb: h.firstMb, sliceType: h.sliceType, directSpatial: h.directSpatial,
          lists: lists, weights: h.weights, noOutput: 0, cabacInit: h.cabacInit, qpDelta: h.qpDelta,
          deblock: h.deblock, alpha: h.alpha, beta: h.beta }), sps);
        out.push(spliceNal(nalType, refIdc, head, s.nal, h.dataStart));
      });
      if (tagRows) {
        // Experimental in-band identity. The renderer samples the first MB of an extra coded row on the GPU.
        // No new picture or long-lived reference. The remaining row stays gray via a reference already live before
        // this picture's marking. CAUTION: extending the bottom edge changes motion prediction near that edge.
        var src = j ? pics[j - 1].marked[0] : undefined, intra = src === undefined;
        var th = writeSliceHeader(Object.assign({}, common, { firstMb: H * W, sliceType: intra ? 2 : 0,
          lists: intra ? [] : [[pics[src].frameNum]], weights: !intra && pps.weighted ? [1, 1, 0, 0] : null,
          cabacInit: 0, qpDelta: 0, deblock: 1 }), sps);
        out.push(nalBytes(nalType, refIdc, concat([th, feedTagData(W, tagValues[p.feed], 26 + pps.initQpMinus26, intra)])));
      }
      return concat(out);
    });
    return { aus: aus, pictures: pics, sps: sps, interleaved: n, info: { pictures: pics.length, frames: feeds.map(function (f) { return f.frames.length; }),
      peakRefs: life.peakRefs, dpbPeak: dpb, reorder: needed, level: sps.level, picturesPerSecond: Math.round(pics.length / seconds),
      mbps: Math.round(mbps), overLevel: mbps > lv.mbps, interleaved: n, mismatch: pics.mismatch,
      feedTag: tagRows ? { row: H * 16, rows: 16, values: tagValues.slice(0, n) } : null } };
  }

  // Sample timing for interleaved fMP4 packaging, in 90 kHz ticks. Each feed's picture is offset within its frame.
  // With spread, pictures in display order sit on an even grid across the segment. Grid points are multiples of
  // 8 ticks plus the feed number, so PTS modulo 8 identifies the feed. Durations tile the presentation timeline;
  // decode times add those durations in decode order.
  function samples(st, o) {
    var pics = st.pictures, n = pics.length, segDur = o.frames * o.frameDur;
    var pts = pics.map(function (p) { return o.start + p.T * o.frameDur + Math.round(p.d * (o.frameDur / st.interleaved)) + o.delay; });
    if (o.spread) {
      if (st.interleaved > 8) throw new Error('spread: at most 8 feeds');
      var step = segDur / n;
      var shown = pts.map(function (t, j) { return j; }).sort(function (a, b) { return pts[a] - pts[b]; });
      shown.forEach(function (j, i) { pts[j] = Math.floor((o.start + o.delay + i * step) / 8) * 8 + pics[j].feed; });
    }
    var order = pts.map(function (t, j) { return j; }).sort(function (a, b) { return pts[a] - pts[b]; });
    var dur = [];
    order.forEach(function (j, i) { dur[j] = (i + 1 < n ? pts[order[i + 1]] : o.start + segDur + o.delay) - pts[j]; });
    var dts = [];
    for (var j = 0, t = o.start; j < n; j++) { dts.push(t); t += dur[j]; }
    return pics.map(function (p, j) {
      if (dts[j] > pts[j]) throw new Error('picture ' + j + ' would decode after it shows: raise the delay');
      if (!(dur[j] > 0)) throw new Error('picture ' + j + ' gets no presentation time');
      return { data: st.aus[j], duration: dur[j], cto: pts[j] - dts[j], sync: j === 0 };
    });
  }

  return { tables: tables, interleaveSegment: interleaveSegment, interleaveLevel: interleaveLevel, samples: samples, analyse: analyse, nals: nals, parseSps: parseSps, parsePps: parsePps,
    Reader: Reader, Writer: Writer, escape: escape, unescape: unescape, concat: concat };
});
