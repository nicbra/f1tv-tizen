const assert = require('node:assert/strict');
const { test } = require('node:test');
const { audioSegmentUrl, sencCount, hlgVariants, heartbeatBase, offerSnapshot, offerDiff, timingWorker, failingKeys } = require('../monitor/check.js');

const MPD = `<MPD type="dynamic"><Period id="1">
<AdaptationSet contentType="video"><SegmentTemplate media="v_$RepresentationID$_$Number$.mp4" startNumber="100"/>
<Representation id="video=6000"/></AdaptationSet>
<AdaptationSet contentType="audio" lang="eng"><SegmentTemplate timescale="48000" media="segment_$RepresentationID$_$Number$.mp4" startNumber="311260634">
<SegmentTimeline><S t="0" d="276480" r="9"/><S d="276480"/></SegmentTimeline></SegmentTemplate>
<Representation id="audio_eng=128000" bandwidth="128000"/></AdaptationSet></Period></MPD>`;
const URL_ = 'https://ott.formula1.com/v2/pa_x/out/v1/Main/index.mpd?start=1&end=2';

test('the monitor finds a recent audio segment a few back from the live edge', () => {
  // 11 segments (311260634..311260644); three back from the end is number 311260642.
  assert.equal(audioSegmentUrl(MPD, URL_), 'https://ott.formula1.com/v2/pa_x/out/v1/Main/segment_audio_eng=128000_311260642.mp4');
});

test('the monitor resolves $Time$ templates, padded numbers and BaseURLs', () => {
  const timed = MPD.replace('segment_$RepresentationID$_$Number$.mp4', 'a/$Time$.m4s');
  assert.equal(audioSegmentUrl(timed, URL_), 'https://ott.formula1.com/v2/pa_x/out/v1/Main/a/2211840.m4s');
  const padded = MPD.replace('segment_$RepresentationID$_$Number$', () => 'segment_$RepresentationID$_$Number%012d$').replace('startNumber="311260634"', 'startNumber="1"');
  assert.match(audioSegmentUrl(padded, URL_), /_000000000009\.mp4$/);
  const based = MPD.replace('<Period id="1">', '<Period id="1"><BaseURL>https://cdn2.formula1.com/x/</BaseURL>');
  assert.match(audioSegmentUrl(based, URL_), /^https:\/\/cdn2\.formula1\.com\/x\/segment_/);
  assert.equal(audioSegmentUrl('<MPD></MPD>', URL_), null);
});

test('the monitor reads the senc sample count, or null without a senc box', () => {
  const senc = Buffer.alloc(16);
  senc.writeUInt32BE(16, 0); senc.write('senc', 4); senc.writeUInt32BE(0, 8); senc.writeUInt32BE(270, 12);
  assert.equal(sencCount(senc), 270);
  assert.equal(sencCount(Buffer.from('no boxes here')), null);
});

test('the monitor finds HLG resolutions without mistaking SDR or iframe variants for HDR', () => {
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="hvc1.2.4.L153.B0,ec-3",RESOLUTION=1920x1080,VIDEO-RANGE=HLG
hd.m3u8
#EXT-X-STREAM-INF:VIDEO-RANGE=SDR,RESOLUTION=7680x4320
sdr.m3u8
#EXT-X-I-FRAME-STREAM-INF:VIDEO-RANGE=HLG,RESOLUTION=7680x4320,URI="iframe.m3u8"
#EXT-X-STREAM-INF:VIDEO-RANGE=HLG,RESOLUTION=3840x2160
uhd.m3u8
#EXT-X-STREAM-INF:VIDEO-RANGE=HLG
unknown.m3u8`;
  assert.deepEqual(hlgVariants(master.replace(/\n/g, '\r\n')), [
    { width: 3840, height: 2160 }, { width: 1920, height: 1080 }
  ]);
  assert.deepEqual(hlgVariants('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160,VIDEO-RANGE=SDR'), []);
  assert.deepEqual(hlgVariants('#EXTM3U\n#EXT-X-STREAM-INF:CODECS="fake,VIDEO-RANGE=HLG",RESOLUTION=3840x2160'), []);
  assert.deepEqual(hlgVariants('#EXTM3U\n#EXT-X-STREAM-INF:VIDEO-RANGE=HLG,RESOLUTION=0x2160'), []);
});

test('the monitor measures the first heartbeat base in milliseconds, including a buffered burst', () => {
  const base = Date.parse('2026-10-25T19:00:00Z');
  assert.equal(heartbeatBase('00:05:15.000{"Utc":"2026-10-25T19:00:00Z"}'), base - 315000);
  assert.equal(heartbeatBase('01:02:03.456{"Utc":"2026-10-25T20:02:03.456Z"}'), base);
  for (const line of ['', 'bad offset {"Utc":"2026-10-25T19:00:00Z"}', '00:00:00.000{', '00:00:00.000{"Utc":"bad"}']) {
    assert.equal(heartbeatBase(line), null);
  }
});

test('the monitor exposes race start and the first heartbeat without changing the worker median', async () => {
  const feeds = {
    Heartbeat: '00:05:15.000{"Utc":"2026-10-25T19:00:00Z"}\n' +
      '00:05:16.000{"Utc":"2026-10-25T19:05:16Z"}\n00:05:17.000{"Utc":"2026-10-25T19:05:17Z"}\n',
    SessionInfo: '00:00:00.000{"Type":"Race","Name":"Race"}\n',
    SessionData: '00:10:00.000{"StatusSeries":[{"Utc":"2026-10-25T19:10:00Z","SessionStatus":"Started"}]}\n',
    LapCount: '00:00:00.000{"CurrentLap":1,"TotalLaps":50}\n'
  };
  const original = global.fetch;
  global.fetch = async (url) => {
    const feed = /\/([^/]+)\.jsonStream$/.exec(url)[1];
    return new Response(feeds[feed] || '', { status: feeds[feed] ? 200 : 404 });
  };
  try {
    const w = await timingWorker('2026/Test/Race/', 'test-token');
    assert.equal(w.base, Date.parse('2026-10-25T19:00:00Z'));
    assert.equal(w.base - w.firstHeartbeat, 315000);
    assert.equal(w.startedAt, Date.parse('2026-10-25T19:10:00Z'));
    assert.equal(w.query(w.startedAt - 60000).beforeStart, true);
    assert.equal(w.query(w.startedAt + 60000).beforeStart, false);
    assert.equal(w.query(w.startedAt + 60000).lap, 1);
  } finally { global.fetch = original; }
});

const OFFER = {
  devices: { web: 'SDR_HD_CMAF', tvos: 'HDR_UHD_CMAF', ios: 'HDR_HD_CMAF' },
  liveNow: ['WEB'], videoKeys: ['liveNow', 'metadata', 'playbackOffsetsVersion'],
  feeds: ['OBC', 'WIF'], playbackOffsetsVersion: 1
};

test('offer snapshots include only enabled platforms and sorted, unique feed identifiers', () => {
  assert.deepEqual(offerSnapshot({
    metadata: { additionalStreams: [{ identifier: 'WIF' }, { identifier: 'OBC' }, { identifier: 'OBC' }, {}] },
    playbackOffsetsVersion: 1,
    liveNow: { enabled: { TVOS: false, WEB: true, SAMSUNG: 'true' } }
  }, OFFER.devices), OFFER);
  assert.deepEqual(offerSnapshot({}, {}), {
    devices: {}, liveNow: [], videoKeys: [], feeds: [], playbackOffsetsVersion: null
  });
});

test('offer changes report stream errors, additions, removals and offset versions', () => {
  const next = {
    devices: { web: 'SDR_HD_CMAF', tvos: 'HDR_UHD_CMAF_WV', ios: 'error: HTTP 500 Failed to evaluate stream rule' },
    liveNow: ['SAMSUNG'], videoKeys: ['liveNow', 'metadata', 'multiview'],
    feeds: ['DATA', 'WIF'], playbackOffsetsVersion: 2
  };
  assert.deepEqual(offerDiff(OFFER, next), [
    'ios: HDR_HD_CMAF → error: HTTP 500 Failed to evaluate stream rule',
    'tvos: HDR_UHD_CMAF → HDR_UHD_CMAF_WV',
    'liveNow: + SAMSUNG; - WEB',
    'new video keys: multiview', 'removed video keys: playbackOffsetsVersion',
    'feeds: + DATA; - OBC', 'playbackOffsetsVersion: 1 → 2'
  ]);
  assert.deepEqual(offerDiff(next, JSON.parse(JSON.stringify(next))), []);
  assert.match(offerDiff(next, OFFER).join('; '), /ios: error: HTTP 500 Failed to evaluate stream rule → HDR_HD_CMAF/);
});

test('offer changes ignore ordering and detect a missing version or device', () => {
  const reordered = { ...OFFER, videoKeys: [...OFFER.videoKeys].reverse(), feeds: ['WIF', 'OBC'] };
  assert.deepEqual(offerDiff(OFFER, reordered), []);
  assert.deepEqual(offerDiff(OFFER, { ...OFFER, playbackOffsetsVersion: null }), ['playbackOffsetsVersion: 1 → null']);
  assert.deepEqual(offerDiff(OFFER, { ...OFFER, devices: { ...OFFER.devices, chromecast: 'SDR_HD_DASH_SINGLE' } }),
    ['chromecast: missing → SDR_HD_DASH_SINGLE']);
});

test('two different changes in a row count as different failures, so both notify', () => {
  const run = (detail) => [{ name: 'menu', ok: false, detail: 'no Home entry' }, { name: 'what F1 offers (changes)', ok: false, detail }];
  const a = failingKeys(run('tvos: HDR_UHD_CMAF → HDR_UHD_CMAF_WV')), b = failingKeys(run('liveNow: + SAMSUNG'));
  assert.equal(a[0], 'menu');
  assert.notEqual(a.join('|'), b.join('|'));
  assert.deepEqual(failingKeys([{ name: 'menu', ok: true }]), []);
});
