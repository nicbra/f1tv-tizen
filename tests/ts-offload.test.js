'use strict';
// ts-offload.js + ts-worker.js against Shaka's own code (the vendored build, in Node): same start times, same metadata,
// byte-identical MP4 from the worker, and the page's transmuxer whenever the worker can't be used.
// Fixtures: synthetic ffmpeg test pictures (testsrc2, sine), 1.2 s each. hevc10-video.ts: HEVC Main 10, video only,
// like F1's Tiledmedia TS; h264-aac.ts: H.264 + AAC muxed, like 2018-2020 replays.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

const root = path.join(__dirname, '..');
const shakaSource = fs.readFileSync(path.join(root, 'app/vendor/shaka-player.compiled.js'), 'utf8');
const fixture = name => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/ts', name)));

function context(extra) {
  const ctx = Object.assign({ console, setTimeout, clearTimeout, Promise, TextDecoder, TextEncoder, URL,
    navigator: { userAgent: 'node' }, Date, Math, structuredClone }, extra);
  ctx.self = ctx; ctx.window = ctx; ctx.global = ctx;
  vm.createContext(ctx);
  return ctx;
}

/** A page with Shaka and ts-offload.js; its Worker runs ts-worker.js in a context of its own, messages cloned. */
function page(opts = {}) {
  const made = [];
  class FakeWorker {
    constructor(url) {
      made.push(url);
      if (opts.workerThrows) throw new Error('no workers here');
      const w = this;
      this.ctx = context({ postMessage: (m, transfer) => setImmediate(() => w.onmessage && w.onmessage({ data: structuredClone(m, { transfer }) })) });
      vm.runInContext(fs.readFileSync(path.join(root, 'app/js', path.basename(url)), 'utf8'), this.ctx);
      this.terminated = false;
    }
    postMessage(m, transfer) {
      if (this.terminated) return;
      const data = structuredClone(m, { transfer });
      setImmediate(() => { if (!this.terminated) this.ctx.onmessage({ data }); });
    }
    terminate() { this.terminated = true; }
  }
  const ctx = context({ Worker: FakeWorker, ArrayBuffer, Uint8Array, Object, MediaSource: { isTypeSupported: () => true } });
  ctx.Launcher = {
    worker: rel => new FakeWorker(rel),
    file: (rel, done) => setImmediate(() => opts.fileFails ? done(new Error('unsigned')) : done(null, new TextEncoder().encode(fs.readFileSync(path.join(root, 'app', rel), 'utf8'))))
  };
  vm.runInContext(shakaSource, ctx);
  // Shaka's untouched parser and transmuxer, kept before ts-offload.js patches the parser.
  const P = ctx.shaka.util.TsParser.prototype, original = {};
  Object.getOwnPropertyNames(P).forEach(k => { original[k] = P[k]; });
  const notes = [];
  ctx.Diag = { note: (kind, data) => notes.push([kind, data]) };
  vm.runInContext(fs.readFileSync(path.join(root, 'app/js/ts-offload.js'), 'utf8'), ctx);
  ctx.TsOffload = vm.runInContext('TsOffload', ctx);
  return { ctx, original, made, notes };
}

/** What Shaka's own parser says, with the prototype as it was before ts-offload.js. */
function shakaSays(p, data, type) {
  const parser = Object.create(p.ctx.shaka.util.TsParser.prototype);
  p.ctx.shaka.util.TsParser.call(parser);
  for (const k of Object.keys(p.original)) parser[k] = p.original[k];
  parser.parse(data);
  return { start: parser.getStartTime(type), metadata: parser.getMetadata() };
}

function reference(ctx, uri) {
  return new ctx.shaka.media.SegmentReference(0, 1.2, () => [uri], 0, null, null, 0, 0, Infinity);
}
function streamOf(codecs) {
  return { id: 1, type: 'video', mimeType: 'video/mp2t', codecs, language: 'und', width: null, height: null, channelsCount: null, audioSamplingRate: null,
    drmInfos: [], closedCaptions: new Map(), fullMimeTypes: new Set() };
}


// -- TS surgery for the sequences below --
const packets = (ts) => { const out = []; for (let i = 0; i + 188 <= ts.length; i += 188) out.push(ts.slice(i, i + 188)); return out; };
const join = (list) => { const out = new Uint8Array(list.length * 188); list.forEach((p, i) => out.set(p, i * 188)); return out; };
const pidOf = (p) => ((p[1] & 0x1f) << 8) | p[2];
function writeTs(p, o, v) {
  const hi = Math.floor(v / 1073741824) & 7;
  p[o] = (p[o] & 0xf0) | (hi << 1) | 1;
  const lo = v % 1073741824;
  p[o + 1] = (lo >>> 22) & 0xff; p[o + 2] = ((lo >>> 14) & 0xfe) | 1; p[o + 3] = (lo >>> 7) & 0xff; p[o + 4] = ((lo << 1) & 0xfe) | 1;
}
function readTs(p, o) { return (p[o] & 0x0e) * 536870912 + (p[o + 1] << 22) + ((p[o + 2] & 0xfe) << 14) + (p[o + 3] << 7) + ((p[o + 4] & 0xfe) >> 1); }
/** Every PES time stamp moved by `delta` ticks, modulo 2^33 (a stream that crosses the 33-bit rollover). */
function shifted(ts, delta) {
  const list = packets(ts);
  for (const p of list) {
    if (!(p[1] & 0x40) || pidOf(p) < 0x20) continue;
    const afc = (p[3] & 0x30) >> 4, o = afc > 1 ? 5 + p[4] : 4;
    if (p[o] !== 0 || p[o + 1] !== 0 || p[o + 2] !== 1) continue;
    const flags = p[o + 7] >> 6;
    if (flags & 2) writeTs(p, o + 9, (readTs(p, o + 9) + delta) % 8589934592);
    if (flags === 3) writeTs(p, o + 14, (readTs(p, o + 14) + delta) % 8589934592);
  }
  return join(list);
}
/** Shaka's untouched parser instance (the prototype as it was before ts-offload.js). */
function shakaParser(p) {
  const parser = Object.create(p.ctx.shaka.util.TsParser.prototype);
  p.ctx.shaka.util.TsParser.call(parser);
  for (const k of Object.keys(p.original)) parser[k] = p.original[k];
  return parser;
}
/** The same segments through one parser instance each, as Shaka's MediaSourceEngine uses it. */
function sequence(p, segments, type) {
  const ours = new p.ctx.shaka.util.TsParser(), theirs = shakaParser(p), out = [];
  for (const seg of segments) {
    ours.clearData(); theirs.clearData();
    ours.parse(seg); theirs.parse(seg);
    out.push({ ours: ours.getStartTime(type), shaka: theirs.getStartTime(type),
      oursMeta: Array.from(ours.getMetadata()).length, shakaMeta: Array.from(theirs.getMetadata()).length });
  }
  return out;
}

test('start times and metadata match Shaka without a full parse (video only HEVC, muxed H.264 + AAC)', () => {
  const p = page(), Parser = p.ctx.shaka.util.TsParser;
  for (const [name, types] of [['hevc10-video.ts', ['video']], ['h264-aac.ts', ['video', 'audio']]]) {
    for (const type of types) {
      const data = fixture(name), want = shakaSays(p, data, type);
      const before = p.ctx.TsOffload.status().fullParses;
      const parser = new Parser().parse(data);
      assert.equal(parser.getStartTime(type), want.start, name + ' ' + type);
      assert.ok(want.start > 0, name + ' has a start time');
      assert.deepEqual(Array.from(parser.getMetadata()), Array.from(want.metadata));
      assert.equal(p.ctx.TsOffload.status().fullParses, before, 'no full parse for ' + name + ' ' + type);
    }
  }
});

test('anything else asked of the parser gets Shaka\'s full parse first', () => {
  const p = page(), data = fixture('h264-aac.ts');
  const parser = new p.ctx.shaka.util.TsParser().parse(data);
  const reference = Object.create(p.ctx.shaka.util.TsParser.prototype);
  p.ctx.shaka.util.TsParser.call(reference);
  p.original.parse.call(reference, data);
  assert.deepEqual(parser.getCodecs(), p.original.getCodecs.call(reference));
  assert.equal(p.ctx.TsOffload.status().fullParses, 1);
  assert.equal(parser.getStartTime('video'), p.original.getStartTime.call(reference, 'video'));
});

test('a segment with ID3 packets keeps Shaka\'s metadata parse', () => {
  const p = page(), data = fixture('h264-aac.ts');
  // The AAC stream declared as ID3 (0x15) in the PMT: its packets now count as ID3 packets.
  let changed = 0;
  for (let i = 0; i + 188 <= data.length; i += 188) {
    const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
    if (pid !== 0x1000 || !(data[i + 1] & 0x40)) continue;
    let q = i + 4 + data[i + 4] + 1 + 12 + (((data[i + 4 + data[i + 4] + 1 + 10] & 0x0f) << 8) | data[i + 4 + data[i + 4] + 1 + 11]);
    for (; q < i + 180; q += 5 + (((data[q + 3] & 0x0f) << 8) | data[q + 4])) if (data[q] === 0x0f) { data[q] = 0x15; changed++; break; }
  }
  assert.ok(changed > 0, 'PMT rewritten');
  const want = shakaSays(p, data, 'video');
  const parser = new p.ctx.shaka.util.TsParser().parse(data);
  assert.deepEqual(Array.from(parser.getMetadata()).map(m => m.cueTime), Array.from(want.metadata).map(m => m.cueTime));
  assert.equal(p.ctx.TsOffload.status().fullParses, 1);
});

test('the worker gives byte-identical MP4 and the same stream facts as Shaka on the page', async () => {
  for (const [name, codecs, type] of [['hevc10-video.ts', 'hvc1.2.4.L63.90', 'video'], ['h264-aac.ts', 'avc1.4d400c,mp4a.40.2', 'video']]) {
    const p = page(), E = p.ctx.shaka.transmuxer.TransmuxerEngine;
    const local = new p.ctx.shaka.transmuxer.TsTransmuxer('video/mp2t'), localStream = streamOf(codecs);
    const want = await local.transmux(fixture(name), localStream, reference(p.ctx, 'https://cdn.example/a.ts'), 1.2, type);
    const Factory = E.findTransmuxer('video/mp2t; codecs="' + codecs + '"', type);
    const t = Factory(), stream = streamOf(codecs), data = fixture(name);
    assert.equal(t.constructor.name, 'WorkerTs', 'the plugin wins over Shaka\'s own');
    const got = await t.transmux(data, stream, reference(p.ctx, 'https://cdn.example/a.ts'), 1.2, type);
    assert.equal(Buffer.compare(Buffer.from(got), Buffer.from(want)), 0, name + ': same MP4');
    for (const k of ['width', 'height', 'channelsCount', 'audioSamplingRate']) assert.equal(stream[k], localStream[k], name + ' ' + k);
    assert.ok(stream.height > 0, name + ': the picture size came back from the worker');
    assert.equal(data.byteLength, 0, 'a video segment is handed over, not copied');
    const s = p.ctx.TsOffload.status();
    assert.equal(s.segments, 1); assert.equal(s.transferred, 1); assert.equal(s.local, 0);
    assert.deepEqual(p.made, ['js/ts-worker.js'], 'through the launcher, started once');
    t.destroy();
  }
});

test('an AES-128 HLS stream (Shaka marks it encrypted, no DRM infos) transmuxes in the worker like on the page', async () => {
  const p = page(), codecs = 'hvc1.2.4.L63.90';
  const stream = Object.assign(streamOf(codecs), { encrypted: true }), localStream = Object.assign(streamOf(codecs), { encrypted: true });
  const want = await new p.ctx.shaka.transmuxer.TsTransmuxer('video/mp2t').transmux(fixture('hevc10-video.ts'), localStream, reference(p.ctx, 'u'), 1.2, 'video');
  const t = p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="' + codecs + '"', 'video')();
  const got = await t.transmux(fixture('hevc10-video.ts'), stream, reference(p.ctx, 'u'), 1.2, 'video');
  assert.equal(Buffer.compare(Buffer.from(got), Buffer.from(want)), 0);
  assert.equal(p.ctx.TsOffload.status().failures, 0);
});

test('a segment that is part of a bigger buffer, or audio, is copied and left as it was', async () => {
  const p = page(), t = new (p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="hvc1.2.4.L63.90"', 'video'))();
  const ts = fixture('hevc10-video.ts'), big = new Uint8Array(ts.length + 188);
  big.set(ts, 188);
  const view = big.subarray(188);
  await t.transmux(view, streamOf('hvc1.2.4.L63.90'), reference(p.ctx, 'u'), 1.2, 'video');
  assert.equal(view.byteLength, ts.length);
  assert.equal(p.ctx.TsOffload.status().copied, 1);
});

test('if Shaka can\'t be read for the worker, the page transmuxes, and keeps doing so', async () => {
  const p = page({ fileFails: true }), codecs = 'hvc1.2.4.L63.90';
  const t = p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="' + codecs + '"', 'video')();
  const data = fixture('hevc10-video.ts');
  const got = await t.transmux(data, streamOf(codecs), reference(p.ctx, 'u'), 1.2, 'video');
  assert.ok(got.byteLength > 1000);
  assert.equal(data.byteLength, fixture('hevc10-video.ts').byteLength, 'nothing handed over');
  await t.transmux(fixture('hevc10-video.ts'), streamOf(codecs), reference(p.ctx, 'u'), 1.2, 'video');
  const s = p.ctx.TsOffload.status();
  assert.equal(s.local, 2); assert.equal(s.disabled, true);
  assert.ok(p.notes.some(n => n[0] === 'player.ts_worker_off'));
});

test('a worker that can\'t start leaves the page transmuxing', async () => {
  const p = page({ workerThrows: true }), codecs = 'hvc1.2.4.L63.90';
  const t = p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="' + codecs + '"', 'video')();
  const got = await t.transmux(fixture('hevc10-video.ts'), streamOf(codecs), reference(p.ctx, 'u'), 1.2, 'video');
  assert.ok(got.byteLength > 1000);
  assert.equal(p.ctx.TsOffload.status().local, 1);
});

test('a segment Shaka\'s transmuxer refuses fails as Shaka\'s own error, from the worker', async () => {
  const p = page(), codecs = 'hvc1.2.4.L63.90';
  const t = p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="' + codecs + '"', 'video')();
  const junk = new Uint8Array(188 * 4).fill(0x47);
  const local = await new p.ctx.shaka.transmuxer.TsTransmuxer('video/mp2t').transmux(junk.slice(), streamOf(codecs), reference(p.ctx, 'u'), 1.2, 'video').then(() => null, e => e);
  const err = await t.transmux(junk, streamOf(codecs), reference(p.ctx, 'u'), 1.2, 'video').then(() => null, e => e);
  assert.ok(local && err, 'both refuse');
  assert.equal(err.code, local.code);
  assert.equal(err.category, local.category);
  assert.equal(p.ctx.TsOffload.status().disabled, false, 'one bad segment doesn\'t turn the worker off');
});


test('segment after segment, across the 33-bit time stamp rollover, the start times are Shaka\'s own', () => {
  const p = page(), base = fixture('hevc10-video.ts');
  // 0.6 s before the rollover: the first segment wraps inside, the next starts after it.
  const pes = packets(base).find((q) => pidOf(q) === 481 && (q[1] & 0x40));
  const first = readTs(pes, ((pes[3] & 0x30) >> 4 > 1 ? 5 + pes[4] : 4) + 9);
  const delta = 8589934592 - first - 54000;
  const a = shifted(base, delta), b = shifted(base, delta + 108000);
  for (const type of ['video']) {
    const got = sequence(p, [a, b, shifted(base, delta + 216000)], type);
    for (const g of got) assert.equal(g.ours, g.shaka, JSON.stringify(got));
    assert.ok(got[1].shaka > 90000, 'Shaka carries the rollover: ' + got[1].shaka);
  }
  assert.ok(p.ctx.TsOffload.status().lazyStarts >= 3);
});

test('a segment without its own PAT and PMT uses what Shaka learned before', () => {
  const p = page(), ts = fixture('h264-aac.ts');
  const bare = join(packets(ts).filter((q) => pidOf(q) !== 0 && pidOf(q) !== 0x1000));
  for (const type of ['video', 'audio']) {
    const got = sequence(p, [ts, bare], type);
    assert.deepEqual(got.map((g) => g.ours), got.map((g) => g.shaka), type);
    assert.notEqual(got[1].shaka, null);
  }
});

test('elementary stream packets before the PMT: Shaka\'s full parse decides (start time and metadata)', () => {
  const p = page();
  const list = packets(fixture('h264-aac.ts'));
  const early = list.filter((q) => pidOf(q) === 0x100).slice(0, 3);
  const late = join(early.concat(list.filter((q) => !early.includes(q))));
  const got = sequence(p, [late], 'video');
  assert.equal(got[0].ours, got[0].shaka);
  // ID3 packets ahead of the PMT (AAC stream declared as ID3 for the test)
  const id3 = packets(fixture('h264-aac.ts'));
  for (const q of id3) {
    if (pidOf(q) !== 0x1000 || !(q[1] & 0x40)) continue;
    const o = 4 + q[4] + 1;
    for (let k = o + 12 + (((q[o + 10] & 0x0f) << 8) | q[o + 11]); k < 180; k += 5 + (((q[k + 3] & 0x0f) << 8) | q[k + 4])) if (q[k] === 0x0f) { q[k] = 0x15; break; }
  }
  const audioFirst = id3.filter((q) => pidOf(q) === 0x101).slice(0, 4);
  const meta = sequence(p, [join(audioFirst.concat(id3.filter((q) => !audioFirst.includes(q))))], 'video');
  assert.equal(meta[0].oursMeta, meta[0].shakaMeta);
});

test('a worker that stops under a copied segment: the page transmuxes that segment; under a handed-over one: an error that is no verdict', async () => {
  const p = page(), codecs = 'hvc1.2.4.L63.90';
  const Factory = p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="' + codecs + '"', 'video');
  const t = Factory();
  await t.transmux(fixture('hevc10-video.ts'), streamOf(codecs), reference(p.ctx, 'u'), 1.2, 'video');   // started
  // Two segments in flight when the worker stops: an audio one (copied) and a video one (handed over).
  const audio = p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="avc1.4d400c,mp4a.40.2"', 'audio')();
  const copied = audio.transmux(fixture('h264-aac.ts'), Object.assign(streamOf('mp4a.40.2'), { type: 'audio' }), reference(p.ctx, 'u'), 1.2, 'audio').then((x) => x, (e) => e);
  const handed = t.transmux(fixture('hevc10-video.ts'), streamOf(codecs), reference(p.ctx, 'u'), 1.2, 'video').then((x) => x, (e) => e);
  await new Promise((r) => setImmediate(r));
  p.ctx.TsOffload.disable();
  const [c, h] = await Promise.all([copied, handed]);
  assert.ok(c && c.byteLength > 0, 'copied: transmuxed on the page (' + (c && c.message) + ')');
  assert.ok(p.ctx.TsOffload.status().local >= 1);
  assert.equal(h.code, 3018);
  assert.match(String(h.data[0]), /^TS worker stopped/);
});

test('a reference that keeps its own copy of the bytes: copied, never handed over', async () => {
  const p = page(), codecs = 'hvc1.2.4.L63.90';
  const t = p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="' + codecs + '"', 'video')();
  const data = fixture('hevc10-video.ts'), ref = reference(p.ctx, 'u');
  ref.getSegmentData = () => data.buffer;
  await t.transmux(data, streamOf(codecs), ref, 1.2, 'video');
  assert.equal(data.byteLength, fixture('hevc10-video.ts').byteLength);
  assert.equal(p.ctx.TsOffload.status().copied, 1);
});

test('destroyed while the worker starts: the segment is not sent, and the call settles', async () => {
  const p = page(), codecs = 'hvc1.2.4.L63.90';
  const t = p.ctx.shaka.transmuxer.TransmuxerEngine.findTransmuxer('video/mp2t; codecs="' + codecs + '"', 'video')();
  const call = t.transmux(fixture('hevc10-video.ts'), streamOf(codecs), reference(p.ctx, 'u'), 1.2, 'video').then(() => 'resolved', (e) => e.code);
  t.destroy();
  assert.equal(await call, 7000);
  assert.equal(p.ctx.TsOffload.status().transferred + p.ctx.TsOffload.status().copied, 0);
});

test('index.html loads it right after Shaka, and the launcher verifies the worker at boot', () => {
  const html = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
  assert.ok(html.indexOf('vendor/shaka-player.compiled.js') < html.indexOf('js/ts-offload.js'));
  assert.ok(html.indexOf('js/ts-offload.js') < html.indexOf('js/player.js'));
  // shell/boot.js reads every js/*worker*.js of a bundle at boot; a worker gets only that verified source.
  assert.match('js/ts-worker.js', /^js\/.*worker.*\.js$/);
  assert.match(fs.readFileSync(path.join(root, 'shell/boot.js'), 'utf8'), /\^js\\\/\.\*worker\.\*\\\.js\$/);
});
