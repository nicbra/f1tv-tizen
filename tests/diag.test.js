const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

const SRC = readFileSync('app/js/diag.js', 'utf8');

/** diag.js in a fresh page; `store` is localStorage, shared between "runs" of the app. */
function load({ store = {}, build = { record: true, label: 'test' }, settings = {}, now = Date.UTC(2026, 10, 8, 20), ua } = {}) {
  const win = {}, doc = { hidden: false, listeners: {} }, intervals = [];
  const clock = { now };
  const context = vm.createContext({
    window: {
      addEventListener: (t, fn) => { win[t] = fn; },
      get localStorage() { return context.localStorage; }
    },
    document: { get hidden() { return doc.hidden; }, addEventListener: (t, fn) => { doc.listeners[t] = fn; } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    Settings: { get: (k) => settings[k] },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    setTimeout: () => 0,
    Date: class extends Date { static now() { return clock.now; } },
    Math, JSON,
    navigator: { userAgent: ua || 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36', onLine: true },
    DIAG_BUILD: build
  });
  vm.runInContext(SRC, context, { filename: 'diag.js' });
  // tick(): the heartbeat timers fire once.
  return { Diag: context.Diag, store, win, doc, clock, settings, tick: () => intervals.forEach((fn) => fn()) };
}

const kinds = (d) => d.report().entries.map((e) => e.k);

test('records nothing unless the build or the viewer turns it on', () => {
  const { Diag, store } = load({ build: { record: false } });
  Diag.note('play.failed', { error: new Error('x') });
  Diag.playing({ contentId: 1 });
  assert.equal(Diag.recording(), false);
  assert.deepEqual(store, {});
  assert.deepEqual(Diag.report().entries, []);
});

test('the opt-in setting turns it on in release builds', () => {
  const { Diag } = load({ build: { record: false }, settings: { diagnostics: true } });
  Diag.note('player.error', { message: 'Player error: PLAYER_ERROR_CONNECTION_FAILED' }, 'error');
  assert.deepEqual(kinds(Diag), ['app.start', 'player.error']);
  assert.equal(Diag.report().tv.build, 'release');
});

test('the repo build file keeps recording off', () => {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync('app/js/diag-build.js', 'utf8'), ctx);
  assert.equal(ctx.DIAG_BUILD.record, false);
});

test('entries survive an app restart and carry the run they came from', () => {
  const first = load();
  first.Diag.note('play.no-start', { position: 12 });
  const second = load({ store: first.store });
  second.Diag.note('player.stall', { ms: 4200 });
  const log = second.Diag.report().entries;
  assert.deepEqual(log.map((e) => e.k), ['app.start', 'play.no-start', 'app.start', 'player.stall']);
  assert.notEqual(log[0].r, log[3].r);
  assert.equal(log[1].d.position, 12);
});

test('secrets, signed URLs and account details are left out', () => {
  const { Diag } = load();
  const err = Object.assign(new Error('License server answered 403 for https://f1prodlive.akamaized.net/out/v1/abc/' +
    'index.m3u8?hdnts=exp=1~acl=*~hmac=0123456789abcdef0123456789abcdef'), { status: 403 });
  Diag.note('play.failed', {
    error: err,
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
    licenseHeaders: { Authorization: 'Bearer secret', ascendon: 'x' },
    note: 'header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig and user@example.com',
    blob: 'A'.repeat(60),
    url: 'https://ott-video-cf.formula1.com/2c6f/1000010409/very/long/path/main.mpd?token=abc'
  });
  const e = Diag.report().entries.find((x) => x.k === 'play.failed');
  const text = JSON.stringify(e);
  assert.doesNotMatch(text, /hdnts|hmac|Bearer|secret|eyJ|example\.com|token=|AAAAAAAAAA/);
  assert.equal(e.d.token, '[redacted]');
  assert.equal(e.d.licenseHeaders.Authorization, '[redacted]');
  assert.equal(e.d.url, 'https://ott-video-cf.formula1.com/…/main.mpd');
  assert.match(e.d.error.message, /^License server answered 403 for https:\/\/f1prodlive\.akamaized\.net\/…\/index\.m3u8$/);
  assert.equal(e.d.error.status, 403);
  assert.match(e.d.note, /\[jwt\].*\[email\]/);
});

test('a stream is summed up without its URL query or DRM data', () => {
  const { Diag } = load();
  const s = Diag.stream({ contentId: 1000010409, channelId: 1033, streamType: 'HDR_UHD_CMAFFP', platform: 'BIG_SCREEN_HLS', hdr: true,
    hdrEncrypted: true, feed: 'F1 LIVE', url: 'https://ott-video-cf.formula1.com/x/y/master.m3u8?sig=1', licenseUrl: 'https://lic/?t=1',
    licenseHeaders: { ascendontoken: 't' }, widevineManifestUrl: 'https://x/y.mpd?t=2',
    info: { encrypted: true, segDur: 5.76, marks: [{ pos: 0, wall: 1 }], offer: { kind: 'hls', keyFormats: ['SAMPLE-AES com.apple.streamingkeydelivery'] } } });
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { contentId: 1000010409, channelId: 1033, feed: 'F1 LIVE', streamType: 'HDR_UHD_CMAFFP',
    platform: 'BIG_SCREEN_HLS', hdr: true, hdrEncrypted: true, device: 'tvos', drm: 'cbcs', encrypted: true, segDur: 5.76,
    offer: { kind: 'hls', keyFormats: ['SAMPLE-AES com.apple.streamingkeydelivery'] }, url: 'https://ott-video-cf.formula1.com/…/master.m3u8' });
  assert.equal(Diag.stream({ cenc: true, licenseUrl: 'x' }).drm, 'cenc');
  assert.equal(Diag.stream({ cenc: true, licenseUrl: 'x' }).device, 'chromecast');
  assert.equal(Diag.stream({ url: 'https://a/b.m3u8' }).drm, 'clear');
});

test('entries name the video playing then', () => {
  const { Diag } = load();
  Diag.playing({ contentId: 7, streamType: 'SDR_HD_CMAF', live: true });
  Diag.note('player.stall', { ms: 3000 });
  Diag.playing(null);
  Diag.note('api.http', { status: 500 });
  const log = Diag.report().entries;
  assert.equal(log.find((e) => e.k === 'play').d.contentId, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(log.find((e) => e.k === 'player.stall').p)), { id: 7, type: 'SDR_HD_CMAF', drm: 'clear', live: true });
  assert.equal(log.find((e) => e.k === 'api.http').p, undefined);
});

test('a burst of one kind is capped per minute and counted', () => {
  const t = load();
  for (let i = 0; i < 25; i++) t.Diag.note('js.rejection', { i });
  t.clock.now += 60000;
  t.Diag.note('js.rejection', { i: 'next' });
  const log = t.Diag.report().entries;
  assert.equal(log.filter((e) => e.k === 'js.rejection').length, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(log.find((e) => e.k === 'diag.dropped').d)), { kind: 'js.rejection', count: 15 });
});

test('the log stays within its entry and size limits', () => {
  const t = load();
  for (let i = 0; i < 1000; i++) { t.clock.now += 61000; t.Diag.note('player.stall', { i, text: 'stalled at segment '.repeat(14) }); }
  const log = t.Diag.report().entries;
  assert.ok(log.length <= 400, String(log.length));
  assert.ok(t.store['f1tv.diag'].length <= 400000);
  assert.equal(log.at(-1).d.i, 999);
});

test('the app ending while a video played shows up at the next start', () => {
  const first = load();
  first.Diag.playing({ contentId: 42, streamType: 'HDR_UHD_CMAF' });
  const second = load({ store: first.store });
  const ended = second.Diag.report().entries.find((e) => e.k === 'app.ended-while-playing');
  assert.equal(ended.l, 'error');
  assert.equal(ended.d.video.contentId, 42);
});

test('leaving the app while a video plays is not an unexpected end', () => {
  const first = load();
  first.Diag.playing({ contentId: 42 });
  first.doc.hidden = true;
  first.doc.listeners.visibilitychange();
  const second = load({ store: first.store });
  assert.ok(!kinds(second.Diag).includes('app.ended-while-playing'));
});

test('script errors and rejections are recorded; failed images are not', () => {
  const { Diag, win } = load();
  win.error({ message: 'Uncaught TypeError: x is undefined', filename: 'file:///opt/usr/apps/F1TV/res/wgt/js/app.js', lineno: 10, colno: 3 });
  win.error({});
  win.unhandledrejection({ reason: new Error('boom') });
  const log = Diag.report().entries;
  assert.deepEqual(log.map((e) => e.k), ['app.start', 'js.error', 'js.rejection']);
  assert.equal(log[1].d.file, 'file:///…/app.js');
  assert.equal(log[2].d.reason.message, 'boom');
});

test('clear() empties the log', () => {
  const t = load();
  t.Diag.note('player.stall', {});
  t.Diag.clear();
  assert.deepEqual(t.Diag.report().entries, []);
  assert.equal(t.store['f1tv.diag'], undefined);
});

test('warnings and errors carry the trail before them and snapshots of the state then', async () => {
  const t = load();
  t.Diag.provide('player', () => ({ engine: 'avplay', avplay: { state: 'PLAYING', video: { width: 1920, height: 1080 } } }));
  t.Diag.provide('broken', () => { throw new Error('no state'); });
  let answer;
  t.Diag.provideAsync('helper', () => new Promise((resolve) => { answer = resolve; }));
  t.Diag.playing({ contentId: 9, streamType: 'SDR_HD_DASH' });
  t.clock.now += 2000;
  t.Diag.trail('player.seekTo', { to: 120, headers: { ascendontoken: 'x' } });
  t.clock.now += 1500;
  t.Diag.note('player.error', { message: 'Player error: PLAYER_ERROR_CONNECTION_FAILED' }, 'error');
  const e = t.Diag.report().entries.find((x) => x.k === 'player.error');
  assert.deepEqual(JSON.parse(JSON.stringify(e.trail)).map((x) => [x.k, x.ago]), [['app.start', 3.5], ['play', 3.5], ['player.seekTo', 1.5]]);
  assert.equal(e.trail[2].d.headers, '[redacted]');
  assert.equal(e.s.player.avplay.state, 'PLAYING');
  assert.equal(e.s.broken.failed, 'no state');
  assert.equal(e.s.playingFor, 3.5);
  assert.ok(e.s.network);
  assert.equal(e.s.helper, undefined);
  answer([{ host: 'f1prodlive.akamaized.net', status: 403, ms: 40 }]);
  await new Promise((r) => setImmediate(r));
  const stored = JSON.parse(t.store['f1tv.diag']).find((x) => x.k === 'player.error');
  assert.equal(stored.s.helper[0].status, 403);
  // Info entries stay small.
  assert.equal(t.Diag.report().entries.find((x) => x.k === 'play').s, undefined);
});

test('the helper log is asked for at most every 5 s', () => {
  const t = load();
  let asks = 0;
  t.Diag.provideAsync('helper', () => { asks++; return null; });
  t.Diag.note('player.stall', {});
  t.clock.now += 1000;
  t.Diag.note('player.error', {}, 'error');
  t.clock.now += 5000;
  t.Diag.note('player.stall', {});
  assert.equal(asks, 2);
});

test('each run says which Chromium the TV has, from Samsung\'s user agent or a Chrome one', () => {
  assert.equal(load().Diag.report().tv.browser, 'Chromium 76.0.3809.146');
  const t9 = load({ ua: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.5 TV Safari/537.36' });
  assert.equal(t9.Diag.report().tv.browser, 'Chromium 120.0.6099.5');
  assert.match(load().Diag.report().tv.userAgent, /Tizen 6\.0/);
});

test('secrets written into text are left out too', () => {
  const { Diag } = load();
  Diag.note('api.http', { message: 'denied: Authorization: Bearer short-secret, customdata: 0123456789abcdef0123456789abcdef, ' +
    '{"drmToken":"abc123"} sig=xyz token=t1 /master.m3u8?token=short-secret&x=1 ascendontoken: zzz' });
  const m = Diag.report().entries.find((e) => e.k === 'api.http').d.message;
  assert.doesNotMatch(m, /short-secret|0123456789abcdef|abc123|xyz|t1\b|zzz|x=1/, m);
  assert.match(m, /Authorization: \[redacted\]/);
  assert.match(m, /\/master\.m3u8/);
});

test('URLs keep their host and a plain file name, never a query or an unknown last part', () => {
  const { Diag } = load();
  Diag.note('x', { a: 'see https://cdn.example/file?x=(1)&token=short-secret now',
    b: 'https://cdn.example/a/b/abc123secret', c: 'at (file:///opt/usr/apps/F1/res/wgt/js/app.js:12:5)',
    d: 'https://user:pw@cdn.example/x.mpd' });
  const d = Diag.report().entries.find((e) => e.k === 'x').d;
  assert.equal(d.a, 'see https://cdn.example/[…] now');
  assert.equal(d.b, 'https://cdn.example/…/[…]');
  assert.equal(d.c, 'at (file:///…/app.js:12:5)');
  assert.equal(d.d, 'https://cdn.example/x.mpd');
});

test('one huge entry is cut down instead of filling the storage', () => {
  const t = load();
  const big = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => 'segment stalled '.repeat(18))));
  t.win.unhandledrejection({ reason: big });
  const e = t.Diag.report().entries.find((x) => x.k === 'js.rejection');
  assert.ok(JSON.stringify(e).length <= 12000, String(JSON.stringify(e).length));
  assert.ok(t.store['f1tv.diag'].length < 20000);
});

test('opting out stops the heartbeat and late helper answers; opting in later catches script errors', async () => {
  const t = load({ build: { record: false }, settings: { diagnostics: true } });
  let answer;
  t.Diag.provideAsync('helper', () => new Promise((r) => { answer = r; }));
  t.Diag.note('player.stall', {});
  t.settings.diagnostics = false;
  const before = t.store['f1tv.diag'], beat = t.store['f1tv.diag.alive'];
  t.clock.now += 20000;
  t.tick();
  answer([{ status: 500 }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.store['f1tv.diag'], before);
  assert.equal(t.store['f1tv.diag.alive'], beat);

  const late = load({ build: { record: false }, settings: {} });
  late.settings.diagnostics = true;
  late.win.error({ message: 'Uncaught TypeError: boom', filename: 'file:///x/app.js', lineno: 1, colno: 1 });
  assert.ok(kinds(late.Diag).includes('js.error'));
});

test('a hidden app keeps its clean mark through heartbeats, so a later close is no crash', () => {
  const first = load();
  first.Diag.playing({ contentId: 42 });
  first.doc.hidden = true;
  first.doc.listeners.visibilitychange();
  first.clock.now += 60000;
  first.tick();
  const second = load({ store: first.store });
  assert.ok(!kinds(second.Diag).includes('app.ended-while-playing'));
  // Back in front and playing, then gone without a word: that is reported.
  first.doc.hidden = false;
  first.doc.listeners.visibilitychange();
  first.tick();
  const third = load({ store: first.store });
  assert.ok(kinds(third.Diag).includes('app.ended-while-playing'));
});

test('every warning in a burst gets the helper log from one request', async () => {
  const t = load();
  let asks = 0, answer;
  t.Diag.provideAsync('helper', () => { asks++; return new Promise((r) => { answer = r; }); });
  t.Diag.note('api.http', { status: 403 });
  t.clock.now += 300;
  t.Diag.note('play.failed', {}, 'error');
  answer([{ host: 'f1prodlive.akamaized.net', status: 403 }]);
  await new Promise((r) => setImmediate(r));
  const log = JSON.parse(t.store['f1tv.diag']);
  assert.equal(asks, 1);
  assert.equal(log.find((e) => e.k === 'api.http').s.helper[0].status, 403);
  assert.equal(log.find((e) => e.k === 'play.failed').s.helper[0].status, 403);
});

test('a stored log or heartbeat of the wrong shape is ignored, not fatal', () => {
  const t = load({ store: { 'f1tv.diag': '{}', 'f1tv.diag.alive': '{"r":"old","p":{"contentId":1},"at":"soon"}' } });
  assert.ok(t.Diag);
  const log = t.Diag.report().entries;
  assert.equal(log[0].k, 'app.start');
  assert.equal(log.find((e) => e.k === 'app.ended-while-playing').d.lastSeen, null);
  const u = load({ store: { 'f1tv.diag': '[1, null, {"t": "x"}, {"t": 5, "k": "old"}]' } });
  assert.deepEqual(kinds(u.Diag), ['old', 'app.start']);
});

test('left-out counts are written even when that kind never comes again', () => {
  const t = load();
  for (let i = 0; i < 14; i++) t.Diag.note('js.rejection', { i });
  t.clock.now += 61000;
  t.Diag.note('player.stall', {});
  const d = t.Diag.report().entries.find((e) => e.k === 'diag.dropped');
  assert.deepEqual(JSON.parse(JSON.stringify(d.d)), { kind: 'js.rejection', count: 4 });
  // Still in the same minute: report() includes the count so far.
  const u = load();
  for (let i = 0; i < 12; i++) u.Diag.note('js.rejection', { i });
  assert.equal(u.Diag.report().entries.find((e) => e.k === 'diag.dropped').d.count, 2);
});
