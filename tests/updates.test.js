const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function checker(fetch, cached) {
  let stored = JSON.stringify(cached || {});
  const timers = new Map();
  const context = vm.createContext({
    fetch,
    localStorage: {
      getItem: () => stored,
      setItem: (key, value) => { stored = value; }
    },
    tizen: { application: { getCurrentApplication: () => ({ appInfo: { version: '0.1.0' } }) } },
    setTimeout: (fn) => { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(readFileSync('app/js/updates.js', 'utf8'), context);
  return { updates: context.Updates, timers };
}

const release = (tag) => ({ ok: true, json: async () => ({ tag_name: tag }) });

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
