/*
 * Championship standings and driver seasons from jolpica (the open Ergast-compatible F1 API),
 * with headshots and team colours from F1's own timing driver list.
 */
var Stats = (function () {
  var API = 'https://api.jolpi.ca/ergast/f1/current';
  var TIMING = 'https://livetiming.formula1.com/static/';
  var INFO_KEY = 'f1tv.drivers';
  var cache = {};

  function get(path) {
    if (!cache[path]) {
      cache[path] = fetch(API + path + '?limit=100').then(function (r) {
        if (!r.ok) throw new Error('Stats unavailable (HTTP ' + r.status + ')');
        return r.json();
      }).then(function (j) { return j.MRData; });
      cache[path].catch(function () { delete cache[path]; });
    }
    return cache[path];
  }

  function shortRace(name) { return String(name || '').replace(/ Grand Prix$/, ' GP'); }

  function driverStandings() {
    return get('/driverStandings.json').then(function (d) {
      var list = d.StandingsTable.StandingsLists[0] || { DriverStandings: [] };
      return {
        round: +list.round || 0,
        drivers: list.DriverStandings.map(function (s) {
          var dr = s.Driver, team = s.Constructors[s.Constructors.length - 1] || {};
          return { pos: +s.position || s.positionText, points: +s.points, wins: +s.wins, id: dr.driverId, code: dr.code,
            number: dr.permanentNumber, first: dr.givenName, last: dr.familyName, nationality: dr.nationality,
            team: team.name || '', teamId: team.constructorId || '' };
        })
      };
    });
  }

  function constructorStandings() {
    return get('/constructorStandings.json').then(function (d) {
      var list = d.StandingsTable.StandingsLists[0] || { ConstructorStandings: [] };
      return list.ConstructorStandings.map(function (s) {
        return { pos: +s.position || s.positionText, points: +s.points, wins: +s.wins, id: s.Constructor.constructorId, name: s.Constructor.name };
      });
    });
  }

  function lastRace() {
    return get('/last/results.json').then(function (d) {
      var r = d.RaceTable.Races[0];
      return r ? { round: +r.round, name: shortRace(r.raceName) } : null;
    }).catch(function () { return null; });
  }

  // Classified finishers are "Finished" or lapped ("+1 Lap", "Lapped"); anything else is a DNF/DSQ.
  function classified(status) { return /^(Finished|Lapped|\+\d+ Laps?)$/.test(status || ''); }

  /** A driver's season: [{ round, name, country, pos, grid, points, status, fastest, quali, sprint }]. */
  function driverSeason(id) {
    return Promise.all([
      get('/drivers/' + id + '/results.json'),
      get('/drivers/' + id + '/qualifying.json').catch(function () { return null; }),
      get('/drivers/' + id + '/sprint.json').catch(function () { return null; })
    ]).then(function (all) {
      var quali = {}, sprint = {};
      ((all[1] && all[1].RaceTable.Races) || []).forEach(function (r) { quali[r.round] = +r.QualifyingResults[0].position; });
      ((all[2] && all[2].RaceTable.Races) || []).forEach(function (r) {
        var s = r.SprintResults[0];
        sprint[r.round] = { pos: +s.position || null, points: +s.points || 0 };
      });
      return all[0].RaceTable.Races.map(function (r) {
        var res = r.Results[0];
        return {
          round: +r.round, name: shortRace(r.raceName), country: r.Circuit.Location.country,
          pos: classified(res.status) ? +res.position : null, posText: res.positionText,
          grid: +res.grid || null, points: +res.points || 0, status: res.status,
          fastest: !!(res.FastestLap && res.FastestLap.rank === '1'),
          quali: quali[r.round] || null, sprint: sprint[r.round] || null
        };
      });
    });
  }

  function summary(races) {
    var s = { wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 0, best: null, finishes: 0, sum: 0, points: 0 };
    races.forEach(function (r) {
      if (r.pos === 1) s.wins++;
      if (r.pos && r.pos <= 3) s.podiums++;
      if (r.quali === 1) s.poles++;
      if (r.fastest) s.fastestLaps++;
      if (!r.pos) s.dnfs++;
      else { s.finishes++; s.sum += r.pos; s.best = s.best ? Math.min(s.best, r.pos) : r.pos; }
      s.points += r.points + (r.sprint ? r.sprint.points : 0);
    });
    s.avg = s.finishes ? s.sum / s.finishes : null;
    return s;
  }

  /**
   * Headshots and colours by driver code from F1's latest timing archive (requires a token).
   * Cached for a day; resolves {} when unavailable.
   */
  function driverInfo(token) {
    try {
      var c = JSON.parse(localStorage.getItem(INFO_KEY) || 'null');
      if (c && Date.now() - c.at < 86400000) return Promise.resolve(c.byCode);
    } catch (e) { /* ignore */ }
    if (!token) return Promise.resolve({});
    var H = { Authorization: 'Bearer ' + token };
    var year = new Date().getUTCFullYear();
    return fetch(TIMING + year + '/Index.json', { headers: H }).then(function (r) { return r.text(); }).then(function (t) {
      var idx = JSON.parse(t.replace(/^﻿/, ''));
      var sessions = [];
      idx.Meetings.forEach(function (m) { m.Sessions.forEach(function (s) { if (s.Path) sessions.push(s.Path); }); });
      var path = sessions[sessions.length - 1];
      return fetch(TIMING + path + 'DriverList.jsonStream', { headers: H }).then(function (r) { return r.text(); });
    }).then(function (text) {
      var list = {};
      text.replace(/^﻿/, '').split('\n').forEach(function (line) {
        try {
          var d = JSON.parse(line.slice(12));
          Object.keys(d).forEach(function (n) { list[n] = Object.assign(list[n] || {}, d[n]); });
        } catch (e) { /* skip partial lines */ }
      });
      var byCode = {};
      Object.keys(list).forEach(function (n) {
        var d = list[n];
        if (!d.Tla) return;
        byCode[d.Tla] = { colour: d.TeamColour ? '#' + d.TeamColour : '', headshot: d.HeadshotUrl || '', team: d.TeamName || '' };
      });
      try { localStorage.setItem(INFO_KEY, JSON.stringify({ at: Date.now(), byCode: byCode })); } catch (e) { /* full */ }
      return byCode;
    }).catch(function () { return {}; });
  }

  /** All pages of a jolpica list endpoint (max 100 per page). */
  function allPages(path, pick) {
    var key = 'pages:' + path;
    if (!cache[key]) {
      cache[key] = (function next(offset, acc) {
        return fetch(API + path + '?limit=100&offset=' + offset).then(function (r) {
          if (!r.ok) throw new Error('Stats unavailable (HTTP ' + r.status + ')');
          return r.json();
        }).then(function (j) {
          var d = j.MRData, items = pick(d);
          acc = acc.concat(items);
          return +d.offset + +d.limit < +d.total ? next(offset + 100, acc) : acc;
        });
      })(0, []);
      cache[key].catch(function () { delete cache[key]; });
    }
    return cache[key];
  }

  /**
   * The season's championship progression: { rounds: [{ round, name }], drivers: { id: { code, name,
   * teamId, team, perRound: { round: pts } } }, teams: { id: { name, perRound } } } (race + sprint).
   * jolpica pages by result row, so a race can span two pages; rows are merged per round.
   */
  function seasonProgress() {
    var flatten = function (key) {
      return function (d) {
        var out = [];
        d.RaceTable.Races.forEach(function (r) {
          (r[key] || []).forEach(function (res) { out.push({ round: +r.round, name: shortRace(r.raceName), res: res }); });
        });
        return out;
      };
    };
    return Promise.all([
      allPages('/results.json', flatten('Results')),
      allPages('/sprint.json', flatten('SprintResults')).catch(function () { return []; })
    ]).then(function (all) {
      var rounds = {}, drivers = {}, teams = {};
      all[0].concat(all[1]).forEach(function (row) {
        var res = row.res, dr = res.Driver, c = res.Constructor, pts = +res.points || 0;
        rounds[row.round] = rounds[row.round] || row.name;
        var d = drivers[dr.driverId] = drivers[dr.driverId] || { code: dr.code, name: dr.givenName + ' ' + dr.familyName, perRound: {} };
        d.teamId = c.constructorId;
        d.team = c.name;
        d.perRound[row.round] = (d.perRound[row.round] || 0) + pts;
        var t = teams[c.constructorId] = teams[c.constructorId] || { name: c.name, perRound: {} };
        t.perRound[row.round] = (t.perRound[row.round] || 0) + pts;
      });
      var list = Object.keys(rounds).map(Number).sort(function (a, b) { return a - b; })
        .map(function (r) { return { round: r, name: rounds[r] }; });
      return { rounds: list, drivers: drivers, teams: teams };
    });
  }

  return {
    seasonProgress: seasonProgress,
    driverStandings: driverStandings,
    constructorStandings: constructorStandings,
    lastRace: lastRace,
    driverSeason: driverSeason,
    summary: summary,
    driverInfo: driverInfo
  };
})();
