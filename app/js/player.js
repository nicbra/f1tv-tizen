/*
 * Playback with two engines behind one interface:
 *  - 'avplay': Samsung's native player (webapis.avplay). Handles F1 TV's CBCS-encrypted
 *    Widevine streams; the app answers the license challenge itself so it can add F1's headers.
 *  - 'shaka':  Shaka Player on MSE/EME. Fine for clear HLS and CENC content.
 */
var Player = (function () {
  var engine = null;          // active engine object
  var engineName = null;
  var listeners = { error: null, buffering: null };
  var els = { video: null, av: null };

  function emit(name, arg) { if (listeners[name]) listeners[name](arg); }

  // Shaka reports two-letter languages, AVPlay three-letter ones; settings may hold either.
  var LANG3 = { en: 'eng', de: 'deu', fr: 'fra', nl: 'nld', pt: 'por', ja: 'jpn', es: 'spa', it: 'ita' };
  function lang3(l) { return LANG3[l] || l; }
  function sameLang(a, b) { return !!a && !!b && lang3(a) === lang3(b); }

  // ---------- Shaka (MSE/EME) ----------

  var ShakaEngine = (function () {
    // Two players: a feed switch loads the next stream paused on the idle one while the current
    // keeps playing (the TV decodes only one video at a time), then they swap.
    var slots = [];
    var cur = 0;
    var licenseHeaders = {};
    var robustness = '';
    var userPaused = false;

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
      var drm = {};
      if (stream.licenseUrl) {
        drm.servers = { 'com.widevine.alpha': stream.licenseUrl };
        if (robustness) drm.advanced = { 'com.widevine.alpha': { videoRobustness: robustness, audioRobustness: 'SW_SECURE_CRYPTO' } };
      }
      player.resetConfiguration();
      player.configure({
        drm: drm,
        // Start on a mid quality and a small buffer so playback begins quickly; ABR then climbs to 1080p.
        streaming: { bufferingGoal: 30, rebufferingGoal: 1, bufferBehind: 30,
          retryParameters: { maxAttempts: 4, baseDelay: 1000, backoffFactor: 2 } },
        abr: { enabled: true, defaultBandwidthEstimate: 2500000, switchInterval: 4 },
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
        // play() can be cancelled by the TV right after another video element was reset;
        // keepPlaying retries until it runs.
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

    /**
     * Resetting one video element makes the TV's resource manager pause the other one, so after
     * the old player is unloaded the new one is resumed unless the viewer paused it.
     */
    function keepPlaying(v, ms) {
      var until = Date.now() + (ms || 2500);
      (function check() {
        if (V() !== v || userPaused || Date.now() > until) return;
        if (v.paused) v.play().catch(function () {});
        setTimeout(check, 150);
      })();
    }

    /** Loads the next stream behind the current one and swaps once it plays. */
    function swap(stream, startTime) {
      var old = slots[cur], next = slots[1 - cur];
      configure(next.p, stream);
      next.v.muted = true;
      return next.p.load(stream.url, startTime == null ? null : startTime).then(function () {
        return whenBuffered(next, 4, 6000);
      }).then(function () {
        applyPrefs(next.p);
        old.v.style.zIndex = '2';           // keep the old picture on top until the new one runs
        next.v.style.zIndex = '1';
        next.v.classList.remove('hidden');
        return next.v.play().catch(function () { /* paused by the TV; whenPlaying retries below */ });
      }).then(function () {
        keepPlaying(next.v);
        return whenPlaying(next.v, 3000);
      }).then(function () {
        next.v.muted = false;
        cur = 1 - cur;
        userPaused = false;
        old.v.classList.add('hidden');
        old.v.style.zIndex = '';
        next.v.style.zIndex = '';
        old.p.unload().then(function () { keepPlaying(next.v); });
        keepPlaying(next.v);
      }, function (err) {
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
      setRobustness: function (r) { robustness = r || ''; },
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

  // ---------- Samsung AVPlay ----------

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
        av.setSilentSubtitle(false);
        av.setSelectTrack('TEXT', t.index);
      } catch (e) { /* subtitles unavailable */ }
    }

    function load(s, startTime) {
      stream = s;
      av = webapis.avplay;
      startAt = startTime;
      // Encrypted live DASH goes through the local service, which fixes the audio segments.
      if (s.licenseUrl && /\.mpd(\?|$)/.test(s.url)) {
        return Proxy.ensure().then(function () { return open(s, Proxy.manifest(s.url)); });
      }
      return open(s, s.url);
    }

    function open(s, url) {
      isPaused = false;
      posMs = 0;
      els.av.classList.remove('hidden');
      document.body.classList.add('avplay');
      return new Promise(function (resolve, reject) {
        av.open(url);
        av.setListener({
          onbufferingstart: function () { emit('buffering', true); },
          onbufferingcomplete: function () { emit('buffering', false); },
          oncurrentplaytime: function (ms) { posMs = ms; },
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
        av.setDisplayRect(0, 0, 1920, 1080);
        av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        av.prepareAsync(function () {
          var d = av.getDuration();
          live = s.info ? s.info.dynamic : (!!s.live || !d || d <= 0);
          selectAudio(Settings.get('audio'));
          selectText(Settings.get('subtitles'));
          av.play();
          if (startAt != null) seek(startAt * 1000);
          ensurePlaying(s);
          resolve();
        }, function (e) { reject(new Error('Could not open stream: ' + e)); });
      });
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

    // AVPlay rejects seeks (InvalidValuesError) for a moment after playback starts; retry.
    function seek(ms, done, tries) {
      posMs = Math.max(0, ms);
      av.seekTo(Math.round(posMs), done || function () {}, function () {
        if ((tries || 0) < 8) setTimeout(function () { seek(ms, done, (tries || 0) + 1); }, 700);
        else if (done) done();
      });
    }

    function unload() {
      try { av && av.stop(); av && av.close(); } catch (e) { /* already closed */ }
      els.av.classList.add('hidden');
      document.body.classList.remove('avplay');
      return Promise.resolve();
    }

    function range() {
      var info = stream && stream.info;
      if (live && info) {
        // The live edge keeps moving: wall clock minus the manifest's presentation delay.
        var edge = Date.now() / 1000 - info.epochAtZero - info.delay;
        return { start: info.windowStart, end: Math.max(edge, posMs / 1000) };
      }
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
      setSubtitles: selectText
    };
  })();

  // ---------- public interface ----------

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
   * Picks the engine: Samsung's AVPlay for encrypted streams and single-feed videos (it starts
   * long-segment videos in ~2 s where Shaka needs the whole first segment), Shaka for clear
   * multi-feed replays so feed switches can load in the background.
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

  /**
   * Switches to another stream. Clear streams on Shaka are preloaded while the current one keeps
   * playing, so the switch feels instant; otherwise it is a normal load.
   */
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
    tracks: function () { return engine ? engine.tracks() : { audio: [], text: [] }; },
    setAudio: function (l) { if (engine) engine.setAudio(l); },
    setSubtitles: function (l) { if (engine) engine.setSubtitles(l); },
    setShakaRobustness: ShakaEngine.setRobustness,
    forceEngine: null,
    on: function (name, fn) { listeners[name] = fn; }
  };
})();
