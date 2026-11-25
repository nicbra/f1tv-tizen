// Multiview stitching (service/stitch.js, service/stitch-hevc.js and the helper's /stitch endpoints) on tiny
// clips encoded like F1's feeds (tests/fixtures/stitch/make.sh). Pixel checks run where ffmpeg is installed.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const url = require('node:url');
const vm = require('node:vm');

const st = require('../app/service/stitch.js');
const hv = require('../app/service/stitch-hevc.js');

const fixture = (name) => readFileSync(path.join(__dirname, 'fixtures/stitch', name + '.mp4'));

/** ftyp+moov and moof+mdat of a one-fragment file. */
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
const clip = (name) => split(fixture(name));

/** A sample's HEVC NAL units: { type, at, end, body }. */
function nals(seg, sample) {
  const out = [];
  for (let p = sample.at; p < sample.at + sample.size;) {
    const len = seg.readUInt32BE(p), h = seg[p + 4];
    out.push({ type: (h >> 1) & 63, at: p, body: p + 4, end: p + 4 + len });
    p += 4 + len;
  }
  return out;
}

/** The HEVC slice address (0 for the first slice) of a slice NAL unit. */
function sliceAddress(seg, n, addressBits) {
  const rbsp = st.unescape(seg, n.body, Math.min(n.end, n.body + 16)).rbsp;
  const r = new st.Reader(rbsp);
  r.u(16);
  if (r.u(1)) return 0;
  if (n.type >= 16 && n.type <= 23) r.u(1);
  r.ue();
  return r.u(addressBits);
}

/** The first SPS and PPS in a fragment's first frame (HEVC, in-band). */
function paramSets(seg) {
  const f = st.fragment(seg), list = nals(seg, f.samples[0]);
  const rbsp = (t) => { const n = list.find((x) => x.type === t); return st.unescape(seg, n.body - 0, n.end).rbsp; };
  return { sps: hv.parseSps(rbsp(33)), pps: hv.parsePps(rbsp(34)) };
}

const box = (type, payload) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
};

/**
 * The clip as if it were cbcs-encrypted: a senc box marks the end of every slice as protected (from 40 bytes
 * in, whole 16-byte blocks), the rest clear, as F1's packager does. The bytes stay readable, so the stitched
 * result still decodes; what matters is that the stitcher keeps the protected ranges and describes them.
 */
function pretendEncrypted(seg) {
  const f = st.fragment(seg);
  const entries = f.samples.map((s) => {
    const slice = nals(seg, s).filter((n) => n.type < 32).pop();
    const protectedLen = Math.max(0, Math.floor((slice.end - slice.body - 40) / 16) * 16);
    return [s.size - protectedLen, protectedLen];
  });
  const sencPayload = Buffer.alloc(8 + entries.length * 8);
  sencPayload.writeUInt32BE(2, 0);   // flags: subsamples
  sencPayload.writeUInt32BE(entries.length, 4);
  entries.forEach(([clear, prot], i) => {
    sencPayload.writeUInt16BE(1, 8 + i * 8);
    sencPayload.writeUInt16BE(clear, 10 + i * 8);
    sencPayload.writeUInt32BE(prot, 12 + i * 8);
  });
  const senc = box('senc', sencPayload);
  // moof grows by the senc box; trun's data offset with it.
  const moof = f.moof, traf = f.traf, trun = f.get('trun');
  const out = Buffer.concat([seg.subarray(0, traf.e), senc, seg.subarray(traf.e)]);
  out.writeUInt32BE(out.readUInt32BE(moof.s) + senc.length, moof.s);
  out.writeUInt32BE(out.readUInt32BE(traf.s) + senc.length, traf.s);
  out.writeUInt32BE(out.readUInt32BE(trun.s + 16) + senc.length, trun.s + 16);
  return { seg: out, protectedRanges: f.samples.map((s, i) => seg.subarray(s.at + s.size - entries[i][1], s.at + s.size)) };
}

// The pixel checks skip without ffmpeg, except in CI (GitHub sets CI=true), where they must run.
let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { ffmpeg = !!process.env.CI; }

/** md5 of each frame of a region of a video (ffmpeg's framemd5). */
function frameHashes(buf, crop) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stitch-'));
  const file = path.join(dir, 'in.mp4');
  writeFileSync(file, buf);
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'crop=' + crop, '-f', 'framemd5', '-'], { encoding: 'utf8' });
  return out.split('\n').filter((l) => /^\d/.test(l)).map((l) => l.split(',').pop().trim());
}

// ---------- HEVC: feeds as tiles ----------

const hevcClips = () => [0, 1, 2, 3].map((i) => clip('hevc' + i));

test('HEVC: four feeds tile into a 2x2 grid: the parameter sets give its size and tiles, each slice its tile', () => {
  const h = hevcClips();
  const g = hv.prepare(h.map((x) => x.init), h.map((x) => x.seg), 'grid2x2', 50);
  assert.equal(g.width, 256);
  assert.equal(g.height, 128);
  assert.match(g.codecs, /^hev1\.2\.4\.L\d+\.B0$/);
  const out = hv.gridSegment(h.map((x) => x.seg), g.cfg), sets = paramSets(out);
  assert.equal(sets.sps.width, 256);
  assert.equal(sets.sps.height, 128);
  assert.equal(sets.pps.tiles, 1);
  assert.equal(sets.pps.tileCols + 'x' + sets.pps.tileRows, '2x2');
  const f = st.fragment(out);
  assert.equal(f.samples.length, 16);
  f.samples.forEach((s) => {
    const slices = nals(out, s).filter((n) => n.type < 32);
    // 128x64 is 4x2 CTBs: the tiles start at CTBs 0, 4, 16 and 20 of the 8x4 grid.
    assert.deepEqual(slices.map((n) => sliceAddress(out, n, sets.sps.addressBits)), [0, 4, 16, 20]);
  });
});

test('HEVC: a feed made of tiles (like F1\'s 1080p) is placed tile by tile: picture in picture', () => {
  const h = hevcClips();
  const g = hv.prepare(h.map((x) => x.init), h.map((x) => x.seg), 'grid2x2', 50);
  const big = { init: g.init, seg: hv.gridSegment(h.map((x) => x.seg), g.cfg) };
  const pip = hv.prepare([big.init, h[3].init], [big.seg, h[3].seg], 'pip', 50);
  const out = hv.gridSegment([big.seg, h[3].seg], pip.cfg);
  const slices = nals(out, st.fragment(out).samples[0]).filter((n) => n.type < 32);
  assert.equal(slices.length, 4, 'three of the big feed\'s tiles and the inset');
});

/** A 4-tile feed like F1's 1080p (four clips as one), and three small ones: big + 3, with two empty cells. */
function big3(encrypted) {
  const h = hevcClips();
  const g = hv.prepare(h.map((x) => x.init), h.map((x) => x.seg), 'grid2x2', 50);
  const big = { init: g.init, seg: hv.gridSegment(h.map((x) => x.seg), g.cfg) };
  const feeds = [big, h[1], h[2], h[3]];
  const segs = feeds.map((x) => (encrypted ? pretendEncrypted(x.seg).seg : x.seg));
  const grid = hv.prepare(feeds.map((x) => x.init), segs, 'big3', 50);
  return { grid, out: hv.gridSegment(segs, grid.cfg) };
}

test('HEVC: big + 3 fills its two empty cells with filler slices', () => {
  const { grid, out } = big3(false);
  assert.equal(grid.width + 'x' + grid.height, '384x192');
  st.fragment(out).samples.forEach((s) => {
    const slices = nals(out, s).filter((n) => n.type < 32);
    assert.equal(slices.length, 9, 'four tiles of the big feed, three small feeds, two empty cells');
  });
});

test('HEVC: encrypted feeds with empty cells: the subsamples still cover every frame', () => {
  const { out } = big3(true);
  st.fragment(out).samples.forEach((s) => {
    assert.equal(s.subs.reduce((n, x) => n + x[0] + x[1], 0), s.size);
  });
});

test('HEVC: big + 3 decodes, the small feeds bit for bit at keyframes, the empty cells one flat picture', { skip: !ffmpeg && 'no ffmpeg' }, () => {
  const { grid, out } = big3(false);
  const file = Buffer.concat([grid.init, out]);
  // The small feeds sit down the right: column 2, rows 0-2 (128x64 cells).
  [1, 2, 3].forEach((k, row) => {
    const placed = frameHashes(file, '128:64:256:' + 64 * row), source = frameHashes(fixture('hevc' + k), '128:64:0:0');
    assert.equal(placed.length, 16);
    [0, 8].forEach((i) => assert.equal(placed[i], source[i], 'feed ' + k + ' keyframe ' + i));
  });
  const empty = frameHashes(file, '256:64:0:128');
  assert.equal(new Set(empty).size, 1, 'the same flat picture in every frame');
});

test('HEVC: encrypted feeds keep every protected byte, a subsample per tile', () => {
  const h = hevcClips(), enc = h.map((x) => pretendEncrypted(x.seg));
  const g = hv.prepare(h.map((x) => x.init), enc.map((e) => e.seg), 'grid2x2', 50);
  const out = hv.gridSegment(enc.map((e) => e.seg), g.cfg), f = st.fragment(out);
  f.samples.forEach((s, i) => {
    assert.equal(s.subs.length, 4);
    let p = s.at;
    s.subs.forEach(([clear, prot], k) => {
      p += clear;
      assert.ok(out.subarray(p, p + prot).equals(enc[k].protectedRanges[i]), 'tile ' + k + ' frame ' + i);
      p += prot;
    });
  });
});

test('HEVC: feeds at different moments are refused', () => {
  const h = hevcClips();
  const g = hv.prepare(h.map((x) => x.init), h.map((x) => x.seg), 'grid2x2', 50);
  const later = Buffer.from(h[2].seg), tfdt = st.fragment(later).get('tfdt');
  later.writeUInt32BE(later.readUInt32BE(tfdt.d + 4) + 1, tfdt.d + 4);
  assert.throws(() => hv.gridSegment([h[0].seg, h[1].seg, later, h[3].seg], g.cfg), /feed 2 is at another time/);
});

test('HEVC: 3840-wide grids are cropped to 2160 lines (the TV refuses taller ones)', () => {
  assert.equal(require('../app/js/layouts.js').shape('grid2x2hd').height, 2160);
});

test('HEVC: the tiled picture shows each feed, keyframes bit for bit', { skip: !ffmpeg && 'no ffmpeg' }, () => {
  const h = hevcClips();
  const g = hv.prepare(h.map((x) => x.init), h.map((x) => x.seg), 'grid2x2', 50);
  const out = Buffer.concat([g.init, hv.gridSegment(h.map((x) => x.seg), g.cfg)]);
  [0, 1, 2, 3].forEach((k) => {
    const tiled = frameHashes(out, '128:64:' + 128 * (k % 2) + ':' + 64 * Math.floor(k / 2)), source = frameHashes(fixture('hevc' + k), '128:64:0:0');
    assert.equal(tiled.length, 16);
    [0, 8].forEach((i) => assert.equal(tiled[i], source[i], 'feed ' + k + ' keyframe ' + i));
  });
});

// ---------- the helper's /stitch endpoints ----------

/**
 * service.js with a fake CDN that serves `routes` (url -> Buffer), recording each request's user agent.
 * gate(url): a promise to hold that answer until it settles, or null.
 */
function helper(routes, gate) {
  const requested = [];
  const lib = {
    get(opts, cb) {
      requested.push({ href: opts.href, ua: opts.headers && opts.headers['User-Agent'] });
      const body = routes[opts.href];
      const res = new EventEmitter();
      res.statusCode = body ? 200 : 404;
      res.headers = {};
      res.resume = () => {};
      Promise.resolve(gate && gate(opts.href)).then(() => setImmediate(() => { cb(res); res.emit('data', body || Buffer.from('missing')); res.emit('end'); }));
      return { setTimeout() {}, on() {}, abort() {} };
    }
  };
  const modules = { http: lib, https: lib, url, './stitch': st, './stitch-hevc': hv };
  const module = { exports: {} };
  const context = vm.createContext({ require: (name) => modules[name], module, Buffer, Uint8Array, console, Date, setTimeout, clearTimeout,
    process: { version: 'v4.4.3' } });
  vm.runInContext(readFileSync(path.join(__dirname, '../app/service/service.js'), 'utf8'), context);
  return { s: context, requested };
}

function call(s, method, p, body) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    Object.assign(req, { url: p, method });
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(b) { resolve({ status: this.status, body: b, headers: this.headers }); } };
    s.handle(req, res);
    setImmediate(() => { if (body != null) req.emit('data', Buffer.from(body)); req.emit('end'); });
  });
}

const CDN = 'https://ott-video-cf.formula1.com/v2/t/';
function cdnRoutes() {
  const routes = {};
  [0, 1, 2, 3].forEach((i) => { const c = clip('hevc' + i); routes[CDN + 'f' + i + '/init.mp4'] = c.init; routes[CDN + 'f' + i + '/seg_7.mp4'] = c.seg; });
  return routes;
}
const feedsOf = (order) => order.map((i) => ({ init: CDN + 'f' + i + '/init.mp4', media: CDN + 'f' + i + '/seg_$Number$.mp4', startNumber: 7, count: 1 }));

test('the helper builds a grid from the feeds, serves its init and segments, and rearranges it in place', async () => {
  const { s, requested } = helper(cdnRoutes());
  const made = await call(s, 'POST', '/stitch/g1', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', ua: 'TV browser', feeds: feedsOf([0, 1, 2, 3]) }));
  assert.equal(made.status, 201, String(made.body));
  assert.deepEqual(JSON.parse(made.body), { width: 256, height: 128, codecs: JSON.parse(made.body).codecs });
  assert.ok(requested.every((r) => r.ua === 'TV browser'), 'Akamai serves a stream only to the user agent that opened it');
  const init = await call(s, 'GET', '/stitch/g1/init.mp4');
  assert.equal(init.status, 200);
  const first = await call(s, 'GET', '/stitch/g1/0.m4s');
  assert.equal(first.status, 200);
  assert.equal(st.fragment(first.body).samples.length, 16);
  assert.equal((await call(s, 'GET', '/stitch/g1/1.m4s')).status, 404, 'past the end');
  // Other feeds in the same grid: the next segments come in the new arrangement.
  const moved = await call(s, 'POST', '/stitch/g1/layout', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', ua: 'TV browser', feeds: feedsOf([3, 2, 1, 0]) }));
  assert.equal(moved.status, 200, String(moved.body));
  assert.equal(JSON.parse(moved.body).from, 0);
  const again = await call(s, 'GET', '/stitch/g1/0.m4s');
  assert.ok(!again.body.equals(first.body), 'rearranged');
  assert.equal((await call(s, 'GET', '/stitch/g1/init.mp4')).body.equals(init.body), true, 'the player keeps the init it has');
});

test('the helper refuses grids it cannot build, and rearranging one it does not have', async () => {
  const { s } = helper(cdnRoutes());
  const refused = await call(s, 'POST', '/stitch/g2', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: feedsOf([0, 1]) }));
  assert.equal(refused.status, 422);
  // Where it failed, for the app's diagnostics only (issue #6): headers the page may read, the message left plain.
  assert.doesNotMatch(String(refused.body), /\[|node/);
  assert.equal(refused.headers['X-Error-Category'], 'type_error');
  assert.equal(refused.headers['X-Error-Source'], 'stitch-hevc.js');
  assert.match(refused.headers['X-Error-Line'], /^\d+$/);
  assert.equal(refused.headers['X-Helper-Node'], '4.4.3');
  assert.match(refused.headers['Access-Control-Expose-Headers'], /X-Error-Source/);
  const offCdn = feedsOf([0, 1, 2, 3]).map((f) => Object.assign({}, f, { init: 'https://example.com/init.mp4' }));
  assert.equal((await call(s, 'POST', '/stitch/g3', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: offCdn }))).status, 400);
  assert.equal((await call(s, 'POST', '/stitch/none/layout', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: feedsOf([0, 1, 2, 3]) }))).status, 404);
  assert.equal((await call(s, 'GET', '/stitch/none/0.m4s')).status, 404);
});

test('a segment beyond a shorter feed of the grid is a 404, not a fetch of undefined', async () => {
  // Regrids can land on replays whose feeds differ in length (the app checks, the helper must not
  // crash): the first feed has two segments, the rest only one.
  const { s } = helper(cdnRoutes());
  const one = (i) => ({ init: CDN + 'f' + i + '/init.mp4', urls: [CDN + 'f' + i + '/seg_7.mp4'] });
  const feeds = [Object.assign({}, one(0), { urls: one(0).urls.concat([CDN + 'f0/seg_7.mp4']) }), one(1), one(2), one(3)];
  const made = await call(s, 'POST', '/stitch/g5', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: feeds }));
  assert.equal(made.status, 201, String(made.body));
  assert.equal((await call(s, 'GET', '/stitch/g5/0.m4s')).status, 200);
  assert.equal((await call(s, 'GET', '/stitch/g5/1.m4s')).status, 404, 'past the short feeds');
});

test('a segment still being built in the old arrangement does not answer requests made after a rearrangement', async () => {
  const routes = cdnRoutes();
  // A second segment per feed (the first one again, renumbered), whose answers wait for `open`.
  [0, 1, 2, 3].forEach((i) => {
    const seg = Buffer.from(clip('hevc' + i).seg), f = st.fragment(seg), tfdt = f.get('tfdt');
    seg.writeUInt32BE(seg.readUInt32BE(tfdt.d + 4) + 16 * 1000, tfdt.d + 4);   // 16 frames later
    routes[CDN + 'f' + i + '/seg_8.mp4'] = seg;
  });
  let open;
  const held = new Promise((r) => { open = r; });
  const { s } = helper(routes, (u) => (/seg_8/.test(u) ? held : null));
  const feeds = (order) => feedsOf(order).map((f) => Object.assign(f, { count: 2 }));
  assert.equal((await call(s, 'POST', '/stitch/g4', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: feeds([0, 1, 2, 3]) }))).status, 201);
  const before = call(s, 'GET', '/stitch/g4/1.m4s');   // built in the first arrangement, held
  const moved = await call(s, 'POST', '/stitch/g4/layout', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: feeds([3, 2, 1, 0]) }));
  assert.equal(moved.status, 200, String(moved.body));
  const after = call(s, 'GET', '/stitch/g4/1.m4s');
  open();
  const [a, b] = await Promise.all([before, after]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(!a.body.equals(b.body), 'the request after the change gets the new arrangement');
});

test('a corrupt trun sample count is refused instead of being allocated', () => {
  const { seg } = clip('hevc0');
  const at = seg.indexOf(Buffer.from('trun'));   // the type field: version/flags then follow
  const bad = Buffer.from(seg);
  bad.writeUInt32BE(0xffffffff, at + 8);        // sample_count
  assert.throws(() => st.fragment(bad), /implausible trun sample count/);
  assert.ok(st.fragment(seg).samples.length > 0, 'the intact segment still parses');
});

test('malformed grid descriptions are 400s, answered in the request callback, and the helper keeps going', async () => {
  const { s } = helper(cdnRoutes());
  for (const body of ['null', '[]', '"text"', JSON.stringify({ kind: 'hevc', feeds: [null] }), JSON.stringify({ kind: 'hevc', feeds: [{ init: 5 }] })]) {
    assert.equal((await call(s, 'POST', '/stitch/m1', body)).status, 400, body);
  }
  assert.equal((await call(s, 'POST', '/stitch/m1', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: feedsOf([0, 1, 2, 3]) }))).status, 201);
  assert.equal((await call(s, 'POST', '/stitch/m1/layout', 'null')).status, 400);
  assert.equal((await call(s, 'POST', '/stitch/m1/prepare', JSON.stringify({ feeds: 'x' }))).status, 400);
});

test('template feeds honour their own count, and a regrid onto shorter feeds is refused', async () => {
  const routes = cdnRoutes();
  [0, 1, 2, 3].forEach((i) => { routes[CDN + 'f' + i + '/seg_8.mp4'] = routes[CDN + 'f' + i + '/seg_7.mp4']; });
  const { s, requested } = helper(routes);
  const two = feedsOf([0, 1, 2, 3]).map((f) => Object.assign({}, f, { count: 2 }));
  const uneven = two.map((f, i) => (i ? Object.assign({}, f, { count: 1 }) : f));
  assert.equal((await call(s, 'POST', '/stitch/t1', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: uneven }))).status, 201);
  assert.equal((await call(s, 'GET', '/stitch/t1/1.m4s')).status, 404);
  assert.ok(!requested.some((r) => /f[123]\/seg_8/.test(r.href)), 'no request past a feed\'s end');
  assert.equal((await call(s, 'POST', '/stitch/t2', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: two }))).status, 201);
  const shorter = await call(s, 'POST', '/stitch/t2/layout', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: feedsOf([3, 2, 1, 0]) }));
  assert.equal(shorter.status, 422); assert.match(String(shorter.body), /shorter than the running grid/);
  assert.equal((await call(s, 'GET', '/stitch/t2/1.m4s')).status, 200, 'the running grid is unchanged');
});

test('a trun table or sample that does not fit the segment is refused', () => {
  const { seg } = clip('hevc0');
  const at = seg.indexOf(Buffer.from('trun'));
  const count = seg.readUInt32BE(at + 8);
  const more = Buffer.from(seg); more.writeUInt32BE(count + 50, at + 8);
  assert.throws(() => st.fragment(more), /implausible trun sample count/);
  const fragment = st.fragment(seg);
  assert.ok(fragment.trunFlags & 0x200, 'the clips carry per-sample sizes, like F1\'s');
  // The first sample's size made larger than the segment.
  const first = at + 12 + (fragment.trunFlags & 1 ? 4 : 0) + (fragment.trunFlags & 4 ? 4 : 0) + (fragment.trunFlags & 0x100 ? 4 : 0);
  const big = Buffer.from(seg); big.writeUInt32BE(seg.length, first);
  assert.throws(() => st.fragment(big), /sample outside the segment/);
});

test('a regrid onto feeds of which any is shorter than the running grid is refused; samples need a size', async () => {
  const routes = cdnRoutes();
  [0, 1, 2, 3].forEach((i) => { routes[CDN + 'f' + i + '/seg_8.mp4'] = routes[CDN + 'f' + i + '/seg_7.mp4']; });
  const { s } = helper(routes);
  const two = feedsOf([0, 1, 2, 3]).map((f) => Object.assign({}, f, { count: 2 }));
  assert.equal((await call(s, 'POST', '/stitch/u1', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: two }))).status, 201);
  const mixed = two.map((f, i) => (i ? Object.assign({}, f, { count: 1 }) : f));
  assert.equal((await call(s, 'POST', '/stitch/u1/layout', JSON.stringify({ kind: 'hevc', layout: 'grid2x2', feeds: mixed }))).status, 422);
  // No per-sample sizes and no default size: nothing bounds the table.
  const { seg } = clip('hevc0');
  const at = seg.indexOf(Buffer.from('trun')), unsized = Buffer.from(seg);
  unsized.writeUInt32BE(seg.readUInt32BE(at + 4) & ~0x200, at + 4);
  assert.throws(() => st.fragment(unsized), /implausible trun sample count/);
});
