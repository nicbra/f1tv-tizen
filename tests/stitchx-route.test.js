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
