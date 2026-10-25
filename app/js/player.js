/*
 * AVPlay handles CBCS streams; Shaka handles clear replays with background feed switching.
 * License requests include F1's required headers.
 */
var Player = (function () {
  var engine = null;
  var engineName = null;
  var listeners = {};
  var els = { video: null, av: null };

  function emit(name, arg) { if (listeners[name]) listeners[name](arg); }

  // Shaka reports two-letter languages, AVPlay three-letter ones; settings may hold either.
  var LANG3 = { en: 'eng', de: 'deu', fr: 'fra', nl: 'nld', pt: 'por', ja: 'jpn', es: 'spa', it: 'ita' };
  function lang3(l) { return LANG3[l] || l; }
  function sameLang(a, b) { return !!a && !!b && lang3(a) === lang3(b); }

  // Shaka (MSE/EME)

  var ShakaEngine = (function () {
    // Preload on the idle player, paused: the TV can only decode one video at a time.
    var slots = [];
    var cur = 0;
    var licenseHeaders = {};
    var userPaused = false;
    var swapping = false;   // a feed switch is under way; the outgoing feed stays current until it is done

    function P() { return slots[cur].p; }
    function V() { return slots[cur].v; }

    function makeSlot(video) {
      var player = new shaka.Player();
      var slot = { p: player, v: video };
      return player.attach(video).then(function () {
        player.getNetworkingEngine().registerRequestFilter(function (type, request) {
          if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
            Object.keys(licenseHeaders).forEach(function (k) {
              if (licenseHeaders[k]) request.headers[k] = licenseHeaders[k];
            });
          }
        });
        player.addEventListener('error', function (ev) { if (slots[cur] === slot) emit('error', describe(ev.detail)); });
        player.addEventListener('buffering', function (ev) { if (slots[cur] === slot) emit('buffering', ev.buffering); });
        video.addEventListener('ended', function () { if (slots[cur] === slot && !swapping) emit('ended'); });
        return slot;
      });
    }

    function init() {
      shaka.polyfill.installAll();
      // No autoplay: an element that starts by itself grabs the TV's single video decoder.
      els.video.autoplay = false;
      var second = els.video.cloneNode(false);
      second.id = 'video2';
      second.classList.add('hidden');
      els.video.parentNode.insertBefore(second, els.video.nextSibling);
      return Promise.all([makeSlot(els.video), makeSlot(second)]).then(function (s) { slots = s; });
    }

    function describe(err) {
      if (!err) return 'Unknown playback error';
      if (err.category === shaka.util.Error.Category.DRM) return 'DRM error ' + err.code;
      return 'Playback error ' + err.code + (err.data && err.data[0] ? ': ' + String(err.data[0]).slice(0, 120) : '');
    }

    function configure(player, stream) {
      licenseHeaders = stream.licenseHeaders || {};
      var drm = stream.licenseUrl ? { servers: { 'com.widevine.alpha': stream.licenseUrl } } : {};
      player.resetConfiguration();
      player.configure({
        drm: drm,
        // Keep recent video for backward seeks. A 10 Mbit/s estimate starts F1 streams at 1080p.
        streaming: { bufferingGoal: 30, rebufferingGoal: 1, bufferBehind: 90,
          retryParameters: { maxAttempts: 4, baseDelay: 1000, backoffFactor: 2 } },
        abr: { enabled: true, defaultBandwidthEstimate: 10000000, useNetworkInformation: false, switchInterval: 4 },
        manifest: { hls: { ignoreManifestProgramDateTime: false } }
      });
    }

    function applyPrefs(player) {
      try { player.selectAudioLanguage(langOf(Settings.get('audio'))); } catch (e) { /* single track */ }
      textTrack(player, Settings.get('subtitles'));
    }

    function load(stream, startTime) {
      var slot = slots[cur];
      configure(slot.p, stream);
      slot.v.muted = false;
      slot.v.classList.remove('hidden');
      userPaused = false;
      return slot.p.load(stream.url, startTime == null ? null : startTime).then(function () {
        applyPrefs(slot.p);
        // Resetting another video element can cancel play(); keepPlaying retries it.
        var started = slot.v.play();
        keepPlaying(slot.v, 5000);
        return started && started.catch(function () {});
      });
    }

    /** Resolves once `seconds` of video are buffered ahead of the playhead (or after a timeout). */
    function whenBuffered(slot, seconds, ms) {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        (function check() {
          var info = slot.p.getBufferedInfo(), v = info && info.video && info.video[0];
          var ahead = v ? v.end - Math.max(v.start, slot.v.currentTime) : 0;
          if (ahead >= seconds || Date.now() - t0 > ms) return resolve();
          setTimeout(check, 100);
        })();
      });
    }

    /** Resolves when the video shows frames (its 'playing' event), or after a timeout. */
    function whenPlaying(v, ms) {
      return new Promise(function (resolve) {
        if (!v.paused && v.readyState >= 3) return resolve();
        var done = function () { v.removeEventListener('playing', done); clearTimeout(timer); resolve(); };
        var timer = setTimeout(done, ms);
        v.addEventListener('playing', done);
      });
    }

    /** Unloading the old player can pause the new one. Resume unless the viewer paused it. */
    function keepPlaying(v, ms, beforeSwap) {
      var until = Date.now() + (ms || 2500);
      (function check() {
        if ((!beforeSwap && V() !== v) || userPaused || Date.now() > until) return;
        if (v.paused) v.play().catch(function () {});
        setTimeout(check, 150);
      })();
    }

    function swap(stream, startTime) {
      var old = slots[cur], next = slots[1 - cur];
      configure(next.p, stream);
      next.v.muted = true;
      swapping = true;
      return next.p.load(stream.url, startTime == null ? null : startTime).then(function () {
        return whenBuffered(next, 4, 6000);
      }).then(function () {
        applyPrefs(next.p);
        old.v.style.zIndex = '2';           // keep the old picture on top until the new one runs
        next.v.style.zIndex = '1';
        next.v.classList.remove('hidden');
        return next.v.play().catch(function () { /* paused by the TV; whenPlaying retries below */ });
      }).then(function () {
        keepPlaying(next.v, 3000, true);
        return whenPlaying(next.v, 3000);
      }).then(function () {
        next.v.muted = false;
        cur = 1 - cur;
        swapping = false;
        userPaused = false;
        old.v.classList.add('hidden');
        old.v.style.zIndex = '';
        next.v.style.zIndex = '';
        old.p.unload().then(function () { keepPlaying(next.v); });
        keepPlaying(next.v);
      }, function (err) {
        swapping = false;
        next.v.classList.add('hidden');
        next.p.unload();
        old.v.style.zIndex = '';
        throw err;
      });
    }

    var LANG2 = { eng: 'en', deu: 'de', fra: 'fr', nld: 'nl', por: 'pt', jpn: 'ja', spa: 'es', ita: 'it' };
    function langOf(l) { return LANG2[l] || l; }

    function textTrack(player, l) {
      try {
        if (l) player.selectTextLanguage(langOf(l));
        player.setTextTrackVisibility(!!l);
      } catch (e) { /* no text tracks */ }
    }

    function tracks() {
      var lang = function (l) { return { lang: lang3(l) }; };
      return { audio: P().getAudioLanguages().map(lang), text: P().getTextLanguages().map(lang) };
    }

    function unload() {
      licenseHeaders = {};
      slots.forEach(function (s) { s.v.classList.add('hidden'); s.v.style.zIndex = ''; });
      return Promise.all(slots.map(function (s) { return s.p.unload(); }));
    }

    return {
      init: init,
      load: load,
      swap: swap,
      tracks: tracks,
      setAudio: function (l) { try { P().selectAudioLanguage(langOf(l)); } catch (e) { /* single track */ } },
      setSubtitles: function (l) { textTrack(P(), l); },
      unload: unload,
      isLive: function () { return P().isLive(); },
      range: function () { return P().seekRange(); },
      position: function () { return V().currentTime; },
      bufferedEnd: function () { var b = V().buffered; return b.length ? b.end(b.length - 1) : 0; },
      seekTo: function (t, done) { V().currentTime = t; if (done) done(); },
      paused: function () { return V().paused; },
      play: function () { userPaused = false; V().play(); },
      pause: function () { userPaused = true; V().pause(); }
    };
  })();

  // Samsung AVPlay

  var AvEngine = (function () {
    var av = null;
    var stream = null;
    var live = false;
    var isPaused = false;
    var posMs = 0;
    var startAt = null;

    function b64ToBytes(b64) {
      var bin = atob(b64), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function bytesToB64(buf) {
      var bytes = new Uint8Array(buf), bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    function onDrm(type, data) {
      if (!data) return;
      if (data.name === 'Challenge') {
        fetch(stream.licenseUrl, {
          method: 'POST',
          headers: stream.licenseHeaders || {},
          body: b64ToBytes(data.challenge)
        }).then(function (res) {
          if (!res.ok) throw new Error('License server answered ' + res.status);
          return res.arrayBuffer();
        }).then(function (lic) {
          var param = data.session_id + 'PARAM_START_POSITION' + bytesToB64(lic) + 'PARAM_START_POSITION';
          av.setDrm('WIDEVINE_CDM', 'widevine_license_data', param);
        }).catch(function (e) { emit('error', 'License: ' + e.message); });
      } else if (data.name === 'DrmError') {
        emit('error', 'DRM error ' + (data.code || '') + ' ' + (data.message || ''));
      }
    }

    function trackList() {
      var out = { audio: [], text: [] };
      try {
        av.getTotalTrackInfo().forEach(function (t) {
          var info = {};
          try { info = JSON.parse(t.extra_info || '{}'); } catch (e) { /* keep empty */ }
          if (t.type === 'AUDIO') out.audio.push({ index: t.index, lang: info.language || '' });
          if (t.type === 'TEXT') out.text.push({ index: t.index, lang: info.track_lang || '' });
        });
      } catch (e) { /* not prepared yet */ }
      return out;
    }

    function selectAudio(lang) {
      var t = trackList().audio.filter(function (a) { return sameLang(a.lang, lang); })[0];
      if (t) try { av.setSelectTrack('AUDIO', t.index); } catch (e) { /* keep current */ }
    }

    function selectText(lang) {
      var t = lang && trackList().text.filter(function (x) { return sameLang(x.lang, lang); })[0];
      try {
        if (!t) { av.setSilentSubtitle(true); emit('subtitle', null); return; }
        av.setSelectTrack('TEXT', t.index);
        av.setSilentSubtitle(false);
      } catch (e) { /* subtitles unavailable in this state */ }
    }

    function load(s, startTime) {
      stream = s;
      av = webapis.avplay;
      startAt = startTime;
      // Encrypted live DASH goes through the local service, which fixes the audio segments.
      if (s.licenseUrl && /\.mpd(\?|$)/.test(s.url)) {
        var langs = { audio: lang3(Settings.get('audio')), text: lang3(Settings.get('subtitles')) };
        return StreamProxy.ensure().then(function () { return open(s, StreamProxy.manifest(s.url, s.startDelay, langs)); });
      }
      return open(s, s.url);
    }

    var preparing = null;   // settles when the current prepareAsync has finished either way

    function open(s, url) {
      isPaused = false;
      posMs = 0;
      els.av.classList.remove('hidden');
      document.body.classList.add('avplay');
      return new Promise(function (resolve, reject) {
        av.open(url);
        openedAt = Date.now();
        quietUntil = openedAt + 6000;
        av.setListener({
          onbufferingstart: function () { emit('buffering', true); noteBuffering(s); },
          onbufferingcomplete: function () { emit('buffering', false); },
          oncurrentplaytime: function (ms) { posMs = ms; noteSmooth(s); },
          onstreamcompleted: function () { emit('ended'); },
          onerror: function (e) { emit('error', 'Player error: ' + e); },
          onsubtitlechange: function (duration, text) {
            emit('subtitle', { text: String(text || '').replace(/\u0000/g, '').trim(), ms: +duration || 3000 });
          },
          ondrmevent: onDrm
        });
        if (s.licenseUrl) {
          av.setDrm('WIDEVINE_CDM', 'SetProperties', JSON.stringify({ AppSession: 'f1tv-' + Date.now() }));
        }
        tune();
        av.setDisplayRect(0, 0, 1920, 1080);
        av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        var settle;
        preparing = new Promise(function (r) { settle = r; });
        function prepare() {
          if (stream !== s) { settle(); return reject(new Error('cancelled')); }
          av.prepareAsync(function () {
            settle();
            // Unloaded or replaced while preparing: don't start (unload() closes the player).
            if (stream !== s) return reject(new Error('cancelled'));
            var d = av.getDuration();
            live = s.info ? s.info.dynamic : (!!s.live || !d || d <= 0);
            selectAudio(Settings.get('audio'));
            // Live streams start where the manifest's presentation delay puts them (see StreamProxy.manifest).
            av.play();
            ensurePlaying(s);
            applyTextWhenPlaying(s);
            if (startAt != null && !live && !seekFirst) seek(startAt * 1000, null, 16);
            resolve();
          }, function (e) { settle(); reject(new Error(stream !== s ? 'cancelled' : 'Could not open stream: ' + e)); });
        }
        // Seek before preparation to avoid briefly showing the beginning of a resumed replay.
        var seekFirst = startAt != null && !(s.info ? s.info.dynamic : s.live);
        if (!seekFirst) return prepare();
        posMs = startAt * 1000;
        try {
          av.seekTo(Math.round(startAt * 1000), prepare, function () { seekFirst = false; prepare(); });
        } catch (e) { seekFirst = false; prepare(); }
      });
    }

    // Samsung requires at least 4 s of buffering after a seek.
    var tuning = { resumeBuffer: 4 };

    function tune() {
      try { av.setStreamingProperty('ADAPTIVE_INFO', 'STARTBITRATE=' + START_LEVELS[startLevel()]); } catch (e) { /* keep default */ }
      try {
        if (tuning.resumeBuffer) av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', tuning.resumeBuffer);
      } catch (e) { /* older firmware: keep defaults */ }
    }

    /*
     * AVPlay's default starts blurry for 25-30 s. The highest bitrate (6 Mbit/s) starts just as
     * fast in testing. Lower the next start's quality after an early stall; raise it after
     * several minutes of smooth playback.
     */
    var START_LEVELS = ['HIGHEST', 'AVERAGE', 'LOWEST'];
    var LEVEL_KEY = 'f1tv.startLevel';
    var openedAt = 0, quietUntil = 0, levelNoted = null;

    function startLevel() {
      try { return Math.min(2, Math.max(0, +localStorage.getItem(LEVEL_KEY) || 0)); } catch (e) { return 0; }
    }

    function setStartLevel(l) {
      try { localStorage.setItem(LEVEL_KEY, String(l)); } catch (e) { /* storage unavailable */ }
    }

    /** Buffering while playing (not right after opening or a seek) soon after the start: a stall. */
    function noteBuffering(s) {
      if (levelNoted === s || isPaused || Date.now() < quietUntil || Date.now() - openedAt > 90000) return;
      levelNoted = s;
      setStartLevel(Math.min(2, startLevel() + 1));
    }

    function noteSmooth(s) {
      if (levelNoted === s || Date.now() - openedAt < 180000) return;
      levelNoted = s;
      if (startLevel() > 0) setStartLevel(startLevel() - 1);
    }

    /** AVPlay's own DVR window for live streams in seconds ({ start, end }), or null. */
    function liveWindow() {
      try {
        var parts = String(av.getStreamingProperty('GET_LIVE_DURATION')).split('|');
        var a = +parts[0] / 1000, b = +parts[1] / 1000;
        return a > 0 && b > a ? { start: a, end: b } : null;
      } catch (e) { return null; }
    }

    /** AVPlay silently ignores out-of-window seeks; leave a margin at each end. */
    function clampLive(t) {
      var w = live && liveWindow();
      return w ? Math.max(w.start + 10, Math.min(w.end - 5, t)) : t;
    }

    /**
     * The proxy puts preferred subtitles first. Check other streams after playback starts;
     * AVPlay ignores track changes before then.
     */
    function applyTextWhenPlaying(s) {
      var want = Settings.get('subtitles');
      try { av.setSilentSubtitle(!want); } catch (e) { /* not ready */ }
      setTimeout(function () {
        if (stream !== s || !want) return;
        var cur = null;
        try { cur = av.getCurrentStreamInfo().filter(function (t) { return t.type === 'TEXT'; })[0]; } catch (e) { return; }
        var info = {};
        try { info = JSON.parse((cur && cur.extra_info) || '{}'); } catch (e) { /* unknown */ }
        if (!sameLang(info.track_lang, want)) selectText(want);
      }, 1200);
    }

    /** Re-issues play() if AVPlay stays READY/PAUSED after starting (and the viewer didn't pause). */
    function ensurePlaying(s) {
      var tries = 0;
      (function check() {
        if (stream !== s || isPaused || ++tries > 8) return;
        var st = '';
        try { st = av.getState(); } catch (e) { return; }
        if (st === 'READY' || st === 'PAUSED') { try { av.play(); } catch (e) { /* retry */ } }
        if (st !== 'PLAYING') setTimeout(check, 700);
      })();
    }

    var seekGen = 0;

    /**
     * AVPlay briefly rejects seeks after starting. Retry InvalidValuesError until superseded
     * by a newer seek or stream; report completion through done(ok).
     */
    function seek(ms, done, maxTries) {
      var gen = ++seekGen, s = stream, tries = 0;
      quietUntil = Date.now() + 6000;
      posMs = Math.max(0, clampLive(ms / 1000) * 1000);
      (function attempt() {
        if (gen !== seekGen || s !== stream) return;
        try {
          av.seekTo(Math.round(posMs), function () { if (gen === seekGen && done) done(true); }, function (e) {
            if (gen !== seekGen || s !== stream) return;
            if (e && e.name === 'InvalidValuesError' && ++tries < (maxTries || 8)) return setTimeout(attempt, 500);
            if (done) done(false);
          });
        } catch (e) {
          if (done) done(false);
        }
      })();
    }

    // Closing AVPlay during prepareAsync can crash the native player; wait for it to finish.
    function unload() {
      var wait = preparing || Promise.resolve();
      stream = null;
      els.av.classList.add('hidden');
      document.body.classList.remove('avplay');
      return wait.then(function () {
        try { if (av) av.stop(); } catch (e) { /* not started */ }
        try { if (av) av.close(); } catch (e) { /* already closed */ }
        preparing = null;
      });
    }

    function range() {
      var info = stream && stream.info;
      var w = live && liveWindow();
      // The real live edge (wall clock minus the presentation delay), also when the stream is
      // time-shifted behind it.
      var edge = live && info ? Date.now() / 1000 - info.epochAtZero - info.delay : null;
      if (w) return { start: w.start + 10, end: Math.max(w.end, edge || 0, posMs / 1000) };
      if (edge != null) return { start: info.windowStart, end: Math.max(edge, posMs / 1000) };
      if (live) return { start: Math.max(0, posMs / 1000 - 3600), end: posMs / 1000 };
      return { start: 0, end: av.getDuration() / 1000 };
    }

    return {
      init: function () { return Promise.resolve(); },
      load: load,
      unload: unload,
      isLive: function () { return live; },
      range: range,
      position: function () { return posMs / 1000; },
      bufferedEnd: function () { return posMs / 1000; },
      seekTo: function (t, done) { seek(t * 1000, done); },
      paused: function () { return isPaused; },
      play: function () { av.play(); isPaused = false; },
      pause: function () { av.pause(); isPaused = true; },
      tracks: trackList,
      setAudio: selectAudio,
      setSubtitles: selectText,
      grid: function () {
        var i = stream && stream.info;
        return !live && i && i.segDur >= 10 ? { size: i.segDur, origin: i.windowStart || 0 } : null;
      },
      tuning: tuning
    };
  })();

  // public interface

  var engines = { shaka: ShakaEngine, avplay: AvEngine };

  function hasAvPlay() {
    return typeof webapis !== 'undefined' && !!webapis.avplay;
  }

  function init(videoEl, avEl) {
    els.video = videoEl;
    els.av = avEl;
    return ShakaEngine.init();
  }

  /**
   * AVPlay starts long-segment videos in ~2 s; Shaka needs the whole first segment but can
   * preload feed switches. Use Shaka for clear multi-feed replays.
   */
  function choose(stream) {
    if (Player.forceEngine) return engines[Player.forceEngine];
    if (!hasAvPlay()) return ShakaEngine;
    return stream.licenseUrl || !stream.multiFeed ? AvEngine : ShakaEngine;
  }

  var current = null;

  function load(stream, startTime) {
    current = stream;
    return unload().then(function () {
      engine = choose(stream);
      engineName = engine === AvEngine ? 'avplay' : 'shaka';
      return engine.load(stream, startTime);
    });
  }

  function unload() {
    var e = engine;
    engine = null;
    return e ? e.unload() : Promise.resolve();
  }

  /** Seeks to an absolute position (player seconds), clamped to the seekable range. */
  function seekTo(sec, done) {
    if (!engine) return;
    var r = engine.range();
    engine.seekTo(Math.max(r.start, Math.min(r.end - 1, sec)), done);
  }

  function seekBy(sec) {
    if (engine) seekTo(engine.position() + sec);
  }

  /** Unix seconds shown at a player position, when the stream's timeline is wall-clock based. */
  function wallClock(pos, info) {
    info = info || (current && current.info);
    if (!info) return null;
    var marks = info.marks;
    if (marks && marks.length) {
      var m = marks[0];
      for (var i = 1; i < marks.length && marks[i].pos <= pos; i++) m = marks[i];
      return m.wall + (pos - m.pos);
    }
    return info.epochAtZero > 1e9 ? info.epochAtZero + pos : null;
  }

  /** Inverse of wallClock: the player position of a Unix time in a stream, or null. */
  function positionAt(wall, info) {
    if (!info) return null;
    var marks = info.marks;
    if (marks && marks.length) {
      var m = marks[0];
      for (var i = 1; i < marks.length && marks[i].wall <= wall; i++) m = marks[i];
      return m.pos + (wall - m.wall);
    }
    return info.epochAtZero > 1e9 ? wall - info.epochAtZero : null;
  }

  function switchTo(stream, startTime) {
    if (engine === ShakaEngine && choose(stream) === ShakaEngine) {
      current = stream;
      return ShakaEngine.swap(stream, startTime);
    }
    return load(stream, startTime);
  }

  function togglePause() {
    if (!engine) return;
    if (engine.paused()) engine.play(); else engine.pause();
  }

  function proxy(fn, fallback) {
    return function () { return engine ? engine[fn]() : fallback; };
  }

  return {
    init: init,
    load: load,
    unload: unload,
    seekBy: seekBy,
    seekTo: seekTo,
    switchTo: switchTo,
    avTuning: AvEngine.tuning,
    wallClock: wallClock,
    positionAt: positionAt,
    stream: function () { return current; },
    togglePause: togglePause,
    isLive: proxy('isLive', false),
    isPaused: proxy('paused', false),
    range: proxy('range', { start: 0, end: 0 }),
    position: proxy('position', 0),
    bufferedEnd: proxy('bufferedEnd', 0),
    engineName: function () { return engineName; },
    /**
     * Long-segment replays on AVPlay (30 s segments): { size, origin } of the segment grid. A seek
     * to a segment start plays in ~3 s; one deep inside a segment can take 10 s.
     */
    seekGrid: function () { return engine === AvEngine ? AvEngine.grid() : null; },
    tracks: function () { return engine ? engine.tracks() : { audio: [], text: [] }; },
    setAudio: function (l) { if (engine) engine.setAudio(l); },
    setSubtitles: function (l) { if (engine) engine.setSubtitles(l); },
    forceEngine: null,
    on: function (name, fn) { listeners[name] = fn; }
  };
})();
