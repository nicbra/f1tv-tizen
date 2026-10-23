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
  var scrub = null;        // { pos, n, last, timer, info } while seeking with the arrows
  var panel = null;        // { grid, timer } while the watch-options panel is open
  var timingState = null;  // latest timing state for the playing position
  var subtitleTimer = null;

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var LANG_NAMES = { eng: 'English', deu: 'Deutsch', fra: 'Français', nld: 'Nederlands', por: 'Português',
    jpn: '日本語', spa: 'Español', ita: 'Italiano', fx: 'Track sound only', tea: 'Team radio' };
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
        var art = el('div', 'tile-art' + (spoilerSafe(t) ? '' : ' spoiler'));
        var src = F1Api.imageUrl(t.image, 384, 216);
        if (src) art.style.backgroundImage = 'url("' + src + '")';
        img.appendChild(art);
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

  /** In spoiler-free mode only live and upcoming artwork is shown unblurred. */
  function spoilerSafe(t) {
    return !Settings.get('spoilerFree') || t.upcoming || (t.badge && t.badge.text === 'LIVE') || !t.contentId;
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

  function openAccount(focus) {
    var p = Auth.profile();
    var toggle = function (key, name, help) {
      return { what: name, sub: help, badge: Settings.get(key) ? 'On' : 'Off', badgeCls: Settings.get(key) ? 'live' : '',
        run: function (idx) { Settings.set(key, !Settings.get(key)); openAccount(idx); } };
    };
    renderList({
      title: (p.firstName + ' ' + p.lastName).trim() || 'Account',
      sub: p.product || 'F1 TV',
      rows: [
        { day: 'Settings' },
        toggle('spoilerFree', 'Spoiler-free mode', 'Blurs artwork of replays and highlights so results stay hidden.'),
        toggle('timing', 'Live timing overlay', 'Timing tower while watching sessions. Also in the player with ▲ ▼.'),
        { day: 'Account' },
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
    }, focus || 0);
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
    $('feeds-hero').classList.toggle('spoiler', !spoilerSafe(tile));
    grid = new Focus.Grid([]);

    F1Api.video(contentId).then(function (v) {
      var m = v.metadata || {};
      var extra = (m.additionalStreams || []).map(function (s) {
        var name = s.title || s.reportingName || (s.driverFirstName && (s.driverFirstName + ' ' + s.driverLastName)) || 'Feed';
        var type = s.type === 'obc' ? (s.teamName || 'Onboard') : '';
        var full = s.driverFirstName ? s.driverFirstName + ' ' + s.driverLastName : '';
        return { title: name, type: type, channelId: s.channelId || null, hex: s.hex || '', full: full,
          num: s.type === 'obc' && s.racingNumber != null ? String(s.racingNumber) : '' };
      });
      var feeds = [{ title: 'Main feed', type: 'Broadcast', channelId: null }].concat(
        extra.filter(function (f) { return !/^main/i.test(f.title) || f.channelId; })
      );
      var ev = tile.event;
      feedsCtx = { contentId: contentId, title: tile.title, image: tile.image, feeds: feeds, index: 0,
        live: ev ? status(ev) === 'live' : (/^LIVE/.test(m.contentSubtype || '') || !!(tile.badge && tile.badge.text === 'LIVE')),
        start: ev ? ev.start : null };
      var emf = m.emfAttributes || {};
      feedsCtx.timingMeta = {
        title: m.titleBrief || tile.title, series: emf.Series || (ev && ev.series) || '',
        meeting: emf.Meeting_Name || (ev && ev.meeting) || '', meetingKey: emf.MeetingKey || (ev && ev.meetingKey),
        start: +emf.sessionStartDate || (ev && ev.start), endIso: emf.sessionEndTime || (ev && ev.endIso) || '',
        meetingEnd: ev && ev.meetingEnd
      };
      feedsCtx.subtype = m.contentSubtype;
      feedsCtx.duration = m.duration;
      var resumeReady = Promise.resolve();
      if (!feedsCtx.live) {
        resumeReady = F1Api.resumePosition(contentId, m.duration).then(function (pos) {
          if (!feedsCtx || feedsCtx.contentId !== contentId || pos < 60 || (m.duration && pos > m.duration - 120)) return;
          feedsCtx.resume = pos;
          $('feeds-sub').textContent += ' · Watched to ' + fmtTime(pos);
        });
      }
      var subParts = [m.emfAttributes && m.emfAttributes.Meeting_Name];
      if (feedsCtx.live) subParts.push('LIVE now');
      else if (ev && status(ev) === 'upcoming') subParts.push('Starts ' + when(ev.start));
      else if (m.uiDuration) subParts.push(m.uiDuration);
      $('feeds-sub').textContent = subParts.filter(Boolean).join(' · ');
      var list = $('feeds-list');
      var rows = feeds.map(function (f, i) {
        var e = el('div', 'feed');
        e.appendChild(feedNumber(f));
        var name = el('span', 'feed-name', f.title);
        if (f.full) name.appendChild(el('small', '', f.full));
        e.appendChild(name);
        e.appendChild(el('span', 'feed-type', f.type));
        e._i = i;
        list.appendChild(e);
        return [e];
      });
      feedsCtx.single = feeds.length === 1;
      grid = new Focus.Grid(rows, {
        onSelect: function (e) { chooseStart(e._i); },
        onMove: function (r) { list.style.transform = 'translateY(' + (-Math.max(0, r - 5) * 72) + 'px)'; }
      });
      grid.apply();
      // Documentaries, shows etc. have just one feed: play straight away (after the resume check).
      if (feedsCtx.single) {
        var ctx = feedsCtx;
        resumeReady.then(function () { if (feedsCtx === ctx && screen === 'feeds') chooseStart(0); });
      }
    }).catch(function (e) {
      $('feeds-sub').textContent = 'Could not load: ' + e.message;
    });
  }

  /** Driver's racing number in the team colour (empty slot for non-driver feeds). */
  function feedNumber(f) {
    var n = el('span', 'feed-num', f.num || '');
    if (f.hex) n.style.color = f.hex;
    return n;
  }

  /** Live sessions ask whether to join live or watch from the start of the broadcast. */
  function chooseStart(i) {
    if (!feedsCtx.live && feedsCtx.resume && i === 0) {
      return ask('Continue watching?', 'You stopped at ' + fmtTime(feedsCtx.resume) + '.', [
        { label: 'Continue from ' + fmtTime(feedsCtx.resume), value: 'resume' }, { label: 'Start over', value: 'start' }
      ]).then(function (v) {
        if (v) playFeed(i, v === 'resume' ? { startAt: feedsCtx.resume } : { fromStart: true });
        else if (feedsCtx.single) goBack();
      });
    }
    if (!feedsCtx.live) return playFeed(i, { fromStart: true });
    ask(feedsCtx.title + ' is live', 'Join the live broadcast, or start from the beginning?', [
      { label: 'Watch live', value: 'live' }, { label: 'From the start', value: 'start' }
    ]).then(function (v) {
      if (v) playFeed(i, { fromStart: v === 'start' });
      else if (feedsCtx.single) goBack();
    });
  }

  // ---------- player ----------

  /**
   * Plays feed i. opts.fromStart starts at the beginning of the broadcast; opts.startAt at a given
   * position; opts.switching continues at the same moment as the feed playing now. Switches of
   * clear streams are preloaded while the current feed keeps playing.
   */
  function playFeed(i, opts) {
    opts = opts || {};
    var f = feedsCtx.feeds[i];
    var playing = screen === 'player' && Player.engineName();
    var from = opts.switching && playing ? { wall: Player.wallClock(Player.position()), at: Date.now() } : null;
    feedsCtx.index = i;
    ensureSession().then(function (ok) {
      if (!ok) return showLogin('Sign in to watch.');
      show('player');
      scrub = null;
      $('osd-title').textContent = feedsCtx.title;
      $('osd-feed').textContent = f.title;
      if (from) toast('Switching to ' + (f.full || f.title) + '…', 2500);
      else $('spinner').classList.remove('hidden');
      showOsd();
      var stream;
      return (from ? Promise.resolve() : Player.unload())
        .then(function () { return F1Api.play(feedsCtx.contentId, f.channelId); })
        .then(function (s) {
          stream = s;
          stream.live = feedsCtx.live;
          stream.multiFeed = feedsCtx.feeds.length > 1;
          return F1Api.streamInfo(stream.url).then(function (info) { stream.info = info; }, function () {});
        })
        .then(function () {
          if (feedsCtx.index !== i) return; // another feed was picked meanwhile
          var start = startPosition(stream.info, opts, from);
          if (!from) return Player.load(stream, start);
          var t0 = Date.now();
          return Player.switchTo(stream, start).then(function () {
            // Learn how long a switch takes so the next one lands on the same moment.
            switchLead = Math.max(0.5, Math.min(8, (switchLead + (Date.now() - t0) / 1000) / 2));
          });
        })
        .then(function () {
          $('spinner').classList.add('hidden');
          Timing.load(feedsCtx.timingMeta, F1Api.state.ascendon, feedsCtx.live);
          if (stream && Player.stream() === stream) watchStart(stream);
        })
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

  /** Safety net: if a video hasn't started 15 s after loading, load it once more. */
  function watchStart(stream) {
    var from = Player.position();
    setTimeout(function () {
      if (screen !== 'player' || Player.stream() !== stream || Player.isPaused() || stream.retried) return;
      if (Player.position() > from + 0.5) return;
      stream.retried = true;
      toast('The video didn\'t start — trying again…', 3000);
      $('spinner').classList.remove('hidden');
      Player.load(stream, from || null).then(function () { $('spinner').classList.add('hidden'); },
        function (e) { $('spinner').classList.add('hidden'); toast('Could not play: ' + e.message, 8000); });
    }, 15000);
  }

  // Seconds a feed switch takes; the new feed starts this far ahead so it lines up. Learned per switch.
  var switchLead = 3;

  function startPosition(info, opts, from) {
    if (opts.startAt != null) return opts.startAt;
    if (from && from.wall) {
      var wall = from.wall + (Date.now() - from.at) / 1000 + switchLead;
      var p = Player.positionAt(wall, info);
      if (p != null && p >= info.windowStart && p <= info.windowEnd) return p;
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

    var f = feedsCtx && feedsCtx.feeds[feedsCtx.index];
    var info = Timing.label(timingState);
    $('osd-feed').textContent = (f ? f.title : '') + (info ? '  ·  ' + info : '');

    var marker = $('osd-marker'), bubble = $('osd-bubble');
    if (scrub) {
      var lbl = posLabel(scrub.pos, r, live);
      marker.style.left = pct(scrub.pos);
      bubble.style.left = pct(scrub.pos);
      bubble.innerHTML = '';
      if (scrub.info) bubble.appendChild(el('div', 'bubble-info', scrub.info));
      bubble.appendChild(document.createTextNode(lbl.main));
      if (lbl.clock) bubble.appendChild(el('small', '', lbl.clock));
      marker.classList.remove('hidden');
      bubble.classList.remove('hidden');
      $('osd-hint').textContent = 'OK to jump · BACK to cancel';
    } else {
      marker.classList.add('hidden');
      bubble.classList.add('hidden');
      $('osd-hint').textContent = '◀ ▶ seek · OK pause · ▲ ▼ feeds & options · BACK exit' + (behind ? ' · hold ▶ to catch up' : '');
    }
  }

  // Seek steps grow while the arrow is held / pressed quickly, like on YouTube or NRK TV.
  var SCRUB_STEPS = [10, 10, 15, 30, 30, 60, 60, 120];

  function scrubMove(dir, big) {
    var now = Date.now();
    if (!scrub) scrub = { pos: Player.position(), n: -1, last: 0 };
    scrub.n = now - scrub.last < 600 ? Math.min(scrub.n + 1, SCRUB_STEPS.length - 1) : 0;
    scrub.last = now;
    var r = Player.range();
    scrub.pos = Math.max(r.start, Math.min(r.end, scrub.pos + dir * (big ? 60 : SCRUB_STEPS[scrub.n])));
    clearTimeout(scrub.timer);
    scrub.timer = setTimeout(scrubCommit, 1500);
    var wall = Player.wallClock(scrub.pos), target = scrub.pos, s = scrub;
    if (wall) Timing.query(wall * 1000).then(function (st) {
      if (scrub === s && s.pos === target) { s.info = Timing.label(st); updateOsd(); }
    });
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

  /** Saves how far the main feed of a replay has been watched (synced with F1 TV). */
  function saveProgress() {
    if (screen !== 'player' || !feedsCtx || feedsCtx.live || feedsCtx.index !== 0 || !Player.engineName()) return;
    var pos = Player.position() - Player.range().start;
    if (pos > 30) {
      F1Api.savePosition(feedsCtx.contentId, pos, feedsCtx.subtype);
      feedsCtx.resume = pos;
    }
  }

  function stopPlayer() {
    saveProgress();
    if (scrub) scrubCancel();
    closePanel();
    timingState = null;
    $('tower').classList.add('hidden');
    showSubtitle(null);
    Player.unload();
    $('spinner').classList.add('hidden');
    // Single-feed videos never showed the feed list, so go straight back to where we came from.
    if (feedsCtx && feedsCtx.single) return goBack();
    show('feeds');
    if (grid) grid.apply();
  }

  function playerKey(key) {
    if (panel) return panelKey(key);
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
    if (key === K.UP || key === K.DOWN) return openPanel();
    if (key === K.CH_UP) return switchFeed(-1);
    if (key === K.CH_DOWN) return switchFeed(1);
    if (key === K.STOP || key === K.BACK) return stopPlayer();
  }

  /** Switches feed and continues at the same moment of the session. */
  function switchFeed(d) {
    var n = feedsCtx.feeds.length;
    if (n < 2) return;
    if (scrub) scrubCancel();
    var i = (feedsCtx.index + d + n) % n;
    grid.r = i;
    playFeed(i, { switching: true });
  }

  // ---------- watch options panel (feeds, timing, commentary, subtitles) ----------

  function cycleValue(list, current, dir) {
    var i = list.indexOf(current);
    return list[(i + dir + list.length) % list.length];
  }

  function openPanel() {
    var box = $('panel-list');
    box.innerHTML = '';
    box.style.transform = '';
    var rows = [];
    var tracks = Player.tracks();

    function setting(label, value, cycle) {
      var e = el('div', 'panel-row setting');
      var v = el('span', 'panel-value');
      e.appendChild(el('span', 'panel-label', label));
      e.appendChild(v);
      e._refresh = function () { v.textContent = '‹ ' + value() + ' ›'; };
      e._cycle = function (dir) { cycle(dir); e._refresh(); };
      e._refresh();
      box.appendChild(e);
      rows.push([e]);
    }

    if (Timing.supported(feedsCtx.timingMeta)) {
      setting('Live timing', function () { return Settings.get('timing') ? 'On' : 'Off'; },
        function () { Settings.set('timing', !Settings.get('timing')); renderTower(); });
    }

    var audio = tracks.audio.map(function (a) { return a.lang; }).filter(Boolean);
    if (audio.length > 1) {
      setting('Commentary', function () {
        var cur = audio.indexOf(Settings.get('audio')) >= 0 ? Settings.get('audio') : audio[0];
        return LANG_NAMES[cur] || cur;
      }, function (dir) {
        var next = cycleValue(audio, Settings.get('audio'), dir);
        Settings.set('audio', next);
        Player.setAudio(next);
      });
    }

    var text = [''].concat(tracks.text.map(function (t) { return t.lang; }).filter(Boolean));
    if (text.length > 1) {
      setting('Subtitles', function () { var cur = Settings.get('subtitles'); return cur ? (LANG_NAMES[cur] || cur) : 'Off'; },
        function (dir) {
          var next = cycleValue(text, Settings.get('subtitles'), dir);
          Settings.set('subtitles', next);
          Player.setSubtitles(next);
          if (!next) showSubtitle(null);
        });
    }

    // Single-feed videos (documentaries, shows) only get the settings.
    var feeds = feedsCtx.feeds.length > 1 ? feedsCtx.feeds : [];
    if (feeds.length) box.appendChild(el('div', 'panel-head', 'Feeds'));
    var current = feeds.length ? rows.length : 0;
    feeds.forEach(function (f, i) {
      var e = el('div', 'panel-row feed-row' + (i === feedsCtx.index ? ' current' : ''));
      e.appendChild(feedNumber(f));
      var name = el('span', 'panel-label', f.title);
      if (f.full) name.appendChild(el('small', '', f.full));
      e.appendChild(name);
      e.appendChild(el('span', 'panel-value', f.type));
      e._feed = i;
      box.appendChild(e);
      if (i === feedsCtx.index) current = rows.length;
      rows.push([e]);
    });

    if (!rows.length) { showOsd(); return; } // nothing to choose for this video

    var g = new Focus.Grid(rows, {
      onSelect: function (e) {
        if (e._cycle) return e._cycle(1);
        closePanel();
        if (e._feed !== feedsCtx.index) {
          grid.r = e._feed;
          playFeed(e._feed, { switching: true });
        }
      },
      onMove: function (r, c, e) {
        var top = e.offsetTop, view = $('panel-list').parentNode.clientHeight;
        box.style.transform = 'translateY(' + (-Math.max(0, top - view / 2)) + 'px)';
      }
    });
    g.r = current;
    panel = { grid: g, timer: null };
    $('panel').classList.remove('hidden');
    $('osd').classList.add('hidden');
    g.apply();
    armPanel();
  }

  function armPanel() {
    clearTimeout(panel.timer);
    panel.timer = setTimeout(closePanel, 7000);
  }

  function closePanel() {
    if (!panel) return;
    clearTimeout(panel.timer);
    panel = null;
    $('panel').classList.add('hidden');
  }

  function panelKey(key) {
    armPanel();
    var row = panel.grid.current();
    if (key === K.BACK || key === K.STOP) return closePanel();
    if ((key === K.LEFT || key === K.RIGHT) && row && row._cycle) return row._cycle(key === K.LEFT ? -1 : 1);
    if (key === K.LEFT || key === K.RIGHT) { closePanel(); return playerKey(key); }
    panel.grid.handle(key);
  }

  // ---------- timing tower and subtitles ----------

  function timingTick() {
    if (screen !== 'player' || !Timing.isReady()) return;
    var wall = Player.wallClock(Player.position());
    if (!wall) return;
    Timing.query(wall * 1000).then(function (st) { timingState = st; renderTower(); });
  }

  function renderTower() {
    var visible = screen === 'player' && Settings.get('timing') && timingState && timingState.standings && timingState.standings.length;
    $('tower').classList.toggle('hidden', !visible);
    if (!visible) return;
    var st = timingState, race = st.type === 'Race';
    $('tower-label').textContent = Timing.label({ type: st.type, name: st.name, lap: st.lap, totalLaps: st.totalLaps,
      remaining: st.remaining, part: st.part }) || st.name;
    var flag = $('tower-flag'), t = st.track;
    flag.className = 'tower-flag ' + ({ '2': 'yellow', '4': 'sc', '5': 'red', '6': 'vsc', '7': 'vsc' }[t] || 'hidden');
    flag.textContent = { '2': 'YELLOW', '4': 'SC', '5': 'RED', '6': 'VSC', '7': 'VSC' }[t] || '';
    var rows = $('tower-rows');
    rows.innerHTML = '';
    st.standings.forEach(function (d) {
      var row = el('div', 'tower-row' + (d.out || d.knockedOut ? ' out' : ''));
      row.appendChild(el('span', 'tw-pos', d.pos));
      var bar = el('span', 'tw-bar');
      bar.style.background = d.colour;
      row.appendChild(bar);
      row.appendChild(el('span', 'tw-tla', d.tla));
      var value;
      if (d.out) value = 'OUT';
      else if (d.pit) value = 'PIT';
      else if (d.pos === 1) value = race ? 'Leader' : d.best;
      else value = race ? (d.interval || d.gap) : d.gap;
      row.appendChild(el('span', 'tw-val', value || ''));
      if (d.tyre) row.appendChild(el('span', 'tw-tyre tyre-' + d.tyre, d.tyre));
      rows.appendChild(row);
    });
  }

  function showSubtitle(s) {
    var box = $('subtitle');
    clearTimeout(subtitleTimer);
    if (!s || !s.text || !Settings.get('subtitles')) return box.classList.add('hidden');
    box.textContent = s.text;
    box.classList.remove('hidden');
    subtitleTimer = setTimeout(function () { box.classList.add('hidden'); }, Math.max(1500, s.ms));
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

  /** Uses img/logo.png in place of the text brand when a build provides one (see local/). */
  function useLogo() {
    var img = new Image();
    img.onload = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.brand'), function (b) {
        b.innerHTML = '';
        var logo = el('img', 'brand-logo');
        logo.src = 'img/logo.png';
        b.appendChild(logo);
        b.appendChild(el('span', 'brand-tv', 'TV'));
      });
    };
    img.src = 'img/logo.png';
  }

  function boot() {
    useLogo();
    Keys.register();
    document.addEventListener('keydown', onKey);
    tickClock();
    setInterval(tickClock, 15000);
    setInterval(updateOsd, 500);

    Player.on('error', function (msg) { toast(msg, 8000); $('spinner').classList.add('hidden'); });
    Player.on('buffering', function (b) { $('spinner').classList.toggle('hidden', !b); });
    Player.on('ended', function () { if (screen === 'player') stopPlayer(); });
    Player.on('subtitle', showSubtitle);
    setInterval(timingTick, 1000);
    setInterval(saveProgress, 30000);

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
