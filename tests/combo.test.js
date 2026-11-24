// js/combo.js: one HLS master for every feed of a video (instant feed switches).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const base = (ch) => 'https://ott-video-cf.formula1.com/v2/t/' + ch + '/';
/** A player_tm-like master: HLG 2160p (main feeds) / 1080p / 540p and SDR 1080p, sound per `sound`. */
function masterOf(ch, sound) {
  const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS'];
  const media = {
    live: ['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",LANGUAGE="eng",NAME="eng",CHANNELS="2",URI="a0/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",LANGUAGE="spa",NAME="spa",CHANNELS="2",URI="a1/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_1",LANGUAGE="eng",NAME="eng",CHANNELS="6",URI="a2/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",LANGUAGE="eng",NAME="eng_subtitle",URI="t0/index.m3u8"'],
    radio: ['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",LANGUAGE="tea",NAME="tea",CHANNELS="2",URI="a0/index.m3u8"'],
    none: []
  }[sound];
  lines.push(...media);
  const groups = sound === 'live' ? [['audio_0', 'mp4a.40.2'], ['audio_1', 'ac-3']] : sound === 'radio' ? [['audio_0', 'mp4a.40.2']] : [[null, null]];
  const heights = sound === 'live' ? [2160, 1080, 540] : [1080, 540];
  heights.forEach((h, i) => groups.forEach(([g, c]) => {
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=' + (8000000 - i * 100000 + 37) + ',CODECS="' + (c ? c + ',' : '') + 'hev1.2.4.L153.B0",RESOLUTION=' +
      (h * 16 / 9) + 'x' + h + ',VIDEO-RANGE=HLG,FRAME-RATE=50.0' + (g ? ',AUDIO="' + g + '"' : '') + (sound === 'live' ? ',SUBTITLES="subtitles"' : ''), 'v' + h + '/index.m3u8');
  }));
  lines.push('#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="hvc1.1.6.L120.90",RESOLUTION=1920x1080,FRAME-RATE=50.0', 'sdr1080/index.m3u8');
  return lines.join('\n') + '\n';
}

function load(routes) {
  const fetched = [], made = [];
  const ctx = vm.createContext({ URL, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent, setTimeout, clearTimeout,
    Blob, Promise,
    fetch: async (url) => {
      fetched.push(url);
      const body = routes[url];
      if (body == null) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, url, text: async () => body };
    } });
  ctx.URL = { createObjectURL: (b) => 'blob:combo-' + fetched.length, revokeObjectURL() {} };
  Object.setPrototypeOf(ctx.URL, URL);
  // `new URL(...)` must still work: give the context the real constructor with the object URL helpers on it.
  class U extends URL {}
  U.createObjectURL = (b) => { made.push(b); return 'blob:combo-' + made.length; };
  U.revokeObjectURL = () => {};
  ctx.URL = U;
  vm.runInContext(fs.readFileSync('app/js/combo.js', 'utf8'), ctx);
  return { FeedCombo: ctx.FeedCombo, fetched, made };
}

const feeds = [
  { index: 0, channel: '1025', sound: 'live' }, { index: 1, channel: '1033', sound: 'live' },
  { index: 2, channel: '1003', sound: 'none' }, { index: 3, channel: '1009', sound: 'radio' }];
const routesOf = (list) => Object.fromEntries(list.map((f) => [base(f.channel) + 'master.m3u8', masterOf(f.channel, f.sound)]));
const listOf = (list) => list.map((f) => ({ index: f.index, channel: f.channel, url: base(f.channel) + 'master.m3u8' }));

test('one master for every feed: its HLG variants tagged with the feed number, its own sound and subtitles, addresses absolute', async () => {
  const { FeedCombo } = load(routesOf(feeds));
  const c = await FeedCombo.build(listOf(feeds), { soundFrom: ['1033', '1025'] });
  assert.match(c.uri, /^blob:combo-/);
  const lines = c.master.split('\n'), inf = lines.filter((l) => /^#EXT-X-STREAM-INF:/.test(l));
  assert.ok(lines.every((l) => !l || l.charAt(0) === '#' || /^https:\/\//.test(l)), 'absolute variant addresses');
  assert.ok(lines.filter((l) => /URI="/.test(l)).every((l) => /URI="https:\/\//.test(l)), 'absolute rendition addresses');
  assert.ok(inf.every((l) => /VIDEO-RANGE=HLG/.test(l) && /CLOSED-CAPTIONS=NONE/.test(l)), 'HLG only, no caption probing');
  const feedOf = (l) => +/BANDWIDTH=(\d+)/.exec(l)[1] % 100;
  // main: 3 heights x 2 sound groups; F1 LIVE the same; TRACKER: 2 heights x F1 LIVE's 2 groups; onboard: 2 x 1.
  assert.deepEqual([0, 1, 2, 3].map((k) => inf.filter((l) => feedOf(l) === k).length), [6, 6, 4, 2]);
  // Each feed's sound under its own group; TRACKER (no sound) on F1 LIVE's groups (feed 1).
  assert.ok(inf.filter((l) => feedOf(l) === 0).every((l) => /AUDIO="a0-audio_[01]"/.test(l)));
  assert.ok(inf.filter((l) => feedOf(l) === 2).every((l) => /AUDIO="a1-audio_[01]"/.test(l)));
  assert.ok(inf.filter((l) => feedOf(l) === 3).every((l) => /AUDIO="a3-audio_0"/.test(l)));
  assert.ok(inf.some((l) => /CODECS="ac-3,hev1/.test(l)), 'the 5.1 group keeps its codec');
  // Subtitle names carry the feed number (player.js picks the playing feed's).
  assert.ok(lines.some((l) => /TYPE=SUBTITLES/.test(l) && /NAME="1\|eng_subtitle"/.test(l) && /GROUP-ID="s1-subtitles"/.test(l)));
  // What player.js needs to prepare a feed: its variants by height and its sound playlists by language.
  const live = c.feeds.find((f) => f.channel === '1033');
  assert.deepEqual(Array.from(live.variants, (v) => v.height), [2160, 1080, 540]);
  assert.deepEqual(Array.from(live.audio.eng, (x) => [x.uri, x.channels]), [[base('1033') + 'a0/index.m3u8', 2], [base('1033') + 'a2/index.m3u8', 6]]);
  assert.equal(c.feeds.find((f) => f.channel === '1003').audio.eng[0].uri, base('1033') + 'a0/index.m3u8', 'TRACKER takes F1 LIVE\'s sound (soundFrom)');
});

test('feeds whose master doesn\'t come are left out; fewer than two feeds: no combined master; SDR on request', async () => {
  const routes = routesOf(feeds);
  delete routes[base('1009') + 'master.m3u8'];
  let { FeedCombo } = load(routes);
  let c = await FeedCombo.build(listOf(feeds), {});
  assert.deepEqual(Array.from(c.feeds, (f) => f.channel), ['1025', '1033', '1003']);
  ({ FeedCombo } = load({ [base('1025') + 'master.m3u8']: masterOf('1025', 'live') }));
  assert.equal(await FeedCombo.build(listOf(feeds), {}), null);
  ({ FeedCombo } = load(routesOf(feeds)));
  c = await FeedCombo.build(listOf(feeds), { range: 'SDR' });
  const inf = c.master.split('\n').filter((l) => /^#EXT-X-STREAM-INF:/.test(l));
  assert.ok(inf.length && inf.every((l) => /VIDEO-RANGE=SDR/.test(l) && /sdr1080/.test(c.master)));
  assert.equal(FeedCombo.feedOf({ bandwidth: 7999937 + 2 - 37 }), 2);
});

/** F1's web master (clear CMAF, 2025 on): H.264 and 8-bit HEVC, no VIDEO-RANGE, its own stereo sound per feed. */
function webMaster(langs) {
  const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS'];
  langs.forEach((l, i) => lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",CHANNELS="2",NAME="' + l + '",LANGUAGE="' + l + '",DEFAULT=' + (i ? 'NO' : 'YES') + ',URI="a' + i + '/index.m3u8"'));
  [['avc1.4D402A', 7495250], ['hvc1.1.6.L123.B0', 6888248]].forEach(([c, bw]) => [1080, 540].forEach((h) =>
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=' + (bw - (1080 - h) * 1000) + ',RESOLUTION=' + (h * 16 / 9) + 'x' + h + ',FRAME-RATE=50.000,CODECS="' + c + ',mp4a.40.2",AUDIO="audio_0"',
      c.slice(0, 4) + h + '/index.m3u8')));
  return lines.join('\n') + '\n';
}

test('SDR from web answers: both codec families, each feed its own sound; a master read before is not fetched again', async () => {
  const web = (ch) => 'https://ott-video-fer-cf.formula1.com/v2/pa_x/' + ch + '/index.m3u8';
  const routes = { [web('main')]: webMaster(['eng', 'deu']), [web('1033')]: webMaster(['eng', 'spa']), [web('1003')]: webMaster(['eng', 'deu', 'fra']) };
  const { FeedCombo, fetched } = load(routes);
  const two = [{ index: 0, channel: 'main', url: web('main') }, { index: 1, channel: '1033', url: web('1033') }];
  let c = await FeedCombo.build(two, { range: 'SDR', soundFrom: ['1033', 'main'] });
  assert.equal(c.range, 'SDR');
  const inf = c.master.split('\n').filter((l) => /^#EXT-X-STREAM-INF:/.test(l));
  assert.equal(inf.length, 8, '2 feeds x 2 codecs x 2 heights');
  assert.ok(inf.some((l) => /avc1\.4D402A/.test(l)) && inf.some((l) => /hvc1\.1\.6/.test(l)));
  assert.ok(inf.every((l) => /VIDEO-RANGE=SDR/.test(l)));
  assert.ok(inf.filter((l) => +/BANDWIDTH=(\d+)/.exec(l)[1] % 100 === 1).every((l) => /AUDIO="a1-audio_0"/.test(l)), 'F1 LIVE keeps its own sound');
  assert.deepEqual(Object.keys(c.feeds[0].audio), ['eng', 'deu']);
  // A third feed joins: only its master is read.
  c = await FeedCombo.build(two.concat([{ index: 2, channel: '1003', url: web('1003') }]), { range: 'SDR' });
  assert.equal(c.feeds.length, 3);
  assert.deepEqual(fetched, [web('main'), web('1033'), web('1003')]);
});

test('the master a load starts with marks only that feed\'s sound DEFAULT (Shaka starts with the DEFAULT sound\'s variants)', async () => {
  const web = (ch) => 'https://ott-video-fer-cf.formula1.com/v2/pa_x/' + ch + '/index.m3u8';
  const { FeedCombo, made } = load({ [web('main')]: webMaster(['eng', 'deu']), [web('1033')]: webMaster(['eng', 'spa']) });
  const c = await FeedCombo.build([{ index: 0, channel: 'main', url: web('main') }, { index: 1, channel: '1033', url: web('1033') }], { range: 'SDR' });
  const uri = FeedCombo.startAt(c, 1);
  assert.notEqual(uri, c.uri);
  assert.equal(FeedCombo.startAt(c, 1), uri, 'made once per feed');
  const text = await made.at(-1).text(), audio = text.split('\n').filter((l) => /TYPE=AUDIO/.test(l));
  assert.deepEqual(audio.filter((l) => /DEFAULT=YES/.test(l)).map((l) => /GROUP-ID="([^"]*)".*LANGUAGE="(\w+)"|LANGUAGE="(\w+)".*GROUP-ID="([^"]*)"/.exec(l).slice(1).filter(Boolean).sort().join(' ')),
    ['a1-audio_0 eng']);
  assert.equal(text.split('\n').filter((l) => /^#EXT-X-STREAM-INF/.test(l)).length, 8, 'the variants as they were');
  // Feeds without a DEFAULT of their own (player_tm onboards), and those on a donor's sound (TRACKER on F1 LIVE's).
  const tm = load(routesOf(feeds));
  const d = await tm.FeedCombo.build(listOf(feeds), { soundFrom: ['1033', '1025'] });
  tm.FeedCombo.startAt(d, 3);
  let lines = (await tm.made.at(-1).text()).split('\n').filter((l) => /DEFAULT=YES/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /GROUP-ID="a3-audio_0"/);
  tm.FeedCombo.startAt(d, 2);
  lines = (await tm.made.at(-1).text()).split('\n').filter((l) => /DEFAULT=YES/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /GROUP-ID="a1-audio_/, 'TRACKER starts on F1 LIVE\'s sound');
});
