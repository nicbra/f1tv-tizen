/* Deblocking filter (8.7), run over the whole picture once all its macroblocks are decoded. */
#include "dec.h"

static const uint8_t ALPHA[52] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15, 17, 20, 22, 25, 28, 32,
  36, 40, 45, 50, 56, 63, 71, 80, 90, 101, 113, 127, 144, 162, 182, 203, 226, 255, 255 };
static const uint8_t BETA[52] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16, 17, 17, 18, 18 };
static const uint8_t TC0[52][3] = { { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 },
  { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 1 }, { 0, 0, 1 }, { 0, 0, 1 },
  { 0, 0, 1 }, { 0, 1, 1 }, { 0, 1, 1 }, { 1, 1, 1 }, { 1, 1, 1 }, { 1, 1, 1 }, { 1, 1, 1 }, { 1, 1, 2 }, { 1, 1, 2 }, { 1, 1, 2 }, { 1, 1, 2 },
  { 1, 2, 3 }, { 1, 2, 3 }, { 2, 2, 3 }, { 2, 2, 4 }, { 2, 3, 4 }, { 2, 3, 4 }, { 3, 3, 5 }, { 3, 4, 6 }, { 3, 4, 6 }, { 4, 5, 7 }, { 4, 5, 8 },
  { 4, 6, 9 }, { 5, 7, 10 }, { 6, 8, 11 }, { 6, 8, 13 }, { 7, 10, 14 }, { 8, 11, 16 }, { 9, 12, 18 }, { 10, 13, 20 }, { 11, 15, 23 }, { 13, 17, 25 } };
static const uint8_t QPC_TAB[52] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39 };

/* One edge segment of 4 luma (or 2 chroma) sample positions; step: between samples across the edge, along: along it. */
static void filter_luma(uint8_t *p, int step, int along, int bs, int alpha, int beta, int tc0) {
  for (int k = 0; k < 4; k++, p += along) {
    int p0 = p[-step], q0 = p[0], p1 = p[-2 * step], q1 = p[step];
    if (iabs(p0 - q0) >= alpha || iabs(p1 - p0) >= beta || iabs(q1 - q0) >= beta) continue;
    int p2 = p[-3 * step], q2 = p[2 * step];
    int ap = iabs(p2 - p0), aq = iabs(q2 - q0);
    if (bs < 4) {
      int tc = tc0 + (ap < beta) + (aq < beta);
      int delta = clip3(-tc, tc, ((q0 - p0) * 4 + (p1 - q1) + 4) >> 3);
      if (ap < beta) p[-2 * step] = (uint8_t)(p1 + clip3(-tc0, tc0, (p2 + ((p0 + q0 + 1) >> 1) - (p1 << 1)) >> 1));
      if (aq < beta) p[step] = (uint8_t)(q1 + clip3(-tc0, tc0, (q2 + ((p0 + q0 + 1) >> 1) - (q1 << 1)) >> 1));
      p[-step] = clip1(p0 + delta); p[0] = clip1(q0 - delta);
    } else {
      int strong = iabs(p0 - q0) < ((alpha >> 2) + 2);
      if (ap < beta && strong) {
        int p3 = p[-4 * step];
        p[-step] = (uint8_t)((p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3);
        p[-2 * step] = (uint8_t)((p2 + p1 + p0 + q0 + 2) >> 2);
        p[-3 * step] = (uint8_t)((2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3);
      } else p[-step] = (uint8_t)((2 * p1 + p0 + q1 + 2) >> 2);
      if (aq < beta && strong) {
        int q3 = p[3 * step];
        p[0] = (uint8_t)((p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3);
        p[step] = (uint8_t)((p0 + q0 + q1 + q2 + 2) >> 2);
        p[2 * step] = (uint8_t)((2 * q3 + 3 * q2 + q1 + q0 + p0 + 4) >> 3);
      } else p[0] = (uint8_t)((2 * q1 + q0 + p1 + 2) >> 2);
    }
  }
}

static void filter_chroma(uint8_t *p, int step, int along, int bs, int alpha, int beta, int tc0) {
  for (int k = 0; k < 2; k++, p += along) {
    int p0 = p[-step], q0 = p[0], p1 = p[-2 * step], q1 = p[step];
    if (iabs(p0 - q0) >= alpha || iabs(p1 - p0) >= beta || iabs(q1 - q0) >= beta) continue;
    if (bs < 4) {
      int tc = tc0 + 1, delta = clip3(-tc, tc, ((q0 - p0) * 4 + (p1 - q1) + 4) >> 3);
      p[-step] = clip1(p0 + delta); p[0] = clip1(q0 - delta);
    } else {
      p[-step] = (uint8_t)((2 * p1 + p0 + q1 + 2) >> 2); p[0] = (uint8_t)((2 * q1 + q0 + p1 + 2) >> 2);
    }
  }
}

/* bS between block bp of MB mp and block bq of MB mq (8.7.2.1), for an edge that is not intra. */
static int mv_bs(Pic *c, int mp, int bp, int mq, int bq) {
  int p0 = c->refpic[mp][0][bp], p1 = c->refpic[mp][1][bp], q0 = c->refpic[mq][0][bq], q1 = c->refpic[mq][1][bq];
  int np = (p0 >= 0) + (p1 >= 0), nq = (q0 >= 0) + (q1 >= 0);
  if (np != nq) return 1;
  const int16_t *a0 = c->mv[mp][0][bp], *a1 = c->mv[mp][1][bp], *b0 = c->mv[mq][0][bq], *b1 = c->mv[mq][1][bq];
#define FAR(u, v) (iabs((u)[0] - (v)[0]) >= 4 || iabs((u)[1] - (v)[1]) >= 4)
  if (np == 1) {
    int rp = p0 >= 0 ? p0 : p1, rq = q0 >= 0 ? q0 : q1;
    if (rp != rq) return 1;
    return FAR(p0 >= 0 ? a0 : a1, q0 >= 0 ? b0 : b1);
  }
  if (!((p0 == q0 && p1 == q1) || (p0 == q1 && p1 == q0))) return 1;
  if (p0 != p1) {
    if (p0 == q0) return FAR(a0, b0) || FAR(a1, b1);
    return FAR(a0, b1) || FAR(a1, b0);
  }
  return (FAR(a0, b0) || FAR(a1, b1)) && (FAR(a0, b1) || FAR(a1, b0));
#undef FAR
}

static void deblock_mb(Dec *d, int addr) {
  Pic *c = d->cur;
  int w = d->mbw, mbx = addr % w, mby = addr / w, sl = d->deblock_of[addr];
  int mode = d->slice_deblock[sl];
  if (mode == 1) return;
  int offA = d->slice_alpha[sl], offB = d->slice_beta[sl];
  int type = d->mbtype[addr], qp = d->qp[addr];
  uint8_t *Y = c->y + mby * 16 * d->stride + mbx * 16;
  uint8_t *U = c->u + mby * 8 * d->cstride + mbx * 8, *V = c->v + mby * 8 * d->cstride + mbx * 8;
  int cq[2];
  for (int k = 0; k < 2; k++) cq[k] = QPC_TAB[clip3(0, 51, qp + d->p->cqp[k])];
  for (int dir = 0; dir < 2; dir++) {   /* 0: vertical edges (left to right), 1: horizontal */
    int nb = dir ? addr - w : addr - 1;
    int has_nb = dir ? mby > 0 : mbx > 0;
    if (has_nb && mode == 2 && d->slice_of[nb] != d->slice_of[addr]) has_nb = 0;
    for (int e = has_nb ? 0 : 1; e < 4; e++) {
      if (e && !((d->bsint[addr][dir] >> (8 * (e - 1))) & 0xFF)) continue;
      int bs[4];
      int any = 0;
      for (int k = 0; k < 4; k++) {
        int bq = dir ? e * 4 + k : k * 4 + e;            /* q block (current MB, raster) */
        int mq = addr, mp = addr, bp;
        if (e == 0) { mp = nb; bp = dir ? 12 + k : k * 4 + 3; }
        else bp = dir ? bq - 4 : bq - 1;
        int v;
        if (e) v = (d->bsint[addr][dir] >> (2 * ((e - 1) * 4 + k))) & 3;
        else if (IS_INTRA(type) || IS_INTRA(d->mbtype[mp])) v = 4;
        else if ((d->cbf[mq] >> bq & 1) || (d->cbf[mp] >> bp & 1)) v = 2;
        else v = mv_bs(c, mp, bp, mq, bq);
        bs[k] = v; any |= v;
      }
      if (!any) continue;
      int qpp = e == 0 ? d->qp[nb] : qp;
      int qav = (qpp + qp + 1) >> 1, ia = clip3(0, 51, qav + offA), ib = clip3(0, 51, qav + offB);
      int alpha = ALPHA[ia], beta = BETA[ib];
      if (alpha && beta) {
        int step = dir ? d->stride : 1, along = dir ? 1 : d->stride;
        for (int k = 0; k < 4; k++) {
          if (!bs[k]) continue;
          uint8_t *p = dir ? Y + e * 4 * d->stride + k * 4 : Y + k * 4 * d->stride + e * 4;
          filter_luma(p, step, along, bs[k], alpha, beta, bs[k] < 4 ? TC0[ia][bs[k] - 1] : 0);
        }
      }
      if (e & 1) continue;   /* chroma edges: luma edges 0 and 2 (4:2:0) */
      for (int ch = 0; ch < 2; ch++) {
        uint8_t *P = ch ? V : U;
        int cqp = e == 0 ? QPC_TAB[clip3(0, 51, d->qp[nb] + d->p->cqp[ch])] : cq[ch];
        int cav = (cqp + cq[ch] + 1) >> 1, ca = clip3(0, 51, cav + offA), cb = clip3(0, 51, cav + offB);
        int calpha = ALPHA[ca], cbeta = BETA[cb];
        if (!calpha || !cbeta) continue;
        int step = dir ? d->cstride : 1, along = dir ? 1 : d->cstride;
        for (int k = 0; k < 4; k++) {
          if (!bs[k]) continue;
          uint8_t *p = dir ? P + (e / 2) * 4 * d->cstride + k * 2 : P + k * 2 * d->cstride + (e / 2) * 4;
          filter_chroma(p, step, along, bs[k], calpha, cbeta, bs[k] < 4 ? TC0[ca][bs[k] - 1] : 0);
        }
      }
    }
  }
}

static void deblock_picture(Dec *d) {
  for (int a = 0; a < d->nmb; a++) deblock_mb(d, a);
}
