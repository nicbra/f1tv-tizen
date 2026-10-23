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

  // ---------- Shaka (MSE/EME) ----------

  var ShakaEngine = (function () {
    var p = null;
    var licenseHeaders = {};
    var robustness = '';

    function init() {
      shaka.polyfill.installAll();
      p = new shaka.Player();
      return p.attach(els.video).then(function () {
        p.getNetworkingEngine().registerRequestFilter(function (type, request) {
          if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
            Object.keys(licenseHeaders).forEach(function (k) {
              if (licenseHeaders[k]) request.headers[k] = licenseHeaders[k];
            });
          }
        });
        p.addEventListener('error', function (ev) { emit('error', describe(ev.detail)); });
        p.addEventListener('buffering', function (ev) { emit('buffering', ev.buffering); });
      });
    }

    function describe(err) {
      if (!err) return 'Unknown playback error';
      if (err.category === shaka.util.Error.Category.DRM) return 'DRM error ' + err.code;
      return 'Playback error ' + err.code + (err.data && err.data[0] ? ': ' + String(err.data[0]).slice(0, 120) : '');
    }

    function load(stream, startTime) {
      licenseHeaders = stream.licenseHeaders || {};
      var drm = {};
      if (stream.licenseUrl) {
        drm.servers = { 'com.widevine.alpha': stream.licenseUrl };
        if (robustness) drm.advanced = { 'com.widevine.alpha': { videoRobustness: robustness, audioRobustness: 'SW_SECURE_CRYPTO' } };
      }
      p.resetConfiguration();
      p.configure({
        drm: drm,
        streaming: { bufferingGoal: 30, rebufferingGoal: 2, bufferBehind: 30,
          retryParameters: { maxAttempts: 4, baseDelay: 1000, backoffFactor: 2 } },
        abr: { enabled: true, defaultBandwidthEstimate: 8000000 }
      });
      els.video.classList.remove('hidden');
      return p.load(stream.url, startTime == null ? null : startTime).then(function () {
        try { p.selectAudioLanguage('en'); } catch (e) { /* single track */ }
        return els.video.play();
      });
    }

    return {
      init: init,
      load: load,
      unload: function () { licenseHeaders = {}; els.video.classList.add('hidden'); return p.unload(); },
      setRobustness: function (r) { robustness = r || ''; },
      isLive: function () { return p.isLive(); },
      range: function () { return p.seekRange(); },
      position: function () { return els.video.currentTime; },
      bufferedEnd: function () { var b = els.video.buffered; return b.length ? b.end(b.length - 1) : 0; },
      seekTo: function (t, done) { els.video.currentTime = t; if (done) done(); },
      paused: function () { return els.video.paused; },
      play: function () { els.video.play(); },
      pause: function () { els.video.pause(); }
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

    function selectEnglishAudio() {
      try {
        var tracks = av.getTotalTrackInfo();
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i].type !== 'AUDIO') continue;
          var info = JSON.parse(tracks[i].extra_info || '{}');
          if (/^en/i.test(info.language || '')) { av.setSelectTrack('AUDIO', tracks[i].index); return; }
        }
      } catch (e) { /* keep default track */ }
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
          selectEnglishAudio();
          av.play();
          if (startAt != null) seek(startAt * 1000);
          resolve();
        }, function (e) { reject(new Error('Could not open stream: ' + e)); });
      });
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
      pause: function () { av.pause(); isPaused = true; }
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

  /** Picks the engine for a stream: AVPlay for Widevine where available, Shaka otherwise. */
  function choose(stream) {
    if (Player.forceEngine) return engines[Player.forceEngine];
    return stream.licenseUrl && hasAvPlay() ? AvEngine : ShakaEngine;
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
  function wallClock(pos) {
    var info = current && current.info;
    return info && info.epochAtZero > 1e9 ? info.epochAtZero + pos : null;
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
    wallClock: wallClock,
    stream: function () { return current; },
    togglePause: togglePause,
    isLive: proxy('isLive', false),
    range: proxy('range', { start: 0, end: 0 }),
    position: proxy('position', 0),
    bufferedEnd: proxy('bufferedEnd', 0),
    engineName: function () { return engineName; },
    setShakaRobustness: ShakaEngine.setRobustness,
    forceEngine: null,
    on: function (name, fn) { listeners[name] = fn; }
  };
})();
