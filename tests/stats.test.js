const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const API = 'https://api.jolpi.ca/ergast/f1/current';
const TIMING = 'https://livetiming.formula1.com/static/';

// Loads a fresh copy of stats.js (its request cache is per-instance). `routes` maps an API path
// (e.g. "/results.json") or a full URL to a handler (url, init) => body | { status } | throws.
// clock (optional): { now } in ms, to test cache expiry.
function load(routes, stored, clock) {
  const calls = [];
  const store = Object.assign({}, stored);
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = url.startsWith(API) ? u.pathname.replace('/ergast/f1/current', '') : url;
    const handler = routes[key] || routes[url.split('?')[0]];
    if (!handler) return { ok: false, status: 404 };
    const out = typeof handler === 'function' ? handler(u, init) : handler;
    if (out && out.status) return { ok: false, status: out.status };
    if (typeof out === 'string') return { ok: true, text: async () => out };
    return { ok: true, json: async () => out };
  };
  const context = vm.createContext({
    fetch,
    ...(clock ? { Date: class extends Date { static now() { return clock.now; } } } : {}),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    }
  });
  vm.runInContext(readFileSync('app/js/stats.js', 'utf8'), context);
  return { stats: context.Stats, calls, store };
}

// vm-created objects have a different Object prototype, so compare via JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

const driver = (id, code, given, family, extra) => Object.assign({ driverId: id, code, givenName: given, familyName: family, permanentNumber: '1', nationality: 'Dutch' }, extra);
const ver = driver('max_verstappen', 'VER', 'Max', 'Verstappen', { permanentNumber: '33' });
const ham = driver('hamilton', 'HAM', 'Lewis', 'Hamilton', { permanentNumber: '44', nationality: 'British' });
const rb = { constructorId: 'red_bull', name: 'Red Bull' };
const fer = { constructorId: 'ferrari', name: 'Ferrari' };
const mer = { constructorId: 'mercedes', name: 'Mercedes' };

const mr = (table, extra) => ({ MRData: Object.assign({ limit: '100', offset: '0', total: '1' }, table, extra) });
const raceTable = (Races, extra) => mr({ RaceTable: { Races } }, extra);
const race = (round, name, extra) => Object.assign({ round: String(round), raceName: name, Circuit: { Location: { country: 'Australia' } } }, extra);
const row = (dr, c, points, extra) => Object.assign({ Driver: dr, Constructor: c, points: String(points) }, extra);

// ---- standings ----

test('driverStandings parses positions, points, wins, names, team ids and codes', async () => {
  const { stats } = load({
    '/driverStandings.json': mr({
      StandingsTable: {
        StandingsLists: [{
          round: '5',
          DriverStandings: [
            { position: '1', positionText: '1', points: '110', wins: '3', Driver: ver, Constructors: [rb] },
            // a driver who switched teams mid-season: the last constructor is the current one
            { position: '2', positionText: '2', points: '90.5', wins: '1', Driver: ham, Constructors: [mer, fer] }
          ]
        }]
      }
    })
  });
  const s = plain(await stats.driverStandings());
  assert.equal(s.round, 5);
  assert.equal(s.drivers.length, 2);
  assert.deepEqual(s.drivers[0], {
    pos: 1, points: 110, wins: 3, id: 'max_verstappen', code: 'VER', number: '33', first: 'Max', last: 'Verstappen',
    nationality: 'Dutch', team: 'Red Bull', teamId: 'red_bull'
  });
  assert.equal(s.drivers[1].points, 90.5);
  assert.equal(s.drivers[1].teamId, 'ferrari');
  assert.equal(s.drivers[1].team, 'Ferrari');
});

test('driverStandings with no standings list yet resolves round 0 and no drivers', async () => {
  const { stats } = load({ '/driverStandings.json': mr({ StandingsTable: { StandingsLists: [] } }) });
  assert.deepEqual(plain(await stats.driverStandings()), { round: 0, drivers: [] });
});

test('driverStandings rejects on an HTTP error and retries instead of caching the failure', async () => {
  let attempts = 0;
  const { stats } = load({
    '/driverStandings.json': () => (++attempts === 1 ? { status: 503 } : mr({ StandingsTable: { StandingsLists: [] } }))
  });
  await assert.rejects(stats.driverStandings(), /HTTP 503/);
  assert.equal((await stats.driverStandings()).round, 0);
  assert.equal(attempts, 2);
});

test('constructorStandings parses positions, points, wins, ids and names', async () => {
  const { stats } = load({
    '/constructorStandings.json': mr({
      StandingsTable: {
        StandingsLists: [{
          ConstructorStandings: [
            { position: '1', points: '200', wins: '4', Constructor: rb },
            { position: '2', points: '150', wins: '1', Constructor: fer }
          ]
        }]
      }
    })
  });
  const t = plain(await stats.constructorStandings());
  assert.deepEqual(t, [
    { pos: 1, points: 200, wins: 4, id: 'red_bull', name: 'Red Bull' },
    { pos: 2, points: 150, wins: 1, id: 'ferrari', name: 'Ferrari' }
  ]);
});

test('lastRace returns the round and a shortened name, or null when unavailable', async () => {
  const ok = load({ '/last/results.json': raceTable([race(7, 'Monaco Grand Prix')]) });
  assert.deepEqual(plain(await ok.stats.lastRace()), { round: 7, name: 'Monaco GP' });

  const empty = load({ '/last/results.json': raceTable([]) });
  assert.equal(await empty.stats.lastRace(), null);

  const down = load({ '/last/results.json': { status: 500 } });
  assert.equal(await down.stats.lastRace(), null);
});

// ---- driverSeason ----

function seasonRoutes() {
  const r1 = race(1, 'Australian Grand Prix');
  const r2 = race(2, 'Chinese Grand Prix', { Circuit: { Location: { country: 'China' } } });
  const r3 = race(3, 'Japanese Grand Prix');
  const r4 = race(4, 'Bahrain Grand Prix');
  return {
    '/drivers/max_verstappen/results.json': raceTable([
      Object.assign({}, r1, { Results: [{ position: '1', positionText: '1', grid: '2', points: '25', status: 'Finished', FastestLap: { rank: '1' } }] }),
      Object.assign({}, r2, { Results: [{ position: '5', positionText: '5', grid: '0', points: '10', status: '+1 Lap', FastestLap: { rank: '4' } }] }),
      Object.assign({}, r3, { Results: [{ position: '6', positionText: '6', grid: '4', points: '8', status: 'Lapped' }] }),
      Object.assign({}, r4, { Results: [{ position: '18', positionText: 'R', grid: '1', points: '0', status: 'Engine' }] })
    ]),
    '/drivers/max_verstappen/qualifying.json': raceTable([
      Object.assign({}, r1, { QualifyingResults: [{ position: '2' }] }),
      Object.assign({}, r4, { QualifyingResults: [{ position: '1' }] })
    ]),
    '/drivers/max_verstappen/sprint.json': raceTable([
      Object.assign({}, r2, { SprintResults: [{ position: '3', points: '6' }] }),
      Object.assign({}, r3, { SprintResults: [{ position: 'R', points: '0' }] })
    ])
  };
}

test('driverSeason merges race results with quali, sprint, fastest lap and grid', async () => {
  const { stats } = load(seasonRoutes());
  const s = plain(await stats.driverSeason('max_verstappen'));
  assert.equal(s.length, 4);
  assert.deepEqual(s[0], {
    round: 1, name: 'Australian GP', country: 'Australia', pos: 1, posText: '1', grid: 2, points: 25,
    status: 'Finished', fastest: true, quali: 2, sprint: null
  });
  // grid "0" (pit lane start) becomes null; fastest-lap rank other than 1 is not fastest
  assert.equal(s[1].grid, null);
  assert.equal(s[1].fastest, false);
  assert.equal(s[1].country, 'China');
  assert.deepEqual(s[1].sprint, { pos: 3, points: 6 });
  // a sprint that was not classified has no position
  assert.deepEqual(s[2].sprint, { pos: null, points: 0 });
  assert.equal(s[3].quali, 1);
});

test('driverSeason counts Finished, +N Lap(s) and Lapped as classified and everything else as DNF', async () => {
  const { stats } = load(seasonRoutes());
  const s = plain(await stats.driverSeason('max_verstappen'));
  assert.deepEqual(s.map((r) => r.pos), [1, 5, 6, null]);
  assert.equal(s[3].posText, 'R');

  const statuses = ['Finished', '+1 Lap', '+2 Laps', 'Lapped', 'Disqualified', 'Retired', 'Accident', 'Finished early'];
  const rows = statuses.map((status, i) => Object.assign(race(i + 1, 'X Grand Prix'), {
    Results: [{ position: String(i + 1), positionText: String(i + 1), grid: '1', points: '0', status }]
  }));
  const t = load({ '/drivers/x/results.json': raceTable(rows) });
  const pos = plain(await t.stats.driverSeason('x')).map((r) => r.pos);
  assert.deepEqual(pos, [1, 2, 3, 4, null, null, null, null]);
});

test('driverSeason still works when qualifying and sprint data fail to load', async () => {
  const routes = seasonRoutes();
  routes['/drivers/max_verstappen/qualifying.json'] = { status: 500 };
  delete routes['/drivers/max_verstappen/sprint.json']; // 404
  const { stats } = load(routes);
  const s = plain(await stats.driverSeason('max_verstappen'));
  assert.equal(s.length, 4);
  assert.ok(s.every((r) => r.quali === null && r.sprint === null));
});

// ---- summary ----

test('summary tallies wins, podiums, poles, fastest laps, DNFs, best and average finish', async () => {
  const { stats } = load(seasonRoutes());
  const races = await stats.driverSeason('max_verstappen');
  const s = plain(stats.summary(races));
  assert.equal(s.wins, 1);
  assert.equal(s.podiums, 1);
  assert.equal(s.poles, 1);
  assert.equal(s.fastestLaps, 1);
  assert.equal(s.dnfs, 1);
  assert.equal(s.best, 1);
  assert.equal(s.finishes, 3);
  assert.equal(s.avg, (1 + 5 + 6) / 3); // DNFs are left out of the average
  assert.equal(s.points, 25 + 10 + 8 + 0 + 6); // race points plus sprint points
});

test('summary of an empty season has zero counts and no best or average', () => {
  const { stats } = load({});
  const s = plain(stats.summary([]));
  assert.equal(s.wins + s.podiums + s.poles + s.fastestLaps + s.dnfs + s.finishes + s.points, 0);
  assert.equal(s.best, null);
  assert.equal(s.avg, null);
});

test('summary of a season of only DNFs counts them all and has no best or average', () => {
  const { stats } = load({});
  const dnf = { pos: null, points: 0, quali: null, fastest: false, sprint: null };
  const s = plain(stats.summary([dnf, dnf, Object.assign({}, dnf, { quali: 1 })]));
  assert.equal(s.dnfs, 3);
  assert.equal(s.poles, 1); // a pole still counts when the race is retired
  assert.equal(s.finishes, 0);
  assert.equal(s.best, null);
  assert.equal(s.avg, null);
});

// ---- seasonProgress ----

test('seasonProgress lists rounds in order with per-round points for drivers and teams including sprints', async () => {
  const { stats } = load({
    // deliberately out of round order in the response
    '/results.json': raceTable([
      race(2, 'Chinese Grand Prix', { Results: [row(ver, rb, 18), row(ham, fer, 25)] }),
      race(1, 'Australian Grand Prix', { Results: [row(ver, rb, 25), row(ham, fer, 15)] })
    ]),
    '/sprint.json': raceTable([
      race(2, 'Chinese Grand Prix', { SprintResults: [row(ver, rb, 8), row(ham, fer, 7)] })
    ])
  });
  const p = plain(await stats.seasonProgress());
  assert.deepEqual(p.rounds, [{ round: 1, name: 'Australian GP' }, { round: 2, name: 'Chinese GP' }]);
  assert.deepEqual(p.drivers.max_verstappen.perRound, { 1: 25, 2: 26 });
  assert.deepEqual(p.drivers.hamilton.perRound, { 1: 15, 2: 32 });
  assert.equal(p.drivers.max_verstappen.code, 'VER');
  assert.equal(p.drivers.max_verstappen.name, 'Max Verstappen');
  assert.equal(p.drivers.max_verstappen.teamId, 'red_bull');
  assert.equal(p.drivers.max_verstappen.team, 'Red Bull');
  assert.deepEqual(p.teams.red_bull, { name: 'Red Bull', perRound: { 1: 25, 2: 26 } });
  assert.deepEqual(p.teams.ferrari.perRound, { 1: 15, 2: 32 });
});

test('seasonProgress sums team points across both drivers in a round', async () => {
  const lec = driver('leclerc', 'LEC', 'Charles', 'Leclerc');
  const { stats } = load({
    '/results.json': raceTable([race(1, 'Australian Grand Prix', { Results: [row(ham, fer, 18), row(lec, fer, 12)] })]),
    '/sprint.json': { status: 404 } // failing sprint endpoint is tolerated
  });
  const p = plain(await stats.seasonProgress());
  assert.deepEqual(p.teams.ferrari.perRound, { 1: 30 });
  assert.deepEqual(p.drivers.leclerc.perRound, { 1: 12 });
});

test('seasonProgress merges a race split across two pages without double-counting or dropping rows', async () => {
  const lec = driver('leclerc', 'LEC', 'Charles', 'Leclerc');
  const page = (offset) => {
    if (offset === 0) {
      // round 1 complete, round 2 only has its first two result rows
      return raceTable([
        race(1, 'Australian Grand Prix', { Results: [row(ver, rb, 25), row(ham, fer, 18), row(lec, fer, 15)] }),
        race(2, 'Chinese Grand Prix', { Results: [row(ver, rb, 25), row(ham, fer, 18)] })
      ], { offset: '0', limit: '100', total: '103' });
    }
    // second page starts mid-race: same round 2, remaining rows, then round 3
    return raceTable([
      race(2, 'Chinese Grand Prix', { Results: [row(lec, fer, 15)] }),
      race(3, 'Japanese Grand Prix', { Results: [row(ver, rb, 25)] })
    ], { offset: '100', limit: '100', total: '103' });
  };
  const { stats } = load({
    '/results.json': (u) => page(+u.searchParams.get('offset')),
    '/sprint.json': raceTable([], { total: '0' })
  });
  const p = plain(await stats.seasonProgress());
  assert.deepEqual(p.rounds.map((r) => r.round), [1, 2, 3]);
  assert.deepEqual(p.drivers.max_verstappen.perRound, { 1: 25, 2: 25, 3: 25 });
  assert.deepEqual(p.drivers.hamilton.perRound, { 1: 18, 2: 18 });
  assert.deepEqual(p.drivers.leclerc.perRound, { 1: 15, 2: 15 });
  assert.deepEqual(p.teams.ferrari.perRound, { 1: 33, 2: 33 });
  assert.deepEqual(p.teams.red_bull.perRound, { 1: 25, 2: 25, 3: 25 });
});

test('seasonProgress keeps fetching pages until total is reached, then stops', async () => {
  const offsets = [];
  const { stats, calls } = load({
    '/results.json': (u) => {
      const offset = +u.searchParams.get('offset');
      offsets.push(offset);
      const round = offset / 100 + 1;
      return raceTable([race(round, 'R' + round + ' Grand Prix', { Results: [row(ver, rb, 10)] })],
        { offset: String(offset), limit: '100', total: '250' });
    },
    '/sprint.json': raceTable([], { total: '0' })
  });
  const p = plain(await stats.seasonProgress());
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.equal(p.rounds.length, 3);
  assert.deepEqual(p.drivers.max_verstappen.perRound, { 1: 10, 2: 10, 3: 10 });
  assert.ok(calls.every((c) => c.url.includes('limit=100')));

  // result is cached: a second call does not refetch
  const before = calls.length;
  await stats.seasonProgress();
  assert.equal(calls.length, before);
});

// ---- driverInfo ----

const index = (year) => JSON.stringify({
  Meetings: [
    { Sessions: [{ Path: year + '/m1/Practice/' }, { Path: year + '/m1/Race/' }] },
    { Sessions: [{ Name: 'Not yet run' }, { Path: year + '/m2/Qualifying/' }] }
  ]
});
const ts = '00:00:00.000';
const driverList = '﻿' + [
  ts + JSON.stringify({ 1: { Tla: 'VER', TeamColour: '3671C6', HeadshotUrl: 'https://img/ver.png', TeamName: 'Red Bull Racing' } }),
  ts + JSON.stringify({ 44: { Tla: 'HAM', TeamColour: 'E80020', TeamName: 'Ferrari' } }),
  ts + JSON.stringify({ 44: { HeadshotUrl: 'https://img/ham.png' } }), // partial update merges into the driver
  ts + JSON.stringify({ 99: { RacingNumber: '99' } }), // no Tla: skipped
  ts + '{"4":{"Tla":"NOR"' // truncated line: skipped
].join('\n');

function timingRoutes() {
  const year = new Date().getUTCFullYear();
  return {
    [TIMING + year + '/Index.json']: '﻿' + index(year),
    [TIMING + year + '/m2/Qualifying/DriverList.jsonStream']: driverList
  };
}

test('driverInfo sends the bearer token and builds the code map from the latest session DriverList', async () => {
  const { stats, calls } = load(timingRoutes());
  const info = plain(await stats.driverInfo('tok123'));
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.equal(c.init.headers.Authorization, 'Bearer tok123');
  // the last session with a path in the index is the one used
  assert.ok(calls[1].url.endsWith('/m2/Qualifying/DriverList.jsonStream'));
  assert.deepEqual(info, {
    VER: { colour: '#3671C6', headshot: 'https://img/ver.png', team: 'Red Bull Racing' },
    HAM: { colour: '#E80020', headshot: 'https://img/ham.png', team: 'Ferrari' }
  });
});

test('driverInfo uses the one-day cache on the second call without fetching', async () => {
  const { stats, calls, store } = load(timingRoutes());
  const first = plain(await stats.driverInfo('tok'));
  const fetched = calls.length;
  assert.ok(fetched > 0);
  assert.ok(store['f1tv.drivers']);
  const second = plain(await stats.driverInfo('tok'));
  assert.equal(calls.length, fetched);
  assert.deepEqual(second, first);
});

test('driverInfo ignores a cache older than a day and refetches', async () => {
  const stale = JSON.stringify({ at: Date.now() - 86400000 - 1000, byCode: { OLD: { colour: '', headshot: '', team: '' } } });
  const { stats, calls } = load(timingRoutes(), { 'f1tv.drivers': stale });
  const info = plain(await stats.driverInfo('tok'));
  assert.ok(calls.length > 0);
  assert.ok(info.VER && !info.OLD);
});

test('driverInfo resolves {} when the fetch fails and does not cache the failure', async () => {
  const year = new Date().getUTCFullYear();
  const failing = load({ [TIMING + year + '/Index.json']: () => { throw new Error('offline'); } });
  assert.deepEqual(plain(await failing.stats.driverInfo('tok')), {});
  assert.equal(failing.store['f1tv.drivers'], undefined);

  const bad = load({ [TIMING + year + '/Index.json']: 'not json' });
  assert.deepEqual(plain(await bad.stats.driverInfo('tok')), {});
});

test('driverInfo resolves {} without fetching when there is no token and no cache', async () => {
  const { stats, calls } = load(timingRoutes());
  assert.deepEqual(plain(await stats.driverInfo('')), {});
  assert.equal(calls.length, 0);
});

test('standings are reused for ten minutes, then fetched again', async () => {
  const clock = { now: Date.parse('2026-10-25T20:00:00Z') };
  let points = 100;
  const { stats, calls } = load({
    '/driverStandings.json': () => ({ MRData: { StandingsTable: { StandingsLists: [{ round: '18', DriverStandings: [
      { position: '1', points: String(points), wins: '1', Driver: ver, Constructors: [rb] }] }] } } })
  }, {}, clock);
  assert.equal((await stats.driverStandings()).drivers[0].points, 100);
  points = 125; // the race has finished
  clock.now += 9 * 60000;
  assert.equal((await stats.driverStandings()).drivers[0].points, 100);
  clock.now += 2 * 60000;
  assert.equal((await stats.driverStandings()).drivers[0].points, 125);
  assert.equal(calls.length, 2);
});

test('seasonProgress follows the page size the API actually answers with', async () => {
  const offsets = [];
  const { stats } = load({
    '/results.json': (u) => {
      const offset = +u.searchParams.get('offset');
      offsets.push(offset);
      const round = offset / 30 + 1;
      return raceTable([race(round, 'R' + round + ' Grand Prix', { Results: [row(ver, rb, 10)] })],
        { offset: String(offset), limit: '30', total: '75' });
    },
    '/sprint.json': raceTable([], { total: '0' })
  });
  const p = plain(await stats.seasonProgress());
  assert.deepEqual(offsets, [0, 30, 60]);
  assert.equal(p.rounds.length, 3);
});
