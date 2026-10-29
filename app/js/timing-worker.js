/*
 * Replays timing data on a UTC timeline. Uses the archive when available; otherwise records
 * SignalR updates from connection time so delayed viewers see timing that matches the video.
 *
 * Messages in:  { cmd: 'load', path, token, live }  |  { cmd: 'query', id, t }  |  { cmd: 'stop' }
 * Messages out: { type: 'loaded', info } | { type: 'error', message } | { type: 'state', id, state }
 */
'use strict';

var BASE = 'https://livetiming.formula1.com/static/';
var FEEDS = ['Heartbeat', 'SessionInfo', 'LapCount', 'ExtrapolatedClock', 'SessionData',
  'TrackStatus', 'DriverList', 'TimingAppData', 'TimingData'];
var SNAPSHOT_MS = 3000;

var job = null;

function emptyJob(path, token) {
  return {
    path: path, token: token, stopped: false,
    collect: [],                           // initial load: [offset, feed, raw line] applied in time order
    base: null,                            // UTC ms of offset 0
    info: {},                              // SessionInfo
    lap: [], clock: [], part: [], track: [], sessionPart: 0,   // sessionPart: the qualifying part (1-3) TimingData is on
    hasStatus: false, startedAt: null,     // startedAt: UTC ms of the first SessionStatus 'Started' (a race's lights out)
    clockStartedAt: null,                  // UTC ms the session clock first ran: lights out where there is no status (2018-2019)
    drivers: {}, timing: {}, stints: {},
    snaps: [], lastSnap: -1, changed: -1   // changed: time of the newest change not yet in a snapshot
  };
}

function offsetMs(ts) {
  var m = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(ts);
  return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4] : null;
}

/** Deep-merges a timing patch. F1 sends array updates as objects keyed by index. */
function merge(target, patch) {
  Object.keys(patch).forEach(function (k) {
    var v = patch[k];
    if (v && typeof v === 'object') {
      if (!target[k] || typeof target[k] !== 'object') target[k] = Array.isArray(v) ? [] : {};
      merge(target[k], v);
    } else {
      target[k] = v;
    }
  });
  return target;
}

function last(arr) { return arr.length ? arr[arr.length - 1] : null; }

function apply(feed, t, d) {
  var j = job;
  switch (feed) {
    case 'SessionInfo': merge(j.info, d); break;
    case 'LapCount':
      var prev = last(j.lap);
      j.lap.push([t, d.CurrentLap != null ? d.CurrentLap : (prev ? prev[1] : 0), d.TotalLaps != null ? d.TotalLaps : (prev ? prev[2] : 0)]);
      break;
    case 'ExtrapolatedClock':
      if (d.Extrapolating === true && j.clockStartedAt == null) j.clockStartedAt = Date.parse(d.Utc) || t;
      if (d.Remaining != null) {
        var p = d.Remaining.split(':');
        var prevC = last(j.clock);
        j.clock.push([t, (+p[0]) * 3600 + (+p[1]) * 60 + (+p[2]),
          d.Extrapolating != null ? !!d.Extrapolating : (prevC ? prevC[2] : false), Date.parse(d.Utc) || t]);
      } else if (d.Extrapolating != null && j.clock.length) {
        var c = last(j.clock);
        j.clock.push([t, c[1] - (c[2] ? (t - c[3]) / 1000 : 0), !!d.Extrapolating, t]);
      }
      break;
    case 'SessionData':
      var series = d.Series, status = d.StatusSeries;
      if (series) Object.keys(series).forEach(function (k) {
        var s = series[k];
        if (s && s.QualifyingPart != null) j.part.push([Date.parse(s.Utc) || t, s.QualifyingPart]);
      });
      if (status) Object.keys(status).forEach(function (k) {
        var s = status[k];
        if (!s) return;
        j.hasStatus = true;
        var u = Date.parse(s.Utc) || t;
        if (s.SessionStatus === 'Started' && (j.startedAt == null || u < j.startedAt)) j.startedAt = u;
      });
      break;
    case 'TrackStatus': if (d.Status != null) j.track.push([t, String(d.Status), d.Message || '']); break;
    case 'DriverList': merge(j.drivers, d); break;
    case 'TimingAppData': if (d.Lines) { merge(j.stints, d.Lines); j.changed = t; } break;
    case 'TimingData':
      if (d.SessionPart != null) j.sessionPart = +d.SessionPart;
      if (d.Lines) merge(j.timing, d.Lines);
      j.changed = t;
      if (t - j.lastSnap >= SNAPSHOT_MS) snapshot(t);
      break;
  }
}

/** Snapshots changes that came after the last snapshot: at the end of the data, or when live updates pause. */
function flush(j) {
  if (job === j && j.changed > j.lastSnap) snapshot(j.changed);
}

function val(x) { return x && typeof x === 'object' ? x.Value : x; }

/** The latest qualifying part, at or before `part`, with a value for key: { value, part }, or null. */
function latestPart(list, part, key) {
  for (var p = part; list && p >= 0; p--) {
    var v = list[p] && val(list[p][key]);
    if (v) return { value: v, part: p };
  }
  return null;
}

function snapshot(t) {
  var j = job, rows = [];
  Object.keys(j.timing).forEach(function (num) {
    var l = j.timing[num];
    if (!l || !l.Position) return;
    var app = j.stints[num] || {}, stints = app.Stints, keys = [], compound = '', age = null, fresh = false;
    if (stints) {
      keys = Object.keys(stints).map(Number).sort(function (a, b) { return a - b; });
      var s = stints[keys[keys.length - 1]];
      compound = s && s.Compound ? s.Compound.charAt(0) : '';
      if (s && s.TotalLaps != null) age = +s.TotalLaps;
      fresh = !!s && String(s.New) === 'true';
    }
    var stops = l.NumberOfPitStops != null ? +l.NumberOfPitStops : (keys.length ? keys.length - 1 : null);
    // Qualifying keeps gaps (Stats) and best laps (BestLapTimes) per part and clears the current ones
    // when a part starts. A driver without a lap in this part yet, or knocked out, keeps their latest
    // earlier part's times, marked old.
    var part = Math.max(0, j.sessionPart - 1), stats = l.Stats || {}, laps = l.BestLapTimes;
    var cur = stats[part] || {}, old = false;
    var best = val(l.BestLapTime) || (laps && laps[part] ? val(laps[part].Value) : '');
    var gap = val(l.GapToLeader) || val(l.TimeDiffToFastest) || val(cur.TimeDiffToFastest);
    var interval = val(l.IntervalToPositionAhead) || val(l.TimeDiffToPositionAhead) || val(cur.TimeDifftoPositionAhead);
    var prev = laps && !(laps[part] && val(laps[part].Value)) && latestPart(laps, part - 1, 'Value');
    if (prev) {
      var s = stats[prev.part] || {};
      old = true;
      best = prev.value;
      gap = val(s.TimeDiffToFastest);
      interval = val(s.TimeDifftoPositionAhead);
    }
    rows.push([num, +l.Position, gap || '', interval || '', best || '', val(l.LastLapTime) || '', l.NumberOfLaps || 0,
      !!(l.InPit || l.PitOut), !!(l.Retired || l.Stopped), !!l.KnockedOut, compound,
      stops, age, fresh, +app.GridPos || null, old]);
  });
  rows.sort(function (a, b) { return a[1] - b[1]; });
  j.snaps.push([t, rows]);
  j.lastSnap = t;
}

/** Collect before replaying so tyre and timing updates are applied in timestamp order. */
function handleLine(feed, line) {
  var off = offsetMs(line);
  if (off != null) job.collect.push([off, feed, line]);
}

function fetchFeed(feed) {
  var j = job;
  return fetch(BASE + j.path + feed + '.jsonStream', { headers: { Authorization: 'Bearer ' + j.token }, cache: 'no-store' }).then(function (r) {
    // Missing feeds (e.g. LapCount in practice) come back as 403 from the archive's storage.
    if (r.status === 404 || r.status === 403) return '';
    if (!r.ok) throw new Error(feed + ': HTTP ' + r.status);
    return r.text();
  }).then(function (text) {
    if (!text || job !== j) return;
    var lines = text.replace(/^\uFEFF/, '').split('\n');
    lines.pop();   // empty, or a line still being written
    lines.forEach(function (l) { handleLine(feed, l.replace(/\r$/, '')); });
  });
}

/** UTC ms of offset 0 by a line's Utc field, or NaN. */
function lineBase(l) {
  try { return Date.parse(JSON.parse(l[2].slice(12)).Utc) - l[0]; } catch (e) { return NaN; }
}

function median(a) {
  a.sort(function (x, y) { return x - y; });
  return a[a.length >> 1];
}

// The session clock's Utc gives a base this many ms before the heartbeats' (2.06-2.09 s from 2019;
// in 2018 0.1 s, but the 2018 videos line up with clock + 2 s too).
var CLOCK_LEAD = 2000;

/** True if a base lies within two days of the session's date in the archive path (".../2018-07-22_Race/"). */
function plausible(path, base) {
  var m = /(\d{4}-\d{2}-\d{2})_[^/]*\/?$/.exec(path || '');
  return !m || Math.abs(base - Date.parse(m[1] + 'T12:00:00Z')) < 2 * 86400000;
}

/**
 * Applies the collected lines in time order. The heartbeats give the UTC time base: the median of
 * their Utc minus offset, because some archives start (and end) with a burst of buffered heartbeats
 * written at once with older Utc times, minutes off (Bahrain 2023 race: 5 min). The 2018 archives up
 * to Hungary have heartbeats rewritten a month later, and 2020 Austria FP1's are 3 days off; for those
 * the base comes from the session clock instead.
 */
function replayCollected() {
  var j = job, lines = j.collect, beats = [], clock = [];
  j.collect = null;
  lines.sort(function (a, b) { return a[0] - b[0]; });
  lines.forEach(function (l) {
    if (l[1] !== 'Heartbeat' && l[1] !== 'ExtrapolatedClock') return;
    var b = lineBase(l);
    if (!isNaN(b)) (l[1] === 'Heartbeat' ? beats : clock).push(b);
  });
  if (!beats.length) throw new Error('No timing data for this session yet');
  j.base = median(beats);
  var fromClock = clock.length ? median(clock) + CLOCK_LEAD : null;
  if (!plausible(j.path, j.base) && fromClock != null && plausible(j.path, fromClock)) j.base = fromClock;
  lines.forEach(function (l) {
    var data;
    try { data = JSON.parse(l[2].slice(12)); } catch (e) { return; }
    apply(l[1], j.base + l[0], data);
  });
}

function loadAll() {
  var j = job;
  return FEEDS.reduce(function (p, f) { return p.then(function () { return fetchFeed(f); }); }, Promise.resolve())
    .then(function () {
      if (job !== j) return;
      replayCollected();
      flush(j);
      j.clock.sort(function (a, b) { return a[0] - b[0]; });
      j.part.sort(function (a, b) { return a[0] - b[0]; });
    });
}

/** Index of the last entry with time <= t (entries sorted by time), or -1. */
function at(arr, t) {
  var lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (arr[mid][0] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function query(t) {
  var j = job;
  if (!j || j.base == null) return null;
  var out = { type: j.info.Type || '', name: j.info.Name || '' };
  var li = at(j.lap, t);
  if (li >= 0) { out.lap = j.lap[li][1]; out.totalLaps = j.lap[li][2]; }
  var ci = at(j.clock, t);
  if (ci >= 0) {
    var c = j.clock[ci];
    // Rounded up, like F1's clock: it shows 0:01 until the time is up.
    out.remaining = Math.max(0, Math.ceil(c[1] - (c[2] ? (t - c[3]) / 1000 : 0) - 1e-6));
  }
  var pi = at(j.part, t);
  if (pi >= 0) out.part = j.part[pi][1];
  var ti = at(j.track, t);
  if (ti >= 0) { out.track = j.track[ti][1]; out.trackMessage = j.track[ti][2]; }
  var si = at(j.snaps, t);
  if (si >= 0) {
    out.standings = j.snaps[si][1].map(function (r) {
      var d = j.drivers[r[0]] || {};
      return { num: r[0], pos: r[1], tla: d.Tla || r[0], colour: d.TeamColour ? '#' + d.TeamColour : '#77777d',
        gap: r[2], interval: r[3], best: r[4], last: r[5], laps: r[6], pit: r[7], out: r[8], knockedOut: r[9], tyre: r[10],
        stops: r[11], tyreAge: r[12], tyreNew: r[13], grid: r[14], old: r[15] };
    });
  }
  out.started = j.snaps.length ? t >= j.snaps[0][0] : false;
  // LapCount says lap 1 from the session's opening, an hour before the start; a race starts at its
  // first 'Started' status. The 2018-2019 archives have no status: there the session clock starts
  // 0.4-2 s after lights out (measured on 2020-2025 races). Once lap 2 is on, it has started.
  var startedAt = j.hasStatus ? j.startedAt : j.clockStartedAt;
  out.beforeStart = (j.hasStatus || j.clockStartedAt != null) && !(startedAt != null && t >= startedAt) && !(out.lap > 1);
  return out;
}

function start(m) {
  job = emptyJob(m.path, m.token);
  var j = job;
  loadAll().then(function () {
    if (job !== j) return;
    self.postMessage({ type: 'loaded', info: { type: j.info.Type, name: j.info.Name, drivers: Object.keys(j.drivers).length } });
    // Live, with the archive already written as it goes: what comes after it arrives on the real-time feed.
    if (m.live) { j.afterArchive = true; connect(j); }
  }).catch(function (err) {
    if (job !== j) return;
    // No archive yet: a live session. Follow F1's real-time feed instead.
    if (m.live && !j.stopped) return startLive(m);
    self.postMessage({ type: 'error', message: err.message });
  });
}

// live: F1's SignalR Core feed (anonymous)

var LIVE = 'https://livetiming.formula1.com/signalrcore';
var RS = '\x1e';

/** Archive folders compared as F1 might write them: slashes, case and accents (São Paulo). */
function samePath(a, b) {
  var n = function (p) {
    p = String(p || '').replace(/^\/+|\/+$/g, '').toLowerCase();
    return p.normalize ? p.normalize('NFC') : p;
  };
  return n(a) === n(b);
}

function startLive(m) {
  var j = job = emptyJob(m.path, m.token);
  j.base = 0;          // live records carry absolute UTC times
  connect(j);
}

function connect(j) {
  if (job !== j || j.stopped) return;
  fetch(LIVE + '/negotiate?negotiateVersion=1', { method: 'POST', credentials: 'include' })
    .then(function (r) { return r.text(); })
    .then(function (text) {
      var n = JSON.parse(text.replace(/^\uFEFF/, ''));
      var ws = new WebSocket('wss://livetiming.formula1.com/signalrcore?id=' + encodeURIComponent(n.connectionToken || n.connectionId));
      var handshaken = false, announced = false;
      j.ws = ws;
      j.lastRx = Date.now();
      // SignalR clients drop a connection that has been silent for 30 s (the server pings every 15 s), and
      // one that never answers the handshake. A half-open socket never closes by itself.
      function reconnect() {
        ws.onclose = null;
        clearInterval(j.keepAlive);
        try { ws.close(); } catch (x) { /* closed */ }
        if (job === j && !j.stopped) setTimeout(function () { connect(j); }, 1000);
      }
      j.keepAlive = setInterval(function () {
        if (Date.now() - j.lastRx > 45000) return reconnect();
        if (handshaken) try { ws.send(JSON.stringify({ type: 6 }) + RS); } catch (x) { /* closed */ }
      }, 15000);
      ws.onopen = function () { ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS); };
      ws.onmessage = function (e) {
        if (job !== j) return ws.close();
        j.lastRx = Date.now();
        var frames = String(e.data).split(RS).filter(Boolean).map(function (f) {
          try { return JSON.parse(f); } catch (x) { return null; }
        });
        if (!handshaken) {
          handshaken = true;
          frames.shift();
          ws.send(JSON.stringify({ type: 1, invocationId: '1', target: 'Subscribe', arguments: [FEEDS] }) + RS);
        }
        frames.forEach(function (msg) {
          if (!msg) return;
          if (msg.type === 3 && msg.result) {
            var live = msg.result.SessionInfo;
            // After an archive, only the same session's updates belong to it.
            if (j.afterArchive && live && live.Path && !samePath(live.Path, j.path)) { j.stopped = true; return ws.close(); }
            // Full state at subscribe time.
            var t = Date.now();
            FEEDS.forEach(function (f) { if (msg.result[f]) apply(f, t, msg.result[f]); });
            snapshot(t);
            if (!announced) {
              announced = true;
              self.postMessage({ type: 'loaded', info: { type: j.info.Type, name: j.info.Name, live: true } });
            }
          } else if (msg.type === 1 && msg.target === 'feed' && msg.arguments) {
            var a = msg.arguments;
            apply(a[0], Date.parse(a[2]) || Date.now(), a[1]);
          }
        });
        // Within 3 s of the first unsnapshotted change; later messages (heartbeats) must not postpone it.
        if (!j.flushTimer) j.flushTimer = setTimeout(function () { j.flushTimer = null; flush(j); }, SNAPSHOT_MS);
      };
      ws.onclose = function () {
        clearInterval(j.keepAlive);
        if (job === j && !j.stopped) setTimeout(function () { connect(j); }, 5000);
      };
    })
    .catch(function () { setTimeout(function () { connect(j); }, 10000); });
}

self.onmessage = function (e) {
  var m = e.data;
  if (m.cmd === 'load') {
    if (job) job.stopped = true;
    start(m);
  } else if (m.cmd === 'query') {
    self.postMessage({ type: 'state', id: m.id, state: query(m.t) });
  } else if (m.cmd === 'stop') {
    if (job) job.stopped = true;
    if (job && job.ws) try { job.ws.close(); } catch (x) { /* closed */ }
    if (job) clearTimeout(job.flushTimer);
    job = null;
  }
};
