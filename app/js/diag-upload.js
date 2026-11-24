/*
 * Opt-in diagnostics upload (contract: f1tv-log-server docs/contract.md, docs/events.md and docs/api.md). Viewers who
 * say yes send small structured events: how playback attempts went per engine and path, what F1 offered the account,
 * start-up, script errors, failed requests by operation. No content ids, titles, URLs, tokens or free text.
 *
 * Off by default. While off, nothing is queued and nothing is sent: crash reports too go only with diagnostics on (as
 * events). The one thing every TV sends, once the viewer has answered the question, is an anonymous count of an app
 * use (countUse below: no ID). Saying yes starts a consent epoch with a fresh queue
 * and session, and the installation secret (kept across off/on, so "Delete my diagnostics data" reaches everything).
 * Uploads also carry the TV's unit (unit below): a hash of its own device ID, the same after a deletion and a new yes.
 * Nothing is sent under a secret that isn't stored. Deleting moves the secret to a list of pending deletions until the
 * server confirms each; a later yes makes a new one. A server that refuses this TV (401/403) stops everything until the
 * viewer says yes again (a new secret; the old one is deleted like the others).
 *
 * It never gets in the way: every call is wrapped, uploads wait while a video starts, a server that is down or
 * unreachable just means backing off (to 15 minutes), and the queue is bounded (250 events, 256 KiB, 24 h, the batch
 * being sent included).
 */
var DiagUpload = (function () {
  // The server comes with the build (DIAG_BUILD.server: the release workflow's DIAG_SERVER variable, or a personal
  // build's local/app/js/diag-build.js). Without one, nothing is sent and nothing is asked.
  var BASE = (function () {
    try { if (/^https?:\/\/[^\s?#]+[^\/\s?#]$/.test(DIAG_BUILD.server)) return DIAG_BUILD.server; } catch (e) { /* none */ }
    return null;
  })();
  var KEYS = { secret: 'f1tv.diag.secret', deleting: 'f1tv.diag.deleting', queue: 'f1tv.diag.queue', batch: 'f1tv.diag.batch',
    state: 'f1tv.diag.upload' };
  var MAX_EVENTS = 250, MAX_BYTES = 262144, MAX_AGE = 24 * 3600000, BATCH = 50, EVENT_BYTES = 4096;
  // The server takes up to 128 KiB per batch or report; this leaves room for the envelope.
  var BODY_BYTES = 120000;
  var FLUSH_MS = 60000, TIMEOUT_MS = 10000;
  var BACKOFF_MIN = 60000, BACKOFF_MAX = 15 * 60000, RETRY_AFTER_MAX = 6 * 3600000;
  var QUIET_AFTER_START_MS = 15000;
  var RING = 100;

  // The contract's shared values (the server's schemas/vocabulary.v1.json), in one place for this and diag-play.js.
  var VOCAB = {
    layouts: ['off', 'grid2x2', 'grid2x2hd', 'pip', 'pip3', 'pip4', 'side2', 'big3', 'side5', 'side3wide'],
    paths: ['shaka:cenc', 'shaka:clear', 'avplay:cbcs', 'avplay:cenc', 'avplay:hdr', 'avplay:clear', 'mvsoft:h264',
      'shaka:hdr', 'shaka:hlsaes', 'shaka:tmgrid', 'avplay:grid', 'shaka:grid', 'avplay:drmgrid', 'avplay:ac3'],
    capsPaths: ['shaka:cenc', 'avplay:cbcs', 'avplay:cenc', 'avplay:hdr'],
    codes: ['PREPARE_TIMEOUT', 'PLAYER_STUCK', 'SHAKA_ERROR', 'AVPLAY_ERROR', 'NETWORK_ERROR', 'DRM_ERROR', 'DECODE_ERROR',
      'UNSUPPORTED', 'HELPER_ERROR', 'NO_PROGRESS', 'OTHER', 'UNKNOWN']
  };

  var session = null, sequence = 0, sending = false, sendGen = 0, inflight = null, timer = null, nextAt = 0, quietUntil = 0, ring = [];
  var memQueue = null, memBytes = 0, memBatch, batchBytes = 0, saveTimer = null;
  var state = load(KEYS.state) || {};
  if (typeof state !== 'object') state = {};

  // ---- storage ------------------------------------------------------------------------------

  function storage() { try { return window.localStorage || null; } catch (e) { return null; } }
  function load(key) { var s = storage(); try { return s ? JSON.parse(s.getItem(key)) : null; } catch (e) { return null; } }
  /** Writes (or removes, for null) one key; false when storage refused it (full, disabled). */
  function store(key, value) {
    var s = storage();
    try {
      if (!s) return false;
      if (value == null) s.removeItem(key); else s.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }
  function saveState() { store(KEYS.state, state); }

  // ---- identity and consent -----------------------------------------------------------------

  function randomBytes(n) {
    var a = new Uint8Array(n);
    window.crypto.getRandomValues(a);
    return a;
  }

  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  function uuid() {
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = hex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function cryptoOk() { try { return !!(window.crypto && window.crypto.getRandomValues); } catch (e) { return false; } }

  /** 'basic' when the viewer said yes (and the TV can make a secret, and the build has a server), else 'off'. */
  function mode() {
    var on = false;
    try { on = !!BASE && typeof Settings !== 'undefined' && Settings.get('diagnostics') === 'basic'; } catch (e) { /* off */ }
    return on && cryptoOk() ? 'basic' : 'off';
  }

  /** Collecting and sending: the viewer said yes and the server hasn't refused this TV since. */
  function enabled() { return mode() !== 'off' && !state.stopped; }

  function validSecret(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) ? s : null; }
  function secret() { return validSecret(load(KEYS.secret)); }

  /**
   * The secret for a viewer who said yes (made now if it is missing: a first yes, or after a deletion or a refusal).
   * Null unless it is stored: what is sent under it must stay deletable.
   */
  function ensureSecret() {
    var s = secret();
    if (s || !enabled()) return s;
    s = hex(randomBytes(32));
    return store(KEYS.secret, s) && secret() === s ? s : null;
  }

  /** Secrets whose data the server hasn't confirmed deleted yet (an older single value counts as one). */
  function deletions() {
    var v = load(KEYS.deleting), list = Array.isArray(v) ? v : [v], out = [];
    list.forEach(function (s) { if (validSecret(s) && out.indexOf(s) < 0) out.push(s); });
    return out;
  }

  /** Moves the current secret to the deletions; it stays where it is if that can't be stored (still deletable). */
  function retireSecret() {
    var s = secret();
    if (!s) return null;
    var list = deletions();
    if (list.indexOf(s) < 0) list.push(s);
    if (store(KEYS.deleting, list) && deletions().indexOf(s) >= 0) store(KEYS.secret, null);
    return s;
  }

  /** An upload under way belongs to the epoch that started it: stop it and ignore its answer. */
  function abortSending() {
    sendGen++;
    sending = false;
    try { if (inflight) inflight.abort(); } catch (e) { /* done already */ }
    inflight = null;
  }

  /** Everything collected in the current consent epoch goes: queue, pending batch, breadcrumbs, counters, session. */
  function resetEpoch() {
    abortSending();
    clearTimeout(saveTimer);
    saveTimer = null;
    memQueue = [];
    memBytes = 0;
    memBatch = null;
    batchBytes = 0;
    store(KEYS.queue, null);
    store(KEYS.batch, null);
    ring = [];
    session = null;
    sequence = 0;
    accountSent = null;
    apiSeen = {};
    jsSeen = {};
    clearTimeout(capsTimer);
    state.capsSent = null;
    state.dropped = {};
    state.report = null;
    state.lastReference = null;
    state.consentAt = 0;
    saveState();
    try { if (typeof DiagPlay !== 'undefined' && DiagPlay.reset) DiagPlay.reset(); } catch (e) { /* never in the way */ }
  }

  /** The viewer's answer (Settings or the one-time question). */
  function setEnabled(on) {
    try {
      var was = enabled();
      if (!on) {
        // The queue goes first: it frees the space the setting needs to be stored.
        resetEpoch();
        clearTimeout(timer);
      }
      Settings.set('diagnostics', on ? 'basic' : 'off');
      Settings.set('diagnosticsAsked', true);
      if (on) {
        if (!was || !state.consentAt) {
          // A refused secret is deleted like any other; this yes gets a new one.
          if (state.stopped) retireSecret();
          state.stopped = null;
          resetEpoch();
          state.consentAt = Date.now();
        }
        saveState();
        ensureSecret();
        startSession();
        account();
        caps();
        schedule(randomDelay(5000, 20000));
        if (deletions().length) retryDeletionLater();
      }
    } catch (e) { /* never in the way */ }
  }

  // ---- the device and the app -----------------------------------------------------------------

  function ascii(v, fallback) {
    var s = String(v == null ? '' : v).replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
    return s || fallback;
  }

  // What the server refuses in a device label (it could identify someone): e-mail, URL, long hex, UUID.
  var IDENTIFIER = /@|[A-Za-z][A-Za-z0-9+.\-]*:\S|\/\/|[Ww][Ww][Ww]\.|\.[A-Za-z]{2,}\/|[0-9A-Fa-f]{16}|[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}/;
  function label(v) {
    var s = ascii(v, 'unknown');
    return IDENTIFIER.test(s) ? 'unknown' : s;
  }

  var deviceInfo = null;
  function device() {
    if (deviceInfo) return deviceInfo;
    var d = { model: 'unknown', firmware: 'unknown', tizen_version: 'unknown' };
    try { d.model = label(webapis.productinfo.getRealModel() || webapis.productinfo.getModel()); } catch (e) { /* not a TV */ }
    try { d.firmware = label(webapis.productinfo.getFirmware()); } catch (e) { /* unknown */ }
    try { d.tizen_version = label(tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version')); } catch (e) { /* unknown */ }
    deviceInfo = d;
    return d;
  }

  function packageVersion() {
    try { return tizen.application.getCurrentApplication().appInfo.version; } catch (e) { return ''; }
  }

  function app() {
    var running = (typeof Launcher !== 'undefined' && Launcher.version) || packageVersion();
    var source = 'unknown';
    var personal = typeof DIAG_BUILD !== 'undefined' && DIAG_BUILD && DIAG_BUILD.label;
    try {
      // Only what is confirmed: the installer leaves a marker; anything else (Apps2Samsung, a missing marker, a personal
      // build) is unknown. Personal builds are told apart by the build check (no published bundle: unofficial).
      if (!personal && typeof Updates !== 'undefined' && Updates.installedBy && Updates.installedBy() === 'installer') source = 'installer';
    } catch (e) { /* unknown */ }
    var pkg = packageVersion();
    return { version: ascii(running, 'unknown'), build: pkg ? ascii('package-' + pkg, null) : null, install_source: source };
  }

  /** The build check: the running release and its signed bundle's archive hash, both or neither (never a personal build). */
  function build() {
    try {
      if (typeof DIAG_BUILD !== 'undefined' && DIAG_BUILD && DIAG_BUILD.label) return null;
      var v = typeof Launcher !== 'undefined' ? String(Launcher.version || '') : '', b = typeof Launcher !== 'undefined' ? Launcher.archiveSha512 : null;
      if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) && /^[0-9a-f]{128}$/.test(b || '')) return { release: v, bundle: b };
    } catch (e) { /* unknown build */ }
    return null;
  }

  /** What labels a batch, taken when an event is collected (an update must not relabel what is queued). */
  var dimsNow = null;
  function dims() {
    if (!dimsNow) dimsNow = { app: app(), device: device(), build: build() };
    return dimsNow;
  }

  // ---- events and the queue ---------------------------------------------------------------------

  function startSession() {
    if (session || !cryptoOk()) return;
    session = uuid();
    sequence = 0;
  }

  function utf8(s) { return unescape(encodeURIComponent(s)).length; }
  function bytesOf(o) {
    try { return utf8(JSON.stringify(o)); } catch (e) { return EVENT_BYTES + 1; }
  }

  /** The queue, read once and then kept in memory (each entry knows its own size). */
  function queue() {
    if (memQueue) return memQueue;
    var q = load(KEYS.queue);
    memQueue = Array.isArray(q) ? q.filter(function (e) { return e && e.event && e.session && e.dims && e.at > 0; }) : [];
    memBytes = 0;
    memQueue.forEach(function (e) { if (!(e.b > 0)) e.b = bytesOf(e); memBytes += e.b + 1; });
    return memQueue;
  }

  function saveQueue() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (memQueue) store(KEYS.queue, memQueue);
  }

  /** New events are written a moment later, together (never on the player's tick itself). */
  function saveQueueSoon() {
    if (!saveTimer) saveTimer = setTimeout(saveQueue, 1000);
  }

  /** The batch being sent (kept until the server acknowledges it), read once. */
  function pendingBatch() {
    if (memBatch === undefined) {
      var b = load(KEYS.batch);
      memBatch = b && b.batch_id && Array.isArray(b.events) && b.events.length && b.dims ? b : null;
      batchBytes = memBatch ? bytesOf(memBatch) : 0;
    }
    return memBatch;
  }

  function setBatch(b) {
    memBatch = b || null;
    batchBytes = memBatch ? bytesOf(memBatch) : 0;
    store(KEYS.batch, memBatch);
  }

  function countDrop(reason, n) {
    if (!n) return;
    state.dropped = state.dropped || {};
    state.dropped[reason] = (state.dropped[reason] || 0) + n;
    saveState();
  }

  /**
   * Expired entries out; then the oldest out first (warnings and errors kept over info) while the queue and the batch
   * being sent are over the bounds together.
   */
  function bound() {
    var q = queue(), now = Date.now(), fresh = q.filter(function (e) { return now - e.at < MAX_AGE; });
    if (fresh.length < q.length) {
      countDrop('expired', q.length - fresh.length);
      memQueue = q = fresh;
      memBytes = 0;
      q.forEach(function (e) { memBytes += e.b + 1; });
    }
    var b = pendingBatch(), held = b ? b.events.length : 0;
    while (q.length && (q.length + held > MAX_EVENTS || memBytes + batchBytes > MAX_BYTES)) {
      var i = 0;
      while (i < q.length && q[i].event.level !== 'info' && q[i].event.level !== 'debug') i++;
      if (i === q.length) i = 0;
      memBytes -= q[i].b + 1;
      q.splice(i, 1);
      countDrop('queue_full', 1);
    }
  }

  function add(e) {
    var item = { at: Date.now(), session: session, dims: dims(), event: e };
    item.b = bytesOf(item);
    queue().push(item);
    memBytes += item.b + 1;
    bound();
    saveQueueSoon();
  }

  /**
   * Queues one event of the contract: name, its fields object (closed: only documented keys), level, and the
   * playback attempt it belongs to. Nothing happens while diagnostics are off. Returns the event (or null).
   */
  function event(name, fields, level, attemptId) {
    try {
      if (!enabled()) return null;
      startSession();
      // No occurred_at: the sequence orders a session, and the server keeps its own receive time.
      var e = { event_id: uuid(), name: name, event_version: 1, sequence: sequence++,
        level: level || 'info', fields: fields || {} };
      if (attemptId) e.playback_attempt_id = attemptId;
      if (bytesOf(e) > EVENT_BYTES) return null;
      ring.push(e);
      if (ring.length > RING) ring.shift();
      add(e);
      // A problem goes out a little sooner, but at most once a minute and never against a backoff or Retry-After.
      if ((level === 'error' || level === 'warn') && !sending && !state.failures && Date.now() >= (state.retryAt || 0) &&
          (!nextAt || nextAt - Date.now() > 20000) && Date.now() - (state.lastSent || 0) > 60000) {
        schedule(randomDelay(5000, 15000));
      }
      return e;
    } catch (err) { return null; }
  }

  /** A fresh random id for one user playback attempt (null while diagnostics are off). */
  function attemptId() {
    try { return enabled() ? uuid() : null; } catch (e) { return null; }
  }

  // ---- sending ----------------------------------------------------------------------------------

  function randomDelay(min, max) { return min + Math.floor(Math.random() * (max - min)); }

  function schedule(ms) {
    clearTimeout(timer);
    nextAt = Date.now() + ms;
    timer = setTimeout(flush, ms);
  }

  function nextRound() {
    if (!enabled()) return;
    schedule(randomDelay(FLUSH_MS * 0.8, FLUSH_MS * 1.2));
  }

  function backoff(retryAfterMs) {
    state.failures = (state.failures || 0) + 1;
    var ms = Math.min(BACKOFF_MAX, BACKOFF_MIN * Math.pow(2, state.failures - 1));
    ms = Math.min(BACKOFF_MAX, randomDelay(ms * 0.8, ms * 1.2));
    if (retryAfterMs > 0) ms = Math.max(ms, Math.min(RETRY_AFTER_MAX, retryAfterMs));
    state.retryAt = Date.now() + ms;
    saveState();
    schedule(ms);
  }

  /** Retry-After in ms: seconds or an HTTP date (0 when missing or unreadable). */
  function retryAfterMs(v) {
    if (!v) return 0;
    if (/^\s*\d+\s*$/.test(v)) return +v * 1000;
    var at = Date.parse(v);
    return at > 0 ? Math.max(0, at - Date.now()) : 0;
  }

  /**
   * fetch with a timeout; resolves { status, retryAfter (ms), body } or rejects on a network failure. A redirect is a
   * failure: only the diagnostics server itself may answer. own: the controller to keep, so turning off can abort it.
   */
  function request(method, path, body, auth, buildPair, own) {
    if (!BASE) return Promise.reject(new Error('No diagnostics server in this build'));
    return new Promise(function (resolve, reject) {
      var done = false, ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (own) inflight = ctrl;
      var h = { 'Content-Type': 'application/json' };
      if (auth) h['Authorization'] = 'Bearer ' + auth;   // none for the anonymous app-use count
      if (buildPair) { h['X-Diag-Release'] = buildPair.release; h['X-Diag-Bundle'] = buildPair.bundle; }
      var t = setTimeout(function () { if (!done) { done = true; if (ctrl) ctrl.abort(); reject(new Error('timeout')); } }, TIMEOUT_MS);
      fetch(BASE + path, { method: method, headers: h, body: body, signal: ctrl ? ctrl.signal : undefined, credentials: 'omit',
        redirect: 'error' })
        .then(function (res) {
          if (res.redirected) throw new Error('redirected');
          return res.text().then(function (text) {
            if (done) return;
            done = true;
            clearTimeout(t);
            var json = null;
            try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
            resolve({ status: res.status, retryAfter: retryAfterMs(res.headers.get('Retry-After')), body: json });
          });
        })
        .catch(function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
    });
  }

  /** The server's acknowledgement of a whole batch (its counts add up to the events sent), not just any 200. */
  function acknowledged(r, batch) {
    var b = r.body, n = function (v) { return typeof v === 'number' && v >= 0 && Math.floor(v) === v; };
    return r.status === 200 && !!b && n(b.stored) && n(b.duplicates) && n(b.dropped) &&
      b.stored + b.duplicates + b.dropped === batch.events.length;
  }

  /** The server refused this TV (401/403): nothing more is collected or sent until the viewer says yes again. */
  function refused(status) {
    state.stopped = status;
    saveState();
    resetEpoch();
    clearTimeout(timer);
  }

  function dimsKey(d) { return JSON.stringify(d); }

  /**
   * The next batch: one session and one set of labels (app, device, build), kept with its id until the server
   * acknowledges it, so a retry is the same batch. Older than 24 h, it is dropped and counted.
   */
  function nextBatch() {
    var pending = pendingBatch(), now = Date.now();
    if (pending) {
      // Each event expires on its own (ats); a batch without them, as a whole.
      var ats = Array.isArray(pending.ats) && pending.ats.length === pending.events.length ? pending.ats : null;
      var keep = pending.events.filter(function (e, i) { return now - (ats ? ats[i] : pending.at || 0) < MAX_AGE; });
      if (keep.length === pending.events.length) return pending;
      countDrop('expired', pending.events.length - keep.length);
      if (!keep.length) setBatch(null);
      else {
        var keptAts = ats.filter(function (at) { return now - at < MAX_AGE; });
        setBatch({ batch_id: uuid(), session_id: pending.session_id, dims: pending.dims, at: Math.min.apply(null, keptAts),
          ats: keptAts, events: keep });
        return memBatch;
      }
    }
    bound();
    var q = queue(), notes = false;
    if (state.dropped && (state.dropped.queue_full || state.dropped.expired)) {
      startSession();
      ['queue_full', 'expired'].forEach(function (reason) {
        var n = state.dropped[reason];
        if (!n) return;
        var e = { event_id: uuid(), name: 'diagnostics.dropped', event_version: 1, sequence: sequence++, level: 'warn',
          fields: { count: Math.min(n, 1000000), reason: reason } };
        var item = { at: now, session: session, dims: dims(), event: e };
        item.b = bytesOf(item);
        q.push(item);
        memBytes += item.b + 1;
        notes = true;
      });
    }
    if (!q.length) { saveQueue(); return null; }
    // The oldest entry's session and labels go first; the envelope has one of each, and the body stays under the
    // server's size limit.
    var sid = q[0].session, key = dimsKey(q[0].dims), take = [], rest = [], size = 0;
    q.forEach(function (e) {
      if (e.session === sid && dimsKey(e.dims) === key && take.length < BATCH && (!take.length || size + e.b < BODY_BYTES)) {
        take.push(e);
        size += e.b;
      } else rest.push(e);
    });
    var at = take.map(function (e) { return e.at; });
    setBatch({ batch_id: uuid(), session_id: sid, dims: q[0].dims, at: Math.min.apply(null, at), ats: at,
      events: take.map(function (e) { return e.event; }) });
    memQueue = rest;
    memBytes = 0;
    rest.forEach(function (e) { memBytes += e.b + 1; });
    saveQueue();
    // The counts are cleared only once their event is stored.
    if (notes) { state.dropped = {}; saveState(); }
    return memBatch;
  }

  function envelope(batch) {
    var body = { schema_version: 1, batch_id: batch.batch_id, session_id: batch.session_id, mode: 'basic',
      app: batch.dims.app, device: batch.dims.device, events: batch.events };
    if (unit()) body.unit = unit();
    return JSON.stringify(body);
  }

  function flush() {
    try {
      timer = null;
      nextAt = 0;
      if (!enabled()) return;
      // One upload at a time; this round comes again after it.
      if (sending) return nextRound();
      if (Date.now() < quietUntil) return schedule(quietUntil - Date.now() + 1000);
      // A backoff or Retry-After holds across restarts.
      if (Date.now() < (state.retryAt || 0)) return schedule(state.retryAt - Date.now() + randomDelay(0, 5000));
      var auth = ensureSecret();
      if (!auth) return nextRound();
      var batch = nextBatch();
      if (!batch) return nextRound();
      var gen = ++sendGen;
      sending = true;
      request('POST', '/events', envelope(batch), auth, batch.dims.build, true).then(function (r) {
        // Turned off, deleted or said yes again meanwhile: this answer belongs to an epoch that is gone.
        if (gen !== sendGen) return;
        sending = false;
        inflight = null;
        if (acknowledged(r, batch) || r.status === 400) {
          // 400: a batch the server can't read won't get better; drop it rather than retry forever.
          setBatch(null);
          state.failures = 0;
          state.retryAt = 0;
          state.lastSent = Date.now();
          saveState();
          // A backlog goes out paced (the server takes ~200 events a minute from one TV).
          return queue().length ? schedule(randomDelay(15000, 25000)) : nextRound();
        }
        if (r.status === 413 && batch.events.length > 1) {
          // Too big: split it, keeping the event ids and their age; the second half goes back in front of the queue.
          var half = Math.ceil(batch.events.length / 2), ats = batch.ats || [];
          var back = batch.events.slice(half).map(function (e, i) {
            var item = { at: ats[half + i] || batch.at, session: batch.session_id, dims: batch.dims, event: e };
            item.b = bytesOf(item);
            return item;
          });
          var first = ats.slice(0, half);
          setBatch({ batch_id: uuid(), session_id: batch.session_id, dims: batch.dims, at: batch.at,
            ats: first.length === half ? first : undefined, events: batch.events.slice(0, half) });
          memQueue = back.concat(queue());
          memBytes = 0;
          memQueue.forEach(function (e) { memBytes += e.b + 1; });
          saveQueue();
          return schedule(2000);
        }
        if (r.status === 413) { setBatch(null); return nextRound(); }
        if (r.status === 401 || r.status === 403) return refused(r.status);
        // No such endpoint (yet), or a request it won't take: the batch waits (it expires after 24 h); try hourly.
        if (r.status === 404 || r.status === 415 || r.status === 431) return backoff(3600000);
        backoff(r.retryAfter);
      }, function () {
        if (gen !== sendGen) return;
        // Unreachable, timed out or a wrong answer (also while the server isn't running yet): later, quietly.
        sending = false;
        inflight = null;
        backoff(0);
      });
    } catch (e) { sending = false; }
  }

  // ---- deletion and problem reports ---------------------------------------------------------------

  /**
   * Deletes everything this TV sent and turns diagnostics off. The secret joins the pending deletions until the server
   * confirms (retried at each start); a later yes makes a new one. Resolves 'deleted' or 'pending'.
   */
  function deleteMyData() {
    var s = null;
    try {
      resetEpoch();
      clearTimeout(timer);
      Settings.set('diagnostics', 'off');
      state.stopped = null;
      saveState();
      s = retireSecret();
    } catch (e) { /* never in the way */ }
    return retryDeletion(s);
  }

  /** Asks the server to delete each pending secret's data; only a confirmed one is forgotten. */
  function retryDeletion(extra) {
    var list = deletions();
    if (validSecret(extra) && list.indexOf(extra) < 0) list.push(extra);
    if (!list.length) return Promise.resolve('deleted');
    return Promise.all(list.map(function (s) {
      return request('DELETE', '/installations/self', undefined, s, null).then(function (r) {
        if (r.status !== 200 || !r.body || r.body.status !== 'deleted') return;
        store(KEYS.deleting, deletions().filter(function (d) { return d !== s; }));
        if (secret() === s) store(KEYS.secret, null);
      }, function () { /* pending */ });
    })).then(function () { return deletions().length || (extra && secret() === extra) ? 'pending' : 'deleted'; });
  }

  /** At a quiet moment: never while a video starts. */
  function retryDeletionLater() {
    setTimeout(function again() {
      if (Date.now() < quietUntil) return setTimeout(again, quietUntil - Date.now() + 1000);
      retryDeletion().catch(function () { /* next start */ });
    }, randomDelay(20000, 60000));
  }

  function deletionPending() { return deletions().length > 0; }

  var REPORT_CATEGORIES = ['playback_fails', 'buffering', 'picture_or_sound', 'multiview', 'sign_in', 'timing', 'app_crash', 'other'];

  /**
   * Sends a problem report the viewer asked for: a category, a few settings, the TV's playback evidence and the
   * events of this consent epoch in this run (at most 100). Resolves the reference to show (R-XXXX-XXXX) or rejects.
   */
  function report(category) {
    if (!enabled()) return Promise.reject(new Error(state.stopped ? 'The server stopped accepting this TV' : 'Diagnostics are off'));
    var auth = ensureSecret();
    if (!auth) return Promise.reject(new Error('This TV can\'t store its diagnostics ID'));
    if (REPORT_CATEGORIES.indexOf(category) < 0) category = 'other';
    if (!state.report || state.report.category !== category) { state.report = { id: uuid(), category: category }; saveState(); }
    var d = dims(), rid = state.report.id, epoch = state.consentAt, crumbs = ring.slice(-100), body;
    // Within the server's size limit: the oldest breadcrumbs go first.
    do {
      var r = { schema_version: 1, report_id: rid, app: d.app, device: d.device,
        data: { description_category: category, settings: reportSettings(), caps: capsProjection(), breadcrumbs: crumbs } };
      if (unit()) r.unit = unit();
      body = JSON.stringify(r);
    } while (utf8(body) > BODY_BYTES && crumbs.shift());
    return request('POST', '/reports', body, auth, d.build).then(function (r) {
      var current = enabled() && state.consentAt === epoch;
      if (current && (r.status === 401 || r.status === 403)) refused(r.status);
      if (r.status === 200 && r.body && /^R-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(r.body.reference || '')) {
        // A newer report (another category) keeps its own id.
        if (current && state.report && state.report.id === rid) { state.report = null; state.lastReference = r.body.reference; saveState(); }
        return r.body.reference;
      }
      throw new Error(r.status === 429 ? 'Too many reports today' : 'The diagnostics server answered ' + r.status);
    });
  }

  // ---- the short id shown in Settings -------------------------------------------------------------

  /** SHA-256 (FIPS 180-4) of bytes, for the id the server knows this TV by; small and synchronous. */
  function sha256(bytes) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
      0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
      0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
      0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length, total = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
    m.set(bytes);
    m[len] = 0x80;
    var bits = len * 8;
    m[total - 4] = (bits >>> 24) & 255; m[total - 3] = (bits >>> 16) & 255; m[total - 2] = (bits >>> 8) & 255; m[total - 1] = bits & 255;
    var w = new Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var a = w[i - 15], b = w[i - 2];
        var s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        var s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var A = H[0], B = H[1], C = H[2], D = H[3], E = H[4], F = H[5], G = H[6], X = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
        var t1 = (X + S1 + ((E & F) ^ (~E & G)) + K[i] + w[i]) | 0;
        var S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
        var t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;
        X = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      H[0] = (H[0] + A) | 0; H[1] = (H[1] + B) | 0; H[2] = (H[2] + C) | 0; H[3] = (H[3] + D) | 0;
      H[4] = (H[4] + E) | 0; H[5] = (H[5] + F) | 0; H[6] = (H[6] + G) | 0; H[7] = (H[7] + X) | 0;
    }
    var out = '';
    for (i = 0; i < 8; i++) out += ('00000000' + (H[i] >>> 0).toString(16)).slice(-8);
    return out;
  }

  /** The ID shown for this TV: the first 12 hex digits of its unit (none until the viewer says yes). */
  function id() {
    var u = secret() ? unit() : null;
    return u ? u.slice(0, 12) : null;
  }

  /** Something was sent and may still be on the server (the delete action applies). */
  function hasData() { return !!secret() || deletionPending(); }

  /** Whether something that happened at time t (ms) falls in the current consent epoch (incidents that began earlier don't). */
  function covers(t) { return enabled() && !!state.consentAt && t >= state.consentAt; }

  /** What the viewer is told before saying yes (and in Settings). Read more shows the details: app/PRIVACY.md. */
  var EXPLANATION = 'You can contribute making this app even better by enabling diagnostics logging.\n'
    + 'The data is linked to an ID made for this TV, never to your F1 TV account: no account information is sent.\n'
    + 'The logs will be used to diagnose how the app performs on different TV models, and to help uncover bugs that were not visible to the developer.\n'
    + 'The data will only be stored and handled in the EU/EEA.';

  // ---- what the app reports directly --------------------------------------------------------------

  var OPS = ['playback_license', 'playback_offer', 'content_list', 'content_detail', 'config', 'entitlement', 'location',
    'standings', 'driver_season', 'driver_info', 'manifest', 'resume_position', 'save_position', 'menu', 'login_status',
    'update_check', 'other'];
  var apiSeen = {};

  /** An operation failed after its own alternatives: a fixed label and the last HTTP status, never a URL. */
  function apiFailed(op, status, retries) {
    try {
      if (!enabled()) return;
      if (OPS.indexOf(op) < 0) op = 'other';
      var key = op + ':' + (status || 0);
      apiSeen[key] = (apiSeen[key] || 0) + 1;
      // The same failure again (a background refresh): a few are enough. Playback requests are the viewer's own.
      if (apiSeen[key] > (/^playback_/.test(op) ? 30 : 3)) return;
      var f = { operation: op, retry_count: Math.max(0, Math.min(100, retries || 0)) };
      if (status >= 100 && status <= 599) f.http_status = status;
      event('api.request_failed', f, 'warn');
    } catch (e) { /* never in the way */ }
  }

  /** F1's location entitlement as a tier: exactly one of ACCESS, PRO, PREMIUM among its words, else other/unknown. */
  function tier(entitlement) {
    if (typeof entitlement !== 'string' || !entitlement.trim()) return 'unknown';
    var words = entitlement.trim().toUpperCase().split(/[^A-Z0-9]+/), found = [];
    ['ACCESS', 'PRO', 'PREMIUM'].forEach(function (t) { if (words.indexOf(t) >= 0) found.push(t.toLowerCase()); });
    return found.length === 1 ? found[0] : 'other';
  }

  function currentTier() {
    try {
      var st = F1Api.state, l = st.location;
      // Only the current sign-in's own location (an account change or a failed refresh can leave the previous one).
      return st.ascendon && st.locationFor === st.ascendon && l && typeof l.entitlement === 'string' ? tier(l.entitlement) : 'unknown';
    } catch (e) { return 'unknown'; }
  }

  var accountSent = null;
  /** Signed in or not, and the tier: once per session and whenever it changes. */
  function account() {
    try {
      if (!enabled()) return;
      var signedIn = false;
      try { signedIn = !!F1Api.state.ascendon; } catch (e) { /* no API */ }
      var f = { signed_in: signedIn, tier: signedIn ? currentTier() : 'unknown' }, key = JSON.stringify(f);
      if (key === accountSent) return;
      accountSent = key;
      event('account.status', f, 'info');
    } catch (e) { /* never in the way */ }
  }

  function capsProjection() {
    if (typeof Caps === 'undefined') return null;
    var b = Caps.report().browser || {}, usable = {};
    VOCAB.capsPaths.forEach(function (p) { usable[p] = !!Caps.usable(p); });
    var flag = function (v) { return v === true || v === false ? v : null; };
    return { browser: { cenc: flag(b.cenc), cbcs: flag(b.cbcs) }, usable: usable };
  }

  var capsTimer = null;
  /** What this TV can play, when it changes (compared with what was last sent, across sessions). */
  function caps() {
    clearTimeout(capsTimer);
    capsTimer = setTimeout(function () {
      try {
        if (!enabled()) return;
        var f = capsProjection();
        if (!f || (f.browser.cenc === null && f.browser.cbcs === null)) return;   // not measured yet
        var key = device().firmware + '|' + JSON.stringify(f);   // a new firmware sends it again
        if (key === state.capsSent) return;
        state.capsSent = key;
        saveState();
        event('caps.snapshot', f, 'info');
      } catch (e) { /* never in the way */ }
    }, 2000);
  }

  var startedSent = false, abnormalChecked = false;
  /** Start-up's result (once per run): ok when Home or the sign-in screen shows, failed on the start-up error. */
  function started(outcome, timeToHome) {
    try {
      if (!startedSent && enabled()) {
        startedSent = true;
        var f = { outcome: outcome };
        if (outcome === 'ok' && timeToHome != null) f.time_to_home_ms = Math.max(0, Math.min(600000, Math.round(timeToHome)));
        event('app.started', f, outcome === 'failed' ? 'error' : 'info');
        account();
        caps();
      }
      abnormalEnd();
    } catch (e) { /* never in the way */ }
  }

  /** The heartbeat caps.js found: the last run ended while protected video played on AVPlay (once per run). */
  function abnormalEnd() {
    if (abnormalChecked) return;
    abnormalChecked = true;
    var prev = typeof Caps !== 'undefined' && Caps.previousRun ? Caps.previousRun() : null;
    if (!prev || !(prev.minutes >= 0 && prev.minutes < 10)) return;
    var f = { path: VOCAB.paths.indexOf(prev.path) >= 0 ? prev.path : 'other', minutes_since_marker: prev.minutes };
    if (covers(Date.now() - prev.minutes * 60000)) event('app.abnormal_end_suspected', f, 'warn');
  }

  var LAUNCH_REASONS = { 'page: start timeout': 'start_timeout', 'page: script error': 'script_error',
    'page: load failure': 'load_failure', 'page: helper failure': 'helper_failure' };

  /** A failed start the launcher kept: an event if it came since the viewer said yes (nothing otherwise). */
  function launcherFailed(e) {
    try {
      if (!e || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(e.version))) return;
      var reason = LAUNCH_REASONS[e.reason] || (/^service\b/.test(String(e.reason)) ? 'service_error' : 'other');
      var f = { version: String(e.version), reason: reason };
      if (covers(e.at)) event('launcher.failed_start', f, 'warn');
    } catch (err) { /* never in the way */ }
  }

  var SOURCES = ['index.html', 'boot.html', 'api.js', 'app.js', 'auth.js', 'caps.js', 'cmaf.js', 'diag.js', 'diag-build.js',
    'diag-upload.js', 'diag-play.js', 'focus.js', 'hdr.js', 'keys.js', 'layouts.js', 'mvsoft.js', 'mvsoft-worker.js', 'player.js', 'proxy.js',
    'settings.js', 'stats.js', 'timing.js', 'timing-worker.js', 'ttml.js', 'updates.js', 'upnext.js', 'shaka-player.compiled.js',
    'qrcode.js', 'boot.js', 'common.js', 'config.js', 'updater.js', 'service.js', 'launcher-build.js', 'builtin.js', 'nacl-fast.js'];
  var CATEGORIES = { TypeError: 'type_error', ReferenceError: 'reference_error', RangeError: 'range_error', SyntaxError: 'syntax_error' };
  var jsSeen = {};

  /**
   * A script error: its category, file and line only (a message could hold a title or a secret). An event with
   * diagnostics on (once per run each); nothing with diagnostics off.
   */
  function jsError(category, file, line) {
    try {
      var base = String(file || '').split(/[?#]/)[0].split('/').pop();
      var source = !file ? 'unknown' : SOURCES.indexOf(base) >= 0 ? base : 'other';
      var f = { error_category: category, source_file: source };
      if (line >= 1 && line <= 1000000) f.line = Math.floor(line);
      if (!enabled()) return;
      var key = category + '|' + source + '|' + (f.line || '');
      if (jsSeen[key]) return;
      jsSeen[key] = true;
      event('js.error', f, 'error');
    } catch (e) { /* never in the way */ }
  }

  try {
    window.addEventListener('error', function (ev) {
      if (!ev || !ev.message) return;   // a failed <img> has no message
      var name = ev.error && ev.error.name;
      jsError(CATEGORIES[name] || 'uncaught_error', ev.filename, ev.lineno);
    });
    window.addEventListener('unhandledrejection', function () { jsError('unhandled_rejection', null, null); });
  } catch (e) { /* no window */ }

  // Anonymous crash reports (POST /crashes) were sent by apps before the TV's unit, with diagnostics off too. Now crash
  // reports go only with diagnostics on, as events; what an older version left waiting is forgotten, never sent.
  try { localStorage.removeItem('f1tv.diag.crashes'); } catch (e) { /* none */ }

  // ---- the TV's unit and the anonymous app-use count ----------------------------------------------

  /**
   * The TV's unit, sent with every upload (`unit`): SHA-256 of an app-specific prefix and the TV's own device ID
   * (Samsung's DUID), the first 32 hex digits. Not the device ID itself; the same for this TV after "Delete my
   * diagnostics data" and a new yes (a new secret), or a reinstall, so the server counts it as one TV. Without a device
   * ID (a browser, another platform), a random one kept in storage, also across deletion. Not a credential: the secret
   * stays the only one.
   */
  var UNIT_KEY = 'f1tv.diag.unit', unitValue;
  function unit() {
    if (unitValue !== undefined) return unitValue;
    unitValue = null;
    try {
      var duid = String(webapis.productinfo.getDuid() || '');
      if (/^[\x21-\x7E]{8,128}$/.test(duid)) {
        var text = unescape(encodeURIComponent('f1tv-tizen unit v1:' + duid)), bytes = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        unitValue = sha256(bytes).slice(0, 32);
      }
    } catch (e) { /* no device ID */ }
    if (!unitValue) {
      var kept = load(UNIT_KEY);
      if (typeof kept === 'string' && /^[0-9a-f]{32}$/.test(kept)) unitValue = kept;
      else if (cryptoOk()) {
        var r = new Uint8Array(16), hex = '';
        window.crypto.getRandomValues(r);
        for (var j = 0; j < 16; j++) hex += ('0' + r[j].toString(16)).slice(-2);
        if (store(UNIT_KEY, hex)) unitValue = hex;
      }
    }
    return unitValue;
  }

  /**
   * How many use the app, and the share with diagnostics on: once the viewer has answered the diagnostics question (new
   * viewers who haven't been asked would skew the share), an app kept open USE_AFTER counts once (POST /starts) with
   * only the app version and whether diagnostics are on. No ID or unit, nothing from the TV; the server counts per day.
   * Not from personal builds (DIAG_BUILD.label: the developer's TVs).
   */
  var USE_AFTER = 15 * 60000;
  function countUse() {
    try {
      if (!BASE || (typeof DIAG_BUILD !== 'undefined' && DIAG_BUILD && DIAG_BUILD.label)) return;
      setTimeout(function () {
        try {
          if (typeof Settings === 'undefined' || !Settings.get('diagnosticsAsked')) return;
          var v = app().version;
          var body = JSON.stringify({ schema_version: 1, version: /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : 'unknown', diagnostics: enabled() });
          request('POST', '/starts', body, null, null, false).then(function () {}, function () {});
        } catch (e) { /* never in the way */ }
      }, USE_AFTER);
    } catch (e) { /* never in the way */ }
  }

  /** The settings a problem report includes, each mapped to the contract's values. */
  function reportSettings() {
    var g = function (k) { try { return Settings.get(k); } catch (e) { return null; } };
    var audio = String(g('audio') || '').toLowerCase(), AUDIO = ['eng', 'deu', 'fra', 'nld', 'por', 'jpn', 'spa', 'ita', 'teamradio', 'fx'];
    var mv = g('multiview');
    return { hdr: !!g('hdr'), multiview_layout: VOCAB.layouts.indexOf(mv) >= 0 ? mv : mv ? 'other' : 'unknown', timing: !!g('timing'),
      spoiler_free: !!g('spoilerFree'), audio: AUDIO.indexOf(audio) >= 0 ? audio : audio ? 'other' : null,
      subtitles: !!g('subtitles'), update_checks: g('updates') === 'automatic' };
  }

  // ---- start ---------------------------------------------------------------------------------------

  /** No upload while a video starts (it competes for the network and the CPU). */
  function quiet(ms) { quietUntil = Math.max(quietUntil, Date.now() + (ms || QUIET_AFTER_START_MS)); }

  try {
    if (enabled()) {
      startSession();
      // A first round within a minute, at a random moment (race starts bring many TVs at once).
      schedule(randomDelay(10000, 60000));
    }
    if (deletionPending()) retryDeletionLater();
    countUse();
    // What was collected in the last second goes to storage before the app is hidden or closed.
    var save = function () { saveQueue(); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });
  } catch (e) { /* never in the way */ }

  return {
    event: event, attemptId: attemptId, mode: mode, apiFailed: apiFailed, tier: tier, currentTier: currentTier, account: account,
    available: function () { return !!BASE; }, caps: caps, started: started, launcherFailed: launcherFailed, jsError: jsError, enabled: enabled, setEnabled: setEnabled,
    deleteMyData: deleteMyData, deletionPending: deletionPending, stopped: function () { return !!state.stopped; },
    report: report, lastReference: function () { return state.lastReference || null; }, categories: REPORT_CATEGORIES, id: id,
    quiet: quiet, covers: covers, flush: flush, hasData: hasData, explanation: EXPLANATION, vocab: VOCAB, unit: unit,
    // For tests and DevTools.
    sha256: sha256, status: function () {
      return { mode: mode(), queued: queue().length, pending: !!pendingBatch(), failures: state.failures || 0, stopped: state.stopped || null,
        nextAt: nextAt || null, retryAt: state.retryAt || null, dropped: state.dropped || {}, deletions: deletions().length, id: id() };
    }
  };
})();
