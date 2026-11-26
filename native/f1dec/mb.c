/* Macroblock layer: parsing (7.3.5, 9.3.3.1), motion vector prediction (8.4.1) and reconstruction. */
#include "dec.h"

static const uint8_t BLK2R[16] = { 0, 1, 4, 5, 2, 3, 6, 7, 8, 9, 12, 13, 10, 11, 14, 15 };  /* luma4x4BlkIdx -> raster */
static uint8_t TR_INSIDE[16];   /* raster block: its top-right 4x4 (inside the MB) is decoded before it */
static const uint8_t CBF_CAT[5] = { 0, 4, 8, 12, 16 }, SIG_CAT[5] = { 0, 15, 29, 44, 47 }, ABS_CAT[5] = { 0, 10, 20, 30, 39 };
static const uint8_t B_PRED[22][2] = { { 0, 0 }, { 1, 0 }, { 2, 0 }, { 3, 0 }, { 1, 1 }, { 1, 1 }, { 2, 2 }, { 2, 2 }, { 1, 2 }, { 1, 2 }, { 2, 1 },
  { 2, 1 }, { 1, 3 }, { 1, 3 }, { 2, 3 }, { 2, 3 }, { 3, 1 }, { 3, 1 }, { 3, 2 }, { 3, 2 }, { 3, 3 }, { 3, 3 } };
static const uint8_t BSUB_PRED[13] = { 0, 1, 2, 3, 1, 1, 2, 2, 3, 3, 1, 2, 3 };
static const uint8_t BSUB_SHAPE[13] = { 0, 0, 0, 0, 1, 2, 1, 2, 1, 2, 3, 3, 3 };
static const uint8_t SUBPARTS[4][4][4] = {   /* x, y, w, h in 4x4 units inside the 8x8 */
  { { 0, 0, 2, 2 } }, { { 0, 0, 2, 1 }, { 0, 1, 2, 1 } }, { { 0, 0, 1, 2 }, { 1, 0, 1, 2 } },
  { { 0, 0, 1, 1 }, { 1, 0, 1, 1 }, { 0, 1, 1, 1 }, { 1, 1, 1, 1 } } };
static const uint8_t NSUBPARTS[4] = { 1, 2, 2, 4 };

#define C8(x, y) (((y) + 1) * 6 + (x) + 1)

typedef struct {
  int addr, mbx, mby, a, b, c, dd, ia, ib, ic, id, type, cbp;
  uint32_t cbf;
  int32_t coef[16][16], dcY[16], ccoef[2][4][16], dcC[2][4];
  uint16_t acmask;
  uint8_t cmask[2];
  int8_t ref[2][30];
  int16_t mv[2][30][2];
  uint8_t mvd[2][30][2], dir[30];
  int8_t ipred[16];
  int cpred;
  /* final motion of the 16 blocks (raster) */
  int16_t fmv[2][16][2];
  int8_t fref[2][16];
  uint16_t dirmask;
} Mb;

static void mb_tables_init(void) {
  uint8_t order[16];
  for (int i = 0; i < 16; i++) order[BLK2R[i]] = (uint8_t)i;
  for (int r = 0; r < 16; r++) {
    int bx = r & 3, by = r >> 2;
    TR_INSIDE[r] = by > 0 && bx < 3 && order[(by - 1) * 4 + bx + 1] < order[r];
  }
}

/* ---------------------------------------------------------------- syntax elements */

static inline int dec_bin(Dec *d, int ctx) { return cabac_decide(&d->c, &d->ctx[ctx]); }

static int dec_intra_type(Dec *d, int base, int islice, int inc) {
  if (islice) { if (!dec_bin(d, base + inc)) return 0; base += 2; }
  else if (!dec_bin(d, base)) return 0;
  if (cabac_terminate(&d->c)) return 25;
  int t = 1 + 12 * dec_bin(d, base + 1);
  if (dec_bin(d, base + 2)) t += 4 + 4 * dec_bin(d, base + 2 + islice);
  t += 2 * dec_bin(d, base + 3 + islice);
  t += dec_bin(d, base + 3 + 2 * islice);
  return t;
}

/* (The arithmetic decoder's state is a local copy in these loops: kept in registers, not WebAssembly memory.) */
static int dec_mvd(Dec *d, int base, int sum) {
  Cabac c = d->c;
  uint8_t *ctx = d->ctx + base;
  int inc = sum < 3 ? 0 : sum > 32 ? 2 : 1, v = 0;
  if (cabac_decide(&c, ctx + inc)) {
    int k = 3;
    v = 1;
    while (v < 9 && cabac_decide(&c, ctx + k)) { v++; if (k < 6) k++; }
    if (v >= 9) {
      k = 3;
      while (cabac_bypass(&c)) { v += 1 << k; if (++k > 24) { d->error = 1; d->c = c; return 0; } }
      while (k--) v += cabac_bypass(&c) << k;
    }
    if (cabac_bypass(&c)) v = -v;
  }
  d->c = c;
  return v;
}

static int dec_ref(Dec *d, Mb *m, int l, int x, int y, int nref) {
  int ia = C8(x - 1, y), ib = C8(x, y - 1);
  int inc = (m->ref[l][ia] > 0 && !m->dir[ia]) + 2 * (m->ref[l][ib] > 0 && !m->dir[ib]);
  if (!dec_bin(d, 54 + inc)) return 0;
  int v = 1, c = 58;
  while (dec_bin(d, c)) { c = 59; if (++v >= nref) { d->error = 1; return 0; } }
  return v;
}

/* One residual block (7.3.5.3.3, 9.3.2.7): coefficients into out[pos[i]] dequantised by dq (NULL: raw levels, for
 * DC blocks). Returns whether it was coded. */
static int residual_block(Dec *d, int cat, int inc, int32_t *out, int n, const uint8_t *pos, const int32_t *dq) {
  Cabac c = d->c;
  uint8_t *ctx = d->ctx;
  if (!cabac_decide(&c, ctx + 85 + CBF_CAT[cat] + inc)) { d->c = c; return 0; }
  /* significance map: bit i of `sig` for coefficient i (levels follow in reverse order) */
  uint8_t *sc = ctx + 105 + SIG_CAT[cat], *lc = ctx + 166 + SIG_CAT[cat];
  uint32_t sig = 0;
  int i;
  if (cat == 3) {
    for (i = 0; i < n - 1; i++) {
      int k = imin(i, 2);
      if (cabac_decide(&c, sc + k)) { sig |= 1u << i; if (cabac_decide(&c, lc + k)) break; }
    }
  } else {
    for (i = 0; i < n - 1; i++)
      if (cabac_decide(&c, sc + i)) { sig |= 1u << i; if (cabac_decide(&c, lc + i)) break; }
  }
  if (i == n - 1) sig |= 1u << (n - 1);
  uint8_t *ab = ctx + 227 + ABS_CAT[cat];
  int gt1 = 0, eq1 = 0, cap = 4 - (cat == 3);
  while (sig) {
    int k = 31 - __builtin_clz(sig), a;
    sig &= ~(1u << k);
    if (!cabac_decide(&c, ab + (gt1 ? 0 : imin(4, 1 + eq1)))) a = 1;
    else {
      uint8_t *cx = ab + 5 + imin(cap, gt1);
      a = 2;
      while (a < 15 && cabac_decide(&c, cx)) a++;
      if (a == 15) {
        int kk = 0;
        while (cabac_bypass(&c)) { a += 1 << kk; if (++kk > 24) { d->error = 1; d->c = c; return 1; } }
        while (kk--) a += cabac_bypass(&c) << kk;
      }
    }
    if (a == 1) eq1++; else gt1++;
    int v = cabac_bypass(&c) ? -a : a, p = pos ? pos[k] : k;
    out[p] = dq ? v * dq[p] : v;
  }
  d->c = c;
  return 1;
}

/* ---------------------------------------------------------------- neighbours */

static void neighbours(Dec *d, Mb *m, int addr) {
  int w = d->mbw, s = d->slice_num;
  m->addr = addr; m->mbx = addr % w; m->mby = addr / w;
  m->a = m->mbx > 0 && d->slice_of[addr - 1] == s ? addr - 1 : -1;
  m->b = m->mby > 0 && d->slice_of[addr - w] == s ? addr - w : -1;
  m->c = m->mby > 0 && m->mbx < w - 1 && d->slice_of[addr - w + 1] == s ? addr - w + 1 : -1;
  m->dd = m->mby > 0 && m->mbx > 0 && d->slice_of[addr - w - 1] == s ? addr - w - 1 : -1;
  int ci = d->p->constrained;
#define IAV(n) ((n) >= 0 && (!ci || IS_INTRA(d->mbtype[n])))
  m->ia = IAV(m->a); m->ib = IAV(m->b); m->ic = IAV(m->c); m->id = IAV(m->dd);
#undef IAV
}

static void fill_cache(Dec *d, Mb *m, int lists) {
  Pic *cur = d->cur;
  memset(m->dir, 0, 30);
  memset(m->ref, -2, sizeof m->ref);
  memset(m->mv, 0, sizeof m->mv);
  memset(m->mvd, 0, sizeof m->mvd);
  for (int l = 0; l < lists; l++) {
#define CP(cell, mb, blk) do { m->ref[l][cell] = cur->refidx[mb][l][blk]; m->mv[l][cell][0] = cur->mv[mb][l][blk][0]; \
    m->mv[l][cell][1] = cur->mv[mb][l][blk][1]; m->mvd[l][cell][0] = d->mvd[mb][l][blk][0]; m->mvd[l][cell][1] = d->mvd[mb][l][blk][1]; \
    if (l == 0) m->dir[cell] = (d->direct[mb] >> (blk)) & 1; } while (0)
    if (m->b >= 0) for (int x = 0; x < 4; x++) CP(C8(x, -1), m->b, 12 + x);
    if (m->c >= 0) CP(C8(4, -1), m->c, 12);
    if (m->dd >= 0) CP(C8(-1, -1), m->dd, 15);
    if (m->a >= 0) for (int y = 0; y < 4; y++) CP(C8(-1, y), m->a, 4 * y + 3);
#undef CP
  }
}

/* mvpLX (8.4.1.3). shape: 0 median, 1 16x8 top, 2 16x8 bottom, 3 8x16 left, 4 8x16 right. */
static void mvpred(Mb *m, int l, int x, int y, int w, int ref, int shape, int *px, int *py) {
  int ia = C8(x - 1, y), ib = C8(x, y - 1), ic = C8(x + w, y - 1);
  if (m->ref[l][ic] == -2) ic = C8(x - 1, y - 1);
  int ra = m->ref[l][ia], rb = m->ref[l][ib], rc = m->ref[l][ic];
  int16_t *A = m->mv[l][ia], *B = m->mv[l][ib], *C = m->mv[l][ic];
  if (shape == 1 && rb == ref) { *px = B[0]; *py = B[1]; return; }
  if (shape == 2 && ra == ref) { *px = A[0]; *py = A[1]; return; }
  if (shape == 3 && ra == ref) { *px = A[0]; *py = A[1]; return; }
  if (shape == 4 && rc == ref) { *px = C[0]; *py = C[1]; return; }
  if (rb == -2 && rc == -2 && ra != -2) { *px = A[0]; *py = A[1]; return; }
  int n = (ra == ref) + (rb == ref) + (rc == ref);
  if (n == 1) {
    int16_t *M = ra == ref ? A : rb == ref ? B : C;
    *px = M[0]; *py = M[1]; return;
  }
  *px = median3(A[0], B[0], C[0]);
  *py = median3(A[1], B[1], C[1]);
}

static void set_cells(Mb *m, int l, int x, int y, int w, int h, int ref, int mx, int my, int dx, int dy) {
  for (int j = y; j < y + h; j++)
    for (int i = x; i < x + w; i++) {
      int c = C8(i, j);
      m->ref[l][c] = (int8_t)ref; m->mv[l][c][0] = (int16_t)mx; m->mv[l][c][1] = (int16_t)my;
      m->mvd[l][c][0] = (uint8_t)imin(dx, 64); m->mvd[l][c][1] = (uint8_t)imin(dy, 64);
      m->fref[l][j * 4 + i] = (int8_t)ref; m->fmv[l][j * 4 + i][0] = (int16_t)mx; m->fmv[l][j * 4 + i][1] = (int16_t)my;
    }
}

/* ---------------------------------------------------------------- direct prediction (8.4.1.2) */

static inline int minpos(int a, int b) { return a >= 0 && b >= 0 ? imin(a, b) : imax(a, b); }

/* Fills fref/fmv (and the cache) of the 4x4 blocks in `blocks` (bit mask, raster) predicted in direct mode. */
static void direct_pred(Dec *d, Mb *m, uint16_t blocks) {
  Pic *col = d->list[1][0];
  int inference = d->s->direct8x8, addr = m->addr;
  if (d->sh.direct_spatial) {
    int ref[2], mvp[2][2];
    for (int l = 0; l < 2; l++) {
      int ic = C8(4, -1);
      if (m->ref[l][ic] == -2) ic = C8(-1, -1);
      ref[l] = minpos(m->ref[l][C8(-1, 0)], minpos(m->ref[l][C8(0, -1)], m->ref[l][ic]));
      if (ref[l] < -1) ref[l] = -1;
    }
    int zero = ref[0] < 0 && ref[1] < 0;
    if (zero) ref[0] = ref[1] = 0;
    for (int l = 0; l < 2; l++) {
      mvp[l][0] = mvp[l][1] = 0;
      if (!zero && ref[l] >= 0) mvpred(m, l, 0, 0, 4, ref[l], 0, &mvp[l][0], &mvp[l][1]);
    }
    int shortcol = col->ref == 1 && !col->intra[addr], czc = -1, czv = 0;
    for (int r = 0; r < 16; r++) {
      if (!(blocks >> r & 1)) continue;
      int cb = inference ? ((r >> 3) & 1) * 12 + ((r >> 1) & 1) * 3 : r, colzero;
      if (cb == czc) colzero = czv;
      else {
        int lc = col->refidx[addr][0][cb] >= 0 ? 0 : 1, rcol = col->refidx[addr][lc][cb];
        colzero = shortcol && rcol == 0 && iabs(col->mv[addr][lc][cb][0]) <= 1 && iabs(col->mv[addr][lc][cb][1]) <= 1;
        czc = cb; czv = colzero;
      }
      for (int l = 0; l < 2; l++) {
        int mx = 0, my = 0;
        if (!zero && ref[l] >= 0 && !(ref[l] == 0 && colzero)) { mx = mvp[l][0]; my = mvp[l][1]; }
        m->fref[l][r] = (int8_t)ref[l]; m->fmv[l][r][0] = (int16_t)mx; m->fmv[l][r][1] = (int16_t)my;
      }
    }
  } else {
    int cur_poc = d->cur->poc;
    for (int r = 0; r < 16; r++) {
      if (!(blocks >> r & 1)) continue;
      int cb = inference ? ((r >> 3) & 1) * 12 + ((r >> 1) & 1) * 3 : r;
      int ref0 = 0, mcx = 0, mcy = 0;
      if (!col->intra[addr]) {
        int lc = col->refidx[addr][0][cb] >= 0 ? 0 : 1;
        int id = col->refpic[addr][lc][cb];
        mcx = col->mv[addr][lc][cb][0]; mcy = col->mv[addr][lc][cb][1];
        for (int i = 0; i < d->nlist[0]; i++) if (d->list[0][i]->id == id) { ref0 = i; break; }
      }
      Pic *p0 = d->list[0][ref0], *p1 = d->list[1][0];
      int m0x, m0y, m1x, m1y;
      int td = clip3(-128, 127, p1->poc - p0->poc);
      if (p0->ref == 2 || td == 0) { m0x = mcx; m0y = mcy; m1x = 0; m1y = 0; }
      else {
        int tb = clip3(-128, 127, cur_poc - p0->poc), tx = (16384 + iabs(td / 2)) / td;
        int dsf = clip3(-1024, 1023, (tb * tx + 32) >> 6);
        m0x = (dsf * mcx + 128) >> 8; m0y = (dsf * mcy + 128) >> 8;
        m1x = m0x - mcx; m1y = m0y - mcy;
      }
      m->fref[0][r] = (int8_t)ref0; m->fmv[0][r][0] = (int16_t)m0x; m->fmv[0][r][1] = (int16_t)m0y;
      m->fref[1][r] = 0; m->fmv[1][r][0] = (int16_t)m1x; m->fmv[1][r][1] = (int16_t)m1y;
    }
  }
  /* Into the cache (the partitions decoded after them predict from them). */
  for (int r = 0; r < 16; r++) {
    if (!(blocks >> r & 1)) continue;
    int c = C8(r & 3, r >> 2);
    m->dir[c] = 1;
    for (int l = 0; l < 2; l++) {
      m->ref[l][c] = m->fref[l][r]; m->mv[l][c][0] = m->fmv[l][r][0]; m->mv[l][c][1] = m->fmv[l][r][1];
      m->mvd[l][c][0] = m->mvd[l][c][1] = 0;
    }
  }
  m->dirmask |= blocks;
}

/* ---------------------------------------------------------------- motion compensation */

static void mc_part(Dec *d, Mb *m, int bx, int by, int bw, int bh) {
  int r = by * 4 + bx, w = bw * 4, h = bh * 4, cw = w >> 1, ch = h >> 1;
  int used0 = m->fref[0][r] >= 0, used1 = m->fref[1][r] >= 0, bi = used0 && used1;
  int r0 = m->fref[0][r], r1 = m->fref[1][r];
  uint8_t *dy = d->cur->y + (m->mby * 16 + by * 4) * d->stride + m->mbx * 16 + bx * 4;
  uint8_t *dc[2] = { d->cur->u + (m->mby * 8 + by * 2) * d->cstride + m->mbx * 8 + bx * 2,
                     d->cur->v + (m->mby * 8 + by * 2) * d->cstride + m->mbx * 8 + bx * 2 };
  /* Predictions: the first list straight into the picture, the second into t (then averaged or weighted in), except
   * explicit weights, which need both. */
  uint8_t pl[2][256], pc[2][2][128];
  int explicitw = d->wmode == 1;
  for (int l = 0; l < 2; l++) {
    if (!(l ? used1 : used0)) continue;
    Pic *ref = d->list[l][m->fref[l][r]];
    int mx = m->fmv[l][r][0], my = m->fmv[l][r][1];
    int x = m->mbx * 16 + bx * 4 + (mx >> 2), y = m->mby * 16 + by * 4 + (my >> 2);
    x = clip3(-(w + 3), d->width + 2, x); y = clip3(-(h + 3), d->height + 2, y);
    int direct = !explicitw && (l == 0 || !used0);
    uint8_t *ld = direct ? dy : pl[l];
    int lds = direct ? d->stride : 16;
    luma_mc(ld, lds, ref->y + y * d->stride + x, d->stride, mx & 3, my & 3, w, h);
    int xc = m->mbx * 8 + bx * 2 + (mx >> 3), yc = m->mby * 8 + by * 2 + (my >> 3);
    xc = clip3(-(cw + 1), d->width / 2, xc); yc = clip3(-(ch + 1), d->height / 2, yc);
    for (int k = 0; k < 2; k++) {
      uint8_t *cd = direct ? dc[k] : pc[l][k];
      int cds = direct ? d->cstride : 16;
      chroma_mc(cd, cds, (k ? ref->v : ref->u) + yc * d->cstride + xc, d->cstride, mx & 7, my & 7, cw, ch);
    }
  }
  if (!explicitw) {
    if (!bi) return;
    int w1 = d->wmode == 2 ? d->imp_w[r0][r1] : 32;
    if (w1 == 32) {
      avg_block(dy, d->stride, pl[1], 16, w, h);
      for (int k = 0; k < 2; k++) avg_block(dc[k], d->cstride, pc[1][k], 16, cw, ch);
    } else {
      weight_block(dy, d->stride, pl[1], 16, w, h, w1);
      for (int k = 0; k < 2; k++) weight_block(dc[k], d->cstride, pc[1][k], 16, cw, ch, w1);
    }
    return;
  }
  /* explicit weights (8.4.2.3.2) */
  Slice *s = &d->sh;
  int one = used0 ? 0 : 1;
  for (int k = 0; k < 3; k++) {
    int n = k ? ch : h, wd = k ? cw : w, st = k ? d->cstride : d->stride, lwd = k ? s->cwd : s->lwd;
    uint8_t *dst = k ? dc[k - 1] : dy;
    const uint8_t *a = k ? pc[0][k - 1] : pl[0], *b = k ? pc[1][k - 1] : pl[1];
    if (bi) {
      int w0 = k ? s->cw[0][r0][k - 1] : s->lw[0][r0], w1 = k ? s->cw[1][r1][k - 1] : s->lw[1][r1];
      int o = ((k ? s->co[0][r0][k - 1] : s->lo[0][r0]) + (k ? s->co[1][r1][k - 1] : s->lo[1][r1]) + 1) >> 1;
      for (int y = 0; y < n; y++) for (int x = 0; x < wd; x++)
        dst[y * st + x] = clip1(((a[y * 16 + x] * w0 + b[y * 16 + x] * w1 + (1 << lwd)) >> (lwd + 1)) + o);
    } else {
      int rr = one ? r1 : r0;
      int wt = k ? s->cw[one][rr][k - 1] : s->lw[one][rr], o = k ? s->co[one][rr][k - 1] : s->lo[one][rr];
      const uint8_t *src = one ? b : a;
      for (int y = 0; y < n; y++) for (int x = 0; x < wd; x++)
        dst[y * st + x] = clip1(lwd >= 1 ? ((src[y * 16 + x] * wt + (1 << (lwd - 1))) >> lwd) + o : src[y * 16 + x] * wt + o);
    }
  }
}

/* Direct-predicted blocks: as one 8x8 where its four blocks move alike, else 4x4 each. */
static int same_motion(Mb *m, int r, int s) {
  for (int l = 0; l < 2; l++) {
    if (m->fref[l][r] != m->fref[l][s]) return 0;
    if (m->fref[l][r] >= 0 && (m->fmv[l][r][0] != m->fmv[l][s][0] || m->fmv[l][r][1] != m->fmv[l][s][1])) return 0;
  }
  return 1;
}
static void mc_direct8x8(Dec *d, Mb *m, int q) {
  int r = (q >> 1) * 8 + (q & 1) * 2;
  if (same_motion(m, r, r + 1) && same_motion(m, r, r + 4) && same_motion(m, r, r + 5)) mc_part(d, m, (q & 1) * 2, (q >> 1) * 2, 2, 2);
  else for (int k = 0; k < 4; k++) mc_part(d, m, (q & 1) * 2 + (k & 1), (q >> 1) * 2 + (k >> 1), 1, 1);
}
static void mc_direct16(Dec *d, Mb *m) {
  int all = 1;
  for (int r = 1; r < 16 && all; r++) all = same_motion(m, 0, r);
  if (all) mc_part(d, m, 0, 0, 4, 4);
  else for (int q = 0; q < 4; q++) mc_direct8x8(d, m, q);
}

/* ---------------------------------------------------------------- residual */

static void residual(Dec *d, Mb *m, int qp) {
  int i16 = m->type & MB_I16;
  uint32_t intra = IS_INTRA(m->type) ? 1 : 0;
  uint32_t cbf = 0;
  m->acmask = 0; m->cmask[0] = m->cmask[1] = 0;
  /* coded_block_flag context: the neighbour block's flag, or 1/0 for an intra/inter MB when it is missing (9.3.3.1.1.9). */
  uint32_t fa = m->a >= 0 ? d->cbf[m->a] : 0, fb = m->b >= 0 ? d->cbf[m->b] : 0;
  int na = m->a >= 0, nb = m->b >= 0;
  if (i16) {
    int inc = (na ? (fa >> 24) & 1 : intra) + 2 * (nb ? (fb >> 24) & 1 : intra);
    int32_t c[16];
    memset(c, 0, sizeof c);
    if (residual_block(d, 0, inc, c, 16, ZIGZAG, NULL)) { cbf |= 1u << 24; luma_dc(c, qp, m->dcY); }
    else memset(m->dcY, 0, sizeof m->dcY);
  }
  for (int b8 = 0; b8 < 4; b8++) {
    if (!(m->cbp >> b8 & 1)) continue;
    for (int k = 0; k < 4; k++) {
      int r = BLK2R[b8 * 4 + k], bx = r & 3, by = r >> 2;
      int left = bx ? (cbf >> (r - 1)) & 1 : na ? (fa >> (r + 3)) & 1 : intra;
      int top = by ? (cbf >> (r - 4)) & 1 : nb ? (fb >> (r + 12)) & 1 : intra;
      int32_t *co = m->coef[r];
      memset(co, 0, 64);
      if (residual_block(d, i16 ? 1 : 2, left + 2 * top, i16 ? co : co, i16 ? 15 : 16, i16 ? ZIGZAG + 1 : ZIGZAG, DQ[qp])) {
        cbf |= 1u << r; m->acmask |= 1 << r;
      }
    }
  }
  int cc = m->cbp >> 4;
  if (cc) {
    for (int k = 0; k < 2; k++) {
      int bit = 25 + k;
      int left = na ? (fa >> bit) & 1 : intra, top = nb ? (fb >> bit) & 1 : intra;
      int32_t c[4] = { 0, 0, 0, 0 };
      int qc = d->cur_qpc[k];
      if (residual_block(d, 3, left + 2 * top, c, 4, NULL, NULL)) { cbf |= 1u << bit; chroma_dc(c, qc, m->dcC[k]); }
      else memset(m->dcC[k], 0, sizeof m->dcC[k]);
    }
  } else memset(m->dcC, 0, sizeof m->dcC);
  if (cc == 2) {
    for (int k = 0; k < 2; k++)
      for (int b = 0; b < 4; b++) {
        int bit = 16 + 4 * k + b, cx = b & 1, cy = b >> 1;
        int left = cx ? (cbf >> (bit - 1)) & 1 : na ? (fa >> (bit + 1)) & 1 : intra;
        int top = cy ? (cbf >> (bit - 2)) & 1 : nb ? (fb >> (bit + 2)) & 1 : intra;
        int32_t *co = m->ccoef[k][b];
        memset(co, 0, 64);
        if (residual_block(d, 4, left + 2 * top, co, 15, ZIGZAG + 1, DQ[d->cur_qpc[k]])) { cbf |= 1u << bit; m->cmask[k] |= 1 << b; }
      }
  }
  m->cbf = cbf;
}

static void add_luma(Dec *d, Mb *m, int r) {
  uint8_t *p = d->cur->y + (m->mby * 16 + (r >> 2) * 4) * d->stride + m->mbx * 16 + (r & 3) * 4;
  if (m->type & MB_I16) {
    if (m->acmask >> r & 1) { m->coef[r][0] = m->dcY[r]; idct4_add(p, d->stride, m->coef[r]); }
    else dc_add(p, d->stride, m->dcY[r]);
  } else if (m->acmask >> r & 1) idct4_add(p, d->stride, m->coef[r]);
}

static void add_chroma(Dec *d, Mb *m) {
  for (int k = 0; k < 2; k++) {
    uint8_t *base = (k ? d->cur->v : d->cur->u) + m->mby * 8 * d->cstride + m->mbx * 8;
    for (int b = 0; b < 4; b++) {
      uint8_t *p = base + (b >> 1) * 4 * d->cstride + (b & 1) * 4;
      if (m->cmask[k] >> b & 1) { m->ccoef[k][b][0] = m->dcC[k][b]; idct4_add(p, d->cstride, m->ccoef[k][b]); }
      else if (m->dcC[k][b]) dc_add(p, d->cstride, m->dcC[k][b]);
    }
  }
}

/* ---------------------------------------------------------------- intra macroblocks */

static void intra4x4_recon(Dec *d, Mb *m) {
  int stride = d->stride;
  for (int i = 0; i < 16; i++) {
    int r = BLK2R[i], bx = r & 3, by = r >> 2;
    uint8_t *p = d->cur->y + (m->mby * 16 + by * 4) * stride + m->mbx * 16 + bx * 4;
    int hasL = bx > 0 || m->ia, hasT = by > 0 || m->ib;
    int hasD = bx > 0 && by > 0 ? 1 : bx > 0 ? m->ib : by > 0 ? m->ia : m->id;
    int hasTR = by == 0 ? (bx < 3 ? m->ib : m->ic) : TR_INSIDE[r];
    int t[9], l[5];
    t[0] = l[0] = hasD ? p[-stride - 1] : 128;
    for (int x = 0; x < 4; x++) t[1 + x] = hasT ? p[x - stride] : 128;
    for (int x = 4; x < 8; x++) t[1 + x] = hasTR ? p[x - stride] : t[4];
    for (int y = 0; y < 4; y++) l[1 + y] = hasL ? p[y * stride - 1] : 128;
    pred4x4(p, stride, m->ipred[r], t, l, hasL, hasT);
    add_luma(d, m, r);
  }
}

static void chroma_recon(Dec *d, Mb *m) {
  for (int k = 0; k < 2; k++) {
    uint8_t *p = (k ? d->cur->v : d->cur->u) + m->mby * 8 * d->cstride + m->mbx * 8;
    pred_chroma(p, d->cstride, m->cpred, m->ib, m->ia, m->id);
  }
}

/* ---------------------------------------------------------------- the macroblock */

/* bS of an edge between two inter blocks of this macroblock from their motion (8.7.2.1): ids are the pictures. */
static int motion_bs(const int32_t *ip, const int16_t (*mp)[2], const int32_t *iq, const int16_t (*mq)[2]) {
  int p0 = ip[0], p1 = ip[1], q0 = iq[0], q1 = iq[1];
  int np = (p0 >= 0) + (p1 >= 0), nq = (q0 >= 0) + (q1 >= 0);
  if (np != nq) return 1;
#define FAR(u, v) (iabs((u)[0] - (v)[0]) >= 4 || iabs((u)[1] - (v)[1]) >= 4)
  if (np == 1) {
    if ((p0 >= 0 ? p0 : p1) != (q0 >= 0 ? q0 : q1)) return 1;
    return FAR(p0 >= 0 ? mp[0] : mp[1], q0 >= 0 ? mq[0] : mq[1]);
  }
  if (!((p0 == q0 && p1 == q1) || (p0 == q1 && p1 == q0))) return 1;
  if (p0 != p1) return p0 == q0 ? FAR(mp[0], mq[0]) || FAR(mp[1], mq[1]) : FAR(mp[0], mq[1]) || FAR(mp[1], mq[0]);
  return (FAR(mp[0], mq[0]) || FAR(mp[1], mq[1])) && (FAR(mp[0], mq[1]) || FAR(mp[1], mq[0]));
#undef FAR
}

static void store_mb(Dec *d, Mb *m, int qp) {
  int a = m->addr, intra = IS_INTRA(m->type);
  Pic *cur = d->cur;
  d->mbtype[a] = (uint8_t)m->type;
  d->cbp[a] = (uint8_t)m->cbp;
  d->cbf[a] = m->cbf;
  d->qp[a] = (uint8_t)qp;
  d->cpred[a] = (uint8_t)m->cpred;
  d->direct[a] = m->dirmask;
  memcpy(d->ipred[a], m->ipred, 16);
  cur->intra[a] = (uint8_t)intra;
  int32_t ids[16][2];
  int16_t mvs[16][2][2];
  if (intra) {
    memset(cur->refidx[a], -1, sizeof cur->refidx[a]);
    memset(cur->mv[a], 0, sizeof cur->mv[a]);
    memset(d->mvd[a], 0, sizeof d->mvd[a]);
    for (int l = 0; l < 2; l++) for (int r = 0; r < 16; r++) cur->refpic[a][l][r] = -1;
    d->bsint[a][0] = d->bsint[a][1] = 0xFFFFFF;   /* 3 everywhere */
  } else {
    /* (fmv is 0 wherever fref is -1: every path that sets a block's motion writes both) */
    for (int l = 0; l < 2; l++) {
      memcpy(cur->refidx[a][l], m->fref[l], 16);
      memcpy(cur->mv[a][l], m->fmv[l], sizeof m->fmv[l]);
      int last = -2, id = -1;
      for (int r = 0; r < 16; r++) {
        int ref = m->fref[l][r];
        if (ref != last) { last = ref; id = ref >= 0 ? d->list_id[l][ref] : -1; }
        ids[r][l] = cur->refpic[a][l][r] = id;
        mvs[r][l][0] = m->fmv[l][r][0]; mvs[r][l][1] = m->fmv[l][r][1];
      }
      for (int y = 0; y < 4; y++) memcpy(d->mvd[a][l][y * 4], m->mvd[l][C8(0, y)], 8);
    }
    /* One motion for the whole macroblock (skipped, 16x16, most direct ones): only coefficients make inner edges. */
    int uniform = 1;
    for (int r = 1; r < 16 && uniform; r++)
      uniform = ids[r][0] == ids[0][0] && ids[r][1] == ids[0][1] && mvs[r][0][0] == mvs[0][0][0] && mvs[r][0][1] == mvs[0][0][1] &&
        mvs[r][1][0] == mvs[0][1][0] && mvs[r][1][1] == mvs[0][1][1];
    uint32_t bs[2] = { 0, 0 };
    if (!uniform || (m->cbf & 0xFFFF))
      for (int dir = 0; dir < 2; dir++)
        for (int e = 1; e < 4; e++)
          for (int k = 0; k < 4; k++) {
            int q = dir ? e * 4 + k : k * 4 + e, p = dir ? q - 4 : q - 1, v;
            if ((m->cbf >> q & 1) || (m->cbf >> p & 1)) v = 2;
            else v = uniform ? 0 : motion_bs(ids[p], (const int16_t (*)[2])mvs[p], ids[q], (const int16_t (*)[2])mvs[q]);
            bs[dir] |= (uint32_t)v << (2 * ((e - 1) * 4 + k));
          }
    d->bsint[a][0] = bs[0]; d->bsint[a][1] = bs[1];
  }
  d->deblock_of[a] = (uint8_t)(d->slice_num & 255);
}

static void set_chroma_qp(Dec *d, int qp) {
  static const uint8_t QPC[52] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39 };
  for (int k = 0; k < 2; k++) d->cur_qpc[k] = QPC[clip3(0, 51, qp + d->p->cqp[k])];
}

/* Returns 0, or an error. *qp: the running QPY. */
static int decode_mb(Dec *d, int addr, int *qp) {
  Mb *m = d->mbctx;
  Slice *s = &d->sh;
  int slice_type = s->type;
  neighbours(d, m, addr);
  d->slice_of[addr] = (int16_t)d->slice_num;
  m->type = 0; m->cbp = 0; m->cbf = 0; m->cpred = 0; m->dirmask = 0; m->acmask = 0; m->cmask[0] = m->cmask[1] = 0;
  memset(m->ipred, 2, 16);
  memset(m->fref, -1, sizeof m->fref);
  memset(m->fmv, 0, sizeof m->fmv);
  int lists = slice_type == 1 ? 2 : slice_type == 0 ? 1 : 0;

  if (slice_type != 2) {
    int base = slice_type == 0 ? 11 : 24;
    int inc = (m->a >= 0 && !(d->mbtype[m->a] & MB_SKIP)) + (m->b >= 0 && !(d->mbtype[m->b] & MB_SKIP));
    if (dec_bin(d, base + inc)) {
      fill_cache(d, m, lists);
      if (slice_type == 0) {
        int mx = 0, my = 0;
        int ra = m->ref[0][C8(-1, 0)], rb = m->ref[0][C8(0, -1)];
        int16_t *A = m->mv[0][C8(-1, 0)], *B = m->mv[0][C8(0, -1)];
        if (!(ra == -2 || rb == -2 || (ra == 0 && !A[0] && !A[1]) || (rb == 0 && !B[0] && !B[1]))) mvpred(m, 0, 0, 0, 4, 0, 0, &mx, &my);
        set_cells(m, 0, 0, 0, 4, 4, 0, mx, my, 0, 0);
        m->type = MB_SKIP | MB_INTER;
        mc_part(d, m, 0, 0, 4, 4);
      } else {
        m->type = MB_SKIP | MB_DIRECT | MB_INTER;
        direct_pred(d, m, 0xFFFF);
        mc_direct16(d, m);
      }
      memset(m->mvd, 0, sizeof m->mvd);
      d->last_dqp = 0;
      store_mb(d, m, *qp);
      return d->error ? ERR_DATA : ERR_OK;
    }
  }

  /* mb_type */
  int itype = -1, ptype = -1, btype = -1;
  if (slice_type == 2) {
    int inc = (m->a >= 0 && (d->mbtype[m->a] & (MB_I16 | MB_PCM))) + (m->b >= 0 && (d->mbtype[m->b] & (MB_I16 | MB_PCM)));
    itype = dec_intra_type(d, 3, 1, inc);
  } else if (slice_type == 0) {
    if (dec_bin(d, 14)) itype = dec_intra_type(d, 17, 0, 0);
    else if (!dec_bin(d, 15)) ptype = dec_bin(d, 16) ? 3 : 0;
    else ptype = dec_bin(d, 17) ? 1 : 2;
  } else {
    int inc = (m->a >= 0 && !(d->mbtype[m->a] & (MB_SKIP | MB_DIRECT))) + (m->b >= 0 && !(d->mbtype[m->b] & (MB_SKIP | MB_DIRECT)));
    if (!dec_bin(d, 27 + inc)) btype = 0;
    else if (!dec_bin(d, 30)) btype = 1 + dec_bin(d, 32);
    else {
      int bits = dec_bin(d, 31) << 3;
      bits |= dec_bin(d, 32) << 2;
      bits |= dec_bin(d, 32) << 1;
      bits |= dec_bin(d, 32);
      if (bits < 8) btype = bits + 3;
      else if (bits == 13) itype = dec_intra_type(d, 32, 0, 0);
      else if (bits == 14) btype = 11;
      else if (bits == 15) btype = 22;
      else btype = ((bits << 1) | dec_bin(d, 32)) - 4;
    }
  }
  if (d->error) return ERR_DATA;

  if (itype >= 0) {
    /* ------------------------------------------------ intra */
    if (itype == 25) {
      const uint8_t *p = cabac_pcm_start(&d->c);
      if (p + 384 > d->c.end) return ERR_DATA;
      uint8_t *y = d->cur->y + m->mby * 16 * d->stride + m->mbx * 16;
      for (int i = 0; i < 16; i++) memcpy(y + i * d->stride, p + i * 16, 16);
      p += 256;
      for (int k = 0; k < 2; k++) {
        uint8_t *c = (k ? d->cur->v : d->cur->u) + m->mby * 8 * d->cstride + m->mbx * 8;
        for (int i = 0; i < 8; i++) memcpy(c + i * d->cstride, p + i * 8, 8);
        p += 64;
      }
      cabac_start(&d->c, p, d->c.end);
      m->type = MB_PCM; m->cbp = 0x2F; m->cbf = 0x7FFFFFF;
      d->last_dqp = 0;
      store_mb(d, m, 0);
      return ERR_OK;
    }
    if (itype == 0) {
      m->type = MB_I4;
      for (int i = 0; i < 16; i++) {
        int r = BLK2R[i], bx = r & 3, by = r >> 2;
        int availA = bx > 0 || m->ia, availB = by > 0 || m->ib, pred;
        if (!availA || !availB) pred = 2;
        else {
          int ma = bx > 0 ? m->ipred[r - 1] : d->ipred[m->a][r + 3];
          int mb = by > 0 ? m->ipred[r - 4] : d->ipred[m->b][r + 12];
          pred = imin(ma, mb);
        }
        if (dec_bin(d, 68)) m->ipred[r] = (int8_t)pred;
        else {
          int rem = dec_bin(d, 69);
          rem |= dec_bin(d, 69) << 1;
          rem |= dec_bin(d, 69) << 2;
          m->ipred[r] = (int8_t)(rem < pred ? rem : rem + 1);
        }
      }
    } else {
      m->type = MB_I16;
      int t = itype - 1;
      m->cbp = (t >= 12 ? 15 : 0) | (((t % 12) / 4) << 4);
      m->ipred[0] = (int8_t)(t % 4);   /* the 16x16 mode, kept in slot 0 until stored */
    }
    {
      int ca = m->a >= 0 && IS_INTRA(d->mbtype[m->a]) && !(d->mbtype[m->a] & MB_PCM) && d->cpred[m->a] != 0;
      int cb = m->b >= 0 && IS_INTRA(d->mbtype[m->b]) && !(d->mbtype[m->b] & MB_PCM) && d->cpred[m->b] != 0;
      int v = 0;
      if (dec_bin(d, 64 + ca + cb)) { v = 1; if (dec_bin(d, 67)) { v = 2; if (dec_bin(d, 67)) v = 3; } }
      m->cpred = v;
    }
  } else {
    /* ------------------------------------------------ inter */
    m->type = MB_INTER;
    fill_cache(d, m, lists);
    if (ptype == 3 || btype == 22) {
      m->type |= MB_8X8;
      int sub[4], refs[2][4];
      for (int i = 0; i < 4; i++) {
        if (slice_type == 0) {
          if (dec_bin(d, 21)) sub[i] = 0;
          else if (!dec_bin(d, 22)) sub[i] = 1;
          else sub[i] = dec_bin(d, 23) ? 2 : 3;
        } else {
          if (!dec_bin(d, 36)) sub[i] = 0;
          else if (!dec_bin(d, 37)) sub[i] = 1 + dec_bin(d, 39);
          else {
            int t = 3;
            if (dec_bin(d, 38)) {
              if (dec_bin(d, 39)) { sub[i] = 11 + dec_bin(d, 39); continue; }
              t += 4;
            }
            t += 2 * dec_bin(d, 39);
            t += dec_bin(d, 39);
            sub[i] = t;
          }
        }
      }
      int pred[4], shape[4];
      uint16_t dmask = 0;
      for (int i = 0; i < 4; i++) {
        if (slice_type == 0) { pred[i] = 1; shape[i] = sub[i]; }
        else { pred[i] = BSUB_PRED[sub[i]]; shape[i] = BSUB_SHAPE[sub[i]]; if (sub[i] == 0) dmask |= 0x33 << ((i >> 1) * 8 + (i & 1) * 2); }
      }
      if (dmask) {
        direct_pred(d, m, dmask);
        for (int l = 0; l < 2; l++) { m->ref[l][C8(2, 0)] = -2; m->ref[l][C8(2, 2)] = -2; }
      }
      for (int l = 0; l < lists; l++)
        for (int i = 0; i < 4; i++) {
          if (slice_type == 1 && sub[i] == 0) continue;
          int x8 = (i & 1) * 2, y8 = (i >> 1) * 2;
          int ref = -1;
          if (pred[i] >> l & 1) ref = s->nref[l] > 1 ? dec_ref(d, m, l, x8, y8, s->nref[l]) : 0;
          refs[l][i] = ref;
          m->ref[l][C8(x8 + 1, y8)] = m->ref[l][C8(x8, y8 + 1)] = m->ref[l][C8(x8 + 1, y8 + 1)] = (int8_t)ref;
        }
      for (int l = 0; l < lists; l++)
        for (int i = 0; i < 4; i++) {
          int x8 = (i & 1) * 2, y8 = (i >> 1) * 2;
          m->ref[l][C8(x8, y8)] = m->ref[l][C8(x8 + 1, y8)];
          if (slice_type == 1 && sub[i] == 0) continue;
          if (!(pred[i] >> l & 1)) { set_cells(m, l, x8, y8, 2, 2, -1, 0, 0, 0, 0); continue; }
          for (int j = 0; j < NSUBPARTS[shape[i]]; j++) {
            const uint8_t *sp = SUBPARTS[shape[i]][j];
            int x = x8 + sp[0], y = y8 + sp[1], ia = C8(x - 1, y), ib = C8(x, y - 1), px, py;
            int dx = dec_mvd(d, 40, m->mvd[l][ia][0] + m->mvd[l][ib][0]);
            int dy = dec_mvd(d, 47, m->mvd[l][ia][1] + m->mvd[l][ib][1]);
            mvpred(m, l, x, y, sp[2], refs[l][i], 0, &px, &py);
            set_cells(m, l, x, y, sp[2], sp[3], refs[l][i], px + dx, py + dy, iabs(dx), iabs(dy));
          }
        }
      if (d->error) return ERR_DATA;
      for (int i = 0; i < 4; i++) {
        int x8 = (i & 1) * 2, y8 = (i >> 1) * 2;
        if (slice_type == 1 && sub[i] == 0) mc_direct8x8(d, m, i);
        else for (int j = 0; j < NSUBPARTS[shape[i]]; j++) {
          const uint8_t *sp = SUBPARTS[shape[i]][j];
          mc_part(d, m, x8 + sp[0], y8 + sp[1], sp[2], sp[3]);
        }
      }
    } else if (btype == 0) {
      m->type |= MB_DIRECT;
      direct_pred(d, m, 0xFFFF);
      mc_direct16(d, m);
    } else {
      int np, px[2], py[2], pw[2], ph[2], pp[2], shp[2];
      int t = slice_type == 0 ? ptype : btype;
      int is16 = slice_type == 0 ? t == 0 : t <= 3, is16x8 = slice_type == 0 ? t == 1 : !(t & 1);
      if (is16) { np = 1; px[0] = py[0] = 0; pw[0] = ph[0] = 4; shp[0] = 0; }
      else if (is16x8) { np = 2; px[0] = px[1] = 0; py[0] = 0; py[1] = 2; pw[0] = pw[1] = 4; ph[0] = ph[1] = 2; shp[0] = 1; shp[1] = 2; }
      else { np = 2; py[0] = py[1] = 0; px[0] = 0; px[1] = 2; pw[0] = pw[1] = 2; ph[0] = ph[1] = 4; shp[0] = 3; shp[1] = 4; }
      for (int k = 0; k < np; k++) pp[k] = slice_type == 0 ? 1 : B_PRED[t][k];
      int refs[2][2];
      for (int l = 0; l < lists; l++)
        for (int k = 0; k < np; k++) {
          int ref = -1;
          if (pp[k] >> l & 1) ref = s->nref[l] > 1 ? dec_ref(d, m, l, px[k], py[k], s->nref[l]) : 0;
          refs[l][k] = ref;
          for (int j = py[k]; j < py[k] + ph[k]; j++) for (int i = px[k]; i < px[k] + pw[k]; i++) m->ref[l][C8(i, j)] = (int8_t)ref;
        }
      for (int l = 0; l < lists; l++)
        for (int k = 0; k < np; k++) {
          if (!(pp[k] >> l & 1)) { set_cells(m, l, px[k], py[k], pw[k], ph[k], -1, 0, 0, 0, 0); continue; }
          int ia = C8(px[k] - 1, py[k]), ib = C8(px[k], py[k] - 1), mx, my;
          int dx = dec_mvd(d, 40, m->mvd[l][ia][0] + m->mvd[l][ib][0]);
          int dy = dec_mvd(d, 47, m->mvd[l][ia][1] + m->mvd[l][ib][1]);
          mvpred(m, l, px[k], py[k], pw[k], refs[l][k], shp[k], &mx, &my);
          set_cells(m, l, px[k], py[k], pw[k], ph[k], refs[l][k], mx + dx, my + dy, iabs(dx), iabs(dy));
        }
      if (d->error) return ERR_DATA;
      for (int k = 0; k < np; k++) mc_part(d, m, px[k], py[k], pw[k], ph[k]);
    }
  }

  /* coded_block_pattern (9.3.3.1.1.4) */
  if (!(m->type & MB_I16)) {
    int la = m->a >= 0 ? d->cbp[m->a] : 0x0F, lb = m->b >= 0 ? d->cbp[m->b] : 0x0F, cbp = 0;
    cbp |= dec_bin(d, 73 + !(la & 2) + 2 * !(lb & 4));
    cbp |= dec_bin(d, 73 + !(cbp & 1) + 2 * !(lb & 8)) << 1;
    cbp |= dec_bin(d, 73 + !(la & 8) + 2 * !(cbp & 1)) << 2;
    cbp |= dec_bin(d, 73 + !(cbp & 4) + 2 * !(cbp & 2)) << 3;
    int ca = m->a >= 0 ? d->cbp[m->a] >> 4 : 0, cb = m->b >= 0 ? d->cbp[m->b] >> 4 : 0;
    if (dec_bin(d, 77 + (ca > 0) + 2 * (cb > 0))) cbp |= (1 + dec_bin(d, 81 + (ca == 2) + 2 * (cb == 2))) << 4;
    m->cbp = cbp;
  }

  if (m->cbp || (m->type & MB_I16)) {
    int ctx = 60 + (d->last_dqp != 0), v = 0;
    while (dec_bin(d, ctx)) { ctx = ctx < 62 ? 62 : 63; if (++v > 104) return ERR_DATA; }
    int dqp = v & 1 ? (v + 1) / 2 : -(v / 2);
    d->last_dqp = dqp;
    *qp = (*qp + dqp + 52) % 52;
    set_chroma_qp(d, *qp);
    residual(d, m, *qp);
  } else {
    d->last_dqp = 0;
    m->cbf = 0;
  }
  if (d->error) return ERR_DATA;

  /* reconstruction */
  if (m->type & MB_I4) intra4x4_recon(d, m);
  else if (m->type & MB_I16) {
    int mode = m->ipred[0];
    memset(m->ipred, 2, 16);
    uint8_t *p = d->cur->y + m->mby * 16 * d->stride + m->mbx * 16;
    pred16x16(p, d->stride, mode, m->ib, m->ia, m->id);
    for (int r = 0; r < 16; r++) add_luma(d, m, r);
  } else if (m->acmask) for (int r = 0; r < 16; r++) add_luma(d, m, r);
  if (IS_INTRA(m->type)) chroma_recon(d, m);
  if (m->cbp >> 4) add_chroma(d, m);
  store_mb(d, m, *qp);
  return ERR_OK;
}
