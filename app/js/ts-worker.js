// Shaka's own TS transmuxer (TS -> MP4), off the page's thread (ts-offload.js). The page sends Shaka's compiled source
// once (a launcher bundle's worker gets only its own verified file, see shell/boot.js), then one segment per message.
// 2160p TS segments of F1's Tiledmedia offer took ~480 ms each on the page and froze key presses for up to 650 ms.
var transmuxers = {}, stats = { segments: 0, ms: 0, maxMs: 0 };

function reply(m, transfer) { self.postMessage(m, transfer || []); }

function errorOf(e) {
  return { severity: e && e.severity, category: e && e.category, code: e && e.code, data: e && e.data && [String(e.data[0] || '')],
    message: String((e && (e.message || e)) || 'transmux failed').slice(0, 300) };
}

self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.op === 'init') {
    try {
      self.window = self; self.global = self;   // what Shaka's compiled file looks for
      (0, eval)(m.source + '\n//# sourceURL=shaka-player.compiled.js');
      if (!self.shaka || !self.shaka.transmuxer || !self.shaka.transmuxer.TsTransmuxer) throw new Error('No TsTransmuxer in Shaka');
      reply({ op: 'ready' });
    } catch (e) { reply({ op: 'ready', err: errorOf(e) }); }
    return;
  }
  if (m.op === 'destroy') {
    var old = transmuxers[m.id];
    delete transmuxers[m.id];
    try { if (old) old.destroy(); } catch (e) { /* nothing to keep */ }
    return;
  }
  if (m.op === 'stats') return reply({ op: 'stats', stats: stats });
  if (m.op !== 'transmux') return;
  var t0 = Date.now();
  try {
    var t = transmuxers[m.id] || (transmuxers[m.id] = new self.shaka.transmuxer.TsTransmuxer(m.mime));
    var uris = m.ref.uris, ref = m.ref.fields;
    // The segment reference's fields as plain values, and its URI getter under every name Shaka's build gives it.
    m.ref.uriNames.forEach(function (k) { ref[k] = function () { return uris; }; });
    var stream = m.stream, before = {};
    Object.keys(stream).forEach(function (k) { before[k] = stream[k]; });
    Promise.resolve().then(function () {
      return t.transmux(m.data, stream, ref, m.duration, m.contentType);
    }).then(function (out) {
      var ms = Date.now() - t0;
      stats.segments++; stats.ms += ms; stats.maxMs = Math.max(stats.maxMs, ms);
      var u8 = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out : out.slice();
      // What the transmuxer learned about the stream (Shaka's TsTransmuxer sets its size, sample rate and channels).
      var learned = {};
      Object.keys(stream).forEach(function (k) {
        var v = stream[k];
        if (v !== before[k] && (v == null || /^(string|number|boolean)$/.test(typeof v))) learned[k] = v;
      });
      reply({ op: 'done', seq: m.seq, out: u8.buffer, ms: ms, learned: learned }, [u8.buffer]);
    }, function (e) {
      reply({ op: 'done', seq: m.seq, err: errorOf(e) });
    });
  } catch (e) {
    reply({ op: 'done', seq: m.seq, err: errorOf(e) });
  }
};
