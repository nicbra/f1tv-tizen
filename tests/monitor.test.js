const assert = require('node:assert/strict');
const { test } = require('node:test');
const { audioSegmentUrl, sencCount } = require('../monitor/check.js');

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
