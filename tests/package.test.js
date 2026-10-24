const assert = require('node:assert/strict');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const read = (f) => readFileSync(f, 'utf8');
const config = read('app/config.xml');
const html = read('app/index.html');

test('every script and stylesheet the page loads is in the package', () => {
  const refs = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((ref) => !ref.startsWith('$WEBAPIS'));
  assert.ok(refs.length > 10);
  for (const ref of refs) assert.ok(existsSync(path.join('app', ref)), ref + ' is missing');
});

test('every font and image the stylesheets use is in the package', () => {
  for (const css of readdirSync('app/css')) {
    for (const [, ref] of read('app/css/' + css).matchAll(/url\('?([^')]+)'?\)/g)) {
      assert.ok(existsSync(path.join('app/css', ref)), css + ': ' + ref + ' is missing');
    }
  }
});

test('the Titillium font ships with its licence', () => {
  assert.ok(existsSync('app/fonts/OFL.txt'));
});

test('config.xml points at files that exist', () => {
  for (const [, ref] of config.matchAll(/<(?:content|icon|tizen:content) src="([^"]+)"/g)) {
    assert.ok(existsSync(path.join('app', ref)), ref + ' is missing');
  }
});

test('the background service id is the one the app launches', () => {
  const pkg = /package="([^"]+)"/.exec(config)[1];
  const service = /<tizen:service id="([^"]+)"/.exec(config)[1];
  assert.match(read('app/js/proxy.js'), /pkg \+ '\.Proxy'/);
  assert.equal(service, pkg + '.Proxy');
});

test('the app id the installers launch matches config.xml', () => {
  const id = /<tizen:application id="([^"]+)"/.exec(config)[1];
  assert.match(read('scripts/install.sh'), new RegExp('APP_ID="' + id.replace('.', '\\.') + '"'));
  assert.match(read('scripts/install.ps1'), new RegExp(id.replace('.', '\\.')));
  assert.match(read('scripts/deploy.sh'), new RegExp('APP_ID="' + id.replace('.', '\\.') + '"'));
});

test('the app asks for the privileges it needs', () => {
  for (const p of ['tizen.org/privilege/internet', 'tizen.org/privilege/tv.inputdevice', 'developer.samsung.com/privilege/drmplay',
    'tizen.org/privilege/application.launch']) {
    assert.ok(config.includes('<tizen:privilege name="http://' + p + '"/>'), p);
  }
});

test('the checked-in version is the development placeholder', () => {
  assert.match(config, /<widget[^>]*\sversion="0\.0\.0"/);
});

test('the media player objects the code drives are on the page', () => {
  assert.match(html, /<object id="av-player" type="application\/avplayer"/);
  assert.match(html, /<video id="video"/);
});

test('every element id the app looks up exists on the page', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...read('app/js/app.js').matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size > 40);
  for (const id of used) assert.ok(ids.has(id), '#' + id + ' is not in index.html');
});

test('all app scripts compile', () => {
  for (const f of readdirSync('app/js')) new vm.Script(read('app/js/' + f), { filename: f });
  new vm.Script(read('app/service/service.js'), { filename: 'service.js' });
});

test('the README screenshots exist', () => {
  const shots = [...read('README.md').matchAll(/(docs\/screenshots\/[\w.-]+)/g)].map((m) => m[1]);
  assert.ok(shots.length >= 8);
  for (const s of shots) assert.ok(existsSync(s), s + ' is missing');
});
