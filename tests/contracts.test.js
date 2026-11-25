// Checks that keep the app and its test doubles honest: what the TVs can parse, and that the fake players the app-flow
// and app-playback tests use offer what app.js calls, as the real player.js does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const acorn = require('./vendor/acorn.js');

const read = (p) => fs.readFileSync(p, 'utf8');
const appScripts = () => fs.readdirSync('app/js').filter((f) => f.endsWith('.js')).map((f) => 'app/js/' + f);

// config.xml lets Tizen 3 TVs (Chromium 47) install the app: ES2015 syntax would not even parse there.
test('every app script parses as ES5 (Tizen 3, Chromium 47); the parser rejects ES2015', () => {
  assert.match(read('app/config.xml'), /required_version="3\.0"/);
  for (const p of appScripts()) {
    try { acorn.parse(read(p), { ecmaVersion: 5, allowReserved: true }); } catch (e) { assert.fail(p + ': ' + e.message); }
  }
  for (const syntax of ['let a=1;', 'var f=()=>1;', 'var x=`a`;', 'var o={...p};', 'a?.b;', 'class C {}']) {
    assert.throws(() => acorn.parse(syntax, { ecmaVersion: 5 }), syntax);
  }
});

/** Every `Player.name` member the script reads (from its syntax tree, not its comments or strings). */
function playerCalls(file) {
  const names = new Set();
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'Player') {
      names.add(node.property.name);
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v);
    }
  })(acorn.parse(read(file), { ecmaVersion: 5, allowReserved: true }));
  return [...names].sort();
}

function realPlayer() {
  const context = vm.createContext({ localStorage: { getItem: () => null, setItem() {} }, Date, Math, JSON });
  for (const f of ['failure.js', 'ways.js', 'player.js']) vm.runInContext(read('app/js/' + f), context);
  return context.Player;
}

test('app.js calls only what player.js offers', () => {
  const real = realPlayer();
  // Set by app.js or the tests, not offered by player.js.
  const own = new Set(['forceEngine']);
  for (const name of playerCalls('app/js/app.js')) {
    if (own.has(name)) continue;
    assert.ok(name in real, 'player.js has no Player.' + name);
  }
});

/** The names the fake player of a test file defines (`const player = { … }` / `Player: { … }`), read from its source. */
function fakeNames(file, start) {
  const src = read(file), at = src.indexOf(start);
  assert.ok(at >= 0, start + ' not found in ' + file);
  // The object literal from its opening brace to the matching closing one.
  let i = src.indexOf('{', at), depth = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  const body = src.slice(i, j + 1);
  const ast = acorn.parse('(' + body + ')', { ecmaVersion: 2022 });
  return ast.body[0].expression.properties.map((p) => p.key.name || p.key.value);
}

test('the fake players offer every Player function app.js calls (no call is left out by a guard)', () => {
  const used = playerCalls('app/js/app.js').filter((n) => n !== 'forceEngine');
  for (const [file, start] of [['tests/app-flow.test.js', 'const player = {'], ['tests/app-playback.test.js', '    Player: {']]) {
    const fake = new Set(fakeNames(file, start));
    // app-playback's harness never boots the UI: only what playback reaches must be there.
    const needed = file.includes('app-playback') ? used.filter((n) => PLAYBACK.has(n)) : used;
    assert.deepEqual(needed.filter((n) => !fake.has(n)), [], file);
  }
});

// What loadFeed, the start watch and the recovery call (app-playback's harness plays feeds, nothing else).
const PLAYBACK = new Set(['audioChannels', 'bufferedEnd', 'cencCapable', 'decodedFrames', 'engineLost', 'engineName', 'engineOpen', 'errorInfo', 'hdrCapable',
  'isLive', 'isPaused', 'isViewerPaused', 'load', 'position', 'range', 'reloadedSince', 'stream', 'switchKind', 'switchTo',
  'togglePause', 'unload', 'wallClock']);

test('the fake players answer Failure.info as player.js does (the real js/failure.js), for errors without their own info', () => {
  for (const file of ['tests/app-flow.test.js', 'tests/app-playback.test.js']) {
    assert.match(read(file), /errorInfo[^\n]*Failure\.info\(e\)/, file + ': its fake errorInfo must use the real Failure.info');
  }
});
