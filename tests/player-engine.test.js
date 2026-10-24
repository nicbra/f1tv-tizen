const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, style: {} });

/** A fake Samsung AVPlay that records what the app asks of it. */
function fakeAvPlay({ liveWindow = '', duration = 0 } = {}) {
  const calls = [];
  let state = 'NONE';
  const av = {
    calls,
    listener: null,
    open: (url) => { calls.push(['open', url]); state = 'IDLE'; },
    setListener: (l) => { av.listener = l; },
    setDrm: (...a) => calls.push(['setDrm', a[0], a[1]]),
    setStreamingProperty: (k, v) => calls.push(['setStreamingProperty', k, v]),
    getStreamingProperty: (k) => k === 'GET_LIVE_DURATION' ? liveWindow : '',
    setBufferingParam: () => {},
    setDisplayRect() {}, setDisplayMethod() {},
    seekTo: (ms, ok) => { calls.push(['seekTo', ms]); setImmediate(ok); },
    prepareAsync: (ok) => { calls.push(['prepareAsync']); state = 'READY'; setImmediate(ok); },
    getDuration: () => duration,
    getTotalTrackInfo: () => [],
    getCurrentStreamInfo: () => [],
    play: () => { calls.push(['play']); state = 'PLAYING'; },
    pause() {}, setSilentSubtitle() {},
    getState: () => state,
    stop: () => calls.push(['stop']),
    close: () => calls.push(['close'])
  };
  return av;
}

/** Loads the real settings, service launcher and player with a fake AVPlay and Shaka. */
async function player(av, storage) {
  const store = Object.assign({}, storage);
  class ShakaPlayer {
    attach() { return Promise.resolve(); }
    getNetworkingEngine() { return { registerRequestFilter() {} }; }
    addEventListener() {}
    unload() { return Promise.resolve(); }
  }
  const context = vm.createContext({
    webapis: { avplay: av },
    shaka: { polyfill: { installAll() {} }, Player: ShakaPlayer, net: { NetworkingEngine: { RequestType: {} } }, util: { Error: { Category: {} } } },
    document: { body: el() },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    fetch: async () => ({ ok: true }), // the stream helper service answers its ping
    setTimeout, clearTimeout, Date, Math, JSON, Promise, encodeURIComponent
  });
  for (const f of ['settings.js', 'proxy.js', 'player.js']) vm.runInContext(readFileSync('app/js/' + f, 'utf8'), context);
  const video = Object.assign(el(), { cloneNode: () => el(), parentNode: { insertBefore() {} } });
  await context.Player.init(video, el());
  return context.Player;
}

const LIVE = { url: 'https://ott-video-cf.formula1.com/v2/x/Main/index.mpd?start=1&end=2', licenseUrl: 'https://f1tv.formula1.com/lic',
  licenseHeaders: {}, live: true, multiFeed: true,
  info: { dynamic: true, windowStart: 88794000, windowEnd: 88795000, epochAtZero: 1704067200, delay: 25, segDur: 5.76 } };
const REPLAY = { url: 'https://ott-video-cf.formula1.com/v2/x/vod/index.mpd', licenseUrl: 'https://f1tv.formula1.com/lic',
  licenseHeaders: {}, live: false, multiFeed: false, info: { dynamic: false, windowStart: 0, windowEnd: 6163, epochAtZero: 1792867000, segDur: 5.76 } };
const names = (av) => av.calls.map((c) => c[0]);

test('encrypted DASH plays on AVPlay through the stream helper, with the preferred commentary', async () => {
  const av = fakeAvPlay();
  const P = await player(av, { 'f1tv.settings': JSON.stringify({ audio: 'deu' }) });
  await P.load(LIVE, null);
  assert.equal(P.engineName(), 'avplay');
  const url = av.calls.find((c) => c[0] === 'open')[1];
  assert.equal(url, 'http://127.0.0.1:18765/mpd?u=' + encodeURIComponent(LIVE.url) + '&audio=deu');
  assert.deepEqual(av.calls.find((c) => c[0] === 'setDrm'), ['setDrm', 'WIDEVINE_CDM', 'SetProperties']);
  assert.ok(names(av).indexOf('play') > names(av).indexOf('prepareAsync'));
  assert.equal(P.isLive(), true);
});

test('a time-shifted live start asks the helper for the shifted manifest', async () => {
  const av = fakeAvPlay();
  const P = await player(av);
  await P.load(Object.assign({}, LIVE, { startDelay: 600.4 }), null);
  assert.match(av.calls.find((c) => c[0] === 'open')[1], /&shift=600&audio=eng$/);
});

test('streams start at the top quality by default, and a lower level after stalls', async () => {
  const av = fakeAvPlay();
  await (await player(av)).load(LIVE, null);
  assert.deepEqual(av.calls.find((c) => c[0] === 'setStreamingProperty'), ['setStreamingProperty', 'ADAPTIVE_INFO', 'STARTBITRATE=HIGHEST']);
  const lower = fakeAvPlay();
  await (await player(lower, { 'f1tv.startLevel': '2' })).load(LIVE, null);
  assert.deepEqual(lower.calls.find((c) => c[0] === 'setStreamingProperty'), ['setStreamingProperty', 'ADAPTIVE_INFO', 'STARTBITRATE=LOWEST']);
});

test('a replay with a resume point seeks before preparing, so the start is never shown', async () => {
  const av = fakeAvPlay({ duration: 6163000 });
  const P = await player(av);
  await P.load(REPLAY, 2723);
  const order = names(av);
  assert.ok(order.indexOf('seekTo') < order.indexOf('prepareAsync'), order.join());
  assert.deepEqual(av.calls.find((c) => c[0] === 'seekTo'), ['seekTo', 2723000]);
  assert.equal(P.isLive(), false);
  assert.equal(P.position(), 2723);
});

test('a live stream is never seeked before preparing', async () => {
  const av = fakeAvPlay();
  await (await player(av)).load(LIVE, 88794500);
  assert.equal(names(av).indexOf('seekTo'), -1);
});

test('live seeks stay inside the window AVPlay can play', async () => {
  const av = fakeAvPlay({ liveWindow: '88794000000|88795000000' });
  const P = await player(av);
  await P.load(LIVE, null);
  P.seekTo(88700000); // far before the window
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(av.calls.filter((c) => c[0] === 'seekTo').at(-1), ['seekTo', 88794010000]);
});

test('long-segment replays expose their 30 s seek grid; live streams do not', async () => {
  const av = fakeAvPlay({ duration: 7200000 });
  const P = await player(av);
  await P.load(Object.assign({}, REPLAY, { info: Object.assign({}, REPLAY.info, { segDur: 30, windowStart: 0 }) }), null);
  assert.deepEqual({ ...P.seekGrid() }, { size: 30, origin: 0 });
  const live = await player(fakeAvPlay());
  await live.load(LIVE, null);
  assert.equal(live.seekGrid(), null);
});

test('clear multi-feed replays play on Shaka; clear single-feed videos on AVPlay without the helper', async () => {
  const P = await player(fakeAvPlay());
  const clear = { url: 'https://ott-video-fer-cf.formula1.com/x/index.m3u8', licenseUrl: '', multiFeed: true, info: { dynamic: false } };
  await P.load(clear, null).catch(() => {});
  assert.equal(P.engineName(), 'shaka');
  const av = fakeAvPlay();
  const single = await player(av);
  await single.load(Object.assign({}, clear, { multiFeed: false }), null);
  assert.equal(single.engineName(), 'avplay');
  assert.equal(av.calls.find((c) => c[0] === 'open')[1], clear.url);
});

test('unloading waits for preparation, then stops and closes the native player', async () => {
  const av = fakeAvPlay();
  const P = await player(av);
  const loading = P.load(LIVE, null);
  await new Promise((r) => setImmediate(r));
  await Promise.all([loading.catch(() => {}), P.unload()]);
  const order = names(av);
  assert.ok(order.indexOf('stop') > order.indexOf('prepareAsync'), order.join());
  assert.ok(order.indexOf('close') > order.indexOf('stop'));
});
