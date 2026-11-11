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
  vm.runInContext(readFileSync('app/js/caps.js', 'utf8'), context);
  return { caps: context.Caps, store, timers, events, calls, document, at: (time) => { now = time; } };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const settled = () => new Promise(setImmediate);

test('caps persists outcomes per path, last time, firmware and returns a detached report', () => {
  const h = boot();
  h.caps.ok('shaka:cenc'); h.at(123456); h.caps.failed('avplay:cbcs');
  const report = h.caps.report();
  assert.deepEqual(plain(report.paths['shaka:cenc']), { ok: 1, failed: 0, crashed: 0, last: 100000 });
  assert.deepEqual(plain(report.paths['avplay:cbcs']), { ok: 0, failed: 1, crashed: 0, last: 123456 });
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

test('avoidance requires two crashes, a crash plus failure, or repeated failures; successes remain evidence', () => {
  for (const sequence of [['crash', 'crash'], ['crash', 'failed'], ['failed', 'failed']]) {
    let h = boot();
    for (let i = 0; i < sequence.length; i++) {
      if (sequence[i] === 'crash') { h.caps.crashStart('avplay:cbcs'); h = boot(h.store); }
      else h.caps.failed('avplay:cbcs');
      assert.equal(h.caps.usable('avplay:cbcs'), i === 0);
    }
    h.caps.ok('avplay:cbcs');
    assert.equal(h.caps.report().paths['avplay:cbcs'].ok, 1);
    assert.equal(h.caps.usable('avplay:cbcs'), false);
  }
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
  ['missing scheme', () => Promise.resolve({ getConfiguration: () => ({ videoCapabilities: [{ contentType: 'video/mp4' }] }) })],
  ['audio-only grant', () => Promise.resolve({ getConfiguration: () => ({ audioCapabilities: [{ encryptionScheme: 'cenc' }] }) })],
  ['different scheme', (config) => Promise.resolve({ getConfiguration: () => ({ videoCapabilities: [{ encryptionScheme: config.videoCapabilities[0].encryptionScheme === 'cenc' ? 'cbcs' : 'cenc' }] }) })],
  ['refusal', () => Promise.reject(Error('unsupported'))],
  ['synchronous error', () => { throw Error('no EME'); }]
]) test('EME does not accept ' + name, async () => {
  const h = boot({}, { probe }); [...h.timers.values()].find((t) => t.ms === 10000).fn(); await settled();
  assert.equal(h.caps.browser('cenc'), false); assert.equal(h.caps.browser('cbcs'), false);
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
