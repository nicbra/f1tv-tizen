/*
 * F1TV API client. Endpoint shapes follow the community clients
 * eXhumer/f1tv-api and npanu420/F1OpenViewer (both MIT).
 * Written for Chromium 76 (Tizen 6.0): no optional chaining / nullish coalescing.
 */
var F1Api = (function () {
  var BASE = 'https://f1tv.formula1.com';
  var LANG = 'ENG';
  // Platforms tried for playback, in order. BIG_SCREEN_* is what the official TV apps use.
  var PLAY_PLATFORMS = ['BIG_SCREEN_DASH', 'WEB_DASH'];
  var PAGE_PLATFORM = 'WEB_DASH';
  // The play API's stream rules reject requests without this header. It describes the
  // TV's web engine (Chromium 76) in the web player's format; a 'device=tv' value is refused.
  var DEVICE_INFO = 'device=web;screen=browser;os=tizen;browser=chrome;browserVersion=76;' +
    'osVersion=6.0;appVersion=55.0.3;playerVersion=8.212.0;p=false;tms=1';
  // Fallback page ids; the live menu (menu()) is preferred.
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

  function http(url, opts) {
    opts = opts || {};
    return fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        if (!res.ok) {
          var msg = (data && (data.message || (data.resultObj && data.resultObj.message))) || ('HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
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
    return http(BASE + '/config').then(function (cfg) {
      state.config = cfg;
      var api = (cfg && cfg.apiConfig) || {};
      if (/^\d+\.\d+$/.test(api.playAPIVersion || '')) state.playApi = api.playAPIVersion;
      if (/^\d+\.\d+$/.test(api.videoAPIVersion || '')) state.videoApi = api.videoAPIVersion;
      return cfg;
    });
  }

  function refreshLocation() {
    var url = [BASE, '1.0', loginStatus(), LANG, PAGE_PLATFORM, 'ALL/USER/LOCATION'].join('/');
    var headers = state.entitlement ? { entitlementtoken: state.entitlement } : {};
    return http(url, { headers: headers }).then(function (data) {
      var list = data && data.resultObj && data.resultObj.userLocation;
      state.location = (list && list[0]) || null;
      return state.location;
    });
  }

  function fetchEntitlement() {
    var url = [BASE, '2.0', 'R', LANG, PAGE_PLATFORM, 'ALL/USER/ENTITLEMENT'].join('/');
    return http(url, { headers: { ascendontoken: state.ascendon } }).then(function (data) {
      state.entitlement = data.resultObj.entitlementToken;
      return state.entitlement;
    });
  }

  /** Sets the subscription token and loads the entitlement + location that go with it. */
  function login(ascendon) {
    state.ascendon = ascendon;
    return fetchEntitlement().then(refreshLocation);
  }

  function logout() {
    state.ascendon = null;
    state.entitlement = null;
    return refreshLocation();
  }

  function page(pageId) {
    var l = loc();
    var url = [BASE, '2.0', loginStatus(), LANG, PAGE_PLATFORM, 'ALL/PAGE', pageId, l.entitlement, l.groupId].join('/');
    return http(url, { headers: authHeaders() }).then(function (data) {
      return (data && data.resultObj && data.resultObj.containers) || [];
    });
  }

  /** Follows an action uri from a page item (they are already full API paths). */
  function pageByUri(uri) {
    var url = uri.indexOf('http') === 0 ? uri : BASE + uri;
    return http(url, { headers: authHeaders() }).then(function (data) {
      return (data && data.resultObj && data.resultObj.containers) || [];
    });
  }

  function liveNow() {
    var l = loc();
    var url = [BASE, '1.0', loginStatus(), LANG, PAGE_PLATFORM, 'ALL/EVENTS/LIVENOW', l.entitlement, l.groupId].join('/');
    return http(url, { headers: authHeaders() }).then(function (data) {
      return (data && data.resultObj && data.resultObj.containers) || [];
    });
  }

  function video(contentId) {
    var l = loc();
    var url = [BASE, state.videoApi, loginStatus(), LANG, PAGE_PLATFORM, 'ALL/CONTENT/VIDEO', contentId, l.entitlement, l.groupId].join('/');
    return http(url, { headers: authHeaders() }).then(function (data) {
      var c = data && data.resultObj && data.resultObj.containers;
      if (!c || !c.length) throw new Error('Video not found');
      return c[0];
    });
  }

  function playOn(platform, contentId, channelId) {
    var url = [BASE, state.playApi, 'R', LANG, platform, 'ALL/CONTENT/PLAY'].join('/') +
      '?contentId=' + encodeURIComponent(contentId) + '&player=player_bm' +
      (channelId ? '&channelId=' + encodeURIComponent(channelId) : '');
    var headers = authHeaders();
    headers['x-f1-device-info'] = DEVICE_INFO;
    return http(url, { headers: headers }).then(function (data) {
      var r = data && data.resultObj;
      if (!r || !r.url) {
        throw new Error((data && data.message) || 'No stream returned');
      }
      r.platform = platform;
      return r;
    });
  }

  /**
   * Resolves a playable stream: manifest url, license url and the headers the
   * license server wants. Tries the TV platform first, then the web one.
   */
  function play(contentId, channelId) {
    var i = 0;
    var firstErr = null;
    function next() {
      if (i >= PLAY_PLATFORMS.length) return Promise.reject(firstErr || new Error('Playback unavailable'));
      var platform = PLAY_PLATFORMS[i++];
      return playOn(platform, contentId, channelId).catch(function (e) {
        if (!firstErr) firstErr = e;
        return next();
      });
    }
    return next().then(function (r) {
      var la = r.laURL || r.laUrl || '';
      if (!la && /WV/i.test(r.streamType || '')) {
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
      return {
        url: r.url,
        streamType: r.streamType || '',
        platform: r.platform,
        licenseUrl: la,
        licenseHeaders: licenseHeaders
      };
    });
  }

  /** F1 TV's navigation menu: [{ title, uri }] (Home, 2026 Season, Archive, Shows, ...). */
  function menu() {
    var l = loc();
    var url = [BASE, '2.0', loginStatus(), LANG, PAGE_PLATFORM, 'ALL/MENU', l.entitlement, l.groupId].join('/');
    return http(url, { headers: authHeaders() }).then(function (data) {
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
        title: m.titleBrief || m.title || '',
        series: e.Series || m.uiSeries || '',
        start: toMs(e.sessionStartDate) || m.contractStartDate || null,
        end: toMs(e.sessionEndDate) || toMs(e.sessionEndTime),
        pictureUrl: m.pictureUrl,
        meeting: e.Meeting_Name || e.Global_Meeting_Name || ''
      };
    }).filter(function (ev) { return ev.start; });
    events.sort(function (a, b) { return a.start - b.start; });
    return { meeting: events.length ? events[0].meeting : '', events: events };
  }

  /** Meetings of a season page (the "2026 Season" menu entry), in calendar order. */
  function seasonFrom(containers) {
    var out = [];
    (containers || []).forEach(function (c) {
      var items = (c.retrieveItems && c.retrieveItems.resultObj && c.retrieveItems.resultObj.containers) || [];
      items.forEach(function (it) {
        var m = it.metadata || {}, e = m.emfAttributes || {}, a = (it.actions || [])[0] || {};
        if (!e.MeetingKey || !/\/PAGE\//.test(a.uri || '')) return;
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
  function dashInfo(url) {
    return fetch(url).then(function (r) { return r.text(); }).then(function (mpd) {
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
      return {
        dynamic: dynamic,
        windowStart: windowStart,
        windowEnd: windowStart + span / ts,
        epochAtZero: dynamic ? ast : (pto / ts) - periodStart,
        delay: isoSeconds(attr(/suggestedPresentationDelay="([^"]+)"/)) || 25
      };
    });
  }

  /** True for "this hasn't started yet" answers from the play API. */
  function isNotStarted(err) {
    return /pre-?live|unavailable/i.test((err && err.message) || '');
  }

  function imageUrl(pictureUrl, w, h) {
    if (!pictureUrl) return '';
    if (pictureUrl.indexOf('http') === 0) return pictureUrl;
    return BASE + '/image-resizer/image/' + pictureUrl + '?w=' + w + '&h=' + h + '&q=HI&o=L';
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
    liveNow: liveNow,
    video: video,
    play: play,
    menu: menu,
    scheduleFrom: scheduleFrom,
    seasonFrom: seasonFrom,
    dashInfo: dashInfo,
    isNotStarted: isNotStarted,
    imageUrl: imageUrl
  };
})();
