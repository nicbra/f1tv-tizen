const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

/**
 * Loads api.js with a fetch that answers from `route(url, init)`, which returns
 * { status, body } (objects are sent as JSON). Every request is recorded.
 */
function api(route) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init: init || {} });
    const r = (route && route(url, init || {})) || { status: 404, body: { message: 'not found' } };
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => text };
  };
  const context = vm.createContext({ fetch, URL, encodeURIComponent, Date });
  vm.runInContext(readFileSync('app/js/api.js', 'utf8'), context);
  return { F1Api: context.F1Api, calls };
}

// The vm has its own Object/Array prototypes; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('http returns parsed JSON and an empty body as null', async () => {
  const { F1Api } = api((url) => url.endsWith('/a') ? { body: { x: 1 } } : { body: '' });
  assert.deepEqual(plain(await F1Api.http('https://f1tv.formula1.com/a')), { x: 1 });
  assert.equal(await F1Api.http('https://f1tv.formula1.com/b'), null);
});

test('http turns error answers into errors with the API message and status', async () => {
  const { F1Api } = api(() => ({ status: 403, body: { resultObj: { message: 'Not entitled' } } }));
  await assert.rejects(F1Api.http('https://f1tv.formula1.com/x'), (e) => e.message === 'Not entitled' && e.status === 403);
  const { F1Api: other } = api(() => ({ status: 502, body: '<html>bad gateway</html>' }));
  await assert.rejects(other.http('https://f1tv.formula1.com/x'), /HTTP 502/);
});

test('refreshConfig takes the API versions from the config, ignoring malformed ones', async () => {
  const { F1Api } = api(() => ({ body: { apiConfig: { playAPIVersion: '3.1', videoAPIVersion: '4/../evil' } } }));
  await F1Api.refreshConfig();
  assert.equal(F1Api.state.playApi, '3.1');
  assert.equal(F1Api.state.videoApi, '4.0');
});

test('login fetches the entitlement and location with the subscription token', async () => {
  const { F1Api, calls } = api((url) => {
    if (url.includes('/USER/ENTITLEMENT')) return { body: { resultObj: { entitlementToken: 'ENT' } } };
    if (url.includes('/USER/LOCATION')) return { body: { resultObj: { userLocation: [{ entitlement: 'PRO', groupId: 7 }] } } };
  });
  await F1Api.login('ASC');
  assert.equal(F1Api.state.ascendon, 'ASC');
  assert.equal(F1Api.state.entitlement, 'ENT');
  assert.equal(F1Api.state.location.groupId, 7);
  assert.equal(calls[0].init.headers.ascendontoken, 'ASC');
  assert.match(calls[1].url, /\/1\.0\/R\/ENG\/WEB_DASH\/ALL\/USER\/LOCATION$/);
  assert.equal(calls[1].init.headers.entitlementtoken, 'ENT');
});

test('pages use the location entitlement and group, and anonymous access before sign-in', async () => {
  const { F1Api, calls } = api(() => ({ body: { resultObj: { containers: [{ id: 1 }] } } }));
  assert.equal((await F1Api.page(395)).length, 1);
  assert.match(calls[0].url, /\/2\.0\/A\/ENG\/WEB_DASH\/ALL\/PAGE\/395\/F1_TV_Pro_Annual\/2$/);
  F1Api.state.ascendon = 'ASC';
  F1Api.state.location = { entitlement: 'PRO', groupId: 0 };
  await F1Api.page(493);
  assert.match(calls[1].url, /\/2\.0\/R\/ENG\/WEB_DASH\/ALL\/PAGE\/493\/PRO\/0$/);
  assert.equal(calls[1].init.headers.ascendontoken, 'ASC');
});

test('pageByUri accepts both API paths and full URLs', async () => {
  const { F1Api, calls } = api(() => ({ body: { resultObj: {} } }));
  assert.deepEqual(plain(await F1Api.pageByUri('/2.0/R/ENG/WEB_DASH/ALL/PAGE/1/x/2')), []);
  await F1Api.pageByUri('https://f1tv.formula1.com/2.0/R/ENG/WEB_DASH/ALL/PAGE/2/x/2');
  assert.equal(calls[0].url, 'https://f1tv.formula1.com/2.0/R/ENG/WEB_DASH/ALL/PAGE/1/x/2');
  assert.equal(calls[1].url, 'https://f1tv.formula1.com/2.0/R/ENG/WEB_DASH/ALL/PAGE/2/x/2');
});

test('video rejects when the content is not found', async () => {
  const { F1Api } = api(() => ({ body: { resultObj: { containers: [] } } }));
  await assert.rejects(F1Api.video(123), /Video not found/);
});

test('play tries the TV platform first and falls back to the web platform', async () => {
  const { F1Api, calls } = api((url) => url.includes('/BIG_SCREEN_DASH/')
    ? { status: 400, body: { message: 'Platform not allowed' } }
    : { body: { resultObj: { url: 'https://cdn/x.mpd', streamType: 'DASHWV', laURL: 'https://lic/wv' } } });
  F1Api.state.ascendon = 'ASC';
  F1Api.state.entitlement = 'ENT';
  const s = await F1Api.play('1000010403', 'ch1');
  assert.equal(s.url, 'https://cdn/x.mpd');
  assert.equal(s.platform, 'WEB_DASH');
  assert.equal(s.licenseUrl, 'https://lic/wv');
  assert.match(calls[0].url, /\/3\.0\/R\/ENG\/BIG_SCREEN_DASH\/ALL\/CONTENT\/PLAY\?contentId=1000010403&player=player_bm&channelId=ch1$/);
  assert.match(calls[0].init.headers['x-f1-device-info'], /os=tizen/);
});

test('play builds the license URL when the answer has none, and passes the DRM token', async () => {
  const { F1Api } = api(() => ({ body: { resultObj: { url: 'https://cdn/x.mpd', streamType: 'SDR_HD_DASHWV', entitlementToken: 'STREAM_ENT', drmToken: 'DRM' } } }));
  F1Api.state.ascendon = 'ASC';
  F1Api.state.entitlement = 'ENT';
  const s = await F1Api.play('42');
  assert.equal(s.licenseUrl, 'https://f1tv.formula1.com/2.0/R/ENG/BIG_SCREEN_DASH/ALL/CONTENT/LA/widevine?contentId=42');
  assert.equal(s.licenseHeaders.entitlementtoken, 'STREAM_ENT');
  assert.equal(s.licenseHeaders.customdata, 'DRM');
  assert.equal(s.licenseHeaders.ascendontoken, 'ASC');
});

test('play leaves clear streams without a license URL and reports the first error when all fail', async () => {
  const { F1Api } = api(() => ({ body: { resultObj: { url: 'https://cdn/x.m3u8', streamType: 'HLS' } } }));
  assert.equal((await F1Api.play('1')).licenseUrl, '');
  const { F1Api: failing } = api((url) => ({ status: 403, body: { message: url.includes('BIG_SCREEN') ? 'first' : 'second' } }));
  await assert.rejects(failing.play('1'), /first/);
});

test('menu collects every entry that links to a page, however deeply nested', async () => {
  const { F1Api } = api(() => ({ body: { resultObj: { containers: [
    { metadata: { label: 'Home' }, actions: [{ uri: '/2.0/A/ENG/WEB_DASH/ALL/PAGE/395/x/2' }] },
    { items: [{ metadata: { title: '2026 Season' }, actions: [{ uri: '/2.0/A/ENG/WEB_DASH/ALL/PAGE/9000/x/2' }] },
      { metadata: { label: 'Search' }, actions: [{ uri: '/search' }] }] }
  ] } } }));
  assert.deepEqual(plain(await F1Api.menu()), [
    { title: 'Home', uri: '/2.0/A/ENG/WEB_DASH/ALL/PAGE/395/x/2' },
    { title: '2026 Season', uri: '/2.0/A/ENG/WEB_DASH/ALL/PAGE/9000/x/2' }
  ]);
});

const event = (id, title, start, extra) => ({ id, metadata: Object.assign({ contentId: id, titleBrief: title, contentSubtype: 'REPLAY',
  emfAttributes: { Series: 'FORMULA 1', sessionStartDate: String(start), Meeting_Name: 'United States Grand Prix', MeetingKey: '1300' } }, extra) });

test('scheduleFrom reads the weekend schedule from the ALL group, sorted by start time', () => {
  const { F1Api } = api();
  const containers = [{ layout: 'hero' }, { layout: 'interactive_schedule', retrieveItems: { resultObj: { containers: [
    { eventName: 'F1', events: [event(9, 'Wrong group', 1)] },
    { eventName: 'ALL', events: [event(2, 'Qualifying', 2000, { contentSubtype: 'LIVE_EVENT', externalId: 'FOM_SESSION_11392' }), event(1, 'Practice 3', 1000, { contentSubtype: 'LIVE' }), { id: 3, metadata: { title: 'No time' } }] }
  ] } } }];
  const s = F1Api.scheduleFrom(containers);
  assert.equal(s.meeting, 'United States Grand Prix');
  assert.deepEqual(plain(s.events.map((e) => [e.contentId, e.title, e.start, e.subtype, e.series])), [
    [1, 'Practice 3', 1000, 'LIVE', 'FORMULA 1'], [2, 'Qualifying', 2000, 'LIVE_EVENT', 'FORMULA 1']]);
  assert.equal(s.events[1].houseId, 'FOM_SESSION_11392'); // links the parts of a pre-show / session / post-show
});

test('scheduleFrom returns null for pages without a schedule', () => {
  const { F1Api } = api();
  assert.equal(F1Api.scheduleFrom([{ layout: 'hero' }]), null);
  assert.equal(F1Api.scheduleFrom(null), null);
});

const meeting = (key, name, start, extra) => ({ metadata: { title: name, emfAttributes: Object.assign({ MeetingKey: key, Meeting_Name: name,
  Meeting_Country_Name: 'Country ' + key, Championship_Meeting_Ordinal: key, Meeting_Start_Date: start }, extra) },
  actions: [{ uri: '/2.0/A/ENG/WEB_DASH/ALL/PAGE/' + key + '/x/2' }] });

test('seasonFrom lists each meeting once, in calendar order, with round and dates', () => {
  const { F1Api } = api();
  const list = (items) => ({ retrieveItems: { resultObj: { containers: items } } });
  const season = F1Api.seasonFrom([
    list([meeting('18', 'United States Grand Prix', '2026-10-23T00:00:00Z'), meeting('17', 'Singapore Grand Prix', '2026-10-09T00:00:00Z')]),
    list([meeting('18', 'United States Grand Prix', '2026-10-23T00:00:00Z'), { metadata: { emfAttributes: { MeetingKey: '99' } }, actions: [{ uri: '/video/1' }] }])
  ]);
  assert.deepEqual(plain(season.map((m) => [m.key, m.round, m.country])), [['17', '17', 'Country 17'], ['18', '18', 'Country 18']]);
  assert.equal(season[0].start, Date.parse('2026-10-09T00:00:00Z'));
});

test('seasonFrom marks testing events', () => {
  const { F1Api } = api();
  const items = [meeting('1', 'Pre-Season Testing', '2026-02-11', { IsTestEvent: 'True' }), meeting('2', 'Australian Grand Prix', '2026-03-06')];
  const season = F1Api.seasonFrom([{ retrieveItems: { resultObj: { containers: items } } }]);
  assert.deepEqual(plain(season.map((m) => m.test)), [true, false]);
});

const LIVE_MPD = `<MPD type="dynamic" availabilityStartTime="2024-01-01T00:00:00Z" suggestedPresentationDelay="PT25S">
<Period start="PT0S"><AdaptationSet><SegmentTemplate timescale="50000" presentationTimeOffset="0">
<SegmentTimeline><S t="4439700000000" d="288000" r="9"/></SegmentTimeline></SegmentTemplate></AdaptationSet></Period></MPD>`;

test('streamInfo reads a live DASH manifest: its window, delay and Unix time base', async () => {
  const { F1Api } = api(() => ({ body: LIVE_MPD }));
  const info = await F1Api.streamInfo('https://cdn/live/index.mpd?start=1');
  assert.equal(info.dynamic, true);
  assert.equal(info.windowStart, 88794000);
  assert.ok(Math.abs(info.windowEnd - 88794057.6) < 1e-6);
  assert.equal(info.segDur, 5.76);
  assert.equal(info.epochAtZero, Date.parse('2024-01-01T00:00:00Z') / 1000);
  assert.equal(info.delay, 25);
});

test('streamInfo maps a replay DASH manifest to real clock time through its presentation offset', async () => {
  const vod = `<MPD type="static"><Period start="PT0S"><AdaptationSet><SegmentTemplate timescale="1000" presentationTimeOffset="1792000000000" duration="30000">
<SegmentTimeline><S t="1792000000000" d="30000" r="3"/></SegmentTimeline></SegmentTemplate></AdaptationSet></Period></MPD>`;
  const { F1Api } = api(() => ({ body: vod }));
  const info = await F1Api.streamInfo('https://cdn/vod/index.mpd');
  assert.equal(info.dynamic, false);
  assert.equal(info.windowStart, 0);
  assert.equal(info.windowEnd, 120);
  assert.equal(info.epochAtZero, 1792000000);
  assert.equal(info.segDur, 30);
});

test('streamInfo follows an HLS master playlist and maps positions to program date-times', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n';
  const media = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-PROGRAM-DATE-TIME:2026-10-11T11:55:00.000Z', '#EXTINF:6.0,', 'a.mp4',
    '#EXTINF:6.0,', 'b.mp4', '#EXT-X-PROGRAM-DATE-TIME:2026-10-11T11:55:30.000Z', '#EXTINF:5.5,', 'c.mp4', '#EXT-X-ENDLIST'].join('\n');
  const { F1Api, calls } = api((url) => ({ body: url.endsWith('/low/index.m3u8') ? media : master }));
  const info = await F1Api.streamInfo('https://cdn/race/index.m3u8');
  assert.equal(calls[1].url, 'https://cdn/race/low/index.m3u8');
  assert.equal(info.dynamic, false);
  assert.equal(info.windowEnd, 17.5);
  const t0 = Date.parse('2026-10-11T11:55:00Z') / 1000;
  assert.deepEqual(plain(info.marks), [{ pos: 0, wall: t0 }, { pos: 12, wall: t0 + 30 }]);
  assert.equal(info.epochAtZero, t0);
});

test('streamInfo treats an HLS playlist without an end as live', async () => {
  const { F1Api } = api(() => ({ body: '#EXTM3U\n#EXTINF:6.0,\na.ts\n' }));
  assert.equal((await F1Api.streamInfo('https://cdn/live.m3u8')).dynamic, true);
});

test('resumePosition reads the saved position and falls back to 0', async () => {
  const { F1Api, calls } = api(() => ({ body: { resultObj: { 42: { user: { resume: { playHeadPosition: 2723 } } } } } }));
  assert.equal(await F1Api.resumePosition('42', 8202), 0); // not signed in
  F1Api.state.entitlement = 'ENT';
  assert.equal(await F1Api.resumePosition('42', 8202), 2723);
  assert.deepEqual(JSON.parse(calls[0].init.body), { 42: { duration: 8202 } });
  const { F1Api: failing } = api(() => ({ status: 500, body: {} }));
  failing.state.entitlement = 'ENT';
  assert.equal(await failing.resumePosition('42', 1), 0);
});

test('savePosition posts whole seconds and never throws', async () => {
  const { F1Api, calls } = api(() => ({ status: 500, body: {} }));
  await F1Api.savePosition('42', 10); // not signed in: no request
  assert.equal(calls.length, 0);
  F1Api.state.ascendon = 'ASC';
  F1Api.state.entitlement = 'ENT';
  await F1Api.savePosition('42', 2722.6, 'REPLAY');
  assert.deepEqual(JSON.parse(calls[0].init.body), { contentId: 42, playHeadPosition: 2723, contentSubType: 'REPLAY' });
});

test('isNotStarted recognises the play API answers for sessions that have not begun', () => {
  const { F1Api } = api();
  assert.equal(F1Api.isNotStarted(new Error('Content is pre-live')), true);
  assert.equal(F1Api.isNotStarted(new Error('Prelive content')), true);
  assert.equal(F1Api.isNotStarted(new Error('Content unavailable')), true);
  assert.equal(F1Api.isNotStarted(new Error('Not entitled')), false);
  assert.equal(F1Api.isNotStarted(null), false);
});

test('imageUrl sizes F1 image ids through the image resizer and keeps full URLs', () => {
  const { F1Api } = api();
  assert.equal(F1Api.imageUrl('1000010403_abc', 384, 216), 'https://f1tv.formula1.com/image-resizer/image/1000010403_abc?w=384&h=216&q=HI&o=L');
  assert.equal(F1Api.imageUrl('https://media.formula1.com/x.png', 1, 1), 'https://media.formula1.com/x.png');
  assert.equal(F1Api.imageUrl('', 1, 1), '');
});
