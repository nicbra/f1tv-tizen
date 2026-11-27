// HdrStream.tmGrid (app/js/hdr.js): a multiview from F1's player_tm masters, against a fake F1 and a fake stream helper.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const CmafDash = require('../app/js/cmaf.js');

const KEY_URL = 'https://f1tv.formula1.com/2.0/R/ENG/BIGSCREEN_HLS/ALL/CONTENT/LA/ck?c=7';
const IV = '0x0102030405060708090a0b0c0d0e0f10';
const base = (ch) => 'https://ott-video-cf.formula1.com/v2/t/' + ch + '/';

/** A player_tm master: 1080p HLG with sound groups (stereo, and 5.1 with its own subtitle group) or none (TRACKER). */
function masterOf(ch, sound) {
  const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (sound) {
    lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",LANGUAGE="eng",NAME="eng",URI="a0/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_1",LANGUAGE="eng",CHANNELS="6",NAME="eng",URI="a2/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="eng",NAME="eng",URI="t0/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs51",LANGUAGE="spa",NAME="spa",URI="t1/index.m3u8"',
      '#EXT-X-STREAM-INF:CODECS="mp4a.40.2,hev1.2.4.L123.B0",RESOLUTION=1920x1080,VIDEO-RANGE=HLG,BANDWIDTH=8000000,AUDIO="audio_0",SUBTITLES="subs"', 'v5/index.m3u8',
      '#EXT-X-STREAM-INF:CODECS="ac-3,hev1.2.4.L123.B0",RESOLUTION=1920x1080,VIDEO-RANGE=HLG,BANDWIDTH=8400000,AUDIO="audio_1",SUBTITLES="subs51"', 'v5/index.m3u8');
  } else lines.push('#EXT-X-STREAM-INF:CODECS="hev1.2.4.L123.B0",RESOLUTION=1920x1080,VIDEO-RANGE=HLG,BANDWIDTH=7700000', 'v5/index.m3u8');
  lines.push('#EXT-X-STREAM-INF:CODECS="mp4a.40.2,hev1.2.4.L93.B0",RESOLUTION=480x270,VIDEO-RANGE=HLG,BANDWIDTH=800000', 'v0/index.m3u8');
  return lines.join('\n') + '\n';
}
/** Its 1080p playlist: media sequence 100, `n` segments of 5.76 s named by their number, one key. */
function playlistOf(ch, n, keyUrl) {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-KEY:METHOD=AES-128,URI="' + (keyUrl || KEY_URL) + '",IV=' + IV + ',KEYFORMAT="identity"',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-22T03:55:00.000Z'];
  for (let k = 0; k < n; k++) lines.push('#EXTINF:5.76,', 'segment__HDR-HD_HEVC_5_' + (100 + k) + '.ts');
  return lines.concat('#EXT-X-ENDLIST').join('\n');
}

function harness(opts = {}) {
  const calls = [], posts = [];
  const routes = {};
  ['1025', '1033', '1003', '1009'].forEach((ch) => {
    routes[base(ch) + 'master.m3u8'] = masterOf(ch, ch !== '1003');
    routes[base(ch) + 'v5/index.m3u8'] = opts.playlist ? opts.playlist(ch) : playlistOf(ch, (opts.lengths || {})[ch] || 6, opts.keyUrl);
  });
  const ctx = vm.createContext({ CmafDash, URL, Uint8Array, AbortController, setTimeout, clearTimeout, Date, navigator: { userAgent: 'TV' },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'), atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    MultiviewLayouts: { layouts: { grid2x2hd: { feeds: [1080, 1080, 1080, 1080] } } },
    fetch: async (url, o = {}) => {
      calls.push({ url, opts: o });
      if (/^http:\/\/127\.0\.0\.1:18765\/stitch\//.test(url)) {
        posts.push(JSON.parse(o.body));
        return { ok: true, status: 201, text: async () => JSON.stringify({ width: 3840, height: 2160, codecs: 'hev1.2.4.L153.B0' }) };
      }
      if (/LA\/ck/.test(url)) return { ok: true, arrayBuffer: async () => Uint8Array.from({ length: 16 }, (_, i) => i).buffer };
      const body = routes[url];
      if (body == null) return { ok: false, status: 404, text: async () => 'missing' };
      return { ok: true, url, text: async () => body };
    } });
  vm.runInContext(fs.readFileSync('app/js/hdr.js', 'utf8'), ctx);
  return { HdrStream: ctx.HdrStream, calls, posts };
}
const masters = (chs) => chs.map((ch) => base(ch) + 'master.m3u8');
const HEADERS = { ascendontoken: 'TOKEN', entitlementtoken: 'ENT' };

test('tmGrid posts the feeds (numbered media, key, IV) and a master: grid video, the sound feed\'s groups and their subtitles', async () => {
  const h = harness();
  const made = await h.HdrStream.tmGrid(masters(['1025', '1033', '1003', '1009']), 'grid2x2hd',
    { id: 't1', sound: masters(['1003', '1033']), at: 12, keyHeaders: HEADERS });
  assert.equal(made.url, 'http://127.0.0.1:18765/stitch/t1/master.m3u8');
  const body = h.posts[0];
  assert.equal(body.probe, 102, '12 s in: the third segment');
  assert.equal(body.lead, 11.52);
  assert.equal(body.playlist, base('1025') + 'v5/index.m3u8');
  assert.deepEqual(body.feeds.map((f) => f.media), ['1025', '1033', '1003', '1009'].map((ch) => base(ch) + 'v5/segment__HDR-HD_HEVC_5_$Number$.ts'));
  assert.ok(body.feeds.every((f) => f.key === '000102030405060708090a0b0c0d0e0f' && f.iv === IV));
  // The key: F1's key server only, with the tokens, never redirected; fetched once.
  const keyCalls = h.calls.filter((c) => /LA\/ck/.test(c.url));
  assert.equal(keyCalls.length, 1);
  assert.deepEqual({ ...keyCalls[0].opts.headers }, HEADERS);
  assert.equal(keyCalls[0].opts.redirect, 'error');
  // TRACKER has no sound: F1 LIVE's groups, each variant with the subtitle group its source variant names.
  const master = body.master.split('\n');
  assert.ok(master.includes('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_1",LANGUAGE="eng",CHANNELS="6",NAME="eng",URI="' + base('1033') + 'a2/index.m3u8"'));
  assert.ok(master.some((l) => /GROUP-ID="subs51"/.test(l)) && master.some((l) => /GROUP-ID="subs"/.test(l)));
  const variants = master.filter((l) => /^#EXT-X-STREAM-INF:/.test(l));
  assert.deepEqual(variants, [
    '#EXT-X-STREAM-INF:BANDWIDTH=31700000,RESOLUTION=$GRIDRESOLUTION$,FRAME-RATE=50.000,VIDEO-RANGE=HLG,CLOSED-CAPTIONS=NONE,CODECS="$GRIDCODECS$,mp4a.40.2",AUDIO="audio_0",SUBTITLES="subs"',
    '#EXT-X-STREAM-INF:BANDWIDTH=31700000,RESOLUTION=$GRIDRESOLUTION$,FRAME-RATE=50.000,VIDEO-RANGE=HLG,CLOSED-CAPTIONS=NONE,CODECS="$GRIDCODECS$,ac-3",AUDIO="audio_1",SUBTITLES="subs51"']);
  assert.ok(master.filter((l) => l === 'video.m3u8').length === 2);
});

test('tmGrid: a clock moment picks its segment; a key elsewhere, or replay feeds of unequal length, are refused', async () => {
  let h = harness();
  await h.HdrStream.tmGrid(masters(['1025', '1033', '1003', '1009']), 'grid2x2hd',
    { id: 't2', sound: [], wall: Date.parse('2026-11-22T03:55:20Z') / 1000, keyHeaders: HEADERS });
  assert.equal(h.posts[0].probe, 103, '20 s after the first segment began');
  h = harness({ keyUrl: 'https://example.com/ck' });
  await assert.rejects(h.HdrStream.tmGrid(masters(['1025', '1033', '1003', '1009']), 'grid2x2hd', { id: 't3', keyHeaders: HEADERS }), /key server/);
  assert.ok(!h.calls.some((c) => /example\.com/.test(c.url)), 'the tokens never go there');
  assert.equal(h.posts.length, 0);
  h = harness({ lengths: { 1009: 5 } });
  await assert.rejects(h.HdrStream.tmGrid(masters(['1025', '1033', '1003', '1009']), 'grid2x2hd', { id: 't4', keyHeaders: HEADERS }), /differ in length/);
  assert.equal(h.posts.length, 0);
});

/** FP2 Qatar 2026, live: one segment from before a 10 min pause, a discontinuity, the clock again, then the broadcast. */
function liveAfterPause(clockAgain = true) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:5', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-DISCONTINUITY-SEQUENCE:4', '#EXT-X-KEY:METHOD=AES-128,URI="' + KEY_URL + '",IV=' + IV + ',KEYFORMAT="identity"',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-27T16:30:37.440Z', '#EXTINF:5.76,', 'segment__HDR-HD_HEVC_5_100.ts', '#EXT-X-DISCONTINUITY'];
  if (clockAgain) lines.push('#EXT-X-PROGRAM-DATE-TIME:2026-11-27T16:40:42.240Z');
  for (let k = 1; k <= 10; k++) lines.push('#EXTINF:5.76,', 'segment__HDR-HD_HEVC_5_' + (100 + k) + '.ts');
  return lines.join('\n');
}

test('tmGrid live: feeds whose playlists break before a pause (FP2 Qatar 2026) play from after the break, by its clock', async () => {
  let h = harness({ playlist: () => liveAfterPause() });
  await h.HdrStream.tmGrid(masters(['1025', '1033', '1003', '1009']), 'grid2x2hd', { id: 't5', sound: [], keyHeaders: HEADERS });
  assert.equal(h.posts[0].probe, 107, 'live: three segments before the newest');
  h = harness({ playlist: () => liveAfterPause() });
  await h.HdrStream.tmGrid(masters(['1025', '1033', '1003', '1009']), 'grid2x2hd',
    { id: 't6', sound: [], wall: Date.parse('2026-11-27T16:40:45Z') / 1000, keyHeaders: HEADERS });
  assert.equal(h.posts[0].probe, 101, 'by the clock after the break');
  // Without the clock after the break: refused, as before (the usual multiview plays).
  h = harness({ playlist: () => liveAfterPause(false) });
  await assert.rejects(h.HdrStream.tmGrid(masters(['1025', '1033', '1003', '1009']), 'grid2x2hd', { id: 't7', keyHeaders: HEADERS }), /unsupported player_tm playlist/);
});
