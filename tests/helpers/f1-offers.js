'use strict';
// F1-like offers for tests, made from tests/fixtures/f1-offers.json: the structure of each captured offer (renditions
// and variants in F1's order, codecs, channels, key methods, which tracks are encrypted, DASH sets), not F1's files.
// serve() answers a fetch for every playlist, init segment, media segment, key and DASH manifest of the offers, with
// one clock for all (as F1's feeds of a session share theirs).
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/f1-offers.json'), 'utf8'));
const OFFERS = FIXTURE.offers;
const BASE = 'https://cdn.test/';
const KEY_URI = 'https://f1tv.formula1.com/2.0/R/ENG/BIGSCREEN_HLS/ALL/CONTENT/LA/ck?c=x';
const HLS_KID = '10213243-5465-7687-98a9-bacbdcedfe0f';   // FairPlay key id of the HLS copy (as in hdr.test.js)
const DASH_KID = '00112233-4455-6677-8899-aabbccddeeff';  // the Widevine offer's
const TIMESCALE = 50000, BASE_TIME = 89669822112000n, SEG = 5.76;

const box = (n, p) => { const b = Buffer.alloc(8); b.writeUInt32BE(p.length + 8); b.write(n, 4); return Buffer.concat([b, p]); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const mdhd = box('mdhd', Buffer.concat([Buffer.alloc(12), u32(TIMESCALE), Buffer.alloc(8)]));
function init(entry, encrypted) {
  let sample = Buffer.alloc(entry === 'hvc1' ? 78 : 28);   // (the fixed part of a visual / an audio sample entry)
  if (encrypted) {
    const tenc = box('tenc', Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0x19, 1, 0]), Buffer.from(HLS_KID.replaceAll('-', ''), 'hex'), Buffer.from([16]), Buffer.alloc(16)]));
    sample = Buffer.concat([sample, box('sinf', Buffer.concat([box('schm', Buffer.concat([Buffer.alloc(4), Buffer.from('cbcs'), u32(65536)])), box('schi', tenc)]))]);
  }
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(4), u32(1), box(encrypted ? (entry === 'hvc1' ? 'encv' : 'enca') : entry, sample)]));
  return box('moov', box('trak', box('mdia', Buffer.concat([mdhd, box('minf', box('stbl', stsd))]))));
}
function fragment(n) {
  const t = Buffer.alloc(8); t.writeBigUInt64BE(BASE_TIME + BigInt(n) * BigInt(SEG * TIMESCALE));
  return box('moof', box('traf', box('tfdt', Buffer.concat([Buffer.from([1, 0, 0, 0]), t]))));
}
const SEGMENTS = 3;

/** Whether the offer is TS (player_tm, 2018-2024 HLS) rather than CMAF. */
const isTs = (o) => /HLSCK/.test(o.streamType || '') || (o.format === 'hls' && !/CMAF/.test(o.streamType || ''));
const encryptedTrack = (scheme) => scheme === 'cbcs' || scheme === 'cenc';

function attrList(pairs) { return pairs.filter(([, v]) => v != null).map(([k, v, q]) => k + '=' + (q === false ? v : '"' + v + '"')).join(','); }

/** The HLS master of an offer (`name/offer` as in the fixture), with addresses under BASE. */
function master(key) {
  const o = OFFERS[key];
  if (!o || o.format !== 'hls') throw new Error('no HLS offer ' + key);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  (o.keys || []).forEach((k) => {
    if (k.method === 'SAMPLE-AES') lines.push('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://' + HLS_KID + '"');
    else if (k.method === 'AES-128') lines.push('#EXT-X-SESSION-KEY:METHOD=AES-128,URI="' + KEY_URI + '",KEYFORMAT="identity"');
  });
  o.media.forEach((m, i) => {
    lines.push('#EXT-X-MEDIA:' + attrList([['TYPE', m.type, false], ['GROUP-ID', m.group], ['NAME', m.name], ['LANGUAGE', m.language],
      ['CHANNELS', m.channels], ['DEFAULT', m.default, false], ['AUTOSELECT', m.autoselect, false], ['URI', 'm' + i + '.m3u8']]));
  });
  o.variants.forEach((v) => {
    lines.push('#EXT-X-STREAM-INF:' + attrList([['BANDWIDTH', v.bandwidth || 1000000, false], ['RESOLUTION', v.resolution, false],
      ['FRAME-RATE', v.frameRate, false], ['VIDEO-RANGE', v.range, false], ['CODECS', v.codecs], ['AUDIO', v.audio], ['SUBTITLES', v.subtitles],
      ['CLOSED-CAPTIONS', v.captions === 'NONE' ? 'NONE' : v.captions, v.captions === 'NONE' ? false : undefined]]));
    lines.push('v' + String(v.resolution || 'x').replace('x', '_') + '_' + (v.range || 'SDR') + '.m3u8');
  });
  return lines.join('\n') + '\n';
}

/** A media playlist of the offer: the video of `res_range`, or rendition `m<i>`. */
function playlist(key, name) {
  const o = OFFERS[key], ts = isTs(o);
  const media = /^m(\d+)$/.exec(name), rendition = media ? o.media[+media[1]] : null;
  const scheme = rendition ? rendition.init : (o.variants.find((v) => 'v' + String(v.resolution).replace('x', '_') + '_' + (v.range || 'SDR') === name) || {}).init;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:1', '#EXT-X-PROGRAM-DATE-TIME:2026-11-22T06:10:00.000Z'];
  if (rendition && rendition.type === 'SUBTITLES') {
    for (let n = 1; n <= SEGMENTS; n++) lines.push('#EXTINF:' + SEG.toFixed(3) + ',', name + '_' + n + '.vtt');
    return lines.concat('#EXT-X-ENDLIST').join('\n') + '\n';
  }
  if (ts) {
    if ((o.keys || []).some((k) => k.method === 'AES-128')) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="' + KEY_URI + '",IV=0x0123456789abcdef0123456789abcdef');
    for (let n = 1; n <= SEGMENTS; n++) lines.push('#EXTINF:' + SEG.toFixed(3) + ',', name + '_' + n + '.ts');
  } else {
    lines.push('#EXT-X-MAP:URI="' + name + '_init.mp4"');
    if (encryptedTrack(scheme)) lines.push('#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://' + HLS_KID + '"');
    for (let n = 1; n <= SEGMENTS; n++) lines.push('#EXTINF:' + SEG.toFixed(3) + ',', name + '_' + n + '.m4s');
  }
  return lines.concat('#EXT-X-ENDLIST').join('\n') + '\n';
}

/** The init segment of `name` (a video playlist or rendition m<i>) of the offer. */
function initOf(key, name) {
  const o = OFFERS[key], media = /^m(\d+)$/.exec(name), rendition = media ? o.media[+media[1]] : null;
  if (rendition) {
    const codec = (o.variants.find((v) => v.audio === rendition.group) || {}).codecs || '';
    return init(/ac-3/.test(codec) ? 'ac-3' : /ec-3/.test(codec) ? 'ec-3' : 'mp4a', encryptedTrack(rendition.init));
  }
  const v = o.variants.find((x) => 'v' + String(x.resolution).replace('x', '_') + '_' + (x.range || 'SDR') === name) || {};
  return init('hvc1', encryptedTrack(v.init));
}

/** The Widevine DASH of a DASH offer: its sets in F1's order, on the same clock, cenc/cbcs as F1 marks them. */
function dash(key) {
  const o = OFFERS[key];
  if (!o || o.format !== 'dash') throw new Error('no DASH offer ' + key);
  const pssh = Buffer.concat([Buffer.from('public-widevine-metadata'), Buffer.from(DASH_KID.replaceAll('-', ''), 'hex')]).toString('base64');
  const cp = (scheme) => `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="${scheme}" cenc:default_KID="${DASH_KID}"/>` +
    `<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>${pssh}</cenc:pssh></ContentProtection>`;
  const templ = (n) => `<SegmentTemplate timescale="${TIMESCALE}" presentationTimeOffset="${BASE_TIME}" initialization="s${n}_init.mp4" media="s${n}_$Number$.m4s"><SegmentTimeline><S t="${BASE_TIME}" d="${SEG * TIMESCALE}" r="${SEGMENTS - 1}"/></SegmentTimeline></SegmentTemplate>`;
  const sets = o.sets.map((s, n) => {
    const type = String(s.contentType).split('/')[0], scheme = (s.protection || []).find((p) => p === 'cenc' || p === 'cbcs');
    const lang = s.lang ? ` lang="${s.lang}"` : '';
    const prot = scheme && type !== 'application' ? cp(scheme) : '';
    const ch = (s.channels || [])[0] ? `<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="${s.channels[0]}"/>` : '';
    return `<AdaptationSet contentType="${type}"${lang}${type === 'application' ? ' codecs="stpp"' : ''}>${prot}${ch}${templ(n)}<Representation id="r${n}" bandwidth="128000" codecs="${(s.codecs || [])[0] || ''}"/></AdaptationSet>`;
  });
  return `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static"><Period start="PT0S">${sets.join('')}</Period></MPD>`;
}

const url = (key, file) => BASE + key + '/' + file;

/**
 * A fetch for the offers (and the helper's grid build: POST /stitch/<id> answers a size and codec). `calls` collects
 * every address asked.
 */
function serve(calls = []) {
  return async (address, opts = {}) => {
    calls.push(address);
    const reply = (body, status = 200) => ({ ok: status < 400, status, url: address, text: async () => String(body),
      arrayBuffer: async () => Uint8Array.from(Buffer.isBuffer(body) ? body : Buffer.from(String(body))).buffer });
    if (/\/stitch\/[a-z0-9-]+$/.test(address) && opts.method === 'POST') return reply(JSON.stringify({ width: 3840, height: 2176, codecs: 'hvc1.2.4.L153.B0' }), 201);
    if (address.startsWith(KEY_URI.split('?')[0])) return reply(Buffer.alloc(16, 7));
    if (!address.startsWith(BASE)) return reply('', 404);
    const rest = address.slice(BASE.length), slash = rest.indexOf('/', rest.indexOf('/') + 1);
    const key = rest.slice(0, slash), file = rest.slice(slash + 1).split('?')[0];
    if (!OFFERS[key]) return reply('', 404);
    if (file === 'master.m3u8') return reply(master(key));
    if (file === 'index.mpd') return reply(dash(key));
    let m;
    if ((m = /^(.+)\.m3u8$/.exec(file))) return reply(playlist(key, m[1]));
    if ((m = /^(.+)_init\.mp4$/.exec(file))) return reply(/^s\d+$/.test(m[1]) ? init('mp4a', true) : initOf(key, m[1]));
    if ((m = /_(\d+)\.(m4s|ts)$/.exec(file))) return reply(fragment(+m[1] - 1));
    if (/\.vtt$/.test(file)) return reply('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n');
    return reply('', 404);
  };
}

/** The HLG heights an offer's HEVC variants have. */
function hlgHeights(key) {
  return [...new Set(OFFERS[key].variants.filter((v) => v.range === 'HLG' && /hvc1|hev1/.test(v.codecs || '')).map((v) => +String(v.resolution).split('x')[1]))];
}

/** Its sound in the source: each audio rendition with its group, language, channels and codec. */
function audioOf(key) {
  const o = OFFERS[key];
  if (o.format === 'dash') return o.sets.filter((s) => /audio/.test(s.contentType)).map((s) => ({ language: s.lang, channels: +((s.channels || [])[0] || 2), codec: (s.codecs || [])[0] }));
  return o.media.filter((m) => m.type === 'AUDIO').map((m) => ({ group: m.group, language: m.language, channels: +(m.channels || 2),
    codec: ((o.variants.find((v) => v.audio === m.group) || {}).codecs || '').split(',').map((c) => c.trim()).find((c) => /^(mp4a|ac-3|ec-3)/.test(c)) }));
}

module.exports = { OFFERS, BASE, url, master, dash, serve, hlgHeights, audioOf };
