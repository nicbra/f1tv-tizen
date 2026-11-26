/*
 * F1TV API client. Endpoint shapes follow the community clients
 * eXhumer/f1tv-api and npanu420/F1OpenViewer (both MIT).
 * Written for Chromium 76 (Tizen 6.0): no optional chaining / nullish coalescing.
 */
var F1Api = (function () {
  var BASE = 'https://f1tv.formula1.com';
  var LANG = 'ENG';
  // Try the TV platform before the web fallback.
  var PLAY_PLATFORMS = ['BIG_SCREEN_DASH', 'WEB_DASH'];
  var PAGE_PLATFORM = 'WEB_DASH';
  // How long the extra HDR request may take before playback goes ahead without it.
  var HDR_WAIT = 8000;
  // F1's Tiledmedia offer (PLAY, usually answered ahead by prefetchTm, plus its master) gets its own share first, so a
  // slow one still leaves the usual HDR request its full HDR_WAIT (live: native HDR before SDR).
  var TM_WAIT = 5000;
  // Playback requires this header in web-player format; 'device=tv' is rejected.
  var DEVICE_INFO = 'device=web;screen=browser;os=tizen;browser=chrome;browserVersion=76;' +
    'osVersion=6.0;appVersion=55.0.3;playerVersion=8.212.0;p=false;tms=1';
  // Fallback IDs when menu() is unavailable.
  var HOME_PAGE_ID = 395;
  var ARCHIVE_PAGE_ID = 493;

  var state = {
    config: null,
    playApi: '3.0',
    videoApi: '4.0',
    ascendon: null,      // subscription token (JWT) from login / pairing
    entitlement: null,   // entitlement token from USER/ENTITLEMENT
    location: null       // { entitlement, groupId, ... }
  };

  function loginStatus() { return state.ascendon ? 'R' : 'A'; }

  /** Diagnostics log (js/diag.js), when it is loaded. */
  function diag(kind, data, level) { if (typeof Diag !== 'undefined') Diag.note(kind, data, level); }

  /** An operation that failed (the upload's api.request_failed: a fixed label and the status, no URL). */
  function failed(op, status, retries) {
    if (op && typeof DiagUpload !== 'undefined') DiagUpload.apiFailed(op, status || null, retries || 0);
  }

  /** Either diagnostics log is on: worth summing up what a manifest offers. */
  function observed() {
    return (typeof Diag !== 'undefined' && Diag.recording()) || (typeof DiagUpload !== 'undefined' && DiagUpload.enabled());
  }

  /**
   * F1's PLAY endpoint is rate-limited per IP by CloudFront: ~250 PLAY requests in 3-4 min blocked playback for the
   * whole household for 30-45 min (2026-10-28), with an HTML 403 "Request blocked" (or a 429). Every further request
   * then only lengthens the block, so after one, PLAY requests wait: Retry-After where given, else 10 min. The block
   * is CloudFront's, not F1's: an F1 answer (JSON, such as "Not entitled") never starts it.
   */
  var playBlockedUntil = 0;   // on monotonic() time, so a TV clock change neither ends nor stretches it
  var PLAY_BLOCK_MS = 10 * 60 * 1000;
  function isPlay(url) { return /\/CONTENT\/PLAY\?/.test(url); }
  function monotonic() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  /** How long a block lasts: Retry-After in seconds or as an HTTP date (0 included), else 10 min; at most 1 h. */
  function blockMs(retryAfter) {
    var v = String(retryAfter || '').trim(), ms = PLAY_BLOCK_MS;
    if (/^\d+$/.test(v)) ms = +v * 1000;
    else if (v && !isNaN(Date.parse(v))) ms = Date.parse(v) - Date.now();
    return Math.max(0, Math.min(ms, 60 * 60 * 1000));
  }

  /**
   * F1's own message (an entitlement or region refusal, also inside an HTTP 200 answer) or this app's plain one, which
   * the TV may show (app.js recover: forViewer); else `technical` (its own words, for the diagnostics only).
   */
  function viewerError(message, technical) {
    var e = new Error(message || technical);
    e.forViewer = !!message;
    return e;
  }

  function http(url, opts) {
    opts = opts || {};
    if (isPlay(url) && monotonic() < playBlockedUntil) {
      var waiting = new Error('F1 TV is limiting video requests from this network for a few minutes. Try again in ' +
        Math.max(1, Math.ceil((playBlockedUntil - monotonic()) / 60000)) + ' min.');
      waiting.status = 429;
      waiting.blocked = true;
      waiting.local = true;   // nothing was asked: no HTTP result for the diagnostics
      waiting.forViewer = true;   // the TV shows this message (app.js recover); others only go to the diagnostics
      return Promise.reject(waiting);
    }
    return fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body
    }).catch(function (e) {
      diag('api.network', { url: url, error: e });
      failed(opts.op, null, 0);
      throw e;
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null, json = false;
        try { data = text ? JSON.parse(text) : null; json = !!text; } catch (e) { /* not JSON */ }
        if (!res.ok) {
          var msg = (data && (data.message || (data.resultObj && data.resultObj.message))) || ('HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          // F1's own message (an entitlement or region refusal) is written for the viewer; 'HTTP 403' isn't.
          err.forViewer = msg !== 'HTTP ' + res.status;
          // An HTML 403 is CloudFront's per-IP block ("Request blocked"), not an F1 TV answer.
          var blocked = !json && (res.status === 429 || (res.status === 403 && /Request blocked/i.test(text)));
          diag('api.http', { url: url, status: res.status, message: msg, blocked: blocked });
          if (blocked && isPlay(url)) {
            var ms = blockMs(res.headers && res.headers.get ? res.headers.get('Retry-After') : '');
            playBlockedUntil = Math.max(playBlockedUntil, monotonic() + ms);
            err.blocked = true;
          }
          failed(opts.op, res.status, 0);
          throw err;
        }
        return data;
      });
    });
  }

  function loc() {
    var l = state.location;
    return {
      entitlement: (l && l.entitlement) || 'F1_TV_Pro_Annual',
      groupId: (l && l.groupId != null) ? l.groupId : 2
    };
  }

  function authHeaders() {
    var h = {};
    if (state.ascendon) h.ascendontoken = state.ascendon;
    if (state.entitlement) h.entitlementtoken = state.entitlement;
    return h;
  }

  function refreshConfig() {
    return http(BASE + '/config', { op: 'config' }).then(function (cfg) {
      state.config = cfg;
      var api = (cfg && cfg.apiConfig) || {};
      if (/^\d+\.\d+$/.test(api.playAPIVersion || '')) state.playApi = api.playAPIVersion;
      if (/^\d+\.\d+$/.test(api.videoAPIVersion || '')) state.videoApi = api.videoAPIVersion;
      return cfg;
    });
  }

  function refreshLocation() {
    var url = [BASE, '1.0', loginStatus(), LANG, PAGE_PLATFORM, 'ALL/USER/LOCATION'].join('/');
    var headers = state.entitlement ? { entitlementtoken: state.entitlement } : {}, forToken = state.ascendon;
    return http(url, { headers: headers, op: 'location' }).then(function (data) {
      var list = data && data.resultObj && data.resultObj.userLocation;
      state.location = (list && list[0]) || null;
      // Whose location this is: the diagnostics tier is unknown while it belongs to another sign-in.
      state.locationFor = forToken;
      return state.location;
    });
  }

  function fetchEntitlement() {
    var url = [BASE, '2.0', 'R', LANG, PAGE_PLATFORM, 'ALL/USER/ENTITLEMENT'].join('/');
    return http(url, { headers: { ascendontoken: state.ascendon }, op: 'entitlement' }).then(function (data) {
      // HTTP 200 can still carry a fault or an empty resultObj; say so rather than fail on undefined.
      var token = data && data.resultObj && data.resultObj.entitlementToken;
      if (!token) throw viewerError(data && data.resultObj && data.resultObj.message, 'no entitlement token');
      state.entitlement = token;
      return state.entitlement;
    });
  }

  /** The diagnostics upload's account.status follows sign-in and the tier (it sends only changes). */
  function accountChanged(v) {
    if (typeof DiagUpload !== 'undefined') DiagUpload.account();
    return v;
  }

  function login(ascendon) {
    state.ascendon = ascendon;
    return fetchEntitlement().then(refreshLocation).then(accountChanged);
  }

  function logout() {
    state.ascendon = null;
    state.entitlement = null;
    return refreshLocation().then(accountChanged, function (e) { accountChanged(); throw e; });
  }

  function page(pageId) {
    var l = loc();
    var url = [BASE, '2.0', loginStatus(), LANG, PAGE_PLATFORM, 'ALL/PAGE', pageId, l.entitlement, l.groupId].join('/');
    return http(url, { headers: authHeaders(), op: 'content_list' }).then(function (data) {
      return (data && data.resultObj && data.resultObj.containers) || [];
    });
  }

  /** Follows an action uri from a page item (they are already full API paths). */
  function pageByUri(uri) {
    var url = uri.indexOf('http') === 0 ? uri : BASE + uri;
    return http(url, { headers: authHeaders(), op: 'content_list' }).then(function (data) {
      return (data && data.resultObj && data.resultObj.containers) || [];
    });
  }

  function video(contentId) {
    var l = loc();
    var url = [BASE, state.videoApi, loginStatus(), LANG, PAGE_PLATFORM, 'ALL/CONTENT/VIDEO', contentId, l.entitlement, l.groupId].join('/');
    return http(url, { headers: authHeaders(), op: 'content_detail' }).then(function (data) {
      var c = data && data.resultObj && data.resultObj.containers;
      if (!c || !c.length) throw viewerError('Video not found');
      return c[0];
    });
  }

  function playOn(platform, contentId, channelId, deviceInfo) {
    var url = [BASE, state.playApi, 'R', LANG, platform, 'ALL/CONTENT/PLAY'].join('/') +
      '?contentId=' + encodeURIComponent(contentId) + '&player=player_bm' +
      (channelId ? '&channelId=' + encodeURIComponent(channelId) : '');
    var headers = authHeaders();
    headers['x-f1-device-info'] = deviceInfo || DEVICE_INFO;
    return http(url, { headers: headers }).then(function (data) {
      var r = data && data.resultObj;
      if (!r || !r.url) {
        throw viewerError(data && data.message, 'No stream returned');
      }
      r.platform = platform;
      return r;
    });
  }

  /**
   * What kind of answer a PLAY request gave, as the diagnostics upload names it (families, never F1's own strings or
   * URLs): hls, dash, wv_dash, wv_cenc_dash, hdr_hls, hdr_cmaffp_hls or other.
   */
  function offerFamily(r) {
    if (!r || typeof r.url !== 'string') return 'other';
    var t = String(r.streamType || '').toUpperCase(), hls = /\.m3u8(\?|$)/.test(r.url), mpd = /\.mpd(\?|$)/.test(r.url);
    if (hls) return /^HDR_/.test(t) ? (/CMAFFP/.test(t) ? 'hdr_cmaffp_hls' : 'hdr_hls') : 'hls';
    if (mpd) return /WV/.test(t) ? (/CENC/.test(t) ? 'wv_cenc_dash' : 'wv_dash') : 'dash';
    return 'other';
  }

  /** One request's answer into `offers[key]`: no_answer from asking until an answer (later ones are ignored). */
  function probe(offers, key, ask) {
    if (!offers) return ask;
    offers[key] = 'no_answer';
    var open = true;
    ask.then(function (r) { if (open && offers[key] === 'no_answer') offers[key] = offerFamily(r); }, function () {});
    offers.close = offers.close || [];
    offers.close.push(function () { open = false; });
    return ask;
  }

  /**
   * The last HLS master an HDR check read ({ url, base (where it was answered from), who, text, at }): hlsInfo reads it
   * again within a minute, for the same sign-in, instead of the CDN.
   */
  var lastMaster = null;
  function keepMaster(url, text, base) { lastMaster = { url: url, base: base || url, who: state.ascendon, text: text, at: Date.now() }; return text; }

  var LANG3 = { en: 'eng', de: 'deu', fr: 'fra', nl: 'nld', pt: 'por', ja: 'jpn', es: 'spa', it: 'ita' };
  function lang3(l) { l = String(l || '').toLowerCase(); return LANG3[l] || l; }
  /** One attribute of an HLS tag line, exactly (LANGUAGE is not ASSOC-LANGUAGE). */
  function hlsAttr(line, name) {
    var m = new RegExp('[:,]' + name + '=(?:"([^"]*)"|([^,]*))').exec(line);
    return m ? (m[1] != null ? m[1] : m[2]) : '';
  }

  /** F1's Tiledmedia answers (playTm), per sign-in and video, the last few: every feed of the video, kept TM_KEEP ms. */
  var tmAnswers = [];
  var TM_KEEP = 30 * 60 * 1000;
  var TM_CLEAR_WAIT = 4000;   // tmClearOffer: its master's check at most this long
  var tmAsking = {};   // requests under way, per sign-in and video (a prefetch and a start share one)

  /**
   * F1's Tiledmedia answer for a video (cached, shared while asked, else one PLAY): { feeds: { channel: url },
   * subs: { channel: [lang] }, main, streamType, entitlementToken, refused }, or null after a sign-in change.
   */
  function tmAnswerFor(contentId, want, mainChannel) {
    var id = String(contentId), who = state.ascendon, key = who + '|' + id;
    var mainOf = function (t) { return t.main || (mainChannel && t.feeds[mainChannel] ? String(mainChannel) : null); };
    var a = tmAnswers.filter(function (x) { return x.key === key && Date.now() < x.until; })[0];
    if (a && (a.refused || (want ? Object.keys(a.feeds).length > 0 : !!mainOf(a)))) return Promise.resolve(a);
    var asking = tmAsking[key];
    if (asking && (want || !asking.want)) return asking.promise;
    var url = [BASE, state.playApi, 'R', LANG, 'BIG_SCREEN_HLS', 'ALL/CONTENT/PLAY'].join('/') +
      '?contentId=' + encodeURIComponent(contentId) + '&player=player_tm' + (want ? '&channelId=' + encodeURIComponent(want) : '');
    var headers = authHeaders();
    headers['x-f1-device-info'] = 'device=tvos;';
    var promise = http(url, { headers: headers }).then(function (data) {
      var r = (data && data.resultObj) || {}, feeds = {}, subs = {};
      ((r.tme && r.tme.feeds) || []).forEach(function (f) {
        var ch = f && f.metadata && f.metadata.channel_id;
        if (ch == null || typeof f.url !== 'string') return;
        feeds[String(ch)] = f.url;
        // The subtitles F1's player offers on it (eng_subtitle, ...): the playlist must have them all.
        subs[String(ch)] = Object.keys(f.subtitle_track_names || {}).map(function (k) { return lang3(k.replace(/_subtitle$/, '')); });
      });
      var same = a && !a.refused && a.streamType === (r.streamType || '') ? a : null;
      return { key: key, until: Date.now() + TM_KEEP, streamType: r.streamType || '', entitlementToken: r.entitlementToken,
        feeds: feeds, subs: subs, refused: !Object.keys(feeds).length,
        main: want ? (same && same.main) : (r.channelId != null ? String(r.channelId) : null) };
    }, function (e) {
      // F1 answering no (Pro, or a rule this request doesn't meet) is kept 30 min; a block or a failure only briefly.
      var answered = e && !e.blocked && e.data != null && e.status >= 400;
      return { key: key, until: Date.now() + (answered ? TM_KEEP : 60 * 1000), streamType: '', feeds: {}, subs: {}, refused: true, main: null };
    }).then(function (t) {
      if (tmAsking[key] && tmAsking[key].promise === promise) delete tmAsking[key];
      if (state.ascendon !== who) return null;   // signed out or in as someone else meanwhile: neither kept nor used
      tmAnswers = [t].concat(tmAnswers.filter(function (x) { return x.key !== key; })).slice(0, 4);
      return t;
    });
    // Its own deadline: a request that never answers must not hold every later start of the video (6 s, then 1 min off).
    var timer = null;
    promise = Promise.race([promise, new Promise(function (resolve) {
      timer = setTimeout(function () {
        if (tmAsking[key] && tmAsking[key].promise === shared) delete tmAsking[key];
        if (state.ascendon !== who) return resolve(null);
        var off = { key: key, until: Date.now() + 60 * 1000, streamType: '', feeds: {}, subs: {}, refused: true, main: null };
        tmAnswers = [off].concat(tmAnswers.filter(function (x) { return x.key !== key; })).slice(0, 4);
        resolve(off);
      }, 6000);
    })]).then(function (t) { clearTimeout(timer); return t; });
    var shared = promise;
    tmAsking[key] = { want: want, promise: promise };
    return promise;
  }

  /**
   * F1's Tiledmedia offer, as F1's own Apple TV and Android TV players ask (player=player_tm), with device=tvos;.
   * One answer has every feed of the video (tme.feeds: channel_id and HLS url; with no channelId asked, its channelId
   * is the main feed's). For Premium it is HDR_UHD_HLSCK: 4K/1080p HLG, the AC-3 5.1 on F1 LIVE, and AES-128 with the
   * key address in the playlist, which Shaka decrypts itself (no DRM). The answer is kept 30 min for the video's other
   * feeds (its addresses last hours), so feed switches need no PLAY request. Resolves an offer for the feed, or null
   * unless it is such HDR (SDR for Pro, untested; old replays): the caller asks the usual way then.
   */
  function playTm(contentId, channelId, langs, mainChannel) {
    var want = channelId ? String(channelId) : null, who = state.ascendon;
    return tmAnswerFor(contentId, want, mainChannel).then(function (t) {
      var ch = t && !t.refused ? want || t.main || (mainChannel && t.feeds[mainChannel] ? String(mainChannel) : null) : null;
      var url = ch && t.feeds[ch];
      if (!url || !/^HDR_/.test(t.streamType) || !/\.m3u8(\?|$)/.test(url)) return null;
      return fetch(url).then(function (res) {
        return res.ok ? res.text().then(function (text) { return { text: text, base: res.url || url }; }) : { text: '' };
      }).then(function (got) {
        var master = got.text;
        if (state.ascendon !== who || !/^#EXTM3U\s/.test(master)) return null;
        // Whole-segment AES-128, with its key at an address the playlist names: never FairPlay or Widevine, nor a master
        // that names no key (its variants could still use another kind).
        var keys = master.match(/^#EXT-X-(?:SESSION-)?KEY:.*$/gm) || [];
        if (!keys.length || !keys.every(function (k) {
          return hlsAttr(k, 'METHOD') === 'AES-128' && /^https:\/\//.test(hlsAttr(k, 'URI')) && /^(identity)?$/.test(hlsAttr(k, 'KEYFORMAT'));
        })) return null;
        // The HLG variants, and their own sound and subtitles with every language F1 names for the feed: TRACKER and DATA
        // have no sound here (F1's player takes another feed's), onboards only team radio. Those play the usual offer.
        var groups = {}, textGroups = {};
        (master.match(/^#EXT-X-STREAM-INF:.*$/gm) || []).forEach(function (l) {
          if (hlsAttr(l, 'VIDEO-RANGE') !== 'HLG') return;
          groups[hlsAttr(l, 'AUDIO')] = true;
          textGroups[hlsAttr(l, 'SUBTITLES')] = true;
        });
        if (!Object.keys(groups).length) return null;
        var langsOf = function (type, use) {
          return (master.match(/^#EXT-X-MEDIA:.*$/gm) || []).filter(function (l) {
            return hlsAttr(l, 'TYPE') === type && use[hlsAttr(l, 'GROUP-ID')];
          }).map(function (l) { return lang3(hlsAttr(l, 'LANGUAGE')); });
        };
        var have = langsOf('AUDIO', groups), texts = langsOf('SUBTITLES', textGroups);
        if (!have.length || (langs || []).some(function (l) { return have.indexOf(lang3(l)) < 0; })) return null;
        if (((t.subs || {})[ch] || []).some(function (l) { return texts.indexOf(l) < 0; })) return null;
        keepMaster(url, master, got.base);
        return { url: url, streamType: t.streamType, platform: 'BIG_SCREEN_HLS', entitlementToken: t.entitlementToken, hdr: true,
          hlsAes: true, who: who };
      });
    }).catch(function () { return null; });
  }

  /**
   * The tvOS request's HLG offer. Clear HLS stays on Shaka; supported CBCS uses the normal Widevine offer.
   * With `tm`, F1's Tiledmedia offer is asked first (playTm). Null unless F1 answers with HDR (it gives SDR to Pro
   * and for old replays), so the caller can fall back.
   */
  function playHdr(contentId, channelId, offers, tm, langs, mainChannel) {
    var late = false;   // past HDR_WAIT: the caller plays SDR, and no further HDR request goes out
    if (tm && offers) offers.hdr = 'no_answer';
    var tmLate = false;
    var first = !tm ? Promise.resolve(null) : new Promise(function (resolve) {
      var timer = setTimeout(function () { tmLate = true; resolve(null); }, TM_WAIT);
      playTm(contentId, channelId, langs, mainChannel).then(function (t) { clearTimeout(timer); resolve(tmLate ? null : t); });
    });
    var ask = first.then(function (t) {
      if (t) { if (offers && !late) offers.hdr = offerFamily(t); return t; }
      return late ? null : usual();
    });
    function usual() { return probe(offers, 'hdr', playOn(PLAY_PLATFORMS[0], contentId, channelId, 'device=tvos;')).then(function (r) {
      if (!/^HDR_/.test(r.streamType || '') || typeof r.url !== 'string' ||
          !/\.m3u8(\?|$)/.test(r.url) || ((r.laURL || r.laUrl) && !/CMAFFP/.test(r.streamType))) return null;
      // tvOS may receive FairPlay streams, which this player cannot decrypt.
      return fetch(r.url).then(function (res) {
        if (!res.ok) return null;
        return res.text().then(function (master) {
          if (!/^#EXTM3U\s/.test(master)) return null;
          keepMaster(r.url, master, res.url);
          if (hasKeys(master)) {
            var keys = master.match(/^#EXT-X-(?:SESSION-)?KEY:.*$/gm) || [];
            if (!/CMAFFP/.test(r.streamType) || !keys.length || !keys.every(function (k) {
              return /[:,]METHOD=SAMPLE-AES(?:,|$)/.test(k) && /KEYFORMAT="com\.apple\.streamingkeydelivery"/.test(k) && /URI="skd:\/\//.test(k);
            })) return null;
            r.hdrEncrypted = true;
          } else if (r.laURL || r.laUrl) return null;
          r.hdr = true;
          return r;
        });
      });
    }).catch(function () { return null; }); }
    // Never let the extra request hold up playback (with the Tiledmedia offer first: its own TM_WAIT more at most).
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { late = true; resolve(null); }, HDR_WAIT + (tm ? TM_WAIT : 0));
      ask.then(function (r) { clearTimeout(timer); resolve(r); });
    });
  }

  /** True when an HLS playlist has a key other than METHOD=NONE (the variant playlists can have them too). */
  function hasKeys(playlist) {
    return (playlist.match(/^#EXT-X-(?:SESSION-)?KEY:.*$/gm) || []).some(function (key) {
      return !/[:,]\s*METHOD=NONE\s*(?:,|$)/.test(key.replace(/"[^"]*"/g, ''));
    });
  }

  /**
   * F1's normal protected streams are cbcs. Asked as a Chromecast it gives the same stream in cenc,
   * including live (measured in PR #3 on Tizen 5); browser Widevine can play that on Shaka. An extra request,
   * like the HDR one: its answer is used only when it is cenc Widevine DASH, otherwise `normal`.
   */
  function cencOffer(normal, contentId, channelId, offers) {
    if (!/WV/i.test(normal.streamType || '') || /CENC/i.test(normal.streamType) || !/\.mpd(\?|$)/.test(normal.url || '')) return Promise.resolve(normal);
    return probe(offers, 'cenc', playOn(normal.platform, contentId, channelId, 'device=chromecast;')).then(function (r) {
      if (!/WV/i.test(r.streamType || '') || !/_CENC$/i.test(r.streamType) || !/\.mpd(\?|$)/.test(r.url)) return normal;
      r.cenc = true;
      return r;
    }, function () { return normal; });
  }

  /** Resolves the manifest URL, license URL and required license headers. */
  function play(contentId, channelId, opts) {
    var i = 0;
    var firstErr = null, lastErr = null;
    // Which requests were asked and what came back (for the diagnostics upload; nothing extra is requested for it).
    var offers = observed() ? { web: 'not_asked', hdr: 'not_asked', cenc: 'not_asked' } : null;
    function next() {
      if (i >= PLAY_PLATFORMS.length) {
        // Every platform failed: one failed operation (a session that hasn't started yet isn't one).
        if (!isNotStarted(firstErr)) failed('playback_offer', lastErr && lastErr.status, i - 1);
        return Promise.reject(firstErr || viewerError('Playback unavailable'));
      }
      var platform = PLAY_PLATFORMS[i++];
      var ask = playOn(platform, contentId, channelId);
      if (offers) probe(offers, 'web', ask);   // a later platform only after the first failed
      return ask.catch(function (e) {
        // A block applies to every platform: stop here (and an answer this app didn't ask for is no HTTP result).
        if (e && e.blocked) {
          if (!e.local) failed('playback_offer', e.status, i - 1);
          throw e;
        }
        if (!firstErr) firstErr = e;
        lastErr = e;
        return next();
      });
    }
    // F1 decides what an account gets: the HDR request is asked for every account, and its answer is used
    // only when it is HDR (playHdr). Otherwise (Pro gets SDR from it) the normal request, as before.
    var request = opts && opts.hdr
      ? playHdr(contentId, channelId, offers, !!opts.tm, opts.langs, opts.mainChannel).then(function (hdr) {
        // Apple TV is the only 4K HDR offer: clear HLS on some replays, cbcs on others and live.
        // There is no cenc HDR. Keep clear HDR when the TV has learned to avoid native cbcs, and the other way round
        // (opts.cbcs / opts.clearHdr false: that way of 4K HDR failed for this video or on this TV).
        if (!hdr || (hdr.hdrEncrypted && opts.cbcs === false) || (!hdr.hdrEncrypted && !hdr.hlsAes && opts.clearHdr === false)) return next();
        if (!hdr.hdrEncrypted) return hdr;
        // Multiview's other feeds: the HDR stream alone, one PLAY session each. The first feed's Widevine
        // offer has the licence and the clock; F1 limits how many streams an account plays at once.
        if (opts.hdrOnly) return Object.assign({}, hdr, { laURL: '', laUrl: '' });
        return next().then(function (normal) {
          if (!/WV/i.test(normal.streamType || '') || !/\.mpd(\?|$)/.test(normal.url)) return normal;
          return Object.assign({}, normal, { url: hdr.url, streamType: hdr.streamType, hdr: true, hdrEncrypted: true,
            widevineManifestUrl: normal.url, entitlementToken: hdr.entitlementToken || normal.entitlementToken });
        });
      }) : next();
    if (opts && opts.cenc) request = request.then(function (r) { return r.hdr ? r : cencOffer(r, contentId, channelId, offers); });
    return request.then(function (r) {
      var la = r.laURL || r.laUrl || '';
      if (!la && (/WV/i.test(r.streamType || '') || r.hdrEncrypted)) {
        // Newer VODs omit laURL; the web player falls back to this endpoint.
        la = [BASE, '2.0', 'R', LANG, r.platform, 'ALL/CONTENT/LA/widevine'].join('/') +
          '?contentId=' + encodeURIComponent(contentId) +
          (channelId ? '&channelId=' + encodeURIComponent(channelId) : '');
      }
      var licenseHeaders = {
        ascendontoken: state.ascendon,
        entitlementtoken: r.entitlementToken || state.entitlement,
        'x-f1-device-info': DEVICE_INFO
      };
      if (r.drmToken) licenseHeaders.customdata = r.drmToken;
      var stream = {
        url: r.url,
        streamType: r.streamType || '',
        platform: r.platform,
        licenseUrl: la,
        licenseHeaders: licenseHeaders
      };
      if (r.hdr) stream.hdr = true;
      if (r.cenc) stream.cenc = true;
      // AES-128 HLS (playTm): Shaka fetches the key from the playlist's address, with the account's tokens.
      if (r.hlsAes) {
        if (r.who !== state.ascendon) throw new Error('Signed in again while the video was asked for');
        stream.hlsAes = true;
        stream.keyHeaders = { ascendontoken: r.who, entitlementtoken: r.entitlementToken || state.entitlement };
      }
      if (r.hdrEncrypted) { stream.hdrEncrypted = true; stream.widevineManifestUrl = r.widevineManifestUrl; }
      if (offers) {
        (offers.close || []).forEach(function (close) { close(); });
        stream.offers = { web: offers.web, hdr: offers.hdr, cenc: offers.cenc, chosen: r.hdr ? 'hdr' : r.cenc ? 'cenc' : 'web' };
      }
      return stream;
    });
  }

  /** F1 TV's navigation menu: [{ title, uri }] (Home, 2026 Season, Archive, Shows, ...). */
  function menu() {
    var l = loc();
    var url = [BASE, '2.0', loginStatus(), LANG, PAGE_PLATFORM, 'ALL/MENU', l.entitlement, l.groupId].join('/');
    return http(url, { headers: authHeaders(), op: 'menu' }).then(function (data) {
      var out = [];
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        var m = o.metadata || {}, a = (o.actions || [])[0];
        if ((m.label || m.title) && a && /\/PAGE\//.test(a.uri || '')) out.push({ title: m.label || m.title, uri: a.uri });
        Object.keys(o).forEach(function (k) { if (k !== 'metadata' && k !== 'actions') walk(o[k]); });
      })(data && data.resultObj);
      return out;
    });
  }

  /** The channel a feed plays: the one its playbackUrl names, or null for the video's main stream. */
  function feedChannel(s) {
    if (typeof s.playbackUrl !== 'string') return s.channelId || null;
    var m = /[?&]channelId=([^&]+)/.exec(s.playbackUrl);
    // Only INTERNATIONAL is the main stream; an onboard always has a channel of its own.
    return m ? decodeURIComponent(m[1]) : s.type === 'obc' ? s.channelId || null : null;
  }

  /**
   * A video's feeds, its main stream first: [{ title, type, channelId, hex, full, num, langs }]. `langs`: the audio
   * languages F1's video information names for the feed (its commentaries, `tea` for team radio), where it names any.
   * INTERNATIONAL's playbackUrl names no channel: it is the main stream, and F1 rejects its channelId
   * (1025) for most replays, so it names the first entry instead of being listed twice.
   */
  function feedsFrom(m) {
    var main = { title: 'Main feed', type: 'Broadcast', channelId: null, langs: [] }, mainSeen = false;
    var feeds = [main];
    ((m && m.additionalStreams) || []).forEach(function (s) {
      var name = s.title || s.reportingName || (s.driverFirstName && (s.driverFirstName + ' ' + s.driverLastName)) || 'Feed';
      var channelId = feedChannel(s), langs = Object.keys(s.audioTrackNames || {});
      if (!channelId) {
        if (s.type !== 'obc' && !mainSeen) {
          mainSeen = true;
          if (!/^main/i.test(name)) main.title = name;
          main.langs = langs;
          // Its channel, never asked for (F1 rejects it for most replays) but named in a Tiledmedia answer (playTm).
          if (s.channelId != null) main.tmChannel = String(s.channelId);
        }
        return;
      }
      feeds.push({ title: name, type: s.type === 'obc' ? (s.teamName || 'Onboard') : '', onboard: s.type === 'obc', channelId: channelId, hex: s.hex || '', langs: langs,
        full: s.driverFirstName ? s.driverFirstName + ' ' + s.driverLastName : '',
        num: s.type === 'obc' && s.racingNumber != null ? String(s.racingNumber) : '' });
    });
    return feeds;
  }

  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    if (/^\d+$/.test(v)) return +v;
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  /**
   * The broadcast schedule of a race weekend, from a page's interactive_schedule container:
   * [{ contentId, title, series, start, end, pictureUrl, meeting }] sorted by start time.
   */
  function scheduleFrom(containers) {
    var box = (containers || []).filter(function (c) { return c.layout === 'interactive_schedule'; })[0];
    var groups = box && box.retrieveItems && box.retrieveItems.resultObj && box.retrieveItems.resultObj.containers;
    if (!groups || !groups.length) return null;
    var all = groups.filter(function (g) { return g.eventName === 'ALL'; })[0] || groups[0];
    var events = (all.events || []).map(function (ev) {
      var m = ev.metadata || {}, e = m.emfAttributes || {};
      return {
        contentId: m.contentId || ev.id,
        houseId: m.externalId || '',       // links the parts of a multipart event (see app.js offerNextPart)
        title: m.titleBrief || m.title || '',
        series: e.Series || m.uiSeries || '',
        start: toMs(e.sessionStartDate) || m.contractStartDate || null,
        end: toMs(e.sessionEndDate) || toMs(e.sessionEndTime),
        pictureUrl: m.pictureUrl,
        subtype: m.contentSubtype || '',   // LIVE = on air now, LIVE_EVENT = scheduled, REPLAY = done
        meeting: e.Meeting_Name || e.Global_Meeting_Name || '',
        meetingKey: e.MeetingKey,
        meetingEnd: toMs(e.Meeting_End_Date),
        endIso: e.sessionEndTime || ''
      };
    }).filter(function (ev) { return ev.start; });
    events.sort(function (a, b) { return a.start - b.start; });
    return { meeting: events.length ? events[0].meeting : '', events: events };
  }

  /** Meetings of a season page (the "2026 Season" menu entry), in calendar order. */
  function seasonFrom(containers) {
    var out = [], seen = {};
    (containers || []).forEach(function (c) {
      var items = (c.retrieveItems && c.retrieveItems.resultObj && c.retrieveItems.resultObj.containers) || [];
      items.forEach(function (it) {
        var m = it.metadata || {}, e = m.emfAttributes || {}, a = (it.actions || [])[0] || {};
        // The current weekend is listed in more than one section of the season page.
        if (!e.MeetingKey || !/\/PAGE\//.test(a.uri || '') || seen[e.MeetingKey]) return;
        seen[e.MeetingKey] = true;
        out.push({
          key: e.MeetingKey,
          name: e.Meeting_Name || e.Global_Meeting_Name || m.title || '',
          country: e.Meeting_Country_Name || e.Global_Meeting_Country_Name || '',
          round: e.Championship_Meeting_Ordinal || '',
          test: String(e.IsTestEvent).toLowerCase() === 'true' || /TESTING/i.test(m.title || ''),
          start: toMs(e.Meeting_Start_Date),
          end: toMs(e.Meeting_End_Date),
          pictureUrl: m.pictureUrl,
          uri: a.uri
        });
      });
    });
    out.sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
    return out;
  }

  function isoSeconds(d) {
    var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(d || '');
    return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0)) : 0;
  }

  /**
   * Timing facts from a DASH manifest, in player-position seconds:
   * { dynamic, windowStart, windowEnd, epochAtZero (unix seconds at position 0), delay }.
   * F1's media timeline counts Unix time, so positions map to real clock time.
   */
  /** A manifest's text; an error page (a CDN 503, say) is a failure, not a manifest. */
  function manifest(url, re) {
    return fetch(url).then(function (r) {
      if (!r.ok) { failed('manifest', r.status, 0); throw new Error('HTTP ' + r.status); }
      return r.text();
    }, function (e) { failed('manifest', null, 0); throw e; }).then(function (text) {
      if (!re.test(text)) throw new Error('Not a manifest');
      return text;
    });
  }

  /** What an HLS master offers, for the diagnostics log: variants (size, rate, codecs, range), languages, key formats. */
  function hlsOffer(master) {
    var attrs = function (line) {
      var o = {}, re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, m;
      while ((m = re.exec(line))) o[m[1]] = m[2].replace(/^"|"$/g, '');
      return o;
    };
    var variants = [], audio = [], text = [], keys = [];
    master.split('\n').forEach(function (l) {
      if (l.indexOf('#EXT-X-STREAM-INF:') === 0) {
        var a = attrs(l.slice(18));
        variants.push({ kbps: Math.round(+a.BANDWIDTH / 1000) || null, res: a.RESOLUTION || null, codecs: a.CODECS || null,
          range: a['VIDEO-RANGE'] || null, fps: +a['FRAME-RATE'] || null });
      } else if (l.indexOf('#EXT-X-MEDIA:') === 0) {
        var x = attrs(l.slice(13));
        (x.TYPE === 'AUDIO' ? audio : x.TYPE === 'SUBTITLES' ? text : []).push(x.LANGUAGE || x.NAME || '?');
      } else if (/^#EXT-X-(SESSION-)?KEY:/.test(l)) {
        var k = attrs(l.replace(/^#EXT-X-(SESSION-)?KEY:/, ''));
        keys.push((k.METHOD || '?') + (k.KEYFORMAT ? ' ' + k.KEYFORMAT : ''));
      }
    });
    return { kind: 'hls', variants: variants, audio: unique(audio), subtitles: unique(text), keyFormats: unique(keys) };
  }

  /** The same for a DASH manifest: representations per type, DRM schemes and systems. */
  function dashOffer(mpd) {
    var video = [], audio = [], text = [], schemes = [], systems = [];
    (mpd.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g) || []).forEach(function (set) {
      var head = /<AdaptationSet\b[^>]*>/.exec(set)[0];
      var get = function (s, n) { var m = new RegExp('\\s' + n + '="([^"]*)"').exec(s); return m ? m[1] : null; };
      // Type and codecs can be on the AdaptationSet or only on its Representations.
      var rep = (/<Representation\b[^>]*>/.exec(set) || [''])[0];
      var mime = get(head, 'mimeType') || get(rep, 'mimeType') || '';
      var codecs = get(head, 'codecs') || get(rep, 'codecs');
      var type = get(head, 'contentType') || mime.split('/')[0];
      if (type !== 'video' && type !== 'audio' && (/^(text|application)\//.test(mime) || /^(stpp|wvtt)/.test(codecs || ''))) type = 'text';
      if (type === 'video') {
        (set.match(/<Representation\b[^>]*>/g) || []).forEach(function (r) {
          video.push({ kbps: Math.round(+get(r, 'bandwidth') / 1000) || null, res: (get(r, 'width') || get(head, 'width')) + 'x' +
            (get(r, 'height') || get(head, 'height')), codecs: get(r, 'codecs') || codecs, fps: get(r, 'frameRate') || get(head, 'frameRate') });
        });
      } else if (type === 'audio') audio.push((get(head, 'lang') || '?') + (codecs ? ' ' + codecs : ''));
      else if (type === 'text') text.push(get(head, 'lang') || get(rep, 'lang') || '?');
      (set.match(/<ContentProtection\b[^>]*>/g) || []).forEach(function (cp) {
        var v = get(cp, 'value'), id = (get(cp, 'schemeIdUri') || '').toLowerCase();
        if (/^(cenc|cbcs|cens|cbc1)$/.test(v || '')) schemes.push(v);
        systems.push(/edef8ba9/.test(id) ? 'widevine' : /9a04f079/.test(id) ? 'playready' : /94ce86fb/.test(id) ? 'fairplay' :
          /mp4protection/.test(id) ? null : id.slice(0, 40));
      });
    });
    return { kind: 'dash', video: video, audio: unique(audio), subtitles: unique(text), schemes: unique(schemes),
      systems: unique(systems.filter(Boolean)) };
  }

  function unique(list) { return list.filter(function (x, i) { return list.indexOf(x) === i; }); }

  /** For the diagnostics log, only while it records: what the manifest offers. Never fails the stream. */
  function withOffer(info, read, text) {
    if (!observed()) return info;
    try { info.offer = read(text); } catch (e) { /* unknown layout */ }
    return info;
  }

  function dashInfo(url) {
    return manifest(url, /<MPD\b/).then(function (mpd) {
      var attr = function (re) { var m = re.exec(mpd); return m ? m[1] : null; };
      var dynamic = attr(/<MPD\b[^>]*\stype="(\w+)"/) === 'dynamic';
      var periodStart = isoSeconds(attr(/<Period\b[^>]*\sstart="([^"]+)"/));
      var ts = +attr(/<SegmentTemplate\b[^>]*\stimescale="(\d+)"/) || 1;
      var pto = +attr(/<SegmentTemplate\b[^>]*\spresentationTimeOffset="(\d+)"/) || 0;
      var t0 = +attr(/<S\s+t="(\d+)"/) || pto;
      var span = 0, re = /<S\b([^>]*)\/>/g, m, first = mpd.indexOf('</SegmentTimeline>');
      while ((m = re.exec(mpd)) && (first < 0 || m.index < first)) {
        var d = /\sd="(\d+)"/.exec(m[1]), r = /\sr="(\d+)"/.exec(m[1]);
        span += (d ? +d[1] : 0) * (1 + (r ? +r[1] : 0));
      }
      var windowStart = periodStart + (t0 - pto) / ts;
      var ast = Date.parse(attr(/availabilityStartTime="([^"]+)"/) || '') / 1000 || 0;
      var segDur = (+attr(/<SegmentTemplate\b[^>]*\sduration="(\d+)"/) || +attr(/<S\b[^>]*\sd="(\d+)"/) || 0) / ts;
      // Session replays say contentType="video"; highlights only mimeType="video/mp4".
      var video = (/<AdaptationSet\b[^>]*(?:contentType="video"|mimeType="video\/)[\s\S]*?<\/AdaptationSet>/.exec(mpd) || [''])[0];
      return withOffer({
        // The video qualities' declared bitrates, lowest first.
        videoBitrates: (video.match(/<Representation\b[^>]*>/g) || []).map(function (r) {
          return +((/\sbandwidth="(\d+)"/.exec(r) || [])[1] || 0);
        }).filter(function (b) { return b > 0; }).sort(function (a, b) { return a - b; }),
        dynamic: dynamic,
        segDur: segDur,
        windowStart: windowStart,
        windowEnd: windowStart + span / ts,
        epochAtZero: dynamic ? ast : (pto / ts) - periodStart,
        delay: isoSeconds(attr(/suggestedPresentationDelay="([^"]+)"/)) || 25
      }, dashOffer, mpd);
    });
  }

  /**
   * Same timing facts for an HLS stream. F1's replays are HLS with EXT-X-PROGRAM-DATE-TIME tags,
   * which give the real clock time of segments; marks maps player positions to Unix seconds.
   */
  function hlsInfo(url) {
    var m = lastMaster, kept = m && m.url === url && m.who === state.ascendon && Date.now() - m.at < 60000 ? m : null;
    var offer = null, base = kept ? kept.base : url;
    var surround = false;
    return (kept ? Promise.resolve(kept.text) : manifest(url, /^\s*#EXTM3U/)).then(function (master) {
      offer = withOffer({}, hlsOffer, master).offer || null;
      // For playing, not only the diagnostics (offer is filled only while they record): Dolby Digital in the master.
      surround = /^#EXT-X-STREAM-INF:.*CODECS="[^"]*\b(ac-3|ec-3)\b/m.test(master);
      var lines = master.split('\n');
      for (var i = 0; i < lines.length - 1; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
          return manifest(new URL(lines[i + 1].trim(), base).toString(), /^\s*#EXTM3U/);
        }
      }
      return master;
    }).then(function (playlist) {
      var pos = 0, marks = [];
      playlist.split('\n').forEach(function (l) {
        if (l.indexOf('#EXT-X-PROGRAM-DATE-TIME:') === 0) {
          var t = Date.parse(l.slice(25).trim());
          if (!isNaN(t)) marks.push({ pos: pos, wall: t / 1000 });
        } else if (l.indexOf('#EXTINF:') === 0) {
          pos += parseFloat(l.slice(8)) || 0;
        }
      });
      var live = !/#EXT-X-ENDLIST/.test(playlist) && !/PLAYLIST-TYPE:VOD/.test(playlist);
      var info = { dynamic: live, windowStart: 0, windowEnd: pos, delay: 25, marks: marks,
        epochAtZero: marks.length ? marks[0].wall - marks[0].pos : 0, encrypted: hasKeys(playlist), surround: surround };
      if (offer) info.offer = offer;
      return info;
    });
  }

  /** Clock-time facts for any stream URL (DASH or HLS). */
  function streamInfo(url) {
    return /\.m3u8(\?|$)/.test(url) ? hlsInfo(url) : dashInfo(url);
  }

  /** Saved resume position (seconds) for a video, shared with F1 TV's other apps; 0 if none. */
  function resumePosition(contentId, duration) {
    if (!state.entitlement) return Promise.resolve(0);
    var l = loc();
    var url = [BASE, '2.0', 'R', LANG, PAGE_PLATFORM, 'ALL/CONTENT/USERSELECTIONS', l.entitlement, l.groupId].join('/');
    var body = {};
    body[contentId] = { duration: duration || 0 };
    return http(url, {
      method: 'POST',
      headers: { entitlementtoken: state.entitlement, 'content-type': 'text/plain;charset=UTF-8', 'x-f1-device-info': DEVICE_INFO },
      body: JSON.stringify(body),
      op: 'resume_position'
    }).then(function (data) {
      var r = data && data.resultObj && data.resultObj[contentId];
      return (r && r.user && r.user.resume && r.user.resume.playHeadPosition) || 0;
    }).catch(function () { return 0; });
  }

  /** Saves the resume position, like the web player's progress heartbeat. */
  function savePosition(contentId, seconds, contentSubtype) {
    if (!state.ascendon || !state.entitlement) return Promise.resolve();
    var url = [BASE, '1.0', 'R', LANG, PAGE_PLATFORM, 'ALL/ACTION/PLAY'].join('/');
    return http(url, {
      method: 'POST',
      headers: { ascendontoken: state.ascendon, entitlementtoken: state.entitlement, 'content-type': 'application/json', 'x-f1-device-info': DEVICE_INFO },
      body: JSON.stringify({ contentId: +contentId, playHeadPosition: Math.round(seconds), contentSubType: contentSubtype || 'REPLAY' }),
      op: 'save_position'
    }).catch(function () { /* best effort */ });
  }

  /** True for "this hasn't started yet" answers from the play API. */
  function isNotStarted(err) {
    return /pre-?live|unavailable/i.test((err && err.message) || '');
  }

  /** F1's resizer takes a JPEG quality number; its 'HI' is only 70, which shows blocks once the TV scales the UI to 4K (100: ~60 KB a tile). */
  function imageUrl(pictureUrl, w, h) {
    if (!pictureUrl) return '';
    if (pictureUrl.indexOf('http') === 0) return pictureUrl;
    return BASE + '/image-resizer/image/' + pictureUrl + '?w=' + w + '&h=' + h + '&q=100&o=L';
  }

  return {
    state: state,
    HOME_PAGE_ID: HOME_PAGE_ID,
    ARCHIVE_PAGE_ID: ARCHIVE_PAGE_ID,
    http: http,
    refreshConfig: refreshConfig,
    refreshLocation: refreshLocation,
    login: login,
    logout: logout,
    page: page,
    pageByUri: pageByUri,
    video: video,
    play: play,
    menu: menu,
    feedsFrom: feedsFrom,
    /** Asks F1's Tiledmedia offer for a video ahead of playing it (the feed list opened), so a start needs no PLAY. */
    prefetchTm: function (contentId, mainChannel) {
      return state.ascendon ? tmAnswerFor(contentId, null, mainChannel).then(function () { return null; }, function () { return null; }) : Promise.resolve(null);
    },
    /**
     * Multiview from F1's Tiledmedia offer: the answer already kept for this video and sign-in (or null), synchronously,
     * for deciding which layouts play that way. { streamType, feeds: { channel: master URL }, main }.
     */
    tmKnown: function (contentId) {
      var key = state.ascendon + '|' + String(contentId);
      var a = tmAnswers.filter(function (x) { return x.key === key && Date.now() < x.until; })[0];
      return a && !a.refused && /^HDR_/.test(a.streamType) ? a : null;
    },
    /**
     * A multiview feed's clear 4K HDR from the Tiledmedia answer already kept for the video: no PLAY request (a grid of
     * four asked them one by one, ~9 s). Where F1 gave clear CMAF HLG there (HDR_UHD_CMAF) its masters are the same
     * package as each feed's own HDR offer (2026-11-26: F1 LIVE line for line, onboards the same variants) except that
     * onboards carry team radio only, so this is for the feeds whose sound isn't used. Resolves an offer as play()'s
     * with hdrOnly, or null (not kept, another kind, keys in the master, no HLG): then the usual request.
     */
    tmClearOffer: function (contentId, channelId) {
      var who = state.ascendon, key = who + '|' + String(contentId);
      var a = tmAnswers.filter(function (x) { return x.key === key && Date.now() < x.until; })[0];
      if (!who || !a || a.refused || a.streamType !== 'HDR_UHD_CMAF') return Promise.resolve(null);
      var ch = channelId != null ? String(channelId) : a.main, url = ch && a.feeds[ch];
      if (!url || !/\.m3u8(\?|$)/.test(url)) return Promise.resolve(null);
      var check = fetch(url).then(function (res) { return res.ok ? res.text() : ''; }).then(function (master) {
        if (state.ascendon !== who || !/^#EXTM3U\s/.test(master) || hasKeys(master) || !/VIDEO-RANGE=HLG/.test(master)) return null;
        return { url: url, streamType: a.streamType, platform: 'BIG_SCREEN_HLS', licenseUrl: '', hdr: true, fromTm: true,
          licenseHeaders: { ascendontoken: who, entitlementtoken: a.entitlementToken || state.entitlement, 'x-f1-device-info': DEVICE_INFO } };
      }, function () { return null; });
      // A master that never comes must not hold the multiview: the usual request then (as HDR_WAIT does for that one).
      return Promise.race([check, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, TM_CLEAR_WAIT); })]);
    },
    /**
     * The Tiledmedia answer for a multiview (asked if not kept): { streamType, feeds, main, keyHeaders } (the headers
     * Shaka sends with the playlists' key requests), or null when F1 gives no HDR in it.
     */
    tmAnswer: function (contentId, mainChannel) {
      var who = state.ascendon;
      if (!who) return Promise.resolve(null);
      return tmAnswerFor(contentId, null, mainChannel).then(function (t) {
        if (!t || t.refused || !/^HDR_/.test(t.streamType) || state.ascendon !== who) return null;
        return { streamType: t.streamType, feeds: t.feeds, main: t.main, who: who,
          keyHeaders: { ascendontoken: who, entitlementtoken: t.entitlementToken || state.entitlement } };
      });
    },
    scheduleFrom: scheduleFrom,
    seasonFrom: seasonFrom,
    streamInfo: streamInfo,
    resumePosition: resumePosition,
    savePosition: savePosition,
    isNotStarted: isNotStarted,
    imageUrl: imageUrl
  };
})();

// The subscription tier (the location entitlement, e.g. PRO or PREMIUM) for the diagnostics log: only to read
// problems by what F1 offers each tier, never to decide anything in the app.
if (typeof Diag !== 'undefined') {
  Diag.provide('account', function () {
    var l = F1Api.state.location;
    return { signedIn: !!F1Api.state.ascendon, tier: (l && l.entitlement) || null };
  });
}
