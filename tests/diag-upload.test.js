const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');

const SRC = readFileSync('app/js/diag-upload.js', 'utf8');
const BASE = 'https://diag.example/diag/v1';
const NOW = Date.UTC(2026, 10, 18, 20);

/**
 * diag-upload.js in a fresh page. `answer(method, url, body, headers)` returns { status, body, retryAfter } or throws
 * (unreachable). Timers run only when the test says (run()); `store` is localStorage, shared between "runs".
 */
// The TV's own device ID (Samsung's DUID) and the unit the app derives from it.
const DUID = 'OTDTZMVKX4HAW';
const unitOf = (duid) => crypto.createHash('sha256').update('f1tv-tizen unit v1:' + duid).digest('hex').slice(0, 32);
function load({ store = {}, settings = { diagnostics: 'off' }, answer, launcher, caps, now = NOW, f1, refuse, build = { record: false, server: BASE }, duid = DUID } = {}) {
  const sent = [], uses = [], timers = [], win = {};
  const clock = { now };
  const context = vm.createContext({
    DIAG_BUILD: build,
    window: { addEventListener: (t, fn) => { win[t] = fn; }, crypto: { getRandomValues: (a) => crypto.randomFillSync(a) },
      get localStorage() { return context.localStorage; } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { if (refuse && refuse.test(k)) throw new Error('QuotaExceededError'); store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    Settings: { get: (k) => settings[k], set: (k, v) => { settings[k] = v; } },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock.now + (ms || 0) }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    Date: class extends Date { static now() { return clock.now; } constructor(...a) { super(...(a.length ? a : [clock.now])); } },
    Math, JSON, Promise, Uint8Array, unescape, encodeURIComponent,
    fetch: (url, init) => {
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      // The anonymous app-use count (POST /starts) goes to a list of its own: `sent` is the diagnostics traffic.
      if (/\/starts$/.test(url)) {
        uses.push({ url, body, headers: init.headers });
        return Promise.resolve({ status: 200, headers: { get: () => null }, text: async () => '{"status":"counted"}' });
      }
      sent.push({ method: init.method, url, body, headers: init.headers });
      return Promise.resolve().then(() => {
        const r = (answer || (() => { throw new TypeError('Failed to fetch'); }))(init.method, url, body, init.headers);
        return { status: r.status, headers: { get: (h) => (h === 'Retry-After' && r.retryAfter ? String(r.retryAfter) : null) },
          text: async () => (r.body ? JSON.stringify(r.body) : '') };
      });
    },
    ...(launcher ? { Launcher: launcher } : {}),
    ...(caps ? { Caps: caps } : {}),
    ...(f1 ? { F1Api: f1 } : {}),
    webapis: { productinfo: { getRealModel: () => 'QE55Q77AATXXC', getFirmware: () => 'T-NKM2DEUC-2310.0',
      getDuid: () => { if (duid == null) throw new Error('no DUID'); return duid; } } },
    tizen: { systeminfo: { getCapability: () => '6.0' }, application: { getCurrentApplication: () => ({ appInfo: { version: '1.4.0' } }) } }
  });
  vm.runInContext(SRC, context, { filename: 'diag-upload.js' });
  const U = context.DiagUpload;
  /** Runs timers due within `ms` from now (in time order), then lets promises settle. */
  async function run(ms = 0) {
    const until = clock.now + ms;
    for (;;) {
      const due = timers.filter((t) => t.fn && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = Math.max(clock.now, due.at);
      const fn = due.fn; due.fn = null; fn();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
    clock.now = until;
  }
  const queue = () => JSON.parse(store['f1tv.diag.queue'] || '[]');
  return { U, store, settings, sent, uses, run, clock, queue, win };
}

/** The server's acknowledgement: counts that add up to the batch (a DELETE gets its own). */
const ok = (method, url, body) => (method === 'DELETE' ? { status: 200, body: { status: 'deleted' } }
  : { status: 200, body: { stored: body && (body.events || body.crashes) ? (body.events || body.crashes).length : 0, duplicates: 0, dropped: 0 } });

test('off by default: nothing is queued, stored or sent, and no secret exists', async () => {
  const t = load();
  assert.equal(t.U.enabled(), false);
  assert.equal(t.U.event('app.started', { outcome: 'ok' }), null);
  t.U.apiFailed('playback_offer', 500, 1);
  t.U.started('ok', 1000);
  await t.run(3600000);
  assert.deepEqual(t.sent, []);
  assert.deepEqual(Object.keys(t.store), []);
  assert.equal(t.U.id(), null);
});

test('saying yes makes a secret and sends events in the contract\'s envelope, with the build pair', async () => {
  const launcher = { version: '1.4.0', archiveSha512: 'a'.repeat(128) };
  const t = load({ answer: ok, launcher });
  t.U.setEnabled(true);
  assert.match(t.store['f1tv.diag.secret'], /^"[0-9a-f]{64}"$/);
  t.U.event('app.started', { outcome: 'ok', time_to_home_ms: 2300 }, 'info');
  await t.run(60000);
  assert.equal(t.sent.length, 1);
  const { url, body, headers, method } = t.sent[0];
  assert.equal(method, 'POST');
  assert.equal(url, BASE + '/events');
  assert.equal(headers.Authorization, 'Bearer ' + JSON.parse(t.store['f1tv.diag.secret']));
  assert.equal(headers['X-Diag-Release'], '1.4.0');
  assert.equal(headers['X-Diag-Bundle'], 'a'.repeat(128));
  assert.equal(body.schema_version, 1);
  assert.match(body.batch_id, /^[0-9a-f-]{36}$/);
  assert.match(body.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(body.mode, 'basic');
  assert.deepEqual(body.app, { version: '1.4.0', build: 'package-1.4.0', install_source: 'unknown' });
  assert.deepEqual(body.device, { model: 'QE55Q77AATXXC', firmware: 'T-NKM2DEUC-2310.0', tizen_version: '6.0' });
  assert.deepEqual(body.events.map((x) => x.name), ['account.status', 'app.started'], 'saying yes also tells the account state');
  const e = body.events[1];
  assert.deepEqual(Object.keys(e).sort(), ['event_id', 'event_version', 'fields', 'level', 'name', 'sequence']);
  assert.deepEqual(e.fields, { outcome: 'ok', time_to_home_ms: 2300 });
  assert.deepEqual(t.queue(), []);
  assert.equal(t.store['f1tv.diag.batch'], undefined);
});

test('without the launcher\'s build pair, neither header is sent', async () => {
  const t = load({ answer: ok, launcher: { version: '1.4.0' } });
  t.U.setEnabled(true);
  t.U.event('app.started', { outcome: 'ok' });
  await t.run(60000);
  assert.equal(t.sent[0].headers['X-Diag-Release'], undefined);
  assert.equal(t.sent[0].headers['X-Diag-Bundle'], undefined);
});

test('an unreachable server is quiet: the batch waits (same id) and retries back off up to 15 minutes', async () => {
  const t = load();   // every request fails like a network error
  t.U.setEnabled(true);
  t.U.event('app.started', { outcome: 'ok' });
  await t.run(10 * 3600000);
  const first = t.sent[0].body.batch_id;
  // 1, 2, 4, 8 minutes, then every 15 (each ±20 %): about 40 tries in 10 hours, never a tight loop.
  assert.ok(t.sent.length >= 30 && t.sent.length <= 55, String(t.sent.length));
  assert.ok(t.sent.every((s) => s.body.batch_id === first), 'one batch, retried as it was');
  assert.equal(t.U.status().pending, true);
});

test('a 400 drops the batch, a 401 stops until the viewer says yes again, Retry-After is honoured', async () => {
  let status = 400;
  const t = load({ answer: () => ({ status, retryAfter: status === 429 ? 3600 : 0 }) });
  t.U.setEnabled(true);
  t.U.event('app.started', { outcome: 'ok' });
  await t.run(60000);
  assert.equal(t.U.status().pending, false);
  status = 429;
  t.U.event('account.status', { signed_in: true, tier: 'pro' });
  await t.run(90000);
  const n = t.sent.length;
  await t.run(3000000);
  assert.equal(t.sent.length, n, 'nothing before the hour is over');
  status = 401;
  await t.run(3600000);
  assert.equal(t.U.status().stopped, 401);
  t.U.event('caps.snapshot', { browser: { cenc: true, cbcs: false }, usable: {} });
  const m = t.sent.length;
  await t.run(3600000);
  assert.equal(t.sent.length, m);
  t.U.setEnabled(true);
  assert.equal(t.U.status().stopped, null);
});

test('a 413 splits the batch and keeps the event ids', async () => {
  let first = true;
  const t = load({ answer: (m, u, body) => { if (first) { first = false; return { status: 413 }; } return ok(m, u, body); } });
  t.U.setEnabled(true);
  for (let i = 0; i < 4; i++) t.U.event('api.request_failed', { operation: 'menu', retry_count: 0 }, 'info');
  await t.run(60000);
  await t.run(120000);
  const ids = t.sent.map((s) => s.body.events.map((e) => e.event_id));
  assert.equal(ids[0].length, 5);   // account.status and the four
  assert.deepEqual(ids.slice(1).flat().sort(), ids[0].slice().sort());
});

test('the queue keeps at most 250 events and reports what it dropped; events expire after 24 h', async () => {
  const t = load({ answer: ok });
  t.U.setEnabled(true);
  for (let i = 0; i < 260; i++) t.U.event('api.request_failed', { operation: 'menu', retry_count: 0 }, 'info');
  assert.equal(t.U.status().queued, 250);
  await t.run(1500);
  assert.equal(t.queue().length, 250, 'written together a moment later');
  t.clock.now += 25 * 3600000;
  t.U.event('app.started', { outcome: 'ok' });
  await t.run(60000);
  const names = t.sent.flatMap((s) => s.body.events.map((e) => e.name + (e.fields.reason ? ':' + e.fields.reason + ':' + e.fields.count : '')));
  assert.ok(names.includes('diagnostics.dropped:queue_full:11'), names.join(' '));   // 260 + account.status
  assert.ok(names.includes('diagnostics.dropped:expired:250'), names.join(' '));
});

test('turning it off clears the queue but keeps the secret; deleting moves it aside until the server confirms', async () => {
  let up = false;
  const t = load({ answer: (m, u, b) => { if (!up) throw new TypeError('offline'); return ok(m, u, b); } });
  t.U.setEnabled(true);
  const secret = t.store['f1tv.diag.secret'];
  t.U.event('app.started', { outcome: 'ok' });
  t.U.setEnabled(false);
  assert.deepEqual(t.queue(), []);
  assert.equal(t.store['f1tv.diag.secret'], secret);
  assert.equal(t.U.hasData(), true);
  assert.equal(await t.U.deleteMyData(), 'pending');
  assert.equal(t.U.deletionPending(), true);
  assert.equal(t.store['f1tv.diag.secret'], undefined);
  assert.deepEqual(JSON.parse(t.store['f1tv.diag.deleting']), [JSON.parse(secret)]);
  // Saying yes again meanwhile, and deleting that too while offline: both wait for the server.
  t.U.setEnabled(true);
  const second = t.store['f1tv.diag.secret'];
  assert.notEqual(second, secret);
  assert.equal(await t.U.deleteMyData(), 'pending');
  assert.deepEqual(JSON.parse(t.store['f1tv.diag.deleting']), [JSON.parse(secret), JSON.parse(second)]);
  t.U.setEnabled(true);
  up = true;
  // A 200 that isn't the server's confirmation (a proxy's page) deletes nothing here.
  const proxy = load({ store: t.store, settings: t.settings, answer: (m, u, b) => (m === 'DELETE' ? { status: 200 } : ok(m, u, b)) });
  await proxy.run(60000);
  assert.equal(proxy.U.deletionPending(), true);
  const again = load({ store: t.store, settings: t.settings, answer: ok });
  await again.run(60000);
  const del = again.sent.filter((x) => x.method === 'DELETE');
  assert.equal(del[0].url, BASE + '/installations/self');
  assert.deepEqual(del.map((x) => x.headers.Authorization).sort(), ['Bearer ' + JSON.parse(secret), 'Bearer ' + JSON.parse(second)].sort());
  assert.equal(again.U.deletionPending(), false);
  assert.equal(again.U.enabled(), true, 'the retry at start doesn\'t turn diagnostics off');
});

test('a refused secret (403) stops collecting, sending and reports; saying yes again uses a new one and deletes the old', async () => {
  let status = 403;
  const t = load({ answer: (m, u, b) => (status === 200 ? ok(m, u, b) : { status }) });
  t.U.setEnabled(true);
  const first = t.store['f1tv.diag.secret'];
  await t.run(60000);
  assert.equal(t.U.stopped(), true);
  assert.equal(t.U.enabled(), false);
  assert.equal(t.U.event('app.started', { outcome: 'ok' }), null, 'nothing is collected');
  await assert.rejects(t.U.report('other'), /stopped/);
  assert.equal(t.store['f1tv.diag.secret'], first, 'kept, so its data can still be deleted');
  const n = t.sent.length;
  await t.run(3600000);
  assert.equal(t.sent.length, n);
  t.U.setEnabled(true);
  assert.equal(t.U.stopped(), false);
  assert.ok(t.store['f1tv.diag.secret'] && t.store['f1tv.diag.secret'] !== first);
  assert.deepEqual(JSON.parse(t.store['f1tv.diag.deleting']), [JSON.parse(first)]);
  status = 200;
  await t.run(120000);
  const posts = t.sent.filter((x) => x.method === 'POST');
  assert.equal(posts.at(-1).headers.Authorization, 'Bearer ' + JSON.parse(t.store['f1tv.diag.secret']));
  assert.ok(t.sent.some((x) => x.method === 'DELETE' && x.headers.Authorization === 'Bearer ' + JSON.parse(first)));
  assert.equal(t.U.deletionPending(), false);
});

test('a new consent epoch is a new session; a secret that can\'t be stored is never sent', async () => {
  const t = load({ answer: ok });
  t.U.setEnabled(true);
  t.U.event('app.started', { outcome: 'ok' });
  await t.run(60000);
  const s1 = t.sent[0].body.session_id;
  t.U.setEnabled(false);
  t.U.setEnabled(true);
  t.U.event('app.started', { outcome: 'ok' });
  await t.run(60000);
  const last = t.sent.at(-1).body;
  assert.notEqual(last.session_id, s1);
  assert.equal(last.events[0].sequence, 0);
  // Storage refuses the secret: nothing goes out (so nothing is left on the server that couldn't be deleted).
  const full = load({ answer: ok, refuse: /secret/ });
  full.U.setEnabled(true);
  full.U.event('app.started', { outcome: 'ok' });
  await full.run(600000);
  assert.deepEqual(full.sent, []);
  assert.equal(full.U.id(), null);
});

test('an answer that arrives after the viewer turned it off stores nothing again', async () => {
  let answer;
  const t = load({ answer: () => answer });
  t.U.setEnabled(true);
  for (let i = 0; i < 4; i++) t.U.event('api.request_failed', { operation: 'menu', retry_count: 0 }, 'info');
  answer = { status: 413 };
  const flushing = t.run(60000);
  t.U.setEnabled(false);
  await flushing;
  assert.deepEqual(t.queue(), []);
  assert.equal(t.store['f1tv.diag.batch'], undefined);
});

test('a batch keeps the labels of when its events happened, not of a later update', async () => {
  const launcher = { version: '1.4.0', archiveSha512: 'a'.repeat(128) };
  const t = load({ launcher });
  t.U.setEnabled(true);
  t.U.event('js.error', { error_category: 'type_error', source_file: 'app.js' }, 'error');
  await t.run(1500);   // the queue is written a moment after
  const store = t.store;
  launcher.version = '1.5.0';
  launcher.archiveSha512 = 'c'.repeat(128);
  const next = load({ store, settings: t.settings, launcher, answer: ok });
  next.U.event('app.started', { outcome: 'ok' });
  await next.run(300000);
  const versions = next.sent.map((x) => [x.body.app.version, x.headers['X-Diag-Release'], x.body.events.map((e) => e.name).join(',')]);
  assert.deepEqual(versions, [['1.4.0', '1.4.0', 'account.status,js.error'], ['1.5.0', '1.5.0', 'app.started']]);
});

test('a warning doesn\'t hurry an upload while backing off', async () => {
  const t = load();   // unreachable
  t.U.setEnabled(true);
  await t.run(60000);
  const n = t.sent.length;
  for (let i = 0; i < 5; i++) { t.U.event('player.error', {}, 'error'); await t.run(10000); }
  assert.ok(t.sent.length <= n + 1, t.sent.length + ' requests');
});

test('the TV\'s unit is a hash of its device ID, the same after a deletion and a new yes; the shown ID is its start', async () => {
  const t = load({ answer: ok });
  assert.equal(t.U.id(), null, 'no ID before the yes');
  t.U.setEnabled(true);
  assert.equal(t.U.unit(), unitOf(DUID));
  assert.notEqual(t.U.unit(), DUID);
  assert.equal(t.U.id(), unitOf(DUID).slice(0, 12));
  t.U.event('app.started', { outcome: 'ok' });
  await t.run(70000);
  assert.ok(t.sent.length >= 1);
  assert.ok(t.sent.every((s) => s.body.unit === unitOf(DUID)), 'every batch carries the unit');
  const firstSecret = t.store['f1tv.diag.secret'];
  assert.equal(await t.U.deleteMyData(), 'deleted');
  t.U.setEnabled(true);
  assert.notEqual(t.store['f1tv.diag.secret'], firstSecret, 'a new secret');
  assert.equal(t.U.id(), unitOf(DUID).slice(0, 12), 'the same TV');
});

test('without a device ID the unit is random, kept in storage (also across a deletion)', async () => {
  const store = {};
  const t = load({ answer: ok, duid: null, store });
  t.U.setEnabled(true);
  const u = t.U.unit();
  assert.match(u, /^[0-9a-f]{32}$/);
  await t.U.deleteMyData();
  assert.equal(load({ duid: null, store }).U.unit(), u);
});

test('tier comes from F1\'s entitlement words; anything else is other or unknown', () => {
  const { U } = load();
  assert.equal(U.tier('PRO'), 'pro');
  assert.equal(U.tier('F1_TV_Pro_Annual'), 'pro');
  assert.equal(U.tier('PREMIUM'), 'premium');
  assert.equal(U.tier('Access'), 'access');
  assert.equal(U.tier('PRO_PREMIUM'), 'other');
  assert.equal(U.tier('TV'), 'other');
  assert.equal(U.tier(''), 'unknown');
  assert.equal(U.tier(null), 'unknown');
});

test('failed requests: a label and a status, the same one at most three times a session', async () => {
  const t = load({ answer: ok });
  t.U.setEnabled(true);
  for (let i = 0; i < 5; i++) t.U.apiFailed('save_position', 503, 0);
  t.U.apiFailed('https://f1tv.formula1.com/x', null, 2);
  await t.run(60000);
  const rows = t.sent.flatMap((s) => s.body.events).filter((e) => e.name === 'api.request_failed').map((e) => e.fields);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { operation: 'save_position', retry_count: 0, http_status: 503 });
  assert.deepEqual(rows[3], { operation: 'other', retry_count: 2 });
});

test('script errors: category, file and line only, once each', async () => {
  const t = load({ answer: ok });
  t.U.setEnabled(true);
  const err = { message: 'Cannot read property x of undefined', filename: 'http://127.0.0.1:18765/bundle/1.4.0/js/player.js?v=1', lineno: 120, error: new TypeError('x') };
  t.win.error(err);
  t.win.error(err);
  t.win.error({ message: 'boom', filename: 'file:///opt/x/evil.js', lineno: 0, error: null });
  t.win.unhandledrejection({ reason: { secret: 'secret-xyz' } });   // not hex: random ids can't contain it
  await t.run(300000);
  const rows = t.sent.flatMap((s) => s.body.events).filter((e) => e.name === 'js.error').map((e) => e.fields);
  assert.deepEqual(rows, [{ error_category: 'type_error', source_file: 'player.js', line: 120 },
    { error_category: 'uncaught_error', source_file: 'other' }, { error_category: 'unhandled_rejection', source_file: 'unknown' }]);
  assert.doesNotMatch(JSON.stringify(t.sent), /Cannot read|boom|secret-xyz|127\.0\.0\.1/);
});

test('start-up, the suspected crash, account and caps: once, and caps only when it changes', async () => {
  let browser = { cenc: true, cbcs: false };
  const caps = { report: () => ({ browser }), usable: (p) => p !== 'avplay:hdr', previousRun: () => ({ path: 'avplay:cbcs', minutes: 3 }) };
  const f1 = { state: { ascendon: 'TOKEN', locationFor: 'TOKEN', location: { entitlement: 'PREMIUM' } } };
  // The viewer said yes before the run that ended: its marker is theirs to send.
  const t = load({ answer: ok, caps, f1, now: NOW - 600000 });
  t.U.setEnabled(true);
  t.clock.now = NOW;
  t.U.started('ok', 4200);
  t.U.started('ok', 9999);
  t.U.account();
  await t.run(3000);
  t.U.caps();
  await t.run(3000);
  browser = { cenc: true, cbcs: true };
  t.U.caps();
  await t.run(300000);
  const rows = t.sent.flatMap((s) => s.body.events).map((e) => [e.name, e.fields]);
  assert.deepEqual(rows, [
    ['account.status', { signed_in: true, tier: 'premium' }],
    ['app.started', { outcome: 'ok', time_to_home_ms: 4200 }],
    ['app.abnormal_end_suspected', { path: 'avplay:cbcs', minutes_since_marker: 3 }],
    ['caps.snapshot', { browser: { cenc: true, cbcs: false }, usable: { 'shaka:cenc': true, 'avplay:cbcs': true, 'avplay:cenc': true, 'avplay:hdr': false } }],
    ['caps.snapshot', { browser: { cenc: true, cbcs: true }, usable: { 'shaka:cenc': true, 'avplay:cbcs': true, 'avplay:cenc': true, 'avplay:hdr': false } }]
  ]);
  assert.doesNotMatch(JSON.stringify(t.sent), /TOKEN/);
});

test('failed launcher starts: only those since the viewer said yes, with a mapped reason', async () => {
  const t = load({ answer: ok });
  t.U.setEnabled(true);
  t.U.launcherFailed({ id: 1, at: NOW - 60000, version: '1.3.0', reason: 'page: start timeout' });   // before the yes: not sent
  t.U.launcherFailed({ id: 2, at: NOW + 1, version: '1.4.0', reason: 'page: script error' });
  t.U.launcherFailed({ id: 3, at: NOW + 2, version: '1.4.0', reason: 'service: crashed at /x/y' });
  await t.run(60000);
  const rows = t.sent.filter((s) => /events$/.test(s.url)).flatMap((s) => s.body.events)
    .filter((e) => e.name === 'launcher.failed_start').map((e) => e.fields);
  assert.deepEqual(rows, [{ version: '1.4.0', reason: 'script_error' }, { version: '1.4.0', reason: 'service_error' }]);
  assert.ok(!t.sent.some((s) => /crashes$/.test(s.url)), 'no anonymous crash reports');
});

test('with diagnostics off nothing goes out, crashes included; crash reports waiting from an older version are forgotten', async () => {
  const caps = { report: () => ({}), usable: () => true, previousRun: () => ({ path: 'avplay:hdr', minutes: 2 }) };
  const store = { 'f1tv.diag.crashes': JSON.stringify({ items: [{ id: 'x', name: 'js.error', fields: {}, count: 1, at: NOW, dims: {} }] }) };
  const t = load({ answer: ok, caps, store });
  assert.equal(store['f1tv.diag.crashes'], undefined, 'forgotten, never sent');
  t.win.error({ message: 'x', filename: 'file:///a/js/app.js', lineno: 3, error: new TypeError('x') });
  t.win.unhandledrejection({});
  t.U.started('ok', 1000);
  t.U.launcherFailed({ id: 1, at: NOW, version: '1.4.0', reason: 'page: script error' });
  await t.run(3 * 3600000);
  assert.deepEqual(t.sent, []);
});

test('with diagnostics on, script errors are events (once each), not crash reports', async () => {
  const t = load({ answer: ok });
  t.U.setEnabled(true);
  t.win.error({ message: 'x', filename: 'file:///a/js/app.js', lineno: 3, error: new TypeError('x') });
  t.win.error({ message: 'x', filename: 'file:///a/js/app.js', lineno: 3, error: new TypeError('x') });
  await t.run(120000);
  assert.ok(t.sent.every((s) => /events$/.test(s.url)));
  assert.equal(t.sent.flatMap((s) => s.body.events).filter((e) => e.name === 'js.error').length, 1);
});

test('the suspected crash (the heartbeat from the last run) goes as an event under the TV\'s ID, only with diagnostics on', async () => {
  const caps = { report: () => ({}), usable: () => true, previousRun: () => ({ path: 'avplay:hdr', minutes: 2 }) };
  const t = load({ answer: ok, caps, now: NOW - 600000 });
  t.U.setEnabled(true);
  t.clock.now = NOW;
  t.U.started('ok', 1000);
  t.U.started('ok', 1000);
  await t.run(70000);
  const rows = t.sent.flatMap((s) => s.body.events || []).filter((e) => e.name === 'app.abnormal_end_suspected');
  assert.deepEqual(rows.map((e) => e.fields), [{ path: 'avplay:hdr', minutes_since_marker: 2 }]);
  assert.ok(t.sent.every((s) => s.body.unit === unitOf(DUID) && s.headers.Authorization));
});

test('a problem report: category, mapped settings, caps and this session\'s events; the reference comes back', async () => {
  const caps = { report: () => ({ browser: { cenc: true, cbcs: false } }), usable: () => true };
  const t = load({ caps, settings: { diagnostics: 'off', hdr: true, multiview: 'side2', timing: false, audio: 'eng', subtitles: 'fra', updates: 'automatic' },
    answer: (m, u, b) => (/reports$/.test(u) ? { status: 200, body: { reference: 'R-7KQ2-M9XD' } } : ok(m, u, b)) });
  t.U.setEnabled(true);
  t.U.event('app.started', { outcome: 'ok' });
  assert.equal(await t.U.report('buffering'), 'R-7KQ2-M9XD');
  const r = t.sent.find((s) => /reports$/.test(s.url)).body;
  assert.deepEqual(Object.keys(r).sort(), ['app', 'data', 'device', 'report_id', 'schema_version', 'unit']);
  assert.equal(r.unit, unitOf(DUID));
  assert.equal(r.data.description_category, 'buffering');
  assert.deepEqual(r.data.settings, { hdr: true, multiview_layout: 'side2', timing: false, spoiler_free: false, audio: 'eng', subtitles: true, update_checks: true });
  assert.deepEqual(r.data.breadcrumbs.map((e) => e.name), ['account.status', 'app.started']);
});

test('the server comes from the build: any build with a valid URL; without one nothing is sent or offered', async () => {
  for (const [build, want] of [[{ record: true, label: 'tv-dev', server: 'http://10.0.0.49:8787/diag/v1' }, 'http://10.0.0.49:8787/diag/v1/events'],
    [{ record: false, server: BASE }, BASE + '/events'],
    [{ record: true, label: 'tv-dev', server: 'javascript:alert(1)' }, undefined],
    [{ record: false, server: BASE + '/' }, undefined],
    [{ record: false }, undefined]]) {
    const sent = [], settings = { diagnostics: 'off' }, mem = {};
    const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
    const ctx = vm.createContext({ DIAG_BUILD: build, window: { addEventListener: () => {}, crypto: { getRandomValues: (a) => crypto.randomFillSync(a) }, localStorage: storage },
      localStorage: storage,
      Settings: { get: (k) => settings[k], set: (k, v) => { settings[k] = v; } },
      setTimeout: () => 1, clearTimeout: () => {}, Date, Math, JSON, Promise, Uint8Array, unescape, encodeURIComponent,
      fetch: (url) => { sent.push(url); return Promise.reject(new TypeError('Failed to fetch')); } });
    vm.runInContext(SRC, ctx);
    // With a server, the yes sends the events (without one, nothing at all).
    ctx.DiagUpload.setEnabled(true);
    ctx.DiagUpload.event('app.started', { outcome: 'ok' });
    ctx.DiagUpload.flush();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(sent[0], want, JSON.stringify(build));
    assert.equal(ctx.DiagUpload.available(), !!want);
    // The viewer's yes counts only with a server.
    settings.diagnostics = 'basic';
    assert.equal(ctx.DiagUpload.enabled(), !!want);
    if (!want) {
      await assert.rejects(ctx.DiagUpload.report('other'));
      assert.equal(await ctx.DiagUpload.deleteMyData(), 'deleted');
      assert.deepEqual(sent, []);
    }
  }
});

test('an app open 15 minutes counts once, anonymously: the version and whether diagnostics are on, nothing else', async () => {
  const t = load({ answer: ok, settings: { diagnostics: 'off', diagnosticsAsked: true } });
  await t.run(14 * 60000);
  assert.deepEqual(t.uses, [], 'not before 15 minutes (an app closed again counts nothing)');
  await t.run(2 * 60000);
  assert.equal(t.uses.length, 1);
  assert.equal(t.uses[0].url, BASE + '/starts');
  assert.deepEqual(t.uses[0].body, { schema_version: 1, version: '1.4.0', diagnostics: false });
  assert.equal(t.uses[0].headers.Authorization, undefined, 'no secret');
  assert.deepEqual(t.sent, [], 'and nothing else with diagnostics off');
  await t.run(3 * 3600000);
  assert.equal(t.uses.length, 1, 'once per run');
});

test('the app-use count waits for the answer to the diagnostics question, says when it is yes, and skips personal builds', async () => {
  const unasked = load({ answer: ok, settings: { diagnostics: 'off' } });
  await unasked.run(20 * 60000);
  assert.deepEqual(unasked.uses, [], 'a new viewer not asked yet would skew the share');
  const yes = load({ answer: ok });
  yes.U.setEnabled(true);   // the answer: yes (sets diagnosticsAsked)
  await yes.run(16 * 60000);
  assert.deepEqual(yes.uses.map((u) => [u.body.diagnostics, u.body.unit]), [[true, undefined]]);
  const personal = load({ answer: ok, settings: { diagnostics: 'off', diagnosticsAsked: true }, build: { record: true, label: 'tv-dev', server: BASE } });
  await personal.run(20 * 60000);
  assert.deepEqual(personal.uses, []);
});
