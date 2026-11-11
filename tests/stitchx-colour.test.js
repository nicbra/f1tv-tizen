const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const os = require('os');
const cp = require('child_process');

const root = path.resolve(__dirname, '../app/service/stitchx');
const file = path.join(root, 'stitchx.js');
// Expose the SPS writer to test its colour metadata without changing the module's public API.
const source = fs.readFileSync(file, 'utf8').replace('return { tables: tables,', 'return { writeSpsForTest: writeSps, tables: tables,');
const m = new Module(file, module);
m.filename = file;
m.paths = module.paths;
m._compile(source, file);
const X = m.exports;
X.tables(require(path.join(root, 'cabac-tables.json')));
const base = {
  profile: 77, constraints: 64, level: 51, log2FrameNum: 16, log2PocLsb: 16, refFrames: 9,
  widthMbs: 60, heightMbs: 35, direct8x8: 1, reorder: 4, dpb: 9, frameDur: 1800
};

test('SPS rewrite preserves source colour/range, extended aspect and chroma location', () => {
  const fields = {
    vuiAspect: { id: 255, width: 4, height: 3 }, vuiOverscan: 0,
    videoSignal: { format: 5, fullRange: 1, descriptionPresent: 1, primaries: 1, transfer: 1, matrix: 1 },
    chromaLoc: [2, 3]
  };
  const result = X.parseSps(X.writeSpsForTest({ ...base, ...fields }));
  for (const key of Object.keys(fields)) {
    assert.deepEqual(result[key], fields[key]);
  }
  assert.equal(result.widthMbs, 60);
  assert.equal(result.heightMbs, 35);
});

test('unspecified colour stays unspecified; range-only signalling does not invent primaries', () => {
  const plain = X.parseSps(X.writeSpsForTest(base));
  assert.equal(plain.videoSignal, undefined);
  const signal = { format: 5, fullRange: 0, descriptionPresent: 0 };
  assert.deepEqual(X.parseSps(X.writeSpsForTest({ ...base, videoSignal: signal })).videoSignal, signal);
});

// The encoding check skips without ffmpeg, except in CI where it must run.
let ffmpeg = true;
try {
  cp.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch (_) {
  ffmpeg = !!process.env.CI;
}

test('different source colour matrices are rejected before one interleave can mislabel them', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h264-colour-'));
  try {
    const D = require(path.join(root, 'tsdemux.js'));
    const feeds = [];
    for (const matrix of ['bt709', 'smpte170m']) {
      const target = path.join(dir, matrix + '.ts');
      cp.execFileSync('ffmpeg', [
        '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=24',
        '-frames:v', '12', '-an', '-c:v', 'libx264', '-threads', '1', '-profile:v', 'main',
        '-x264-params', 'cabac=1:ref=1:bframes=2:b-adapt=0:b-pyramid=none:keyint=12:min-keyint=12:scenecut=0',
        '-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', matrix,
        '-f', 'mpegts', target
      ]);
      feeds.push(D.video(fs.readFileSync(target)));
    }
    assert.throws(() => X.interleaveSegment(feeds, { maxDpb: 9, reorder: 4 }), /VUI videoSignal differs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
