/* Finds the session's timing archive and queries timing-worker.js at the video's timestamp. */
var Timing = (function () {
  var BASE = 'https://livetiming.formula1.com/static/';
  var SESSIONS = ['Practice 1', 'Practice 2', 'Practice 3', 'Qualifying', 'Sprint Qualifying', 'Sprint Shootout', 'Sprint', 'Race'];
  var worker = null;
  var loadedKey = null;
  var ready = false;
  var seq = 0;
  var waiting = {};

  function onMessage(e) {
    var m = e.data;
    if (m.type === 'loaded') ready = true;
    else if (m.type === 'error') failed(loadedKey);
    else if (m.type === 'state' && waiting[m.id]) { waiting[m.id](m.state); delete waiting[m.id]; }
  }

  /**
   * The timing archive's name for a session video's title, or the title if it names none. Besides
   * "Qualifying", F1 TV has "F1 Qualifying", "Qualifying Replay", "Sprint shootout",
   * "2018 Monaco Grand Prix - Full Race" and "2018 Australian GP - F1 FP2".
   */
  function sessionName(title) {
    var t = String(title || '').split(' - ').pop().replace(/^(F1|Full) /i, '').replace(/ Replay$/i, '')
      .replace(/^FP([123])$/i, 'Practice $1');
    return SESSIONS.filter(function (s) { return s.toLowerCase() === t.toLowerCase(); })[0] || t;
  }

  function supported(meta) {
    return !!meta && /FORMULA 1/i.test(meta.series || '') && SESSIONS.indexOf(sessionName(meta.title)) >= 0;
  }

  function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

  /** "2026-10-23T13:45:00-05:00" -> offset in ms (-5 h). */
  function trackOffset(iso) {
    var m = /([+-])(\d{2}):(\d{2})$/.exec(iso || '');
    return m ? (m[1] === '-' ? -1 : 1) * ((+m[2]) * 60 + (+m[3])) * 60000 : 0;
  }

  /**
   * Archive folder for a session: from the season index (by session key, then name), or built from the
   * meeting name and dates. Replays before 2021 have no start date, only the year.
   */
  function resolvePath(meta, token) {
    var year = +meta.year || new Date(meta.start).getUTCFullYear();
    var name = sessionName(meta.title);
    var auth = { headers: { Authorization: 'Bearer ' + token } };
    return fetch(BASE + year + '/Index.json', auth)
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        var idx = text ? JSON.parse(text.replace(/^\uFEFF/, '')) : { Meetings: [] };
        var mt = idx.Meetings.filter(function (x) { return String(x.Key) === String(meta.meetingKey); })[0];
        var sessions = (mt ? mt.Sessions : []).filter(function (x) { return x.Path; });
        var s = sessions.filter(function (x) { return meta.sessionKey && String(x.Key) === String(meta.sessionKey); })[0] ||
          sessions.filter(function (x) { return x.Name.toLowerCase() === name.toLowerCase(); })[0];
        if (s) return s.Path;
        if (!meta.start) throw new Error('No timing archive for this session');
        // Not indexed (the current weekend, 2022, early 2024): folders are named after local session and race dates.
        var sessionDay = isoDate(meta.start + trackOffset(meta.endIso));
        var folder = function (raceDay) {
          // F1 TV says "Emilia-Romagna Grand Prix" (2024); the archive, Emilia_Romagna_Grand_Prix.
          return year + '/' + raceDay + '_' + meta.meeting.replace(/[ -]/g, '_') + '/' + sessionDay + '_' + name.replace(/ /g, '_') + '/';
        };
        if (meta.meetingEnd) return folder(isoDate(meta.meetingEnd));
        if (name === 'Race') return folder(sessionDay);
        // The race is on Sunday, or on Saturday (Bahrain and Saudi Arabia 2024, Las Vegas): take the folder that exists.
        var sunday = nextSunday(sessionDay), saturday = isoDate(Date.parse(sunday + 'T12:00:00Z') - 86400000);
        if (saturday < sessionDay) return folder(sunday);
        var exists = function (path) {
          return fetch(BASE + path + 'SessionInfo.jsonStream', auth).then(function (r) { return r.ok; }, function () { return false; });
        };
        return exists(folder(sunday)).then(function (ok) {
          return ok ? folder(sunday) : exists(folder(saturday)).then(function (sat) { return folder(sat ? saturday : sunday); });
        });
      });
  }

  function nextSunday(day) {
    var d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay()) % 7);
    return isoDate(d.getTime());
  }

  /** Starts loading timing for a session. meta: { title, series, meeting, meetingKey, start, endIso, meetingEnd } */
  var failure = { key: null, at: 0 };

  /**
   * No timing for this session (2022 and others have none), or a network error: a load a minute
   * later tries again, not every feed switch.
   */
  function failed(key) {
    if (key == null || loadedKey !== key) return;
    loadedKey = null;
    failure = { key: key, at: Date.now() };
  }

  function load(meta, token, live) {
    if (!supported(meta)) { stop(); return; }
    var key = meta.meetingKey + '/' + meta.title;
    if (key === loadedKey || (key === failure.key && Date.now() - failure.at < 60000)) return;
    stop();
    loadedKey = key;
    if (!worker) { worker = new Worker('js/timing-worker.js'); worker.onmessage = onMessage; }
    resolvePath(meta, token).then(function (path) {
      if (loadedKey === key) worker.postMessage({ cmd: 'load', path: path, token: token, live: !!live });
    }).catch(function () {
      // The real-time feed needs no archive path: a live session still gets its tower.
      if (live && loadedKey === key) worker.postMessage({ cmd: 'load', path: '', token: token, live: true });
      else failed(key);
    });
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

  /** short: without the total laps ("Lap 34"), for the seek bubble. */
  function label(s, short) {
    if (!s) return '';
    var parts = [];
    var mmss = function (sec) { var m = Math.floor(sec / 60), r = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r; };
    if (s.type === 'Race' && s.beforeStart) parts.push('Not started');
    else if (s.type === 'Race' && s.lap) parts.push('Lap ' + s.lap + (s.totalLaps && !short ? '/' + s.totalLaps : ''));
    else if (s.type === 'Qualifying') {
      var sprint = /sprint/i.test(s.name);
      parts.push((sprint ? 'SQ' : 'Q') + (s.part || 1) + (s.remaining != null ? ' · ' + mmss(s.remaining) + ' left' : ''));
    } else if (s.type === 'Practice') {
      parts.push((s.name || 'Practice').replace(/^Practice /, 'FP') + (s.remaining != null ? ' · ' + mmss(s.remaining) + ' left' : ''));
    }
    if (s.track && TRACK[s.track]) parts.push(TRACK[s.track]);
    return parts.join(' · ');
  }

  return { load: load, query: query, stop: stop, label: label, supported: supported, sessionName: sessionName, isReady: function () { return ready; } };
})();
