'use strict';
// What each kind of playback gives the viewer, against the structure of F1's real offers (tests/fixtures/f1-offers.json,
// tests/helpers/f1-offers.js): wherever the sound feed's offer has 5.1 or subtitles, every way of playing it must carry
// them, unless its row says why not. A feature added to one path and not to its siblings fails here (2026-11-26: the clear
// multiview stayed stereo while single feeds and encrypted multiviews had the 5.1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const CmafDash = require('../app/js/cmaf.js');
const F1 = require('./helpers/f1-offers.js');
const Harness = require('./helpers/player-harness.js');

const root = path.join(__dirname, '..');

function hdr(posts) {
  const serve = F1.serve();
  const ctx = vm.createContext({ CmafDash, URL, Uint8Array, AbortController, setTimeout, clearTimeout, Date, navigator: { userAgent: 'test' },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'), atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    MultiviewLayouts: { layouts: {} }, Diag: { note: (k, d) => { if (process.env.MATRIX_DEBUG) console.log('NOTE', k, JSON.stringify(d)); } },
    fetch: (address, opts = {}) => { if (opts.method === 'POST' && posts) posts.push(JSON.parse(opts.body)); return serve(address, opts); } });
  vm.runInContext(fs.readFileSync(path.join(root, 'app/js/hdr.js'), 'utf8'), ctx);
  return ctx;
}

/** A layout for these feeds: for each, the first HLG height its offer has. */
function layout(ctx, keys) {
  ctx.MultiviewLayouts.layouts.matrix = { feeds: keys.map((k) => F1.hlgHeights(k)[0]) };
  return 'matrix';
}

/** The sound sets of a DASH manifest: [{ lang, codec, channels }]. */
function dashSound(mpd) {
  return mpd.split('<AdaptationSet').slice(1).filter((x) => /contentType="audio"/.test(x)).map((x) => ({
    lang: (x.match(/lang="([^"]+)"/) || [])[1], codec: (x.match(/codecs="([^"]+)"/) || [])[1],
    channels: +((x.match(/AudioChannelConfiguration[^>]*value="(\d+)"/) || [])[1] || 0) }));
}

/** The sound renditions of an HLS master the app wrote: [{ lang, group, channels, codec }]. */
function hlsSound(master) {
  const lines = master.split('\n'), codec = {};
  lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF:')).forEach((l) => {
    const g = (l.match(/AUDIO="([^"]+)"/) || [])[1], c = ((l.match(/CODECS="([^"]+)"/) || [])[1] || '').split(',').find((x) => /^(mp4a|ac-3|ec-3)/.test(x.trim()));
    if (g && c) codec[g] = c.trim();
  });
  return lines.filter((l) => /^#EXT-X-MEDIA:TYPE=AUDIO/.test(l)).map((l) => {
    const group = (l.match(/GROUP-ID="([^"]+)"/) || [])[1];
    return { lang: (l.match(/LANGUAGE="([^"]+)"/) || [])[1], group, channels: +((l.match(/CHANNELS="(\d+)"/) || [])[1] || 2), codec: codec[group] };
  });
}
const hlsSubs = (master) => master.split('\n').filter((l) => /^#EXT-X-MEDIA:TYPE=SUBTITLES/.test(l)).map((l) => (l.match(/LANGUAGE="([^"]+)"/) || [])[1]);
const officialSound = (key) => F1.OFFERS[key].sets.filter((s) => /audio/.test(s.contentType)).map((s) => s.lang);
function combo() {
  const ctx = vm.createContext({ URL: Object.assign(function (u, b) { return new URL(u, b); }, { createObjectURL: () => 'blob:combo', revokeObjectURL() {} }),
    Blob: function () {}, btoa: (x) => Buffer.from(x, 'binary').toString('base64'), unescape, encodeURIComponent, setTimeout, clearTimeout,
    AbortController, Date, fetch: F1.serve() });
  vm.runInContext(fs.readFileSync(path.join(root, 'app/js/combo.js'), 'utf8'), ctx);
  return ctx.FeedCombo;
}
const subtitleLangs = (key) => F1.OFFERS[key].format === 'dash'
  ? F1.OFFERS[key].sets.filter((s) => /application|text/.test(s.contentType)).map((s) => s.lang)
  : F1.OFFERS[key].media.filter((m) => m.type === 'SUBTITLES').map((m) => m.language);
const surroundIn = (key) => F1.audioOf(key).filter((a) => a.channels > 2);
const stereoIn = (key) => F1.audioOf(key).filter((a) => a.channels <= 2);
const langs = (list) => [...new Set(list.map((x) => x.lang || x.language))].sort();
// The app's own map (hdr.js LANG3), so the test can't name a language the app misses.
const APP_LANG3 = vm.runInNewContext('(' + fs.readFileSync(path.join(root, 'app/js/hdr.js'), 'utf8').match(/var LANG3 = (\{[^}]*\})/)[1] + ')');
const lang3 = (l) => APP_LANG3[String(l || '').toLowerCase()] || l;

/**
 * What a DASH the app built plays: its 5.1 and stereo sound (with the channels each set names) and the subtitles it
 * hands the app (shown by the app: ttml/WebVTT), as one row's observations.
 */
function observeDash(out, row) {
  const sets = dashSound(out.mpd), mc = sets.filter((x) => /ac-3|ec-3/.test(x.codec)), st = sets.filter((x) => !/ac-3|ec-3/.test(x.codec));
  return { surround: out.surround, surroundCounted: mc.length, surroundLangs: langs(mc), stereo: langs(st),
    stereoFrom: row.official || row.source, channels: mc.map((x) => [x.lang, x.codec, x.channels]), stereoChannels: st.map((x) => x.channels),
    subtitles: Array.from(out.subtitles || [], (x) => x.lang || x.language) };
}

/*
 * The matrix: one row per kind of playback and sound feed. `run` builds it the app's way and returns what it plays:
 * { surround: count, stereo: [langs], surroundLangs: [langs], subtitles: [langs] | null (shown another way) }.
 * `source` is the offer whose sound it should carry (its 5.1 and stereo come from there).
 */
const ROWS = [
  { kind: 'single feed, encrypted 4K HDR (AVPlay, hdr.js build), F1 LIVE', source: 'lvq-2026/tvos-hdruhdcmaffp-pres', official: 'lvq-2026/web-sdrhddashwvsingle-pres',
    run: async (row) => {
      const out = await hdr().HdrStream.build({ url: F1.url(row.source, 'master.m3u8'), widevineManifestUrl: F1.url(row.official, 'index.mpd') }, { audio: 'eng', text: 'eng' });
      return observeDash(out, row);
    } },
  { kind: 'single feed, encrypted 4K HDR (AVPlay, hdr.js build), main feed', source: 'lvq-2026/tvos-hdruhdcmaffp-main', official: 'lvq-2026/androidtv-sdrhddashwvsingle-main',
    run: async (row) => {
      const out = await hdr().HdrStream.build({ url: F1.url(row.source, 'master.m3u8'), widevineManifestUrl: F1.url(row.official, 'index.mpd') }, { audio: 'eng', text: 'eng' });
      return observeDash(out, row);
    } },
  ...['pres', 'main', 'obc'].map((sound) => ({
    kind: 'clear HEVC multiview (hdr.js grid), sound ' + sound, source: 'lvrace-2026/tvos-hdruhdcmaf-' + sound,
    run: async (row) => {
      const keys = ['lvrace-2026/tvos-hdruhdcmaf-' + sound].concat(['main', 'pres', 'tracker', 'obc'].filter((x) => x !== sound).slice(0, 2).map((x) => 'lvrace-2026/tvos-hdruhdcmaf-' + x));
      const ctx = hdr();
      const out = await ctx.HdrStream.grid(keys.map((k) => ({ url: F1.url(k, 'master.m3u8'), hdr: true })), layout(ctx, keys), { id: 'g1', langs: { audio: 'eng', text: '' }, audio: 0 });
      return observeDash(out, row);
    } })),
  { kind: 'encrypted HEVC multiview (hdr.js grid), sound F1 LIVE', source: 'lvq-2026/tvos-hdruhdcmaffp-pres', official: 'lvq-2026/web-sdrhddashwvsingle-pres',
    run: async (row) => {
      const keys = [row.source, 'lvq-2026/tvos-hdruhdcmaffp-main'], ctx = hdr();
      const out = await ctx.HdrStream.grid(keys.map((k) => ({ url: F1.url(k, 'master.m3u8'), hdr: true, hdrEncrypted: true, widevineManifestUrl: F1.url(row.official, 'index.mpd') })),
        layout(ctx, keys), { id: 'g1', langs: { audio: 'eng', text: '' }, audio: 0 });
      return observeDash(out, row);
    } },
  ...[['1033', ['1033']], ['1003', ['1003', '1033']]].map(([lead, sound]) => ({
    kind: 'player_tm multiview (hdr.js tmGrid, Shaka), sound ' + (lead === '1033' ? 'F1 LIVE' : 'TRACKER (has none: F1 LIVE\'s)'),
    source: 'lvq-2026/tm-hdruhdhlsck-1033', hls: true,
    run: async () => {
      const keys = ['lvq-2026/tm-hdruhdhlsck-' + lead, 'lvq-2026/tm-hdruhdhlsck-main', 'lvq-2026/tm-hdruhdhlsck-1016'], posts = [], ctx = hdr(posts);
      await ctx.HdrStream.tmGrid(keys.map((k) => F1.url(k, 'master.m3u8')), layout(ctx, keys),
        { id: 'tm1', sound: sound.map((c) => F1.url('lvq-2026/tm-hdruhdhlsck-' + c, 'master.m3u8')), at: 0, keyHeaders: {} });
      const sound$ = hlsSound(posts[0].master);
      return { surround: sound$.filter((s) => s.channels > 2 && /ac-3|ec-3/.test(s.codec)).length, surroundLangs: langs(sound$.filter((s) => s.channels > 2)),
        stereo: langs(sound$.filter((s) => s.channels <= 2)), channels: sound$.filter((x) => x.channels > 2).map((x) => [x.lang, x.codec, x.channels]),
        stereoChannels: sound$.filter((x) => x.channels <= 2).map((x) => x.channels), subtitles: hlsSubs(posts[0].master) };
    } })),
  ...[['pres', 'F1 LIVE'], ['main', 'the main feed']].map(([feed, name]) => ({
    kind: 'combined master for instant feed switches (combo.js), ' + name, source: 'lvrace-2026/tvos-hdruhdcmaf-' + feed,
    run: async (row) => {
      const others = ['main', 'pres', 'tracker'].filter((x) => x !== feed);
      const feeds = [feed].concat(others).map((x, i) => ({ index: i, channel: x, url: F1.url('lvrace-2026/tvos-hdruhdcmaf-' + x, 'master.m3u8') }));
      const built = await combo().build(feeds, { range: 'HLG' });
      const mine = built.feeds.find((f) => f.channel === feed), groups = mine.groups;
      const sound$ = hlsSound(built.master).filter((x) => groups.some((g) => x.group === g));
      return { surround: sound$.filter((x) => x.channels > 2 && /ac-3|ec-3/.test(x.codec)).length, surroundLangs: langs(sound$.filter((x) => x.channels > 2)),
        stereo: langs(sound$.filter((x) => x.channels <= 2)), channels: sound$.filter((x) => x.channels > 2).map((x) => [x.lang, x.codec, x.channels]),
        stereoChannels: sound$.filter((x) => x.channels <= 2).map((x) => x.channels), comboSurround: !!mine.surround,
        subtitles: hlsSubs(built.master.split('\n').filter((l) => !/TYPE=SUBTITLES/.test(l) || new RegExp('GROUP-ID="s' + mine.k + '-').test(l)).join('\n')) };
    } }))
];

// Where F1 sends no 5.1 at all: these rows hold while that stays true (if F1 adds it, the path needs the work).
const NO_SURROUND_AT_F1 = {
  'H.264 multiview and 2018-2024 replays (HLS TS)': ['abudhabi-2021/web-hls-main', 'lasvegas-2024/web-hls-main', 'lasvegas-2024/web-hls-obc', 'bahrain-2020/web-hls-main'],
  'SDR offers (web, android_tv, chromecast; HDR off or no HDR TV)': ['abudhabi-2025/web-sdrhdcmaf-main', 'f1a-feature-2026/web-sdrhdcmaf-main', 'postq-show-2026/web-sdrhdcmaf-main',
    'lvq-2026/androidtv-sdrhddashwvsingle-main', 'lvq-2026/chromecast-sdrhddashwvsinglecenc-main', 'lvq-2026/web-sdrhddashwvsingle-pres'],
  'highlights, press conferences (DASH)': ['highlights-2026/web-dash-main', 'presser-2026/web-dash-main']
};

// Kinds without a row here, each with why and the tests that cover them instead (checked to exist).
const ELSEWHERE = {
  'live 4K HDR single feed (hdr.js live)': ['no live capture in the fixture (live DASH and its segment timeline): hdr.test.js',
    ['live HDR 5.1: AC-3 sets after the video, on the audio clock, the HDR key and through the helper', 'live HDR 5.1 is optional']],
  'live HEVC multiview (hdr.js liveGrid)': ['no live capture in the fixture: hdr.test.js',
    ['AC-3 after the grid, on the official audio clock', 'live multiview 5.1 is optional']],
  'live player_tm single feed and player_tm multiview live': ['F1\'s live player_tm playlists (no ENDLIST): tm-grid.test.js', []],
  'H.264 multiview\'s small feeds (mvsoft, our decoder)': ['no sound of their own: the big feed plays its master on AVPlay', []],
  'SDR HEVC multiview (web offers: HDR off, Pro, a TV without HDR)': ['the library\'s web SDR copies kept only their H.264 variants (no HEVC structure to ' +
    'build from); F1\'s SDR offers are stereo (rows below); the multiview itself: app-flow.test.js', ['a multiview from clear SDR offers']]
};

// Known gaps: kinds that don't carry 5.1 the source has, with why and what would close them. Keep this list short.
const KNOWN_GAPS = {};

// What F1 sends, written down apart from the fixture (checked on F1's offers, Nov 2026): 5.1 is AC-3, 6 channels, in
// F1's UHD packages only, on the F1 LIVE feed of sessions (English and Spanish) and on F1's own shows (English); the main
// feed (INTERNATIONAL) and onboards are stereo. Every row's source is listed, so a fixture extracted wrong (or a row whose
// source happens to have no 5.1) can't pass unnoticed.
const F1_SURROUND = {
  'lvq-2026/tvos-hdruhdcmaffp-pres': ['eng', 'spa'], 'lvrace-2026/tvos-hdruhdcmaf-pres': ['eng', 'spa'], 'lvq-2026/tm-hdruhdhlsck-1033': ['eng', 'spa'],
  'postq-show-2026/tvos-hdruhdcmaf-main': ['eng'],
  'lvq-2026/tvos-hdruhdcmaffp-main': [], 'lvrace-2026/tvos-hdruhdcmaf-main': [], 'lvrace-2026/tvos-hdruhdcmaf-obc': []
};
test('matrix: the fixture has the 5.1 F1 sends, and the rows cover both kinds of source', () => {
  const sources = ROWS.map((r) => r.source).concat(Object.values(SHAKA_SINGLE));
  for (const key of sources) {
    assert.ok(key in F1_SURROUND, key + ': say what F1 sends there');
    assert.deepEqual(surroundIn(key).map((a) => a.language).sort(), F1_SURROUND[key], key);
    assert.ok(surroundIn(key).every((a) => a.codec === 'ac-3' && a.channels === 6), key);
  }
  for (const kind of ['clear HEVC multiview', 'encrypted', 'player_tm multiview', 'combined master']) {
    assert.ok(ROWS.some((r) => r.kind.includes(kind) && F1_SURROUND[r.source].length), kind + ': a row whose source has 5.1');
  }
});

for (const row of ROWS) {
  test('matrix: ' + row.kind, async () => {
    const got = await row.run(row);
    if (process.env.MATRIX_DEBUG) console.log('GOT', row.kind, JSON.stringify(got), 'want subs', JSON.stringify(subtitleLangs(row.official || row.source)));
    const want51 = surroundIn(row.source);
    assert.equal(got.surround, want51.length, 'the 5.1 commentaries the source has (' + langs(want51).join(', ') + ')');
    if (got.surroundCounted !== undefined) assert.equal(got.surroundCounted, want51.length, 'as many 5.1 sets in the manifest as it reports');
    assert.deepEqual(got.surroundLangs.map(lang3).sort(), langs(want51).map(lang3).sort());
    // its stereo: the sound feed's own (clear) or the official offer's (encrypted: F1's Widevine commentary)
    const wantStereo = F1.OFFERS[got.stereoFrom || row.source].format === 'dash' ? officialSound(got.stereoFrom) : langs(stereoIn(row.source));
    assert.deepEqual([...new Set(got.stereo.map(lang3))].sort(), [...new Set(wantStereo.map(lang3))].sort(), 'its stereo commentaries');
    // channels as the source says: 5.1 sets as many as F1's rendition, stereo 2 (where the output names them)
    for (const [lang, codec, channels] of got.channels || []) {
      const src = want51.find((a) => lang3(a.language) === lang3(lang)) || {};
      assert.ok(/ac-3|ec-3/.test(codec) && channels === src.channels, lang + ' ' + codec + ' ' + channels + ' channels, F1: ' + src.channels);
    }
    for (const ch of got.stereoChannels || []) assert.ok(ch === 0 || ch === 2, 'stereo named ' + ch);
    if (got.comboSurround !== undefined) assert.equal(got.comboSurround, want51.length > 0, 'the combined master marks its Dolby Digital');
    // subtitles: the sound feed's (clear, player_tm) or the official offer's (encrypted)
    assert.deepEqual([...new Set(Array.from(got.subtitles, lang3))].sort(), [...new Set(subtitleLangs(row.official || row.source))].map(lang3).sort(), 'its subtitles');
  });
}

// Single feeds on Shaka (clear 4K HDR, player_tm, F1's shows): Shaka reads F1's master itself, so this runs player.js's
// own load and sound choice for each commentary the offer has, against Shaka's tracks as that master gives them (Shaka's
// selectAudioLanguage as in 4.12: the language's variants, of the asked channel count where it has them). Subtitles
// come straight from F1's master there (nothing of the app's in between).
const SHAKA_SINGLE = { 'clear 4K HDR, F1 LIVE': 'lvrace-2026/tvos-hdruhdcmaf-pres', 'clear 4K HDR, F1\'s show': 'postq-show-2026/tvos-hdruhdcmaf-main',
  'player_tm, F1 LIVE': 'lvq-2026/tm-hdruhdhlsck-1033' };
const LANG2 = Object.fromEntries(Object.entries(APP_LANG3).map(([two, three]) => [three, two]));   // (Shaka reports two letters)
function shakaTracks(key) {
  const audio = F1.audioOf(key);
  return F1.OFFERS[key].variants.filter((v) => v.range === 'HLG').flatMap((v, n) => audio.filter((a) => a.group === v.audio).map((a, i) => ({
    id: n * 10 + i, language: LANG2[a.language] || a.language, channelsCount: a.channels, audioCodec: a.codec, bandwidth: v.bandwidth,
    height: +v.resolution.split('x')[1], active: false })));
}
for (const [name, key] of Object.entries(SHAKA_SINGLE)) {
  test('matrix: single feed on Shaka (' + name + '): each commentary plays in 5.1 where the offer has it', async () => {
    const want51 = surroundIn(key);
    assert.ok(want51.length > 0, key + ' has 5.1');
    for (const lang of langs(F1.audioOf(key))) {
      const P = await Harness.player(Harness.fakeAvPlay(), { 'f1tv.settings': JSON.stringify({ audio: lang }) }, () => Promise.resolve());
      const variants = shakaTracks(key), ctx = P.context;
      ctx.variants = variants;
      ctx.audioLanguages = [...new Set(variants.map((t) => t.language))];
      ctx.shaka.Player.prototype.selectAudioLanguage = function (l, role, count) {
        let pool = variants.filter((t) => lang3(t.language) === lang3(l));
        if (count && pool.some((t) => t.channelsCount === count)) pool = pool.filter((t) => t.channelsCount === count);
        const pick = pool.sort((a, b) => b.bandwidth - a.bandwidth)[0];
        variants.forEach((t) => { t.active = t === pick; });
      };
      P.videos.forEach((v) => { v.play = () => Promise.resolve(); v.paused = false; });
      await P.load({ url: F1.url(key, 'master.m3u8'), hdr: true, multiFeed: false, info: { dynamic: false } }, null);
      assert.equal(P.engineName(), 'shaka', key);
      const playing = variants.find((t) => t.active);
      assert.ok(playing && lang3(playing.language) === lang, key + ': plays ' + lang + ' (' + JSON.stringify(playing) + ')');
      const has51 = want51.find((a) => a.language === lang);
      assert.equal(playing.channelsCount, has51 ? has51.channels : 2, key + ' ' + lang + ': channels');
      if (has51) assert.match(playing.audioCodec, /^(ac-3|ec-3)/, key + ' ' + lang);
      assert.equal(P.configs.find((c) => c && c.preferredAudioChannelCount).preferredAudioChannelCount, 6, 'Shaka prefers 6 channels');
    }
  });
}

for (const [kind, keys] of Object.entries(NO_SURROUND_AT_F1)) {
  test('matrix: ' + kind + ': F1 sends no 5.1 (if it starts to, this path needs it)', () => {
    for (const key of keys) assert.deepEqual(surroundIn(key), [], key);
  });
}

test('matrix: kinds covered elsewhere say where, and those tests exist', () => {
  for (const [kind, [why, names]] of Object.entries(ELSEWHERE)) {
    assert.ok(why.length > 20, kind);
    const file = (why.match(/([a-z-]+\.test\.js)/) || [])[1];
    if (file) assert.ok(fs.existsSync(path.join(__dirname, file)), kind + ': ' + file);
    for (const name of names) assert.ok(fs.readFileSync(path.join(__dirname, file), 'utf8').includes(name), kind + ': ' + name);
  }
});

test('matrix: known gaps are named, with why', () => {
  for (const [kind, why] of Object.entries(KNOWN_GAPS)) assert.ok(why.length > 40, kind);
});
