const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

/*
 * Boots the whole app (app.js with the real api.js parsing, timing.js, focus.js, keys.js, settings.js
 * and upnext.js) on a small fake DOM with fake timers, and drives it with remote keys. The network,
 * sign-in, statistics and the video player are stubs the tests control.
 */

// ---------- a small DOM: what app.js uses ----------

// The classes index.html starts each element with ("spinner hidden", "dialog hidden", ...).
const INITIAL_CLASS = {};
for (const m of readFileSync('app/index.html', 'utf8').matchAll(/<\w+\b([^>]*)>/g)) {
  const id = /\sid="([^"]+)"/.exec(m[1]), cls = /\sclass="([^"]*)"/.exec(m[1]);
  if (id) INITIAL_CLASS[id[1]] = cls ? cls[1] : '';
}

function makeDom() {
  const byId = {};
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.parentNode = null; this.style = { setProperty(k, v) { this[k] = String(v); } }; this.className = ''; this.ownText = '';
      this.attrs = {}; this.html = ''; this.listeners = {};
      this.offsetTop = 0; this.offsetHeight = 0; this.offsetWidth = 0; this.clientHeight = 1000;
      this.scrollHeight = 0; this.scrollTop = 0;
    }
    get classList() {
      const e = this, list = () => e.className.split(/\s+/).filter(Boolean);
      return {
        contains: (c) => list().includes(c),
        add: (...cs) => { e.className = [...new Set(list().concat(cs))].join(' '); },
        remove: (...cs) => { e.className = list().filter((x) => !cs.includes(x)).join(' '); },
        toggle: (c, force) => {
          const on = force === undefined ? !list().includes(c) : !!force;
          if (on) e.classList.add(c); else e.classList.remove(c);
          return on;
        }
      };
    }
    get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) {
      this.children.forEach((c) => { c.parentNode = null; });
      this.children = [];
      this.ownText = v == null ? '' : String(v);
      this.html = '';
    }
    get innerHTML() { return this.html; }
    set innerHTML(v) { this.textContent = ''; this.html = String(v); }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = v; byId[v] = this; }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.children.push(c);
      return c;
    }
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    }
    get nextSibling() {
      const p = this.parentNode;
      return p ? p.children[p.children.indexOf(this) + 1] || null : null;
    }
    setAttribute(k, v) { if (k === 'class') this.className = String(v); else this.attrs[k] = String(v); }
    getAttribute(k) { return k === 'class' ? this.className : (k in this.attrs ? this.attrs[k] : null); }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const l = this.listeners[t] || []; if (l.includes(fn)) l.splice(l.indexOf(fn), 1); }
    cloneNode() { return new El(this.tagName); }
    descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
    querySelectorAll(sel) { const c = sel.replace(/^\./, ''); return this.descendants().filter((e) => e.classList.contains(c)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  const body = new El('body');
  const listeners = {};
  const document = {
    body,
    getElementById: (id) => {
      if (!byId[id]) { const e = new El('div'); e.id = id; e.className = INITIAL_CLASS[id] || ''; body.appendChild(e); }
      return byId[id];
    },
    createElement: (t) => new El(t),
    createElementNS: (ns, t) => new El(t),
    createTextNode: (t) => { const e = new El('#text'); e.ownText = String(t); return e; },
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    listeners
  };
  return { document, El };
}

// ---------- fake timers and clock ----------

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };

function makeClock(start) {
  let now = start, seq = 0;
  const timers = [];
  const add = (fn, ms, every) => {
    const t = { id: ++seq, fn, at: now + Math.max(0, +ms || 0), every: every ? Math.max(1, +ms || 1) : 0 };
    timers.push(t);
    return t.id;
  };
  const clear = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  /** Runs every timer due within ms, in order, letting promises settle between them. */
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await settle();
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      if (due.every) due.at += due.every; else clear(due.id);
      due.fn();
    }
    now = end;
    await settle();
  }
  return { setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: clear,
    setInterval: (fn, ms) => add(fn, ms, true), clearInterval: clear, Date: FakeDate, advance, now: () => now };
}

/** A promise the test resolves or rejects later. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// ---------- F1 TV data ----------

const NOW = Date.parse('2026-10-28T20:00:00Z');
const RACE_START = Date.parse('2025-12-07T13:00:00Z') / 1000;

const tileItem = (id, title, subtype, extra) => ({
  metadata: Object.assign({ contentId: id, contentType: 'VIDEO', title, titleBrief: title, contentSubtype: subtype || 'REPLAY', pictureUrl: 'art-' + id,
    emfAttributes: { Meeting_Name: 'Abu Dhabi Grand Prix' } }, extra),
  actions: [{ uri: '/2.0/R/ENG/WEB_DASH/ALL/CONTENT/VIDEO/' + id }]
});
const pageItem = (title, uri) => ({ metadata: { title, contentType: 'BUNDLE' }, actions: [{ uri }] });
const rail = (label, items) => ({ layout: 'horizontal_thumbnail', metadata: { label }, retrieveItems: { resultObj: { containers: items } } });

const meetingItem2 = (key, name, country, uri, start, end, round) => ({ metadata: { title: name, emfAttributes: { MeetingKey: key,
  Meeting_Name: name, Meeting_Country_Name: country, Meeting_Start_Date: start, Meeting_End_Date: end, Championship_Meeting_Ordinal: round } },
  actions: [{ uri }] });
const liveEvent = (id, title, house, start) => ({ id, metadata: { contentId: id, titleBrief: title, contentSubtype: 'LIVE', externalId: house,
  emfAttributes: { Series: 'FORMULA 1', sessionStartDate: String(start * 1000), sessionEndDate: String((start + 7200) * 1000),
    Meeting_Name: 'United States Grand Prix', MeetingKey: '1297' } } });
const meetingItem = (key, name, uri) => ({ metadata: { title: name, emfAttributes: { MeetingKey: key, Meeting_Name: name,
  Meeting_Start_Date: '2025-12-05T00:00:00Z', Meeting_End_Date: '2025-12-07T23:59:59Z' } }, actions: [{ uri }] });
const event = (id, title, house, start) => ({ id, metadata: { contentId: id, titleBrief: title, contentSubtype: 'REPLAY', externalId: house,
  emfAttributes: { Series: 'FORMULA 1', sessionStartDate: String(start * 1000), Meeting_Name: 'Abu Dhabi Grand Prix', MeetingKey: '1252' } } });
const PAGES = {
  '/home': [rail('Latest', [tileItem(101, 'Race'), tileItem(103, 'Qualifying'), tileItem(102, ' McLaren', 'SHOW'),
    tileItem(104, 'Pre-Race Show'), tileItem(106, 'Practice 1', 'LIVE')])],
  '/archive': [rail('Seasons', [pageItem('2025 Season', '/PAGE/2025')])],
  '/season': [rail('Season', [
    meetingItem2('1297', 'United States Grand Prix', 'United States', '/PAGE/1297', '2026-10-23T00:00:00Z', '2026-10-25T23:59:59Z', '19'),
    meetingItem2('1300', 'Mexico City Grand Prix', 'Mexico', '/PAGE/1300', '2026-10-30T00:00:00Z', '2026-11-01T23:59:59Z', '20')])],
  // The US weekend: its race was LIVE when the list was fetched (the list has stayed open since).
  '/PAGE/1297': [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{ eventName: 'ALL', events: [
    liveEvent(105, 'Race', 'FOM_SESSION_11396', Date.parse('2026-10-25T19:00:00Z') / 1000)] }] } } }],
  '/PAGE/2025': [rail('Meetings', [meetingItem('1252', 'Abu Dhabi Grand Prix', '/PAGE/1252')])],
  '/PAGE/1252': [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{ eventName: 'ALL', events: [
    event(104, 'Pre-Race Show', 'FOM_SESSION_9839001', RACE_START - 3600), event(101, 'Race', 'FOM_SESSION_9839', RACE_START - 300)] }] } } }]
};

const session = (key, title, start) => ({ Series: 'FORMULA 1', MeetingKey: '1252', MeetingSessionKey: key, Meeting_Name: 'Abu Dhabi Grand Prix',
  sessionStartDate: String(start * 1000), sessionEndTime: '2025-12-07T19:00:00+04:00' });
const feeds = [
  { title: 'F1 LIVE', identifier: 'PRES', type: 'additional', channelId: 1033, playbackUrl: 'CONTENT/PLAY?channelId=1033&contentId=101' },
  { title: 'INTERNATIONAL', identifier: 'WIF', type: 'additional', channelId: 1025, playbackUrl: 'CONTENT/PLAY?contentId=101' },
  { title: 'VER', identifier: 'OBC', type: 'obc', channelId: 1009, racingNumber: 1, teamName: 'Red Bull Racing', hex: '#3671C6',
    driverFirstName: 'Max', driverLastName: 'Verstappen', playbackUrl: 'CONTENT/PLAY?channelId=1009&contentId=101' }
];

const VIDEOS = {
  101: { contentId: 101, title: '2025 Abu Dhabi Grand Prix', titleBrief: 'Race', contentSubtype: 'REPLAY', year: '2025', duration: 7500,
    uiDuration: '02:05:00', emfAttributes: session('9662', 'Race', RACE_START), additionalStreams: feeds },
  103: { contentId: 103, title: '2025 Abu Dhabi GP - Qualifying', titleBrief: 'Qualifying', contentSubtype: 'REPLAY', year: '2025',
    duration: 4600, emfAttributes: session('9658', 'Qualifying', RACE_START - 86400), additionalStreams: feeds },
  // An archived pre-race show, whose next part is the race.
  104: { contentId: 104, title: 'Pre-Race Show - Abu Dhabi', titleBrief: 'Pre-Race Show', contentSubtype: 'REPLAY', year: '2025',
    duration: 3600, externalId: 'FOM_SESSION_9839001', emfAttributes: Object.assign(session('9661', 'Pre-Race Show', RACE_START - 3600),
      { multipartEvent: 'true', multipartEventNextHouseId: 'FOM_SESSION_9839' }) },
  // The US race, a replay by now.
  105: { contentId: 105, title: '2026 United States Grand Prix', titleBrief: 'Race', contentSubtype: 'REPLAY', year: '2026', duration: 7700,
    emfAttributes: Object.assign(session('11396', 'Race', 1792954800), { MeetingKey: '1297', Meeting_Name: 'United States Grand Prix' }),
    additionalStreams: feeds },
  // A live session (Mexico FP1), with the usual feeds.
  106: { contentId: 106, title: '2026 Mexico City GP - Practice 1', titleBrief: 'Practice 1', contentSubtype: 'LIVE', year: '2026',
    emfAttributes: Object.assign(session('11400', 'Practice 1', NOW / 1000 - 1800), { MeetingKey: '1300', Meeting_Name: 'Mexico City Grand Prix',
      sessionEndDate: String(NOW - 600000) }),   // scheduled to have ended 10 min ago: it overruns
    additionalStreams: feeds },
  // A show of the weekend: no session, no video clock (DASH).
  102: { contentId: 102, title: 'Lap of Luxury: McLaren', titleBrief: ' McLaren', contentSubtype: 'SHOW', year: '2026', duration: 600,
    emfAttributes: { Series: 'FORMULA 1', MeetingKey: '1294', Meeting_Name: 'Spanish Grand Prix', ContentCategory: 'EPISODIC' } }
};

// Where each video's picture starts in real time: the race video opens 15 min before the start.
const CLOCKS = { 101: RACE_START - 900, 103: RACE_START - 86400 - 900, 102: 0, 104: RACE_START - 3600, 105: 1792954800 - 900 };

const TIMING_INDEX = { Meetings: [{ Key: 1252, Sessions: [{ Key: 9658, Name: 'Qualifying', Path: '2025/q/' }, { Key: 9662, Name: 'Race', Path: '2025/race/' }] }] };

// ---------- the app ----------

async function boot(options = {}) {
  // options.mvSoftware: this TV decodes the H.264 multiview's small feeds in software (Samsung's EMSS).
  const mvSoft = { starts: [], stops: 0, places: [], supported: () => !!options.mvSoftware,
    start(o) { mvSoft.starts.push(o); return Promise.resolve(); }, stop() { mvSoft.stops++; return Promise.resolve(); },
    place(r) { mvSoft.places.push(r); }, running: () => false, status: () => null };
  const clock = makeClock(options.now || NOW);
  const pages = Object.assign({}, PAGES, options.pages);
  const { document } = makeDom();
  // options.store: what an earlier run left in localStorage (a restart).
  const store = Object.assign({ 'f1tv.settings': JSON.stringify(options.settings || {}) }, options.store);
  const windowListeners = {};
  const exits = [];
  const auth = { token: null, pairing: null, cancelled: 0 };
  const net = {
    // Each returns a promise; tests replace them to hold or fail requests.
    page: (uri) => Promise.resolve(pages[uri] || []),
    video: (id) => Promise.resolve({ metadata: JSON.parse(JSON.stringify(VIDEOS[id])) }),
    play: options.play || ((id, channel) => Promise.resolve({ url: 'https://cdn/' + id + '/' + (channel || 'main') + '.m3u8', streamType: 'HLS' })),
    info: options.info || ((url) => {
      const id = /cdn\/(\d+)\//.exec(url)[1];
      // Live: a DVR window of the last hour, on the wall clock.
      if (id === '106') return Promise.resolve({ dynamic: true, windowStart: 1000, windowEnd: 4600, delay: 25, marks: [], epochAtZero: NOW / 1000 - 4600 });
      return Promise.resolve({ dynamic: false, windowStart: 0, windowEnd: 7200, delay: 25, marks: [], epochAtZero: CLOCKS[id] });
    }),
    resume: () => Promise.resolve(0),
    login: () => Promise.resolve(),
    standings: () => Promise.resolve({ round: 19, drivers: [
      { pos: 1, code: 'NOR', first: 'Lando', last: 'Norris', team: 'McLaren', teamId: 'mclaren', points: 323, wins: 6, id: 'norris', number: '4' },
      { pos: 2, code: 'PIA', first: 'Oscar', last: 'Piastri', team: 'McLaren', teamId: 'mclaren', points: 300, wins: 5, id: 'piastri', number: '81' }] }),
    season: () => Promise.resolve([])
  };
  const requests = [], saved = [];
  // The timing worker: tests mark it loaded and answer its queries with timing.state(path, t).
  // timing.hold keeps the worker's answers in timing.held, to arrive whenever the test calls them.
  const timing = { workers: [], held: [], hold: false, state: () => null,
    loaded() { const w = timing.workers.at(-1); w.onmessage({ data: { type: 'loaded', info: {} } }); } };
  class Worker {
    constructor(src) { this.src = src; this.sent = []; timing.workers.push(this); }
    postMessage(m) {
      this.sent.push(m);
      if (m.cmd === 'load') this.path = m.path;
      if (m.cmd === 'stop') this.path = null;
      if (m.cmd === 'query') {
        const path = this.path;
        const reply = () => this.onmessage({ data: { type: 'state', id: m.id, state: path ? timing.state(path, m.t) : null } });
        if (timing.hold) timing.held.push(reply); else Promise.resolve().then(reply);
      }
    }
  }
  const fetch = async (url) => {
    requests.push(url);
    if (/api\.github\.com\/repos\/nicbra\/f1tv-tizen\/releases\?/.test(url) && options.releases) {
      return { ok: true, json: async () => options.releases };
    }
    if (/127\.0\.0\.1:18765\/ping/.test(url)) return { ok: true, status: 200, text: async () => 'ok' };   // the stream helper
    if (/livetiming.*\/2025\/Index\.json$/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify(TIMING_INDEX) };
    return { ok: false, status: 404, text: async () => '' };
  };

  // The video player: loads resolve unless the test holds them; positions move only when the test says.
  const player = {
    current: null, engine: null, pos: 0, paused: false, loads: [], listeners: {}, hold: null,
    init: async () => {},
    hdrCapable: () => !!options.hdrCapable,
    // Which multiview pictures the TV decodes (all by default): (width, height, hdr) => boolean.
    hevcDecodes: (w, h, hdr) => (options.hevcDecodes ? options.hevcDecodes(w, h, hdr) : true),
    kind: 'shaka',   // or 'avplay': which engine the stub plays as
    load(s, start) {
      player.current = s;
      player.engine = player.kind;
      player.pos = start || 0;
      player.paused = false;
      player.loads.push({ url: s.url, start });
      return player.hold ? player.hold.promise : Promise.resolve();
    },
    // Shaka switches in the background: on failure the previous feed plays on as the current
    // stream, and a viewer's pause carries over. AVPlay reopens, playing.
    switchTo(s, start) {
      if (player.kind === 'avplay') return player.load(s, start);
      // Shaka: the old feed (its position and pause) stays current until the new one runs.
      const prev = player.current;
      player.current = s;
      player.loads.push({ url: s.url, start });
      return (player.hold ? player.hold.promise : Promise.resolve()).then(() => { player.pos = start || 0; },
        (e) => { player.current = prev; throw e; });
    },
    unload: async () => { player.engine = null; },
    setGridRect(r) { player.gridRect = r; },
    stream: () => player.current,
    engineName: () => player.engine,
    exactPosition: () => player.pos,
    position: () => (player.engine ? player.pos : 0),
    // player.live: a live stream with an hour of DVR window up to its live edge (window positions 1000-4600).
    range: () => (!player.engine ? { start: 0, end: 0 } : player.live ? { start: 1000, end: 4600 } : { start: 0, end: 7200 }),
    bufferedEnd: () => player.pos,
    isLive: () => !!player.engine && !!player.live,
    isPaused: () => !!player.engine && player.paused,
    togglePause() { player.paused = !player.paused; },
    seekTo(p) { player.pos = p; },
    seekBy(d) { player.pos += d; },
    seekGrid: () => null,
    // Like the real player, the clock comes from the last stream loaded, even while the next one loads.
    wallClock(pos, info) {
      info = info || (player.current && player.current.info);
      return info && info.epochAtZero > 1e9 ? info.epochAtZero + pos : null;
    },
    positionAt: (wall, info) => (info && info.epochAtZero > 1e9 ? wall - info.epochAtZero : null),
    tracks: () => player.trackList || { audio: [], text: [] },
    chosen: [],
    setAudio(l) { player.chosen.push(['audio', l]); }, setSubtitles(l) { player.chosen.push(['subtitles', l]); },
    on(name, fn) { player.listeners[name] = fn; }
  };

  const stats = {
    driverStandings: () => net.standings(), lastRace: async () => ({ round: 19, name: 'United States GP' }),
    constructorStandings: async () => [{ pos: 1, points: 623, wins: 11, id: 'mclaren', name: 'McLaren' }],
    driverInfo: async () => ({}), seasonProgress: async () => ({ rounds: [], drivers: {}, teams: {} }),
    driverSeason: () => net.season(), summary: () => ({ wins: 0, podiums: 0, poles: 0, fastestLaps: 0, best: null, avg: null, dnfs: 0 })
  };
  const context = vm.createContext({
    document,
    window: { addEventListener: (t, fn) => { windowListeners[t] = fn; } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    Date: clock.Date, Math, JSON, Promise, encodeURIComponent, decodeURIComponent, URL, Worker, fetch,
    Image: class { set src(v) { this._src = v; } },
    qrcode: () => ({ addData() {}, make() {}, createImgTag: () => '<img>' }),
    tizen: { application: { getCurrentApplication: () => ({ appInfo: { version: '1.0.0' }, exit: () => exits.push(clock.now()) }) } },
    XMLHttpRequest: class {
      open() {}
      send() { this.status = 200; this.responseText = options.installMarker || ''; this.onload(); }
    },
    Auth: options.signedOut ? {
      // Not paired: pairing shows a code and waits; tests resolve auth.pairing to sign in.
      token: () => auth.token, profile: () => (auth.token ? { firstName: 'Nicholas', lastName: '' } : {}), renew: async () => null,
      clear() { auth.token = null; }, pairUrl: (c) => 'https://f1tv.formula1.com/tv?pin=' + c, PAIR_PAGE: 'https://f1tv.formula1.com/tv',
      pair(onCode) {
        auth.pairing = deferred();
        Promise.resolve().then(() => onCode('AB12CD'));
        return Object.assign(auth.pairing.promise.then((t) => { auth.token = t; return t; }), { cancel() { auth.cancelled++; } });
      }
    } : { token: () => 'TOKEN', profile: () => ({ firstName: 'Nicholas', lastName: '' }), renew: async () => 'TOKEN', clear() {},
      pair: () => Object.assign(new Promise(() => {}), { cancel() {} }), pairUrl: () => '', PAIR_PAGE: 'https://f1tv.formula1.com/tv' },
    Stats: stats,
    // The HEVC heights in a stream's master playlist (multiview layouts need theirs).
    HdrStream: { heights: async (url, range) => (options.heights ? options.heights(url, range) : [270, 360, 540, 720, 1080, 1620, 2160]) },
    Updates: { check: async () => ({}), status: () => ({ page: 'https://github.com/nicbra/f1tv-tizen', current: '1.0.0' }), noticeToday: () => false,
      installedBy: () => 'apps2samsung' },
    // options.av: the real player.js on that fake AVPlay instead of the Player stub.
    Player: options.av ? undefined : player,
    // The H.264 multiview's small feeds (js/mvsoft.js): what the app asks of them.
    MvSoftware: mvSoft
  });
  if (options.av) {
    class SimpleTextDisplayer { append() {} }
    class ShakaPlayer {
      attach() { return Promise.resolve(); } resetConfiguration() {} configure() {}
      load() { return Promise.reject(new Error('no Shaka in this test')); }
      getNetworkingEngine() { return { registerRequestFilter() {}, registerResponseFilter() {} }; }
      addEventListener() {} unload() { return Promise.resolve(); }
    }
    Object.assign(context, { webapis: { avplay: options.av }, atob, btoa, Uint8Array, MediaSource: { isTypeSupported: () => false },
      shaka: { polyfill: { installAll() {} }, Player: ShakaPlayer, text: { SimpleTextDisplayer }, net: { NetworkingEngine: { RequestType: {} } },
        util: { Error: { Category: {} } } } });
    for (const f of ['proxy.js', 'player.js']) vm.runInContext(readFileSync('app/js/' + f, 'utf8'), context, { filename: f });
  }
  for (const f of ['settings.js', 'keys.js', 'focus.js', 'upnext.js', 'api.js', 'timing.js']) {
    vm.runInContext(readFileSync('app/js/' + f, 'utf8'), context, { filename: f });
  }
  const api = context.F1Api;
  if (!options.signedOut) Object.assign(api.state, { ascendon: 'TOKEN', entitlement: 'ENT', location: { entitlement: options.tier || 'PRO', groupId: 2 } });
  // Multiview's layouts, loaded before app.js as in index.html.
  if (options.multiview) vm.runInContext(readFileSync('app/js/layouts.js', 'utf8'), context, { filename: 'layouts.js' });
  Object.assign(api, {
    refreshConfig: async () => ({}), refreshLocation: async () => null,
    login: () => net.login().then(() => { Object.assign(api.state, { ascendon: 'TOKEN', entitlement: 'ENT' }); }),
    menu: async () => [{ title: 'Home', uri: '/home' }, { title: '2026 Season', uri: '/season' }, { title: 'Archive', uri: '/archive' }],
    page: (id) => net.page(id === api.ARCHIVE_PAGE_ID ? '/archive' : '/home'),
    pageByUri: (uri) => net.page(uri),
    video: (id) => net.video(id),
    play: (id, channel, opts) => net.play(id, channel, opts),
    streamInfo: (url) => net.info(url),
    resumePosition: (id) => net.resume(id),
    savePosition: async (...a) => { saved.push(a); }
  });
  if (options.releases) vm.runInContext(readFileSync('app/js/updates.js', 'utf8'), context, { filename: 'updates.js' });
  vm.runInContext(readFileSync('app/js/app.js', 'utf8'), context, { filename: 'app.js' });
  windowListeners.load();
  // With player.progress on, the position moves on while it plays, as real playback does.
  clock.setInterval(() => { if (player.progress && player.engine && !player.paused) player.pos += 0.1; }, 100);
  await clock.advance(100);

  const $ = (id) => document.getElementById(id);
  const KEYS = context.Keys.codes;
  const app = {
    mvSoft,
    context, clock, net, player, timing, requests, exits, saved, $, deferred, api, auth, stats, store,
    advance: (ms) => clock.advance(ms),
    async press(...names) {
      for (const name of names) {
        document.listeners.keydown.forEach((fn) => fn({ keyCode: KEYS[name], preventDefault() {} }));
        await clock.advance(50);
      }
    },
    screen: () => ['login', 'browse', 'list', 'chart', 'feeds', 'player'].find((n) => !$('screen-' + n).classList.contains('hidden')),
    focused: () => { const f = document.querySelectorAll('focused'.replace(/^/, '.')); return f.length ? f[0].textContent : null; },
    /** Moves the focus with the arrow keys until the focused element's text matches. */
    async moveTo(re, dirs) {
      for (const dir of dirs || ['DOWN', 'RIGHT', 'UP', 'LEFT']) {
        for (let i = 0; i < 25; i++) {
          if (re.test(app.focused() || '')) return;
          const before = app.focused();
          await app.press(dir);
          if (app.focused() === before) break;
        }
      }
      throw new Error('nothing focusable matches ' + re + '; focused: ' + app.focused());
    },
    /** Moves the focus with the arrow keys until the focused element's text matches, then presses OK. */
    async pick(re, dirs) {
      for (const dir of dirs || ['DOWN', 'RIGHT', 'UP', 'LEFT']) {
        for (let i = 0; i < 25; i++) {
          if (re.test(app.focused() || '')) { await app.press('ENTER'); return; }
          const before = app.focused();
          await app.press(dir);
          if (app.focused() === before) break;
        }
      }
      throw new Error('nothing focusable matches ' + re + '; focused: ' + app.focused());
    },
    /** Stops the video: BACK closes the bar first if it is up, then the player. */
    async stop() {
      for (let i = 0; i < 3 && app.screen() === 'player'; i++) await app.press('BACK');
    },
    towerShown: () => !$('tower').classList.contains('hidden'),
    toast: () => ($('toast').classList.contains('hidden') ? '' : $('toast').textContent)
  };
  return app;
}

/** Plays a video from Home's "Latest" rail, from the start. */
async function play(app, title, feed) {
  if (app.screen() !== 'browse') throw new Error('not on the browse screen');
  await app.pick(new RegExp('^' + title));
  await app.advance(100);
  if (app.screen() === 'feeds') await app.pick(feed || /^INTERNATIONAL/);
  await app.advance(300);
}

/** Timing answers for the race: lap 10 of 58 from lights out, with one driver. */
function raceTiming(path, t) {
  if (path !== '2025/race/') return path === '2025/q/' ? { type: 'Qualifying', name: 'Qualifying', part: 1, remaining: 1080,
    standings: [{ num: '4', pos: 1, tla: 'NOR', colour: '#ff8000', gap: '', interval: '', best: '1:23.000' }] } : null;
  const started = t >= RACE_START * 1000;
  return { type: 'Race', name: 'Race', lap: started ? 10 : 1, totalLaps: 58, beforeStart: !started,
    standings: [{ num: '1', pos: 1, tla: 'VER', colour: '#3671c6', gap: '', interval: '', laps: started ? 10 : 0 }] };
}

// ---------- tests ----------

test('the app boots to Home with the top nav and the first rail focused', async () => {
  const app = await boot();
  assert.equal(app.screen(), 'browse');
  assert.match(app.$('topnav').textContent, /^HomeScheduleStandingsArchiveNicholas$/);
  assert.match(app.focused(), /^Race/);
});

test('the feed list starts with INTERNATIONAL, which plays the main stream', async () => {
  const app = await boot();
  await app.pick(/^Race/);
  await app.advance(100);
  assert.equal(app.screen(), 'feeds');
  const rows = app.$('feeds-list').children.map((e) => e.textContent);
  assert.deepEqual(rows, ['INTERNATIONALBroadcast', 'F1 LIVE', '1VERMax VerstappenRed Bull Racing']);
  await app.pick(/^INTERNATIONAL/);
  await app.advance(100);
  assert.equal(app.screen(), 'player');
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/main.m3u8');
});

test('a race\'s timing tower does not carry over to a show watched next', async () => {
  const app = await boot();
  app.timing.state = raceTiming;
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1800;   // lap 10
  await app.advance(1000);
  assert.ok(app.towerShown());
  assert.match(app.$('tower-label').textContent, /10/);
  await app.press('BACK', 'BACK', 'BACK');
  assert.equal(app.screen(), 'browse');
  // The show's stream is slow to come; meanwhile the player's clock still belongs to the race.
  const stream = deferred();
  app.net.play = () => stream.promise;
  await app.pick(/^ McLaren/);
  for (let i = 0; i < 20; i++) {
    await app.advance(250);
    assert.equal(app.towerShown(), false, 'tower shown while the show loads');
  }
  stream.resolve({ url: 'https://cdn/102/main.m3u8', streamType: 'DASH' });
  await app.advance(5000);
  assert.equal(app.screen(), 'player');
  assert.equal(app.towerShown(), false, 'tower shown on the show');
  assert.doesNotMatch(app.$('osd-feed').textContent, /Lap/);
});

test('going from the race to qualifying shows qualifying\'s timing, never the race\'s', async () => {
  const app = await boot();
  app.timing.state = raceTiming;
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1800;
  await app.advance(1000);
  assert.equal(app.$('tower-name').textContent, 'Race');
  await app.press('BACK', 'BACK', 'BACK');
  const stream = deferred();
  app.net.play = () => stream.promise;
  await app.pick(/^Qualifying/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  for (let i = 0; i < 12; i++) {
    await app.advance(250);
    assert.equal(app.towerShown(), false, 'tower shown while qualifying loads');
  }
  stream.resolve({ url: 'https://cdn/103/main.m3u8', streamType: 'HLS' });
  await app.advance(500);
  app.timing.loaded();
  await app.advance(1000);
  assert.ok(app.towerShown());
  assert.equal(app.$('tower-name').textContent, 'Qualifying');
});

test('reloading the same video does not flash the tower at the video\'s start', async () => {
  const app = await boot();
  app.timing.state = raceTiming;
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1800;
  await app.advance(1000);
  await app.press('BACK', 'BACK');
  assert.equal(app.screen(), 'feeds');
  const stream = deferred();
  app.net.play = () => stream.promise;
  await app.pick(/^F1 LIVE/);
  for (let i = 0; i < 12; i++) {
    await app.advance(250);
    assert.ok(!app.towerShown() || !/Not started|^1/.test(app.$('tower-label').textContent), 'tower showed the race before its start');
  }
  stream.resolve({ url: 'https://cdn/101/1033.m3u8', streamType: 'HLS' });
});

test('BACK while a video\'s details load stays where the viewer went back to', async () => {
  const app = await boot();
  const details = deferred();
  app.net.video = () => details.promise;
  await app.pick(/^Race/);
  assert.equal(app.screen(), 'feeds');
  await app.press('BACK');
  assert.equal(app.screen(), 'browse');
  details.resolve({ metadata: JSON.parse(JSON.stringify(VIDEOS[101])) });
  await app.advance(500);
  assert.equal(app.screen(), 'browse');
  // The keys still work on Home's rails.
  await app.press('RIGHT');
  assert.match(app.focused(), /^Qualifying/);
});

for (const [tab, waitFor] of [['Schedule', 'page'], ['Standings', 'standings']]) {
  test(`BACK while ${tab} loads returns to Home, and the list does not pop up later`, async () => {
    const app = await boot();
    const held = deferred();
    if (waitFor === 'page') app.net.page = (uri) => (uri === '/season' ? held.promise : Promise.resolve(PAGES[uri] || []));
    else app.net.standings = () => held.promise;
    await app.press('UP');
    await app.pick(new RegExp('^' + tab + '$'), ['RIGHT']);
    assert.equal(app.screen(), 'list');
    // Keys pressed while it loads do nothing to the screen left behind.
    await app.press('DOWN', 'ENTER');
    assert.equal(app.screen(), 'list');
    await app.press('BACK');
    assert.equal(app.screen(), 'browse');
    held.resolve(waitFor === 'page' ? [] : { round: 1, drivers: [] });
    await app.advance(500);
    assert.equal(app.screen(), 'browse');
    assert.equal(app.exits.length, 0);
  });
}

test('a page that fails after the viewer moved on does not wipe the page shown now', async () => {
  const app = await boot();
  const held = deferred();
  app.net.page = (uri) => (uri === '/archive' ? held.promise : Promise.resolve(PAGES[uri] || []));
  await app.press('UP');
  await app.pick(/^Archive$/, ['RIGHT']);
  await app.pick(/^Home$/, ['LEFT']);
  await app.advance(100);
  assert.match(app.$('rails').textContent, /Latest/);
  held.reject(new Error('HTTP 503'));
  await app.advance(100);
  assert.match(app.$('rails').textContent, /Latest/);
  await app.press('DOWN');
  assert.match(app.focused(), /^Race/);
});

test('a jump while paused stops the spinner once it is there', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.pos = 600;
  await app.press('ENTER');   // pause
  assert.equal(app.player.paused, true);
  await app.press('RIGHT', 'ENTER');
  await app.advance(2000);
  assert.ok(app.$('spinner').classList.contains('hidden'), 'spinner still shown');
});

test('stopping while a load runs drops a feed switch asked for meanwhile', async () => {
  const app = await boot();
  await play(app, 'Race');
  const stream = deferred();
  app.net.play = () => stream.promise;
  await app.press('CH_DOWN');           // switch to F1 LIVE: waits for its stream
  await app.press('CH_DOWN');           // and on to the onboard: queued behind it
  await app.press('BACK', 'BACK');      // bar, then stop
  assert.equal(app.screen(), 'feeds');
  stream.resolve({ url: 'https://cdn/101/1033.m3u8', streamType: 'HLS' });
  await app.advance(2000);
  assert.equal(app.screen(), 'feeds');
});

test('leaving the player frees a load that never settles for the next feed', async () => {
  const app = await boot();
  app.player.hold = deferred();
  await play(app, 'Race');
  await app.press('CH_DOWN');           // a queued switch must be dropped on exit
  await app.stop();
  assert.equal(app.screen(), 'feeds');
  app.player.hold = null;
  await app.pick(/^INTERNATIONAL/);
  assert.equal(app.screen(), 'player');
  assert.equal(app.player.loads.length, 2);
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/main.m3u8');
});

test('a load that never settles releases the queued feed after 30 seconds', async () => {
  const app = await boot();
  await app.pick(/^Race/);
  await app.advance(100);
  app.player.hold = deferred();
  const started = app.clock.now();
  await app.press('ENTER');             // INTERNATIONAL: held inside the player
  await app.press('CH_DOWN');           // F1 LIVE: queued
  app.player.hold = null;
  await app.advance(30000 - (app.clock.now() - started) - 1);
  assert.equal(app.player.loads.length, 1, 'keep serializing before the deadline');
  await app.advance(1);
  assert.equal(app.player.loads.length, 2, 'start the queued feed at the deadline');
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/1033.m3u8');
});

test('a late load completion cannot release a newer load or its queued feed', async () => {
  for (const abandoned of [true, false]) {
    const app = await boot();
    const old = deferred(), newer = deferred();
    app.player.hold = old;
    await play(app, 'Race');
    if (abandoned) {
      await app.stop();
      app.player.hold = newer;
      await app.pick(/^F1 LIVE/);
    } else {
      await app.press('CH_DOWN');
      app.player.hold = newer;
      await app.advance(30000);
    }
    assert.equal(app.player.loads.length, 2, abandoned ? 'restart after exit' : 'restart after timeout');
    await app.press('CH_DOWN');         // onboard: waits for the newer load
    old.resolve();
    await app.advance(0);
    assert.equal(app.player.loads.length, 2, 'the old completion must not start the onboard');
    await app.press('RIGHT');
    assert.match(app.toast(), /Loading/, 'the newer load must still count as loading');
    app.player.hold = null;
    newer.resolve();
    await app.advance(0);
    assert.equal(app.player.loads.length, 3, 'the newer completion releases its queue');
    assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/1009.m3u8');
  }
});

test('buffering shows the spinner and passes on without an error (the player\'s own stall handling runs after it)', async () => {
  const app = await boot();
  await play(app, 'Race');
  assert.doesNotThrow(() => app.player.listeners.buffering(true));
  assert.ok(!app.$('spinner').classList.contains('hidden'));
  assert.doesNotThrow(() => app.player.listeners.buffering(false));
  assert.ok(app.$('spinner').classList.contains('hidden'));
});

test('BACK on the feed list while the session renews does not start the video', async () => {
  const app = await boot();
  await app.pick(/^Race/);
  await app.advance(100);
  app.api.state.entitlement = null;     // expired: the next play renews the session first
  const login = deferred();
  app.net.login = () => login.promise;
  await app.pick(/^INTERNATIONAL/);
  await app.press('BACK');
  assert.equal(app.screen(), 'browse');
  login.resolve();
  await app.advance(1000);
  assert.equal(app.screen(), 'browse');
  assert.equal(app.player.loads.length, 0);
});

test('a feed switch without the new feed\'s clock keeps the position', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.pos = 3000;
  app.net.info = () => Promise.reject(new Error('HTTP 503'));
  await app.press('CH_DOWN');
  await app.advance(500);
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/1033.m3u8');
  assert.ok(app.player.loads.at(-1).start >= 3000, 'started at ' + app.player.loads.at(-1).start);
});

for (const kind of ['shaka', 'avplay']) {
  test(`switching feeds while paused shows the same moment, paused (${kind})`, async () => {
    const app = await boot();
    app.player.kind = kind;
    await play(app, 'Race');
    app.player.pos = 3000;
    await app.press('ENTER');
    assert.equal(app.player.paused, true);
    await app.advance(10000);
    await app.press('CH_DOWN');
    await app.advance(500);
    const load = app.player.loads.at(-1);
    assert.equal(load.url, 'https://cdn/101/1033.m3u8');
    assert.equal(Math.round(load.start), 3000);
    assert.equal(app.player.paused, true);
  });

  test(`pressing play while a paused feed switch loads leaves it playing (${kind})`, async () => {
    const app = await boot();
    app.player.kind = kind;
    await play(app, 'Race');
    app.player.pos = 3000;
    await app.press('ENTER');
    app.player.hold = deferred();
    await app.press('CH_DOWN');
    await app.press('PLAY');   // changed their mind while it switched
    app.player.hold.resolve();
    app.player.hold = null;
    await app.advance(500);
    assert.equal(app.player.paused, false);
  });
}

test('a failed feed switch leaves the previous feed current', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.pos = 3000;
  app.player.hold = deferred();
  await app.press('CH_DOWN');
  app.player.hold.reject(new Error('Shaka Error 1001'));
  app.player.hold = null;
  await app.advance(500);
  assert.match(app.toast(), /Could not play/);
  assert.equal(app.player.current.url, 'https://cdn/101/main.m3u8');
  assert.match(app.$('osd-feed').textContent, /^INTERNATIONAL/);
  // The next switch goes on from INTERNATIONAL, to F1 LIVE again.
  await app.press('CH_DOWN');
  await app.advance(500);
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/1033.m3u8');
});

test('a start that hangs in AVPlay is tried once more at the same moment, then the viewer is told to restart', async () => {
  const hung = () => Object.assign(new Error('The video player did not start'), { code: 'PREPARE_TIMEOUT' });
  const app = await boot();
  app.net.resume = () => Promise.resolve(1800);
  await app.pick(/^Race/);
  await app.advance(100);
  app.player.hold = deferred();
  await app.pick(/^INTERNATIONAL/);
  await app.press('ENTER');   // continue from 30:00
  await app.advance(200);
  const first = app.player.hold;
  app.player.hold = deferred();
  first.reject(hung());
  await app.advance(200);
  assert.match(app.toast(), /didn't start, trying again/);
  assert.deepEqual(app.player.loads.map((l) => l.start), [1800, 1800]);
  app.player.hold.reject(hung());
  app.player.hold = null;
  await app.advance(200);
  assert.match(app.toast(), /video player is stuck\. Restart the app/);
  assert.equal(app.player.loads.length, 2, 'no third open over a stuck player');
});

test('after a hung start that recovered, a later hang gets its retry again', async () => {
  const hung = () => Object.assign(new Error('The video player did not start'), { code: 'PREPARE_TIMEOUT' });
  const app = await boot();
  await play(app, 'Race');
  app.player.pos = 3000;
  for (const round of [1, 2]) {
    app.player.hold = deferred();
    await app.press('CH_DOWN');
    await app.advance(100);
    const h = app.player.hold;
    app.player.hold = null;
    h.reject(hung());
    await app.advance(500);
    assert.match(app.toast(), /didn't start, trying again/, 'round ' + round);
  }
});

test('OK on the feed list before the saved position arrives still offers to continue', async () => {
  const app = await boot();
  const resume = deferred();
  app.net.resume = () => resume.promise;
  await app.pick(/^Race/);
  await app.advance(100);
  await app.press('ENTER');   // INTERNATIONAL, at once
  assert.equal(app.screen(), 'feeds');
  resume.resolve(1800);
  await app.advance(100);
  assert.match(app.$('dialog-actions').textContent, /Continue from 30:00/);
  await app.press('ENTER');
  await app.advance(200);
  assert.equal(app.player.loads.at(-1).start, 1800);
});

test('jumping back soon after the start is not taken for a video that did not start', async () => {
  const app = await boot();
  app.net.resume = () => Promise.resolve(1800);
  await app.pick(/^Race/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.press('ENTER');   // continue from 30:00
  await app.advance(200);
  assert.equal(app.player.pos, 1800);
  app.player.pos = 1500;      // the viewer went back five minutes, and it plays from there
  await app.advance(20000);
  assert.doesNotMatch(app.toast(), /didn't start/);
  assert.equal(app.player.loads.length, 1);
});

test('the Play and Pause keys only play or pause', async () => {
  const app = await boot();
  await play(app, 'Race');
  await app.press('PLAY');
  assert.equal(app.player.paused, false);
  await app.press('PAUSE');
  assert.equal(app.player.paused, true);
  await app.press('PAUSE');
  assert.equal(app.player.paused, true);
  await app.press('PLAY');
  assert.equal(app.player.paused, false);
  await app.press('PLAY_PAUSE');
  assert.equal(app.player.paused, true);
});

test('an archived pre-race show offers the race when it ends', async () => {
  const app = await boot();
  await play(app, 'Pre-Race Show');
  assert.equal(app.screen(), 'player');
  app.player.pos = 3590;
  app.player.listeners.ended();
  await app.advance(1000);
  assert.ok(!app.$('upnext').classList.contains('hidden'), 'no Up next card');
  assert.match(app.$('upnext-title').textContent, /^Race/);
  await app.advance(11000);
  assert.equal(app.screen(), 'player');
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/main.m3u8');
  // From the moment the show ended: 10 s before lights out, 890 s into the race video.
  assert.equal(Math.round(app.player.loads.at(-1).start), 890);
});

// ---------- lists, pages and settings ----------

test('Schedule focuses the next weekend, and BACK walks back through the lists to Home', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  assert.equal(app.screen(), 'list');
  assert.match(app.focused(), /^Round 20Mexico/);
  assert.match(app.$('list-inner').textContent, /Round 19United States.*Replays/);
  await app.press('ENTER');
  assert.equal(app.$('list-title').textContent, 'Mexico');
  assert.match(app.$('list-sub').textContent, /No broadcast schedule/);
  await app.press('BACK');
  assert.equal(app.$('list-title').textContent, 'Schedule');
  assert.match(app.focused(), /^Round 20Mexico/);
  await app.press('BACK');
  assert.equal(app.screen(), 'browse');
  assert.equal(app.exits.length, 0);
});

test('a session the open weekend list still shows as live plays as the replay it has become', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  await app.pick(/^Round 19United States/, ['UP']);
  assert.match(app.focused(), /^\d\d:\d\dRace.*LIVE/);
  await app.press('ENTER');
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.doesNotMatch(app.$('dialog-title').textContent, /is live/);
  assert.equal(app.screen(), 'player');
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/105/main.m3u8');
});

test('Standings opens a driver, and BACK returns to the same row', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Standings$/, ['RIGHT']);
  assert.match(app.$('list-sub').textContent, /after round 19 \(United States GP\)/);
  await app.pick(/^P2.*Oscar Piastri/, ['DOWN']);
  assert.equal(app.$('list-title').textContent, 'Oscar Piastri');
  await app.press('BACK');
  assert.match(app.focused(), /Oscar Piastri/);
  await app.press('BACK');
  assert.equal(app.screen(), 'browse');
});

test('the championship chart before the first race says so, and its keys do nothing', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Standings$/, ['RIGHT']);
  await app.press('ENTER');   // Championship battle
  assert.equal(app.screen(), 'chart');
  assert.equal(app.$('chart-sub').textContent, 'No races yet this season.');
  await app.press('LEFT', 'UP', 'RIGHT');
  await app.press('BACK');
  assert.equal(app.screen(), 'list');
});

test('a single-feed video plays at once, and BACK returns to the tile it was opened from', async () => {
  const app = await boot();
  await app.pick(/^ McLaren/);
  await app.advance(300);
  assert.equal(app.screen(), 'player');
  await app.press('BACK', 'BACK');
  assert.equal(app.screen(), 'browse');
  assert.match(app.focused(), /^ McLaren/);
});

test('browsing commentary languages applies only the one chosen: on OK, or once the presses stop', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.trackList = { audio: [{ lang: 'eng' }, { lang: 'deu' }, { lang: 'fra' }, { lang: 'fx' }], text: [] };
  await app.press('UP');
  await app.moveTo(/^Commentary/, ['UP']);
  await app.press('RIGHT');
  await app.advance(1000);
  await app.press('RIGHT');   // past Deutsch to Français, within 2 s
  await app.advance(1500);
  assert.deepEqual(app.player.chosen, [], 'nothing while browsing');
  await app.press('ENTER');   // OK takes it at once
  assert.deepEqual(app.player.chosen, [['audio', 'fra']]);
  await app.advance(3000);
  assert.deepEqual(app.player.chosen, [['audio', 'fra']], 'once');
  // A choice still shown when the panel closes applies.
  await app.press('RIGHT');
  await app.press('BACK');
  assert.deepEqual(app.player.chosen, [['audio', 'fra'], ['audio', 'fx']]);
});

test('watch options change commentary and subtitles, and pick a feed', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.trackList = { audio: [{ lang: 'eng' }, { lang: 'deu' }, { lang: 'fx' }], text: [{ lang: 'eng' }, { lang: 'fra' }] };
  await app.press('UP');
  assert.ok(!app.$('panel').classList.contains('hidden'));
  const rows = app.$('panel-list').children.map((e) => e.textContent);
  assert.deepEqual(rows.slice(0, 3), ['Live timing‹ Interval ›', 'Commentary‹ English ›', 'Subtitles‹ Off ›']);
  // The current feed is focused; up to the settings.
  assert.match(app.focused(), /^INTERNATIONAL/);
  await app.moveTo(/^Commentary/, ['UP']);
  await app.press('RIGHT');
  assert.match(app.focused(), /Deutsch/);
  // Browsing the commentary doesn't switch the sound at every press: it does once the choice settles.
  assert.deepEqual(app.player.chosen, []);
  await app.advance(2100);
  assert.deepEqual(app.player.chosen, [['audio', 'deu']]);
  await app.press('DOWN', 'LEFT');
  assert.match(app.focused(), /Français/);
  assert.deepEqual(app.player.chosen, [['audio', 'deu'], ['subtitles', 'fra']]);
  await app.pick(/^1VER/, ['DOWN']);
  await app.advance(300);
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/1009.m3u8');
  assert.ok(app.$('panel').classList.contains('hidden'));
});

// ---------- multiview (experiment) ----------

// An HDR TV unless options say otherwise; the account's tier plays no part.
const premiumHdr = (options) => boot(Object.assign({ multiview: true, hdrCapable: true }, options));

const premiumOffer = (id, channel) => Promise.resolve({ url: 'https://cdn/' + id + '/' + (channel || 'main') + '/hdr.m3u8', hdr: true, hdrEncrypted: true, licenseUrl: 'https://lic' });

test('watch options open a multiview page: layouts as pictures, then a feed for each place', async () => {
  const app = await premiumHdr();
  await play(app, 'Race');
  await app.press('UP');
  await app.moveTo(/^Multiview/, ['UP']);
  assert.match(app.focused(), /^MultiviewOff/);
  await app.press('ENTER');
  assert.equal(app.$('panel-title').textContent, 'Multiview');
  assert.ok(app.$('panel').classList.contains('wide'));
  assert.equal(app.focused(), 'One feed', 'the current choice is focused');
  // Layouts that need more feeds than the video has are left out (this race has three).
  assert.ok(!/2×2/.test(app.$('panel-list').textContent));
  assert.ok(!/experimental/.test(app.$('panel-list').textContent), 'the HEVC multiview has no H.264 note');
  await app.moveTo(/^Big \+ 2$/, ['RIGHT']);
  await app.press('ENTER');
  // The chosen layout, larger, with the current feed in the big place.
  assert.match(app.focused(), /INTERNATIONAL/);
  const places = () => app.$('panel-list').children.find((e) => /mv-preview/.test(e.className)).children[0].children.map((c) => c.textContent);
  await app.press('RIGHT');   // the arrows go by position: the small place beside the big one
  const small = app.focused();
  assert.equal(small, places()[1]);
  // OK opens the feeds for that place; one already shown elsewhere swaps places.
  await app.press('ENTER');
  assert.equal(app.$('panel-title').textContent, 'Feed for this place');
  assert.match(app.$('panel-list').textContent, /in multiview/);
  await app.pick(/^INTERNATIONAL/, ['UP']);
  assert.equal(app.$('panel-title').textContent, 'Multiview');
  assert.deepEqual(places().slice(0, 2), [small, 'INTERNATIONAL']);
  assert.equal(new Set(places()).size, 3);
  // BACK returns to watch options, OK there comes back with the choices kept.
  await app.press('BACK');
  assert.equal(app.$('panel-title').textContent, 'Watch options');
  await app.press('ENTER');
  assert.equal(app.focused(), 'Big + 2');
  app.net.play = premiumOffer;
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  const s = app.player.current;
  assert.equal(s.grid.layout, 'side2');
  assert.equal(s.grid.streams.length, 3);
  assert.equal(app.context.Settings.get('multiview'), 'side2');
  assert.equal(app.context.Settings.get('mvFeeds').side2[1], 'INTERNATIONAL', 'the feeds are remembered by name');
  assert.match(app.$('osd-feed').textContent, /^Multiview · 3 feeds · HDR/);
  // Over the video: a frame per feed (margins, rounded corners), with its name.
  await app.advance(600);
  const frames = app.$('mv-frames');
  assert.ok(!frames.classList.contains('hidden'));
  const labels = frames.children.filter((c) => /mv-label/.test(c.className));
  assert.equal(labels.length, 3);
  assert.match(labels[1].textContent, /INTERNATIONAL/);
  // A feed from the list plays alone again.
  await app.press('UP');
  await app.pick(/^1VER/, ['DOWN']);
  await app.advance(600);
  assert.ok(!app.player.current.grid);
  assert.ok(app.$('mv-frames').classList.contains('hidden'));
});

test('changing a playing multiview rearranges it in place: no new load, feeds that stay keep their sessions', async () => {
  const app = await premiumHdr({ play: premiumOffer });
  app.player.kind = 'avplay';
  await play(app, 'Race');
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  const grid = app.player.current.grid;
  grid.id = 'g1';                                     // as the player sets it once the helper has the grid
  const asked = [], plays = [];
  app.context.StreamProxy = { regrid: async (s, list, layout, at, prepareOnly) => { asked.push({ list, layout, at, prepareOnly }); return prepareOnly ? null : {}; } };
  app.net.play = (id, channel) => { plays.push(channel); return premiumOffer(id, channel); };
  const loads = app.player.loads.length;
  app.player.pos = 1234;
  // The big feed and the second place swap (the race has three feeds, all shown).
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.moveTo(/INTERNATIONAL/, ['DOWN']);
  await app.press('RIGHT', 'ENTER');
  const before = grid.slots.slice(), sessions = grid.streams.slice();
  await app.pick(/^INTERNATIONAL/, ['UP']);
  await app.pick(/^Show this multiview/, ['DOWN']);
  await app.advance(3000);
  assert.equal(app.player.loads.length, loads, 'not loaded again');
  // Focus on Show had the helper prepare it; OK then changed it.
  assert.deepEqual(asked.map((a) => !!a.prepareOnly), [true, false]);
  assert.equal(asked[1].list[0], asked[0].list[0], 'the prepared offers are used');
  asked.shift();
  assert.equal(asked[0].layout, 'side2');
  assert.equal(asked[0].at, 1238, 'prepared from a few seconds ahead');
  assert.equal(plays.length, 0, 'no new streams from F1 for feeds that stay');
  assert.deepEqual(Array.from(grid.slots), [before[1], before[0], before[2]]);
  assert.ok(asked[0].list[0] === sessions[1] && asked[0].list[1] === sessions[0] && asked[0].list[2] === sessions[2], 'each feed keeps its session');
  assert.equal(app.player.pos, 1234, 'the same moment, fetched anew');
});

test('OK on Show while that multiview is still being prepared waits for it', async () => {
  const app = await premiumHdr({ play: premiumOffer });
  app.player.kind = 'avplay';
  await play(app, 'Race');
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  app.player.current.grid.id = 'g1';
  let release;
  const held = new Promise((r) => { release = r; });
  const asked = [], plays = [];
  app.context.StreamProxy = { regrid: (s, list, layout, at, prepareOnly) => { asked.push(!!prepareOnly); return prepareOnly ? held : Promise.resolve({}); } };
  app.net.play = (id, channel) => { plays.push(channel); return premiumOffer(id, channel); };
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Picture in picture ½$/, ['RIGHT']);
  await app.moveTo(/^Show this multiview/, ['DOWN']);   // starts preparing, which hangs on
  await app.advance(200);
  await app.press('ENTER');
  await app.advance(500);
  assert.deepEqual(asked, [true], 'the change waits for the preparation');
  release(null);
  await app.advance(1000);
  assert.deepEqual(asked, [true, false]);
  assert.equal(plays.length, 0, 'no second set of offers');
  assert.equal(app.player.current.grid.layout, 'pip');
});

test('in a multiview, the timing data moves from the tower into the space the layout leaves free', async () => {
  const app = await premiumHdr({ play: premiumOffer });
  app.timing.state = (path) => {
    const st = busyRace(path);
    if (st) st.standings[0].sectors = ['p21.034', 'o33.415', '25.900'];
    return st;
  };
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1800;
  await app.advance(1000);
  assert.ok(!app.$('tower').classList.contains('hidden'), 'one feed: the tower');
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  const data = app.$('mv-data');
  assert.ok(app.$('tower').classList.contains('hidden'), 'not over the video');
  assert.ok(!data.classList.contains('hidden'));
  // Big + 2 is wider than the screen: with timing data, the picture goes to the top and the data below it.
  assert.deepEqual(Array.from(app.player.gridRect), [0, 0, 1920, 720]);
  assert.match(data.className, /field/);
  assert.equal(data.style.top, '720px');
  const frames = app.$('mv-frames').children.filter((c) => /mv-label/.test(c.className));
  assert.ok(frames.every((l) => parseInt(l.style.top, 10) < 720), 'the frames follow the picture up');
  assert.match(data.textContent, /Lap 10 \/ 58/);
  // With room to spare, the sector times: green personal best, purple overall fastest.
  const secs = data.children[1].children[0].children.filter((c) => /tw-sec/.test(c.className));
  assert.deepEqual(secs.map((c) => c.textContent + ':' + c.className), ['21.034:tw-sec p', '33.415:tw-sec o', '25.900:tw-sec']);
  assert.ok(!/21\.034/.test(app.$('tower').textContent), 'the tower stays as it was');
  // Every other row a shade lighter.
  assert.deepEqual(data.children[1].children.map((r) => /\balt\b/.test(r.className)), [false, true, false, true]);
  assert.match(data.textContent, /VER/);
  assert.match(data.textContent, /SC/);
  // Back to one feed: the tower again, and the picture on the whole screen.
  await app.press('UP');
  await app.pick(/^1VER/, ['DOWN']);
  await app.advance(1000);
  assert.ok(data.classList.contains('hidden'));
  assert.ok(!app.$('tower').classList.contains('hidden'));
  assert.equal(app.player.gridRect, null);
});

test('a multiview without HEVC offers to stitch falls back to the big feed alone', async () => {
  const app = await premiumHdr();
  await play(app, 'Race');
  // DRM DASH (as F1's normal offer for some replays and live): nothing the helper can stitch.
  app.net.play = (id, channel) => Promise.resolve({ url: 'https://cdn/' + id + '/' + (channel || 'main') + '.mpd', licenseUrl: 'https://lic' });
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  assert.ok(!app.player.current.grid);
  assert.match(app.player.current.url, /\/main\./);   // the big feed still plays
  assert.match(app.$('toast').textContent, /Multiview didn't work \(no matching multiview stream for/);
});

test('a multiview from clear SDR offers (as Pro gets), also on a TV without HDR: the SDR HEVC, and no HDR asked for', async () => {
  const app = await premiumHdr({ hdrCapable: false });
  await play(app, 'Race');
  const asked = [];
  app.net.play = (id, channel, opts) => { asked.push(opts); return Promise.resolve({ url: 'https://cdn/' + id + '/' + (channel || 'main') + '.m3u8', streamType: 'SDR_HD_CMAF' }); };
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  const grid = app.player.current.grid;
  assert.ok(grid, 'the multiview plays');
  assert.equal(grid.streams.length, 3);
  assert.ok(grid.streams.every((s) => !s.hdr));
  assert.ok(!app.player.current.hdr);
  assert.ok(asked.length && asked.every((o) => !o.hdr));
  assert.doesNotMatch(app.$('osd-feed').textContent, /HDR/);
});

// H.264 replays (2018-2024) have no HEVC to tile: the big feed plays on AVPlay in its place and the small ones are
// decoded in software from one interleaved stream (js/mvsoft.js), under the same frames, names and timing data.
test('an H.264 replay (no HEVC) offers the layouts with a big feed: AVPlay shows it in its place, the small ones play in software', async () => {
  const app = await premiumHdr({ heights: () => [], mvSoftware: true });
  await play(app, 'Race');
  const asked = [];
  app.net.play = (id, channel, opts) => { asked.push(opts); return Promise.resolve({ url: 'https://cdn/' + id + '/' + (channel || 'main') + '.m3u8', streamType: 'HLS' }); };
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  // Layouts of one big feed and small 540p ones only (all four equal ones would all be software).
  assert.ok(!/2×2/.test(app.$('panel-list').textContent));
  assert.match(app.$('panel-list').textContent, /Multiview for H\.264 streams is experimental/);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  const s = app.player.current;
  assert.equal(s.grid.engine, 'h264');
  assert.equal(s.grid.layout, 'side2');
  assert.equal(s.grid.streams.length, 3);
  assert.match(s.url, /\/main\.m3u8$/, 'AVPlay plays the big feed itself');
  assert.equal(s.grid.audio, s.grid.slots[0], 'the sound comes from the big feed');
  assert.ok(asked.length === 3 && asked.every((o) => !o.hdr && !o.hdrOnly), 'the usual offers');
  // AVPlay's picture goes to the big feed's place (the left two thirds), not the whole screen.
  const r = app.player.gridRect;
  assert.ok(r && r[0] >= 0 && r[2] > 1000 && r[2] < 1400 && r[3] < 1080, 'big feed rect ' + r);
  // The small feeds start once the big one plays: two offers, their two places on the screen, the canvas.
  assert.equal(app.mvSoft.starts.length, 1);
  const o = app.mvSoft.starts[0];
  assert.equal(o.streams.length, 2);
  assert.deepEqual(o.streams.map((x) => x.url), s.grid.streams.slice(1).map((x) => x.url));
  assert.equal(o.rects.length, 2);
  assert.ok(o.rects.every((x) => x.left >= r[0] + r[2] - 1), 'the small places are right of the big one');
  assert.equal(o.canvas, app.$('mv-soft'));
  // Until the small feeds have a picture: only the big feed's frame and name, and a line saying they load.
  await app.advance(600);
  const frames = () => app.$('mv-frames').children;
  assert.equal(frames().filter((c) => /mv-label/.test(c.className)).length, 1);
  assert.match(frames().filter((c) => /mv-loading/.test(c.className))[0].textContent, /^Loading .+, .+…$/);
  // Then the same frames and names over them as for the HEVC grids.
  o.onShown();
  await app.advance(600);
  assert.equal(frames().filter((c) => /mv-label/.test(c.className)).length, 3);
  assert.equal(frames().filter((c) => /mv-loading/.test(c.className)).length, 0);
  // No sound choice: only the big feed has sound.
  await app.press('UP');
  assert.ok(!/Sound from/.test(app.$('panel-list').textContent));
  await app.press('BACK');
  // A feed from the list plays alone again: the small feeds stop.
  const stops = app.mvSoft.stops;
  await app.press('UP');
  await app.pick(/^1VER/, ['DOWN']);
  await app.advance(600);
  assert.ok(!app.player.current.grid);
  assert.ok(app.mvSoft.stops > stops);
  assert.ok(app.$('mv-frames').classList.contains('hidden'));
});

test('H.264 multiview: small feeds that fail start once more, then the big feed plays alone', async () => {
  const app = await premiumHdr({ heights: () => [], mvSoftware: true });
  await play(app, 'Race');
  app.net.play = (id, channel) => Promise.resolve({ url: 'https://cdn/' + id + '/' + (channel || 'main') + '.m3u8', streamType: 'HLS' });
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  assert.equal(app.mvSoft.starts.length, 1);
  app.mvSoft.starts[0].onError(new Error('helper: no such segment'));
  assert.match(app.$('toast').textContent, /starting them again/);
  await app.advance(2500);
  assert.equal(app.mvSoft.starts.length, 2, 'started once more');
  assert.ok(app.player.current.grid, 'still the multiview');
  app.mvSoft.starts[1].onError(new Error('helper: no such segment'));
  await app.advance(3000);
  assert.match(app.$('toast').textContent, /Multiview didn't work \(helper: no such segment\)/);
  assert.ok(!app.player.current.grid, 'the big feed alone');
  assert.match(app.player.current.url, /\/main\.m3u8$/);
  assert.equal(app.mvSoft.starts.length, 2);
});

test('an H.264 replay offers no multiview on a TV without Samsung\'s software decoding', async () => {
  const app = await premiumHdr({ heights: () => [], mvSoftware: false });
  await play(app, 'Race');
  // The first opening reads the offer's HEVC heights (meanwhile every layout counts, as before); then none fits.
  await app.press('UP');
  await app.press('BACK');
  await app.advance(500);
  await app.press('UP');
  assert.equal(app.$('panel-title').textContent, 'Watch options');
  assert.ok(!/Multiview/.test(app.$('panel-list').textContent));
});

test('a multiview mixing HDR and SDR offers falls back to the big feed alone', async () => {
  const app = await premiumHdr();
  await play(app, 'Race');
  app.net.play = (id, channel) => channel ? Promise.resolve({ url: 'https://cdn/' + id + '/' + channel + '.m3u8' }) : premiumOffer(id, channel);
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  assert.ok(!app.player.current.grid);
  assert.match(app.$('toast').textContent, /no matching multiview stream for/);
});

test('after a restart an H.264 multiview comes back as one (its engine waits for the offer\'s HEVC heights)', async () => {
  const sdr = (id, channel) => Promise.resolve({ url: 'https://cdn/' + id + '/' + (channel || 'main') + '.m3u8', streamType: 'HLS' });
  const app = await premiumHdr({ heights: () => [], mvSoftware: true, play: sdr });
  app.net.info = async () => ({ epochAtZero: 1.7e9, windowStart: 0, windowEnd: 7200 });
  await play(app, 'Race');
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  assert.equal(app.player.current.grid.engine, 'h264');
  app.player.pos = 2345;
  await app.advance(3100);
  const again = await premiumHdr({ store: app.store, info: app.net.info, play: sdr, heights: () => [], mvSoftware: true });
  await again.advance(4000);
  assert.ok(!again.player.current.grid, 'the big feed first, alone');
  again.player.progress = true;
  await again.advance(5000);
  assert.equal(again.player.current.grid.layout, 'side2');
  assert.equal(again.player.current.grid.engine, 'h264');
  assert.equal(again.mvSoft.starts.length, 1);
});

test('after a restart the app continues the same video at the same moment, also a multiview', async () => {
  const app = await premiumHdr();
  app.net.info = async () => ({ epochAtZero: 1.7e9, windowStart: 0, windowEnd: 7200 });
  await play(app, 'Race');
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  app.net.play = premiumOffer;
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  app.player.pos = 2345;
  await app.advance(3100);
  const saved = JSON.parse(app.store['f1tv.watching']);
  assert.equal(saved.wall, 1.7e9 + 2345);
  assert.equal(saved.multiview.layout, 'side2');
  // The TV restarts the app (a new version): it opens that video again at that moment, as a multiview.
  const again = await premiumHdr({ store: app.store, info: app.net.info, play: premiumOffer });
  await again.advance(4000);
  assert.equal(again.screen(), 'player');
  // The big feed first, alone (a multiview as the first video has stalled in AVPlay), at that moment.
  assert.ok(!again.player.current.grid);
  assert.equal(again.player.loads.at(-1).start, 2345, 'not a second further: no spoilers');
  // Once it plays, the multiview takes over.
  again.player.progress = true;
  await again.advance(5000);
  assert.equal(again.player.current.grid.layout, 'side2');
  // Leaving the player forgets it.
  await again.press('BACK', 'BACK');
  assert.equal(again.store['f1tv.watching'], '');
});

/** A Big + 2 multiview playing on AVPlay, with its grid id set as the player sets it. */
async function playingBig2(app) {
  app.player.kind = 'avplay';
  await play(app, 'Race');
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  app.player.current.grid.id = 'g1';
  return app.player.current.grid;
}

test('subtitles in picture in picture keep the usual place, as with one feed', async () => {
  for (const name of ['Picture in picture ½', 'Picture in picture ⅓']) {
    const app = await premiumHdr({ play: premiumOffer, settings: { subtitles: 'eng' } });
    app.player.kind = 'avplay';
    await play(app, 'Race');
    await app.press('UP');
    await app.pick(/^Multiview/, ['UP']);
    await app.pick(new RegExp('^' + name + '$'), ['RIGHT']);
    await app.pick(/^Show multiview/, ['DOWN']);
    await app.advance(3600);
    assert.equal(app.player.current.grid.layout.slice(0, 3), 'pip');
    app.player.listeners.subtitle({ text: 'Box, box', ms: 3000 });
    const box = app.$('subtitle');
    assert.ok(!box.classList.contains('hidden'));
    assert.ok(!box.classList.contains('mv'), name + ': the usual place');
  }
});

test('a failed rearrangement does not bring the viewer back to the player after they left', async () => {
  const app = await premiumHdr({ play: premiumOffer });
  await playingBig2(app);
  let fail;
  app.context.StreamProxy = { regrid: (s, list, layout, at, prepareOnly) => (prepareOnly ? Promise.resolve(null) : new Promise((r, f) => { fail = f; })) };
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Picture in picture ½$/, ['RIGHT']);
  await app.pick(/^Show this multiview/, ['DOWN']);
  await app.advance(500);
  const loads = app.player.loads.length;
  await app.press('BACK', 'BACK');   // the toast says it changes; the viewer leaves meanwhile
  await app.advance(200);
  assert.notEqual(app.screen(), 'player');
  fail(new Error('HTTP 502'));
  await app.advance(3000);
  assert.notEqual(app.screen(), 'player');
  assert.equal(app.player.loads.length, loads, 'nothing loaded again');
});

test('a multiview without the feed the sound comes from loads anew, so the sound follows the new big feed', async () => {
  const app = await premiumHdr({ play: premiumOffer });
  const grid = await playingBig2(app);
  const asked = [];
  app.context.StreamProxy = { regrid: async (s, list, layout, at, prepareOnly) => { asked.push(!!prepareOnly); return prepareOnly ? null : {}; } };
  const soundFrom = app.$('panel-list') && grid.audio;
  const loads = app.player.loads.length;
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Picture in picture ½$/, ['RIGHT']);
  // The big place (the feed the sound comes from) gets the feed that Picture in picture leaves out.
  const places = () => app.$('panel-list').children.find((e) => /mv-preview/.test(e.className)).children[0].children.map((c) => c.textContent);
  const shown = places();
  await app.press('ENTER');
  const other = app.$('panel-list').children.map((e) => e.textContent).find((t) => !/in multiview/.test(t) && !shown.includes(t.replace(/^\d+/, '')) && /^(INTERNATIONAL|F1 LIVE|1VER)/.test(t));
  await app.pick(new RegExp('^' + other.slice(0, 5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ['DOWN', 'UP']);
  await app.pick(/^Show this multiview/, ['DOWN']);
  await app.advance(3000);
  assert.deepEqual(asked.filter((x) => !x), [], 'not rearranged in place');
  assert.equal(app.player.loads.length, loads + 1, 'loaded anew');
  const g = app.player.current.grid;
  assert.ok(!g.slots.includes(soundFrom));
  assert.equal(g.audio, g.slots[0], 'the sound from the new big feed');
});

test('a restart before the resumed video plays still comes back to it, twice at most', async () => {
  const state = { contentId: 101, title: 'Race', feed: 0, multiview: null, wall: null, pos: 1500 };
  const boot1 = await premiumHdr();
  const saved = (tries) => Object.assign({}, boot1.store, { 'f1tv.watching': JSON.stringify(Object.assign({}, state, { at: boot1.clock.now(), tries })) });
  // While it opens, the moment stays saved (a restart now comes back to it), counted as one try.
  const first = await premiumHdr({ store: saved(undefined) });
  assert.equal(JSON.parse(first.store['f1tv.watching']).tries, 1);
  await first.advance(4000);
  assert.equal(first.player.loads.at(-1).start, 1500);
  // Tried twice already (resuming may be what fails): not again.
  const third = await premiumHdr({ store: saved(2) });
  await third.advance(4000);
  assert.notEqual(third.screen(), 'player');
  assert.equal(third.store['f1tv.watching'], '');
});

test('a feed chosen while a resumed multiview waits for its big feed is not overridden', async () => {
  const app = await premiumHdr();
  app.net.info = async () => ({ epochAtZero: 1.7e9, windowStart: 0, windowEnd: 7200 });
  await play(app, 'Race');
  await app.press('UP');
  await app.pick(/^Multiview/, ['UP']);
  await app.pick(/^Big \+ 2$/, ['RIGHT']);
  app.net.play = premiumOffer;
  await app.pick(/^Show multiview/, ['DOWN']);
  await app.advance(3000);
  app.player.pos = 2345;
  await app.advance(3100);
  const again = await premiumHdr({ store: app.store, info: app.net.info, play: premiumOffer });
  await again.advance(4000);
  assert.ok(!again.player.current.grid);
  await again.press('CH_DOWN');   // another feed, before the multiview takes over
  await again.advance(1000);
  again.player.progress = true;
  await again.advance(5000);
  assert.ok(!again.player.current.grid, 'the viewer\'s feed stays');
});

test('in a multiview, Sound from picks the feed the commentary comes from, once the choice settles', async () => {
  const app = await premiumHdr({ play: premiumOffer });
  const grid = await playingBig2(app);
  assert.equal(grid.audio, grid.slots[0], 'at first the big feed\'s sound');
  const offers = [];
  app.net.play = (id, channel, opts) => { offers.push([channel, !!(opts && opts.hdrOnly)]); return premiumOffer(id, channel); };
  const loads = app.player.loads.length;
  await app.press('UP');
  await app.moveTo(/^Sound from/, ['UP', 'DOWN']);
  assert.match(app.focused(), /^Sound from‹ INTERNATIONAL/);
  await app.press('RIGHT');
  const shown = app.focused();
  await app.advance(1500);
  assert.equal(app.player.loads.length, loads, 'not while browsing');
  await app.advance(5000);
  assert.equal(app.player.loads.length, loads + 1, 'the multiview loads anew with that sound');
  const g = app.player.current.grid;
  assert.deepEqual(Array.from(g.slots), Array.from(grid.slots), 'the same feeds, in the same places');
  assert.equal(g.audio, grid.slots[1]);
  assert.equal(g.audioPos, 1);
  assert.doesNotMatch(shown, /INTERNATIONAL/, 'the next feed shown while browsing');
  // The sound's feed gets the full offer (licence, commentary); the others their HDR video alone.
  assert.deepEqual(offers.filter((o) => !o[1]).length, 1);
  // The choice is saved for a restart.
  await app.advance(3100);
  assert.equal(JSON.parse(app.store['f1tv.watching']).multiview.audio, grid.slots[1]);
});

test('subtitles: a box behind each line, and in a multiview at the bottom of the big feed', async () => {
  const app = await premiumHdr({ play: premiumOffer, settings: { subtitles: 'eng' } });
  await playingBig2(app);
  await app.advance(600);
  app.player.listeners.subtitle({ text: 'Box, box\nfor softs', ms: 3000 });
  const box = app.$('subtitle');
  assert.ok(!box.classList.contains('hidden'));
  assert.deepEqual(box.children.filter((c) => /sub-line/.test(c.className)).map((c) => c.textContent), ['Box, box', 'for softs']);
  assert.ok(box.classList.contains('mv'));
  // Big + 2: the big feed is the left two thirds; the lines sit centred on it, as wide as it allows.
  const big = app.context.MultiviewLayouts.onScreen('side2', 1920, 1080, 'center')[0];
  assert.equal(+box.style['--sub-x'].replace('px', ''), Math.round(big.left + big.width / 2));
  assert.ok(+box.style['--sub-width'].replace('px', '') < big.width);
  assert.equal(+box.style['--sub-bottom'].replace('px', ''), Math.round(1080 - (big.top + big.height - 6) + 28));
  // One feed again: the usual place.
  await app.press('UP');
  await app.pick(/^1VER/, ['DOWN']);
  await app.advance(600);
  assert.ok(!box.classList.contains('mv'));
});

test('the multiview page shows only the layouts the TV decodes and the offer has the feed sizes for', async () => {
  const layoutsShown = async (options) => {
    const app = await premiumHdr(options);
    await play(app, 'Race');
    await app.press('UP');
    await app.pick(/^Multiview/, ['UP']);
    return app.$('panel-list').children[1].children.map((t) => t.children.find((c) => /mv-name/.test(c.className)).textContent);
  };
  // This race has three feeds: Big + 2 and the pictures in picture.
  assert.deepEqual(await layoutsShown({}), ['One feed', 'Big + 2', 'Picture in picture ½', 'Picture in picture ⅓', 'Picture in picture ¼']);
  // An SDR offer (HEVC to 1080p): no layout with a 1620p or 2160p feed.
  assert.deepEqual(await layoutsShown({ heights: () => [270, 360, 540, 720, 1080] }), ['One feed', 'Big + 2', 'Picture in picture ½']);
  // A TV that decodes HEVC to 1920 wide: what fits in 1920x1080.
  const asked = [];
  assert.deepEqual(await layoutsShown({ hevcDecodes: (w, h, hdr) => { asked.push(hdr); return w <= 1920; } }), ['One feed', 'Picture in picture ½']);
  assert.ok(asked.length && asked.every((hdr) => hdr === false), 'the playing stream is SDR: the SDR picture is asked about');
});

test('no multiview row when the video has no HEVC to combine (older replays)', async () => {
  const app = await premiumHdr({ heights: () => [] });
  await play(app, 'Race');
  await app.press('UP');   // the first time, the playlist is read
  await app.press('BACK');
  assert.ok(app.$('panel').classList.contains('hidden'));
  await app.press('UP');
  assert.ok(!app.$('panel').classList.contains('hidden'));
  assert.ok(!app.$('panel-list').children.some((e) => /^Multiview/.test(e.textContent)));
});

test('a failed playlist read is tried again the next time watch options open', async () => {
  let reads = 0;
  const app = await premiumHdr({ heights: () => { reads++; if (reads === 1) throw new Error('offline'); return []; } });
  await play(app, 'Race');
  await app.press('UP');
  assert.ok(app.$('panel-list').children.some((e) => /^Multiview/.test(e.textContent)), 'unknown yet: offered');
  await app.press('BACK');
  await app.press('UP');   // read again: no HEVC
  await app.press('BACK');
  await app.press('UP');
  assert.equal(reads, 2);
  assert.ok(!app.$('panel-list').children.some((e) => /^Multiview/.test(e.textContent)));
});

test('multiview is offered whatever the account tier (F1\'s offers decide)', async () => {
  const app = await premiumHdr();
  app.api.state.location = { entitlement: 'PRO', groupId: 2 };
  await play(app, 'Race');
  await app.press('UP');
  assert.ok(app.$('panel-list').children.some((e) => /^Multiview/.test(e.textContent)));
});

test('the Up next card closes watch options, and BACK dismisses it', async () => {
  const app = await boot();
  await play(app, 'Pre-Race Show');
  app.player.trackList = { audio: [{ lang: 'eng' }, { lang: 'deu' }], text: [] };
  await app.press('UP');
  assert.ok(!app.$('panel').classList.contains('hidden'));
  app.player.listeners.ended();
  await app.advance(500);
  assert.ok(!app.$('upnext').classList.contains('hidden'));
  assert.ok(app.$('panel').classList.contains('hidden'), 'watch options still open over the card');
  await app.press('BACK');
  assert.ok(app.$('upnext').classList.contains('hidden'));
  await app.advance(12000);
  assert.equal(app.player.loads.length, 1, 'the next part started anyway');
});

test('spoiler-free mode shows replay artwork only as a tiny thumbnail, but live artwork in full', async () => {
  const app = await boot({ settings: { spoilerFree: true } });
  const tiles = app.$('rails').querySelectorAll('.tile');
  assert.equal(tiles.length, 5);
  for (const t of tiles) {
    const art = t.querySelector('.tile-art'), live = /^LIVE/.test(t.textContent);
    assert.equal(/spoiler/.test(art.className), !live, t.textContent);
    assert.equal(/w=384/.test(art.style.backgroundImage || ''), live, t.textContent);
  }
});

test('turning the timing overlay off in the account settings keeps the tower hidden', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Nicholas$/, ['RIGHT']);
  await app.pick(/^Live timing overlay/, ['DOWN']);
  assert.match(app.focused(), /Off$/);
  await app.press('BACK');
  app.timing.state = raceTiming;
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1800;
  await app.advance(1000);
  assert.equal(app.towerShown(), false);
  assert.match(app.$('osd-feed').textContent, /Lap 10\/58/);   // the lap still shows in the bar
});

test('the account settings offer 4K HDR on HDR TVs only, and switching it off is remembered', async () => {
  const plain = await boot();
  await plain.press('UP');
  await plain.pick(/^Nicholas$/, ['RIGHT']);
  assert.ok(!/4K HDR/.test(plain.$('screen-list').textContent), 'not on a TV without HDR');
  const app = await boot();
  app.player.hdrCapable = () => true;
  await app.press('UP');
  await app.pick(/^Nicholas$/, ['RIGHT']);
  await app.moveTo(/^4K HDR/, ['DOWN']);
  assert.match(app.focused(), /On$/);
  await app.press('ENTER');
  assert.match(app.focused(), /^4K HDR.*Off$/);
  assert.equal(app.context.Settings.get('hdr'), false);
});

// ---------- the timing tower ----------

const driverRow = (pos, tla, extra) => Object.assign({ num: String(pos), pos, tla, colour: '#123456', gap: '', interval: '', best: '',
  last: '', laps: 10 }, extra);

/** A race at lap 10 under the safety car: a leader, an interval, a car in the pits and one out. */
function busyRace(path) {
  if (path !== '2025/race/') return null;
  return { type: 'Race', name: 'Race', lap: 10, totalLaps: 58, track: '4', standings: [
    driverRow(1, 'VER', { gap: '', interval: '', tyre: 'M', tyreAge: 10, stops: 0, grid: 1 }),
    driverRow(2, 'NOR', { gap: '+1.234', interval: '+1.234', tyre: 'H', tyreAge: 0, tyreNew: true, stops: 1, grid: 4 }),
    driverRow(3, 'LEC', { gap: '+3.500', interval: '+2.266', pit: true, tyre: 'S', tyreAge: 3, stops: 1, grid: 2 }),
    driverRow(4, 'HAM', { out: true, grid: 3 })] };
}

/** Q2 with 8:00 left: P1 shows its best time, and a driver with only a Q1 time keeps it, dimmed. */
function quali(path) {
  if (path !== '2025/q/') return null;
  return { type: 'Qualifying', name: 'Qualifying', part: 2, remaining: 480, standings: [
    driverRow(1, 'PIA', { best: '1:22.800', gap: '', interval: '' }),
    driverRow(2, 'RUS', { best: '1:22.950', gap: '+0.150', interval: '+0.150' }),
    driverRow(3, 'ALO', { best: '1:23.400', gap: '+0.600', interval: '+0.450', old: true }),
    driverRow(4, 'SAI', { best: '1:23.500', gap: '+0.700', interval: '+0.100', pit: true })] };
}

const towerRows = (app) => app.$('tower-rows').children.map((r) => r.children.map((c) => c.textContent + (/(old|pit|up|down)$/.test(c.className) ? '(' + c.className.split(' ').pop() + ')' : '')).join(' '));

test('the race tower shows the lap, the safety car, intervals, a car in the pits and one out', async () => {
  const app = await boot();
  app.timing.state = busyRace;
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1800;
  await app.advance(1000);
  assert.equal(app.$('tower-label').textContent, 'Lap 10 / 58');
  assert.equal(app.$('tower-view').textContent, 'Interval');
  assert.equal(app.$('tower-flag').textContent, 'SC');
  assert.deepEqual(towerRows(app), ['1  VER Leader M', '2  NOR +1.234 H', '3  LEC In pit S', '4  HAM OUT']);
});

test('the tower views cycle in watch options: gap, laps, tyres, stops and places gained', async () => {
  const app = await boot();
  app.timing.state = busyRace;
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1800;
  await app.advance(1000);
  await app.press('UP');
  await app.moveTo(/^Live timing/, ['UP']);
  const seen = [];
  for (let i = 0; i < 7; i++) {
    await app.press('RIGHT');
    await app.advance(300);
    seen.push(app.towerShown() ? app.$('tower-view').textContent + ': ' + towerRows(app).slice(1, 3).join(' | ') : 'off');
  }
  assert.deepEqual(seen, [
    'Gap to leader: 2  NOR +1.234 H | 3  LEC In pit S',
    'Last lap: 2  NOR  H | 3  LEC  S',
    'Best lap: 2  NOR  H | 3  LEC  S',
    'Tyres: 2  NOR New H | 3  LEC 3 laps S',
    'Pit stops: 2  NOR 1 stop H | 3  LEC 1 stop S',
    'Positions: 2  NOR ▲ 2(up) H | 3  LEC ▼ 1(down) S',
    'off']);
});

test('the qualifying tower shows the part and clock, P1\'s time, and old times dimmed', async () => {
  const app = await boot();
  app.timing.state = quali;
  await play(app, 'Qualifying');
  app.timing.loaded();
  app.player.pos = 2400;
  await app.advance(1000);
  assert.equal(app.$('tower-label').textContent, 'Q2 8:00');
  assert.equal(app.$('tower-view').textContent, 'Gap to fastest');
  assert.deepEqual(towerRows(app), ['1  PIA 1:22.800', '2  RUS +0.150', '3  ALO +0.600(old)', '4  SAI +0.700(pit)']);
});

// ---------- seeking ----------

test('arrow presses preview a jump with growing steps, OK jumps there and BACK cancels', async () => {
  const app = await boot();
  app.timing.state = raceTiming;
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1000;
  await app.advance(500);
  // Quick presses: 10, 10, 15 s.
  await app.press('RIGHT', 'RIGHT', 'RIGHT');
  assert.match(app.$('osd-bubble').textContent, /^17:15/);
  assert.match(app.$('osd-bubble').textContent, /Lap 10/);   // the lap at that moment
  assert.equal(app.player.pos, 1000);                         // only a preview so far
  await app.press('ENTER');
  assert.equal(app.player.pos, 1035);
  app.player.progress = true;   // it plays on from there
  await app.advance(3000);
  assert.ok(app.$('spinner').classList.contains('hidden'));
  assert.doesNotMatch(app.$('osd-hint').textContent, /Jumping/);
  app.player.progress = false;
  const at = app.player.pos;
  // A preview dropped with BACK leaves the position alone.
  await app.press('LEFT', 'LEFT');
  await app.press('BACK');
  assert.equal(app.player.pos, at);
  assert.ok(app.$('osd-bubble').classList.contains('hidden'));
  assert.equal(app.screen(), 'player');
});

test('arrows while a stream loads do not seek from position 0', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.pos = 3000;
  const stream = deferred();
  app.net.play = () => stream.promise;
  await app.press('CH_DOWN');
  await app.press('RIGHT', 'RIGHT');
  assert.match(app.toast(), /Loading/);
  stream.resolve({ url: 'https://cdn/101/1033.m3u8', streamType: 'HLS' });
  await app.advance(500);
  assert.ok(app.player.pos > 2990, 'position ' + app.player.pos);
});

// ---------- live and signing in ----------

test('a live session asks whether to join live or start from the beginning', async () => {
  const app = await boot();
  await app.pick(/^LIVEPractice 1/);
  await app.advance(100);
  assert.match(app.$('feeds-sub').textContent, /LIVE now/);
  await app.pick(/^INTERNATIONAL/);
  assert.equal(app.$('dialog-title').textContent, 'Practice 1 is live');
  await app.press('ENTER');           // Watch live
  await app.advance(300);
  assert.equal(app.player.loads.at(-1).start, null);
  await app.press('BACK', 'BACK');
  await app.pick(/^INTERNATIONAL/);
  await app.press('RIGHT', 'ENTER');  // From the start
  await app.advance(300);
  assert.equal(app.player.loads.at(-1).start, 1015);   // just inside the DVR window
});

test('signed out, the app shows a pairing code and can browse; playing asks to sign in', async () => {
  const app = await boot({ signedOut: true });
  assert.equal(app.screen(), 'login');
  assert.equal(app.$('login-code').textContent, 'AB12CD');
  assert.match(app.focused(), /Browse without signing in/);
  await app.press('ENTER');
  await app.advance(500);
  assert.equal(app.screen(), 'browse');
  assert.equal(app.auth.cancelled, 1);
  assert.match(app.$('topnav').textContent, /Sign in$/);
  await app.pick(/^Race/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.equal(app.screen(), 'login');
  assert.equal(app.$('login-code').textContent, 'AB12CD');   // a fresh pairing
});

test('confirming the code on the phone signs in and opens Home', async () => {
  const app = await boot({ signedOut: true });
  app.auth.pairing.resolve('TOKEN');
  await app.advance(500);
  assert.equal(app.screen(), 'browse');
  assert.match(app.toast(), /Signed in as Nicholas/);
  assert.match(app.$('topnav').textContent, /Nicholas$/);
});

test('going back to the feed list offers to continue only from a position worth it', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.pos = 45;
  await app.advance(30000);   // saved every 30 s
  await app.stop();
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.equal(app.screen(), 'player', 'asked to continue from 0:45');
  app.player.pos = 7450;      // the last two minutes: finished
  await app.advance(30000);
  await app.stop();
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.equal(app.screen(), 'player', 'asked to continue a finished video');
  app.player.pos = 3600;
  await app.advance(30000);
  await app.stop();
  await app.pick(/^INTERNATIONAL/);
  assert.match(app.$('dialog-actions').textContent, /Continue from 1:00:00/);
});

// ---------- late answers (from the review) ----------

test('keys do nothing to the page left behind while the next tab loads', async () => {
  const app = await boot();
  const held = deferred();
  app.net.page = (uri) => (uri === '/archive' ? held.promise : Promise.resolve(PAGES[uri] || []));
  await app.press('UP');
  await app.pick(/^Archive$/, ['RIGHT']);
  let opened = 0;
  const video = app.net.video;
  app.net.video = (id) => { opened++; return video(id); };
  await app.press('DOWN', 'ENTER');
  await app.advance(300);
  assert.equal(opened, 0, 'opened a tile of the page that was replaced');
  assert.equal(app.screen(), 'browse');
});

test('BACK before the saved position arrives: nothing starts later', async () => {
  const app = await boot();
  const resume = deferred();
  app.net.resume = () => resume.promise;
  await app.pick(/^Race/);
  await app.advance(100);
  await app.press('ENTER');
  await app.press('BACK');
  assert.equal(app.screen(), 'browse');
  resume.resolve(1800);
  await app.advance(300);
  assert.equal(app.screen(), 'browse');
  assert.ok(app.$('dialog').classList.contains('hidden'), 'dialog over Home');
  assert.equal(app.player.loads.length, 0);
});

test('one video\'s late saved position does not start a feed of the video opened next', async () => {
  const app = await boot();
  const resume = deferred();
  app.net.resume = () => resume.promise;
  await app.pick(/^Race/);
  await app.advance(100);
  await app.press('ENTER');             // OK at once, on A's feed list
  await app.press('BACK');
  app.net.resume = () => Promise.resolve(0);
  await app.pick(/^Qualifying/);        // B's feed list
  await app.advance(100);
  assert.equal(app.screen(), 'feeds');
  resume.resolve(1800);
  await app.advance(300);
  assert.equal(app.screen(), 'feeds');
  assert.equal(app.player.loads.length, 0);
});

test('a timing answer for the video left behind is dropped once the next one plays', async () => {
  const app = await boot();
  app.timing.state = raceTiming;
  await play(app, 'Race');
  app.timing.loaded();
  app.player.pos = 1800;
  await app.advance(1000);
  assert.ok(app.towerShown());
  app.timing.hold = true;
  await app.advance(300);                // a tick asks the worker; the answer is held
  assert.ok(app.timing.held.length > 0);
  await app.press('BACK', 'BACK', 'BACK');
  app.timing.hold = false;
  const held = app.timing.held.splice(0);
  await app.pick(/^Qualifying/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.advance(500);
  app.timing.hold = true;                // keep Qualifying's own answers out
  app.timing.loaded();
  held.forEach((f) => f());              // the race's answers arrive now
  await app.advance(0);
  assert.equal(app.towerShown(), false, 'the race tower shows on qualifying');
});

test('progress is saved as the position in the video, and not while a switch to the main feed loads', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.pos = 3000;
  await app.advance(30000);
  assert.deepEqual(app.saved.map((a) => [a[0], a[1], a[2]]), [[101, 3000, 'REPLAY']]);
  app.saved.length = 0;
  await app.press('CH_DOWN');            // F1 LIVE
  await app.advance(500);
  const stream = deferred();
  app.net.play = () => stream.promise;
  await app.press('CH_UP');              // back to INTERNATIONAL (index 0), whose stream is slow
  await app.advance(30000);
  assert.deepEqual(app.saved, [], 'saved mid-switch');
});

test('BACK while a weekend page loads: it does not open over the calendar', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  const held = deferred(), page = app.net.page;
  app.net.page = (uri) => (uri === '/PAGE/1300' ? held.promise : page(uri));
  await app.press('ENTER');
  await app.press('BACK');
  assert.equal(app.$('list-title').textContent, 'Schedule');
  held.resolve([]);
  await app.advance(300);
  assert.equal(app.$('list-title').textContent, 'Schedule');
});

test('BACK while a driver page loads: it does not open over the standings', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Standings$/, ['RIGHT']);
  const held = deferred();
  app.net.season = () => held.promise;
  await app.pick(/^P2.*Oscar Piastri/, ['DOWN']);
  await app.press('BACK');
  assert.equal(app.$('list-title').textContent, 'Standings');
  held.resolve([]);
  await app.advance(300);
  assert.equal(app.$('list-title').textContent, 'Standings');
});

test('a failure that arrives after the viewer moved on is not written on the list shown now', async () => {
  const app = await boot();
  await app.press('UP');
  const held = deferred();
  app.net.standings = () => held.promise;
  await app.pick(/^Standings$/, ['RIGHT']);
  await app.press('BACK');
  app.net.standings = () => Promise.resolve({ round: 1, drivers: [] });
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  assert.equal(app.screen(), 'list');
  held.reject(new Error('HTTP 503'));
  await app.advance(300);
  assert.doesNotMatch(app.$('list-sub').textContent, /Could not load/);
});

// ---------- more from the review ----------

test('a feed asked for while an abandoned load finishes is dropped when the viewer goes back to Home', async () => {
  const app = await boot();
  await app.pick(/^Race/);
  await app.advance(100);
  const stream = deferred();
  app.net.play = () => stream.promise;
  await app.pick(/^INTERNATIONAL/);          // waits for its stream
  await app.press('BACK', 'BACK');           // bar, then stop: back on the feed list, the load still out
  assert.equal(app.screen(), 'feeds');
  await app.press('ENTER');                  // picked again: starts immediately despite the abandoned load
  await app.stop();
  await app.press('BACK');                   // and back to Home after all
  assert.equal(app.screen(), 'browse');
  stream.resolve({ url: 'https://cdn/101/main.m3u8', streamType: 'HLS' });
  app.net.play = (id, ch) => Promise.resolve({ url: 'https://cdn/' + id + '/' + (ch || 'main') + '.m3u8', streamType: 'HLS' });
  await app.advance(2000);
  assert.equal(app.screen(), 'browse');
  assert.equal(app.player.loads.length, 0);
});

test('two quick switches where the second fails leave the playing feed current', async () => {
  const app = await boot();
  await play(app, 'Race');
  app.player.pos = 3000;
  const first = deferred();
  let n = 0;
  app.net.play = (id, ch) => (++n === 1 ? first.promise : Promise.reject(new Error('Not available')));
  await app.press('CH_DOWN');                // to F1 LIVE: waits
  await app.press('CH_DOWN');                // on to the onboard: queued, then fails
  first.resolve({ url: 'https://cdn/101/1033.m3u8', streamType: 'HLS' });
  await app.advance(1500);
  assert.match(app.toast(), /Could not play: Not available/);
  assert.equal(app.player.current.url, 'https://cdn/101/main.m3u8');
  assert.match(app.$('osd-feed').textContent, /^INTERNATIONAL/);
  app.net.play = (id, ch) => Promise.resolve({ url: 'https://cdn/' + id + '/' + (ch || 'main') + '.m3u8', streamType: 'HLS' });
  await app.press('CH_DOWN');
  await app.advance(500);
  assert.equal(app.player.loads.at(-1).url, 'https://cdn/101/1033.m3u8');
});

test('two OK presses before the saved position arrives start the video once', async () => {
  const app = await boot();
  const resume = deferred();
  app.net.resume = () => resume.promise;
  let plays = 0;
  const play0 = app.net.play;
  app.net.play = (...a) => { plays++; return play0(...a); };
  await app.pick(/^Race/);
  await app.advance(100);
  await app.press('ENTER', 'ENTER');
  resume.resolve(0);
  await app.advance(1000);
  assert.equal(app.screen(), 'player');
  assert.equal(plays, 1);
  assert.equal(app.player.loads.length, 1);
});

test('a saved-position lookup that never answers holds OK back for 3 s at most', async () => {
  const app = await boot();
  app.net.resume = () => new Promise(() => {});
  await app.pick(/^Race/);
  await app.advance(100);
  await app.press('ENTER');
  await app.advance(3100);
  assert.equal(app.screen(), 'player');
  assert.equal(app.player.loads.length, 1);
});

test('the Up next card for a part not on air yet does not keep closing watch options', async () => {
  const later = (NOW / 1000) + 3600;
  const upcoming = { ...event(101, 'Race', 'FOM_SESSION_9839', later) };
  upcoming.metadata = { ...upcoming.metadata, contentSubtype: 'LIVE_EVENT' };
  upcoming.metadata.emfAttributes = { ...upcoming.metadata.emfAttributes, sessionEndDate: String((later + 7200) * 1000) };
  const app = await boot({ pages: { '/PAGE/1252': [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{
    eventName: 'ALL', events: [event(104, 'Pre-Race Show', 'FOM_SESSION_9839001', RACE_START - 3600), upcoming] }] } } }] } });
  await play(app, 'Pre-Race Show');
  app.player.listeners.ended();
  await app.advance(500);
  assert.match(app.$('upnext-sub').textContent, /^Starts /);
  app.player.trackList = { audio: [{ lang: 'eng' }, { lang: 'deu' }], text: [] };
  await app.press('UP');
  assert.ok(!app.$('panel').classList.contains('hidden'));
  for (let i = 0; i < 7; i++) {   // in use for 35 s (a key every 5 s keeps it open)
    await app.advance(5000);
    assert.ok(!app.$('panel').classList.contains('hidden'), 'the 30 s refresh closed watch options');
    await app.press('DOWN');
  }
});

test('a live feed switch without the new feed\'s manifest facts goes to live, not to the old position', async () => {
  const app = await boot();
  await app.pick(/^LIVEPractice 1/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.press('ENTER');              // Watch live
  await app.advance(300);
  app.player.pos = 4500;
  app.net.info = () => Promise.reject(new Error('HTTP 503'));
  await app.press('CH_DOWN');
  await app.advance(500);
  assert.equal(app.player.loads.at(-1).start, null);
});

test('a driver\'s Grand Prix still to come shows its sprint without a trailing separator', async () => {
  const app = await boot();
  app.net.season = () => Promise.resolve([{ round: 20, name: 'Mexico City GP', pos: null, posText: '', grid: null, points: 0, status: '',
    fastest: false, quali: null, sprint: { pos: 2, points: 7 }, pending: true }]);
  await app.press('UP');
  await app.pick(/^Standings$/, ['RIGHT']);
  await app.pick(/^P1.*Lando Norris/, ['DOWN']);
  await app.advance(200);
  const row = app.$('list-inner').querySelectorAll('.list-row')[0];
  assert.equal(row.textContent, 'R20Mexico City GP  ·  Grand Prix to comesprint P2 (+7)+7 pts');
});

test('"tomorrow" is the next calendar day, also across the spring clock change', async () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Europe/Oslo';
  try {
    // Saturday 28 March 2026, 23:30 in Oslo; the clocks go forward at 02:00.
    const at = (iso) => Date.parse(iso) / 1000;
    const app = await boot({ now: Date.parse('2026-03-28T22:30:00Z'), pages: { '/home': [{ layout: 'interactive_schedule', retrieveItems: {
      resultObj: { containers: [{ eventName: 'ALL', events: [
        { ...event(201, 'Race', 'R', at('2026-03-29T13:00:00Z')), metadata: { ...event(201, 'Race', 'R', at('2026-03-29T13:00:00Z')).metadata, contentSubtype: 'LIVE_EVENT' } },
        { ...event(202, 'F1 Show', 'S', at('2026-03-30T13:00:00Z')), metadata: { ...event(202, 'F1 Show', 'S', at('2026-03-30T13:00:00Z')).metadata, contentSubtype: 'LIVE_EVENT' } }] }] } } }] } });
    const badges = app.$('rails').querySelectorAll('.tile-badge').map((b) => b.textContent);
    assert.deepEqual(badges, ['Tomorrow 15:00', 'Mon 30 Mar 15:00']);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

// ---------- live playback ----------

/** Plays Practice 1 live (Watch live), on the given engine. */
async function playLive(app, kind) {
  app.player.kind = kind || 'shaka';
  app.player.live = true;
  await app.pick(/^LIVEPractice 1/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.press('ENTER');   // Watch live
  await app.advance(300);
  assert.equal(app.screen(), 'player');
}

test('the LIVE button goes back to live from behind it', async () => {
  const app = await boot();
  await playLive(app);
  app.player.pos = 3000;      // 26:40 behind live
  await app.advance(600);
  assert.equal(app.$('osd-live').textContent, 'GO LIVE ▶▶');
  assert.match(app.$('osd-dur').textContent, /26:40 behind live/);
  await app.press('DOWN', 'ENTER');
  await app.advance(300);
  assert.equal(app.player.loads.length, 2);
  assert.equal(app.player.loads.at(-1).start, null);   // at live
});

test('watch options offer Go to live while behind it', async () => {
  const app = await boot();
  await playLive(app);
  app.player.pos = 3000;
  await app.press('UP');
  assert.match(app.$('panel-list').children[0].textContent, /^Go to live−26:40$/);
  await app.moveTo(/^Go to live/, ['UP']);
  await app.press('ENTER');
  await app.advance(300);
  assert.equal(app.player.loads.length, 2);
  assert.equal(app.player.loads.at(-1).start, null);
});

test('a jump on a live stream played by AVPlay reopens the stream at that moment', async () => {
  const app = await boot();
  await playLive(app, 'avplay');
  app.player.pos = 4500;
  await app.press('LEFT', 'LEFT', 'ENTER');   // 20 s back
  await app.advance(300);
  assert.equal(app.player.loads.length, 2);
  assert.equal(Math.round(app.player.loads.at(-1).start), 4480);
});

test('a live session that has not started yet says when it starts, and stays on the feed list', async () => {
  const app = await boot();
  app.net.play = () => Promise.reject(new Error('Content is pre-live'));
  await app.pick(/^LIVEPractice 1/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.press('ENTER');
  await app.advance(300);
  assert.equal(app.screen(), 'feeds');
  assert.match(app.toast(), /^Practice 1 hasn't started yet\./);
});

test('a live broadcast that F1 no longer lists as live, past its scheduled end, closes with a countdown', async () => {
  const app = await boot();
  await playLive(app);
  app.player.pos = 4590;      // at live: past the scheduled end
  app.player.progress = true;
  await app.advance(5000);
  assert.ok(app.$('upnext').classList.contains('hidden'), 'closed while F1 still lists it as live (overrunning)');
  const replay = JSON.parse(JSON.stringify(VIDEOS[106]));
  replay.contentSubtype = 'REPLAY';
  app.net.video = () => Promise.resolve({ metadata: replay });
  await app.advance(31000);   // checked again every 30 s
  await app.advance(15000);   // and offered once the viewer's moment (29 s behind real time) reaches the end
  assert.equal(app.$('upnext-label').textContent, 'Broadcast ended');
  assert.match(app.$('upnext-sub').textContent, /^Closing in \d+ s$/);
  await app.advance(11000);
  assert.equal(app.screen(), 'feeds');
});

// ---------- signing in again, pages, charts ----------

test('an expired session is renewed with the device key before playing', async () => {
  const app = await boot();
  await app.pick(/^Race/);
  await app.advance(100);
  app.api.state.entitlement = null;           // the stored token no longer works
  let logins = 0;
  app.net.login = () => (++logins === 1 ? Promise.reject(new Error('HTTP 401')) : Promise.resolve());
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.equal(logins, 2);                    // the stored token, then the renewed one
  assert.equal(app.screen(), 'player');
  assert.equal(app.player.loads.length, 1);
});

test('a session that cannot be renewed asks to sign in again', async () => {
  const app = await boot({ signedOut: true });
  await app.press('ENTER');                   // browse without signing in
  await app.advance(300);
  await app.pick(/^Race/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.equal(app.screen(), 'login');
  assert.equal(app.player.loads.length, 0);
});

test('BACK through nested archive pages returns to the tile each was opened from', async () => {
  const app = await boot({ pages: { '/archive': [rail('Seasons', [pageItem('2026 Season', '/PAGE/2026'), pageItem('2025 Season', '/PAGE/2025')])],
    '/PAGE/2026': [rail('Meetings', [meetingItem('1297', 'United States Grand Prix', '/PAGE/1297')])] } });
  await app.press('UP');
  await app.pick(/^Archive$/, ['RIGHT']);
  await app.pick(/^2025 Season/, ['DOWN', 'RIGHT']);
  assert.equal(app.$('page-title').textContent, '2025 Season');
  await app.pick(/^Abu Dhabi Grand Prix/, ['DOWN']);
  assert.equal(app.$('page-title').textContent, 'Abu Dhabi Grand Prix');
  await app.press('BACK');
  assert.equal(app.$('page-title').textContent, '2025 Season');
  assert.match(app.focused(), /^Abu Dhabi Grand Prix/);
  await app.press('BACK');
  assert.equal(app.$('page-title').textContent, '');
  assert.match(app.focused(), /^2025 Season/);
});

test('the championship chart draws the rounds and steps through them', async () => {
  const app = await boot();
  const progress = { rounds: [{ round: 1, name: 'Australian GP' }, { round: 2, name: 'Chinese GP' }],
    drivers: { norris: { perRound: { 1: 25, 2: 18 } }, piastri: { perRound: { 1: 18, 2: 25 } } },
    teams: { mclaren: { perRound: { 1: 43, 2: 43 } } } };
  app.stats.seasonProgress = async () => progress;
  await app.press('UP');
  await app.pick(/^Standings$/, ['RIGHT']);
  await app.press('ENTER');
  assert.equal(app.screen(), 'chart');
  assert.match(app.$('chart-readout').textContent, /^Round 2Chinese GP1NOR43/);
  await app.press('LEFT');
  assert.match(app.$('chart-readout').textContent, /^Round 1Australian GP1NOR25\+25/);
  await app.press('DOWN');    // constructors
  assert.match(app.$('chart-sub').textContent, /^Top 6 constructors/);
  assert.match(app.$('chart-readout').textContent, /MCL43/);
});

test('commentary offered as team radio is named so', async () => {
  const app = await boot({ settings: { audio: 'teamradio' } });
  await play(app, 'Race');
  app.player.trackList = { audio: [{ lang: 'eng' }, { lang: 'teamradio' }], text: [] };
  await app.press('UP');
  assert.match(app.$('panel-list').textContent, /Commentary‹ Team radio ›/);
});

test('a race titled "Race Replay" gets its timing', async () => {
  const replay = JSON.parse(JSON.stringify(VIDEOS[101]));
  replay.titleBrief = 'Race Replay';
  const app = await boot();
  app.net.video = (id) => Promise.resolve({ metadata: id === 101 ? replay : JSON.parse(JSON.stringify(VIDEOS[id])) });
  await play(app, 'Race');
  await app.advance(500);
  assert.equal(app.timing.workers.at(-1).path, '2025/race/');
  // A race's tower views, from the start (before the timing data says it is a race).
  await app.press('UP');
  assert.match(app.$('panel-list').textContent, /Live timing‹ Interval ›/);
});

test('a saved position from F1 in the first minute or the last two is not offered', async () => {
  for (const [saved, offered] of [[45, false], [7450, false], [1800, true]]) {
    const app = await boot();
    app.net.resume = () => Promise.resolve(saved);
    await app.pick(/^Race/);
    await app.advance(100);
    assert.equal(/Watched to/.test(app.$('feeds-sub').textContent), offered, String(saved));
    await app.press('ENTER');
    await app.advance(300);
    assert.equal(app.screen(), offered ? 'feeds' : 'player', String(saved));
  }
});

// ---------- menus, lists and sign-in (from the second review) ----------

// A replay event of a weekend's broadcast schedule, and a weekend page made of events.
const replay = (id, title, house, start) => {
  const e = event(id, title, house, start);
  e.metadata.pictureUrl = 'art-' + id;
  return e;
};
const weekendPage = (events) => [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{ eventName: 'ALL', events }] } } }];

test('the Home refresh keeps the focus on the same video when a tile is added before it', async () => {
  const app = await boot();
  await app.press('RIGHT');                       // Race -> Qualifying
  assert.match(app.focused(), /^Qualifying/);
  const before = PAGES['/home'];
  app.net.page = (uri) => Promise.resolve(uri === '/home'
    ? [rail('Latest', [tileItem(999, 'Race Highlights'), ...before[0].retrieveItems.resultObj.containers])] : []);
  await app.advance(125000);
  assert.match(app.focused(), /^Qualifying/, 'focus moved to: ' + app.focused());
});

test('the Home refresh keeps the focus on the same video when a rail appears above it', async () => {
  const app = await boot({ pages: { '/home': [rail('Latest', [tileItem(101, 'Race'), tileItem(103, 'Qualifying')]),
    rail('Shows', [tileItem(102, 'McLaren Show', 'SHOW'), tileItem(104, 'Pre-Race Show')])] } });
  await app.press('DOWN');                         // rail "Shows"
  assert.match(app.focused(), /^McLaren Show/);
  const old = await app.net.page('/home');
  app.net.page = (uri) => Promise.resolve(uri === '/home' ? [rail('Breaking', [tileItem(500, 'Breaking news')]), ...old] : []);
  await app.advance(125000);
  assert.match(app.focused(), /^McLaren Show/, 'focus moved to: ' + app.focused());
});

test('BACK on the sign-in screen opened from the Sign in tab returns to Home', async () => {
  const app = await boot({ signedOut: true });
  await app.press('ENTER');                        // Browse without signing in
  await app.advance(300);
  await app.press('UP');
  await app.pick(/^Sign in$/, ['RIGHT']);
  await app.advance(100);
  assert.equal(app.screen(), 'login');
  await app.press('BACK');
  assert.equal(app.exits.length, 0, 'BACK exited the app');
  assert.equal(app.screen(), 'browse');
});

test('"Sign in to watch." stays on the sign-in screen once the code arrives', async () => {
  const app = await boot({ signedOut: true });
  await app.press('ENTER');
  await app.advance(300);
  await app.pick(/^Race/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.equal(app.screen(), 'login');
  assert.match(app.$('login-status').textContent, /Sign in to watch/);
});

test('BACK from Standings opened from the Archive tab returns to Archive', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Archive$/, ['RIGHT']);
  assert.match(app.$('rails').textContent, /2025 Season/);
  await app.press('UP');
  await app.pick(/^Standings$/, ['LEFT', 'RIGHT']);
  assert.equal(app.screen(), 'list');
  await app.press('BACK');
  assert.equal(app.screen(), 'browse');
  assert.match(app.$('rails').textContent, /2025 Season/, 'back on: ' + app.$('rails').textContent.slice(0, 60));
});

test('a meeting without dates comes last in Schedule, with no badge', async () => {
  const app = await boot({ pages: { '/season': [rail('Season', [
    meetingItem2('1297', 'United States Grand Prix', 'United States', '/PAGE/1297', '2026-10-23T00:00:00Z', '2026-10-25T23:59:59Z', '19'),
    meetingItem2('1400', 'Brazilian Grand Prix', 'Brazil', '/PAGE/1400', undefined, undefined, '21'),
    meetingItem2('1300', 'Mexico City Grand Prix', 'Mexico', '/PAGE/1300', '2026-10-30T00:00:00Z', '2026-11-01T23:59:59Z', '20')])] } });
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  const text = app.$('list-inner').textContent;
  assert.doesNotMatch(text, /Brazil.*Replays/, text);
});

test('a meeting with only an end date does not take the focus as this weekend', async () => {
  const app = await boot({ pages: { '/season': [rail('Season', [
    meetingItem2('1400', 'Brazilian Grand Prix', 'Brazil', '/PAGE/1400', undefined, '2026-11-15T23:59:59Z', '21'),
    meetingItem2('1300', 'Mexico City Grand Prix', 'Mexico', '/PAGE/1300', '2026-10-30T00:00:00Z', '2026-11-01T23:59:59Z', '20')])] } });
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  assert.doesNotMatch(app.$('list-inner').textContent, /Brazil.*This weekend/, app.$('list-inner').textContent);
});

test('spoiler-free: a replay opened from a weekend list shows its artwork blurred on the feed list', async () => {
  const app = await boot({ settings: { spoilerFree: true }, pages: { '/PAGE/1297': weekendPage([
    replay(105, 'Race', 'FOM_SESSION_11396', Date.parse('2026-10-25T19:00:00Z') / 1000)]) } });
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  await app.pick(/^Round 19United States/, ['UP']);   // opens the weekend
  await app.advance(100);
  await app.pick(/^\d\d:\d\dRace/, ['DOWN']);       // the replay
  await app.advance(100);
  assert.equal(app.screen(), 'feeds');
  const hero = app.$('feeds-hero');
  assert.ok(/spoiler/.test(hero.className), 'feeds hero is not blurred: ' + hero.className);
  assert.doesNotMatch(hero.style.backgroundImage || '', /w=1920/, 'full size artwork: ' + hero.style.backgroundImage);
});

test('spoiler-free: the next part that Up next opens shows its artwork blurred', async () => {
  const app = await boot({ settings: { spoilerFree: true }, pages: { '/PAGE/1252': weekendPage([
    replay(104, 'Pre-Race Show', 'FOM_SESSION_9839001', RACE_START - 3600), replay(101, 'Race', 'FOM_SESSION_9839', RACE_START - 300)]) } });
  await play(app, 'Pre-Race Show');
  app.player.pos = 3590;
  app.player.listeners.ended();
  await app.advance(11000);
  // The race is now loading or playing; its feed list screen state was built with the same hero.
  const hero = app.$('feeds-hero');
  assert.ok(/spoiler/.test(hero.className), 'feeds hero is not blurred: ' + hero.className + ' ' + hero.style.backgroundImage);
});

test('Standings > team > driver: BACK returns to the driver that was opened', async () => {
  const app = await boot();
  app.net.standings = () => Promise.resolve({ round: 19, drivers: [
    { pos: 1, code: 'NOR', first: 'Lando', last: 'Norris', team: 'McLaren', teamId: 'mclaren', points: 323, wins: 6, id: 'norris', number: '4' },
    { pos: 2, code: 'PIA', first: 'Oscar', last: 'Piastri', team: 'McLaren', teamId: 'mclaren', points: 300, wins: 5, id: 'piastri', number: '81' }] });
  await app.press('UP');
  await app.pick(/^Standings$/, ['RIGHT']);
  await app.pick(/^P1McLaren/, ['DOWN']);           // the team
  await app.advance(100);
  assert.equal(app.$('list-title').textContent, 'McLaren');
  await app.press('DOWN');                          // Piastri
  assert.match(app.focused(), /Oscar Piastri/);
  await app.press('ENTER');
  await app.advance(100);
  assert.equal(app.$('list-title').textContent, 'Oscar Piastri');
  await app.press('BACK');
  assert.equal(app.$('list-title').textContent, 'McLaren');
  assert.match(app.focused(), /Oscar Piastri/, 'focus: ' + app.focused());
});

test('BACK on the Archive tab goes to Home, and BACK on Home exits', async () => {
  const app = await boot();
  await app.press('UP');
  await app.pick(/^Archive$/, ['RIGHT']);
  await app.press('BACK');
  assert.equal(app.exits.length, 0, 'BACK on Archive exited the app');
});

test('a session refused during a feed switch stops the video before asking to sign in', async () => {
  const app = await boot();
  await app.pick(/^Race/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.equal(app.screen(), 'player');
  assert.ok(app.player.engine);
  app.api.state.entitlement = null;
  app.net.login = () => Promise.reject(new Error('HTTP 401'));
  app.context.Auth.renew = async () => null;
  await app.press('CH_DOWN');
  await app.advance(500);
  assert.equal(app.screen(), 'login');
  assert.equal(app.player.engine, null, 'the old stream is still playing (audio) under the sign-in screen');
});

test('the feed list of a session that starts later says when, not LIVE now', async () => {
  const start = NOW / 1000 + 3 * 3600;
  const e = event(106, 'Practice 1', 'FOM_SESSION_11400', start);
  e.metadata.contentSubtype = 'LIVE_EVENT';
  e.metadata.emfAttributes.sessionEndDate = String((start + 3600) * 1000);
  const app = await boot({ pages: { '/home': [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{ eventName: 'ALL', events: [e] }] } } }] } });
  app.net.video = () => Promise.resolve({ metadata: { ...JSON.parse(JSON.stringify(VIDEOS[106])), contentSubtype: 'LIVE_EVENT',
    emfAttributes: { ...VIDEOS[106].emfAttributes, sessionStartDate: String(start * 1000) } } });
  await app.pick(/Practice 1/);
  await app.advance(200);
  assert.equal(app.screen(), 'feeds');
  assert.doesNotMatch(app.$('feeds-sub').textContent, /LIVE now/, app.$('feeds-sub').textContent);
  assert.match(app.$('feeds-sub').textContent, /Starts/, app.$('feeds-sub').textContent);
});

test('a weekend schedule without start times says that nothing is published', async () => {
  const app = await boot({ pages: { '/PAGE/1297': [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{ eventName: 'ALL', events: [
    { id: 5, metadata: { contentId: 5, titleBrief: 'Race', emfAttributes: {} } }] }] } } }] } });
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  await app.pick(/^Round 19United States/, ['UP']);
  await app.advance(100);
  assert.match(app.$('list-sub').textContent, /No broadcast schedule/);
});

test('a This weekend tile without a series has no leading separator', async () => {
  const start = NOW / 1000 + 3 * 3600;
  const e = event(106, 'Practice 1', 'FOM_SESSION_11400', start);
  e.metadata.contentSubtype = 'LIVE_EVENT';
  delete e.metadata.emfAttributes.Series;
  const app = await boot({ pages: { '/home': [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{ eventName: 'ALL', events: [e] }] } } }] } });
  const sub = app.$('rails').querySelectorAll('.tile-sub')[0].textContent;
  assert.doesNotMatch(sub, /^ · /, JSON.stringify(sub));
});

test('the Schedule header names the season the menu lists', async () => {
  const app = await boot({ now: Date.parse('2027-01-05T12:00:00Z'), pages: { '/season': [rail('Season', [
    meetingItem2('1297', 'United States Grand Prix', 'United States', '/PAGE/1297', '2026-10-23T00:00:00Z', '2026-10-25T23:59:59Z', '19')])] } });
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  assert.match(app.$('list-sub').textContent, /^2026 season/, app.$('list-sub').textContent);
});

test('the update notice does not send a signed-out viewer to an About page', async () => {
  const app = await boot({ signedOut: true });
  app.context.Updates.check = async () => ({ available: true, latest: '1.3.0', current: '1.0.0', page: 'https://github.com/nicbra/f1tv-tizen' });
  app.context.Updates.noticeToday = () => true;
  await app.press('ENTER');            // Browse without signing in
  await app.advance(300);
  assert.match(app.$('topnav').textContent, /Sign in$/);
  assert.equal(app.toast(), 'App update available: v1.3.0');
  assert.ok(app.$('toast').classList.contains('notice'));
});

test('automatic and manual update notices use two lines and the notice style', async () => {
  const app = await boot({ releases: [{ tag_name: 'v1.3.0', body: 'New features' }] });
  assert.equal(app.toast(), 'App update available: v1.3.0\nDetails in the settings');
  assert.ok(app.$('toast').classList.contains('notice'));
  await app.press('UP');
  await app.pick(/^Nicholas$/, ['RIGHT']);
  await app.pick(/^Version 1\.0\.0/, ['DOWN']);
  await app.pick(/^Check for updates now/, ['DOWN']);
  assert.equal(app.toast(), 'App update available: v1.3.0\nDetails in the settings');
  assert.ok(app.$('toast').classList.contains('notice'));
  assert.equal(app.requests.filter((url) => /api\.github\.com/.test(url)).length, 2);
  const css = readFileSync('app/css/style.css', 'utf8');
  assert.match(css, /\.toast\s*\{[^}]*white-space:\s*pre-line/);
});

test('About opens the version submenu with all releases, install instructions and BACK focus', async () => {
  for (const source of ['installer', 'apps2samsung']) {
    const app = await boot({
      installMarker: source === 'installer' ? JSON.stringify({ installedBy: source, version: '1.0.0' }) : '',
      releases: [
        { tag_name: 'v1.2.0', body: '## Playback\n\n- **Fixed** [audio](https://example.test/audio).' },
        { tag_name: 'v0.9.0', body: 'Older release' },
        { tag_name: 'v1.10.0', body: '## Features\n\n- Better `navigation`.\n- Fixed audio.' },
        { tag_name: 'v1.0.0', body: 'Running release' }
      ]
    });
    await app.press('UP');
    await app.pick(/^Nicholas$/, ['RIGHT']);
    const version = app.$('list-inner').querySelectorAll('.list-row').find((row) => /^Version /.test(row.textContent));
    assert.equal(version.textContent, 'Version 1.0.0Update is available to v1.10.0');
    assert.equal(version.querySelector('.badge'), null);
    assert.doesNotMatch(app.$('list-inner').textContent, /What's new|Check for updates now|Release notes|Run the installer|Update from Apps2Samsung/);
    assert.match(app.$('list-inner').textContent, /Automatic update checks/);
    await app.pick(/^Version 1\.0\.0/, ['DOWN']);
    assert.equal(app.$('list-title').textContent, 'F1 TV 1.0.0');
    assert.deepEqual(app.$('list-inner').children.map((row) => row.textContent), [
      'Check for updates now', 'Release notes', 'v1.10.0New', 'v1.2.0New', 'v1.0.0Installed', 'v0.9.0'
    ]);
    assert.doesNotMatch(app.$('list-inner').textContent, /Automatic update checks/);
    assert.equal(app.$('list-sub').textContent, 'Update available: v1.10.0 · ' + (source === 'installer'
      ? 'Run the installer from github.com/nicbra/f1tv-tizen on your computer again.' : 'Update from Apps2Samsung.'));
    await app.press('DOWN', 'ENTER');
    assert.equal(app.$('dialog-title').textContent, 'F1 TV 1.10.0');
    assert.equal(app.$('dialog-text').textContent, 'Features\n\n• Better navigation.\n• Fixed audio.');
    assert.equal(app.$('dialog-actions').textContent, 'Close');
    assert.equal(app.focused(), 'Close');
    await app.press('ENTER');
    assert.ok(app.$('dialog').classList.contains('hidden'));
    assert.equal(app.focused(), 'v1.10.0New');
    await app.pick(/^v1\.0\.0/, ['DOWN']);
    assert.equal(app.$('dialog-text').textContent, 'Running release');
    await app.press('BACK');
    assert.equal(app.$('list-title').textContent, 'F1 TV 1.0.0');
    assert.equal(app.focused(), 'v1.0.0Installed');
    await app.press('DOWN', 'ENTER');
    assert.equal(app.$('dialog-text').textContent, 'Older release');
    await app.press('BACK', 'BACK');
    assert.equal(app.$('list-title').textContent, 'Nicholas');
    assert.equal(app.focused(), 'Version 1.0.0Update is available to v1.10.0');
    assert.equal(app.requests.filter((url) => /api\.github\.com/.test(url)).length, 1, 'navigation uses cached releases');
    await app.press('BACK');
    assert.equal(app.screen(), 'browse');
  }
});

test('the version row remains selectable when up to date, with installed and older notes', async () => {
  const app = await boot({ releases: [{ tag_name: 'v0.9.0' }, { tag_name: 'v1.0.0', body: 'Current notes' }] });
  await app.press('UP');
  await app.pick(/^Nicholas$/, ['RIGHT']);
  await app.moveTo(/^Version 1\.0\.0/, ['DOWN']);
  assert.equal(app.focused(), 'Version 1.0.0Up to date · github.com/nicbra/f1tv-tizen');
  await app.press('ENTER');
  assert.equal(app.$('list-sub').textContent, 'Up to date');
  assert.deepEqual(app.$('list-inner').children.map((row) => row.textContent), [
    'Check for updates now', 'Release notes', 'v1.0.0Installed', 'v0.9.0'
  ]);
  await app.pick(/^v0\.9\.0/, ['DOWN']);
  assert.equal(app.$('dialog-title').textContent, 'F1 TV 0.9.0');
  assert.equal(app.$('dialog-text').textContent, 'No release notes provided.');
});

test('check-now redraws the version submenu, preserves focus and keeps the existing result toasts', async () => {
  const app = await boot({ releases: [{ tag_name: 'v1.0.0' }] });
  await app.press('UP');
  await app.pick(/^Nicholas$/, ['RIGHT']);
  await app.pick(/^Version /, ['DOWN']);
  const pending = deferred();
  app.context.Updates.check = (force) => { assert.equal(force, true); return pending.promise; };
  await app.press('ENTER');
  assert.equal(app.focused(), 'Checking for updates…');
  assert.equal(app.toast(), 'Checking for updates…');
  await app.press('ENTER');          // no duplicate check while pending
  await app.press('DOWN');           // keep the viewer's focus if they move during the check
  app.context.Updates.status = () => ({ current: '1.0.0', latest: '1.2.0', available: true,
    releases: [{ version: '1.2.0', notes: 'New notes' }, { version: '1.0.0' }], page: 'https://github.com/nicbra/f1tv-tizen' });
  pending.resolve({ current: '1.0.0', latest: '1.2.0', available: true });
  await app.advance(100);
  assert.equal(app.$('list-title').textContent, 'F1 TV 1.0.0');
  assert.equal(app.focused(), 'v1.2.0New');
  assert.equal(app.toast(), 'App update available: v1.2.0\nDetails in the settings');
  await app.press('BACK');
  assert.equal(app.focused(), 'Version 1.0.0Update is available to v1.2.0');
  await app.press('ENTER');
  for (const [result, message] of [
    [{ error: true }, 'Could not check for updates.'],
    [{ current: '1.0.0' }, 'F1 TV 1.0.0 is up to date.'],
    [{ latest: '1.2.0' }, 'Latest release: F1 TV 1.2.0. Could not read the installed version.']
  ]) {
    app.context.Updates.check = async () => result;
    await app.press('ENTER');
    assert.equal(app.focused(), 'Check for updates now');
    assert.equal(app.$('list-title').textContent, 'F1 TV 1.0.0');
    assert.equal(app.toast(), message);
  }
});

test('a check completed after BACK does not reopen the version submenu', async () => {
  const app = await boot({ releases: [{ tag_name: 'v1.0.0' }] });
  await app.press('UP');
  await app.pick(/^Nicholas$/, ['RIGHT']);
  await app.pick(/^Version /, ['DOWN']);
  const pending = deferred();
  app.context.Updates.check = () => pending.promise;
  await app.press('ENTER', 'BACK');
  pending.resolve({ current: '1.0.0' });
  await app.advance(100);
  assert.equal(app.$('list-title').textContent, 'Nicholas');
  assert.match(app.focused(), /^Version /);
});

test('long release notes scroll with UP and DOWN and return to the Close button', async () => {
  const app = await boot({ releases: [{ tag_name: 'v1.3.0', body: ('- A release note.\n').repeat(100) }] });
  await app.press('UP');
  await app.pick(/^Nicholas$/, ['RIGHT']);
  await app.pick(/^Version /, ['DOWN']);
  const text = app.$('dialog-text');
  text.clientHeight = 560;
  text.scrollHeight = 1230;           // fake the constrained text box's layout
  await app.press('DOWN', 'ENTER');
  assert.equal(app.focused(), 'Close');
  assert.equal(text.scrollTop, 0);
  await app.press('UP', 'DOWN');
  assert.ok(text.classList.contains('focused'));
  assert.equal(text.scrollTop, 100);
  await app.press('UP', 'UP');
  assert.equal(text.scrollTop, 0);
  await app.press('ENTER');           // OK on the text does not close the dialog
  assert.ok(!app.$('dialog').classList.contains('hidden'));
  for (let i = 0; i < 7; i++) await app.press('DOWN');
  assert.equal(text.scrollTop, 670);
  assert.ok(text.classList.contains('focused'));
  await app.press('DOWN');
  assert.equal(app.focused(), 'Close');
  await app.press('ENTER');
  assert.equal(app.focused(), 'v1.3.0New');
  await app.press('ENTER');
  assert.equal(text.scrollTop, 0, 'reopening the notes resets scrolling');
  await app.press('BACK');
  assert.equal(app.focused(), 'v1.3.0New');
  const css = readFileSync('app/css/style.css', 'utf8');
  assert.match(css, /\.dialog-box p\s*\{[^}]*max-height:\s*560px/);
  assert.match(css, /\.dialog-box p\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.dialog-box p\s*\{[^}]*white-space:\s*pre-wrap/);
});

test('BACK to a weekend list shows the badges as they are now', async () => {
  const start = NOW / 1000 + 2 * 3600;
  const later = event(106, 'Practice 2', 'FOM_SESSION_11401', start);
  later.metadata.contentSubtype = 'LIVE_EVENT';
  later.metadata.emfAttributes.sessionEndDate = String((start + 3600) * 1000);
  const done = event(105, 'Practice 1', 'FOM_SESSION_11400', NOW / 1000 - 7200);
  const app = await boot({ pages: { '/PAGE/1297': [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{ eventName: 'ALL', events: [done, later] }] } } }] } });
  await app.press('UP');
  await app.pick(/^Schedule$/, ['RIGHT']);
  await app.pick(/^Round 19United States/, ['UP']);
  await app.advance(100);
  assert.match(app.$('list-inner').textContent, /Practice 2.*in 2 h/);
  await app.pick(/Practice 1/, ['UP', 'DOWN']);          // watch the replay of P1
  await app.advance(100);
  assert.equal(app.screen(), 'feeds');
  await app.advance(95 * 60000);                         // 95 minutes later P2 is 25 minutes away
  await app.press('BACK');
  assert.equal(app.screen(), 'list');
  assert.match(app.$('list-inner').textContent, /Practice 2.*in 25 min/, app.$('list-inner').textContent);
});

test('OK on a feed says F1 TV could not be reached when signing in again fails', async () => {
  const app = await boot();
  await app.pick(/^Race/);
  await app.advance(100);
  app.api.state.entitlement = null;                       // the session must be set up again
  app.net.login = () => Promise.reject(new Error('Failed to fetch'));
  await app.pick(/^INTERNATIONAL/);
  await app.advance(500);
  assert.equal(app.player.loads.length, 0);
  assert.notEqual(app.toast(), '', 'the viewer got no message');
});

test('an archived weekend\'s broadcast rail is not called This weekend', async () => {
  const app = await boot({ pages: { '/archive': [rail('Seasons', [pageItem('2025 Season', '/PAGE/2025')])] } });
  await app.press('UP');
  await app.pick(/^Archive$/, ['RIGHT']);
  await app.pick(/^2025 Season/, ['DOWN', 'RIGHT']);
  await app.pick(/^Abu Dhabi Grand Prix/, ['DOWN']);
  const titles = app.$('rails').querySelectorAll('.rail-title').map((e) => e.textContent);
  assert.ok(!titles.some((t) => /^This weekend/.test(t)), JSON.stringify(titles) + ' (a December 2025 race, viewed in October 2026)');
});

test('a network error while renewing the session says so, and does not ask to sign in again', async () => {
  const app = await boot();
  await app.pick(/^Race/);
  await app.advance(100);
  app.api.state.entitlement = null;
  app.net.login = () => Promise.reject(new TypeError('Failed to fetch'));
  app.context.Auth.renew = () => Promise.reject(new TypeError('Failed to fetch'));   // auth.js rejects on network errors
  await app.pick(/^INTERNATIONAL/);
  await app.advance(300);
  assert.equal(app.screen(), 'feeds');
  assert.match(app.toast(), /Could not reach F1 TV/);
});

// ---------- live playback (from the third review) ----------

/** Samsung AVPlay as the real player.js uses it; tick(ms) reports a playing position. */
function fakeAvPlay({ liveWindow = '', duration = 0, tracks = [], current = [] } = {}) {
  const calls = [];
  let state = 'NONE';
  const av = {
    calls, listener: null, liveWindow, tracks, current, silent: null,
    open: (url) => { calls.push(['open', url]); state = 'IDLE'; },
    setListener: (l) => { av.listener = l; },
    setDrm: (...a) => calls.push(['setDrm', a[0], a[1]]),
    setStreamingProperty: (k, v) => calls.push(['setStreamingProperty', k, v]),
    getStreamingProperty: (k) => k === 'GET_LIVE_DURATION' ? av.liveWindow : '',
    setBufferingParam: () => {}, setDisplayRect() {}, setDisplayMethod() {},
    seekTo: (ms, ok) => { calls.push(['seekTo', ms]); setImmediate(ok); },
    prepareAsync: (ok) => { calls.push(['prepareAsync']); state = 'READY'; setImmediate(ok); },
    getDuration: () => duration,
    getTotalTrackInfo: () => av.tracks,
    getCurrentStreamInfo: () => av.current,
    setSelectTrack: (type, i) => calls.push(['setSelectTrack', type, i]),
    setSilentSubtitle: (on) => { av.silent = on; calls.push(['setSilentSubtitle', on]); },
    play: () => { calls.push(['play']); state = 'PLAYING'; },
    pause() { calls.push(['pause']); state = 'PAUSED'; },
    getState: () => state,
    stop: () => calls.push(['stop']),
    close: () => calls.push(['close']),
    tick: (ms) => av.listener.oncurrentplaytime(ms)
  };
  return av;
}

// Live Practice 1 on the real player.js + AvEngine (fake AVPlay), encrypted DASH through the helper service.
async function liveReal(opts = {}) {
  const av = fakeAvPlay(opts.av);
  const app = await boot({ av, settings: opts.settings });
  app.net.play = (id, channel) => Promise.resolve({ url: 'https://cdn/' + id + '/' + (channel || 'main') + '.mpd', streamType: 'DASH_WV',
    licenseUrl: 'https://lic', licenseHeaders: {} });
  await app.pick(/^LIVEPractice 1/);
  await app.advance(100);
  await app.pick(/^INTERNATIONAL/);
  return { app, av };
}
const opens = (av) => av.calls.filter((c) => c[0] === 'open').map((c) => c[1]);
const shiftOf = (url) => { const m = /[?&]shift=(\d+)/.exec(url); return m ? +m[1] : 0; };

const clone = (o) => JSON.parse(JSON.stringify(o));

// Practice 1 (106) is live and part of a multipart event whose next part is a live "Post-session show".
function multipart() {
  const v = clone(VIDEOS[106]);
  v.emfAttributes.multipartEvent = 'true';
  v.emfAttributes.multipartEventNextHouseId = 'FOM_NEXT';
  v.externalId = 'FOM_THIS';
  const next = event(107, 'Post-session show', 'FOM_NEXT', NOW / 1000 - 300);
  next.metadata.contentSubtype = 'LIVE';
  next.metadata.emfAttributes.MeetingKey = '1300';
  return { v, pages: { '/PAGE/1300': [{ layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [{ eventName: 'ALL', events: [next] }] } } }] } };
}

test('the stream ending while the Next card counts down leaves the countdown to play the next part', async () => {
  const { v, pages } = multipart();
  const app = await boot({ pages });
  app.net.video = (id) => Promise.resolve({ metadata: clone(id === 106 ? v : VIDEOS[id]) });
  await playLive(app, 'avplay');
  app.player.pos = 4590;
  app.player.progress = true;
  await app.advance(5000);                       // past the scheduled end, F1 still says LIVE: nothing yet
  assert.ok(app.$('upnext').classList.contains('hidden'));
  const done = clone(v); done.contentSubtype = 'REPLAY';
  app.net.video = (id) => Promise.resolve({ metadata: clone(id === 106 ? done : VIDEOS[id]) });
  await app.advance(31000);
  assert.ok(!app.$('upnext').classList.contains('hidden'), 'no Up next card');
  assert.match(app.$('upnext-title').textContent, /Post-session show/);
  await app.advance(3000);                       // counting down: 7 s left
  app.player.listeners.ended();                  // AVPlay's onstreamcompleted for the finished broadcast
  await app.advance(500);
  assert.equal(app.screen(), 'player', 'the player was closed, the countdown to the next part is gone');
});

test('a failed live reopen leaves the playing stream playing', async () => {
  const app = await boot();
  await playLive(app, 'avplay');
  app.player.pos = 4500;
  assert.ok(app.player.engine);
  app.net.play = () => Promise.reject(new Error('HTTP 500'));
  await app.press('LEFT', 'LEFT', 'ENTER');      // 20 s back -> reopen
  await app.advance(1000);
  assert.match(app.toast(), /Could not play/);
  assert.ok(app.player.engine, 'the live stream that was playing is gone (engine ' + app.player.engine + ')');
});

test('a Service Unavailable answer to a live reopen is not taken for "not started yet"', async () => {
  const app = await boot();
  await playLive(app, 'avplay');
  app.player.pos = 4500;
  app.net.play = () => Promise.reject(new Error('Service Unavailable'));
  await app.press('LEFT', 'LEFT', 'ENTER');
  await app.advance(1000);
  assert.equal(app.screen(), 'player', 'closed with: ' + app.toast());
});

test('a viewer behind live in an overrunning broadcast is not cut off when F1 stops listing it as live', async () => {
  const app = await boot();
  await playLive(app, 'avplay');
  // Live window is 1000..4600 (4600 = the live edge, i.e. real now). Scheduled end was 10 min ago (NOW - 600 s).
  // The viewer watches the moment 500 s ago: past the scheduled end (overrun), but 500 s of broadcast are still ahead of them.
  app.player.pos = 4100;
  const replay = JSON.parse(JSON.stringify(VIDEOS[106]));
  replay.contentSubtype = 'REPLAY';          // F1 flipped it: the broadcast is over in real time
  app.net.video = () => Promise.resolve({ metadata: replay });
  await app.advance(35000);
  assert.equal(app.screen(), 'player', 'the player was closed ("Broadcast ended") with ' + Math.round(4600 - app.player.pos) + ' s of the broadcast unwatched');
});

test('at live, a 10 s jump back is a real rewind, not "already live"', async () => {
  const app = await boot();
  await playLive(app, 'avplay');
  app.player.pos = 4596;                    // live: ~4 s behind the edge (the wall clock minus the 25 s delay)
  await app.advance(600);
  assert.match(app.$('osd-live').textContent, /^LIVE$/);
  await app.press('LEFT', 'ENTER');         // 10 s back
  await app.advance(500);
  assert.equal(app.player.loads.length, 2, 'the jump back was dropped as "already live"; toast: ' + app.toast());
});

test('live timing starts from the real-time feed when the archive index cannot be read', async () => {
  const app = await boot();
  app.context.fetch = async (url) => { throw new Error('network down'); };   // livetiming.formula1.com/static/2026/Index.json
  await playLive(app, 'avplay');
  await app.advance(2000);
  const loads = app.timing.workers.flatMap((w) => w.sent).filter((m) => m.cmd === 'load');
  assert.equal(loads.length, 1, 'the worker was never told to follow the real-time feed (it does not need the archive path)');
});

test('Watch live opens the stream at live through the stream helper (real player, AVPlay)', async () => {
  const { app, av } = await liveReal();
  await app.press('ENTER');   // Watch live
  await app.advance(500);
  assert.equal(app.screen(), 'player');
  assert.equal(opens(av).length, 1);
  assert.equal(shiftOf(opens(av)[0]), 0);
});

test('a live start that does not play is retried at live, not an hour back (real player, AVPlay)', async () => {
  const { app, av } = await liveReal();
  await app.press('ENTER');
  await app.advance(500);
  await app.advance(16000);
  assert.equal(opens(av).length, 2, 'no retry');
  assert.equal(shiftOf(opens(av)[1]), 0, 'retry opened ' + opens(av)[1]);
});

test('a 10 s jump back from live reopens the stream 10 s back (real player, AVPlay)', async () => {
  const { app, av } = await liveReal({ av: { liveWindow: '1010000|4600000' } });
  await app.press('ENTER');
  await app.advance(500);
  av.tick(4575000);                         // AVPlay at its normal live start: edge - presentation delay
  await app.advance(1000);
  assert.equal(opens(av).length, 1);
  await app.press('LEFT', 'ENTER');
  await app.advance(1500);
  assert.equal(opens(av).length, 2, '10 s back: nothing reopened');
});

test('after a 50 s rewind the bar says behind live and the LIVE button goes back (real player, AVPlay, TV-log numbers)', async () => {
  const { app, av } = await liveReal({ av: { liveWindow: '1010000|4593000' } });
  const edgeNow = () => 4575 + (app.clock.now() - NOW) / 1000;   // now - AST - 25 s (the helper's presentation delay)
  let pos = 0, behindWindow = 22;
  // AVPlay runs at 1x; its window ends ~22 s after the playing position (TV log: unshifted 21-24 s, shifted 21 s).
  app.clock.setInterval(() => { if (pos) { pos += 1; av.tick(pos * 1000); av.liveWindow = '1010000|' + Math.round((pos + behindWindow) * 1000); } }, 1000);
  await app.press('ENTER');
  await app.advance(500);
  pos = edgeNow() - 4;                       // ~29 s behind real time
  await app.advance(1000);
  assert.equal(app.$('osd-live').textContent, 'LIVE');
  for (let i = 0; i < 5; i++) { await app.press('LEFT'); await app.advance(700); }   // 5 x 10 s back
  await app.press('ENTER');
  await app.advance(2000);
  const shift = shiftOf(opens(av).at(-1));
  assert.ok(shift > 40 && shift < 70, 'shift ' + shift);
  pos = edgeNow() - shift;                   // AVPlay starts where it was asked to
  await app.advance(3000);
  const trueLag = 4600 + (app.clock.now() - NOW) / 1000 - pos;
  assert.ok(trueLag > 70, 'true lag ' + trueLag);
  const label = app.$('osd-live').textContent;
  const count = opens(av).length;
  await app.press('DOWN', 'ENTER');          // the LIVE button
  await app.advance(1500);
  assert.equal(opens(av).length, count + 1, 'LIVE button did nothing at ' + Math.round(trueLag) + ' s behind real time (bar: "' + label + '"); toast: ' + app.toast());
});
