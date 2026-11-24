/*
 * Playback attempts for the diagnostics upload (js/diag-upload.js), as the contract counts them:
 *
 * - An attempt is one thing the viewer asked for: a video, "start over", going live, a multiview layout. It ends once:
 *   playing (the picture moved), failed (after the app's own fallbacks) or cancelled (left or replaced first). That
 *   one row (playback.attempt_outcome) also says what F1 offered the account and whether multiview was possible.
 * - Each engine load inside it is a trial (playback.engine_attempt): the first, retries and fallbacks, with the engine,
 *   the path, how long until the picture moved, or the error. Feed switches only send a row when they fail.
 * - When a played attempt ends, playback.summary: watch time (bucketed), buffering and feed-switch counts and times.
 *
 * app.js tells it what happens through a handful of calls; nothing here touches playback. Off while diagnostics are off.
 */
var DiagPlay = (function () {
  var PROGRESS_S = 0.5, BUFFER_MS = 500, EXTRA_MS = 30000;
  var attempt = null, trial = null, seq = 0;

  function up() { return typeof DiagUpload !== 'undefined' && DiagUpload.enabled(); }
  function send(name, fields, level, id) { try { if (up()) DiagUpload.event(name, fields, level, id); } catch (e) { /* never in the way */ } }
  /** Durations come from a clock that never goes back (the TV may set its wall clock meanwhile). */
  function now() { try { return performance.now(); } catch (e) { return Date.now(); } }
  function ms(v) { return Math.max(0, Math.min(600000, Math.round(v))); }

  // The contract's values come from DiagUpload (nothing here runs without it).
  function vocab() { return DiagUpload.vocab; }
  function layout(v) { return v == null ? 'off' : vocab().layouts.indexOf(v) >= 0 ? v : 'other'; }

  function bucket(t) {
    var m = t / 60000;
    return m < 1 ? 'lt_1m' : m < 5 ? '1m_5m' : m < 30 ? '5m_30m' : m < 120 ? '30m_2h' : m < 360 ? '2h_6h' : 'gte_6h';
  }

  /** The engine and input actually used: Caps' path for protected video, else the engine with clear input. */
  function pathOf(stream, engine) {
    var p = stream && stream.capsPath;
    // The way it plays (Caps, js/ways.js): the contract names every one.
    if (!p && (engine === 'shaka' || engine === 'avplay') && stream && !stream.licenseUrl) p = engine + ':clear';
    return vocab().paths.indexOf(p) >= 0 ? p : p ? 'other' : 'unknown';
  }

  /** { code, platform } of a failure, from Player.errorInfo (structured, never display text). */
  function errorOf(err) {
    var CODES = vocab().codes;
    var info = err && err.code && CODES.indexOf(err.code) >= 0 && 'platform' in err ? err : null;
    try { if (!info && typeof Player !== 'undefined' && Player.errorInfo) info = Player.errorInfo(err); } catch (e) { /* unknown */ }
    info = info || { code: 'UNKNOWN', platform: null };
    var code = CODES.indexOf(info.code) >= 0 ? info.code : 'OTHER';
    var platform = typeof info.platform === 'string' && /^[A-Z0-9_]{1,64}$/.test(info.platform) ? info.platform : null;
    return { error_code: code, platform_code: platform };
  }

  function withCodes(fields, codes) {
    if (codes) { fields.error_code = codes.error_code; if (codes.platform_code) fields.platform_code = codes.platform_code; }
    return fields;
  }

  // ---- attempts ------------------------------------------------------------------------------

  function conclude(outcome, codes) {
    var a = attempt;
    if (!a || a.outcome) return;
    a.outcome = outcome;
    var f = { outcome: outcome, tier: a.tier, content: a.content, requested_layout: a.layout, fallbacks_used: Math.min(100, a.fallbacks) };
    if (a.feeds) f.available_feeds = Math.min(64, a.feeds);
    if (a.offer) f.offer = a.offer;
    if (outcome === 'playing') {
      f.playing_layout = layout(a.playingLayout);
      f.total_time_to_play_ms = ms(now() - a.at);
    }
    if (outcome === 'failed') withCodes(f, codes || { error_code: 'UNKNOWN' });
    send('playback.attempt_outcome', f, outcome === 'failed' ? 'error' : 'info', a.id);
  }

  /** The end of a played attempt: its summary, with the runtime failure that ended it, if one did. */
  function summarize() {
    var a = attempt;
    if (!a || a.outcome !== 'playing' || a.summarized) return;
    a.summarized = true;
    closeBuffering();
    if (a.switching) endSwitch();
    var f = { watch_duration_bucket: bucket(a.watchMs), buffering_count: Math.min(1000000, a.buffers),
      buffering_total_ms: Math.min(604800000, Math.round(a.bufferMs)), stream_switch_count: Math.min(1000000, a.switches),
      stream_switch_total_ms: Math.min(604800000, Math.round(a.switchMs)) };
    if (a.switches) f.stream_switch_max_ms = ms(a.switchMax);
    send('playback.summary', withCodes(f, a.runtimeError), a.runtimeError ? 'warn' : 'info', a.id);
  }

  function finish() {
    if (!attempt) return;
    if (!attempt.outcome) conclude('cancelled');
    summarize();
    attempt = null;
    trial = null;
  }

  /**
   * A load starts (app.js loadFeed). o: { layout (requested multiview layout or null), switching (a feed switch or
   * multiview change while playing), recover (one of the app's own retries or fallbacks), feeds, content, tier }.
   * Returns a token for the calls below (null while diagnostics are off).
   */
  function request(o) {
    try {
      if (!up()) { attempt = trial = null; return null; }
      o = o || {};
      var want = layout(o.layout);
      var a = attempt;
      var phase = 'start';
      // What plays now (a multiview may have fallen back to one feed), else what was asked for.
      var current = a && a.outcome === 'playing' && a.playingLayout ? layout(a.playingLayout) : a && a.layout;
      if (a && o.recover) {
        if (!a.outcome) a.fallbacks++;
        // Retrying a failed switch is still that switch (it ends when the new feed moves).
        else if (trial && trial.phase === 'switch') {
          phase = 'switch';
          if (a.switching) a.switching.failedAt = 0;
        }
      } else if (a && (o.switching || o.jump) && want === current && a.outcome === 'playing') {
        phase = 'switch';
        if (a.switching) endSwitch();   // the previous one never got its picture: it ends here
        a.switches++;
        a.switching = { at: now() };
      } else {
        finish();
        a = attempt = { id: DiagUpload.attemptId(), at: now(), layout: want, content: o.content || 'unknown', tier: o.tier || 'unknown',
          feeds: o.feeds || 0, fallbacks: 0, offer: null, outcome: null, watchMs: 0, buffers: 0, bufferMs: 0, switches: 0, switchMs: 0,
          switchMax: 0, switching: null, bufferSince: 0, playingLayout: null, runtimeError: null };
      }
      if (!a.id) { attempt = trial = null; return null; }
      trial = { n: ++seq, attempt: a, phase: phase, at: now(), engineAt: 0, base: null, last: null, engine: null, path: null,
        done: false, extra: false };
      return trial;
    } catch (e) { return null; }
  }

  /** Whether this load's attempt still needs its offer (so app.js works it out only once). */
  function wantsOffer(t) { return !!(t && !t.attempt.offer); }

  /** F1's offer for this load (the first main-feed offer of an attempt is kept): o = { offer } from app.js. */
  function offered(t, o) {
    try {
      if (!t || !o || !o.offer || t.attempt.offer) return;
      t.attempt.offer = o.offer;
    } catch (e) { /* never in the way */ }
  }

  /** The engine is about to load this stream (Player.load / switchTo): no upload while it starts. */
  function loading(t, stream) {
    if (!t) return;
    t.engineAt = now();
    t.stream = stream || null;
    try { DiagUpload.quiet(); } catch (e) { /* never in the way */ }
  }

  /** The load resolved: progress is measured from the position now. */
  function loaded(t, stream, position) {
    try {
      if (!t || t !== trial) return;
      t.engine = typeof Player !== 'undefined' ? Player.engineName() : null;
      t.path = pathOf(stream, t.engine);
      t.base = t.last = position || 0;
      t.attempt.playingLayout = stream && stream.grid ? stream.grid.layout : 'off';
      // An H.264 multiview plays once its small feeds show too (supplementary), not with the big feed alone.
      t.extra = !!(stream && stream.grid && stream.grid.engine === 'h264');
      // Switched while paused: no picture moves until the viewer plays, so the switch ends with the load.
      if (t.phase === 'switch' && typeof Player !== 'undefined' && Player.isPaused && Player.isPaused()) {
        t.done = true;
        endSwitch();
      }
    } catch (e) { /* never in the way */ }
  }

  function engineRow(t, outcome, codes) {
    if (t.done) return;
    t.done = true;
    var f = { phase: t.phase, engine: t.engine === 'shaka' || t.engine === 'avplay' || t.engine === 'mvsoft' ? t.engine : 'unknown',
      path: t.path || 'unknown', outcome: outcome };
    if (outcome === 'playing') f.time_to_progress_ms = ms(now() - (t.engineAt || t.at));
    if (outcome === 'failed') withCodes(f, codes);
    // Switches that work are counted in the summary; only their failures are rows.
    if (t.phase === 'switch' && outcome !== 'failed') return;
    send('playback.engine_attempt', f, outcome === 'failed' ? 'warn' : 'info', t.attempt.id);
  }

  /** The switch under way ends: when its picture moves, or when it failed (and no retry of it is under way). */
  function endSwitch() {
    var a = attempt;
    if (!a || !a.switching) return;
    var d = (a.switching.failedAt || now()) - a.switching.at;
    a.switchMs += d;
    a.switchMax = Math.max(a.switchMax, d);
    a.switching = null;
  }

  /**
   * Called often (the player bar's tick): the position moved PROGRESS_S past where the load left it while playing
   * means the trial plays. Also counts foreground watch time.
   */
  var lastTick = 0;
  function tick(position, paused, hidden) {
    try {
      var t = now(), dt = lastTick ? Math.min(2000, t - lastTick) : 0;
      lastTick = t;
      var a = attempt;
      if (!a) return;
      if (a.outcome === 'playing' && !paused && !hidden && !a.bufferSince) a.watchMs += dt;
      if (paused && a.bufferSince) a.bufferSince = 0;   // a pause is no buffering
      var tr = trial;
      if (!tr || tr.base == null) return;
      // A seek (or a jump while loading) moves the position by more than playing could: measure from there.
      var jumped = tr.last != null && Math.abs(position - tr.last) > 2 + dt / 1000;
      tr.last = position;
      if (jumped) { tr.base = position; return; }
      // An H.264 multiview's big feed moved: it plays once the small feeds show, or alone if they don't within 30 s.
      if (tr.moved && tr.extra && !a.outcome && now() - tr.movedAt > EXTRA_MS) { a.playingLayout = 'off'; conclude('playing'); }
      if (tr.done || paused) return;
      if (position > tr.base + PROGRESS_S) {
        engineRow(tr, 'playing');
        if (tr.phase === 'switch') endSwitch();
        tr.moved = true;
        tr.movedAt = now();
        if (!a.outcome && (!tr.extra || a.extraShown)) conclude('playing');
      }
    } catch (e) { /* never in the way */ }
  }

  /**
   * A trial failed: a load rejected, no picture in time (noProgress), or the engine failed while playing (runtime:
   * the summary keeps it). final: the app gives up on the attempt (no more fallbacks).
   */
  function failed(t, err, o) {
    try {
      o = o || {};
      t = t || trial;
      if (t && t !== trial) return;   // an older load, superseded meanwhile
      var codes = o.noProgress ? { error_code: 'NO_PROGRESS', platform_code: null } : errorOf(err);
      // A row only for an engine that was asked to load (a stream refused before that is no trial of an engine).
      if (t && !t.done && t.engineAt) {
        if (!t.engine && typeof Player !== 'undefined') t.engine = Player.engineName();
        if (!t.path && t.stream) t.path = pathOf(t.stream, t.engine);
        engineRow(t, 'failed', codes);
      }
      if (t) t.done = true;
      var a = (t && t.attempt) || attempt;
      if (!a) return;
      // A failed switch ends here, unless a retry of it follows (request with recover reopens it).
      if (t && t.phase === 'switch' && a.switching && !a.switching.failedAt) a.switching.failedAt = now();
      if (o.runtime && a.outcome === 'playing') a.runtimeError = codes;
      else if (o.final) conclude('failed', codes);
    } catch (e) { /* never in the way */ }
  }

  /**
   * The software decoder of an H.264 multiview's small feeds: its own trial in the attempt, which plays once they show.
   * o.final on a failure: no more tries, the big feed plays alone.
   */
  var extra = null;
  function supplementaryStart() { extra = trial ? { trial: trial, at: now() } : null; }
  function supplementary(outcome, err, o) {
    try {
      var x = extra, a = attempt;
      if (!x || !a || x.trial.attempt !== a) return;
      extra = null;
      var phase = x.trial.phase === 'switch' ? 'switch' : 'start';
      var f = { phase: phase, engine: 'mvsoft', path: 'mvsoft:h264', outcome: outcome };
      if (outcome === 'playing') {
        f.time_to_progress_ms = ms(now() - x.at);
        a.extraShown = true;
        if (!a.outcome && x.trial.moved) conclude('playing');
      } else {
        withCodes(f, errorOf(err && err.diag ? err : { diag: { code: 'DECODE_ERROR', platform: null } }));
        if (o && o.final) {
          a.playingLayout = 'off';
          if (!a.outcome && x.trial.moved) conclude('playing');
        }
      }
      if (phase === 'switch' && outcome !== 'failed') return;
      send('playback.engine_attempt', f, outcome === 'failed' ? 'warn' : 'info', a.id);
    } catch (e) { /* never in the way */ }
  }

  /** The app gave up before any engine ran (no offer, no session) or after its last fallback. t: that load's token. */
  function gaveUp(err, o, t) {
    try {
      var a = attempt;
      if (!a || (t && t.attempt !== a)) return;   // a load of an attempt that has ended meanwhile
      if (o && o.cancelled) return conclude('cancelled');
      var codes = err && err.noProgress ? { error_code: 'NO_PROGRESS', platform_code: null } : errorOf(err);
      if (a.outcome === 'playing') a.runtimeError = codes;
      else conclude('failed', codes);
    } catch (e) { /* never in the way */ }
  }

  /** Buffering reported by the player; counted once the attempt plays and no load, switch or jump is under way. */
  function buffering(on, busy) {
    var a = attempt;
    if (!a || a.outcome !== 'playing') return;
    if (on && !busy && (!a.switching || a.switching.failedAt) && !a.bufferSince) a.bufferSince = now();
    if (!on) closeBuffering();
  }

  function closeBuffering() {
    var a = attempt;
    if (!a || !a.bufferSince) return;
    var d = now() - a.bufferSince;
    a.bufferSince = 0;
    if (d >= BUFFER_MS) { a.buffers++; a.bufferMs += d; }
  }

  /** The viewer left the player: a pending attempt was cancelled; a played one gets its summary. */
  function leave() { try { finish(); } catch (e) { attempt = trial = null; } }

  /** A new consent epoch: nothing from before it is sent. */
  function reset() { attempt = trial = extra = null; lastTick = 0; }

  // The app hidden or closed while a video plays (power off, another app): its summary now, or never. Coming back,
  // the video carries on without one; its next attempt counts again.
  try {
    var away = function () { if (typeof document === 'undefined' || document.hidden !== false) leave(); };
    window.addEventListener('pagehide', leave);
    window.addEventListener('beforeunload', leave);
    document.addEventListener('visibilitychange', away);
  } catch (e) { /* no window */ }

  return {
    request: request, wantsOffer: wantsOffer, offered: offered, loading: loading, loaded: loaded, tick: tick, failed: failed, gaveUp: gaveUp,
    buffering: buffering, leave: leave, reset: reset, supplementaryStart: supplementaryStart, supplementary: supplementary,
    // For tests and DevTools.
    current: function () { return attempt && { id: attempt.id, outcome: attempt.outcome, layout: attempt.layout, fallbacks: attempt.fallbacks }; }
  };
})();
