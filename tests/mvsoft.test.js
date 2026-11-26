'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const rungList = (sizes) => sizes.map((r) => '#EXT-X-STREAM-INF:RESOLUTION=' + r + ',CODECS="avc1.4d401f"\n' + r + '.m3u8').join('\n');
const LADDER = rungList(['480x270', '640x360', '960x540', '1280x720']);
function harness(mediaFails, master = '#EXT-X-STREAM-INF:RESOLUTION=960x540,CODECS="avc1.4d401f"\nmedia.m3u8', samples) {
  const events = [], timers = new Map(), workers = [], posts = [], errors = [], failures = [];
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
    constructor() { Source.instances.push(this); events.push('create source'); }
    addVideoTrack(o) { this.trackOptions = o; return { trackId: 1, sessionId: 2 }; }
    open() { return Promise.resolve(); }
    destroy() { events.push('destroy source'); }
  }
  Source.instances = [];
  class Worker {
    constructor() { workers.push(this); this.number = workers.length; }
    postMessage(m, transfers) {
      if (m.moments) (this.moments = this.moments || []).push(Array.from(m.moments));
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
      samples: () => samples || [{ dts: 0, pts: .1, duration: .04, key: true, data: new Uint8Array(1) }] },
    document: { createElement: () => ({ style: {}, paused: true, currentTime: 0, muted: true,
      set src(v) { this._src = v; queueMicrotask(() => { if (Source.instances.at(-1).onsourceopenpending) Source.instances.at(-1).onsourceopenpending(); }); },
      play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, removeAttribute() {}, load() {}, remove() {} }) },
    fetch: async (url, options) => {
      if (options && options.method === 'POST' && mediaFails === 'helper') {
        const site = { 'X-Error-Category': 'type_error', 'X-Error-Source': 'stitchx.js', 'X-Error-Line': '88', 'X-Helper-Node': '4.4.3' };
        return { status: 422, text: async () => 'Cannot read property \'nal\' of undefined', headers: { get: (k) => site[k] || null } };
      }
      if (options && options.method === 'POST') { posts.push(JSON.parse(options.body)); return { status: 201, text: async () => JSON.stringify({ segments: 100, visibleRows: 540, feedTag: { row: 544, values: [32, 96, 160] } }) }; }
      if (/\.m4s$|init\.mp4$/.test(url)) return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
      if (mediaFails === 'empty' && !/master/.test(url)) return { ok: true, url, text: async () => '#EXTM3U\n' };
      if (mediaFails === true && !/master/.test(url)) return { ok: false, status: 503, text: async () => 'gone' };
      const ladder = typeof master === 'string' ? master : master[url];
      return { ok: true, url, text: async () => /master/.test(url) ? ladder : '#EXTINF:3.84,\na.ts\n'.repeat(100) };
    },
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, interval: false }); return id; },
    setInterval: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval: id => timers.delete(id), Diag: { note: (kind) => events.push(kind) },
    Player: { engineLost: (name, overReload) => events.push('lost ' + name + (overReload ? ' over reload' : '')) }
  };
  ctx.window.HTMLCanvasElement.prototype.transferControlToOffscreen = function () {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/failure.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/mvsoft.js'), 'utf8'), ctx);
  const opts = (rects = [0, 1, 2].map(k => ({ left: 1280, top: k * 360, width: 640, height: 360 })), urls) => ({
    streams: rects.map((r, k) => ({ url: urls ? urls[k] : 'http://cdn/master.m3u8' })), rects, canvas,
    clock: { position: () => position, playing: () => true }, onError: e => { errors.push(e.message); failures.push(e); } });
  return { api: ctx.MvSoftware, opts, workers, posts, events, errors, failures, Source,
    expire: async ms => { for (const [id, t] of [...timers]) if (!t.interval && t.ms === ms) { timers.delete(id); t.fn(); } await flush(); } };
}

test('native software onboards transfer a fresh visible canvas and use the validated stream settings', async () => {
  const h = harness(); assert.equal(h.api.supported(), true);
  await h.api.start(h.opts());
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].start.canvas.owner.id, 'mv-soft');
  assert.equal(h.workers[0].start.feeds, 3);
  assert.equal(h.Source.instances[0].trackOptions.decodingMode, 'software');
  assert.equal(h.posts[0].maxDpb, 9); assert.equal(h.posts[0].level, 51);
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

test('a segment playlist that answers an error is reported, not turned into a NaN start clock', async () => {
  const h = harness(true);   // the media playlist fetches fail; the master and the helper still answer
  await h.api.start(h.opts());
  assert.ok(h.errors.some((m) => /segment playlist 503/.test(m)), 'onError was called with the status');
  assert.equal(h.workers.length, 0, 'no worker was started for a failed begin');
});

test('a segment playlist without segments is reported too, not a start clock of undefined', async () => {
  const h = harness('empty');
  await h.api.start(h.opts());
  assert.ok(h.errors.some((m) => /without segments/.test(m)), String(h.errors));
  assert.equal(h.workers.length, 0);
});

// Once an EMSS source exists, the browser's MediaSource won't open again until the app restarts (QE55Q77A): Shaka is
// lost for the app run (and over a page reload) before the source is made; a start that fails earlier loses nothing.
test('the first EMSS source marks Shaka lost until the app restarts, before it is created; a start failing before that does not', async () => {
  const h = harness(); await h.api.start(h.opts());
  assert.ok(h.events.includes('lost shaka over reload'), String(h.events));
  assert.ok(h.events.indexOf('lost shaka over reload') < h.events.indexOf('create source'));
  const stopped = h.api.stop(); h.workers[0].ack(); await stopped;
  const early = harness(true); await early.api.start(early.opts());
  assert.ok(!early.events.some((e) => /^lost /.test(e)), String(early.events));
});

test('a helper refusal is HELPER_ERROR with where the helper failed, for the diagnostics only (issue #6)', async () => {
  const h = harness('helper');
  await h.api.start(h.opts());
  const e = h.failures.at(-1);
  assert.ok(e, 'reported');
  assert.equal(e.diag.code, 'HELPER_ERROR');
  assert.deepEqual({ ...e.diag.site }, { category: 'type_error', source: 'stitchx.js', line: '88', node: '4.4.3' });
});

// Measured on the QE55Q77A (2026-11-26): 540p for 640x360 places lost pictures; below 50 fps only F1's reference
// frames (every third) move evenly.
test('small feeds come in the rung of their place, and two or three show only their reference frames', async () => {
  const h = harness(false, LADDER); await h.api.start(h.opts());
  const rungs = (x) => x.posts[0].feeds.map((f) => f.playlist.split('/').pop());
  assert.deepEqual(rungs(h), ['640x360.m3u8', '640x360.m3u8', '640x360.m3u8']);
  assert.deepEqual(h.posts[0].dropB, [true, true, true]);
  assert.equal(h.posts[0].targetFps, undefined); assert.equal(h.posts[0].spread, undefined);
  const stopped = h.api.stop(); h.workers[0].ack(); await stopped;

  const pip = harness(false, LADDER); await pip.api.start(pip.opts([{ left: 960, top: 540, width: 960, height: 540 }]));
  assert.deepEqual(rungs(pip), ['960x540.m3u8']); assert.deepEqual(pip.posts[0].dropB, [false], 'one small feed: every frame');
  const big = harness(false, LADDER); await big.api.start(big.opts([{ left: 0, top: 0, width: 1920, height: 1080 }]));
  assert.deepEqual(rungs(big), ['1280x720.m3u8'], 'a place bigger than every rung: the biggest');
});

test('all small feeds get one size that every feed has (the helper interleaves one size)', async () => {
  const urls = ['http://cdn/a/master.m3u8', 'http://cdn/b/master.m3u8', 'http://cdn/c/master.m3u8'];
  const masters = { [urls[0]]: LADDER, [urls[1]]: rungList(['480x270', '960x540']), [urls[2]]: LADDER };
  const h = harness(false, masters); await h.api.start(h.opts(undefined, urls));
  assert.deepEqual(h.posts[0].feeds.map((f) => f.playlist.split('/').pop()), ['960x540.m3u8', '960x540.m3u8', '960x540.m3u8']);
  const stopped = h.api.stop(); h.workers[0].ack(); await stopped;
  const none = harness(false, { [urls[0]]: rungList(['640x360']), [urls[1]]: rungList(['960x540']), [urls[2]]: LADDER });
  await none.api.start(none.opts(undefined, urls));
  assert.equal(none.failures.at(-1).diag.code, 'UNSUPPORTED'); assert.equal(none.workers.length, 0);
});

test('the worker learns from each segment\'s timestamps which pictures end a moment, in display order', async () => {
  // Decode order; PTS modulo 8: the feed, + 4 on the last picture of its frame time (StitchX samples).
  const at = (ticks) => ({ dts: 0, pts: ticks / 90000, duration: .02, key: false, data: new Uint8Array(1) });
  const h = harness(false, undefined, [at(9000), at(9600 + 1), at(10200 + 2 + 4), at(14400 + 4)]);
  await h.api.start(h.opts());
  assert.deepEqual(h.workers[0].moments[0], [0, 0, 1, 1]);
  const stopped = h.api.stop(); h.workers[0].ack(); await stopped;
});
