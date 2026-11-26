// The helper's interleaved H.264 stream (app/service/stitchx): which frames each feed keeps and when they show.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const root = path.resolve(__dirname, '../app/service/stitchx');
const StitchX = require(path.join(root, 'stitchx.js'));
const Segment = require(path.join(root, 'segment.js'));
const CmafDash = require('../app/js/cmaf.js');
StitchX.tables(require(path.join(root, 'cabac-tables.json')));

// The encoding check skips without ffmpeg, except in CI where it must run.
let ffmpeg = true;
try {
  cp.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch (_) {
  ffmpeg = !!process.env.CI;
}

/** A 50 fps MPEG-TS feed coded like F1's (I B B P, B frames not referenced; 49 frames end on a P); `cut`: an extra key frame there. */
function feed(dir, name, cut) {
  const target = path.join(dir, name + '.ts');
  cp.execFileSync('ffmpeg', [
    '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=50',
    '-frames:v', '49', '-an', '-c:v', 'libx264', '-threads', '1', '-profile:v', 'main',
    '-x264-params', 'cabac=1:ref=2:bframes=2:b-adapt=0:b-pyramid=none:keyint=49:min-keyint=49:scenecut=0',
    ...(cut ? ['-force_key_frames', String(cut / 50)] : []), '-f', 'mpegts', target
  ]);
  return new Uint8Array(fs.readFileSync(target));
}

/** Each picture's display time (ticks), feed and moment flag, in display order, from the built fMP4 segment. */
function shown(video) {
  return CmafDash.samples(video, 90000).map((s) => Math.round(s.pts * 90000)).sort((a, b) => a - b)
    .map((t) => ({ t, feed: t % 4, last: t % 8 >= 4 }));
}

test('reference frames only stay evenly spaced, and each moment\'s last picture is marked', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h264-interleave-'));
  try {
    const bytes = [feed(dir, 'a'), feed(dir, 'b', 20), feed(dir, 'c')];
    const out = Segment.build(bytes, { segment: 0, start: 0, delay: 0.1, feeds: 3, init: true, maxDpb: 9, reorder: 4,
      dropB: [true, true, true], feedTag: true, decodeOrder: 'unlock' });
    const pics = shown(out.video);
    const frame = 1800, steps = (k) => pics.filter((p) => p.feed === k).map((p, i, a) => i ? (p.t - a[i - 1].t) / frame : null).slice(1);
    // Feeds without a cut: every third frame (60 ms apart), exactly.
    for (const k of [0, 2]) assert.ok(steps(k).every((s) => Math.abs(s - 3) < 0.01), 'feed ' + k + ': ' + steps(k));
    // A cut's extra key frame moves that feed's references: they still show at their own frame times.
    const cut = steps(1);
    assert.ok(cut.every((s) => [1, 2, 3].some((w) => Math.abs(s - w) < 0.01)), String(cut));
    assert.ok(cut.some((s) => Math.abs(s - 3) >= 0.01), 'the cut changed the spacing: ' + cut);
    // A moment: the pictures of one frame time, together in display order; only its last one is marked.
    const moments = new Map();
    pics.forEach((p) => { const T = Math.floor((p.t - 9000) / frame); (moments.get(T) || moments.set(T, []).get(T)).push(p); });
    for (const [T, list] of moments) {
      assert.deepEqual(list.map((p) => p.last), list.map((p, i) => i === list.length - 1), 'frame ' + T);
      const at = pics.indexOf(list[0]);
      assert.deepEqual(pics.slice(at, at + list.length), list, 'frame ' + T + ' is contiguous');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one small feed keeps every frame, each its own moment', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h264-interleave-'));
  try {
    const out = Segment.build([feed(dir, 'a')], { segment: 0, start: 0, delay: 0.1, feeds: 1, init: true, maxDpb: 9, reorder: 4,
      dropB: [false], feedTag: true, decodeOrder: 'unlock' });
    const pics = shown(out.video);
    assert.equal(pics.length, 49);
    assert.ok(pics.every((p, i) => p.last && (!i || p.t - pics[i - 1].t === 1800)), JSON.stringify(pics.slice(0, 6)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
