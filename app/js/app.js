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
  var scrub = null;        // { pos, n, last, dir, timer, info } while choosing a jump with the arrows
  var pending = null;      // { pos, info, since } after a jump until playback runs there
  var liveFocus = false;   // the LIVE button in the time bar is highlighted (▼ in live streams)
  var panel = null;        // { grid, timer } while the watch-options panel is open
  var timingState = null;  // latest timing state for the playing position
  var subtitleTimer = null;

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var LANG_NAMES = { eng: 'English', deu: 'Deutsch', fra: 'Français', nld: 'Nederlands', por: 'Português',
    jpn: '日本語', spa: 'Español', ita: 'Italiano', fx: 'Track sound only', tea: 'Team radio' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- helpers ----------

  function show(name) {
    ['login', 'browse', 'list', 'chart', 'feeds', 'player'].forEach(function (n) {
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

  /**
   * 'live' | 'upcoming' | 'done' for a scheduled broadcast. F1 marks a broadcast that is on air
   * as LIVE (the coverage starts before the session); the clock is only a fallback.
   */
  function status(ev) {
    if (ev.subtype === 'LIVE') return 'live';
    if (ev.subtype === 'REPLAY') return 'done';
    var now = Date.now(), end = ev.end || ev.start + 2 * 3600000;
    if (ev.subtype === 'LIVE_EVENT') return now < end ? 'upcoming' : 'done';
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
      navTabs.push({ title: 'Standings', run: function () { openStandings(); } });
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

  /** Red dot on the Home and Schedule tabs while something is on air. */
  function markLive(on) {
    Array.prototype.forEach.call($('topnav').children, function (e) {
      if (/^(Home|Schedule)$/.test(e.textContent)) e.classList.toggle('has-live', !!on);
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
      if (pg.kind === 'home') markLive(weekend && weekend.events.some(function (ev) { return status(ev) === 'live'; }));
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
      badge: m.contentSubtype === 'LIVE' ? { text: 'LIVE', cls: 'live' } : null,
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
    var badge = st === 'live' ? { text: 'LIVE', cls: 'live' }
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
    if (spec.header) inner.appendChild(spec.header);
    var rows = [];
    spec.rows.forEach(function (row) {
      if (row.day) return inner.appendChild(el('div', 'list-day', row.day));
      var compact = row.colour !== undefined || row.img !== undefined;
      var e = el('div', 'list-row' + (row.past ? ' past' : '') + (row.info ? ' info' : '') + (compact ? ' compact' : ''));
      e.appendChild(el('div', 'when', row.when || ''));
      if (row.colour !== undefined) {
        var bar = el('div', 'row-colour');
        if (row.colour) bar.style.background = row.colour;
        e.appendChild(bar);
      }
      if (row.img !== undefined) {
        var face = el('div', 'row-face');
        if (row.img) face.style.backgroundImage = 'url("' + row.img + '")';
        e.appendChild(face);
      }
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
        var y = spec.header ? top + e.offsetHeight - view + 40 : top - view / 2 + 60;
        inner.style.transform = 'translateY(' + (-Math.max(0, y)) + 'px)';
        if (spec.onFocus) spec.onFocus(e._row);
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
          badgeCls: st === 'live' ? 'live pulse' : '',
          past: st === 'done',
          run: function (idx) {
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

  // ---------- standings and driver pages ----------

  function ordinal(n) { return 'P' + n; }

  function openStandings(focus) {
    show('list');
    $('list-title').textContent = 'Standings';
    $('list-sub').textContent = 'Loading…';
    $('list-inner').innerHTML = '';
    Promise.all([Stats.driverStandings(), Stats.constructorStandings(), Stats.lastRace(), Stats.driverInfo(F1Api.state.ascendon)])
      .then(function (all) {
        var ds = all[0], cs = all[1], last = all[2], info = all[3];
        var teamColour = {};
        ds.drivers.forEach(function (d) { var i = info[d.code]; if (i && i.colour) teamColour[d.teamId] = i.colour; });
        var rows = [{
          what: 'Championship battle', sub: 'How the points built up, round by round', badge: 'Graph',
          run: function (idx) { backStack.push(function () { openStandings(idx); }); openBattle('drivers'); }
        }, { day: 'Drivers' }];
        ds.drivers.forEach(function (d) {
          var i = info[d.code] || {};
          rows.push({
            when: ordinal(d.pos), colour: i.colour || '', img: i.headshot || '',
            what: d.first + ' ' + d.last, sub: d.team + (d.wins ? ' · ' + d.wins + (d.wins === 1 ? ' win' : ' wins') : ''),
            badge: d.points + ' pts',
            run: function (idx) {
              backStack.push(function () { openStandings(idx); });
              openDriver(d, i);
            }
          });
        });
        rows.push({ day: 'Constructors' });
        cs.forEach(function (c) {
          rows.push({
            when: ordinal(c.pos), colour: teamColour[c.id] || '', what: c.name,
            sub: c.wins ? c.wins + (c.wins === 1 ? ' win' : ' wins') : '', badge: c.points + ' pts',
            run: function (idx) {
              backStack.push(function () { openStandings(idx); });
              openTeam(c, ds.drivers, info);
            }
          });
        });
        renderList({ title: 'Standings', sub: new Date().getFullYear() + ' season' + (last ? ' · after round ' + last.round + ' (' + last.name + ')' : ''), rows: rows }, focus || 0);
      })
      .catch(function (e) { $('list-sub').textContent = 'Could not load the standings: ' + e.message; });
  }

  function openTeam(team, drivers, info) {
    var rows = drivers.filter(function (d) { return d.teamId === team.id; }).map(function (d) {
      var i = info[d.code] || {};
      return { when: ordinal(d.pos), colour: i.colour || '', img: i.headshot || '', what: d.first + ' ' + d.last,
        sub: d.wins ? d.wins + ' wins' : '', badge: d.points + ' pts',
        run: function (idx) { backStack.push(function () { openTeam(team, drivers, info); }); openDriver(d, i); } };
    });
    renderList({ title: team.name, sub: ordinal(team.pos) + ' in the constructors\' championship · ' + team.points + ' pts', rows: rows }, 0);
  }

  function svgEl(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  /**
   * Points per round as thin bars in the team colour (race + sprint), rounded tops on a recessive
   * baseline, the best round labelled. Returns { node, highlight(round) }.
   */
  function pointsChart(races, colour) {
    var W = 1640, H = 230, top = 34, base = 196, gap = 4;
    var max = Math.max(25, Math.max.apply(null, races.map(function (r) { return r.points + (r.sprint ? r.sprint.points : 0); })));
    var n = Math.max(races.length, 1), slot = W / n, bw = Math.min(56, slot - gap);
    var svg = svgEl('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'class': 'points-chart' });
    svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, 'class': 'axis' }));
    var bars = {}, best = null;
    races.forEach(function (r, i) {
      var pts = r.points + (r.sprint ? r.sprint.points : 0);
      if (!best || pts > best.pts) best = { pts: pts, i: i };
      var h = Math.round((base - top) * pts / max), x = Math.round(i * slot + (slot - bw) / 2);
      if (h > 0) {
        var rad = Math.min(4, h, bw / 2), y = base - h;
        var d = 'M' + x + ',' + base + 'V' + (y + rad) + 'Q' + x + ',' + y + ' ' + (x + rad) + ',' + y +
          'H' + (x + bw - rad) + 'Q' + (x + bw) + ',' + y + ' ' + (x + bw) + ',' + (y + rad) + 'V' + base + 'Z';
        var bar = svgEl('path', { d: d, fill: colour || '#9aa0aa', 'class': 'bar' });
        svg.appendChild(bar);
        bars[r.round] = bar;
      } else {
        bars[r.round] = svg.appendChild(svgEl('rect', { x: x, y: base - 2, width: bw, height: 2, 'class': 'bar zero' }));
      }
      var lbl = svgEl('text', { x: x + bw / 2, y: H - 8, 'class': 'tick' });
      lbl.textContent = r.round;
      svg.appendChild(lbl);
    });
    if (best && best.pts > 0) {
      var bx = Math.round(best.i * slot + slot / 2), by = base - Math.round((base - top) * best.pts / max) - 10;
      var v = svgEl('text', { x: bx, y: by, 'class': 'value' });
      v.textContent = best.pts;
      svg.appendChild(v);
    }
    return {
      node: svg,
      highlight: function (round) {
        Object.keys(bars).forEach(function (k) { bars[k].setAttribute('class', bars[k].getAttribute('class').replace(/ dim/g, '') + (round && +k !== round ? ' dim' : '')); });
      }
    };
  }

  // ---------- championship battle graph ----------

  var battle = null;   // { data, info, ds, cs, mode: 'drivers' | 'teams', idx }

  function openBattle(mode) {
    show('chart');
    grid = null;
    $('chart-sub').textContent = 'Loading…';
    $('chart-plot').innerHTML = '';
    $('chart-legend').innerHTML = '';
    $('chart-readout').innerHTML = '';
    Promise.all([Stats.seasonProgress(), Stats.driverInfo(F1Api.state.ascendon), Stats.driverStandings(), Stats.constructorStandings()])
      .then(function (all) {
        battle = { data: all[0], info: all[1], ds: all[2], cs: all[3], mode: mode, idx: all[0].rounds.length - 1 };
        drawBattle();
      })
      .catch(function (e) { $('chart-sub').textContent = 'Could not load the season: ' + e.message; });
  }

  // Short labels for the chart's line ends and readout (jolpica constructor ids).
  var TEAM_CODES = { mercedes: 'MER', ferrari: 'FER', mclaren: 'MCL', red_bull: 'RBR', rb: 'RB', alpine: 'ALP', haas: 'HAA',
    williams: 'WIL', aston_martin: 'AMR', sauber: 'SAU', audi: 'AUD', cadillac: 'CAD' };

  /** The plotted series: top 6 drivers or teams, cumulative points per round, in team colours. */
  function battleSeries() {
    var b = battle, rounds = b.data.rounds, teamColour = {}, teamName = {};
    b.ds.drivers.forEach(function (d) {
      var i = b.info[d.code];
      if (i && i.colour && !teamColour[d.teamId]) teamColour[d.teamId] = i.colour;
      if (i && i.team && !teamName[d.teamId]) teamName[d.teamId] = i.team;   // F1's own name, e.g. "Racing Bulls"
    });
    function cumulative(perRound) {
      var sum = 0;
      return rounds.map(function (r) { sum += perRound[r.round] || 0; return sum; });
    }
    if (b.mode === 'teams') {
      return assignDashes(b.cs.slice(0, 6).map(function (c) {
        var src = b.data.teams[c.id] || { perRound: {} };
        var name = teamName[c.id] || c.name.replace(/ F1 Team$/, '');
        return { label: TEAM_CODES[c.id] || name.slice(0, 3).toUpperCase(), name: name, colour: teamColour[c.id] || '#9aa0aa',
          values: cumulative(src.perRound) };
      }));
    }
    return assignDashes(b.ds.drivers.slice(0, 6).map(function (d) {
      var src = b.data.drivers[d.id] || { perRound: {} };
      return { label: d.code, name: d.first + ' ' + d.last, colour: (b.info[d.code] || {}).colour || teamColour[d.teamId] || '#9aa0aa',
        values: cumulative(src.perRound) };
    }));
  }

  /** OKLab distance (x100) between two #rrggbb colours; below ~12 two lines read as the same colour. */
  function colourDistance(a, b) {
    function lab(hex) {
      var n = parseInt(hex.slice(1), 16);
      var c = [n >> 16, (n >> 8) & 255, n & 255].map(function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      var l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
      var m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
      var q = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
      return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q];
    }
    var x = lab(a), y = lab(b);
    return 100 * Math.sqrt(Math.pow(x[0] - y[0], 2) + Math.pow(x[1] - y[1], 2) + Math.pow(x[2] - y[2], 2));
  }

  /**
   * Lines that share (nearly) a colour - teammates, or look-alike team colours such as the blues of
   * Red Bull, Racing Bulls and Alpine - get different styles: dash 0 solid, 1 dashed, 2 dotted.
   */
  function assignDashes(series) {
    series.forEach(function (s, i) {
      var used = {};
      for (var j = 0; j < i; j++) if (colourDistance(s.colour, series[j].colour) < 12) used[series[j].dash] = true;
      s.dash = 0;
      while (used[s.dash] && s.dash < 2) s.dash++;
    });
    return series;
  }

  function niceStep(max) {
    var steps = [25, 50, 100, 200, 250, 500];
    for (var i = 0; i < steps.length; i++) if (max / steps[i] <= 7) return steps[i];
    return 1000;
  }

  function drawBattle() {
    var b = battle, rounds = b.data.rounds, series = battleSeries();
    var W = 1400, H = 640, L = 70, R = 90, T = 16, B = 44;
    var max = Math.max.apply(null, series.map(function (s) { return s.values[s.values.length - 1] || 0; }).concat([10]));
    var step = niceStep(max), top = Math.ceil(max / step) * step;
    var n = rounds.length;
    var x = function (i) { return L + (n > 1 ? i * (W - L - R) / (n - 1) : 0); };
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };

    $('chart-title').textContent = 'Championship battle';
    $('chart-sub').textContent = (b.mode === 'teams' ? 'Top 6 constructors' : 'Top 6 drivers') + ' · points after each round, sprints included';

    var svg = svgEl('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'class': 'battle-chart' });
    for (var v = 0; v <= top; v += step) {
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: Math.round(y(v)) + 0.5, y2: Math.round(y(v)) + 0.5, 'class': v ? 'grid' : 'axis' }));
      var t = svgEl('text', { x: L - 14, y: y(v) + 6, 'class': 'ytick' });
      t.textContent = v;
      svg.appendChild(t);
    }
    rounds.forEach(function (r, i) {
      var t = svgEl('text', { x: x(i), y: H - 12, 'class': 'xtick' });
      t.textContent = r.round;
      svg.appendChild(t);
    });
    // crosshair behind the lines
    svg.appendChild(svgEl('line', { x1: x(b.idx), x2: x(b.idx), y1: T, y2: H - B, 'class': 'crosshair' }));
    series.forEach(function (s) {
      var d = s.values.map(function (val, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(val).toFixed(1); }).join('');
      var attrs = { d: d, stroke: s.colour, 'class': 'line' };
      if (s.dash) attrs['stroke-dasharray'] = s.dash === 1 ? '10 7' : '0.1 8';
      svg.appendChild(svgEl('path', attrs));
    });
    // markers at the selected round, with a surface ring so overlaps stay readable
    series.forEach(function (s) {
      svg.appendChild(svgEl('circle', { cx: x(b.idx), cy: y(s.values[b.idx] || 0), r: 7, fill: s.colour, 'class': 'marker' }));
    });
    // direct labels at the line ends, nudged apart so they never collide
    var ends = series.map(function (s) { return { s: s, y: y(s.values[n - 1] || 0) }; }).sort(function (a, c) { return a.y - c.y; });
    for (var k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 26) ends[k].y = ends[k - 1].y + 26;
    ends.forEach(function (e) {
      var lbl = svgEl('text', { x: W - R + 14, y: e.y + 7, 'class': 'endlabel' });
      lbl.textContent = e.s.label;
      svg.appendChild(lbl);
    });
    $('chart-plot').innerHTML = '';
    $('chart-plot').appendChild(svg);

    // legend: swatch (in the line's dash style) + name
    var legend = $('chart-legend');
    legend.innerHTML = '';
    series.forEach(function (s) {
      var item = el('span', 'legend-item');
      var sw = svgEl('svg', { width: 34, height: 12 });
      var ln = svgEl('line', { x1: 2, x2: 32, y1: 6, y2: 6, stroke: s.colour, 'stroke-width': 4, 'stroke-linecap': 'round' });
      if (s.dash) ln.setAttribute('stroke-dasharray', s.dash === 1 ? '7 5' : '0.1 7');
      sw.appendChild(ln);
      item.appendChild(sw);
      item.appendChild(document.createTextNode(s.name));
      legend.appendChild(item);
    });

    // readout for the selected round (the TV's stand-in for a hover tooltip)
    var r = rounds[b.idx], out = $('chart-readout');
    out.innerHTML = '';
    out.appendChild(el('div', 'readout-round', 'Round ' + r.round));
    out.appendChild(el('div', 'readout-name', r.name));
    series.slice().sort(function (a, c) { return (c.values[b.idx] || 0) - (a.values[b.idx] || 0); }).forEach(function (s, i) {
      var row = el('div', 'readout-row');
      var sw = el('span', 'readout-swatch' + ['', ' dashed', ' dotted'][s.dash]);
      sw.style.borderColor = s.colour;
      row.appendChild(el('span', 'readout-pos', i + 1));
      row.appendChild(sw);
      row.appendChild(el('span', 'readout-label', s.label));
      row.appendChild(el('span', 'readout-pts', s.values[b.idx] || 0));
      var gain = (s.values[b.idx] || 0) - (b.idx ? s.values[b.idx - 1] || 0 : 0);
      row.appendChild(el('span', 'readout-gain', gain ? '+' + gain : '–'));
      out.appendChild(row);
    });
  }

  function chartKey(key) {
    if (!battle) return key === K.BACK ? goBack() : null;
    var n = battle.data.rounds.length;
    if (key === K.LEFT && battle.idx > 0) { battle.idx--; return drawBattle(); }
    if (key === K.RIGHT && battle.idx < n - 1) { battle.idx++; return drawBattle(); }
    if (key === K.UP || key === K.DOWN) { battle.mode = battle.mode === 'teams' ? 'drivers' : 'teams'; return drawBattle(); }
    if (key === K.BACK) return goBack();
  }

  function statTile(value, label) {
    var t = el('div', 'stat-tile');
    t.appendChild(el('div', 'stat-value', value));
    t.appendChild(el('div', 'stat-label', label));
    return t;
  }

  function openDriver(d, info) {
    info = info || {};
    show('list');
    $('list-title').textContent = d.first + ' ' + d.last;
    $('list-sub').textContent = 'Loading the season…';
    $('list-inner').innerHTML = '';
    Stats.driverSeason(d.id).then(function (races) {
      var sum = Stats.summary(races);
      var card = el('div', 'driver-card');
      var face = el('div', 'driver-face');
      if (info.headshot) face.style.backgroundImage = 'url("' + info.headshot + '")';
      card.appendChild(face);
      var numberEl = el('div', 'driver-number', d.number || d.code);
      if (info.colour) numberEl.style.color = info.colour;
      card.appendChild(numberEl);
      var tiles = el('div', 'stat-tiles');
      tiles.appendChild(statTile(ordinal(d.pos), d.points + ' pts'));
      tiles.appendChild(statTile(sum.wins, sum.wins === 1 ? 'Win' : 'Wins'));
      tiles.appendChild(statTile(sum.podiums, 'Podiums'));
      tiles.appendChild(statTile(sum.poles, 'Poles'));
      tiles.appendChild(statTile(sum.fastestLaps, 'Fastest laps'));
      tiles.appendChild(statTile(sum.best ? ordinal(sum.best) : '–', 'Best finish'));
      tiles.appendChild(statTile(sum.avg ? sum.avg.toFixed(1) : '–', 'Avg finish'));
      tiles.appendChild(statTile(sum.dnfs, 'DNFs'));
      card.appendChild(tiles);
      var header = el('div', 'driver-header');
      header.appendChild(card);
      header.appendChild(el('div', 'chart-title', 'Points per round'));
      var chart = pointsChart(races, info.colour);
      header.appendChild(chart.node);

      var rows = [{ day: 'Races' }];
      races.slice().reverse().forEach(function (r) {
        var bits = [];
        if (r.grid) bits.push('from ' + ordinal(r.grid));
        if (r.quali === 1) bits.push('pole');
        if (r.fastest) bits.push('fastest lap');
        if (r.sprint) bits.push('sprint ' + (r.sprint.pos ? ordinal(r.sprint.pos) : 'DNF') + (r.sprint.points ? ' (+' + r.sprint.points + ')' : ''));
        var pts = r.points + (r.sprint ? r.sprint.points : 0);
        rows.push({
          when: 'R' + r.round, what: r.name + '  ·  ' + (r.pos ? ordinal(r.pos) : (r.posText === 'D' ? 'DSQ' : 'DNF')),
          sub: bits.join(' · ') + (r.pos ? '' : (bits.length ? ' · ' : '') + r.status),
          badge: pts ? '+' + pts + ' pts' : '0 pts', badgeCls: r.pos === 1 ? 'live' : '',
          round: r.round, run: function () {}
        });
      });
      renderList({
        title: d.first + ' ' + d.last,
        sub: d.team + ' · #' + (d.number || '') + ' · ' + (d.nationality || ''),
        header: header, rows: rows,
        onFocus: function (row) { chart.highlight(row && row.round); }
      }, 0);
      chart.highlight(races.length ? races[races.length - 1].round : null);
    }).catch(function (e) { $('list-sub').textContent = 'Could not load the season: ' + e.message; });
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
        live: ev ? status(ev) !== 'done' : (m.contentSubtype === 'LIVE' || !!(tile.badge && tile.badge.text === 'LIVE')),
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
  var loadingFeed = false;   // a playFeed load is running
  var queuedFeed = null;     // the latest request made meanwhile: [i, opts]

  /** Runs playFeed requests one at a time (rapid reloads crash Samsung's player); latest wins. */
  function playFeed(i, opts) {
    if (loadingFeed) { queuedFeed = [i, opts]; return; }
    loadingFeed = true;
    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      loadingFeed = false;
      if (queuedFeed) { var q = queuedFeed; queuedFeed = null; playFeed(q[0], q[1]); }
    }
    loadFeed(i, opts).then(done, done);
  }

  function loadFeed(i, opts) {
    opts = opts || {};
    var f = feedsCtx.feeds[i];
    var playing = screen === 'player' && Player.engineName();
    var from = opts.switching && playing ? { wall: Player.wallClock(Player.position()), at: Date.now() } : null;
    feedsCtx.index = i;
    return ensureSession().then(function (ok) {
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
          // Superseded by a newer request, or the viewer left the player while it loaded.
          if (feedsCtx.index !== i || queuedFeed || screen !== 'player') return;
          var start = startPosition(stream.info, opts, from);
          // Live (dynamic) streams on AVPlay can't seek at start-up; instead the local service
          // time-shifts the manifest so the player's own live edge lies at the chosen moment
          // (it starts `delay` before its edge, hence the extra info.delay).
          var info = stream.info;
          if (start != null && info && info.dynamic && info.epochAtZero > 1e9 && stream.licenseUrl) {
            var shift = Date.now() / 1000 - (info.epochAtZero + start) - info.delay;
            if (shift > 5) stream.startDelay = shift;
            start = null;
          }
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
          if (stream && Player.stream() === stream && !opts.retry) watchStart(stream);
        })
        .catch(function (e) {
          $('spinner').classList.add('hidden');
          if (e && e.message === 'cancelled') return;
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
      toast('The video didn\'t start — trying again…', 3000);
      // Through playFeed so it queues behind any other load instead of racing it.
      var wall = Player.wallClock(from);
      playFeed(feedsCtx.index, Player.isLive() ? (wall ? { liveAt: wall, retry: true } : { retry: true })
        : { startAt: from || null, retry: true });
    }, 15000);
  }

  // Seconds a feed switch takes; the new feed starts this far ahead so it lines up. Learned per switch.
  var switchLead = 3;

  function startPosition(info, opts, from) {
    if (opts.startAt != null) return opts.startAt;
    if (opts.liveAt) {
      var at = Player.positionAt(opts.liveAt, info);
      if (at != null) return at;
    }
    if (from && from.wall) {
      var wall = from.wall + (Date.now() - from.at) / 1000 + switchLead;
      var p = Player.positionAt(wall, info);
      if (p != null && p >= info.windowStart && p <= info.windowEnd) return p;
    }
    // A little after the window start: the player's own DVR window begins a few seconds later.
    if (opts.fromStart && info && info.dynamic) return info.windowStart + 15;
    return null;
  }

  function showOsd() {
    $('osd').classList.remove('hidden');
    $('screen-player').classList.add('osd-visible');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () {
      if (scrub || pending || liveFocus) return showOsd();
      $('osd').classList.add('hidden');
      $('screen-player').classList.remove('osd-visible');
    }, 4000);
  }

  // The live player itself runs ~25-50 s behind real time; within this margin counts as live.
  var LIVE_MARGIN = 60;

  /** Label for a position: offset or behind-live time, plus the real clock time when known. */
  function posLabel(pos, r, live) {
    var wall = Player.wallClock(pos);
    var main;
    if (live) main = r.end - pos < LIVE_MARGIN ? 'LIVE' : '−' + fmtTime(r.end - pos);
    else main = fmtTime(pos - r.start);
    return { main: main, clock: wall ? hhmmss(wall * 1000) : '' };
  }

  function updateOsd() {
    if (screen !== 'player') return;
    var pos = Player.position();
    var r = Player.range();
    // While a stream (re)loads it has no position yet.
    if (loadingFeed || (Player.isLive() && pos < r.start - 3600)) {
      $('osd-pos').textContent = 'Loading…';
      $('osd-dur').textContent = '';
      $('osd-live').classList.add('hidden');
      return;
    }
    var live = Player.isLive();
    var span = Math.max(1, r.end - r.start);
    var pct = function (p) { return Math.max(0, Math.min(100, 100 * (p - r.start) / span)) + '%'; };
    $('osd-progress').style.width = pct(pos);
    $('osd-buffer').style.width = pct(Player.bufferedEnd());
    var behind = live && r.end - pos >= LIVE_MARGIN;
    $('osd-live').classList.toggle('hidden', !live);
    $('osd-live').classList.toggle('behind', behind);
    $('osd-live').classList.toggle('focused', liveFocus);
    $('osd-live').textContent = behind ? 'GO LIVE ▶▶' : 'LIVE';
    var cur = posLabel(pos, r, live);
    $('osd-pos').textContent = cur.clock ? cur.clock + (live ? '' : '  ·  ' + cur.main) : cur.main;
    $('osd-dur').textContent = live ? (behind ? cur.main + ' behind live' : '') : fmtTime(span);

    var f = feedsCtx && feedsCtx.feeds[feedsCtx.index];
    var info = Timing.label(timingState);
    $('osd-feed').textContent = (f ? f.title : '') + (info ? '  ·  ' + info : '');

    var marker = $('osd-marker'), bubble = $('osd-bubble');
    var shown = scrub || pending;
    if (shown) {
      var lbl = posLabel(shown.pos, r, live);
      marker.style.left = pct(shown.pos);
      bubble.style.left = pct(shown.pos);
      bubble.innerHTML = '';
      if (shown.info) bubble.appendChild(el('div', 'bubble-info', shown.info));
      bubble.appendChild(document.createTextNode(lbl.main));
      if (lbl.clock) bubble.appendChild(el('small', '', lbl.clock));
      marker.classList.remove('hidden');
      bubble.classList.remove('hidden');
      $('osd-hint').textContent = scrub ? 'OK to jump · BACK to cancel' : 'Jumping…';
    } else {
      marker.classList.add('hidden');
      bubble.classList.add('hidden');
      $('osd-hint').textContent = liveFocus ? 'OK = go live · ▲ back'
        : '◀ ▶ seek · OK pause · ▲ feeds & options' + (live ? ' · ▼ LIVE button' : '') + ' · BACK exit';
    }
  }

  // Seek steps grow while the arrow is held / pressed quickly, like on YouTube or NRK TV.
  var SCRUB_STEPS = [10, 10, 15, 30, 30, 60, 60, 120];

  function scrubMove(dir, big) {
    var now = Date.now();
    if (!scrub) scrub = { pos: pending ? pending.pos : Player.position(), n: -1, last: 0, dir: dir };
    // Steps grow while pressing quickly in one direction; turning around starts small again.
    if (scrub.dir !== dir) scrub.n = -1;
    scrub.dir = dir;
    scrub.n = now - scrub.last < 600 ? Math.min(scrub.n + 1, SCRUB_STEPS.length - 1) : 0;
    scrub.last = now;
    var r = Player.range();
    scrub.pos = Math.max(r.start, Math.min(r.end - 1, scrub.pos + dir * (big ? 60 : SCRUB_STEPS[scrub.n])));
    clearTimeout(scrub.timer);
    // Jump after the presses stop; quick presses keep adding up. Live jumps reopen the stream,
    // so they wait longer (OK jumps right away).
    scrub.timer = setTimeout(scrubCommit, Player.isLive() && Player.engineName() === 'avplay' ? 1500 : 800);
    var wall = Player.wallClock(scrub.pos), target = scrub.pos, s = scrub;
    if (wall) Timing.query(wall * 1000).then(function (st) {
      if (scrub === s && s.pos === target) { s.info = Timing.label(st); updateOsd(); }
    });
    showOsd();
    updateOsd();
  }

  /**
   * Commits the previewed jump. The destination stays on screen until the video actually plays
   * there; the spinner only appears if that takes longer than a moment.
   */
  function scrubCommit() {
    if (!scrub) return;
    var p = scrub.pos;
    // Live streams on Samsung's player don't seek reliably: reopen them instead, at live or
    // time-shifted to the chosen moment (see playFeed / the service's time-shift).
    if (Player.isLive() && Player.engineName() === 'avplay') {
      clearTimeout(scrub.timer);
      scrub = null;
      var toLive = Player.range().end - p < LIVE_MARGIN;
      if (toLive && behindLive() < LIVE_MARGIN) return updateOsd(); // already live: nothing to do
      return goLive(toLive ? null : Player.wallClock(p));
    }
    clearTimeout(scrub.timer);
    pending = { pos: p, info: scrub.info, since: Date.now() };
    scrub = null;
    var mine = pending;
    setTimeout(function () { if (pending === mine) $('spinner').classList.remove('hidden'); }, 450);
    Player.seekTo(p);
    showOsd();
    updateOsd();
  }

  /** Reopens the current live feed at live, or (wall = unix seconds) time-shifted to that moment. */
  function goLive(wall) {
    closePanel();
    playFeed(feedsCtx.index, wall ? { liveAt: wall } : {});
  }

  function behindLive() {
    if (!Player.isLive()) return 0;
    return Math.max(0, Player.range().end - Player.position());
  }

  /** Clears the pending jump once playback runs near its destination (or gives up after 10 s). */
  function checkPending() {
    if (!pending) return;
    var pos = Player.position();
    var arrived = Math.abs(pos - pending.pos) < 4 && Date.now() - pending.since > 150 &&
      pending.lastPos != null && pos > pending.lastPos;
    pending.lastPos = pos;
    if (arrived || Date.now() - pending.since > 10000) {
      pending = null;
      $('spinner').classList.add('hidden');
      updateOsd();
    }
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
    liveFocus = false;
    saveProgress();
    if (scrub) scrubCancel();
    pending = null;
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

  function hideOsd() {
    clearTimeout(osdTimer);
    $('osd').classList.add('hidden');
    $('screen-player').classList.remove('osd-visible');
  }

  function playerKey(key) {
    if (panel) return panelKey(key);
    // While a stream (re)loads it has no position yet: seeking now would start from 0.
    if (loadingFeed && (key === K.LEFT || key === K.RIGHT || key === K.RW || key === K.FF)) {
      return toast('Loading…', 1200);
    }
    // BACK first closes whatever is open (preview, LIVE focus, the bar); only then the video.
    var barVisible = !$('osd').classList.contains('hidden');
    if (key === K.BACK && !scrub && !liveFocus && barVisible) return hideOsd();
    showOsd();
    if (liveFocus) {
      liveFocus = false;
      if (key === K.ENTER) {
        if (behindLive() > LIVE_MARGIN) return goLive(null);
        if (Player.isPaused()) Player.togglePause();
        updateOsd();
        return toast('You\'re watching live.', 2000);
      }
      updateOsd();
      if (key === K.BACK) return hideOsd();
      if (key === K.UP || key === K.DOWN) return;
    }
    if (scrub) {
      if (key === K.ENTER) return scrubCommit();
      if (key === K.BACK) { scrubCancel(); return hideOsd(); }
    }
    if (key === K.LEFT) return scrubMove(-1);
    if (key === K.RIGHT) return scrubMove(1);
    if (key === K.RW) return scrubMove(-1, true);
    if (key === K.FF) return scrubMove(1, true);
    if (key === K.ENTER || key === K.PLAY_PAUSE || key === K.PLAY || key === K.PAUSE) return Player.togglePause();
    if (key === K.DOWN && Player.isLive()) { liveFocus = true; return updateOsd(); }
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

    if (behindLive() > LIVE_MARGIN) {
      var go = el('div', 'panel-row setting go-live');
      go.appendChild(el('span', 'panel-label', 'Go to live'));
      go.appendChild(el('span', 'panel-value', '−' + fmtTime(behindLive())));
      go._action = function () { goLive(null); };
      box.appendChild(go);
      rows.push([go]);
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
        if (e._action) return e._action();
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
    $('screen-player').classList.remove('osd-visible');
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
    if (screen === 'chart') { e.preventDefault(); return chartKey(key); }
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
    // During a jump the pending-seek logic owns the spinner (it waits a moment before showing it).
    Player.on('buffering', function (b) { if (!pending) $('spinner').classList.toggle('hidden', !b); });
    setInterval(checkPending, 100);
    Player.on('ended', function () { if (screen === 'player') stopPlayer(); });
    Player.on('subtitle', showSubtitle);
    setInterval(timingTick, 1000);
    setInterval(saveProgress, 30000);
    // Refresh the home page now and then so live / upcoming badges stay current.
    setInterval(function () {
      if (screen === 'browse' && currentPage && currentPage.kind === 'home' && grid && !dialog) {
        renderPage(currentPage, { r: grid.r, c: grid.c.slice() });
      }
    }, 120000);

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
