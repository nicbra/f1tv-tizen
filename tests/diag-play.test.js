const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

// The contract's values, as the real diag-upload.js has them.
const VOCAB = (() => {
  const c = vm.createContext({ window: { addEventListener() {} }, Math, JSON, Date, setTimeout() {}, Uint8Array });
  vm.runInContext(readFileSync('app/js/diag-upload.js', 'utf8'), c);
  return c.DiagUpload.vocab;
})();

/** diag-play.js with a recording DiagUpload stub (or a disabled one) and a controllable clock and engine. */
function load({ enabled = true } = {}) {
  const events = [], clock = { now: Date.UTC(2026, 10, 18, 20) }, player = { engine: 'shaka' };
  let ids = 0;
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock.now; } },
    Math, JSON,
    DiagUpload: { vocab: VOCAB, enabled: () => enabled, attemptId: () => (enabled ? 'attempt-' + ++ids : null),
      event: (name, fields, level, id) => events.push({ name, fields: JSON.parse(JSON.stringify(fields)), level, id }) },
    Player: { engineName: () => player.engine, errorInfo: (e) => (e && e.diag) || { code: 'OTHER', platform: null } }
  });
  vm.runInContext(readFileSync('app/js/ways.js', 'utf8'), context, { filename: 'ways.js' });
  vm.runInContext(readFileSync('app/js/diag-play.js', 'utf8'), context, { filename: 'diag-play.js' });
  const P = context.DiagPlay;
  const wait = (ms) => { clock.now += ms; };
  /** One engine load that starts playing after `ms`. */
  function plays(t, stream, ms = 1000, from = 0) {
    P.loading(t, stream); wait(ms); P.loaded(t, stream, from); wait(600); P.tick(from + 0.6, false, false);
  }
  return { P, events, wait, player, plays, names: () => events.map((e) => e.name) };
}

const OFFER = { web: 'wv_dash', hdr: 'hdr_hls', cenc: 'wv_cenc_dash', chosen: 'hdr', max_height: 2160, hevc: true, multiview: 'hevc' };
const cenc = { capsPath: 'shaka:cenc', licenseUrl: 'x' };

test('a video that plays: one engine row, one outcome with the offer, a summary when left', () => {
  const t = load();
  const tr = t.P.request({ layout: null, feeds: 6, content: 'replay', tier: 'premium' });
  t.P.offered(tr, { offer: OFFER });
  t.plays(tr, cenc, 1500);
  t.wait(30000); t.P.tick(30, false, false);
  t.P.leave();
  assert.deepEqual(t.names(), ['playback.engine_attempt', 'playback.attempt_outcome', 'playback.summary']);
  assert.deepEqual(t.events[0].fields, { phase: 'start', engine: 'shaka', path: 'shaka:cenc', outcome: 'playing', time_to_progress_ms: 2100 });
  const o = t.events[1].fields;
  assert.equal(o.outcome, 'playing');
  assert.equal(o.tier, 'premium');
  assert.equal(o.content, 'replay');
  assert.equal(o.requested_layout, 'off');
  assert.equal(o.playing_layout, 'off');
  assert.equal(o.available_feeds, 6);
  assert.deepEqual(o.offer, OFFER);
  assert.equal(o.fallbacks_used, 0);
  assert.equal(o.total_time_to_play_ms, 2100);
  assert.equal(t.events[2].fields.watch_duration_bucket, 'lt_1m');
  assert.ok(t.events.every((e) => e.id === 'attempt-1'));
});

test('a fallback is a second trial of the same attempt; a final failure ends it with codes', () => {
  const t = load();
  t.player.engine = 'avplay';
  const tr = t.P.request({ layout: null, feeds: 1, content: 'live', tier: 'pro' });
  t.P.loading(tr); t.wait(3000); t.P.loaded(tr, { capsPath: 'avplay:cbcs', licenseUrl: 'x' }, 0);
  t.wait(15000);
  t.P.failed(null, null, { noProgress: true });
  t.player.engine = 'shaka';
  const tr2 = t.P.request({ layout: null, recover: true });
  t.P.loading(tr2, cenc); t.wait(1000);
  t.P.failed(tr2, { diag: { code: 'DRM_ERROR', platform: null } }, { final: true });
  t.P.leave();
  assert.deepEqual(t.events.map((e) => [e.name, e.fields.outcome, e.fields.error_code]), [
    ['playback.engine_attempt', 'failed', 'NO_PROGRESS'],
    ['playback.engine_attempt', 'failed', 'DRM_ERROR'],
    ['playback.attempt_outcome', 'failed', 'DRM_ERROR']
  ]);
  assert.equal(t.events[2].fields.fallbacks_used, 1);
  assert.equal(t.events[2].level, 'error');
  assert.equal(t.events[1].fields.engine, 'shaka');
});

test('feed switches are counted in the summary; only a failed one is a row', () => {
  const t = load();
  const tr = t.P.request({ layout: null, feeds: 6 });
  t.plays(tr, cenc);
  const sw = t.P.request({ layout: null, switching: true });
  t.plays(sw, cenc, 2000, 100);
  const bad = t.P.request({ layout: null, switching: true });
  t.P.loading(bad, cenc); t.wait(3000);
  t.P.failed(bad, { diag: { code: 'SHAKA_ERROR', platform: '6007' } });
  t.P.leave();
  assert.deepEqual(t.names(), ['playback.engine_attempt', 'playback.attempt_outcome', 'playback.engine_attempt', 'playback.summary']);
  assert.deepEqual(t.events[2].fields, { phase: 'switch', engine: 'shaka', path: 'shaka:cenc', outcome: 'failed', error_code: 'SHAKA_ERROR', platform_code: '6007' });
  const s = t.events[3].fields;
  assert.equal(s.stream_switch_count, 2);
  assert.equal(s.stream_switch_max_ms, 3000);
  assert.equal(s.stream_switch_total_ms, 2600 + 3000);
});

test('a new layout is a new attempt; leaving before a picture is a cancellation', () => {
  const t = load();
  const tr = t.P.request({ layout: null, feeds: 6 });
  t.plays(tr, cenc);
  const mv = t.P.request({ layout: 'big3', switching: true });
  t.P.loading(mv); t.wait(2000);
  t.P.leave();
  assert.deepEqual(t.events.map((e) => [e.name, e.fields.outcome || e.fields.watch_duration_bucket, e.id]), [
    ['playback.engine_attempt', 'playing', 'attempt-1'],
    ['playback.attempt_outcome', 'playing', 'attempt-1'],
    ['playback.summary', 'lt_1m', 'attempt-1'],
    ['playback.attempt_outcome', 'cancelled', 'attempt-2']
  ]);
  assert.equal(t.events[3].fields.requested_layout, 'big3');
});

test('buffering after the picture counts (half a second or more); a failure while playing goes into the summary', () => {
  const t = load();
  const tr = t.P.request({ layout: null });
  t.plays(tr, cenc);
  t.P.buffering(true, false); t.wait(300); t.P.buffering(false, false);
  t.P.buffering(true, false); t.wait(2500); t.P.buffering(false, false);
  t.P.buffering(true, true); t.wait(4000); t.P.buffering(false, true);   // during a jump: not counted
  t.P.failed(null, { diag: { code: 'AVPLAY_ERROR', platform: 'PLAYER_ERROR_CONNECTION_FAILED' } }, { runtime: true });
  t.P.leave();
  const s = t.events.find((e) => e.name === 'playback.summary');
  assert.equal(s.fields.buffering_count, 1);
  assert.equal(s.fields.buffering_total_ms, 2500);
  assert.equal(s.fields.error_code, 'AVPLAY_ERROR');
  assert.equal(s.fields.platform_code, 'PLAYER_ERROR_CONNECTION_FAILED');
  assert.equal(s.level, 'warn');
});

test('an H.264 multiview\'s small feeds are their own trial', () => {
  const t = load();
  t.player.engine = 'avplay';
  const tr = t.P.request({ layout: 'big3', feeds: 6 });
  t.plays(tr, { grid: { layout: 'big3' } });
  t.P.supplementaryStart(); t.wait(900); t.P.supplementary('playing');
  const rows = t.events.filter((e) => e.name === 'playback.engine_attempt').map((e) => e.fields);
  assert.deepEqual(rows[1], { phase: 'start', engine: 'mvsoft', path: 'mvsoft:h264', outcome: 'playing', time_to_progress_ms: 900 });
  assert.equal(rows[0].path, 'avplay:clear');
  assert.equal(t.events.find((e) => e.name === 'playback.attempt_outcome').fields.playing_layout, 'big3');
});

test('with diagnostics off nothing is tracked', () => {
  const t = load({ enabled: false });
  const tr = t.P.request({ layout: null });
  assert.equal(tr, null);
  t.plays(tr, cenc);
  t.P.leave();
  assert.deepEqual(t.events, []);
});

test('a failed switch without a retry ends at the failure; buffering after it counts', () => {
  const t = load();
  const tr = t.P.request({ layout: null, feeds: 6 });
  t.plays(tr, cenc);
  const bad = t.P.request({ layout: null, switching: true });
  t.P.loading(bad, cenc); t.wait(1000);
  t.P.failed(bad, { diag: { code: 'SHAKA_ERROR', platform: '6007' } });
  t.wait(1000); t.P.tick(10, false, false);
  t.P.buffering(true, false); t.wait(2000); t.P.buffering(false, false);
  t.wait(180000);
  t.P.leave();
  const s = t.events.find((e) => e.name === 'playback.summary').fields;
  assert.equal(s.stream_switch_count, 1);
  assert.equal(s.stream_switch_total_ms, 1000);
  assert.equal(s.buffering_count, 1);
});

test('a retried switch is one switch until the retry\'s picture moves', () => {
  const t = load();
  const tr = t.P.request({ layout: null, feeds: 6 });
  t.plays(tr, cenc);
  const sw = t.P.request({ layout: null, switching: true });
  t.P.loading(sw, cenc); t.wait(1000);
  t.P.failed(sw, { diag: { code: 'SHAKA_ERROR', platform: '6007' } });
  const retry = t.P.request({ layout: null, switching: true, recover: true });
  t.plays(retry, cenc, 2000, 50);
  t.P.leave();
  const s = t.events.find((e) => e.name === 'playback.summary').fields;
  assert.equal(s.stream_switch_count, 1);
  assert.equal(s.stream_switch_total_ms, 3600);
});

test('a stream refused before any engine loads is no engine row; the attempt fails once the app gives up', () => {
  const t = load();
  const tr = t.P.request({ layout: null });
  t.P.failed(tr, new Error('encrypted HDR stream'));
  t.P.gaveUp({ diag: { code: 'UNSUPPORTED', platform: null } }, null, tr);
  assert.deepEqual(t.names(), ['playback.attempt_outcome']);
  assert.equal(t.events[0].fields.error_code, 'UNSUPPORTED');
});

test('a late give-up of an older load leaves the newer attempt alone', () => {
  const t = load();
  const old = t.P.request({ layout: null });
  t.P.loading(old, cenc);
  t.P.leave();
  const tr = t.P.request({ layout: null });
  t.P.gaveUp({ diag: { code: 'NETWORK_ERROR', platform: null } }, null, old);
  t.plays(tr, cenc);
  const outcomes = t.events.filter((e) => e.name === 'playback.attempt_outcome').map((e) => e.fields.outcome);
  assert.deepEqual(outcomes, ['cancelled', 'playing']);
});

test('a seek before the picture moves is no progress: measured from where it landed', () => {
  const t = load();
  const tr = t.P.request({ layout: null });
  t.P.loading(tr, cenc); t.wait(1000); t.P.loaded(tr, cenc, 0);
  t.wait(500); t.P.tick(0, false, false);
  t.wait(500); t.P.tick(300, false, false);   // the viewer jumped ahead
  assert.deepEqual(t.events, []);
  t.wait(500); t.P.tick(300.2, false, false);
  assert.deepEqual(t.events, []);
  t.wait(500); t.P.tick(300.7, false, false);
  assert.equal(t.events[0].fields.outcome, 'playing');
});

test('an H.264 multiview plays once its small feeds show; if they never do, the big feed played alone', () => {
  const t = load();
  t.player.engine = 'avplay';
  const tr = t.P.request({ layout: 'big3', feeds: 6 });
  t.P.supplementaryStart();
  t.plays(tr, { grid: { layout: 'big3', engine: 'h264' } });
  assert.equal(t.events.filter((e) => e.name === 'playback.attempt_outcome').length, 0, 'not before the small feeds');
  t.P.supplementary('failed', null, { final: false });
  t.P.supplementaryStart();
  t.P.supplementary('failed', null, { final: true });
  const o = t.events.find((e) => e.name === 'playback.attempt_outcome').fields;
  assert.equal(o.outcome, 'playing');
  assert.equal(o.playing_layout, 'off');
  assert.equal(t.events.filter((e) => e.name === 'playback.engine_attempt' && e.fields.engine === 'mvsoft').length, 2);
});

test('a failure while playing that nothing follows ends a not-yet-playing attempt as failed', () => {
  const t = load();
  const tr = t.P.request({ layout: null });
  t.P.loading(tr, cenc); t.wait(500); t.P.loaded(tr, cenc, 0);
  t.P.failed(null, { diag: { code: 'DECODE_ERROR', platform: null } }, { runtime: true, final: true });
  const o = t.events.find((e) => e.name === 'playback.attempt_outcome').fields;
  assert.equal(o.outcome, 'failed');
  assert.equal(o.error_code, 'DECODE_ERROR');
});

test('a new consent epoch forgets the attempt under way', () => {
  const t = load();
  const tr = t.P.request({ layout: null });
  t.plays(tr, cenc);
  const n = t.events.length;
  t.P.reset();
  t.P.leave();
  assert.equal(t.events.length, n, 'no summary from before');
});

test('each way of playing is reported by its own name (multiview grids, clear 4K HDR, H.264 multiview\'s big feed)', () => {
  const paths = [];
  for (const [engine, stream] of [
    ['avplay', { capsPath: 'avplay:grid', grid: { layout: 'big3' } }],
    ['shaka', { capsPath: 'shaka:grid', grid: { layout: 'big3' } }],
    ['avplay', { capsPath: 'mvsoft:h264', grid: { layout: 'big3', engine: 'h264' } }],
    ['avplay', { capsPath: 'avplay:drmgrid', licenseUrl: 'x', hdrEncrypted: true, grid: { layout: 'big3' } }],
  ]) {
    const t = load();
    t.player.engine = engine;
    const tr = t.P.request({ layout: 'big3', feeds: 3, content: 'replay', tier: 'premium' });
    t.P.loading(tr); t.wait(1000); t.P.loaded(tr, stream, 0);
    t.wait(15000);
    t.P.failed(null, null, { noProgress: true, final: true });
    paths.push(t.events[0].fields.path);
  }
  assert.deepEqual(paths, ['avplay:grid', 'shaka:grid', 'mvsoft:h264', 'avplay:drmgrid']);
});
