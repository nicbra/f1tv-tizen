/* ES5 boot page. Never navigates away from file://: bundle markup lives inside this document. */
(function () {
  'use strict';
  var common = LauncherCommon, config = LauncherConfig, build = LauncherBuild;
  var shellBase = location.href.replace(/[^/]*$/, ''), builtinBase = shellBase + '../builtin/';
  var api = 'http://127.0.0.1:18765', storageKey = 'f1tv.launcher', state = {}, timer, booted = false, failed = false, selected;
  try { state = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch (e) { /* fresh */ }
  state = common.normalize(state);
  var sources = {}, scriptsStarted = false;
  function save() { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (e) { /* disabled storage */ } }
  function request(url, method, binary, done) {
    var x = new XMLHttpRequest(), finished = false;
    function finish(err, value) { if (finished) return; finished = true; done(err, value); }
    try { x.open(method || 'GET', url, true); x.timeout = 8000;
      if (binary) x.responseType = 'arraybuffer';
    } catch (e) { return finish(e); }
    x.onload = function () {
      if (x.status !== 200 && !(x.status === 0 && url.indexOf('file:') === 0)) return finish(new Error('HTTP ' + x.status));
      finish(null, binary ? new Uint8Array(x.response) : x.responseText);
    };
    x.onerror = x.ontimeout = function () { finish(new Error('Read failed')); };
    try { x.send(); } catch (e) { finish(e); }
  }
  function mark(reason) {
    if (booted || failed || !selected) return;
    failed = true; clearTimeout(timer);
    reason = typeof reason === 'string' ? reason : 'script error';
    common.fail(state, selected.manifest.version, reason);
    state.fallback = selected.manifest.version; save();
    request(api + '/launcher/mark?version=' + selected.manifest.version + '&reason=' + encodeURIComponent(reason), 'POST', false, function () { location.reload(); });
  }
  window.Launcher = {
    version: '', shellLevel: config.SHELL_LEVEL, updates: !!build.updates, channel: build.channel || 'stable',
    ready: function () {
      if (booted || failed || !selected) return;
      booted = true; clearTimeout(timer);
      common.ready(state, selected.manifest.version); save();
      request(api + '/launcher/ready?version=' + selected.manifest.version, 'POST', false, function () {});
    },
    restart: function () { location.reload(); },
    // A full restart: the service opens the app again once it has closed (shell/service.js relaunch); anything
    // missing on the way falls back to a page reload.
    relaunch: function () {
      request(api + '/launcher/relaunch', 'POST', false, function (err) {
        if (err) return location.reload();
        // If the app is still here after 3 s, closing didn't work: reload instead (the service's restart then only
        // brings this page to the front).
        setTimeout(function () { location.reload(); }, 3000);
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { location.reload(); }
      });
    },
    playback: function (active) { request(api + '/launcher/playback?active=' + (active ? '1' : '0'), 'POST', false, function () {}); },
    setUpdates: function (enabled) { request(api + '/launcher/settings?updates=' + (enabled ? '1' : '0'), 'POST', false, function () {}); },
    /*
     * Any file of the running bundle as bytes, checked against its signed manifest: done(err, Uint8Array). For what a
     * bundle loads after its start (WebAssembly, more scripts, a worker's own files). The built-in comes from the
     * signed package itself.
     */
    file: function (relative, done) {
      var b = selected;
      if (!b || !window.Launcher.base) return done(new Error('Bundle not started'));
      if (b.builtin) {
        if (!common.safePath(relative)) return done(new Error('Unsafe path'));
        return request(window.Launcher.base + relative, 'GET', true, done);
      }
      verifiedBytes(b, window.Launcher.base, relative, done);
    },
    // Workers only receive source authenticated during boot.
    worker: function (relative) {
      var u = window.Launcher.base + relative;
      if (/^http:/.test(u)) {
        if (!Object.prototype.hasOwnProperty.call(sources, relative)) throw new Error('Unverified worker');
        var blob = URL.createObjectURL(new Blob([sources[relative] + '\n//# sourceURL=' + u], { type: 'application/javascript' }));
        // Not revoked: older engines read the Blob after the constructor returns. Two workers, tiny leak.
        return new Worker(blob);
      }
      return new Worker(u);
    }
  };
  function startService(whenFound) {
    // One answer within 8 s at most: a launch that never calls back must not keep the 30 s start watch from arming.
    var answered = false, deadline = setTimeout(function () { done(null); }, 8000);
    function done(info) { if (answered) return; answered = true; clearTimeout(deadline); whenFound(info); }
    request(api + '/launcher/info?start=1&retry=' + (state.fallback ? '0' : '1'), 'GET', false, function (err, body) {
      if (!err) { try { return done(JSON.parse(body)); } catch (e) { /* launch */ } }
      try {
        var pkg = tizen.application.getCurrentApplication().appInfo.packageId;
        tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'), pkg + '.Helper', wait, function () { done(null); });
      } catch (e) { done(null); }
      function wait() {
        var tries = 0;
        function poll() { request(api + '/launcher/info?start=1&retry=' + (state.fallback ? '0' : '1'), 'GET', false, function (err, body) {
          if (!err) { try { return done(JSON.parse(body)); } catch (e) { /* retry */ } }
          if (++tries < 12) setTimeout(poll, 250); else done(null);
        }); }
        poll();
      }
    });
  }
  function recover(e) {
    if (scriptsStarted || (selected && selected.builtin)) return mark();
    clearTimeout(timer); failed = false; sources = {};
    load({ builtin: true, manifest: LauncherBuiltin.manifest }, builtinBase);
  }
  function guard(fn) { return function () { try { return fn.apply(null, arguments); } catch (e) { recover(e); } }; }
  // UTF-8 bytes to text. The escape fallback took 1.3 s for 1 MB of scripts on a 2021 TV; TextDecoder is
  // in Chromium 38+, so the fallback only runs on engines older than any supported TV.
  function text(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    var encoded = '', i;
    for (i = 0; i < bytes.length; i++) encoded += '%' + ('0' + bytes[i].toString(16)).slice(-2);
    return decodeURIComponent(encoded);
  }
  // SHA-512 as hex: WebCrypto where it works, else TweetNaCl.
  function sha512(bytes, done) {
    var called = false;
    function once(hash) { if (!called) { called = true; done(hash); } }
    function fallback() { once(common.hash(bytes)); }
    try {
      if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
        window.crypto.subtle.digest('SHA-512', bytes).then(function (result) {
          var hash = '', data = new Uint8Array(result), i;
          for (i = 0; i < data.length; i++) hash += ('0' + data[i].toString(16)).slice(-2);
          once(hash);
        }, fallback);
        return;
      }
    } catch (e) { /* older engines may expose an unusable digest */ }
    fallback();
  }
  // A file of a downloaded bundle, read as bytes and checked against its signed manifest entry: done(err, bytes).
  function verifiedBytes(b, base, relative, done) {
    if (!common.safePath(relative) || !Object.prototype.hasOwnProperty.call(b.manifest.files, relative)) return done(new Error('Unsigned file'));
    var entry = b.manifest.files[relative];
    request(base + relative, 'GET', true, function (err, bytes) {
      if (err) return done(err);
      if (bytes.length !== entry.size) return done(new Error('File size mismatch'));
      sha512(bytes, function (hash) { if (hash !== entry.sha512) done(new Error('File hash mismatch')); else done(null, bytes); });
    });
  }
  function verifiedSource(b, base, relative, done) {
    if (Object.prototype.hasOwnProperty.call(sources, relative)) return done(null, sources[relative]);
    verifiedBytes(b, base, relative, guard(function (err, bytes) {
      if (err) return done(err);
      try { sources[relative] = text(bytes); } catch (e) { return done(e); }
      done(null, sources[relative]);
    }));
  }
  function load(b, base) {
    selected = b;
    if (!common.begin(state, b.manifest.version, b.builtin)) {
      state.fallback = b.manifest.version; save();
      request(api + '/launcher/mark?version=' + b.manifest.version, 'POST', false, function () { location.reload(); });
      return;
    }
    save();
    window.Launcher.version = b.manifest.version; window.Launcher.base = base;
    // Which signed release build this is (the diagnostics upload names it; the server checks it against GitHub).
    var archive = b.manifest.archive && b.manifest.archive.sha512;
    window.Launcher.archiveSha512 = /^[a-f0-9]{128}$/.test(archive || '') ? archive : null;
    timer = setTimeout(function () { mark('start timeout'); }, 30000);
    function read(relative, done) {
      if (b.builtin) request(base + relative, 'GET', false, done);
      else verifiedSource(b, base, relative, done);
    }
    read('index.html', guard(function (err, html) {
      if (err) return mark('load failure');
      var parsed = new DOMParser().parseFromString(html, 'text/html'), scripts = parsed.querySelectorAll('script'), queue = [], i;
      for (i = 0; i < scripts.length; i++) {
        var src = scripts[i].getAttribute('src');
        if (src && src.indexOf('$WEBAPIS') !== 0) queue.push(src);
        scripts[i].parentNode.removeChild(scripts[i]);
      }
      var pending = b.builtin ? [] : queue.concat(Object.keys(b.manifest.files).filter(function (p) { return /^js\/.*worker.*\.js$/.test(p); }));
      function prepare() {
        if (failed) return;
        if (pending.length) return read(pending.shift(), guard(function (err) { if (err) return mark('load failure'); prepare(); }));
        var baseEl = document.createElement('base'); baseEl.href = base; document.head.insertBefore(baseEl, document.head.firstChild);
        var styles = parsed.querySelectorAll('link[rel="stylesheet"]');
        for (i = 0; i < styles.length; i++) document.head.appendChild(document.importNode(styles[i], true));
        document.body.removeAttribute('style'); document.body.innerHTML = parsed.body.innerHTML;
        function next() {
          if (failed || !queue.length) return;
          var relative = queue.shift(), script = document.createElement('script'); script.async = false;
          script.onerror = mark;
          if (b.builtin) { script.src = base + relative; script.onload = guard(next); }
          else script.text = sources[relative] + '\n//# sourceURL=' + base + relative;
          scriptsStarted = true;
          document.body.appendChild(script);
          if (!b.builtin) next();
        }
        // Match the service before app.js runs.
        request(api + '/launcher/restart?version=' + b.manifest.version, 'POST', false, guard(function (err) {
          if (err && !b.builtin) return mark('helper failure'); window.Launcher.playback(false); next();
        }));
      }
      prepare();
    }));
  }
  startService(guard(function (info) {
    var list = [{ builtin: true, manifest: LauncherBuiltin.manifest }];
    if (info) {
      var trusted = {}, k;
      for (k in config.keys) trusted[k] = config.keys[k];
      if (build.source) for (k in build.keys || {}) trusted[k] = build.keys[k];
      info.installed.forEach(function (b) {
        if (b.builtin || !build.updates) return;
        try { list.push({ manifest: common.verify(b.raw, b.signature, trusted) }); } catch (e) { /* reject */ }
      });
      var serviceState = common.normalize(info.state), versions = list.map(function (b) { return b.manifest.version; });
      if (!state.good && versions.indexOf(serviceState.good) >= 0) state.good = serviceState.good;
      versions.forEach(function (v) {
        // Both processes may observe the same interrupted page; begin() counts it locally once.
        if (!(state.boot && state.boot.version === v && !state.boot.failed))
          state.failures[v] = Math.max(state.failures[v] || 0, serviceState.failures[v] || 0);
        if (serviceState.bad[v]) state.bad[v] = serviceState.bad[v];
        // Revokes the service learned from manifests this page never sees (e.g. a release that needs a reinstall).
        if (serviceState.revokes.indexOf(v) >= 0 && state.revokes.indexOf(v) < 0) state.revokes.push(v);
      });
    }
    list.forEach(function (b) { b.manifest.revokes.forEach(function (v) { if (state.revokes.indexOf(v) < 0) state.revokes.push(v); }); });
    // A failure reload consumes this marker once. A real subsequent start retries the candidate.
    var fallback = state.fallback || (info && info.failedThisStart && info.failedThisStart[0]);
    delete state.fallback; save();
    window.Launcher.blockedUpdates = Object.keys(state.bad).concat(state.revokes, fallback ? [fallback] : []);
    var b;
    if (fallback) {
      b = common.select(list.filter(function (item) { return item.manifest.version !== fallback && item.manifest.version === state.good; }), config.SHELL_LEVEL, state);
      if (!b) b = list[0];
    } else b = common.select(list, config.SHELL_LEVEL, state);
    load(b, b.builtin ? builtinBase : api + '/bundle/' + b.manifest.version + '/');
  }));
  window.addEventListener('error', function (e) { if (e && e.filename) mark('script error'); });
})();
