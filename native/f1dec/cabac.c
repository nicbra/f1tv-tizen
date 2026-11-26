/*
 * CABAC arithmetic decoding (9.3.1.2, 9.3.3.2). codIOffset is kept with `s` further bits of the stream below it:
 * off = codIOffset * 2^s + next s bits. Renormalising then only lowers s (and shifts the range); bytes come in two at
 * a time once fewer than 7 bits are buffered (a decision uses at most 6).
 * Context state: (pStateIdx << 1) | valMPS.
 */
#include "dec.h"
#include "cabac_tables.h"

static uint8_t RENORM[256];   /* left shift that brings a range of 1..255 back to >= 256 */
static uint8_t LPS_ST[128 * 4]; /* rangeTabLPS by context state ((pStateIdx << 1) | valMPS) << 2 | qCodIRangeIdx */
static uint8_t NEXT_MPS[128], NEXT_LPS[128];   /* the state after an MPS / an LPS */

static void cabac_tables_init(void) {
  for (int r = 1; r < 256; r++) { int n = 0; while ((r << n) < 256) n++; RENORM[r] = n; }
  for (int st = 0; st < 128; st++) {
    int p = st >> 1, mps = st & 1;
    for (int q = 0; q < 4; q++) LPS_ST[(st << 2) | q] = LPS_RANGE[p][q];
    NEXT_MPS[st] = (uint8_t)((TRANS_MPS[p] << 1) | mps);
    NEXT_LPS[st] = (uint8_t)((TRANS_LPS[p] << 1) | (p == 0 ? !mps : mps));
  }
}

static inline void cabac_refill(Cabac *c) {
  uint32_t v = 0;
  if (c->p + 1 < c->end) v = (c->p[0] << 8) | c->p[1];
  else if (c->p < c->end) v = c->p[0] << 8;
  c->p += 2;
  c->off = (c->off << 16) | v;
  c->s += 16;
}

static void cabac_start(Cabac *c, const uint8_t *p, const uint8_t *end) {
  c->p = p; c->end = end;
  c->off = 0; c->s = -9;
  cabac_refill(c);   /* 16 bits: codIOffset is the first 9, s = 7 */
  if (c->s < 7) cabac_refill(c);
  c->range = 510;
}

static inline int cabac_decide(Cabac *c, uint8_t *ctx) {
  int st = *ctx;
  uint32_t lps = LPS_ST[(st << 2) | ((c->range >> 6) & 3)];
  uint32_t r = c->range - lps, scaled = r << c->s;
  int bin;
  if (c->off < scaled) {
    bin = st & 1;
    *ctx = NEXT_MPS[st];
    if (r < 256) { r <<= 1; c->s--; }
    c->range = r;
  } else {
    c->off -= scaled;
    bin = !(st & 1);
    *ctx = NEXT_LPS[st];
    int n = RENORM[lps];
    c->range = lps << n;
    c->s -= n;
  }
  if (c->s < 7) cabac_refill(c);
  return bin;
}

static inline int cabac_bypass(Cabac *c) {
  c->s--;
  uint32_t scaled = c->range << c->s;
  int bin = 0;
  if (c->off >= scaled) { c->off -= scaled; bin = 1; }
  if (c->s < 7) cabac_refill(c);
  return bin;
}

static inline int cabac_terminate(Cabac *c) {
  c->range -= 2;
  uint32_t scaled = c->range << c->s;
  if (c->off >= scaled) return 1;
  if (c->range < 256) { c->range <<= 1; c->s--; if (c->s < 7) cabac_refill(c); }
  return 0;
}

/* Byte position of the next unread stream byte after a terminate bin of 1 (I_PCM samples follow). */
static const uint8_t *cabac_pcm_start(Cabac *c) {
  /* The encoder's flush (9.3.4.5) ends exactly where the decoder's 9 offset bits end: stream bits consumed so far
   * are (bytes read) * 8 - s. PCM samples start at the next byte boundary after that. */
  return c->p - (c->s >> 3);
}

static void cabac_init_contexts(Dec *d, int type, int init_idc, int qp) {
  const signed char (*t)[2] = type == 2 ? INIT_I : INIT_PB[init_idc];
  qp = clip3(0, 51, qp);
  for (int i = 0; i < 460; i++) {
    int pre = clip3(1, 126, ((t[i][0] * qp) >> 4) + t[i][1]);
    d->ctx[i] = pre <= 63 ? (uint8_t)((63 - pre) << 1) : (uint8_t)(((pre - 64) << 1) | 1);
  }
}
