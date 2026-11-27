/* Update status for the app: from the launcher's shell when installed, else from GitHub (at most hourly). Also remembers how this version was installed. */
var Updates = (function () {
  var REPO = 'nicbra/f1tv-tizen';
  var KEY = 'f1tv.update';
  var INSTALL_KEY = 'f1tv.install';
  // Test versions (prereleases) on this TV: 'prerelease' or 'stable', chosen on the Version page. Kept here (it survives
  // bundle updates) and told to the bundle's downloader (app/service/updates.js) at each check: no shell change, so
  // every launcher TV can use it after a normal update. Unset: the package's channel. A package built for prereleases
  // (F1TV-staging.wgt, until v1.2.1) takes them whatever is chosen: its shell checks for them at every start  (fixed()).
  var CHANNEL_KEY = 'f1tv.channel', HELPER = 'http://127.0.0.1:18765';
  var HOUR = 3600000;
  var pending = null;

  function current() {
    if (typeof Launcher !== 'undefined' && Launcher.version) return Launcher.version;
    return installedVersion();
  }

  function installedVersion() {
    try { return tizen.application.getCurrentApplication().appInfo.version; } catch (e) { return ''; }
  }

  function plain(v) { return String(v || '').replace(/^v/, ''); }

  function installedBy() {
    try {
      var entry = JSON.parse(localStorage.getItem(INSTALL_KEY));
      if (entry && entry.by === 'installer' && entry.version === installedVersion() && installedVersion()) return 'installer';
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
          if (xhr.status === 200 && marker && marker.installedBy === 'installer' && marker.version === installedVersion() && installedVersion()) {
            // A label only: any app on the TV can write this shared file, so nothing it says changes what the TV runs
            // (test versions are only turned on on the Version page).
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
    var downloaded = c.downloaded && newer(c.downloaded, current()) ? c.downloaded : null;
    return { current: current(), latest: plain(c.latest), available: available, page: 'https://github.com/' + REPO,
      releases: releases, needsReinstall: c.needsReinstall, downloaded: downloaded, channel: channel(), channelFixed: fixed() };
  }

  /** Whether the package itself takes test versions (F1TV-staging.wgt): then they can't be turned off here. */
  function fixed() { return typeof Launcher !== 'undefined' && Launcher.channel === 'prerelease'; }

  /** The releases this TV takes: the choice made here, else its package's (F1TV-staging.wgt installs: prerelease). */
  function channel() {
    if (fixed()) return 'prerelease';
    var chosen = null;
    try { chosen = localStorage.getItem(CHANNEL_KEY); } catch (e) { /* storage disabled */ }
    if (chosen === 'prerelease' || chosen === 'stable') return chosen;
    return typeof Launcher !== 'undefined' && Launcher.channel === 'prerelease' ? 'prerelease' : 'stable';
  }

  /** Tells the bundle's downloader which releases to take. Never rejects (the next check tells it again). */
  function tellDownloader() {
    if (typeof Launcher === 'undefined') return Promise.resolve();
    try {
      return fetch(HELPER + '/updates/channel?name=' + channel(), { method: 'POST' }).then(function () {}, function () {});
    } catch (e) { return Promise.resolve(); }
  }

  /** Test versions on ('prerelease') or off ('stable'): kept, told to the downloader, and the next check asks again. */
  function setChannel(name) {
    try { localStorage.setItem(CHANNEL_KEY, name === 'prerelease' ? 'prerelease' : 'stable'); } catch (e) { /* storage disabled */ }
    var c = load();
    delete c.at;
    save(c);
    return tellDownloader();
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

  /**
   * With the launcher: asks the shell what is known (local; the bundle's downloader checks hourly, the shell at each
   * start), and when forced first runs the bundle's downloader. Without it: GitHub, at most hourly unless forced.
   * Never rejects; failures include error: true.
   */
  function check(force) {
    if (typeof Launcher !== 'undefined' && !Launcher.updates) return Promise.resolve(status());
    if (pending) return pending;
    var c = load();
    var usingLauncher = typeof Launcher !== 'undefined';
    if (!usingLauncher && !force && c.at && Date.now() >= c.at && Date.now() - c.at < HOUR) return Promise.resolve(status());
    var timer;
    var timeout = new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error('timeout')); }, typeof Launcher !== 'undefined' ? 300000 : 15000); });
    var launcherResult = null;
    // With the launcher: a forced check runs this bundle's downloader (app/service/updates.js); either way the shell
    // then says what is known (releases, downloads), without going online itself.
    // A manual check whose downloader failed (or couldn't be reached) is a failure, even when the shell still has
    // an older good answer.
    var helper = HELPER, manualFailed = false;
    // The downloader first learns this TV's channel (a restarted helper forgets it).
    var request = usingLauncher ? tellDownloader().then(function () { return force ? fetch(helper + '/updates/check', { method: 'POST' })
      .then(function (r) { if (!r.ok) manualFailed = true; }, function () { manualFailed = true; }) : null; })
      .then(function () { return fetch(helper + '/launcher/check?cached=1', { method: 'POST' }); })
      .then(function (r) { if (!r.ok) throw new Error('Launcher check failed'); return r.json(); })
      .then(function (r) {
        launcherResult = r;
        return (r.releases || []).map(function (j) { return { tag_name: j.version, body: j.notes, minShell: j.minShell }; });
      }) : releasesPage(1);
    pending = Promise.race([request, timeout])
      .then(function (list) {
        var releases = list.filter(function (j) {
          return j && !j.draft && !j.prerelease && typeof j.tag_name === 'string' && /^v?\d+\.\d+\.\d+$/.test(j.tag_name);
        }).map(function (j) { return { version: plain(j.tag_name), notes: notes(j.body), minShell: j.minShell }; });
        releases.sort(function (a, b) { return newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0; });
        if (!releases.length) throw new Error('Invalid releases');
        c = load();
        c.latest = releases[0].version;
        c.releases = releases;
        if (launcherResult) {
          c.needsReinstall = launcherResult.needsReinstall;
          c.downloaded = launcherResult.downloaded;
        }
        c.at = Date.now();
        save(c);
        var result = status();
        if (manualFailed) result.error = true;
        return result;
      })
      .catch(function () {
        if (typeof DiagUpload !== 'undefined') DiagUpload.apiFailed('update_check', null, 0);
        c = load();
        c.at = Date.now();   // failed (the network not up yet, say): try again in an hour
        save(c);
        var result = status();
        result.error = true;
        return result;
      })
      .then(function (result) { clearTimeout(timer); pending = null; return result; });
    return pending;
  }


  function once(kind, version) {
    if (!version) return false;
    var c = load(), key = kind + ':' + version;
    c.seen = c.seen || {};
    if (c.seen[key]) return false;
    c.seen[key] = true; save(c); return true;
  }

  function attemptApply(version) {
    var c = load();
    if (!newer(version, current()) || c.applyAttempt === version) return false;
    c.applyAttempt = version; save(c); return true;
  }

  readInstallSource();
  return { check: check, status: status, installedBy: installedBy, newer: newer, once: once, attemptApply: attemptApply, setChannel: setChannel };
})();
