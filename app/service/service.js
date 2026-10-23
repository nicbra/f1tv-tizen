/*
 * Background service (Node.js on the TV) that sits between Samsung's AVPlay and F1 TV's CDN
 * for encrypted live streams. It only fixes container metadata; decryption still happens in
 * the TV's Widevine CDM with F1's own license.
 *
 * F1 TV's CBCS audio segments carry a `senc` box that claims 0 samples while the fragment has
 * hundreds. AVPlay rejects that, so audio segments are routed through here and the count is
 * corrected (the entries are empty: constant IV, no subsamples). Video goes straight to the CDN.
 *
 *   GET /ping                 -> "ok"
 *   GET /mpd?u=<manifest url> -> manifest with audio segments pointed at /s/
 *   GET /s/<b64 base>/<file>  -> segment from the CDN, patched if needed
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

// Buffer.from is missing on very old Node versions; toBuf() is deprecated on new ones.
function toBuf(s, enc) {
  return typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from ? Buffer.from(s, enc) : toBuf(s, enc);
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
      send(res, 200, toBuf(rewriteManifest(body.toString('utf8'), manifestUrl), 'utf8'), 'application/dash+xml');
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
