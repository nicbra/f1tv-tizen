# f1dec: an H.264 decoder for the TV

The small feeds of the H.264 multiview (2018-2024 replays) are decoded by this decoder, built as WebAssembly
(`app/js/f1dec.wasm`), one decoder per feed in a worker of its own (`app/js/mvdec-worker.js`), so the TV's cores work in
parallel. Samsung's own software decoder (EMSS) runs every feed through one serial budget of ~7 ms per picture plus the
decoding: on the 2021 QE55Q77A it reached ~95 pictures/s in all, 16.7-25 fps for three small feeds. With this decoder
three 270p feeds play at 50 fps each beside the 1080p50 big feed (see `app/js/mvsoft.js`, engine `wasm`).

## What it decodes

Written from ITU-T H.264 (section numbers in the comments). It decodes progressive Main profile with CABAC, 8-bit 4:2:0:
I, P and B slices, every partition, intra 4x4/16x16/chroma, I_PCM, several slices, several references, reference list
modification, sliding-window and adaptive (MMCO) marking, picture order types 0 and 2, explicit and implicit weighted
prediction, spatial and temporal direct, deblocking with slice offsets. F1's onboards use a small part of it: I B B P, one
reference per list, spatial direct, implicit bi-prediction weights.

It refuses (error -2, the multiview then plays on Samsung's decoder): CAVLC, interlace (field pictures, MBAFF), the
8x8 transform and scaling matrices (High profile), slice groups, SP/SI slices, redundant pictures, picture order type 1,
other chroma formats and bit depths.

Every picture is bit-exact with FFmpeg's decoder, both builds: `tests/f1dec.test.js` (x264 clips with each tool) and,
outside the repository, F1's own onboards (2019, 2021: 270p/288p/360p, 1,422 pictures). About 2,400 damaged streams
under AddressSanitizer and UBSan: decoder errors only, no fault, no hang.

## Made for the TV

The TV's WebAssembly (Chromium 76) has no SIMD, and on its 32-bit cores every memory access is bounds-checked. So:
interpolation and averaging work on 32-bit words (four pixels, or two in 16-bit lanes for the 6-tap sums and the
weights; on the TV +15-20% over byte-wise filters), each quarter-sample position is one filter pass that averages on the
fly, predictions go straight into the picture, the inner edge strengths are worked out once per macroblock while its
motion is at hand (a macroblock that moves as one has no motion edges inside), and the arithmetic decoder's state stays
in local variables through a block's coefficients and a motion vector difference (in registers, not memory: +7-9% at
360p on the TV). On the TV one decoder does ~86 pictures/s at 270p and ~65 at 360p alone.

Measured and not kept (TV, 360p): deblocking on 32-bit words (no gain: arithmetic-bound), -O2/-Os/-fno-unroll-loops/LTO
(all within noise). Filtering the B pictures on the GPU instead (an exported map of edge strengths and QPs; within
57-67 dB of the standard's result): one sample a fragment cost 1.4 ms of GPU per picture, packed four samples a texel
0.6 ms, but even then the app's page refresh fell from ~55 to 46-47 fps on the TV's Mali-G51 (worth another try on a
TV with a stronger GPU).

`f1dec_option(d, 1)` leaves the non-reference pictures (F1's B frames) unfiltered: nothing predicts from them, so
nothing drifts; they stay within 42-55 dB of the filtered picture and decoding is ~13% quicker (the multiview uses it
when that is what fits a larger size: Big + 3 at 288p instead of 270p, +3.4 dB).

`f1dec-simd.wasm` (Tizen 7+, Chromium 91+) has the 6-tap filters, averaging, weighting and chroma interpolation in
WebAssembly SIMD: ~25% quicker in V8 than the plain build; picked by `WebAssembly.validate` of a one-instruction probe.

## API (`api.c`)

```c
Dec *f1dec_create(void);
int f1dec_decode(Dec *d, const uint8_t *access_unit, int len); // 1: a picture, 0: none, < 0: error (-2 unsupported)
void f1dec_copy(Dec *d, uint8_t *dst);                          // its visible Y, U, V planes, without padding
int f1dec_width(Dec *d), f1dec_height(Dec *d), f1dec_poc(Dec *d), f1dec_is_ref(Dec *d);
void f1dec_option(Dec *d, int deblock_mode);                     // 0 all, 1 not non-reference pictures, 2 none
void f1dec_destroy(Dec *d);
```

Pictures come out in decode order; the caller orders them (the worker uses the TS timestamps).

## Building

`native/f1dec/build.sh` builds `app/js/f1dec.wasm` (MVP WebAssembly) and `app/js/f1dec-simd.wasm` in emscripten's
Docker image (`emscripten/emsdk:3.1.64`). `cabac_tables.h` comes from the helper's tables (`node native/f1dec/tables.js`). Any C compiler builds it
natively too (`#include "api.c"`), which is quicker for testing.
