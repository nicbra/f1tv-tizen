/* Reconstruction: inverse transforms (8.5.10-8.5.12), intra prediction (8.3), inter prediction (8.4.2). */
#include "dec.h"

static const uint8_t ZIGZAG[16] = { 0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15 };
static const uint8_t NORM[6][3] = { { 10, 16, 13 }, { 11, 18, 14 }, { 13, 20, 16 }, { 14, 23, 18 }, { 16, 25, 20 }, { 18, 29, 23 } };
static int32_t DQ[52][16];   /* d = c * DQ[qp][raster position] (flat scaling, 8.5.12.1) */

static void recon_tables_init(void) {
  for (int q = 0; q < 52; q++)
    for (int k = 0; k < 16; k++) {
      int i = k >> 2, j = k & 3, cls = (i & 1) == 0 && (j & 1) == 0 ? 0 : (i & 1) && (j & 1) ? 1 : 2;
      DQ[q][k] = NORM[q % 6][cls] << (q / 6);
    }
}

/* 4x4 inverse transform of d (raster), added to the prediction at p. */
static void idct4_add(uint8_t *p, int stride, int32_t *d) {
  int32_t f[16];
  for (int i = 0; i < 4; i++) {
    const int32_t *r = d + 4 * i;
    int e0 = r[0] + r[2], e1 = r[0] - r[2], e2 = (r[1] >> 1) - r[3], e3 = r[1] + (r[3] >> 1);
    f[4 * i] = e0 + e3; f[4 * i + 1] = e1 + e2; f[4 * i + 2] = e1 - e2; f[4 * i + 3] = e0 - e3;
  }
  for (int j = 0; j < 4; j++) {
    int g0 = f[j] + f[8 + j], g1 = f[j] - f[8 + j], g2 = (f[4 + j] >> 1) - f[12 + j], g3 = f[4 + j] + (f[12 + j] >> 1);
    p[j] = clip1(p[j] + ((g0 + g3 + 32) >> 6));
    p[stride + j] = clip1(p[stride + j] + ((g1 + g2 + 32) >> 6));
    p[2 * stride + j] = clip1(p[2 * stride + j] + ((g1 - g2 + 32) >> 6));
    p[3 * stride + j] = clip1(p[3 * stride + j] + ((g0 - g3 + 32) >> 6));
  }
}

static void dc_add(uint8_t *p, int stride, int dc) {
  int v = (dc + 32) >> 6;
  if (!v) return;
  for (int y = 0; y < 4; y++, p += stride)
    for (int x = 0; x < 4; x++) p[x] = clip1(p[x] + v);
}

/* Intra_16x16 DC: c (raster 4x4 of the DC levels) -> the 16 blocks' DC values, spatial order (8.5.10). */
static void luma_dc(int32_t *c, int qp, int32_t *dc) {
  int32_t f[16];
  for (int i = 0; i < 4; i++) {
    int32_t *r = c + 4 * i;
    int a = r[0] + r[1], b = r[0] - r[1], x = r[2] + r[3], y = r[2] - r[3];
    f[4 * i] = a + x; f[4 * i + 1] = a - x; f[4 * i + 2] = b - y; f[4 * i + 3] = b + y;
  }
  int ls = 16 * NORM[qp % 6][0], q6 = qp / 6;
  for (int j = 0; j < 4; j++) {
    int a = f[j] + f[4 + j], b = f[j] - f[4 + j], x = f[8 + j] + f[12 + j], y = f[8 + j] - f[12 + j];
    int v[4] = { a + x, a - x, b - y, b + y };
    for (int i = 0; i < 4; i++)
      dc[4 * i + j] = qp >= 36 ? v[i] * ls * (1 << (q6 - 6)) : (v[i] * ls + (1 << (5 - q6))) >> (6 - q6);
  }
}

/* Chroma DC (2x2, 4:2:0): c[4] raster -> DC of blocks 0..3 (8.5.11). */
static void chroma_dc(int32_t *c, int qp, int32_t *dc) {
  int a = c[0] + c[1], b = c[0] - c[1], x = c[2] + c[3], y = c[2] - c[3];
  int f[4] = { a + x, b + y, a - x, b - y };
  int ls = 16 * NORM[qp % 6][0];
  for (int i = 0; i < 4; i++) dc[i] = (f[i] * ls * (1 << (qp / 6))) >> 5;
}

/* ---------------------------------------------------------------- intra prediction */

/* Intra_4x4 (8.3.1.2). t[0] = p[-1,-1], t[1..8] = p[0..7,-1]; l[0] = p[-1,-1], l[1..4] = p[-1,0..3]. */
static void pred4x4(uint8_t *p, int stride, int mode, const int *t, const int *l, int hasL, int hasT) {
#define T(x) t[(x) + 1]
#define L(y) l[(y) + 1]
#define P(x, y) p[(y) * stride + (x)]
  int x, y;
  switch (mode) {
  case 0: for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) P(x, y) = T(x); break;
  case 1: for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) P(x, y) = L(y); break;
  case 2: {
    int s;
    if (hasL && hasT) s = (T(0) + T(1) + T(2) + T(3) + L(0) + L(1) + L(2) + L(3) + 4) >> 3;
    else if (hasL) s = (L(0) + L(1) + L(2) + L(3) + 2) >> 2;
    else if (hasT) s = (T(0) + T(1) + T(2) + T(3) + 2) >> 2;
    else s = 128;
    for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) P(x, y) = s;
    break;
  }
  case 3:
    for (y = 0; y < 4; y++) for (x = 0; x < 4; x++)
      P(x, y) = x == 3 && y == 3 ? (T(6) + 3 * T(7) + 2) >> 2 : (T(x + y) + 2 * T(x + y + 1) + T(x + y + 2) + 2) >> 2;
    break;
  case 4:
    for (y = 0; y < 4; y++) for (x = 0; x < 4; x++)
      P(x, y) = x > y ? (T(x - y - 2) + 2 * T(x - y - 1) + T(x - y) + 2) >> 2
              : x < y ? (L(y - x - 2) + 2 * L(y - x - 1) + L(y - x) + 2) >> 2
              : (T(0) + 2 * T(-1) + L(0) + 2) >> 2;
    break;
  case 5:
    for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) {
      int z = 2 * x - y;
      if (z >= 0 && !(z & 1)) P(x, y) = (T(x - (y >> 1) - 1) + T(x - (y >> 1)) + 1) >> 1;
      else if (z > 0) P(x, y) = (T(x - (y >> 1) - 2) + 2 * T(x - (y >> 1) - 1) + T(x - (y >> 1)) + 2) >> 2;
      else if (z == -1) P(x, y) = (L(0) + 2 * L(-1) + T(0) + 2) >> 2;
      else P(x, y) = (L(y - 1) + 2 * L(y - 2) + L(y - 3) + 2) >> 2;
    }
    break;
  case 6:
    for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) {
      int z = 2 * y - x;
      if (z >= 0 && !(z & 1)) P(x, y) = (L(y - (x >> 1) - 1) + L(y - (x >> 1)) + 1) >> 1;
      else if (z > 0) P(x, y) = (L(y - (x >> 1) - 2) + 2 * L(y - (x >> 1) - 1) + L(y - (x >> 1)) + 2) >> 2;
      else if (z == -1) P(x, y) = (L(0) + 2 * L(-1) + T(0) + 2) >> 2;
      else P(x, y) = (T(x - 1) + 2 * T(x - 2) + T(x - 3) + 2) >> 2;
    }
    break;
  case 7:
    for (y = 0; y < 4; y++) for (x = 0; x < 4; x++)
      P(x, y) = !(y & 1) ? (T(x + (y >> 1)) + T(x + (y >> 1) + 1) + 1) >> 1
              : (T(x + (y >> 1)) + 2 * T(x + (y >> 1) + 1) + T(x + (y >> 1) + 2) + 2) >> 2;
    break;
  default:
    for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) {
      int z = x + 2 * y;
      if (z > 5) P(x, y) = L(3);
      else if (z == 5) P(x, y) = (L(2) + 3 * L(3) + 2) >> 2;
      else if (z & 1) P(x, y) = (L(y + (x >> 1)) + 2 * L(y + (x >> 1) + 1) + L(y + (x >> 1) + 2) + 2) >> 2;
      else P(x, y) = (L(y + (x >> 1)) + L(y + (x >> 1) + 1) + 1) >> 1;
    }
  }
#undef T
#undef L
#undef P
}

/* Intra_16x16 (8.3.3) and chroma (8.3.4, size 8): p is the block, top row p - stride, left column p - 1. */
static void pred_plane(uint8_t *p, int stride, int n, int hasT, int hasL, int hasD) {
  (void)hasT; (void)hasL; (void)hasD;
  const uint8_t *top = p - stride;
  int h = 0, v = 0, half = n / 2;
  for (int i = 0; i < half; i++) {
    h += (i + 1) * (top[half + i] - (i == half - 1 ? top[-1] : top[half - 2 - i]));
    v += (i + 1) * (p[(half + i) * stride - 1] - (i == half - 1 ? top[-1] : p[(half - 2 - i) * stride - 1]));
  }
  int a = 16 * (p[(n - 1) * stride - 1] + top[n - 1]), b, c;
  if (n == 16) { b = (5 * h + 32) >> 6; c = (5 * v + 32) >> 6; }
  else { b = (34 * h + 32) >> 6; c = (34 * v + 32) >> 6; }
  for (int y = 0; y < n; y++)
    for (int x = 0; x < n; x++) p[y * stride + x] = clip1((a + b * (x - (half - 1)) + c * (y - (half - 1)) + 16) >> 5);
}

static void pred16x16(uint8_t *p, int stride, int mode, int hasT, int hasL, int hasD) {
  int x, y;
  if (mode == 0) { for (y = 0; y < 16; y++) memcpy(p + y * stride, p - stride, 16); }
  else if (mode == 1) { for (y = 0; y < 16; y++) memset(p + y * stride, p[y * stride - 1], 16); }
  else if (mode == 2) {
    int s = 0;
    if (hasT) for (x = 0; x < 16; x++) s += p[x - stride];
    if (hasL) for (y = 0; y < 16; y++) s += p[y * stride - 1];
    s = hasT && hasL ? (s + 16) >> 5 : hasT || hasL ? (s + 8) >> 4 : 128;
    for (y = 0; y < 16; y++) memset(p + y * stride, s, 16);
  } else pred_plane(p, stride, 16, hasT, hasL, hasD);
}

static void pred_chroma(uint8_t *p, int stride, int mode, int hasT, int hasL, int hasD) {
  int x, y;
  if (mode == 0) {
    for (int b = 0; b < 4; b++) {
      int bx = (b & 1) * 4, by = (b >> 1) * 4, st = 0, sl = 0, s;
      uint8_t *q = p + by * stride + bx;
      for (x = 0; x < 4; x++) st += hasT ? q[x - by * stride - stride] : 0;
      for (y = 0; y < 4; y++) sl += hasL ? q[y * stride - bx - 1] : 0;
      if (b == 0 || b == 3) s = hasT && hasL ? (st + sl + 4) >> 3 : hasL ? (sl + 2) >> 2 : hasT ? (st + 2) >> 2 : 128;
      else if (b == 1) s = hasT ? (st + 2) >> 2 : hasL ? (sl + 2) >> 2 : 128;
      else s = hasL ? (sl + 2) >> 2 : hasT ? (st + 2) >> 2 : 128;
      for (y = 0; y < 4; y++) memset(q + y * stride, s, 4);
    }
  } else if (mode == 1) { for (y = 0; y < 8; y++) memset(p + y * stride, p[y * stride - 1], 8); }
  else if (mode == 2) { for (y = 0; y < 8; y++) memcpy(p + y * stride, p - stride, 8); }
  else pred_plane(p, stride, 8, hasT, hasL, hasD);
}

/* ---------------------------------------------------------------- inter prediction
 * Luma (8.4.2.2.1) per block width (16, 8, 4: fixed, so loops unroll), writing to any stride. A quarter position is
 * one filter pass that averages with the neighbouring full or half sample on the fly. Averages and weights go four
 * samples to a 32-bit word (the TV's WebAssembly has no SIMD).
 */

#define TAP6(a, b, c, d, e, f) ((a) - 5 * ((b) + (e)) + 20 * ((c) + (d)) + (f))

static inline uint32_t ld32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static inline void st32(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }
static inline uint32_t avg4(uint32_t a, uint32_t b) { return (a | b) - (((a ^ b) >> 1) & 0x7F7F7F7Fu); }

/*
 * Two samples per 32-bit word in 16-bit lanes (even bytes, odd bytes): a 6-tap sum plus 2576 (= 80 * 32 + 16)
 * stays within 26..13286, so the lanes never borrow; (lane >> 5) - 80 is then (sum + 16) >> 5.
 */
#define M8 0x00FF00FFu
#define BIAS6 0x0A100A10u
static inline uint32_t tap2(uint32_t a, uint32_t b, uint32_t c, uint32_t d, uint32_t e, uint32_t f) {
  return a + f + 20 * (c + d) + BIAS6 - 5 * (b + e);
}
static inline uint32_t clip_lane(uint32_t lane) { int v = (int)(lane >> 5) - 80; return v < 0 ? 0 : v > 255 ? 255 : (uint32_t)v; }
/* the four results of even lanes (outputs 0, 2) and odd lanes (1, 3) as one word */
static inline uint32_t pack4(uint32_t ev, uint32_t od) {
  return clip_lane(ev & 0xFFFF) | (clip_lane(od & 0xFFFF) << 8) | (clip_lane(ev >> 16) << 16) | (clip_lane(od >> 16) << 24);
}

#define DEF_FILTERS(W)                                                                                                   \
static void copy##W(uint8_t *d, int ds, const uint8_t *s, int ss, int h) {                                         \
  for (int y = 0; y < h; y++, d += ds, s += ss) for (int x = 0; x < W; x += 4) st32(d + x, ld32(s + x));            \
}                                                                                                                     \
/* horizontal half sample b; av: average with it (quarter positions) */                                            \
static void h6_##W(uint8_t *d, int ds, const uint8_t *s, int ss, int h, const uint8_t *av, int as) {               \
  for (int y = 0; y < h; y++, d += ds, s += ss) {                                                                   \
    const uint8_t *r = s - 2;                                                                                        \
    uint32_t w0 = ld32(r), w1 = ld32(r + 4);                                                                         \
    for (int x = 0; x < W; x += 4) {                                                                                 \
      uint32_t w2 = ld32(r + x + 8);                                                                                 \
      uint32_t A = w0 & M8, B = (w0 >> 8) & M8, C = ((w0 >> 16) | (w1 << 16)) & M8, D = ((w0 >> 24) | (w1 << 8)) & M8; \
      uint32_t E = w1 & M8, F = (w1 >> 8) & M8, G = ((w1 >> 16) | (w2 << 16)) & M8;                                 \
      uint32_t out = pack4(tap2(A, B, C, D, E, F), tap2(B, C, D, E, F, G));                                         \
      if (av) out = avg4(out, ld32(av + x));                                                                         \
      st32(d + x, out);                                                                                              \
      w0 = w1; w1 = w2;                                                                                              \
    }                                                                                                                \
    if (av) av += as;                                                                                                \
  }                                                                                                                  \
}                                                                                                                     \
/* vertical half sample h: four columns at a time, rows sliding down */                                            \
static void v6_##W(uint8_t *d, int ds, const uint8_t *s, int ss, int h, const uint8_t *av, int as) {               \
  for (int x = 0; x < W; x += 4) {                                                                                   \
    const uint8_t *c = s + x;                                                                                        \
    uint32_t r0 = ld32(c - 2 * ss), r1 = ld32(c - ss), r2 = ld32(c), r3 = ld32(c + ss), r4 = ld32(c + 2 * ss);       \
    for (int y = 0; y < h; y++) {                                                                                    \
      uint32_t r5 = ld32(c + (y + 3) * ss);                                                                          \
      uint32_t ev = tap2(r0 & M8, r1 & M8, r2 & M8, r3 & M8, r4 & M8, r5 & M8);                                      \
      uint32_t od = tap2((r0 >> 8) & M8, (r1 >> 8) & M8, (r2 >> 8) & M8, (r3 >> 8) & M8, (r4 >> 8) & M8, (r5 >> 8) & M8); \
      uint32_t out = pack4(ev, od);                                                                                  \
      if (av) out = avg4(out, ld32(av + y * as + x));                                                                \
      st32(d + y * ds + x, out);                                                                                     \
      r0 = r1; r1 = r2; r2 = r3; r3 = r4; r4 = r5;                                                                   \
    }                                                                                                                \
  }                                                                                                                  \
}                                                                                                                     \
/* centre j: vertical sums (unrounded, two to a word) of W + 5 columns, then horizontal over them */                 \
static void hv6_##W(uint8_t *d, int ds, const uint8_t *s, int ss, int h, const uint8_t *av, int as) {              \
  int32_t tmp[W + 8];                                                                                                \
  for (int y = 0; y < h; y++, d += ds, s += ss) {                                                                   \
    const uint8_t *r = s - 2;                                                                                        \
    for (int x = 0; x < W + 8; x += 4) {                                                                             \
      const uint8_t *c = r + x;                                                                                      \
      uint32_t r0 = ld32(c - 2 * ss), r1 = ld32(c - ss), r2 = ld32(c), r3 = ld32(c + ss), r4 = ld32(c + 2 * ss), r5 = ld32(c + 3 * ss); \
      uint32_t ev = tap2(r0 & M8, r1 & M8, r2 & M8, r3 & M8, r4 & M8, r5 & M8);                                      \
      uint32_t od = tap2((r0 >> 8) & M8, (r1 >> 8) & M8, (r2 >> 8) & M8, (r3 >> 8) & M8, (r4 >> 8) & M8, (r5 >> 8) & M8); \
      tmp[x] = (int32_t)(ev & 0xFFFF) - 2576; tmp[x + 1] = (int32_t)(od & 0xFFFF) - 2576;                            \
      tmp[x + 2] = (int32_t)(ev >> 16) - 2576; tmp[x + 3] = (int32_t)(od >> 16) - 2576;                              \
    }                                                                                                                \
    int a = tmp[0], b = tmp[1], c = tmp[2], e = tmp[3], f = tmp[4];                                                  \
    for (int x = 0; x < W; x += 4) {                                                                                 \
      uint32_t out = 0;                                                                                              \
      for (int k = 0; k < 4; k++) {                                                                                  \
        int g = tmp[x + k + 5];                                                                                      \
        int v = (a - 5 * (b + f) + 20 * (c + e) + g + 512) >> 10;                                                    \
        out |= (uint32_t)(v < 0 ? 0 : v > 255 ? 255 : v) << (8 * k);                                               \
        a = b; b = c; c = e; e = f; f = g;                                                                           \
      }                                                                                                              \
      if (av) out = avg4(out, ld32(av + x));                                                                         \
      st32(d + x, out);                                                                                              \
    }                                                                                                                \
    if (av) av += as;                                                                                                \
  }                                                                                                                  \
}                                                                                                                     \

#define DEF_SWITCH(W)                                                                                                  \
static void luma##W(uint8_t *d, int ds, const uint8_t *s, int ss, int fx, int fy, int h) {                         \
  uint8_t t[16 * W];                                                                                                 \
  switch (fx + 4 * fy) {                                                                                             \
  case 0: copy##W(d, ds, s, ss, h); break;                                                                          \
  case 1: h6_##W(d, ds, s, ss, h, s, ss); break;                                                                    \
  case 2: h6_##W(d, ds, s, ss, h, NULL, 0); break;                                                                  \
  case 3: h6_##W(d, ds, s, ss, h, s + 1, ss); break;                                                                \
  case 4: v6_##W(d, ds, s, ss, h, s, ss); break;                                                                    \
  case 8: v6_##W(d, ds, s, ss, h, NULL, 0); break;                                                                  \
  case 12: v6_##W(d, ds, s, ss, h, s + ss, ss); break;                                                              \
  case 10: hv6_##W(d, ds, s, ss, h, NULL, 0); break;                                                                \
  case 5: h6_##W(t, W, s, ss, h, NULL, 0); v6_##W(d, ds, s, ss, h, t, W); break;            /* e = (b + h) */       \
  case 7: h6_##W(t, W, s, ss, h, NULL, 0); v6_##W(d, ds, s + 1, ss, h, t, W); break;        /* g = (b + m) */       \
  case 13: h6_##W(t, W, s + ss, ss, h, NULL, 0); v6_##W(d, ds, s, ss, h, t, W); break;      /* p = (h + s) */       \
  case 15: h6_##W(t, W, s + ss, ss, h, NULL, 0); v6_##W(d, ds, s + 1, ss, h, t, W); break;  /* r = (m + s) */       \
  case 6: h6_##W(t, W, s, ss, h, NULL, 0); hv6_##W(d, ds, s, ss, h, t, W); break;           /* f = (b + j) */       \
  case 14: h6_##W(t, W, s + ss, ss, h, NULL, 0); hv6_##W(d, ds, s, ss, h, t, W); break;     /* q = (j + s) */       \
  case 9: v6_##W(t, W, s, ss, h, NULL, 0); hv6_##W(d, ds, s, ss, h, t, W); break;           /* i = (h + j) */       \
  default: v6_##W(t, W, s + 1, ss, h, NULL, 0); hv6_##W(d, ds, s, ss, h, t, W); break;      /* k = (j + m) */       \
  }                                                                                                                  \
}

#ifdef __wasm_simd128__
/*
 * WebAssembly SIMD (Tizen 7+, Chromium 91+; this build is chosen where the TV has it): 8 samples a step in 16-bit lanes
 * (the 6-tap sums fit: -2550..10710), the centre's second pass in 32-bit lanes; narrowing saturates = clip1.
 */
#include <wasm_simd128.h>
static inline v128_t w8(const uint8_t *p) { return wasm_u16x8_extend_low_u8x16(wasm_v128_load64_zero(p)); }
static inline v128_t tap8(v128_t a, v128_t b, v128_t c, v128_t d, v128_t e, v128_t f) {
  return wasm_i16x8_add(wasm_i16x8_sub(wasm_i16x8_add(a, f), wasm_i16x8_mul(wasm_i16x8_add(b, e), wasm_i16x8_splat(5))),
    wasm_i16x8_mul(wasm_i16x8_add(c, d), wasm_i16x8_splat(20)));
}
static inline v128_t half8(v128_t t) { v128_t r = wasm_i16x8_shr(wasm_i16x8_add(t, wasm_i16x8_splat(16)), 5); return wasm_u8x16_narrow_i16x8(r, r); }
static inline void out8(uint8_t *d, v128_t r, const uint8_t *av) {
  if (av) r = wasm_u8x16_avgr(r, wasm_v128_load64_zero(av));
  wasm_v128_store64_lane(d, r, 0);
}
#define DEF_SIMD(W)                                                                                                    \
static void copy##W(uint8_t *d, int ds, const uint8_t *s, int ss, int h) {                                         \
  for (int y = 0; y < h; y++, d += ds, s += ss) for (int x = 0; x < W; x += 8) wasm_v128_store64_lane(d + x, wasm_v128_load64_zero(s + x), 0); \
}                                                                                                                     \
static void h6_##W(uint8_t *d, int ds, const uint8_t *s, int ss, int h, const uint8_t *av, int as) {               \
  for (int y = 0; y < h; y++, d += ds, s += ss, av = av ? av + as : av)                                             \
    for (int x = 0; x < W; x += 8)                                                                                   \
      out8(d + x, half8(tap8(w8(s + x - 2), w8(s + x - 1), w8(s + x), w8(s + x + 1), w8(s + x + 2), w8(s + x + 3))), av ? av + x : NULL); \
}                                                                                                                     \
static void v6_##W(uint8_t *d, int ds, const uint8_t *s, int ss, int h, const uint8_t *av, int as) {               \
  for (int x = 0; x < W; x += 8) {                                                                                   \
    const uint8_t *c = s + x;                                                                                        \
    v128_t r0 = w8(c - 2 * ss), r1 = w8(c - ss), r2 = w8(c), r3 = w8(c + ss), r4 = w8(c + 2 * ss);                   \
    for (int y = 0; y < h; y++) {                                                                                    \
      v128_t r5 = w8(c + (y + 3) * ss);                                                                              \
      out8(d + y * ds + x, half8(tap8(r0, r1, r2, r3, r4, r5)), av ? av + y * as + x : NULL);                       \
      r0 = r1; r1 = r2; r2 = r3; r3 = r4; r4 = r5;                                                                   \
    }                                                                                                                \
  }                                                                                                                  \
}                                                                                                                     \
static void hv6_##W(uint8_t *d, int ds, const uint8_t *s, int ss, int h, const uint8_t *av, int as) {              \
  int16_t tmp[W + 16];                                                                                               \
  for (int y = 0; y < h; y++, d += ds, s += ss, av = av ? av + as : av) {                                           \
    const uint8_t *r = s - 2;                                                                                        \
    for (int x = 0; x < W + 8; x += 8)                                                                               \
      wasm_v128_store(tmp + x, tap8(w8(r + x - 2 * ss), w8(r + x - ss), w8(r + x), w8(r + x + ss), w8(r + x + 2 * ss), w8(r + x + 3 * ss))); \
    for (int x = 0; x < W; x += 8) {                                                                                 \
      v128_t a = wasm_v128_load(tmp + x), b = wasm_v128_load(tmp + x + 1), c = wasm_v128_load(tmp + x + 2);          \
      v128_t e = wasm_v128_load(tmp + x + 3), f = wasm_v128_load(tmp + x + 4), g = wasm_v128_load(tmp + x + 5);      \
      v128_t lo = wasm_i32x4_add(wasm_i32x4_sub(wasm_i32x4_add(wasm_i32x4_extend_low_i16x8(a), wasm_i32x4_extend_low_i16x8(g)),      \
          wasm_i32x4_mul(wasm_i32x4_add(wasm_i32x4_extend_low_i16x8(b), wasm_i32x4_extend_low_i16x8(f)), wasm_i32x4_splat(5))),       \
        wasm_i32x4_mul(wasm_i32x4_add(wasm_i32x4_extend_low_i16x8(c), wasm_i32x4_extend_low_i16x8(e)), wasm_i32x4_splat(20)));        \
      v128_t hi = wasm_i32x4_add(wasm_i32x4_sub(wasm_i32x4_add(wasm_i32x4_extend_high_i16x8(a), wasm_i32x4_extend_high_i16x8(g)),    \
          wasm_i32x4_mul(wasm_i32x4_add(wasm_i32x4_extend_high_i16x8(b), wasm_i32x4_extend_high_i16x8(f)), wasm_i32x4_splat(5))),     \
        wasm_i32x4_mul(wasm_i32x4_add(wasm_i32x4_extend_high_i16x8(c), wasm_i32x4_extend_high_i16x8(e)), wasm_i32x4_splat(20)));      \
      lo = wasm_i32x4_shr(wasm_i32x4_add(lo, wasm_i32x4_splat(512)), 10); hi = wasm_i32x4_shr(wasm_i32x4_add(hi, wasm_i32x4_splat(512)), 10); \
      v128_t v = wasm_i16x8_narrow_i32x4(lo, hi);                                                                    \
      out8(d + x, wasm_u8x16_narrow_i16x8(v, v), av ? av + x : NULL);                                                \
    }                                                                                                                \
  }                                                                                                                  \
}
DEF_SIMD(16)
DEF_SIMD(8)
DEF_FILTERS(4)
#else
DEF_FILTERS(16)
DEF_FILTERS(8)
DEF_FILTERS(4)
#endif
DEF_SWITCH(16)
DEF_SWITCH(8)
DEF_SWITCH(4)

static void luma_mc(uint8_t *d, int ds, const uint8_t *s, int ss, int fx, int fy, int w, int h) {
  if (w == 16) luma16(d, ds, s, ss, fx, fy, h);
  else if (w == 8) luma8(d, ds, s, ss, fx, fy, h);
  else luma4(d, ds, s, ss, fx, fy, h);
}

/* Chroma (8.4.2.2.2), eighth samples; widths 8, 4, 2. Four samples at a time in two 16-bit lanes (weights sum to 64:
 * at most 255 * 64 + 32 per lane). */
static void chroma_mc(uint8_t *d, int ds, const uint8_t *s, int ss, int fx, int fy, int w, int h) {
  if (!fx && !fy) {
    for (int y = 0; y < h; y++, d += ds, s += ss) memcpy(d, s, w);
    return;
  }
  uint32_t A = (8 - fx) * (8 - fy), B = fx * (8 - fy), C = (8 - fx) * fy, D = fx * fy;
#ifdef __wasm_simd128__
  if (w == 8) {
    v128_t a = wasm_i16x8_splat(A), b = wasm_i16x8_splat(B), c = wasm_i16x8_splat(C), e = wasm_i16x8_splat(D), r32 = wasm_i16x8_splat(32);
    for (int y = 0; y < h; y++, d += ds, s += ss) {
      v128_t t = wasm_i16x8_add(wasm_i16x8_add(wasm_i16x8_mul(a, w8(s)), wasm_i16x8_mul(b, w8(s + 1))),
        wasm_i16x8_add(wasm_i16x8_mul(c, w8(s + ss)), wasm_i16x8_mul(e, w8(s + ss + 1))));
      t = wasm_u16x8_shr(wasm_i16x8_add(t, r32), 6);
      wasm_v128_store64_lane(d, wasm_u8x16_narrow_i16x8(t, t), 0);
    }
    return;
  }
#endif
  for (int y = 0; y < h; y++, d += ds, s += ss) {
    int x = 0;
    for (; x + 4 <= w; x += 4) {
      uint32_t p = ld32(s + x), q = ld32(s + x + 1), r = ld32(s + ss + x), t = ld32(s + ss + x + 1);
      uint32_t ev = ((A * (p & M8) + B * (q & M8) + C * (r & M8) + D * (t & M8) + 0x00200020u) >> 6) & M8;
      uint32_t od = ((A * ((p >> 8) & M8) + B * ((q >> 8) & M8) + C * ((r >> 8) & M8) + D * ((t >> 8) & M8) + 0x00200020u) >> 6) & M8;
      st32(d + x, ev | (od << 8));
    }
    for (; x < w; x++) d[x] = (uint8_t)((A * s[x] + B * s[x + 1] + C * s[x + ss] + D * s[x + ss + 1] + 32) >> 6);
  }
}

/* d = (d + s + 1) >> 1 */
static void avg_block(uint8_t *d, int ds, const uint8_t *s, int ss, int w, int h) {
  for (int y = 0; y < h; y++, d += ds, s += ss) {
    int x = 0;
#ifdef __wasm_simd128__
    for (; x + 8 <= w; x += 8) wasm_v128_store64_lane(d + x, wasm_u8x16_avgr(wasm_v128_load64_zero(d + x), wasm_v128_load64_zero(s + x)), 0);
#endif
    for (; x + 4 <= w; x += 4) st32(d + x, avg4(ld32(d + x), ld32(s + x)));
    for (; x < w; x++) d[x] = (d[x] + s[x] + 1) >> 1;
  }
}

/* Implicit bi-prediction weights (8.4.2.3): d = (d * w0 + s * w1 + 32) >> 6, w0 + w1 = 64. With both weights in
 * 0..64 the result needs no clipping and two samples fit one 32-bit word per multiply. */
static void weight_block(uint8_t *d, int ds, const uint8_t *s, int ss, int w, int h, int w1) {
  int w0 = 64 - w1;
  if (w1 >= 0 && w1 <= 64) {
    for (int y = 0; y < h; y++, d += ds, s += ss) {
      int x = 0;
#ifdef __wasm_simd128__
      for (; x + 8 <= w; x += 8) {
        v128_t t = wasm_i16x8_add(wasm_i16x8_add(wasm_i16x8_mul(w8(d + x), wasm_i16x8_splat(w0)), wasm_i16x8_mul(w8(s + x), wasm_i16x8_splat(w1))), wasm_i16x8_splat(32));
        t = wasm_u16x8_shr(t, 6);
        wasm_v128_store64_lane(d + x, wasm_u8x16_narrow_i16x8(t, t), 0);
      }
#endif
      for (; x + 4 <= w; x += 4) {
        uint32_t a = ld32(d + x), b = ld32(s + x);
        uint32_t lo = ((a & 0x00FF00FFu) * w0 + (b & 0x00FF00FFu) * w1 + 0x00200020u) >> 6;
        uint32_t hi = (((a >> 8) & 0x00FF00FFu) * w0 + ((b >> 8) & 0x00FF00FFu) * w1 + 0x00200020u) >> 6;
        st32(d + x, (lo & 0x00FF00FFu) | ((hi & 0x00FF00FFu) << 8));
      }
      for (; x < w; x++) d[x] = (uint8_t)((d[x] * w0 + s[x] * w1 + 32) >> 6);
    }
  } else {
    for (int y = 0; y < h; y++, d += ds, s += ss) for (int x = 0; x < w; x++) d[x] = clip1((d[x] * w0 + s[x] * w1 + 32) >> 6);
  }
}
