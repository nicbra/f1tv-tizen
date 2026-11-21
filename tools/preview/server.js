#!/usr/bin/env node
/*
 * UI preview: runs the real app/ in a desktop browser, without a TV and without an F1 TV login.
 *
 *   node tools/preview/server.js [--port 8090] [--offline]
 *
 * Nothing in app/ changes. This server:
 *  - serves app/ straight from the working tree (edit, reload, see it),
 *  - adds tools/preview/shim.js to index.html as it is served (fake TV APIs, remote keys, 1920x1080 stage),
 *  - answers the app's network requests, which the shim routes here as /__up/<host>/<path>:
 *    F1 TV's catalog goes to F1 anonymously (no token leaves this PC: there is none), sign-in and play are
 *    faked, and a "video" is a local stream made from that video's own key art, played by the app's Shaka.
 * Answers from F1 are cached in local/preview-cache/ (gitignored); --offline uses only the cache.
 * Requires Node 18+ and, for the still-image streams, ffmpeg.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'app');
const HERE = __dirname;
const CACHE = path.join(ROOT, 'local/preview-cache');
const DATA = path.join(ROOT, 'local/preview-data');   // optional recordings (see README)

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const PORT = +opt('--port', process.env.PORT || 8090);
const HOST = opt('--host', '127.0.0.1');
const OFFLINE = args.includes('--offline');

const Layouts = require(path.join(APP, 'js/layouts.js'));   // the app's own multiview layouts
const timing = require('./openf1.js')({ cacheDir: CACHE, offline: OFFLINE, log });   // the timing archive, from OpenF1

const SEG = 6;   // seconds per segment of the still-image stream

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment'
};

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
const json = (res, obj, status) => send(res, status || 200, JSON.stringify(obj), 'application/json');

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// ---------------------------------------------------------------- the app's own files

function serveApp(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  // index.html's Tizen script (`$WEBAPIS/webapis/webapis.js`): the shim already set up webapis.
  if (/\$WEBAPIS/.test(decodeURIComponent(pathname))) return send(res, 200, '/* webapis: see tools/preview/shim.js */', TYPES['.js']);
  const file = path.normalize(path.join(APP, decodeURIComponent(pathname)));
  if (!file.startsWith(APP + path.sep)) return send(res, 403, 'no');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found: ' + pathname);
    const ext = path.extname(file).toLowerCase();
    if (pathname === '/index.html') {
      // The shim before anything else; the original markup otherwise untouched.
      const html = buf.toString('utf8').replace(/<head>/i, '<head>\n  <script src="/__preview/shim.js"></script>');
      return send(res, 200, html, TYPES['.html']);
    }
    if (/-worker\.js$/.test(pathname)) {
      // Workers make their own requests (the timing feed): the same routing as the page.
      return send(res, 200, "importScripts('/__preview/worker-shim.js');\n" + buf.toString('utf8'), TYPES['.js']);
    }
    send(res, 200, buf, TYPES[ext] || 'application/octet-stream');
  });
}

function servePreviewFile(res, name) {
  fs.readFile(path.join(HERE, name), (err, buf) => err ? send(res, 404, 'not found') : send(res, 200, buf, TYPES[path.extname(name)]));
}

// ---------------------------------------------------------------- cache of upstream answers

function cacheFile(key) {
  return path.join(CACHE, 'http', crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '.json');
}

function readCache(key) {
  try { return JSON.parse(fs.readFileSync(cacheFile(key), 'utf8')); } catch (e) { return null; }
}

function writeCache(key, entry) {
  try {
    fs.mkdirSync(path.dirname(cacheFile(key)), { recursive: true });
    fs.writeFileSync(cacheFile(key), JSON.stringify(Object.assign({ key }, entry)));
  } catch (e) { /* cache is best effort */ }
}

/** GET from upstream (no cookies, no tokens), cached; the cache answers when offline or upstream fails. */
async function upstream(url) {
  const cached = readCache(url);
  if (OFFLINE) return cached || { status: 504, type: 'text/plain', body: 'offline and not cached: ' + url };
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (preview)' } });
    const entry = { status: r.status, type: r.headers.get('content-type') || 'application/octet-stream', body: await r.text() };
    if (r.ok) writeCache(url, entry);
    else if (cached) return cached;
    return entry;
  } catch (e) {
    return cached || { status: 502, type: 'text/plain', body: 'upstream failed: ' + e.message };
  }
}

// ---------------------------------------------------------------- fake sign-in and F1 TV answers

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }

// A token the app can read (name, product, expiry). It is never sent anywhere but this server.
const FAKE_TOKEN = b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url({
  exp: Math.floor(Date.now() / 1000) + 10 * 365 * 86400, FirstName: 'Preview', LastName: 'User',
  SubscribedProduct: 'F1 TV Premium', SubscriberId: 0
}) + '.preview';

async function accountApi(req, res, p) {
  if (/GenerateDeviceRendezvousCode/i.test(p)) return json(res, { RendezvousCode: 'PREVIEW', AuthenticationKey: 'preview' });
  if (/RetrieveDeviceRendezvousStatus/i.test(p)) return json(res, { Status: 2 });   // pending: the sign-in screen stays
  if (/authenticate\/by-device/i.test(p)) return json(res, { AuthenticationKey: 'preview', data: { subscriptionToken: FAKE_TOKEN } });
  json(res, { Fault: { Code: 0, Message: 'not in the preview' } });
}

async function f1tv(req, res, p, search) {
  if (/\/ALL\/USER\/ENTITLEMENT/.test(p)) return json(res, { resultCode: 'OK', resultObj: { entitlementToken: 'preview' } });
  if (/\/ALL\/CONTENT\/PLAY/.test(p)) return play(req, res, new URLSearchParams(search));
  if (/\/ALL\/CONTENT\/USERSELECTIONS|\/ALL\/ACTION\//.test(p)) return json(res, { resultCode: 'OK', resultObj: {} });
  if (/\/ALL\/CONTENT\/LA\//.test(p)) return send(res, 404, 'no licences in the preview');
  if (req.method !== 'GET') return json(res, { resultCode: 'OK', resultObj: {} });
  // The catalog, anonymously: the signed-in path (/R/) as the signed-out one (/A/).
  const url = 'https://f1tv.formula1.com' + p.replace(/^(\/\d+\.\d+)\/R\//, '$1/A/') + search;
  const r = await upstream(url);
  send(res, r.status, r.body, r.type);
}

/** The video's details from F1 (anonymous, cached), for its picture, length and start time. */
async function videoDetail(contentId) {
  const r = await upstream('https://f1tv.formula1.com/4.0/A/ENG/WEB_DASH/ALL/CONTENT/VIDEO/' + encodeURIComponent(contentId) + '/F1_TV_Pro_Annual/2');
  try {
    const c = JSON.parse(r.body).resultObj.containers[0];
    return c && c.metadata;
  } catch (e) { return null; }
}

async function play(req, res, q) {
  const contentId = (q.get('contentId') || '0').replace(/\D/g, '') || '0';
  const channel = (q.get('channelId') || '').replace(/\D/g, '');
  log('play', contentId, channel ? 'channel ' + channel : '', /tvos/.test(req.headers['x-f1-device-info'] || '') ? '(HDR request)' : '');
  const md = await videoDetail(contentId);
  const live = !!(md && /LIVE/i.test(md.contentSubtype || ''));
  const host = 'http://' + req.headers.host;
  // The extra HDR request (only on a TV that reports HDR) gets Pro's SDR answer, which the app drops.
  if (/device=tvos/.test(req.headers['x-f1-device-info'] || '')) return json(res, { resultCode: 'OK', resultObj: { url: host + '/__preview/none.m3u8', streamType: 'SDR_HD_CMAF' } });
  json(res, {
    resultCode: 'OK',
    resultObj: {
      url: host + '/__preview/stream/' + contentId + '/' + (channel || 'main') + '/master.m3u8' + (live ? '?live=1' : ''),
      streamType: 'HLS',
      entitlementToken: 'preview'
    }
  });
}

// ---------------------------------------------------------------- the still-image stream

const making = new Map();

function run(cmd, argv) {
  return new Promise((resolve, reject) => execFile(cmd, argv, { maxBuffer: 1 << 24 }, (err, out, errOut) => err ? reject(new Error(errOut || err.message)) : resolve(out)));
}

/** Encodes one 6 s fMP4 segment of `image` (or a plain card), once per video: init.mp4 + seg.m4s. */
function stillStream(contentId) {
  const dir = path.join(CACHE, 'stream', contentId);
  if (fs.existsSync(path.join(dir, 'seg.m4s'))) return Promise.resolve(dir);
  if (making.has(contentId)) return making.get(contentId);
  const p = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const md = await videoDetail(contentId);
    const img = path.join(dir, 'picture.jpg');
    let input = ['-f', 'lavfi', '-i', 'color=c=0x15151e:s=1920x1080:r=25'];
    if (md && md.pictureUrl && !OFFLINE) {
      try {
        const r = await fetch('https://f1tv.formula1.com/image-resizer/image/' + md.pictureUrl + '?w=1920&h=1080&q=90&o=L');
        if (r.ok) { fs.writeFileSync(img, Buffer.from(await r.arrayBuffer())); }
      } catch (e) { /* plain card */ }
    }
    if (fs.existsSync(img)) input = ['-loop', '1', '-framerate', '25', '-i', img];
    const out = path.join(dir, 'tmp');
    fs.mkdirSync(out, { recursive: true });
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-t', String(SEG),
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x15151e,format=yuv420p',
      '-c:v', 'libx264', '-profile:v', 'main', '-tune', 'stillimage', '-preset', 'veryfast', '-crf', '24', '-bf', '0',
      '-g', String(SEG * 25), '-keyint_min', String(SEG * 25), '-sc_threshold', '0', '-r', '25',
      '-f', 'hls', '-hls_time', String(SEG), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(out, 's%d.m4s'), path.join(out, 'v.m3u8')]);
    fs.renameSync(path.join(out, 'init.mp4'), path.join(dir, 'init.mp4'));
    fs.renameSync(path.join(out, 's0.m4s'), path.join(dir, 'seg.m4s'));
    fs.rmSync(out, { recursive: true, force: true });
    log('made the still stream for', contentId, fs.existsSync(img) ? '(key art)' : '(plain)');
    return dir;
  })().finally(() => making.delete(contentId));
  making.set(contentId, p);
  return p;
}

// 64 kHz: a 6 s segment is a whole number of AAC frames (375 x 1024 samples).
const AUDIO_RATE = 64000;
let silenceMaking = null;

/** One 6 s segment of silent stereo AAC, shared by every video: init.mp4 + seg.m4s. */
function silence() {
  const dir = path.join(CACHE, 'stream', '_silence');
  if (fs.existsSync(path.join(dir, 'seg.m4s'))) return Promise.resolve(dir);
  return silenceMaking || (silenceMaking = (async () => {
    const out = path.join(dir, 'tmp');
    fs.mkdirSync(out, { recursive: true });
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=' + AUDIO_RATE + ':cl=stereo', '-t', String(SEG),
      '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', String(SEG), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(out, 's%d.m4s'), path.join(out, 'a.m3u8')]);
    fs.renameSync(path.join(out, 'init.mp4'), path.join(dir, 'init.mp4'));
    fs.renameSync(path.join(out, 's0.m4s'), path.join(dir, 'seg.m4s'));
    fs.rmSync(out, { recursive: true, force: true });
    return dir;
  })().finally(() => { silenceMaking = null; }));
}

/** The track's ticks per second, from the init segment's mdhd (ffmpeg's HLS muxer picks its own). */
function timescaleOf(file) {
  const d = fs.readFileSync(file), at = d.indexOf('mdhd');
  if (at < 4) throw new Error('no mdhd in ' + file);
  return d.readUInt32BE(at + (d[at + 4] === 1 ? 24 : 16));
}

/** The segment with its decode time moved to segment `n` (tfdt), in `timescale` ticks per second. */
function segmentAt(buf, n, timescale) {
  const out = Buffer.from(buf);
  const at = out.indexOf('tfdt');
  if (at < 4) return out;
  const version = out[at + 4], t = BigInt(n * SEG * timescale);
  if (version === 1) out.writeBigUInt64BE(t, at + 8); else out.writeUInt32BE(Number(t), at + 8);
  const mfhd = out.indexOf('mfhd');
  if (mfhd >= 4) out.writeUInt32BE(n + 1, mfhd + 8);
  return out;
}

async function stream(req, res, rest, search) {
  // /__preview/stream/<contentId>/<feed>/<file>
  const [contentId, feed, file] = rest.split('/');
  const q = new URLSearchParams(search);
  if (file === 'master.m3u8') {
    // As F1's clear web HLS: H.264, plus SDR HEVC at the sizes a multiview is built from. The HEVC variants point
    // at the same H.264 playlist: only the preview's AVPlay (shim.js) "plays" them, and it draws pictures instead.
    // Commentary: silent AAC in two languages (so the language menu has a choice), as F1's audio renditions.
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="eng",NAME="English",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8' + search + '"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="deu",NAME="Deutsch",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8' + (search ? search + '&' : '?') + 'l=deu"',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,AVERAGE-BANDWIDTH=6000000,CODECS="avc1.4d4028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=25.000,AUDIO="aac"',
      'video.m3u8' + search];
    [[480, 270], [640, 360], [960, 540], [1280, 720], [1920, 1080]].forEach(([w, h]) => lines.push(
      '#EXT-X-STREAM-INF:BANDWIDTH=' + Math.round(w * h * 2.5) + ',CODECS="hvc1.1.6.L120.90,mp4a.40.2",RESOLUTION=' + w + 'x' + h + ',FRAME-RATE=50.000,AUDIO="aac"',
      // Its own address: Shaka merges variants that share a playlist URL (the H.264 one then stalled).
      'video.m3u8' + (search ? search + '&' : '?') + 'hevc=' + h));
    return send(res, 200, lines.join('\n') + '\n', TYPES['.m3u8']);
  }
  const audio = /^(audio\.m3u8|audio-init\.mp4|a\d+\.m4s)$/.test(file || '');
  const dir = await (audio ? silence() : stillStream(contentId)).catch((e) => { log('ffmpeg failed:', e.message); return null; });
  if (!dir) return send(res, 500, 'could not make the still stream (is ffmpeg installed?)');
  if (file === 'init.mp4' || file === 'audio-init.mp4') return send(res, 200, fs.readFileSync(path.join(dir, 'init.mp4')), TYPES['.mp4']);
  const m = /^[sa](\d+)\.m4s$/.exec(file || '');
  if (m) return send(res, 200, segmentAt(fs.readFileSync(path.join(dir, 'seg.m4s')), +m[1], timescaleOf(path.join(dir, 'init.mp4'))), TYPES['.m4s']);
  if (file !== 'video.m3u8' && file !== 'audio.m3u8') return send(res, 404, 'not found');

  const md = await videoDetail(contentId) || {};
  const duration = Math.max(SEG, +md.duration || 3600);
  const start = startOf(md);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:' + SEG, '#EXT-X-INDEPENDENT-SEGMENTS'];
  let first = 0, count = Math.ceil(duration / SEG);
  if (q.get('live')) {
    // A live "broadcast" that started an hour ago and keeps growing.
    const t0 = Math.floor(Date.now() / 1000 / SEG) * SEG - 3600;
    count = 3600 / SEG;
    first = t0 / SEG;
    lines.push('#EXT-X-MEDIA-SEQUENCE:' + first);
  } else {
    lines.push('#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0');
  }
  lines.push('#EXT-X-MAP:URI="' + (audio ? 'audio-init.mp4' : 'init.mp4') + '"');
  for (let i = 0; i < count; i++) {
    const n = first + i;
    if (i === 0) lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(q.get('live') ? n * SEG * 1000 : start).toISOString());
    lines.push('#EXTINF:' + SEG.toFixed(3) + ',', (audio ? 'a' : 's') + n + '.m4s');
  }
  if (!q.get('live')) lines.push('#EXT-X-ENDLIST');
  send(res, 200, lines.join('\n') + '\n', TYPES['.m3u8']);
}

function startOf(md) {
  const e = (md && md.emfAttributes) || {};
  const ms = +e.sessionStartDate || Date.parse(e.sessionStartDate || '') || +(md && md.contractStartDate);
  return ms > 0 ? ms : Date.parse('2026-01-01T12:00:00Z');
}

// ---------------------------------------------------------------- the stream helper (multiview) and AVPlay's pictures

const grids = new Map();   // stitch id -> the app's grid description (layout, feeds)
const vods = new Map();    // /vod/<name> -> manifest text

function body(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (b) => c.push(b)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}

async function helper(req, res, p) {
  if (p === '/ping') return json(res, { ok: true, version: 'preview' });
  if (p === '/log') return json(res, []);
  let m = /^\/stitch\/([a-z0-9-]{1,64})(?:\/(layout|prepare))?$/.exec(p);
  if (m && req.method === 'POST') {
    const desc = JSON.parse(await body(req) || '{}');
    if (m[2] === 'prepare') return send(res, 200, '');
    const sh = Layouts.shape(desc.layout);
    if (desc.kind !== 'hevc' || !sh) return send(res, 400, 'the preview draws HEVC multiviews only');
    grids.set(m[1], { layout: desc.layout, feeds: desc.feeds || [], version: Date.now() });
    if (grids.size > 8) grids.delete(grids.keys().next().value);
    log('multiview', m[1], desc.layout, (desc.feeds || []).map((f) => feedOf(f.init).feed).join(' '));
    const info = { width: sh.width, height: sh.height, codecs: 'hvc1.1.6.L153.90' };
    if (m[2] === 'layout') info.from = desc.probe || 0;
    return json(res, info, m[2] ? 200 : 201);
  }
  m = /^\/vod\/([^/]+)$/.exec(p);
  if (m && req.method === 'POST') { vods.set(m[1], await body(req)); return send(res, 201, ''); }
  if (m && vods.has(m[1])) return send(res, 200, vods.get(m[1]), 'application/dash+xml');
  send(res, 404, 'not in the preview helper');
}

/** contentId and feed of a preview stream URL (/__preview/stream/<contentId>/<feed>/...). */
function feedOf(url) {
  const m = /\/__preview\/stream\/(\d+)\/([^/]+)\//.exec(String(url || ''));
  return m ? { contentId: m[1], feed: m[2] } : { contentId: null, feed: null };
}

/** How a feed looks in the preview's AVPlay: the video's key art and the feed's name (and team colour). */
async function feedPicture(contentId, feed) {
  const md = contentId && await videoDetail(contentId) || {};
  const streams = md.additionalStreams || [];
  const s = streams.find((x) => feed === 'main' ? !/channelId=/.test(x.playbackUrl || '') : String(x.channelId) === feed) || {};
  const name = s.driverLastName ? (s.title + ' · ' + (s.driverFirstName || '') + ' ' + s.driverLastName).trim() : (s.title || md.titleBrief || md.title || '');
  return {
    image: md.pictureUrl ? 'https://f1tv.formula1.com/image-resizer/image/' + md.pictureUrl + '?w=960&h=540&q=80&o=L' : null,
    label: name, colour: s.hex || null
  };
}

/** GET /__preview/av?url=<what AVPlay opened>: what the preview's AVPlay shows, and for how long. */
async function avInfo(res, url) {
  const u = new URL(url, 'http://x');
  const vod = /^\/__up\/127\.0\.0\.1(?::\d+)?\/vod\/([^/.]+)/.exec(u.pathname) || /\/vod\/([^/.]+)/.exec(u.pathname);
  const grid = vod && grids.get(vod[1]);
  if (grid) {
    const first = feedOf(grid.feeds[0] && grid.feeds[0].init);
    const md = first.contentId && await videoDetail(first.contentId) || {};
    return json(res, {
      kind: 'grid', layout: grid.layout, version: grid.version, durationMs: (+md.duration || 3600) * 1000,
      feeds: await Promise.all(grid.feeds.map((f) => { const x = feedOf(f.init); return feedPicture(x.contentId, x.feed); }))
    });
  }
  const one = feedOf(u.pathname);
  const md = one.contentId && await videoDetail(one.contentId) || {};
  json(res, { kind: 'single', durationMs: (+md.duration || 3600) * 1000, live: !!u.searchParams.get('live'),
    feeds: [await feedPicture(one.contentId, one.feed)] });
}

// ---------------------------------------------------------------- recordings (optional, local/preview-data)

/** A recorded answer for this URL, if there is one: local/preview-data/<host>/<path>. */
function recorded(host, p) {
  const file = path.normalize(path.join(DATA, host, p));
  if (!file.startsWith(DATA + path.sep)) return null;
  try { return fs.readFileSync(file); } catch (e) { return null; }
}

// ---------------------------------------------------------------- timing: the archive (OpenF1) and the live feed (F1)

async function livetiming(req, res, p, search) {
  if (/^\/signalrcore\/negotiate$/.test(p) && req.method === 'POST') return await negotiate(res, search);
  let m = /^\/static\/(\d{4})\/Index\.json$/.exec(p);
  if (m) {
    try { return json(res, await timing.index(+m[1])); } catch (e) {
      log('timing: no index for', m[1] + ':', e.message);
      return send(res, 503, 'no timing index: ' + e.message);
    }
  }
  m = /^\/static\/(.+\/)([A-Za-z]+)\.jsonStream$/.exec(p);
  if (m) {
    // A recorded session without this feed (LapCount outside races): F1's storage answers 403 for those.
    const dir = path.normalize(path.join(DATA, 'livetiming.formula1.com', path.dirname(p)));
    if (dir.startsWith(DATA + path.sep) && fs.existsSync(dir)) return send(res, 403, 'not in this recording');
    try {
      const r = await timing.feed(decodeURIComponent(m[1]), m[2]);
      return send(res, r.status, r.body, r.status === 200 ? 'application/json' : 'text/plain');
    } catch (e) {
      log('timing:', m[1] + m[2], e.message);
      return send(res, 503, 'no timing data: ' + e.message);
    }
  }
  send(res, 404, 'not in the preview');
}

// F1's live feed (SignalR, anonymous). Its WebSocket needs the AWSALB cookie from the negotiation, which a page
// served from here can't hold for formula1.com: the server keeps it per connection and adds it to the upgrade.
const liveCookies = new Map();

async function negotiate(res, search) {
  if (OFFLINE) return send(res, 503, 'offline');
  try {
    const r = await fetch('https://livetiming.formula1.com/signalrcore/negotiate' + search, { method: 'POST' });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : String(r.headers.get('set-cookie') || '').split(/,(?=\s*AWSALB)/);
    const text = await r.text();
    if (r.ok) {
      const n = JSON.parse(text.replace(/^\uFEFF/, ''));
      liveCookies.set(String(n.connectionToken || n.connectionId), raw.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; '));
      if (liveCookies.size > 20) liveCookies.delete(liveCookies.keys().next().value);
    }
    send(res, r.status, text, r.headers.get('content-type') || 'application/json');
  } catch (e) {
    send(res, 502, 'live feed: ' + e.message);
  }
}

/** The page's (or worker's) WebSocket to F1's live feed, passed through to F1 byte for byte. */
function liveSocket(req, socket, head) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/__up/livetiming.formula1.com/signalrcore' || OFFLINE) return socket.destroy();
  const cookie = liveCookies.get(u.searchParams.get('id') || '') || '';
  const up = tls.connect({ host: 'livetiming.formula1.com', port: 443, servername: 'livetiming.formula1.com' }, () => {
    up.write(['GET /signalrcore' + u.search + ' HTTP/1.1', 'Host: livetiming.formula1.com', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + req.headers['sec-websocket-key'], 'Sec-WebSocket-Version: ' + (req.headers['sec-websocket-version'] || 13),
      'User-Agent: Mozilla/5.0 (preview)'].concat(cookie ? ['Cookie: ' + cookie] : []).join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on('error', (e) => { log('live feed:', e.message); close(); });
  socket.on('error', close);
  up.on('close', close);
  socket.on('close', close);
}

// ---------------------------------------------------------------- live reload

// fs.watch can't watch folders recursively on Linux before Node 20: compare modification times instead.
const clients = new Set();
let stamps = null;

function scan(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'service' && e.name !== 'vendor') scan(f, out); }
    else out.set(f, fs.statSync(f).mtimeMs);
  }
  return out;
}

setInterval(() => {
  let now;
  try { now = scan(APP, new Map()); } catch (e) { return; }
  if (stamps) {
    const changed = [];
    for (const [f, t] of now) if (stamps.get(f) !== t) changed.push(f);
    for (const f of stamps.keys()) if (!now.has(f)) changed.push(f);
    if (changed.length) {
      const cssOnly = changed.every((f) => f.endsWith('.css'));
      log('changed:', changed.map((f) => path.relative(APP, f)).join(', '), cssOnly ? '-> styles' : '-> reload');
      for (const c of clients) c.write('data: ' + (cssOnly ? 'css' : 'reload') + '\n\n');
    }
  }
  stamps = now;
}, 400);

function events(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 1000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ---------------------------------------------------------------- routing

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname, search = u.search;
  try {
    if (pathname === '/__preview/shim.js') return servePreviewFile(res, 'shim.js');
    if (pathname === '/__preview/worker-shim.js') return servePreviewFile(res, 'worker-shim.js');
    if (pathname === '/__preview/events') return events(req, res);
    if (pathname === '/__preview/av') return await avInfo(res, u.searchParams.get('url') || '');
    if (pathname.startsWith('/__preview/stream/')) return await stream(req, res, pathname.slice('/__preview/stream/'.length), search);
    if (pathname === '/__preview/none.m3u8') return send(res, 404, 'no HDR in the preview');

    const up = /^\/__up\/([^/]+)(\/.*)?$/.exec(pathname);
    if (up) {
      const host = up[1], p = up[2] || '/';
      const rec = recorded(host, p);
      if (rec) return send(res, 200, rec, TYPES[path.extname(p)] || 'application/json');
      if (host === 'f1tv.formula1.com') return await f1tv(req, res, p, search);
      if (host === 'api.formula1.com') return await accountApi(req, res, p);
      if ((host === 'api.jolpi.ca' || host === 'api.github.com') && req.method === 'GET') {
        const r = await upstream('https://' + host + p + search);
        return send(res, r.status, r.body, r.type);
      }
      if (host === 'livetiming.formula1.com') return await livetiming(req, res, p, search);
      if (/^127\.0\.0\.1(:\d+)?$/.test(host)) return await helper(req, res, p);
      // Anything else the app asks for: not in the preview.
      log('not routed:', req.method, host + p);
      return send(res, 404, 'not in the preview: ' + host);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'no');
    serveApp(req, res, pathname);
  } catch (e) {
    log('error', req.url, e && e.stack || e);
    if (!res.headersSent) send(res, 500, String(e && e.message || e));
  }
});

server.on('upgrade', liveSocket);

server.listen(PORT, HOST, () => {
  log('F1 TV UI preview: http://' + HOST + ':' + PORT + '/' + (OFFLINE ? '  (offline: cached answers only)' : ''));
  log('app files from', APP);
});
