/*
 * AVPlay handles CBCS streams; Shaka handles clear replays with background feed switching.
 * License requests include F1's required headers.
 */
var Player = (function () {
  var engine = null;
  var engineName = null;
  var listeners = {};
  var els = { video: null, av: null };

  /** Diagnostics log (js/diag.js), when it is loaded. */
  function diag(kind, data, level) { if (typeof Diag !== 'undefined') Diag.note(kind, data, level); }
  function diagTrail(kind, data) { if (typeof Diag !== 'undefined') Diag.trail(kind, data); }
  function kbps(bps) { return bps > 0 ? Math.round(bps / 1000) : null; }

  function emit(name, arg, extra) { if (listeners[name]) listeners[name](arg, extra); }

  // AVPlay's error types the diagnostics contract keeps as they are (others: AVPLAY_ERROR without a platform code).
  var AV_ERRORS = { PLAYER_ERROR_CONNECTION_FAILED: 'NETWORK_ERROR', PLAYER_ERROR_NOT_SUPPORTED_FORMAT: 'UNSUPPORTED',
    PLAYER_ERROR_NOT_SUPPORTED_FILE: 'UNSUPPORTED', PLAYER_ERROR_INVALID_STATE: 'AVPLAY_ERROR', PLAYER_ERROR_INVALID_OPERATION: 'AVPLAY_ERROR',
    PLAYER_ERROR_INVALID_PARAMETER: 'AVPLAY_ERROR', PLAYER_ERROR_NO_SUCH_FILE: 'AVPLAY_ERROR', PLAYER_ERROR_SEEK_FAILED: 'AVPLAY_ERROR',
    PLAYER_ERROR_NONE: 'AVPLAY_ERROR' };

  function avError(type) {
    var t = String(type == null ? '' : type).trim();
    return AV_ERRORS[t] ? { code: AV_ERRORS[t], platform: t } : { code: 'AVPLAY_ERROR', platform: null };
  }

  // Shaka's error categories (shaka.util.Error.Category): NETWORK 1, DRM 6; the rest is SHAKA_ERROR.
  var SHAKA_CODES = { 1: 'NETWORK_ERROR', 6: 'DRM_ERROR' };

  /**
   * A stable error code and the engine's own identifier for a playback failure, taken from the error itself, never
   * from display text: { code: 'SHAKA_ERROR' | 'AVPLAY_ERROR' | 'DRM_ERROR' | ..., platform: '6007' | 'PLAYER_ERROR_...' | null }.
   * Errors this app throws carry their own (`e.diag`); the HDR/helper ones are recognised by their fixed messages.
   */
  function errorInfo(e) {
    if (!e) return { code: 'UNKNOWN', platform: null };
    if (e.diag && e.diag.code) return e.diag;
    if (e.code === 'PREPARE_TIMEOUT' || e.code === 'PLAYER_STUCK') return { code: e.code, platform: null };
    if (typeof e.code === 'number' && typeof e.category === 'number') {
      // 4032: CONTENT_UNSUPPORTED_BY_BROWSER (no playable variant); 3016 with media error 3: MEDIA_ERR_DECODE.
      var shaka = e.code === 4032 ? 'UNSUPPORTED' : e.code === 3016 && e.data && e.data[0] === 3 ? 'DECODE_ERROR'
        : SHAKA_CODES[e.category] || 'SHAKA_ERROR';
      return { code: shaka, platform: e.code >= 0 && e.code % 1 === 0 ? String(e.code) : null };
    }
    if (typeof e === 'string' && /^PLAYER_ERROR_[A-Z_]+$/.test(e.trim())) return avError(e);
    if (e.name && /^PLAYER_ERROR_[A-Z_]+$/.test(e.name)) return avError(e.name);
    // An HTTP answer (F1's API): a server failure is a network problem; a refusal (4xx) is something else.
    if (typeof e.status === 'number') return { code: e.status >= 500 ? 'NETWORK_ERROR' : 'OTHER', platform: null };
    // This app's own fixed messages (never text from a server).
    var m = String(e.message || '');
    if (/^encrypted HDR stream$|^HDR: (?!media request failed)/.test(m)) return { code: 'UNSUPPORTED', platform: null };
    if (/^HDR: media request failed|^HDR preparation timed out/.test(m)) return { code: 'NETWORK_ERROR', platform: null };
    if (/^helper did not answer$|^Stream helper service did not start$|^Could not prepare (HDR manifest|multiview)$/.test(m)) return { code: 'HELPER_ERROR', platform: null };
    if (e instanceof TypeError && /fetch|network/i.test(m)) return { code: 'NETWORK_ERROR', platform: null };
    return { code: 'OTHER', platform: null };
  }

  // Shaka reports two-letter languages, AVPlay three-letter ones; settings may hold either. Team radio
  // is "tea" in the replays' HLS and "teamradio" on AVPlay.
  var LANG3 = { en: 'eng', de: 'deu', fr: 'fra', nl: 'nld', pt: 'por', ja: 'jpn', es: 'spa', it: 'ita', tea: 'teamradio' };
  function lang3(l) { return LANG3[l] || l; }
  function sameLang(a, b) { return !!a && !!b && lang3(a) === lang3(b); }

  // Shaka (MSE/EME)

  var ShakaEngine = (function () {
    // Preload on the idle player, paused: the TV can only decode one video at a time.
    var slots = [];
    var cur = 0;
    var reloadedAt = 0;   // when reloadIfFrozen last loaded a frozen start again
    var licenseHeaders = {};
    var userPaused = false;
    var swapping = false;   // a feed switch is under way; the outgoing feed stays current until it is done
    var generation = 0;     // bumped by every load, swap and unload, so late callbacks can tell they are stale

    /**
     * 4K HDR starts at the bandwidth this TV last measured on Shaka (70 %, 10-30 Mbit/s), so it can open at 2160p
     * rather than climbing from 1080p (the default 10 Mbit/s); SDR keeps the default.
     */
    var BW_KEY = 'f1tv.bandwidth';
    function startEstimate(slot, hdr) {
      var seen = 0;
      try { seen = +localStorage.getItem(BW_KEY) || 0; } catch (e) { /* no storage */ }
      slot.startedAt = hdr ? Math.max(10000000, Math.min(30000000, Math.round(seen * 0.7))) : 10000000;
      return slot.startedAt;
    }
    /** A slot's last measurement, slow ones too (the clamp applies when read); not Shaka's untouched start estimate. */
    function rememberBandwidth(slot) {
      try {
        var bw = slot && slot.p.getStats().estimatedBandwidth;
        if (bw > 0 && isFinite(bw) && Math.round(bw) !== slot.startedAt) localStorage.setItem(BW_KEY, String(Math.round(bw)));
      } catch (e) { /* no stats or storage */ }
    }
    function P() { return slots[cur].p; }
    function V() { return slots[cur].v; }

    /**
     * HLG must be a constraint, not just a preference: Shaka can otherwise select an SDR variant
     * from F1's mixed master after a seek or an adaptation, making the TV change picture modes.
     * Leave media playlists, audio, subtitles, clocks and signed URIs as supplied by F1.
     */
    function hlgMaster(master) {
      if (!/^#EXTM3U\s/.test(master) || !/^#EXT-X-STREAM-INF:/m.test(master)) return master;
      var lines = master.split(/\r?\n/), out = [], keep = true, variants = 0;
      lines.forEach(function (line) {
        if (/^#EXT-X-STREAM-INF:/.test(line)) {
          var range = '', re = /(?:^|,)\s*([\w-]+)=("[^"]*"|[^,]*)/g, m;
          while ((m = re.exec(line.slice(18)))) {
            if (m[1] === 'VIDEO-RANGE') range = m[2].replace(/^"|"$/g, '').trim();
          }
          keep = range === 'HLG';
          if (keep) { variants++; out.push(line); }
        } else if (/^#EXT-X-I-FRAME-STREAM-INF:/.test(line)) {
          // Trick-play renditions do not always declare their colour range.
        } else if (line.trim() && line.trim().charAt(0) !== '#') {
          if (keep) out.push(line);
          keep = true;
        } else {
          out.push(line);
        }
      });
      if (!variants) throw new Error('HDR playlist has no HLG variants');
      return out.join('\n');
    }

    function makeSlot(video) {
      var player = new shaka.Player();
      var slot = { p: player, v: video, hdr: false };
      return player.attach(video).then(function () {
        player.getNetworkingEngine().registerRequestFilter(function (type, request) {
          var types = shaka.net.NetworkingEngine.RequestType;
          // Key requests get the tokens only from F1's own server, whatever address a playlist names.
          var add = type === types.LICENSE ? licenseHeaders :
            type === types.KEY && /^https:\/\/f1tv\.formula1\.com\//.test(request.uris[0] || '') ? slot.keyHeaders : null;
          if (add) Object.keys(add).forEach(function (k) { if (add[k]) request.headers[k] = add[k]; });
        });
        player.getNetworkingEngine().registerResponseFilter(function (type, response) {
          if (!slot.hdr || type !== shaka.net.NetworkingEngine.RequestType.MANIFEST) return;
          var text = shaka.util.StringUtils.fromUTF8(response.data);
          response.data = shaka.util.StringUtils.toUTF8(hlgMaster(text));
        });
        // Only what stops playback is an error for the app: a recoverable one (Shaka switches variant or retries) is
        // noted, or a working stream would be given up and counted as failed.
        player.addEventListener('error', function (ev) {
          if (slots[cur] !== slot) return;
          var d = ev.detail || {};
          if (d.severity === 1) return diag('player.recoverable', { code: d.code, category: d.category }, 'info');
          emit('error', describe(d), errorInfo(d));
        });
        player.addEventListener('buffering', function (ev) { if (slots[cur] === slot) emit('buffering', ev.buffering); });
        video.addEventListener('ended', function () { if (slots[cur] === slot && !swapping) emit('ended'); });
        return slot;
      });
    }

    /**
     * F1's WebVTT cuts a subtitle at a segment's end and repeats it whole in the next segment, and
     * Shaka keeps both copies, so the line showed twice. Some subtitles are cut to 1 ms and never
     * showed. Merges the repeats and shows the cut ones for up to 3 s, until the next subtitle.
     */
    function tidyCues(track) {
      if (track.kind !== 'subtitles' && track.kind !== 'captions') return;   // not metadata tracks
      var list = function () { return Array.prototype.slice.call(track.cues || []); };
      var seen = {};
      list().forEach(function (c) {
        var key = Math.round(c.startTime * 1000) + '|' + c.text, first = seen[key];
        if (!first) { seen[key] = c; return; }
        if (c.endTime > first.endTime) first.endTime = c.endTime;
        track.removeCue(c);
      });
      var cues = list();
      cues.forEach(function (c, i) {
        if (!c.f1Cut && c.endTime - c.startTime >= 0.1) return;
        c.f1Cut = true;   // rechecked as later subtitles arrive
        var next = cues.slice(i + 1).filter(function (n) { return n.startTime > c.startTime; })[0];
        c.endTime = Math.min(c.startTime + 3, next ? next.startTime : Infinity);
      });
    }

    function init() {
      shaka.polyfill.installAll();
      var Simple = shaka.text && shaka.text.SimpleTextDisplayer;
      if (Simple && !Simple.prototype.append.f1Tidy) {
        var append = Simple.prototype.append;
        Simple.prototype.append = function (cues) {
          append.call(this, cues);
          slots.forEach(function (s) { Array.prototype.forEach.call(s.v.textTracks || [], tidyCues); });
        };
        Simple.prototype.append.f1Tidy = true;
      }
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

    var SURROUND = 6;

    function configure(slot, stream) {
      var player = slot.p;
      slot.hdr = stream.hdr === true;
      licenseHeaders = stream.licenseHeaders || {};
      // AES-128 HLS key requests (F1's Tiledmedia offer): the account's tokens, per slot (a feed switch configures the
      // incoming slot while the outgoing one may still fetch a key).
      slot.keyHeaders = (stream.hlsAes && stream.keyHeaders) || {};
      var drm = stream.licenseUrl ? { servers: { 'com.widevine.alpha': stream.licenseUrl } } : {};
      player.resetConfiguration();
      player.configure({
        drm: drm,
        preferredVideoHdrLevel: stream.hdr ? 'HLG' : 'AUTO',
        // 5.1 where the offer has it: F1's own shows and the F1 LIVE feed of sessions carry AC-3 5.1 (English, F1 LIVE
        // also Spanish) beside the stereo AAC in the Apple TV HDR offer; other feeds and offers are stereo (2026-11-21).
        // Shaka takes the most channels up to this, and stereo where nothing else exists; codecs the TV can't decode
        // are left out by Shaka itself.
        preferredAudioChannelCount: SURROUND,
        // Keep recent video for backward seeks. A 10 Mbit/s estimate starts F1 streams at 1080p.
        // 4K HDR keeps less: 30 s ahead at 2160p (~17 Mbit/s) filled the TV's video buffer, and Shaka then dropped 2160p
        // for 30 s at a time (LV Qualifying, 2026-11-21: 2160p ~27 s, 1620p ~30 s, over and over); 15 + 10 s held 2160p.
        streaming: { bufferingGoal: stream.hdr ? 15 : 30, rebufferingGoal: 1, bufferBehind: stream.hdr ? 10 : 90,
          retryParameters: { maxAttempts: 4, baseDelay: 1000, backoffFactor: 2 } },
        abr: { enabled: true, defaultBandwidthEstimate: startEstimate(slot, stream.hdr), useNetworkInformation: false, switchInterval: 4 },
        // F1's DASH says minBufferTime PT30S, and Shaka waits for max(that, rebufferingGoal) at playbackRate 0 before
        // playing: a live start ~25 s from the edge can't buffer 30 s, so it sat frozen ~10 s (Las Vegas FP1, 2026-11-20).
        manifest: { hls: { ignoreManifestProgramDateTime: false }, dash: { ignoreMinBufferTime: true } }
      });
    }

    function applyPrefs(player) {
      try { player.selectAudioLanguage(langOf(Settings.get('audio')), '', SURROUND); } catch (e) { /* single track */ }
      textTrack(player, Settings.get('subtitles'));
    }

    function load(stream, startTime) {
      return renewStuck().then(function () { return loadSlot(stream, startTime); });
    }

    function loadSlot(stream, startTime) {
      var slot = slots[cur], gen = ++generation;
      configure(slot, stream);
      slot.v.muted = false;
      slot.v.classList.remove('hidden');
      userPaused = false;
      return slot.p.load(stream.url, startTime == null ? null : startTime).then(function () {
        applyPrefs(slot.p);
        // Resetting another video element can cancel play(); keepPlaying retries it.
        var started = slot.v.play();
        keepPlaying(slot.v, 5000);
        if (stream.hdr || stream.cenc) reloadIfFrozen(slot, stream, startTime, gen);
        return started && started.catch(function () {});
      });
    }

    /**
     * The first HDR video after the app starts can stay frozen on this TV (the screen switching to
     * HDR, presumably): data buffered, not one frame decoded. Loading it again starts it. The first
     * encrypted (cenc) video after the start stalls earlier, at readyState 1 (the browser's DRM
     * starting up, presumably); loading it again plays it too (Mexico FP3 replay, 2026-10-31).
     */
    function reloadIfFrozen(slot, stream, startTime, gen) {
      var done = false;
      function frozen(ms) {
        var q = slot.v.getVideoPlaybackQuality ? slot.v.getVideoPlaybackQuality() : null;
        if (done || gen !== generation || userPaused || !q || q.totalVideoFrames > 0) return false;
        // At any check: seconds of data, ready to play, playing, and not one frame (the first player_tm start after
        // launch, 2026-11-22: readyState 4, 5.8 s buffered, 0 frames; its reload then took 12 s, which the app's 25 s
        // start watch only just allowed), or a seek stuck with data under the playhead (the TS start of 2026-11-19 and
        // player_tm resumes, 2026-11-22: readyState 1, seeking, 17-23 s buffered around it, 0 frames for 26 s; seeking to
        // the segment's start didn't help, loading again did; the data can come seconds after the 5 s check).
        if (slot.v.readyState >= 4 && !slot.v.paused && bufferedAhead(slot.v) >= 4) return true;
        if (stuckSeeking(slot.v)) return true;
        // At 5 s, as before: frozen unless still waiting for data (below readyState 3), except cenc (its DRM start-up).
        return ms === 5000 && !(slot.v.readyState < 3 && !stream.cenc) ? 'now' : false;
      }
      // Seen at two checks in a row (2.5 s apart), so data that has only just come gets its chance to decode first;
      // the 5 s rule as before.
      var seen = 0;
      [2500, 5000, 7500, 10000, 12500, 15000].forEach(function (ms) {
        setTimeout(function () {
          var stuck = frozen(ms);
          if (stuck === 'now') return reload();
          seen = stuck ? seen + 1 : 0;
          if (seen >= 2) reload();
        }, ms);
      });
      function reload() {
        done = true;
        reloadedAt = Date.now();
        // From where it is now, which includes a seek made meanwhile.
        var at = slot.v.currentTime > 0 ? slot.v.currentTime : startTime;
        diag('player.frozen-reload', { hdr: !!stream.hdr, cenc: !!stream.cenc, readyState: slot.v.readyState, at: at });
        slot.p.load(stream.url, at == null ? null : at).then(function () {
          if (gen !== generation) return;
          // A new load starts on the stream's default tracks (French subtitles on F1's replays).
          applyPrefs(slot.p);
          if (userPaused) return;
          slot.v.play().catch(function () {});
          keepPlaying(slot.v, 5000);
        }).catch(function () { /* the start watch in app.js falls back to SDR */ });
      }
    }

    function stuckSeeking(v) {
      var b = v.buffered;
      if (!v.seeking || !b) return false;
      for (var i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime && b.end(i) - v.currentTime >= 2) return true;
      return false;
    }

    /** Seconds buffered from the playhead on, in the range that holds it (a later range past a gap doesn't count). */
    function bufferedAhead(v) {
      var b = v.buffered;
      if (b) for (var i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime && v.currentTime < b.end(i)) return b.end(i) - v.currentTime;
      return 0;
    }

    /**
     * Frames decoded since the video was loaded (Shaka's polyfill gives older Tizen the count too), or null without
     * a count. Trusted at 0 like reloadIfFrozen and showFrame do: the frozen TS start (TV, 2026-11-19) sat seeking
     * at 2.13 s with readyState 3 and 1080p known, so readyState doesn't tell it from a playing video.
     */
    function decodedFrames() {
      var v = V(), q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      return q ? q.totalVideoFrames : null;
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

    /**
     * The TV decodes only one video, and no frame of a paused one: a feed switched to while paused
     * plays, muted, from when the old feed has let go of the decoder until it shows a frame.
     */
    function showFrame(v) {
      var t0 = Date.now();
      (function check() {
        if (V() !== v) return;
        var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
        // Shown (or given up on), or the viewer pressed play meanwhile.
        if (!userPaused || (q && q.totalVideoFrames > 0) || Date.now() - t0 > 5000) {
          if (userPaused) v.pause();
          v.muted = false;
          return;
        }
        if (v.paused) v.play().catch(function () {});
        setTimeout(check, 100);
      })();
    }

    function swap(stream, startTime) {
      var old = slots[cur], next = slots[1 - cur];
      generation++;
      rememberBandwidth(old);   // before the incoming slot reads it for its start
      configure(next, stream);
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
        var paused = userPaused;   // paused before or during the switch: the new feed stays paused
        next.v.muted = paused;
        cur = 1 - cur;
        swapping = false;
        old.v.classList.add('hidden');
        old.v.style.zIndex = '';
        next.v.style.zIndex = '';
        old.p.unload().then(function () { if (paused) showFrame(next.v); else keepPlaying(next.v); });
        if (!paused) keepPlaying(next.v);
      }, function (err) {
        swapping = false;
        next.v.classList.add('hidden');
        next.p.unload();
        old.v.style.zIndex = '';
        throw err;
      });
    }

    var LANG2 = { eng: 'en', deu: 'de', fra: 'fr', nld: 'nl', por: 'pt', jpn: 'ja', spa: 'es', ita: 'it', teamradio: 'tea' };
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

    // Slots whose Shaka player didn't finish unloading in time (see unload): replaced before the next load.
    var stuckSlots = [];

    function unload() {
      rememberBandwidth(slots[cur]);
      licenseHeaders = {};
      generation++;
      slots.forEach(function (s) { s.v.classList.add('hidden'); s.v.style.zIndex = ''; });
      // Shaka's unload has been seen never to finish on the TV (2026-11-11, switching to a multiview): the next load
      // waits for it (Player.unload's teardown), so it gets 10 s; then the next load goes on, and a Shaka load first
      // gets fresh players for the slots still unloading (renewStuck).
      var pending = slots.slice(), timer;
      var done = Promise.all(slots.map(function (s) {
        return s.p.unload().then(function () { pending.splice(pending.indexOf(s), 1); });
      })).then(function () { clearTimeout(timer); });
      return Promise.race([done, new Promise(function (ok) {
        timer = setTimeout(function () { stuckSlots = stuckSlots.concat(pending); ok(); }, 10000);
      })]);
    }

    /** New Shaka players on the same video elements for the slots whose old player never finished unloading. */
    function renewStuck() {
      var old = stuckSlots;
      stuckSlots = [];
      return Promise.all(old.map(function (s) {
        try { s.p.destroy(); } catch (e) { /* stuck already: it is dropped either way */ }
        return makeSlot(s.v).then(function (fresh) {
          var k = slots.indexOf(s);
          if (k >= 0) slots[k] = fresh;
        });
      }));
    }

    return {
      init: init,
      load: load,
      swap: swap,
      tracks: tracks,
      setAudio: function (l) { try { P().selectAudioLanguage(langOf(l), '', SURROUND); } catch (e) { /* single track */ } },
      /** Channels of the audio playing (2, or 6 for F1's 5.1 AC-3), or null before a variant is chosen. */
      audioChannels: function () {
        var a = P().getVariantTracks().filter(function (t) { return t.active; })[0];
        return a && a.channelsCount ? a.channelsCount : null;
      },
      setSubtitles: function (l) { textTrack(P(), l); },
      unload: unload,
      isLive: function () { return P().isLive(); },
      range: function () { return P().seekRange(); },
      position: function () { return V().currentTime; },
      exactPosition: function () { return V().currentTime; },
      decodedFrames: decodedFrames,
      reloadedAt: function () { return reloadedAt; },
      bufferedEnd: function () { var b = V().buffered; return b.length ? b.end(b.length - 1) : 0; },
      seekTo: function (t, done) { V().currentTime = t; if (done) done(); },
      // The viewer's pause counts even while showFrame plays a switched-to feed until it has a picture.
      paused: function () { return userPaused || V().paused; },
      viewerPaused: function () { return userPaused; },
      play: function () { userPaused = false; V().play(); },
      pause: function () { userPaused = true; V().pause(); },
      snapshot: snapshot
    };

    /** The playing slot's state for the diagnostics log. */
    function snapshot() {
      var p = P(), v = V(), o = { slots: slots.length, readyState: v.readyState, networkState: v.networkState,
        videoPaused: v.paused, userPaused: userPaused, hdrSlot: !!slots[cur].hdr };
      if (v.error) o.mediaError = { code: v.error.code, message: v.error.message };
      try {
        var q = v.getVideoPlaybackQuality();
        o.frames = { total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
      } catch (e) { /* not available */ }
      try {
        var st = p.getStats();
        o.stats = { width: st.width, height: st.height, streamKbps: kbps(st.streamBandwidth), estimatedKbps: kbps(st.estimatedBandwidth),
          bufferingTime: st.bufferingTime, playTime: st.playTime, loadLatency: st.loadLatency };
      } catch (e) { /* not loaded */ }
      try {
        var tracks = p.getVariantTracks(), t = tracks.filter(function (x) { return x.active; })[0];
        o.variants = tracks.length;
        if (t) o.variant = { height: t.height, kbps: kbps(t.bandwidth), video: t.videoCodec, audio: t.audioCodec, hdr: t.hdr,
          fps: t.frameRate, lang: t.language };
      } catch (e) { /* not loaded */ }
      try { o.text = p.isTextTrackVisible() ? (p.getTextTracks().filter(function (x) { return x.active; })[0] || {}).language : null; } catch (e) { /* none */ }
      return o;
    }
  })();

  // Samsung AVPlay

  var AvEngine = (function () {
    var av = null;
    var stream = null;
    var gridRect = null;   // where a multiview's picture goes on screen (set by the app), else the whole screen

    /** A multiview's picture area on screen ([x, y, w, h]), or null for the whole screen. */
    function setGridRect(rect) {
      var key = rect ? rect.join() : '';
      if (key === (gridRect ? gridRect.join() : '')) return;
      gridRect = rect;
      var r = rect || [0, 0, 1920, 1080];
      if (av && stream && stream.grid) try { av.setDisplayRect(r[0], r[1], r[2], r[3]); } catch (e) { /* not open */ }
    }
    var live = false;
    var isPaused = false;
    var posMs = 0;
    var startAt = null;

    /*
     * AVPlay's preparation can hang: no callback for minutes (Mexico 2026 multiview, twice as the first video
     * after the app started, once after another video). It can't be cancelled, and stopping or closing AVPlay
     * while it prepares has crashed or frozen the player, so a preparation that takes longer than this is left
     * alone (`stuck`): its open fails with code PREPARE_TIMEOUT, and the next open goes over it, as BACK and trying
     * again did. Each open has its own generation, so a late answer from an earlier one changes nothing.
     */
    var PREPARE_MS = { grid: 20000, other: 30000 };
    var openGen = 0, stuck = null;

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
        var g = openGen;
        fetch(stream.licenseUrl, {
          method: 'POST',
          headers: stream.licenseHeaders || {},
          body: b64ToBytes(data.challenge)
        }).then(function (res) {
          if (!res.ok) {
            var refused = new Error('License server answered ' + res.status);
            refused.diag = { code: 'DRM_ERROR', platform: null };
            refused.status = res.status;
            throw refused;
          }
          return res.arrayBuffer();
        }).then(function (lic) {
          if (g !== openGen) return;   // a newer open has the player now
          var param = data.session_id + 'PARAM_START_POSITION' + bytesToB64(lic) + 'PARAM_START_POSITION';
          // The TV refusing the licence it got is the TV's (app.js counts it against the path); 'License: ' below is the
          // download only (the network or the licence server).
          try { av.setDrm('WIDEVINE_CDM', 'widevine_license_data', param); }
          catch (e) { emit('error', 'Licence install: ' + (e && e.message || e), { code: 'DRM_ERROR', platform: null }); }
        }).catch(function (e) {
          if (typeof DiagUpload !== 'undefined') DiagUpload.apiFailed('playback_license', e.status || null, 0);
          emit('error', 'License: ' + e.message, { code: 'DRM_ERROR', platform: null });
        });
      } else if (data.name === 'DrmError') {
        emit('error', 'DRM error ' + (data.code || '') + ' ' + (data.message || ''), { code: 'DRM_ERROR', platform: null });
      }
    }

    var captions = null;   // native HDR: the app's own subtitles (ttml.js), not AVPlay's

    function subtitleReader(list) {
      if (!list || !list.length || typeof Ttml === 'undefined') return null;
      return Ttml.reader(list, {
        position: function () {
          try { var ms = av.getCurrentTime(); return ms > 0 ? ms / 1000 : null; } catch (e) { return null; }
        },
        show: function (cue) { emit('subtitle', cue); },
        same: sameLang
      });
    }

    function trackList() {
      var out = { audio: [], text: [] };
      try {
        av.getTotalTrackInfo().forEach(function (t) {
          var info = {};
          try { info = JSON.parse(t.extra_info || '{}'); } catch (e) { /* keep empty */ }
          if (t.type === 'AUDIO') out.audio.push({ index: t.index, lang: info.language || '', channels: +info.channels || 0, bitrate: +info.bit_rate || 0 });
          if (t.type === 'TEXT') out.text.push({ index: t.index, lang: info.track_lang || '' });
        });
      } catch (e) { /* not prepared yet */ }
      if (captions) out.text = captions.langs().map(function (lang, i) { return { index: i, lang: lang }; });
      return out;
    }

    /**
     * 5.1 before stereo where a language has both (encrypted 4K HDR on F1 LIVE and the shows, hdr.js). AVPlay names
     * the channels of the playing track only; the others show their manifest bitrate: 384k for the 5.1 AC-3 tracks,
     * 192k for F1's stereo commentary.
     */
    function surroundish(a) { return a.channels > 2 || (!a.channels && a.bitrate >= 384000); }

    function selectAudio(lang) {
      var t = trackList().audio.filter(function (a) { return sameLang(a.lang, lang); })
        .sort(function (x, y) { return surroundish(y) - surroundish(x) || x.index - y.index; })[0];
      if (t) try { av.setSelectTrack('AUDIO', t.index); } catch (e) { /* keep current */ }
    }

    function selectText(lang) {
      if (captions) return captions.select(lang || null);
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
      if (captions) { captions.stop(); captions = null; }
      // An H.264 multiview (grid.engine 'h264') plays the big feed's own stream here, in the grid rect; its small
      // feeds are the app's (js/mvsoft.js).
      if (s.grid && s.grid.engine !== 'h264') {
        var gridPrefs = { audio: lang3(Settings.get('audio')), text: lang3(Settings.get('subtitles')) };
        var gridReady = s.info && s.info.dynamic ? StreamProxy.gridLive(s, s.startDelay, gridPrefs) :
          StreamProxy.gridManifest(s.grid.streams, s.grid.layout, { audio: gridPrefs.audio, text: gridPrefs.text, surround: !s.noSurround },
            startTime, s.grid.audioPos || 0);
        return gridReady.then(function (prepared) {
          if (stream !== s) throw new Error('cancelled');
          s.grid.id = prepared.id;   // for rearranging it later without reloading
          s.surround = prepared.surround || 0;   // 5.1 commentaries in it (the app learns per TV whether they play)
          captions = subtitleReader(prepared.subtitles);
          return open(s, prepared.url);
        });
      }
      if (s.hdrEncrypted) {
        var prefs = { audio: lang3(Settings.get('audio')), text: lang3(Settings.get('subtitles')), surround: !s.noSurround };
        var prepare = s.info && s.info.dynamic ? StreamProxy.hdrLive(s, s.startDelay, prefs) : StreamProxy.hdrManifest(s, prefs);
        return prepare.then(function (prepared) {
          if (stream !== s) throw new Error('cancelled');
          s.surround = prepared.surround || 0;
          captions = subtitleReader(prepared.subtitles);
          return open(s, prepared.url);
        });
      }
      // Encrypted live DASH goes through the local service, which fixes the audio segments.
      if (s.licenseUrl && /\.mpd(\?|$)/.test(s.url)) {
        var langs = { audio: lang3(Settings.get('audio')), text: lang3(Settings.get('subtitles')) };
        return StreamProxy.ensure().then(function () {
          // Stopped while the helper started: opening now would leave AVPlay open over the next video.
          if (stream !== s) throw new Error('cancelled');
          return open(s, StreamProxy.manifest(s.url, s.startDelay, langs));
        });
      }
      return open(s, s.url);
    }

    var preparing = null;   // settles when the current prepareAsync has finished either way

    var recentLines = {};   // subtitle text -> when AVPlay last sent it

    function open(s, url) {
      clearTimeout(stallTimer);
      isPaused = false;
      posMs = 0;
      recentLines = {};
      openedUrl = url;
      started = false;
      els.av.classList.remove('hidden');
      document.body.classList.add('avplay');
      var g = ++openGen;
      return new Promise(function (resolve, reject) {
        try { av.open(url); } catch (e) {
          // Over a stuck preparation, AVPlay may refuse to open again: only restarting the app helps then.
          if (!stuck) throw e;
          var refused = new Error('The TV\'s video player is stuck');
          refused.code = 'PLAYER_STUCK';
          throw refused;
        }
        openedAt = Date.now();
        quietUntil = openedAt + 6000;
        av.setListener({
          onbufferingstart: function () { emit('buffering', true); bufferingStarted(s); },
          onbufferingcomplete: function () { emit('buffering', false); clearTimeout(stallTimer); },
          oncurrentplaytime: function (ms) { posMs = ms; noteSmooth(s); },
          onstreamcompleted: function () { emit('ended'); },
          onerror: function (e) { emit('error', 'Player error: ' + e, avError(e)); },
          // The type only: its data is often binary (Tizen 6) and could carry anything.
          onevent: function (type) { diagTrail('avplay.event', { type: type }); },
          onsubtitlechange: function (duration, text) {
            text = String(text || '').replace(/\u0000/g, '').trim();
            // At each segment boundary AVPlay sends the new segment's earlier lines again (F1 repeats
            // cues across segments), which flashed old lines: show a line once.
            var now = Date.now();
            Object.keys(recentLines).forEach(function (t) { if (now - recentLines[t] > 15000) delete recentLines[t]; });
            if (text && recentLines[text]) return;
            if (text) recentLines[text] = now;
            emit('subtitle', { text: text, ms: +duration || 3000 });
          },
          ondrmevent: onDrm
        });
        if (s.licenseUrl) {
          var properties = { AppSession: 'f1tv-' + Date.now() };
          if (s.hdrEncrypted) properties.DataType = 'MPEG-DASH';
          av.setDrm('WIDEVINE_CDM', 'SetProperties', JSON.stringify(properties));
        }
        tune(s);
        var rect = s.grid && gridRect ? gridRect : [0, 0, 1920, 1080];
        av.setDisplayRect(rect[0], rect[1], rect[2], rect[3]);
        av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        var settle, finished = false;
        var mine = preparing = new Promise(function (r) { settle = r; });
        // AVPlay has answered (the seek before preparing, or the preparation): it may be stopped and closed again.
        function answered() {
          settle();
          if (stuck && stuck.gen === g) stuck = null;
        }
        // This open's outcome, once: false if it has already failed (timed out).
        function finish() {
          if (finished) return false;
          finished = true;
          clearTimeout(timer);
          return true;
        }
        var timer = setTimeout(function () {
          if (!finish()) return;
          stuck = { gen: g };
          // Whoever waits for this preparation goes on (unload() then leaves AVPlay alone: see `stuck`).
          settle();
          if (preparing === mine) preparing = null;
          var e = new Error('The video player did not start');
          e.code = 'PREPARE_TIMEOUT';
          reject(e);
        }, s.grid ? PREPARE_MS.grid : PREPARE_MS.other);
        function prepare() {
          if (finished) return answered();   // the seek answered after this open gave up: don't prepare now
          if (stream !== s) { answered(); finish(); return reject(new Error('cancelled')); }
          av.prepareAsync(function () {
            answered();
            if (!finish()) return;   // too late: this open has failed, and a retry may have the player
            // Unloaded or replaced while preparing: don't start (unload() closes the player).
            if (stream !== s) return reject(new Error('cancelled'));
            stuck = null;   // AVPlay prepares again: an earlier stuck preparation no longer holds it
            started = true;
            var d = av.getDuration();
            live = s.info ? s.info.dynamic : (!!s.live || !d || d <= 0);
            selectAudio(Settings.get('audio'));
            // Live streams start where the manifest's presentation delay puts them (see StreamProxy.manifest).
            av.play();
            ensurePlaying(s);
            applyAudioWhenPlaying(s);
            applyTextWhenPlaying(s);
            if (startAt != null && !live && !seekFirst) seek(startAt * 1000, null, 16);
            resolve();
          }, function (e) {
            answered();
            if (!finish()) return;
            var failure = new Error(stream !== s ? 'cancelled' : 'Could not open stream: ' + e);
            failure.diag = avError(e && typeof e === 'object' && e.name ? e.name : e);
            reject(failure);
          });
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
    var tuning = { resumeBuffer: 4, gridResumeBuffer: 2 };

    /*
     * AVPlay's own choice on F1's SDR DASH replays drops from 1080p to 720p, 540p and even 270p every
     * minute or two with a fast connection (80 Mbit/s measured, no buffering); the HDR stream holds
     * 2160p. So an SDR replay is locked to its top quality, as long as starts at the top have been
     * smooth (start level 0). A stall while locked reopens it at the same moment with AVPlay choosing.
     */
    var pinned = 0, openedUrl = null, started = false;

    function pinFor(s) {
      var rates = s.info && !s.info.dynamic && !s.hdr && !s.unpinned && s.info.videoBitrates;
      return rates && rates.length > 1 && startLevel() === 0 ? rates[rates.length - 1] : 0;
    }

    function release(s) {
      if (stream !== s || !pinned || !started) return;
      diag('player.unpin', { bitrate: pinned, position: posMs / 1000 }, 'info');
      pinned = 0;
      s.unpinned = true;
      setStartLevel(Math.max(1, startLevel()));
      startAt = posMs / 1000;
      try { av.stop(); } catch (e) { /* not playing */ }
      try { av.close(); } catch (e) { /* already closed */ }
      open(s, openedUrl).catch(function (e) { if (stream === s) emit('error', 'Could not reopen: ' + e.message, errorInfo(e)); });
    }

    function tune(s) {
      pinned = pinFor(s);
      var adaptive = 'STARTBITRATE=' + START_LEVELS[startLevel()];
      if (pinned) adaptive = 'BITRATES=' + pinned + '~' + pinned * 2 + '|' + adaptive;
      try { av.setStreamingProperty('ADAPTIVE_INFO', adaptive); } catch (e) { /* keep default */ }
      // A multiview changes by a seek to the same moment: it plays on sooner with less buffer (its segments are
      // built ahead by the stream helper).
      var resume = s.grid && s.grid.engine !== 'h264' ? tuning.gridResumeBuffer : tuning.resumeBuffer;
      try {
        if (resume) av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', resume);
      } catch (e) {
        try { if (tuning.resumeBuffer) av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', tuning.resumeBuffer); } catch (e2) { /* keep defaults */ }
      }
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

    /*
     * A stall is buffering that lasts STALL_MS, not right after opening or a seek. AVPlay also reports
     * blips of 50-150 ms (live HDR, between segments); counting those pushed every start down to the
     * lowest quality, so each feed switch or seek began at 270p (Qualifying, 2026-10-31).
     */
    var STALL_MS = 2000, stallTimer = null;

    function bufferingStarted(s) {
      var at = Date.now();
      clearTimeout(stallTimer);
      stallTimer = setTimeout(function () {
        if (stream !== s || isPaused || at < quietUntil) return;
        noteBuffering(s, at);
        // A stall at the locked top quality: hand the choice back to AVPlay.
        if (pinned && started) release(s);
      }, STALL_MS);
    }

    /** A stall soon after the start lowers the next start's quality. */
    function noteBuffering(s, at) {
      if (levelNoted === s || at - openedAt > 90000) return;
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
      if (captions) return captions.select(want || null);
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

    /**
     * Tizen 9 refuses setSelectTrack('AUDIO') in READY with
     * PLAYER_ERROR_INVALID_STATE, so the choice made before play() is lost there. Once playing,
     * select the commentary again if the current track isn't it.
     */
    function applyAudioWhenPlaying(s) {
      var tries = 0;
      (function check() {
        if (stream !== s || ++tries > 20) return;
        var st = '';
        try { st = av.getState(); } catch (e) { return; }
        if (st !== 'PLAYING' && st !== 'PAUSED') return setTimeout(check, 400);
        var want = Settings.get('audio'), cur = null;
        if (!want) return;
        try { cur = av.getCurrentStreamInfo().filter(function (t) { return t.type === 'AUDIO'; })[0]; } catch (e) { /* unknown */ }
        var info = {};
        try { info = JSON.parse((cur && cur.extra_info) || '{}'); } catch (e) { /* unknown */ }
        if (!sameLang(info.language, want)) selectAudio(want);
      })();
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
      recentLines = {};   // lines heard before the seek may come again
      // Its own target: playback reports overwrite posMs while a retry waits.
      var target = posMs = Math.max(0, clampLive(ms / 1000) * 1000);
      (function attempt() {
        if (gen !== seekGen || s !== stream) return;
        try {
          av.seekTo(Math.round(target), function () { if (gen === seekGen && done) done(true); }, function (e) {
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
      var wait = preparing || Promise.resolve(), g = openGen;
      stream = null;
      clearTimeout(stallTimer);
      if (captions) { captions.stop(); captions = null; }
      els.av.classList.add('hidden');
      document.body.classList.remove('avplay');
      return wait.then(function () {
        // A newer open has the player by now (this waited for a slow preparation), or one is stuck: leave it.
        if (g !== openGen || stuck) return;
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
      // One live edge for both ends of the bar: where a fresh open would start (wall clock minus the delay), not
      // AVPlay's window end, which is ~18 s further on when the stream was not time-shifted and behind it when it was.
      if (w) return { start: w.start + 10, end: edge != null ? Math.max(edge, posMs / 1000) : Math.max(w.end, posMs / 1000) };
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
      // AVPlay's own clock (position() follows its time callbacks, up to ~0.3 s behind): costs a few ms per call.
      exactPosition: function () { try { var ms = av.getCurrentTime(); return ms > 0 ? ms / 1000 : posMs / 1000; } catch (e) { return posMs / 1000; } },
      decodedFrames: function () { return null; },   // AVPlay counts none (and reports no position until it plays)
      bufferedEnd: function () { return posMs / 1000; },
      seekTo: function (t, done) { seek(t * 1000, done); },
      paused: function () { return isPaused; },
      play: function () { try { av.play(); } catch (e) { /* not ready: ensurePlaying retries */ } isPaused = false; },
      pause: function () { try { av.pause(); } catch (e) { /* not ready yet */ } isPaused = true; },
      // One entry per language (a 5.1 and a stereo commentary in one language are one choice, as on Shaka).
      tracks: function () {
        var list = trackList(), seen = {};
        list.audio = list.audio.filter(function (a) { var k = lang3(a.lang); if (seen[k]) return false; seen[k] = true; return true; });
        return list;
      },
      setGridRect: setGridRect,
      setAudio: selectAudio,
      /** Channels of the audio playing (6 for F1's 5.1 AC-3), or null where AVPlay doesn't say. */
      audioChannels: function () {
        var a = null;
        try { a = av.getCurrentStreamInfo().filter(function (t) { return t.type === 'AUDIO'; })[0]; } catch (e) { return null; }
        var n = 0;
        try { n = +JSON.parse((a && a.extra_info) || '{}').channels || 0; } catch (e) { /* unknown */ }
        return n > 0 ? n : null;
      },
      setSubtitles: selectText,
      grid: function () {
        var i = stream && stream.info;
        return !live && i && i.segDur >= 10 ? { size: i.segDur, origin: i.windowStart || 0 } : null;
      },
      tuning: tuning,
      snapshot: snapshot
    };

    /** AVPlay's state for the diagnostics log. */
    function snapshot() {
      var o = { started: started, paused: isPaused, live: live, positionS: posMs / 1000, pinnedKbps: kbps(pinned),
        startLevel: START_LEVELS[startLevel()], sinceOpenS: openedAt ? Math.round((Date.now() - openedAt) / 100) / 10 : null };
      if (!av) return o;
      try { o.state = av.getState(); } catch (e) { /* not open */ }
      try { o.durationS = av.getDuration() / 1000; } catch (e) { /* not prepared */ }
      try { o.bandwidthKbps = kbps(+av.getStreamingProperty('CURRENT_BANDWIDTH')); } catch (e) { /* not available */ }
      try {
        av.getCurrentStreamInfo().forEach(function (t) {
          var x = {};
          try { x = JSON.parse(t.extra_info || '{}'); } catch (e) { /* unknown */ }
          o[String(t.type).toLowerCase()] = t.type === 'VIDEO'
            ? { width: x.Width, height: x.Height, kbps: kbps(+x.Bit_rate), fourCC: x.fourCC }
            : { lang: x.language || x.track_lang, fourCC: x.fourCC };
        });
      } catch (e) { /* not prepared */ }
      if (live) o.liveWindow = liveWindow();
      return o;
    }
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

  var hdrSupport = null;

  function hdrCapable() {
    if (hdrSupport !== null) return hdrSupport;
    try {
      hdrSupport = webapis.avinfo.isHdrTvSupport() === true &&
        MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"') === true;
    } catch (e) { hdrSupport = false; }
    return hdrSupport;
  }

  /**
   * Whether the TV decodes an HEVC picture of this size at 50 fps (Main 10 with `hdr`, else Main). The level in
   * the codec string is ignored here (a QE55Q77A says yes to 8K levels), but the size is honoured: 3840x2160 yes,
   * 3840x2176 and 7680x4320 no. AVPlay uses the same decoder; a picture it refuses anyway falls back when played.
   */
  var hevcSizes = {};
  function hevcDecodes(width, height, hdr) {
    var key = width + 'x' + height + (hdr ? ' hdr' : '');
    if (!(key in hevcSizes)) {
      try {
        hevcSizes[key] = MediaSource.isTypeSupported('video/mp4; codecs="' + (hdr ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0') + '"; width=' +
          width + '; height=' + height + '; framerate=50') === true;
      } catch (e) { hevcSizes[key] = false; }
    }
    return hevcSizes[key];
  }

  /**
   * AVPlay starts long-segment videos in ~2 s; Shaka needs the whole first segment but can
   * preload feed switches. Use Shaka for clear multi-feed replays.
   */
  function choose(stream) {
    if (Player.forceEngine) return engines[Player.forceEngine];
    // Multiview: the stream helper's stitched HEVC, native only (clear or encrypted).
    if (stream.grid) return AvEngine;
    if (stream.hdrEncrypted && stream.licenseUrl && hasAvPlay()) return AvEngine;
    // F1's cenc stream (asked as a Chromecast): the browser decrypts it, so Shaka plays it.
    if (stream.cenc) return stream.cencAvplay && hasAvPlay() ? AvEngine : ShakaEngine;
    // AVPlay picks SDR variants from HDR playlists; Shaka can be told to prefer HLG.
    if (stream.hdr) return ShakaEngine;
    if (!hasAvPlay()) return ShakaEngine;
    return stream.licenseUrl || !stream.multiFeed ? AvEngine : ShakaEngine;
  }

  var current = null;
  var channelsSeen = { stream: null, at: 0, n: null };   // Player.audioChannels(), kept 2 s

  function load(stream, startTime) {
    current = stream;
    channelsSeen = { stream: null, at: 0, n: null };
    return unload().then(function () {
      engine = choose(stream);
      engineName = engine === AvEngine ? 'avplay' : 'shaka';
      return engine.load(stream, startTime);
    });
  }

  // The engine's unload still under way: a second unload (or the next load) waits for it too, so a player still
  // finishing a preparation is not opened again under it.
  var teardown = null;

  function unload() {
    if (typeof Caps !== 'undefined') Caps.crashEnd();
    var e = engine;
    engine = null;
    if (!e) return teardown || Promise.resolve();
    var t = teardown = e.unload().then(function () { if (teardown === t) teardown = null; });
    return t;
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
    // Encrypted feeds can't be preloaded beside the playing one: the TV has one secure decoder, and the
    // preloaded cenc feed barely moves (164 frames in 9 s, Mexico FP3). They load like AVPlay's.
    if (engine === ShakaEngine && choose(stream) === ShakaEngine && !stream.cenc && !(current && current.cenc)) {
      var prev = current;
      current = stream;
      // A failed switch leaves the previous feed playing, on its own clock.
      return ShakaEngine.swap(stream, startTime).catch(function (e) {
        if (current === stream) current = prev;
        throw e;
      });
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

  /** Calls `fn`, first leaving a step in the diagnostics trail (`what` gives its details from the arguments). */
  function traced(kind, fn, what) {
    return function () {
      try {
        if (typeof Diag !== 'undefined' && Diag.recording()) Diag.trail(kind, what ? what.apply(null, arguments) : undefined);
      } catch (e) { /* never in the way */ }
      return fn.apply(null, arguments);
    };
  }

  /** The player's state for the diagnostics log. */
  function snapshot() {
    var o = { engine: engineName, hdrCapable: hdrSupport };
    if (!engine) return o;
    try {
      o.position = engine.position();
      o.paused = engine.paused();
      o.live = engine.isLive();
      var r = engine.range();
      o.range = { start: r.start, end: r.end };
      // AVPlay doesn't tell how much it has buffered (its bufferedEnd is the position).
      if (engine === ShakaEngine) o.bufferedAheadS = Math.max(0, engine.bufferedEnd() - o.position);
    } catch (e) { /* not loaded */ }
    try { if (engine.snapshot) o[engineName] = engine.snapshot(); } catch (e) { o[engineName] = { failed: String(e && e.message) }; }
    return o;
  }

  return {
    init: init,
    hdrCapable: hdrCapable,
    hevcDecodes: hevcDecodes,
    cencCapable: function () { return typeof Caps !== 'undefined' && Caps.browser('cenc') !== false; },
    load: traced('player.load', load, function (s, t) { return { start: t, cenc: !!(s && s.cenc), hdr: !!(s && s.hdr) }; }),
    unload: traced('player.unload', unload),
    seekBy: traced('player.seekBy', seekBy, function (d) { return { by: d }; }),
    seekTo: traced('player.seekTo', seekTo, function (t) { return { to: t }; }),
    switchTo: traced('player.switchTo', switchTo, function (s, t) { return { start: t, cenc: !!(s && s.cenc), hdr: !!(s && s.hdr) }; }),
    snapshot: snapshot,
    errorInfo: errorInfo,
    avTuning: AvEngine.tuning,
    wallClock: wallClock,
    positionAt: positionAt,
    stream: function () { return current; },
    togglePause: traced('player.togglePause', togglePause, function () { return { wasPaused: !!(engine && engine.paused()) }; }),
    isLive: proxy('isLive', false),
    isPaused: proxy('paused', false),
    range: proxy('range', { start: 0, end: 0 }),
    position: proxy('position', 0),
    /** The position from the engine's own clock (for keeping other pictures in step: the H.264 multiview's small feeds). */
    exactPosition: proxy('exactPosition', 0),
    /** Frames decoded since the load (a new load restarts the count), or null where the engine doesn't tell (AVPlay). */
    decodedFrames: proxy('decodedFrames', null),
    bufferedEnd: proxy('bufferedEnd', 0),
    /** Whether Shaka loaded a frozen start again (reloadIfFrozen) at or after `since` (ms): that start is still loading. */
    reloadedSince: function (since) { return engine === ShakaEngine && ShakaEngine.reloadedAt() >= since; },
    /** When that reload began (ms), or 0. */
    reloadedAt: function () { return engine === ShakaEngine ? ShakaEngine.reloadedAt() : 0; },
    /** Paused by the viewer (Shaka's element is also paused while a frozen start loads again). */
    isViewerPaused: function () { return engine === ShakaEngine ? ShakaEngine.viewerPaused() : !!(engine && engine.paused()); },
    engineName: function () { return engineName; },
    /**
     * Long-segment replays on AVPlay (30 s segments): { size, origin } of the segment grid. A seek
     * to a segment start plays in ~3 s; one deep inside a segment can take 10 s.
     */
    seekGrid: function () { return engine === AvEngine ? AvEngine.grid() : null; },
    tracks: function () { return engine ? engine.tracks() : { audio: [], text: [] }; },
    /** Audio channels playing, where the engine tells: 2, 6, ...; null otherwise. Asked every 500 ms by the player bar: kept 2 s. */
    audioChannels: function () {
      var now = Date.now();
      if (channelsSeen.stream === current && now - channelsSeen.at < 2000) return channelsSeen.n;
      var n = null;
      try { n = engine && engine.audioChannels ? engine.audioChannels() : null; } catch (e) { n = null; }
      channelsSeen = { stream: current, at: now, n: n };
      return n;
    },
    setAudio: traced('player.setAudio', function (l) { channelsSeen.at = 0; if (engine) engine.setAudio(l); }, function (l) { return { lang: l }; }),
    setSubtitles: traced('player.setSubtitles', function (l) { if (engine) engine.setSubtitles(l); }, function (l) { return { lang: l }; }),
    forceEngine: null,
    /** Multiview: where AVPlay draws the grid's picture ([x, y, w, h] on the 1920x1080 screen, null: all of it). */
    setGridRect: function (rect) { AvEngine.setGridRect(rect); },
    on: function (name, fn) { listeners[name] = fn; }
  };
})();

if (typeof Diag !== 'undefined') Diag.provide('player', function () { return Player.snapshot(); });
