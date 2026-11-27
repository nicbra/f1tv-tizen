const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const common = require('../shell/common');
const updater = require('../shell/updater');
const { tar, assemble } = require('../scripts/build-bundle');
const { signingKey, publicKey, sign } = require('../scripts/sign-bundle');
const acorn = require('./vendor/acorn');
const config = require('../shell/config');
const read = (p) => fs.readFileSync(p, 'utf8');
const hash = (b) => crypto.createHash('sha512').update(b).digest('hex');
const key = signingKey(crypto.randomBytes(32).toString('base64'));
const keys = { test: publicKey(key) };
function release(v, body = '') { return { tag_name: 'v' + v, prerelease: false, body, assets: ['bundle.json', 'bundle.json.sig', 'bundle-' + v + '.tar'].map((name) => ({ name })) }; }
function fixture(version = '1.1.0', opts = {}) {
  const files = opts.files || [['index.html', Buffer.from('<body>Home</body>')], ['service/service.js', Buffer.from('module.exports.handle=function(){};')]];
  const archive = tar(files);
  const m = { format: 1, version, minShell: opts.minShell || 1, archive: { name: `bundle-${version}.tar`, size: archive.length, sha512: hash(archive) },
    files: Object.fromEntries(files.map(([p, b]) => [p, { size: b.length, sha512: hash(b) }])), revokes: opts.revokes || [], key: 'test' };
  const raw = JSON.stringify(m), sig = crypto.sign(null, Buffer.from(raw), key).toString('base64');
  return { manifest: m, raw, sig, archive };
}
function temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-launcher-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
function service(t, opts = {}) {
  const root = temp(t), builtin = fixture(opts.builtin || '1.0.0');
  const cfg = { ...config, keys };
  const svc = updater.create({ root, config: cfg, builtin, candidates: [path.join(root, 'data')], build: { updates: true }, ...opts });
  return { svc, root, builtin };
}
function install(svc, f) { return svc.install(f.raw, f.sig, f.archive); }

test('stable skips prereleases; staging selects the newest compatible of both channels', async (t) => {
  const bundles = { '1.2.0': fixture('1.2.0'), '1.3.0': fixture('1.3.0'), '2.0.0': fixture('2.0.0', { minShell: 2 }) };
  for (const channel of [undefined, 'stable', 'prerelease']) {
    const requested = [];
    const { svc } = service(t, { build: { updates: true, channel }, download(u, limit, cb) {
      requested.push(u);
      if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([
        { ...release('1.3.0'), prerelease: true }, release('1.2.0'),
        { ...release('2.0.0'), prerelease: true }, { ...release('9.0.0'), draft: true }
      ])));
      const f = bundles[/\/v([^/]+)\//.exec(u)[1]];
      cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
    } });
    const result = await new Promise((resolve, reject) => svc.check((err, r) => err ? reject(err) : resolve(r)));
    assert.equal(result.downloaded, channel === 'prerelease' ? '1.3.0' : '1.2.0');
    assert.equal(result.needsReinstall, channel === 'prerelease' ? '2.0.0' : null);
    assert.equal(svc.info().channel, channel || 'stable');
    assert.ok(!requested.some((u) => u.includes('v9.0.0')));
  }
  const stable = fixture('1.4.0'), pre = fixture('1.3.0');
  const { svc } = service(t, { build: { updates: true, channel: 'prerelease' }, download(u, limit, cb) {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([
      { ...release('1.3.0'), prerelease: true }, release('1.4.0')
    ])));
    const f = u.includes('v1.4.0') ? stable : pre;
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
  } });
  assert.equal((await new Promise((resolve, reject) => svc.check((e, r) => e ? reject(e) : resolve(r)))).downloaded, '1.4.0');
});

test('separate verification rejects wrong keys, placeholder, archive changes and signed file mismatches', (t) => {
  const { verify } = require('../scripts/verify-bundle');
  const dir = temp(t), file = path.join(dir, 'bundle.json'), f = fixture();
  const archive = path.join(dir, f.manifest.archive.name);
  const write = (raw = f.raw, body = f.archive) => {
    fs.writeFileSync(file, raw);
    fs.writeFileSync(file + '.sig', crypto.sign(null, Buffer.from(raw), key).toString('base64'));
    fs.writeFileSync(archive, body);
  };
  write();
  assert.equal(verify(file, { keys }).version, '1.1.0');
  assert.throws(() => verify(file, { keys: { test: publicKey(signingKey(crypto.randomBytes(32).toString('base64'))) } }), /signature/);
  assert.throws(() => verify(file, { keys: { test: 'TODO_REPLACE_WITH_BASE64_ED25519_PUBLIC_KEY' } }), /TODO public signing key/);
  fs.appendFileSync(archive, 'extra');
  assert.throws(() => verify(file, { keys }), /Archive size/);
  const changed = Buffer.from(f.archive); changed[512] ^= 1;
  write(f.raw, changed);
  assert.throws(() => verify(file, { keys }), /Archive hash/);
  const manifest = { ...f.manifest, archive: { ...f.manifest.archive, sha512: hash(changed) } };
  write(JSON.stringify(manifest), changed);
  assert.throws(() => verify(file, { keys }), /File hash/);
  write(); fs.appendFileSync(file + '.sig', '!');
  assert.throws(() => verify(file, { keys }), /signature encoding/);
  write(); fs.appendFileSync(file, ' ');
  assert.throws(() => verify(file, { keys }), /signature/);
});

test('Launcher exposes stable by default and the staging channel explicitly', () => {
  assert.equal(bootShell().ctx.Launcher.channel, 'stable');
  assert.equal(bootShell({ channel: 'prerelease' }).ctx.Launcher.channel, 'prerelease');
});

test('selection checks shell level, bad marks, revokes, format and built-in precedence', () => {
  const builtin = { ...fixture('2.0.0'), builtin: true };
  const list = [fixture('1.9.0'), builtin, fixture('3.0.0', { minShell: 2 }), fixture('2.1.0')];
  assert.equal(common.select(list, 1, {}).manifest.version, '2.1.0');
  assert.equal(common.select(list, 1, { bad: { '2.1.0': true } }), builtin);
  assert.equal(common.select(list, 1, { revokes: ['2.1.0'] }), builtin);
  assert.equal(common.select([{ ...fixture('2.0.0') }, builtin], 1, {}), builtin);
  assert.equal(common.select([fixture('3.0.0', { minShell: 2 })], 1, {}), null);
});

test('two failed starts mark bad; fallback readiness preserves the new version failure count', () => {
  const state = {};
  assert.equal(common.begin(state, '2.0.0'), true);
  common.fail(state, '2.0.0', 'timeout');
  common.fail(state, '2.0.0', 'duplicate error');
  assert.equal(state.failures['2.0.0'], 1);
  assert.ok(!state.bad['2.0.0']);
  common.begin(state, '1.0.0'); common.ready(state, '1.0.0');
  assert.equal(common.begin(state, '2.0.0'), true);
  common.fail(state, '2.0.0', 'script error');
  assert.ok(state.bad['2.0.0']);
  const interrupted = {};
  assert.equal(common.begin(interrupted, '2.0.0'), true);
  assert.equal(common.begin(interrupted, '2.0.0'), true);
  assert.equal(common.begin(interrupted, '2.0.0'), false);
  const recovered = {};
  common.begin(recovered, '2.0.0'); common.fail(recovered, '2.0.0', 'timeout');
  common.begin(recovered, '2.0.0'); common.ready(recovered, '2.0.0');
  assert.equal(recovered.failures['2.0.0'], undefined);
});

test('Ed25519 authenticates exact manifest bytes and SHA-512 fallback matches Node', () => {
  const f = fixture();
  assert.equal(common.verify(f.raw, f.sig, keys).version, '1.1.0');
  assert.throws(() => common.verify(f.raw + ' ', f.sig, keys), /signature/);
  assert.throws(() => common.verify(f.raw, Buffer.alloc(64).toString('base64'), keys), /signature/);
  assert.throws(() => common.verify(f.raw, f.sig, {}), /signature/);
  assert.equal(common.hash(Buffer.from('abc')), hash(Buffer.from('abc')));
  const source = read('shell/updater.js');
  const sandbox = { require: (p) => { if (p === 'crypto' || p === 'zlib') throw Error('absent'); return p === './common' ? common : require(p); }, module: { exports: {} }, Buffer, Uint8Array };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.module.exports.sha(Buffer.from('abc')), hash(Buffer.from('abc')));
});

test('staging validates complete files before atomic rename; hash rejection leaves no install', (t) => {
  const { svc, root } = service(t), f = fixture();
  const archive = Buffer.from(f.archive); archive[600] ^= 1;
  assert.throws(() => svc.install(f.raw, f.sig, archive), /Archive hash/);
  assert.deepEqual(svc.installed().map((b) => b.manifest.version), ['1.0.0']);
  const original = fs.renameSync, renames = [];
  fs.renameSync = (a, b) => { renames.push([a, b]); return original(a, b); };
  try { install(svc, f); } finally { fs.renameSync = original; }
  assert.ok(renames.some(([a, b]) => a.endsWith('.stage-1.1.0') && b.endsWith('/1.1.0')));
  assert.ok(fs.existsSync(path.join(root, 'data/bundles/1.1.0/index.html')));
  assert.ok(!fs.existsSync(path.join(root, 'data/bundles/.stage-1.1.0')));
  assert.equal(svc.selected().manifest.version, '1.1.0');
  fs.appendFileSync(path.join(root, 'data/bundles/1.1.0/index.html'), 'tampered');
  assert.equal(svc.selected().manifest.version, '1.1.0', 'verification is cached for this process');
  install(svc, f);
  assert.equal(read(path.join(root, 'data/bundles/1.1.0/index.html')), '<body>Home</body>', 'inactive corrupt folders are repaired');
  fs.appendFileSync(path.join(root, 'data/bundles/1.1.0/index.html'), 'tampered again');
  const fresh = updater.create({ root, config: { ...config, keys }, builtin: fixture('1.0.0'), candidates: [path.join(root, 'data')], build: { updates: true } });
  assert.equal(fresh.selected().manifest.version, '1.0.0', 'next service process detects damage');
});

test('file hash mismatch, incomplete tar, unsafe paths, links and duplicate entries are rejected', (t) => {
  const dir = temp(t);
  const f = fixture(), m = structuredClone(f.manifest);
  m.files['index.html'].sha512 = '0'.repeat(128);
  assert.throws(() => updater.unpack(f.archive, dir, m), /hash mismatch/);
  assert.throws(() => updater.unpack(f.archive.subarray(0, 512), dir, f.manifest), /size/);
  for (const name of ['../escape', '/absolute', 'a/../../escape', 'a//b', 'a/./b', 'a\\b']) {
    const files = [[name, Buffer.from('evil')]], a = tar(files);
    assert.throws(() => updater.unpack(a, dir, { files: { [name]: { size: 4, sha512: hash(Buffer.from('evil')) } } }), /Unsafe/);
  }
  const a = tar([['index.html', Buffer.from('x')], ['index.html', Buffer.from('x')]]);
  assert.throws(() => updater.unpack(a, dir, { files: { 'index.html': { size: 1, sha512: hash(Buffer.from('x')) } } }), /Unsafe/);
  const link = tar([['index.html', Buffer.from('x')]]);
  link[156] = 50; link.fill(32, 148, 156);
  const sum = [...link.subarray(0, 512)].reduce((a, b) => a + b, 0);
  link.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  assert.throws(() => updater.unpack(link, dir, f.manifest), /Unsafe/);
  assert.ok(!fs.existsSync(path.join(dir, '../escape')));
});

test('failed unpack cleans staging; interrupted staging is discarded; cleanup retains rollback', (t) => {
  const { svc, root } = service(t);
  const f = fixture(), m = structuredClone(f.manifest); m.files['index.html'].sha512 = '0'.repeat(128);
  const raw = JSON.stringify(m), sig = crypto.sign(null, Buffer.from(raw), key).toString('base64');
  assert.throws(() => svc.install(raw, sig, f.archive), /hash mismatch/);
  assert.ok(!fs.existsSync(path.join(root, 'data/bundles/.stage-1.1.0')));
  for (const v of ['1.1.0', '1.2.0', '1.3.0', '1.4.0']) install(svc, fixture(v));
  assert.deepEqual(svc.installed().map((b) => b.manifest.version), ['1.0.0', '1.3.0', '1.4.0']);
  const stage = path.join(root, 'data/bundles/.stage-9.0.0'); fs.mkdirSync(stage);
  updater.create({ root, config: { ...config, keys }, builtin: fixture('1.0.0'), candidates: [path.join(root, 'data')], build: {} });
  assert.ok(!fs.existsSync(stage));
});

test('newest compatible release installs even when latest requires reinstall; revokes persist', async (t) => {
  const f = fixture('2.0.0', { minShell: 2 }), g = fixture('1.5.0', { revokes: ['1.2.0'] });
  const requests = [];
  function download(u, limit, done) {
    requests.push(u);
    if (u.includes('api.github')) return done(null, Buffer.from(JSON.stringify([release('1.5.0', 'Compatible'), release('2.0.0', 'New shell'), release('1.0.0', 'Older notes')])));
    const b = u.includes('v2.0.0') ? f : g;
    done(null, u.endsWith('.sig') ? Buffer.from(b.sig) : u.endsWith('.json') ? Buffer.from(b.raw) : b.archive);
  }
  const { svc } = service(t, { download });
  const result = await new Promise((resolve, reject) => svc.check((e, r) => e ? reject(e) : resolve(r)));
  assert.equal(result.needsReinstall, '2.0.0'); assert.equal(result.downloaded, '1.5.0');
  assert.equal(svc.selected().manifest.version, '1.5.0');
  assert.deepEqual(svc.state.revokes, ['1.2.0']);
  assert.equal(requests.filter((u) => u.includes('api.github')).length, 1);
  assert.ok(!requests.some((u) => u.endsWith('bundle-2.0.0.tar')));
});

test('invalid signatures are skipped with diagnostics and no download', async (t) => {
  const f = fixture(); let archives = 0;
  function download(u, limit, cb) {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('1.1.0')])));
    if (u.endsWith('.sig')) return cb(null, Buffer.from(Buffer.alloc(64).toString('base64')));
    if (u.endsWith('.json')) return cb(null, Buffer.from(f.raw));
    archives++; cb(null, f.archive);
  }
  const { svc } = service(t, { download });
  const result = await new Promise((resolve, reject) => svc.check((e, r) => e ? reject(e) : resolve(r)));
  assert.match(result.skipped[0].reason, /signature/);
  assert.deepEqual(svc.state.skipped, result.skipped);
  assert.equal(result.downloaded, null); assert.equal(archives, 0);
});

test('development override disables checks and selection of downloaded releases', async (t) => {
  const build = require('../shell/launcher-build'); assert.equal(build.updates, true);
  const { svc } = service(t, { build: { updates: false }, download: () => { throw Error('network forbidden'); } });
  install(svc, fixture('9.0.0'));
  assert.equal(svc.selected().builtin, true);
  assert.equal((await new Promise((resolve) => svc.check((err, r) => resolve(r)))).disabled, true);
});

test('config.xml normalized hash is pinned to the shell level', () => {
  const pins = JSON.parse(read('shell/config-hashes.json'));
  // Comments and blank lines don't reach the TV; everything else does.
  const normalized = read('app/config.xml').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\n/gm, '')
    .replace(/(<widget\b[^>]*\bversion=")[^"]+"/, '$1VERSION"');
  assert.equal(hash(Buffer.from(normalized)), pins[config.SHELL_LEVEL], 'Raise SHELL_LEVEL and add the normalized config hash when changing shell config');
});

test('all shell files parse as ES5; the parser rejects ES2015', () => {
  for (const p of [...fs.readdirSync('shell').filter((p) => p.endsWith('.js')).map((p) => 'shell/' + p), 'shell/vendor/nacl-fast.js']) {
    acorn.parse(read(p), { ecmaVersion: 5, allowReserved: true });
  }
  for (const syntax of ['let a=1;', 'const a=1;', 'var f=()=>1;', 'var x=`hello`;', 'async function f(){}', 'class C {}']) assert.throws(() => acorn.parse(syntax, { ecmaVersion: 5 }));
});

test('assembly packages shell boot and service entry with an offline builtin and no dev override', (t) => {
  const out = temp(t); assemble('app', 'shell', out, false);
  assert.ok(fs.existsSync(path.join(out, 'src/launcher/boot.html')));
  assert.ok(fs.existsSync(path.join(out, 'src/launcher/service.js')));
  assert.equal(require(path.join(out, 'src/launcher/builtin.json')).manifest.version, '0.0.0');
  assert.equal(require(path.join(out, 'src/launcher-build.js')).updates, true);
  assert.ok(!fs.existsSync(path.join(out, 'src/builtin/launcher-build.js')));
  assert.ok(!fs.existsSync(path.join(out, 'src/launcher/launcher-build.js')), 'one copy, at the package root');
  assert.ok(!fs.existsSync(path.join(out, 'src/builtin/config.xml')));
  assert.match(read(path.join(out, 'src/launcher/boot.html')), /\$WEBAPIS\/webapis\/webapis.js/);
  const m = JSON.parse(read(path.join(out, 'bundle.json')));
  updater.unpack(fs.readFileSync(path.join(out, m.archive.name)), path.join(out, 'unpacked'), m);
});

test('signing accepts seed or PEM, validates shell key, and rejects release placeholder', (t) => {
  const out = temp(t), file = path.join(out, 'bundle.json'), f = fixture(); fs.writeFileSync(file, f.raw);
  const previous = process.env.BUNDLE_SIGNING_KEY;
  try {
    process.env.BUNDLE_SIGNING_KEY = key.export({ format: 'pem', type: 'pkcs8' });
    sign(file, { keys }); assert.equal(common.verify(read(file), read(file + '.sig'), keys).version, f.manifest.version);
    assert.throws(() => sign(file, { keys: { test: 'TODO_REPLACE' } }), /TODO/);
    assert.throws(() => sign(file, { keys: { test: crypto.randomBytes(32).toString('base64') } }), /match/);
    delete process.env.BUNDLE_SIGNING_KEY;
    assert.throws(() => sign(file, { keys }), /BUNDLE_SIGNING_KEY is required/);
  } finally { if (previous === undefined) delete process.env.BUNDLE_SIGNING_KEY; else process.env.BUNDLE_SIGNING_KEY = previous; }
  const printed = [];
  vm.runInNewContext(read('scripts/generate-bundle-key.js'), { require: (p) => p === './sign-bundle' ? require('../scripts/sign-bundle') : require(p), console: { log: (s) => printed.push(s) } });
  assert.match(printed[1], /Public entry: {"f1tv-2026":"[A-Za-z0-9+/]+=*"}/);
});

test('the TV fixture generator assembles, signs and verifies bundles from a disposable copy of the repo', (t) => {
  // LAUNCHER.md's TV verification depends on this generator; run the real script in an isolated copy
  // so a broken fixture is caught in CI, not in front of the TV, and the repo's shell keys stay untouched.
  const root = temp(t);
  fs.cpSync('app', path.join(root, 'app'), { recursive: true });
  fs.cpSync('shell', path.join(root, 'shell'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['build-bundle.js', 'build-test-bundle.js', 'sign-bundle.js', 'revokes.json'])
    fs.copyFileSync(path.join('scripts', name), path.join(root, 'scripts', name));
  const shellConfig = read(path.join(root, 'shell/config.js'));
  const seed = crypto.randomBytes(32).toString('base64');
  const publicKeys = { 'local-test': publicKey(signingKey(seed)) };
  const out = path.join(root, 'test-source');
  function build(env, expectFailure) {
    const result = spawnSync(process.execPath, ['scripts/build-test-bundle.js', out], {
      cwd: root, encoding: 'utf8', env: { ...process.env, BUNDLE_SIGNING_KEY: seed, ...env } });
    if (!expectFailure) assert.equal(result.status, 0, result.stderr);
    return result;
  }
  function manifestOf(version, installed) {
    const raw = read(path.join(out, 'bundle.json')), m = common.verify(raw, read(path.join(out, 'bundle.json.sig')), publicKeys);
    assert.equal(m.version, version);
    updater.unpack(fs.readFileSync(path.join(out, m.archive.name)), path.join(root, installed), m);
    return m;
  }

  build({ TEST_VERSION: '9.0.1', TEST_MIN_SHELL: '2', BUNDLE_REVOKES: '1.2.3', FAULT: 'timeout', LAUNCHER_TEST_SOURCE: 'http://192.168.0.2:8000' });
  const m = manifestOf('9.0.1', 'installed');
  assert.equal(m.minShell, 2);
  assert.deepEqual(m.revokes.slice(-1), ['1.2.3']);
  assert.match(read(path.join(root, 'installed/js/app.js')), /function launcherReady\(\) \{ return; \/\/ local timeout fixture/,
    'the timeout fixture must actually land in the assembled source');
  const overrideModule = { exports: {} };
  vm.runInNewContext(read(path.join(root, 'local/app/launcher-build.js')), { module: overrideModule });
  const override = overrideModule.exports;
  assert.equal(override.updates, true);
  assert.equal(override.source, 'http://192.168.0.2:8000');
  assert.deepEqual(Object.keys(override.keys), ['local-test'], 'the override carries only the public test key');
  assert.equal(override.keys['local-test'], publicKeys['local-test']);

  build({ TEST_VERSION: '9.0.2', FAULT: 'service' });
  manifestOf('9.0.2', 'installed2');
  assert.equal(read(path.join(root, 'installed2/service/service.js')), "throw new Error('Local service rollback fixture');\n");

  assert.notEqual(build({ TEST_VERSION: '9.0.3', FAULT: 'nonsense' }, true).status, 0);
  assert.match(build({ TEST_VERSION: 'nope' }, true).stderr, /Invalid TEST_VERSION/);
  assert.equal(read(path.join(root, 'shell/config.js')), shellConfig, 'no test key may enter the shell');
});

test('page/service version mismatch requests a service restart before ensure succeeds', async () => {
  const calls = [];
  const ctx = { Launcher: { version: '1.2.0' }, fetch: async (u) => { calls.push(u); return { ok: true, json: async () => ({ ok: true, version: u.includes('restart') ? '1.2.0' : '1.1.0' }) }; },
    setTimeout, clearTimeout };
  vm.runInNewContext(read('app/js/proxy.js'), ctx);
  assert.equal(await ctx.StreamProxy.ensure(), true);
  assert.deepEqual(calls, ['http://127.0.0.1:18765/ping', 'http://127.0.0.1:18765/launcher/restart?version=1.2.0']);
});

function bootShell(opts = {}) {
  // The XHR fake serves fixture files by path suffix, so the downloaded fixture stays version 1.1.0 throughout.
  const files = [
    ['index.html', Buffer.from('<body>Home<script src="js/one.js"></script><script src="js/two.js"></script></body>')],
    ['js/one.js', Buffer.from('window.executed = [1];')], ['js/two.js', Buffer.from('window.executed.push(2);')],
    ['js/timing-worker.js', Buffer.from('self.onmessage = function () {};')],
    ['js/decoder.wasm', Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff])],
    ['service/service.js', Buffer.from('module.exports.handle=function(){};')]
  ];
  const downloaded = fixture('1.1.0', { files: opts.missingScript ? files.filter(([p]) => p !== 'js/two.js') : files }), builtin = fixture('1.0.0');
  const store = { 'f1tv.launcher': opts.rawState === undefined ? JSON.stringify(opts.state === undefined ? {} : opts.state) : opts.rawState }, requests = [], scripts = [], timers = new Map(), bases = [], blobs = [];
  let reloaded = 0, seq = 0;
  const head = { firstChild: null, insertBefore: (base) => bases.push(base.href), appendChild() {} };
  const body = { removeAttribute() {}, innerHTML: '', appendChild(s) { scripts.push(s.src || /sourceURL=(.*)/.exec(s.text)[1]); if (opts.scriptFails) s.onerror(); else if (s.src) s.onload(); else vm.runInNewContext(s.text, ctx); } };
  const info = { state: opts.serviceState || { bad: {}, revokes: [] }, failedThisStart: opts.serviceFailed || [], installed: [{ verified: opts.verified !== false, manifest: downloaded.manifest, raw: downloaded.raw, signature: opts.invalidSignature ? Buffer.alloc(64).toString('base64') : downloaded.sig,
    fileBase: 'file:///data/1.1.0/', httpBase: opts.httpBase || 'http://127.0.0.1:18765/bundle/1.1.0/' }] };
  const ctx = { LauncherCommon: common, LauncherConfig: { ...config, keys }, LauncherBuild: { updates: opts.updates !== false, channel: opts.channel }, LauncherBuiltin: builtin,
    location: { href: 'file:///app/launcher/boot.html', reload: () => reloaded++ },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    document: { head, body, createElement: () => ({}), getElementById: () => ({}), importNode: (n) => n },
    DOMParser: class {
      parseFromString(html) {
        if (opts.parseThrows && html.includes('Home')) throw Error('bad DOM');
        const refs = html.includes('Home') ? [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]) : ['$WEBAPIS/webapis/webapis.js', 'js/one.js', 'js/two.js'];
        return { body: { innerHTML: '<main>Home</main>' }, querySelectorAll: (q) => q === 'script' ? refs.map((r) => ({ getAttribute: () => r, parentNode: { removeChild() {} } })) : [] };
      }
    },
    XMLHttpRequest: class {
      open(method, url) { this.method = method; this.url = url; requests.push([method, url]); }
      send() {
        if (this.responseType === 'arraybuffer' && this.url.startsWith('file:')) { this.status = 0; this.response = Uint8Array.from(Buffer.from('built-in ' + this.url)).buffer; return this.onload(); }
        if (this.url.includes('/launcher/info')) { this.status = opts.serviceOffline ? 500 : 200; this.responseText = JSON.stringify(info); return this.onload(); }
        if (this.url.includes('/launcher/')) { this.status = 200; this.responseText = '{}'; return this.onload(); }
        if (opts.fileFails && this.url.startsWith('file:///data')) { this.status = 403; return this.onload(); }
        this.status = this.url.startsWith('file:') ? 0 : 200;
        if (this.responseType === 'arraybuffer') {
          const p = this.url.replace(/^.*1\.1\.0\//, '');
          if (opts.readFails === p) return this.onerror();
          const b = opts.substitute && opts.substitute[p] !== undefined ? Buffer.from(opts.substitute[p]) : files.find(([name]) => name === p)[1];
          this.response = Uint8Array.from(b).buffer;
        } else this.responseText = '<html>bundle</html>';
        this.onload();
      }
    },
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: (id) => timers.delete(id),
    Uint8Array, crypto: opts.crypto, Worker: class { constructor(url) { this.url = url; } },
    URL: { createObjectURL: () => 'blob:worker', revokeObjectURL() {} }, Blob: class { constructor(parts) { blobs.push(parts.join('')); } }
  };
  if (opts.launchHangs) {
    ctx.tizen = { application: { getCurrentApplication: () => ({ appInfo: { packageId: 'F1TVtizen1' } }), launchAppControl() {} },
      ApplicationControl: class {} };
    ctx.ApplicationControl = ctx.tizen.ApplicationControl;
  }
  ctx.window = ctx; ctx.addEventListener = (name, fn) => { ctx[name + "Listener"] = fn; };
  vm.runInNewContext(read('shell/boot.js'), ctx);
  return { ctx, store, requests, scripts, timers, bases, blobs, reloaded: () => reloaded };
}

test('boot stays on file origin, verifies HTTP assets, injects scripts in order and confirms ready', () => {
  const b = bootShell({ fileFails: true, state: { good: '1.0.0' } });
  assert.equal(b.ctx.location.href, 'file:///app/launcher/boot.html');
  assert.deepEqual(b.bases, ['http://127.0.0.1:18765/bundle/1.1.0/']);
  assert.deepEqual(b.scripts, ['http://127.0.0.1:18765/bundle/1.1.0/js/one.js', 'http://127.0.0.1:18765/bundle/1.1.0/js/two.js']);
  assert.ok(b.requests.some(([method, url]) => method === 'POST' && url.endsWith('/launcher/restart?version=1.1.0')));
  assert.equal(b.ctx.Launcher.worker('js/timing-worker.js').url, 'blob:worker');
  b.ctx.Launcher.ready(); b.ctx.Launcher.ready();
  assert.equal(b.timers.size, 0);
  assert.equal(JSON.parse(b.store['f1tv.launcher']).boot, null);
  assert.equal(b.requests.filter(([, u]) => u.includes('/launcher/ready')).length, 1);
});

test('first boot timeout/script error falls back for one start; second failure marks bad', async (t) => {
  for (const scriptFails of [false, true]) {
    await t.test(scriptFails ? 'script load error' : '30-second timeout', () => {
      const b = bootShell({ scriptFails });
      if (!scriptFails) [...b.timers.values()].find((x) => x.ms === 30000).fn();
      const failed = JSON.parse(b.store['f1tv.launcher']);
      assert.equal(failed.failures['1.1.0'], 1); assert.ok(!failed.bad['1.1.0']); assert.equal(b.reloaded(), 1);
      const fallback = bootShell({ state: failed });
      assert.equal(fallback.ctx.Launcher.version, '1.0.0'); fallback.ctx.Launcher.ready();
      const retry = bootShell({ state: JSON.parse(fallback.store['f1tv.launcher']) });
      assert.equal(retry.ctx.Launcher.version, '1.1.0');
      [...retry.timers.values()].find((x) => x.ms === 30000).fn();
      assert.ok(JSON.parse(retry.store['f1tv.launcher']).bad['1.1.0']);
    });
  }
});

test('development shell boots built-in even with a newer valid downloaded bundle', () => {
  const b = bootShell({ updates: false }); assert.equal(b.ctx.Launcher.version, '1.0.0');
  assert.ok(b.bases[0].endsWith('../builtin/'));
});

test('vendored nacl still loads, verifies and hashes when Node crypto is absent', () => {
  const module = { exports: {} };
  vm.runInNewContext(read('shell/vendor/nacl-fast.js'), { module, Uint8Array, Float64Array, require: () => { throw Error('no crypto'); } });
  const nacl = module.exports, f = fixture();
  assert.equal(Buffer.from(nacl.hash(Buffer.from('abc'))).toString('hex'), hash(Buffer.from('abc')));
  assert.equal(nacl.sign.detached.verify(Buffer.from(f.raw), Buffer.from(f.sig, 'base64'), Buffer.from(keys.test, 'base64')), true);
});

/* Runs the real shell listener in a fake package: a working built-in 1.0.0 and a broken downloaded 1.1.0. */
function serviceShell(t, opts = {}) {
  const root = temp(t), files = [
    ['index.html', Buffer.from('Home')],
    ['service/service.js', Buffer.from("exports.calls=[]; exports.onStart=function(o){exports.calls.push(['start',o.externalServer]);exports.launcher=o.launcher;}; exports.onRequest=function(){exports.calls.push(['request']);}; exports.onExit=function(){exports.calls.push(['exit']);}; exports.handle=function(req,res){res.end('media');};")]
  ];
  const builtin = fixture('1.0.0', { files });
  updater.unpack(builtin.archive, path.join(root, 'builtin'), builtin.manifest);
  const svc = updater.create({ root, config: { ...config, keys }, builtin, candidates: [path.join(root, 'data')], build: { updates: true } });
  install(svc, fixture('1.1.0', { files: [['index.html', Buffer.from('Broken')], ['service/service.js', Buffer.from("throw Error('broken load');")]] }));
  let handler, closed = false;
  const timers = new Map(); let seq = 0;
  // Never the runner's own process: the shell's exception guard would hide failing tests.
  const processListeners = {}, fakeProcess = { env: {}, on(name, fn) { processListeners[name] = fn; } };
  const server = { errorHandler: null, listeningHandler: null, listens: 0, free: false };
  const module = { exports: {} };
  const req = (p) => p === './config' ? { ...config, keys } : p === '../launcher-build' ? { updates: true } :
    p === './builtin.json' ? builtin : p === './common' ? common : p === './updater' ? { ...updater, create: () => svc } :
    p === 'http' ? { createServer: (h) => { handler = h; return { on(name, fn) { if (name === 'error') server.errorHandler = fn; if (name === 'listening') server.listeningHandler = fn; },
      listen(port, addr) { server.listens++; assert.equal(port, 18765); assert.equal(addr, '127.0.0.1'); if (server.free) server.listeningHandler(); }, close() { closed = true; } }; } } : require(p);
  req.cache = require.cache;
  vm.runInNewContext(read('shell/service.js'), { require: req, module, __dirname: path.join(root, 'launcher'), Buffer, process: fakeProcess, tizen: opts.tizen, console: { log() {} }, setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: (id) => timers.delete(id) });
  module.exports.onStart();
  function call(url, method = 'GET', origin) {
    const res = { writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; }, destroy() { this.destroyed = true; } };
    handler({ url, method, headers: { origin } }, res); return res;
  }
  return { root, files, svc, module, call, timers, closed: () => closed, processListeners, server };
}

test('exceptions escaping bundle helper callbacks are kept and shown, and the listener keeps answering', (t) => {
  const { call, processListeners } = serviceShell(t);
  assert.equal(typeof processListeners.uncaughtException, 'function');
  assert.equal(typeof processListeners.unhandledRejection, 'function');
  processListeners.uncaughtException(new Error('bad audio box'));
  processListeners.unhandledRejection('rejected');
  for (let i = 0; i < 12; i++) processListeners.uncaughtException(new Error('again ' + i));
  assert.equal(JSON.parse(call('/ping').body).ok, true);
  const errors = JSON.parse(call('/launcher/info').body).errors;
  assert.equal(errors.count, 14);
  assert.equal(errors.last.length, 10, 'only the latest ten are kept');
  assert.match(errors.last[9].error, /again 11/); assert.equal(errors.last[9].version, '1.0.0');
});

test('a port still held by a previous helper process is retried every 2 s for a minute', (t) => {
  const { server, timers } = serviceShell(t);
  assert.equal(server.listens, 1);
  const busy = Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
  for (let i = 0; i < 31; i++) {
    server.errorHandler(busy);
    const retry = [...timers.entries()].find(([, x]) => x.ms === 2000);
    if (i < 30) { assert.ok(retry, 'retry ' + (i + 1)); timers.delete(retry[0]); retry[1].fn(); }
    else assert.ok(!retry, 'gives up after 30 retries');
  }
  assert.equal(server.listens, 31);
  server.errorHandler(Object.assign(new Error('denied'), { code: 'EACCES' }));
  assert.ok(![...timers.values()].some((x) => x.ms === 2000), 'other errors are not retried');
});

test('the service listener runs the newest delegate, rolls back a throwing one, gives it the launcher API and checks at page starts', (t) => {
  const { root, svc, module, call, timers } = serviceShell(t);
  assert.equal(JSON.parse(call('/ping').body).version, '1.0.0', 'the built-in runs after the broken newest rolled back');
  assert.equal(svc.state.failures['1.1.0'], 1, 'the broken newest counted one failed start');
  assert.ok(!svc.state.bad['1.1.0']);
  assert.deepEqual(svc.state.events.map((e) => [e.version, e.reason]), [['1.1.0', 'service: broken load']], 'kept for the next bundle to report');
  const delegate = require(path.join(root, 'builtin/service/service.js'));
  assert.deepEqual(delegate.calls, [['start', true]]);
  assert.equal(delegate.launcher.shellLevel, 1);
  assert.deepEqual(['status', 'install', 'checked'].map((k) => typeof delegate.launcher[k]), ['function', 'function', 'function']);
  module.exports.onRequest();
  assert.deepEqual(delegate.calls, [['start', true], ['request']]);
  assert.ok(![...timers.values()].some((x) => x.ms === 300000), 'no update timer of its own: the bundle checks hourly');
  let starts = 0; svc.startCheck = () => starts++;
  call('/launcher/info'); assert.equal(starts, 0);
  call('/launcher/info?start=1&retry=1'); assert.equal(starts, 1, 'the shell checks at each app start');
});

test('failed starts are kept as events until a bundle acknowledges them; at most twenty', (t) => {
  const { svc, call } = serviceShell(t);
  call('/launcher/info?start=1&retry=1');
  assert.equal(call('/launcher/mark?version=1.0.0&reason=start%20timeout', 'POST').code, 200);
  assert.equal(call('/launcher/mark?version=1.0.0&reason=%3Cscript%3E', 'POST').code, 200);
  let events = JSON.parse(call('/launcher/info').body).state.events;
  assert.deepEqual(events.map((e) => e.reason), ['service: broken load', 'page: start timeout'], 'one per failed start; odd reasons are not kept');
  assert.equal(call('/launcher/ack?through=' + events[0].id, 'POST').code, 200);
  events = JSON.parse(call('/launcher/info').body).state.events;
  assert.deepEqual(events.map((e) => e.reason), ['page: start timeout']);
  assert.equal(call('/launcher/ack?through=x', 'POST').code, 500);
  for (let i = 0; i < 30; i++) svc.event('1.0.0', 'x' + i);
  assert.equal(svc.state.events.length, 20); assert.equal(svc.state.events.at(-1).reason, 'x29');
});

test('bundles install through the launcher API: signature, hashes, shell level, bad and revoked versions all checked', (t) => {
  const { svc, root } = serviceShell(t);
  const api = require(path.join(root, 'builtin/service/service.js')).launcher;
  const good = fixture('1.2.0'), high = fixture('2.0.0', { minShell: 2, revokes: ['1.3.0'] });
  assert.throws(() => api.install(good.raw, Buffer.alloc(64).toString('base64'), good.archive), /Invalid signature/);
  assert.throws(() => api.install(good.raw, good.sig, Buffer.from('tampered')), /Archive hash mismatch/);
  assert.throws(() => api.install(good.raw, good.sig, null), /No archive/);
  // A newer-shell manifest: refused, but its revokes count (they arrive this way when only the bundle downloads).
  assert.throws(() => api.install(Buffer.from(high.raw), Buffer.from(high.sig), null), /Needs reinstall/);
  assert.ok(svc.state.revokes.includes('1.3.0'));
  const revoked = fixture('1.3.0');
  assert.throws(() => api.install(revoked.raw, revoked.sig, revoked.archive), /Bad or revoked/);
  assert.equal(api.install(Buffer.from(good.raw), Buffer.from(good.sig), good.archive).version, '1.2.0');
  const st = api.status();
  assert.equal(st.newest, '1.2.0'); assert.equal(st.shellLevel, 1); assert.equal(st.enabled, true);
  assert.ok(st.blocked.includes('1.3.0'));
});

test('a bundle check report sets the shared clock and the release list the page reads; junk is dropped', (t) => {
  const { svc, root, call } = serviceShell(t);
  const api = require(path.join(root, 'builtin/service/service.js')).launcher;
  api.checked({ ok: true, deferred: true, releases: [{ version: '2.0.0', minShell: 2, notes: 'New shell' }, { version: 'bad' }, null,
    { version: '1.0.0', notes: 'x'.repeat(20000), minShell: 0.5 }], skipped: [{ version: '1.9.0', reason: 'Size limit' }] });
  assert.ok(svc.state.lastCheck > 0); assert.equal(svc.state.checkFailed, false); assert.equal(api.status().deferred, true);
  assert.deepEqual(svc.state.releases.map((r) => r.version), ['2.0.0', '1.0.0']);
  assert.equal(svc.state.releases[1].notes.length, 16000); assert.equal(svc.state.releases[1].minShell, undefined);
  const page = JSON.parse(call('/launcher/check?cached=1', 'POST').body);
  assert.equal(page.needsReinstall, '2.0.0'); assert.deepEqual(page.skipped, [{ version: '1.9.0', reason: 'Size limit' }]);
  api.checked({ ok: false, error: 'offline' });
  assert.equal(svc.state.checkFailed, true); assert.equal(svc.state.releases.length, 2, 'a failure keeps what was known');
  assert.equal(call('/launcher/check?cached=1', 'POST').code, 502);
  api.checked('nonsense'); assert.equal(svc.state.checkFailed, true);
});

test('a broken bundle service is retried once per page start and marked bad on its second failure', (t) => {
  const { svc, call } = serviceShell(t);
  call('/launcher/info?start=1&retry=1');
  call('/launcher/ready?version=1.0.0', 'POST');
  assert.equal(call('/launcher/restart?version=1.1.0', 'POST').code, 500);
  assert.equal(svc.state.failures['1.1.0'], 1, 'same-start service retries do not count twice');
  call('/launcher/info?start=1&retry=0');
  assert.equal(call('/launcher/restart?version=1.1.0', 'POST').code, 500);
  assert.equal(svc.state.failures['1.1.0'], 1, 'a rollback reload does not retry the broken service');
  call('/launcher/info?start=1&retry=1');
  assert.equal(call('/launcher/restart?version=1.1.0', 'POST').code, 500);
  assert.equal(svc.state.failures['1.1.0'], 2); assert.match(svc.state.bad['1.1.0'], /service/);
});

test('mark and ready for versions that are not installed are ignored without touching state', (t) => {
  const { svc, call } = serviceShell(t);
  call('/launcher/ready?version=1.0.0', 'POST');
  const before = JSON.stringify(svc.state);
  for (const route of ['mark', 'ready', 'mark']) {
    const response = call('/launcher/' + route + '?version=1.2.0', 'POST', 'null');
    assert.equal(response.code, 200); assert.equal(JSON.parse(response.body).ignored, true);
    assert.equal(JSON.stringify(svc.state), before);
  }
});

test('launcher mutation routes require POST and the local origin, and settings persist', (t) => {
  const { svc, call } = serviceShell(t);
  assert.equal(call('/launcher/restart?version=1.0.0').code, 405);
  assert.equal(call('/launcher/restart?version=1.0.0', 'POST', 'https://evil.test').code, 403);
  call('/launcher/settings?updates=0', 'POST'); assert.equal(svc.state.updates, false);
  call('/launcher/settings?updates=1', 'POST'); assert.equal(svc.state.updates, true);
});

test('a restart reloads a newer verified delegate in place and serves bundle files safely', (t) => {
  const { root, files, svc, module, call, closed } = serviceShell(t);
  const delegate = require(path.join(root, 'builtin/service/service.js'));  // the instance onStart loaded
  install(svc, fixture('1.2.0', { files }));
  assert.equal(call('/launcher/restart?version=1.2.0', 'POST', 'null').code, 200);
  assert.equal(JSON.parse(call('/ping').body).version, '1.2.0');
  assert.deepEqual(delegate.calls.at(-1), ['exit'], 'the previous delegate was unloaded');
  assert.equal(call('/media').body, 'media');
  assert.equal(call('/bundle/1.2.0/index.html').body.toString(), 'Home');
  assert.equal(call('/bundle/1.2.0/%2e%2e/config.js').code, 500);
  fs.writeFileSync(path.join(root, 'data/bundles/1.2.0/index.html'), 'Tampered');
  assert.equal(call('/bundle/1.2.0/index.html').code, 200, 'folder was already verified this process');
  const info = JSON.parse(call('/launcher/info').body);
  assert.equal(info.modules.crypto, true); assert.equal(info.candidates[0].writable, true); assert.equal(info.dataFolder, path.join(root, 'data'));
  module.exports.onExit(); assert.equal(closed(), true);
});

test('network downloader follows bounded redirects, rejects HTTP downgrade and bounds streamed bytes', async () => {
  const { EventEmitter } = require('node:events');
  let mode, calls;
  const transport = { get(opts, cb) {
    calls.push(opts);
    const req = new EventEmitter(); req.abort = () => {};
    setImmediate(() => {
      const res = new EventEmitter(); res.resume = () => {}; res.headers = {};
      if (mode === 'redirect' && calls.length === 1) { res.statusCode = 302; res.headers.location = 'https://assets.test/final'; cb(res); }
      else if (mode === 'downgrade') { res.statusCode = 302; res.headers.location = 'http://assets.test/final'; cb(res); }
      else { res.statusCode = 200; cb(res); res.emit('data', Buffer.from(mode === 'large' ? 'oversized' : 'ok')); res.emit('end'); }
    });
    return req;
  } };
  const module = { exports: {} };
  vm.runInNewContext(read('shell/updater.js'), { require: (p) => p === 'https' || p === 'http' ? transport : p === './common' ? common : require(p), module, Buffer, Uint8Array, setTimeout, clearTimeout });
  const run = (url = 'https://github.test/start') => new Promise((resolve, reject) => module.exports.download(url, 4, (e, b) => e ? reject(e) : resolve(b)));
  mode = 'redirect'; calls = []; assert.equal((await run()).toString(), 'ok'); assert.equal(calls[1].hostname, 'assets.test');
  assert.equal(calls[0].headers.Accept, 'application/octet-stream');
  assert.equal(calls[1].headers.Accept, 'application/octet-stream');
  mode = 'redirect'; calls = []; await run('https://api.github.com/start');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[1].headers.Accept, 'application/octet-stream');
  mode = 'downgrade'; calls = []; await assert.rejects(run(), /HTTPS required/);
  mode = 'large'; calls = []; await assert.rejects(run(), /Size limit/);
});

test('a certificate the TV cannot check is retried unverified; other network errors are not', async () => {
  const { EventEmitter } = require('node:events');
  let calls, firstError;
  const transport = { get(opts, cb) {
    calls.push(opts);
    const req = new EventEmitter(); req.abort = () => {};
    setImmediate(() => {
      if (calls.length === 1 && firstError) return req.emit('error', Object.assign(new Error('tls'), { code: firstError }));
      const res = new EventEmitter(); res.resume = () => {}; res.headers = {}; res.statusCode = 200;
      cb(res); res.emit('data', Buffer.from('ok')); res.emit('end');
    });
    return req;
  } };
  const module = { exports: {} };
  vm.runInNewContext(read('shell/updater.js'), { require: (p) => p === 'https' || p === 'http' ? transport : p === './common' ? common : require(p), module, Buffer, Uint8Array, setTimeout, clearTimeout });
  const run = () => new Promise((resolve) => module.exports.download('https://github.test/x', 4, (e, b, unverified) => resolve({ e, b, unverified })));
  firstError = null; calls = [];
  let r = await run(); assert.equal(r.b.toString(), 'ok'); assert.equal(r.unverified, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].rejectUnauthorized, undefined, 'certificates are checked by default');
  for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    firstError = code; calls = [];
    r = await run(); assert.equal(r.b.toString(), 'ok', code); assert.equal(r.unverified, true, code);
    assert.equal(calls.length, 2); assert.equal(calls[1].rejectUnauthorized, false);
  }
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND']) {
    firstError = code; calls = [];
    r = await run(); assert.equal(r.e.code, code); assert.equal(calls.length, 1, code + ' is not retried');
  }
});

test('a certificate from an authority the TV lacks: the real HTTPS download still arrives, marked unverified', async (t) => {
  const https = require('node:https'), dir = temp(t), key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
  if (made.status !== 0) return t.skip('openssl unavailable');
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => res.end('signed bytes'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const r = await new Promise((resolve) => updater.download('https://127.0.0.1:' + server.address().port + '/x', 1024, (e, b, unverified) => resolve({ e, b, unverified })));
  assert.ifError(r.e); assert.equal(r.b.toString(), 'signed bytes'); assert.equal(r.unverified, true);
});

test('release notes from an unverified connection are dropped; the update itself still installs', async (t) => {
  const f = fixture();
  for (const unverified of [false, true]) {
    const { svc } = service(t, { download(u, limit, cb) {
      if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('1.1.0', 'Faster feed switching')])), unverified);
      cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive, unverified);
    } });
    const result = await new Promise((resolve, reject) => svc.check((e, r) => e ? reject(e) : resolve(r)));
    assert.equal(result.downloaded, '1.1.0', 'signed bundle installs either way');
    assert.equal(result.releases[0].notes, unverified ? '' : 'Faster feed switching');
    assert.equal(!!svc.info().lastUnverifiedDownload, unverified);
  }
});

test('a check reaching its download decision during playback defers the archive, and tells the bundle', async (t) => {
  const f = fixture(); let archives = 0, startsPlaying = true;
  const { svc } = service(t, { download(u, limit, cb) {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('1.1.0')])));
    if (u.endsWith('.sig')) { if (startsPlaying) svc.setPlayback(true); return cb(null, Buffer.from(f.sig)); }
    if (u.endsWith('.json')) return cb(null, Buffer.from(f.raw));
    archives++; cb(null, f.archive);
  } });
  await new Promise((resolve, reject) => svc.check((e, r) => e ? reject(e) : resolve(r)));
  assert.equal(archives, 0); assert.equal(svc.bundleStatus().deferred, true);
  // Up to date during playback: nothing was put off.
  startsPlaying = false; svc.setPlayback(false); await new Promise((resolve) => svc.check(() => resolve()));
  assert.equal(archives, 1);
  svc.setPlayback(true); await new Promise((resolve) => svc.check(() => resolve()));
  assert.equal(svc.bundleStatus().deferred, false);
});

test('repeated interrupted page starts sync the bad mark to service diagnostics before reloading', () => {
  const b = bootShell({ state: { failures: { '1.1.0': 1 }, boot: { version: '1.1.0', failed: false } } });
  assert.equal(b.reloaded(), 1);
  assert.ok(JSON.parse(b.store['f1tv.launcher']).bad['1.1.0']);
  assert.ok(b.requests.some(([method, url]) => method === 'POST' && url.endsWith('/launcher/mark?version=1.1.0')));
  assert.equal(b.scripts.length, 0);
});

test('built-in is always the last resort even when marked bad, revoked, or below the usual compatibility filter', () => {
  const builtin = { ...fixture('2.0.0'), builtin: true };
  const state = { bad: { '2.0.0': 'false positive', '1.0.0': 'failed' }, revokes: ['2.0.0'] };
  assert.equal(common.select([fixture('1.0.0'), builtin], 1, state), builtin);
  assert.equal(common.select([fixture('1.9.0'), builtin], 1, state).manifest.version, '1.9.0');
  assert.equal(common.begin(state, '2.0.0', true), true);
  const boot = bootShell({ state: { bad: { '1.0.0': true, '1.1.0': true }, revokes: ['1.0.0'] } });
  assert.equal(boot.ctx.Launcher.version, '1.0.0');
  assert.ok(boot.ctx.Launcher.blockedUpdates.includes('1.1.0'));
});

test('page verifies downloaded files independently; offline/invalid signature uses builtin', () => {
  const boot = bootShell();
  assert.equal(boot.ctx.Launcher.version, '1.1.0');
  assert.ok(!boot.requests.some(([, u]) => /file:\/\/\/data/.test(u) || /service\/service.js/.test(u)));
  for (const opts of [{ serviceOffline: true }, { invalidSignature: true }]) {
    const b = bootShell(opts);
    assert.equal(b.ctx.Launcher.version, '1.0.0');
    assert.equal(b.scripts.length, 2);
    assert.equal(b.reloaded(), 0);
  }
  const failedService = bootShell({ serviceFailed: ['1.1.0'], serviceState: { bad: {}, failures: { '1.1.0': 1 } } });
  assert.equal(failedService.ctx.Launcher.version, '1.0.0');
  assert.equal(JSON.parse(failedService.store['f1tv.launcher']).failures['1.1.0'], 1);
});

test('page and service observing the same interrupted start do not double-count it', () => {
  const b = bootShell({ state: { boot: { version: '1.1.0', failed: false } }, serviceState: { bad: {}, failures: { '1.1.0': 1 } } });
  assert.equal(b.ctx.Launcher.version, '1.1.0');
  const state = JSON.parse(b.store['f1tv.launcher']);
  assert.equal(state.failures['1.1.0'], 1); assert.ok(!state.bad['1.1.0']);
});

test('newest-first check skips missing/invalid bundles, stops at compatible manifest and retains all release notes', async (t) => {
  const high = fixture('5.0.0', { minShell: 2 }), compatible = fixture('2.0.0');
  const calls = [], list = [release('1.0.0', 'Old notes'), release('2.0.0', 'New notes'), release('3.0.0'),
    { tag_name: 'v4.0.0', prerelease: false, body: 'Old packaging', assets: [] }, release('5.0.0', 'Shell notes'), release('6.0.0')];
  const { svc } = service(t, { download(u, limit, cb) {
    calls.push(u);
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify(list)));
    if (u.includes('/v1.0.0/')) throw Error('must not request older manifest');
    if (u.includes('/v6.0.0/')) return cb(null, Buffer.from('invalid JSON'));
    const f = u.includes('/v5.0.0/') ? high : compatible;
    if (u.includes('/v3.0.0/')) return cb(null, Buffer.from(u.endsWith('.sig') ? 'bad signature' : f.raw));
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
  } });
  const result = await new Promise((resolve, reject) => svc.check((e, r) => e ? reject(e) : resolve(r)));
  assert.equal(result.downloaded, '2.0.0'); assert.equal(result.needsReinstall, '5.0.0');
  assert.deepEqual(result.skipped.map((r) => r.version), ['6.0.0', '4.0.0', '3.0.0']);
  assert.equal(result.releases.at(-1).notes, 'Old notes');
  assert.ok(!calls.some((u) => u.includes('/v4.0.0/')));
  assert.equal(calls.filter((u) => u.includes('api.github')).length, 1);
  const at = svc.state.downloads['2.0.0'];
  assert.ok(at > 0);
  await new Promise((resolve, reject) => svc.check((e, r) => e ? reject(e) : resolve(r)));
  assert.equal(svc.state.downloads['2.0.0'], at, 'a check must not reset the download time');
  const fresh = updater.create({ root: path.dirname(svc.info().dataFolder), config: { ...config, keys }, builtin: fixture('1.0.0'), candidates: [svc.info().dataFolder], build: { updates: true } });
  assert.equal(fresh.state.downloads['2.0.0'], at, 'download age survives a new service process');
});

test('folder verification is cached across info, selection and asset lookup; cleanup invalidates removed folders', (t) => {
  const { svc, root } = service(t); install(svc, fixture('1.1.0'));
  const create = () => updater.create({ root, config: { ...config, keys }, builtin: fixture('1.0.0'), candidates: [path.join(root, 'data')], build: { updates: true } });
  const fresh = create(), readFile = fs.readFileSync; let reads = 0;
  fs.readFileSync = (p, ...args) => { if (String(p).includes('/bundles/1.1.0/')) reads++; return readFile(p, ...args); };
  try {
    fresh.info(); assert.equal(reads, 4, 'manifest, signature and two signed files');
    fresh.info(); fresh.selected(); fresh.bundle('1.1.0'); assert.equal(reads, 4);
    install(fresh, fixture('1.2.0')); install(fresh, fixture('1.3.0'));
    assert.equal(fresh.bundle('1.1.0'), undefined);
    fresh.setActive('1.1.0');
    const replacement = fixture('1.1.0', { files: [['index.html', Buffer.from('Replacement')], ['service/service.js', Buffer.from('module.exports.handle=function(){};')]] });
    install(fresh, replacement);
    assert.equal(fresh.bundle('1.1.0').raw, replacement.raw);
  } finally { fs.readFileSync = readFile; }
});

test('untrusted service cannot substitute HTML, scripts or workers, and cannot choose the code origin', async (t) => {
  const good = bootShell({ verified: false, httpBase: 'https://evil.test/' });
  assert.deepEqual(Array.from(good.ctx.executed), [1, 2]);
  assert.ok(good.requests.every(([, u]) => !u.includes('evil.test')));
  assert.ok(good.scripts.every((u) => u.startsWith('http://127.0.0.1:18765/bundle/1.1.0/')));
  good.ctx.Launcher.worker('js/timing-worker.js');
  assert.match(good.blobs[0], /^self.onmessage/); assert.doesNotMatch(good.blobs[0], /importScripts/);
  assert.throws(() => good.ctx.Launcher.worker('js/unsigned-worker.js'), /Unverified/);
  for (const opts of [
    { substitute: { 'index.html': '<body onload="evil()">evil</body>' } },
    { substitute: { 'js/one.js': 'window.executed = [9];' } }, // same byte length, different hash
    { substitute: { 'js/two.js': 'evil()' } },
    { substitute: { 'js/timing-worker.js': 'evil()' } },
    { missingScript: true }, { readFails: 'js/one.js' }
  ]) {
    await t.test('rejected: ' + JSON.stringify(opts), () => {
      const boot = bootShell(opts);
      assert.equal(boot.scripts.length, 0); assert.equal(boot.ctx.executed, undefined);
      assert.equal(boot.reloaded(), 1);
      const state = JSON.parse(boot.store['f1tv.launcher']);
      assert.equal(state.failures['1.1.0'], 1);
      assert.equal(bootShell({ state }).ctx.Launcher.version, '1.0.0');
    });
  }
});

test('page prefers subtle SHA-512 and falls back when absent, throwing or rejecting; files hash once', async (t) => {
  for (const mode of ['native', 'throw', 'reject']) {
    await t.test('digest ' + mode, async () => {
      const calls = [];
      const boot = bootShell({ crypto: { subtle: { digest(name, bytes) {
        calls.push(Buffer.from(bytes).toString()); assert.equal(name, 'SHA-512');
        if (mode === 'throw') throw Error('unsupported');
        if (mode === 'reject') return Promise.reject(Error('unsupported'));
        return Promise.resolve(Uint8Array.from(crypto.createHash('sha512').update(bytes).digest()).buffer);
      } } } });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.deepEqual(Array.from(boot.ctx.executed), [1, 2]);
      boot.ctx.Launcher.worker('js/timing-worker.js'); boot.ctx.Launcher.worker('js/timing-worker.js');
      assert.equal(calls.length, 4); assert.equal(new Set(calls).size, 4);
    });
  }
});

test('page only imports bad marks and failures for authenticated installed versions', () => {
  const boot = bootShell({ serviceState: { bad: { '9.0.0': true }, failures: { '9.0.0': 99 } } });
  const state = JSON.parse(boot.store['f1tv.launcher']);
  assert.equal(state.bad['9.0.0'], undefined); assert.equal(state.failures['9.0.0'], undefined);
  boot.ctx.Launcher.setUpdates(false); boot.ctx.Launcher.setUpdates(true);
  assert.ok(boot.requests.some(([m, u]) => m === 'POST' && u.endsWith('/settings?updates=0')));
  assert.ok(boot.requests.some(([m, u]) => m === 'POST' && u.endsWith('/settings?updates=1')));
});

test('malformed page and service state cannot prevent builtin recovery', async (t) => {
  for (const raw of ['null', 'true', '42', '"text"', '[]', '{', JSON.stringify({ bad: [], failures: true, revokes: {}, boot: 'oops', good: [], downloads: false }),
    JSON.stringify({ bad: { '1.1.0': {} }, failures: { '1.1.0': 'oops' }, revokes: [null, 1, {}, 'bad'], boot: { version: false } })]) {
    await t.test('state ' + JSON.stringify(raw), (st) => {
      const page = bootShell({ rawState: raw, serviceOffline: true });
      assert.equal(page.ctx.Launcher.version, '1.0.0'); assert.equal(page.scripts.length, 2);
      page.ctx.Launcher.ready(); assert.equal(JSON.parse(page.store['f1tv.launcher']).boot, null);
      const root = temp(st), data = path.join(root, 'data'); fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, 'launcher-state.json'), raw);
      const svc = updater.create({ root, config, builtin: fixture('1.0.0'), candidates: [data], build: { updates: true } });
      assert.equal(svc.selected().builtin, true);
      common.begin(svc.state, '1.0.0', true); common.ready(svc.state, '1.0.0'); svc.save();
      assert.equal(svc.state.boot, null);
    });
  }
  const page = bootShell({ parseThrows: true });
  assert.equal(page.ctx.Launcher.version, '1.0.0'); assert.equal(page.scripts.length, 2);
});

test('the shell checks at each app start unless one succeeded in the last 5 minutes; cached answers never go online', (t) => {
  let now = 100000000, calls = 0, fail = false;
  const oldNow = Date.now; Date.now = () => now; t.after(() => { Date.now = oldNow; });
  const root = temp(t), data = path.join(root, 'data');
  const f = fixture('1.0.0');
  const mod = updater.create({ root, config: { ...config, keys }, builtin: f, candidates: [data], build: { updates: true },
    download(u, limit, cb) { calls++; if (fail) return cb(Error('offline'));
      cb(null, Buffer.from(u.includes('api.github') ? JSON.stringify([release('1.0.0')]) : u.endsWith('.sig') ? f.sig : f.raw)); } });
  mod.state.updates = false; mod.startCheck(); assert.equal(calls, 0, 'automatic checks off');
  mod.state.updates = true; mod.setPlayback(true); mod.startCheck(); assert.equal(calls, 0, 'not while playing');
  mod.setPlayback(false); mod.startCheck(); assert.equal(calls, 3); assert.equal(mod.state.lastCheck, now);
  now += 299000; mod.startCheck(); assert.equal(calls, 3, 'a quick restart');
  now += 1000; mod.startCheck(); assert.equal(calls, 6, 'five minutes on: checks again');
  now -= 86400000; mod.startCheck(); assert.equal(calls, 9, 'a clock set back checks, never stalls');
  fail = true; now += 1000; mod.startCheck(); assert.equal(calls, 9);
  now += 300000; mod.startCheck(); assert.equal(calls, 10); assert.equal(mod.state.checkFailed, true);
  now += 1000; mod.startCheck(); assert.equal(calls, 11, 'after a failure, the next start checks again');
  // The page asks with cached=1: always local, an error while the last check failed.
  let failure; mod.check(true, (err) => { failure = err; }); assert.equal(calls, 11); assert.match(String(failure), /last update check failed/);
  mod.check(false, () => {}); assert.equal(calls, 12, 'a forced check goes online');
  fail = false; mod.check(false, () => {}); assert.equal(calls, 15);
  let answer; mod.check(true, (err, r) => { answer = r; }); assert.equal(calls, 15);
  assert.deepEqual(answer.releases.map((r) => r.version), ['1.0.0']);
  // A bundle's report counts like the shell's own check.
  now += 3600000; mod.checked({ ok: true, releases: [{ version: '1.0.0' }] }); mod.startCheck(); assert.equal(calls, 15);
  mod.state.updates = false; mod.save();
  const fresh = updater.create({ root, config, builtin: f, candidates: [data], build: { updates: true } });
  assert.equal(fresh.state.updates, false);
});

test('ENOSPC and exceptions in asynchronous check completions release busy and call back once', async (t) => {
  const f = fixture(), root = temp(t); let full = false, mode = 'normal';
  const stub = Object.create(fs);
  stub.writeFileSync = (...args) => { if (full) throw Object.assign(Error('ENOSPC'), { code: 'ENOSPC' }); return fs.writeFileSync(...args); };
  const module = { exports: {} };
  vm.runInNewContext(read('shell/updater.js'), { require: (p) => p === 'fs' ? stub : p === './common' ? common : require(p), module, Buffer, process, Date });
  const svc = module.exports.create({ root, config: { ...config, keys }, builtin: fixture('1.0.0'), candidates: [path.join(root, 'data')], build: { updates: true },
    download(u, limit, cb) { setImmediate(() => {
      if (mode === 'json') return cb(null, Buffer.from('invalid'));
      const value = u.includes('api.github') ? Buffer.from(JSON.stringify([release('1.1.0')])) : u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive;
      cb(null, value); cb(null, value); // misbehaving transport must not complete twice
    }); } });
  const check = () => new Promise((resolve) => { let n = 0; svc.check((err, result) => { assert.equal(++n, 1); resolve({ err, result }); }); });
  full = true; assert.doesNotThrow(() => svc.save());
  assert.match((await check()).err.message, /ENOSPC/);
  assert.match((await check()).err.message, /ENOSPC/);
  full = false; mode = 'json'; assert.ok((await check()).err);
  mode = 'normal'; assert.equal((await check()).result.downloaded, '1.1.0');
  full = true; const result = await check(); assert.ifError(result.err); assert.equal(result.result.downloaded, '1.1.0');
});

test('installed signed revocations survive loss of state, including builtin revocations', (t) => {
  const { svc, root } = service(t); install(svc, fixture('1.1.0', { revokes: ['0.9.0'] }));
  install(svc, fixture('1.2.0', { revokes: ['0.8.0'] }));
  fs.unlinkSync(path.join(root, 'data/launcher-state.json'));
  const fresh = updater.create({ root, config: { ...config, keys }, builtin: fixture('1.0.0', { revokes: ['0.7.0'] }), candidates: [path.join(root, 'data')], build: { updates: true } });
  fresh.installed(); assert.deepEqual(fresh.state.revokes.sort(), ['0.7.0', '0.8.0', '0.9.0']);
  assert.deepEqual(JSON.parse(read(path.join(root, 'data/launcher-state.json'))).revokes.sort(), fresh.state.revokes);
});

test('valid installed folders and corrupt active folders cannot be overwritten', (t) => {
  const { svc, root } = service(t), f = fixture(); install(svc, f);
  const other = fixture('1.1.0', { files: [['index.html', Buffer.from('different')], ['service/service.js', Buffer.from('service')]] });
  assert.throws(() => install(svc, other), /Version already exists/);
  svc.setActive('1.1.0'); fs.writeFileSync(path.join(root, 'data/bundles/1.1.0/index.html'), 'corrupt');
  assert.throws(() => install(svc, f), /active/);
  assert.equal(read(path.join(root, 'data/bundles/1.1.0/index.html')), 'corrupt');
});

test('bad or revoked newest release does not hide a good older update; scanning stops at installed version', async (t) => {
  for (const blocked of ['bad', 'revoked']) {
    const files = { '1.3.0': fixture('1.3.0', { revokes: blocked === 'revoked' ? ['1.3.0', '0.8.0'] : ['0.8.0'] }), '1.2.0': fixture('1.2.0') }, calls = [];
    const { svc } = service(t, { download(u, size, cb) {
      calls.push(u);
      if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify(['1.3.0', '1.2.0', '1.0.0'].map((v) => release(v)))));
      const f = files[/\/v([^/]+)\//.exec(u)[1]]; assert.ok(f, 'must stop before 1.0.0');
      cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
    } });
    if (blocked === 'bad') svc.state.bad['1.3.0'] = true;
    const check = () => new Promise((resolve, reject) => svc.check((err, value) => err ? reject(err) : resolve(value)));
    assert.equal((await check()).downloaded, '1.2.0'); assert.ok(svc.state.revokes.includes('0.8.0'));
    svc.setActive('1.2.0');
    assert.equal((await check()).downloaded, null);
    assert.equal(calls.filter((u) => u.endsWith('.tar')).length, 1);
  }
});

test('the download deadline grows with the size limit (60 s plus the limit at 32 kB/s)', () => {
  const delays = [], oldSet = global.setTimeout;
  global.setTimeout = (fn, ms) => { delays.push(ms); return oldSet(() => {}, 0); };
  try {
    updater.download('http://127.0.0.1:1/x', 1048576, () => {});
    updater.download('http://127.0.0.1:1/x', 8 * 1048576, () => {});
  } finally { global.setTimeout = oldSet; }
  assert.deepEqual(delays, [60000 + 32768, 60000 + 262144]);
});

test('Launcher.file hands a bundle any of its files, only as signed: bytes, refusals and the built-in', async () => {
  const opts = {}, b = bootShell(opts);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(b.ctx.Launcher.version, '1.1.0');
  const file = (p) => new Promise((resolve) => b.ctx.Launcher.file(p, (err, bytes) => resolve({ err, bytes })));
  const wasm = await file('js/decoder.wasm');
  assert.ifError(wasm.err); assert.deepEqual(Array.from(wasm.bytes), [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff]);
  assert.ok(b.requests.some(([, u]) => u === 'http://127.0.0.1:18765/bundle/1.1.0/js/decoder.wasm'));
  assert.match(String((await file('js/evil.js')).err), /Unsigned file/);
  assert.match(String((await file('../config.js')).err), /Unsigned file/);
  opts.substitute = { 'js/decoder.wasm': Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xfe]) };
  const swapped = await file('js/decoder.wasm');
  assert.match(String(swapped.err), /File hash mismatch/); assert.equal(swapped.bytes, undefined);
  opts.substitute = { 'js/decoder.wasm': Buffer.from([0]) };
  assert.match(String((await file('js/decoder.wasm')).err), /File size mismatch/);
  const builtin = bootShell({ updates: false });
  const own = await new Promise((resolve) => builtin.ctx.Launcher.file('img/logo.png', (err, bytes) => resolve({ err, bytes })));
  assert.ifError(own.err); assert.match(Buffer.from(own.bytes).toString(), /^built-in file:\/\/\/app\/launcher\/\.\.\/builtin\/img\/logo\.png$/);
});

test('the helper serves bundle files with their content type, WebAssembly included', (t) => {
  const { svc, call } = serviceShell(t);
  const files = [['index.html', Buffer.from('Home')], ['js/d.wasm', Buffer.from([0, 0x61, 0x73, 0x6d])], ['fonts/x.ttf', Buffer.from('ttf')],
    ['service/service.js', Buffer.from("exports.handle=function(req,res){res.end('media');};")]];
  install(svc, fixture('1.2.0', { files }));
  assert.equal(call('/bundle/1.2.0/js/d.wasm').headers['Content-Type'], 'application/wasm');
  assert.equal(call('/bundle/1.2.0/fonts/x.ttf').headers['Content-Type'], 'font/ttf');
  assert.equal(call('/bundle/1.2.0/index.html').headers['Content-Type'], 'text/html');
});

test('after the port retries run out, the next start or request listens again', (t) => {
  const { server, timers, module } = serviceShell(t);
  const busy = Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
  for (let i = 0; i < 31; i++) {
    server.errorHandler(busy);
    const retry = [...timers.entries()].find(([, x]) => x.ms === 2000);
    if (retry) { timers.delete(retry[0]); retry[1].fn(); }
  }
  assert.equal(server.listens, 31);
  server.free = true;
  module.exports.onRequest();
  assert.equal(server.listens, 32, 'a fresh round');
  module.exports.onRequest();
  assert.equal(server.listens, 32, 'listening now: nothing more');
});

test('a helper request that throws gets a 500, or a closed connection once its answer has started', (t) => {
  const { root, svc, call } = serviceShell(t);
  const delegate = require(path.join(root, 'builtin/service/service.js'));
  delegate.handle = () => { throw new Error('bad box'); };
  assert.equal(call('/mpd?x=1').code, 500);
  delegate.handle = (req, res) => { res.headersSent = true; throw new Error('late'); };
  const res = call('/seg'); assert.equal(res.destroyed, true); assert.equal(res.code, undefined);
  assert.equal(JSON.parse(call('/launcher/info').body).errors.count, 2, 'both are kept');
  for (let i = 0; i < 20; i++) call('/seg');
  assert.ok(!svc.state.failures['1.0.0'], 'answered failures (one bad video) never count against the version');
});

test('escaped exceptions are diagnostics only: however many, they never count against a version', (t) => {
  const { svc, call, processListeners } = serviceShell(t);
  for (let i = 0; i < 1000; i++) processListeners.uncaughtException(new Error('x' + i));
  assert.ok(!svc.state.failures['1.0.0'] && !svc.state.bad['1.0.0']);
  const info = JSON.parse(call('/launcher/info').body);
  assert.equal(info.errors.count, 1000); assert.equal(info.errors.last.length, 10, 'memory stays bounded');
  assert.equal(JSON.parse(call('/ping').body).ok, true);
});

test('updates: release pages are read until a short one (at most five), whatever versions they hold', (t) => {
  const root = temp(t), f = fixture('1.0.0'), urls = [];
  const page = (from) => Array.from({ length: 50 }, (_, i) => ({ tag_name: 'v' + (from - i) + '.0.0', prerelease: true, draft: false, assets: [] }));
  const mod = updater.create({ root, config: { ...config, keys }, builtin: f, candidates: [path.join(root, 'data')], build: { updates: true },
    download(u, limit, cb) { urls.push(u);
      if (!u.includes('api.github')) return cb(null, Buffer.from(u.endsWith('.sig') ? f.sig : f.raw));
      const n = +/[?&]page=(\d+)/.exec(u)[1];
      // Page 1 holds an old prerelease among newer ones: it must not end the listing early.
      const p1 = page(200); p1[49] = { tag_name: 'v0.1.0', prerelease: true, draft: false, assets: [] };
      cb(null, Buffer.from(JSON.stringify(n === 1 ? p1 : n === 2 ? page(150) : [release('1.0.0')]))); } });
  mod.check(() => {});
  assert.deepEqual(urls.filter((u) => u.includes('api.github')).map((u) => /[?&]page=(\d+)/.exec(u)[1]), ['1', '2', '3']);
  urls.length = 0; mod.check(false, () => {});
  assert.equal(urls.filter((u) => u.includes('api.github')).length, 3);
  const many = updater.create({ root: temp(t), config: { ...config, keys }, builtin: f, candidates: [path.join(temp(t), 'data')], build: { updates: true },
    download(u, limit, cb) { urls.push(u); cb(null, Buffer.from(JSON.stringify(page(900)))); } });
  urls.length = 0; many.check(() => {});
  assert.equal(urls.filter((u) => u.includes('api.github')).length, 5, 'never more than five pages');
});

test('cleanup keeps a usable older copy for rollback, never a revoked or newer-shell one', (t) => {
  const { svc } = service(t);
  install(svc, fixture('1.1.0'));
  const revoked = fixture('1.2.0'); install(svc, revoked);
  svc.state.revokes.push('1.2.0');
  install(svc, fixture('1.3.0'));
  const kept = svc.installed().map((b) => b.manifest.version);
  assert.ok(kept.includes('1.1.0'), 'the usable rollback copy stays'); assert.ok(!kept.includes('1.2.0'));
});

test('boot does not wait forever for a service launch that never calls back', () => {
  const b = bootShell({ serviceOffline: true, launchHangs: true });
  assert.equal(b.ctx.Launcher.version, '', 'still looking for the service');
  const deadline = [...b.timers.entries()].find(([, x]) => x.ms === 8000);
  assert.ok(deadline); b.timers.delete(deadline[0]); deadline[1].fn();
  assert.equal(b.ctx.Launcher.version, '1.0.0', 'the built-in starts');
  assert.ok([...b.timers.values()].some((x) => x.ms === 30000), 'and the start watch is armed');
});


/* The bundle's own downloader (app/service/updates.js) against the real shell as its launcher. */
const bundleUpdates = require('../app/service/updates');
function bundleRig(t, download, opts = {}) {
  const { svc } = service(t, opts.service || {});
  let now = opts.now || 100000000;
  const reports = [], installs = [];
  const launcher = {
    status: () => svc.bundleStatus(),
    verify: (raw, sig) => { const m = svc.verify(raw, sig); svc.save(); return { version: m.version, minShell: m.minShell, revokes: m.revokes, archive: m.archive, notes: m.notes || '' }; },
    install: (raw, sig, archive) => { installs.push(archive ? 'archive' : 'manifest'); return { version: svc.install(raw, sig, archive).version }; },
    checked: (r) => { reports.push(r); svc.checked(r); },
    discard: (v) => svc.discard(v)
  };
  const updates = bundleUpdates.create(launcher, { download, now: () => now });
  return { svc, updates, reports, installs, clock: { get: () => now, set: (v) => { now = v; } } };
}
const runCheck = (u) => new Promise((resolve) => u.check((err) => resolve(err)));

test('bundle downloader: newest compatible release, verified by the shell; newer-shell revokes learned; notes kept', async (t) => {
  const high = fixture('3.0.0', { minShell: 2, revokes: ['1.5.0'] }), good = fixture('2.0.0'), urls = [];
  const list = [release('1.0.0', 'Old'), release('2.0.0', 'Good'), release('3.0.0', 'Needs shell 2'), { tag_name: 'v2.5.0', prerelease: false, body: '', assets: [] }];
  const { svc, updates, reports, installs } = bundleRig(t, (u, limit, cb) => {
    urls.push(u);
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify(list)));
    const f = u.includes('/v3.0.0/') ? high : good;
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
  });
  assert.equal(await runCheck(updates), null);
  assert.deepEqual(installs, ['archive']);
  assert.equal(svc.bundleStatus().newest, '2.0.0');
  assert.ok(svc.state.revokes.includes('1.5.0'), 'revokes of a newer-shell release apply');
  assert.ok(!urls.some((u) => u.includes('/v1.0.0/')), 'nothing older than what it installs');
  const r = reports.at(-1);
  assert.equal(r.ok, true); assert.deepEqual(r.skipped.map((x) => x.version), ['2.5.0']);
  assert.equal(svc.status().needsReinstall, '3.0.0');
  assert.equal(svc.state.releases.find((x) => x.version === '2.0.0').notes, 'Good');
  // Up to date: lists again, fetches nothing else.
  urls.length = 0; await runCheck(updates);
  assert.ok(urls.every((u) => u.includes('api.github') || u.includes('/v3.0.0/')));
});

test('bundle downloader: forged releases are refused by the shell and the next one is tried; failures are reported', async (t) => {
  const good = fixture('1.1.0'), forged = fixture('1.2.0');
  const { svc, updates, reports } = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('1.1.0'), release('1.2.0')])));
    if (u.includes('/v1.2.0/') && u.endsWith('.sig')) return cb(null, Buffer.from(Buffer.alloc(64).toString('base64')));
    const f = u.includes('/v1.2.0/') ? forged : good;
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
  });
  await runCheck(updates);
  assert.equal(svc.bundleStatus().newest, '1.1.0');
  assert.match(reports.at(-1).skipped[0].reason, /Invalid signature/);
  const offline = bundleRig(t, (u, limit, cb) => cb(Object.assign(Error('offline'))));
  assert.match(String(await runCheck(offline.updates)), /offline/);
  assert.equal(offline.reports.at(-1).ok, false); assert.equal(offline.svc.state.checkFailed, true);
});

test('bundle downloader: no archive during playback; notes dropped over an unverified connection', async (t) => {
  const f = fixture('1.1.0'); let archives = 0, unverified = false;
  const rig = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('1.1.0', 'Notes')])), unverified);
    if (!u.endsWith('.json') && !u.endsWith('.sig')) archives++;
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive, unverified);
  });
  rig.svc.setPlayback(true);
  await runCheck(rig.updates);
  assert.equal(archives, 0); assert.equal(rig.svc.bundleStatus().deferred, true);
  rig.svc.setPlayback(false); unverified = true;
  await runCheck(rig.updates);
  assert.equal(archives, 1); assert.equal(rig.svc.bundleStatus().newest, '1.1.0'); assert.equal(rig.svc.bundleStatus().deferred, false);
  assert.equal(rig.svc.state.releases[0].notes, '', 'GitHub text from an unverified connection is not shown');
});

test('bundle downloader schedule: hourly on the shared clock, deferred downloads, clocks set back, playback and settings', (t) => {
  let calls = 0;
  const rig = bundleRig(t, (u, limit, cb) => { calls++; cb(Error('offline')); });
  const at = rig.clock.get(), tick = () => rig.updates.tick();
  rig.svc.state.lastCheck = at - 1000; tick(); assert.equal(calls, 0, 'the shell just checked');
  rig.clock.set(at + 3600000 - 1001); tick(); assert.equal(calls, 0);
  rig.clock.set(at + 3600000); tick(); assert.equal(calls, 1, 'an hour after the last check, anyone\'s');
  rig.svc.state.lastCheck = at + 3600000; tick(); assert.equal(calls, 1);
  rig.clock.set(at - 86400000); tick(); assert.equal(calls, 2, 'a clock set back checks, never stalls');
  rig.svc.state.lastCheck = rig.clock.get(); rig.svc.state.lastDeferred = true; tick(); assert.equal(calls, 3, 'a deferred download goes ahead');
  rig.svc.state.lastDeferred = true; rig.svc.setPlayback(true); tick(); assert.equal(calls, 3, 'not while playing');
  rig.svc.setPlayback(false); rig.svc.state.updates = false; tick(); assert.equal(calls, 3, 'automatic checks off');
  rig.updates.check(() => {}); assert.equal(calls, 4, 'a manual check still runs');
});

test('bundle downloader: a local test source installs its one signed release', async (t) => {
  const f = fixture('1.4.0'), urls = [];
  const rig = bundleRig(t, (u, limit, cb, allowHttp) => {
    urls.push(u); assert.equal(allowHttp, true);
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
  }, { service: { build: { updates: true, source: 'http://10.0.0.49:8000/', keys } } });
  await runCheck(rig.updates);
  assert.equal(rig.svc.bundleStatus().newest, '1.4.0');
  assert.deepEqual(urls, ['http://10.0.0.49:8000/bundle.json', 'http://10.0.0.49:8000/bundle.json', 'http://10.0.0.49:8000/bundle.json.sig', 'http://10.0.0.49:8000/bundle-1.4.0.tar']);
});

test('bundle downloader: the real HTTPS transport retries a certificate the TV cannot check, and only that', async (t) => {
  const https = require('node:https'), dir = temp(t), key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
  if (made.status !== 0) return t.skip('openssl unavailable');
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => res.end('signed bytes'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const r = await new Promise((resolve) => bundleUpdates.download('https://127.0.0.1:' + server.address().port + '/x', 1024, (e, b, unverified) => resolve({ e, b, unverified })));
  assert.ifError(r.e); assert.equal(r.b.toString(), 'signed bytes'); assert.equal(r.unverified, true);
  const refused = await new Promise((resolve) => bundleUpdates.download('https://127.0.0.1:1/x', 1024, (e) => resolve(e)));
  assert.equal(refused.code, 'ECONNREFUSED');
  assert.equal(bundleUpdates.untrustedCertificate({ code: 'CERT_HAS_EXPIRED' }), true);
  assert.equal(bundleUpdates.untrustedCertificate({ code: 'ECONNRESET' }), false);
});

test('bundle downloader: an unsigned "needs a newer shell" manifest is skipped, never shown as needing a reinstall', async (t) => {
  const forged = fixture('3.0.0', { minShell: 2 });
  const { svc, updates, reports } = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('3.0.0')])));
    cb(null, u.endsWith('.sig') ? Buffer.from(Buffer.alloc(64).toString('base64')) : Buffer.from(forged.raw));
  });
  await runCheck(updates);
  assert.equal(svc.status().needsReinstall, null);
  assert.match(reports.at(-1).skipped[0].reason, /Invalid signature/);
  assert.equal(reports.at(-1).releases[0].minShell, undefined);
});

test('bundle downloader: revokes count before the playback decision; a failed archive download is a failed check', async (t) => {
  const f = fixture('1.2.0', { revokes: ['1.1.0'] });
  const playing = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('1.2.0')])));
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : Buffer.from(f.raw));
  });
  playing.svc.setPlayback(true);
  await runCheck(playing.updates);
  assert.ok(playing.svc.state.revokes.includes('1.1.0'), 'learned without downloading the archive');
  const broken = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('1.2.0')])));
    if (u.endsWith('.tar')) return cb(Error('HTTP 503'));
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : Buffer.from(f.raw));
  });
  assert.match(String(await runCheck(broken.updates)), /HTTP 503/);
  assert.equal(broken.reports.at(-1).ok, false); assert.equal(broken.svc.state.checkFailed, true);
});

test('bundle downloader: test versions chosen in the app win over the package\'s channel, on the unchanged shell', async (t) => {
  const pre = fixture('1.3.0'), stable = fixture('1.2.0');
  const list = [{ ...release('1.3.0'), prerelease: true }, release('1.2.0')];
  for (const [built, chosen, want] of [['stable', 'prerelease', '1.3.0'], ['prerelease', 'stable', '1.2.0'],
    ['stable', null, '1.2.0'], ['prerelease', null, '1.3.0']]) {
    const rig = bundleRig(t, (u, limit, cb) => {
      if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify(list)));
      const f = u.includes('/v1.3.0/') ? pre : stable;
      cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
    }, { service: { build: { updates: true, channel: built } } });
    if (chosen) rig.updates.setChannel(chosen);
    assert.equal(await runCheck(rig.updates), null);
    // The shell installs it and starts the newest it holds: no shell change needed.
    assert.equal(rig.svc.bundleStatus().newest, want, built + ' package, ' + chosen + ' chosen');
  }
});

test('bundle downloader: test versions turned off while one downloads: it isn\'t installed', async (t) => {
  const pre = fixture('1.3.0');
  let deliver;
  const rig = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([{ ...release('1.3.0'), prerelease: true }])));
    if (u.endsWith('.tar')) { deliver = () => cb(null, pre.archive); return; }
    cb(null, u.endsWith('.sig') ? Buffer.from(pre.sig) : Buffer.from(pre.raw));
  }, { service: { build: { updates: true, channel: 'stable' } } });
  rig.updates.setChannel('prerelease');   // its own check starts (none for an hour)
  await new Promise(setImmediate);
  const done = runCheck(rig.updates);      // busy: refused, the first one goes on
  rig.updates.setChannel('stable');        // turned off before the archive arrives
  deliver();
  await done;
  await new Promise(setImmediate);
  assert.equal(rig.svc.bundleStatus().newest, '1.0.0', 'not installed');
});

test('bundle downloader: test versions on: a check of its own when it hasn\'t looked for an hour, not more', async (t) => {
  let lists = 0;
  const rig = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) { lists++; return cb(null, Buffer.from(JSON.stringify([release('1.0.0')]))); }
    cb(new Error('none'));
  }, { service: { build: { updates: true, channel: 'stable' } } });
  rig.updates.setChannel('prerelease');
  await new Promise(setImmediate);
  assert.equal(lists, 1, 'checked at once');
  rig.updates.setChannel('prerelease');
  await new Promise(setImmediate);
  assert.equal(lists, 1, 'not again within the hour');
  rig.clock.set(rig.clock.get() + 3600000);
  rig.updates.setChannel('prerelease');
  await new Promise(setImmediate);
  assert.equal(lists, 2, 'again an hour later');
  rig.clock.set(rig.clock.get() + 3600000);
  rig.updates.setChannel('stable');
  await new Promise(setImmediate);
  assert.equal(lists, 2, 'turned off: only the usual hourly checks (nothing held is deleted)');
});

test('bundle downloader: turned off, a test version already downloaded stays (nothing held is deleted)', async (t) => {
  const pre = fixture('1.3.0');
  const rig = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([{ ...release('1.3.0'), prerelease: true }])));
    cb(null, u.endsWith('.sig') ? Buffer.from(pre.sig) : u.endsWith('.json') ? Buffer.from(pre.raw) : pre.archive);
  }, { service: { build: { updates: true, channel: 'stable' } } });
  rig.updates.setChannel('prerelease');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rig.svc.bundleStatus().newest, '1.3.0');
  rig.updates.setChannel('stable');
  await runCheck(rig.updates);   // only a test version listed: "No releases" for this TV now
  assert.equal(rig.svc.bundleStatus().newest, '1.3.0', 'stays until a newer release');
});

test('bundle downloader: turned off while a test version\'s manifest comes, its archive isn\'t fetched', async (t) => {
  const pre = fixture('1.3.0'), urls = [];
  const rig = bundleRig(t, (u, limit, cb) => {
    urls.push(u);
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([{ ...release('1.3.0'), prerelease: true }])));
    if (u.endsWith('.sig')) rig.updates.setChannel('stable');   // turned off before the archive request
    cb(null, u.endsWith('.sig') ? Buffer.from(pre.sig) : u.endsWith('.json') ? Buffer.from(pre.raw) : pre.archive);
  }, { service: { build: { updates: true, channel: 'stable' } } });
  rig.updates.setChannel('prerelease');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!urls.some((u) => u.endsWith('.tar')), 'no archive download: ' + urls.join(' '));
  assert.equal(rig.svc.bundleStatus().newest, '1.0.0');
});

test('bundle downloader: a check asked for while one runs waits for it and gets its result', async (t) => {
  let deliver;
  const rig = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) { deliver = () => cb(null, Buffer.from(JSON.stringify([release('1.0.0')]))); return; }
    cb(new Error('none'));
  });
  const first = runCheck(rig.updates), second = runCheck(rig.updates);
  deliver();
  assert.deepEqual([await first, await second], [null, null], 'the second waited (no "already running" failure)');
  // Stopped meanwhile (its version switched off): every waiting caller still gets an answer.
  let later;
  const stopped = bundleRig(t, (u, limit, cb) => { if (u.includes('api.github')) { later = () => cb(null, Buffer.from('[]')); return; } cb(new Error('none')); });
  const a = runCheck(stopped.updates), b = runCheck(stopped.updates);
  stopped.updates.stop(); later();
  assert.deepEqual([String(await a), String(await b)], ['Error: Stopped', 'Error: Stopped']);
});

test('bundle downloader: turned off during a check, the remaining test versions aren\'t even fetched', async (t) => {
  const urls = [];
  const rig = bundleRig(t, (u, limit, cb) => {
    urls.push(u);
    if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([
      { ...release('1.5.0'), prerelease: true }, { ...release('1.4.0'), prerelease: true }, release('1.0.0')])));
    rig.updates.setChannel('stable');   // turned off while the first one's manifest comes
    cb(new Error('gone'));
  }, { service: { build: { updates: true, channel: 'stable' } } });
  rig.updates.setChannel('prerelease');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!urls.some((u) => u.includes('/v1.4.0/')), 'not fetched: ' + urls.join(' '));
});


test('bundle downloader: once stopped (its version switched off), late download results change nothing', async (t) => {
  const f = fixture('1.2.0'); let release1;
  const rig = bundleRig(t, (u, limit, cb) => {
    if (u.includes('api.github')) { release1 = () => cb(null, Buffer.from(JSON.stringify([release('1.2.0')]))); return; }
    cb(null, u.endsWith('.sig') ? Buffer.from(f.sig) : u.endsWith('.json') ? Buffer.from(f.raw) : f.archive);
  });
  const done = runCheck(rig.updates);
  rig.updates.stop(); release1();
  assert.match(String(await done), /Stopped/);
  assert.equal(rig.svc.bundleStatus().newest, '1.0.0'); assert.equal(rig.reports.length, 0);
});

test('a slower install of an older version never deletes a newer download', (t) => {
  const { svc } = service(t);
  install(svc, fixture('1.2.0'));
  install(svc, fixture('1.1.0'));
  assert.ok(svc.installed().some((b) => b.manifest.version === '1.2.0'));
  assert.equal(svc.bundleStatus().newest, '1.2.0');
});

test('the launcher API: one set per activation (old helpers are refused), start resets playback, discard protects', (t) => {
  const { svc, root, call } = serviceShell(t);
  const first = require(path.join(root, 'builtin/service/service.js')).launcher;
  install(svc, fixture('1.2.0'));
  assert.equal(call('/launcher/restart?version=1.2.0', 'POST').code, 200);
  assert.throws(() => first.checked({ ok: true, releases: [] }), /no longer running/);
  assert.throws(() => first.install('', '', null), /no longer running/);
  assert.doesNotThrow(() => first.status(), 'reading stays allowed');
  // A page that vanished while playing: the next start plays nothing yet, so the shell's check is not skipped.
  svc.setPlayback(true); let starts = 0; svc.startCheck = () => { starts++; assert.equal(svc.bundleStatus().playing, false); };
  call('/launcher/info?start=1&retry=1'); assert.equal(starts, 1);
  call('/launcher/ready?version=1.2.0', 'POST');
  install(svc, fixture('1.3.0'));
  assert.throws(() => svc.discard('1.2.0'), /in use/); assert.throws(() => svc.discard('1.0.0'), /in use/);
  assert.equal(svc.discard('1.3.0'), true); assert.ok(!svc.installed().some((b) => b.manifest.version === '1.3.0'));
  assert.equal(svc.discard('1.3.0'), false);
});

test('a full restart: the service reopens the app once its process is gone (10 s at most)', (t) => {
  const launched = []; let contexts = 0;
  const tizen = { application: {
    getAppsContext(ok) { contexts++; ok(contexts < 3 ? [{ appId: 'F1TVtizen1.F1TV' }, { appId: 'F1TVtizen1.Helper' }] : [{ appId: 'F1TVtizen1.Helper' }]); },
    launch(id, ok) { launched.push(id); ok(); } } };
  const { call, timers } = serviceShell(t, { tizen });
  assert.equal(call('/launcher/relaunch', 'POST').code, 200);
  assert.deepEqual(launched, [], 'not while the app still runs');
  for (let i = 0; i < 2; i++) { const w = [...timers.entries()].find(([, x]) => x.ms === 250); timers.delete(w[0]); w[1].fn(); }
  assert.deepEqual(launched, ['F1TVtizen1.F1TV']);
  // An app that never closes: launched anyway after 40 looks (it then simply comes to the front).
  contexts = -1000; launched.length = 0;
  call('/launcher/relaunch', 'POST');
  for (let i = 0; i < 39; i++) { const w = [...timers.entries()].find(([, x]) => x.ms === 250); timers.delete(w[0]); w[1].fn(); }
  assert.deepEqual(launched, ['F1TVtizen1.F1TV']);
  assert.equal(call('/launcher/relaunch').code, 405, 'POST only, like every launcher route');
});

test('Launcher.relaunch asks the service, then closes the app; without that it reloads the page', () => {
  for (const exits of [true, false]) {
    const b = bootShell();
    let exited = 0;
    if (exits) b.ctx.tizen = { application: { getCurrentApplication: () => ({ exit() { exited++; } }) } };
    b.ctx.Launcher.relaunch();
    assert.ok(b.requests.some(([m, u]) => m === 'POST' && /\/launcher\/relaunch$/.test(u)));
    assert.equal(exited, exits ? 1 : 0); assert.equal(b.reloaded(), exits ? 0 : 1);
  }
});

test('restart requests: refused where the TV cannot, one at a time, cancelled by a new start, failed launches retried', (t) => {
  const none = serviceShell(t);
  assert.equal(none.call('/launcher/relaunch', 'POST').code, 501, 'no Tizen application API: the page reloads instead');
  const launched = []; let running = true, failLaunches = 0;
  const tizen = { application: {
    getAppsContext(ok) { ok(running ? [{ appId: 'F1TVtizen1.F1TV' }] : []); },
    launch(id, ok, fail) { if (failLaunches-- > 0) return fail(new Error('busy')); launched.push(id); ok(); } } };
  const { call, timers } = serviceShell(t, { tizen });
  const next = (ms) => { const w = [...timers.entries()].find(([, x]) => x.ms === ms); timers.delete(w[0]); w[1].fn(); };
  assert.equal(call('/launcher/relaunch', 'POST').code, 200);
  assert.equal(call('/launcher/relaunch', 'POST').code, 200);
  assert.equal([...timers.values()].filter((x) => x.ms === 250).length, 1, 'two requests, one loop');
  running = false; call('/launcher/relaunch', 'POST');
  assert.deepEqual(launched, [], 'still the first request, which looks again in 250 ms');
  next(250); assert.deepEqual(launched, ['F1TVtizen1.F1TV'], 'one launch for three requests');
  // The viewer reopens the app before the restart happened: nothing opens it a second time.
  running = true; launched.length = 0;
  call('/launcher/relaunch', 'POST');
  call('/launcher/info?start=1&retry=1');
  running = false; next(250); assert.deepEqual(launched, []);
  // A launch that fails is tried again, three times at most.
  failLaunches = 2; call('/launcher/relaunch', 'POST');
  next(1000); next(1000); assert.deepEqual(launched, ['F1TVtizen1.F1TV']);
});

test('Launcher.relaunch reloads the page itself when closing the app did not work within 3 s', () => {
  const b = bootShell();
  b.ctx.tizen = { application: { getCurrentApplication: () => ({ exit() {} }) } };
  b.ctx.Launcher.relaunch();
  assert.equal(b.reloaded(), 0);
  const watch = [...b.timers.values()].find((x) => x.ms === 3000);
  assert.ok(watch); watch.fn(); assert.equal(b.reloaded(), 1);
});

test('the shell check fails when a release could not be fetched, unless it installed one anyway', async (t) => {
  const older = fixture('1.1.0');
  for (const [olderAvailable, failed] of [[false, true], [true, false]]) {
    const { svc } = service(t, { download(u, limit, cb) {
      if (u.includes('api.github')) return cb(null, Buffer.from(JSON.stringify([release('1.1.0'), release('1.2.0')])));
      if (u.includes('/v1.2.0/') || !olderAvailable) return cb(Error('HTTP 503'));
      cb(null, u.endsWith('.sig') ? Buffer.from(older.sig) : u.endsWith('.json') ? Buffer.from(older.raw) : older.archive);
    } });
    await new Promise((resolve) => svc.check(() => resolve()));
    assert.equal(svc.state.checkFailed, failed, olderAvailable ? 'installed 1.1.0' : 'nothing could be fetched');
  }
});
