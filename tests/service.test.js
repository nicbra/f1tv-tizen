const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const url = require('node:url');
const vm = require('node:vm');

/** Loads service.js with fake http/https modules that answer from `routes` (url -> response). */
function service(routes) {
  const requested = [];
  const lib = {
    get(opts, cb) {
      requested.push(opts.href);
      const r = (routes || {})[opts.href] || { status: 404, body: 'missing' };
      const res = new EventEmitter();
      res.statusCode = r.status || 200;
      res.headers = r.headers || {};
      res.resume = () => {};
      setImmediate(() => {
        cb(res);
        if (r.body != null) res.emit('data', Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body));
        res.emit('end');
      });
      return { setTimeout() {}, on() {}, abort() {} };
    }
  };
  const module = { exports: {} };
  const context = vm.createContext({
    require: (name) => ({ http: lib, https: lib, url })[name],
    module, Buffer, Uint8Array, console, Date
  });
  vm.runInContext(readFileSync('app/service/service.js', 'utf8'), context);
  return { s: context, requested };
}

/** Calls the request handler and resolves with { status, headers, body }. */
function get(s, path) {
  return new Promise((resolve) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); } };
    s.handle({ url: path }, res);
  });
}

const box = (type, payload) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
};
const u32 = (...values) => Buffer.concat(values.map((v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }));

/** A media segment: moof(mfhd, traf(tfhd, trun, senc)) followed by mdat. */
function segment({ trunCount = 300, sencFlags = 0, sencCount = 0 } = {}) {
  const traf = box('traf', Buffer.concat([
    box('tfhd', u32(0, 1)),
    box('trun', u32(0, trunCount)),
    box('senc', u32(sencFlags, sencCount))
  ]));
  return Buffer.concat([box('moof', Buffer.concat([box('mfhd', u32(0, 7)), traf])), box('mdat', Buffer.from('media'))]);
}
const sencCount = (buf) => buf.readUInt32BE(buf.indexOf('senc') + 8);

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('patchSenc sets an empty senc sample count to the trun sample count', () => {
  const { s } = service();
  assert.equal(sencCount(s.patchSenc(segment({ trunCount: 345 }))), 345);
});

test('patchSenc leaves a senc that already has a sample count alone', () => {
  const { s } = service();
  assert.equal(sencCount(s.patchSenc(segment({ trunCount: 345, sencCount: 12 }))), 12);
});

test('patchSenc leaves a senc with flags (subsample entries) alone', () => {
  const { s } = service();
  assert.equal(sencCount(s.patchSenc(segment({ trunCount: 345, sencFlags: 2 }))), 0);
});

test('patchSenc returns other data unchanged', () => {
  const { s } = service();
  const init = box('ftyp', Buffer.from('iso6cmfc'));
  assert.deepEqual(s.patchSenc(Buffer.from(init)), init);
  const truncated = segment().subarray(0, 20);
  assert.deepEqual(s.patchSenc(Buffer.from(truncated)), truncated);
});

test('isoSeconds parses manifest durations', () => {
  const { s } = service();
  assert.equal(s.isoSeconds('PT25S'), 25);
  assert.equal(s.isoSeconds('PT1H2M3.5S'), 3723.5);
  assert.equal(s.isoSeconds('P1DT2H'), 93600);
  assert.equal(s.isoSeconds('PT24663H2M24S'), 88786944);
  assert.equal(s.isoSeconds(''), 0);
  assert.equal(s.isoSeconds(null), 0);
});

test('base64url round-trips CDN base URLs', () => {
  const { s } = service();
  const base = 'https://ott-video-cf.formula1.com/v2/pa_abc~x/out/v1/Main/?a=1&b=2/';
  const encoded = s.b64urlEncode(base);
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.equal(s.b64urlDecode(encoded), base);
});

const AST = Date.parse('2024-01-01T00:00:00Z');
const LIVE_MPD = `<?xml version="1.0"?>
<MPD type="dynamic" availabilityStartTime="2024-01-01T00:00:00Z" minimumUpdatePeriod="PT6S">
<Period id="1" start="PT0S">
<AdaptationSet contentType="video"><SegmentTemplate timescale="1000" presentationTimeOffset="0"><SegmentTimeline><S t="0" d="6000" r="99"/></SegmentTimeline></SegmentTemplate></AdaptationSet>
<AdaptationSet contentType="text"><SegmentTemplate timescale="1000"><SegmentTimeline><S t="590000" d="6000" r="1"/></SegmentTimeline></SegmentTemplate></AdaptationSet>
</Period></MPD>`;

test('timeShift trims every timeline to the segments that existed shift seconds ago', () => {
  const { s } = service();
  const out = s.timeShift(LIVE_MPD, 60, AST + 600000);
  assert.match(out, /<SegmentTimeline><S t="0" d="6000" r="89"\/><\/SegmentTimeline>/);
});

test('timeShift moves availabilityStartTime forward by the shift', () => {
  const { s } = service();
  const out = s.timeShift(LIVE_MPD, 60, AST + 600000);
  assert.match(out, /availabilityStartTime="2024-01-01T00:01:00.000Z"/);
});

test('timeShift drops adaptation sets that have no segments yet at the shifted time', () => {
  const { s } = service();
  const out = s.timeShift(LIVE_MPD, 60, AST + 600000);
  assert.doesNotMatch(out, /contentType="text"/);
  assert.match(out, /contentType="video"/);
});

test('timeShift splits a repeated run at the cut and keeps later runs out', () => {
  const { s } = service();
  const mpd = LIVE_MPD.replace('<S t="0" d="6000" r="99"/>', '<S t="0" d="6000" r="9"/><S d="5000" r="99"/>');
  const out = s.timeShift(mpd, 60, AST + 140000); // edge 80 s: ten 6 s segments, then four 5 s ones
  assert.match(out, /<S t="0" d="6000" r="9"\/><S t="60000" d="5000" r="3"\/><\/SegmentTimeline>/);
});

test('timeShift leaves static manifests and manifests without a start time alone', () => {
  const { s } = service();
  const vod = LIVE_MPD.replace('type="dynamic"', 'type="static"');
  assert.equal(s.timeShift(vod, 60, AST + 600000), vod);
  const noAst = LIVE_MPD.replace(' availabilityStartTime="2024-01-01T00:00:00Z"', '');
  assert.equal(s.timeShift(noAst, 60, AST + 600000), noAst);
});

const LANG_MPD = `<MPD><Period>
<AdaptationSet contentType="video" id="v"></AdaptationSet>
<AdaptationSet contentType="audio" lang="eng" id="a1"></AdaptationSet>
<AdaptationSet contentType="audio" lang="deu" id="a2"></AdaptationSet>
<AdaptationSet contentType="audio" lang="fra-FR" id="a3"></AdaptationSet>
<AdaptationSet mimeType="application/mp4" lang="eng" id="t1"><Representation codecs="stpp"/></AdaptationSet>
<AdaptationSet contentType="text" lang="fra" id="t2"></AdaptationSet>
</Period></MPD>`;
const order = (mpd) => (mpd.match(/id="\w+"/g) || []).map((m) => m.slice(4, -1)).join(' ');

test('preferLanguages moves the preferred audio track first, keeping the others in order', () => {
  const { s } = service();
  assert.equal(order(s.preferLanguages(LANG_MPD, { audio: 'fra' })), 'v a3 a1 a2 t1 t2');
});

test('preferLanguages moves the preferred subtitles first, recognising stpp subtitles', () => {
  const { s } = service();
  assert.equal(order(s.preferLanguages(LANG_MPD, { text: 'fra' })), 'v a1 a2 a3 t2 t1');
  assert.equal(order(s.preferLanguages(LANG_MPD, { audio: 'deu', text: 'fra' })), 'v a2 a1 a3 t2 t1');
});

test('preferLanguages leaves the manifest alone for languages it does not have', () => {
  const { s } = service();
  assert.equal(s.preferLanguages(LANG_MPD, { audio: 'jpn', text: 'nld' }), LANG_MPD);
  assert.equal(s.preferLanguages(LANG_MPD, {}), LANG_MPD);
});

test('rewriteManifest points the period at the CDN and only audio at the local proxy', () => {
  const { s } = service();
  const mpd = '<MPD><Period id="1"><AdaptationSet contentType="video"></AdaptationSet><AdaptationSet contentType="audio" lang="eng"></AdaptationSet></Period></MPD>';
  const out = s.rewriteManifest(mpd, 'https://cdn.formula1.com/live/main/index.mpd?start=1&end=2');
  assert.match(out, /<Period id="1"><BaseURL>https:\/\/cdn\.formula1\.com\/live\/main\/<\/BaseURL>/);
  const proxied = /<AdaptationSet contentType="audio" lang="eng"><BaseURL>http:\/\/127\.0\.0\.1:18765\/s\/([^/]+)\/<\/BaseURL>/.exec(out);
  assert.ok(proxied, out);
  assert.equal(s.b64urlDecode(proxied[1]), 'https://cdn.formula1.com/live/main/');
  assert.doesNotMatch(out, /<AdaptationSet contentType="video"><BaseURL>/);
});

test('GET /ping answers ok', async () => {
  const { s } = service();
  const r = await get(s, '/ping');
  assert.equal(r.status, 200);
  assert.equal(String(r.body), 'ok');
});

test('GET /mpd serves the rewritten manifest with the preferred audio first', async () => {
  const src = 'https://cdn.formula1.com/live/main/index.mpd';
  const { s } = service({ [src]: { body: LANG_MPD } });
  const r = await get(s, '/mpd?u=' + encodeURIComponent(src) + '&audio=deu');
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'application/dash+xml');
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
  const body = String(r.body);
  assert.match(body, /<BaseURL>https:\/\/cdn\.formula1\.com\/live\/main\/<\/BaseURL>/);
  assert.equal(order(body), 'v a2 a1 a3 t1 t2');
});

test('GET /mpd follows redirects and passes upstream errors through', async () => {
  const src = 'https://cdn.formula1.com/a.mpd';
  const { s, requested } = service({
    [src]: { status: 302, headers: { location: '/b.mpd' } },
    'https://cdn.formula1.com/b.mpd': { status: 403, body: 'geo' }
  });
  const r = await get(s, '/mpd?u=' + encodeURIComponent(src));
  assert.deepEqual(requested, [src, 'https://cdn.formula1.com/b.mpd']);
  assert.equal(r.status, 403);
  assert.equal(String(r.body), 'geo');
});

test('GET /mpd with shift time-shifts a live manifest', async () => {
  const src = 'https://cdn.formula1.com/live/index.mpd';
  const { s } = service({ [src]: { body: LIVE_MPD } });
  const r = await get(s, '/mpd?u=' + encodeURIComponent(src) + '&shift=60');
  assert.match(String(r.body), /availabilityStartTime="2024-01-01T00:01:00.000Z"/);
});

test('GET /s/ fetches the segment from the CDN and fixes its sample count', async () => {
  const base = 'https://ott-video-cf.formula1.com/out/v1/Main/';
  const { s, requested } = service({ [base + 'audio_eng_42.mp4']: { body: segment({ trunCount: 280 }), headers: { 'content-type': 'video/iso.segment' } } });
  const r = await get(s, '/s/' + b64url(base) + '/audio_eng_42.mp4');
  assert.deepEqual(requested, [base + 'audio_eng_42.mp4']);
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'video/iso.segment');
  assert.equal(sencCount(r.body), 280);
});

test('GET /s/ refuses hosts other than formula1.com', async () => {
  const { s, requested } = service();
  for (const base of ['https://evil.example/', 'http://ott.formula1.com/', 'https://formula1.com.evil.example/']) {
    const r = await get(s, '/s/' + b64url(base) + '/x.mp4');
    assert.equal(r.status, 403, base);
  }
  assert.deepEqual(requested, []);
});

test('unknown paths, and /mpd without a URL, are 404', async () => {
  const { s } = service();
  assert.equal((await get(s, '/nope')).status, 404);
  assert.equal((await get(s, '/mpd')).status, 404);
});
