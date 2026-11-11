/* Checks GitHub releases daily or on demand, and remembers how this version was installed. */
var Updates = (function () {
  var REPO = 'nicbra/f1tv-tizen';
  var KEY = 'f1tv.update';
  var INSTALL_KEY = 'f1tv.install';
  var DAY = 86400000;
  var pending = null;

  function current() {
    try { return tizen.application.getCurrentApplication().appInfo.version; } catch (e) { return ''; }
  }

  function plain(v) { return String(v || '').replace(/^v/, ''); }

  function installedBy() {
    try {
      var entry = JSON.parse(localStorage.getItem(INSTALL_KEY));
      if (entry && entry.by === 'installer' && entry.version === current() && current()) return 'installer';
    } catch (e) { /* no remembered install */ }
    return 'apps2samsung';
  }

  function readInstallSource() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'file:///home/owner/share/tmp/sdk_tools/tmp/f1tv-installed.json', true);
      xhr.timeout = 5000;
      xhr.onload = function () {
        try {
          var marker = JSON.parse(xhr.responseText);
          if (xhr.status === 200 && marker && marker.installedBy === 'installer' && marker.version === current() && current()) {
            localStorage.setItem(INSTALL_KEY, JSON.stringify({ by: 'installer', version: marker.version }));
          }
        } catch (e) { /* missing or malformed marker, or storage disabled */ }
      };
      xhr.send();
    } catch (e) { /* the marker is optional */ }
  }

  /** Numeric version comparison: 0.10.0 > 0.9.2. */
  function newer(a, b) {
    var x = plain(a).split('.'), y = plain(b).split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (+x[i] || 0) - (+y[i] || 0);
      if (d) return d > 0;
    }
    return false;
  }

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* storage disabled */ } }

  /** Light Markdown cleanup, keeping paragraphs and bullets readable on the TV. */
  function notes(body) {
    var text = String(body || '').replace(/\r/g, '').replace(/^[ \t]*```[^\n]*$/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '').replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]*)/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '• ')
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
      .replace(/[*_`~]/g, '').replace(/[ \t]+/g, ' ').replace(/^ +| +$/gm, '')
      .replace(/\n{3,}/g, '\n\n').trim();
    return text.length > 4000 ? text.slice(0, 3999).trim() + '…' : text;
  }

  /** What is known without asking GitHub: { current, latest, available, page, releases }. */
  function status() {
    var c = load();
    var available = !!c.latest && !!current() && newer(c.latest, current());
    var releases = (Array.isArray(c.releases) ? c.releases : []).filter(function (r) {
      return r && typeof r.version === 'string';
    }).sort(function (a, b) { return newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0; });
    return { current: current(), latest: plain(c.latest), available: available, page: 'https://github.com/' + REPO,
      releases: releases };
  }

  function releasesPage(page) {
    return fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=100&page=' + page,
      { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list)) throw new Error('Invalid releases');
        if (list.length < 100) return list;
        return releasesPage(page + 1).then(function (rest) { return list.concat(rest); });
      });
  }

  /** Refreshes daily, or immediately when forced. Never rejects; failures include error: true. */
  function check(force) {
    if (pending) return pending;
    var c = load();
    if (!force && c.at && Date.now() - c.at < DAY) return Promise.resolve(status());
    var timer;
    var timeout = new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error('timeout')); }, 15000); });
    var request = releasesPage(1);
    pending = Promise.race([request, timeout])
      .then(function (list) {
        var releases = list.filter(function (j) {
          return j && !j.draft && !j.prerelease && typeof j.tag_name === 'string' && /^v?\d+\.\d+\.\d+$/.test(j.tag_name);
        }).map(function (j) { return { version: plain(j.tag_name), notes: notes(j.body) }; });
        releases.sort(function (a, b) { return newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0; });
        if (!releases.length) throw new Error('Invalid releases');
        c = load();
        c.latest = releases[0].version;
        c.releases = releases;
        c.at = Date.now();
        save(c);
        return status();
      })
      .catch(function () {
        c = load();
        c.at = Date.now() - DAY + 3600000;   // failed (the network not up yet, say): try again in an hour
        save(c);
        var result = status();
        result.error = true;
        return result;
      })
      .then(function (result) { clearTimeout(timer); pending = null; return result; });
    return pending;
  }

    /** Whether to show the update notice now: once a day (the TV's local date) while an update is waiting. */
  function noticeToday() {
    var c = load(), day = new Date().toDateString();
    if (c.noticedDay === day) return false;
    c.noticedDay = day;
    save(c);
    return true;
  }

  readInstallSource();
  return { check: check, status: status, noticeToday: noticeToday, installedBy: installedBy, newer: newer };
})();
