/* Tizen lifecycle entry. Owns the socket; delegates media requests and lifecycle to verified bundles. */
'use strict';
var fs = require('fs'), path = require('path'), http = require('http');
var config = require('./config'), build = require('../launcher-build'), common = require('./common');
var builtin = require('./builtin.json'), root = path.dirname(__dirname);
var server = null, delegate = null, active = null, activeDir = null, updater = null, starting = false, waiting = [], apiFolders = [], failed = {}, pageSeen = false;
var errors = { count: 0, last: [] }, guarded = false;
/*
 * Diagnostics only. Escaped exceptions never count against a version: one can't tell which version's callback threw
 * (an old one's may still run after a switch) or whether bad upstream data caused it, and the updater survives them,
 * so a fixed bundle still arrives. Failed starts and page failures remain what rolls a version back.
 */
function noteError(kind, e) {
  errors.count++;
  errors.last.push({ kind: kind, at: Date.now(), version: active, error: String((e && (e.stack || e.message)) || e).slice(0, 600) });
  if (errors.last.length > 10) errors.last.shift();
  try { console.log('launcher service ' + kind + ': ' + String((e && e.message) || e)); } catch (ignored) { /* no console */ }
}
/*
 * Bundle helper code runs in this process. An exception in one of its callbacks must not take the listener and the
 * updater (the way its fix arrives) down with it; newer Node versions also exit on an unhandled rejection. Kept
 * and shown in /launcher/info.
 */
function guardProcess() {
  if (guarded || typeof process === 'undefined' || !process.on) return;
  guarded = true;
  process.on('uncaughtException', function (e) { noteError('uncaught', e); });
  process.on('unhandledRejection', function (e) { noteError('rejection', e); });
}
function folders() {
  var out = apiFolders.slice();
  try {
    var info = tizen.application.getCurrentApplication().appInfo;
    if (info.dataPath) out.push(info.dataPath);
    if (info.packageId) out.push('/opt/usr/home/owner/apps_rw/' + info.packageId + '/data');
  } catch (e) { /* not exposed on all service runtimes */ }
  try { if (process.env.TIZEN_APP_DATA_PATH) out.push(process.env.TIZEN_APP_DATA_PATH); } catch (e) { /* optional */ }
  out.push('/opt/usr/home/owner/apps_rw/' + config.packageId + '/data');
  out.push(path.join(__dirname, 'data'));
  return out;
}
function init() {
  if (!updater) updater = require('./updater').create({ root: root, config: config, build: build, builtin: builtin, candidates: folders() });
}
function activate(version) {
  init();
  var list = updater.installed(), choice;
  if (version && failed[version]) throw new Error('Service failed this start');
  if (version) choice = common.select(list.filter(function (b) { return b.manifest.version === version; }), config.SHELL_LEVEL, updater.state);
  else {
    list = list.filter(function (b) { return !failed[b.manifest.version] && (build.updates || b.builtin); });
    choice = common.select(list.filter(function (b) { return b.manifest.version === updater.state.good; }), config.SHELL_LEVEL, updater.state);
    if (!Object.keys(failed).length) choice = common.select(list, config.SHELL_LEVEL, updater.state);
    else if (!choice) choice = updater.installed()[0];
  }
  if (!choice) throw new Error('No compatible bundle');
  if (active === choice.manifest.version && delegate) return;
  if (delegate && delegate.onExit) { try { delegate.onExit(); } catch (e) { /* unload anyway */ } }
  if (!common.begin(updater.state, choice.manifest.version, choice.builtin)) { updater.save(); failed[choice.manifest.version] = true; return activate(); }
  updater.save();
  var previousDir = activeDir;
  apiGeneration++;   // the outgoing helper's launcher API stops working now, even if this activation fails
  delegate = null; active = null; updater.setActive(null); activeDir = choice.dir;
  try {
    // Clear only bundle modules; shell state and listener survive a version switch.
    Object.keys(require.cache).forEach(function (p) { if (p.indexOf(path.join(root, 'builtin') + path.sep) === 0 || p.indexOf(choice.dir + path.sep) === 0 || (previousDir && p.indexOf(previousDir + path.sep) === 0)) delete require.cache[p]; });
    delegate = require(path.join(choice.dir, 'service/service.js'));
    if (typeof delegate.handle !== 'function') throw new Error('Missing service handler');
    var api = launcherApi();   // every activation: the previous helper's set stops working, whether or not this one asks
    if (delegate.onStart) delegate.onStart({ externalServer: true, launcher: api });
    active = choice.manifest.version; updater.setActive(active);
  } catch (e) {
    if (delegate && delegate.onExit) { try { delegate.onExit(); } catch (ignored) { /* rollback */ } }
    delegate = null;
    failed[choice.manifest.version] = true;
    common.fail(updater.state, choice.manifest.version, 'service: ' + String(e.message));
    updater.event(choice.manifest.version, 'service: ' + String(e.message)); updater.save();
    // The built-in is the final recovery copy; if it too fails, keep diagnostics reachable.
    if (!choice.builtin) activate();
  }
}
/*
 * What the bundle's helper gets at start (onStart's `launcher`), so a bundle can find and fetch updates its own way.
 * verify() checks a manifest's signature (and learns its revokes) and returns its signed fields; install() checks the
 * signature and every hash exactly as the shell's own check does, or throws. One set per activation: after a switch
 * to another version, the old helper's calls are refused (its downloads may still be finishing).
 */
var apiGeneration = 0;
function launcherApi() {
  var generation = ++apiGeneration;
  function live() { if (generation !== apiGeneration) throw new Error('This helper is no longer running'); }
  function signed(m) {
    return { version: m.version, minShell: m.minShell, revokes: m.revokes.slice(),
      archive: { name: m.archive.name, size: m.archive.size }, notes: typeof m.notes === 'string' ? m.notes.slice(0, 16000) : '' };
  }
  return {
    shellLevel: config.SHELL_LEVEL,
    status: function () { return updater.bundleStatus(); },
    verify: function (manifest, signature) { live(); var m = signed(updater.verify(manifest, signature)); updater.save(); return m; },
    install: function (manifest, signature, archive) {
      live();
      if (!build.updates) throw new Error('Updates are off in this build');
      return { version: updater.install(manifest, signature, archive).version };
    },
    checked: function (result) { live(); updater.checked(result); },
    discard: function (version) { live(); return updater.discard(version); }
  };
}
/*
 * A full app restart (Launcher.relaunch): the page closes the app, and this service opens it again once its process
 * is gone. A page reload keeps the process, and with it video hardware state: after an update reload the first 4K
 * HDR video fell back to SDR on the QE55Q77A (2026-11-16), while after a real start it played in HDR.
 */
var relaunching = null;   // one restart at a time; cancelled by any new page start and when this service exits
function relaunch() {
  var app = typeof tizen !== 'undefined' && tizen.application;
  if (!app || typeof app.launch !== 'function' || typeof app.getAppsContext !== 'function') return false;
  if (relaunching) return true;
  var job = relaunching = { cancelled: false }, appId = config.packageId + '.F1TV', looks = 0, launches = 0;
  function done() { if (relaunching === job) relaunching = null; }
  function launch() {
    if (job.cancelled) return done();
    try {
      app.launch(appId, done, function (e) {
        noteError('relaunch', e);
        if (++launches < 3 && !job.cancelled) setTimeout(launch, 1000); else done();
      });
    } catch (e) { noteError('relaunch', e); if (++launches < 3) setTimeout(launch, 1000); else done(); }
  }
  (function waitForExit() {
    if (job.cancelled) return done();
    try {
      app.getAppsContext(function (list) {
        var running = (list || []).some(function (c) { return c && c.appId === appId; });
        if (running && ++looks < 40) return setTimeout(waitForExit, 250);
        launch();
      }, function (e) { noteError('relaunch', e); setTimeout(launch, 1500); });
    } catch (e) { noteError('relaunch', e); setTimeout(launch, 1500); }
  })();
  return true;
}
function cancelRelaunch() { if (relaunching) { relaunching.cancelled = true; relaunching = null; } }
function answer(res, code, value, type) {
  var body = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' });
  res.end(body);
}
function handle(req, res) {
  var parts = req.url.split('?'), route = parts[0], query = {};
  (parts[1] || '').split('&').forEach(function (s) { var p = s.split('='); try { query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); } catch (e) { /* bad query */ } });
  if (req.method === 'OPTIONS') return answer(res, 204, '');
  try {
    if (route === '/ping') return answer(res, 200, { ok: !!delegate, version: active, shellLevel: config.SHELL_LEVEL });
    if (route === '/launcher/info') {
      // An ordinary new page start retries transient service failures. A rollback reload keeps them excluded.
      if (query.start === '1') {
        if (pageSeen && query.retry === '1') failed = {};
        pageSeen = true;
      }
      var info = updater.info(); info.failedThisStart = Object.keys(failed); info.errors = errors;
      answer(res, 200, info);
      // Each app start: the shell's own update check, in the background (it never delays the start). A new page
      // plays nothing yet, whatever the previous one said before it vanished.
      if (query.start === '1') {
        cancelRelaunch();   // the app is open again (reopened by the user, or the restart already happened)
        try { updater.setPlayback(false); updater.startCheck(); } catch (e) { noteError('check', e); }
      }
      return;
    }
    if (route.indexOf('/launcher/') === 0) {
      if (req.method !== 'POST') return answer(res, 405, { error: 'POST required' });
      var origin = req.headers.origin;
      if (origin && origin !== 'null' && origin !== 'file://') return answer(res, 403, { error: 'Local page required' });
      if (route === '/launcher/restart') {
        if (!common.version(query.version)) throw new Error('Invalid version');
        activate(query.version);
        if (active !== query.version) throw new Error('Service rolled back');
        return answer(res, 200, { version: active });
      }
      if (route === '/launcher/mark' || route === '/launcher/ready') {
        if (!common.version(query.version)) throw new Error('Invalid version');
        if (!updater.bundle(query.version)) return answer(res, 200, { ignored: true });
        if (route === '/launcher/mark') {
          if (!failed[query.version]) {
            var reason = 'page: ' + (/^[a-z ]{1,40}$/.test(query.reason || '') ? query.reason : 'failure');
            common.fail(updater.state, query.version, reason); updater.event(query.version, reason);
          }
          failed[query.version] = true;
        }
        else { updater.state.page = query.version; common.ready(updater.state, query.version); }
        updater.save(); return answer(res, 200, { ok: true });
      }
      if (route === '/launcher/relaunch') { if (!relaunch()) return answer(res, 501, { error: 'Restart not available' }); return answer(res, 200, { ok: true }); }
      if (route === '/launcher/ack') { var n = +query.through; if (!(n >= 0)) throw new Error('Invalid event id'); updater.ack(n); return answer(res, 200, { ok: true }); }
      if (route === '/launcher/settings') { updater.state.updates = query.updates !== '0'; updater.save(); return answer(res, 200, { ok: true }); }
      if (route === '/launcher/playback') { updater.setPlayback(query.active === '1'); return answer(res, 200, { ok: true }); }
      if (route === '/launcher/check') return updater.check(query.cached === '1', function (err, result) { answer(res, err ? 502 : 200, err ? { error: String(err.message) } : result); });
      return answer(res, 404, { error: 'Unknown route' });
    }
    var m = /^\/bundle\/(\d+\.\d+\.\d+)\/(.+)$/.exec(route);
    if (m) {
      var p = decodeURIComponent(m[2]);
      if (!common.safePath(p)) throw new Error('Unsafe path');
      var b = updater.bundle(m[1]);
      if (!b || !Object.prototype.hasOwnProperty.call(b.manifest.files, p)) return answer(res, 404, 'Not found');
      var body = fs.readFileSync(path.join(b.dir, p));
      // Generous on purpose: whatever later bundles ship is served with its proper type (WebAssembly needs its own).
      var ext = path.extname(p).toLowerCase(), types = { '.html': 'text/html', '.htm': 'text/html', '.js': 'application/javascript',
        '.mjs': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
        '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.json': 'application/json', '.wasm': 'application/wasm',
        '.txt': 'text/plain', '.vtt': 'text/vtt', '.xml': 'application/xml', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment',
        '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
      return answer(res, 200, body, types[ext] || 'application/octet-stream');
    }
    if (delegate) return delegate.handle(req, res);
    answer(res, 503, { error: 'Bundle service unavailable' });
  } catch (e) {
    // Helper code may throw after it started its answer: then the connection is closed, so the player sees an error
    // at once instead of waiting on a half-written response.
    if (route.indexOf('/launcher/') !== 0 && route !== '/ping') noteError('request', e);
    try { if (res.headersSent) res.destroy(); else answer(res, 500, { error: String(e.message) }); } catch (ignored) { /* gone */ }
  }
}
var listening = false, retrying = false, attempts = 0;
function listenAgain() {
  if (!server || listening) return;
  attempts = 0; retrying = true;
  try { server.listen(18765, '127.0.0.1'); } catch (e) { retrying = false; noteError('listen', e); }
}
function start(done) {
  if (typeof done === 'function') waiting.push(done);
  function callbacks() { var list = waiting; waiting = []; list.forEach(function (f) { f(); }); }
  if (server) { if (!listening && !retrying) listenAgain(); return callbacks(); }
  if (starting) return;
  starting = true;
  var finished = false, deadline;
  function listen(folder) {
    if (finished) return;
    finished = true; clearTimeout(deadline);
    try { if (folder && folder.toURI) { var uri = folder.toURI(); if (uri.indexOf('file://') === 0) apiFolders.push(decodeURIComponent(uri.slice(7))); } } catch (e) { /* optional API */ }
    guardProcess();
    init();
    try { activate(); } catch (e) { /* diagnostics and built-in page remain available */ }
    server = http.createServer(handle);
    var current = server;
    server.on('listening', function () { if (server === current) { listening = true; retrying = false; } });
    // A previous helper process may still hold the port for a moment: try again every 2 s for a minute; a later
    // start or request begins another round.
    server.on('error', function (e) {
      noteError('listen', e);
      if (server !== current || listening) return;
      if (e && e.code === 'EADDRINUSE' && ++attempts <= 30) setTimeout(function () { if (server === current && !listening) current.listen(18765, '127.0.0.1'); }, 2000);
      else retrying = false;
    });
    listenAgain();
    starting = false; callbacks();
  }
  // Some service builds expose the filesystem API, others only appInfo or process.env.
  try {
    if (typeof tizen !== 'undefined' && tizen.filesystem && tizen.filesystem.resolve) {
      deadline = setTimeout(function () { listen(); }, 1500);
      tizen.filesystem.resolve('wgt-private', listen, function () { listen(); }, 'rw');
      return;
    }
  } catch (e) { /* use derived package path */ }
  listen();
}
module.exports.onStart = function () { start(); };
module.exports.onRequest = function () {
  start(function () {
    if (delegate && delegate.onRequest) {
      try { delegate.onRequest({ externalServer: true }); }
      catch (e) {
        failed[active] = true; common.fail(updater.state, active, 'service request failure');
        updater.event(active, 'service request failure'); updater.save();
        try { activate(); } catch (ignored) { /* listener remains available */ }
      }
    }
  });
};
module.exports.onExit = function () { apiGeneration++; cancelRelaunch(); try { if (delegate && delegate.onExit) delegate.onExit(); } finally { if (server) server.close(); server = null; listening = false; retrying = false; delegate = null; active = null; activeDir = null; } };
