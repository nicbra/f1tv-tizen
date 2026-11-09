'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function harness() {
  const events = [], timers = new Map(), workers = [], posts = [], errors = [];
  let serial = 0, position = 0, canvas;
  const parent = { insertBefore() {}, replaceChild(fresh, old) { assert.equal(old, canvas); canvas = fresh; fresh.parentNode = parent; events.push('replace canvas'); } };
  function makeCanvas() {
    const c = { id: 'mv-soft', classList: { add() {}, remove() {} }, style: {}, parentNode: parent,
      cloneNode() { return makeCanvas(); }, transferControlToOffscreen() { assert.ok(!c.transferred); c.transferred = true; return { owner: c }; },
      getContext() { throw Error('page must not acquire a bitmap context'); } };
    return c;
  }
  canvas = makeCanvas();
  class Source {
    constructor() { Source.instances.push(this); }
    addVideoTrack(o) { this.trackOptions = o; return { trackId: 1, sessionId: 2 }; }
    open() { return Promise.resolve(); }
    destroy() { events.push('destroy source'); }
  }
  Source.instances = [];
  class Worker {
    constructor() { workers.push(this); this.number = workers.length; }
    postMessage(m, transfers) {
      if (m.start) { this.start = m; assert.equal(transfers[0], m.canvas); position = posts.at(-1).probe * 3.84 - .08; this.onmessage({ data: { ready: true } }); }
      if (m.stop) events.push('stop worker ' + this.number);
    }
    ack() { this.onmessage({ data: { stopped: true } }); }
    terminate() { events.push('terminate worker ' + this.number); }
  }
  const T = { appendPacketAsync() {} };
  const api = { ElementaryMediaStreamSource: Source, SideThreadElementaryMediaTrack: T };
  class MediaURL extends URL { static createObjectURL() { return 'blob:test'; } static revokeObjectURL() { events.push('revoke'); } }
  const ctx = { window: { tizentvwasm: api, OffscreenCanvas: function () {}, HTMLCanvasElement: function () {}, MessageChannel: function () {}, Worker },
    Worker, Promise, Object, URL: MediaURL,
    StreamProxy: { ensure: () => Promise.resolve() },
    CmafDash: { videoTrack: () => ({ codec: 'avc1', extradata: [], width: 960, height: 560, timescale: 90000 }),
      samples: () => [{ dts: 0, pts: .1, duration: .04, key: true, data: new Uint8Array(1) }] },
    document: { createElement: () => ({ style: {}, paused: true, currentTime: 0, muted: true,
      set src(v) { this._src = v; queueMicrotask(() => { if (Source.instances.at(-1).onsourceopenpending) Source.instances.at(-1).onsourceopenpending(); }); },
      play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, removeAttribute() {}, load() {}, remove() {} }) },
    fetch: async (url, options) => {
      if (options && options.method === 'POST') { posts.push(JSON.parse(options.body)); return { status: 201, text: async () => JSON.stringify({ segments: 100, visibleRows: 540, feedTag: { row: 544, values: [32, 96, 160] } }) }; }
      if (/\.m4s$|init\.mp4$/.test(url)) return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
      return { ok: true, url, text: async () => /master/.test(url) ? '#EXT-X-STREAM-INF:RESOLUTION=960x540,CODECS="avc1.4d401f"\nmedia.m3u8' : '#EXTINF:3.84,\na.ts\n'.repeat(100) };
    },
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, interval: false }); return id; },
    setInterval: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval: id => timers.delete(id), Diag: { note: (kind) => events.push(kind) }
  };
  ctx.window.HTMLCanvasElement.prototype.transferControlToOffscreen = function () {};
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/mvsoft.js'), 'utf8'), ctx);
  const opts = () => ({ streams: [1, 2, 3].map(() => ({ url: 'http://cdn/master.m3u8' })),
    rects: [0, 1, 2].map(k => ({ left: 1280, top: k * 360, width: 640, height: 360 })), canvas,
    clock: { position: () => position, playing: () => true }, onError: e => errors.push(e.message) });
  return { api: ctx.MvSoftware, opts, workers, posts, events, errors, Source,
    expire: async ms => { for (const [id, t] of [...timers]) if (!t.interval && t.ms === ms) { timers.delete(id); t.fn(); } await flush(); } };
}

test('native software onboards transfer a fresh visible canvas and use the validated stream settings', async () => {
  const h = harness(); assert.equal(h.api.supported(), true);
  await h.api.start(h.opts());
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].start.canvas.owner.id, 'mv-soft');
  assert.equal(h.workers[0].start.feeds, 3);
  assert.equal(h.Source.instances[0].trackOptions.decodingMode, 'software');
  assert.equal(h.posts[0].maxDpb, 9); assert.equal(h.posts[0].level, 51); assert.deepEqual(h.posts[0].targetFps, [25, 25, 25]);
  const stopped = h.api.stop(); await flush(); assert.ok(!h.events.includes('destroy source'));
  h.workers[0].ack(); assert.equal(await stopped, true);
  assert.ok(h.events.indexOf('terminate worker 1') < h.events.indexOf('destroy source'));
});

test('replacement waits for the previous worker to release its decoder and canvas', async () => {
  const h = harness(); await h.api.start(h.opts());
  const start = h.api.start(h.opts()); await flush(); assert.equal(h.workers.length, 1);
  h.workers[0].ack(); await start;
  assert.equal(h.workers.length, 2);
  assert.notEqual(h.workers[0].start.canvas.owner, h.workers[1].start.canvas.owner);
  assert.ok(h.events.indexOf('terminate worker 1') < h.events.lastIndexOf('replace canvas'));
  const stopped = h.api.stop(); h.workers[1].ack(); await stopped;
});

test('Stop cancels a pending replacement instead of restarting playback after the ACK', async () => {
  const h = harness(); await h.api.start(h.opts());
  const start = h.api.start(h.opts()); await flush(); const stopped = h.api.stop();
  h.workers[0].ack(); await Promise.all([start, stopped]);
  assert.equal(h.workers.length, 1); assert.equal(h.api.running(), false);
});

test('an unacknowledged worker keeps its source alive and blocks another decoder until a late ACK', async () => {
  const h = harness(); await h.api.start(h.opts());
  const start = h.api.start(h.opts()); await flush(); await h.expire(1500); await start;
  assert.equal(h.workers.length, 1); assert.ok(!h.events.includes('destroy source'));
  assert.match(h.errors[0], /Restart the app/);
  h.workers[0].ack(); await flush(); assert.ok(h.events.includes('destroy source'));
  await h.api.start(h.opts()); assert.equal(h.workers.length, 2);
  const stopped = h.api.stop(); h.workers[1].ack(); await stopped;
});
