/*
 * Local audio proxy for AVPlay. F1's CBCS audio segments report zero senc samples despite
 * having hundreds in the fragment. Correcting the count lets AVPlay accept them; the entries
 * are empty (constant IV, no subsamples). Widevine handles decryption; video goes to the CDN.
 *
 *   GET /ping -> "ok"
 *   GET /mpd?u=<url>[&shift=<seconds>][&audio=eng][&text=eng] -> rewritten manifest
 *       shift delays the live edge; audio/text put the preferred tracks first for AVPlay.
 *   GET /s/<b64 base>/<file> -> segment with its sample count patched if needed
 */
'use strict';

var http = require('http');
var https = require('https');
var urlLib = require('url');

var PORT = 18765;
var UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) TV Safari/537.36';
var server = null;

function fetchBuffer(target, redirects, cb) {
  var opts = urlLib.parse(target);
  opts.headers = { 'User-Agent': UA };
  var lib = opts.protocol === 'http:' ? http : https;
  var req = lib.get(opts, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
      res.resume();
      return fetchBuffer(urlLib.resolve(target, res.headers.location), redirects - 1, cb);
    }
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(null, res.statusCode, Buffer.concat(chunks), res.headers); });
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

  if (u.pathname === '/mpd' && u.query.u) {
    var manifestUrl = String(u.query.u);
    return fetchBuffer(manifestUrl, 3, function (err, status, body) {
      if (err) return send(res, 502, toBuf(String(err)));
      if (status !== 200) return send(res, status, body);
      var mpd = rewriteManifest(body.toString('utf8'), manifestUrl);
      if (+u.query.shift > 0) mpd = timeShift(mpd, +u.query.shift, Date.now());
      if (u.query.audio || u.query.text) mpd = preferLanguages(mpd, { audio: u.query.audio, text: u.query.text });
      send(res, 200, toBuf(mpd, 'utf8'), 'application/dash+xml');
    });
  }

  var m = /^\/s\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (m) {
    var target = b64urlDecode(m[1]) + m[2];
    if (!/^https:\/\/[a-z0-9.-]+\.formula1\.com\//.test(target)) return send(res, 403, toBuf('forbidden'));
    return fetchBuffer(target, 3, function (err, status, body, headers) {
      if (err) return send(res, 502, toBuf(String(err)));
      if (status !== 200) return send(res, status, body);
      send(res, 200, patchSenc(body), headers['content-type'] || 'video/mp4');
    });
  }

  send(res, 404, toBuf('not found'));
}

function start() {
  if (server) return;
  server = http.createServer(handle);
  server.on('error', function (e) { console.log('proxy error: ' + e); });
  server.listen(PORT, '127.0.0.1');
}

module.exports.onStart = start;
module.exports.onRequest = start;
module.exports.onExit = function () {
  if (server) server.close();
  server = null;
};
