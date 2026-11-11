#!/usr/bin/env bash
# Makes the tiny clips the stitching tests use (tests/stitch.test.js): 128x64, 16 frames at 50 fps, encoded
# the way F1 encodes its feeds - a fixed I/P/B pattern with a keyframe every 8 frames, one slice per frame;
# HEVC with 32-pixel CTBs, temporal motion vector prediction off and the parameter sets in every keyframe
# (hev1). Each is one fragment (ftyp+moov, then moof+mdat). Different content per clip.
set -euo pipefail
cd "$(dirname "$0")"
MP4="-an -movflags +empty_moov+default_base_moof -frag_duration 30000000 -frames:v 16"
SRC=("testsrc2=s=128x64:r=50" "mandelbrot=s=128x64:r=50" "testsrc=s=128x64:r=50" "cellauto=s=128x64:r=50:rule=30")
for i in 0 1 2 3; do
  ffmpeg -v error -y -f lavfi -i "${SRC[$i]},format=yuv420p10le" -c:v libx265 -preset fast -crf 34 \
    -x265-params ctu=32:wpp=0:temporal-mvp=0:weightp=0:weightb=0:repeat-headers=1:sao=1:keyint=8:min-keyint=8:scenecut=0:bframes=2:b-adapt=0:b-pyramid=0:ref=2:open-gop=0:info=0:log-level=error \
    -tag:v hev1 $MP4 "hevc$i.mp4"
done
