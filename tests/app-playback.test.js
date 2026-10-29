const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// opts: encryptedHdr (keys in the HDR variant playlist), gate(contentId) (a promise the play request waits for).
function playback(load, capable = true, opts = {}) {
  const nodes = {}, requests = [], loads = [], timers = [];
  let current = null;
  function start(stream, position, switching) {
    current = stream;
    loads.push({ stream, position, switching });
    return load ? load(stream) : Promise.resolve();
  }
  const context = vm.createContext({
    Keys: { codes: {} }, window: { addEventListener() {} },
    document: { getElementById: (id) => nodes[id] || (nodes[id] = {
      style: {}, classList: { add() {}, remove() {}, toggle() {} }
    }) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, clearTimeout() {},
    F1Api: {
      state: {}, isNotStarted: () => false, savePosition: async () => {},
      play: async (id, channel, o) => {
        requests.push({ id, channel, hdr: o.hdr });
        if (opts.gate) await opts.gate(id);
        return o.hdr ? { url: 'https://cdn/hdr.m3u8', hdr: true } : { url: 'https://cdn/stream.m3u8' };
      },
      streamInfo: async (url) => ({ dynamic: false, windowStart: 0, windowEnd: 600,
        encrypted: !!opts.encryptedHdr && url.includes('hdr') })
    },
    Timing: { load() {}, label: () => '', supported: () => false, isReady: () => false },
    Settings: { get: () => false },
    Player: {
      hdrCapable: () => capable, engineName: () => current ? 'shaka' : null,
      unload: async () => {}, stream: () => current,
      load: (s, p) => start(s, p, false), switchTo: (s, p) => start(s, p, true),
      position: () => 120, wallClock: () => null, isLive: () => false, isPaused: () => false,
      range: () => ({ start: 0, end: 600 }), bufferedEnd: () => 150,
      tracks: () => ({ audio: [], text: [] })
    }
  });
  // Expose the playback entry points without booting the browse/login screens.
  const source = readFileSync('app/js/app.js', 'utf8').replace("window.addEventListener('load', boot);", `
    ensureSession = function () { return Promise.resolve(true); };
    testApp = { play: playFeed, update: updateOsd, stop: stopPlayer,
      set: function (ctx) { feedsCtx = ctx; screen = 'feeds'; } };
  `);
  vm.runInContext(source, context);
  return { app: context.testApp, nodes, requests, loads, timers };
}

const video = (extra) => ({ contentId: '42', index: 0, live: false,
  feeds: [{ title: 'Main', channelId: 'main' }, { title: 'Onboard', channelId: 'car' }], ...extra });
const settle = () => new Promise(setImmediate);

test('HDR load and switch failures retry the same feed in SDR with the same start options', async () => {
  for (const switching of [false, true]) {
    let active = false;
    const h = playback(async (stream) => {
      assert.equal(active, false);
      active = true;
      await settle();
      active = false;
      if (stream.hdr && (!switching || h.loads.length > 1)) throw new Error('HDR failed');
    });
    const ctx = video();
    h.app.set(ctx);
    if (switching) { h.app.play(0, {}); await settle(); await settle(); }
    h.app.play(1, { switching, startAt: 87 });
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(ctx.hdrFailed, true);
    assert.deepEqual(h.requests.slice(-2), [
      { id: '42', channel: 'car', hdr: true }, { id: '42', channel: 'car', hdr: false }
    ]);
    assert.deepEqual(h.loads.slice(-2).map((l) => [l.position, l.switching]), [[87, switching], [87, switching]]);
    assert.doesNotMatch(h.nodes.toast?.textContent || '', /Could not play/);
    h.app.set(video({ contentId: 'next' }));
    h.app.play(0, {});
    await settle();
    assert.equal(h.requests.at(-1).hdr, true);
  }
});

test('a late HDR rejection does not disable HDR for the next video', async () => {
  let reject;
  const h = playback(() => new Promise((resolve, fail) => { reject = fail; }));
  h.app.set(video());
  h.app.play(0, {});
  await settle();
  const next = video({ contentId: 'next' });
  h.app.set(next);
  reject(new Error('HDR failed'));
  await settle();
  assert.equal(next.hdrFailed, undefined);
  assert.equal(h.requests.length, 1);
});

test('stopping a video while it loads is not an error and keeps HDR for it', async () => {
  let reject;
  const h = playback(() => new Promise((resolve, fail) => { reject = fail; }));
  const ctx = video();
  h.app.set(ctx);
  h.app.play(0, {});
  await settle();
  h.app.stop();
  // Shaka rejects the load that unload() interrupted.
  reject(new Error('Shaka Error 7000'));
  await settle();
  assert.equal(ctx.hdrFailed, undefined);
  assert.equal(h.nodes.toast?.textContent, undefined);
  assert.equal(h.requests.length, 1);
  h.app.play(0, {});
  await settle();
  assert.equal(h.requests.at(-1).hdr, true);
});

test('an HDR stream that has not started after 25 s is retried in SDR, and the OSD reflects the current stream', async () => {
  const h = playback();
  const ctx = video();
  h.app.set(ctx);
  h.app.play(0, {});
  await settle();
  assert.equal(h.nodes['osd-feed'].textContent, 'Main · HDR');
  h.app.update();
  assert.equal(h.nodes['osd-feed'].textContent, 'Main · HDR');
  // HDR streams get longer to start than the usual 15 s.
  assert.equal(h.timers.some((t) => t.ms === 15000), false);
  h.timers.find((t) => t.ms === 25000).fn();
  await settle();
  assert.equal(ctx.hdrFailed, true);
  assert.equal(h.requests.at(-1).hdr, false);
  h.app.update();
  assert.equal(h.nodes['osd-feed'].textContent, 'Main');
});

test('single-feed HDR shows only HDR, while live and incapable playback request SDR', async () => {
  for (const [live, capable, expected] of [[false, true, 'HDR'], [true, true, ''], [false, false, '']]) {
    const h = playback(undefined, capable);
    h.app.set(video({ live, feeds: [{ title: 'Documentary' }] }));
    h.app.play(0, {});
    await settle();
    assert.equal(h.requests[0].hdr, !!expected);
    assert.equal(h.nodes['osd-feed'].textContent, expected);
    h.app.update();
    assert.equal(h.nodes['osd-feed'].textContent, expected);
  }
});

test('an HDR stream with keys in its variant playlist is never loaded; the feed plays in SDR', async () => {
  const h = playback(undefined, true, { encryptedHdr: true });
  const ctx = video();
  h.app.set(ctx);
  h.app.play(0, {});
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(ctx.hdrFailed, true);
  assert.deepEqual(h.requests.map((r) => r.hdr), [true, false]);
  assert.deepEqual(h.loads.map((l) => !!l.stream.hdr), [false]);
});

test('a video\'s start watch does nothing once another video is loading', async () => {
  let release;
  const h = playback(undefined, true, { gate: (id) => (id === 'next' ? new Promise((r) => { release = r; }) : null) });
  h.app.set(video());
  h.app.play(0, {});
  for (let i = 0; i < 3; i++) await settle();
  const watch = h.timers.find((t) => t.ms === 25000);
  const next = video({ contentId: 'next', live: true });
  h.app.set(next);
  h.app.play(0, { fromStart: true });
  await settle();
  watch.fn();   // the first video's watch fires while the next one's play request is pending
  release();
  for (let i = 0; i < 3; i++) await settle();
  assert.equal(next.hdrFailed, undefined);
  assert.deepEqual(h.requests.map((r) => r.id), ['42', 'next']);
});
