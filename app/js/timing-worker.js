/*
 * Timing worker: loads a session's feeds from F1's timing archive, keeps them on a UTC
 * timeline and answers "what did the timing screen show at time T?". The archive is published
 * shortly after a session; during a live session the worker uses F1's real-time feed (SignalR)
 * instead and records it from the moment it connects, so viewers behind live see no spoilers.
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

function emptyJob(path, token, live) {
  return {
    path: path, token: token, live: live, stopped: false,
    bytes: {}, partial: {},                // per feed: bytes read, unfinished last line
    collect: [],                           // initial load: [offset, feed, raw line] applied in time order
    base: null,                            // UTC ms of offset 0
    info: {},                              // SessionInfo
    lap: [], clock: [], part: [], track: [],
    drivers: {}, timing: {}, stints: {},
    snaps: [], lastSnap: -1
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
      var series = d.Series;
      if (series) Object.keys(series).forEach(function (k) {
        var s = series[k];
        if (s && s.QualifyingPart != null) j.part.push([Date.parse(s.Utc) || t, s.QualifyingPart]);
      });
      break;
    case 'TrackStatus': if (d.Status != null) j.track.push([t, String(d.Status), d.Message || '']); break;
    case 'DriverList': merge(j.drivers, d); break;
    case 'TimingAppData': if (d.Lines) merge(j.stints, d.Lines); break;
    case 'TimingData':
      if (d.Lines) merge(j.timing, d.Lines);
      if (t - j.lastSnap >= SNAPSHOT_MS) snapshot(t);
      break;
  }
}

function val(x) { return x && typeof x === 'object' ? x.Value : x; }

/** Compact standings at the current point of the replay. */
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
    rows.push([num, +l.Position, val(l.GapToLeader) || val(l.TimeDiffToFastest) || '',
      val(l.IntervalToPositionAhead) || val(l.TimeDiffToPositionAhead) || '',
      val(l.BestLapTime) || '', val(l.LastLapTime) || '', l.NumberOfLaps || 0,
      !!(l.InPit || l.PitOut), !!(l.Retired || l.Stopped), !!l.KnockedOut, compound,
      stops, age, fresh, +app.GridPos || null]);
  });
  rows.sort(function (a, b) { return a[1] - b[1]; });
  j.snaps.push([t, rows]);
  j.lastSnap = t;
}

function handleLine(feed, line) {
  var off = offsetMs(line);
  if (off == null) return;
  // While loading, keep raw lines and apply them later in global time order, so that e.g.
  // tyre stints and timing lines interleave correctly in the snapshots.
  if (job.collect) return job.collect.push([off, feed, line]);
  var data;
  try { data = JSON.parse(line.slice(12)); } catch (e) { return; }
  apply(feed, job.base + off, data);
}

function fetchFeed(feed) {
  var j = job, from = j.bytes[feed] || 0;
  var headers = { Authorization: 'Bearer ' + j.token };
  if (from) headers.Range = 'bytes=' + from + '-';
  return fetch(BASE + j.path + feed + '.jsonStream', { headers: headers, cache: 'no-store' }).then(function (r) {
    // Missing feeds (e.g. LapCount in practice) come back as 403 from the archive's storage.
    if (r.status === 416 || r.status === 404 || r.status === 403) return '';
    if (!r.ok) throw new Error(feed + ': HTTP ' + r.status);
    var whole = r.status === 200;
    return r.text().then(function (text) {
      if (whole && from) text = text.slice(from); // server ignored the range
      return text;
    });
  }).then(function (text) {
    if (!text || job !== j) return;
    j.bytes[feed] = (j.bytes[feed] || 0) + utf8Length(text);
    var body = (j.partial[feed] || '') + text.replace(/^﻿/, '');
    var lines = body.split('\n');
    j.partial[feed] = lines.pop();
    lines.forEach(function (l) { handleLine(feed, l.replace(/\r$/, '')); });
  });
}

function utf8Length(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xdc00) ? (i++, 4) : 3;
  }
  return n;
}

/** Applies the collected lines in time order; the first heartbeat gives the UTC time base. */
function replayCollected() {
  var j = job, lines = j.collect;
  j.collect = null;
  lines.sort(function (a, b) { return a[0] - b[0]; });
  for (var i = 0; i < lines.length && j.base == null; i++) {
    if (lines[i][1] !== 'Heartbeat') continue;
    try { j.base = Date.parse(JSON.parse(lines[i][2].slice(12)).Utc) - lines[i][0]; } catch (e) { /* next */ }
  }
  if (j.base == null) throw new Error('No timing data for this session yet');
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
      return { num: r[0], pos: r[1], tla: d.Tla || r[0], colour: d.TeamColour ? '#' + d.TeamColour : '#888',
        gap: r[2], interval: r[3], best: r[4], last: r[5], laps: r[6], pit: r[7], out: r[8], knockedOut: r[9], tyre: r[10],
        stops: r[11], tyreAge: r[12], tyreNew: r[13], grid: r[14] };
    });
  }
  out.started = j.snaps.length ? t >= j.snaps[0][0] : false;
  return out;
}

function start(m) {
  job = emptyJob(m.path, m.token, m.live);
  var j = job;
  loadAll().then(function () {
    if (job !== j) return;
    self.postMessage({ type: 'loaded', info: { type: j.info.Type, name: j.info.Name, drivers: Object.keys(j.drivers).length } });
  }).catch(function (err) {
    if (job !== j) return;
    // No archive yet: a live session. Follow F1's real-time feed instead.
    if (m.live && !j.stopped) return startLive(m);
    self.postMessage({ type: 'error', message: err.message });
  });
}

// ---------- live: F1's SignalR Core feed (anonymous) ----------

var LIVE = 'https://livetiming.formula1.com/signalrcore';
var RS = '\x1e';

function startLive(m) {
  var j = job = emptyJob(m.path, m.token, true);
  j.collect = null;
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
      ws.onopen = function () { ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS); };
      ws.onmessage = function (e) {
        if (job !== j) return ws.close();
        var frames = String(e.data).split(RS).filter(Boolean).map(function (f) {
          try { return JSON.parse(f); } catch (x) { return null; }
        });
        if (!handshaken) {
          handshaken = true;
          frames.shift();
          ws.send(JSON.stringify({ type: 1, invocationId: '1', target: 'Subscribe', arguments: [FEEDS] }) + RS);
          j.keepAlive = setInterval(function () { try { ws.send(JSON.stringify({ type: 6 }) + RS); } catch (x) { /* closed */ } }, 15000);
        }
        frames.forEach(function (msg) {
          if (!msg) return;
          if (msg.type === 3 && msg.result) {
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
    job = null;
  }
};
