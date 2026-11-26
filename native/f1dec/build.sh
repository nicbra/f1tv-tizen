#!/usr/bin/env bash
# Builds app/js/f1dec.wasm in emscripten's Docker image: MVP WebAssembly for Chromium 76 (Tizen 6: no SIMD, bulk
# memory, sign extension or non-trapping float conversions), and app/js/f1dec-simd.wasm with WebAssembly SIMD for
# TVs that have it (Tizen 7+, Chromium 91+; mvsoft.js picks it by WebAssembly.validate).
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:3.1.64}"
EXPORTS='["_f1dec_create","_f1dec_destroy","_f1dec_option","_f1dec_decode","_f1dec_plane","_f1dec_copy","_f1dec_width","_f1dec_height","_f1dec_poc","_f1dec_is_ref","_malloc","_free"]'
build() {   # build <output> <extra flags>
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/src -w /src "$IMAGE" \
    emcc api.c -O3 -mcpu=mvp -mno-bulk-memory -mno-sign-ext -mno-nontrapping-fptoint -mno-mutable-globals $2 \
    -s STANDALONE_WASM=1 --no-entry -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=8MB -s STACK_SIZE=256KB \
    -s EXPORTED_FUNCTIONS="$EXPORTS" -o "$1"
  mv "$1" "../../app/js/$1"
  echo "built app/js/$1 ($(wc -c < "../../app/js/$1") bytes)"
}
build f1dec.wasm ""
build f1dec-simd.wasm "-msimd128"
