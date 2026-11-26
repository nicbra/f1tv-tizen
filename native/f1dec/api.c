/* Pictures, references (8.2), slices and the API. One file to build: everything is included here. */
#include "dec.h"
#include "headers.c"
#include "cabac.c"
#include "recon.c"
#include "mb.c"
#include "deblock.c"

/* ---------------------------------------------------------------- picture buffers */

static void free_pics(Dec *d) {
  for (int i = 0; i < MAX_PICS; i++) {
    Pic *p = &d->pics[i];
    free(p->mem); free(p->mv); free(p->refidx); free(p->refpic); free(p->intra);
    memset(p, 0, sizeof *p);
  }
  free(d->mbtype); free(d->cbp); free(d->cpred); free(d->qp); free(d->cbf); free(d->ipred); free(d->mvd);
  free(d->direct); free(d->bsint); free(d->slice_of); free(d->deblock_of);
  d->mbtype = d->cbp = d->cpred = d->qp = NULL; d->cbf = NULL; d->ipred = NULL; d->mvd = NULL;
  d->direct = NULL; d->bsint = NULL; d->slice_of = NULL; d->deblock_of = NULL;
  d->mbw = d->mbh = d->nmb = 0;
}

static int alloc_pics(Dec *d, const Sps *s) {
  free_pics(d);
  d->mbw = s->mbw; d->mbh = s->mbh; d->nmb = s->mbw * s->mbh;
  d->width = s->mbw * 16; d->height = s->mbh * 16;
  d->stride = d->width + 2 * PAD; d->cstride = d->width / 2 + 2 * PADC;
  int n = d->nmb, lsize = d->stride * (d->height + 2 * PAD), csize = d->cstride * (d->height / 2 + 2 * PADC);
  for (int i = 0; i < MAX_PICS; i++) {
    Pic *p = &d->pics[i];
    p->mem = (uint8_t *)malloc(lsize + 2 * csize);
    p->mv = malloc(sizeof *p->mv * n); p->refidx = malloc(sizeof *p->refidx * n);
    p->refpic = malloc(sizeof *p->refpic * n); p->intra = (uint8_t *)malloc(n);
    if (!p->mem || !p->mv || !p->refidx || !p->refpic || !p->intra) return ERR_MEMORY;
    p->y = p->mem + PAD * d->stride + PAD;
    p->u = p->mem + lsize + PADC * d->cstride + PADC;
    p->v = p->mem + lsize + csize + PADC * d->cstride + PADC;
  }
  d->mbtype = (uint8_t *)malloc(n); d->cbp = (uint8_t *)malloc(n); d->cpred = (uint8_t *)malloc(n); d->qp = (uint8_t *)malloc(n);
  d->cbf = (uint32_t *)malloc(4 * n); d->ipred = malloc(sizeof *d->ipred * n); d->mvd = malloc(sizeof *d->mvd * n);
  d->direct = (uint16_t *)malloc(2 * n); d->bsint = malloc(sizeof *d->bsint * n); d->slice_of = (int16_t *)malloc(2 * n); d->deblock_of = (uint8_t *)malloc(n);
  if (!d->mbtype || !d->cbp || !d->cpred || !d->qp || !d->cbf || !d->ipred || !d->mvd || !d->direct || !d->bsint || !d->slice_of || !d->deblock_of) return ERR_MEMORY;
  d->s = s;
  return ERR_OK;
}

/* Borders for motion vectors that point outside: repeat the edge samples (8.4.2.2). */
static void extend(uint8_t *p, int stride, int w, int h, int pad) {
  for (int y = 0; y < h; y++) {
    uint8_t *r = p + y * stride;
    memset(r - pad, r[0], pad);
    memset(r + w, r[w - 1], pad);
  }
  for (int y = 1; y <= pad; y++) {
    memcpy(p - y * stride - pad, p - pad, w + 2 * pad);
    memcpy(p + (h - 1 + y) * stride - pad, p + (h - 1) * stride - pad, w + 2 * pad);
  }
}

/* ---------------------------------------------------------------- reference marking (8.2.5) */

static int max_frame_num(Dec *d) { return 1 << d->s->log2_max_frame_num; }

static void unmark_all(Dec *d) {
  for (int i = 0; i < MAX_PICS; i++) if (d->pics[i].ref) d->pics[i].ref = 0;
}

static void set_wraps(Dec *d, int frame_num) {
  for (int i = 0; i < MAX_PICS; i++) {
    Pic *p = &d->pics[i];
    if (p->ref == 1) p->wrap = p->frame_num > frame_num ? p->frame_num - max_frame_num(d) : p->frame_num;
  }
}

static void mark_reference(Dec *d) {
  Pic *cur = d->cur;
  Slice *h = &d->sh;
  int mmco5 = 0;
  if (h->nal_type == 5) {
    unmark_all(d);
    cur->ref = h->long_term ? 2 : 1;
    cur->long_idx = 0;
  } else {
    set_wraps(d, cur->frame_num);
    if (h->adaptive) {
      int cur_pic_num = cur->frame_num;
      for (int i = 0; i < h->mmco_count; i++) {
        int op = h->mmco[i][0];
        if (op == 1 || op == 3) {
          int num = cur_pic_num - (h->mmco[i][1] + 1);
          for (int k = 0; k < MAX_PICS; k++) {
            Pic *p = &d->pics[k];
            if (p->ref == 1 && p->wrap == num) {
              if (op == 1) p->ref = 0;
              else {
                for (int j = 0; j < MAX_PICS; j++) if (d->pics[j].ref == 2 && d->pics[j].long_idx == h->mmco[i][2]) d->pics[j].ref = 0;
                p->ref = 2; p->long_idx = h->mmco[i][2];
              }
            }
          }
        } else if (op == 2) {
          for (int k = 0; k < MAX_PICS; k++) if (d->pics[k].ref == 2 && d->pics[k].long_idx == h->mmco[i][2]) d->pics[k].ref = 0;
        } else if (op == 4) {
          for (int k = 0; k < MAX_PICS; k++) if (d->pics[k].ref == 2 && d->pics[k].long_idx >= h->mmco[i][2]) d->pics[k].ref = 0;
        } else if (op == 5) {
          unmark_all(d);
          mmco5 = 1;
        } else if (op == 6) {
          for (int k = 0; k < MAX_PICS; k++) if (d->pics[k].ref == 2 && d->pics[k].long_idx == h->mmco[i][2]) d->pics[k].ref = 0;
          cur->ref = 2; cur->long_idx = h->mmco[i][2];
        }
      }
    } else {
      /* sliding window */
      int n = 0, oldest = -1;
      for (int k = 0; k < MAX_PICS; k++) {
        Pic *p = &d->pics[k];
        if (p == cur || !p->ref) continue;
        n++;
        if (p->ref == 1 && (oldest < 0 || p->wrap < d->pics[oldest].wrap)) oldest = k;
      }
      if (n >= imax(d->s->max_refs, 1) && oldest >= 0) d->pics[oldest].ref = 0;
    }
    if (cur->ref != 2) cur->ref = 1;
  }
  if (mmco5) {
    /* The picture becomes the first of a new sequence of frame numbers and picture order counts (8.2.1). */
    int t = cur->poc;
    cur->poc = 0;
    cur->frame_num = 0;
    d->poc_top -= t; d->poc_bottom -= t;
    d->prev_msb = 0; d->prev_lsb = d->poc_top;
  }
  d->prev_mmco5 = mmco5;
}

/* ---------------------------------------------------------------- picture order count (8.2.1) */

static void compute_poc(Dec *d) {
  Slice *h = &d->sh;
  const Sps *s = d->s;
  int idr = h->nal_type == 5;
  if (s->poc_type == 0) {
    int max = 1 << s->log2_max_poc_lsb, pmsb, plsb;
    if (idr) { pmsb = 0; plsb = 0; }
    else if (d->prev_mmco5) { pmsb = 0; plsb = d->prev_lsb; }
    else { pmsb = d->prev_msb; plsb = d->prev_lsb; }
    int msb;
    if (h->poc_lsb < plsb && plsb - h->poc_lsb >= max / 2) msb = pmsb + max;
    else if (h->poc_lsb > plsb && h->poc_lsb - plsb > max / 2) msb = pmsb - max;
    else msb = pmsb;
    d->poc_top = msb + h->poc_lsb;
    d->poc_bottom = d->poc_top + h->delta_bottom;
    if (h->nal_ref) { d->prev_msb = msb; d->prev_lsb = h->poc_lsb; }
  } else {
    int off;
    if (idr) off = 0;
    else if (d->prev_mmco5) off = 0;
    else off = d->prev_frame_num_offset + (d->prev_frame_num > h->frame_num ? max_frame_num(d) : 0);
    if (s->poc_type == 2) {
      int t = idr ? 0 : h->nal_ref ? 2 * (off + h->frame_num) : 2 * (off + h->frame_num) - 1;
      d->poc_top = d->poc_bottom = t;
    } else {
      int abs_n = s->cycle ? off + h->frame_num : 0, expected = 0;
      if (!h->nal_ref && abs_n > 0) abs_n--;
      if (abs_n > 0) {
        int delta_cycle = 0;
        for (int i = 0; i < s->cycle; i++) delta_cycle += s->offset_ref[i];
        int cnt = (abs_n - 1) / s->cycle, in = (abs_n - 1) % s->cycle;
        expected = cnt * delta_cycle;
        for (int i = 0; i <= in; i++) expected += s->offset_ref[i];
      }
      if (!h->nal_ref) expected += s->offset_non_ref;
      d->poc_top = expected + h->delta_poc[0];
      d->poc_bottom = d->poc_top + s->offset_top_bottom + h->delta_poc[1];
    }
    d->frame_num_offset = off;
  }
}

/* ---------------------------------------------------------------- reference lists (8.2.4) */

static void sort_pics(Pic **a, int n, int (*key)(const Pic *), int desc) {
  for (int i = 1; i < n; i++) {
    Pic *t = a[i];
    int j = i;
    while (j > 0 && (desc ? key(a[j - 1]) < key(t) : key(a[j - 1]) > key(t))) { a[j] = a[j - 1]; j--; }
    a[j] = t;
  }
}
static int key_wrap(const Pic *p) { return p->wrap; }
static int key_poc(const Pic *p) { return p->poc; }
static int key_long(const Pic *p) { return p->long_idx; }

static int build_lists(Dec *d) {
  Slice *h = &d->sh;
  Pic *st[MAX_PICS], *lt[MAX_PICS];
  int ns = 0, nl = 0;
  set_wraps(d, h->frame_num);
  for (int i = 0; i < MAX_PICS; i++) {
    Pic *p = &d->pics[i];
    if (p == d->cur) continue;
    if (p->ref == 1) st[ns++] = p;
    else if (p->ref == 2) lt[nl++] = p;
  }
  sort_pics(lt, nl, key_long, 0);
  for (int l = 0; l < 2; l++) d->nlist[l] = 0;
  if (h->type == 0) {
    sort_pics(st, ns, key_wrap, 1);
    for (int i = 0; i < ns; i++) d->list[0][d->nlist[0]++] = st[i];
    for (int i = 0; i < nl; i++) d->list[0][d->nlist[0]++] = lt[i];
  } else if (h->type == 1) {
    Pic *before[MAX_PICS], *after[MAX_PICS];
    int nb = 0, na = 0, cur = d->cur->poc;
    for (int i = 0; i < ns; i++) { if (st[i]->poc < cur) before[nb++] = st[i]; else after[na++] = st[i]; }
    sort_pics(before, nb, key_poc, 1);
    sort_pics(after, na, key_poc, 0);
    for (int i = 0; i < nb; i++) d->list[0][d->nlist[0]++] = before[i];
    for (int i = 0; i < na; i++) d->list[0][d->nlist[0]++] = after[i];
    for (int i = 0; i < nl; i++) d->list[0][d->nlist[0]++] = lt[i];
    for (int i = 0; i < na; i++) d->list[1][d->nlist[1]++] = after[i];
    for (int i = 0; i < nb; i++) d->list[1][d->nlist[1]++] = before[i];
    for (int i = 0; i < nl; i++) d->list[1][d->nlist[1]++] = lt[i];
    if (d->nlist[1] > 1 && d->nlist[0] == d->nlist[1]) {
      int same = 1;
      for (int i = 0; i < d->nlist[0]; i++) if (d->list[0][i] != d->list[1][i]) same = 0;
      if (same) { Pic *t = d->list[1][0]; d->list[1][0] = d->list[1][1]; d->list[1][1] = t; }
    }
  }
  int lists = h->type == 1 ? 2 : h->type == 0 ? 1 : 0;
  for (int l = 0; l < lists; l++) {
    int n = d->nlist[l];
    if (n == 0) return ERR_NOREF;
    if (n > h->nref[l]) n = h->nref[l];
    /* modification (8.2.4.3) */
    int pred = d->cur->frame_num, maxn = max_frame_num(d), idx = 0;
    Pic *tmp[34];
    for (int i = 0; i < n; i++) tmp[i] = d->list[l][i];
    int len = n;
    for (int k = 0; k < h->mod_count[l]; k++) {
      int idc = h->mod_idc[l][k];
      Pic *pick = NULL;
      if (idc < 2) {
        int diff = h->mod_val[l][k] + 1;
        int no_wrap = idc == 0 ? pred - diff : pred + diff;
        if (no_wrap < 0) no_wrap += maxn;
        if (no_wrap >= maxn) no_wrap -= maxn;
        pred = no_wrap;
        int num = no_wrap > d->cur->frame_num ? no_wrap - maxn : no_wrap;
        for (int i = 0; i < MAX_PICS; i++) if (d->pics[i].ref == 1 && &d->pics[i] != d->cur && d->pics[i].wrap == num) pick = &d->pics[i];
      } else {
        for (int i = 0; i < MAX_PICS; i++) if (d->pics[i].ref == 2 && d->pics[i].long_idx == h->mod_val[l][k]) pick = &d->pics[i];
      }
      if (!pick || idx >= h->nref[l]) return ERR_DATA;
      /* insert at idx, drop a later copy */
      Pic *out[34];
      int o = 0;
      for (int i = 0; i < idx; i++) out[o++] = tmp[i];
      out[o++] = pick;
      for (int i = idx; i < len && o < 33; i++) if (tmp[i] != pick) out[o++] = tmp[i];
      len = imin(o, h->nref[l]);
      for (int i = 0; i < len; i++) tmp[i] = out[i];
      idx++;
    }
    for (int i = 0; i < len; i++) d->list[l][i] = tmp[i];
    /* missing entries (never used by a conforming stream): repeat the first */
    for (int i = len; i < h->nref[l]; i++) d->list[l][i] = d->list[l][0];
    d->nlist[l] = h->nref[l];
    for (int i = 0; i < d->nlist[l]; i++) d->list_id[l][i] = d->list[l][i]->id;
  }
  return ERR_OK;
}

static void weights(Dec *d) {
  Slice *h = &d->sh;
  d->wmode = 0;
  if ((d->p->weighted && h->type == 0) || (d->p->bipred == 1 && h->type == 1)) d->wmode = 1;
  else if (d->p->bipred == 2 && h->type == 1) {
    d->wmode = 2;
    for (int i = 0; i < d->nlist[0]; i++)
      for (int j = 0; j < d->nlist[1]; j++) {
        Pic *p0 = d->list[0][i], *p1 = d->list[1][j];
        int w1 = 32, td = clip3(-128, 127, p1->poc - p0->poc);
        if (td && p0->ref != 2 && p1->ref != 2) {
          int tb = clip3(-128, 127, d->cur->poc - p0->poc), tx = (16384 + iabs(td / 2)) / td;
          int dsf = clip3(-1024, 1023, (tb * tx + 32) >> 6);
          if ((dsf >> 2) >= -64 && (dsf >> 2) <= 128) w1 = dsf >> 2;
        }
        d->imp_w[i][j] = w1;
      }
  }
}

/* ---------------------------------------------------------------- pictures */

/* Macroblocks no slice covered (a slice lost): the newest reference picture's samples there (grey without one), with no
 * motion, coefficients or intra modes, so deblocking and later pictures see something consistent. */
static void conceal(Dec *d) {
  Pic *cur = d->cur, *ref = NULL;
  for (int i = 0; i < MAX_PICS; i++) {
    Pic *p = &d->pics[i];
    if (p != cur && p->ref && (!ref || p->id > ref->id)) ref = p;
  }
  for (int a = 0; a < d->nmb; a++) {
    if (d->slice_of[a] >= 0) continue;
    int mx = a % d->mbw, my = a / d->mbw;
    for (int k = 0; k < 3; k++) {
      int n = k ? 8 : 16, st = k ? d->cstride : d->stride;
      uint8_t *dst = (k == 0 ? cur->y : k == 1 ? cur->u : cur->v) + my * n * st + mx * n;
      const uint8_t *src = ref ? (k == 0 ? ref->y : k == 1 ? ref->u : ref->v) + my * n * st + mx * n : NULL;
      for (int y = 0; y < n; y++) { if (src) memcpy(dst + y * st, src + y * st, n); else memset(dst + y * st, 128, n); }
    }
    d->slice_of[a] = (int16_t)d->slice_num;
    d->mbtype[a] = MB_SKIP | MB_INTER; d->cbp[a] = 0; d->cbf[a] = 0; d->cpred[a] = 0; d->direct[a] = 0;
    d->qp[a] = (uint8_t)d->sh.qp; d->deblock_of[a] = (uint8_t)(d->slice_num & 255); d->bsint[a][0] = d->bsint[a][1] = 0;
    memset(d->ipred[a], 2, 16); memset(d->mvd[a], 0, sizeof d->mvd[a]);
    cur->intra[a] = 0;
    memset(cur->refidx[a], -1, sizeof cur->refidx[a]); memset(cur->mv[a], 0, sizeof cur->mv[a]);
    for (int l = 0; l < 2; l++) for (int r = 0; r < 16; r++) cur->refpic[a][l][r] = -1;
  }
}

static void finish_picture(Dec *d) {
  Pic *cur = d->cur;
  if (!cur) return;
  conceal(d);
  if (!(d->skip_nonref_deblock == 2 || (d->skip_nonref_deblock && !d->sh.nal_ref))) deblock_picture(d);
  if (d->sh.nal_ref) {
    extend(cur->y, d->stride, d->width, d->height, PAD);
    extend(cur->u, d->cstride, d->width / 2, d->height / 2, PADC);
    extend(cur->v, d->cstride, d->width / 2, d->height / 2, PADC);
    mark_reference(d);
    d->prev_frame_num = cur->frame_num;
    d->prev_frame_num_offset = d->frame_num_offset;
  } else {
    d->prev_frame_num = cur->frame_num;
    d->prev_frame_num_offset = d->frame_num_offset;
  }
  cur->busy = 0;
  d->out = cur;
  d->cur = NULL;
}

static int start_picture(Dec *d) {
  Slice *h = &d->sh;
  const Pps *p = &d->pps[h->pps];
  const Sps *s = &d->sps[p->sps];
  /* New buffers only for a new size (by what they were made for: an SPS may be replaced in place); a parameter set of
   * another id with the same size keeps the references. */
  if (!d->mbtype || d->mbw != s->mbw || d->mbh != s->mbh) {
    if (h->nal_type != 5 && d->mbtype) return ERR_DATA;   /* a new size starts with an IDR picture */
    int e = alloc_pics(d, s);
    if (e) return e;
  }
  d->s = s; d->p = p;
  if (h->nal_type == 5) unmark_all(d);
  Pic *pic = NULL;
  for (int i = 0; i < MAX_PICS; i++) if (!d->pics[i].ref && !d->pics[i].busy && &d->pics[i] != d->out) { pic = &d->pics[i]; break; }
  if (!pic) for (int i = 0; i < MAX_PICS; i++) if (!d->pics[i].ref && !d->pics[i].busy) { pic = &d->pics[i]; break; }
  if (!pic) return ERR_MEMORY;
  d->cur = pic;
  pic->busy = 1; pic->ref = 0; pic->id = ++d->next_id & 0x3FFFFFFF; pic->idr = h->nal_type == 5;
  pic->frame_num = h->frame_num;
  compute_poc(d);
  pic->poc = imin(d->poc_top, d->poc_bottom);
  for (int i = 0; i < d->nmb; i++) d->slice_of[i] = -1;
  d->slice_num = 0;
  return ERR_OK;
}

static int decode_slice(Dec *d, const uint8_t *data, int len, int nal_type, int nal_ref) {
  Bits b = { data, 0, len * 8 };
  Slice h;
  int e = parse_slice_header(d, &b, &h, nal_type, nal_ref);
  if (e) return e;
  if (h.first_mb == 0 && d->cur) finish_picture(d);
  d->sh = h;
  if (!d->cur) {
    if (h.first_mb != 0) return ERR_DATA;
    e = start_picture(d);
    if (e) return e;
  } else d->slice_num++;
  d->p = &d->pps[h.pps];
  if (&d->sps[d->p->sps] != d->s) return ERR_DATA;
  if (h.first_mb >= d->nmb) return ERR_DATA;
  e = build_lists(d);
  if (e) return e;
  weights(d);
  int sn = d->slice_num & 255;
  d->slice_deblock[sn] = h.deblock; d->slice_alpha[sn] = h.alpha; d->slice_beta[sn] = h.beta;
  /* slice_data: CABAC starts at the next byte */
  const uint8_t *p = data + ((b.pos + 7) >> 3);
  cabac_init_contexts(d, h.type, h.cabac_init, h.qp);
  cabac_start(&d->c, p, data + len + 8);
  d->last_dqp = 0;
  d->error = 0;
  int qp = h.qp;
  set_chroma_qp(d, qp);
  for (int addr = h.first_mb;; addr++) {
    if (addr >= d->nmb) return ERR_DATA;
    e = decode_mb(d, addr, &qp);
    if (e) return e;
    if (cabac_terminate(&d->c)) break;
  }
  return ERR_OK;
}

/* ---------------------------------------------------------------- API */

static int initialised;

Dec *f1dec_create(void) {
  if (!initialised) { cabac_tables_init(); recon_tables_init(); mb_tables_init(); initialised = 1; }
  Dec *d = (Dec *)calloc(1, sizeof(Dec));
  if (!d) return NULL;
  d->mbctx = calloc(1, sizeof(Mb));
  if (!d->mbctx) { free(d); return NULL; }
  return d;
}

void f1dec_destroy(Dec *d) {
  if (!d) return;
  free_pics(d);
  free(d->rbsp); free(d->mbctx); free(d);
}

/* Deblocking: 0 every picture (as the standard), 1 not the non-reference ones (nothing predicts from them: no drift,
 * 42-55 dB from the filtered picture on F1's onboards), 2 none (tests). */
void f1dec_option(Dec *d, int deblock_mode) { d->skip_nonref_deblock = deblock_mode; }

/*
 * Decodes one access unit (Annex B bytes: start codes and NAL units). Returns 1 when it completed a picture
 * (f1dec_copy / f1dec_plane give it until the next call), 0 when it held none, < 0 on an error (decoding can resume
 * at the next IDR picture).
 */
int f1dec_decode(Dec *d, const uint8_t *data, int len) {
  int i = 0, ret = 0;
  d->out = NULL;
  while (i + 3 <= len) {
    /* find the start code */
    if (!(data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1)) { i++; continue; }
    int s = i + 3, e = s;
    while (e + 3 <= len && !(data[e] == 0 && data[e + 1] == 0 && (data[e + 2] == 1 || (data[e + 2] == 0 && e + 3 < len && data[e + 3] == 1)))) e++;
    if (e + 3 > len) e = len;
    i = e;
    int n = e - s;
    while (n > 0 && data[s + n - 1] == 0) n--;
    if (n < 1) continue;
    int forbidden = data[s] >> 7, ref = (data[s] >> 5) & 3, type = data[s] & 31;
    if (forbidden) { ret = ERR_DATA; continue; }
    if (type != 1 && type != 5 && type != 7 && type != 8) continue;
    int rl = unescape(d, data + s + 1, n - 1);
    if (rl < 0) return ERR_MEMORY;
    Bits b = { d->rbsp, 0, rl * 8 };
    int r = ERR_OK;
    if (type == 7) r = parse_sps(d, &b);
    else if (type == 8) r = parse_pps(d, &b);
    else r = decode_slice(d, d->rbsp, rl, type, ref);
    if (r < 0) {
      if (d->cur) { d->cur->busy = 0; d->cur->ref = 0; d->cur = NULL; }
      return r;
    }
  }
  if (d->cur) { finish_picture(d); ret = 1; }
  return ret < 0 ? ret : d->out ? 1 : 0;
}

/* The last picture: plane 0 Y, 1 U, 2 V -> pointer to its first visible sample; *stride. */
int f1dec_width(Dec *d);
int f1dec_height(Dec *d);
uint8_t *f1dec_plane(Dec *d, int plane, int *stride) {
  Pic *p = d->out;
  if (!p) return NULL;
  const Sps *s = d->s;
  if (plane == 0) { *stride = d->stride; return p->y + s->crop_t * d->stride + s->crop_l; }
  *stride = d->cstride;
  return (plane == 1 ? p->u : p->v) + (s->crop_t / 2) * d->cstride + s->crop_l / 2;
}
/* The last picture's visible samples into dst: Y, then U, then V, without padding (width * height * 3 / 2 bytes). */
void f1dec_copy(Dec *d, uint8_t *dst) {
  int w = f1dec_width(d), h = f1dec_height(d);
  for (int p = 0; p < 3; p++) {
    int st, pw = p ? w / 2 : w, ph = p ? h / 2 : h;
    const uint8_t *src = f1dec_plane(d, p, &st);
    for (int y = 0; y < ph; y++, dst += pw) memcpy(dst, src + y * st, pw);
  }
}
int f1dec_width(Dec *d) { return d->s ? d->width - d->s->crop_l - d->s->crop_r : 0; }
int f1dec_height(Dec *d) { return d->s ? d->height - d->s->crop_t - d->s->crop_b : 0; }
int f1dec_poc(Dec *d) { return d->out ? d->out->poc : 0; }
int f1dec_is_ref(Dec *d) { return d->out ? d->out->ref != 0 : 0; }
