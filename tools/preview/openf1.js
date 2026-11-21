/*
 * UI preview: F1's timing archive (livetiming.formula1.com/static/) rebuilt from OpenF1's public data
 * (https://openf1.org, 2023 onwards, no account). F1's own archive needs the account's token, which the preview
 * never has. The files have the archive's layout and line format, so the app's timing worker reads them unchanged:
 *
 *   <year>/Index.json                                         the season's meetings and sessions
 *   <year>/<race day>_<Meeting>/<session day>_<Session>/<Feed>.jsonStream
 *
 * It is a likeness, good enough for the interface: positions, gaps, laps, sectors, tyres, pit stops, flags, the
 * session clock and qualifying parts come from OpenF1; timings inside a lap are spread from its sector times.
 * Sessions that ended less than 30 minutes ago answer 403, as F1's storage does while a session is live, so the
 * app follows the live feed instead.
 *
 * OpenF1's answers and the built files are cached in local/preview-cache/ (openf1/, timing/).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.openf1.org/v1/';
const FEEDS = ['Heartbeat', 'SessionInfo', 'LapCount', 'ExtrapolatedClock', 'SessionData',
  'TrackStatus', 'DriverList', 'TimingAppData', 'TimingData'];
const SETTLE_MS = 30 * 60000;   // after a session's end, before its data counts as complete

module.exports = function openF1(opts) {
  const CACHE = opts.cacheDir, OFFLINE = !!opts.offline, log = opts.log || (() => {});

  // ------------------------------------------------------------ OpenF1 requests (rate limited, cached)

  // Free use: 3 requests a second, 30 a minute.
  const sent = [];
  let queue = Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function slot() {
    const p = queue.then(async () => {
      for (;;) {
        const now = Date.now();
        while (sent.length && now - sent[0] > 60000) sent.shift();
        const wait = Math.max(sent.length >= 28 ? sent[0] + 60000 - now : 0, sent.length ? sent[sent.length - 1] + 400 - now : 0);
        if (wait <= 0) break;
        await sleep(wait);
      }
      sent.push(Date.now());
    });
    queue = p.catch(() => {});
    return p;
  }

  function cachePath(url) {
    return path.join(CACHE, 'openf1', crypto.createHash('sha1').update(url).digest('hex').slice(0, 20) + '.json');
  }

  /** GET an OpenF1 endpoint. maxAge: how long a cached answer counts as current (Infinity: for good). */
  async function get(endpoint, query, maxAge) {
    const url = API + endpoint + '?' + new URLSearchParams(query);
    const file = cachePath(url);
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* none */ }
    if (cached && (OFFLINE || Date.now() - cached.at < maxAge)) return cached.data;
    if (OFFLINE) throw new Error('offline and not cached: ' + url);
    for (let attempt = 0; ; attempt++) {
      await slot();
      let r;
      try { r = await fetch(url, { headers: { 'User-Agent': 'f1tv-tizen UI preview' } }); } catch (e) {
        if (cached) return cached.data;
        throw e;
      }
      if (r.status === 429 && attempt < 6) { await sleep((+r.headers.get('retry-after') || 5) * 1000); continue; }
      // OpenF1 answers 404 with {"detail":"No results found."} for an empty list.
      if (r.status === 404) return [];
      if (!r.ok) {
        if (cached) return cached.data;
        throw new Error('OpenF1 ' + endpoint + ': HTTP ' + r.status);
      }
      const data = await r.json();
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ url, at: Date.now(), data }));
      } catch (e) { /* cache is best effort */ }
      return data;
    }
  }

  // ------------------------------------------------------------ seasons and archive folders

  const ms = (iso) => iso ? Date.parse(iso) : NaN;
  const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
  const under = (s) => String(s || '').replace(/[ -]/g, '_');

  /** "-08:00:00" -> ms */
  function gmtOffset(s) {
    const m = /^([+-])?(\d+):(\d+)/.exec(s || '');
    return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60000 : 0;
  }
  const localDay = (s, t) => isoDay(t + gmtOffset(s.gmt_offset));

  async function season(year) {
    const [sessions, meetings] = await Promise.all([get('sessions', { year }, 6 * 3600000), get('meetings', { year }, 6 * 3600000)]);
    return { sessions: sessions.filter((s) => !s.is_cancelled), meetings };
  }

  /** The archive folder F1 uses: 2025/2025-11-22_Las_Vegas_Grand_Prix/2025-11-21_Practice_1/ */
  function folderOf(s, all, meeting) {
    const race = all.filter((x) => x.meeting_key === s.meeting_key && x.session_name === 'Race')[0];
    const raceDay = race ? localDay(race, ms(race.date_start)) : localDay(s, ms(meeting && meeting.date_end || s.date_end));
    return s.year + '/' + raceDay + '_' + under(meeting ? meeting.meeting_name : s.location) + '/' +
      localDay(s, ms(s.date_start)) + '_' + under(s.session_name) + '/';
  }

  async function index(year) {
    const { sessions, meetings } = await season(year);
    return {
      Year: +year,
      Meetings: meetings.map((m) => ({
        Key: m.meeting_key, Name: m.meeting_name, OfficialName: m.meeting_official_name, Location: m.location,
        Country: { Code: m.country_code, Name: m.country_name },
        Sessions: sessions.filter((s) => s.meeting_key === m.meeting_key).map((s) => ({
          Key: s.session_key, Type: s.session_type, Name: s.session_name,
          StartDate: s.date_start, EndDate: s.date_end, GmtOffset: s.gmt_offset, Path: folderOf(s, sessions, m)
        }))
      }))
    };
  }

  /** The OpenF1 session an archive folder names, or null. */
  async function sessionAt(folder) {
    const m = /^(\d{4})\/(\d{4}-\d{2}-\d{2})_([^/]+)\/(\d{4}-\d{2}-\d{2})_([^/]+)\/$/.exec(folder);
    if (!m) return null;
    const { sessions, meetings } = await season(+m[1]);
    const name = m[5].replace(/_/g, ' ').toLowerCase();
    const found = sessions.filter((s) => s.session_name.toLowerCase() === name && localDay(s, ms(s.date_start)) === m[4]);
    if (found.length < 2) return found[0] ? { session: found[0], meetings, sessions } : null;
    // Two meetings on one day (never so far): by the meeting's name.
    const meet = meetings.filter((x) => under(x.meeting_name) === m[3])[0];
    const s = found.filter((x) => meet && x.meeting_key === meet.meeting_key)[0] || found[0];
    return { session: s, meetings, sessions };
  }

  // ------------------------------------------------------------ building one session's archive

  const building = new Map();

  /** { feed: text } for a folder, or { status } when there is none (yet). */
  async function archive(folder) {
    const hit = await sessionAt(folder);
    if (!hit) return { status: 404 };
    const s = hit.session;
    if (ms(s.date_end) + SETTLE_MS > Date.now()) return { status: 403, live: true };
    const dir = path.join(CACHE, 'timing', String(s.session_key));
    if (fs.existsSync(path.join(dir, 'done'))) return { dir };
    if (!building.has(s.session_key)) {
      building.set(s.session_key, build(s, hit).then((files) => {
        fs.mkdirSync(dir, { recursive: true });
        for (const f of Object.keys(files)) fs.writeFileSync(path.join(dir, f + '.jsonStream'), files[f]);
        fs.writeFileSync(path.join(dir, 'done'), new Date().toISOString());
        return { dir };
      }).finally(() => building.delete(s.session_key)));
    }
    return building.get(s.session_key);
  }

  /** GET <folder><Feed>.jsonStream: { status, body } */
  async function feed(folder, name) {
    if (FEEDS.indexOf(name) < 0) return { status: 403, body: '' };
    const a = await archive(folder);
    if (!a.dir) return { status: a.status, body: '' };
    const file = path.join(a.dir, name + '.jsonStream');
    // A feed the session doesn't have (LapCount outside races): F1's storage answers 403.
    return fs.existsSync(file) ? { status: 200, body: fs.readFileSync(file) } : { status: 403, body: '' };
  }

  async function build(s, hit) {
    const key = { session_key: s.session_key };
    const race = s.session_type === 'Race';
    log('timing: building', s.year, s.location, s.session_name, 'from OpenF1');
    const ever = Infinity;
    const [drivers, laps, stints, positions, pits, control, results, intervals] = [
      await get('drivers', key, ever), await get('laps', key, ever), await get('stints', key, ever),
      await get('position', key, ever), await get('pit', key, ever), await get('race_control', key, ever),
      await get('session_result', key, ever), race ? await get('intervals', key, ever) : []];
    if (!drivers.length && !laps.length) throw new Error('OpenF1 has no data for session ' + s.session_key);
    const meeting = hit.meetings.filter((m) => m.meeting_key === s.meeting_key)[0];
    const files = convert(s, meeting, folderOf(s, hit.sessions, meeting),
      { drivers, laps, stints, positions, pits, control, results, intervals });
    log('timing: built', s.session_name, Object.keys(files).map((f) => f + ' ' + Math.round(files[f].length / 1024) + ' KiB').join(', '));
    return files;
  }

  return { index, feed };
};

// ---------------------------------------------------------------- OpenF1 -> F1's feeds

const iso = (t) => new Date(t).toISOString();

/** 83.456 -> "1:23.456"; 23.4 -> "23.400" */
function lapTime(sec) {
  if (sec == null || !(sec > 0)) return '';
  const m = Math.floor(sec / 60), r = sec - m * 60;
  return (m ? m + ':' + (r < 10 ? '0' : '') : '') + r.toFixed(3);
}

function diff(sec) { return sec == null || isNaN(sec) ? '' : '+' + sec.toFixed(3); }

/** OpenF1's gap (12.345, "+1 LAP", "+2 LAPS", null) as F1 writes it ("+12.345", "1L"). */
function gapText(g) {
  if (g == null) return '';
  if (typeof g === 'number') return g > 0 ? '+' + g.toFixed(3) : '';
  const m = /(\d+)\s*LAP/i.exec(g);
  return m ? m[1] + 'L' : String(g);
}

function clockText(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 3600) + ':' + String(Math.floor(sec / 60) % 60).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
}

function convert(s, meeting, folder, d) {
  const T = (x) => x ? Date.parse(x) : NaN;
  const start = T(s.date_start), end = T(s.date_end);
  const race = s.session_type === 'Race', quali = s.session_type === 'Qualifying';
  const base = start - 30 * 60000;                       // the archive opens half an hour before the session
  const out = {};
  FEEDS.forEach((f) => { out[f] = []; });
  const line = (feed, t, data) => out[feed].push([Math.max(0, t - base), data]);
  const nums = d.drivers.map((x) => String(x.driver_number));

  // ---- session status, qualifying parts, the clock
  const status = [];
  d.control.filter((r) => r.category === 'SessionStatus').forEach((r) => {
    const m = /SESSION (STARTED|RESUMED|SUSPENDED|FINISHED|ABORTED)/.exec(r.message || '');
    if (m) status.push({ t: T(r.date), what: m[1], part: r.qualifying_phase });
  });
  status.sort((a, b) => a.t - b.t);
  if (!status.some((x) => x.what === 'STARTED')) status.unshift({ t: start, what: 'STARTED', part: quali ? 1 : null });
  if (!status.some((x) => x.what === 'FINISHED')) status.push({ t: end, what: 'FINISHED', part: null });
  const F1STATUS = { STARTED: 'Started', RESUMED: 'Started', SUSPENDED: 'Aborted', ABORTED: 'Aborted', FINISHED: 'Finished' };
  const lightsOut = status.filter((x) => x.what === 'STARTED')[0].t;

  const statusSeries = [], series = [];
  let part = 0;
  const parts = [];                                         // [{ part, start, finish }]
  status.forEach((x) => {
    statusSeries.push({ Utc: iso(x.t), SessionStatus: F1STATUS[x.what] });
    if (quali && x.what === 'STARTED') {
      const p = x.part || part + 1;
      if (p !== part) {
        part = p;
        series.push({ Utc: iso(x.t), QualifyingPart: p });
        parts.push({ part: p, start: x.t, finish: null });
      }
    }
    if (quali && x.what === 'FINISHED' && parts.length) parts[parts.length - 1].finish = x.t;
  });
  line('SessionData', base, { Series: [], StatusSeries: [] });
  statusSeries.forEach((x, i) => line('SessionData', T(x.Utc), { StatusSeries: { [i]: x } }));
  series.forEach((x, i) => line('SessionData', T(x.Utc), { Series: { [i]: x } }));

  // The clock: each running stretch counts down from what was left. A part's (or session's) length is its running time.
  const chunks = [];                                        // [{ from, to, part }]
  let runFrom = null, runPart = null;
  status.forEach((x) => {
    if ((x.what === 'STARTED' || x.what === 'RESUMED') && runFrom == null) { runFrom = x.t; runPart = x.part; }
    else if (x.what !== 'STARTED' && x.what !== 'RESUMED' && runFrom != null) { chunks.push({ from: runFrom, to: x.t, part: runPart }); runFrom = null; }
  });
  const lengthOf = (p) => chunks.filter((c) => !quali || c.part === p).reduce((n, c) => n + c.to - c.from, 0) / 1000;
  const left = {};
  line('ExtrapolatedClock', base, { Utc: iso(base), Remaining: clockText(race ? 7200 : lengthOf(quali ? 1 : null)), Extrapolating: false });
  chunks.forEach((c) => {
    const k = quali ? c.part : 'all';
    // Rounded to the minute: F1's parts are 18/15/12 min and practice 60 min; suspensions cut it short.
    if (left[k] == null) left[k] = race ? 7200 : Math.round(lengthOf(quali ? c.part : null) / 60) * 60;
    line('ExtrapolatedClock', c.from, { Utc: iso(c.from), Remaining: clockText(left[k]), Extrapolating: true });
    left[k] = Math.max(0, left[k] - (c.to - c.from) / 1000);
    line('ExtrapolatedClock', c.to, { Utc: iso(c.to), Remaining: clockText(left[k]), Extrapolating: false });
  });

  // ---- heartbeats, session info, drivers
  const last = Math.max(end, ...d.laps.map((l) => T(l.date_start) + (l.lap_duration || 0) * 1000).filter((x) => x > 0)) + 5 * 60000;
  for (let t = base; t <= last; t += 10000) line('Heartbeat', t, { Utc: iso(t) });
  line('SessionInfo', base, {
    Meeting: { Key: s.meeting_key, Name: meeting ? meeting.meeting_name : s.location, OfficialName: meeting && meeting.meeting_official_name,
      Location: s.location, Country: { Code: s.country_code, Name: s.country_name } },
    ArchiveStatus: { Status: 'Complete' }, Key: s.session_key, Type: s.session_type, Name: s.session_name,
    StartDate: s.date_start.slice(0, 19), EndDate: s.date_end.slice(0, 19), GmtOffset: s.gmt_offset, Path: folder
  });
  const order = {};
  d.results.forEach((r) => { order[r.driver_number] = r.position; });
  const list = {};
  d.drivers.slice().sort((a, b) => (order[a.driver_number] || 99) - (order[b.driver_number] || 99)).forEach((x, i) => {
    list[x.driver_number] = { RacingNumber: String(x.driver_number), BroadcastName: x.broadcast_name, FullName: x.full_name,
      Tla: x.name_acronym, Line: i + 1, TeamName: x.team_name, TeamColour: x.team_colour || '77777d',
      FirstName: x.first_name, LastName: x.last_name, HeadshotUrl: x.headshot_url };
  });
  line('DriverList', base, list);

  // ---- track status: safety cars, red flags, yellow sectors
  let trackCode = '1';
  const yellow = new Set();
  const track = (t, code, msg) => { if (code !== trackCode) { trackCode = code; line('TrackStatus', t, { Status: code, Message: msg }); } };
  line('TrackStatus', base, { Status: '1', Message: 'AllClear' });
  let neutral = null;                                       // '4', '5', '6', '7' while they last
  d.control.slice().sort((a, b) => T(a.date) - T(b.date)).forEach((r) => {
    const t = T(r.date), m = r.message || '';
    if (r.category === 'SafetyCar') {
      if (/VIRTUAL SAFETY CAR DEPLOYED/.test(m)) neutral = '6';
      else if (/VIRTUAL SAFETY CAR ENDING/.test(m)) neutral = '7';
      else if (/SAFETY CAR DEPLOYED/.test(m)) neutral = '4';
      else return;
    } else if (r.category === 'Flag' && r.scope === 'Track') {
      if (r.flag === 'RED') neutral = '5';
      else if (r.flag === 'GREEN' || r.flag === 'CLEAR') { neutral = null; yellow.clear(); }
      else return;
    } else if (r.category === 'Flag' && r.scope === 'Sector' && r.sector != null) {
      if (/YELLOW/.test(r.flag || '')) yellow.add(r.sector);
      else if (r.flag === 'CLEAR') yellow.delete(r.sector);
      else return;
    } else if (r.category === 'SessionStatus' && /FINISHED/.test(m)) { neutral = null; yellow.clear(); }
    else return;
    const code = neutral || (yellow.size ? '2' : '1');
    track(t, code, { 1: 'AllClear', 2: 'Yellow', 4: 'SCDeployed', 5: 'Red', 6: 'VSCDeployed', 7: 'VSCEnding' }[code]);
  });

  // ---- laps: when each one starts and ends (OpenF1 leaves out-laps' and lap 1's start out)
  const byDriver = {};
  nums.forEach((n) => { byDriver[n] = []; });
  d.laps.forEach((l) => { (byDriver[l.driver_number] = byDriver[l.driver_number] || []).push(l); });
  const timed = [];                                         // { num, lap, from, to, s: [s1, s2, s3] }
  Object.keys(byDriver).forEach((n) => {
    const ls = byDriver[n].sort((a, b) => a.lap_number - b.lap_number);
    ls.forEach((l, i) => {
      const next = ls[i + 1];
      const sec = [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3];
      const known = sec.filter((x) => x > 0);
      const guess = l.lap_duration || (known.length ? known.reduce((a, b) => a + b, 0) * 3 / known.length : 120);
      let from = T(l.date_start), to;
      if (!(from > 0)) {
        to = next && T(next.date_start) > 0 ? T(next.date_start) : NaN;
        if (!(to > 0)) return;
        from = to - guess * 1000;
      } else to = from + guess * 1000;
      timed.push({ num: n, lap: l.lap_number, from, to, s: sec, duration: l.lap_duration, pitOut: l.is_pit_out_lap });
    });
  });

  // ---- TimingData: events gathered, then written in time order
  const ev = [];
  const td = (t, num, patch) => ev.push([t, num, patch]);
  const tdAll = (t, patch) => ev.push([t, null, patch]);

  nums.forEach((n) => td(base, n, { RacingNumber: n, Line: list[n] ? list[n].Line : 99, NumberOfLaps: 0, NumberOfPitStops: 0,
    InPit: false, PitOut: false, Retired: false, Stopped: false, KnockedOut: false,
    Sectors: [{ Value: '' }, { Value: '' }, { Value: '' }], BestLapTime: { Value: '' }, LastLapTime: { Value: '' } }));
  d.positions.forEach((p) => td(T(p.date), String(p.driver_number), { Position: String(p.position) }));

  // Race gaps from OpenF1's intervals; practice and qualifying gaps from best laps (below).
  // OpenF1 has no gap now and then (after the flag, mostly): the last one stays, as on F1's tower.
  d.intervals.forEach((x) => {
    const patch = {};
    if (x.gap_to_leader != null) patch.GapToLeader = gapText(x.gap_to_leader);
    if (x.interval != null) patch.IntervalToPositionAhead = { Value: gapText(x.interval) };
    if (Object.keys(patch).length) td(T(x.date), String(x.driver_number), patch);
  });

  // Sectors and lap times, with personal (green) and overall (purple) bests as they happen.
  const sectorEvents = [];
  timed.forEach((l) => {
    let t = l.from;
    l.s.forEach((v, k) => {
      if (v > 0) { t += v * 1000; sectorEvents.push({ t, l, k, v }); }
    });
    sectorEvents.push({ t: l.to, l, k: 3, v: l.duration });
  });
  sectorEvents.sort((a, b) => a.t - b.t);
  const pb = {}, ob = [Infinity, Infinity, Infinity, Infinity];
  const partAt = (t) => { let p = 0; parts.forEach((x) => { if (t >= x.start) p = x.part; }); return p || 1; };
  const partBest = {};                                      // part -> num -> best lap
  sectorEvents.forEach((e) => {
    const n = e.l.num, mine = pb[n] = pb[n] || [Infinity, Infinity, Infinity, Infinity];
    const valid = e.v > 0;
    const personal = valid && e.v < mine[e.k], overall = valid && e.v < ob[e.k];
    if (personal) mine[e.k] = e.v;
    if (overall) ob[e.k] = e.v;
    if (e.k < 3) {
      const sectors = { [e.k]: { Value: valid ? e.v.toFixed(3) : '', PersonalFastest: personal, OverallFastest: overall } };
      if (e.k === 0) { sectors[1] = { Value: '' }; sectors[2] = { Value: '' }; }
      td(e.t, n, { Sectors: sectors });
      return;
    }
    // The lap's end.
    const patch = { NumberOfLaps: e.l.lap, LastLapTime: { Value: lapTime(e.v), PersonalFastest: personal, OverallFastest: overall } };
    if (personal) patch.BestLapTime = { Value: lapTime(e.v), Lap: e.l.lap };
    if (valid && !race) {
      const p = quali ? partAt(e.t) : 0;
      const pbp = partBest[p] = partBest[p] || {};
      if (!(pbp[n] <= e.v)) {
        pbp[n] = e.v;
        if (quali) patch.BestLapTimes = { [p - 1]: { Value: lapTime(e.v), Lap: e.l.lap } };
        if (quali && !personal) patch.BestLapTime = { Value: lapTime(e.v), Lap: e.l.lap };
        td(e.t, n, patch);
        gaps(e.t, p);
        return;
      }
    }
    td(e.t, n, patch);
  });

  /** Practice and qualifying: each driver's gap to the fastest and to the one ahead, by best lap (this part's). */
  function gaps(t, p) {
    const pbp = partBest[p] || {};
    const ranked = Object.keys(pbp).sort((a, b) => pbp[a] - pbp[b]);
    ranked.forEach((n, i) => {
      const toFirst = i ? diff(pbp[n] - pbp[ranked[0]]) : '', toAhead = i ? diff(pbp[n] - pbp[ranked[i - 1]]) : '';
      const patch = { TimeDiffToFastest: toFirst, TimeDiffToPositionAhead: toAhead };
      if (quali) patch.Stats = { [p - 1]: { TimeDiffToFastest: toFirst, TimeDifftoPositionAhead: toAhead } };
      td(t, n, patch);
    });
  }

  // Qualifying: a part's start clears the current times (earlier parts stay in BestLapTimes and Stats); its end
  // knocks out the slowest (by the final classification: 10 reach Q3, the rest split evenly).
  if (quali) {
    const N = d.results.length || nums.length, q2 = 10 + Math.ceil((N - 10) / 2);
    parts.forEach((x, i) => {
      tdAll(x.start, { SessionPart: x.part });
      if (i) nums.forEach((n) => td(x.start, n, { BestLapTime: { Value: '' }, TimeDiffToFastest: '', TimeDiffToPositionAhead: '' }));
      const cut = x.part === 1 ? q2 : x.part === 2 ? 10 : null;
      const done = x.finish != null ? x.finish + 90000 : (parts[i + 1] ? parts[i + 1].start - 60000 : null);
      if (cut && done) d.results.forEach((r) => { if (r.position > cut) td(done, String(r.driver_number), { KnockedOut: true }); });
    });
  }

  // Pit stops: OpenF1's pit time is the car leaving the pit lane, its lane time the stretch before (the garage
  // included). Without a lane time: in the pit lane from the end of the lap before.
  d.pits.forEach((p) => {
    const n = String(p.driver_number), out = T(p.date);
    if (!(out > 0)) return;
    const inLap = timed.filter((l) => l.num === n && l.to <= out + 1000).sort((a, b) => b.to - a.to)[0];
    const pitIn = p.lane_duration > 0 ? out - p.lane_duration * 1000 : inLap ? inLap.to : null;
    if (pitIn != null && pitIn < out) td(pitIn, n, { InPit: true, PitOut: false });
    td(out, n, { InPit: false, PitOut: true });
    td(out + 20000, n, { PitOut: false });
  });
  if (race) {
    const stops = {};
    d.pits.slice().sort((a, b) => T(a.date) - T(b.date)).forEach((p) => {
      const n = String(p.driver_number);
      if (T(p.date) > lightsOut) td(T(p.date), n, { NumberOfPitStops: stops[n] = (stops[n] || 0) + 1 });
    });
    // Retirements after their last lap (a disqualification comes after the race: those cars finished).
    d.results.filter((r) => r.dnf || r.dns).forEach((r) => {
      const n = String(r.driver_number), mine = timed.filter((l) => l.num === n);
      const t = mine.length ? Math.max(...mine.map((l) => l.to)) + 30000 : lightsOut;
      td(t, n, { Retired: true, Stopped: true });
    });
  }

  // Everything from before the archive opens is its starting state; a snapshot of it right after, so the tower
  // shows the order (a race's grid) before the first car moves.
  ev.forEach((e) => { e[0] = Math.max(base, e[0]); });
  tdAll(base + 3000, {});
  ev.sort((a, b) => a[0] - b[0]);
  // One line per moment, as F1 writes them (the worker snapshots at most every 3 s, at a line: 22 cars' positions
  // in 22 lines would leave 21 out). A quiet stretch after a change gets an empty line, so it is snapshotted too.
  let at = null, group = null;
  const put = () => {
    if (group) line('TimingData', at, group);
    group = null;
  };
  ev.forEach(([t, n, patch], i) => {
    if (t !== at) { put(); at = t; group = {}; }
    if (n == null) Object.assign(group, patch);
    else deepMerge(group.Lines = group.Lines || {}, { [n]: patch });
    const following = ev[i + 1];
    if (!following || following[0] - t > 3100) { put(); line('TimingData', t + 3100, {}); }
  });
  put();

  // ---- lap counter (races): the leader's lap
  if (race) {
    const total = Math.max(0, ...d.results.map((r) => r.number_of_laps || 0)) || Math.max(0, ...timed.map((l) => l.lap));
    line('LapCount', base, { CurrentLap: 1, TotalLaps: total });
    const firstStart = {};
    timed.forEach((l) => { if (l.lap > 1 && !(firstStart[l.lap] <= l.from)) firstStart[l.lap] = l.from; });
    Object.keys(firstStart).map(Number).sort((a, b) => a - b).forEach((n) => {
      if (n <= total) line('LapCount', firstStart[n], { CurrentLap: n });
    });
  } else delete out.LapCount;

  // ---- tyres (TimingAppData): each stint from its first lap, its age counted lap by lap; races add the grid
  const app = (t, n, patch) => line('TimingAppData', t, { Lines: { [n]: patch } });
  const appEv = [];
  if (race) {
    const grid = {};
    d.positions.forEach((p) => { if (T(p.date) <= lightsOut && grid[p.driver_number] == null) grid[p.driver_number] = p.position; });
    Object.keys(grid).forEach((n) => appEv.push([base, n, { RacingNumber: n, GridPos: String(grid[n]) }]));
  }
  d.stints.forEach((st) => {
    const n = String(st.driver_number), i = st.stint_number - 1;
    const mine = timed.filter((l) => l.num === n && l.lap >= st.lap_start && l.lap <= (st.lap_end || 999)).sort((a, b) => a.lap - b.lap);
    // The first set is known from the start (in the first snapshot, before the first car moves).
    const from = i === 0 ? base : mine.length ? mine[0].from : NaN;
    if (!(from > 0)) return;
    const age0 = st.tyre_age_at_start || 0;
    appEv.push([from, n, { Stints: { [i]: { Compound: st.compound || 'UNKNOWN', New: age0 ? 'false' : 'true', StartLaps: age0, TotalLaps: age0 } } }]);
    mine.forEach((l, k) => appEv.push([l.to, n, { Stints: { [i]: { TotalLaps: age0 + k + 1 } } }]));
  });
  appEv.sort((a, b) => a[0] - b[0]).forEach(([t, n, patch]) => app(t, n, patch));

  // ---- the files: "HH:MM:SS.mmm{json}" per line, by offset from the archive's start
  const files = {};
  Object.keys(out).forEach((f) => {
    const lines = out[f].sort((a, b) => a[0] - b[0]).map(([off, data]) => stamp(off) + JSON.stringify(data));
    files[f] = '﻿' + lines.join('\r\n') + '\r\n';
  });
  return files;
}

function deepMerge(target, patch) {
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  });
  return target;
}

function stamp(off) {
  off = Math.round(off);
  const h = Math.floor(off / 3600000), days = Math.floor(h / 24);
  const t = String(h % 24).padStart(2, '0') + ':' + String(Math.floor(off / 60000) % 60).padStart(2, '0') + ':' +
    String(Math.floor(off / 1000) % 60).padStart(2, '0') + '.' + String(off % 1000).padStart(3, '0');
  return days ? days + '.' + t : t;
}

module.exports.convert = convert;
module.exports.FEEDS = FEEDS;
