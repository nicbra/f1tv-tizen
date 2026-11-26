'use strict';
// A small feed's decoder worker (app/js/mvdec-worker.js) on a real clip: picture times from the segment's start, how
// far ahead of the clock it decodes, and which pictures it leaves out when it is late.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');

let ffmpeg = true;
try { ffmpeg = /libx264/.test(cp.execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })); } catch (_) { ffmpeg = false; }
if (!ffmpeg && process.env.CI) ffmpeg = true;

const root = path.resolve(__dirname, '..');
// (the worker's own MessageChannel for its yields: ports unref'd, so they don't keep the tests running)
const Channel = function () { const c = new MessageChannel(); c.port1.unref(); c.port2.unref(); return c; };
let segment = null;
/** Two seconds of 50 fps I B B P (as F1's onboards), as one TS segment. */
function clip() {
  if (segment) return segment;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvdec-'));
  const out = path.join(dir, 's.ts');
  cp.execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=50', '-frames:v', '100', '-an',
    '-c:v', 'libx264', '-threads', '1', '-profile:v', 'main', '-x264-params', 'cabac=1:ref=2:bframes=2:b-adapt=0:b-pyramid=none:keyint=100:scenecut=0',
    '-f', 'mpegts', out]);
  segment = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return segment;
}

function harness() {
  const got = [], page = [];
  const port = { postMessage: (m) => { if (m.pic) got.push(m.pic); } };
  const ctx = { performance, setTimeout, Uint8Array, Int32Array, ArrayBuffer, WebAssembly, Promise, Math, Error, Infinity, MessageChannel: Channel,
    postMessage: (m) => page.push(m), fetch: async () => ({ ok: true, arrayBuffer: async () => clip().buffer.slice(clip().byteOffset, clip().byteOffset + clip().length) }) };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'app/js/mvdec-worker.js'), 'utf8'), ctx);
  ctx.turn.port1.unref();
  ctx.onmessage({ data: { op: 'init', wasm: fs.readFileSync(path.join(root, 'app/js/f1dec.wasm')), demux: fs.readFileSync(path.join(root, 'app/service/stitchx/tsdemux.js'), 'utf8'),
    feed: 0, port } });
  const abs = () => performance.timeOrigin + performance.now();
  return {
    got, page,
    play: (start) => ctx.onmessage({ data: { op: 'play', segments: [{ url: 's.ts', start, duration: 2 }], from: 0 } }),
    clock: (t, rate) => port.onmessage({ data: { clock: { t, at: abs(), rate } } }),
    stats: () => { ctx.onmessage({ data: { op: 'stats' } }); return page.filter((m) => m.stats).at(-1).stats; },
    stop: () => ctx.onmessage({ data: { op: 'stop' } })
  };
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('pictures are timed from the segment\'s start in frame steps, and decoded at most a second ahead of the clock', { skip: !ffmpeg }, async (t) => {
  const h = harness();
  t.after(() => h.stop());
  h.play(30);
  h.clock(30, 0);                    // paused at the segment's start
  await settle(400);
  const times = h.got.map((p) => p.t).sort((a, b) => a - b);
  assert.ok(times.length >= 40, 'decoded ' + times.length);
  assert.ok(Math.abs(times[0] - 30) < 1e-9, 'first ' + times[0]);
  // (at the edge the next P picture waits for the clock, and the B pictures shown before it with it)
  const settled = times.filter((t) => t < 30.9);
  assert.ok(settled.every((t, i) => !i || Math.abs(t - settled[i - 1] - 0.02) < 1e-6), 'frame steps: ' + settled.map((t) => t.toFixed(2)).join(' '));
  assert.ok(times.at(-1) <= 31 + 0.02, 'not beyond LEAD: ' + times.at(-1));
  assert.ok(times.at(-1) >= 30.9, 'up to LEAD: ' + times.at(-1));
  assert.equal(h.got[0].w * h.got[0].h * 3 / 2, h.got[0].data.byteLength);
});

test('late B pictures are left out (nothing predicts from them); the reference pictures all decode', { skip: !ffmpeg }, async (t) => {
  const h = harness();
  t.after(() => h.stop());
  h.play(30);
  h.clock(31, 0);                    // the clock is a second into the segment already
  await settle(400);
  const s = h.stats();
  const early = h.got.filter((p) => p.t < 31);
  // Before the clock only every third picture (I and P) decoded; from it on all of them.
  assert.ok(s.skipped >= 30, 'skipped ' + s.skipped);
  assert.ok(early.length >= 15 && early.length <= 18, 'references before the clock: ' + early.length);
  const later = h.got.filter((p) => p.t >= 31.06).map((p) => p.t).sort((a, b) => a - b);
  assert.ok(later.length >= 40, 'all pictures from the clock on: ' + later.length);
});
