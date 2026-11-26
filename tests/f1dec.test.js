// Our H.264 decoder (native/f1dec, app/js/f1dec.wasm) against FFmpeg's: every picture bit-exact, on clips x264 codes
// with F1's tools (Main profile, CABAC, I B B P, spatial direct, implicit weights) and the others Main allows. The
// clips go through the decoder worker's own code (app/js/mvdec-worker.js: TS demux, decoding, the copy out).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
// Both builds: plain (Tizen 6) and with WebAssembly SIMD (Tizen 7+), where this Node has SIMD.
const BUILDS = ['f1dec.wasm', 'f1dec-simd.wasm'].filter((f) => WebAssembly.validate(fs.readFileSync(path.join(root, 'app/js', f))))
  .map((f) => [f, new WebAssembly.Module(fs.readFileSync(path.join(root, 'app/js', f)))]);
let wasm = BUILDS[0][1];
const TsDemux = require(path.join(root, 'app/service/stitchx/tsdemux.js'));

// The worker's Decoder, from its own file.
// (the worker's own MessageChannel for its yields: ports unref'd, so they don't keep the tests running)
const Channel = function () { const c = new MessageChannel(); c.port1.unref(); c.port2.unref(); return c; };
const ctx = { performance, setTimeout, Uint8Array, Int32Array, ArrayBuffer, WebAssembly, Promise, Math, Error, MessageChannel: Channel, postMessage() {}, self: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'app/js/mvdec-worker.js'), 'utf8'), ctx);
ctx.turn.port1.unref();
const Decoder = ctx.Decoder;

// The encoding checks skip without FFmpeg (with libx264), except in CI where they must run.
let ffmpeg = true;
try {
  ffmpeg = /libx264/.test(cp.execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }));
} catch (_) {
  ffmpeg = false;
}
if (!ffmpeg && process.env.CI) ffmpeg = true;

const FRAMES = 40;

/** A TS clip from x264 with these parameters; returns its path. */
function clip(dir, name, params, opts = {}) {
  const size = opts.size || '192x112', src = `testsrc2=size=${size}:rate=50` + (opts.noise ? ',noise=alls=14:allf=t+u' : '') +
    (opts.fade ? ',fade=t=in:st=0:d=0.5,fade=t=out:st=0.4:d=0.4' : '');
  const out = path.join(dir, name + '.ts');
  cp.execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', src, '-frames:v', String(opts.frames || FRAMES), '-an',
    '-c:v', 'libx264', '-threads', '1', '-profile:v', opts.profile || 'main', ...(opts.qp != null ? ['-qp', String(opts.qp)] : []),
    '-x264-params', params, '-f', 'mpegts', out]);
  return out;
}

/** FFmpeg's pictures (I420, display order) as one buffer. */
function reference(file) {
  return cp.execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
    { maxBuffer: 1 << 28 });
}

/** Our pictures in display order (by PTS), as one buffer; deblock: f1dec_option. */
function ours(file, deblock) {
  const dec = new Decoder(wasm);
  if (deblock) dec.x.f1dec_option(dec.d, deblock);
  const pics = [];
  for (const au of TsDemux.video(new Uint8Array(fs.readFileSync(file)))) {
    if (!dec.decode(au.data)) continue;
    const { w, h } = dec.size(), buf = new ArrayBuffer(w * h * 3 / 2);
    dec.copyTo(buf, w, h);
    pics.push({ pts: au.pts, data: Buffer.from(buf) });
  }
  dec.destroy();
  return Buffer.concat(pics.sort((a, b) => a.pts - b.pts).map((p) => p.data));
}

function same(file, label) {
  const a = ours(file), b = reference(file);
  assert.equal(a.length, b.length, label + ': picture count');
  if (!a.equals(b)) {
    let i = 0;
    while (a[i] === b[i]) i++;
    assert.fail(label + ': first difference at byte ' + i);
  }
}

const F1 = 'cabac=1:ref=2:bframes=2:b-adapt=0:b-pyramid=none:weightb=1:direct=spatial:weightp=0:keyint=50:scenecut=0:aud=1';
const CASES = {
  'F1 onboards: I B B P, spatial direct, implicit weights': [F1],
  'textured, lower QP (more levels, intra in P/B)': [F1, { noise: true, qp: 18 }],
  'high QP (strong deblocking)': [F1, { qp: 44 }],
  'several references, B references, explicit weights, temporal direct': ['cabac=1:ref=4:bframes=3:b-pyramid=normal:b-adapt=2:weightb=1:weightp=2:direct=temporal:mixed-refs=1:keyint=24:aud=1'],
  'explicit weights (fades)': ['cabac=1:ref=2:bframes=2:weightb=1:weightp=2:keyint=50:aud=1', { fade: true }],
  'plain bi-prediction, several slices, deblocking offsets': ['cabac=1:ref=2:bframes=2:weightb=0:direct=auto:slices=3:deblock=-2,1:keyint=30:aud=1'],
  'no deblocking, constrained intra': ['cabac=1:ref=1:bframes=1:no-deblock=1:constrained-intra=1:keyint=16:aud=1'],
  'cropped size, IDR every 8 pictures': [F1.replace('keyint=50', 'keyint=8:min-keyint=8'), { size: '200x120' }],
  'P only, many partitions': ['cabac=1:ref=3:bframes=0:partitions=all:subme=7:keyint=40:aud=1', { noise: true }]
};

for (const [label, [params, opts]] of Object.entries(CASES)) {
  test('f1dec: ' + label, { skip: !ffmpeg }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1dec-'));
    try {
      const file = clip(dir, 'c', params, opts);
      for (const [name, module] of BUILDS) { wasm = module; same(file, label + ' (' + name + ')'); }
    } finally { wasm = BUILDS[0][1]; fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('f1dec: the SIMD build exists and this Node runs it (CI must check it)', () => {
  assert.equal(BUILDS.length, 2, BUILDS.map((b) => b[0]).join());
});

test('f1dec: refuses what it does not decode (CAVLC, 8x8 transforms), so the multiview can fall back', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1dec-'));
  try {
    for (const [name, params, profile] of [['cavlc', 'cabac=0:bframes=0:aud=1', 'baseline'], ['8x8', 'cabac=1:8x8dct=1:aud=1', 'high']]) {
      const dec = new Decoder(wasm);
      const aus = TsDemux.video(new Uint8Array(fs.readFileSync(clip(dir, name, params, { profile, frames: 3 }))));
      assert.throws(() => aus.forEach((au) => dec.decode(au.data)), (e) => e.code === -2, name);
      dec.destroy();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('f1dec: unfiltered non-reference pictures stay close and leave the references exact', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1dec-'));
  try {
    const file = clip(dir, 'c', F1, { noise: true, qp: 30 });
    const a = ours(file, 1), b = reference(file), size = 192 * 112 * 3 / 2;
    let exact = 0, worst = Infinity;
    for (let i = 0; i < a.length / size; i++) {
      const x = a.subarray(i * size, (i + 1) * size), y = b.subarray(i * size, (i + 1) * size);
      if (x.equals(y)) { exact++; continue; }
      let se = 0;
      for (let k = 0; k < size; k++) se += (x[k] - y[k]) ** 2;
      worst = Math.min(worst, 10 * Math.log10(255 * 255 * size / se));
    }
    // I B B P: every third picture is a reference (decoded exactly); the B pictures differ by their filtering only.
    assert.ok(exact >= Math.floor(FRAMES / 3), 'exact pictures: ' + exact);
    assert.ok(worst > 35, 'worst B picture ' + worst.toFixed(1) + ' dB');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('f1dec: damaged streams end in decoder errors, never anything else, and in bounded time', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1dec-'));
  try {
    const clean = TsDemux.video(new Uint8Array(fs.readFileSync(clip(dir, 'c', 'cabac=1:ref=3:bframes=2:weightb=1:weightp=2:keyint=20:aud=1',
      { noise: true, fade: true }))));
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
    const t0 = Date.now();
    for (let k = 0; k < 60; k++) {
      const dec = new Decoder(wasm);
      for (const au of clean) {
        const d = au.data.slice();
        if (rand(3) === 0) for (let i = 0, n = 1 + rand(8); i < n; i++) d[4 + rand(d.length - 4)] ^= 1 << rand(8);
        try { dec.decode(rand(10) ? d : d.subarray(0, rand(d.length))); } catch (e) { assert.ok(e.code < 0, 'unexpected ' + e); }
      }
      dec.destroy();
    }
    assert.ok(Date.now() - t0 < 30000, 'took ' + (Date.now() - t0) + ' ms');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('f1dec: a picture missing a slice still comes out, the missing part from the newest reference', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1dec-'));
  try {
    const aus = TsDemux.video(new Uint8Array(fs.readFileSync(clip(dir, 'c', 'cabac=1:ref=1:bframes=0:slices=3:keyint=30:aud=1', { frames: 4 }))));
    const dec = new Decoder(wasm), out = (au) => {
      assert.equal(dec.decode(au), true);
      const { w, h } = dec.size(), buf = new ArrayBuffer(w * h * 3 / 2);
      dec.copyTo(buf, w, h);
      return { w, h, y: new Uint8Array(buf, 0, w * h) };
    };
    const first = out(aus[0].data);
    // The second picture without its last slice NAL unit.
    const d = aus[1].data, starts = [];
    for (let i = 0; i + 3 < d.length; i++) if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) starts.push(i);
    const slices = starts.filter((s) => [1, 5].includes(d[s + 3] & 31));
    const second = out(d.subarray(0, slices.at(-1)));
    // 192x112: 7 macroblock rows (12 macroblocks each) in 3 slices of 28: the last starts in row 4, so rows 5 and 6 are
    // all concealed (their top edge filtered against row 4: 3 sample rows).
    const row = (p, y) => Buffer.from(p.y.subarray(y * p.w, (y + 1) * p.w));
    for (let y = 5 * 16 + 3; y < 112; y++) assert.ok(row(second, y).equals(row(first, y)), 'row ' + y);
    dec.destroy();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
