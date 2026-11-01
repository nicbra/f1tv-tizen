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

test('GET /mpd resolves segments against the address a redirect led to', async () => {
  const src = 'https://cdn.formula1.com/entry/index.mpd';
  const { s } = service({
    [src]: { status: 302, headers: { location: '/actual/main/index.mpd' } },
    'https://cdn.formula1.com/actual/main/index.mpd': { body: LIVE_MPD }
  });
  const body = String((await get(s, '/mpd?u=' + encodeURIComponent(src))).body);
  assert.match(body, /<BaseURL>https:\/\/cdn\.formula1\.com\/actual\/main\/<\/BaseURL>/);
  assert.doesNotMatch(body, /\/entry\//);
});

test('GET /mpd keeps the requested base when a redirect leaves formula1.com, which the audio proxy refuses', async () => {
  const src = 'https://ott.formula1.com/live/index.mpd';
  const { s } = service({
    [src]: { status: 302, headers: { location: 'https://cdn.example.net/x/index.mpd' } },
    'https://cdn.example.net/x/index.mpd': { body: LIVE_MPD }
  });
  const body = String((await get(s, '/mpd?u=' + encodeURIComponent(src))).body);
  assert.match(body, /<BaseURL>https:\/\/ott\.formula1\.com\/live\/<\/BaseURL>/);
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

test('GET /s/ keeps the segment\'s query string', async () => {
  const base = 'https://ott-video-cf.formula1.com/out/v1/Main/';
  const { s, requested } = service({ [base + 'audio_eng_42.mp4?token=abc&n=1']: { body: segment() } });
  const r = await get(s, '/s/' + b64url(base) + '/audio_eng_42.mp4?token=abc&n=1');
  assert.deepEqual(requested, [base + 'audio_eng_42.mp4?token=abc&n=1']);
  assert.equal(r.status, 200);
});

test('GET /s/ refuses hosts other than F1\'s CDNs', async () => {
  const { s, requested } = service();
  for (const base of ['https://evil.example/', 'http://ott.formula1.com/', 'https://formula1.com.evil.example/',
    'https://someone.akamaized.net/', 'https://f1prodlive.akamaized.net.evil.example/']) {
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

function post(s, path, body) {
  return new Promise(resolve => {
    const req = new EventEmitter(); req.url=path; req.method='POST';
    const res={writeHead(status, headers){this.status=status;this.headers=headers;},end(body){resolve({status:this.status,headers:this.headers,body});}};
    s.handle(req,res);
    req.emit('data',Buffer.from(body)); req.emit('end');
  });
}
test('prepared VOD manifests have distinct bounded loopback URLs', async () => {
  const {s}=service();
  const one='<MPD type="static"><Period id="one"/></MPD>', two='<MPD type="static"><Period id="two"/></MPD>';
  assert.equal((await post(s,'/vod/one.mpd',one)).status,201);
  assert.equal((await post(s,'/vod/two.mpd',two)).status,201);
  assert.equal((await get(s,'/vod/one.mpd')).body.toString(),one);
  assert.equal((await get(s,'/vod/two.mpd')).body.toString(),two);
  assert.equal((await get(s,'/vod/missing.mpd')).status,404);
  assert.equal((await post(s,'/vod/bad.mpd','not a manifest')).status,400);
  assert.equal((await post(s,'/vod/big.mpd','x'.repeat(2*1024*1024+1))).status,413);
  for(let i=0;i<5;i++)await post(s,'/vod/new'+i+'.mpd',one);
  assert.equal((await get(s,'/vod/one.mpd')).status,404);
});

// Live HDR: a live manifest as F1 sends it (FP3, Mexico 2026), and the app's HLG set for it.
const LIVE_HDR_MPD = '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="dynamic" availabilityStartTime="2024-01-01T00:00:00Z" minimumUpdatePeriod="PT6S">' +
  '<Period id="1" start="PT24830H49M49.440S">' +
  '<AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="50000" media="v_$RepresentationID$_$Number$.mp4" initialization="v_init.mp4" startNumber="311365738" presentationTimeOffset="89672909472000">' +
  '<SegmentTimeline><S t="89673332256000" d="288000" r="738"/></SegmentTimeline></SegmentTemplate><Representation id="SDR_5" bandwidth="6144000" height="1080"/></AdaptationSet>' +
  '<AdaptationSet contentType="audio" lang="eng"><SegmentTemplate timescale="48000" media="a_$Number$.mp4" startNumber="311365738"><SegmentTimeline><S t="86086398965760" d="276480" r="738"/></SegmentTimeline></SegmentTemplate><Representation id="A" bandwidth="128000"/></AdaptationSet>' +
  '<AdaptationSet contentType="application" codecs="stpp" lang="eng"><SegmentTemplate timescale="50000" media="t_$Number$.mp4" startNumber="311365738"><SegmentTimeline><S t="89673332256000" d="288000" r="738"/></SegmentTimeline></SegmentTemplate><Representation id="T" bandwidth="256"/></AdaptationSet>' +
  '<AdaptationSet contentType="video" mimeType="video/mp4"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="1"/><Representation id="TRICK" bandwidth="33333"/></AdaptationSet>' +
  '</Period></MPD>';
const HLG_SET = '<AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="hlg0" bandwidth="18000000">' +
  '<SegmentTemplate timescale="50000" presentationTimeOffset="89672909472000" startNumber="311365738" media="https://ott-video-cf.formula1.com/hdr/seg_$Number$.mp4"><!--timeline--></SegmentTemplate></Representation></AdaptationSet>';

test('live HDR: the stored HLG set replaces the official video, on the official timeline of each refresh', async () => {
  const live = 'https://ott-video-cf.formula1.com/v2/x/Main/index.mpd';
  const { s } = service({ [live]: { body: LIVE_HDR_MPD } });
  assert.equal((await post(s, '/hdr/abc-1', HLG_SET)).status, 201);
  assert.equal((await post(s, '/hdr/bad', '<AdaptationSet>no timeline</AdaptationSet>')).status, 400);
  assert.equal((await get(s, '/hdr/abc-1')).status, 404, 'stored sets are for the manifest only');
  const r = await get(s, '/mpd?u=' + encodeURIComponent(live) + '&audio=eng&hdr=abc-1&notext=1');
  assert.equal(r.status, 200);
  const mpd = r.body.toString();
  assert.ok(mpd.includes('<Representation id="hlg0" bandwidth="18000000"><SegmentTemplate timescale="50000" presentationTimeOffset="89672909472000" startNumber="311365738" media="https://ott-video-cf.formula1.com/hdr/seg_$Number$.mp4"><SegmentTimeline><S t="89673332256000" d="288000" r="738"/></SegmentTimeline></SegmentTemplate>'));
  assert.ok(!mpd.includes('SDR_5'), 'the SDR video is gone');
  assert.ok(mpd.includes('TRICK'), 'other video sets (trick play) stay');
  assert.ok(!mpd.includes('codecs="stpp"'), 'subtitles are the app\'s');
  assert.match(mpd, /contentType="audio" lang="eng"><BaseURL>http:\/\/127\.0\.0\.1:18765\/s\//);
  // Without the stored set (e.g. after the helper restarted) the manifest fails, and the app falls back.
  assert.equal((await get(s, '/mpd?u=' + encodeURIComponent(live) + '&hdr=gone')).status, 502);
});

test('live HDR: a refresh that moves the window start renumbers the swapped-in video like the official one', async () => {
  const live = 'https://ott-video-cf.formula1.com/v2/x/Main/index.mpd';
  const moved = LIVE_HDR_MPD.replace('startNumber="311365738" presentationTimeOffset="89672909472000"', 'startNumber="311365800" presentationTimeOffset="89672927328000"');
  const { s } = service({ [live]: { body: moved } });
  await post(s, '/hdr/abc-9', HLG_SET);
  const mpd = (await get(s, '/mpd?u=' + encodeURIComponent(live) + '&hdr=abc-9&notext=1')).body.toString();
  assert.ok(mpd.includes('<Representation id="hlg0" bandwidth="18000000"><SegmentTemplate timescale="50000" presentationTimeOffset="89672927328000" startNumber="311365800"'));
});

test('live HDR: a time-shifted start trims the HLG timeline like the rest', async () => {
  const live = 'https://ott-video-cf.formula1.com/v2/x/Main/index.mpd';
  const { s } = service({ [live]: { body: LIVE_HDR_MPD } });
  await post(s, '/hdr/abc-2', HLG_SET);
  const realNow = Date.now;
  // The timeline's end: 739 segments from 1793466645.12 (Unix seconds); ask for 10 minutes behind it.
  const end = (89673332256000 + 739 * 288000) / 50000 - 1793458189.44 + Date.parse('2024-01-01T00:00:00Z') / 1000 + 89390989.44;
  try {
    Date.now = () => end * 1000;
    const mpd = (await get(s, '/mpd?u=' + encodeURIComponent(live) + '&shift=600&hdr=abc-2')).body.toString();
    const hlg = /<Representation id="hlg0"[\s\S]*?<S t="89673332256000" d="288000" r="(\d+)"\/>/.exec(mpd);
    assert.ok(hlg, 'the HLG video is still there');
    assert.ok(Math.abs(+hlg[1] - (738 - 600 / 5.76)) <= 1, 'trimmed to 10 minutes behind: r=' + hlg[1]);
  } finally { Date.now = realNow; }
});

test('GET /log lists recent requests by kind and CDN host, without paths or tokens', async () => {
  const live = 'https://ott-video-cf.formula1.com/v2/pa_TOKEN/Main/index.mpd?secret=1';
  const { s } = service({ [live]: { body: LIVE_HDR_MPD } });
  await post(s, '/hdr/abc-3', HLG_SET);
  await get(s, '/mpd?u=' + encodeURIComponent(live) + '&hdr=abc-3');
  await get(s, '/mpd?u=' + encodeURIComponent(live) + '&hdr=missing');
  await get(s, '/ping');
  const log = JSON.parse((await get(s, '/log')).body.toString());
  assert.deepEqual(log.map((r) => [r.kind, r.status, r.host]), [['hdr-set', 201, ''], ['live-hdr-mpd', 200, 'ott-video-cf.formula1.com'], ['live-hdr-mpd', 502, 'ott-video-cf.formula1.com']]);
  assert.ok(!JSON.stringify(log).includes('TOKEN') && !JSON.stringify(log).includes('secret'));
  assert.ok(log.every((r) => typeof r.ms === 'number'));
});

test('F1\'s Akamai CDN is served like its own: audio segments and live manifests', async () => {
  const live = 'https://f1prodlive.akamaized.net/v2/x/Main/index.mpd';
  const seg = 'https://f1prodlive.akamaized.net/v2/x/Main/a_1.mp4';
  const { s } = service({ [live]: { body: LIVE_HDR_MPD }, [seg]: { body: segment({ trunCount: 4 }) } });
  await post(s, '/hdr/akamai', HLG_SET);
  const mpd = await get(s, '/mpd?u=' + encodeURIComponent(live) + '&hdr=akamai&notext=1');
  assert.equal(mpd.status, 200);
  assert.ok(mpd.body.toString().includes('/s/' + b64url('https://f1prodlive.akamaized.net/v2/x/Main/') + '/'));
  assert.equal((await get(s, '/s/' + b64url('https://f1prodlive.akamaized.net/v2/x/Main/') + '/a_1.mp4')).status, 200);
});
