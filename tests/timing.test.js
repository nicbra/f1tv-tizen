const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

/** Loads timing.js with a fake Worker (its messages are recorded) and a fetch for the season index. */
function timing(index) {
  const workers = [];
  class Worker {
    constructor(src) { this.src = src; this.sent = []; workers.push(this); }
    postMessage(m) { this.sent.push(JSON.parse(JSON.stringify(m))); }
  }
  const fetches = [];
  const fetch = async (url, init) => {
    fetches.push({ url, init });
    return index ? { ok: true, text: async () => '﻿' + JSON.stringify(index) } : { ok: false, text: async () => '' };
  };
  const context = vm.createContext({ Worker, fetch, setTimeout, Date, JSON });
  vm.runInContext(readFileSync('app/js/timing.js', 'utf8'), context);
  return { Timing: context.Timing, workers, fetches };
}

const tick = () => new Promise((r) => setImmediate(r));

test('supported is true only for F1 sessions with timing data', () => {
  const { Timing } = timing();
  const f1 = (title) => Timing.supported({ series: 'FORMULA 1', title });
  for (const t of ['Practice 1', 'Practice 3', 'Qualifying', 'Sprint Qualifying', 'Sprint Shootout', 'Sprint', 'Race']) assert.equal(f1(t), true, t);
  for (const t of ['Practice 3 Highlights', 'Pre-Race Show', 'Race Replay', '']) assert.equal(f1(t), false, t);
  assert.equal(Timing.supported({ series: 'F1 ACADEMY', title: 'Race' }), false);
  assert.equal(Timing.supported(null), false);
});

test('label shows the lap in races', () => {
  const { Timing } = timing();
  assert.equal(Timing.label({ type: 'Race', lap: 22, totalLaps: 62 }), 'Lap 22/62');
  assert.equal(Timing.label({ type: 'Race', lap: 3 }), 'Lap 3');
});

test('label shows the qualifying part and the time left', () => {
  const { Timing } = timing();
  assert.equal(Timing.label({ type: 'Qualifying', name: 'Qualifying', part: 2, remaining: 432 }), 'Q2 · 07:12 left');
  assert.equal(Timing.label({ type: 'Qualifying', name: 'Sprint Qualifying', part: 3, remaining: 65 }), 'SQ3 · 01:05 left');
  assert.equal(Timing.label({ type: 'Qualifying', name: 'Qualifying' }), 'Q1');
});

test('label shows practice sessions as FP with the time left', () => {
  const { Timing } = timing();
  assert.equal(Timing.label({ type: 'Practice', name: 'Practice 2', remaining: 1930 }), 'FP2 · 32:10 left');
});

test('label adds flags and safety cars, and is empty without timing', () => {
  const { Timing } = timing();
  assert.equal(Timing.label({ type: 'Race', lap: 40, totalLaps: 56, track: '4' }), 'Lap 40/56 · Safety car');
  assert.equal(Timing.label({ type: 'Race', lap: 40, track: '5' }), 'Lap 40 · Red flag');
  assert.equal(Timing.label({ type: 'Race', lap: 40, track: '1' }), 'Lap 40');
  assert.equal(Timing.label(null), '');
});

const meta = { title: 'Race', series: 'FORMULA 1', meeting: 'Singapore Grand Prix', meetingKey: 1281,
  start: Date.parse('2026-10-11T12:00:00Z'), endIso: '2026-10-11T22:00:00+08:00', meetingEnd: Date.parse('2026-10-11T23:59:59Z') };

test('load finds the session folder in the season index and starts the worker with it', async () => {
  const index = { Meetings: [{ Key: 1281, Sessions: [{ Name: 'Qualifying', Path: '2026/q/' }, { Name: 'Race', Path: '2026/2026-10-11_Singapore_Grand_Prix/2026-10-11_Race/' }] }] };
  const { Timing, workers, fetches } = timing(index);
  Timing.load(meta, 'TOKEN', false);
  await tick(); await tick();
  assert.equal(fetches[0].url, 'https://livetiming.formula1.com/static/2026/Index.json');
  assert.equal(fetches[0].init.headers.Authorization, 'Bearer TOKEN');
  assert.equal(workers[0].src, 'js/timing-worker.js');
  assert.deepEqual(workers[0].sent.at(-1), { cmd: 'load', path: '2026/2026-10-11_Singapore_Grand_Prix/2026-10-11_Race/', token: 'TOKEN', live: false });
});

test('load builds the folder from local dates when the session is not indexed yet', async () => {
  const { Timing, workers } = timing({ Meetings: [] });
  // Practice 3 in Austin: 11:30 local (UTC-5) on Saturday; the race is on Sunday.
  Timing.load({ title: 'Practice 3', series: 'FORMULA 1', meeting: 'United States Grand Prix', meetingKey: 1300,
    start: Date.parse('2026-10-24T16:30:00Z'), endIso: '2026-10-24T12:30:00-05:00' }, 'T', true);
  await tick(); await tick();
  assert.equal(workers[0].sent.at(-1).path, '2026/2026-10-25_United_States_Grand_Prix/2026-10-24_Practice_3/');
  assert.equal(workers[0].sent.at(-1).live, true);
});

test('load uses the local date even when the session crosses midnight in UTC', async () => {
  const { Timing, workers } = timing({ Meetings: [] });
  // Las Vegas: 22:00 local on Saturday is 06:00 UTC on Sunday.
  Timing.load({ title: 'Race', series: 'FORMULA 1', meeting: 'Las Vegas Grand Prix', meetingKey: 1, start: Date.parse('2026-11-22T06:00:00Z'),
    endIso: '2026-11-21T22:00:00-08:00', meetingEnd: Date.parse('2026-11-21T23:59:59Z') }, 'T', false);
  await tick(); await tick();
  assert.equal(workers[0].sent.at(-1).path, '2026/2026-11-21_Las_Vegas_Grand_Prix/2026-11-21_Race/');
});

test('load does nothing for content without timing, and does not reload the same session', async () => {
  const { Timing, workers, fetches } = timing({ Meetings: [] });
  Timing.load({ title: 'Pre-Race Show', series: 'FORMULA 1' }, 'T', false);
  assert.equal(workers.length, 0);
  Timing.load(meta, 'T', false);
  Timing.load(meta, 'T', false);
  await tick(); await tick();
  assert.equal(fetches.length, 1);
});

test('query answers through the worker once it has loaded', async () => {
  const { Timing, workers } = timing({ Meetings: [] });
  assert.equal(await Timing.query(1000), null); // nothing loaded
  Timing.load(meta, 'T', false);
  await tick(); await tick();
  const w = workers[0];
  assert.equal(Timing.isReady(), false);
  w.onmessage({ data: { type: 'loaded', info: {} } });
  assert.equal(Timing.isReady(), true);
  const answer = Timing.query(1234);
  const q = w.sent.at(-1);
  assert.equal(q.cmd, 'query');
  assert.equal(q.t, 1234);
  w.onmessage({ data: { type: 'state', id: q.id, state: { lap: 5 } } });
  assert.deepEqual(await answer, { lap: 5 });
});

test('stop clears the ready state and tells the worker', async () => {
  const { Timing, workers } = timing({ Meetings: [] });
  Timing.load(meta, 'T', false);
  await tick(); await tick();
  workers[0].onmessage({ data: { type: 'loaded', info: {} } });
  Timing.stop();
  assert.equal(Timing.isReady(), false);
  assert.deepEqual(workers[0].sent.at(-1), { cmd: 'stop' });
  assert.equal(await Timing.query(1), null);
});
