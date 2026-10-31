const assert = require('node:assert/strict');
const { test } = require('node:test');
const cmaf = require('../app/js/cmaf.js');

const box = (name, payload) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(payload.length + 8); head.write(name, 4);
  return Buffer.concat([head, payload]);
};
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
function sample(timescale, base, version = 1) {
  const mdhd = box('mdhd', Buffer.concat([Buffer.alloc(12), u32(timescale), Buffer.alloc(8)]));
  const init = Buffer.concat([box('ftyp', Buffer.from('iso6')), box('moov', box('trak', box('mdia', mdhd)))]);
  const time = Buffer.alloc(version ? 8 : 4);
  if (version) time.writeBigUInt64BE(BigInt(base)); else time.writeUInt32BE(base);
  const fragment = box('moof', box('traf', box('tfdt', Buffer.concat([Buffer.from([version, 0, 0, 0]), time]))));
  return { init, fragment };
}

test('CMAF timing preserves the real large decode origin instead of assuming zero', () => {
  const s = sample(50000, 89643062304000);
  assert.deepEqual(cmaf.timing(s.init, s.fragment), { timescale: 50000, baseTime: 89643062304000 });
  const old = sample(48000, 276480, 0);
  assert.deepEqual(cmaf.timing(old.init, old.fragment), { timescale: 48000, baseTime: 276480 });
});

test('malformed or ambiguous timing never creates a misleading DASH timeline', () => {
  const s = sample(50000, 89643062304000);
  assert.throws(() => cmaf.timing(s.init, s.fragment.subarray(0, -1)), /box|truncated/i);
  assert.throws(() => cmaf.timing(Buffer.concat([s.init, s.init]), s.fragment), /track|timing|ambiguous/i);
  const unsafe = sample(50000, 9007199254740992n);
  assert.throws(() => cmaf.timing(unsafe.init, unsafe.fragment), /safe|precision|range/i);
  const shortTfdt = box('moof', box('traf', Buffer.concat([box('tfdt', Buffer.alloc(4)), box('free', Buffer.alloc(16))])));
  assert.throws(() => cmaf.timing(s.init, shortTfdt), /truncated|timing/i);
  const shortMdhd = box('moov', box('trak', box('mdia', Buffer.concat([box('mdhd', Buffer.alloc(4)), box('free', Buffer.alloc(32))]))));
  assert.throws(() => cmaf.timing(shortMdhd, s.fragment), /truncated|timing/i);
});

test('encrypted video and audio key identifiers are read from their own protected sample entries', () => {
  const kid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  for (const type of ['encv', 'enca']) {
    const tenc = box('tenc', Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0x19, 1, 0]), kid, Buffer.from([16]), Buffer.alloc(16)]));
    const sinf = box('sinf', Buffer.concat([box('frma', Buffer.from(type === 'encv' ? 'hev1' : 'mp4a')),
      box('schm', Buffer.concat([Buffer.alloc(4), Buffer.from('cbcs'), u32(65536)])), box('schi', tenc)]));
    const entry = box(type, Buffer.concat([Buffer.alloc(type === 'encv' ? 78 : 28), sinf]));
    const stsd = box('stsd', Buffer.concat([Buffer.alloc(4), u32(1), entry]));
    const init = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))));
    assert.deepEqual(cmaf.encryption(init), { kid: '00112233-4455-6677-8899-aabbccddeeff', scheme: 'cbcs' });
  }
});

test('the template inference preserves signed query parameters and only substitutes media sequence numbers', () => {
  assert.deepEqual(cmaf.template(['https://cdn.example/v_900_00100.m4s?sig=keep&x=2', 'https://cdn.example/v_900_00101.m4s?sig=keep&x=2']), {
    media: 'https://cdn.example/v_900_$Number%05d$.m4s?sig=keep&x=2', startNumber: 100
  });
  assert.equal(cmaf.template(['https://cdn.example/a.m4s?sig=100', 'https://cdn.example/a.m4s?sig=101']), null);
  assert.equal(cmaf.template(['https://cdn.example/v_100.m4s?sig=a', 'https://cdn.example/v_101.m4s?sig=b']), null);
  assert.equal(cmaf.template(['https://cdn.example/v_100.m4s', 'https://cdn.example/v_102.m4s']), null);
});

test('a discontinuity sequence counter is allowed, while real discontinuities are rejected', () => {
  const media = '#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5.76,\nv_100.m4s\n#EXT-X-ENDLIST\n';
  assert.deepEqual(cmaf.playlist(media), { init: 'init.mp4', segments: [{ uri: 'v_100.m4s', duration: 5.76 }], keys: [] });
  assert.throws(() => cmaf.playlist(media.replace('#EXTINF:', '#EXT-X-DISCONTINUITY\n#EXTINF:')), /discontinuity/i);
});

function track(type, hdr = false) {
  return { type, id: type, hdr, codecs: type === 'video' ? 'hev1.2.4.L153.B0' : 'mp4a.40.2',
    width: 3840, height: 2160, bandwidth: type === 'video' ? 18000000 : 128000, language: 'en',
    timing: { timescale: 50000, baseTime: 89643062304000 }, init: 'https://cdn.example/init.mp4?sig=keep&x=2',
    segments: [100, 101, 102].map((n) => ({ url: `https://cdn.example/${type}_${n}.m4s?sig=keep&x=2`, duration: 5.76 })),
    protection: { kid: '00112233-4455-6677-8899-aabbccddeeff', pssh: 'public-initialization-metadata' } };
}

test('DASH output anchors its timeline and presentation offset to the actual media clock', () => {
  const mpd = cmaf.manifest([track('video', true), track('audio')]);
  assert.match(mpd, /profiles="urn:mpeg:dash:profile:isoff-live:2011"/);
  assert.match(mpd, /presentationTimeOffset="89643062304000"/);
  assert.match(mpd, /<S t="89643062304000" d="288000" r="2"\/>/);
  assert.match(mpd, /media="https:\/\/cdn.example\/video_\$Number\$.m4s\?sig=keep&amp;x=2"/);
  assert.match(mpd, /schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="18"/);
  assert.match(mpd, /value="cbcs" cenc:default_KID="00112233-4455-6677-8899-aabbccddeeff"/);
  assert.equal((mpd.match(/<ContentProtection/g) || []).length, 4);
});

test('explicit segment lists use the main profile instead of falsely declaring the live template profile', () => {
  const t = track('video');
  t.segments[1].url = 'https://cdn.example/special.m4s';
  const mpd = cmaf.manifest([t]);
  assert.match(mpd, /profiles="urn:mpeg:dash:profile:isoff-main:2011"/);
  assert.match(mpd, /<SegmentList[^>]*presentationTimeOffset="89643062304000"/);
  assert.equal((mpd.match(/<SegmentURL /g) || []).length, 3);
});

test('the same adapter builds the SDR control without adding HDR signaling', () => {
  const mpd = cmaf.manifest([track('video', false), track('audio')]);
  assert.ok(!mpd.includes('TransferCharacteristics'));
  assert.match(mpd, /value="cbcs"/);
  assert.match(mpd, /<cenc:pssh>public-initialization-metadata<\/cenc:pssh>/);
});

test('adding public Widevine initialization metadata preserves the existing encryption metadata', () => {
  const encrypted = box('tenc', Buffer.from('encryption-metadata-stays-intact'));
  const init = Buffer.concat([box('ftyp', Buffer.from('iso6')), box('moov', encrypted)]);
  const header = Buffer.concat([Buffer.alloc(4), Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex'), u32(0)]);
  const pssh = box('pssh', header);
  const adapted = Buffer.from(cmaf.addPssh(init, pssh));
  assert.deepEqual(adapted.subarray(0, 12), init.subarray(0, 12));
  assert.deepEqual(adapted.subarray(20, 20 + encrypted.length), encrypted);
  assert.equal(adapted.readUInt32BE(12), init.readUInt32BE(12) + pssh.length);
  assert.deepEqual(adapted.subarray(-pssh.length), pssh);
  assert.deepEqual(Buffer.from(cmaf.addPssh(adapted, pssh)), adapted);
});


test('timing accepts a complete moof followed by a partial mdat Range response', () => {
  const s = sample(50000, 89643062304000);
  const mdat = Buffer.alloc(8); mdat.writeUInt32BE(14000000); mdat.write('mdat', 4);
  assert.deepEqual(cmaf.timing(s.init, Buffer.concat([s.fragment, mdat, Buffer.alloc(10)])), { timescale: 50000, baseTime: 89643062304000 });
});

test('HLG qualities share one adaptation set so native ABR cannot select SDR', () => {
  const a = track('video', true), b = { ...track('video', true), id: '1080', width:1920, height:1080, bandwidth:6000000 };
  const mpd = cmaf.manifest([a,b,track('audio')]);
  assert.equal((mpd.match(/<AdaptationSet contentType="video"/g)||[]).length, 1);
  assert.equal((mpd.match(/<Representation/g)||[]).length, 3);
});
