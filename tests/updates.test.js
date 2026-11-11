const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function checker(fetch, cached, options = {}) {
  const store = Object.assign({ 'f1tv.update': JSON.stringify(cached || {}) }, options.store);
  const timers = new Map();
  const markerRequests = [];
  const context = vm.createContext({
    fetch,
    localStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, value) => { store[key] = value; }
    },
    XMLHttpRequest: class {
      open(method, url, async) { markerRequests.push({ method, url, async }); }
      send() {
        this.status = options.markerStatus === undefined ? 200 : options.markerStatus;
        this.responseText = options.marker === undefined ? '' : options.marker;
        this.onload();
      }
    },
    tizen: { application: { getCurrentApplication: () => ({ appInfo: { version: '0.1.0' } }) } },
    setTimeout: (fn) => { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    ...(options.Date ? { Date: options.Date } : {})   // a clock the test moves
  });
  vm.runInContext(readFileSync('app/js/updates.js', 'utf8'), context);
  return { updates: context.Updates, timers, store, markerRequests };
}

const release = (tag) => ({ ok: true, json: async () => [{ tag_name: tag }] });

test('manual checks find a new release even when the daily cache is fresh', async () => {
  const { updates, timers } = checker(async () => release('v0.2.0'), { at: Date.now(), latest: 'v0.1.0' });
  const result = await updates.check(true);
  assert.equal(result.latest, '0.2.0');
  assert.equal(result.available, true);
  assert.equal(updates.status().latest, '0.2.0');
  assert.equal(timers.size, 0);
});

test('automatic checks still reuse a fresh daily cache', async () => {
  const { updates } = checker(async () => { throw new Error('should use cache'); }, { at: Date.now(), latest: 'v0.2.0' });
  const result = await updates.check();
  assert.equal(result.latest, '0.2.0');
  assert.equal(result.available, true);
  assert.equal(result.error, undefined);
});

test('manual checks report network failure while preserving the last known release', async () => {
  const { updates, timers } = checker(async () => { throw new Error('offline'); }, { at: Date.now(), latest: 'v0.2.0' });
  const result = await updates.check(true);
  assert.equal(result.error, true);
  assert.equal(result.latest, '0.2.0');
  assert.equal(updates.status().latest, '0.2.0');
  assert.equal(timers.size, 0);
});

test('manual checks can retry immediately after HTTP failure', async () => {
  let attempts = 0;
  const { updates } = checker(async () => ++attempts === 1 ? { ok: false, status: 403 } : release('v0.2.0'));
  assert.equal((await updates.check(true)).error, true);
  assert.equal((await updates.check(true)).available, true);
});

test('a missing release tag is a failed check and does not clear the cache', async () => {
  const { updates } = checker(async () => release(undefined), { latest: 'v0.2.0' });
  const result = await updates.check(true);
  assert.equal(result.error, true);
  assert.equal(result.latest, '0.2.0');
});

test('a stalled request times out and allows a retry', async () => {
  let attempts = 0;
  const { updates, timers } = checker(() => ++attempts === 1 ? new Promise(() => {}) : Promise.resolve(release('v0.2.0')));
  const pending = updates.check(true);
  for (const timeout of timers.values()) timeout();
  assert.equal((await pending).error, true);
  assert.equal((await updates.check(true)).available, true);
  assert.equal(timers.size, 0);
});

test('overlapping automatic and manual checks share the pending request', async () => {
  let finish;
  const { updates } = checker(() => new Promise((resolve) => { finish = resolve; }));
  const automatic = updates.check();
  const manual = updates.check(true);
  assert.equal(automatic, manual);
  finish(release('v0.2.0'));
  assert.equal((await manual).available, true);
});

test('an equal or older release does not offer an update', async () => {
  for (const version of ['v0.1.0', 'v0.0.9']) {
    const { updates } = checker(async () => release(version));
    assert.equal((await updates.check(true)).available, false);
  }
});

test('a failed automatic check (the network not up yet) is tried again an hour later, not a day', async () => {
  let online = false, now = Date.parse('2026-10-29T08:00:00Z');
  let stored = '{}';
  const context = vm.createContext({
    fetch: async () => { if (!online) throw new Error('offline'); return release('v0.3.0'); },
    localStorage: { getItem: () => stored, setItem: (k, v) => { stored = v; } },
    tizen: { application: { getCurrentApplication: () => ({ appInfo: { version: '0.1.0' } }) } },
    setTimeout: () => ({}), clearTimeout: () => {},
    Date: class extends Date { static now() { return now; } }
  });
  vm.runInContext(readFileSync('app/js/updates.js', 'utf8'), context);
  assert.equal((await context.Updates.check()).error, true);
  online = true;
  now += 30 * 60000;
  assert.equal((await context.Updates.check()).latest, '');      // not yet
  now += 31 * 60000;
  assert.equal((await context.Updates.check()).latest, '0.3.0');
});

test('the update notice shows once a day, again the next day, for the same waiting version', () => {
  let now = Date.parse('2026-11-11T09:00:00');
  const Clock = class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
  const { updates } = checker(async () => { throw new Error('unused'); }, { at: now, latest: 'v0.2.0' }, { Date: Clock });
  assert.equal(updates.noticeToday(), true, 'first time today');
  now += 6 * 3600000;
  assert.equal(updates.noticeToday(), false, 'later the same day');
  now += 24 * 3600000;
  assert.equal(updates.noticeToday(), true, 'the next day');
});

test('a matching marker remembers the installer after the TV temp file disappears', () => {
  const { updates, store, markerRequests } = checker(null, null, {
    marker: JSON.stringify({ installedBy: 'installer', version: '0.1.0' })
  });
  assert.equal(updates.installedBy(), 'installer');
  assert.deepEqual(JSON.parse(store['f1tv.install']), { by: 'installer', version: '0.1.0' });
  assert.deepEqual(markerRequests, [{ method: 'GET', url: 'file:///home/owner/share/tmp/sdk_tools/tmp/f1tv-installed.json', async: true }]);
  assert.equal(checker(null, null, { store, markerStatus: 404 }).updates.installedBy(), 'installer');
});

test('a different marker or remembered version defaults to Apps2Samsung', () => {
  for (const marker of [JSON.stringify({ installedBy: 'installer', version: '0.2.0' }),
    JSON.stringify({ installedBy: 'apps2samsung', version: '0.1.0' })]) {
    const { updates, store } = checker(null, null, { marker,
      store: { 'f1tv.install': JSON.stringify({ by: 'installer', version: '0.0.9' }) } });
    assert.equal(updates.installedBy(), 'apps2samsung');
    assert.equal(JSON.parse(store['f1tv.install']).version, '0.0.9');
  }
});

test('malformed, missing and failed marker reads are normal, including malformed remembered data', () => {
  for (const options of [{ marker: '{bad' }, { marker: 'null' }, {},
    { markerStatus: 403, marker: '{"installedBy":"installer","version":"0.1.0"}' }]) {
    const { updates } = checker(null, null, Object.assign({ store: { 'f1tv.install': '{bad' } }, options));
    assert.equal(updates.installedBy(), 'apps2samsung');
  }
});

test('release notes share the daily cache, sort numerically and include installed and old releases', async () => {
  const requests = [];
  const { updates, store } = checker(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => [
      { tag_name: 'v0.2.0', body: '## Improvements\n- **Faster** [playback](https://example.test)\n- `Fixed` audio' },
      { tag_name: 'v0.0.9', body: 'Old' }, { tag_name: 'v0.1.0', body: 'Current' },
      { tag_name: 'v0.10.0', body: 'New'.repeat(1600) },
      { tag_name: 'v0.11.0', prerelease: true, body: 'Preview' }, { tag_name: 'v0.12.0', draft: true },
      { tag_name: 'invalid' }
    ] };
  });
  const result = await updates.check();
  assert.equal(result.latest, '0.10.0');
  assert.deepEqual(Array.from(result.releases, (r) => r.version), ['0.10.0', '0.2.0', '0.1.0', '0.0.9']);
  assert.equal(result.releases[1].notes, 'Improvements\n• Faster playback\n• Fixed audio');
  assert.equal(result.releases[0].notes.length, 4000);
  assert.ok(result.releases[0].notes.endsWith('…'));
  await updates.check();
  assert.deepEqual(requests, ['https://api.github.com/repos/nicbra/f1tv-tizen/releases?per_page=100&page=1']);
  const restarted = checker(() => { throw new Error('must use cached notes'); }, null, { store });
  assert.deepEqual(JSON.parse(JSON.stringify((await restarted.updates.check()).releases)), JSON.parse(JSON.stringify(result.releases)));
});

test('release lists follow pagination so newer notes beyond the first page are included', async () => {
  const requests = [];
  const { updates } = checker(async (url) => {
    requests.push(url);
    const list = requests.length === 1 ? Array.from({ length: 100 }, () => ({ tag_name: 'v0.3.0' })) : [{ tag_name: 'v0.2.0', body: 'Also new' }];
    return { ok: true, json: async () => list };
  });
  const result = await updates.check();
  assert.equal(requests.length, 2);
  assert.match(requests[1], /page=2$/);
  assert.ok(result.releases.some((r) => r.version === '0.2.0' && r.notes === 'Also new'));
});

test('release notes preserve paragraphs and normalize Markdown bullets without markup', async () => {
  const { updates } = checker(async () => ({ ok: true, json: async () => [{ tag_name: 'v0.2.0',
    body: '# Changes\r\n\r\nA **better** [player](https://example.test).\r\n\r\n- `Audio` fix\n* _Picture_ fix\n+ ~~Timing~~ fix\n1. Navigation fix\n\n> More details\n\n---\n\n```js\nplain code\n```\n![Preview](https://example.test/image) <b>Done</b>'
  }] }));
  const result = await updates.check(true);
  assert.equal(result.releases[0].notes, 'Changes\n\nA better player.\n\n• Audio fix\n• Picture fix\n• Timing fix\n• Navigation fix\n\nMore details\n\nplain code\n\nPreview Done');
});

test('installed and older release notes remain available when there is no update', async () => {
  const { updates, store } = checker(async () => ({ ok: true, json: async () => [
    { tag_name: 'v0.0.9', body: 'Older' }, { tag_name: 'v0.1.0', body: 'Installed' }
  ] }));
  const result = await updates.check(true);
  assert.equal(result.available, false);
  assert.deepEqual(Array.from(result.releases, (r) => r.version), ['0.1.0', '0.0.9']);
  const restarted = checker(null, null, { store });
  assert.deepEqual(Array.from(restarted.updates.status().releases, (r) => r.notes), ['Installed', 'Older']);
});
