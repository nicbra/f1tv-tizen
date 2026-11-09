/*
 * StitchX: several H.264 feeds stacked into one picture by rewriting slice headers only, also when the feeds are NOT
 * encoded in lockstep (frame types, decode order and references differ per feed, as F1's 2018-2024 replays do).
 *
 * How: every feed's slices are copied unchanged into a region (full width, regions stacked); only headers change.
 * - Stitched pictures are issued in display-time order of the feeds' next frames: a picture carries the REAL slices
 *   of the feeds whose next frame (in their own decode order) is due at that display time T, and COPY slices (all
 *   P_Skip from one chosen reference picture: an exact copy) for the others. The last picture issued for each T is
 *   "complete": every region shows its feed at T (copied from where that frame was decoded).
 * - Each REAL slice gets an explicit reference list (ref_pic_list_modification) pointing every original reference at
 *   the stitched picture where that frame was decoded; reference marking is explicit (MMCO), so each picture stays
 *   exactly as long as a later slice or copy needs it.
 * - POC = 2T + d (d: the extra pictures at the same T), so implicit weighted bi-prediction and temporal direct see
 *   the original POC distances in the common case (d = 0).
 * Segments start with an IDR frame in every feed: each segment is planned on its own.
 *
 * StitchX.stitchSegment(feeds, opts) -> { aus: [Uint8Array Annex B access units], pictures: plan, sps, info }
 *   feeds[f]: the feed's access units of one segment in decode order, as TsDemux gives them: [{ data (Annex B), pts }].
 *   Display times come from the PTS (the feeds share one clock; POC restarts at every IDR, PTS doesn't).
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
    // Slice groups (FMO, map type 2: rectangles; the last group is what they leave). Baseline-only in the standard: an
    // experiment for decoders that take it anyway (opts.fmo).
    if (p.groups && p.groups.length) {
      w.ue(p.groups.length); w.ue(2);
      p.groups.forEach(function (g) { w.ue(g[0]); w.ue(g[1]); });
    } else w.ue(0);
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

  // ---------------------------------------------------------------- CABAC (copy slices: every macroblock P_Skip)
  var RANGE_LPS = null, TRANS_LPS = null, SKIP_INIT = null, INIT_I = null, INIT_PB = null;
  function tables(t) { RANGE_LPS = t.rangeTabLPS; TRANS_LPS = t.transIdxLPS; SKIP_INIT = t.skipInit; INIT_I = t.initI; INIT_PB = t.initPB; }

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
  // 9.3.4.4 EncodeBypass.
  Cabac.prototype.bypass = function (bin) {
    this.low <<= 1;
    if (bin) this.low += this.range;
    if (this.low >= 1024) { this.put(1); this.low -= 1024; }
    else if (this.low < 512) this.put(0);
    else { this.low -= 512; this.outstanding++; }
  };
  function context(mn, qp) {
    var pre = Math.max(1, Math.min(126, ((mn[0] * Math.max(0, Math.min(51, qp))) >> 4) + mn[1]));
    return pre <= 63 ? { state: 63 - pre, mps: 0 } : { state: pre - 64, mps: 1 };
  }
  // Slice data of `mbs` P_Skip macroblocks (P slice, cabac_init_idc 0, SliceQP qp): every mb_skip_flag has neighbours
  // that are unavailable or skipped, so ctxIdxInc is 0 (ctxIdx 11); end_of_slice_flag after each macroblock.
  var skipCache = {};
  function skipData(mbs, qp) {
    var key = mbs + '/' + qp;
    if (skipCache[key]) return skipCache[key];
    var c = new Cabac(), ctx = context(SKIP_INIT[0][0], qp);
    for (var i = 0; i < mbs; i++) { c.decision(ctx, 1); c.terminate(i === mbs - 1 ? 1 : 0); }
    return (skipCache[key] = c.w.bytes());
  }

  /*
   * The frame stamp (opts.stamp): slice data for the guard row under the regions. Macroblock 0 is I_PCM with luma
   * `value` (235: this picture is complete, 16: it is not) and chroma 128, so a renderer can tell complete pictures
   * from the ones in between (a shader reads one texel). The other macroblocks: P_Skip (P slice; they copy the gray
   * row) or, in the IDR picture (an I slice), I_PCM gray. CABAC (9.3): P slice with cabac_init_idc 0; the row above
   * is another slice, so neighbour B is unavailable; I_PCM = mb_type bin then the terminate bin 1, which flushes and
   * byte-aligns the engine (pcm_alignment_zero_bits), then the samples, then the engine starts afresh (9.3.1.2).
   */
  var stampCache = {};
  // width: macroblocks per row when the slice spans several rows (intra only: mb_type's context counts the neighbour
  // above too).
  function stampData(mbs, value, qp, intra, width) {
    width = width || mbs;
    var key = mbs + '/' + value + '/' + qp + '/' + (intra ? 'I' : 'P') + '/' + width;
    if (stampCache[key]) return stampCache[key];
    var c = new Cabac(), init = intra ? INIT_I : INIT_PB[0];
    var ctx = function (i) { return context(init[i], qp); };
    var skip = [ctx(11), ctx(12)], intraInP = ctx(14), notNxN = ctx(17), iType = [ctx(3), ctx(4), ctx(5)];
    function pcm(luma) {
      c.terminate(1);
      for (var i = 0; i < 256; i++) c.w.u(8, luma);
      for (i = 0; i < 128; i++) c.w.u(8, 128);
      c.low = 0; c.range = 510; c.first = true; c.outstanding = 0;
    }
    for (var m = 0; m < mbs; m++) {
      if (intra) {
        c.decision(iType[(m % width ? 1 : 0) + (m >= width ? 1 : 0)], 1);   // mb_type bin 0 (ctxIdx 3 + condTermFlagA + B: I_PCM neighbours count)
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
    return (stampCache[key] = c.w.bytes());
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

  /*
   * Slice data for an edge picture (opts.edges): a P slice (cabac_init_idc 0, SliceQP qp, two active L0 references)
   * covering whole macroblock rows from firstMb, every macroblock one of
   *   { t: 'copy' }               P_L0_16x16, ref_idx 1, motion (0, 0), no residual (a copy that B frames' spatial direct
   *                               prediction sees as non-zero-reference, see insertEdges)
   *   { t: 'mv', ref, mv: [x, y] } P_L0_16x16, motion in quarter samples, no residual
   *   { t: 'vert' }               I_16x16, vertical prediction (repeats the row above), chroma vertical, no residual
   * Context selection per 9.3.3.1.1 with the neighbours A (left) and B (above) inside the slice.
   */
  function edgeSliceData(desc, width, firstMb, qp) {
    var c = new Cabac(), ctxs = {};
    var ctx = function (i) { return ctxs[i] || (ctxs[i] = context(INIT_PB[0][i], qp)); };
    var info = [];   // per macroblock of the slice: { intra, ref, mv, mvd: [|x|, |y|] }
    var at = function (m, dx, dy) {   // neighbour in the slice, or null
      var a = firstMb + m, col = a % width, n = a + dx + dy * width;
      if (col + dx < 0 || col + dx >= width || n < firstMb || n >= a) return null;
      return info[n - firstMb] || null;
    };
    function mvPred(m, ref) {
      var A = at(m, -1, 0), B = at(m, 0, -1), C = at(m, 1, -1) || at(m, -1, -1);
      var geoB = B !== null, geoC = C !== null;
      var pick = function (N) { return N && !N.intra ? { ref: N.ref, mv: N.mv } : { ref: -1, mv: [0, 0] }; };
      var a = pick(A), b = pick(B), cc = pick(C);
      if (!geoB && !geoC && A) { b = a; cc = a; }
      var same = [a, b, cc].filter(function (x) { return x.ref === ref; });
      if (same.length === 1) return same[0].mv.slice();
      var med = function (x, y, z) { return Math.max(Math.min(x, y), Math.min(Math.max(x, y), z)); };
      return [med(a.mv[0], b.mv[0], cc.mv[0]), med(a.mv[1], b.mv[1], cc.mv[1])];
    }
    function mvdComp(v, base, sum) {
      var abs = Math.abs(v);
      var inc = sum < 3 ? 0 : sum > 32 ? 2 : 1;
      for (var b = 0; b < Math.min(abs, 9) + (abs < 9 ? 1 : 0); b++) {
        var bin = b < Math.min(abs, 9) ? 1 : 0;
        c.decision(ctx(base + (b === 0 ? inc : Math.min(b + 2, 6))), bin);
      }
      if (abs >= 9) {   // EG3 suffix
        var s = abs - 9, k = 3;
        while (s >= (1 << k)) { c.bypass(1); s -= (1 << k); k++; }
        c.bypass(0);
        while (k--) c.bypass((s >> k) & 1);
      }
      if (abs) c.bypass(v < 0 ? 1 : 0);
    }
    desc.forEach(function (d, m) {
      var A = at(m, -1, 0), B = at(m, 0, -1);
      c.decision(ctx(11 + (A ? 1 : 0) + (B ? 1 : 0)), 0);   // mb_skip_flag 0 (no neighbour is skipped)
      if (d.t === 'vert') {
        c.decision(ctx(14), 1);                 // mb_type prefix: intra
        c.decision(ctx(17), 1);                 // not I_NxN
        c.terminate(0);                         // not I_PCM
        c.decision(ctx(18), 0);                 // luma cbp 0
        c.decision(ctx(19), 0);                 // chroma cbp 0
        c.decision(ctx(20), 0); c.decision(ctx(20), 0);   // Intra16x16PredMode 0: vertical
        // intra_chroma_pred_mode 2 (vertical): TU 1 1 0
        var chromaInc = (A && A.intra && A.chroma ? 1 : 0) + (B && B.intra && B.chroma ? 1 : 0);
        c.decision(ctx(64 + chromaInc), 1); c.decision(ctx(67), 1); c.decision(ctx(67), 0);
        c.decision(ctx(60), 0);                 // mb_qp_delta 0 (the previous macroblock had none)
        // Intra16x16DCLevel coded_block_flag 0: an unavailable neighbour counts 1 for an intra macroblock, an inter one 0,
        // an I_16x16 one its own flag (0).
        var cbf = (A ? 0 : 1) + 2 * (B ? 0 : 1);
        c.decision(ctx(85 + cbf), 0);
        info[m] = { intra: true, chroma: 2, ref: -1, mv: [0, 0], mvd: [0, 0] };
      } else {
        var ref = d.t === 'copy' ? 1 : d.ref, mv = d.t === 'copy' ? [0, 0] : d.mv;
        c.decision(ctx(14), 0); c.decision(ctx(15), 0); c.decision(ctx(16), 0);   // P_L0_16x16
        // ref_idx_l0 (unary): bin 0 counts neighbours with ref_idx > 0
        var refInc = (A && !A.intra && A.ref > 0 ? 1 : 0) + 2 * (B && !B.intra && B.ref > 0 ? 1 : 0);
        for (var r = 0; r <= ref; r++) c.decision(ctx(54 + (r === 0 ? refInc : r === 1 ? 4 : 5)), r < ref ? 1 : 0);
        var p = mvPred(m, ref), mvd = [mv[0] - p[0], mv[1] - p[1]];
        mvdComp(mvd[0], 40, (A ? A.mvd[0] : 0) + (B ? B.mvd[0] : 0));
        mvdComp(mvd[1], 47, (A ? A.mvd[1] : 0) + (B ? B.mvd[1] : 0));
        // coded_block_pattern 0: luma bins see a neighbour 8x8 block as 1 when it is available (none has coefficients),
        // chroma bin 0 sees 0 for every neighbour (no chroma coefficients anywhere).
        var a = A ? 1 : 0, b = B ? 1 : 0;
        c.decision(ctx(73 + a + 2 * b), 0);   // block 0: left MB, upper MB
        c.decision(ctx(73 + 1 + 2 * b), 0);   // block 1: block 0, upper MB
        c.decision(ctx(73 + a + 2), 0);       // block 2: left MB, block 0
        c.decision(ctx(73 + 3), 0);           // block 3: block 2, block 1
        c.decision(ctx(77), 0);               // chroma: none
        info[m] = { intra: false, ref: ref, mv: mv, mvd: [Math.abs(mvd[0]), Math.abs(mvd[1])] };
      }
      c.terminate(m === desc.length - 1 ? 1 : 0);
    });
    return c.w.bytes();
  }

  // ---------------------------------------------------------------- the plan
  /*
   * Stitched pictures for one segment. Each: { T, d, regions: [{ real: frame } | { copy: pictureIndex }], complete }.
   * Greedy: the earliest display time among the feeds' next frames (in their own decode order) goes next.
   */
  function plan(feeds, group) {
    var n = feeds.length, next = feeds.map(function () { return 0; }), at = feeds.map(function () { return {}; });
    var pics = [], perT = {};
    function left() { return feeds.some(function (f, k) { return next[k] < f.frames.length; }); }
    while (left()) {
      // The next display time: the earliest among the feeds' next frames, or (opts.group) the one most feeds are ready
      // for (fewer pictures when feeds diverge), earliest on a tie.
      var T = Infinity, votes = {};
      feeds.forEach(function (f, k) { if (next[k] < f.frames.length) { var t = f.frames[next[k]].T; T = Math.min(T, t); votes[t] = (votes[t] || 0) + 1; } });
      if (group) Object.keys(votes).forEach(function (t) { t = +t; if (votes[t] > votes[T] || (votes[t] === votes[T] && t < T)) T = t; });
      var pic = { T: T, d: perT[T] = (perT[T] === undefined ? 0 : perT[T] + 1), regions: [] };
      feeds.forEach(function (f, k) {
        var fr = next[k] < f.frames.length ? f.frames[next[k]] : null;
        if (fr && fr.T === T) { pic.regions[k] = { real: fr }; fr.pic = pics.length; at[k][T] = pics.length; next[k]++; }
      });
      feeds.forEach(function (f, k) {
        if (pic.regions[k]) return;
        // This feed's frame at T, if decoded already; else whatever the previous picture shows there.
        pic.regions[k] = { copy: at[k][T] !== undefined ? at[k][T] : pics.length - 1 };
      });
      // The first picture becomes the IDR picture: every feed must start with an intra frame (IDR, or an I frame).
      if (pics.length === 0 && pic.regions.some(function (r) { return !r.real || r.real.slices.some(function (s) { return s.head.sliceType !== 2; }); })) throw new Error('feeds must all start with an intra frame');
      pic.complete = feeds.every(function (f, k) { return at[k][T] !== undefined; });
      pics.push(pic);
    }
    return pics;
  }

  /*
   * opts.lanes: a lane is a group of feeds whose frames come in the same order (display indices in decode order) all
   * through the segment; each picture carries one lane's frames, and lane k of n gets POC nT + k (2T + k for one or two
   * lanes). POCs stay unique (H.264 8.2.1) and each feed's POC distances are its original ones (2 per frame) times
   * n/2: for one or two lanes the original exactly; for more, H.264's implicit weights (DistScaleFactor >> 2) still come
   * out the same for every pair of references within ~10 frames (checked per B slice: info.lanesMismatch counts
   * reference pairs whose weights or temporal-direct scaling would change; 0 = exact). The last lane's frame T waits
   * until every other lane's frame T is in, so its picture, shown last at T, is complete; the others are shown for 1 ms.
   * The IDR picture holds all first frames; copies of it (POC 1 .. n-1) stand in for the other lanes' first frames.
   */
  function implicitWeight(tb, td) {
    var clip = function (a, b, x) { return Math.max(a, Math.min(b, x)); };
    tb = clip(-128, 127, tb); td = clip(-128, 127, td);
    if (td === 0) return { w: 32, dsf: 0 };
    var tx = ((16384 + Math.abs((td / 2) | 0)) / td) | 0, dsf = clip(-1024, 1023, (tb * tx + 32) >> 6);
    return { w: (dsf >> 2) < -64 || (dsf >> 2) > 128 ? 32 : dsf >> 2, dsf: dsf };
  }
  function planLanes(feeds) {
    var n = feeds.length;
    // POC 2T: the original distances when a feed's POC is 2 x its display index since its last IDR (x264, and F1 as far
    // as seen); a B slice and its references are always inside one IDR period.
    feeds.forEach(function (f, k) {
      var tIdr = 0;
      f.frames.forEach(function (fr) {
        if (fr.idr) tIdr = fr.T;
        if (fr.poc !== 2 * (fr.T - tIdr)) throw new Error('lanes: feed ' + k + ' POC ' + fr.poc + ' at display index ' + fr.T + ' (needs 2 x the index since its IDR)');
      });
      if (f.frames[0].T !== 0) throw new Error('lanes: feed ' + k + ' does not start with its first frame shown');
      if (f.frames[0].slices.some(function (sl) { return sl.head.sliceType !== 2; })) throw new Error('feeds must all start with an intra frame');
    });
    // Lanes are groups of feeds whose frames come in the same order (display indices in decode order) all through the
    // segment: such feeds share their pictures (F1's feeds often match; one picture per display time when all do).
    var groups = [], laneOf = [];
    feeds.forEach(function (f, k) {
      var sig = f.frames.map(function (fr) { return fr.T; }).join(',');
      var g = groups.filter(function (x) { return x.sig === sig; })[0];
      if (!g) { g = { sig: sig, feeds: [] }; groups.push(g); }
      g.feeds.push(k); laneOf[k] = groups.indexOf(g);
    });
    var G = groups.length, scale = Math.max(2, G), lastLane = G - 1;
    var at = feeds.map(function () { return {}; }), next = groups.map(function () { return 1; }), pics = [];
    pics.push({ T: 0, d: 0, regions: feeds.map(function (f) { return { real: f.frames[0] }; }), complete: true, lanePoc: 0 });
    feeds.forEach(function (f, k) { f.frames[0].pic = 0; at[k][0] = 0; });
    for (var l = 1; l < G; l++) {
      pics.push({ T: 0, d: l, regions: feeds.map(function () { return { copy: 0 }; }), complete: true, lanePoc: l });
      groups[l].feeds.forEach(function (k) { feeds[k].frames[0].pic = l; at[k][0] = l; });
    }
    groups.forEach(function (g) { g.count = feeds[g.feeds[0]].frames.length; });
    // A B slice's colocated picture (RefPicList1[0], for direct prediction) must hold its feed's own macroblocks: the
    // copy pictures that stand in for lanes' first frames don't (their P_Skip blocks would change spatial direct's
    // colZeroFlag and break temporal direct's reference mapping). Such a segment is planned the default way.
    feeds.forEach(function (f, k) {
      if (laneOf[k] === 0) return;
      f.frames.forEach(function (fr) {
        fr.slices.forEach(function (sl) {
          if (sl.head.sliceType === 1 && sl.lists[1] && sl.lists[1][0] === f.frames[0]) throw new Error('lanes: feed ' + k + ' predicts directly from its first frame');
        });
      });
    });
    function placed(k, T) { return at[k][T] !== undefined; }
    while (groups.some(function (g, l) { return next[l] < g.count; })) {
      // The earliest display time among the lanes' next frames that may go (the last lane's waits for the others' at T).
      var pick = -1;
      groups.forEach(function (g, l) {
        if (next[l] >= g.count) return;
        var T0 = feeds[g.feeds[0]].frames[next[l]].T;
        if (l === lastLane && !feeds.every(function (f, i) { return laneOf[i] === lastLane || placed(i, T0); })) return;
        if (pick < 0 || T0 < feeds[groups[pick].feeds[0]].frames[next[pick]].T) pick = l;
      });
      if (pick < 0) throw new Error('lanes: nothing can go next');
      var j = next[pick]++, T = feeds[groups[pick].feeds[0]].frames[j].T, pic = { T: T, d: pick, regions: [], lanePoc: scale * T + pick };
      groups[pick].feeds.forEach(function (k) { var fr = feeds[k].frames[j]; pic.regions[k] = { real: fr }; fr.pic = pics.length; at[k][T] = pics.length; });
      feeds.forEach(function (f, i) { if (laneOf[i] !== pick) pic.regions[i] = { copy: placed(i, T) ? at[i][T] : pics.length - 1 }; });
      pic.complete = feeds.every(function (f, i) { return placed(i, T); });
      pics.push(pic);
    }
    n = scale;   // the POC distance per frame, for the check below
    pics.lanes = G;
    // Exactness: every B slice's reference pairs, original distances (2 per frame) against the stitched ones (n per frame).
    var mismatch = 0;
    feeds.forEach(function (f) {
      f.frames.forEach(function (fr) {
        fr.slices.forEach(function (sl) {
          if (sl.head.sliceType !== 1) return;
          (sl.lists[0] || []).forEach(function (r0) {
            (sl.lists[1] || []).forEach(function (r1) {
              if (!r0 || !r1) return;
              var a = implicitWeight(2 * (fr.T - r0.T), 2 * (r1.T - r0.T)), b = implicitWeight(n * (fr.T - r0.T), n * (r1.T - r0.T));
              if (a.w !== b.w || (!sl.head.directSpatial && a.dsf !== b.dsf)) mismatch++;
            });
          });
        });
      });
    });
    pics.mismatch = mismatch;
    return pics;
  }

  /*
   * opts.edges: after every picture that later pictures use, an edge picture: a copy of it (motion 0) whose bands between
   * the regions repeat each region's edge rows, the way a decoder repeats a picture's edge for motion vectors that point
   * outside it (so regions stop bleeding into each other). Later pictures use the edge picture instead (references and
   * copies); its MMCO drops the original, so the DPB holds no more. POCs: see below (x4, B slices keep their distances). The copies
   * are P_L0_16x16 with ref_idx 1 (both list entries are the original): for B frames whose colocated picture is an edge
   * picture, spatial direct then never sees a "zero motion, reference 0" colocated block (colZeroFlag 0), which matches
   * the original wherever its colocated block moved; where it stood still the predicted motion is usually zero anyway.
   */
  function insertEdges(pics) {
    var used = pics.map(function () { return false; });
    pics.forEach(function (p, j) {
      p.regions.forEach(function (r) {
        if (r.copy !== undefined) used[r.copy] = true;
        else r.real.slices.forEach(function (s) { s.lists.forEach(function (L) { L.forEach(function (fr) { if (fr && fr.pic !== j) used[fr.pic] = true; }); }); });
      });
    });
    var out = [], newIndex = [], edgeIndex = [];
    pics.forEach(function (p, j) {
      newIndex[j] = out.length; out.push(p);
      if (used[j]) { edgeIndex[j] = out.length; out.push({ T: p.T, d: p.d + 0.5, regions: p.regions.map(function () { return {}; }), complete: p.complete, edgeOf: newIndex[j], basePoc: p.poc }); }
    });
    var target = function (j) { return edgeIndex[j] !== undefined ? edgeIndex[j] : newIndex[j]; };
    pics.forEach(function (p) {
      p.regions.forEach(function (r) {
        if (r.copy !== undefined) r.copy = target(r.copy);
        else { r.real.refPic = target(r.real.pic); r.real.pic = newIndex[r.real.pic]; }
      });
    });
    // POCs x4: originals 4p (4p + 2 with B slices), edge pictures 4p + 2 (4p + 3 after a picture with B slices). A B
    // slice's references are edge pictures of P/I pictures (4r + 2) and its own picture is 4c + 2: distances 4 x the
    // original ones; all POCs unique (base POCs are).
    var hasB = function (p) { return p.regions.some(function (r) { return r.real && r.real.slices.some(function (s) { return s.head.sliceType === 1; }); }); };
    out.forEach(function (p) { if (p.edgeOf === undefined) { p.hasB = hasB(p); p.poc = 4 * p.poc + (p.hasB ? 2 : 0); } });
    out.forEach(function (p) { if (p.edgeOf !== undefined) p.poc = 4 * p.basePoc + (out[p.edgeOf].hasB ? 3 : 2); });
    out.edges = edgeIndex.filter(function (x) { return x !== undefined; }).length;
    return out;
  }

  // Which pictures each picture uses (its slices' references and copy sources), and from that: reference status,
  // the MMCOs that drop pictures once their last user is decoded, and the DPB sizes needed.
  function lifetimes(pics) {
    var last = pics.map(function (p, i) { return i === 0 ? 0 : -1; });
    pics.forEach(function (p, j) {
      p.uses = [];
      if (p.edgeOf !== undefined) p.uses.push(p.edgeOf);
      else p.regions.forEach(function (r) {
        if (r.copy !== undefined) p.uses.push(r.copy);
        else r.real.slices.forEach(function (s) { s.lists.forEach(function (L) { L.forEach(function (fr) { if (fr) p.uses.push(fr.refPic !== undefined ? fr.refPic : fr.pic); }); }); });
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
  // smallest POC first (equal POCs in decode order: the complete picture of a display time comes out last) whenever
  // more than `reorder` wait. `marks[j]`: the pictures still marked as reference after picture j.
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
  /*
   * The level for a whole stitched stream (one SPS): the picture size, and at most one picture per feed and display
   * time (lanes: exactly that; the default plan: each picture carries a frame of that display time). 3 x 540p at 50
   * fps: 5.1; 4 x 540p, 3 x 720p or 2 x 1080p: 5.2. null if none fits.
   */
  function streamLevel(widthMbs, regionHeightMbs, feeds, fps, guardRows) {
    // ... and a DPB with room for the references and the reordering lanes need (~5 frames per feed, 16 at most).
    var frameMbs = widthMbs * (regionHeightMbs * feeds + (guardRows || 0)), mbps = frameMbs * feeds * fps, dpb = Math.min(16, 5 * feeds);
    for (var i = 0; i < LEVELS.length; i++) {
      var L = LEVELS[i];
      if (frameMbs <= L[2] && mbps <= L[1] && Math.min(16, Math.floor(L[3] / frameMbs)) >= dpb) return L[0];
    }
    return null;
  }
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

  // ---------------------------------------------------------------- one segment
  function stitchSegment(feedAus, opts) {
    opts = opts || {};
    if (!RANGE_LPS) throw new Error('StitchX.tables(cabac-tables.json) first');
    var feeds = feedAus.map(analyse), base = feeds[0];
    feeds.forEach(function (f, k) {
      if (f.sps.widthMbs !== base.sps.widthMbs || f.sps.heightMbs !== base.sps.heightMbs) throw new Error('feed ' + k + ': other size');
      ['initQpMinus26', 'chromaQpOffset', 'weighted', 'bipred', 'constrainedIntra'].forEach(function (key) {
        if (f.pps[key] !== base.pps[key]) throw new Error('feed ' + k + ': PPS ' + key + ' differs');
      });
      if (f.sps.direct8x8 !== base.sps.direct8x8) throw new Error('feed ' + k + ': direct_8x8_inference differs');
      if (f.frameDur !== base.frameDur) throw new Error('feed ' + k + ': other frame rate');
      ['vuiAspect', 'vuiOverscan', 'videoSignal', 'chromaLoc'].forEach(function (key) {
        if (JSON.stringify(f.sps[key]) !== JSON.stringify(base.sps[key])) throw new Error('feed ' + k + ': VUI ' + key + ' differs');
      });
      // F1's feeds share their PTS; a muxer may shift a feed by a fraction of a frame (our test feeds: audio priming).
      // Display times count from each feed's own first frame, so only a whole frame or more is a misaligned segment.
      if (Math.abs(f.firstPts - base.firstPts) >= base.frameDur / 2) throw new Error('feed ' + k + ': segment starts at another time');
    });
    var pics = null, life = null, fallback = null;
    // The DPB the stream's fixed level allows (16 frames at most), known before planning.
    var dpbFrames = 16, fixedL = opts.fixedLevel ? LEVELS.filter(function (x) { return x[0] === opts.fixedLevel; })[0] : null;
    // opts.gap: macroblock rows of gray between the regions (motion vectors that reach past a feed's edge read gray, not
    // the neighbouring feed; the app's black separators cover them). 0 = regions touch.
    // opts.edges: three rows per seam (the band under a region, a helper row, the band over the next region).
    // opts.edges: band rows on each side (true = 1): a band of that many rows under each region, a helper row, the same over the next.
    var bandRows = opts.edges ? (opts.edges === true ? 1 : Math.max(1, Math.min(4, +opts.edges))) : 0;
    var gapMbs = opts.edges ? 2 * bandRows + 1 : Math.max(0, Math.min(4, Math.floor(+opts.gap || 0))), extraRows = (opts.stamp ? 1 : 0) + gapMbs * (feeds.length - 1);
    if (fixedL) dpbFrames = Math.min(16, Math.floor(fixedL[3] / (base.sps.widthMbs * (base.sps.heightMbs * feeds.length + extraRows))));
    // opts.maxDpb: the decoder's own cap, below the level's. Samsung's 2021 TV (Tizen 6, MSE and AVPlay alike) refuses
    // or fails on H.264 above FHD-class sizes that declare more than 7 reference frames, whatever the level says.
    if (opts.maxDpb) dpbFrames = Math.min(dpbFrames, opts.maxDpb);
    // The stream's reordering depth (one SPS for all segments). Under a 7-picture cap with F1-like feeds (2 references,
    // IBBP): 2 feeds fit lanes (exact) with depth 4, 3 feeds fit the default plan with depth 3 (lanes then fall back).
    var reorderDepthCap = opts.reorder != null ? opts.reorder : opts.maxDpb ? (feeds.length <= 2 ? 4 : 3) : null;
    if (opts.lanes) {
      // Lanes where they fit (references and pictures waiting for output within the level's DPB; four diverging feeds
      // with 3 references each need ~20), else this segment is planned the default way (near-exact): one stream can
      // mix both.
      try {
        pics = planLanes(feeds); life = lifetimes(pics);
        if (life.peakRefs > dpbFrames) throw new Error('lanes need ' + life.peakRefs + ' reference pictures');
        pics.forEach(function (p) { p.poc = p.lanePoc; });
        var lanesReorder = Math.min(reorderDepthCap != null ? reorderDepthCap : 3 * feeds.length, dpbFrames);
        if (reorderDepth(pics) > lanesReorder) throw new Error('lanes reorder deeper than ' + lanesReorder);
        var lanesDpb = dpbPeak(pics, lanesReorder, pics.map(function (p) { return p.marked; }));
        if (lanesDpb > dpbFrames) throw new Error('lanes need ' + lanesDpb + ' pictures in the DPB (' + dpbFrames + ' at this level)');
      } catch (e) { fallback = String(e.message || e); pics = null; }
    }
    if (!pics) { pics = plan(feeds, opts.group); life = lifetimes(pics); }
    var lanesUsed = !!opts.lanes && !fallback;
    if (life.peakRefs > 16) throw new Error('needs ' + life.peakRefs + ' reference pictures at once (H.264 allows 16)');
    var maxD = pics.reduce(function (m, p) { return Math.max(m, p.d); }, 0), scale = maxD <= 1 ? 2 : 4;
    if (maxD > 3) throw new Error('more than 4 pictures for one display time');
    // POCs are unique (H.264 8.2.1): 2T + d, or 4T + d when a display time needs more than two pictures. B slices
    // then see POC distances x1 or x2 (+ d), which can change their implicit weights slightly; with B frames that
    // nothing references (F1), such an error stays in that frame. opts.samePoc (experiment, NOT conforming): every
    // picture of a display time gets the original 2T, exact in FFmpeg.
    pics.forEach(function (p) { p.poc = lanesUsed ? p.lanePoc : opts.samePoc ? 2 * p.T : scale * p.T + p.d; });
    var edgeCount = 0;
    if (opts.edges) {
      if (opts.fmo || opts.stamp) throw new Error('edges: not with fmo or stamp');
      if (base.pps.constrainedIntra) throw new Error('edges: constrained intra prediction (the bands predict from copies)');
      pics = insertEdges(pics); edgeCount = pics.edges; life = lifetimes(pics);
    }
    var W = base.sps.widthMbs, H = base.sps.heightMbs, n = feeds.length;
    // opts.fmo: { width, height (macroblocks), at: [[x, y] per region] }: each region a slice-group rectangle at (x, y)
    // instead of a full-width band; the regions must cover the picture, the last one taking what the others leave.
    var fmo = opts.fmo || null, PW = fmo ? fmo.width : W;
    function picMb(k, f) {
      if (!fmo) return k * (H + gapMbs) * W + f;
      var at = fmo.at[k]; return (at[1] + Math.floor(f / W)) * PW + at[0] + f % W;
    }
    // The level: picture size and pictures per second (a segment's pictures over its duration), DPB for the peak.
    var guard = opts.stamp ? 1 : 0, G = gapMbs, stride = H + G, frameMbs = fmo ? fmo.width * fmo.height : W * (H * n + G * (n - 1) + guard), seconds = base.frames.length * (base.frameDur || 1800) / 90000;
    var mbps = frameMbs * pics.length / seconds, lv;
    if (opts.fixedLevel) {
      // A stream of several segments has one SPS (an MP4 init segment): the level given, its DPB size, for every segment.
      var L = LEVELS.filter(function (x) { return x[0] === opts.fixedLevel; })[0];
      if (!L) throw new Error('unknown level ' + opts.fixedLevel);
      if (frameMbs > L[2]) throw new Error('the stack is larger than level ' + L[0] + ' allows');
      lv = { level: L[0], dpb: Math.min(16, Math.floor(L[3] / frameMbs)), mbps: L[1] };
      if (life.peakRefs > lv.dpb) throw new Error('needs ' + life.peakRefs + ' reference pictures (level ' + L[0] + ' allows ' + lv.dpb + ')');
      if (opts.edges && mbps > L[1]) throw new Error(Math.round(mbps) + ' macroblocks/s is more than level ' + L[0] + ' allows');
    } else lv = levelFor(frameMbs, mbps, life.peakRefs);
    if (!lv) throw new Error('no H.264 level fits ' + frameMbs + ' MBs x ' + Math.round(pics.length / seconds) + ' pictures/s');
    if (opts.maxDpb && lv.dpb > opts.maxDpb) {
      lv = { level: lv.level, dpb: opts.maxDpb, mbps: lv.mbps };
      if (life.peakRefs > lv.dpb) throw new Error('needs ' + life.peakRefs + ' reference pictures (the decoder takes ' + lv.dpb + ')');
    }
    var sps = { profile: base.sps.profile, constraints: base.sps.constraints, level: Math.max(opts.level || 0, lv.level), log2FrameNum: 16, log2PocLsb: 16,
      frameDur: isFinite(base.frameDur) && base.frameDur > 0 ? base.frameDur : 1800, refFrames: lv.dpb, widthMbs: fmo ? fmo.width : W, heightMbs: fmo ? fmo.height : H * n + G * (n - 1) + guard, vuiAspect: base.sps.vuiAspect, vuiOverscan: base.sps.vuiOverscan, videoSignal: base.sps.videoSignal, chromaLoc: base.sps.chromaLoc, direct8x8: base.sps.direct8x8, reorder: Math.min(reorderDepthCap != null ? reorderDepthCap : opts.lanes ? 3 * n : 4, lv.dpb), dpb: lv.dpb };
    // One SPS for the whole stream (an MP4 init segment carries the first): a fixed reordering depth, checked here.
    var needed = reorderDepth(pics);
    if (needed > sps.reorder) throw new Error('this segment reorders ' + needed + ' pictures deep (SPS says ' + sps.reorder + ')');
    var pps = { l0: base.pps.l0, l1: base.pps.l1, weighted: base.pps.weighted, bipred: base.pps.bipred, initQpMinus26: base.pps.initQpMinus26,
      initQsMinus26: base.pps.initQsMinus26, chromaQpOffset: base.pps.chromaQpOffset, constrainedIntra: base.pps.constrainedIntra,
      groups: fmo ? fmo.at.slice(0, n - 1).map(function (at) { return [at[1] * PW + at[0], (at[1] + H - 1) * PW + at[0] + W - 1]; }) : null };
    var dpb = dpbPeak(pics, sps.reorder, pics.map(function (p) { return p.marked; }));
    if (dpb > sps.dpb && !opts.noDpbCheck) throw new Error('needs ' + dpb + ' pictures in the DPB at once (' + sps.dpb + ' at level ' + sps.level + ')');
    var spsNal = nalBytes(7, 3, writeSps(sps)), ppsNal = nalBytes(8, 3, writePps(pps));
    var copyQp = 26 + pps.initQpMinus26, idr = (opts.segment || 0) & 0xffff;

    // An edge picture's macroblocks, row by row: regions copied; per seam the band under the region (vertical
    // prediction from its last row), a helper row whose motion puts the next region's first row in its last row
    // (17 rows down), and the band over the next region (vertical prediction from that row).
    var edgeData = null;
    function edgeDesc() {
      var desc = [];
      for (var row = 0; row < n * H + (n - 1) * G; row++) {
        var k = Math.floor(row / stride), within = row - k * stride, d;
        if (within < H) d = { t: 'copy' };
        else if (within - H === bandRows) d = { t: 'mv', ref: 1, mv: [0, 4 * (16 * (stride - within) - 15)] };
        else d = { t: 'vert' };
        for (var x = 0; x < W; x++) desc.push(d);
      }
      return desc;
    }
    var aus = pics.map(function (p, j) {
      var nalType = j === 0 ? 5 : 1, refIdc = p.ref ? (j === 0 ? 3 : 2) : 0, out = j === 0 ? [spsNal, ppsNal] : [];
      var common = { frameNum: p.frameNum, poc: p.poc, idr: idr, nalType: nalType, refIdc: refIdc, currPicNum: p.frameNum,
        mmco: p.mmco.map(function (m) { return [1, p.frameNum - pics[m].frameNum - 1]; }) };
      // The gaps: an I slice of gray I_PCM in the IDR picture, then P_Skip copies of the latest marked picture (gray
      // there). Each gap goes right after its region: Main profile needs slices in increasing macroblock order.
      if (p.edgeOf !== undefined) {
        // An edge picture: one slice over the whole picture (see edgeDesc), both list entries the original.
        var src = pics[p.edgeOf].frameNum;
        var eHead = writeSliceHeader(Object.assign({}, common, { firstMb: 0, sliceType: 0, lists: [[src, src]],
          weights: pps.weighted ? [1, 1, 0, 0, 0, 0] : null, cabacInit: 0, qpDelta: 0, deblock: 1 }), sps);
        out.push(nalBytes(1, refIdc, concat([eHead, edgeData || (edgeData = edgeSliceData(edgeDesc(), W, 0, copyQp))])));
        return concat(out);
      }
      var gsrc = j > 0 ? pics[j - 1].marked[pics[j - 1].marked.length - 1] : undefined, gIntra = gsrc === undefined, regionNals = [];
      p.regions.forEach(function (r, k) {
        var offset = k * stride * W;
        if (r.real) {
          r.real.slices.forEach(function (s) {
            var h = s.head;
            var lists = s.lists.slice(0, h.sliceType === 1 ? 2 : h.sliceType === 0 ? 1 : 0).map(function (L, l) {
              // Entries the original list left empty are never used: fill them with any other live picture.
              var spare = p.uses.filter(function (u) { return pics[u].ref; });
              return L.map(function (fr, i) {
                if (fr) return pics[fr.refPic !== undefined ? fr.refPic : fr.pic].frameNum;
                var alt = spare.filter(function (u) { return L.every(function (x) { return !x || (x.refPic !== undefined ? x.refPic : x.pic) !== u; }); })[i % Math.max(1, spare.length)];
                if (alt === undefined) throw new Error('no spare reference for an unused list entry');
                return pics[alt].frameNum;
              });
            });
            var head = writeSliceHeader(Object.assign({}, common, { firstMb: picMb(k, h.firstMb), sliceType: h.sliceType, directSpatial: h.directSpatial,
              lists: lists, weights: h.weights, noOutput: 0, cabacInit: h.cabacInit, qpDelta: h.qpDelta,
              deblock: h.deblock === 1 ? 1 : 2, alpha: h.alpha, beta: h.beta }), sps);
            regionNals.push([picMb(k, h.firstMb), spliceNal(nalType, refIdc, head, s.nal, h.dataStart)]);
          });
        } else {
          if (nalType === 5) throw new Error('an IDR picture can not copy');
          // With explicit weighted prediction on (PPS), a P slice must carry a weight table: denominators 0 and no
          // weights given means weight 1, offset 0, so the copy stays exact.
          var head = writeSliceHeader(Object.assign({}, common, { firstMb: picMb(k, 0), sliceType: 0, lists: [[pics[r.copy].frameNum]],
            weights: pps.weighted ? [1, 1, 0, 0] : null, cabacInit: 0, qpDelta: 0, deblock: 1 }), sps);
          regionNals.push([picMb(k, 0), nalBytes(1, refIdc, concat([head, skipData(W * H, copyQp)]))]);
        }
        if (G && k < n - 1) {
          var gHead = writeSliceHeader(Object.assign({}, common, { firstMb: (k * stride + H) * W, sliceType: gIntra ? 2 : 0,
            lists: gIntra ? [] : [[pics[gsrc].frameNum]], weights: !gIntra && pps.weighted ? [1, 1, 0, 0] : null, cabacInit: 0, qpDelta: 0, deblock: 1 }), sps);
          regionNals.push([(k * stride + H) * W, nalBytes(nalType, refIdc, concat([gHead, gIntra ? stampData(W * G, 128, copyQp, true, W) : skipData(W * G, copyQp)]))]);
        }
      });
      regionNals.sort(function (a, b) { return a[0] - b[0]; }).forEach(function (x) { out.push(x[1]); });
      if (guard) {
        // The stamp row: P_Skip copies need a reference picture still marked: the latest one marked before this picture.
        var stamp = p.complete ? 235 : 16, src = j > 0 ? pics[j - 1].marked[pics[j - 1].marked.length - 1] : undefined;
        var intra = src === undefined;
        var gh = writeSliceHeader(Object.assign({}, common, { firstMb: (n * H + G * (n - 1)) * W, sliceType: intra ? 2 : 0, lists: intra ? [] : [[pics[src].frameNum]],
          weights: !intra && pps.weighted ? [1, 1, 0, 0] : null, cabacInit: 0, qpDelta: 0, deblock: 1 }), sps);
        out.push(nalBytes(nalType, refIdc, concat([gh, stampData(W, stamp, copyQp, intra)])));
      }
      return concat(out);
    });
    return { aus: aus, pictures: pics, sps: sps, info: { pictures: pics.length, frames: feeds.map(function (f) { return f.frames.length; }),
      complete: pics.filter(function (p) { return p.complete; }).length, peakRefs: life.peakRefs, dpbPeak: dpb, reorder: needed,
      level: sps.level, picturesPerSecond: Math.round(pics.length / seconds), mbps: Math.round(mbps), overLevel: mbps > lv.mbps,
      pocScale: lanesUsed ? 'lanes' : opts.samePoc ? 1 : scale, lanesMismatch: lanesUsed ? pics.mismatch : undefined, lanes: lanesUsed ? pics.lanes : undefined,
      lanesFallback: fallback || undefined, gapRows: G * 16, edges: edgeCount || undefined,
      extra: pics.length - feeds[0].frames.length } };
  }

  // ---------------------------------------------------------------- interleaving in time
  /*
   * The feeds' frames one after another in ONE stream, each picture a whole frame of one feed (no stacking): every feed
   * keeps its own picture edges, so nothing bleeds across feeds and each picture decodes exactly as in its own stream
   * (headers rewritten only: frame_num, POC, explicit reference lists, MMCOs). Feed k's frame at display time T gets
   * POC max(2, n) * T + k (the lanes scheme with one lane per feed, so implicit weights stay as they were; checked per
   * B slice). A renderer that gets every decoded picture (Samsung's EMSS video texture mode) puts each feed's latest
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

  // opts: { segment, fixedLevel, maxDpb, reorder, dropB, targetFps, feedTag }. Returns { aus, pictures, sps, info } like
  // stitchSegment; picture j's feed is pictures[j].feed. dropB[k]: leave out feed k's non-reference frames (F1's B frames:
  // nothing predicts from them, so the rest decodes the same): a third of the pictures (16.7 fps of 50), one reference.
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
        out.push(nalBytes(nalType, refIdc, concat([th, stampData(W, tagValues[p.feed], 26 + pps.initQpMinus26, intra)])));
      }
      return concat(out);
    });
    return { aus: aus, pictures: pics, sps: sps, interleaved: n, info: { pictures: pics.length, frames: feeds.map(function (f) { return f.frames.length; }),
      peakRefs: life.peakRefs, dpbPeak: dpb, reorder: needed, level: sps.level, picturesPerSecond: Math.round(pics.length / seconds),
      mbps: Math.round(mbps), overLevel: mbps > lv.mbps, interleaved: n, mismatch: pics.mismatch,
      feedTag: tagRows ? { row: H * 16, rows: 16, values: tagValues.slice(0, n) } : null } };
  }

  // Sample timing for packaging (fMP4 trun), all in 90 kHz ticks: o = { start, frameDur, frames, delay, mode }.
  // An interleaved stream (st.interleaved = n feeds): feed k's frame T at T + k / n of a frame (o.stepMs: T + k x that
  // many ms, so feed 0's picture follows the longest gap: a renderer can tell where each display time starts).
  // Presentation: display time T's pictures (in decode order) at T + 0, 1, 2.. ms; the last of them (complete) shows
  // until T + 1. mode 'tile' (default): each sample's duration is its presentation duration, so the intervals tile
  // the timeline, and decode times add those durations up in decode order; 'even': decode times spread evenly over
  // the segment (durations then overlap and leave gaps in presentation; Firefox failed some seeks with it).
  function samples(st, o) {
    if (st.interleaved && o.stepMs && (st.interleaved - 1) * o.stepMs * 90 >= o.frameDur) throw new Error('stepMs: the feeds\' pictures must fit in one frame');
    var pics = st.pictures, n = pics.length, segDur = o.frames * o.frameDur, dts, dur;
    var pts = pics.map(function (p) { return o.start + p.T * o.frameDur + (st.interleaved ? Math.round(p.d * (o.stepMs ? o.stepMs * 90 : o.frameDur / st.interleaved)) : p.d * 90) + o.delay; });
    // o.spread (interleaved): the pictures, in display order, on an even grid over the segment (no bursts of several
    // feeds' pictures a few ms apart, which a renderer pulling one picture at a time can't take). Each picture moves at
    // most about one grid step (~10 ms for Big + 3). Grid points are multiples of 8 ticks and the feed number is added,
    // so pts mod 8 (in 90 kHz ticks) names the picture's feed.
    if (o.spread && st.interleaved) {
      if (st.interleaved > 8) throw new Error('spread: at most 8 feeds');
      // o.markEvery (e.g. 50): before every markEvery-th picture (and the first), an extra pause of o.markMs (default 12 ms);
      // the other gaps shrink to keep the segment's length. A renderer that only knows when it got each picture finds its
      // place again at these pauses (they are far apart, so the nearest one is never ambiguous).
      var every = o.markEvery || 0, extra = every ? Math.round((o.markMs || 12) * 90) : 0, marks = every ? Math.floor((n - 1) / every) + 1 : 0;
      var step = (segDur - marks * extra) / n;
      if (!(step > 0)) throw new Error('spread: the marks leave no time for the pictures');
      var shown = pts.map(function (t, j) { return j; }).sort(function (a, b) { return pts[a] - pts[b]; });
      shown.forEach(function (j, i) { pts[j] = Math.floor((o.start + o.delay + i * step + (every ? (Math.floor(i / every) + 1) * extra : 0)) / 8) * 8 + pics[j].feed; });
    }
    if (o.mode === 'even') {
      dts = pics.map(function (p, j) { return o.start + Math.round(j * segDur / n); });
      dur = dts.map(function (t, j) { return (j + 1 < n ? dts[j + 1] : o.start + segDur) - t; });
    } else {
      var order = pts.map(function (t, j) { return j; }).sort(function (a, b) { return pts[a] - pts[b]; });
      dur = [];
      // The last picture lasts until the next segment's first one: with spread marks that one comes `lead` after the
      // segment start (the pause), so without it the decode timeline would have a hole between segments (EMSS stalls).
      var lead = o.spread && st.interleaved && o.markEvery ? Math.min.apply(null, pts) - o.start - o.delay : 0;
      order.forEach(function (j, i) { dur[j] = (i + 1 < n ? pts[order[i + 1]] : o.start + segDur + o.delay + lead) - pts[j]; });
      dts = [];
      for (var j = 0, t = o.start; j < n; j++) { dts.push(t); t += dur[j]; }
    }
    return pics.map(function (p, j) {
      if (dts[j] > pts[j]) throw new Error('picture ' + j + ' would decode after it shows: raise the delay');
      if (!(dur[j] > 0)) throw new Error('picture ' + j + ' gets no presentation time (stepMs too large?)');
      return { data: st.aus[j], duration: dur[j], cto: pts[j] - dts[j], sync: j === 0 };
    });
  }

  return { tables: tables, stitchSegment: stitchSegment, interleaveSegment: interleaveSegment, interleaveLevel: interleaveLevel, samples: samples, streamLevel: streamLevel, analyse: analyse, nals: nals, parseSps: parseSps, parsePps: parsePps,
    skipData: skipData, Reader: Reader, Writer: Writer, escape: escape, unescape: unescape, concat: concat };
});
