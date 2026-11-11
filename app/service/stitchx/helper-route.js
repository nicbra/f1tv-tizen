/*
 * StitchX for the stream helper (app/service/service.js): an H.264 replay's feeds (2018-2024: clear HLS, MPEG-TS
 * segments, not in lockstep) as ONE interleaved stream with the sound of one feed, served as DASH the way the helper
 * serves its HEVC grids (segments built on demand, a few cached, the next one made ready ahead). ES5 for the TV's Node.
 *
 *   var route = require('./stitchx/helper-route.js')({ fetchAll: fetchAll, send: send, toBuf: toBuf, f1Cdn: f1Cdn, port: PORT,
 *     stitches: stitches });
 *   route.post(res, id, body)  body: { kind: 'h264x', feeds: [{ playlist }], interleave: true,
 *     feedTag: true, spread: true, decodeOrder: 'unlock', reorder: 4, maxDpb: 9, level: 51,
 *     targetFps: [number per feed], dropB: [bool per feed], audio: null, probe: segment index }
 *     feeds' playlists: media playlists of one rung and resolution, segments aligned (F1's are)
 *     Optional audio also works with interleaved video; mvsoft.js plays sound separately and sends null.
 *     audio.playlist: the sound's own media playlist (segments aligned with the feeds'); without it, AAC muxed in the
 *     TS of feed `audio.feed`
 *     -> 201 { width, height, codecs, audioCodec, regions, regionRows, gapRows, visibleRows, delay, segments, duration, mpd }
 *   route.get(res, s, what)    s: stitches[id]; what: 'mpd', 'init.mp4', 'audio-init.mp4', '<n>.m4s' or 'a<n>.m4s'
 *
 * In service.js: stitchRequest's path pattern also takes audio-init.mp4 and a<n>.m4s; a POST with kind 'h264x' goes to
 * route.post, a GET of a stitch whose kind is 'h264x' to route.get.
 */
'use strict';
var urlLib = require('url');
var StitchX = require('./stitchx.js'), StitchSegment = require('./segment.js'), Dash = require('./dash.js');

module.exports = function (deps) {
  var DELAY = 0.1, tablesLoaded = false;
  // Bounds on work under way per stream: builds at once, and requests waiting for one build (players ask for a few
  // segments at a time; anything beyond is refused with 503 and asked again).
  var MAX_BUILDS = 3, MAX_WAITERS = 8;

  function loadTables() {
    if (tablesLoaded) return;
    StitchX.tables(require('./cabac-tables.json'));
    tablesLoaded = true;
  }

  // A media playlist: [{ url, start, duration }] (a master playlist is refused: the app picks the rung).
  function parsePlaylist(text, base) {
    if (/#EXT-X-STREAM-INF/.test(text)) throw new Error('a master playlist: send the media playlist of one rung');
    var out = [], t = 0, d = 0;
    text.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (line.indexOf('#EXTINF:') === 0) d = parseFloat(line.slice(8));
      else if (line && line.charAt(0) !== '#') { out.push({ url: urlLib.resolve(base, line), start: t, duration: d }); t += d; }
    });
    if (!out.length) throw new Error('an empty playlist');
    return out;
  }

  function segmentUrls(s, n) {
    var urls = s.feeds.map(function (f) { return f[n].url; });
    if (s.audioList) urls.push(s.audioList[n].url);
    return urls;
  }

  // Segment n: cached, under way (shared), or fetched and stitched now. cb(status, built).
  function build(s, n, cb) {
    var hit = s.cache.filter(function (c) { return c.number === n; })[0];
    if (hit) return cb(200, hit);
    if (s.pending[n]) {
      if (s.pending[n].length >= MAX_WAITERS) return cb(503, 'busy');
      return s.pending[n].push(cb);
    }
    if (Object.keys(s.pending).length >= MAX_BUILDS) return cb(503, 'busy');
    var waiting = s.pending[n] = [cb], t0 = Date.now();
    function answer(status, body) {
      delete s.pending[n];
      waiting.forEach(function (w) { try { w(status, body); } catch (e) { /* one waiter's failure stays its own */ } });
    }
    deps.fetchAll(segmentUrls(s, n), function (err, bytes) {
      if (err) return answer(502, String(err));
      var entry;
      try {
        var r = StitchSegment.build(bytes, { segment: n, start: s.feeds[0][n].start, delay: DELAY, level: s.level, maxDpb: s.maxDpb, dropB: s.dropB, reorder: s.reorder, feedTag: s.feedTag, targetFps: s.targetFps, decodeOrder: s.decodeOrder, spread: s.spread,
          feeds: s.feeds.length, audio: s.audio ? { feed: s.audio.feed, separate: !!s.audioList } : null, init: !s.init });
        if (r.init && !s.init) s.init = r.init;
        entry = { number: n, video: r.video, audio: r.audio, ms: Date.now() - t0, info: r.info };
      } catch (e) { return answer(422, String(e && e.message || e)); }
      s.cache.push(entry);
      if (s.cache.length > 4) s.cache.shift();
      answer(200, entry);
    }, 0, s.ua, false);
  }

  function warmNext(s, n) {
    if (n + 1 < s.feeds[0].length && Object.keys(s.pending).length < MAX_BUILDS - 1) build(s, n + 1, function () {});
  }

  // The request body, checked (it comes from the page, but the helper must never throw on it). null when bad.
  function checkBody(body) {
    if (!body || typeof body !== 'object' || !body.interleave || !Array.isArray(body.feeds)) return null;
    var n = body.feeds.length;
    // One small feed is enough for picture in picture: the big feed plays on AVPlay.
    if (n < 1 || n > 4) return null;
    var urlOk = function (u) { return typeof u === 'string' && u.length > 0 && u.length < 2048; };
    if (!body.feeds.every(function (f) { return f && typeof f === 'object' && urlOk(f.playlist); })) return null;
    var audio = body.audio == null ? null : body.audio;
    if (audio !== null) {
      if (typeof audio !== 'object') return null;
      var feed = audio.feed == null ? 0 : audio.feed;
      if (typeof feed !== 'number' || feed !== Math.floor(feed) || feed < 0 || feed >= n) return null;
      if (audio.playlist != null && !urlOk(audio.playlist)) return null;
      audio = { feed: feed, playlist: audio.playlist || null, lang: typeof audio.lang === 'string' ? audio.lang.slice(0, 8) : null };
    }
    var probe = Math.floor(+body.probe || 0), level = Math.floor(+body.level || 0);
    // The decoder cap depends on the route and picture size; mvsoft.js requests 9 at 1280x720.
    var maxDpb = body.maxDpb == null ? 7 : Math.floor(+body.maxDpb);
    if (!(maxDpb >= 1 && maxDpb <= 16)) return null;
    var reorder = body.reorder == null ? null : Math.floor(+body.reorder);
    if (reorder !== null && !(reorder >= 0 && reorder <= 16)) return null;
    if (body.decodeOrder != null && body.decodeOrder !== 'head' && body.decodeOrder !== 'unlock') return null;
    if (body.targetFps != null && (!Array.isArray(body.targetFps) || body.targetFps.length !== n || !body.targetFps.every(function (x) { return x === null || (typeof x === 'number' && isFinite(x) && x > 0 && x <= 50); }))) return null;
    return { playlists: body.feeds.map(function (f) { return f.playlist; }), audio: audio,
      spread: !!body.spread, feedTag: !!body.feedTag, targetFps: body.targetFps || null, decodeOrder: body.decodeOrder || null, dropB: Array.isArray(body.dropB) ? body.dropB.slice(0, n).map(function (x) { return !!x; }) : null, reorder: reorder,
      level: level >= 40 && level <= 52 ? level : null, maxDpb: maxDpb, probe: isFinite(probe) && probe > 0 ? probe : 0,
      ua: typeof body.ua === 'string' ? body.ua.slice(0, 300) : null };
  }

  function mpd(s, id) {
    var local = 'http://127.0.0.1:' + deps.port + '/stitch/' + id, i = s.init;
    var bandwidth = Math.round(s.cache.reduce(function (sum, c) { return sum + c.video.length * 8 / (s.feeds[0][c.number].duration || 3.84); }, 0) /
      Math.max(1, s.cache.length)) || 6000000;
    return Dash.mpd({ segments: s.feeds[0].map(function (x) { return x.duration; }), delay: DELAY,
      video: { init: local + '/init.mp4', media: local + '/$Number$.m4s', codecs: i.codec, width: i.meta.width, height: i.meta.height,
        frameRate: 50, bandwidth: bandwidth },
      audio: i.audio ? { init: local + '/audio-init.mp4', media: local + '/a$Number$.m4s', codecs: i.audioCodec, rate: i.audioConfig.rate,
        channels: i.audioConfig.channels, lang: s.audio && s.audio.lang || null } : null });
  }

  function post(res, id, raw) {
    var body = checkBody(raw), answered = false;
    function reply(status, text, type) { if (answered) return; answered = true; deps.send(res, status, deps.toBuf(text), type); }
    if (!body) return reply(400, 'need { kind: "h264x", feeds: [{ playlist }] x 1-4, interleave: true, audio: { feed, playlist } | null }');
    try { loadTables(); } catch (e) { return reply(500, 'StitchX tables: ' + e); }
    var feeds = body.playlists, urls = feeds.slice(), audio = body.audio, ua = body.ua;
    if (audio && audio.playlist) urls.push(audio.playlist);
    if (!urls.every(deps.f1Cdn)) return reply(400, 'need F1 media');
    deps.fetchAll(urls, function (err, texts) {
      if (err) return reply(502, String(err));
      try { accept(texts); } catch (e) { reply(500, String(e && e.message || e)); }
    }, 0, ua, false);
    function accept(texts) {
      var lists;
      try { lists = texts.map(function (b, i) { return parsePlaylist(b.toString('utf8'), urls[i]); }); }
      catch (e) { return reply(422, String(e && e.message || e)); }
      // Every segment from F1's media too (a playlist may name other hosts).
      if (!lists.every(function (l) { return l.every(function (x) { return deps.f1Cdn(x.url); }); })) return reply(422, 'segments outside F1 media');
      var feedLists = lists.slice(0, feeds.length), audioList = audio && audio.playlist ? lists[feeds.length] : null;
      // Aligned segments: the same durations in every feed and the sound (within 0.1 s: a sound rendition's last segment
      // may run a little longer; the sound is timed by its PTS anyway). A feed may have a segment more at the end (F1:
      // Monza 2024's LEC onboard ends with an extra 1.92 s one): the stitch covers the segments all of them have.
      var all = feedLists.concat(audioList ? [audioList] : []);
      var count = Math.min.apply(null, all.map(function (l) { return l.length; }));
      var aligned = count > 0 && all.every(function (l) {
        for (var k = 0; k < count; k++) if (Math.abs(l[k].duration - feedLists[0][k].duration) >= 0.1) return false;
        return true;
      });
      if (!aligned) return reply(422, 'the feeds\' segments are not aligned');
      feedLists = feedLists.map(function (l) { return l.slice(0, count); });
      if (audioList) audioList = audioList.slice(0, count);
      var s = { kind: 'h264x', feeds: feedLists, audio: audio, audioList: audioList, level: body.level, maxDpb: body.maxDpb, dropB: body.dropB, reorder: body.reorder, feedTag: body.feedTag, targetFps: body.targetFps, decodeOrder: body.decodeOrder, spread: body.spread,
        cache: [], pending: {}, init: null, at: Date.now(), ua: ua };
      var probe = Math.min(count - 1, body.probe);
      build(s, probe, function (status, got) {
        if (status !== 200) return reply(status, String(got));
        deps.stitches[id] = s;
        var ids = Object.keys(deps.stitches);
        if (ids.length > 2) delete deps.stitches[ids[0]];
        var i = s.init, total = feedLists[0].reduce(function (a, x) { return a + x.duration; }, 0);
        reply(201, JSON.stringify({ width: i.meta.width, height: i.meta.height, codecs: i.codec, audioCodec: i.audioCodec,
          regions: i.meta.regions, regionRows: i.meta.regionRows, gapRows: i.meta.gapRows || 0, visibleRows: i.meta.visibleRows, feedTag: i.meta.feedTag || null, buildInfo: got.info, delay: DELAY, segments: count, duration: total,
          mpd: 'http://127.0.0.1:' + deps.port + '/stitch/' + id + '.mpd', buildMs: got.ms }), 'application/json');
        warmNext(s, probe);
      });
    }
  }

  function get(res, s, what, id) {
    s.at = Date.now();
    if (what === 'mpd') return deps.send(res, 200, deps.toBuf(mpd(s, id)), 'application/dash+xml');
    if (what === 'init.mp4') return deps.send(res, 200, toBuffer(s.init.video), 'video/mp4');
    if (what === 'audio-init.mp4') return s.init.audio ? deps.send(res, 200, toBuffer(s.init.audio), 'video/mp4') : deps.send(res, 404, deps.toBuf('no sound'));
    var m = /^(a?)(\d+)\.m4s$/.exec(what);
    if (!m) return deps.send(res, 404, deps.toBuf('not found'));
    var n = parseInt(m[2], 10);
    if (!(n >= 0 && n < s.feeds[0].length)) return deps.send(res, 404, deps.toBuf('no such segment'));
    build(s, n, function (status, got) {
      if (status !== 200) return deps.send(res, status, deps.toBuf(String(got)));
      var b = m[1] ? got.audio : got.video;
      if (!b) return deps.send(res, 404, deps.toBuf('no sound'));
      res.f1 = { segment: n, stitchMs: got.ms };
      deps.send(res, 200, toBuffer(b), 'video/mp4');
      warmNext(s, n);
    });
  }

  function toBuffer(u8) { return Buffer.from ? Buffer.from(u8.buffer, u8.byteOffset, u8.length) : new Buffer(u8); }

  return { post: post, get: get, parsePlaylist: parsePlaylist };
};
