const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Removing redaction or response cloning would leak credentials or break the app's body reader.
test('diagnostics preserve PLAY responses for the app and persist redacted evidence with check context', async (t) => {
  const { createDiagnostics } = require('../monitor/diagnostics.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const response = { resultObj: {
    streamType: 'HDR_UHD_CMAFFP', url: 'https://cdn.example/hdr.m3u8?token=cdn-secret',
    laURL: 'https://lic.example/fairplay?signature=lic-secret', entitlementToken: 'ent-secret', drmToken: 'drm-secret'
  } };
  const diagnostics = createDiagnostics(dir, {
    now: () => new Date('2026-10-31T05:53:00Z'),
    fetchImpl: async () => new Response(JSON.stringify(response))
  });
  await diagnostics.withContext({ check: '4K HDR (Premium)', attempt: 1 }, async () => {
    const r = await diagnostics.fetch('https://f1tv.example/3.0/R/ENG/BIG_SCREEN_DASH/ALL/CONTENT/PLAY?contentId=42&player=player_bm', {
      headers: { ascendontoken: 'auth-secret', entitlementtoken: 'ent-secret', 'x-f1-device-info': 'device=tvos;' }
    });
    assert.deepEqual(await r.json(), response);
    diagnostics.log('check.error', { error: { message: 'Failed for auth-secret at https://cdn.example/x?token=another-secret' } });
  });
  const raw = fs.readFileSync(diagnostics.file, 'utf8');
  for (const secret of ['auth-secret', 'ent-secret', 'drm-secret', 'cdn-secret', 'lic-secret', 'another-secret']) {
    assert.ok(!raw.includes(secret), secret + ' leaked');
  }
  const events = raw.trim().split('\n').map(JSON.parse);
  const result = events.find((e) => e.event === 'http.response');
  assert.equal(result.response.resultObj.streamType, 'HDR_UHD_CMAFFP');
  assert.match(result.response.resultObj.laURL, /fairplay/);
  assert.match(result.url, /contentId=42/);
  assert.equal(result.device, 'device=tvos;');
  assert.equal(result.status, 200);
  assert.equal(result.check, '4K HDR (Premium)');
  assert.equal(result.attempt, 1);
  assert.ok(result.runId);
  assert.equal(fs.statSync(diagnostics.file).mode & 0o777, 0o600);
});

test('manifest evidence records HLG sizes and FairPlay keys without storing key URIs', async (t) => {
  const { createDiagnostics } = require('../monitor/diagnostics.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const master = '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key-secret",KEYFORMAT="com.apple.streamingkeydelivery"\n' +
    '#EXT-X-STREAM-INF:VIDEO-RANGE=HLG,RESOLUTION=3840x2160,CODECS="hvc1.2.4,ec-3"\nuhd.m3u8?token=variant-secret\n';
  const diagnostics = createDiagnostics(dir, { fetchImpl: async () => new Response(master) });
  assert.equal(await (await diagnostics.fetch('https://cdn.example/master.m3u8?token=master-secret')).text(), master);
  const raw = fs.readFileSync(diagnostics.file, 'utf8');
  for (const secret of ['key-secret', 'variant-secret', 'master-secret']) assert.ok(!raw.includes(secret));
  const event = raw.trim().split('\n').map(JSON.parse).find((e) => e.manifest);
  assert.equal(event.manifest.format, 'hls');
  assert.deepEqual(event.manifest.hlg, [{ width: 3840, height: 2160 }]);
  assert.deepEqual(event.manifest.keys, [{ method: 'SAMPLE-AES', keyFormat: 'com.apple.streamingkeydelivery' }]);
});

test('daily diagnostics retain fourteen days and leave unrelated files alone', (t) => {
  const { createDiagnostics } = require('../monitor/diagnostics.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'logs'));
  for (const name of ['2026-10-17.jsonl', '2026-10-18.jsonl', 'notes.txt']) fs.writeFileSync(path.join(dir, 'logs', name), '');
  const diagnostics = createDiagnostics(dir, { now: () => new Date('2026-10-31T05:53:00Z') });
  diagnostics.log('run.start', {});
  assert.deepEqual(fs.readdirSync(path.join(dir, 'logs')).sort(), ['2026-10-18.jsonl', '2026-10-31.jsonl', 'notes.txt']);
});

test('device authentication keys are redacted from error data and errors echoing a JSON request', async (t) => {
  const { createDiagnostics } = require('../monitor/diagnostics.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diagnostics = createDiagnostics(dir, {
    fetchImpl: async () => { throw new Error('rejected request-device-secret'); }
  });
  diagnostics.log('check.error', { error: { message: 'rejected response-device-secret',
    data: { AuthenticationKey: 'response-device-secret' } } });
  await assert.rejects(diagnostics.fetch('https://account.example/Subscriber/AuthenticateByDevice', {
    method: 'POST', body: JSON.stringify({ AuthenticationKey: 'request-device-secret' })
  }), /rejected/);
  const raw = fs.readFileSync(diagnostics.file, 'utf8');
  assert.ok(!raw.includes('response-device-secret'));
  assert.ok(!raw.includes('request-device-secret'));
});

test('network errors are saved with their cause and original check even after another check starts', async (t) => {
  const { createDiagnostics } = require('../monitor/diagnostics.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reject;
  const diagnostics = createDiagnostics(dir, { fetchImpl: () => new Promise((resolve, no) => { reject = no; }) });
  const pending = diagnostics.withContext({ check: 'HDR', attempt: 1 }, () => diagnostics.fetch('https://cdn.example/hdr.m3u8'));
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
  diagnostics.withContext({ check: 'next check' }, () => reject(error));
  await assert.rejects(pending, /fetch failed/);
  const event = fs.readFileSync(diagnostics.file, 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.event === 'http.error');
  assert.equal(event.check, 'HDR');
  assert.equal(event.error.cause.code, 'ECONNRESET');
  assert.match(event.error.stack, /fetch failed/);
});

test('the monitor CLI writes attempts, retries, failing checks and the completed run to its data directory', (t) => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-monitor-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'fetch-fixture.cjs');
  fs.writeFileSync(preload, `global.fetch = async (url) => new Response(JSON.stringify({ message: 'fixture unavailable' }),
    { status: String(url).endsWith('/config') ? 503 : 403 });`);
  const child = spawnSync(process.execPath, ['--require', preload, path.resolve('monitor/check.js'), 'check'], {
    env: { ...process.env, DATA_DIR: dir, F1TV_TOKEN: '', NOTIFY_URL: '', RETRY_WAIT: '1' },
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stdout, /Diagnostics: .*\.jsonl/, child.stderr);
  const file = fs.readdirSync(path.join(dir, 'logs'))[0];
  const events = fs.readFileSync(path.join(dir, 'logs', file), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter((e) => e.event === 'check.start' && e.check === 'API config').map((e) => e.attempt), [1, 2]);
  assert.ok(events.some((e) => e.event === 'check.retry' && e.check === 'API config' && e.waitMs === 1));
  assert.ok(events.some((e) => e.event === 'check.result' && e.check === 'API config' && e.ok === false));
  assert.ok(events.some((e) => e.event === 'run.results' && e.failing.includes('API config')));
  assert.equal(events.at(-1).event, 'run.end');
  assert.equal(new Set(events.map((e) => e.runId)).size, 1);
});
