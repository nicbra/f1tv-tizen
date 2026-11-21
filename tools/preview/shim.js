/*
 * UI preview shim (tools/preview/server.js adds it to index.html as served; app/ itself is unchanged).
 * Stands in for the TV: webapis, remote keys, a signed-in session, a 1920x1080 stage scaled to the window,
 * and routes the app's requests to other hosts through the preview server (/__up/<host>/<path>).
 *
 * Page options (in the address): ?signedout  shows the sign-in screen
 *                                 ?fresh      forgets the app's saved settings and progress (localStorage)
 *                                 ?noscale    shows the stage at 100% instead of fitting it to the window
 *                                 ?noreload   no automatic reload when files in app/ change
 */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);

  // ------------------------------------------------------------ saved state

  try {
    if (params.has('fresh')) localStorage.clear();
    if (params.has('signedout')) localStorage.removeItem('f1tv.session');
    else {
      // Paired (a token the app renews through the fake account API at start), unless it already is.
      var s = JSON.parse(localStorage.getItem('f1tv.session') || '{}') || {};
      if (!s.authKey) localStorage.setItem('f1tv.session', JSON.stringify({ authKey: 'preview', deviceId: s.deviceId || 'preview' }));
    }
  } catch (e) { /* storage blocked */ }
  // One-time options: a reload after an edit shouldn't sign out or forget again.
  if (params.has('fresh') || params.has('signedout')) {
    var keep = new URLSearchParams(location.search);
    keep.delete('fresh');
    keep.delete('signedout');
    history.replaceState(null, '', location.pathname + (String(keep) ? '?' + keep : ''));
  }

  // ------------------------------------------------------------ the TV's APIs (an SDR 4K TV)

  window.webapis = {
    avinfo: { isHdrTvSupport: function () { return false; } },
    productinfo: {
      getFirmware: function () { return 'PREVIEW'; },
      getModel: function () { return 'Preview'; },
      getRealModel: function () { return 'Preview'; },
      isUdPanelSupported: function () { return true; }
    },
    avplay: makeAvPlay()
  };

  // HEVC: the app asks with a picture size ("; width=..; height=.."), and gets the QE55Q77A's answer (up to
  // 3840x2160, 60 fps), so it offers multiview. Shaka asks without one and is told no, so it keeps to the
  // preview stream's H.264 whatever this computer could decode.
  var realIsType = MediaSource.isTypeSupported.bind(MediaSource);
  MediaSource.isTypeSupported = function (type) {
    type = String(type);
    if (!/hvc1|hev1/.test(type)) return realIsType(type);
    var w = /width=(\d+)/.exec(type), h = /height=(\d+)/.exec(type), f = /framerate=([\d.]+)/.exec(type);
    if (!w || !h) return false;
    return +w[1] <= 3840 && +h[1] <= 2160 && (!f || +f[1] <= 60);
  };
  if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
    var realInfo = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
    navigator.mediaCapabilities.decodingInfo = function (cfg) {
      if (cfg && cfg.video && /hvc1|hev1/.test(cfg.video.contentType || '')) {
        return Promise.resolve({ supported: false, smooth: false, powerEfficient: false, configuration: cfg });
      }
      return realInfo(cfg);
    };
  }

  /*
   * Samsung's AVPlay, as far as the app uses it. It plays nothing: it shows each feed's key art and name where
   * the video would be (a multiview: one per cell of the layout), and its clock runs like a playing video.
   * The app uses it as on the TV: single-feed videos and multiviews (clear multi-feed videos stay on Shaka).
   */
  function makeAvPlay() {
    var state = 'NONE', url = null, listener = {}, rect = [0, 0, 1920, 1080], info = null;
    var posMs = 0, durMs = 0, ticking = null, last = 0, box = null, shown = '';

    function emit(name, arg) { try { if (listener[name]) listener[name](arg); } catch (e) { console.error(e); } }

    function tick() {
      var now = Date.now();
      if (state === 'PLAYING') {
        posMs += now - last;
        if (durMs && posMs >= durMs) { posMs = durMs; state = 'READY'; emit('onstreamcompleted'); }
        emit('oncurrentplaytime', Math.round(posMs));
      }
      last = now;
    }

    function describe() {
      return fetch('/__preview/av?url=' + encodeURIComponent(url)).then(function (r) { return r.json(); }).then(function (i) {
        info = i;
        durMs = i.live ? 0 : i.durationMs;
        draw();
        return i;
      });
    }

    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

    function cell(feed, n) {
      var c = el('div', 'preview-av-cell');
      if (feed.image) c.style.backgroundImage = 'url("' + feed.image + '")';
      var tag = el('div', 'preview-av-tag');
      if (feed.colour) tag.style.borderLeftColor = '#' + String(feed.colour).replace('#', '');
      tag.appendChild(el('b', null, String(n + 1)));
      tag.appendChild(document.createTextNode(feed.label || 'Feed'));
      c.appendChild(tag);
      return c;
    }

    function draw() {
      var host = document.getElementById('screen-player');
      if (!host || !info || state === 'NONE') { if (box) box.style.display = 'none'; return; }
      var key = JSON.stringify([info.version, info.layout, rect, info.feeds.map(function (f) { return f.label; })]);
      if (!box) {
        box = el('div');
        box.id = 'preview-av';
        host.insertBefore(box, host.firstChild);
      }
      box.style.display = '';
      if (key === shown) return;
      shown = key;
      box.textContent = '';
      box.style.left = rect[0] + 'px'; box.style.top = rect[1] + 'px';
      box.style.width = rect[2] + 'px'; box.style.height = rect[3] + 'px';
      var L = window.MultiviewLayouts, sh = info.kind === 'grid' && L && L.shape(info.layout);
      if (!sh) {
        // One feed: the picture alone (the app's own player bar names the feed).
        var one = el('div', 'preview-av-cell');
        if (info.feeds[0] && info.feeds[0].image) one.style.backgroundImage = 'url("' + info.feeds[0].image + '")';
        one.style.inset = '0';
        box.appendChild(one);
        return;
      }
      // The stitched picture, letterboxed in the display rect (PLAYER_DISPLAY_MODE_LETTER_BOX).
      var s = Math.min(rect[2] / sh.width, rect[3] / sh.height), pw = sh.width * s, ph = sh.height * s;
      var pic = el('div', 'preview-av-picture');
      pic.style.left = (rect[2] - pw) / 2 + 'px'; pic.style.top = (rect[3] - ph) / 2 + 'px';
      pic.style.width = pw + 'px'; pic.style.height = ph + 'px';
      sh.rects.forEach(function (r, n) {
        if (!r) return;
        var c = cell(info.feeds[n] || {}, n);
        c.style.left = (r.x * 960 * s) + 'px'; c.style.top = (r.y * 544 * s) + 'px';
        c.style.width = (r.w * 960 * s) + 'px'; c.style.height = (Math.min(r.h * 544, sh.height - r.y * 544) * s) + 'px';
        pic.appendChild(c);
      });
      box.appendChild(pic);
    }

    var tracks = [
      { index: 0, type: 'VIDEO', extra_info: JSON.stringify({ Width: 1920, Height: 1080, Bit_rate: 6000000, fourCC: 'HEVC' }) },
      { index: 1, type: 'AUDIO', extra_info: JSON.stringify({ language: 'eng', channels: 2, bit_rate: 192000, fourCC: 'AAC' }) }
    ];

    return {
      open: function (u) { url = u; state = 'IDLE'; posMs = 0; info = null; shown = ''; },
      close: function () { state = 'NONE'; clearInterval(ticking); ticking = null; info = null; draw(); },
      stop: function () { if (state !== 'NONE') state = 'IDLE'; },
      setListener: function (l) { listener = l || {}; },
      setDisplayRect: function (x, y, w, h) { rect = [x, y, w, h]; draw(); },
      setDisplayMethod: function () {},
      setStreamingProperty: function () {},
      getStreamingProperty: function (name) {
        if (name === 'CURRENT_BANDWIDTH') return '6000000';
        throw new Error('not in the preview');
      },
      setBufferingParam: function () {},
      setDrm: function () {},
      setSilentSubtitle: function () {},
      setSelectTrack: function () {},
      getTotalTrackInfo: function () { return tracks; },
      getCurrentStreamInfo: function () { return tracks; },
      prepareAsync: function (ok, fail) {
        describe().then(function () {
          state = 'READY';
          if (!ticking) { last = Date.now(); ticking = setInterval(tick, 250); }
          setTimeout(ok, 300);
        }, function (e) { state = 'IDLE'; if (fail) fail('PLAYER_ERROR_CONNECTION_FAILED: ' + e.message); });
      },
      play: function () { if (state === 'READY' || state === 'PAUSED') { last = Date.now(); state = 'PLAYING'; } },
      pause: function () { if (state === 'PLAYING') state = 'PAUSED'; },
      seekTo: function (ms, ok) {
        posMs = Math.max(0, durMs ? Math.min(ms, durMs) : ms);
        // A multiview changes layout or feeds by a seek to the same moment: show what the helper has now.
        var after = info && info.kind === 'grid' ? describe() : Promise.resolve();
        after.then(function () { setTimeout(function () { if (ok) ok(); }, 150); });
      },
      jumpForward: function (ms) { posMs += ms; },
      jumpBackward: function (ms) { posMs = Math.max(0, posMs - ms); },
      getCurrentTime: function () { return Math.round(posMs); },
      getDuration: function () { return durMs; },
      getState: function () { return state; },
      suspend: function () {},
      restore: function () {}
    };
  }

  // ------------------------------------------------------------ network: other hosts through the preview server

  function route(url) {
    if (typeof url !== 'string') return url;
    var m = /^https?:\/\/([^/?#]+)([^#]*)/i.exec(url);
    if (!m || m[1] === location.host) return url;
    // Pictures and fonts load fine from F1 directly; only script requests need routing (CORS).
    return location.origin + '/__up/' + m[1] + (m[2] || '/');
  }
  window.__previewRoute = route;

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') return realFetch(route(input), init);
    if (input && input.url) return realFetch(new Request(route(input.url), input), init);
    return realFetch(input, init);
  };
  var realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var a = Array.prototype.slice.call(arguments);
    a[1] = route(String(url));
    return realOpen.apply(this, a);
  };
  // Live timing's SignalR socket: through the preview server too, which adds the cookie F1 wants.
  var RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    var m = /^wss?:\/\/([^/?#]+)([^#]*)/i.exec(String(url));
    if (m && m[1] !== location.host) url = location.origin.replace(/^http/, 'ws') + '/__up/' + m[1] + (m[2] || '/');
    return protocols ? new RealWS(url, protocols) : new RealWS(url);
  };
  window.WebSocket.prototype = RealWS.prototype;

  // ------------------------------------------------------------ remote keys from the keyboard

  // keys.js already maps Backspace/Esc to BACK and Space to PLAY/PAUSE. The rest of the remote:
  var KEYMAP = {
    r: 403, g: 404, y: 405, b: 406,           // colour keys
    PageUp: 427, PageDown: 428,                // CH up / down
    '.': 417, ',': 412,                        // fast forward / rewind
    '>': 10233, '<': 10232,                    // next / previous track
    p: 415, s: 413,                            // play, stop
    Home: 10009                                // BACK (also Backspace / Esc)
  };
  window.addEventListener('keydown', function (e) {
    if (e.__preview || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === '?') { e.preventDefault(); e.stopImmediatePropagation(); toggleHelp(); return; }
    var code = KEYMAP[e.key];
    if (!code) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: e.key });
    Object.defineProperty(ev, 'keyCode', { get: function () { return code; } });
    Object.defineProperty(ev, 'which', { get: function () { return code; } });
    ev.__preview = true;
    (document.activeElement || document.body).dispatchEvent(ev);
  }, true);

  // ------------------------------------------------------------ the 1920x1080 stage

  var css = [
    'html { background: #000; overflow: hidden; width: 100vw; height: 100vh; }',
    'body { position: relative; transform-origin: 0 0; }',
    '#preview-help { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font: 14px/1.5 system-ui, sans-serif;',
    '  color: #eee; background: rgba(20,20,28,.92); border: 1px solid #444; border-radius: 8px; padding: 12px 16px; white-space: pre; }',
    '#preview-help.hidden { display: none; }',
    // The preview's AVPlay picture: under the app's player overlays, as AVPlay's video plane is on the TV.
    '#preview-av { position: absolute; overflow: hidden; background: #000; }',
    // The TV's <object type="application/avplayer">: a desktop browser shows "Couldn't load plug-in" in it.
    '#av-player { visibility: hidden; }',
    'body:not(.avplay) #preview-av { display: none; }',
    '.preview-av-picture { position: absolute; background: #222; }',
    '.preview-av-cell { position: absolute; background: #15151e center / cover no-repeat; }',
    // Which feed is where (the picture F1 sends has no names; the app may draw its own, top left).
    '.preview-av-tag { position: absolute; right: 3%; bottom: 5%; max-width: 80%; padding: 2px 10px 2px 8px; border-left: 5px solid #e10600;',
    '  background: rgba(0,0,0,.55); color: rgba(255,255,255,.8); font: 600 20px/1.3 "Titillium Web", sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.preview-av-tag b { margin-right: 10px; opacity: .6; }'
  ].join('\n');

  function fit() {
    var b = document.body;
    if (!b) return;
    if (params.has('noscale')) { b.style.transform = ''; return; }
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var x = (window.innerWidth - 1920 * s) / 2, y = (window.innerHeight - 1080 * s) / 2;
    b.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
  }

  var HELP = 'F1 TV UI preview — keys\n' +
    'Arrows  move        Enter  OK\n' +
    'Backspace / Esc  BACK\n' +
    'Space  play/pause   p / s  play / stop\n' +
    ', / .  rewind / fast forward\n' +
    'PageUp / PageDown  CH up / down\n' +
    'r g y b  colour keys\n' +
    '?  this help';
  var help = null;
  function toggleHelp() {
    if (!help) {
      help = document.createElement('div');
      help.id = 'preview-help';
      help.textContent = HELP;
      // Outside <body>, so it isn't scaled with the stage and the app never sees it.
      document.documentElement.appendChild(help);
    } else help.classList.toggle('hidden');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    fit();
  });
  window.addEventListener('resize', fit);

  // ------------------------------------------------------------ live reload

  // Styles are swapped in place (the app keeps its screen and focus); other changes reload the page.
  var realES = window.EventSource;
  if (realES && !params.has('noreload')) {
    var es = new realES('/__preview/events');
    var connected = false;
    es.onopen = function () {
      // A reconnect after the server restarted: the files may have changed meanwhile.
      if (connected) location.reload();
      connected = true;
    };
    es.onmessage = function (m) {
      if (m.data === 'reload') return location.reload();
      if (m.data !== 'css') return;
      var stamp = Date.now();
      Array.prototype.forEach.call(document.querySelectorAll('link[rel=stylesheet]'), function (l) {
        var href = l.getAttribute('href').split('?')[0];
        if (/^https?:/.test(href)) return;
        var fresh = l.cloneNode();
        fresh.href = href + '?v=' + stamp;
        // Swap once loaded, so the page never shows unstyled.
        fresh.onload = function () { l.remove(); };
        l.parentNode.insertBefore(fresh, l.nextSibling);
      });
    };
  }

  console.info('%cF1 TV UI preview%c  press ? for the keys', 'font-weight:bold', '');
})();
