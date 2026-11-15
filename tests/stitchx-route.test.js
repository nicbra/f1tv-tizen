// The helper's H.264 multiview route (app/service/stitchx/helper-route.js): which requests it takes.
const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../app/service/stitchx/helper-route.js');

/** The route with fake helper parts: records answers and playlist fetches (which never answer here). */
function setup() {
  const answers = [], fetched = [];
  const r = route({
    fetchAll: (urls) => { fetched.push(urls); },
    send: (res, status, body) => answers.push({ status, body: String(body) }),
    toBuf: (t) => t,
    f1Cdn: (u) => /^https:\/\/f1\.example\//.test(u),
    port: 0
  });
  return { r, answers, fetched };
}
const feed = (name) => ({ playlist: 'https://f1.example/' + name + '/540.m3u8' });

test('interleaved, one small feed is taken (picture in picture: the big feed plays on AVPlay)', () => {
  const { r, answers, fetched } = setup();
  r.post({}, 'pip', { kind: 'h264x', interleave: true, feedTag: true, feeds: [feed('ver')] });
  assert.deepEqual(answers, [], 'no refusal');
  assert.deepEqual(fetched, [['https://f1.example/ver/540.m3u8']]);
});

test('requests without interleave and requests with more than four feeds are refused', () => {
  const { r, answers } = setup();
  r.post({}, 'one', { kind: 'h264x', feeds: [feed('ver')] });
  r.post({}, 'five', { kind: 'h264x', interleave: true, feeds: ['a', 'b', 'c', 'd', 'e'].map(feed) });
  assert.deepEqual(answers.map((a) => a.status), [400, 400]);
});

test('a playlist with a malformed #EXTINF duration is refused, not built with NaN timing', () => {
  const answers = [];
  const route = require('../app/service/stitchx/helper-route.js');
  const r = route({
    fetchAll: (urls, cb) => cb(null, [Buffer.from('#EXTM3U\n#EXTINF:oops,\na.ts\n#EXTINF:2.0,\nb.ts\n')]),
    send: (res, status, body) => answers.push({ status, body: String(body) }),
    toBuf: (t) => t, f1Cdn: () => true, port: 0
  });
  r.post({}, 'nan', { kind: 'h264x', interleave: true, feeds: [feed('ver')] });
  assert.deepEqual(answers.map((a) => a.status), [422]);
  assert.match(answers[0].body, /bad #EXTINF duration/);
});

test('playlist durations must be finite and positive, one per segment', () => {
  const route = require('../app/service/stitchx/helper-route.js');
  for (const text of ['#EXTM3U\n#EXTINF:Infinity,\na.ts\n#EXTINF:Infinity,\nb.ts\n', '#EXTM3U\n#EXTINF:0,\na.ts\n',
    '#EXTM3U\n#EXTINF:2.0,\na.ts\nb.ts\n', '#EXTM3U\n']) {
    const answers = [];
    const r = route({ fetchAll: (urls, cb) => cb(null, [Buffer.from(text)]), send: (res, status, body) => answers.push({ status, body: String(body) }),
      toBuf: (t) => t, f1Cdn: () => true, port: 0 });
    r.post({}, 'p', { kind: 'h264x', interleave: true, feeds: [feed('ver')] });
    assert.deepEqual(answers.map((a) => a.status), [422], text);
  }
});

test('ADTS: every frame is checked, an unknown or changed sample rate is refused', () => {
  const ts = require('../app/service/stitchx/tsdemux.js');
  const frame = (ri, ch = 2) => { const len = 7 + 4, b = Buffer.alloc(len);
    b[0] = 0xff; b[1] = 0xf1; b[2] = (1 << 6) | (ri << 2) | (ch >> 2); b[3] = ((ch & 3) << 6) | (len >> 11);
    b[4] = (len >> 3) & 0xff; b[5] = ((len & 7) << 5) | 0x1f; b[6] = 0xfc; return b; };
  const packed = (...frames) => new Uint8Array(Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), ...frames]));
  assert.equal(ts.audio(packed(frame(3), frame(3))).frames.length, 2);
  assert.throws(() => ts.audio(packed(frame(13))), /unsupported ADTS sample rate/);
  assert.throws(() => ts.audio(packed(frame(3), frame(14))), /unsupported ADTS sample rate/);
  assert.throws(() => ts.audio(packed(frame(3), frame(4))), /ADTS configuration changed/);
  assert.throws(() => ts.audio(packed(frame(3, 2), frame(3, 1))), /ADTS configuration changed/);
});
