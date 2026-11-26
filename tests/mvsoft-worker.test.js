'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
function harness(options = {}) {
  const callbacks = [], messages = [], events = [];
  let now = 0, counting = false, target = null;
  const gl = new Proxy({
    getError: () => 0, getShaderParameter: () => true, getProgramParameter: () => true,
    checkFramebufferStatus: () => 1, FRAMEBUFFER_COMPLETE: 1,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    createTexture: () => ({}), createFramebuffer: () => ({}),
    bindFramebuffer: (_, f) => { target = f; events.push(f ? 'marker target' : 'visible target'); },
    drawArrays: () => { if (counting && options.drawFails) throw Error('draw failed'); if (counting && !target) events.push('canvas drawn'); }
  }, { get: (o, k) => k in o ? o[k] : /^[A-Z_0-9]+$/.test(k) ? k : () => {} });
  class MessageChannel {
    constructor() {
      this.port1 = { onmessage: null, close() { events.push('port1 closed'); } };
      this.port2 = { close() { events.push('port2 closed'); }, postMessage: () => callbacks.push(() => this.port1.onmessage && this.port1.onmessage()) };
    }
  }
  const T = { setWebGLRenderingContext() {},
    getPictureSync() { counting = true; now += options.slowPictures || 0; if (options.stopWhileBorrowing) ctx.onmessage({ data: { stop: true } }); return { texture: {} }; },
    recyclePictureSync() { events.push('recycle'); if (options.recycleFails) throw Error('recycle failed'); } };
  const ctx = { self: { tizentvwasm: { SideThreadElementaryMediaTrack: T } }, MessageChannel,
    performance: { now: () => ++now }, Float32Array, Uint8Array,
    postMessage: m => { messages.push(m); if (m.stopped) events.push('ack'); } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/mvsoft-worker.js'), 'utf8'), ctx);
  ctx.onmessage({ data: { start: true, canvas: { width: 639, height: 1080, getContext: () => gl }, trackId: 1,
    width: 960, height: 560, visibleRows: 540, feeds: 3, feedTag: { row: 544, values: [32, 96, 160] },
    rects: [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]] } });
  return { messages, events, post: (data) => ctx.onmessage({ data }), tick() { const cb = callbacks.shift(); assert.ok(cb); cb(); } };
}
test('the canvas is shown after the last picture of each moment the segments say, else after every three pictures', () => {
  const h = harness();
  h.post({ moments: Uint8Array.from([0, 1]) }); h.post({ moments: Uint8Array.from([0, 0, 1]) });
  const recycled = () => h.events.filter((x) => x === 'recycle').length;
  h.tick(); assert.equal(recycled(), 2, 'a moment of two feeds (the third had none at that time)');
  h.tick(); assert.equal(recycled(), 5, 'the next segment\'s first moment');
  h.tick(); assert.equal(recycled(), 6, 'no schedule left: every three pictures (6 pulled)');
});
test('the canvas gets a moment only once all its pictures are in, though a slow picture ends the step (a stop gets through)', () => {
  const h = harness({ slowPictures: 30 });   // each picture "takes" 30 ms, past the step's 25 ms
  h.post({ moments: Uint8Array.from([0, 0, 1]) });
  const count = (x) => h.events.filter((e) => e === x).length;
  h.tick(); assert.deepEqual([count('recycle'), count('canvas drawn')], [1, 0]);
  h.tick(); assert.deepEqual([count('recycle'), count('canvas drawn')], [2, 0]);
  h.tick(); assert.deepEqual([count('recycle'), count('canvas drawn')], [3, 1]);
});
test('pictures taken before their segment\'s list arrived are skipped in it: the next moments stay in step', () => {
  const h = harness();
  const recycled = () => h.events.filter((x) => x === 'recycle').length;
  h.tick(); assert.equal(recycled(), 3, 'no list yet: three pictures');
  h.post({ moments: Uint8Array.from([0, 0, 1, 0, 1, 0, 0, 1]) });   // its first three entries were those pictures
  h.tick(); assert.equal(recycled(), 5, 'the moment of pictures 4 and 5');
  h.tick(); assert.equal(recycled(), 8, 'then 6 to 8');
});
test('Stop during a native picture request recycles it and closes task ports before ACK', () => {
  const h = harness({ stopWhileBorrowing: true }); h.tick(); h.tick();
  const seq = h.events.filter(x => ['recycle', 'port1 closed', 'port2 closed', 'ack'].includes(x));
  assert.deepEqual(seq, ['recycle', 'port1 closed', 'port2 closed', 'ack']);
  assert.equal(h.events.at(-4), 'visible target', 'report restores the visible framebuffer before stop');
});
test('a draw failure returns the native picture before acknowledging stop', () => {
  const h = harness({ drawFails: true }); h.tick();
  assert.ok(h.messages.some(m => /draw failed/.test(m.error || '')));
  assert.ok(h.events.indexOf('recycle') < h.events.indexOf('ack'));
});
test('failed recycle withholds ACK so the page cannot destroy a borrowed texture', () => {
  const h = harness({ recycleFails: true }); h.tick();
  assert.ok(h.messages.some(m => /recycle failed/.test(m.error || '')));
  assert.ok(!h.messages.some(m => m.stopped));
});
