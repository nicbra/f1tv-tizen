/* Screens, navigation and wiring between the API, auth and player. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var K = Keys.codes;

  var screen = null;       // 'login' | 'browse' | 'list' | 'feeds' | 'player'
  var grid = null;         // focus grid of the current screen
  var backStack = [];      // functions that restore the previous screen
  var navTabs = [];
  var currentPage = null;  // { title, load, kind } shown on the browse screen
  var feedsCtx = null;     // { contentId, title, image, feeds, index, live, start }
  var osdTimer = null;
  var loginJob = null;
  var dialog = null;       // { grid, resolve } while a dialog is open
  var scrub = null;        // { pos, n, last, timer } while seeking with the arrows

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- helpers ----------

  function show(name) {
    ['login', 'browse', 'list', 'feeds', 'player'].forEach(function (n) {
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

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }

  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function hhmmss(ms) { var d = new Date(ms); return hhmm(ms) + ':' + pad(d.getSeconds()); }
  function dayDate(ms) { var d = new Date(ms); return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }

  function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

  /** "today 23:00", "tomorrow 19:00", "Sat 25 Oct 19:00". */
  function when(ms) {
    var now = Date.now();
    if (sameDay(ms, now)) return 'today ' + hhmm(ms);
    if (sameDay(ms, now + 86400000)) return 'tomorrow ' + hhmm(ms);
    return dayDate(ms) + ' ' + hhmm(ms);
  }

  /** "in 5 min", "in 1 h 52 min", "in 3 days". */
  function until(ms) {
    var min = Math.max(1, Math.round((ms - Date.now()) / 60000));
    if (min < 60) return 'in ' + min + ' min';
    if (min < 48 * 60) return 'in ' + Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
    return 'in ' + Math.round(min / 1440) + ' days';
  }

  /** 'live' | 'upcoming' | 'done' for a scheduled broadcast. */
  function status(ev) {
    var now = Date.now(), end = ev.end || ev.start + 2 * 3600000;
    if (now < ev.start) return 'upcoming';
    return now < end ? 'live' : 'done';
  }

  function tickClock() { $('clock').textContent = hhmm(Date.now()); }

  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* desktop */ }
  }

  /** Remembers the current screen (its DOM stays intact) so BACK can return to it. */
  function snapshot() {
    var s = screen, g = grid;
    return function () { show(s); grid = g; if (grid) grid.apply(); };
  }

  function goBack() {
    var fn = backStack.pop();
    if (fn) fn(); else exitApp();
  }

  // ---------- dialog ----------

  /** Shows a choice dialog; resolves with the chosen option's value, or null on BACK. */
  function ask(title, text, options) {
    $('dialog-title').textContent = title;
    $('dialog-text').textContent = text || '';
    var box = $('dialog-actions');
    box.innerHTML = '';
    var row = options.map(function (o) {
      var b = el('div', 'btn', o.label);
      b._value = o.value;
      box.appendChild(b);
      return b;
    });
    $('dialog').classList.remove('hidden');
    return new Promise(function (resolve) {
      var g = new Focus.Grid([row], { onSelect: function (b) { close(b._value); } });
      function close(v) { $('dialog').classList.add('hidden'); dialog = null; if (grid) grid.apply(); resolve(v); }
      dialog = { grid: g, close: close };
      g.apply();
    });
  }

  // ---------- login ----------

  /** Sign-in screen: starts pairing straight away and shows the code plus a QR link. */
  function showLogin(reason) {
    show('login');
    backStack = [];
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
      toast('Signed in as ' + (Auth.profile().firstName || 'you'));
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

  // ---------- navigation tabs ----------

  function enterBrowse() {
    if (loginJob && loginJob.cancel) loginJob.cancel();
    loginJob = null;
    show('browse');
    var page = function (uri) { return function () { return F1Api.pageByUri(uri); }; };
    var byId = function (id) { return function () { return F1Api.page(id); }; };
    F1Api.menu().catch(function () { return []; }).then(function (menu) {
      var find = function (re) { return menu.filter(function (m) { return re.test(m.title); })[0]; };
      var home = find(/^home$/i), season = find(/season/i);
      navTabs = [{ title: 'Home', kind: 'home', load: home ? page(home.uri) : byId(F1Api.HOME_PAGE_ID) }];
      if (season) navTabs.push({ title: 'Schedule', run: function () { openCalendar(season.uri); } });
      menu.forEach(function (m) {
        if (m === home || m === season || /search/i.test(m.title)) return;
        navTabs.push({ title: m.title, load: page(m.uri) });
      });
      if (!menu.length) navTabs.push({ title: 'Archive', load: byId(F1Api.ARCHIVE_PAGE_ID) });
      var who = Auth.profile();
      navTabs.push(Auth.token()
        ? { title: who.firstName || 'Account', account: true, run: openAccount }
        : { title: 'Sign in', account: true, run: function () { showLogin(); } });

      var nav = $('topnav');
      nav.innerHTML = '';
      navTabs.forEach(function (t, i) {
        var e = el('div', 'nav-item' + (t.account ? ' account' : ''), t.title);
        e._tab = i;
        nav.appendChild(e);
      });
      openTab(0);
    });
  }

  function markTab(i) {
    var items = $('topnav').children;
    for (var j = 0; j < items.length; j++) items[j].classList.toggle('active', j === i);
  }

  function openTab(i) {
    var t = navTabs[i];
    backStack = [];
    if (t.run) {
      backStack.push(function () { show('browse'); openTab(0); });
      return t.run();
    }
    markTab(i);
    show('browse');
    currentPage = { title: t.title, load: t.load, kind: t.kind, root: true };
    renderPage(currentPage);
  }

  // ---------- browse (rails) ----------

  function openPage(title, load) {
    var prev = currentPage, focus = grid ? { r: grid.r, c: grid.c.slice() } : null;
    backStack.push(function () { show('browse'); currentPage = prev; renderPage(prev, focus); });
    currentPage = { title: title, load: load };
    renderPage(currentPage);
  }

  function renderPage(pg, focus) {
    $('page-title').textContent = pg.root ? '' : pg.title;
    var rails = $('rails');
    rails.innerHTML = '';
    rails.appendChild(el('div', 'empty', 'Loading…'));
    pg.load().then(function (containers) {
      if (currentPage !== pg) return;
      var list = railsFromContainers(containers);
      var weekend = F1Api.scheduleFrom(containers);
      if (weekend && weekend.events.length) list.unshift(weekendRail(weekend));
      drawRails(list, focus);
    }).catch(function (e) {
      rails.innerHTML = '';
      rails.appendChild(el('div', 'empty', 'Could not load: ' + e.message));
      buildBrowseGrid([], focus);
    });
  }

  function railsFromContainers(containers) {
    var out = [];
    (containers || []).forEach(function (c) {
      if (c.layout === 'interactive_schedule') return;
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
      badge: /LIVE/.test(m.contentSubtype || '') && m.contentSubtype !== 'LIVE_REPLAY' ? { text: 'LIVE', cls: '' } : null,
      raw: item
    };
  }

  /** "This weekend" rail from the page's broadcast schedule; focus lands on live/next. */
  function weekendRail(weekend) {
    var focus = 0, found = false;
    var tiles = weekend.events.map(function (ev, i) {
      var st = status(ev);
      if (!found && st !== 'done') { focus = i; found = true; }
      return scheduleTile(ev);
    });
    if (!found) focus = tiles.length - 1;
    return { title: 'This weekend' + (weekend.meeting ? ' · ' + weekend.meeting : ''), tiles: tiles, focus: focus };
  }

  function scheduleTile(ev) {
    var st = status(ev);
    var badge = st === 'live' ? { text: 'LIVE', cls: '' }
      : st === 'upcoming' ? { text: when(ev.start), cls: 'soon' } : { text: 'Replay', cls: 'done' };
    return {
      title: ev.title,
      sub: ev.series + ' · ' + dayDate(ev.start) + ' ' + hhmm(ev.start),
      image: ev.pictureUrl,
      contentId: ev.contentId,
      badge: badge,
      event: ev,
      upcoming: st === 'upcoming'
    };
  }

  function drawRails(rails, focus) {
    var root = $('rails');
    root.innerHTML = '';
    if (!rails.length) {
      root.appendChild(el('div', 'empty', 'Nothing here right now.'));
      return buildBrowseGrid([], focus);
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
        var tile = el('div', 'tile' + (t.upcoming ? ' upcoming' : ''));
        var img = el('div', 'tile-img');
        var src = F1Api.imageUrl(t.image, 384, 216);
        if (src) img.style.backgroundImage = 'url("' + src + '")';
        if (t.badge) img.appendChild(el('div', 'tile-badge ' + t.badge.cls, t.badge.text));
        tile.appendChild(img);
        tile.appendChild(el('div', 'tile-title', t.title));
        if (t.sub) tile.appendChild(el('div', 'tile-sub', t.sub));
        tile._tile = t;
        track.appendChild(tile);
        return tile;
      });
    });
    if (!focus && rails[0].focus != null) focus = { r: 1, c: [0, rails[0].focus] };
    buildBrowseGrid(rows, focus);
  }

  /** Row 0 is the top nav; rails follow. */
  function buildBrowseGrid(railRows, focus) {
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
    if (focus) {
      grid.r = Math.min(focus.r, grid.rows.length - 1);
      for (var i = 0; i < grid.rows.length; i++) {
        if (focus.c[i] != null) grid.c[i] = Math.min(focus.c[i], grid.rows[i].length - 1);
      }
    }
    var active = navTabs.indexOf(navTabs.filter(function (t) { return t.title === (currentPage && currentPage.title); })[0]);
    if (active >= 0) grid.c[0] = active;
    grid.apply();
  }

  function selectTile(t) {
    if (t.event && status(t.event) === 'upcoming') return toast(t.title + ' starts ' + when(t.event.start) + ' (' + until(t.event.start) + ').');
    if (t.contentId) return openFeeds(t.contentId, t);
    if (t.uri) return openPage(t.title, function () { return F1Api.pageByUri(t.uri); });
    toast('This item cannot be opened yet');
  }

  // ---------- lists: calendar, weekend, account ----------

  /**
   * Renders a vertical list. rows: [{ day } | { when, what, sub, badge, badgeCls, past, info, run }].
   * focusIndex is the index into the focusable rows.
   */
  function renderList(spec, focusIndex) {
    show('list');
    $('list-title').textContent = spec.title;
    $('list-sub').textContent = spec.sub || '';
    var hero = F1Api.imageUrl(spec.image, 1920, 1080);
    $('list-hero').style.backgroundImage = hero ? 'url("' + hero + '")' : '';
    var inner = $('list-inner');
    inner.innerHTML = '';
    inner.style.transform = '';
    var rows = [];
    spec.rows.forEach(function (row) {
      if (row.day) return inner.appendChild(el('div', 'list-day', row.day));
      var e = el('div', 'list-row' + (row.past ? ' past' : '') + (row.info ? ' info' : ''));
      e.appendChild(el('div', 'when', row.when || ''));
      var what = el('div', 'what', row.what);
      if (row.sub) what.appendChild(el('small', '', row.sub));
      e.appendChild(what);
      if (row.badge) e.appendChild(el('div', 'badge ' + (row.badgeCls || ''), row.badge));
      inner.appendChild(e);
      if (row.run) { e._row = row; rows.push([e]); }
    });
    grid = new Focus.Grid(rows, {
      onSelect: function (e) { e._row.run(rows.indexOf(rows.filter(function (r) { return r[0] === e; })[0])); },
      onMove: function (r, c, e) {
        var top = e.offsetTop, view = $('list-body').clientHeight;
        inner.style.transform = 'translateY(' + (-Math.max(0, top - view / 2 + 60)) + 'px)';
      }
    });
    grid.r = Math.max(0, Math.min(focusIndex || 0, rows.length - 1));
    grid.apply();
  }

  function openCalendar(seasonUri) {
    show('list');
    $('list-title').textContent = 'Schedule';
    $('list-sub').textContent = 'Loading the calendar…';
    $('list-inner').innerHTML = '';
    F1Api.pageByUri(seasonUri).then(function (containers) {
      var meetings = F1Api.seasonFrom(containers);
      var now = Date.now(), focus = -1, rows = [];
      meetings.forEach(function (mt) {
        var endDay = (mt.end || mt.start) + 86400000;
        var current = mt.start <= now && now < endDay;
        var past = !current && endDay <= now;
        if (focus < 0 && !past) focus = rows.length;
        // Meeting dates are whole UTC days (end at 23:59:59Z), so read them in UTC.
        var s0 = new Date(mt.start), s1 = new Date(mt.end || mt.start);
        var range = mt.start ? s0.getUTCDate() + '–' + s1.getUTCDate() + ' ' + MONTHS[s1.getUTCMonth()] : '';
        rows.push({
          when: mt.test ? 'Testing' : (mt.round ? 'Round ' + mt.round : ''),
          what: mt.country || mt.name,
          sub: mt.name + (range ? ' · ' + range : ''),
          badge: current ? 'This weekend' : past ? 'Replays' : until(mt.start).replace(/^in /, ''),
          badgeCls: current ? 'live' : '',
          past: past,
          run: function (idx) {
            backStack.push(function () { openCalendarAt(seasonUri, idx, rows); });
            openWeekend(mt);
          }
        });
      });
      openCalendarAt(seasonUri, focus < 0 ? rows.length - 1 : focus, rows);
    }).catch(function (e) { $('list-sub').textContent = 'Could not load the calendar: ' + e.message; });
  }

  function openCalendarAt(seasonUri, focus, rows) {
    renderList({ title: 'Schedule', sub: (new Date().getFullYear()) + ' season · times in your local time zone', rows: rows }, focus);
  }

  function openWeekend(mt) {
    show('list');
    $('list-title').textContent = mt.country || mt.name;
    $('list-sub').textContent = 'Loading…';
    $('list-inner').innerHTML = '';
    F1Api.pageByUri(mt.uri).then(function (containers) {
      var sched = F1Api.scheduleFrom(containers);
      var rows = [], lastDay = null, focus = -1, count = 0;
      (sched ? sched.events : []).forEach(function (ev) {
        var d = dayDate(ev.start);
        if (d !== lastDay) { rows.push({ day: d }); lastDay = d; }
        var st = status(ev);
        if (focus < 0 && st !== 'done') focus = count;
        count++;
        rows.push({
          when: hhmm(ev.start),
          what: ev.title,
          sub: ev.series,
          badge: st === 'live' ? 'LIVE' : st === 'upcoming' ? until(ev.start) : 'Replay',
          badgeCls: st === 'live' ? 'live' : '',
          past: st === 'done',
          run: function (idx) {
            if (status(ev) === 'upcoming') return toast(ev.title + ' starts ' + when(ev.start) + ' (' + until(ev.start) + ').');
            var restore = function () { renderList(spec, idx); };
            openFeeds(ev.contentId, { title: ev.title, image: ev.pictureUrl, event: ev }, restore);
          }
        });
      });
      rows.push({ what: 'All videos from this weekend', sub: 'Shows, press conferences and more', run: function (idx) {
        backStack.push(function () { renderList(spec, idx); });
        show('browse');
        markTab(-1);
        currentPage = { title: mt.country || mt.name, load: function () { return F1Api.pageByUri(mt.uri); } };
        renderPage(currentPage);
      } });
      var spec = { title: mt.country || mt.name, sub: mt.name + ' · times in your local time zone', image: mt.pictureUrl, rows: rows };
      if (!sched) spec.sub = 'No broadcast schedule published yet';
      renderList(spec, focus < 0 ? 0 : focus);
    }).catch(function (e) { $('list-sub').textContent = 'Could not load: ' + e.message; });
  }

  function openAccount() {
    var p = Auth.profile();
    renderList({
      title: (p.firstName + ' ' + p.lastName).trim() || 'Account',
      sub: p.product || 'F1 TV',
      rows: [
        { what: 'Sign out of this TV', sub: 'You can sign in again with a code at any time.', run: function () {
          ask('Sign out?', 'This TV stops being able to play F1 TV until you sign in again.', [
            { label: 'Cancel', value: false }, { label: 'Sign out', value: true }
          ]).then(function (yes) {
            if (!yes) return;
            Auth.clear();
            F1Api.logout().catch(function () {});
            showLogin();
          });
        } },
        { info: true, what: 'Unofficial app — not affiliated with Formula 1.', sub: 'Streams play through the TV\'s own Widevine DRM.' }
      ]
    }, 0);
  }

  // ---------- feeds ----------

  function openFeeds(contentId, tile, restore) {
    backStack.push(restore || snapshot());
    show('feeds');
    $('feeds-title').textContent = tile.title;
    $('feeds-sub').textContent = 'Loading…';
    $('feeds-list').innerHTML = '';
    $('feeds-list').style.transform = '';
    var hero = F1Api.imageUrl(tile.image, 1920, 1080);
    $('feeds-hero').style.backgroundImage = hero ? 'url("' + hero + '")' : '';
    grid = new Focus.Grid([]);

    F1Api.video(contentId).then(function (v) {
      var m = v.metadata || {};
      var extra = (m.additionalStreams || []).map(function (s) {
        var name = s.title || s.reportingName || (s.driverFirstName && (s.driverFirstName + ' ' + s.driverLastName)) || 'Feed';
        var type = s.type === 'obc' ? (s.teamName || 'Onboard') : (s.type || '');
        return { title: name, type: type, channelId: s.channelId || null };
      });
      var feeds = [{ title: 'Main feed', type: 'Broadcast', channelId: null }].concat(
        extra.filter(function (f) { return !/^main/i.test(f.title) || f.channelId; })
      );
      var ev = tile.event;
      feedsCtx = { contentId: contentId, title: tile.title, image: tile.image, feeds: feeds, index: 0,
        live: ev ? status(ev) === 'live' : (/^LIVE/.test(m.contentSubtype || '') || !!(tile.badge && tile.badge.text === 'LIVE')),
        start: ev ? ev.start : null };
      var subParts = [m.emfAttributes && m.emfAttributes.Meeting_Name];
      if (feedsCtx.live) subParts.push('LIVE now');
      else if (ev && status(ev) === 'upcoming') subParts.push('Starts ' + when(ev.start));
      else if (m.uiDuration) subParts.push(m.uiDuration);
      $('feeds-sub').textContent = subParts.filter(Boolean).join(' · ');
      var list = $('feeds-list');
      var rows = feeds.map(function (f, i) {
        var e = el('div', 'feed');
        e.appendChild(el('span', '', f.title));
        e.appendChild(el('span', 'feed-type', f.type));
        e._i = i;
        list.appendChild(e);
        return [e];
      });
      grid = new Focus.Grid(rows, {
        onSelect: function (e) { chooseStart(e._i); },
        onMove: function (r) { list.style.transform = 'translateY(' + (-Math.max(0, r - 5) * 72) + 'px)'; }
      });
      grid.apply();
    }).catch(function (e) {
      $('feeds-sub').textContent = 'Could not load: ' + e.message;
    });
  }

  /** Live sessions ask whether to join live or watch from the start of the broadcast. */
  function chooseStart(i) {
    if (!feedsCtx.live) return playFeed(i, { fromStart: true });
    ask(feedsCtx.title + ' is live', 'Join the live broadcast, or start from the beginning?', [
      { label: 'Watch live', value: 'live' }, { label: 'From the start', value: 'start' }
    ]).then(function (v) { if (v) playFeed(i, { fromStart: v === 'start' }); });
  }

  // ---------- player ----------

  /**
   * Plays feed i. opts.fromStart starts at the beginning of the broadcast; opts.keepTime
   * (unix seconds) continues at the same moment, used when switching feeds.
   */
  function playFeed(i, opts) {
    opts = opts || {};
    var f = feedsCtx.feeds[i];
    feedsCtx.index = i;
    ensureSession().then(function (ok) {
      if (!ok) return showLogin('Sign in to watch.');
      show('player');
      scrub = null;
      $('osd-title').textContent = feedsCtx.title;
      $('osd-feed').textContent = f.title;
      $('spinner').classList.remove('hidden');
      showOsd();
      return Player.unload()
        .then(function () { return F1Api.play(feedsCtx.contentId, f.channelId); })
        .then(function (stream) {
          stream.live = feedsCtx.live;
          if (!/\.mpd(\?|$)/.test(stream.url)) return stream;
          return F1Api.dashInfo(stream.url).then(function (info) { stream.info = info; return stream; }, function () { return stream; });
        })
        .then(function (stream) { return Player.load(stream, startPosition(stream.info, opts)); })
        .then(function () { $('spinner').classList.add('hidden'); })
        .catch(function (e) {
          $('spinner').classList.add('hidden');
          if (F1Api.isNotStarted(e)) {
            stopPlayer();
            return toast(feedsCtx.title + ' hasn\'t started yet' + (feedsCtx.start ? ' — it starts ' + when(feedsCtx.start) + '.' : '.'), 8000);
          }
          toast('Could not play: ' + (e.message || e), 8000);
        });
    });
  }

  function startPosition(info, opts) {
    if (opts.keepTime && info && info.epochAtZero > 1e9) {
      var p = opts.keepTime - info.epochAtZero;
      if (p >= info.windowStart && p <= info.windowEnd) return p;
    }
    if (opts.fromStart && info && info.dynamic) return info.windowStart + 1;
    return null;
  }

  function showOsd() {
    $('osd').classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { if (!scrub) $('osd').classList.add('hidden'); }, 4000);
  }

  /** Label for a position: offset or behind-live time, plus the real clock time when known. */
  function posLabel(pos, r, live) {
    var wall = Player.wallClock(pos);
    var main;
    if (live) main = r.end - pos < 15 ? 'LIVE' : '−' + fmtTime(r.end - pos);
    else main = fmtTime(pos - r.start);
    return { main: main, clock: wall ? hhmmss(wall * 1000) : '' };
  }

  function updateOsd() {
    if (screen !== 'player') return;
    var pos = Player.position();
    var r = Player.range();
    var live = Player.isLive();
    var span = Math.max(1, r.end - r.start);
    var pct = function (p) { return Math.max(0, Math.min(100, 100 * (p - r.start) / span)) + '%'; };
    $('osd-progress').style.width = pct(pos);
    $('osd-buffer').style.width = pct(Player.bufferedEnd());
    var behind = live && r.end - pos >= 15;
    $('osd-live').classList.toggle('hidden', !live || behind);
    var cur = posLabel(pos, r, live);
    $('osd-pos').textContent = cur.clock ? cur.clock + (live ? '' : '  ·  ' + cur.main) : cur.main;
    $('osd-dur').textContent = live ? (behind ? cur.main + ' behind live' : '') : fmtTime(span);

    var marker = $('osd-marker'), bubble = $('osd-bubble');
    if (scrub) {
      var lbl = posLabel(scrub.pos, r, live);
      marker.style.left = pct(scrub.pos);
      bubble.style.left = pct(scrub.pos);
      bubble.innerHTML = '';
      bubble.appendChild(document.createTextNode(lbl.main));
      if (lbl.clock) bubble.appendChild(el('small', '', lbl.clock));
      marker.classList.remove('hidden');
      bubble.classList.remove('hidden');
      $('osd-hint').textContent = 'OK to jump · BACK to cancel';
    } else {
      marker.classList.add('hidden');
      bubble.classList.add('hidden');
      $('osd-hint').textContent = '◀ ▶ seek · OK pause · ▲ ▼ switch feed · BACK exit' + (behind ? ' · hold ▶ to catch up' : '');
    }
  }

  // Seek steps grow while the arrow is held / pressed quickly, like on YouTube or NRK TV.
  var SCRUB_STEPS = [10, 10, 15, 30, 30, 60, 60, 120, 300];

  function scrubMove(dir, big) {
    var now = Date.now();
    if (!scrub) scrub = { pos: Player.position(), n: -1, last: 0 };
    scrub.n = now - scrub.last < 600 ? Math.min(scrub.n + 1, SCRUB_STEPS.length - 1) : 0;
    scrub.last = now;
    var r = Player.range();
    scrub.pos = Math.max(r.start, Math.min(r.end, scrub.pos + dir * (big ? 60 : SCRUB_STEPS[scrub.n])));
    clearTimeout(scrub.timer);
    scrub.timer = setTimeout(scrubCommit, 1500);
    showOsd();
    updateOsd();
  }

  function scrubCommit() {
    if (!scrub) return;
    var p = scrub.pos;
    clearTimeout(scrub.timer);
    scrub = null;
    $('spinner').classList.remove('hidden');
    Player.seekTo(p, function () { $('spinner').classList.add('hidden'); });
    showOsd();
    updateOsd();
  }

  function scrubCancel() {
    clearTimeout(scrub.timer);
    scrub = null;
    updateOsd();
  }

  function stopPlayer() {
    if (scrub) scrubCancel();
    Player.unload();
    $('spinner').classList.add('hidden');
    show('feeds');
    if (grid) grid.apply();
  }

  function playerKey(key) {
    showOsd();
    if (scrub) {
      if (key === K.ENTER) return scrubCommit();
      if (key === K.BACK) return scrubCancel();
    }
    if (key === K.LEFT) return scrubMove(-1);
    if (key === K.RIGHT) return scrubMove(1);
    if (key === K.RW) return scrubMove(-1, true);
    if (key === K.FF) return scrubMove(1, true);
    if (key === K.ENTER || key === K.PLAY_PAUSE || key === K.PLAY || key === K.PAUSE) return Player.togglePause();
    if (key === K.UP || key === K.CH_UP) return switchFeed(-1);
    if (key === K.DOWN || key === K.CH_DOWN) return switchFeed(1);
    if (key === K.STOP || key === K.BACK) return stopPlayer();
  }

  /** Switches feed and continues at the same moment of the session. */
  function switchFeed(d) {
    var n = feedsCtx.feeds.length;
    if (n < 2) return;
    if (scrub) scrubCancel();
    var i = (feedsCtx.index + d + n) % n;
    var wall = Player.wallClock(Player.position());
    grid.r = i;
    playFeed(i, { keepTime: wall });
  }

  // ---------- keys ----------

  function onKey(e) {
    var key = Keys.normalize(e);
    if (dialog) {
      e.preventDefault();
      if (key === K.BACK) return dialog.close(null);
      return dialog.grid.handle(key);
    }
    if (screen === 'player') { e.preventDefault(); return playerKey(key); }
    if (key === K.BACK) {
      e.preventDefault();
      if (screen === 'login' || !backStack.length) return exitApp();
      return goBack();
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
