const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

/**
 * Loads timing.js with a fake Worker (its messages are recorded) and a fetch for the season index;
 * exists(url) says which other archive files exist.
 */
function timing(index, exists) {
  const workers = [];
  class Worker {
    constructor(src) { this.src = src; this.sent = []; workers.push(this); }
    postMessage(m) { this.sent.push(JSON.parse(JSON.stringify(m))); }
  }
  const fetches = [];
  const fetch = async (url, init) => {
    fetches.push({ url, init });
    if (!url.endsWith('/Index.json')) return { ok: !!exists && exists(url), text: async () => '' };
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
  // Other names F1 TV gives sessions, mostly in 2018-2020.
  const other = { 'F1 Practice 3': 'Practice 3', 'F1 Qualifying': 'Qualifying', 'Race Replay': 'Race', 'Qualifying Replay': 'Qualifying',
    'Sprint shootout': 'Sprint Shootout', 'F1 Sprint': 'Sprint', '2018 Monaco Grand Prix - Full Race': 'Race',
    '2018 Australian GP - F1 FP2': 'Practice 2', '2018 Canadian Grand Prix - Qualifying': 'Qualifying' };
  for (const [t, name] of Object.entries(other)) { assert.equal(f1(t), true, t); assert.equal(Timing.sessionName(t), name, t); }
  for (const t of ['Practice 3 Highlights', 'Pre-Race Show', 'Race - F1 Kids', 'F1 Kids Sprint', 'Weekend Warm-Up', '']) assert.equal(f1(t), false, t);
  assert.equal(Timing.supported({ series: 'F1 ACADEMY', title: 'Race' }), false);
  assert.equal(Timing.supported(null), false);
});

test('label shows the lap in races', () => {
  const { Timing } = timing();
  assert.equal(Timing.label({ type: 'Race', lap: 22, totalLaps: 62 }), 'Lap 22/62');
  assert.equal(Timing.label({ type: 'Race', lap: 3 }), 'Lap 3');
  assert.equal(Timing.label({ type: 'Race', lap: 22, totalLaps: 62 }, true), 'Lap 22'); // the seek bubble
  assert.equal(Timing.label({ type: 'Race', lap: 1, totalLaps: 62, beforeStart: true }), 'Not started');
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

test('load finds older replays by their session key, and the season by the video year', async () => {
  // 2019 German GP: no start date, and the video says "F1 Qualifying".
  const index = { Meetings: [{ Key: 1010, Sessions: [{ Key: 5477, Name: 'Practice 3', Path: '2019/p3/' }, { Key: 5478, Name: 'Qualifying', Path: '2019/q/' }] }] };
  const { Timing, workers, fetches } = timing(index);
  Timing.load({ title: 'F1 Qualifying', series: 'FORMULA 1', meeting: 'German Grand Prix', meetingKey: '1010', sessionKey: '5478',
    year: '2019', endIso: '2019-12-31T23:59:59+00:00' }, 'T', false);
  await tick(); await tick();
  assert.equal(fetches[0].url, 'https://livetiming.formula1.com/static/2019/Index.json');
  assert.equal(workers[0].sent.at(-1).path, '2019/q/');
  // The 2024 Abu Dhabi race is a "Race Replay"; its key finds it even when the names differ.
  const t2 = timing({ Meetings: [{ Key: 1252, Sessions: [{ Key: 9662, Name: 'Race', Path: '2024/race/' }] }] });
  t2.Timing.load({ title: 'Race Replay', series: 'FORMULA 1', meetingKey: '1252', sessionKey: '9662', year: '2024', start: 1733662800000 }, 'T', false);
  await tick(); await tick();
  assert.equal(t2.workers[0].sent.at(-1).path, '2024/race/');
});

test('load gives up on a session that is neither indexed nor dated', async () => {
  // 2018 Australia is missing from the 2018 index, and its videos have no start date.
  const { Timing, workers } = timing({ Meetings: [] });
  Timing.load({ title: 'Race', series: 'FORMULA 1', meeting: 'Australian Grand Prix', meetingKey: '979', sessionKey: '5066', year: '2018' }, 'T', false);
  await tick(); await tick(); await tick();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].sent.filter((m) => m.cmd === 'load').length, 0);
});

test('load builds a Saturday race folder from its own date, and finds the folder of the sessions before it', async () => {
  // Bahrain 2024 (not in the 2024 index): race on Saturday 2 March, qualifying on Friday.
  const bahrain = { series: 'FORMULA 1', meeting: 'Bahrain Grand Prix', meetingKey: '1229', year: '2024' };
  const race = timing({ Meetings: [] });
  race.Timing.load({ ...bahrain, title: 'Race', start: Date.parse('2024-03-02T15:00:00Z'), endIso: '2024-03-02T20:00:00+03:00' }, 'T', false);
  await tick(); await tick();
  assert.equal(race.workers[0].sent.at(-1).path, '2024/2024-03-02_Bahrain_Grand_Prix/2024-03-02_Race/');
  const imola = timing({ Meetings: [] });
  imola.Timing.load({ ...bahrain, meeting: 'Emilia-Romagna Grand Prix', title: 'Race', start: Date.parse('2024-05-19T13:00:00Z'),
    endIso: '2024-05-19T17:00:00+02:00' }, 'T', false);
  await tick(); await tick();
  assert.equal(imola.workers[0].sent.at(-1).path, '2024/2024-05-19_Emilia_Romagna_Grand_Prix/2024-05-19_Race/');
  const quali = timing({ Meetings: [] }, (url) => url.includes('/2024-03-02_Bahrain_Grand_Prix/'));
  quali.Timing.load({ ...bahrain, title: 'Qualifying', start: Date.parse('2024-03-01T16:00:00Z'), endIso: '2024-03-01T20:00:00+03:00' }, 'T', false);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(quali.workers[0].sent.at(-1).path, '2024/2024-03-02_Bahrain_Grand_Prix/2024-03-01_Qualifying/');
  // Neither folder there yet (a session before it is archived): the Sunday one, as before.
  const live = timing({ Meetings: [] }, () => false);
  live.Timing.load({ ...bahrain, title: 'Qualifying', start: Date.parse('2024-03-01T16:00:00Z'), endIso: '2024-03-01T20:00:00+03:00' }, 'T', true);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(live.workers[0].sent.at(-1).path, '2024/2024-03-03_Bahrain_Grand_Prix/2024-03-01_Qualifying/');
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

test('a session whose timing failed to load is tried again on the next load', async () => {
  // The season index failed (a network error): nothing loaded, and the key must not stick.
  let fail = true;
  const workers = [];
  class Worker { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } }
  const fetch = async () => { if (fail) throw new Error('offline'); return { ok: true, text: async () => JSON.stringify({ Meetings: [] }) }; };
  const vm = require('node:vm');
  let now = Date.parse('2026-10-28T20:00:00Z');
  const context = vm.createContext({ Worker, fetch, setTimeout, JSON, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(readFileSync('app/js/timing.js', 'utf8'), context);
  context.Timing.load(meta, 'T', false);
  await tick(); await tick();
  assert.equal(workers[0].sent.filter((m) => m.cmd === 'load').length, 0);
  fail = false;
  // Not on every feed switch: a minute later.
  context.Timing.load(meta, 'T', false);
  await tick(); await tick();
  assert.equal(workers[0].sent.filter((m) => m.cmd === 'load').length, 0);
  now += 61000;
  context.Timing.load(meta, 'T', false);
  await tick(); await tick();
  assert.equal(workers[0].sent.filter((m) => m.cmd === 'load').length, 1);
  // A worker error (no archive, as for 2022) likewise.
  workers[0].onmessage({ data: { type: 'error', message: 'No timing data for this session yet' } });
  context.Timing.load(meta, 'T', false);
  await tick(); await tick();
  assert.equal(workers[0].sent.filter((m) => m.cmd === 'load').length, 1);
  now += 61000;
  context.Timing.load(meta, 'T', false);
  await tick(); await tick();
  assert.equal(workers[0].sent.filter((m) => m.cmd === 'load').length, 2);
});

test('the session key finds a session the index names differently', async () => {
  const { Timing, workers } = timing({ Meetings: [{ Key: 1252, Sessions: [{ Key: 9662, Name: 'Grand Prix', Path: '2024/race/' }] }] });
  Timing.load({ title: 'Race Replay', series: 'FORMULA 1', meeting: 'Abu Dhabi Grand Prix', meetingKey: '1252', sessionKey: '9662', year: '2024',
    start: 1733662800000 }, 'T', false);
  await tick(); await tick();
  assert.equal(workers[0].sent.at(-1).path, '2024/race/');
});
