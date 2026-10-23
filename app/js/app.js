/* Screens, navigation and wiring between the API, auth and player. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var K = Keys.codes;

  var screen = null;       // 'login' | 'browse' | 'feeds' | 'player'
  var grid = null;         // focus grid of the current screen
  var history = [];        // browse pages: [{ title, load: fn }]
  var navTabs = [];
  var activeTab = 0;
  var feedsCtx = null;     // { video, feeds: [...], index }
  var osdTimer = null;
  var loginJob = null;

  // ---------- helpers ----------

  function show(name) {
    ['login', 'browse', 'feeds', 'player'].forEach(function (n) {
      $('screen-' + n).classList.toggle('hidden', n !== name);
    });
    screen = name;
  }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.add('hidden'); }, ms || 5000);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    var mm = (h && m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }

  function tickClock() {
    var d = new Date();
    $('clock').textContent = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* desktop */ }
  }

  // ---------- login ----------

  /** Sign-in screen: starts pairing straight away and shows the code plus a QR link. */
  function showLogin(reason) {
    show('login');
    if (loginJob && loginJob.cancel) loginJob.cancel();
    $('login-title').textContent = 'Sign in to F1 TV';
    $('login-text').textContent = 'Scan the code with your phone, or go to ' +
      Auth.PAIR_PAGE.replace('https://', '') + ' and enter the code. Sign in with your F1 TV account and confirm.';
    $('login-code').textContent = '';
    $('login-hint').textContent = '';
    $('login-qr').classList.add('hidden');
    $('login-status').textContent = reason || 'Getting a code…';

    var actions = $('login-actions');
    actions.innerHTML = '';
    var browse = el('div', 'btn', 'Browse without signing in');
    actions.appendChild(browse);
    grid = new Focus.Grid([[browse]], { onSelect: function () { enterBrowse(); } });
    grid.apply();

    loginJob = Auth.pair(function (code) {
      $('login-code').textContent = code;
      $('login-hint').textContent = 'The code renews by itself if it expires.';
      showQr(Auth.pairUrl(code));
      $('login-status').textContent = 'Waiting for confirmation…';
    });
    loginJob.then(onToken).catch(function (e) {
      $('login-status').textContent = 'Could not get a code: ' + e.message;
    });
  }

  function showQr(url) {
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    var box = $('login-qr');
    box.innerHTML = qr.createImgTag(6, 0);
    box.classList.remove('hidden');
  }

  function onToken(token) {
    loginJob = null;
    $('login-status').textContent = 'Signing in…';
    return F1Api.login(token).then(function () {
      toast('Signed in');
      enterBrowse();
    }).catch(function (e) {
      Auth.clear();
      showLogin('Sign-in failed: ' + e.message);
    });
  }

  /** Makes sure we hold a valid token before playing; renews paired devices silently. */
  function ensureSession() {
    var t = Auth.token();
    if (t && t === F1Api.state.ascendon && F1Api.state.entitlement) return Promise.resolve(true);
    function renewAndLogin() {
      return Auth.renew().then(function (fresh) {
        if (!fresh) return false;
        return F1Api.login(fresh).then(function () { return true; });
      });
    }
    if (t) return F1Api.login(t).then(function () { return true; }, renewAndLogin);
    return renewAndLogin();
  }

  // ---------- browse ----------

  function enterBrowse() {
    if (loginJob && loginJob.cancel) loginJob.cancel();
    loginJob = null;
    show('browse');
    navTabs = [
      { title: 'Home', load: function () { return F1Api.page(F1Api.HOME_PAGE_ID); } },
      { title: 'Live', load: function () { return F1Api.liveNow(); } },
      { title: 'Archive', load: function () { return F1Api.page(F1Api.ARCHIVE_PAGE_ID); } },
      { title: Auth.token() ? 'Sign out' : 'Sign in', action: function () {
        Auth.clear();
        F1Api.logout().catch(function () {});
        showLogin();
      } }
    ];
    var nav = $('topnav');
    nav.innerHTML = '';
    navTabs.forEach(function (t, i) {
      var e = el('div', 'nav-item', t.title);
      e._tab = i;
      nav.appendChild(e);
    });
    openTab(0);
  }

  function openTab(i) {
    var t = navTabs[i];
    if (t.action) return t.action();
    activeTab = i;
    var items = $('topnav').children;
    for (var j = 0; j < items.length; j++) items[j].classList.toggle('active', j === i);
    history = [];
    openPage(t.title, t.load);
  }

  function openPage(title, load) {
    history.push({ title: title, load: load });
    renderPage(title, load);
  }

  function renderPage(title, load) {
    $('page-title').textContent = history.length > 1 ? title : '';
    var rails = $('rails');
    rails.innerHTML = '';
    rails.appendChild(el('div', 'empty', 'Loading…'));
    load().then(function (containers) {
      drawRails(railsFromContainers(containers));
    }).catch(function (e) {
      rails.innerHTML = '';
      rails.appendChild(el('div', 'empty', 'Could not load: ' + e.message));
      buildBrowseGrid([]);
    });
  }

  function railsFromContainers(containers) {
    var out = [];
    (containers || []).forEach(function (c) {
      var inner = c.retrieveItems && c.retrieveItems.resultObj && c.retrieveItems.resultObj.containers;
      var items = inner || (c.metadata && c.metadata.contentType ? [c] : []);
      var label = (c.metadata && (c.metadata.label || c.metadata.title)) || '';
      var tiles = items.map(toTile).filter(function (t) { return t && (t.contentId || t.uri); });
      if (tiles.length) out.push({ title: inner ? label : '', tiles: tiles });
    });
    // LIVENOW returns bare items: fold single-item rails into one.
    if (out.length > 1 && out.every(function (r) { return !r.title && r.tiles.length === 1; })) {
      out = [{ title: '', tiles: out.map(function (r) { return r.tiles[0]; }) }];
    }
    return out;
  }

  function toTile(item) {
    var m = item.metadata || {};
    var action = (item.actions && item.actions[0]) || {};
    var emf = m.emfAttributes || {};
    var sub = [emf.Meeting_Name || emf.Global_Title, m.contentSubtype].filter(Boolean).join(' · ');
    return {
      title: m.titleBrief || m.title || '',
      sub: sub,
      image: m.pictureUrl,
      contentId: m.contentType === 'VIDEO' ? (m.contentId || item.id) : null,
      uri: action.uri && /\/PAGE\//.test(action.uri) ? action.uri : null,
      live: /LIVE/.test(m.contentSubtype || '') && m.contentSubtype !== 'LIVE_REPLAY',
      raw: item
    };
  }

  function drawRails(rails) {
    var root = $('rails');
    root.innerHTML = '';
    if (!rails.length) {
      root.appendChild(el('div', 'empty', 'Nothing here right now.'));
      return buildBrowseGrid([]);
    }
    var inner = el('div', 'rails-inner');
    root.appendChild(inner);
    var rows = rails.map(function (rail) {
      var r = el('div', 'rail');
      if (rail.title) r.appendChild(el('div', 'rail-title', rail.title));
      var track = el('div', 'rail-track');
      r.appendChild(track);
      inner.appendChild(r);
      return rail.tiles.map(function (t) {
        var tile = el('div', 'tile');
        var img = el('div', 'tile-img');
        var src = F1Api.imageUrl(t.image, 384, 216);
        if (src) img.style.backgroundImage = 'url("' + src + '")';
        if (t.live) img.appendChild(el('div', 'tile-badge', 'LIVE'));
        tile.appendChild(img);
        tile.appendChild(el('div', 'tile-title', t.title));
        if (t.sub) tile.appendChild(el('div', 'tile-sub', t.sub));
        tile._tile = t;
        track.appendChild(tile);
        return tile;
      });
    });
    buildBrowseGrid(rows);
  }

  /** Row 0 is the top nav; rails follow. */
  function buildBrowseGrid(railRows) {
    var navRow = Array.prototype.slice.call($('topnav').children);
    grid = new Focus.Grid([navRow].concat(railRows), {
      onSelect: function (e) {
        if (e._tab != null) return openTab(e._tab);
        selectTile(e._tile);
      },
      onMove: function (r, c, e) {
        if (r === 0) return;
        var track = e.parentNode;
        track.style.transform = 'translateX(' + (-Math.max(0, c - 1) * 408) + 'px)';
        var inner = document.querySelector('.rails-inner');
        var rail = track.parentNode;
        if (inner) inner.style.transform = 'translateY(' + (-Math.max(0, rail.offsetTop - 20)) + 'px)';
      }
    });
    grid.r = railRows.length ? 1 : 0;
    grid.apply();
  }

  function selectTile(t) {
    if (t.contentId) return openFeeds(t.contentId, t);
    if (t.uri) return openPage(t.title, function () { return F1Api.pageByUri(t.uri); });
    toast('This item cannot be opened yet');
  }

  // ---------- feeds ----------

  function openFeeds(contentId, tile) {
    show('feeds');
    $('feeds-title').textContent = tile.title;
    $('feeds-sub').textContent = 'Loading…';
    $('feeds-list').innerHTML = '';
    var hero = F1Api.imageUrl(tile.image, 1920, 1080);
    $('feeds-hero').style.backgroundImage = hero ? 'url("' + hero + '")' : '';
    grid = new Focus.Grid([]);

    F1Api.video(contentId).then(function (v) {
      var m = v.metadata || {};
      var extra = (m.additionalStreams || []).map(function (s) {
        var name = s.title || s.reportingName || s.driverFirstName && (s.driverFirstName + ' ' + s.driverLastName) || 'Feed';
        return { title: name, type: s.type || '', channelId: s.channelId || null, playbackUrl: s.playbackUrl };
      });
      var feeds = [{ title: 'Main feed', type: 'broadcast', channelId: null }].concat(
        extra.filter(function (f) { return !/^main/i.test(f.title) || f.channelId; })
      );
      feedsCtx = { contentId: contentId, title: tile.title, feeds: feeds, index: 0,
        live: /^LIVE/.test(m.contentSubtype || '') || tile.live };
      $('feeds-sub').textContent = [m.emfAttributes && m.emfAttributes.Meeting_Name, m.contentSubtype].filter(Boolean).join(' · ');
      var list = $('feeds-list');
      var rows = feeds.map(function (f, i) {
        var e = el('div', 'feed');
        e.appendChild(el('span', '', f.title));
        e.appendChild(el('span', 'feed-type', f.type));
        e._i = i;
        list.appendChild(e);
        return [e];
      });
      grid = new Focus.Grid(rows, { onSelect: function (e) { playFeed(e._i); } });
      grid.apply();
    }).catch(function (e) {
      $('feeds-sub').textContent = 'Could not load: ' + e.message;
    });
  }

  // ---------- player ----------

  function playFeed(i) {
    var f = feedsCtx.feeds[i];
    feedsCtx.index = i;
    ensureSession().then(function (ok) {
      if (!ok) return showLogin('Sign in to watch.');
      show('player');
      $('osd-title').textContent = feedsCtx.title;
      $('osd-feed').textContent = f.title;
      $('spinner').classList.remove('hidden');
      showOsd();
      return Player.unload()
        .then(function () { return F1Api.play(feedsCtx.contentId, f.channelId); })
        .then(function (stream) { stream.live = feedsCtx.live; return stream; })
        .then(function (stream) { return Player.load(stream); })
        .then(function () { $('spinner').classList.add('hidden'); })
        .catch(function (e) {
          $('spinner').classList.add('hidden');
          toast('Could not play: ' + (e.message || e), 8000);
        });
    });
  }

  function showOsd() {
    $('osd').classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { $('osd').classList.add('hidden'); }, 4000);
  }

  function updateOsd() {
    if (screen !== 'player') return;
    var pos = Player.position();
    var r = Player.range();
    var live = Player.isLive();
    var span = Math.max(1, r.end - r.start);
    $('osd-progress').style.width = (100 * (pos - r.start) / span) + '%';
    $('osd-buffer').style.width = (100 * (Player.bufferedEnd() - r.start) / span) + '%';
    $('osd-live').classList.toggle('hidden', !live);
    $('osd-pos').textContent = live ? '-' + fmtTime(r.end - pos) : fmtTime(pos);
    $('osd-dur').textContent = live ? '' : fmtTime(r.end);
  }

  function stopPlayer() {
    Player.unload();
    $('spinner').classList.add('hidden');
    show('feeds');
    grid.apply();
  }

  function playerKey(key) {
    showOsd();
    if (key === K.ENTER || key === K.PLAY_PAUSE || key === K.PLAY || key === K.PAUSE) return Player.togglePause();
    if (key === K.LEFT) return Player.seekBy(-10);
    if (key === K.RIGHT) return Player.seekBy(10);
    if (key === K.RW) return Player.seekBy(-60);
    if (key === K.FF) return Player.seekBy(60);
    if (key === K.UP || key === K.CH_UP) return switchFeed(-1);
    if (key === K.DOWN || key === K.CH_DOWN) return switchFeed(1);
    if (key === K.STOP || key === K.BACK) return stopPlayer();
  }

  function switchFeed(d) {
    var n = feedsCtx.feeds.length;
    if (n < 2) return;
    var i = (feedsCtx.index + d + n) % n;
    grid.r = i;
    playFeed(i);
  }

  // ---------- keys ----------

  function onKey(e) {
    var key = Keys.normalize(e);
    if (screen === 'player') { e.preventDefault(); return playerKey(key); }
    if (key === K.BACK) {
      e.preventDefault();
      if (screen === 'feeds') { show('browse'); return renderPage(history[history.length - 1].title, history[history.length - 1].load); }
      if (screen === 'browse' && history.length > 1) {
        history.pop();
        var top = history[history.length - 1];
        return renderPage(top.title, top.load);
      }
      return exitApp();
    }
    if (key === K.EXIT) return exitApp();
    if (grid && grid.handle(key)) e.preventDefault();
  }

  // ---------- boot ----------

  function boot() {
    Keys.register();
    document.addEventListener('keydown', onKey);
    tickClock();
    setInterval(tickClock, 15000);
    setInterval(updateOsd, 500);

    Player.on('error', function (msg) { toast(msg, 8000); $('spinner').classList.add('hidden'); });
    Player.on('buffering', function (b) { $('spinner').classList.toggle('hidden', !b); });
    Player.on('ended', function () { if (screen === 'player') stopPlayer(); });

    Player.init($('video'), $('av-player'))
      .then(function () { return F1Api.refreshConfig(); })
      .then(function () { return ensureSession(); })
      .then(function (ok) {
        if (!ok) return F1Api.refreshLocation().then(function () { showLogin(); });
        enterBrowse();
      })
      .catch(function (e) {
        showLogin('Startup problem: ' + e.message);
      });
  }

  window.addEventListener('load', boot);
})();
