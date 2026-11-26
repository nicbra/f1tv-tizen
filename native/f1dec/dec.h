/*
 * f1dec: an H.264 decoder for the onboard feeds of F1's replays on Samsung Tizen TVs (WebAssembly, one decoder per
 * feed and core). Decodes progressive Main profile with CABAC (what F1 sends: I B B P, spatial direct, implicit
 * bi-prediction weights); refuses anything else (CAVLC, interlace, 8x8 transforms, scaling lists, slice groups) so
 * the caller can fall back. Written from ITU-T H.264 (08/2021); section numbers refer to it.
 */
#ifndef F1DEC_H
#define F1DEC_H
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

#define MAX_PICS 19         /* 16 references + the current picture + slack */
#define PAD 32              /* luma border (motion vectors may point outside the picture) */
#define PADC 16             /* chroma border */

enum { ERR_OK = 0, ERR_DATA = -1, ERR_UNSUPPORTED = -2, ERR_MEMORY = -3, ERR_NOREF = -4 };

/* Macroblock kinds (per MB of the picture being decoded). */
enum { MB_I4 = 1, MB_I16 = 2, MB_PCM = 4, MB_SKIP = 8, MB_DIRECT = 16, MB_INTER = 32, MB_8X8 = 64 };
#define IS_INTRA(t) (((t) & (MB_I4 | MB_I16 | MB_PCM)) != 0)

typedef struct {
  int valid, profile, level;
  int log2_max_frame_num, poc_type, log2_max_poc_lsb;
  int delta_always_zero, offset_non_ref, offset_top_bottom, cycle;
  int offset_ref[256];
  int max_refs, gaps;
  int mbw, mbh, direct8x8;
  int crop_l, crop_r, crop_t, crop_b;   /* luma samples */
} Sps;

typedef struct {
  int valid, sps;
  int bottom_poc, nref[2], weighted, bipred, init_qp, cqp[2], deblock_ctrl, constrained, redundant;
} Pps;

typedef struct Pic {
  uint8_t *mem, *y, *u, *v;
  int poc, frame_num, wrap, long_idx;
  int ref;                  /* 0: none, 1: short-term, 2: long-term */
  int id, busy, idr, kept;  /* busy: being decoded; kept: referenced or waiting to be collected */
  int16_t (*mv)[2][16][2];  /* per MB, list, 4x4 block (raster in the MB), x/y */
  int8_t (*refidx)[2][16];
  int32_t (*refpic)[2][16]; /* id of the picture each block refers to (-1: none) */
  uint8_t *intra;           /* per MB */
} Pic;

typedef struct {
  uint32_t off, range;
  int s;
  const uint8_t *p, *end;
} Cabac;

typedef struct {
  const uint8_t *a;
  int pos, len;   /* bits */
} Bits;

typedef struct Slice {
  int first_mb, type, pps, frame_num, idr_id, poc_lsb, delta_bottom, delta_poc[2];
  int direct_spatial, nref[2], cabac_init, qp, deblock, alpha, beta, nal_ref, nal_type;
  int mod_count[2], mod_idc[2][33], mod_val[2][33];
  int lwd, cwd, lw[2][32], lo[2][32], cw[2][32][2], co[2][32][2], lwf[2][32], cwf[2][32];
  int no_output, long_term, adaptive, mmco_count, mmco[66][3];
} Slice;

typedef struct Dec {
  Sps sps[32];
  Pps pps[256];
  const Sps *s;
  const Pps *p;
  int mbw, mbh, nmb, width, height, stride, cstride;
  Pic pics[MAX_PICS];
  int next_id;
  Pic *cur;
  /* per MB of the current picture */
  uint8_t *mbtype, *cbp, *cpred, *qp, *sub8;
  uint32_t *cbf;             /* coded_block_flag bits: 0-15 luma 4x4 (raster), 16-19 Cb AC, 20-23 Cr AC, 24 luma DC, 25 Cb DC, 26 Cr DC */
  int8_t (*ipred)[16];       /* intra 4x4 modes, raster; 2 (DC) for other macroblocks */
  uint8_t (*mvd)[2][16][2];  /* |mvd| per block, capped at 64 */
  uint16_t *direct;          /* blocks predicted in direct mode */
  uint32_t (*bsint)[2];      /* bS of the inner 4x4 edges (2 bits each: edge 1..3 x segment 0..3), vertical / horizontal */
  int16_t *slice_of;
  uint8_t *deblock_of;       /* index into the slice parameter table below (per MB) */
  int slice_alpha[256], slice_beta[256], slice_deblock[256];
  int slice_num;
  /* slice */
  Slice sh;
  Pic *list[2][33];
  int32_t list_id[2][33];
  int nlist[2];
  int imp_w[33][33];         /* implicit weight of L1 (w0 = 64 - w1); 32/32 = plain average */
  int wmode;                 /* 0: none, 1: explicit, 2: implicit */
  int skip_nonref_deblock;   /* option: leave non-reference pictures unfiltered (nothing predicts from them) */
  /* picture order */
  int prev_msb, prev_lsb, prev_frame_num, frame_num_offset, prev_frame_num_offset, prev_mmco5;
  int poc_top, poc_bottom;
  int have_pic;
  /* CABAC */
  Cabac c;
  uint8_t ctx[460];
  uint8_t *rbsp;
  int rbsp_cap;
  int last_dqp;
  int cur_qpc[2];
  void *mbctx;
  /* output (the last decoded picture, cropped geometry) */
  Pic *out;
  int out_w, out_h;
  int error;
} Dec;

static inline int clip3(int lo, int hi, int v) { return v < lo ? lo : v > hi ? hi : v; }
static inline uint8_t clip1(int v) { return (unsigned)v > 255 ? (v < 0 ? 0 : 255) : (uint8_t)v; }
static inline int iabs(int v) { return v < 0 ? -v : v; }
static inline int imin(int a, int b) { return a < b ? a : b; }
static inline int imax(int a, int b) { return a > b ? a : b; }
static inline int median3(int a, int b, int c) { return imax(imin(a, b), imin(imax(a, b), c)); }

#endif
