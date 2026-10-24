const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const SOURCE = readFileSync('app/js/timing-worker.js', 'utf8');
const PATH = '2024/test-gp/Race/';
const T0 = Date.parse('2024-05-05T12:00:00.000Z');
const at = (sec) => T0 + sec * 1000;
const iso = (sec) => new Date(at(sec)).toISOString();

// One archive line: HH:MM:SS.mmm followed by the JSON patch.
function line(sec, data) {
  const ms = Math.round(sec * 1000);
  const p = (n, w) => String(n).padStart(w, '0');
  const ts = p(Math.floor(ms / 3600000), 2) + ':' + p(Math.floor(ms / 60000) % 60, 2) + ':' +
    p(Math.floor(ms / 1000) % 60, 2) + '.' + p(ms % 1000, 3);
  return ts + JSON.stringify(data);
}
const stream = (...lines) => lines.join('\n') + '\n';

// feeds: { FeedName: text }. Anything else is a 404. status overrides: { FeedName: httpStatus }.
function harness(feeds, status) {
  const messages = [];
  const urls = [];
  const self = { postMessage: (m) => messages.push(JSON.parse(JSON.stringify(m))) };
  const fetch = async (url) => {
    urls.push(url);
    const m = /([A-Za-z]+)\.jsonStream$/.exec(url);
    const feed = m && m[1];
    if (status && status[feed]) return { ok: false, status: status[feed], text: async () => '' };
    if (feed && feeds[feed] != null) return { ok: true, status: 200, text: async () => feeds[feed] };
    return { ok: false, status: 404, text: async () => '' };
  };
  const context = vm.createContext({
    self, fetch,
    setTimeout: () => ({}), clearTimeout: () => {},
    setInterval: () => ({}), clearInterval: () => {}
  });
  vm.runInContext(SOURCE, context);

  const waitFor = async (pred) => {
    for (let i = 0; i < 200; i++) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('timed out; messages: ' + JSON.stringify(messages));
  };
  let nextId = 1;
  const api = {
    messages, urls,
    load: (live) => self.onmessage({ data: { cmd: 'load', path: PATH, token: 'tok', live: !!live } }),
    loaded: () => waitFor((m) => m.type === 'loaded' || m.type === 'error'),
    stop: () => self.onmessage({ data: { cmd: 'stop' } }),
    ask: (t) => {
      const id = nextId++;
      self.onmessage({ data: { cmd: 'query', id, t } });
      return messages.filter((m) => m.type === 'state' && m.id === id)[0].state;
    }
  };
  return api;
}

async function loadedWorker(feeds) {
  const w = harness(feeds);
  w.load();
  const res = await w.loaded();
  assert.equal(res.type, 'loaded', JSON.stringify(res));
  return w;
}

const base = () => ({
  Heartbeat: stream(line(5, { Utc: iso(5) })),
  SessionInfo: stream(line(0, { Type: 'Race', Name: 'Test Grand Prix' })),
  DriverList: stream(line(1, {
    1: { Tla: 'VER', TeamColour: '3671C6' },
    44: { Tla: 'HAM', TeamColour: '27F4D2' },
    16: { Tla: 'LEC' }
  }))
});

const row = (state, num) => state.standings.find((r) => r.num === num);

test('load posts loaded with session type, name and driver count', async () => {
  const w = harness(base());
  w.load();
  const res = await w.loaded();
  assert.deepEqual(res, { type: 'loaded', info: { type: 'Race', name: 'Test Grand Prix', drivers: 3 } });
});

test('missing archive with live false posts an error and never touches SignalR', async () => {
  const w = harness({});
  w.load(false);
  const res = await w.loaded();
  assert.equal(res.type, 'error');
  assert.match(res.message, /No timing data/);
  assert.ok(w.urls.every((u) => u.includes('.jsonStream')), w.urls.join());
});

test('a server error on a feed posts an error naming the feed', async () => {
  const w = harness(base(), { SessionInfo: 500 });
  w.load();
  const res = await w.loaded();
  assert.equal(res.type, 'error');
  assert.match(res.message, /SessionInfo: HTTP 500/);
});

test('feeds are fetched from BASE + path + Feed.jsonStream', async () => {
  const w = await loadedWorker(base());
  assert.ok(w.urls.includes('https://livetiming.formula1.com/static/' + PATH + 'Heartbeat.jsonStream'));
  assert.ok(w.urls.includes('https://livetiming.formula1.com/static/' + PATH + 'TimingData.jsonStream'));
});

test('query before anything is loaded returns null state', () => {
  const w = harness(base());
  assert.equal(w.ask(at(10)), null);
});

test('before the first timing data there are no standings and started is false', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(line(10, { Lines: { 1: { Position: '1' } } }))
  });
  const s = w.ask(at(9));
  assert.equal(s.type, 'Race');
  assert.equal(s.name, 'Test Grand Prix');
  assert.equal(s.standings, undefined);
  assert.equal(s.started, false);
  assert.equal(w.ask(at(10)).started, true);
});

test('the first heartbeat fixes the UTC base: offsets map to heartbeat Utc minus its offset', async () => {
  // Heartbeat at offset 5s says it is 12:00:05, so offset 0 is 12:00:00.
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(line(20, { Lines: { 1: { Position: '1' } } }))
  });
  assert.equal(w.ask(at(20) - 1).standings, undefined);
  assert.equal(w.ask(at(20)).standings.length, 1);
});

test('a query returns state as of that time, not later data', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(
      line(10, { Lines: { 1: { Position: '1', NumberOfLaps: 1 }, 44: { Position: '2' } } }),
      line(20, { Lines: { 1: { Position: '2', NumberOfLaps: 2 }, 44: { Position: '1' } } })),
    LapCount: stream(line(10, { CurrentLap: 1, TotalLaps: 50 }), line(20, { CurrentLap: 2 })),
    TrackStatus: stream(line(10, { Status: '1', Message: 'AllClear' }), line(20, { Status: '2', Message: 'Yellow' }))
  });
  const s = w.ask(at(15));
  assert.deepEqual(s.standings.map((r) => r.num), ['1', '44']);
  assert.equal(row(s, '1').laps, 1);
  assert.equal(s.lap, 1);
  assert.equal(s.track, '1');
});

test('standings are ordered by position and use TLA and team colour from DriverList', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(line(10, { Lines: {
      16: { Position: '3' }, 1: { Position: '1' }, 44: { Position: '2' }
    } }))
  });
  const s = w.ask(at(10));
  assert.deepEqual(s.standings.map((r) => [r.pos, r.tla]), [[1, 'VER'], [2, 'HAM'], [3, 'LEC']]);
  assert.equal(row(s, '1').colour, '#3671C6');
  assert.equal(row(s, '16').colour, '#888');
});

test('a later TimingData patch reorders standings', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(
      line(10, { Lines: { 1: { Position: '1' }, 44: { Position: '2' }, 16: { Position: '3' } } }),
      line(20, { Lines: { 1: { Position: '3' }, 16: { Position: '1' }, 44: { Position: '2' } } }))
  });
  assert.deepEqual(w.ask(at(10)).standings.map((r) => r.tla), ['VER', 'HAM', 'LEC']);
  assert.deepEqual(w.ask(at(20)).standings.map((r) => r.tla), ['LEC', 'HAM', 'VER']);
});

test('drivers without a Position are left out of standings', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(line(10, { Lines: { 1: { Position: '1' }, 44: { NumberOfLaps: 0 } } }))
  });
  assert.deepEqual(w.ask(at(10)).standings.map((r) => r.num), ['1']);
});

test('gap and interval handle the leader and plain or {Value} formats', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(line(10, { Lines: {
      1: { Position: '1', GapToLeader: '', IntervalToPositionAhead: { Value: '' } },
      44: { Position: '2', GapToLeader: '+1.500', IntervalToPositionAhead: { Value: '+1.500' } },
      16: { Position: '3', GapToLeader: { Value: '+4.000' }, IntervalToPositionAhead: '+2.500' }
    } }))
  });
  const s = w.ask(at(10));
  assert.deepEqual([row(s, '1').gap, row(s, '1').interval], ['', '']);
  assert.deepEqual([row(s, '44').gap, row(s, '44').interval], ['+1.500', '+1.500']);
  assert.deepEqual([row(s, '16').gap, row(s, '16').interval], ['+4.000', '+2.500']);
});

test('gap updates merge into the existing line without wiping other fields', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(
      line(10, { Lines: { 44: { Position: '2', GapToLeader: '+1.500', BestLapTime: { Value: '1:31.000' } } } }),
      line(20, { Lines: { 44: { GapToLeader: '+2.250' } } }))
  });
  const r = row(w.ask(at(20)), '44');
  assert.equal(r.gap, '+2.250');
  assert.equal(r.best, '1:31.000');
  assert.equal(r.pos, 2);
});

test('best and last lap times are reported and update', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(
      line(10, { Lines: { 1: { Position: '1', BestLapTime: { Value: '1:30.500' }, LastLapTime: { Value: '1:31.200' } } } }),
      line(20, { Lines: { 1: { LastLapTime: { Value: '1:30.100' }, BestLapTime: { Value: '1:30.100' } } } }))
  });
  assert.deepEqual([row(w.ask(at(10)), '1').best, row(w.ask(at(10)), '1').last], ['1:30.500', '1:31.200']);
  assert.deepEqual([row(w.ask(at(20)), '1').best, row(w.ask(at(20)), '1').last], ['1:30.100', '1:30.100']);
});

test('pit flag follows InPit and PitOut and clears when both are false', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(
      line(10, { Lines: { 1: { Position: '1', InPit: false }, 44: { Position: '2' } } }),
      line(20, { Lines: { 1: { InPit: true } } }),
      line(30, { Lines: { 1: { InPit: false, PitOut: true } } }),
      line(40, { Lines: { 1: { PitOut: false } } }))
  });
  assert.equal(row(w.ask(at(10)), '1').pit, false);
  assert.equal(row(w.ask(at(20)), '1').pit, true);
  assert.equal(row(w.ask(at(30)), '1').pit, true);
  assert.equal(row(w.ask(at(40)), '1').pit, false);
  assert.equal(row(w.ask(at(40)), '44').pit, false);
});

test('Retired and Stopped mark a driver out; KnockedOut is separate', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(
      line(10, { Lines: { 1: { Position: '1' }, 44: { Position: '2' }, 16: { Position: '3' } } }),
      line(20, { Lines: { 44: { Retired: true }, 16: { Stopped: true, KnockedOut: true } } }))
  });
  const before = w.ask(at(10));
  assert.deepEqual(before.standings.map((r) => r.out), [false, false, false]);
  const s = w.ask(at(20));
  assert.equal(row(s, '1').out, false);
  assert.equal(row(s, '44').out, true);
  assert.equal(row(s, '44').knockedOut, false);
  assert.equal(row(s, '16').out, true);
  assert.equal(row(s, '16').knockedOut, true);
});

test('tyre compound, age and new-tyre come from the latest stint', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingAppData: stream(line(2, { Lines: {
      1: { GridPos: '2', Stints: { 0: { Compound: 'SOFT', New: 'true', TotalLaps: 0 } } },
      44: { Stints: { 0: { Compound: 'MEDIUM', New: 'false', TotalLaps: 4 } } }
    } })),
    TimingData: stream(line(10, { Lines: { 1: { Position: '1' }, 44: { Position: '2' } } }))
  });
  const s = w.ask(at(10));
  assert.deepEqual([row(s, '1').tyre, row(s, '1').tyreAge, row(s, '1').tyreNew], ['S', 0, true]);
  assert.deepEqual([row(s, '44').tyre, row(s, '44').tyreAge, row(s, '44').tyreNew], ['M', 4, false]);
});

test('stint updates keyed by index merge into the right stint and count stops', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingAppData: stream(
      line(2, { Lines: { 1: { Stints: { 0: { Compound: 'SOFT', New: 'true', TotalLaps: 0 } } } } }),
      line(15, { Lines: { 1: { Stints: { 0: { TotalLaps: 12 } } } } }),
      line(25, { Lines: { 1: { Stints: { 1: { Compound: 'HARD', New: 'true', TotalLaps: 0 } } } } })),
    TimingData: stream(
      line(10, { Lines: { 1: { Position: '1' } } }),
      line(20, { Lines: { 1: { Position: '1' } } }),
      line(30, { Lines: { 1: { Position: '1' } } }))
  });
  const a = row(w.ask(at(10)), '1');
  assert.deepEqual([a.tyre, a.tyreAge, a.stops], ['S', 0, 0]);
  const b = row(w.ask(at(20)), '1');
  assert.deepEqual([b.tyre, b.tyreAge, b.stops], ['S', 12, 0]);
  const c = row(w.ask(at(30)), '1');
  assert.deepEqual([c.tyre, c.tyreAge, c.stops], ['H', 0, 1]);
});

test('stint patches sent as real arrays also merge', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingAppData: stream(line(2, { Lines: { 1: { Stints: [{ Compound: 'WET', New: 'false', TotalLaps: 7 }] } } })),
    TimingData: stream(line(10, { Lines: { 1: { Position: '1' } } }))
  });
  const r = row(w.ask(at(10)), '1');
  assert.deepEqual([r.tyre, r.tyreAge, r.tyreNew], ['W', 7, false]);
});

test('NumberOfPitStops overrides the stint-derived stop count; grid comes from GridPos', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingAppData: stream(line(2, { Lines: {
      44: { GridPos: '5', Stints: { 0: { Compound: 'HARD', New: 'true', TotalLaps: 0 } } },
      1: { GridPos: '1' }
    } })),
    TimingData: stream(line(10, { Lines: { 44: { Position: '1', NumberOfPitStops: 2 }, 1: { Position: '2' } } }))
  });
  const s = w.ask(at(10));
  assert.equal(row(s, '44').stops, 2);
  assert.equal(row(s, '44').grid, 5);
  assert.equal(row(s, '1').grid, 1);
  assert.equal(row(s, '1').stops, null);
  assert.equal(row(s, '1').tyre, '');
});

test('lines from different feeds apply in time order even though feeds load one after another', async () => {
  // TimingAppData is fetched before TimingData, but its update at 25s must not appear in the 20s snapshot.
  const w = await loadedWorker({
    ...base(),
    TimingAppData: stream(
      line(2, { Lines: { 1: { Stints: { 0: { Compound: 'SOFT', New: 'true', TotalLaps: 0 } } } } }),
      line(25, { Lines: { 1: { Stints: { 1: { Compound: 'HARD', New: 'true', TotalLaps: 0 } } } } })),
    TimingData: stream(
      line(20, { Lines: { 1: { Position: '1' } } }),
      line(30, { Lines: { 1: { Position: '1' } } }))
  });
  assert.equal(row(w.ask(at(20)), '1').tyre, 'S');
  assert.equal(row(w.ask(at(30)), '1').tyre, 'H');
});

test('lap count reports current and total laps and keeps the total across partial updates', async () => {
  const w = await loadedWorker({
    ...base(),
    LapCount: stream(
      line(8, { CurrentLap: 1, TotalLaps: 57 }),
      line(40, { CurrentLap: 2 }))
  });
  assert.equal(w.ask(at(7)).lap, undefined);
  assert.deepEqual([w.ask(at(8)).lap, w.ask(at(8)).totalLaps], [1, 57]);
  assert.deepEqual([w.ask(at(41)).lap, w.ask(at(41)).totalLaps], [2, 57]);
});

test('remaining clock holds while not extrapolating and counts down while extrapolating', async () => {
  const w = await loadedWorker({
    ...base(),
    ExtrapolatedClock: stream(
      line(10, { Remaining: '00:10:00', Extrapolating: false, Utc: iso(10) }),
      line(20, { Remaining: '00:09:50', Extrapolating: true, Utc: iso(20) }),
      line(40, { Extrapolating: false }))
  });
  assert.equal(w.ask(at(9)).remaining, undefined);
  assert.equal(w.ask(at(15)).remaining, 600);
  assert.equal(w.ask(at(20)).remaining, 590);
  assert.equal(w.ask(at(30)).remaining, 580);
  assert.equal(w.ask(at(30) + 500).remaining, 580);   // rounded up
  assert.equal(w.ask(at(30) + 1000).remaining, 579);
  // Pausing freezes the clock at what it showed at 40s (570) and keeps it there.
  assert.equal(w.ask(at(40)).remaining, 570);
  assert.equal(w.ask(at(90)).remaining, 570);
});

test('remaining clock never goes below zero', async () => {
  const w = await loadedWorker({
    ...base(),
    ExtrapolatedClock: stream(line(10, { Remaining: '00:00:05', Extrapolating: true, Utc: iso(10) }))
  });
  assert.equal(w.ask(at(12)).remaining, 3);
  assert.equal(w.ask(at(100)).remaining, 0);
});

test('track status and message follow TrackStatus updates', async () => {
  const w = await loadedWorker({
    ...base(),
    TrackStatus: stream(
      line(10, { Status: '1', Message: 'AllClear' }),
      line(20, { Status: '2', Message: 'Yellow' }),
      line(30, { Status: '4', Message: 'SCDeployed' }),
      line(40, { Status: '5', Message: 'Red' }))
  });
  assert.equal(w.ask(at(9)).track, undefined);
  assert.deepEqual([w.ask(at(10)).track, w.ask(at(10)).trackMessage], ['1', 'AllClear']);
  assert.deepEqual([w.ask(at(25)).track, w.ask(at(25)).trackMessage], ['2', 'Yellow']);
  assert.deepEqual([w.ask(at(35)).track, w.ask(at(35)).trackMessage], ['4', 'SCDeployed']);
  assert.deepEqual([w.ask(at(45)).track, w.ask(at(45)).trackMessage], ['5', 'Red']);
});

test('qualifying part comes from SessionData series', async () => {
  const w = await loadedWorker({
    ...base(),
    SessionData: stream(
      line(10, { Series: { 0: { Utc: iso(10), QualifyingPart: 1 } } }),
      line(30, { Series: { 1: { Utc: iso(30), QualifyingPart: 2 } } }))
  });
  assert.equal(w.ask(at(9)).part, undefined);
  assert.equal(w.ask(at(20)).part, 1);
  assert.equal(w.ask(at(30)).part, 2);
});

test('lines with a byte order mark, CRLF endings or bad JSON do not break loading', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: '﻿' + [
      line(10, { Lines: { 1: { Position: '1' } } }),
      '00:00:15.000{not json',
      line(20, { Lines: { 1: { Position: '2' } } })
    ].join('\r\n') + '\r\n'
  });
  assert.equal(row(w.ask(at(10)), '1').pos, 1);
  assert.equal(row(w.ask(at(20)), '1').pos, 2);
});

test('stop makes later queries return a null state', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(line(10, { Lines: { 1: { Position: '1' } } }))
  });
  assert.equal(w.ask(at(10)).standings.length, 1);
  w.stop();
  assert.equal(w.ask(at(10)), null);
});

test('a change less than 3 s after the previous snapshot still shows once the data ends', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(
      line(10, { Lines: { 1: { Position: '1' }, 44: { Position: '2' } } }),
      line(11, { Lines: { 1: { Position: '2' }, 44: { Position: '1' } } }) // last update, 1 s later
    )
  });
  assert.equal(w.ask(at(10.5)).standings[0].tla, 'VER');
  assert.equal(w.ask(at(11)).standings[0].tla, 'HAM');
});

test('a tyre change after the last timing update still shows once the data ends', async () => {
  const w = await loadedWorker({
    ...base(),
    TimingData: stream(line(10, { Lines: { 1: { Position: '1' } } })),
    TimingAppData: stream(
      line(9, { Lines: { 1: { Stints: [{ Compound: 'MEDIUM', TotalLaps: 10, New: 'false' }] } } }),
      line(12, { Lines: { 1: { Stints: { 1: { Compound: 'HARD', TotalLaps: 0, New: 'true' } } } } })
    )
  });
  assert.equal(row(w.ask(at(11)), '1').tyre, 'M');
  assert.equal(row(w.ask(at(12)), '1').tyre, 'H');
});

// ---- qualifying: per-part gaps and best laps ----

const q1Lap = (best, gap, int) => ({ BestLapTime: { Value: best }, BestLapTimes: { 0: { Value: best } },
  Stats: { 0: { TimeDiffToFastest: gap, TimeDifftoPositionAhead: int } } });
const qualifying = (...timing) => ({
  ...base(),
  SessionInfo: stream(line(0, { Type: 'Qualifying', Name: 'Qualifying' })),
  TimingData: stream(
    line(10, { SessionPart: 1, Lines: {
      1: { Position: '1', BestLapTimes: [{ Value: '' }, {}, {}], Stats: [{ TimeDiffToFastest: '', TimeDifftoPositionAhead: '' }, {}, {}] },
      44: { Position: '2', BestLapTimes: [{ Value: '' }, {}, {}], Stats: [{ TimeDiffToFastest: '', TimeDifftoPositionAhead: '' }, {}, {}] },
      16: { Position: '3', BestLapTimes: [{ Value: '' }, {}, {}], Stats: [{ TimeDiffToFastest: '', TimeDifftoPositionAhead: '' }, {}, {}] } } }),
    line(20, { Lines: { 1: q1Lap('1:32.000', '', ''), 44: q1Lap('1:32.300', '+0.300', '+0.300'), 16: q1Lap('1:33.000', '+1.000', '+0.700') } }),
    ...timing)
});

test('qualifying gaps and intervals come from the current part', async () => {
  const w = await loadedWorker(qualifying());
  const s = w.ask(at(21));
  assert.deepEqual([row(s, '44').gap, row(s, '44').interval, row(s, '44').best, row(s, '44').old], ['+0.300', '+0.300', '1:32.300', false]);
  assert.equal(row(s, '1').best, '1:32.000');
});

test('when a new qualifying part starts, earlier times stay, marked old', async () => {
  const w = await loadedWorker(qualifying(
    line(40, { SessionPart: 2, Lines: { 1: { BestLapTime: { Value: '' }, BestLapTimes: { 1: { Value: '' } } },
      44: { BestLapTime: { Value: '' }, BestLapTimes: { 1: { Value: '' } } }, 16: { KnockedOut: true } } })
  ));
  const s = w.ask(at(41));
  assert.deepEqual([row(s, '44').gap, row(s, '44').best, row(s, '44').old], ['+0.300', '1:32.300', true]);
  assert.deepEqual([row(s, '1').best, row(s, '1').old], ['1:32.000', true]);
  // Knocked out: F1 keeps the best lap but the gap is in the earlier part's stats.
  assert.deepEqual([row(s, '16').gap, row(s, '16').interval, row(s, '16').old], ['+1.000', '+0.700', true]);
});

test('a lap in the new qualifying part replaces the old times', async () => {
  const w = await loadedWorker(qualifying(
    line(40, { SessionPart: 2, Lines: { 44: { BestLapTime: { Value: '' }, BestLapTimes: { 1: { Value: '' } } } } }),
    line(50, { Lines: { 44: { BestLapTime: { Value: '1:31.900' }, BestLapTimes: { 1: { Value: '1:31.900' } },
      Stats: { 1: { TimeDiffToFastest: '+0.100', TimeDifftoPositionAhead: '+0.100' } } } } })
  ));
  const s = w.ask(at(51));
  assert.deepEqual([row(s, '44').gap, row(s, '44').best, row(s, '44').old], ['+0.100', '1:31.900', false]);
});
