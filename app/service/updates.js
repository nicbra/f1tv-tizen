/*
 * The bundle's update downloader (docs/LAUNCHER.md): finds and fetches new versions and hands them to the shell's
 * `launcher.install(manifest, signature, archive)`, which checks the signature and every hash and refuses anything
 * else. Nothing here needs to be trusted, so it can change in any release: another source, another URL scheme.
 * The shell keeps its own frozen check at each app start as a safety net, and both share one clock: this runs when the
 * last check, anyone's, is an hour old (`launcher.status().lastCheck`), and reports each outcome (`launcher.checked`).
 * Archives are never downloaded during playback: the check notes `deferred` and runs again once playback stops.
 */
'use strict';
var http = require('http'), https = require('https');

var REPO = 'nicbra/f1tv-tizen', HOUR = 3600000, TICK = 300000, PAGE = 50, MAX_PAGES = 5;

/* A certificate the TV's old Node can't check (authority missing from its list, expired, wrong clock). Everything
 * downloaded is checked against the signed manifest, so the connection is retried without the check. */
function untrustedCertificate(e) { return !!e && /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(String(e.code || '')); }

/* GET with redirects, a size limit and one deadline: cb(err, Buffer, unverified). */
function download(target, limit, cb, allowHttp) {
  var done = false, current, unverified = false;
  var timer = setTimeout(function () { finish(new Error('Download timeout')); if (current) current.abort(); }, 60000 + Math.round(limit / 32));
  function finish(err, b) { if (done) return; done = true; clearTimeout(timer); cb(err, b, unverified); }
  function get(u, hops) {
    var m = /^(https?):\/\/([^\/\s?#:]+)(?::(\d+))?(\/[^#\s]*)?$/.exec(u);
    if (!m) return finish(new Error('Invalid URL'));
    if (m[1] === 'http' && !allowHttp) return finish(new Error('HTTPS required'));
    var secure = m[1] === 'https', lax = unverified && secure;
    var opts = { hostname: m[2], port: +m[3] || (secure ? 443 : 80), path: m[4] || '/',
      headers: { 'User-Agent': 'F1TV-bundle/1', Accept: m[2] === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } };
    if (lax) opts.rejectUnauthorized = false;
    try {
      current = (secure ? https : http).get(opts, function (res) {
        if (done) return res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops) {
          res.resume();
          var next = res.headers.location;
          if (next.indexOf('//') === 0) next = m[1] + ':' + next;
          else if (next.charAt(0) === '/') next = m[1] + '://' + m[2] + (m[3] ? ':' + m[3] : '') + next;
          return get(next, hops - 1);
        }
        if (res.statusCode !== 200 || +res.headers['content-length'] > limit) { res.resume(); return finish(new Error('HTTP ' + res.statusCode + ' or size limit')); }
        var chunks = [], size = 0;
        res.on('data', function (b) { size += b.length; if (size > limit) { finish(new Error('Size limit')); current.abort(); } else chunks.push(b); });
        res.on('end', function () { finish(null, Buffer.concat(chunks)); });
        res.on('error', finish);
        res.on('aborted', function () { finish(new Error('Download aborted')); });
      });
      current.on('error', function (e) {
        if (!done && !lax && secure && untrustedCertificate(e)) { unverified = true; return get(u, hops); }
        finish(e);
      });
    } catch (e) { finish(e); }
  }
  get(target, 5);
}

function version(v) { return /^\d+\.\d+\.\d+$/.test(String(v || '')); }
function compare(a, b) {
  var x = a.split('.'), y = b.split('.');
  for (var i = 0; i < 3; i++) if (+x[i] !== +y[i]) return +x[i] - +y[i];
  return 0;
}

/*
 * launcher: { status(), verify(manifest, signature), install(manifest, signature, archive), checked(result),
 *   discard(version) } from the shell.
 * deps (tests): { download, now }.
 */
function create(launcher, deps) {
  deps = deps || {};
  var fetch = deps.download || download, now = deps.now || Date.now, busy = false, timer = null, stopped = false;

  function check(cb) {
    cb = cb || function () {};
    if (busy) return cb(new Error('Update check already running'));
    var st = launcher.status();
    if (!st.enabled) return cb(null);
    busy = true;
    // failure: the first network or install error. A release that is merely broken (assets missing, signature
    // invalid) is skipped; one that couldn't be fetched or installed makes the check a failure unless an
    // update was installed anyway.
    var releases = [], skipped = [], deferred = false, notesUnverified = false, ended = false, failure = null, installed = false;
    function finish(err) {
      if (ended) return; ended = true; busy = false;
      if (stopped) return cb(new Error('Stopped'));
      if (!err && failure && !installed) err = failure;
      try {
        launcher.checked(err ? { ok: false, error: String(err.message || err) } : { ok: true, releases: releases, skipped: skipped, deferred: deferred });
      } catch (e) { /* the shell keeps its own state */ }
      cb(err || null);
    }
    function get(u, limit, done) {
      try { fetch(u, limit, function (err, body, unverified) { if (stopped) return finish(); try { done(err, body, !!unverified); } catch (e) { finish(e); } }, !!st.source); }
      catch (e) { finish(e); }
    }
    // Newest first, newer than what this TV already has; stops at the first one installed. Every value used from a
    // manifest comes from the shell's verify(), after the signature check (which also applies its revokes).
    function walk(list, i) {
      if (i >= list.length || compare(list[i].version, st.newest) <= 0) return finish();
      var r = list[i];
      function skip(reason) { skipped.push({ version: r.version, reason: String(reason.message || reason) }); walk(list, i + 1); }
      function failed(e) { if (!failure) failure = e; skip(e); }
      if (!r.base) return skip('Missing bundle assets');
      get(r.base + '/bundle.json', 1048576, function (err, raw) {
        if (err) return failed(err);
        get(r.base + '/bundle.json.sig', 1024, function (err, sig) {
          if (err) return failed(err);
          var m;
          try { m = launcher.verify(raw, sig); } catch (e) { return skip(e); }
          if (m.version !== r.version) return skip('Release version mismatch');
          releases.forEach(function (x) { if (x.version === r.version) { x.minShell = m.minShell; if (st.source) x.notes = m.notes; } });
          if (m.minShell > st.shellLevel) return walk(list, i + 1);   // the shell shows "needs reinstall"
          if (launcher.status().blocked.indexOf(r.version) >= 0) return skip('Bad or revoked version');
          if (launcher.status().playing) { deferred = true; return finish(); }
          get(r.base + '/' + m.archive.name, m.archive.size, function (err, archive) {
            if (err) return failed(err);
            try { launcher.install(raw, sig, archive); } catch (e) { return failed(e); }
            installed = true;
            finish();
          });
        });
      });
    }
    if (st.source) {
      // A local test source (development builds only): one release, notes inside the signed manifest.
      var base = String(st.source).replace(/\/$/, '');
      return get(base + '/bundle.json', 1048576, function (err, raw) {
        if (err) return finish(err);
        var m;
        try { m = JSON.parse(raw.toString('utf8')); } catch (e) { return finish(new Error('Invalid manifest')); }
        if (!m || !version(m.version)) return finish(new Error('Invalid version'));
        releases = [{ version: m.version, notes: '' }];   // its notes come from verify() below
        walk([{ version: m.version, base: base }], 0);
      });
    }
    (function page(n, all) {
      get('https://api.github.com/repos/' + REPO + '/releases?per_page=' + PAGE + '&page=' + n, 2097152, function (err, body, unverified) {
        if (err) return finish(err);
        if (unverified) notesUnverified = true;
        var got;
        try { got = JSON.parse(body.toString('utf8')); } catch (e) { return finish(new Error('Invalid releases')); }
        if (!Array.isArray(got)) return finish(new Error('Invalid releases'));
        all = all.concat(got);
        if (got.length >= PAGE && n < MAX_PAGES) return page(n + 1, all);
        var list = all.filter(function (r) {
          return r && !r.draft && (st.channel === 'prerelease' || r.prerelease === false) && version(String(r.tag_name || '').replace(/^v/, ''));
        }).map(function (r) {
          var v = String(r.tag_name).replace(/^v/, ''), names = (r.assets || []).map(function (a) { return a && a.name; });
          var complete = ['bundle.json', 'bundle.json.sig', 'bundle-' + v + '.tar'].every(function (x) { return names.indexOf(x) >= 0; });
          return { version: v, base: complete ? 'https://github.com/' + REPO + '/releases/download/' + r.tag_name : null,
            // GitHub's text, not signed: dropped when the connection couldn't be verified.
            notes: notesUnverified ? '' : String(r.body || '').slice(0, 16000) };
        }).sort(function (a, b) { return compare(b.version, a.version); });
        if (!list.length) return finish(new Error('No releases'));
        releases = list.map(function (r) { return { version: r.version, notes: r.notes }; });
        walk(list, 0);
      });
    })(1, []);
  }

  // Every 5 minutes: check once the last check (this one's or the shell's) is an hour old, or when a download put
  // off by playback can go ahead.
  function tick() {
    var st = launcher.status(), t = now();
    if (!st.updates || st.playing || busy) return;
    if (st.deferred || !st.lastCheck || t < st.lastCheck || t - st.lastCheck >= HOUR) check();
  }
  return {
    check: check, tick: tick,
    start: function () { if (!timer) timer = setInterval(function () { try { tick(); } catch (e) { /* next tick */ } }, TICK); },
    // A stopped downloader (this version was switched off) ignores whatever its running downloads bring.
    stop: function () { stopped = true; clearInterval(timer); timer = null; }
  };
}

module.exports = { create: create, download: download, untrustedCertificate: untrustedCertificate };
