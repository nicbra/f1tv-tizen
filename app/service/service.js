/*
 * Local audio proxy for AVPlay. F1's CBCS audio segments report zero senc samples despite
 * having hundreds in the fragment. Correcting the count lets AVPlay accept them; the entries
 * are empty (constant IV, no subsamples). Widevine handles decryption; video goes to the CDN.
 *
 *   GET /ping -> "ok" (the installed shell wraps this with the bundle version)
 *   GET /mpd?u=<url>[&shift=<seconds>][&audio=eng][&text=eng] -> rewritten manifest
 *       shift delays the live edge; audio/text put the preferred tracks first for AVPlay.
 *   GET /s/<b64 base>/<file> -> segment with its sample count patched if needed
 *   POST/GET /vod/<id>.mpd -> a replay manifest the app prepared (native HDR replays)
 *   POST /hdr/<id> -> a live HLG video AdaptationSet; /mpd?...&hdr=<id> puts it in place of the
 *       official video, with that video's current SegmentTimeline; &notext=1 drops subtitle sets
 *   GET /log -> the last requests (kind, CDN host, status, time, error; no paths or tokens), for diagnosis
 *   POST /stitch/<id> { kind: 'hevc', ... } -> an HEVC multiview grid (stitch-hevc.js)
 *   POST /stitch/<id> { kind: 'h264x', ... } -> an H.264 replay's small multiview feeds interleaved (stitchx/)
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
    if (kind === 'stitch') entry.path = String(u.pathname).replace(/^\/stitch\/[^/]+/, '');
    if (req.headers && req.headers.range) entry.range = String(req.headers.range).slice(0, 40);
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

/**
 * Where a manifest may redirect to: https to a DNS name, no IP literal or local name. A name filter only (names are not
 * resolved), against redirects to the home network spelled as addresses or local names.
 */
function publicHttps(u) {
  var m = /^https:\/\/([a-z0-9.-]+)(?::\d+)?\//i.exec(u || '');
  return !!m && /\.[a-z]{2,}$/i.test(m[1]) && !/(^|\.)(localhost|local|lan|home|internal)$/i.test(m[1]);
}

/** `allowed(url)`, when given, must hold for every redirect target too. */
function fetchBuffer(target, redirects, cb, ua, allowed) {
  var over = false;
  function done(err, status, body, headers, finalUrl) { if (over) return; over = true; cb(err, status, body, headers, finalUrl); }
  // Only http(s): anything else (a missing segment URL, file://) must fail this request, not the helper.
  if (typeof target !== 'string' || !/^https?:\/\//.test(target)) return done(new Error('not an http(s) URL'));
  var req;
  try {
    var opts = urlLib.parse(target);
    opts.headers = { 'User-Agent': ua || browserUa || UA };
    req = (opts.protocol === 'http:' ? http : https).get(opts, answered);
  } catch (e) { return done(e); }
  function answered(res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
      res.resume();
      var next;
      try { next = urlLib.resolve(target, res.headers.location); } catch (e) { return done(e); }
      if (allowed && !allowed(next)) return done(new Error('redirect to a host that is not allowed'));
      return fetchBuffer(next, redirects - 1, done, ua, allowed);
    }
    var chunks = [], size = 0;
    // A bounded buffer: an endless or lying response must not take the helper down with it.
    res.on('data', function (c) { size += c.length; if (size > 32 * 1024 * 1024) { req.abort(); return done(new Error('response too large')); } chunks.push(c); });
    res.on('end', function () { done(null, res.statusCode, Buffer.concat(chunks), res.headers, target); });
    res.on('error', function (e) { done(e); });
    res.on('aborted', function () { done(new Error('response cut off')); });
  }
  // Answer the caller on time even if aborting emits nothing on this Node version.
  req.setTimeout(15000, function () { done(new Error('timeout')); req.abort(); });
  req.on('error', function (e) { done(e); });
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
  // A truncated segment (a CDN edge serving a short moof) is served unpatched, not a crash.
  if (buf.readUInt32BE(senc) < 16 || buf.readUInt32BE(trun) < 16 || senc + 16 > buf.length || trun + 16 > buf.length) return buf;
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
  var periodTag = (/<Period\b[^>]*>/.exec(mpd) || [''])[0];
  var periodStart = isoSeconds(attr(periodTag, 'start')), periodDuration = isoSeconds(attr(periodTag, 'duration'));
  // Built for F1's single-Period manifests: a first Period's length must not cap later ones' timelines.
  if ((mpd.match(/<Period\b/g) || []).length !== 1) periodDuration = 0;
  var edgeSeconds = (nowMs - shift * 1000 - ast) / 1000 - periodStart; // shifted edge, period time

  var shifted = mpd.replace(/<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/g, function (all, attrs, inner) {
    var ts = +attr(attrs, 'timescale') || 1, pto = +attr(attrs, 'presentationTimeOffset') || 0;
    var cut = pto + edgeSeconds * ts; // media time of the shifted live edge
    var periodEnd = periodDuration > 0 ? pto + periodDuration * ts : Infinity;
    inner = inner.replace(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/, function (x, body) {
      var list = [], out = [], t = 0;   // the first S starts at 0 when it has no t
      body.replace(/<S\b([^>]*)\/>/g, function (tag, a) { list.push(a); return tag; });
      list.forEach(function (a, i) {
        if (attr(a, 't') != null) t = +attr(a, 't');
        var d = +attr(a, 'd'), r = +(attr(a, 'r') || 0);
        if (!d) return;
        // r="-1" repeats up to the next S's t, or to the Period's end (open while live: a sliding window).
        var span = r + 1, nextT = i + 1 < list.length ? attr(list[i + 1], 't') : null;
        if (r < 0) span = Math.max(0, Math.ceil(((nextT != null ? +nextT : periodEnd) - t) / d));
        var n = Math.max(0, Math.min(span, Math.floor((cut - t) / d)));
        if (n > 0) out.push('<S t="' + t + '" d="' + d + '"' + (n > 1 ? ' r="' + (n - 1) + '"' : '') + '/>');
        t += (span === Infinity ? n : span) * d;
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
 * The stored 5.1 sets (after <!--audio-->) take the official audio's timeline the same way and go before
 * the official audio (AVPlay starts on the first set; preferLanguages still puts the chosen language first).
 * Without the official audio's timeline the 5.1 is left out (stereo plays); without the video's, null.
 */
function onTimeline(stored, official) {
  var timeline = /<SegmentTimeline>[\s\S]*?<\/SegmentTimeline>/.exec(official);
  if (!timeline) return null;
  var out = stored.split('<!--timeline-->').join(timeline[0]);
  // This refresh's addressing too, not only its timeline: should F1 move the window's start (startNumber,
  // offset), the swapped-in set must number its segments as the official one does. A missing attribute is its
  // DASH default (the stored one may be from an earlier refresh).
  var template = /<SegmentTemplate\b([^>]*)>/.exec(official);
  var defaults = { startNumber: '1', timescale: '1', presentationTimeOffset: '0' };
  if (template) Object.keys(defaults).forEach(function (name) {
    var v = attr(template[1], name);
    if (v == null) v = defaults[name];
    out = out.replace(new RegExp('(<SegmentTemplate\\b[^>]*\\s' + name + '=")[^"]*"', 'g'), function (all, head) { return head + v + '"'; });
  });
  return out;
}
function officialSets(mpd, type) {
  var sets = [], re = /<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, m;
  while ((m = re.exec(mpd))) sets.push({ text: m[0], at: m.index });
  return sets.filter(function (b) { return new RegExp('\\scontentType="' + type + '"').test(b.text.slice(0, b.text.indexOf('>'))); });
}
function useHdrVideo(mpd, adaptation) {
  var parts = adaptation.split('<!--audio-->');
  var video = officialSets(mpd, 'video')[0];
  var hdr = video && onTimeline(parts[0], video.text);
  if (!hdr) return null;
  mpd = mpd.slice(0, video.at) + hdr + mpd.slice(video.at + video.text.length);
  var audio = parts.length > 1 && officialSets(mpd, 'audio')[0];
  var surround = audio && onTimeline(parts.slice(1).join(''), audio.text);
  return surround ? mpd.slice(0, audio.at) + surround + mpd.slice(audio.at) : mpd;
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
    // A language code, not RegExp source: anything else is served unsorted (never a crash).
    if (!lang || !/^[a-z]{2,9}$/i.test(lang)) return;
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

/** extra: more headers, readable by the app's page too (a failure's site: failureSite). */
function send(res, status, body, type, extra) {
  var headers = {
    'Content-Type': type || 'text/plain',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  };
  if (extra) {
    Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
    headers['Access-Control-Expose-Headers'] = Object.keys(extra).join(', ');
  }
  res.writeHead(status, headers);
  res.end(body);
}

function handle(req, res) {
  var u = urlLib.parse(req.url, true);
  if (u.pathname === '/ping') return send(res, 200, toBuf('ok'));
  if (u.pathname === '/log') return send(res, 200, toBuf(JSON.stringify(recent)), 'application/json');
  // "Check for updates now": this bundle's downloader (the page then reads the result from the shell). Like the shell's
  // own /launcher/ routes, only the app's own pages may ask: it goes online (a caller could burn GitHub's rate limit).
  if (u.pathname === '/updates/check' && req.method === 'POST') {
    var origin = req.headers && req.headers.origin;
    if (origin && origin !== 'null' && origin !== 'file://') return send(res, 403, toBuf('local page required'));
    if (!bundleUpdates) return send(res, 404, toBuf('no launcher'));
    return bundleUpdates.check(function (err) {
      send(res, err ? 502 : 200, toBuf(JSON.stringify(err ? { error: String(err.message || err) } : { ok: true })), 'application/json');
    });
  }
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
    // Only F1's CDNs, like the audio route: CORS is open, so anything else would make this a proxy into the home network.
    if (!f1Cdn(manifestUrl)) return send(res, 403, toBuf('forbidden'));
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
    }, null, publicHttps);
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

var stitchHevc = null, tmTs = null;
try { stitchHevc = require('./stitch-hevc'); } catch (e) { console.log('stitch unavailable: ' + e); }
try { tmTs = require('./tm-ts'); } catch (e) { console.log('player_tm grids unavailable: ' + e); }

/** HEVC grid: a feed's media segment n (0-based) from its template or list. */
/** n: the index in the playlist, or for live (`absolute`) the segment number itself (as in the DASH timeline). */
function hevcSegmentUrl(feed, n) {
  if (feed.urls) return feed.urls[n];
  if (!feed.absolute && feed.count != null && !(n < feed.count)) return null;   // past a replay feed's end
  return feed.media.replace(/\$Number(?:%0(\d+)d)?\$/g, function (m, w) {
    var s = String(feed.absolute ? n : feed.startNumber + n); while (s.length < (+w || 0)) s = '0' + s; return s;
  });
}

/**
 * POST /stitch/<id> with { kind: 'hevc', layout: name or { cols, rows, cells }, feeds: [{ init, media, startNumber, count } | { init, urls }] }
 * (see stitch-hevc.js LAYOUTS).
 *
 * player_tm feeds (F1's HDR_UHD_HLSCK, tm-ts.js) instead: feeds [{ ts: true, media, absolute: true, key, iv }] (TS segments
 * by their media sequence number, AES-128 key and IV in hex, no init: it comes from the segments' parameter sets),
 * plus `playlist` (the first feed's variant playlist, which video.m3u8 follows: replays and live alike) and `master`
 * (the HLS master the app made, served as master.m3u8: its video variant is video.m3u8, its sound and subtitles F1's).
 */
function hevcGridPost(res, id, body) {
  buildGrid(body, function (status, err, grid, site) {
    res.f1 = { probe: +body.probe || 0, ts: !!(grid && grid.ts) };
    if (err) return send(res, status, toBuf(err), null, site);
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
  buildGrid(body, function (status, err, grid, site) {
    if (err) return send(res, status, toBuf(err), null, site);
    // The licence AVPlay has is for the running grid's key.
    if (grid.cfg.enc !== old.cfg.enc) return send(res, 422, toBuf('the new feeds are encrypted differently'));
    // The player keeps the running grid's manifest: shorter replay feeds would leave its last segments missing.
    if (!grid.live && grid.count < old.count) return send(res, 422, toBuf('the new feeds are shorter than the running grid'));
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

/**
 * Where a grid or segment build failed, for the app's diagnostics only (never shown on the TV): the error's kind, the
 * file and line that threw it (past fail()) and this helper's Node version (issue #6: an old Node on Tizen 5.5 broke
 * every grid). Sent as response headers next to the plain message.
 */
var CATEGORIES = { TypeError: 'type_error', ReferenceError: 'reference_error', RangeError: 'range_error', SyntaxError: 'syntax_error' };
function failureSite(e) {
  var at = String(e && e.stack || '').split('\n').slice(1).filter(function (l) { return !/\bat fail\b/.test(l); })
    .map(function (l) { return /([^\/\\\s(]+\.js):(\d+):\d+/.exec(l); }).filter(Boolean)[0];
  var node = typeof process !== 'undefined' && process.version ? String(process.version).replace(/^v/, '') : '';
  var h = { 'X-Error-Category': CATEGORIES[e && e.name] || 'other' };
  if (at) { h['X-Error-Source'] = at[1]; h['X-Error-Line'] = at[2]; }
  if (node) h['X-Helper-Node'] = node;
  return h;
}

/** Fetches the feeds' init and probe segments, prepares the grid and stitches the probe; cb(status, error, grid). */
function buildGrid(body, cb) {
  var feeds = body && Array.isArray(body.feeds) ? body.feeds : [];
  if (feeds.length < 1 || feeds.length > 9) return cb(400, 'need 1-9 feeds');
  var ts = feeds.some(function (f) { return f && f.ts; });
  if (ts && !tmTs) return cb(501, 'player_tm grids unavailable');
  if (!feeds.every(function (f) {
    if (!f || typeof f !== 'object') return false;
    // player_tm: every feed TS, numbered as in the playlist, with its key (the init comes from the segments).
    if (ts) return !!f.ts && f.absolute && typeof f.media === 'string' && /^[0-9a-f]{32}$/i.test(String(f.key)) && (f.iv == null || /^(0x)?[0-9a-f]{32}$/i.test(String(f.iv)));
    return typeof f.init === 'string' && (Array.isArray(f.urls) || typeof f.media === 'string');
  })) return cb(400, 'bad feeds');
  if (ts && !(typeof body.playlist === 'string' && f1Cdn(body.playlist) && typeof body.master === 'string' && body.master.length < 65536)) return cb(400, 'player_tm grids need the playlist and master');
  var live = !!body.live, count0 = feeds[0].urls ? feeds[0].urls.length : feeds[0].count;
  var probe = live || ts ? +body.probe : Math.max(0, Math.min(count0 - 1, +body.probe || 0)), all = [];
  // Live CMAF numbers come from the DASH timeline (never 0); a player_tm replay may start at media sequence 0.
  var numbered = ts ? probe >= 0 && probe === Math.floor(probe) : probe > 0;
  if ((live || ts) && !(numbered && feeds.every(function (f) { return f.absolute && f.media; }))) return cb(400, (ts ? 'player_tm' : 'live') + ' grids need absolute numbers');
  feeds.forEach(function (f) { if (!f.ts) all.push(f.init); all.push(hevcSegmentUrl(f, probe)); });
  if (!all.every(function (u) { return f1Cdn(String(u)); })) return cb(400, 'need F1 media');
  // A replay grid is as long as its shortest feed (a player_tm grid: as its playlist, which the player follows).
  var count = live || ts ? Infinity : Math.min.apply(Math, feeds.map(function (f) { return f.urls ? f.urls.length : +f.count || 0; })), ua = body.ua ? String(body.ua).slice(0, 300) : null;
  // Akamai serves a stream only to the user agent that opened it: the manifest and commentary too.
  if (ua) browserUa = ua;
  if (body.prepareOnly) {
    // Only fetch the inputs now (the viewer is choosing); the grid is built when chosen, a moment later:
    // the segment after too.
    var later = feeds.map(function (f) { return hevcSegmentUrl(f, probe + 1); }).filter(function (u) { return u && f1Cdn(String(u)); });
    return fetchInputs(all.concat(live || ts || probe + 1 < count0 ? later : []), function (err) { cb(err ? 502 : 204, err ? String(err) : null, null); }, 2, ua, live || ts);
  }
  fetchInputs(all, function (err, got) {
    if (err) return cb(502, String(err));
    try {
      var inits = [], firsts = [];
      if (ts) {
        // player_tm: decrypt and unpack each feed's probe segment; its parameter sets make the feed's init.
        feeds = feeds.map(function (f, n) {
          var made = tmTs.convert(got[n], f, probe, null);
          // Every time of the playlist's window stays at or above zero: a probe just after the 33-bit clock wrapped
          // would put the segments before it (body.lead seconds of them) below zero, so this epoch starts one higher.
          if (made.firstDts - (+body.lead || 0) * 90000 < 0) made = tmTs.convert(got[n], f, probe, made.firstDts + tmTs.WRAP);
          inits.push(tmTs.init(made.aus));
          firsts.push(made.segment);
          return { ts: true, media: f.media, absolute: true, key: f.key, iv: f.iv || null, base: made.firstDts, probe: probe };
        });
      } else got.forEach(function (b, i) { (i % 2 ? firsts : inits).push(b); });
      var g = stitchHevc.prepare(inits, firsts, body.layout || 'grid2x2', 50);
      // Stitch the probe now: it proves the feeds fit together, and is likely the first segment asked for.
      var warm = stitchHevc.gridSegment(firsts, g.cfg);
      cb(200, null, { kind: 'hevc', live: live, ts: ts, feeds: feeds, count: count, init: g.init, cfg: g.cfg, cache: [{ number: probe, body: warm }],
        pending: {}, at: Date.now(), ua: ua, playlist: ts ? body.playlist : null, master: ts ? body.master : null, asked: probe,
        info: { width: g.width, height: g.height, codecs: g.codecs } });
    } catch (e) { cb(422, String(e && e.message || e), null, failureSite(e)); }
  }, 2, ua, live || ts);
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
try { stitchx = require('./stitchx/helper-route.js')({ fetchAll: fetchAll, send: send, toBuf: toBuf, f1Cdn: f1Cdn, port: PORT, stitches: stitches,
  failureSite: failureSite }); }
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

function stitchRequest(req, res, u) {
  if (!stitchHevc) return send(res, 501, toBuf('stitching unavailable'));
  var m = /^\/stitch\/([a-z0-9-]{1,64})(?:\.mpd|\/(init\.mp4|audio-init\.mp4|a?\d+\.m4s|layout|prepare|master\.m3u8|video\.m3u8))?$/.exec(u.pathname);
  if (!m) return send(res, 404, toBuf('not found'));
  var id = m[1], what = m[2] || (/\.mpd$/.test(u.pathname) ? 'mpd' : null);
  if (req.method === 'POST' && (!what || what === 'layout' || what === 'prepare')) {
    var chunks = [], size = 0;
    req.on('data', function (b) { size += b.length; if (size <= 2 * 1024 * 1024) chunks.push(b); });
    req.on('end', function () {
      if (size > 2 * 1024 * 1024) return send(res, 413, toBuf('grid description too large'));
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, 400, toBuf('bad json')); }
      if (!body || typeof body !== 'object') return send(res, 400, toBuf('need a grid description'));
      try { posted(body); } catch (e) { send(res, 400, toBuf('bad grid description: ' + String(e && e.message || e))); }
    });
    return;
  }
  function posted(body) {
    if (what === 'prepare') {
      if (!stitches[id]) return send(res, 404, toBuf('no such grid'));
      body.prepareOnly = true;
      return buildGrid(body, function (status, err) { send(res, status, toBuf(err || '')); });
    }
    if (what === 'layout') return hevcRegridPost(res, id, body);
    if (body.kind === 'hevc') return hevcGridPost(res, id, body);
    if (body.kind === 'h264x') return stitchx ? stitchx.post(res, id, body) : send(res, 501, toBuf('stitchx unavailable: ' + stitchxError));
    return send(res, 400, toBuf('need kind hevc or h264x'));
  }
  var s = stitches[id];
  if (!s || !what) return send(res, 404, toBuf('not found'));
  s.at = Date.now();
  if (s.kind === 'h264x') return stitchx.get(res, s, what, id);
  if (what === 'mpd') return send(res, 200, s.mpd, 'application/dash+xml');
  if (what === 'master.m3u8') {
    if (!s.master) return send(res, 404, toBuf('not found'));
    // The app wrote the master before the grid existed: its codec and size go in now.
    return send(res, 200, toBuf(s.master.replace(/\$GRIDCODECS\$/g, s.info.codecs).replace(/\$GRIDRESOLUTION\$/g, s.info.width + 'x' + s.info.height)), 'application/vnd.apple.mpegurl');
  }
  if (what === 'video.m3u8') return s.playlist ? tmPlaylist(res, s) : send(res, 404, toBuf('not found'));
  if (what === 'init.mp4') return send(res, 200, s.init, 'video/mp4');
  var number = parseInt(what, 10);
  if (!(number >= 0 && number < s.count)) return send(res, 404, toBuf('no such segment'));
  s.asked = number;   // where the player is: the background fetches follow it (a seek back included)
  segmentFor(s, number, function (status, body, timing) {
    res.f1 = timing;
    send(res, status, body, status === 200 ? 'video/mp4' : 'text/plain', status === 200 ? null : timing && timing.site);
  });
}

/**
 * A player_tm grid's video playlist: the first feed's own (F1's; a replay's whole list, live as it grows), its segments
 * the grid's (<media sequence number>.m4s) and clear (no EXT-X-KEY), with the grid's init. Its PROGRAM-DATE-TIME and
 * durations stay F1's, so the player lines it up with the sound and subtitles of the master. Kept 1 s.
 */
function tmPlaylist(res, s) {
  var kept = s.playlistCache;
  if (kept && Date.now() - kept.at < 1000) return send(res, 200, kept.body, 'application/vnd.apple.mpegurl');
  fetchBuffer(s.playlist, 3, function (err, status, body) {
    if (err || status !== 200) return send(res, 502, toBuf('playlist: ' + (err ? String(err).replace(/https?:\/\/\S*/g, '') : 'HTTP ' + status)));
    var out = tmRewrite(body.toString('utf8'), s.feeds[0].iv);
    if (typeof out !== 'string') return send(res, 502, toBuf('playlist: ' + (out && out.why || 'not an HLS media playlist')));
    s.playlistCache = { at: Date.now(), body: toBuf(out) };
    send(res, 200, s.playlistCache.body, 'application/vnd.apple.mpegurl');
  }, s.ua, f1Cdn);
}

/**
 * tmPlaylist's rewrite of an HLS media playlist (text), or { why } when it isn't one or no longer matches what the grid
 * was built for: the helper converts every segment with the first key and IV (`iv`, hex or null), and can't follow a
 * discontinuity (new timestamps, parameter sets) or byte ranges. The player then fails, and the app falls back.
 */
function tmRewrite(text, iv) {
  if (!/^#EXTM3U/.test(text) || /^#EXT-X-ENDLIST\s*$/m.test(text)) return tmRewriteWhole(text, iv);
  return tmRewriteWhole(liveFromLastBreak(text), iv);
}

/**
 * A live playlist from the segment after its last discontinuity on (FP2 Qatar 2026: every feed's playlist kept one
 * segment from before a 10 min pause, then a discontinuity, for the whole session), when F1 states the clock again
 * there (PROGRAM-DATE-TIME). Its numbers go on (media sequence, discontinuity sequence) and it is no longer an EVENT
 * playlist (its start moved). Otherwise the text as it was (and the discontinuity is refused, as before).
 */
function liveFromLastBreak(text) {
  var lines = text.split(/\r?\n/), last = -1, i;
  for (i = 0; i < lines.length; i++) if (/^#EXT-X-DISCONTINUITY\s*$/.test(lines[i])) last = i;
  if (last < 0) return text;
  var after = lines.slice(last + 1), pdt = false;
  for (i = 0; i < after.length && !(after[i] && after[i].charAt(0) !== '#'); i++) if (/^#EXT-X-PROGRAM-DATE-TIME:/.test(after[i])) pdt = true;
  if (!pdt) return text;
  var head = [], skipped = 0, breaks = 0, seq = 0, dseq = 0, inHead = true;
  for (i = 0; i < last; i++) {
    var line = lines[i], m;
    if ((m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(line))) { seq = +m[1]; continue; }
    if ((m = /^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(line))) { dseq = +m[1]; continue; }
    if (/^#EXT-X-PLAYLIST-TYPE:/.test(line)) continue;
    if (/^#EXT-X-DISCONTINUITY\s*$/.test(line)) { breaks++; continue; }
    if (/^#EXT(?:INF|-X-PROGRAM-DATE-TIME|-X-BYTERANGE|-X-GAP)\b/.test(line)) inHead = false;
    if (line && line.charAt(0) !== '#') { skipped++; inHead = false; continue; }
    // Header tags and the key stay; a segment's own tags before the cut go with it.
    if (inHead || /^#EXT-X-KEY:/.test(line)) head.push(line);
  }
  return head.concat(['#EXT-X-MEDIA-SEQUENCE:' + (seq + skipped), '#EXT-X-DISCONTINUITY-SEQUENCE:' + (dseq + breaks + 1)], after).join('\n');
}

function tmRewriteWhole(text, iv) {
  var lines = text.split(/\r?\n/);
  if (!/^#EXTM3U/.test(lines[0] || '')) return null;
  if (/^#EXT-X-(?:DISCONTINUITY\s*$|BYTERANGE:|MAP:)/m.test(text)) return { why: 'a discontinuity or byte range' };
  var keys = (text.match(/^#EXT-X-KEY:.*$/gm) || []), want = iv ? String(iv).replace(/^0x/i, '').toLowerCase() : null;
  if (keys.some(function (k) {
    var got = (/[:,]IV=0x([0-9a-f]+)/i.exec(k) || [])[1];
    return !/[:,]METHOD=AES-128(?:,|$)/.test(k) || (got ? got.toLowerCase() : null) !== want;
  }) || keys.length > 1 && keys.some(function (k) { return k !== keys[0]; })) return { why: 'the key changed' };
  var seq = 0, mapped = false, out = [];
  lines.forEach(function (line) {
    var m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(line);
    if (m) seq = +m[1];
    if (/^#EXT-X-KEY:/.test(line) || /^#EXT-X-MAP:/.test(line)) return;
    if (/^#EXT-X-VERSION:/.test(line)) return out.push('#EXT-X-VERSION:7');
    // The init before the first segment's own tags (its duration, clock time, ...).
    if (!mapped && (/^#EXT(?:INF|-X-PROGRAM-DATE-TIME|-X-DISCONTINUITY|-X-BYTERANGE|-X-GAP)\b/.test(line) || (line && line.charAt(0) !== '#'))) {
      out.push('#EXT-X-MAP:URI="init.mp4"');
      mapped = true;
    }
    if (line && line.charAt(0) !== '#') return out.push(String(seq++) + '.m4s');
    out.push(line);
  });
  return out.join('\n');
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
  var waiting = s.pending[number] = [cb];
  var t0 = Date.now(), timing = { segment: number };
  function answer(status, body) {
    delete s.pending[number];
    if (status !== 200) timing.why = String(body).slice(0, 200);
    waiting.forEach(function (w) { w(status, body, timing); });
  }
  var segUrls = s.feeds.map(function (f) { return hevcSegmentUrl(f, number); });
  // A feed with fewer segments than the first (regridded onto unequal replays) has nothing here: 404.
  if (segUrls.some(function (u) { return u == null; })) return answer(404, toBuf('no such segment'));
  fetchAll(segUrls, function (err, segs) {
    timing.fetchMs = Date.now() - t0;
    if (err) return answer(502, toBuf(String(err)));
    // player_tm grids: Shaka asks for one segment at a time, and fetching four feeds takes most of a segment's
    // length, so the next one's fetch starts now, while this one is unpacked and stitched (two ahead at most).
    if (s.ts && number + 1 <= s.asked + 2) setTimeout(function () { aheadOf(s, number + 1); }, 0);
    var out, t1 = Date.now();
    try {
      if (s.ts) {
        // Each segment unwrapped around where its time should be (5.76 s a segment from the probe's).
        segs = segs.map(function (raw, n) {
          var f = s.feeds[n];
          return tmTs.convert(raw, f, number, f.base + (number - f.probe) * tmTs.SEGMENT).segment;
        });
        timing.convertMs = Date.now() - t1;
      }
      out = stitchHevc.gridSegment(segs, s.cfg);
    }
    catch (e) { timing.site = failureSite(e); return answer(422, toBuf(String(e && e.message || e))); }
    timing.stitchMs = Date.now() - t1;
    timing.mb = Math.round(out.length / 1e5) / 10;
    s.cache.push({ number: number, body: out });
    if (s.cache.length > 4) s.cache.shift();
    answer(200, out);
  }, 0, s.ua, s.live);
}

/** Builds segment `number` in the background unless it is kept or being built already. */
function aheadOf(s, number) {
  if (!(number < s.count) || number > s.asked + 2 || s.pending && s.pending[number] || s.cache.some(function (c) { return c.number === number; })) return;
  if (Object.keys(stitches).every(function (k) { return stitches[k] !== s; })) return;   // replaced meanwhile
  segmentFor(s, number, function () {});
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

var bundleUpdates = null;   // the update downloader (updates.js), when the launcher's shell runs this helper
function start(options) {
  if (options && options.launcher && !bundleUpdates) {
    try { bundleUpdates = require('./updates').create(options.launcher); bundleUpdates.start(); }
    catch (e) { console.log('updates unavailable: ' + e); bundleUpdates = null; }
  }
  if (options && options.externalServer) return;
  if (server) return;
  server = http.createServer(handle);
  server.on('error', function (e) { console.log('proxy error: ' + e); });
  server.listen(PORT, '127.0.0.1');
}

module.exports.handle = handle;
module.exports.onStart = start;
module.exports.useHdrVideo = useHdrVideo;
module.exports.onRequest = start;
module.exports.onExit = function () {
  if (bundleUpdates) bundleUpdates.stop();
  bundleUpdates = null;
  if (server) server.close();
  server = null;
};
