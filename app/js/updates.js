/*
 * Looks for a newer release on GitHub, daily or on demand. The app can't update itself (Tizen
 * doesn't let apps install packages); updates are installed from a computer by running the
 * installer again (scripts/install.sh or install.ps1), which keeps the sign-in.
 */
var Updates = (function () {
  var REPO = 'nicbra/f1tv-tizen';   // GitHub repository hosting the release packages
  var KEY = 'f1tv.update';
  var DAY = 86400000;
  var pending = null;

  function current() {
    try { return tizen.application.getCurrentApplication().appInfo.version; } catch (e) { return ''; }
  }

  function plain(v) { return String(v || '').replace(/^v/, ''); }

  /** True when dotted version a is newer than b ("0.10.0" > "0.9.2"). */
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

  /** What is known without asking GitHub: { current, latest, available, page }. */
  function status() {
    var c = load();
    var available = !!c.latest && !!current() && newer(c.latest, current());
    return { current: current(), latest: plain(c.latest), available: available, page: 'https://github.com/' + REPO };
  }

  /** Refreshes daily, or immediately when forced. Never rejects; failures include error: true. */
  function check(force) {
    if (pending) return pending;
    var c = load();
    if (/^YOUR-/.test(REPO) || (!force && c.at && Date.now() - c.at < DAY)) return Promise.resolve(status());
    var timer;
    var timeout = new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error('timeout')); }, 15000); });
    var request = fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    pending = Promise.race([request, timeout])
      .then(function (j) {
        if (!j || typeof j.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(j.tag_name)) throw new Error('Invalid release');
        c = load();
        c.latest = j.tag_name;
        c.at = Date.now();
        save(c);
        return status();
      })
      .catch(function () {
        c = load();
        c.at = Date.now();
        save(c);
        var result = status();
        result.error = true;
        return result;
      })
      .then(function (result) { clearTimeout(timer); pending = null; return result; });
    return pending;
  }

  /** True the first time it is called for a given new version (so the toast shows once). */
  function firstNotice(version) {
    var c = load();
    if (c.noticed === version) return false;
    c.noticed = version;
    save(c);
    return true;
  }

  return { check: check, status: status, firstNotice: firstNotice };
})();
