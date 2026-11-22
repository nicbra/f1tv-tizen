const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function boot(store = {}, options = {}) {
  let now = options.now || 100000, id = 0;
  const timers = new Map(), events = {}, calls = [];
  class Clock extends Date { static now() { return now; } }
  const document = { hidden: false, addEventListener: (name, fn) => { events[name] = fn; } };
  const context = vm.createContext({ Date: Clock, document,
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    webapis: { productinfo: { getFirmware: () => { if (options.firmwareError) throw Error('unavailable'); return options.firmware || 'TV-1'; } } },
    localStorage: { getItem: (key) => store[key] || null, setItem: (key, value) => { if (options.storageError) throw Error('full'); store[key] = value; } },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: (id) => timers.delete(id),
    navigator: { requestMediaKeySystemAccess: (key, configs) => {
      calls.push({ key, configs });
      return options.probe ? options.probe(configs[0]) : Promise.reject(Error('unsupported'));
    } }
  });
  if (options.version) context.Launcher = { version: options.version };
  const source = readFileSync('app/js/caps.js', 'utf8');
  vm.runInContext(options.source ? options.source(source) : source, context);
  return { caps: context.Caps, store, timers, events, calls, document, at: (time) => { now = time; } };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const settled = () => new Promise(setImmediate);

test('caps persists outcomes per path, last time, firmware and returns a detached report', () => {
  const h = boot();
  h.caps.ok('shaka:cenc'); h.at(123456); h.caps.failed('avplay:cbcs');
  const report = h.caps.report();
  assert.deepEqual(plain(report.paths['shaka:cenc']), { ok: 1, failed: 0, crashed: 0, last: 100000, streak: 0, retries: 0 });
  assert.deepEqual(plain(report.paths['avplay:cbcs']), { ok: 0, failed: 1, crashed: 0, last: 123456, streak: 1, badAt: 123456 });
  report.paths['avplay:cbcs'].failed = 99;
  assert.equal(boot(h.store).caps.report().paths['avplay:cbcs'].failed, 1);
  assert.equal(boot(h.store, { firmware: 'TV-2' }).caps.report().paths['avplay:cbcs'], undefined);
});

test('caps tolerates corrupt/disabled storage and unavailable firmware', () => {
  for (const value of ['garbage', 'null', '{}']) {
    const h = boot({ 'f1tv.caps': value }, { firmwareError: true, storageError: true });
    h.caps.ok('shaka:cenc'); h.caps.crashStart('avplay:hdr'); h.caps.crashEnd();
    assert.equal(h.caps.report().firmware, 'unknown');
    assert.equal(h.caps.usable('shaka:cenc'), true);
  }
});

test('a recent native heartbeat is counted once at next launch; stale/future markers are discarded', () => {
  for (const [age, expected] of [[0, 1], [9 * 60000, 1], [10 * 60000, 0], [-1, 0]]) {
    const h = boot(); h.caps.crashStart('avplay:cbcs');
    const next = boot(h.store, { now: 100000 + age });
    assert.equal(next.caps.report().paths['avplay:cbcs']?.crashed || 0, expected);
    assert.equal(next.caps.report().playing, undefined);
    assert.equal(boot(h.store).caps.report().paths['avplay:cbcs']?.crashed || 0, expected);
  }
});

test('crash heartbeat refreshes every five seconds, preserving its start, and replaces the old path', () => {
  const h = boot(); h.caps.crashStart('avplay:cbcs'); h.at(180000);
  h.timers.forEach((t) => { if (t.interval) { assert.equal(t.ms, 5000); t.fn(); } });
  assert.deepEqual(plain(h.caps.report().playing), { path: 'avplay:cbcs', since: 100000, at: 180000 });
  assert.equal(boot(h.store, { now: 185000 }).caps.report().paths['avplay:cbcs'].crashed, 1);
  h.caps.crashStart('avplay:cenc');
  assert.equal([...h.timers.values()].filter((t) => t.interval).length, 1);
  assert.equal(h.caps.report().playing.path, 'avplay:cenc');
});

test('stop, normal exit, unload and hiding remove the marker and stop heartbeats; hidden playback cannot arm it', () => {
  for (const event of ['stop', 'pagehide', 'beforeunload', 'unload', 'visibilitychange']) {
    const h = boot(); h.caps.crashStart('avplay:hdr');
    if (event === 'stop') h.caps.crashEnd();
    else { h.document.hidden = true; h.events[event](); }
    assert.equal(h.caps.report().playing, undefined, event);
    assert.equal([...h.timers.values()].some((t) => t.interval), false);
    assert.equal(boot(h.store).caps.report().paths['avplay:hdr'], undefined);
    h.document.hidden = true; h.caps.crashStart('avplay:hdr');
    assert.equal(h.caps.report().playing, undefined);
  }
});

test('avoidance requires two crashes, a crash plus failure, or repeated failures; a good start clears failures, not crashes', () => {
  for (const sequence of [['crash', 'crash'], ['crash', 'failed'], ['failed', 'failed']]) {
    let h = boot();
    for (let i = 0; i < sequence.length; i++) {
      if (sequence[i] === 'crash') { h.caps.crashStart('avplay:cbcs'); h = boot(h.store); }
      else h.caps.failed('avplay:cbcs');
      assert.equal(h.caps.usable('avplay:cbcs'), i === 0);
    }
    // It played after all (the last resort): failed starts no longer count against it, crashes still do.
    h.caps.ok('avplay:cbcs');
    assert.equal(h.caps.report().paths['avplay:cbcs'].ok, 1);
    assert.equal(h.caps.usable('avplay:cbcs'), sequence[1] === 'failed');
    h.caps.failed('avplay:cbcs');
    assert.equal(h.caps.usable('avplay:cbcs'), sequence[0] === 'failed', sequence.join());
  }
});

test('failed starts between good ones never rule a path out (4K HDR: 31 good starts, 2 connection failures)', () => {
  const h = boot();
  for (let i = 0; i < 20; i++) h.caps.ok('avplay:hdr');
  h.caps.failed('avplay:hdr');
  for (let i = 0; i < 11; i++) h.caps.ok('avplay:hdr');
  h.caps.failed('avplay:hdr');
  assert.equal(h.caps.usable('avplay:hdr'), true);
  h.caps.failed('avplay:hdr');
  assert.equal(h.caps.usable('avplay:hdr'), false);
  // A record from before the streak was kept: its successes count as the latest outcome.
  const old = boot({ 'f1tv.caps': JSON.stringify({ version: 1, firmware: 'TV-1', browser: { cenc: true, cbcs: false },
    paths: { 'avplay:hdr': { ok: 31, failed: 2, crashed: 0, last: 1 }, 'avplay:cenc': { ok: 0, failed: 2, crashed: 0, last: 1 } } }) });
  assert.equal(old.caps.usable('avplay:hdr'), true);
  assert.equal(old.caps.usable('avplay:cenc'), false);
});

test('even when every SDR path is avoided there is a usable last resort; HDR is never that last resort', () => {
  const h = boot(), paths = ['shaka:cenc', 'avplay:cbcs', 'avplay:cenc'];
  for (const path of paths.concat('avplay:hdr')) { h.caps.failed(path); h.caps.failed(path); }
  assert.equal(paths.filter(h.caps.usable).length, 1);
  assert.equal(h.caps.usable('avplay:hdr'), false);
  h.caps.failed('shaka:cenc');
  assert.equal(h.caps.usable('avplay:cbcs'), true);
});

test('EME waits ten seconds, asks video-only for each scheme and verifies the granted scheme', async () => {
  const h = boot({}, { probe: (config) => Promise.resolve({ getConfiguration: () => config }) });
  assert.equal(h.calls.length, 0);
  assert.equal(h.caps.browser('cenc'), null);
  const probe = [...h.timers.values()].find((t) => t.ms === 10000); assert.ok(probe); probe.fn();
  await settled();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map((c) => c.configs[0].videoCapabilities[0].encryptionScheme), ['cenc', 'cbcs']);
  for (const call of h.calls) { assert.equal(call.key, 'com.widevine.alpha'); assert.equal(call.configs[0].audioCapabilities, undefined); }
  assert.equal(h.caps.browser('cenc'), true); assert.equal(h.caps.browser('cbcs'), true);
  assert.equal(boot(h.store).caps.browser('cbcs'), true);
  assert.equal(boot(h.store, { firmware: 'new' }).caps.browser('cbcs'), null);
});

for (const [name, probe] of [
  ['audio-only grant', () => Promise.resolve({ getConfiguration: () => ({ audioCapabilities: [{ encryptionScheme: 'cenc' }] }) })],
  ['different scheme', (config) => Promise.resolve({ getConfiguration: () => ({ videoCapabilities: [{ encryptionScheme: config.videoCapabilities[0].encryptionScheme === 'cenc' ? 'cbcs' : 'cenc' }] }) })],
  ['refusal', () => Promise.reject(Error('unsupported'))],
  ['synchronous error', () => { throw Error('no EME'); }]
]) test('EME does not accept ' + name, async () => {
  const h = boot({}, { probe }); [...h.timers.values()].find((t) => t.ms === 10000).fn(); await settled();
  assert.equal(h.caps.browser('cenc'), false); assert.equal(h.caps.browser('cbcs'), false);
});

test('an old engine that drops the encryptionScheme member keeps the browser path unknown', async () => {
  // Chromium before 58 drops unknown dictionary members: access is granted, but the configuration
  // reports no scheme. That is "unknown" (null), so cencCapable keeps shaka:cenc selectable and the
  // TV's own playback evidence decides.
  const probe = () => Promise.resolve({ getConfiguration: () => ({ videoCapabilities: [{ contentType: 'video/mp4' }] }) });
  const h = boot({}, { probe }); [...h.timers.values()].find((t) => t.ms === 10000).fn(); await settled();
  assert.equal(h.caps.browser('cenc'), null); assert.equal(h.caps.browser('cbcs'), null);
  assert.equal(boot(h.store).caps.browser('cenc'), null, 'persisted as unknown, not as a refusal');
});

test('without browser cenc the last resort is the native path that only failed, not the one that crashed', () => {
  const h = boot({ 'f1tv.caps': JSON.stringify({ version: 1, firmware: 'TV-1', browser: { cenc: false, cbcs: false },
    paths: { 'avplay:cbcs': { ok: 0, failed: 0, crashed: 2, last: 1 }, 'avplay:cenc': { ok: 0, failed: 2, crashed: 0, last: 1 } } }) });
  assert.equal(h.caps.usable('avplay:cbcs'), false);
  assert.equal(h.caps.usable('avplay:cenc'), true);
});

test('encrypted HDR stays avoided when native cbcs is the last SDR resort', () => {
  const h = boot();
  for (const path of ['shaka:cenc', 'avplay:cbcs', 'avplay:cenc']) {
    h.caps.failed(path); h.caps.failed(path);
  }
  h.caps.failed('shaka:cenc');
  assert.equal(h.caps.usable('avplay:cbcs'), true);
  assert.equal(h.caps.usable('avplay:hdr'), false);
});

const DAY = 86400000;
// Two crashes on a path, found as heartbeats at the next starts (as the app does), then a third start after them.
function crashedTwice(path, options = {}) {
  let h = boot({}, options);
  for (let i = 0; i < 2; i++) { h.caps.crashStart(path); h = boot(h.store, Object.assign({}, options, { now: 100000 + 60000 })); }
  return h;
}

test('failures caused by the network or a server are kept apart and never rule a path out', () => {
  const h = boot();
  h.caps.failed('avplay:hdr', true); h.caps.failed('avplay:hdr', true); h.caps.failed('avplay:hdr', true);
  const p = h.caps.report().paths['avplay:hdr'];
  assert.equal(p.unclear, 3); assert.equal(p.failed, 0); assert.equal(p.streak, undefined);
  assert.equal(h.caps.usable('avplay:hdr'), true);
  h.caps.failed('avplay:hdr'); h.caps.failed('avplay:hdr', true);
  assert.equal(h.caps.usable('avplay:hdr'), true, 'one real failure between unclear ones');
});

test('a path ruled out by failures gets a try after 3 days, then waits twice as long after each try that fails', () => {
  const h = boot();
  h.caps.failed('avplay:hdr'); h.caps.failed('avplay:hdr');
  assert.equal(h.caps.avoided('avplay:hdr'), true);
  h.at(100000 + 3 * DAY - 1); assert.equal(h.caps.usable('avplay:hdr'), false);
  h.at(100000 + 3 * DAY); assert.equal(h.caps.usable('avplay:hdr'), true);
  // The try fails: 6 days now, then 12.
  const t1 = 100000 + 3 * DAY; h.caps.failed('avplay:hdr');
  assert.equal(h.caps.report().paths['avplay:hdr'].retries, 1);
  h.at(t1 + 6 * DAY - 1); assert.equal(h.caps.usable('avplay:hdr'), false);
  h.at(t1 + 6 * DAY); assert.equal(h.caps.usable('avplay:hdr'), true);
  const t2 = t1 + 6 * DAY; h.caps.failed('avplay:hdr');
  h.at(t2 + 12 * DAY - 1); assert.equal(h.caps.usable('avplay:hdr'), false);
  // Never longer than 60 days.
  const r = JSON.parse(h.store['f1tv.caps']); r.paths['avplay:hdr'].retries = 10; h.store['f1tv.caps'] = JSON.stringify(r);
  const later = boot(h.store, { now: t2 + 60 * DAY });
  assert.equal(later.caps.usable('avplay:hdr'), true);
  // A try that plays: the record is clean again, and the next ruling waits 3 days.
  later.caps.ok('avplay:hdr');
  assert.equal(later.caps.report().paths['avplay:hdr'].retries, 0);
  later.caps.failed('avplay:hdr'); later.caps.failed('avplay:hdr');
  later.at(t2 + 63 * DAY); assert.equal(later.caps.usable('avplay:hdr'), true);
});

test('a path ruled out by crashes waits 14 days for its try; older records count from their last outcome', () => {
  const h = crashedTwice('avplay:hdr');
  const at = 100000 + 60000;
  assert.equal(h.caps.report().paths['avplay:hdr'].crashed, 2);
  h.at(at + 14 * DAY - 1); assert.equal(h.caps.usable('avplay:hdr'), false);
  h.at(at + 14 * DAY); assert.equal(h.caps.usable('avplay:hdr'), true);
  const old = { version: 1, firmware: 'TV-1', browser: { cenc: null, cbcs: null }, paths: { 'avplay:cbcs': { ok: 0, failed: 2, crashed: 0, last: 5000 } } };
  assert.equal(boot({ 'f1tv.caps': JSON.stringify(old) }, { now: 5000 + 3 * DAY - 1 }).caps.avoided('avplay:cbcs'), true);
  assert.equal(boot({ 'f1tv.caps': JSON.stringify(old) }, { now: 5000 + 3 * DAY }).caps.avoided('avplay:cbcs'), false);
});

test('three clean runs of 10 minutes wear one crash off; short runs and runs that end in a failure do not', () => {
  const h = crashedTwice('avplay:cbcs');
  let t = 100000 + 60000;
  const run = (minutes, end) => { h.caps.crashStart('avplay:cbcs'); t += minutes * 60000; h.at(t); end(); };
  run(9, () => h.caps.crashEnd());
  run(30, () => h.caps.crashEnd(true));
  assert.equal(h.caps.report().paths['avplay:cbcs'].cleanRuns, undefined);
  run(10, () => h.caps.crashEnd());
  run(12, () => h.events.pagehide({ type: 'pagehide' }));   // an event object is no failure
  assert.equal(h.caps.report().paths['avplay:cbcs'].cleanRuns, 2);
  assert.equal(h.caps.avoided('avplay:cbcs'), true);
  run(20, () => h.caps.crashEnd());
  const p = h.caps.report().paths['avplay:cbcs'];
  assert.equal(p.crashed, 2); assert.equal(p.forgiven, 1); assert.equal(p.cleanRuns, 0);
  assert.equal(h.caps.avoided('avplay:cbcs'), false, 'one crash alone rules nothing out');
  // A clean run without crashes held against the path just counts.
  const fresh = boot(); fresh.caps.crashStart('avplay:hdr'); fresh.at(100000 + 10 * 60000); fresh.caps.crashEnd();
  assert.equal(fresh.caps.report().paths['avplay:hdr'], undefined, 'no record made for a path never counted');
});

test('a new app version forgets failures but keeps crashes; the same version keeps both', () => {
  let h = boot({}, { version: '1.2.0' });
  h.caps.failed('avplay:hdr'); h.caps.failed('avplay:hdr');
  h.caps.crashStart('avplay:cbcs');
  h = boot(h.store, { version: '1.2.0', now: 160000 });
  h.caps.crashStart('avplay:cbcs');
  h = boot(h.store, { version: '1.2.0', now: 220000 });
  assert.equal(h.caps.avoided('avplay:hdr'), true);
  assert.equal(h.caps.avoided('avplay:cbcs'), true);
  const next = boot(h.store, { version: '1.2.1', now: 230000 });
  assert.equal(next.caps.avoided('avplay:hdr'), false);
  assert.equal(next.caps.report().paths['avplay:hdr'].failed, 2, 'the counts stay for the About screen');
  assert.equal(next.caps.avoided('avplay:cbcs'), true);
  assert.equal(next.caps.report().appVersion, '1.2.1');
  // A record from before versions were kept counts as another version: its failures go once.
  const old = { version: 1, firmware: 'TV-1', browser: { cenc: null, cbcs: null }, paths: { 'avplay:hdr': { ok: 0, failed: 2, crashed: 0, last: 100000, streak: 2 } } };
  assert.equal(boot({ 'f1tv.caps': JSON.stringify(old) }, { version: '1.2.0' }).caps.avoided('avplay:hdr'), false);
  // No version known (desktop): nothing forgotten.
  assert.equal(boot({ 'f1tv.caps': JSON.stringify(old) }).caps.avoided('avplay:hdr'), true);
  // Forget keeps the version (it isn't a new one).
  next.caps.reset(); assert.equal(next.caps.report().appVersion, '1.2.1');
});

test('a release that lists a path as fixed forgets its crashes once', () => {
  const fixed = (src) => src.replace('var FIXED = {};', "var FIXED = { 'avplay:cbcs': '1.3.0' };");
  const h = crashedTwice('avplay:cbcs', { version: '1.2.0' });
  assert.equal(h.caps.avoided('avplay:cbcs'), true);
  let next = boot(h.store, { version: '1.3.0', source: fixed, now: 200000 });
  assert.equal(next.caps.avoided('avplay:cbcs'), false);
  assert.equal(next.caps.report().paths['avplay:cbcs'].forgiven, 2);
  // New crashes after the fix count again, and the next start of the same release forgives nothing.
  next.caps.crashStart('avplay:cbcs'); next = boot(next.store, { version: '1.3.0', source: fixed, now: 230000 });
  next.caps.crashStart('avplay:cbcs'); next = boot(next.store, { version: '1.3.0', source: fixed, now: 260000 });
  assert.equal(next.caps.avoided('avplay:cbcs'), true);
  // Neither does a later release that still lists the same fix.
  assert.equal(boot(next.store, { version: '1.3.1', source: fixed, now: 290000 }).caps.avoided('avplay:cbcs'), true);
});

test("a good start keeps a crash's growing wait (the crash comes after it); a clean run without a crash held earns nothing", () => {
  let h = crashedTwice('avplay:hdr');
  let t = 100000 + 60000 + 14 * DAY;
  h.at(t); assert.equal(h.caps.usable('avplay:hdr'), true);
  h.caps.ok('avplay:hdr'); h.caps.crashStart('avplay:hdr');
  h = boot(h.store, { now: t + 30000 });
  assert.equal(h.caps.report().paths['avplay:hdr'].retries, 1);
  t += 30000 + 28 * DAY; h.at(t - 1); assert.equal(h.caps.usable('avplay:hdr'), false);
  h.at(t); h.caps.ok('avplay:hdr'); h.caps.crashStart('avplay:hdr');
  h = boot(h.store, { now: t + 30000 });
  assert.equal(h.caps.report().paths['avplay:hdr'].retries, 2, 'the good start did not reset it');
  h.at(t + 30000 + 56 * DAY - 1); assert.equal(h.caps.usable('avplay:hdr'), false);
  // Clean runs before a crash earn nothing.
  const f = boot(); let now = 100000;
  f.caps.ok('avplay:cbcs');
  for (let i = 0; i < 3; i++) { f.caps.crashStart('avplay:cbcs'); now += 11 * 60000; f.at(now); f.caps.crashEnd(); }
  assert.equal(f.caps.report().paths['avplay:cbcs'].cleanRuns, undefined);
});

test("an older record's wait starts at its last outcome once; a good try or an unclear failure later does not restart it", () => {
  const old = { version: 1, firmware: 'TV-1', browser: { cenc: null, cbcs: null }, paths: { 'avplay:hdr': { ok: 0, failed: 0, crashed: 2, last: 5000 } } };
  const h = boot({ 'f1tv.caps': JSON.stringify(old) }, { now: 5000 + 14 * DAY });
  assert.equal(h.caps.report().paths['avplay:hdr'].badAt, 5000);
  assert.equal(h.caps.usable('avplay:hdr'), true);
  h.caps.failed('avplay:hdr', true);
  h.caps.ok('avplay:hdr');
  assert.equal(h.caps.usable('avplay:hdr'), true);
});
