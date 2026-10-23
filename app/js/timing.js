/*
 * Live timing for the session being watched. Finds the session in F1's timing archive and
 * runs js/timing-worker.js, which answers queries for any moment (live or replay).
 */
var Timing = (function () {
  var BASE = 'https://livetiming.formula1.com/static/';
  var SESSIONS = /^(Practice [123]|Qualifying|Sprint Qualifying|Sprint Shootout|Sprint|Race)$/;
  var worker = null;
  var loadedKey = null;
  var ready = false;
  var seq = 0;
  var waiting = {};

  function onMessage(e) {
    var m = e.data;
    if (m.type === 'loaded') ready = true;
    else if (m.type === 'state' && waiting[m.id]) { waiting[m.id](m.state); delete waiting[m.id]; }
  }

  /** True when the content is an F1 session that has timing data. */
  function supported(meta) {
    return !!meta && /FORMULA 1/i.test(meta.series || '') && SESSIONS.test(meta.title || '');
  }

  function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

  /** "2026-10-23T13:45:00-05:00" -> offset in ms (-5 h). */
  function trackOffset(iso) {
    var m = /([+-])(\d{2}):(\d{2})$/.exec(iso || '');
    return m ? (m[1] === '-' ? -1 : 1) * ((+m[2]) * 60 + (+m[3])) * 60000 : 0;
  }

  /** Archive folder for a session: from the season index, or built from the meeting name and dates. */
  function resolvePath(meta, token) {
    var year = new Date(meta.start).getUTCFullYear();
    return fetch(BASE + year + '/Index.json', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        var idx = text ? JSON.parse(text.replace(/^﻿/, '')) : { Meetings: [] };
        var mt = idx.Meetings.filter(function (x) { return String(x.Key) === String(meta.meetingKey); })[0];
        var s = mt && mt.Sessions.filter(function (x) { return x.Name.toLowerCase() === meta.title.toLowerCase() && x.Path; })[0];
        if (s) return s.Path;
        // Not indexed yet (the current weekend): folders are named after local session and race dates.
        var sessionDay = isoDate(meta.start + trackOffset(meta.endIso));
        var raceDay = meta.meetingEnd ? isoDate(meta.meetingEnd) : nextSunday(sessionDay);
        return year + '/' + raceDay + '_' + meta.meeting.replace(/ /g, '_') + '/' + sessionDay + '_' + meta.title.replace(/ /g, '_') + '/';
      });
  }

  function nextSunday(day) {
    var d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay()) % 7);
    return isoDate(d.getTime());
  }

  /** Starts loading timing for a session. meta: { title, series, meeting, meetingKey, start, endIso, meetingEnd } */
  function load(meta, token, live) {
    if (!supported(meta)) { stop(); return; }
    var key = meta.meetingKey + '/' + meta.title;
    if (key === loadedKey) return;
    stop();
    loadedKey = key;
    if (!worker) { worker = new Worker('js/timing-worker.js'); worker.onmessage = onMessage; }
    resolvePath(meta, token).then(function (path) {
      if (loadedKey === key) worker.postMessage({ cmd: 'load', path: path, token: token, live: !!live });
    }).catch(function () { /* no timing for this session */ });
  }

  /** Resolves with the timing state at UTC ms t, or null. */
  function query(t) {
    if (!ready || !worker) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var id = ++seq;
      waiting[id] = resolve;
      worker.postMessage({ cmd: 'query', id: id, t: t });
      setTimeout(function () { if (waiting[id]) { delete waiting[id]; resolve(null); } }, 2000);
    });
  }

  function stop() {
    ready = false;
    loadedKey = null;
    if (worker) worker.postMessage({ cmd: 'stop' });
  }

  var TRACK = { '2': 'Yellow flag', '4': 'Safety car', '5': 'Red flag', '6': 'Virtual safety car', '7': 'VSC ending' };

  /** Short line for the seeker / OSD: "Lap 34/56", "Q2 · 07:12 left", "FP2 · 32:10 left". */
  function label(s) {
    if (!s) return '';
    var parts = [];
    var mmss = function (sec) { var m = Math.floor(sec / 60), r = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r; };
    if (s.type === 'Race' && s.lap) parts.push('Lap ' + s.lap + (s.totalLaps ? '/' + s.totalLaps : ''));
    else if (s.type === 'Qualifying') {
      var sprint = /sprint/i.test(s.name);
      parts.push((sprint ? 'SQ' : 'Q') + (s.part || 1) + (s.remaining != null ? ' · ' + mmss(s.remaining) + ' left' : ''));
    } else if (s.type === 'Practice') {
      parts.push((s.name || 'Practice').replace(/^Practice /, 'FP') + (s.remaining != null ? ' · ' + mmss(s.remaining) + ' left' : ''));
    }
    if (s.track && TRACK[s.track]) parts.push(TRACK[s.track]);
    return parts.join(' · ');
  }

  return { load: load, query: query, stop: stop, label: label, supported: supported, isReady: function () { return ready; } };
})();
