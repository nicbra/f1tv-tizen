const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

/** Loads app modules into one context with the given globals. */
function load(files, globals) {
  const context = vm.createContext(Object.assign({ Date, JSON, Math }, globals));
  files.forEach((f) => vm.runInContext(readFileSync('app/js/' + f, 'utf8'), context));
  return context;
}

// ---------- settings ----------

function settings(saved, { failWrites } = {}) {
  const store = { 'f1tv.settings': saved };
  const ctx = load(['settings.js'], { localStorage: {
    getItem: (k) => store[k] == null ? null : store[k],
    setItem: (k, v) => { if (failWrites) throw new Error('QuotaExceededError'); store[k] = v; }
  } });
  return { Settings: ctx.Settings, store };
}

test('settings start from the defaults', () => {
  const { Settings } = settings(null);
  assert.equal(Settings.get('timing'), true);
  assert.equal(Settings.get('audio'), 'eng');
  assert.equal(Settings.get('subtitles'), '');
  assert.equal(Settings.get('spoilerFree'), false);
  assert.equal(Settings.get('updates'), true);
});

test('settings are saved and read back, including false and empty values', () => {
  const { Settings, store } = settings(null);
  Settings.set('timing', false);
  Settings.set('audio', 'nld');
  assert.deepEqual(JSON.parse(store['f1tv.settings']), { timing: false, audio: 'nld' });
  const again = settings(store['f1tv.settings']).Settings;
  assert.equal(again.get('timing'), false);
  assert.equal(again.get('audio'), 'nld');
});

test('settings survive corrupt or unwritable storage', () => {
  assert.equal(settings('{not json').Settings.get('audio'), 'eng');
  const { Settings } = settings(null, { failWrites: true });
  Settings.set('audio', 'fx');
  assert.equal(Settings.get('audio'), 'fx'); // kept for this session
});

// ---------- keys ----------

test('keys map the keyboard to the remote for trying the app in a browser', () => {
  const { Keys } = load(['keys.js'], {});
  assert.equal(Keys.normalize({ keyCode: 8 }), Keys.codes.BACK);
  assert.equal(Keys.normalize({ keyCode: 27 }), Keys.codes.BACK);
  assert.equal(Keys.normalize({ keyCode: 32 }), Keys.codes.PLAY_PAUSE);
  assert.equal(Keys.normalize({ keyCode: 10009 }), Keys.codes.BACK);
  assert.equal(Keys.normalize({ keyCode: 37 }), Keys.codes.LEFT);
});

test('keys register the media keys, skipping ones the TV model lacks', () => {
  const registered = [];
  const { Keys } = load(['keys.js'], { tizen: { tvinputdevice: { registerKey: (name) => {
    if (name === 'ColorF3Blue') throw new Error('not supported');
    registered.push(name);
  } } } });
  Keys.register();
  assert.ok(registered.includes('MediaPlayPause'));
  assert.ok(registered.includes('ChannelDown'));
  assert.ok(!registered.includes('ColorF3Blue'));
  load(['keys.js'], {}).Keys.register(); // no tizen: nothing to do
});

// ---------- focus ----------

/** Minimal DOM: elements with a class list, and document.querySelectorAll('.focused'). */
function dom() {
  const all = [];
  const el = (name) => {
    const classes = new Set();
    const e = { name, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } };
    all.push(e);
    return e;
  };
  const document = { querySelectorAll: (sel) => all.filter((e) => e.classList.contains(sel.slice(1))) };
  const ctx = load(['keys.js', 'focus.js'], { document });
  return { el, ctx, focused: () => all.filter((e) => e.classList.contains('focused')).map((e) => e.name) };
}

test('focus highlights exactly one element and moves within rows', () => {
  const { el, ctx, focused } = dom();
  const K = ctx.Keys.codes;
  const g = new ctx.Focus.Grid([[el('a'), el('b'), el('c')], [el('d')]]);
  g.apply();
  assert.deepEqual(focused(), ['a']);
  assert.equal(g.handle(K.RIGHT), true);
  assert.equal(g.handle(K.RIGHT), true);
  assert.deepEqual(focused(), ['c']);
  assert.equal(g.handle(K.RIGHT), false); // end of the row
  assert.deepEqual(focused(), ['c']);
});

test('focus remembers the column of each row when moving up and down', () => {
  const { el, ctx, focused } = dom();
  const K = ctx.Keys.codes;
  const g = new ctx.Focus.Grid([[el('nav1'), el('nav2')], [el('t1'), el('t2'), el('t3')]]);
  g.apply();
  g.handle(K.RIGHT);           // nav2
  g.handle(K.DOWN);            // t1
  g.handle(K.RIGHT); g.handle(K.RIGHT); // t3
  g.handle(K.UP);
  assert.deepEqual(focused(), ['nav2']);
  g.handle(K.DOWN);
  assert.deepEqual(focused(), ['t3']);
  assert.equal(g.handle(K.DOWN), false);
});

test('focus reports moves and selections with the element and its place', () => {
  const { el, ctx } = dom();
  const K = ctx.Keys.codes;
  const moves = [], picks = [];
  const g = new ctx.Focus.Grid([[el('a')], [el('b'), el('c')]], {
    onMove: (r, c, e) => moves.push([r, c, e.name]),
    onSelect: (e, r, c) => picks.push([e.name, r, c])
  });
  g.apply();
  g.handle(K.DOWN);
  g.handle(K.RIGHT);
  g.handle(K.ENTER);
  assert.deepEqual(moves, [[0, 0, 'a'], [1, 0, 'b'], [1, 1, 'c']]);
  assert.deepEqual(picks, [['c', 1, 1]]);
  assert.equal(g.current().name, 'c');
});

test('focus on an empty grid does nothing and other keys are not handled', () => {
  const { ctx } = dom();
  const K = ctx.Keys.codes;
  const g = new ctx.Focus.Grid([]);
  g.apply();
  assert.equal(g.current(), null);
  assert.equal(g.handle(K.DOWN), false);
  assert.equal(new ctx.Focus.Grid([[{ classList: { add() {}, remove() {} } }]]).handle(K.RED), false);
});

// ---------- the service launcher ----------

function proxy({ upAfter = 0, launchFails = false } = {}) {
  let pings = 0;
  const launched = [];
  const ctx = load(['proxy.js'], {
    fetch: async (url) => { pings++; if (pings > upAfter) return { ok: true }; throw new Error('refused'); },
    setTimeout: (fn) => setImmediate(fn),
    tizen: {
      application: { getCurrentApplication: () => ({ appInfo: { packageId: 'F1TVtizen1' } }),
        launchAppControl: (ctl, id, ok, fail) => { launched.push(id); launchFails ? fail({ message: 'denied' }) : ok(); } },
      ApplicationControl: function (op) { this.op = op; }
    }
  });
  return { StreamProxy: ctx.StreamProxy, launched, pings: () => pings };
}

test('the service is not launched when it already answers', async () => {
  const { StreamProxy, launched } = proxy();
  assert.equal(await StreamProxy.ensure(), true);
  assert.deepEqual(launched, []);
});

test('the service is launched by its id and awaited until it answers', async () => {
  const { StreamProxy, launched } = proxy({ upAfter: 3 });
  assert.equal(await StreamProxy.ensure(), true);
  assert.deepEqual(launched, ['F1TVtizen1.Proxy']);
});

test('ensure fails when the service cannot be launched or never answers', async () => {
  await assert.rejects(proxy({ upAfter: 99, launchFails: true }).StreamProxy.ensure(), /denied/);
  await assert.rejects(proxy({ upAfter: 99 }).StreamProxy.ensure(), /did not start/);
});

test('manifest URLs carry the stream, the time shift in whole seconds and the languages', () => {
  const { StreamProxy } = proxy();
  const src = 'https://cdn.formula1.com/v2/pa_x/index.mpd?start=1&end=2';
  assert.equal(StreamProxy.manifest(src), 'http://127.0.0.1:18765/mpd?u=' + encodeURIComponent(src));
  assert.equal(StreamProxy.manifest(src, 59.6, { audio: 'deu', text: 'fra' }),
    'http://127.0.0.1:18765/mpd?u=' + encodeURIComponent(src) + '&shift=60&audio=deu&text=fra');
  assert.doesNotMatch(StreamProxy.manifest(src, 0, { audio: '' }), /shift|audio/);
  assert.doesNotMatch(StreamProxy.manifest(src, -5), /shift/);
});

test('the app does not replace JavaScript built-ins such as Proxy', () => {
  const builtins = ['Proxy', 'Map', 'Set', 'Promise', 'URL', 'Worker', 'Image', 'Event', 'Element', 'Node', 'Option'];
  const { readdirSync } = require('node:fs');
  for (const f of readdirSync('app/js')) {
    const globals = [...readFileSync('app/js/' + f, 'utf8').matchAll(/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    for (const name of globals) assert.ok(!builtins.includes(name), f + ' defines a global ' + name);
  }
});
