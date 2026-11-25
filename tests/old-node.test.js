// The stream helper's byte paths under an old Node's Buffer (issue #6: on a Tizen 5.5 TV every multiview grid failed
// with "Cannot read property 's' of undefined"; Node 4.4.3 and 4.9.1 fail the same way, Node 8 doesn't). In Node 4,
// Buffer.prototype.set is the old one-byte setter (`buf.set(offset, value)`: `buf.set(bytes, at)` copied nothing),
// and before 4.5 there is no Buffer.alloc and Buffer.from is Uint8Array.from. Here those come back for the length of a
// call: the helper must build the same bytes as with this Node's Buffer.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const st = require('../app/service/stitch.js');
const hv = require('../app/service/stitch-hevc.js');
const tm = require('../app/service/tm-ts.js');

/**
 * fn() with Node 4.4's Buffer as the global the helper uses: `new Buffer(n | string, encoding)`, no Buffer.alloc,
 * Uint8Array.from as Buffer.from, and the old buf.set(offset, value) on every Buffer.
 */
function node4(fn) {
  const Real = globalThis.Buffer, own = Object.getOwnPropertyDescriptor(Real.prototype, 'set');
  function Node4Buffer(arg, encoding) { return typeof arg === 'number' ? Real.alloc(arg) : Real.from(arg, encoding); }
  Node4Buffer.prototype = Real.prototype;
  Node4Buffer.from = Uint8Array.from;
  Node4Buffer.concat = Real.concat;
  Node4Buffer.isBuffer = Real.isBuffer;
  Object.defineProperty(Real.prototype, 'set', {
    configurable: true, writable: true,
    value: function set(offset, v) { offset = offset >>> 0; return (this[offset] = v); }   // Node 4's lib/buffer.js
  });
  globalThis.Buffer = Node4Buffer;
  try { return fn(); } finally {
    globalThis.Buffer = Real;
    if (own) Object.defineProperty(Real.prototype, 'set', own); else delete Real.prototype.set;
  }
}

const same = (a, b, what) => assert.ok(Buffer.from(a).equals(Buffer.from(b)), what + ' differs under Node 4\'s Buffer');

function split(buf) {
  let p = 0;
  const init = [], seg = [];
  while (p < buf.length) {
    const size = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    (type === 'ftyp' || type === 'moov' ? init : seg).push(buf.subarray(p, p + size));
    p += size;
  }
  return { init: Buffer.concat(init), seg: Buffer.concat(seg) };
}
const clips = () => [0, 1, 2, 3].map((i) => split(readFileSync(path.join(__dirname, 'fixtures/stitch/hevc' + i + '.mp4'))));

test('Node 4\'s Buffer is emulated here: buf.set(bytes, at) copies nothing, Buffer.from(hex) throws', () => {
  node4(() => {
    const b = new Buffer(4).fill(0);
    b.set([1, 2], 1);
    assert.deepEqual([...b], [1, 0, 0, 0], 'as Node 4.4.3: the bytes become offset 0, `at` its value');
    assert.throws(() => Buffer.from('0a0b', 'hex'), /not a function/);
  });
  const b = Buffer.alloc(4);
  b.set([1, 2], 1);
  assert.deepEqual([...b], [0, 1, 2, 0], 'restored afterwards');
});

test('an HEVC multiview grid is the same bytes under Node 4\'s Buffer (issue #6: it was zeroed, then refused)', () => {
  const c = clips(), inits = c.map((x) => x.init), segs = c.map((x) => x.seg);
  const want = hv.prepare(inits, segs, 'grid2x2', 50), wantSeg = hv.gridSegment(segs, want.cfg);
  const got = node4(() => { const g = hv.prepare(inits, segs, 'grid2x2', 50); return { g, seg: hv.gridSegment(segs, g.cfg) }; });
  same(got.g.init, want.init, 'the grid\'s init');
  same(got.seg, wantSeg, 'the grid\'s segment');
  assert.equal(st.fragment(got.seg).samples.length, 16);
});

test('player_tm segments (decrypt, unpack, init) and their grid are the same bytes under Node 4\'s Buffer', () => {
  const KEY = '000102030405060708090a0b0c0d0e0f', IV = '0x1f1e1d1c1b1a19181716151413121110';
  const enc = (buf) => { const x = crypto.createCipheriv('aes-128-cbc', Buffer.from(KEY, 'hex'), Buffer.from(IV.slice(2), 'hex')); return Buffer.concat([x.update(buf), x.final()]); };
  const raw = [0, 1, 2, 3].map((i) => enc(readFileSync(path.join(__dirname, 'fixtures/stitch/hevc' + i + '.ts'))));
  const build = () => {
    const made = raw.map((r) => tm.convert(r, { key: KEY, iv: IV }, 7, null)), inits = made.map((m) => tm.init(m.aus));
    const g = hv.prepare(inits, made.map((m) => m.segment), 'grid2x2', 50);
    return { seg: made[0].segment, init: inits[0], grid: hv.gridSegment(made.map((m) => m.segment), g.cfg),
      iv: tm.ivFor(null, 311687449), ivHex: tm.ivFor(IV, 0) };
  };
  const want = build(), got = node4(build);
  ['seg', 'init', 'grid', 'iv', 'ivHex'].forEach((k) => same(got[k], want[k], k));
});

test('hex and latin1 bytes without Buffer.from read as Buffer.from does, odd or broken hex too', () => {
  for (const hex of ['000102ff', '0x1F1e', '0a1', 'zz', '0a0g12', '', '0x']) {
    assert.deepEqual([...node4(() => st.fromHex(hex))], [...Buffer.from(hex.replace(/^0x/i, ''), 'hex')], hex);
  }
  for (const s of ['iso6cmfc', 'video\0', 'éĀ']) assert.deepEqual([...node4(() => st.fromLatin1(s))], [...Buffer.from(s, 'latin1')], s);
});

test('the H.264 multiview route answers a view\'s own bytes with this Node\'s, Node 4.4\'s and Node 4.5-5.9\'s Buffer', () => {
  const route = require('../app/service/stitchx/helper-route.js');
  const sent = [];
  const r = route({ fetchAll() {}, send: (res, status, body) => sent.push(body), toBuf: (t) => t, f1Cdn: () => true, port: 0 });
  const whole = new Uint8Array([9, 9, 1, 2, 3, 9]), s = { init: { video: whole.subarray(2, 5), audio: whole } };
  const answer = () => { sent.length = 0; r.get({}, s, 'init.mp4', 'g'); r.get({}, s, 'audio-init.mp4', 'g'); return sent.map((b) => [Buffer.isBuffer(b), ...b]); };
  const want = [[true, 1, 2, 3], [true, 9, 9, 1, 2, 3, 9]];
  assert.deepEqual(answer(), want);
  assert.deepEqual(node4(answer), want, 'Node 4.4: Buffer.from is Uint8Array.from');
  // Node 4.5-5.9: Buffer.from(arrayBuffer, offset, length) ignored offset and length (the whole buffer came out).
  const from = Buffer.from;
  Buffer.from = function (x, ...rest) { return x instanceof ArrayBuffer ? from.call(Buffer, x) : from.call(Buffer, x, ...rest); };
  try { assert.deepEqual(answer(), want, 'Node 4.9'); } finally { Buffer.from = from; }
});
