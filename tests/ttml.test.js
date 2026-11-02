const assert = require('node:assert/strict');
const { test } = require('node:test');
const Ttml = require('../app/js/ttml.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// As F1's stpp segments (Mexico 2026): media-timeline clock times ~498162 h, and every cue that
// overlaps the next segment repeated there.
const doc = (ps) => '<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ' +
  'ttp:timeBase="media" xml:lang="en" ttp:cellResolution="50 30"><body><div>' + ps.join('') + '</div></body></tt>';
const p = (begin, end, text) => `<p begin="${begin}" end="${end}" region="r1"><span style="s1">${text}</span></p>`;
const segment = (xml) => Uint8Array.from(Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('moof'), Buffer.alloc(8, 0xff),
  Buffer.from([0, 0, 0, 0]), Buffer.from('mdat'), Buffer.from(xml, 'utf8')])).buffer;

test('TTML time expressions', () => {
  assert.equal(Ttml.seconds('498162:26:28.510', 30, 1), 498162 * 3600 + 26 * 60 + 28.51);
  assert.equal(Ttml.seconds('00:00:01:15', 30, 1), 1.5);
  assert.equal(Ttml.seconds('2.5s', 30, 1), 2.5);
  assert.equal(Ttml.seconds('1500ms', 30, 1), 1.5);
  assert.equal(Ttml.seconds('2m', 30, 1), 120);
  assert.equal(Ttml.seconds('90000t', 30, 90000), 1);
  assert.equal(Ttml.seconds('soon', 30, 1), null);
  assert.equal(Ttml.seconds(null, 30, 1), null);
});

test('cues keep line breaks, drop markup and decode entities', () => {
  const cues = Ttml.cues(doc([
    p('498162:26:28.510', '498162:26:30.030', '2.6 miles.'),
    '<p begin="498162:26:30.270" dur="1.24s">Max &amp; <span>Lando</span><br/>&#233;l&#xE8;ve</p>',
    '<p begin="498162:26:31.000">no end</p>',
    p('498162:26:32.000', '498162:26:33.000', '  ')
  ]));
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '2.6 miles.');
  assert.ok(Math.abs(cues[0].end - cues[0].begin - 1.52) < 1e-6);
  assert.equal(cues[1].text, 'Max & Lando\nélève');
  assert.ok(Math.abs(cues[1].end - cues[1].begin - 1.24) < 1e-6);
});

test('the documents are found between the binary boxes of a segment', () => {
  const xml = doc([p('00:00:01.000', '00:00:02.000', 'Hola, ¿qué tal?')]);
  const found = Ttml.documents(segment(xml));
  assert.equal(found.length, 1);
  assert.equal(Ttml.cues(found[0])[0].text, 'Hola, ¿qué tal?');
});

test('segment lookup on a SegmentTimeline and from a fixed duration', () => {
  const track = { timescale: 50000, startNumber: 311351363, runs: [{ t: 89669192256000, d: 288000, r: 1061 }] };
  const start = 89669192256000 / 50000;
  const s = Ttml.segmentAt(track, start + 949.8);
  assert.equal(s.number, 311351363 + 164);
  assert.equal(s.time, 89669192256000 + 164 * 288000);
  assert.ok(Math.abs(s.start - (start + 164 * 5.76)) < 1e-6);
  assert.equal(Ttml.segmentAt(track, start - 1), null);
  assert.equal(Ttml.segmentAt(track, start + 1062 * 5.76 + 1), null);
  // Several runs, the second without t.
  const runs = { timescale: 10, startNumber: 1, runs: [{ t: 100, d: 20, r: 1 }, { t: null, d: 30, r: 0 }] };
  assert.deepEqual([12, 15, 16.5, 17].map((m) => (Ttml.segmentAt(runs, m) || {}).number), [2, 3, 3, undefined]);
  const fixed = { timescale: 1000, startNumber: 5, duration: 2000, offset: 10000 };
  assert.equal(Ttml.segmentAt(fixed, 13.5).number, 6);
});

test('segment addresses fill in the template', () => {
  const track = { base: 'https://cdn/v2/path/', id: '_SUBS_1', bandwidth: '256', media: 'segment_$RepresentationID$_$Number$.mp4' };
  assert.equal(Ttml.url(track, { number: 311351527, time: 0 }), 'https://cdn/v2/path/segment__SUBS_1_311351527.mp4');
  assert.equal(Ttml.url(Object.assign({}, track, { media: 'sub/$Time$_$Number%05d$.m4s?x=1' }), { number: 7, time: 900 }),
    'https://cdn/v2/path/sub/900_00007.m4s?x=1');
});

/** A reader over two languages, with a settable position and fetches answered from `files`. */
function harness(files, lang = 'eng') {
  const shown = [], fetched = [];
  const state = { position: 0 };
  const track = (l, id) => ({ lang: l, base: 'https://cdn/subs/', id, media: '$RepresentationID$_$Number$.mp4',
    timescale: 1000, offset: 1793383845120, startNumber: 1, runs: [{ t: 1793383845120, d: 5760, r: 99 }] });
  const reader = Ttml.reader([track('eng', 'en'), track('spa', 'es')], {
    position: () => state.position,
    show: (s) => shown.push(s),
    same: (a, b) => ({ en: 'eng', es: 'spa' }[a] || a) === ({ en: 'eng', es: 'spa' }[b] || b),
    fetch: async (url) => {
      fetched.push(url);
      const name = url.slice('https://cdn/subs/'.length);
      return name in files ? { ok: true, arrayBuffer: async () => segment(files[name]) } : { ok: false, status: 404 };
    }
  });
  if (lang) reader.select(lang);
  return { reader, shown, fetched, state, texts: () => shown.filter((s) => s && s.text).map((s) => s.text) };
}

// Clock times of the media timeline: segment 1 starts at 498162:10:45.120 (1793383845.12 s).
const at = (s) => { const t = 1793383845.12 + s, h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60); return `${h}:${String(m).padStart(2, '0')}:${(t % 60).toFixed(3).padStart(6, '0')}`; };

test('the reader shows each cue at its time once, though F1 repeats it in the next segment', async () => {
  const one = p(at(1), at(3), 'First'), two = p(at(5), at(7.5), 'Across the boundary');
  const h = harness({ 'en_1.mp4': doc([one, two]), 'en_2.mp4': doc([two, p(at(8), at(9), 'Third')]) });
  h.state.position = 0.5;
  await wait(20);
  assert.deepEqual(h.fetched, ['https://cdn/subs/en_1.mp4', 'https://cdn/subs/en_2.mp4']);
  assert.deepEqual(h.texts(), []);
  for (const [pos, expect] of [[1.2, 'First'], [3.5, null], [5.5, 'Across the boundary'], [6.2, 'Across the boundary'], [8.1, 'Third']]) {
    h.state.position = pos;
    await wait(230);
    const last = h.shown.at(-1);
    assert.equal(last.text || null, expect, 'at ' + pos);
  }
  // Each line was put up once (a re-show of the same line only refreshes the box each second).
  assert.deepEqual([...new Set(h.texts())], ['First', 'Across the boundary', 'Third']);
  assert.ok(h.shown.filter((s) => s && s.text === 'Across the boundary').length <= 2);
  assert.ok(h.shown.find((s) => s && s.text === 'First').ms <= 1800);
  h.reader.stop();
});

test('overlapping cues show together, in order, and a language switch or off is immediate', async () => {
  const h = harness({ 'en_1.mp4': doc([p(at(1), at(4), 'Top'), p(at(2), at(4), 'Bottom')]), 'es_1.mp4': doc([p(at(1), at(4), 'Arriba')]) });
  h.state.position = 2.5;
  await wait(30);
  assert.equal(h.shown.at(-1).text, 'Top\nBottom');
  h.reader.select('es');
  await wait(30);
  assert.equal(h.shown.at(-1).text, 'Arriba');
  h.reader.select(null);
  assert.equal(h.shown.at(-1), null);
  const n = h.shown.length;
  await wait(250);
  assert.equal(h.shown.length, n, 'nothing more once off');
  h.reader.select('fra');   // not offered: off
  assert.equal(h.shown.at(-1), null);
  assert.deepEqual(h.reader.langs(), ['eng', 'spa']);
  h.reader.stop();
});

test('a seek loads the segments there, and a failed segment is retried later, not every tick', async () => {
  const h = harness({ 'en_50.mp4': doc([p(at(49 * 5.76 + 1), at(49 * 5.76 + 3), 'Later on')]) });
  h.state.position = 49 * 5.76 + 2;
  await wait(250);
  assert.equal(h.shown.at(-1).text, 'Later on');
  const failures = h.fetched.filter((u) => u.endsWith('en_51.mp4')).length;
  assert.equal(failures, 1);
  await wait(450);
  assert.equal(h.fetched.filter((u) => u.endsWith('en_51.mp4')).length, 1, 'no retry within a few seconds');
  h.reader.stop();
  const n = h.fetched.length;
  await wait(250);
  assert.equal(h.fetched.length, n, 'stopped');
});

test('cues timed from the segment start are moved onto the media timeline', async () => {
  const h = harness({ 'en_3.mp4': doc([p('00:00:01.000', '00:00:02.000', 'Relative')]) });
  h.state.position = 2 * 5.76 + 1.5;
  await wait(250);
  assert.equal(h.shown.at(-1).text, 'Relative');
  h.reader.stop();
});

// As F1's WebVTT (Elemental, Mexico 2026 race): cue times from the stream's start, cues numbered.
const vtt = (cues, map = 'LOCAL:00:00:00.000,MPEGTS:0') => 'WEBVTT\t#Elemental Media Engine(TM) 2.1.3.0\nX-TIMESTAMP-MAP=' + map + '\n\n' +
  cues.map(([n, b, e, t]) => n + '\n' + b + ' --> ' + e + '\n' + t + '\n').join('\n');

test('WebVTT cues: times with or without hours, markup and entities, and X-TIMESTAMP-MAP', () => {
  assert.deepEqual(Ttml.vttCues(vtt([[14242458, '01:07:13.804', '01:07:14.883', "l'Air de dire"],
    [14242463, '07:15.364', '07:17.564', '<i>que les gommes</i> &amp;\nmediums']])), [
    { begin: 4033.804, end: 4034.883, text: "l'Air de dire" },
    { begin: 435.364, end: 437.564, text: 'que les gommes &\nmediums' }]);
  // A timestamp map moves the cues: MPEGTS 900000 (10 s) at LOCAL 2 s is 8 s later.
  assert.deepEqual(Ttml.vttCues(vtt([[1, '00:00:01.000', '00:00:02.000', 'x']], 'MPEGTS:900000,LOCAL:00:00:02.000')).map((c) => c.begin), [9]);
  assert.deepEqual(Ttml.vttCues('not a vtt'), []);
});

test('the reader shows WebVTT cues from a segment list at the player\'s position, once each', async () => {
  const files = {
    'https://cdn/s/1.vtt': vtt([[1, '00:00:01.000', '00:00:03.000', 'First'], [2, '00:00:05.000', '00:00:07.000', 'Across']]),
    'https://cdn/s/2.vtt': vtt([[2, '00:00:05.000', '00:00:07.000', 'Across'], [3, '00:00:08.000', '00:00:09.000', 'Third']])
  };
  const shown = [], state = { position: 0 };
  const track = { lang: 'eng', vtt: true, offset: 0, timescale: 1,
    list: [{ url: 'https://cdn/s/1.vtt', start: 0, end: 5.76 }, { url: 'https://cdn/s/2.vtt', start: 5.76, end: 11.52 }] };
  const reader = Ttml.reader([track], { position: () => state.position, show: (s) => shown.push(s),
    fetch: async (url) => ({ ok: true, arrayBuffer: async () => Uint8Array.from(Buffer.from(files[url], 'utf8')).buffer }) });
  reader.select('eng');
  for (const [pos, expect] of [[1.5, 'First'], [3.5, null], [6, 'Across'], [8.5, 'Third']]) {
    state.position = pos;
    await wait(230);
    assert.equal(shown.at(-1).text || null, expect, 'at ' + pos);
  }
  reader.stop();
});
