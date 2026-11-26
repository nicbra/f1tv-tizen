'use strict';
// MvSoftware's engine 'wasm' (our own decoder, one worker per small feed, js/mvsoft.js): which engine and size a start
// gets, what the workers are told, and the fallback to Samsung's decoder.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const ladder = (rows, fps) => rows.map((r) => `#EXT-X-STREAM-INF:RESOLUTION=${Math.round(r * 16 / 9)}x${r},CODECS="avc1.4d401f"` +
  (fps ? ',FRAME-RATE=' + fps : '') + `\n${r}.m3u8`).join('\n');

function harness({ rows = [270, 288, 360, 540], fps = null, emss = true, position = 100, store = {}, simd = false } = {}) {
  const events = [], workers = [], timers = new Map(), errors = [], shown = [];
  let serial = 0, pos = position, canvas, paused = false;
  const parent = { insertBefore() {}, replaceChild(fresh, old) { canvas = fresh; fresh.parentNode = parent; } };
  function makeCanvas() {
    const c = { classList: { add: (x) => events.push('canvas ' + x), remove: (x) => events.push('canvas shown') }, style: {}, parentNode: parent,
      cloneNode: () => makeCanvas(), transferControlToOffscreen: () => ({ owner: c }) };
    return c;
  }
  canvas = makeCanvas();
  class Worker {
    constructor(name) { this.name = name; this.sent = []; workers.push(this); }
    postMessage(m) {
      this.sent.push(m);
      if (m.op === 'init' || m.start) queueMicrotask(() => this.onmessage({ data: { ready: true } }));
      if (m.stop) queueMicrotask(() => this.onmessage({ data: { stopped: true } }));   // Samsung's path waits for it
    }
    terminate() { this.ended = true; events.push('terminate ' + this.name); }
  }
  class Source { addVideoTrack() { return { trackId: 1, sessionId: 2 }; } open() { return Promise.resolve(); } destroy() {} }
  class MessageChannel { constructor() { this.port1 = { side: 1 }; this.port2 = { side: 2 }; } }
  const window = { WebAssembly: { validate: () => !!simd }, performance: { timeOrigin: 1000 }, OffscreenCanvas: function () {}, HTMLCanvasElement: function () {},
    MessageChannel, Worker, tizentvwasm: emss ? { ElementaryMediaStreamSource: Source, SideThreadElementaryMediaTrack: { appendPacketAsync() {} } } : undefined };
  window.HTMLCanvasElement.prototype.transferControlToOffscreen = function () {};
  class MediaURL extends URL { static createObjectURL() { return 'blob:test'; } static revokeObjectURL() {} }
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  let clockNow = 0, perfNow = 0;
  const ctx = { window, Worker, MessageChannel, Promise, Object, URL: MediaURL, TextDecoder, localStorage, Date: { now: () => clockNow }, performance: { timeOrigin: 1000, now: () => perfNow },
    Launcher: { file: (rel, done) => done(null, new TextEncoder().encode(/\.wasm$/.test(rel) ? rel : 'var TsDemux = {};')), worker: (n) => new Worker(n) },
    WebAssembly: { validate: () => !!simd },
    fetch: async (url, o) => {
      // Samsung's path: the helper's stitch and its segments
      if (o && o.method === 'POST') return { status: 201, text: async () => JSON.stringify({ segments: 300, visibleRows: 540, feedTag: { row: 544, values: [32, 96, 160] } }) };
      if (/\.m4s$|init\.mp4$/.test(url)) return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
      return { ok: true, url, text: async () => /master/.test(url) ? ladder(rows, fps) : '#EXTINF:3.84,\ns.ts\n'.repeat(300) };
    },
    StreamProxy: { ensure: () => Promise.resolve() },
    CmafDash: { videoTrack: () => ({ codec: 'avc1', extradata: [], width: 960, height: 560, timescale: 90000 }),
      samples: () => [{ dts: 0, pts: 0.1, duration: 0.04, key: true, data: new Uint8Array(1) }] },
    document: { createElement: () => ({ style: {}, set src(v) {}, play: () => Promise.resolve(), pause() {}, removeAttribute() {}, load() {}, remove() {} }) },
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, interval: false }); return id; },
    setInterval: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval: (id) => timers.delete(id), Diag: { note: (kind, data) => events.push(kind + ' ' + JSON.stringify(data)) },
    Player: { engineLost: (name) => events.push('lost ' + name) }
  };
  ctx.TextEncoder = TextEncoder;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/failure.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/mvsoft.js'), 'utf8'), ctx);
  const opts = (n = 3) => {
    const rects = Array.from({ length: n }, (_, k) => ({ left: 1280, top: k * 360, width: 640, height: 360 }));
    return { streams: rects.map(() => ({ url: 'http://cdn/master.m3u8' })), rects, canvas,
      clock: { position: () => pos, playing: () => !paused }, onError: (e) => errors.push(e.message), onShown: () => shown.push(1) };
  };
  const tick = (ms) => { perfNow += ms; for (const t of [...timers.values()]) if (t.interval && t.ms === ms) t.fn(); };
  return { api: ctx.MvSoftware, opts, workers, events, errors, shown, tick, seek: (p) => { pos = p; }, pause: (v) => { paused = v; }, store, later: (ms) => { clockNow += ms; },
    decoders: () => workers.filter((w) => w.name === 'js/mvdec-worker.js' && !w.ended),
    draw: () => workers.filter((w) => w.name === 'js/mvdraw-worker.js' && !w.ended)[0] };
}

test('three small feeds: our decoder, one worker each, at 288p with B pictures unfiltered, from the segment the big feed is in', async () => {
  const h = harness({ position: 100 });
  await h.api.start(h.opts(3));
  assert.equal(h.api.status().engine, 'wasm');
  const dec = h.decoders();
  assert.equal(dec.length, 3);
  dec.forEach((w, k) => {
    const init = w.sent.find((m) => m.op === 'init'), play = w.sent.find((m) => m.op === 'play');
    assert.equal(init.feed, k);
    assert.equal(init.unfiltered, true);
    assert.equal(new TextDecoder().decode(init.wasm), 'js/f1dec.wasm');
    assert.match(init.demux, /TsDemux/);
    assert.equal(play.from, 26);                       // 26 * 3.84 = 99.84 <= 100 < 103.68
    assert.match(play.segments[0].url, /\/270\.m3u8$|s\.ts$/);
  });
  const draw = h.draw(), start = draw.sent.find((m) => m.start);
  assert.equal(start.ports.length, 3);
  assert.equal(JSON.stringify(start.rects[1].map((x) => +x.toFixed(3))), '[0,0.333,1,0.333]');
  assert.ok(!h.events.some((e) => /^lost /.test(e)), 'the browser\'s MediaSource stays usable');
  assert.ok(h.events.some((e) => /mv\.h264\.start .*"rows":288.*"engine":"wasm".*"unfiltered":true/.test(e)), h.events.join('\n'));
});

test('the budget learns only from windows where it played and every decoder decoded; kept without localStorage too', async () => {
  const h = harness();
  await h.api.start(h.opts(3));
  h.draw().onmessage({ data: { shown: true } });
  const stats = (each) => h.decoders().forEach((w, k) => w.onmessage({ data: { stats: each(k) } }));
  stats(() => ({ decoded: 0, decodeMs: 0, skipped: 0 })); h.tick(1000);
  h.later(8000); h.tick(1000); h.later(10000);
  // one decoder produced nothing in the window: nothing learned
  stats((k) => ({ decoded: k === 2 ? 0 : 500, decodeMs: k === 2 ? 0 : 5000, skipped: 0 })); h.tick(1000);
  assert.equal(h.store['f1tv.mvbudget'], undefined);
  assert.equal(h.api.status().learned, undefined);
  // a pause throws the window away and the warm-up starts over
  h.pause(true); h.later(5000); h.tick(1000); h.pause(false);
  h.later(1000); stats((k) => ({ decoded: 501 + k, decodeMs: 5030, skipped: 1 })); h.tick(1000);
  assert.equal(h.api.status().learned, undefined, 'one picture after a pause is no sample');
});

test('a TV with WebAssembly SIMD gets the SIMD build', async () => {
  const h = harness({ simd: true });
  await h.api.start(h.opts(3));
  assert.equal(new TextDecoder().decode(h.decoders()[0].sent.find((m) => m.op === 'init').wasm), 'js/f1dec-simd.wasm');
  assert.ok(h.events.some((e) => /"simd":true/.test(e)));
});

test('two small feeds get 288p; one goes to Samsung\'s decoder (ours only where Samsung\'s is missing)', async () => {
  const two = harness();
  await two.api.start(two.opts(2));
  assert.ok(two.events.some((e) => /"rows":288/.test(e)), two.events.join('\n'));
  const one = harness();
  one.api.start(one.opts(1)); await flush();   // (Samsung's path then waits for the big feed's clock)
  assert.equal(one.api.status().engine, 'emss');
  const alone = harness({ emss: false });
  await alone.api.start(alone.opts(1));
  assert.equal(alone.api.status().engine, 'wasm');
});

test('a 30 fps ladder (2018-2020) gets more lines: 360p for three small feeds (B unfiltered), 360p for two', async () => {
  const three = harness({ rows: [216, 288, 360, 432], fps: '30.000' });
  await three.api.start(three.opts(3));
  assert.ok(three.events.some((e) => /"rows":360.*"unfiltered":true/.test(e)), three.events.join('\n'));
  const two = harness({ rows: [216, 288, 360, 432], fps: '30.000' });
  await two.api.start(two.opts(2));
  assert.ok(two.events.some((e) => /"rows":360.*"unfiltered":false/.test(e)), two.events.join('\n'));
});

test('what this TV\'s decoders kept up with picks the size: a faster TV gets 360p for three small feeds', async () => {
  const h = harness({ store: { 'f1tv.mvbudget': JSON.stringify({ 3: { full: 50000 } }) } });
  await h.api.start(h.opts(3));
  assert.ok(h.events.some((e) => /"rows":360.*"unfiltered":false/.test(e)), h.events.join('\n'));
});

test('playing teaches the budget from the slowest decoder\'s time per picture; falling behind starts over smaller', async () => {
  const h = harness();
  await h.api.start(h.opts(3));
  h.draw().onmessage({ data: { shown: true } });
  const stats = (decoded, ms, skipped) => h.decoders().forEach((w, k) => w.onmessage({ data: { stats: { decoded, decodeMs: ms + k, skipped } } }));
  stats(0, 0, 0); h.tick(1000);                // first picture: the warm-up starts
  h.later(8000); h.tick(1000);                 // the window opens
  h.later(10000); stats(500, 5000, 0); h.tick(1000);
  // 288p (32 x 18 = 576 macroblocks) at ~10 ms a picture: 0.85 * 576 * 100 = ~49,000, at most 25% above the 28,815 known
  const kept = JSON.parse(h.store['f1tv.mvbudget'])[3];
  assert.ok(kept.unfiltered > 35000 && kept.unfiltered < 36100, JSON.stringify(kept));
  assert.ok(Math.abs(kept.full * 1.13 - kept.unfiltered) < 2, 'both from one measurement');
  assert.equal(h.api.status().engine, 'wasm');
  // Then a slow stretch: 30 ms a picture and a fifth of the pictures left out -> a smaller size
  const before = h.decoders();
  h.later(10000); stats(900, 17000, 100); h.tick(1000); await flush();
  assert.ok(before.every((w) => w.ended), 'started over');
  assert.ok(h.events.some((e) => /mv\.h264\.budget/.test(e)), h.events.join('\n'));
  // Started over at 270p (the smallest): still behind there, it doesn't start over again.
  assert.ok(h.events.some((e) => /mv\.h264\.start .*"rows":270/.test(e)), h.events.join('\n'));
  h.draw().onmessage({ data: { shown: true } });
  const again = h.decoders();
  stats(0, 0, 0); h.tick(1000); h.later(8000); h.tick(1000);
  h.later(10000); stats(400, 12000, 100); h.tick(1000); await flush();
  assert.ok(again.every((w) => !w.ended), 'kept at the smallest size');
});

test('without a size within the limit, the smallest the feeds have', async () => {
  const h = harness({ rows: [360, 540] });
  await h.api.start(h.opts(3));
  assert.ok(h.events.some((e) => /"rows":360/.test(e)), h.events.join('\n'));
});

test('the drawing worker gets the big feed\'s clock; a jump starts the decoders over there', async () => {
  const h = harness({ position: 100 });
  await h.api.start(h.opts(3));
  h.tick(50);
  const clock = h.draw().sent.filter((m) => m.clock).at(-1).clock;
  assert.equal(clock.pos, 100); assert.equal(clock.playing, true);
  const before = h.decoders();
  h.seek(200);
  for (let i = 0; i < 10; i++) h.tick(50);   // noticed at the next look at the position (twice a second)
  await flush();
  assert.ok(before.every((w) => w.ended), 'the old decoders ended');
  assert.equal(h.decoders().length, 3);
  assert.equal(h.decoders()[0].sent.find((m) => m.op === 'play').from, 52);    // 52 * 3.84 = 199.68
});

test('the big feed\'s position (a synchronous call into AVPlay) is asked twice a second, and at once on pause and play', async () => {
  const h = harness({ position: 100 });
  const o = h.opts(3); let asked = 0; const position = o.clock.position;
  o.clock.position = () => { asked++; return position(); };
  await h.api.start(o);
  const clocks = () => h.draw().sent.filter((m) => m.clock).map((m) => m.clock);
  for (let i = 0; i < 40; i++) h.tick(50);   // 2 s
  assert.ok(asked >= 4 && asked <= 5, 'asked ' + asked + ' times in 2 s');
  const n = asked;
  h.pause(true); h.tick(50);
  assert.equal(asked, n + 1);
  assert.equal(clocks().at(-1).playing, false);
  h.pause(false); h.tick(50);
  assert.equal(asked, n + 2);
  assert.equal(clocks().at(-1).playing, true);
});

test('the first picture shows the canvas; stop ends every worker', async () => {
  const h = harness();
  await h.api.start(h.opts(3));
  h.draw().onmessage({ data: { shown: true } });
  assert.equal(h.shown.length, 1);
  assert.ok(h.events.includes('canvas shown'));
  const all = h.workers.slice();
  await h.api.stop();
  assert.ok(all.every((w) => w.ended));
  assert.equal(h.api.running(), false);
});

test('a feed whose segments don\'t load goes back to the app (it starts them again), without changing decoders', async () => {
  const h = harness();
  await h.api.start(h.opts(3));
  h.decoders()[2].onmessage({ data: { error: 'Failed to fetch', network: true } });
  await flush();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /Failed to fetch/);
  await h.api.start(h.opts(3));
  assert.equal(h.api.status().engine, 'wasm');
});

test('a stream our decoder refuses plays on Samsung\'s this time; any other failure for the rest of the app run', async () => {
  const h = harness();
  await h.api.start(h.opts(3));
  h.decoders()[1].onmessage({ data: { error: 'f1dec -2', unsupported: true } });
  await flush();
  assert.equal(h.api.status().engine, 'emss');
  assert.equal(h.errors.length, 0, 'no failure reported to the app');
  await h.api.stop();
  await h.api.start(h.opts(3));
  assert.equal(h.api.status().engine, 'wasm', 'ours again for the next start');
  h.decoders()[0].onmessage({ data: { error: 'segment: HTTP 403' } });
  await flush();
  assert.equal(h.api.status().engine, 'emss');
  await h.api.stop();
  h.api.start(h.opts(3)); await flush();
  assert.equal(h.api.status().engine, 'emss', 'Samsung\'s until the app restarts');
});
