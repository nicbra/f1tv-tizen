/* Bit reading, parameter sets and slice headers (7.3, 7.4). */
#include "dec.h"

static inline uint32_t bits_u(Bits *b, int n) {
  uint32_t v = 0;
  while (n-- > 0) {
    int p = b->pos++;
    v = (v << 1) | (p < b->len ? (b->a[p >> 3] >> (7 - (p & 7))) & 1 : 0);
  }
  return v;
}
static inline int bits_ue(Bits *b) {
  int z = 0;
  while (!bits_u(b, 1)) { if (++z > 30 || b->pos > b->len) return -1; }   /* (no syntax element needs 2^31 or more) */
  return z ? (int)((1u << z) - 1 + bits_u(b, z)) : 0;
}
static inline int bits_se(Bits *b) {
  int k = bits_ue(b);
  return k & 1 ? (k + 1) / 2 : -(k / 2);
}
static int bits_more(Bits *b) {   /* more_rbsp_data() */
  int last = b->len - 1;
  while (last >= 0 && !((b->a[last >> 3] >> (7 - (last & 7))) & 1)) last--;
  return b->pos < last;
}

/* NAL payload without emulation prevention bytes, followed by zero padding for the CABAC reader. */
static int unescape(Dec *d, const uint8_t *src, int n) {
  if (d->rbsp_cap < n + 64) {
    free(d->rbsp);
    d->rbsp_cap = n + 64 + n / 4;
    d->rbsp = (uint8_t *)malloc(d->rbsp_cap);
    if (!d->rbsp) { d->rbsp_cap = 0; return -1; }
  }
  int o = 0, zeros = 0;
  for (int i = 0; i < n; i++) {
    if (zeros >= 2 && src[i] == 3) { zeros = 0; continue; }
    d->rbsp[o++] = src[i];
    zeros = src[i] ? 0 : zeros + 1;
  }
  memset(d->rbsp + o, 0, 32);
  return o;
}

static int skip_scaling_list(Bits *b, int size) {
  int last = 8, next = 8;
  for (int j = 0; j < size; j++) {
    if (next) { next = (last + bits_se(b) + 256) % 256; if (j == 0 && next == 0) return 0; }
    if (next) last = next;
    else return 1;
  }
  return 1;
}

static int parse_sps(Dec *d, Bits *b) {
  Sps t;
  memset(&t, 0, sizeof t);
  t.profile = bits_u(b, 8);
  bits_u(b, 8);
  t.level = bits_u(b, 8);
  int id = bits_ue(b);
  if (id < 0 || id > 31) return ERR_DATA;
  int p = t.profile;
  if (p == 100 || p == 110 || p == 122 || p == 244 || p == 44 || p == 83 || p == 86 || p == 118 || p == 128 || p == 138 || p == 139 || p == 134 || p == 135) {
    int cf = bits_ue(b);
    if (cf != 1) return ERR_UNSUPPORTED;
    if (bits_ue(b) != 0 || bits_ue(b) != 0) return ERR_UNSUPPORTED;   /* 8-bit only */
    bits_u(b, 1);
    if (bits_u(b, 1)) return ERR_UNSUPPORTED;                         /* scaling matrices */
  }
  t.log2_max_frame_num = bits_ue(b) + 4;
  t.poc_type = bits_ue(b);
  if (t.poc_type == 0) t.log2_max_poc_lsb = bits_ue(b) + 4;
  else if (t.poc_type == 1) {
    t.delta_always_zero = bits_u(b, 1);
    t.offset_non_ref = bits_se(b);
    t.offset_top_bottom = bits_se(b);
    t.cycle = bits_ue(b);
    if (t.cycle < 0 || t.cycle > 255) return ERR_DATA;
    for (int i = 0; i < t.cycle; i++) t.offset_ref[i] = bits_se(b);
  } else if (t.poc_type != 2) return ERR_DATA;
  t.max_refs = bits_ue(b);
  if (t.max_refs < 0 || t.log2_max_frame_num < 4 || (t.poc_type == 0 && t.log2_max_poc_lsb < 4)) return ERR_DATA;
  t.gaps = bits_u(b, 1);
  t.mbw = bits_ue(b) + 1;
  t.mbh = bits_ue(b) + 1;
  if (!bits_u(b, 1)) return ERR_UNSUPPORTED;                           /* frame_mbs_only_flag */
  t.direct8x8 = bits_u(b, 1);
  if (bits_u(b, 1)) {
    t.crop_l = 2 * bits_ue(b); t.crop_r = 2 * bits_ue(b);
    t.crop_t = 2 * bits_ue(b); t.crop_b = 2 * bits_ue(b);
  }
  if (t.max_refs > 16 || t.mbw > 256 || t.mbh > 256 || t.log2_max_frame_num > 16 || t.log2_max_poc_lsb > 16) return ERR_UNSUPPORTED;
  if (t.crop_l < 0 || t.crop_r < 0 || t.crop_t < 0 || t.crop_b < 0) return ERR_DATA;
  if (t.crop_l + t.crop_r >= t.mbw * 16 || t.crop_t + t.crop_b >= t.mbh * 16) return ERR_DATA;
  t.valid = 1;
  d->sps[id] = t;
  return ERR_OK;
}

static int parse_pps(Dec *d, Bits *b) {
  Pps t;
  memset(&t, 0, sizeof t);
  int id = bits_ue(b);
  if (id < 0 || id > 255) return ERR_DATA;
  t.sps = bits_ue(b);
  if (t.sps < 0 || t.sps > 31) return ERR_DATA;
  if (!bits_u(b, 1)) return ERR_UNSUPPORTED;                           /* CAVLC */
  t.bottom_poc = bits_u(b, 1);
  if (bits_ue(b) != 0) return ERR_UNSUPPORTED;                         /* slice groups */
  t.nref[0] = bits_ue(b) + 1;
  t.nref[1] = bits_ue(b) + 1;
  t.weighted = bits_u(b, 1);
  t.bipred = bits_u(b, 2);
  t.init_qp = 26 + bits_se(b);
  bits_se(b);
  t.cqp[0] = t.cqp[1] = bits_se(b);
  if (t.cqp[0] < -12 || t.cqp[0] > 12) return ERR_DATA;
  t.deblock_ctrl = bits_u(b, 1);
  t.constrained = bits_u(b, 1);
  t.redundant = bits_u(b, 1);
  if (bits_more(b)) {
    if (bits_u(b, 1)) return ERR_UNSUPPORTED;                          /* transform_8x8_mode_flag */
    if (bits_u(b, 1)) {                                                /* pic_scaling_matrix_present_flag */
      for (int i = 0; i < 6; i++) if (bits_u(b, 1) && skip_scaling_list(b, 16)) return ERR_UNSUPPORTED;
      return ERR_UNSUPPORTED;
    }
    t.cqp[1] = bits_se(b);
    if (t.cqp[1] < -12 || t.cqp[1] > 12) return ERR_DATA;
  }
  if (t.nref[0] > 32 || t.nref[1] > 32 || t.bipred == 3 || t.init_qp < 0 || t.init_qp > 51) return ERR_DATA;
  t.valid = 1;
  d->pps[id] = t;
  return ERR_OK;
}

static int parse_pred_weights(Dec *d, Bits *b, Slice *h) {
  h->lwd = bits_ue(b);
  h->cwd = bits_ue(b);
  if (h->lwd < 0 || h->lwd > 7 || h->cwd < 0 || h->cwd > 7) return ERR_DATA;
  for (int l = 0; l < (h->type == 1 ? 2 : 1); l++) {
    for (int i = 0; i < h->nref[l]; i++) {
      h->lw[l][i] = 1 << h->lwd; h->lo[l][i] = 0;
      h->cw[l][i][0] = h->cw[l][i][1] = 1 << h->cwd; h->co[l][i][0] = h->co[l][i][1] = 0;
      /* coded weights and offsets are -128..127 (7.4.3.2; the default weight 2^denominator may be 128) */
#define OUT8(v) ((v) < -128 || (v) > 127)
      h->lwf[l][i] = bits_u(b, 1);
      if (h->lwf[l][i]) {
        h->lw[l][i] = bits_se(b); h->lo[l][i] = bits_se(b);
        if (OUT8(h->lw[l][i]) || OUT8(h->lo[l][i])) return ERR_DATA;
      }
      h->cwf[l][i] = bits_u(b, 1);
      if (h->cwf[l][i]) for (int k = 0; k < 2; k++) {
        h->cw[l][i][k] = bits_se(b); h->co[l][i][k] = bits_se(b);
        if (OUT8(h->cw[l][i][k]) || OUT8(h->co[l][i][k])) return ERR_DATA;
      }
#undef OUT8
    }
  }
  (void)d;
  return ERR_OK;
}

/* slice_header() up to slice_data(); returns the bit position where slice data starts (byte-aligned by CABAC). */
static int parse_slice_header(Dec *d, Bits *b, Slice *h, int nal_type, int nal_ref) {
  memset(h, 0, sizeof *h);
  h->nal_type = nal_type; h->nal_ref = nal_ref;
  h->first_mb = bits_ue(b);
  if (h->first_mb < 0) return ERR_DATA;
  int t = bits_ue(b);
  if (t < 0 || t > 9) return ERR_DATA;
  t %= 5;
  if (t > 2) return ERR_UNSUPPORTED;                                   /* SP/SI */
  h->type = t == 2 ? 2 : t;   /* 0: P, 1: B, 2: I */
  h->pps = bits_ue(b);
  if (h->pps < 0 || h->pps > 255 || !d->pps[h->pps].valid) return ERR_DATA;
  const Pps *p = &d->pps[h->pps];
  const Sps *s = &d->sps[p->sps];
  if (!s->valid) return ERR_DATA;
  h->frame_num = bits_u(b, s->log2_max_frame_num);
  if (nal_type == 5) h->idr_id = bits_ue(b);
  if (s->poc_type == 0) {
    h->poc_lsb = bits_u(b, s->log2_max_poc_lsb);
    if (p->bottom_poc) h->delta_bottom = bits_se(b);
  } else if (s->poc_type == 1 && !s->delta_always_zero) {
    h->delta_poc[0] = bits_se(b);
    if (p->bottom_poc) h->delta_poc[1] = bits_se(b);
  }
  if (p->redundant && bits_ue(b) != 0) return ERR_UNSUPPORTED;        /* redundant pictures */
  if (h->type == 1) h->direct_spatial = bits_u(b, 1);
  h->nref[0] = p->nref[0]; h->nref[1] = p->nref[1];
  if (h->type != 2 && bits_u(b, 1)) {
    h->nref[0] = bits_ue(b) + 1;
    if (h->type == 1) h->nref[1] = bits_ue(b) + 1;
  }
  if (h->type == 2) h->nref[0] = 0;
  if (h->type != 1) h->nref[1] = 0;
  if (h->nref[0] > 32 || h->nref[1] > 32 || h->nref[0] < 0 || h->nref[1] < 0) return ERR_DATA;
  if ((h->type != 2 && h->nref[0] < 1) || (h->type == 1 && h->nref[1] < 1)) return ERR_DATA;
  for (int l = 0; l < 2; l++) {
    if ((l == 0 && h->type == 2) || (l == 1 && h->type != 1)) continue;
    if (bits_u(b, 1)) {
      int n = 0;
      for (;;) {
        int idc = bits_ue(b);
        if (idc == 3) break;
        if (idc < 0 || idc > 2 || n >= 33) return ERR_DATA;
        h->mod_idc[l][n] = idc;
        h->mod_val[l][n] = bits_ue(b);
        n++;
      }
      h->mod_count[l] = n;
    }
  }
  if ((p->weighted && h->type == 0) || (p->bipred == 1 && h->type == 1)) {
    int e = parse_pred_weights(d, b, h);
    if (e) return e;
  }
  if (nal_ref) {
    if (nal_type == 5) { h->no_output = bits_u(b, 1); h->long_term = bits_u(b, 1); }
    else if ((h->adaptive = bits_u(b, 1))) {
      int n = 0;
      for (;;) {
        int op = bits_ue(b);
        if (op == 0) break;
        if (op < 0 || op > 6 || n >= 66) return ERR_DATA;
        h->mmco[n][0] = op;
        h->mmco[n][1] = (op == 1 || op == 3) ? bits_ue(b) : 0;   /* difference_of_pic_nums_minus1 */
        h->mmco[n][2] = op == 2 ? bits_ue(b) : (op == 3 || op == 6) ? bits_ue(b) : op == 4 ? bits_ue(b) : 0;
        n++;
      }
      h->mmco_count = n;
    }
  }
  if (h->type != 2) { h->cabac_init = bits_ue(b); if (h->cabac_init < 0 || h->cabac_init > 2) return ERR_DATA; }
  h->qp = p->init_qp + bits_se(b);
  if (h->qp < 0 || h->qp > 51) return ERR_DATA;
  h->deblock = 0;
  if (p->deblock_ctrl) {
    h->deblock = bits_ue(b);
    if (h->deblock < 0 || h->deblock > 2) return ERR_DATA;
    if (h->deblock != 1) { h->alpha = 2 * bits_se(b); h->beta = 2 * bits_se(b); }
    if (h->alpha < -12 || h->alpha > 12 || h->beta < -12 || h->beta > 12) return ERR_DATA;
  }
  if (b->pos > b->len) return ERR_DATA;
  return ERR_OK;
}
