const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// opts: encryptedHdr (keys in the HDR variant playlist), gate(contentId) (a promise the play request waits for).
function playback(load, capable = true, opts = {}) {
  const nodes = {}, requests = [], loads = [], timers = [], infos = [];
  let current = null, paused = false;
  function start(stream, position, switching) {
    current = stream;
    paused = false;
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
        requests.push({ id, channel, hdr: o.hdr, cenc: o.cenc });
        if (opts.gate) await opts.gate(id);
        const drm = opts.drm ? { licenseUrl: 'https://lic/wv' } : {};
        if (o.cenc && !o.hdr) return { url: 'https://cdn/cast.mpd', cenc: true, channel, ...drm };
        return o.hdr ? { url: 'https://cdn/hdr.m3u8', hdr: true, channel, ...(opts.authorizedHdr ? {hdrEncrypted:true,licenseUrl:'https://lic/wv',widevineManifestUrl:'https://cdn/sdr.mpd'} : {}) } : { url: 'https://cdn/stream.m3u8', channel, ...drm };
      },
      streamInfo: async (url) => (infos.push(url), opts.info ? opts.info(url) : { dynamic: false, windowStart: 0, windowEnd: 600,
        encrypted: !!opts.encryptedHdr && url.includes('hdr') })
    },
    Timing: { load() {}, label: () => '', supported: () => false, isReady: () => false },
    Settings: { get: (k) => (opts.settings && k in opts.settings ? opts.settings[k] : k === 'hdr') },
    Player: {
      hdrCapable: () => capable, cencCapable: () => !!opts.cencCapable, engineName: () => current ? 'shaka' : null,
      unload: async () => {}, stream: () => current,
      load: (s, p) => start(s, p, false), switchTo: (s, p) => start(s, p, true),
      position: () => opts.position ? opts.position(current) : 120, wallClock: () => null, isLive: () => false, isPaused: () => paused, togglePause: () => { paused = !paused; },
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
  return { app: context.testApp, nodes, requests, loads, timers, infos, pause: () => {paused=true;}, isPaused: () => paused };
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
      { id: '42', channel: 'car', hdr: true, cenc: false }, { id: '42', channel: 'car', hdr: false, cenc: false }
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

test('single-feed HDR shows only HDR; incapable playback requests SDR, and live plays SDR without native HDR', async () => {
  for (const [live, capable, asked, expected] of [[false, true, true, 'HDR'], [true, true, true, ''], [false, false, false, '']]) {
    const h = playback(undefined, capable);
    h.app.set(video({ live, feeds: [{ title: 'Documentary' }] }));
    h.app.play(0, {});
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(h.requests[0].hdr, asked);
    assert.equal(h.loads.length, 1);
    assert.equal(!!h.loads[0].stream.hdr, !!expected);
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
  const next = video({ contentId: 'next' });
  h.app.set(next);
  h.app.play(0, { fromStart: true });
  await settle();
  watch.fn();   // the first video's watch fires while the next one's play request is pending
  release();
  for (let i = 0; i < 3; i++) await settle();
  assert.equal(next.hdrFailed, undefined);
  assert.deepEqual(h.requests.map((r) => r.id), ['42', 'next']);
});


test('authorized CBCS HDR loads, and native preparation that fails twice recovers in SDR', async () => {
 for (const fail of [false,true]) {
  const h=playback(async stream=>{if(fail&&stream.hdr)throw new Error('Could not open stream: PLAYER_ERROR_CONNECTION_FAILED');},true,{encryptedHdr:true,authorizedHdr:true});
  const ctx=video();h.app.set(ctx);h.app.play(0,{startAt:600});
  for(let i=0;i<8;i++)await settle();
  assert.deepEqual(h.requests.map(r=>r.hdr),fail?[true,true,false]:[true]);
  assert.equal(!!h.loads.at(-1).stream.hdr,!fail);
  assert.equal(h.loads.at(-1).position,600);
  assert.equal(!!ctx.hdrFailed,fail);
 }
});


test('a failed native HDR feed switch preserves the outgoing playback position for SDR', async () => {
 const h=playback(async stream=>{if(stream.hdr&&stream.channel==='car')throw new Error('native prepare failed');},true,{authorizedHdr:true,encryptedHdr:true,position:s=>s&&s.channel==='main'?600:0});
 const ctx=video();h.app.set(ctx);h.app.play(0,{});await settle();await settle();
 h.app.play(1,{switching:true});for(let i=0;i<6;i++)await settle();
 const last=h.loads.at(-1);assert.equal(last.stream.hdr,undefined);assert.ok(last.position>=600&&last.position<610,'recovery position '+last.position);
});


test('failed native HDR switching retains the viewer pause through SDR recovery', async () => {
 const h=playback(async stream=>{if(stream.hdr&&stream.channel==='car')throw new Error('native prepare failed');},true,{authorizedHdr:true,encryptedHdr:true,position:s=>s&&s.channel==='main'?600:0});
 h.app.set(video());h.app.play(0,{});await settle();await settle();h.pause();
 h.app.play(1,{switching:true});for(let i=0;i<6;i++)await settle();
 assert.equal(h.loads.at(-1).position,600);assert.equal(h.isPaused(),true);
});

test('one failed native HDR start is retried in HDR at once, and plays HDR', async () => {
  let failures = 1;
  const h = playback(async (stream) => { if (stream.hdr && failures-- > 0) throw new Error('Could not open stream: PLAYER_ERROR_CONNECTION_FAILED'); },
    true, { encryptedHdr: true, authorizedHdr: true });
  const ctx = video(); h.app.set(ctx); h.app.play(0, { startAt: 600 });
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(h.requests.map((r) => r.hdr), [true, true]);
  assert.equal(h.loads.at(-1).stream.hdr, true);
  assert.equal(h.loads.at(-1).position, 600);
  assert.equal(!!ctx.hdrFailed, false);
});

test('after falling back to SDR, the next feed switch tries HDR again, until HDR has failed three times', async () => {
  const h = playback(async (stream) => { if (stream.hdr) throw new Error('Could not open stream: PLAYER_ERROR_CONNECTION_FAILED'); },
    true, { encryptedHdr: true, authorizedHdr: true });
  const ctx = video(); h.app.set(ctx); h.app.play(0, {});
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(h.requests.map((r) => r.hdr), [true, true, false]);   // retried once, then SDR
  h.app.play(1, { switching: true });
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(h.requests.slice(3).map((r) => r.hdr), [true, false]);   // third failure: SDR, no immediate retry
  assert.equal(ctx.hdrFailures, 3);
  h.app.play(0, { switching: true });
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(h.requests.slice(5).map((r) => r.hdr), [false]);   // given up for this video
});

test('an HDR offer the app turns down is not retried', async () => {
  const h = playback(null, true, { encryptedHdr: true });
  const ctx = video(); h.app.set(ctx); h.app.play(0, {});
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(h.requests.map((r) => r.hdr), [true, false]);
  assert.equal(ctx.hdrFailed, true);
});

test('live sessions ask for HDR too, and time a live HDR stream on the official live DASH', async () => {
  const h = playback(null, true, { encryptedHdr: true, authorizedHdr: true });
  const ctx = video({ live: true }); h.app.set(ctx); h.app.play(0, {});
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(h.requests.map((r) => r.hdr), [true]);
  assert.deepEqual(h.infos, ['https://cdn/sdr.mpd']);
  assert.equal(h.loads.at(-1).stream.hdrEncrypted, true);
});

test('with 4K HDR switched off in Settings, every video asks for SDR', async () => {
  const h = playback(null, true, { encryptedHdr: true, authorizedHdr: true, settings: { hdr: false } });
  for (const live of [false, true]) {
    h.app.set(video({ live, contentId: 'v' + live })); h.app.play(0, {});
    for (let i = 0; i < 5; i++) await settle();
  }
  assert.deepEqual(h.requests.map((r) => r.hdr), [false, false]);
  assert.ok(h.loads.every((l) => !l.stream.hdr));
});

test('replays ask for the cenc stream when the browser can decrypt it; a failed one plays the usual stream, at the same moment', async () => {
  const h = playback(async (stream) => { if (stream.cenc) throw new Error('Shaka error 6007'); }, true, { cencCapable: true, settings: { hdr: false } });
  const ctx = video(); h.app.set(ctx); h.app.play(0, { startAt: 600 });
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(h.requests.map((r) => r.cenc), [true, false]);
  assert.equal(ctx.cencFailed, true);
  assert.equal(h.loads.at(-1).position, 600);
  assert.equal(h.loads.at(-1).stream.cenc, undefined);
});

test('browsers without cenc keep the usual request', async () => {
  for (const live of [true, false]) {
    const h = playback(null, true, { cencCapable: false, settings: { hdr: false } });
    h.app.set(video({ live })); h.app.play(0, {});
    for (let i = 0; i < 3; i++) await settle();
    assert.deepEqual(h.requests.map((r) => r.cenc), [false]);
  }
});

const NOW = Date.now() / 1000;
const liveInfo = () => ({ dynamic: true, windowStart: 1000, windowEnd: 4600, delay: 25, epochAtZero: NOW - 4600 });

// AVPlay's Widevine crashes some TVs outright (github issue #1), live included, so live asks for
// the cenc stream too -- but only when HDR gave nothing, since 4K HDR plays natively.
test('live asks for the cenc stream too, and seeks in it instead of time-shifting the manifest', async () => {
  for (const cencCapable of [true, false]) {
    const h = playback(null, true, { cencCapable, drm: true, settings: { hdr: false }, info: liveInfo });
    h.app.set(video({ live: true })); h.app.play(0, { startAt: 2000 });
    for (let i = 0; i < 5; i++) await settle();
    assert.deepEqual(h.requests.map((r) => r.cenc), [cencCapable]);
    const l = h.loads.at(-1);
    assert.equal(l.stream.cenc, cencCapable || undefined);
    // Shaka opens the cenc stream at the moment itself; AVPlay gets the time-shifted manifest.
    assert.equal(l.position, cencCapable ? 2000 : null);
    assert.equal(l.stream.startDelay === undefined, cencCapable);
  }
});

test('a live session playing in 4K HDR keeps the native stream: no cenc request is made', async () => {
  const h = playback(null, true, { cencCapable: true, authorizedHdr: true, drm: true, info: liveInfo });
  h.app.set(video({ live: true })); h.app.play(0, {});
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(h.requests.map((r) => [r.hdr, r.cenc]), [[true, true]]);   // asked for both
  assert.equal(h.loads.at(-1).stream.hdrEncrypted, true);                     // HDR answered, so cenc was never used
  assert.equal(h.loads.at(-1).stream.cenc, undefined);
});

test('a failed cenc live stream falls back to the usual time-shifted stream on AVPlay', async () => {
  const h = playback(async (stream) => { if (stream.cenc) throw new Error('Shaka error 6007'); }, true,
    { cencCapable: true, drm: true, settings: { hdr: false }, info: liveInfo });
  const ctx = video({ live: true });
  h.app.set(ctx); h.app.play(0, { startAt: 2000 });
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(h.requests.map((r) => r.cenc), [true, false]);
  assert.equal(ctx.cencFailed, true);
  assert.equal(h.loads.at(-1).stream.cenc, undefined);
  assert.ok(h.loads.at(-1).stream.startDelay > 5);
});
