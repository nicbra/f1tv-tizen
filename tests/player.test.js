const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function player() {
  const context = vm.createContext({ localStorage: { getItem: () => null, setItem() {} }, Date, Math, JSON });
  vm.runInContext(readFileSync('app/js/player.js', 'utf8'), context);
  return context.Player;
}

const T0 = Date.parse('2026-10-11T11:55:00Z') / 1000;

test('wallClock maps a DASH position to Unix time through the stream time base', () => {
  const P = player();
  const info = { epochAtZero: 1704067200 };
  assert.equal(P.wallClock(88794000, info), 1704067200 + 88794000);
});

test('wallClock follows HLS program date-time marks, including gaps between them', () => {
  const P = player();
  const info = { marks: [{ pos: 0, wall: T0 }, { pos: 12, wall: T0 + 30 }], epochAtZero: T0 };
  assert.equal(P.wallClock(5, info), T0 + 5);
  assert.equal(P.wallClock(12, info), T0 + 30);
  assert.equal(P.wallClock(20, info), T0 + 38);
});

test('wallClock is null when the timeline has no real clock time', () => {
  const P = player();
  assert.equal(P.wallClock(10, { epochAtZero: 0 }), null);
  assert.equal(P.wallClock(10, null), null);
  assert.equal(P.wallClock(10), null); // nothing playing
});

test('positionAt is the inverse of wallClock', () => {
  const P = player();
  const hls = { marks: [{ pos: 0, wall: T0 }, { pos: 12, wall: T0 + 30 }], epochAtZero: T0 };
  const dash = { epochAtZero: 1704067200 };
  for (const pos of [0, 5, 12, 20, 6000]) assert.equal(P.positionAt(P.wallClock(pos, hls), hls), pos);
  assert.equal(P.positionAt(P.wallClock(88794000, dash), dash), 88794000);
  assert.equal(P.positionAt(T0, null), null);
  assert.equal(P.positionAt(T0, { epochAtZero: 0 }), null);
});

test('with nothing loaded the player reports safe defaults', () => {
  const P = player();
  assert.equal(P.stream(), null);
  assert.equal(P.engineName(), null);
  assert.equal(P.isLive(), false);
  assert.equal(P.isPaused(), false);
  assert.equal(P.position(), 0);
  assert.deepEqual({ ...P.range() }, { start: 0, end: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(P.tracks())), { audio: [], text: [] });
  assert.equal(P.seekGrid(), null);
  P.setAudio('eng');
  P.setSubtitles('');
  P.seekBy(10);
  P.togglePause();
});
