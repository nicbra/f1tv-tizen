const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const el = () => {
  const listeners = {};
  return {
    classList: { add() {}, remove() {}, toggle() {} }, style: {},
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    fire: (type) => (listeners[type] || []).forEach((fn) => fn())
  };
};

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

/** Loads the real settings, service launcher and player with a fake AVPlay and Shaka. shakaLoad: Shaka's load(). */
async function player(av, storage, shakaLoad, globals) {
  const store = Object.assign({}, storage);
  const configs = [];
  class ShakaPlayer {
    attach() { return Promise.resolve(); }
    resetConfiguration() {}
    configure(config) { configs.push(config); }
    load(url, start) { return shakaLoad ? shakaLoad(url, start) : Promise.reject(new Error('no stream')); }
    getNetworkingEngine() { return { registerRequestFilter() {} }; }
    addEventListener() {}
    unload() { return Promise.resolve(); }
  }
  const context = vm.createContext(Object.assign({
    webapis: { avplay: av },
    shaka: { polyfill: { installAll() {} }, Player: ShakaPlayer, net: { NetworkingEngine: { RequestType: {} } }, util: { Error: { Category: {} } } },
    document: { body: el() },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    fetch: async () => ({ ok: true }), // the stream helper service answers its ping
    setTimeout, clearTimeout, Date, Math, JSON, Promise, encodeURIComponent
  }, globals));
  for (const f of ['settings.js', 'proxy.js', 'player.js']) vm.runInContext(readFileSync('app/js/' + f, 'utf8'), context);
  const second = el();
  const video = Object.assign(el(), { cloneNode: () => second, parentNode: { insertBefore() {} } });
  await context.Player.init(video, el());
  context.Player.videos = [video, second];
  context.Player.configs = configs;
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

test('HDR uses Shaka even for a single feed, selecting HLG and resetting to AUTO for SDR', async () => {
  const P = await player(fakeAvPlay(), undefined, () => Promise.resolve());
  P.videos.forEach((v) => { v.play = () => Promise.resolve(); v.paused = false; });
  const stream = { url: 'https://cdn/hdr.m3u8', hdr: true, multiFeed: false, info: { dynamic: false } };
  await P.load(stream, null);
  assert.equal(P.engineName(), 'shaka');
  assert.equal(P.configs.at(-1).preferredVideoHdrLevel, 'HLG');
  await P.load({ ...stream, hdr: undefined, multiFeed: true }, null);
  assert.equal(P.configs.at(-1).preferredVideoHdrLevel, 'AUTO');
  P.forceEngine = 'avplay';
  await P.load(stream, null);
  assert.equal(P.engineName(), 'avplay');
});

test('HDR capability requires TV HDR and HEVC support and caches the result', async () => {
  let tvChecks = 0, codecChecks = 0;
  const P = await player(fakeAvPlay(), undefined, undefined, {
    webapis: { avinfo: { isHdrTvSupport: () => { tvChecks++; return true; } } },
    MediaSource: { isTypeSupported: (type) => { codecChecks++; assert.equal(type, 'video/mp4; codecs="hvc1.2.4.L153.B0"'); return true; } }
  });
  assert.equal(P.hdrCapable(), true);
  assert.equal(P.hdrCapable(), true);
  assert.equal(tvChecks, 1);
  assert.equal(codecChecks, 1);
});

for (const [name, webapis, MediaSource] of [
  ['missing webapis', undefined, { isTypeSupported: () => true }],
  ['missing avinfo', {}, { isTypeSupported: () => true }],
  ['throwing avinfo', { avinfo: { isHdrTvSupport() { throw new Error('unsupported'); } } }, { isTypeSupported: () => true }],
  ['SDR TV', { avinfo: { isHdrTvSupport: () => false } }, { isTypeSupported: () => true }],
  ['missing MediaSource', { avinfo: { isHdrTvSupport: () => true } }, undefined],
  ['unsupported HEVC', { avinfo: { isHdrTvSupport: () => true } }, { isTypeSupported: () => false }],
  ['throwing MediaSource', { avinfo: { isHdrTvSupport: () => true } }, { isTypeSupported() { throw new Error('unsupported'); } }]
]) {
  test('HDR capability is false for ' + name, async () => {
    const P = await player(fakeAvPlay(), undefined, undefined, { webapis, MediaSource });
    assert.equal(P.hdrCapable(), false);
    assert.equal(P.hdrCapable(), false);
  });
}

test('a Shaka video that plays to its end reports it; the idle preload slot does not', async () => {
  const P = await player(fakeAvPlay());
  let ended = 0;
  P.on('ended', () => ended++);
  P.forceEngine = 'shaka';
  await P.load({ url: 'https://ott-video-fer-cf.formula1.com/x/index.m3u8', licenseUrl: '', multiFeed: true, info: { dynamic: false } }, null).catch(() => {});
  P.videos[1].fire('ended');
  assert.equal(ended, 0);
  P.videos[0].fire('ended');
  assert.equal(ended, 1);
});

test('the outgoing Shaka feed reaching its end during a feed switch does not end playback', async () => {
  let loads = 0;
  // The first feed loads; the switch's load stays pending, so the old feed is still current.
  const P = await player(fakeAvPlay(), undefined, () => (loads++ ? new Promise(() => {}) : Promise.resolve()));
  let ended = 0;
  P.on('ended', () => ended++);
  P.forceEngine = 'shaka';
  const feed = { url: 'https://ott-video-fer-cf.formula1.com/x/index.m3u8', licenseUrl: '', multiFeed: true, info: { dynamic: false } };
  P.videos[0].play = P.videos[1].play = () => Promise.resolve();
  await P.load(feed, null);
  P.switchTo(Object.assign({}, feed, { url: feed.url.replace('x', 'y') }), null);
  await new Promise((r) => setImmediate(r));
  P.videos[0].fire('ended');
  assert.equal(ended, 0);
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

test('an HDR video frozen on its first frame is loaded once more; one that plays is left alone', async () => {
  for (const [frames, hdr, reloads] of [[0, true, 1], [25, true, 0], [0, false, 0]]) {
    let loads = 0;
    const timers = [];
    const P = await player(fakeAvPlay(), undefined, () => { loads++; return Promise.resolve(); },
      { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 0; } });
    P.forceEngine = 'shaka';
    Object.assign(P.videos[0], { readyState: 4, play: () => Promise.resolve(), getVideoPlaybackQuality: () => ({ totalVideoFrames: frames }) });
    await P.load({ url: 'https://cdn/hdr.m3u8', licenseUrl: '', multiFeed: true, hdr, info: { dynamic: false } }, 30);
    const check = timers.find((t) => t.ms === 5000);
    assert.equal(!!check, hdr);
    if (check) check.fn();
    await new Promise(setImmediate);
    assert.equal(loads, 1 + reloads);
  }
});

test('the frozen-HDR reload stands down after a stop, starts from a seek, and does not undo a pause', async () => {
  const setup = async () => {
    const loads = [], timers = [];
    let release = null;
    const P = await player(fakeAvPlay(), undefined, (url, start) => {
      loads.push(start);
      return loads.length === 1 ? Promise.resolve() : new Promise((r) => { release = r; });
    }, { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 0; } });
    P.forceEngine = 'shaka';
    let plays = 0;
    Object.assign(P.videos[0], { readyState: 4, currentTime: 0, play: () => { plays++; return Promise.resolve(); },
      pause() {}, getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }) });
    await P.load({ url: 'https://cdn/hdr.m3u8', licenseUrl: '', multiFeed: true, hdr: true, info: { dynamic: false } }, 30);
    return { P, loads, check: timers.find((t) => t.ms === 5000), plays: () => plays, release: () => release && release() };
  };
  // Stopped just before the check: no reload.
  let t = await setup();
  await t.P.unload();
  t.check.fn();
  assert.deepEqual(t.loads, [30]);
  // Sought to 120 while frozen: the reload starts there.
  t = await setup();
  t.P.videos[0].currentTime = 120;
  t.check.fn();
  assert.deepEqual(t.loads, [30, 120]);
  // Paused while the reload loads: it stays paused.
  t = await setup();
  t.P.videos[0].currentTime = 30;
  t.check.fn();
  const before = t.plays();
  t.P.togglePause();
  t.release();
  await new Promise(setImmediate);
  assert.equal(t.plays(), before);
});
