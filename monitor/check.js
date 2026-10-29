#!/usr/bin/env node
/*
 * Checks that the F1 TV services the app depends on still answer the way it expects, by running
 * the app's own code against them. Meant for a home server; see monitor/README.md.
 *
 *   node monitor/check.js pair    sign this machine in with a code (once)
 *   node monitor/check.js         run every check once; exit code 1 if any fails
 *   node monitor/check.js loop    run every CHECK_EVERY hours and notify when results change
 *
 * Environment: DATA_DIR (sign-in and state, default monitor/data), CHECK_EVERY (hours, default 6),
 * NOTIFY_URL (an ntfy topic URL or a Discord webhook), NOTIFY_ON (change | always), and for testing
 * F1TV_TOKEN (a subscription token to use instead of the paired sign-in).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS = /^(Practice [123]|Qualifying|Sprint Qualifying|Sprint|Race)$/;
// Reports each change once; two different changes in a row must both notify.
const OFFER_CHECK = 'what F1 offers (changes)';

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** localStorage for the app's code, kept in a JSON file so the sign-in survives restarts. */
function fileStorage(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 });
    },
    removeItem: (k) => { delete data[k]; }
  };
}

/** The app's API client, sign-in and statistics, loaded as they run on the TV. */
function app() {
  const ctx = vm.createContext({
    fetch, URL, atob, btoa, console, setTimeout, clearTimeout, Promise, Date, JSON, Math,
    localStorage: fileStorage(path.join(DATA, 'storage.json'))
  });
  for (const f of ['settings.js', 'api.js', 'auth.js', 'stats.js']) vm.runInContext(read('app/js/' + f), ctx, { filename: f });
  return ctx;
}

/** The TV service's manifest and segment fixes. */
function service() {
  const ctx = vm.createContext({ require, module: { exports: {} }, Buffer, Uint8Array, console, Date });
  vm.runInContext(read('app/service/service.js'), ctx, { filename: 'service.js' });
  return ctx;
}

/** Loads a session from F1's timing archive with the app's timing worker; resolves with a query function. */
function timingWorker(sessionPath, token) {
  const messages = [];
  const self = { postMessage: (m) => messages.push(m) };
  const ctx = vm.createContext({ self, fetch, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Math });
  vm.runInContext(read('app/js/timing-worker.js'), ctx, { filename: 'timing-worker.js' });
  // Observe the first heartbeat without changing how the worker builds its median clock.
  let firstHeartbeat = null;
  const handleLine = ctx.handleLine;
  ctx.handleLine = (feed, line) => {
    if (feed === 'Heartbeat' && firstHeartbeat == null) firstHeartbeat = heartbeatBase(line);
    handleLine(feed, line);
  };
  self.onmessage({ data: { cmd: 'load', path: sessionPath, token, live: false } });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function wait() {
      const m = messages.find((x) => x.type === 'loaded' || x.type === 'error');
      if (m && m.type === 'error') return reject(new Error(m.message));
      if (m) {
        let id = 0;
        return resolve({ info: m.info, base: ctx.job.base, startedAt: ctx.job.startedAt,
          firstHeartbeat, snaps: ctx.job.snaps, query: (t) => {
          self.onmessage({ data: { cmd: 'query', id: ++id, t } });
          return messages.find((x) => x.type === 'state' && x.id === id).state;
        } });
      }
      if (Date.now() - started > 120000) return reject(new Error('timing archive did not load in 2 minutes'));
      setTimeout(wait, 200);
    })();
  });
}

const attr = (tag, name) => (new RegExp('\\s' + name + '="([^"]*)"').exec(tag || '') || [])[1];

/**
 * A recent audio segment of a DASH manifest (SegmentTemplate with a SegmentTimeline, addressed by
 * $Number$ or $Time$), a few segments back from the end so it surely exists on a live stream.
 */
function audioSegmentUrl(mpd, manifestUrl) {
  const set = (mpd.match(/<AdaptationSet\b[^>]*contentType="audio"[\s\S]*?<\/AdaptationSet>/) || [])[0];
  if (!set) return null;
  const tpl = (set.match(/<SegmentTemplate\b[^>]*>/) || [])[0];
  const rep = attr((set.match(/<Representation\b[^>]*>/) || [])[0], 'id');
  const media = attr(tpl, 'media');
  if (!media || !rep) return null;
  const times = [];
  let t = 0;
  for (const [, a] of set.matchAll(/<S\b([^>]*)\/>/g)) {
    if (attr(a, 't') != null) t = +attr(a, 't');
    const d = +attr(a, 'd'), r = Math.max(0, +(attr(a, 'r') || 0));
    for (let i = 0; i <= r; i++) { times.push(t); t += d; }
  }
  if (!times.length) return null;
  const k = Math.max(0, times.length - 3);
  const number = +(attr(tpl, 'startNumber') || 1) + k;
  const file = media.replace(/\$RepresentationID\$/g, rep)
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (m, w) => String(number).padStart(+w || 0, '0'))
    .replace(/\$Time\$/g, String(times[k]));
  const baseTag = (mpd.match(/<BaseURL>([^<]*)<\/BaseURL>/) || [])[1];
  const base = new URL(baseTag || '.', manifestUrl.split('?')[0]).toString();
  return new URL(file, base).toString();
}

/** The sample count in a segment's senc box, or null without one. */
function sencCount(buf) {
  const i = buf.indexOf('senc');
  return i < 4 || i + 12 > buf.length ? null : buf.readUInt32BE(i + 8);
}

/** HLG video sizes, largest first; quoted CODECS attributes can contain commas. */
function hlgVariants(master) {
  const variants = [];
  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = {};
    for (const [, key, value] of line.slice(18).matchAll(/(?:^|,)\s*([\w-]+)=("[^"]*"|[^,]*)/g)) {
      attrs[key] = value.replace(/^"|"$/g, '').trim();
    }
    const size = /^(\d+)x(\d+)$/.exec(attrs.RESOLUTION || '');
    if (attrs['VIDEO-RANGE'] === 'HLG' && size && +size[1] > 0 && +size[2] > 0) {
      variants.push({ width: +size[1], height: +size[2] });
    }
  }
  return variants.sort((a, b) => b.width * b.height - a.width * a.height);
}

/** UTC milliseconds at offset zero according to one heartbeat. */
function heartbeatBase(line) {
  const m = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(line);
  if (!m) return null;
  try {
    const utc = Date.parse(JSON.parse(line.slice(12)).Utc);
    return Number.isFinite(utc) ? utc - ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 - +m[4] : null;
  } catch (e) { return null; }
}

/** Keep capabilities, not replay ids or expiring URLs, so ordinary new replays don't alert. */
function offerSnapshot(video, devices) {
  const enabled = (video.liveNow || {}).enabled || {};
  return {
    devices,
    liveNow: Object.keys(enabled).filter((p) => enabled[p] === true).sort(),
    videoKeys: Object.keys(video).sort(),
    feeds: [...new Set(((video.metadata || {}).additionalStreams || []).map((s) => s.identifier).filter(Boolean))].sort(),
    playbackOffsetsVersion: video.playbackOffsetsVersion ?? null
  };
}

/** Readable changes between two capability snapshots; no timestamps or ordering noise. */
function offerDiff(before, after) {
  const changes = [];
  for (const device of [...new Set([...Object.keys(before.devices), ...Object.keys(after.devices)])].sort()) {
    if (before.devices[device] !== after.devices[device]) {
      changes.push(`${device}: ${before.devices[device] ?? 'missing'} → ${after.devices[device] ?? 'missing'}`);
    }
  }
  for (const key of ['liveNow', 'videoKeys', 'feeds']) {
    const added = after[key].filter((v) => !before[key].includes(v)).sort();
    const removed = before[key].filter((v) => !after[key].includes(v)).sort();
    if (key === 'videoKeys') {
      if (added.length) changes.push('new video keys: ' + added.join(', '));
      if (removed.length) changes.push('removed video keys: ' + removed.join(', '));
    } else {
      const parts = [];
      if (added.length) parts.push('+ ' + added.join(', '));
      if (removed.length) parts.push('- ' + removed.join(', '));
      if (parts.length) changes.push(key + ': ' + parts.join('; '));
    }
  }
  if (before.playbackOffsetsVersion !== after.playbackOffsetsVersion) {
    changes.push(`playbackOffsetsVersion: ${before.playbackOffsetsVersion} → ${after.playbackOffsetsVersion}`);
  }
  return changes;
}

async function archiveSessions(token) {
  const year = new Date().getUTCFullYear();
  const r = await fetch(`https://livetiming.formula1.com/static/${year}/Index.json`, { headers: { Authorization: 'Bearer ' + token } });
  need(r.ok, 'Index.json answered HTTP ' + r.status);
  const index = JSON.parse((await r.text()).replace(/^\uFEFF/, ''));
  const sessions = [];
  index.Meetings.forEach((m) => (m.Sessions || []).forEach((s) => { if (s.Path && SESSIONS.test(s.Name)) sessions.push(s); }));
  return sessions;
}

async function text(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.split('?')[0].slice(0, 80));
  return r.text();
}

function need(condition, message) { if (!condition) throw new Error(message); }

/** Runs every check; returns [{ name, ok, detail }]. */
async function runChecks() {
  const results = [];
  // Rate limits, server errors and network blips get one retry a minute later before they count.
  const transient = /HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/;
  const check = async (name, fn, retry = true) => {
    for (let attempt = 1; ; attempt++) {
      try { return results.push({ name, ok: true, detail: (await fn()) || '' }); }
      catch (e) {
        if (retry && attempt === 1 && transient.test(e.message)) { await new Promise((r) => setTimeout(r, +process.env.RETRY_WAIT || 60000)); continue; }
        return results.push({ name, ok: false, detail: e.message });
      }
    }
  };
  const { F1Api, Auth, Stats } = app();
  const svc = service();
  let season, meeting, schedule, replay, token, stream;

  // ---------- public: what the app shows before signing in ----------

  await check('API config', async () => {
    await F1Api.refreshConfig();
    const c = (F1Api.state.config || {}).apiConfig || {};
    need(/^\d+\.\d+$/.test(c.playAPIVersion || ''), 'no playAPIVersion in /config');
    need(/^\d+\.\d+$/.test(c.videoAPIVersion || ''), 'no videoAPIVersion in /config');
    return `play API ${c.playAPIVersion}, video API ${c.videoAPIVersion}`;
  });

  await check('menu', async () => {
    const menu = await F1Api.menu();
    need(menu.some((m) => /^home$/i.test(m.title)), 'no Home entry');
    season = menu.filter((m) => /season/i.test(m.title))[0];
    need(season, 'no season entry, so no Schedule tab');
    return menu.map((m) => m.title).join(', ');
  });

  await check('season calendar', async () => {
    need(season, 'needs the menu');
    const meetings = F1Api.seasonFrom(await F1Api.pageByUri(season.uri));
    need(meetings.length >= 10, `only ${meetings.length} meetings`);
    need(meetings.every((m) => m.start && m.uri && m.key), 'meetings without dates, pages or keys');
    meeting = meetings.filter((m) => m.start <= Date.now()).pop() || meetings[0];
    return `${meetings.length} meetings; latest: ${meeting.name}`;
  });

  await check('weekend schedule', async () => {
    need(meeting, 'needs the calendar');
    schedule = F1Api.scheduleFrom(await F1Api.pageByUri(meeting.uri));
    need(schedule && schedule.events.length >= 3, 'no broadcast schedule on the weekend page');
    need(schedule.events.every((e) => e.contentId && e.start && e.houseId), 'events without ids, start times or house ids');
    const f1 = schedule.events.filter((e) => /FORMULA 1/.test(e.series) && SESSIONS.test(e.title));
    replay = f1.filter((e) => e.subtype === 'REPLAY').pop();
    return `${schedule.events.length} broadcasts, ${f1.length} F1 sessions` + (replay ? `; latest replay: ${replay.title}` : '');
  });

  await check('video details and feeds', async () => {
    need(replay, 'no F1 session replay this weekend yet');
    const m = (await F1Api.video(replay.contentId)).metadata || {};
    const emf = m.emfAttributes || {};
    need(emf.MeetingKey && +emf.sessionStartDate > 1e12, 'no MeetingKey or sessionStartDate');
    const onboard = (m.additionalStreams || []).filter((s) => s.type === 'obc');
    need(onboard.length >= 10, `only ${onboard.length} onboard feeds`);
    need(onboard.every((s) => s.racingNumber != null && s.hex && s.driverLastName && s.channelId), 'onboard feeds without number, colour, name or channel');
    return `${replay.title}: ${(m.additionalStreams || []).length} extra feeds, ${onboard.length} onboards`;
  });

  await check('multipart links (pre-show → session → post-show)', async () => {
    need(schedule, 'needs the schedule');
    const houses = new Set(schedule.events.map((e) => e.houseId));
    const shows = schedule.events.filter((e) => /^Pre-/.test(e.title) && e.subtype !== 'LIVE_EVENT');
    if (!shows.length) return 'no pre-show has aired this weekend yet';
    const m = (await F1Api.video(shows[0].contentId)).metadata || {};
    const emf = m.emfAttributes || {};
    need(emf.multipartEvent === 'true', `${shows[0].title} is no longer marked as part of an event`);
    need(houses.has(emf.multipartEventNextHouseId), `${shows[0].title} points to ${emf.multipartEventNextHouseId}, which is not in the schedule`);
    const next = schedule.events.find((e) => e.houseId === emf.multipartEventNextHouseId);
    return `${shows[0].title} → ${next.title}`;
  });

  await check('standings (jolpica)', async () => {
    const ds = await Stats.driverStandings();
    need(ds.drivers.length >= 10, `only ${ds.drivers.length} drivers`);
    const progress = await Stats.seasonProgress();
    need(progress.rounds.length >= 1, 'no rounds in the season results');
    return `after round ${ds.round}: ${ds.drivers[0].first} ${ds.drivers[0].last} leads; ${progress.rounds.length} rounds of results`;
  });

  await check('live timing connection', async () => {
    const r = await fetch('https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1', { method: 'POST' });
    need(r.ok, 'negotiate answered HTTP ' + r.status);
    const n = JSON.parse((await r.text()).replace(/^﻿/, ''));
    need(n.connectionToken || n.connectionId, 'no connection token');
    return 'negotiate ok';
  });

  // ---------- signed in: playback and timing data ----------

  const paired = !!JSON.parse(fileStorage(path.join(DATA, 'storage.json')).getItem('f1tv.session') || '{}').authKey;
  if (!paired && !process.env.F1TV_TOKEN) {
    results.push({ name: 'signed-in checks', ok: false, detail: 'not paired: run "check.js pair" first' });
    return results;
  }

  await check('sign-in', async () => {
    token = process.env.F1TV_TOKEN || await Auth.renew();
    need(token, 'the device key no longer gives a token (removed from the account?)');
    await F1Api.login(token);
    need(F1Api.state.entitlement, 'no entitlement token');
    return Auth.profile().product || 'signed in';
  });

  await check('play API (TV platform)', async () => {
    need(token && replay, 'needs sign-in and a replay');
    stream = await F1Api.play(replay.contentId);
    need(stream.platform === 'BIG_SCREEN_DASH', `the TV platform was refused; fell back to ${stream.platform}`);
    const hls = /\.m3u8(\?|$)/.test(stream.url);
    need(hls || stream.licenseUrl, 'no licence URL for an encrypted stream');
    return `${replay.title}: ${stream.streamType}, ${hls ? 'hls' : 'dash'}`;
  });

  await check('every feed plays', async () => {
    need(token && replay, 'needs sign-in and a replay');
    const feeds = F1Api.feedsFrom((await F1Api.video(replay.contentId)).metadata);
    // The broadcast feeds and one onboard, as the app lists them (INTERNATIONAL is the main stream).
    const tried = feeds.filter((f) => !f.num).concat(feeds.filter((f) => f.num).slice(0, 1));
    const failed = [];
    for (const f of tried) await F1Api.play(replay.contentId, f.channelId).catch((e) => failed.push(`${f.title} (${e.message})`));
    need(!failed.length, 'cannot play ' + failed.join(', '));
    return tried.map((f) => f.title).join(', ');
  });

  await check('stream manifest and clock', async () => {
    need(stream, 'needs a stream');
    const info = await F1Api.streamInfo(stream.url);
    if (/\.m3u8(\?|$)/.test(stream.url)) {
      need(info.marks && info.marks.length > 0, 'no program date-times in HLS (tower and seeking break)');
    }
    need(info.epochAtZero > 1e9, 'the video timeline no longer maps to real time (tower and seeking break)');
    need(info.windowEnd > info.windowStart, 'empty timeline');
    return `${info.dynamic ? 'live' : 'replay'}, ${Math.round(info.windowEnd - info.windowStart)} s` +
      (info.segDur ? `, ${info.segDur} s segments` : '');
  });

  const live = schedule && schedule.events.find((e) => e.subtype === 'LIVE');
  await check('audio fix (senc sample count)', async () => {
    need(stream || (live && token), 'needs a replay stream or a live broadcast and sign-in');
    let audio = stream;
    if (!audio || /\.m3u8(\?|$)/.test(audio.url)) {
      if (!live) return 'replays are clear HLS; the fix is checked while something is live';
      need(token, 'needs sign-in for the live stream');
      audio = await F1Api.play(live.contentId);
    }
    need(/\.mpd(\?|$)/.test(audio.url) && audio.licenseUrl, 'needs an encrypted DASH stream to check the audio fix');
    const mpd = await text(audio.url);
    const rewritten = svc.preferLanguages(svc.rewriteManifest(mpd, audio.url), { audio: 'eng' });
    need(/contentType="audio"[^>]*lang="eng[^"]*"[^>]*><BaseURL>http:\/\/127\.0\.0\.1/.test(rewritten) ||
      /contentType="audio"[^>]*><BaseURL>http:\/\/127\.0\.0\.1/.test(rewritten), 'audio sets were not routed through the service');
    const url = audioSegmentUrl(mpd, audio.url);
    need(url, 'could not find an audio segment in the manifest');
    const r = await fetch(url);
    need(r.ok, 'audio segment answered HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const before = sencCount(buf);
    need(before != null, 'no senc box in the audio (encryption format changed?)');
    const after = sencCount(svc.patchSenc(Buffer.from(buf)));
    if (before > 0) return `F1 now sends ${before} samples itself: the fix is no longer needed`;
    need(after > 0, 'senc claims 0 samples and the fix could not correct it');
    return `senc 0 → ${after} samples`;
  });

  await check('timing archive', async () => {
    need(token, 'needs sign-in');
    const sessions = await archiveSessions(token);
    const last = sessions.pop();
    need(last, 'no sessions in the archive index');
    const w = await timingWorker(last.Path, token);
    need(w.snaps.length > 10, 'almost no timing snapshots');
    const mid = w.snaps[Math.floor(w.snaps.length * 0.8)][0];
    const st = w.query(mid);
    need(st && st.standings && st.standings.length >= 10, 'no standings');
    need(st.standings.every((d) => d.tla && d.colour), 'drivers without code or team colour');
    const timed = st.standings.filter((d) => d.best || d.gap).length;
    need(timed >= 10, `only ${timed} drivers with times`);
    return `${last.Name} (${last.Path.split('/')[1]}): ${st.standings.length} drivers, ${timed} with times`;
  });

  await check('race start in the timing data', async () => {
    need(token, 'needs sign-in');
    const last = (await archiveSessions(token)).filter((s) => /^(Race|Sprint)$/.test(s.Name)).pop();
    need(last, 'no Race or Sprint in the archive index');
    const w = await timingWorker(last.Path, token);
    need(Number.isFinite(w.startedAt) && w.startedAt > 0, 'no race start in SessionData (tower cannot show lights out)');
    const before = w.query(w.startedAt - 60000), after = w.query(w.startedAt + 60000);
    need(before && before.beforeStart === true, 'tower thinks the race has started a minute before lights out');
    need(after && after.beforeStart === false && after.lap >= 1, 'tower has no racing lap a minute after lights out');
    const off = w.firstHeartbeat == null ? null : Math.round(Math.abs(w.firstHeartbeat - w.base) / 1000);
    return `${last.Name} (${last.Path.split('/')[1]}): lap ${after.lap} after lights out; ` +
      (off == null ? 'first heartbeat could not be read' : `first heartbeat ${off} s off` + (off > 1 ? ' (buffered burst)' : ''));
  });

  await check('4K HDR (Premium)', async () => {
    need(token && F1Api.state.entitlement, 'needs sign-in');
    if ((F1Api.state.location || {}).entitlement === 'PRO') return 'Pro account: no HDR to check';
    need(replay, 'needs a replay');
    const hdr = await F1Api.play(replay.contentId, null, { hdr: true });
    need(hdr.hdr === true, 'the app has fallen back to SDR for Premium');
    const variants = hlgVariants(await text(hdr.url));
    need(variants.length, 'no HLG video variants (Premium HDR is missing)');
    const sdr = stream || await F1Api.play(replay.contentId);
    const hdrInfo = await F1Api.streamInfo(hdr.url), sdrInfo = await F1Api.streamInfo(sdr.url);
    need(!hdrInfo.encrypted, 'the HDR variant playlists are encrypted (the app falls back to SDR)');
    need(variants[0].height >= 2160, `HDR tops out at ${variants[0].width}x${variants[0].height}: no more 4K`);
    need(hdrInfo.epochAtZero > 1e9 && sdrInfo.epochAtZero > 1e9, 'HDR or SDR has no video clock (tower cannot sync)');
    const offset = Math.abs(hdrInfo.epochAtZero - sdrInfo.epochAtZero);
    need(offset <= 1, `HDR and SDR clocks differ by ${offset.toFixed(1)} s (tower is out of sync)`);
    return `${replay.title}: HLG ${variants[0].width}x${variants[0].height}; SDR clock within ${offset.toFixed(1)} s`;
  });

  await check(OFFER_CHECK, async () => {
    need(token && F1Api.state.entitlement && replay, 'needs sign-in and a replay');
    const video = await F1Api.video(replay.contentId);
    const devices = {};
    const url = `https://f1tv.formula1.com/${F1Api.state.playApi}/R/ENG/BIG_SCREEN_DASH/ALL/CONTENT/PLAY` +
      `?contentId=${encodeURIComponent(replay.contentId)}&player=player_bm`;
    for (const device of ['web', 'tvos', 'android_tv', 'ios', 'chromecast']) {
      // Probe directly: play() would hide rejected devices behind its SDR/web fallback.
      const deviceInfo = device === 'web'
        ? 'device=web;screen=browser;os=tizen;browser=chrome;browserVersion=76;osVersion=6.0;appVersion=55.0.3;playerVersion=8.212.0;p=false;tms=1'
        : `device=${device};`;
      try {
        const data = await F1Api.http(url, { headers: {
          ascendontoken: F1Api.state.ascendon, entitlementtoken: F1Api.state.entitlement, 'x-f1-device-info': deviceInfo
        } });
        need(data && data.resultObj && data.resultObj.streamType, (data && data.message) || 'no streamType returned');
        devices[device] = data.resultObj.streamType;
      } catch (e) { devices[device] = 'error: ' + e.message; }
    }
    const snapshot = offerSnapshot(video, devices), file = path.join(DATA, 'offer.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const changes = previous ? offerDiff(previous, snapshot) : [];
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 1), { mode: 0o600 });
    need(!changes.length, changes.join('; '));
    return previous ? 'no changes' : 'baseline saved';
  }, false); // A saved change containing "HTTP 500" must still alert once, not pass on retry.

  await check('driver headshots and colours', async () => {
    need(token, 'needs sign-in');
    const info = await Stats.driverInfo(token);
    const n = Object.keys(info).filter((k) => info[k].headshot && info[k].colour).length;
    need(n >= 10, `only ${n} drivers with headshot and colour`);
    return `${n} drivers`;
  });

  if (live && token) {
    await check('live stream and time-shift', async () => {
      const s = await F1Api.play(live.contentId);
      const info = await F1Api.streamInfo(s.url);
      need(info.dynamic, 'a live broadcast with a static manifest');
      const shifted = svc.timeShift(await text(s.url), 300, Date.now());
      need(/<S\b/.test(shifted), 'nothing left after time-shifting 5 minutes');
      return `${live.title}: live, time-shift ok`;
    });
  }
  return results;
}

// ---------- reporting and notifications ----------

function report(results) {
  return results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ': ' + r.detail : ''}`).join('\n');
}

async function notify(title, body) {
  const url = process.env.NOTIFY_URL;
  if (!url) return;
  const discord = /discord(app)?\.com\/api\/webhooks\//.test(url);
  const r = await fetch(url, discord
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }) }
    : { method: 'POST', headers: { Title: title, Tags: 'checkered_flag' }, body });
  if (!r.ok) console.error('notification failed: HTTP ' + r.status);
}

/** What identifies each failure for notifications: its name; for the changes check, also what changed. */
function failingKeys(results) {
  return results.filter((r) => !r.ok).map((r) => (r.name === OFFER_CHECK ? `${r.name}: ${r.detail}` : r.name));
}

/** Notifies when the set of failing checks changes (or every run with NOTIFY_ON=always). */
async function runAndNotify() {
  const results = await runChecks();
  const failing = failingKeys(results);
  const stateFile = path.join(DATA, 'state.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { /* first run */ }
  console.log(`\n${new Date().toISOString()}\n${report(results)}`);
  const changed = !previous || previous.failing.join('|') !== failing.join('|');
  if (changed || process.env.NOTIFY_ON === 'always') {
    const title = failing.length ? `F1 TV monitor: ${failing.length} check${failing.length > 1 ? 's' : ''} failing`
      : previous && previous.failing.length ? 'F1 TV monitor: all checks pass again' : 'F1 TV monitor: all checks pass';
    await notify(title, report(failing.length ? results.filter((r) => !r.ok) : results)).catch((e) => console.error('notification failed: ' + e.message));
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ at: new Date().toISOString(), failing }));
  return failing.length;
}

async function pair() {
  const { Auth } = app();
  console.log('Signing this machine in to F1 TV. It appears in your account as an Android tablet.');
  await Auth.pair((code) => console.log(`\nOpen ${Auth.pairUrl(code)} (or go to f1tv.formula1.com/tv and enter ${code}),\nsign in and confirm. Waiting…`));
  console.log(`Signed in (${Auth.profile().product || 'F1 TV'}). The sign-in is kept in ${DATA}.`);
}

async function main(mode) {
  if (mode === 'pair') return pair();
  if (mode === 'loop') {
    const hours = +process.env.CHECK_EVERY || 6;
    for (;;) {
      await runAndNotify().catch((e) => console.error(e));
      await new Promise((r) => setTimeout(r, hours * 3600000));
    }
  }
  process.exitCode = (await runAndNotify()) ? 1 : 0;
}

if (require.main === module) main(process.argv[2]).catch((e) => { console.error(e); process.exitCode = 1; });

module.exports = { audioSegmentUrl, sencCount, hlgVariants, heartbeatBase, offerSnapshot, offerDiff, timingWorker, failingKeys };
