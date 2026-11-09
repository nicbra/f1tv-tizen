/*
 * Local audio proxy for AVPlay. F1's CBCS audio segments report zero senc samples despite
 * having hundreds in the fragment. Correcting the count lets AVPlay accept them; the entries
 * are empty (constant IV, no subsamples). Widevine handles decryption; video goes to the CDN.
 *
 *   GET /ping -> "ok"
 *   GET /mpd?u=<url>[&shift=<seconds>][&audio=eng][&text=eng] -> rewritten manifest
 *       shift delays the live edge; audio/text put the preferred tracks first for AVPlay.
 *   GET /s/<b64 base>/<file> -> segment with its sample count patched if needed
 *   POST/GET /vod/<id>.mpd -> a replay manifest the app prepared (native HDR replays)
 *   POST /hdr/<id> -> a live HLG video AdaptationSet; /mpd?...&hdr=<id> puts it in place of the
 *       official video, with that video's current SegmentTimeline; &notext=1 drops subtitle sets
 *   GET /log -> the last requests (kind, CDN host, status, time, error; no paths or tokens), for diagnosis
 *   POST /stitch/<id> { kind: 'h264x', ... } -> an H.264 replay's small multiview feeds interleaved (stitchx/)
 *   POST /stitch/<id> {"urls": [feed manifests], "height": 540} -> multiview (experiment, stitch.js):
 *       GET /stitch/<id>.mpd, /stitch/<id>/init.mp4 and /stitch/<id>/<number>.m4s give the feeds
 *       stacked into one video, with the first feed's audio and subtitles
 */
'use strict';

var http = require('http');
var https = require('https');
var urlLib = require('url');

var PORT = 18765;
var UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) TV Safari/537.36';
var server = null;
var vodManifests = [];
var recent = [];   // the last requests: AVPlay's requests here are otherwise invisible to the app

/**
 * F1's CDNs, the only hosts the helper fetches from. F1 hands out a CDN per play request: its own
 * (ott-video-cf / ott-video-fl.formula1.com) or Akamai (f1prodlive.akamaized.net, Qualifying
 * 2026-10-31). Refusing Akamai's audio made AVPlay fail with PLAYER_ERROR_CONNECTION_FAILED.
 */
function f1Cdn(url) {
  return /^https:\/\/(?:[a-z0-9-]+\.)+formula1\.com\//.test(url || '') || /^https:\/\/f1prod[a-z0-9-]*\.akamaized\.net\//.test(url || '');
}

function kindOf(u) {
  if (u.pathname === '/mpd') return u.query.hdr ? 'live-hdr-mpd' : 'mpd';
  if (/^\/s\//.test(u.pathname)) return 'audio';
  if (/^\/vod\//.test(u.pathname)) return 'vod-mpd';
  if (/^\/hdr\//.test(u.pathname)) return 'hdr-set';
  if (/^\/stitch\//.test(u.pathname)) return 'stitch';
  return u.pathname === '/ping' || u.pathname === '/log' ? null : 'other';
}

/** Records each answered request (not /ping or /log) in `recent`. */
function logged(req, res, u) {
  var kind = kindOf(u), t0 = Date.now();
  if (!kind) return res;
  var head = res.writeHead;
  res.writeHead = function (status) {
    var host = '';
    try { host = u.pathname === '/mpd' ? urlLib.parse(String(u.query.u)).host : /^\/s\/([^/]+)\//.test(u.pathname) ? urlLib.parse(b64urlDecode(RegExp.$1)).host : ''; } catch (e) { /* no host */ }
    var entry = { at: new Date(t0).toISOString(), kind: kind, method: req.method || 'GET', host: host, status: status, ms: Date.now() - t0 };
    // Multiview: which segment, where the time went, and why it failed (no URLs or tokens).
    if (res.f1) Object.keys(res.f1).forEach(function (k) { entry[k] = res.f1[k]; });
    recent.push(entry);
    if (recent.length > 200) recent.shift();   // a few minutes of live multiview
    return head.apply(res, arguments);
  };
  return res;
}

/** cb(err, status, body, headers, finalUrl): finalUrl is where redirects led. */
/**
 * ua: the user agent to send; the TV browser's for multiview, as Akamai only serves a stream's media to
 * the user agent that opened it (403 "Access Denied" otherwise, Mexico 2026).
 */
var browserUa = null;   // the TV browser's user agent, once the app has sent it (multiview)

function fetchBuffer(target, redirects, cb, ua) {
  var opts = urlLib.parse(target);
  opts.headers = { 'User-Agent': ua || browserUa || UA };
  var lib = opts.protocol === 'http:' ? http : https;
  var req = lib.get(opts, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
      res.resume();
      return fetchBuffer(urlLib.resolve(target, res.headers.location), redirects - 1, cb, ua);
    }
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(null, res.statusCode, Buffer.concat(chunks), res.headers, target); });
    res.on('error', function (e) { cb(e); });
  });
  req.setTimeout(15000, function () { req.abort(); });
  req.on('error', function (e) { cb(e); });
}

// Buffer.from is missing on very old Node versions; new Buffer() is deprecated on new ones.
function toBuf(s, enc) {
  return typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from ? Buffer.from(s, enc) : new Buffer(s, enc);
}

function b64urlEncode(s) {
  return toBuf(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return toBuf(s, 'base64').toString('utf8');
}

/** Finds a box by type inside [start, end) of a flat run of boxes. */
function findBox(buf, type, start, end) {
  var off = start;
  while (off + 8 <= end) {
    var size = buf.readUInt32BE(off);
    if (size < 8 || off + size > end) return -1;
    if (buf.toString('ascii', off + 4, off + 8) === type) return off;
    off += size;
  }
  return -1;
}

/** Sets senc.sample_count to trun.sample_count when senc has no flags and claims 0 samples. */
function patchSenc(buf) {
  var moof = findBox(buf, 'moof', 0, buf.length);
  if (moof < 0) return buf;
  var moofEnd = moof + buf.readUInt32BE(moof);
  var traf = findBox(buf, 'traf', moof + 8, moofEnd);
  if (traf < 0) return buf;
  var trafEnd = traf + buf.readUInt32BE(traf);
  var trun = findBox(buf, 'trun', traf + 8, trafEnd);
  var senc = findBox(buf, 'senc', traf + 8, trafEnd);
  if (trun < 0 || senc < 0) return buf;
  var sencFlags = buf.readUInt32BE(senc + 8) & 0xffffff;
  if (sencFlags !== 0 || buf.readUInt32BE(senc + 12) !== 0) return buf;
  buf.writeUInt32BE(buf.readUInt32BE(trun + 12), senc + 12);
  return buf;
}

function attr(attrs, name) {
  var m = new RegExp('\\s' + name + '="([^"]*)"').exec(attrs);
  return m ? m[1] : null;
}

function isoSeconds(d) {
  var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(d || '');
  return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0)) : 0;
}

/**
 * Move availabilityStartTime forward by `shift` seconds and trim SegmentTimelines to that
 * delayed live edge. AVPlay ignores large presentation delays and refuses early live seeks.
 */
function timeShift(mpd, shift, nowMs) {
  var astText = attr(mpd.slice(0, mpd.indexOf('>', mpd.indexOf('<MPD'))), 'availabilityStartTime');
  if (!astText || !/type="dynamic"/.test(mpd)) return mpd;
  var ast = Date.parse(astText);
  var periodStart = isoSeconds(attr((/<Period\b[^>]*>/.exec(mpd) || [''])[0], 'start'));
  var edgeSeconds = (nowMs - shift * 1000 - ast) / 1000 - periodStart; // shifted edge, period time

  var shifted = mpd.replace(/<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/g, function (all, attrs, inner) {
    var ts = +attr(attrs, 'timescale') || 1, pto = +attr(attrs, 'presentationTimeOffset') || 0;
    var cut = pto + edgeSeconds * ts; // media time of the shifted live edge
    inner = inner.replace(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/, function (x, body) {
      var out = [], t = null;
      body.replace(/<S\b([^>]*)\/>/g, function (tag, a) {
        if (attr(a, 't') != null) t = +attr(a, 't');
        var d = +attr(a, 'd'), r = +(attr(a, 'r') || 0);
        if (t == null || !d) return tag;
        var n = Math.max(0, Math.min(r + 1, Math.floor((cut - t) / d)));
        if (n > 0) out.push('<S t="' + t + '" d="' + d + '"' + (n > 1 ? ' r="' + (n - 1) + '"' : '') + '/>');
        t += (r + 1) * d;
        return tag;
      });
      return '<SegmentTimeline>' + out.join('') + '</SegmentTimeline>';
    });
    return '<SegmentTemplate' + attrs + '>' + inner + '</SegmentTemplate>';
  });
  // Drop tracks that have no segments at the shifted time.
  mpd = shifted.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, function (set) {
    return /<SegmentTimeline><\/SegmentTimeline>/.test(set) ? '' : set;
  });
  return mpd.replace(/availabilityStartTime="[^"]*"/, 'availabilityStartTime="' + new Date(ast + shift * 1000).toISOString() + '"');
}

/**
 * Live HDR: the official video AdaptationSet (the first one) becomes the stored HLG set, whose
 * templates take the official SegmentTimeline of this refresh. F1 numbers and times both alike.
 */
function useHdrVideo(mpd, adaptation) {
  var sets = [], re = /<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, m;
  while ((m = re.exec(mpd))) sets.push({ text: m[0], at: m.index });
  var video = sets.filter(function (b) { return /\scontentType="video"/.test(b.text.slice(0, b.text.indexOf('>'))); })[0];
  var timeline = video && /<SegmentTimeline>[\s\S]*?<\/SegmentTimeline>/.exec(video.text);
  if (!timeline) return null;
  var hdr = adaptation.split('<!--timeline-->').join(timeline[0]);
  // This refresh's addressing too, not only its timeline: should F1 move the window's start (startNumber,
  // offset), the swapped-in video must number its segments as the official one does.
  var official = /<SegmentTemplate\b([^>]*)>/.exec(video.text);
  if (official) ['startNumber', 'timescale', 'presentationTimeOffset'].forEach(function (name) {
    var v = attr(official[1], name);
    if (v != null) hdr = hdr.replace(new RegExp('(<SegmentTemplate\\b[^>]*\\s' + name + '=")[^"]*"', 'g'), function (all, head) { return head + v + '"'; });
  });
  return mpd.slice(0, video.at) + hdr + mpd.slice(video.at + video.text.length);
}

function setKind(block) {
  if (/contentType="audio"/.test(block)) return 'audio';
  if (/contentType="text"/.test(block) || /codecs="stpp/.test(block) || /codecs="wvtt/.test(block)) return 'text';
  return null;
}

/** AVPlay defaults to the first track; put the preferred audio/subtitle language first. */
function preferLanguages(mpd, prefs) {
  var blocks = [];
  mpd.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, function (b, at) { blocks.push({ text: b, at: at }); return b; });
  if (!blocks.length) return mpd;
  var order = blocks.map(function (b) { return b.text; });
  ['audio', 'text'].forEach(function (kind) {
    var lang = prefs[kind];
    if (!lang) return;
    var slots = [], sets = [];
    blocks.forEach(function (b, i) { if (setKind(b.text) === kind) { slots.push(i); sets.push(b.text); } });
    var pick = sets.filter(function (t) { return new RegExp('lang="' + lang + '(-[^"]*)?"').test(t); })[0];
    if (!pick) return;
    var rest = sets.filter(function (t) { return t !== pick; });
    [pick].concat(rest).forEach(function (t, k) { order[slots[k]] = t; });
  });
  var out = '', pos = 0;
  blocks.forEach(function (b, i) { out += mpd.slice(pos, b.at) + order[i]; pos = b.at + b.text.length; });
  return out + mpd.slice(pos);
}

function rewriteManifest(mpd, manifestUrl) {
  var base = manifestUrl.split('?')[0];
  base = base.substring(0, base.lastIndexOf('/') + 1);
  var proxied = 'http://127.0.0.1:' + PORT + '/s/' + b64urlEncode(base) + '/';
  // Everything resolves against the CDN; audio sets get their own BaseURL pointing here.
  mpd = mpd.replace(/(<Period\b[^>]*>)/, '$1<BaseURL>' + base + '</BaseURL>');
  return mpd.replace(/(<AdaptationSet\b[^>]*contentType="audio"[^>]*>)/g, '$1<BaseURL>' + proxied + '</BaseURL>');
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function handle(req, res) {
  var u = urlLib.parse(req.url, true);
  if (u.pathname === '/ping') return send(res, 200, toBuf('ok'));
  if (u.pathname === '/log') return send(res, 200, toBuf(JSON.stringify(recent)), 'application/json');
  res = logged(req, res, u);

  if (/^\/(?:vod\/[a-z0-9-]{1,64}\.mpd|hdr\/[a-z0-9-]{1,64})$/.test(u.pathname)) {
    vodManifests = vodManifests.filter(function (m) { return Date.now() - m.at < 6 * 3600000; });
    if (req.method === 'POST') {
      var chunks = [], size = 0;
      req.on('data', function (b) { size += b.length; if (size <= 2 * 1024 * 1024) chunks.push(b); });
      req.on('end', function () {
        if (size > 2 * 1024 * 1024) return send(res, 413, toBuf('manifest too large'));
        var body = Buffer.concat(chunks);
        var text = body.toString('utf8');
        if (/^\/vod\//.test(u.pathname) ? !/<MPD\b[^>]*\btype="static"/.test(text) :
          !/^<AdaptationSet\b[\s\S]*<!--timeline-->[\s\S]*<\/AdaptationSet>$/.test(text)) return send(res, 400, toBuf('unexpected body'));
        vodManifests = vodManifests.filter(function (m) { return m.path !== u.pathname; });
        vodManifests.push({ path: u.pathname, at: Date.now(), body: body });
        if (vodManifests.length > 4) vodManifests.shift();
        send(res, 201, toBuf('ok'));
      });
      return;
    }
    var saved = vodManifests.filter(function (m) { return m.path === u.pathname; })[0];
    if (!saved || !/^\/vod\//.test(u.pathname)) return send(res, 404, toBuf('not found'));
    saved.at = Date.now();
    return send(res, 200, saved.body, 'application/dash+xml');
  }

  if (/^\/stitch\//.test(u.pathname)) return stitchRequest(req, res, u);


  if (u.pathname === '/mpd' && u.query.u) {
    var manifestUrl = String(u.query.u);
    return fetchBuffer(manifestUrl, 3, function (err, status, body, headers, finalUrl) {
      if (err) return send(res, 502, toBuf(String(err)));
      if (status !== 200) return send(res, status, body);
      // Segments are relative to where a redirect led, not to the requested address; but the audio
      // proxy only fetches from F1's CDNs, so a redirect elsewhere keeps the requested base.
      var base = f1Cdn(finalUrl) ? finalUrl : manifestUrl;
      var mpd = body.toString('utf8');
      if (u.query.hdr) {
        var stored = vodManifests.filter(function (m) { return m.path === '/hdr/' + u.query.hdr; })[0];
        mpd = stored ? useHdrVideo(mpd, stored.body.toString('utf8')) : null;
        // Fails the manifest, so the player reports it and the app plays SDR.
        if (!mpd) return send(res, 502, toBuf('no HDR video for this manifest'));
        stored.at = Date.now();
      }
      if (u.query.notext) mpd = mpd.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, function (b) { return setKind(b) === 'text' ? '' : b; });
      mpd = rewriteManifest(mpd, base);
      if (+u.query.shift > 0) mpd = timeShift(mpd, +u.query.shift, Date.now());
      if (u.query.audio || u.query.text) mpd = preferLanguages(mpd, { audio: u.query.audio, text: u.query.text });
      send(res, 200, toBuf(mpd, 'utf8'), 'application/dash+xml');
    });
  }

  var m = /^\/s\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (m) {
    var target = b64urlDecode(m[1]) + m[2] + (u.search || '');   // keep a segment's query (CDN tokens)
    if (!f1Cdn(target)) return send(res, 403, toBuf('forbidden'));
    return fetchBuffer(target, 3, function (err, status, body, headers) {
      if (err) return send(res, 502, toBuf(String(err)));
      if (status !== 200) return send(res, status, body);
      send(res, 200, patchSenc(body), headers['content-type'] || 'video/mp4');
    });
  }

  send(res, 404, toBuf('not found'));
}

// --- Multiview by stitching (experiment) ---

var stitch = null, stitchHevc = null;
try { stitch = require('./stitch'); stitchHevc = require('./stitch-hevc'); } catch (e) { console.log('stitch unavailable: ' + e); }

/** HEVC grid: a feed's media segment n (0-based) from its template or list. */
/** n: the index in the playlist, or for live (`absolute`) the segment number itself (as in the DASH timeline). */
function hevcSegmentUrl(feed, n) {
  if (feed.urls) return feed.urls[n];
  return feed.media.replace(/\$Number(?:%0(\d+)d)?\$/g, function (m, w) {
    var s = String(feed.absolute ? n : feed.startNumber + n); while (s.length < (+w || 0)) s = '0' + s; return s;
  });
}

/**
 * POST /stitch/<id> with { kind: 'hevc', layout: name or { cols, rows, cells }, feeds: [{ init, media, startNumber, count } | { init, urls }] }
 * (see stitch-hevc.js LAYOUTS).
 */
function hevcGridPost(res, id, body) {
  buildGrid(body, function (status, err, grid) {
    if (err) return send(res, status, toBuf(err));
    stitches[id] = grid;
    var ids = Object.keys(stitches);
    if (ids.length > 2) delete stitches[ids[0]];
    send(res, 201, toBuf(JSON.stringify(grid.info)), 'application/json');
    warmNext(grid, grid.cache[0].number);
  });
}

/**
 * POST /stitch/<id>/layout, with a body as for a new grid: the running grid rearranged (other feeds, another
 * layout). AVPlay keeps the init segment it has; the new segments carry their own parameter sets (hev1).
 * Takes effect for every segment built from now on.
 */
function hevcRegridPost(res, id, body) {
  var old = stitches[id];
  if (!old || old.kind !== 'hevc') return send(res, 404, toBuf('no such grid'));
  if (!!body.live !== old.live) return send(res, 400, toBuf('live and replay grids differ'));
  buildGrid(body, function (status, err, grid) {
    if (err) return send(res, status, toBuf(err));
    // The licence AVPlay has is for the running grid's key.
    if (grid.cfg.enc !== old.cfg.enc) return send(res, 422, toBuf('the new feeds are encrypted differently'));
    grid.init = old.init;
    // Builds under way finish for whoever asked for them, in the old arrangement; a request from now on gets the
    // new one (grid.pending starts empty), or the picture would switch back for a segment and the frames not match.
    stitches[id] = grid;
    // Where the new arrangement starts (the probe segment), for the player to go to.
    grid.info.from = grid.cache[0].number;
    send(res, 200, toBuf(JSON.stringify(grid.info)), 'application/json');
    warmNext(grid, grid.cache[0].number);
  });
}

/** Fetches the feeds' init and probe segments, prepares the grid and stitches the probe; cb(status, error, grid). */
function buildGrid(body, cb) {
  var feeds = body.feeds || [];
  if (feeds.length < 1 || feeds.length > 9) return cb(400, 'need 1-9 feeds');
  var live = !!body.live, count0 = feeds[0].urls ? feeds[0].urls.length : feeds[0].count;
  var probe = live ? +body.probe : Math.max(0, Math.min(count0 - 1, +body.probe || 0)), all = [];
  if (live && !(probe > 0 && feeds.every(function (f) { return f.absolute && f.media; }))) return cb(400, 'live grids need absolute numbers');
  feeds.forEach(function (f) { all.push(f.init, hevcSegmentUrl(f, probe)); });
  if (!all.every(function (u) { return f1Cdn(String(u)); })) return cb(400, 'need F1 media');
  var count = live ? Infinity : feeds[0].urls ? feeds[0].urls.length : feeds[0].count, ua = body.ua ? String(body.ua).slice(0, 300) : null;
  // Akamai serves a stream only to the user agent that opened it: the manifest and commentary too.
  if (ua) browserUa = ua;
  if (body.prepareOnly) {
    // Only fetch the inputs now (the viewer is choosing); the grid is built when chosen, a moment later:
    // the segment after too.
    var later = feeds.map(function (f) { return hevcSegmentUrl(f, probe + 1); }).filter(function (u) { return u && f1Cdn(String(u)); });
    return fetchInputs(all.concat(live || probe + 1 < count0 ? later : []), function (err) { cb(err ? 502 : 204, err ? String(err) : null, null); }, 2, ua, live);
  }
  fetchInputs(all, function (err, got) {
    if (err) return cb(502, String(err));
    try {
      var inits = [], firsts = [];
      got.forEach(function (b, i) { (i % 2 ? firsts : inits).push(b); });
      var g = stitchHevc.prepare(inits, firsts, body.layout || 'grid2x2', 50);
      // Stitch the probe now: it proves the feeds fit together, and is likely the first segment asked for.
      var warm = stitchHevc.gridSegment(firsts, g.cfg);
      cb(200, null, { kind: 'hevc', live: live, feeds: feeds, count: count, init: g.init, cfg: g.cfg, cache: [{ number: probe, body: warm }],
        pending: {}, at: Date.now(), ua: ua, info: { width: g.width, height: g.height, codecs: g.codecs } });
    } catch (e) { cb(422, String(e && e.message || e)); }
  }, 2, ua, live);
}

var stitches = {};   // id -> { kind, feeds, count, init, cfg, cache, at } (and mpd for the H.264 stack)

/*
 * POST /stitch/<id> { kind: 'h264x', feeds: [{ playlist }], interleave: true, feedTag: true, ... } (stitchx/helper-route.js):
 * an H.264 replay's small multiview feeds (2018-2024 have no HEVC) as ONE stream of their frames one after another, each
 * picture marked with its feed; the app decodes it with Samsung's software decoder beside the big feed on AVPlay
 * (js/mvsoft.js). GET /stitch/<id>/init.mp4 and /<n>.m4s give it, segments built on demand like the HEVC grids'.
 */
// The TV's Node lacks these ES2015 helpers.
if (!Object.assign) Object.assign = function (t) { for (var i = 1; i < arguments.length; i++) { var o = arguments[i]; if (o) for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) t[k] = o[k]; } return t; };
if (!Array.prototype.fill) Array.prototype.fill = function (v) { for (var i = 0; i < this.length; i++) this[i] = v; return this; };
var stitchx = null, stitchxError = null;
try { stitchx = require('./stitchx/helper-route.js')({ fetchAll: fetchAll, send: send, toBuf: toBuf, f1Cdn: f1Cdn, port: PORT, stitches: stitches }); }
catch (e) { stitchxError = String(e && e.message || e); console.log('stitchx unavailable: ' + stitchxError); }

/**
 * Fetches all urls in parallel. F1's CDN sometimes refuses one of a burst (HTTP 403, Mexico 2026 grids)
 * although the file exists: such answers, server errors and network errors are retried three times,
 * within ~2 s (AVPlay gives up on a segment after ~5 s).
 * `missing`: also retry 404 (live: a feed's newest segment may reach the CDN a moment after another's).
 */
/*
 * A minute's worth of fetched grid inputs (inits and first segments), so a multiview prepared while the viewer
 * chooses (POST /stitch/<id>/prepare) starts at once when chosen. A few entries: 1080p segments are ~4 MB.
 */
var inputs = [];
function cachedInput(u) {
  inputs = inputs.filter(function (c) { return Date.now() - c.at < 60000; });
  var hit = inputs.filter(function (c) { return c.url === u; })[0];
  return hit ? hit.body : null;
}
function keepInput(u, body) {
  inputs = inputs.filter(function (c) { return c.url !== u; });
  inputs.push({ url: u, body: body, at: Date.now() });
  if (inputs.length > 12) inputs.shift();
}

/** fetchAll with the grid input cache: answers from it, and keeps what it fetched. */
function fetchInputs(urls, cb, parallel, ua, missing) {
  var have = urls.map(cachedInput), want = [], at = [];
  urls.forEach(function (u, i) { if (!have[i]) { want.push(u); at.push(i); } });
  if (!want.length) return cb(null, have);
  fetchAll(want, function (err, got) {
    if (err) return cb(err);
    got.forEach(function (b, k) { have[at[k]] = b; keepInput(want[k], b); });
    cb(null, have);
  }, parallel, ua, missing);
}

function fetchAll(urls, cb, parallel, ua, missing) {
  var out = [], left = urls.length, failed = false, next = 0, limit = parallel || urls.length;
  function start(i) {
    (function attempt(tries) {
      fetchBuffer(urls[i], 3, function (err, status, body) {
        if (failed) return;
        if ((err || status === 403 || status === 429 || status >= 500 || (missing && status === 404)) && tries < 3) return setTimeout(function () { attempt(tries + 1); }, 300 * (tries + 1));
        if (err || status !== 200) {
          failed = true;
          var why = err ? String(err).replace(/https?:\/\/\S*/g, '') : 'HTTP ' + status;
          return cb(new Error(why + ' (request ' + i + ', ' + (urlLib.parse(urls[i]).host || '') + ')'));
        }
        out[i] = body;
        if (--left === 0) return cb(null, out);
        if (next < urls.length) start(next++);
      }, ua);
    })(0);
  }
  while (next < Math.min(limit, urls.length)) start(next++);
}

/** A feed's video template for the representation of the given height. */
function feedVideo(mpd, manifestUrl, height) {
  var set = (mpd.match(/<AdaptationSet\b[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/) || [])[0];
  if (!set) throw new Error('no video set');
  var tpl = (set.match(/<SegmentTemplate\b[^>]*>/) || [])[0];
  var reps = set.match(/<Representation\b[^>]*>/g) || [];
  var rep = reps.filter(function (r) { return attr(r, 'height') === String(height); })[0];
  if (!tpl || !rep) throw new Error('no ' + height + 'p video');
  var base = manifestUrl.split('?')[0];
  base = base.substring(0, base.lastIndexOf('/') + 1);
  var baseTag = (mpd.match(/<BaseURL>([^<]*)<\/BaseURL>/) || [])[1];
  if (baseTag) base = urlLib.resolve(base, baseTag);
  function fill(t) { return t.replace(/\$RepresentationID\$/g, attr(rep, 'id')).replace(/\$Bandwidth\$/g, attr(rep, 'bandwidth')); }
  return { set: set, rep: rep, base: base, media: fill(attr(tpl, 'media')), init: fill(attr(tpl, 'initialization')),
    start: +(attr(tpl, 'startNumber') || 1) };
}

function segmentUrl(feed, number) {
  return urlLib.resolve(feed.base, feed.media.replace(/\$Number(?:%0(\d+)d)?\$/g, function (m, w) {
    var s = String(number); while (s.length < (+w || 0)) s = '0' + s; return s;
  }));
}

/** The first feed's manifest with its video replaced by the stacked video. */
function stitchManifest(mpd, manifestUrl, id, first, stacked, feeds) {
  var local = 'http://127.0.0.1:' + PORT + '/stitch/' + id;
  var bandwidth = feeds.reduce(function (sum, f) { return sum + (+attr(f.rep, 'bandwidth') || 0); }, 0);
  var rep = '<Representation id="stitch" bandwidth="' + bandwidth + '" codecs="' + stacked.codecs + '" frameRate="' +
    (attr(first.rep, 'frameRate') || '50/1') + '" width="' + stacked.width + '" height="' + stacked.height + '"/>';
  var set = first.set
    .replace(/<InbandEventStream\b[^>]*\/>\s*/g, '')
    .replace(/<Representation\b[^>]*\/>\s*/g, '')
    .replace(/<Representation\b[\s\S]*?<\/Representation>\s*/g, '')
    .replace(/(<SegmentTemplate\b[^>]*?)\smedia="[^"]*"/, '$1 media="' + local + '/$Number$.m4s"')
    .replace(/(<SegmentTemplate\b[^>]*?)\sinitialization="[^"]*"/, '$1 initialization="' + local + '/init.mp4"')
    .replace(/<\/AdaptationSet>$/, rep + '</AdaptationSet>');
  mpd = rewriteManifest(mpd, manifestUrl);
  return mpd.replace(/<AdaptationSet\b[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/, function () { return set; });
}

function stitchRequest(req, res, u) {
  if (!stitch) return send(res, 501, toBuf('stitching unavailable'));
  var m = /^\/stitch\/([a-z0-9-]{1,64})(?:\.mpd|\/(init\.mp4|audio-init\.mp4|a?\d+\.m4s|layout|prepare))?$/.exec(u.pathname);
  if (!m) return send(res, 404, toBuf('not found'));
  var id = m[1], what = m[2] || (/\.mpd$/.test(u.pathname) ? 'mpd' : null);
  if (req.method === 'POST' && (!what || what === 'layout' || what === 'prepare')) {
    var chunks = [];
    req.on('data', function (b) { chunks.push(b); });
    req.on('end', function () {
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, 400, toBuf('bad json')); }
      if (what === 'prepare') {
        if (!stitches[id]) return send(res, 404, toBuf('no such grid'));
        body.prepareOnly = true;
        return buildGrid(body, function (status, err) { send(res, status, toBuf(err || '')); });
      }
      if (what === 'layout') return hevcRegridPost(res, id, body);
      if (body.kind === 'hevc') return hevcGridPost(res, id, body);
      if (body.kind === 'h264x') return stitchx ? stitchx.post(res, id, body) : send(res, 501, toBuf('stitchx unavailable: ' + stitchxError));
      var urls = (body.urls || []).map(String);
      if (urls.length < 2 || urls.length > 4 || !urls.every(f1Cdn)) return send(res, 400, toBuf('need 2-4 F1 manifests'));
      fetchAll(urls, function (err, mpds) {
        if (err) return send(res, 502, toBuf(String(err)));
        var feeds, texts = mpds.map(function (b) { return b.toString('utf8'); });
        try { feeds = texts.map(function (t, i) { return feedVideo(t, urls[i], body.height || 540); }); }
        catch (e) { return send(res, 422, toBuf(String(e))); }
        fetchAll(feeds.map(function (f) { return urlLib.resolve(f.base, f.init); }), function (err2, inits) {
          if (err2) return send(res, 502, toBuf(String(err2)));
          try {
            var cfgs = inits.map(stitch.avcConfig);
            cfgs.forEach(function (c, i) {
              if (c.spsRaw.toString('hex') !== cfgs[0].spsRaw.toString('hex') || c.ppsRaw.toString('hex') !== cfgs[0].ppsRaw.toString('hex'))
                throw new Error('feed ' + i + ' has different SPS/PPS');
            });
            var stacked = stitch.stackInit(inits[0], feeds.length, 50);
            Object.keys(stitches).forEach(function (k) { if (Date.now() - stitches[k].at > 6 * 3600000) delete stitches[k]; });
            stitches[id] = { feeds: feeds, init: stacked.init, cfg: cfgs[0], cache: [], at: Date.now(),
              mpd: toBuf(stitchManifest(texts[0], urls[0], id, feeds[0], stacked, feeds), 'utf8') };
            var ids = Object.keys(stitches);
            if (ids.length > 2) delete stitches[ids[0]];
            send(res, 201, toBuf(JSON.stringify({ width: stacked.width, height: stacked.height, codecs: stacked.codecs })), 'application/json');
          } catch (e) { send(res, 422, toBuf(String(e && e.message || e))); }
        });
      });
    });
    return;
  }
  var s = stitches[id];
  if (!s || !what) return send(res, 404, toBuf('not found'));
  s.at = Date.now();
  if (s.kind === 'h264x') return stitchx.get(res, s, what, id);
  if (what === 'mpd') return send(res, 200, s.mpd, 'application/dash+xml');
  if (what === 'init.mp4') return send(res, 200, s.init, 'video/mp4');
  var number = parseInt(what, 10);
  if (s.kind === 'hevc' && !(number >= 0 && number < s.count)) return send(res, 404, toBuf('no such segment'));
  segmentFor(s, number, function (status, body, timing) {
    res.f1 = timing;
    send(res, status, body, status === 200 ? 'video/mp4' : 'text/plain');
  });
}

/**
 * Segment `number` of a grid: from the cache, from a build already under way, or built now (the feeds'
 * segments fetched and stitched). cb(status, body, timing). The cache keeps a few: a 4K grid's is ~20 MB.
 */
function segmentFor(s, number, cb) {
  var hit = s.cache.filter(function (c) { return c.number === number; })[0];
  if (hit) return cb(200, hit.body, { segment: number, cached: true });
  // A live grid keeps getting used for hours: keep it from expiring.
  s.at = Date.now();
  s.pending = s.pending || {};
  if (s.pending[number]) return s.pending[number].push(cb);
  var waiting = s.pending[number] = [cb], first = s.feeds[0], hevc = s.kind === 'hevc';
  var t0 = Date.now(), timing = { segment: number };
  function answer(status, body) {
    delete s.pending[number];
    if (status !== 200) timing.why = String(body).slice(0, 200);
    waiting.forEach(function (w) { w(status, body, timing); });
  }
  var segUrls = s.feeds.map(function (f) { return hevc ? hevcSegmentUrl(f, number) : segmentUrl(f, number - first.start + f.start); });
  fetchAll(segUrls, function (err, segs) {
    timing.fetchMs = Date.now() - t0;
    if (err) return answer(502, toBuf(String(err)));
    var out, t1 = Date.now();
    try { out = hevc ? stitchHevc.gridSegment(segs, s.cfg) : stitch.stackSegment(segs, s.cfg); }
    catch (e) { return answer(422, toBuf(String(e && e.message || e))); }
    timing.stitchMs = Date.now() - t1;
    timing.mb = Math.round(out.length / 1e5) / 10;
    s.cache.push({ number: number, body: out });
    if (s.cache.length > 4) s.cache.shift();
    answer(200, out);
  }, 0, s.ua, s.live);
}

/**
 * The two segments after the one just built, made ready in the background, one after the other: a grid
 * starts or changes there, and after a seek AVPlay wants ~4 s of buffer before it plays on.
 */
function warmNext(s, number) {
  if (s.kind !== 'hevc') return;
  if (number + 1 < s.count) segmentFor(s, number + 1, function () {
    if (stitches[Object.keys(stitches).filter(function (k) { return stitches[k] === s; })[0]] && number + 2 < s.count) segmentFor(s, number + 2, function () {});
  });
}

function start() {
  if (server) return;
  server = http.createServer(handle);
  server.on('error', function (e) { console.log('proxy error: ' + e); });
  server.listen(PORT, '127.0.0.1');
}

module.exports.onStart = start;
module.exports.useHdrVideo = useHdrVideo;
module.exports.onRequest = start;
module.exports.onExit = function () {
  if (server) server.close();
  server = null;
};
