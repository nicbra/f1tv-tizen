/* Fixed updater. No downloaded code runs until its complete signed file set has been checked. */
'use strict';
var fs = require('fs');
var path = require('path');
var common = require('./common');
var crypto = null, zlib = null, https = null, http = null;
try { crypto = require('crypto'); } catch (e) { /* nacl fallback */ }
try { zlib = require('zlib'); } catch (e) { /* format 1 needs no compression */ }
try { https = require('https'); } catch (e) { /* report unavailable */ }
try { http = require('http'); } catch (e) { /* report unavailable */ }
function buffer(s, enc) { return Buffer.from ? Buffer.from(s, enc) : new Buffer(s, enc); }
function sha(b) {
  try { if (crypto && crypto.createHash) return crypto.createHash('sha512').update(b).digest('hex'); } catch (e) { /* missing hash implementation */ }
  return common.hash(b);
}
function mkdir(p) { if (fs.existsSync(p)) return; mkdir(path.dirname(p)); fs.mkdirSync(p); }
function remove(p) {
  if (!fs.existsSync(p)) return;
  if (fs.lstatSync(p).isDirectory()) { fs.readdirSync(p).forEach(function (f) { remove(path.join(p, f)); }); fs.rmdirSync(p); }
  else fs.unlinkSync(p);
}
function atomic(p, value) { fs.writeFileSync(p + '.tmp', JSON.stringify(value)); fs.renameSync(p + '.tmp', p); }
function json(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }
function keys(config, build) {
  var out = {}, k;
  for (k in config.keys) if (Object.prototype.hasOwnProperty.call(config.keys, k)) out[k] = config.keys[k];
  // Extra keys only exist in a locally assembled development override.
  if (build.source) for (k in build.keys || {}) if (Object.prototype.hasOwnProperty.call(build.keys, k)) out[k] = build.keys[k];
  return out;
}
function parseUrl(u) {
  var m = /^(https?):\/\/([^\/\s?#]+)(\/[^#]*)?$/.exec(u);
  if (!m || /@/.test(m[2])) throw new Error('Invalid URL');
  return { protocol: m[1] + ':', host: m[2], path: m[3] || '/' };
}
function redirect(base, target) {
  if (/^https?:\/\//.test(target)) return target;
  var u = parseUrl(base);
  if (target.indexOf('//') === 0) return u.protocol + target;
  return u.protocol + '//' + u.host + (target.charAt(0) === '/' ? target : u.path.replace(/[^\/]*$/, '') + target);
}
/*
 * A certificate this TV's Node can't check: authority missing from its 2019 list, expired, not yet valid (a wrong TV
 * clock), another name. What arrives is checked against the signed manifest anyway, so such a connection is retried
 * unverified rather than ending updates for good. The caller learns it (third callback argument).
 */
function untrustedCertificate(e) { return !!e && /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(String(e.code || '')); }
/* Bounded even without Content-Length; one deadline covers all redirects: 60 s plus the limit at 32 kB/s. */
function download(target, limit, cb, allowHttp) {
  var done = false, current, unverified = false, timer = setTimeout(function () { finish(new Error('Download timeout')); if (current) current.abort(); }, 60000 + Math.round(limit / 32));
  function finish(err, b) { if (done) return; done = true; clearTimeout(timer); cb(err, b, unverified); }
  function get(u, hops) {
    var parsed, lib;
    try {
      parsed = parseUrl(u);
      if (parsed.protocol === 'http:' && !allowHttp) throw new Error('HTTPS required');
      lib = parsed.protocol === 'https:' ? https : http;
      if (!lib) throw new Error('Transport unavailable');
      var hp = parsed.host.split(':'), lax = unverified && parsed.protocol === 'https:';
      var opts = { hostname: hp[0], port: hp[1] || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.path, headers: { 'User-Agent': 'F1TV-launcher/1', Accept: hp[0].toLowerCase() === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } };
      if (lax) opts.rejectUnauthorized = false;
      current = lib.get(opts, function (res) {
        if (done) { res.resume(); return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops) {
          res.resume();
          try { get(redirect(u, res.headers.location), hops - 1); } catch (e) { finish(e); }
          return;
        }
        if (res.statusCode !== 200 || +res.headers['content-length'] > limit) { res.resume(); return finish(new Error('HTTP ' + res.statusCode + ' or size limit')); }
        var chunks = [], size = 0;
        res.on('data', function (b) { size += b.length; if (size > limit) { finish(new Error('Size limit')); current.abort(); } else chunks.push(b); });
        res.on('end', function () { finish(null, Buffer.concat(chunks)); });
        res.on('error', finish);
      });
      current.on('error', function (e) {
        if (!done && !lax && parsed.protocol === 'https:' && untrustedCertificate(e)) { unverified = true; return get(u, hops); }
        finish(e);
      });
    } catch (e) { finish(e); }
  }
  get(target, 5);
}
/* Format 1 is plain USTAR, regular files only. No links, PAX, devices, duplicate paths or implicit files. */
function unpack(archive, dir, manifest) {
  var pos = 0, seen = {}, total = 0, ended = false;
  function field(block, a, b) { return block.slice(a, b).toString('utf8').replace(/\0.*$/, ''); }
  function oct(s) { if (!/^[0-7]+$/.test(s.trim())) throw new Error('Invalid tar number'); return parseInt(s.trim(), 8); }
  while (pos + 512 <= archive.length) {
    var block = archive.slice(pos, pos + 512), i, sum = 0;
    if (block.every ? block.every(function (b) { return b === 0; }) : /^\x00+$/.test(block.toString('binary'))) { ended = true; break; }
    for (i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
    if (sum !== oct(field(block, 148, 156))) throw new Error('Invalid tar checksum');
    var name = field(block, 0, 100), prefix = field(block, 345, 500), type = block[156];
    if (prefix) name = prefix + '/' + name;
    var size = oct(field(block, 124, 136));
    if (!common.safePath(name) || (type !== 0 && type !== 48) || seen[name] || !Object.prototype.hasOwnProperty.call(manifest.files, name)) throw new Error('Unsafe archive entry: ' + name);
    if (size !== manifest.files[name].size || pos + 512 + size > archive.length) throw new Error('Invalid archive size');
    total += size;
    if (total > 67108864) throw new Error('Expanded size limit');
    var body = archive.slice(pos + 512, pos + 512 + size);
    if (sha(body) !== manifest.files[name].sha512) throw new Error('File hash mismatch: ' + name);
    var dest = path.join(dir, name);
    mkdir(path.dirname(dest)); fs.writeFileSync(dest, body); seen[name] = true;
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || Object.keys(seen).length !== Object.keys(manifest.files).length) throw new Error('Incomplete archive');
  for (; pos < archive.length; pos++) if (archive[pos] !== 0) throw new Error('Trailing archive data');
}
function create(options) {
  var config = options.config, build = options.build || {}, root = options.root, builtin = options.builtin;
  var trusted = keys(config, build), candidates = [], data = null, active = builtin.manifest.version, busy = false, playing = false, lastUnverified = null;
  var folders = options.candidates || [];
  folders.forEach(function (p) {
    if (!p || candidates.some(function (c) { return c.path === p; })) return;
    var c = { path: p, writable: false };
    try { mkdir(p); var probe = path.join(p, '.launcher-probe'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); c.writable = true; if (!data) data = p; }
    catch (e) { c.error = String(e.message); }
    candidates.push(c);
  });
  var bundles = data && path.join(data, 'bundles'), stateFile = data && path.join(data, 'launcher-state.json');
  if (bundles) { try { mkdir(bundles); } catch (e) { bundles = null; } }
  var verificationCache = {};
  var state = normalize(common.normalize(stateFile ? json(stateFile, {}) : {}));
  /* The service's own fields, next to the shared start-up health ones. */
  function normalize(st) {
    var d = st.downloads, clean = {};
    if (d && typeof d === 'object') Object.keys(d).forEach(function (v) { if (common.version(v) && typeof d[v] === 'number' && isFinite(d[v])) clean[v] = d[v]; });
    st.downloads = clean;
    if (typeof st.lastCheck !== 'number' || !isFinite(st.lastCheck)) delete st.lastCheck;
    st.checkFailed = st.checkFailed === true; st.lastDeferred = st.lastDeferred === true;
    st.updates = st.updates !== false;
    st.events = (Array.isArray(st.events) ? st.events : []).filter(function (e) {
      return e && typeof e.id === 'number' && common.version(e.version) && typeof e.reason === 'string';
    }).slice(-20);
    st.eventSeq = typeof st.eventSeq === 'number' && isFinite(st.eventSeq) ? st.eventSeq : 0;
    return st;
  }
  /*
   * A version that failed a start, kept until a running bundle reports it (it reads /launcher/info and acknowledges
   * with /launcher/ack): the latest twenty, so nothing grows without bound.
   */
  function event(version, reason) {
    state.events.push({ id: ++state.eventSeq, at: Date.now(), version: version, reason: String(reason || '').slice(0, 300) });
    if (state.events.length > 20) state.events.shift();
  }
  function ack(through) { state.events = state.events.filter(function (e) { return e.id > through; }); save(); }
  function save() { try { if (stateFile) atomic(stateFile, state); } catch (e) { /* keep in-memory state when storage is full */ } }
  function revoke(manifest) {
    var changed = false;
    manifest.revokes.forEach(function (v) { if (state.revokes.indexOf(v) < 0) { state.revokes.push(v); changed = true; } });
    if (changed) save();
  }
  function checkTree(dir, m) {
    function tree(folder, prefix) {
      fs.readdirSync(folder).forEach(function (name) {
        var rel = prefix + name, full = path.join(folder, name), stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error('Symlink');
        if (stat.isDirectory()) tree(full, rel + '/');
        else if (!stat.isFile() || (!Object.prototype.hasOwnProperty.call(m.files, rel) && rel !== 'bundle.json' && rel !== 'bundle.json.sig')) throw new Error('Unexpected installed file');
      });
    }
    tree(dir, '');
    Object.keys(m.files).forEach(function (p) {
      var full = path.join(dir, p), parts = p.split('/'), walk = dir;
      parts.forEach(function (part) { walk = path.join(walk, part); if (fs.lstatSync(walk).isSymbolicLink()) throw new Error('Symlink'); });
      var stat = fs.statSync(full);
      if (!stat.isFile() || stat.size !== m.files[p].size || sha(fs.readFileSync(full)) !== m.files[p].sha512) throw new Error('Installed hash mismatch');
    });
  }
  function verified(dir, v) {
    if (Object.prototype.hasOwnProperty.call(verificationCache, dir)) return verificationCache[dir];
    verificationCache[dir] = null;
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Symlink');
      var raw = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'), sig = fs.readFileSync(path.join(dir, 'bundle.json.sig'), 'utf8');
      var m = common.verify(raw, sig, trusted);
      if (m.version !== v) throw new Error('Version mismatch');
      checkTree(dir, m);
      verificationCache[dir] = { dir: dir, manifest: m, raw: raw, signature: sig, verified: true };
    } catch (e) { /* Cache failures too: retry only after install or a new service process. */ }
    return verificationCache[dir];
  }
  function installed() {
    var out = [{ builtin: true, dir: path.join(root, 'builtin'), manifest: builtin.manifest, verified: true }];
    if (bundles) fs.readdirSync(bundles).filter(common.version).forEach(function (v) {
      var b = verified(path.join(bundles, v), v);
      if (b) out.push(b);
    });
    out.forEach(function (b) { revoke(b.manifest); });
    return out;
  }
  function selected() { return common.select(installed().filter(function (b) { return build.updates || b.builtin; }), config.SHELL_LEVEL, state); }
  function cleanup(next) {
    if (!bundles) return;
    var list = installed().filter(function (b) { return !b.builtin; }).sort(function (a, b) { return common.compare(b.manifest.version, a.manifest.version); });
    // The newest eligible copy too: a slower install of an older version must never delete a newer download.
    var newest = common.select(list, config.SHELL_LEVEL, state);
    var keep = [active, next, state.good, newest && newest.manifest.version];
    // One older candidate remains for rollback even if the active service has already switched.
    var older = common.select(list.filter(function (b) { return common.compare(b.manifest.version, next || active || builtin.manifest.version) < 0; }), config.SHELL_LEVEL, state);
    if (older) keep.push(older.manifest.version);
    fs.readdirSync(bundles).forEach(function (v) {
      if (v.indexOf('.stage-') === 0 || (common.version(v) && keep.indexOf(v) < 0)) {
        var dir = path.join(bundles, v); remove(dir); delete verificationCache[dir]; delete state.downloads[v];
      }
    });
    save();
  }
  /*
   * Checks and installs one signed version (the shell's own check, and bundles through launcher.install). The
   * signature comes first, and a verified manifest's revokes always apply, also when it needs a newer shell.
   */
  function verifyManifest(raw, sig) {
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    if (Buffer.isBuffer(sig)) sig = sig.toString('utf8');
    var m = common.verify(String(raw), String(sig), trusted);
    revoke(m);
    return m;
  }
  function install(raw, sig, archive) {
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    if (Buffer.isBuffer(sig)) sig = sig.toString('utf8');
    var m = verifyManifest(raw, sig);
    if (m.minShell > config.SHELL_LEVEL) throw new Error('Needs reinstall');
    if (state.bad[m.version] || state.revokes.indexOf(m.version) >= 0) throw new Error('Bad or revoked version');
    if (!Buffer.isBuffer(archive)) throw new Error('No archive');
    if (!bundles) throw new Error('No writable data folder');
    if (archive.length !== m.archive.size || sha(archive) !== m.archive.sha512) throw new Error('Archive hash mismatch');
    var stage = path.join(bundles, '.stage-' + m.version), dest = path.join(bundles, m.version);
    remove(stage); mkdir(stage);
    try {
      unpack(archive, stage, m);
      fs.writeFileSync(path.join(stage, 'bundle.json'), raw); fs.writeFileSync(path.join(stage, 'bundle.json.sig'), sig);
      checkTree(stage, m);
      if (fs.existsSync(dest)) {
        delete verificationCache[dest];
        // Valid signed versions are immutable; repair only a corrupt, inactive destination.
        var existing = verified(dest, m.version);
        if (existing) {
          if (existing.raw !== raw) throw new Error('Version already exists');
          remove(stage);
        } else {
          if (active === m.version) throw new Error('Version already exists: active');
          remove(dest);
        }
      }
      if (!fs.existsSync(dest)) {
        fs.renameSync(stage, dest);
        delete verificationCache[dest];
        // Stage already passed signature, every file hash and tree checks.
        verificationCache[dest] = { dir: dest, manifest: m, raw: raw, signature: sig, verified: true };
        state.downloads[m.version] = Date.now(); save();
      }
    } catch (e) { try { remove(stage); } catch (ignored) { /* retry cleanup next start */ } throw e; }
    cleanup(m.version);
    return m;
  }
  function info() {
    return { node: process.version, modules: { fs: true, path: true, http: !!http, https: !!https, crypto: !!crypto, zlib: !!zlib },
      dataFolder: data, candidates: candidates, lastUnverifiedDownload: lastUnverified, shellLevel: config.SHELL_LEVEL, updates: !!build.updates, channel: build.channel || 'stable',
      activeService: active, playback: playing, activePage: state.page || null, state: state, releases: state.releases || [],
      installed: installed().map(function (b) { return { builtin: !!b.builtin, verified: b.verified, manifest: b.manifest, raw: b.raw, signature: b.signature,
        fileBase: 'file://' + b.dir + '/', httpBase: 'http://127.0.0.1:18765/bundle/' + b.manifest.version + '/' }; }) };
  }
  /* What the last check found plus what is installed now, without going online. */
  function status() {
    var result = { releases: Array.isArray(state.releases) ? state.releases : [], skipped: Array.isArray(state.skipped) ? state.skipped : [], needsReinstall: null, downloaded: null };
    result.releases.some(function (r) { if (r && r.minShell > config.SHELL_LEVEL) { result.needsReinstall = r.version; return true; } return false; });
    var b = common.select(installed().filter(function (item) {
      return !item.builtin && common.compare(item.manifest.version, active || builtin.manifest.version) > 0;
    }), config.SHELL_LEVEL, state);
    if (b) result.downloaded = b.manifest.version;
    return result;
  }
  /*
   * Online: the shell's own check, frozen with the shell. It runs at each app start (startCheck) and for the shell's
   * manual route; the bundle's downloader does the hourly checks. `cached` only answers what is known, never online.
   */
  function check(cached, cb) {
    if (typeof cached === 'function') { cb = cached; cached = false; }
    if (!build.updates) return cb(null, { disabled: true, releases: [] });
    if (cached) return state.checkFailed ? cb(new Error('The last update check failed')) : cb(null, status());
    if (busy) return cb(new Error('Update check already running'));
    busy = true; state.lastCheck = Date.now(); save();
    var finished = false;
    // failure: a release that couldn't be fetched makes the check a failure (so the next start tries again) unless
    // an update was installed anyway; a release that is merely broken is only skipped.
    var releases = [], skipped = [], picked = null, notesUnverified = false, failure = null;
    var base = build.source && build.source.replace(/\/$/, '');
    function get(u, size, done) {
      var called = false;
      try { (options.download || download)(u, size, function (err, value, unverified) {
        if (called || finished) return; called = true;
        if (unverified) lastUnverified = Date.now();
        try { done(err, value, !!unverified); } catch (e) { finish(e); }
      }, !!base); } catch (e) { finish(e); }
    }
    function finish(err, value) {
      if (finished) return; finished = true; busy = false;
      state.checkFailed = !!err; save(); cb(err, value);
    }
    function decision() {
      state.releases = releases; state.skipped = skipped;
      var latest = selected(), wanted = picked && !state.bad[picked.m.version] && state.revokes.indexOf(picked.m.version) < 0 &&
        !(latest && common.compare(latest.manifest.version, picked.m.version) >= 0);
      // Never an archive download during playback: put off, then the bundle's next check (or the next start) takes it.
      state.lastDeferred = !!(wanted && playing); save();
      function staged(installed) { finish(failure && !installed ? failure : null, status()); }
      if (!wanted || playing) return staged(false);
      get(picked.base + '/' + picked.m.archive.name, picked.m.archive.size, function (err, archive) {
        if (err) return finish(err);
        try { install(picked.raw, picked.sig, archive); staged(true); } catch (e) { finish(e); }
      });
    }
    function manifests(list, i, firstRaw) {
      if (i === list.length) return decision();
      var r = list[i], source = base || 'https://github.com/' + config.repo + '/releases/download/' + r.tag_name;
      function skip(reason) { skipped.push({ version: r.version, reason: String(reason.message || reason) }); manifests(list, i + 1); }
      if (!base && !['bundle.json', 'bundle.json.sig', 'bundle-' + r.version + '.tar'].every(function (name) {
        return (r.assets || []).some(function (asset) { return asset.name === name; });
      })) return skip('Missing bundle assets');
      function manifest(err, raw) {
        if (err) { failure = failure || err; return skip(err); }
        get(source + '/bundle.json.sig', 1024, function (err, sig) {
          var text, signature, m;
          if (err) { failure = failure || err; return skip(err); }
          try {
            text = raw.toString('utf8'); signature = sig.toString('utf8'); m = common.verify(text, signature, trusted);
            if (m.version !== r.version) throw new Error('Release version mismatch');
          } catch (e) { return skip(e); }
          revoke(m);
          releases[i].minShell = m.minShell;
          if (m.minShell > config.SHELL_LEVEL) return manifests(list, i + 1);
          var latest = selected();
          if (latest && common.compare(m.version, latest.manifest.version) <= 0) return decision();
          if (state.bad[m.version] || state.revokes.indexOf(m.version) >= 0) return skip('Bad or revoked version');
          picked = { m: m, raw: text, sig: signature, base: source };
          decision();
        });
      }
      if (firstRaw) manifest(null, firstRaw);
      else get(source + '/bundle.json', 1048576, manifest);
    }
    if (base) {
      get(base + '/bundle.json', 1048576, function (err, raw) {
        if (err) return finish(err);
        try {
          var m = JSON.parse(raw.toString('utf8'));
          if (!common.version(m.version)) throw new Error('Invalid version');
          releases = [{ version: m.version, notes: String(m.notes || '').slice(0, 16000) }];
        } catch (e) { state.skipped = [{ version: null, reason: String(e.message) }]; save(); return finish(e); }
        manifests(releases, 0, raw);
      });
    // 50 releases a page (each launcher release lists ~15-20 kB: seven assets with their uploader; 100 would near the
    // 2 MB bound). Every page up to five, until a short one: GitHub's order is by creation, not version, so no tag
    // shows that later pages hold nothing this TV may take (newer-shell releases or prereleases can hide it).
    } else (function page(n, all) {
      get('https://api.github.com/repos/' + config.repo + '/releases?per_page=50&page=' + n, 2097152, function (err, body, unverified) {
        if (err) return finish(err);
        if (unverified) notesUnverified = true;
        var got;
        try { got = JSON.parse(body.toString('utf8')); if (!Array.isArray(got)) throw new Error('Invalid releases'); } catch (e) { return finish(e); }
        all = all.concat(got);
        if (got.length >= 50 && n < 5) return page(n + 1, all);
        listed(all);
      });
    })(1, []);
    function listed(list) {
      try {
        list = list.filter(function (r) { return r && !r.draft && (build.channel === 'prerelease' || r.prerelease === false) && common.version(String(r.tag_name || '').replace(/^v/, '')); }).map(function (r) {
          // Notes are GitHub's text, not signed: from an unverified connection anyone between could have written them.
          return { tag_name: r.tag_name, version: r.tag_name.replace(/^v/, ''), notes: notesUnverified ? '' : String(r.body || '').slice(0, 16000), assets: r.assets };
        });
        list.sort(function (a, b) { return common.compare(b.version, a.version); });
        if (!list.length) throw new Error('No releases');
      } catch (e) { return finish(e); }
      releases = list.map(function (r) { return { version: r.version, notes: r.notes }; });
      manifests(list, 0);
    }
  }
  /*
   * At each app start: the safety net for a bundle whose own downloader broke. Skipped only when a check succeeded
   * in the last five minutes (a quick restart or a rollback reload); a clock set back makes it check, never stall.
   */
  function startCheck() {
    if (!build.updates || !state.updates || playing || busy) return;
    var age = Date.now() - state.lastCheck;
    if (state.lastCheck && !state.checkFailed && age >= 0 && age < 300000) return;
    check(function () {});
  }
  /* For the bundle's downloader (launcher.status): what it needs to decide, without going online. */
  function bundleStatus() {
    var latest = selected(), found = status();
    // enabled: updates possible in this build (manual checks); updates: automatic checks are on as well.
    return { shellLevel: config.SHELL_LEVEL, enabled: !!build.updates, updates: !!(build.updates && state.updates), channel: build.channel || 'stable',
      source: build.source || null, newest: latest ? latest.manifest.version : builtin.manifest.version, active: active,
      blocked: Object.keys(state.bad).concat(state.revokes), playing: playing, lastCheck: state.lastCheck || null,
      checkFailed: !!state.checkFailed, deferred: !!state.lastDeferred,
      releases: found.releases, skipped: found.skipped, needsReinstall: found.needsReinstall, downloaded: found.downloaded };
  }
  /* A bundle may drop a downloaded version (never the running one, the last confirmed one or the built-in). */
  function discard(v) {
    if (!common.version(v) || !bundles) throw new Error('Invalid version');
    if (v === active || v === state.good || v === state.page || v === builtin.manifest.version) throw new Error('Version in use');
    var dir = path.join(bundles, v);
    if (!fs.existsSync(dir)) return false;
    remove(dir); delete verificationCache[dir]; delete state.downloads[v]; save();
    return true;
  }
  /* The bundle's downloader reports each check (launcher.checked): one clock and one release list for both. */
  function checked(result) {
    result = result && typeof result === 'object' ? result : {};
    function list(value, fields) {
      return (Array.isArray(value) ? value : []).slice(0, 250).filter(function (r) { return r && common.version(r.version); }).map(function (r) {
        var out = { version: r.version };
        if (fields.notes) out.notes = String(r.notes || '').slice(0, 16000);
        if (fields.minShell && typeof r.minShell === 'number' && r.minShell % 1 === 0 && r.minShell > 0) out.minShell = r.minShell;
        if (fields.reason) out.reason = String(r.reason || '').slice(0, 300);
        return out;
      });
    }
    state.lastCheck = Date.now(); state.checkFailed = result.ok !== true; state.lastDeferred = result.ok === true && result.deferred === true;
    if (result.ok === true) { state.releases = list(result.releases, { notes: true, minShell: true }); state.skipped = list(result.skipped, { reason: true }); }
    save();
  }
  // Abandoned staging folders are safe to discard on service startup.
  if (bundles) fs.readdirSync(bundles).forEach(function (v) { if (v.indexOf('.stage-') === 0) { try { remove(path.join(bundles, v)); } catch (e) { /* retry later */ } } });
  return { info: info, event: event, ack: ack, startCheck: startCheck, bundleStatus: bundleStatus, checked: checked, status: status,
    verify: verifyManifest, discard: discard, installed: installed, selected: selected, install: install, check: check, cleanup: cleanup,
    bundle: function (v) { return installed().filter(function (b) { return b.manifest.version === v; }).sort(function (a, b) { return a.builtin ? -1 : 1; })[0]; },
    state: state, save: save, setPlayback: function (value) { playing = !!value; }, setActive: function (v) { active = v; }, checkTree: checkTree };
}
module.exports = { create: create, unpack: unpack, sha: sha, download: download, keys: keys, untrustedCertificate: untrustedCertificate };
