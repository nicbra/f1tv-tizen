const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// A video's text track: cues sorted by start time, as the browser keeps them.
const textTrack = () => ({ kind: 'subtitles', cues: [], removeCue(c) { this.cues.splice(this.cues.indexOf(c), 1); } });

const el = () => {
  const listeners = {};
  return {
    classList: { add() {}, remove() {}, toggle() {} }, style: {}, textTracks: [textTrack()],
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
    getCurrentTime: () => av.time || 0,
    play: () => { calls.push(['play']); state = 'PLAYING'; },
    pause() {}, setSilentSubtitle() {},
    getState: () => state,
    stop: () => calls.push(['stop']),
    close: () => calls.push(['close'])
  };
  return av;
}

/** Loads the real settings, service launcher and player with a fake AVPlay and Shaka. shakaLoad: Shaka's load(). */
async function player(av, storage, shakaLoad, globals, manifest) {
  const store = Object.assign({}, storage);
  const configs = [], languages = [], manifests = [];
  // Shaka's SimpleTextDisplayer as far as it matters here: append() adds the cues to the video's track.
  class SimpleTextDisplayer {
    constructor(video) { this.track = video.textTracks[0]; }
    append(cues) {
      cues.forEach((c) => this.track.cues.push(Object.assign({}, c)));
      this.track.cues.sort((a, b) => a.startTime - b.startTime);
    }
  }
  class ShakaPlayer {
    constructor() { this.responseFilters = []; }
    attach() { return Promise.resolve(); }
    resetConfiguration() {}
    configure(config) { configs.push(config); }
    async load(url, start) {
      if (manifest != null) {
        const response = { data: Buffer.from(manifest), uri: url };
        for (const filter of this.responseFilters) await filter(0, response);
        manifests.push(Buffer.from(response.data).toString('utf8'));
      }
      return shakaLoad ? shakaLoad(url, start) : Promise.reject(new Error('no stream'));
    }
    getNetworkingEngine() { return { registerRequestFilter() {}, registerResponseFilter: (fn) => this.responseFilters.push(fn) }; }
    getBufferedInfo() { return { video: [{ start: 0, end: 10 }] }; }
    selectAudioLanguage(l) { languages.push(['audio', l]); }
    selectTextLanguage(l) { languages.push(['text', l]); }
    setTextTrackVisibility(on) { languages.push(['subtitles', on]); }
    addEventListener() {}
    unload() { return Promise.resolve(); }
  }
  const context = vm.createContext(Object.assign({
    webapis: { avplay: av },
    shaka: { polyfill: { installAll() {} }, Player: ShakaPlayer, text: { SimpleTextDisplayer },
      net: { NetworkingEngine: { RequestType: { MANIFEST: 0, LICENSE: 2 } } },
      util: { Error: { Category: {} }, StringUtils: { fromUTF8: (b) => Buffer.from(b).toString('utf8'), toUTF8: (s) => Buffer.from(s) } } },
    document: { body: el() },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    fetch: async () => ({ ok: true }), // the stream helper service answers its ping
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, encodeURIComponent, URL, TextDecoder
  }, globals));
  for (const f of ['settings.js', 'proxy.js', 'ttml.js', 'player.js']) vm.runInContext(readFileSync('app/js/' + f, 'utf8'), context);
  const second = el();
  const video = Object.assign(el(), { cloneNode: () => second, parentNode: { insertBefore() {} } });
  await context.Player.init(video, el());
  context.Player.videos = [video, second];
  context.Player.configs = configs;
  context.Player.SimpleTextDisplayer = SimpleTextDisplayer;
  context.Player.languages = languages;
  context.Player.manifests = manifests;
  context.Player.context = context;
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

const MIXED_HDR = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Norwegian",URI="subs/no.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=7000000,CODECS="hvc1.2.4.L123.B0,mp4a.40.2",RESOLUTION=1920x1080,VIDEO-RANGE=HLG,AUDIO="audio",SUBTITLES="subs"
hdr/hd.m3u8?signature=keep-this
#EXT-X-STREAM-INF:BANDWIDTH=18000000,CODECS="hvc1.2.4.L153.B0,mp4a.40.2",RESOLUTION=3840x2160,VIDEO-RANGE="HLG",AUDIO="audio",SUBTITLES="subs"
hdr/uhd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="hvc1.1.6.L150.B0,mp4a.40.2",RESOLUTION=2880x1620,VIDEO-RANGE=SDR
sdr/1620.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="fake,VIDEO-RANGE=HLG,codec",RESOLUTION=480x270
unknown/270.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=500000,VIDEO-RANGE=SDR,URI="sdr/iframe.m3u8"
`;
const HLG_MASTER = MIXED_HDR.slice(0, MIXED_HDR.indexOf('#EXT-X-STREAM-INF:BANDWIDTH=9000000'));

test('HDR playback exposes only HLG qualities to adaptation, preserving signed URLs, audio and subtitles', async () => {
  const P = await player(fakeAvPlay(), undefined, () => Promise.resolve(), undefined, MIXED_HDR.replace(/\n/g, '\r\n'));
  P.videos.forEach((v) => { v.play = () => Promise.resolve(); v.paused = false; });
  await P.load({ url: 'https://cdn/hdr.m3u8', hdr: true }, null);
  assert.equal(P.manifests[0].replace(/\r\n/g, '\n'), HLG_MASTER);
  // Reusing the same slot for normal playback must restore the entire original ladder.
  await P.load({ url: 'https://cdn/sdr.m3u8', multiFeed: true }, null);
  assert.equal(P.manifests[1], MIXED_HDR.replace(/\n/g, '\r\n'));
});

test('an HDR feed switch filters the idle slot as well as the initial load', async () => {
  const P = await player(fakeAvPlay(), undefined, () => Promise.resolve(), undefined, MIXED_HDR);
  P.videos.forEach((v) => { v.play = () => Promise.resolve(); v.paused = false; v.readyState = 4; v.currentTime = 0; });
  const stream = { url: 'https://cdn/main.m3u8', hdr: true, multiFeed: true };
  await P.load(stream, 50);
  await P.switchTo({ ...stream, url: 'https://cdn/onboard.m3u8' }, 50);
  assert.deepEqual(P.manifests, [HLG_MASTER, HLG_MASTER]);
});

test('HDR masters without HLG fail for the existing SDR fallback instead of silently selecting SDR', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,VIDEO-RANGE=SDR\nsdr.m3u8\n';
  const P = await player(fakeAvPlay(), undefined, () => Promise.resolve(), undefined, master);
  P.videos.forEach((v) => { v.play = () => Promise.resolve(); v.paused = false; });
  await assert.rejects(P.load({ url: 'https://cdn/hdr.m3u8', hdr: true }, null), /HLG/);
});

test('HDR media playlists retain their timing, discontinuities and encryption tags', async () => {
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=NONE\n' +
    '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T18:00:00Z\n#EXTINF:5.76,\na.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-ENDLIST\n';
  const P = await player(fakeAvPlay(), undefined, () => Promise.resolve(), undefined, media);
  P.videos.forEach((v) => { v.play = () => Promise.resolve(); v.paused = false; });
  await P.load({ url: 'https://cdn/hdr/2160.m3u8', hdr: true }, null);
  assert.equal(P.manifests[0], media);
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

test('subtitles F1 repeats in the next segment show once, and ones cut to 1 ms show until the next', async () => {
  const P = await player(fakeAvPlay());
  const display = new P.SimpleTextDisplayer(P.videos[0]);
  const cue = (start, end, text) => ({ startTime: start, endTime: end, text });
  // Abu Dhabi 2025 qualifying: segments end at 80.64 and 86.4 s.
  display.append([cue(73.626, 79.196, 'FOR THE CHAMPIONSHIP'), cue(79.197, 80.64, 'SESSION OF THE SEASON')]);
  display.append([cue(79.197, 84.836, 'SESSION OF THE SEASON'), cue(84.836, 84.837, 'FINALE 58 LAPS')]);
  const shown = () => P.videos[0].textTracks[0].cues.map((c) => [c.startTime, c.endTime, c.text]);
  assert.deepEqual(shown(), [[73.626, 79.196, 'FOR THE CHAMPIONSHIP'], [79.197, 84.836, 'SESSION OF THE SEASON'],
    [84.836, 87.836, 'FINALE 58 LAPS']]);
  // The next subtitle cuts the 3 s short; an exact repeat of a whole cue is merged too.
  display.append([cue(86.5, 89, 'AND WHO IS GOING TO BE ON POLE'), cue(79.197, 84.836, 'SESSION OF THE SEASON')]);
  assert.deepEqual(shown().slice(1), [[79.197, 84.836, 'SESSION OF THE SEASON'], [84.836, 86.5, 'FINALE 58 LAPS'],
    [86.5, 89, 'AND WHO IS GOING TO BE ON POLE']]);
});

test('the frozen-HDR reload keeps the viewer\'s commentary and subtitles', async () => {
  // A new load starts on the stream's defaults; F1 marks French subtitles as the default.
  const timers = [];
  const P = await player(fakeAvPlay(), { 'f1tv.settings': JSON.stringify({ audio: 'deu', subtitles: 'eng' }) },
    () => Promise.resolve(), { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 0; } });
  P.forceEngine = 'shaka';
  Object.assign(P.videos[0], { readyState: 4, currentTime: 0, play: () => Promise.resolve(), getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }) });
  await P.load({ url: 'https://cdn/hdr.m3u8', licenseUrl: '', multiFeed: true, hdr: true, info: { dynamic: false } }, 30);
  const first = P.languages.splice(0);
  assert.deepEqual(first, [['audio', 'de'], ['text', 'en'], ['subtitles', true]]);
  timers.find((t) => t.ms === 5000).fn();
  await new Promise(setImmediate);
  assert.deepEqual(P.languages, first);
});

test('a live stream stopped while the stream helper starts never opens AVPlay', async () => {
  const av = fakeAvPlay();
  let answer;
  const P = await player(av, undefined, undefined, { fetch: () => new Promise((r) => { answer = r; }) });
  const loading = P.load(LIVE, null);
  await new Promise(setImmediate);
  await P.unload();
  answer({ ok: true });   // the helper's ping finally answers
  await assert.rejects(loading, /cancelled/);
  assert.equal(names(av).includes('open'), false);
});

test('an AVPlay seek retried after a refusal still goes to its target', async () => {
  const av = fakeAvPlay({ duration: 6163000 });
  let refusals = 1;
  av.seekTo = (ms, ok, fail) => {
    av.calls.push(['seekTo', ms]);
    if (refusals-- > 0) setImmediate(() => fail({ name: 'InvalidValuesError' }));
    else setImmediate(ok);
  };
  const P = await player(av);
  const clear = { url: 'https://ott-video-fer-cf.formula1.com/x/index.m3u8', licenseUrl: '', multiFeed: false, info: { dynamic: false } };
  await P.load(clear, null);
  P.seekTo(120);
  await new Promise(setImmediate);
  av.listener.oncurrentplaytime(11000);   // playback goes on at 11 s before the retry
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(av.calls.filter((c) => c[0] === 'seekTo').map((c) => c[1]), [120000, 120000]);
});

// ---------- Shaka feed switches (with videos that play, pause and count decoded frames) ----------

const FEED = { url: 'https://ott-video-fer-cf.formula1.com/x/index.m3u8', licenseUrl: '', multiFeed: true, info: { dynamic: false } };
const videoFake = (v, frames) => Object.assign(v, { paused: true, muted: false, readyState: 4, currentTime: 0,
  play() { v.paused = false; return Promise.resolve(); }, pause() { v.paused = true; }, removeEventListener() {},
  getVideoPlaybackQuality: () => ({ totalVideoFrames: frames() }) });

test('a failed Shaka feed switch leaves the previous feed as the current stream', async () => {
  let loads = 0, fail;
  const P = await player(fakeAvPlay(), undefined, () => (loads++ ? new Promise((_, rej) => { fail = rej; }) : Promise.resolve()));
  P.forceEngine = 'shaka';
  P.videos.forEach((v) => videoFake(v, () => 0));
  await P.load(FEED, null);
  const next = Object.assign({}, FEED, { url: FEED.url.replace('x', 'y') });
  const sw = P.switchTo(next, null);
  assert.equal(P.stream(), next);        // current while it loads, for the clock of what is about to show
  await new Promise(setImmediate);
  fail(new Error('Shaka Error 1001'));
  await assert.rejects(sw, /1001/);
  assert.equal(P.stream(), FEED);
});

test('a Shaka feed switch made while paused stays paused, playing muted only until a frame shows', async () => {
  const timers = [];
  let frames = 0;
  const P = await player(fakeAvPlay(), undefined, () => Promise.resolve(), { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  P.forceEngine = 'shaka';
  const [a, b] = P.videos;
  P.videos.forEach((v) => videoFake(v, () => frames));
  await P.load(FEED, null);
  P.togglePause();                       // the viewer pauses
  assert.equal(a.paused, true);
  await P.switchTo(Object.assign({}, FEED, { url: FEED.url.replace('x', 'y') }), null);
  await new Promise(setImmediate);
  assert.equal(b.muted, true, 'the new feed is audible while the viewer has paused');
  assert.equal(P.isPaused(), true, 'reported playing while the viewer has paused');
  timers.splice(0).forEach((t) => t.fn());
  assert.equal(b.paused, false, 'no frame to show yet: it plays on, muted');
  assert.equal(b.muted, true);
  frames = 1;
  timers.splice(0).forEach((t) => t.fn());
  assert.equal(b.paused, true);
  assert.equal(b.muted, false);
  P.togglePause();                       // play again
  assert.equal(b.paused, false);
});

test('pressing play while a paused Shaka switch is still finding a frame lets it play, with sound', async () => {
  const timers = [];
  const P = await player(fakeAvPlay(), undefined, () => Promise.resolve(), { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  P.forceEngine = 'shaka';
  const [, b] = P.videos;
  P.videos.forEach((v) => videoFake(v, () => 0));
  await P.load(FEED, null);
  P.togglePause();
  await P.switchTo(Object.assign({}, FEED, { url: FEED.url.replace('x', 'y') }), null);
  await new Promise(setImmediate);
  P.togglePause();                       // play, before a frame was shown
  timers.splice(0).forEach((t) => t.fn());
  assert.equal(b.paused, false);
  assert.equal(b.muted, false);
  assert.equal(P.isPaused(), false);
});

test('the frozen-HDR reload keeps the viewer\'s subtitles also when they pause while it reloads', async () => {
  const timers = [];
  let loads = 0, release;
  const P = await player(fakeAvPlay(), { 'f1tv.settings': JSON.stringify({ subtitles: 'eng' }) },
    () => (loads++ ? new Promise((r) => { release = r; }) : Promise.resolve()),
    { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 0; } });
  P.forceEngine = 'shaka';
  Object.assign(P.videos[0], { readyState: 4, currentTime: 0, paused: false, play: () => Promise.resolve(), pause() {},
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }) });
  await P.load({ url: 'https://cdn/hdr.m3u8', licenseUrl: '', multiFeed: true, hdr: true, info: { dynamic: false } }, 30);
  P.languages.splice(0);
  timers.find((t) => t.ms === 5000).fn();   // frozen: it reloads
  P.togglePause();                          // and the viewer pauses before the reload is done
  release();
  await new Promise(setImmediate);
  assert.ok(P.languages.some((l) => l[0] === 'text' && l[1] === 'en'), 'the reload is left on the stream\'s default subtitles');
});

test('team radio chosen on one engine is found on the other ("tea" in HLS, "teamradio" on AVPlay)', async () => {
  // Shaka, with the choice made on AVPlay.
  const P = await player(fakeAvPlay(), { 'f1tv.settings': JSON.stringify({ audio: 'teamradio' }) }, () => Promise.resolve());
  P.forceEngine = 'shaka';
  Object.assign(P.videos[0], { play: () => Promise.resolve() });
  await P.load({ url: 'https://cdn/onboard.m3u8', licenseUrl: '', multiFeed: true, info: { dynamic: false } }, null);
  assert.deepEqual(P.languages[0], ['audio', 'tea']);
  // AVPlay, with the choice made on Shaka.
  const av = fakeAvPlay();
  av.getTotalTrackInfo = () => [{ type: 'AUDIO', index: 0, extra_info: '{"language":"eng"}' }, { type: 'AUDIO', index: 3, extra_info: '{"language":"teamradio"}' }];
  av.setSelectTrack = (type, i) => av.calls.push(['setSelectTrack', type, i]);
  const A = await player(av, { 'f1tv.settings': JSON.stringify({ audio: 'tea' }) });
  await A.load({ url: 'https://cdn/single.m3u8', licenseUrl: '', multiFeed: false, info: { dynamic: false } }, null);
  assert.deepEqual(av.calls.find((c) => c[0] === 'setSelectTrack'), ['setSelectTrack', 'AUDIO', 3]);
});

test('commentary is selected again once playing when AVPlay refuses it in READY (Tizen 9)', async () => {
  const av = fakeAvPlay();
  let audio = 0;
  av.getTotalTrackInfo = () => [{ type: 'AUDIO', index: 0, extra_info: '{"language":"eng"}' }, { type: 'AUDIO', index: 2, extra_info: '{"language":"deu"}' }];
  av.getCurrentStreamInfo = () => [{ type: 'AUDIO', index: audio, extra_info: audio === 2 ? '{"language":"deu"}' : '{"language":"eng"}' }];
  av.setSelectTrack = (type, i) => {
    if (av.getState() !== 'PLAYING') throw new Error('PLAYER_ERROR_INVALID_STATE');
    av.calls.push(['setSelectTrack', type, i]);
    audio = i;
  };
  const P = await player(av, { 'f1tv.settings': JSON.stringify({ audio: 'deu' }) });
  await P.load({ url: 'https://cdn/single.m3u8', licenseUrl: '', multiFeed: false, info: { dynamic: false } }, null);
  await new Promise(setImmediate);
  assert.deepEqual(av.calls.filter((c) => c[0] === 'setSelectTrack'), [['setSelectTrack', 'AUDIO', 2]]);
});

test('commentary already applied in READY is not selected again once playing', async () => {
  const av = fakeAvPlay();
  let audio = 0;
  av.getTotalTrackInfo = () => [{ type: 'AUDIO', index: 0, extra_info: '{"language":"eng"}' }, { type: 'AUDIO', index: 2, extra_info: '{"language":"deu"}' }];
  av.getCurrentStreamInfo = () => [{ type: 'AUDIO', index: audio, extra_info: audio === 2 ? '{"language":"deu"}' : '{"language":"eng"}' }];
  av.setSelectTrack = (type, i) => { av.calls.push(['setSelectTrack', type, i]); audio = i; };
  const P = await player(av, { 'f1tv.settings': JSON.stringify({ audio: 'deu' }) });
  await P.load({ url: 'https://cdn/single.m3u8', licenseUrl: '', multiFeed: false, info: { dynamic: false } }, null);
  await new Promise(setImmediate);
  assert.equal(av.calls.filter((c) => c[0] === 'setSelectTrack').length, 1);
});

test('authorized encrypted HDR uses native playback and the prepared HLG manifest', async () => {
  const av=fakeAvPlay();
  const P=await player(av,undefined,()=>Promise.resolve());
  P.videos.forEach(v=>{v.play=()=>Promise.resolve();});
  let prepared;
  P.context.StreamProxy.hdrManifest=async s=>{prepared=s;return {url:'http://127.0.0.1:18765/vod/hlg.mpd',subtitles:[]};};
  const s={url:'https://cdn/hdr.m3u8',hdr:true,hdrEncrypted:true,widevineManifestUrl:'https://cdn/sdr.mpd',licenseUrl:'https://lic/wv',info:{dynamic:false}};
  await P.load(s,12);
  assert.equal(P.engineName(),'avplay');
  assert.equal(prepared,s);
  assert.equal(av.calls.find(c=>c[0]==='open')[1],'http://127.0.0.1:18765/vod/hlg.mpd');
});

test('native HDR shows its subtitles itself, at the player position, and switches them off', async () => {
  // AVPlay's own renderer loops over one segment's lines above 1080p: the app reads the segments.
  const doc = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" ttp:timeBase="media"><body><div>' +
    '<p begin="10:00:01.000" end="10:00:03.000">First line</p><p begin="10:00:04.000" end="10:00:05.500">Second<br/>line</p></div></body></tt>';
  const fetched = [];
  const av = fakeAvPlay();
  const P = await player(av, { 'f1tv.settings': JSON.stringify({ subtitles: 'en' }) }, () => Promise.resolve(), {
    fetch: async (url) => {
      fetched.push(url);
      return url.includes('/subs/') ? { ok: true, arrayBuffer: async () => Uint8Array.from(Buffer.from('\0\0mdat' + doc)).buffer } : { ok: true };
    }
  });
  const shown = [];
  P.on('subtitle', (s) => shown.push(s));
  const subtitles = [{ lang: 'eng', base: 'https://cdn/subs/', id: 'S1', media: 'seg_$RepresentationID$_$Number$.mp4',
    timescale: 1000, offset: 36000000, startNumber: 1, runs: [{ t: 36000000, d: 6000, r: 9 }] }];
  P.context.StreamProxy.hdrManifest = async () => ({ url: 'http://127.0.0.1:18765/vod/hlg.mpd', subtitles });
  av.time = 1500;
  await P.load({ url: 'https://cdn/hdr.m3u8', hdr: true, hdrEncrypted: true, licenseUrl: 'https://lic/wv', info: { dynamic: false } }, null);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(P.tracks().text.map((t) => t.lang), ['eng']);
  assert.equal(fetched.filter((u) => u.includes('/subs/'))[0], 'https://cdn/subs/seg_S1_1.mp4');
  assert.equal(shown.at(-1).text, 'First line');
  av.time = 4200;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(shown.at(-1).text, 'Second\nline');
  P.setSubtitles('');
  assert.equal(shown.at(-1), null);
  await P.unload();
});

test('AVPlay subtitles: lines resent at a segment boundary are not flashed again, but come back after a seek', async () => {
  const av = fakeAvPlay();
  const P = await player(av);
  const shown = [];
  P.on('subtitle', (s) => shown.push(s.text));
  await P.load(REPLAY, null);
  const say = (text) => av.listener.onsubtitlechange(2000, text + '\u0000');
  say('one'); say('two');
  // The next segment repeats its earlier cues before the new one.
  say('one'); say('two'); say('three');
  assert.deepEqual(shown, ['one', 'two', 'three']);
  P.seekTo(100);
  say('two');
  assert.deepEqual(shown, ['one', 'two', 'three', 'two']);
});

test('SDR replays are locked to their top quality; live, HDR and stall-prone starts are not', async () => {
  const LADDER = [512000, 911360, 2048000, 3645440, 6144000];
  const replay = Object.assign({}, REPLAY, { info: Object.assign({}, REPLAY.info, { videoBitrates: LADDER }) });
  const adaptive = (av) => av.calls.find((c) => c[0] === 'setStreamingProperty')[2];
  const av = fakeAvPlay({ duration: 6163000 });
  await (await player(av)).load(replay, null);
  assert.equal(adaptive(av), 'BITRATES=6144000~12288000|STARTBITRATE=HIGHEST');
  const live = fakeAvPlay();
  await (await player(live)).load(Object.assign({}, LIVE, { info: Object.assign({}, LIVE.info, { videoBitrates: LADDER }) }), null);
  assert.equal(adaptive(live), 'STARTBITRATE=HIGHEST');
  const slow = fakeAvPlay({ duration: 6163000 });
  await (await player(slow, { 'f1tv.startLevel': '1' })).load(replay, null);
  assert.equal(adaptive(slow), 'STARTBITRATE=AVERAGE');
  const unknown = fakeAvPlay({ duration: 6163000 });
  await (await player(unknown)).load(REPLAY, null);   // no ladder known: as before
  assert.equal(adaptive(unknown), 'STARTBITRATE=HIGHEST');
});

test('a stall at the locked quality reopens the replay where it was, with AVPlay choosing again', async () => {
  const av = fakeAvPlay({ duration: 6163000 });
  const timers = [];
  const P = await player(av, {}, undefined, { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  const replay = Object.assign({}, REPLAY, { info: Object.assign({}, REPLAY.info, { videoBitrates: [2048000, 6144000] }) });
  await P.load(replay, null);
  const realNow = Date.now;
  const stall = async (offset) => {
    Date.now = () => realNow() + offset;   // well past the start's quiet period
    try {
      av.listener.onbufferingstart();
      timers.filter((t) => t.ms === 2000).at(-1).fn();   // still buffering 2 s later
      await new Promise((r) => setImmediate(r));
    } finally { Date.now = realNow; }
  };
  av.listener.oncurrentplaytime(754000);
  await stall(60000);
  const opens = av.calls.filter((c) => c[0] === 'open');
  assert.equal(opens.length, 2);
  assert.equal(opens[1][1], opens[0][1]);
  const props = av.calls.filter((c) => c[0] === 'setStreamingProperty').map((c) => c[2]);
  assert.equal(props.at(-1), 'STARTBITRATE=AVERAGE');
  assert.deepEqual(av.calls.filter((c) => c[0] === 'seekTo').at(-1), ['seekTo', 754000]);
  assert.ok(names(av).lastIndexOf('stop') < names(av).lastIndexOf('open'));
  // A stall once it is no longer locked does not reopen it again.
  await stall(120000);
  assert.equal(av.calls.filter((c) => c[0] === 'open').length, 2);
});

test('brief buffering is not a stall: the next start keeps the top quality and the lock stays', async () => {
  const av = fakeAvPlay({ duration: 6163000 });
  const timers = [], store = {};
  const P = await player(av, store, undefined, { setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; } });
  const replay = Object.assign({}, REPLAY, { info: Object.assign({}, REPLAY.info, { videoBitrates: [2048000, 6144000] }) });
  await P.load(replay, null);
  const realNow = Date.now;
  Date.now = () => realNow() + 30000;
  try {
    av.listener.onbufferingstart();
    av.listener.onbufferingcomplete();   // a 100 ms blip
  } finally { Date.now = realNow; }
  const check = timers.filter((t) => t.ms === 2000).at(-1);
  assert.equal(check.cleared, true);
  assert.equal(store['f1tv.startLevel'], undefined);
  assert.equal(av.calls.filter((c) => c[0] === 'open').length, 1);
});

test('live native HDR opens the helper\'s live manifest with the HLG video, time-shifted like SDR live', async () => {
  const av = fakeAvPlay({ liveWindow: '1000|2000' });
  const P = await player(av, { 'f1tv.settings': JSON.stringify({ audio: 'deu' }) });
  let asked = null;
  P.context.StreamProxy.hdrManifest = async () => { throw new Error('the replay builder is not for live'); };
  P.context.StreamProxy.hdrLive = async (s, shift, langs) => { asked = { shift, langs }; return { url: 'http://127.0.0.1:18765/mpd?u=x&hdr=1&notext=1', subtitles: [] }; };
  const s = Object.assign({}, LIVE, { url: 'https://cdn/live/master.m3u8', hdr: true, hdrEncrypted: true, widevineManifestUrl: LIVE.url, startDelay: 600 });
  await P.load(s, null);
  assert.equal(P.engineName(), 'avplay');
  assert.deepEqual(JSON.parse(JSON.stringify(asked)), { shift: 600, langs: { audio: 'deu', text: '' } });
  assert.equal(av.calls.find((c) => c[0] === 'open')[1], 'http://127.0.0.1:18765/mpd?u=x&hdr=1&notext=1');
  assert.equal(P.isLive(), true);
  assert.equal(av.calls.filter((c) => c[0] === 'setStreamingProperty')[0][2], 'STARTBITRATE=HIGHEST');   // never locked
});

test('Chromecast\'s cenc stream plays on Shaka, with its licence; the usual cbcs stream stays on AVPlay', async () => {
  const P = await player(fakeAvPlay({ duration: 6163000 }), undefined, () => Promise.resolve());
  P.videos.forEach((v) => { v.play = () => Promise.resolve(); });
  await P.load(Object.assign({}, REPLAY, { cenc: true, multiFeed: true }), 600);
  assert.equal(P.engineName(), 'shaka');
  assert.deepEqual(JSON.parse(JSON.stringify(P.configs.at(-1).drm)), { servers: { 'com.widevine.alpha': REPLAY.licenseUrl } });
  await P.load(REPLAY, 600);
  assert.equal(P.engineName(), 'avplay');
});

test('live cenc plays on AVPlay through the helper; Tizen 5 reports no cbcs, Tizen 6 and unknown TVs do', async () => {
  const av = fakeAvPlay();
  const P = await player(av, undefined, () => Promise.resolve());
  await P.load(Object.assign({}, LIVE, { cenc: true }), null);
  assert.equal(P.engineName(), 'avplay');
  assert.match(av.calls.find((c) => c[0] === 'open')[1], /^http:\/\/127\.0\.0\.1:18765\/mpd\?u=/);
  assert.equal(P.cbcsCapable(), true);
  for (const [version, cbcs] of [['5.0', false], ['5.5', false], ['6.0', true], ['6.5', true]]) {
    const tv = await player(fakeAvPlay(), undefined, undefined, { tizen: { systeminfo: { getCapability: () => version } } });
    assert.equal(tv.cbcsCapable(), cbcs, version);
  }
});

test('the first cenc video, stalled before any data (readyState 1), is loaded once more; a clear one still buffering is not', async () => {
  for (const [cenc, readyState, reloads] of [[true, 1, 1], [false, 1, 0], [true, 4, 1]]) {
    let loads = 0;
    const timers = [];
    const P = await player(fakeAvPlay(), undefined, () => { loads++; return Promise.resolve(); },
      { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 0; } });
    P.forceEngine = 'shaka';
    Object.assign(P.videos[0], { readyState, play: () => Promise.resolve(), getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }) });
    await P.load({ url: 'https://cdn/x.mpd', licenseUrl: 'https://lic', multiFeed: true, cenc, hdr: !cenc, info: { dynamic: false } }, 600);
    const check = timers.find((t) => t.ms === 5000);
    if (check) check.fn();
    await new Promise(setImmediate);
    assert.equal(loads, 1 + reloads, JSON.stringify({ cenc, readyState }));
  }
});

test('cenc feed switches load in place instead of preloading beside the playing feed', async () => {
  const urls = [];
  const P = await player(fakeAvPlay(), undefined, (url) => { urls.push(url); return Promise.resolve(); });
  P.videos.forEach((v) => { v.play = () => Promise.resolve(); });
  const feed = (n) => Object.assign({}, REPLAY, { url: 'https://cdn/' + n + '.mpd', cenc: true, multiFeed: true });
  await P.load(feed('main'), 600);
  await P.switchTo(feed('onboard'), 610);
  assert.equal(P.engineName(), 'shaka');
  assert.deepEqual(urls, ['https://cdn/main.mpd', 'https://cdn/onboard.mpd']);
  assert.equal(P.stream().url, 'https://cdn/onboard.mpd');
  assert.notEqual(P.videos[1].muted, true, 'the second element (preloading) was never used');
});
