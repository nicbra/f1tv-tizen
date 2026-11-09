'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
function harness(options = {}) {
  const callbacks = [], messages = [], events = [];
  let now = 0, counting = false;
  const gl = new Proxy({
    getError: () => 0, getShaderParameter: () => true, getProgramParameter: () => true,
    checkFramebufferStatus: () => 1, FRAMEBUFFER_COMPLETE: 1,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    createTexture: () => ({}), createFramebuffer: () => ({}),
    bindFramebuffer: (_, f) => events.push(f ? 'marker target' : 'visible target'),
    drawArrays: () => { if (counting && options.drawFails) throw Error('draw failed'); }
  }, { get: (o, k) => k in o ? o[k] : /^[A-Z_0-9]+$/.test(k) ? k : () => {} });
  class MessageChannel {
    constructor() {
      this.port1 = { onmessage: null, close() { events.push('port1 closed'); } };
      this.port2 = { close() { events.push('port2 closed'); }, postMessage: () => callbacks.push(() => this.port1.onmessage && this.port1.onmessage()) };
    }
  }
  const T = { setWebGLRenderingContext() {},
    getPictureSync() { counting = true; if (options.stopWhileBorrowing) ctx.onmessage({ data: { stop: true } }); return { texture: {} }; },
    recyclePictureSync() { events.push('recycle'); if (options.recycleFails) throw Error('recycle failed'); } };
  const ctx = { self: { tizentvwasm: { SideThreadElementaryMediaTrack: T } }, MessageChannel,
    performance: { now: () => ++now }, Float32Array, Uint8Array,
    postMessage: m => { messages.push(m); if (m.stopped) events.push('ack'); } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/mvsoft-worker.js'), 'utf8'), ctx);
  ctx.onmessage({ data: { start: true, canvas: { width: 639, height: 1080, getContext: () => gl }, trackId: 1,
    width: 960, height: 560, visibleRows: 540, feeds: 3, feedTag: { row: 544, values: [32, 96, 160] },
    rects: [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]] } });
  return { messages, events, tick() { const cb = callbacks.shift(); assert.ok(cb); cb(); } };
}
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
