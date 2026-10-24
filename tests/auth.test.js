const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

/**
 * Loads api.js + auth.js. `route(path, body, headers)` answers account API calls; timers run
 * right away so pairing polls without waiting 5 s.
 */
function auth(route, stored) {
  const store = { 'f1tv.session': stored ? JSON.stringify(stored) : null };
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.replace('https://api.formula1.com', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, headers: init.headers });
    const r = route ? route(path, body, init.headers) : null;
    const text = JSON.stringify(r && r.body !== undefined ? r.body : r);
    return { ok: !(r && r.status >= 400), status: (r && r.status) || 200, text: async () => text };
  };
  const context = vm.createContext({
    fetch, URL, atob, encodeURIComponent, decodeURIComponent, Date, JSON, Math,
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    setTimeout: (fn) => { setImmediate(fn); return 1; }, clearTimeout: () => {}
  });
  vm.runInContext(readFileSync('app/js/api.js', 'utf8'), context);
  vm.runInContext(readFileSync('app/js/auth.js', 'utf8'), context);
  return { Auth: context.Auth, calls, saved: () => JSON.parse(store['f1tv.session'] || '{}') };
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload) => b64url({ alg: 'RS256' }) + '.' + b64url(payload) + '.sig';
const inSeconds = (s) => Math.floor(Date.now() / 1000) + s;

test('token returns the stored subscription token while it is valid', () => {
  const t = jwt({ exp: inSeconds(3600) });
  assert.equal(auth(null, { subscriptionToken: t }).Auth.token(), t);
});

test('token treats a token with less than a minute left as expired', () => {
  assert.equal(auth(null, { subscriptionToken: jwt({ exp: inSeconds(30) }) }).Auth.token(), null);
  assert.equal(auth(null, { subscriptionToken: jwt({ exp: inSeconds(-10) }) }).Auth.token(), null);
});

test('token keeps a token without a readable expiry, and is null when signed out', () => {
  const t = jwt({ FirstName: 'Alex' });
  assert.equal(auth(null, { subscriptionToken: t }).Auth.token(), t);
  assert.equal(auth(null, {}).Auth.token(), null);
});

test('profile reads the name and plan from the token, also with URL-safe base64', () => {
  // '?' and '>' encode to '/' and '+' in standard base64, '_' and '-' in base64url.
  const t = jwt({ FirstName: 'Zoë', LastName: '?>?>', SubscribedProduct: 'F1 TV Pro Monthly', exp: inSeconds(3600) });
  assert.match(t.split('.')[1], /[-_]/);
  const p = auth(null, { subscriptionToken: t }).Auth.profile();
  assert.deepEqual({ ...p }, { firstName: 'Zoë', lastName: '?>?>', product: 'F1 TV Pro Monthly' });
  assert.deepEqual({ ...auth(null, {}).Auth.profile() }, { firstName: '', lastName: '', product: '' });
});

test('pairUrl links to F1 confirmation page with the code pre-filled', () => {
  assert.equal(auth().Auth.pairUrl('AB12CD'), 'https://f1tv.formula1.com/tv?pin=ab12cd');
});

test('clear signs out but keeps the device id', () => {
  const { Auth, saved } = auth(null, { subscriptionToken: jwt({}), authKey: 'K', deviceId: 'tizen-1' });
  Auth.clear();
  assert.deepEqual(saved(), { deviceId: 'tizen-1' });
});

/** An account API that confirms the code after `pending` polls. */
function account({ pending = 1, expireFirst = false } = {}) {
  let codes = 0, polls = 0;
  return (path, body) => {
    if (path.endsWith('/GenerateDeviceRendezvousCode')) { codes++; return { RendezvousCode: 'code' + codes, AuthenticationKey: 'KEY' + codes }; }
    if (path.endsWith('/RetrieveDeviceRendezvousStatus')) {
      if (expireFirst && body.RendezvousCode === 'code1') return { Status: '3' };
      return { Status: ++polls > pending ? '1' : '2' };
    }
    if (path.endsWith('/authenticate/by-device')) return { data: { subscriptionToken: jwt({ exp: inSeconds(3600), FirstName: 'Alex' }) }, AuthenticationKey: 'ROTATED' };
  };
}

test('pair shows the code, polls until it is confirmed and saves the session', async () => {
  const { Auth, calls, saved } = auth(account({ pending: 2 }));
  const shown = [];
  const token = await Auth.pair((code) => shown.push(code));
  assert.deepEqual(shown, ['CODE1']);
  assert.equal(Auth.token(), token);
  assert.equal(Auth.profile().firstName, 'Alex');
  assert.equal(saved().authKey, 'ROTATED');
  assert.equal(calls.filter((c) => c.path.endsWith('Status')).length, 3);
});

test('pair sends the device profile, and the same device id every time', async () => {
  const { Auth, calls, saved } = auth(account());
  await Auth.pair(() => {});
  const gen = calls[0];
  assert.equal(gen.headers.apikey.length > 10, true);
  assert.equal(gen.headers['CD-DeviceType'], '17');
  assert.ok(gen.headers['CD-SystemID']);
  assert.equal(gen.body.DeviceId, saved().deviceId);
  const byDevice = calls.find((c) => c.path.endsWith('/by-device'));
  assert.equal(byDevice.headers['CD-SystemID'], undefined);
  assert.equal(byDevice.body.DeviceId, saved().deviceId);
  assert.equal(byDevice.body.AuthenticationKey, 'KEY1');
});

test('pair gets a new code when the shown one expires', async () => {
  const { Auth } = auth(account({ expireFirst: true }));
  const shown = [];
  await Auth.pair((code) => shown.push(code));
  assert.deepEqual(shown, ['CODE1', 'CODE2']);
});

test('pair keeps polling through network errors', async () => {
  let failures = 2;
  const ok = account();
  const { Auth } = auth((path, body) => path.endsWith('Status') && failures-- > 0 ? { status: 503, body: {} } : ok(path, body));
  assert.ok(await Auth.pair(() => {}));
});

test('pair rejects with the account API fault message when no code can be made', async () => {
  const { Auth } = auth(() => ({ Fault: { Code: 1, Message: 'Device limit reached' } }));
  await assert.rejects(Auth.pair(() => {}), /Device limit reached/);
});

test('cancel stops pairing', async () => {
  let polls = 0;
  const { Auth } = auth((path) => path.endsWith('Code') ? { RendezvousCode: 'c', AuthenticationKey: 'k' } : (polls++, { Status: '2' }));
  const job = Auth.pair(() => {});
  await new Promise((r) => setImmediate(r));
  job.cancel();
  const seen = polls;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(polls <= seen + 1);
});

test('renew trades the device key for a fresh token, and gives null when it cannot', async () => {
  const { Auth } = auth(account(), { authKey: 'KEY1', deviceId: 'tizen-1' });
  assert.ok(await Auth.renew());
  assert.equal(await auth(account(), {}).Auth.renew(), null);
  const { Auth: revoked } = auth(() => ({ status: 401, body: { message: 'revoked' } }), { authKey: 'K', deviceId: 'd' });
  assert.equal(await revoked.renew(), null);
});
