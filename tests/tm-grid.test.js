// Multiview from F1's player_tm feeds (service/tm-ts.js and the helper's /stitch endpoints for TS feeds): the stitch
// fixtures (tests/fixtures/stitch/make.sh) as AES-128 MPEG-TS, the way player_tm sends them.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const url = require('node:url');
const vm = require('node:vm');

const st = require('../app/service/stitch.js');
const hv = require('../app/service/stitch-hevc.js');
const tm = require('../app/service/tm-ts.js');

const KEY = '000102030405060708090a0b0c0d0e0f', IV = '0x1f1e1d1c1b1a19181716151413121110';
const ts = (i) => readFileSync(path.join(__dirname, 'fixtures/stitch/hevc' + i + '.ts'));
const encrypt = (buf, iv) => {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(KEY, 'hex'), iv || Buffer.from(IV.slice(2), 'hex'));
  return Buffer.concat([c.update(buf), c.final()]);
};

/** ftyp+moov and the rest of a one-fragment MP4 file. */
function split(buf) {
  let p = 0;
  const init = [], seg = [];
  while (p < buf.length) {
    const size = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    (type === 'ftyp' || type === 'moov' ? init : seg).push(buf.subarray(p, p + size));
    p += size;
  }
  return { init: Buffer.concat(init), seg: Buffer.concat(seg) };
}
const mp4 = (i) => split(readFileSync(path.join(__dirname, 'fixtures/stitch/hevc' + i + '.mp4')));

/** A grid segment's pictures as their slice NAL units only (an MP4 source has no access unit delimiters). */
function slices(seg) {
  const f = st.fragment(seg);
  return f.samples.map((s) => {
    const out = [];
    for (let p = s.at; p < s.at + s.size;) {
      const len = seg.readUInt32BE(p), n = seg.subarray(p + 4, p + 4 + len);
      if (((n[0] >> 1) & 63) < 32) out.push(n);
      p += 4 + len;
    }
    return Buffer.concat(out);
  });
}

test('player_tm: a decrypted TS segment becomes the fragment and init the stitcher reads, the same pictures as CMAF', () => {
  const made = [0, 1, 2, 3].map((i) => tm.convert(encrypt(ts(i)), { key: KEY, iv: IV }, 7, null));
  made.forEach((m) => assert.equal(st.fragment(m.segment).samples.length, 16));
  const g = hv.prepare(made.map((m) => tm.init(m.aus)), made.map((m) => m.segment), 'grid2x2', 50);
  const c = [0, 1, 2, 3].map(mp4), gc = hv.prepare(c.map((x) => x.init), c.map((x) => x.seg), 'grid2x2', 50);
  assert.deepEqual([g.width, g.height, g.codecs], [gc.width, gc.height, gc.codecs]);
  const a = slices(hv.gridSegment(made.map((m) => m.segment), g.cfg)), b = slices(hv.gridSegment(c.map((x) => x.seg), gc.cfg));
  assert.equal(a.length, 16);
  a.forEach((pic, k) => assert.ok(pic.equals(b[k]), 'picture ' + k));
});

test('player_tm: the IV defaults to the media sequence number, and times unwrap around the 33-bit clock', () => {
  const iv = tm.ivFor(null, 311687449);
  assert.equal(iv.toString('hex'), '0000000000000000000000001293f919');
  assert.equal(tm.convert(encrypt(ts(0), iv), { key: KEY }, 311687449, null).aus.length, 16);
  // A feed whose clock passed 2^33 since the grid started: its small timestamps continue the earlier ones.
  const aus = tm.videoAccessUnits(ts(0), 8589934592 - 900);
  assert.equal(aus[0].dts, 8589934592);
  assert.ok(aus.every((au, i) => i === 0 || au.dts > aus[i - 1].dts));
  assert.throws(() => tm.convert(encrypt(ts(0)), { key: 'abcd', iv: IV }, 7, null), /16-byte key/);
  assert.throws(() => tm.videoAccessUnits(Buffer.alloc(100)), /whole TS packets/);
});

// ---------- the helper ----------

function helper(routes) {
  const requested = [];
  const lib = {
    get(opts, cb) {
      requested.push({ href: opts.href, ua: opts.headers && opts.headers['User-Agent'] });
      const body = typeof routes[opts.href] === 'function' ? routes[opts.href]() : routes[opts.href];
      const res = new EventEmitter();
      res.statusCode = body ? 200 : 404;
      res.headers = {};
      res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', body || Buffer.from('missing')); res.emit('end'); });
      return { setTimeout() {}, on() {}, abort() {} };
    }
  };
  const modules = { http: lib, https: lib, url, './stitch': st, './stitch-hevc': hv, './tm-ts': tm };
  const module = { exports: {} };
  const context = vm.createContext({ require: (name) => modules[name], module, Buffer, Uint8Array, console, Date, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(path.join(__dirname, '../app/service/service.js'), 'utf8'), context);
  return { s: context, requested };
}

function call(s, method, p, body) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    Object.assign(req, { url: p, method });
    const res = { writeHead(status) { this.status = status; }, end(b) { resolve({ status: this.status, body: b }); } };
    s.handle(req, res);
    setImmediate(() => { if (body != null) req.emit('data', Buffer.from(body)); req.emit('end'); });
  });
}

const CDN = 'https://ott-video-cf.formula1.com/v2/t/';
const PLAYLIST = CDN + 'f0/index.m3u8';
const playlist = (end) => ['#EXTM3U', '#EXT-X-VERSION:5', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:7',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://f1tv.formula1.com/2.0/R/ENG/BIGSCREEN_HLS/ALL/CONTENT/LA/ck?c=1",IV=' + IV + ',KEYFORMAT="identity"',
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-22T03:55:00.480Z', '#EXTINF:0.32,', CDN + 'f0/segment__HDR-HD_HEVC_3_7.ts',
  '#EXTINF:0.32,', CDN + 'f0/segment__HDR-HD_HEVC_3_8.ts'].concat(end ? ['#EXT-X-ENDLIST'] : []).join('\n');
function routes() {
  const r = { [PLAYLIST]: Buffer.from(playlist(true)) };
  [0, 1, 2, 3].forEach((i) => { r[CDN + 'f' + i + '/segment__HDR-HD_HEVC_3_7.ts'] = encrypt(ts(i)); r[CDN + 'f' + i + '/segment__HDR-HD_HEVC_3_8.ts'] = encrypt(ts(3 - i)); });
  return r;
}
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="hev1.2.4.L93.B0",VIDEO-RANGE=HLG\nvideo.m3u8\n';
const tmFeeds = (order, extra) => order.map((i) => Object.assign({ ts: true, absolute: true, media: CDN + 'f' + i + '/segment__HDR-HD_HEVC_3_$Number$.ts', key: KEY, iv: IV }, extra));
const grid = (order, more) => JSON.stringify(Object.assign({ kind: 'hevc', layout: 'grid2x2', probe: 7, ua: 'TV browser', playlist: PLAYLIST, master: MASTER, feeds: tmFeeds(order) }, more));

test('the helper builds a grid from player_tm feeds: master, a clear playlist that follows F1\'s, init and segments', async () => {
  const { s, requested } = helper(routes());
  const made = await call(s, 'POST', '/stitch/t1', grid([0, 1, 2, 3]));
  assert.equal(made.status, 201, String(made.body));
  assert.deepEqual(JSON.parse(made.body), { width: 256, height: 128, codecs: 'hev1.2.4.L93.B0' });
  assert.equal(String((await call(s, 'GET', '/stitch/t1/master.m3u8')).body), MASTER);
  const list = String((await call(s, 'GET', '/stitch/t1/video.m3u8')).body).split('\n');
  assert.deepEqual(list, ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-22T03:55:00.480Z', '#EXTINF:0.32,', '7.m4s', '#EXTINF:0.32,', '8.m4s', '#EXT-X-ENDLIST']);
  assert.ok(requested.every((r) => r.ua === 'TV browser'));
  const init = await call(s, 'GET', '/stitch/t1/init.mp4');
  assert.equal(init.status, 200);
  // Segment 7 (stitched when the grid was made) and 8 (built now, from other content per place).
  const c = [0, 1, 2, 3].map(mp4);
  for (const [n, order] of [[7, [0, 1, 2, 3]], [8, [3, 2, 1, 0]]]) {
    const got = await call(s, 'GET', '/stitch/t1/' + n + '.m4s');
    assert.equal(got.status, 200, String(got.body));
    const gc = hv.prepare(order.map((i) => c[i].init), order.map((i) => c[i].seg), 'grid2x2', 50);
    const want = slices(hv.gridSegment(order.map((i) => c[i].seg), gc.cfg));
    slices(got.body).forEach((pic, k) => assert.ok(pic.equals(want[k]), 'segment ' + n + ' picture ' + k));
  }
  assert.equal((await call(s, 'GET', '/stitch/t1/9.m4s')).status, 502, 'past F1\'s playlist: F1 has nothing');
});

test('player_tm grids: a live playlist is followed as it grows; refused without key, playlist, master or F1 media', async () => {
  const r = routes();
  let live = false;
  r[PLAYLIST] = () => Buffer.from(playlist(!live));
  const { s } = helper(r);
  assert.equal((await call(s, 'POST', '/stitch/t2', grid([0, 1, 2, 3], { live: true }))).status, 201);
  live = true;
  const first = String((await call(s, 'GET', '/stitch/t2/video.m3u8')).body);
  assert.ok(!/ENDLIST/.test(first) && /8\.m4s$/.test(first));
  const bad = [
    grid([0, 1, 2, 3], { feeds: tmFeeds([0, 1, 2, 3], { key: 'nope' }) }),
    grid([0, 1, 2, 3], { playlist: 'https://example.com/index.m3u8' }),
    grid([0, 1, 2, 3], { master: null }),
    grid([0, 1, 2, 3], { feeds: tmFeeds([0, 1, 2, 3], { media: 'https://example.com/$Number$.ts' }) }),
    grid([0, 1, 2, 3], { feeds: tmFeeds([0, 1, 2, 3], { absolute: false }) }),
    grid([0, 1, 2, 3], { feeds: tmFeeds([0, 1, 2, 3]).map((f, i) => (i ? f : { init: CDN + 'f0/init.mp4', media: f.media })) })
  ];
  for (const body of bad) assert.equal((await call(s, 'POST', '/stitch/t3', body)).status, 400, body.slice(0, 200));
  // A wrong key: the segment doesn't decrypt (or decrypts to rubbish): refused, not a crash.
  const wrong = await call(s, 'POST', '/stitch/t4', grid([0, 1, 2, 3], { feeds: tmFeeds([0, 1, 2, 3], { key: 'ffffffffffffffffffffffffffffffff' }) }));
  assert.equal(wrong.status, 422);
  assert.equal((await call(s, 'GET', '/stitch/none/video.m3u8')).status, 404);
});

// ---------- review fixes (Codex, 2026-11-22) ----------

/** Shifts every PTS/DTS of a TS segment by `ticks` (mod 2^33): the same pictures at another clock time. */
function shifted(buf, ticks) {
  const out = Buffer.from(buf);
  const put = (o, v) => {
    const t = ((v % 8589934592) + 8589934592) % 8589934592, hi = Math.floor(t / 1073741824);
    out[o] = (out[o] & 0xf1) | (hi << 1); out[o + 1] = Math.floor(t / 4194304) & 255;
    out[o + 2] = ((Math.floor(t / 32768) & 127) << 1) | 1; out[o + 3] = Math.floor(t / 128) & 255; out[o + 4] = ((t & 127) << 1) | 1;
  };
  const get = (o) => ((out[o] >> 1) & 7) * 1073741824 + ((out[o + 1] << 7) | (out[o + 2] >> 1)) * 32768 + ((out[o + 3] << 7) | (out[o + 4] >> 1));
  for (let p = 0; p + 188 <= out.length; p += 188) {
    if (!(out[p + 1] & 0x40)) continue;
    const afc = (out[p + 3] >> 4) & 3;
    let q = p + 4;
    if (afc & 2) q += 1 + out[q];
    if (!(afc & 1) || out[q] !== 0 || out[q + 1] !== 0 || out[q + 2] !== 1) continue;
    const flags = out[q + 7];
    if (flags & 0x80) put(q + 9, get(q + 9) + ticks);
    if (flags & 0x40) put(q + 14, get(q + 14) + ticks);
  }
  return out;
}

function longRoutes(n, seq, at) {
  const r = {};
  const list = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:' + seq,
    '#EXT-X-KEY:METHOD=AES-128,URI="https://f1tv.formula1.com/2.0/R/ENG/BIGSCREEN_HLS/ALL/CONTENT/LA/ck?c=1",IV=' + IV + ',KEYFORMAT="identity"'];
  for (let k = 0; k < n; k++) {
    list.push('#EXTINF:5.76,', CDN + 'f0/segment__HDR-HD_HEVC_3_' + (seq + k) + '.ts');
    [0, 1, 2, 3].forEach((i) => { r[CDN + 'f' + i + '/segment__HDR-HD_HEVC_3_' + (seq + k) + '.ts'] = encrypt(at ? at(i, k) : ts(i)); });
  }
  r[PLAYLIST] = Buffer.from(list.concat('#EXT-X-ENDLIST').join('\n'));
  return r;
}

test('player_tm grids: background fetches stay two segments ahead of the player, also before its first request', async () => {
  const { s, requested } = helper(longRoutes(12, 0));
  const made = await call(s, 'POST', '/stitch/t5', grid([0, 1, 2, 3], { probe: 0 }));
  assert.equal(made.status, 201, 'a replay may start at media sequence 0');
  await new Promise((r) => setTimeout(r, 200));
  const segs = () => [...new Set(requested.map((r) => +(/_(\d+)\.ts$/.exec(r.href) || [])[1]).filter((n) => n >= 0))].sort((a, b) => a - b);
  assert.deepEqual(segs(), [0, 1, 2], 'the probe and the two after it, nothing more');
  assert.equal((await call(s, 'GET', '/stitch/t5/5.m4s')).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(segs(), [0, 1, 2, 5, 6, 7]);
  // A seek back: the fetches follow the player there.
  assert.equal((await call(s, 'GET', '/stitch/t5/3.m4s')).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(segs(), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('player_tm grids: a probe just after the 33-bit clock wrapped keeps the earlier segments at positive times', async () => {
  // Segment 0 ends just before the wrap, segment 1 starts after it.
  const WRAP = 8589934592, seg0 = WRAP - 300000;
  const { s } = helper(longRoutes(3, 0, (i, k) => shifted(ts(i), seg0 + k * 518400)));
  assert.equal((await call(s, 'POST', '/stitch/t6', grid([0, 1, 2, 3], { probe: 1, lead: 5.76 }))).status, 201);
  const tfdt = async (n) => {
    const b = (await call(s, 'GET', '/stitch/t6/' + n + '.m4s')).body, at = b.indexOf('tfdt');
    return b[at + 4] === 1 ? b.readUInt32BE(at + 8) * 4294967296 + b.readUInt32BE(at + 12) : b.readUInt32BE(at + 8);
  };
  const [a, b] = [await tfdt(0), await tfdt(1)];
  assert.ok(a > 0 && b > a && b - a < 2 * 518400, 'segment 0 at ' + a + ', segment 1 at ' + b);
});

test('player_tm grids: a playlist that changed key or gained a discontinuity is refused, so the app falls back', async () => {
  const r = routes();
  let text = playlist(true);
  r[PLAYLIST] = () => Buffer.from(text);
  const { s } = helper(r);
  assert.equal((await call(s, 'POST', '/stitch/t7', grid([0, 1, 2, 3]))).status, 201);
  text = playlist(true).replace('#EXTINF:0.32,\n' + CDN + 'f0/segment__HDR-HD_HEVC_3_8.ts', '#EXT-X-DISCONTINUITY\n#EXTINF:0.32,\n' + CDN + 'f0/segment__HDR-HD_HEVC_3_8.ts');
  assert.equal((await call(s, 'GET', '/stitch/t7/video.m3u8')).status, 502);
  await new Promise((res) => setTimeout(res, 1100));   // past the 1 s the playlist is kept
  text = playlist(true).replace(IV, '0x00000000000000000000000000000001');
  assert.equal((await call(s, 'GET', '/stitch/t7/video.m3u8')).status, 502);
});
