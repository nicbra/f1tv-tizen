'use strict';
// The drawing worker of our decoder's multiview (app/js/mvdraw-worker.js): which picture each feed shows by the big
// feed's clock, and what goes back to the decoders.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function harness() {
  let now = 0, frame = null;
  const posted = [], uploads = [], draws = [];
  const gl = new Proxy({ TEXTURE0: 33984, COMPILE_STATUS: 1, LINK_STATUS: 2, LUMINANCE: 6409,
    texImage2D: (...a) => uploads.push(a[3] + 'x' + a[4]), texSubImage2D: (...a) => uploads.push(a[4] + 'x' + a[5]),
    drawArrays: () => draws.push(now), getShaderParameter: () => true, getProgramParameter: () => true }, {
    get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z_]+$/.test(k) ? 1 : () => ({}))
  });
  const ports = [0, 1].map(() => ({ sent: [], postMessage(m) { this.sent.push(m); } }));
  const ctx = { performance: { timeOrigin: 0, now: () => now }, postMessage: (m) => posted.push(m), Float32Array, Uint8Array, Math,
    requestAnimationFrame: (fn) => { frame = fn; } };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/mvdraw-worker.js'), 'utf8'), ctx);
  ctx.onmessage({ data: { start: true, canvas: { width: 640, height: 720, getContext: () => gl }, rects: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]], ports } });
  const pic = (t) => ({ t, w: 4, h: 2, data: new ArrayBuffer(12) });
  return {
    ctx, ports, posted, uploads, draws,
    send: (k, t) => ports[k].onmessage({ data: { pic: pic(t) } }),
    clock: (pos, playing = true) => ctx.onmessage({ data: { clock: { pos, at: now, playing, rate: 1 } } }),
    frame: (ms) => { now += ms; const f = frame; frame = null; f(); },
    stats: () => posted.filter((m) => m.stats).at(-1).stats,
    freed: (k) => ports[k].sent.filter((m) => m.free).length
  };
}

test('each feed shows its newest picture that is due; B pictures arriving after their P are put in time order', () => {
  const h = harness();
  h.clock(10);
  // decode order I P B B: times 10.00, 10.06, 10.02, 10.04
  [10, 10.06, 10.02, 10.04].forEach((t) => h.send(0, t));
  h.frame(1);                        // clock 10.001: the I picture
  assert.equal(h.uploads.length, 3); // Y, U, V
  h.frame(20);                       // 10.021: the first B
  h.frame(20);                       // 10.041: the second B
  h.frame(20);                       // 10.061: the P
  assert.equal(h.uploads.length, 12);
  assert.equal(h.draws.length, 4, 'one canvas update per new picture');
  assert.equal(h.freed(0), 3, 'each picture goes back once the next one shows');
  h.frame(500);
  assert.equal(JSON.stringify(h.stats().perFeed), '[4,0]');
  assert.equal(JSON.stringify(h.stats().dropped), '[0,0]');
});

test('pictures that came too late to show are given back unshown, and counted', () => {
  const h = harness();
  h.clock(20);
  [19.9, 19.92, 19.94, 19.96].forEach((t) => h.send(1, t));
  h.frame(1);
  assert.equal(h.uploads.length, 3, 'only the newest due one uploads');
  assert.equal(h.freed(1), 3);
  h.frame(500);
  assert.equal(JSON.stringify(h.stats().dropped), '[0,3]');
});

test('a picture older than the one shown is given back unshown (motion never steps back)', () => {
  const h = harness();
  h.clock(10);
  h.send(0, 10.06); h.frame(70);     // the P picture, shown at 10.07
  h.send(0, 10.02); h.send(0, 10.04); h.frame(20);
  assert.equal(h.uploads.length, 3, 'only the P picture uploaded');
  assert.equal(h.freed(0), 2);
  h.frame(500);
  assert.equal(JSON.stringify(h.stats().dropped), '[2,0]');
});

test('the clock stands still while the big feed is paused; the decoders hear the clock with its rate', () => {
  const h = harness();
  h.clock(5, false);
  h.send(0, 5.5);
  h.frame(1000);
  assert.equal(h.uploads.length, 0, 'not due while paused');
  const c = h.ports[0].sent.filter((m) => m.clock).at(-1).clock;
  assert.equal(c.t, 5); assert.equal(c.rate, 0);
  h.clock(5, true);
  h.frame(600);
  assert.equal(h.uploads.length, 3);
});

test('the page hears once when the first picture shows', () => {
  const h = harness();
  h.clock(1);
  h.send(0, 1); h.frame(1); h.send(0, 1.02); h.frame(20);
  assert.equal(h.posted.filter((m) => m.shown).length, 1);
});
