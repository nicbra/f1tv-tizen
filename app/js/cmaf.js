/* CMAF metadata and DASH addressing. Media remains encrypted; the native CDM handles licences. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CmafDash = factory();
})(this, function () {
  'use strict';
  var MAX_SAFE = 9007199254740991;
  function uint32(bytes, at) {
    if (at < 0 || at + 4 > bytes.length) throw new Error('truncated MP4 box');
    return bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3];
  }
  function uint64(bytes, at) {
    var n = uint32(bytes, at) * 4294967296 + uint32(bytes, at + 4);
    if (n > MAX_SAFE) throw new Error('MP4 timestamp exceeds safe precision');
    return n;
  }
  function name(bytes, at) { return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]); }
  function boxes(bytes, start, end) {
    var out = [], at = start;
    while (at < end) {
      if (end - at < 8) throw new Error('truncated MP4 box header');
      var size = uint32(bytes, at), header = 8;
      if (size === 1) { size = uint64(bytes, at + 8); header = 16; }
      else if (size === 0) size = end - at;
      if (size < header || at + size > end) throw new Error('invalid or truncated MP4 box');
      out.push({ type: name(bytes, at + 4), start: at, payload: at + header, end: at + size, header: header });
      at += size;
    }
    return out;
  }
  var CONTAINERS = { moov: true, trak: true, mdia: true, minf: true, stbl: true, moof: true, traf: true, sinf: true, schi: true };
  function needPayload(box, size) { if (box.end - box.payload < size) throw new Error('truncated ' + box.type + ' payload'); }
  function collect(bytes, list, wanted) {
    var out = [];
    list.forEach(function (b) {
      if (b.type === wanted) out.push(b);
      if (CONTAINERS[b.type]) out = out.concat(collect(bytes, boxes(bytes, b.payload, b.end), wanted));
      else if (b.type === 'stsd') {
        needPayload(b, 8);
        out = out.concat(collect(bytes, boxes(bytes, b.payload + 8, b.end), wanted));
      } else if (b.type === 'encv' || b.type === 'enca') {
        var skip = b.type === 'encv' ? 78 : 28;
        needPayload(b, skip);
        if (b.type === 'enca' && (bytes[b.payload + 8] || bytes[b.payload + 9])) throw new Error('unsupported protected audio entry version');
        out = out.concat(collect(bytes, boxes(bytes, b.payload + skip, b.end), wanted));
      }
    });
    return out;
  }
  function timing(init, fragment) {
    var headers = collect(init, boxes(init, 0, init.length), 'mdhd');
    // A Range response need only include the complete moof, not the following video payload.
    var end = 0;
    while (end + 8 <= fragment.length) {
      var size = uint32(fragment, end), type = name(fragment, end + 4);
      if (size === 1) size = uint64(fragment, end + 8);
      if (type === 'mdat') break;
      if (size < 8 || end + size > fragment.length) throw new Error('truncated fragment header');
      end += size;
    }
    var origins = collect(fragment, boxes(fragment, 0, end), 'tfdt');
    if (headers.length !== 1 || origins.length !== 1) throw new Error('ambiguous or missing track timing');
    var m = headers[0], t = origins[0];
    needPayload(m, 4); needPayload(t, 4);
    var mv = init[m.payload], tv = fragment[t.payload];
    if (mv > 1 || tv > 1) throw new Error('unsupported MP4 timing version');
    needPayload(m, mv ? 24 : 16); needPayload(t, tv ? 12 : 8);
    var timescale = uint32(init, m.payload + (mv ? 20 : 12));
    if (!timescale) throw new Error('invalid track timescale');
    return { timescale: timescale, baseTime: tv ? uint64(fragment, t.payload + 4) : uint32(fragment, t.payload + 4) };
  }
  /**
   * An H.264 init segment's video track (for feeding a decoder packet by packet, e.g. Samsung's EMSS):
   * { timescale, codec ('avc1.PPCCLL'), extradata (the avcC payload), width, height }.
   */
  function videoTrack(init) {
    var all = boxes(init, 0, init.length), mdhd = collect(init, all, 'mdhd'), avc1 = collect(init, all, 'avc1');
    if (mdhd.length !== 1 || avc1.length !== 1) throw new Error('not one H.264 video track');
    var m = mdhd[0], v = avc1[0];
    needPayload(m, 24); needPayload(v, 78);
    var avcC = boxes(init, v.payload + 78, v.end).filter(function (b) { return b.type === 'avcC'; })[0];
    if (!avcC) throw new Error('no avcC');
    needPayload(avcC, 4);
    var hex = '';
    for (var i = 1; i < 4; i++) hex += (init[avcC.payload + i] < 16 ? '0' : '') + init[avcC.payload + i].toString(16);
    return { timescale: uint32(init, m.payload + (init[m.payload] ? 20 : 12)), codec: 'avc1.' + hex.toUpperCase(),
      extradata: init.slice(avcC.payload, avcC.end), width: init[v.payload + 24] * 256 + init[v.payload + 25],
      height: init[v.payload + 26] * 256 + init[v.payload + 27] };
  }
  /**
   * A fragmented MP4 media segment's samples (one track; every moof + mdat pair):
   * [{ pts, dts, duration (seconds), key, data (a view into `fragment`) }].
   */
  function samples(fragment, timescale) {
    var out = [], moof = null;
    boxes(fragment, 0, fragment.length).forEach(function (box) {
      if (box.type === 'moof') { moof = box; return; }
      if (box.type !== 'mdat' || !moof) return;
      var inner = boxes(fragment, moof.payload, moof.end);
      var tfhd = collect(fragment, inner, 'tfhd')[0], tfdt = collect(fragment, inner, 'tfdt')[0], trun = collect(fragment, inner, 'trun')[0];
      if (!tfhd || !tfdt || !trun) throw new Error('fragment without tfhd/tfdt/trun');
      var q = tfhd.payload, tf = uint32(fragment, q) % 16777216; q += 8;
      if (tf & 1) q += 8;
      if (tf & 2) q += 4;
      var defDur = 0, defSize = 0, defFlags = 0;
      if (tf & 8) { defDur = uint32(fragment, q); q += 4; }
      if (tf & 16) { defSize = uint32(fragment, q); q += 4; }
      if (tf & 32) defFlags = uint32(fragment, q);
      var dts = fragment[tfdt.payload] ? uint64(fragment, tfdt.payload + 4) : uint32(fragment, tfdt.payload + 4);
      var r = trun.payload, rv = fragment[r], rf = uint32(fragment, r) % 16777216, count = uint32(fragment, r + 4);
      r += 8;
      var at = box.payload, firstFlags = null;
      if (rf & 1) { var off = uint32(fragment, r); at = moof.start + (off > 2147483647 ? off - 4294967296 : off); r += 4; }
      if (rf & 4) { firstFlags = uint32(fragment, r); r += 4; }
      for (var i = 0; i < count; i++) {
        var dur = defDur, size = defSize, flags = i === 0 && firstFlags !== null ? firstFlags : defFlags, cto = 0;
        if (rf & 0x100) { dur = uint32(fragment, r); r += 4; }
        if (rf & 0x200) { size = uint32(fragment, r); r += 4; }
        if (rf & 0x400) { flags = uint32(fragment, r); r += 4; }
        if (rf & 0x800) { cto = uint32(fragment, r); if (rv && cto > 2147483647) cto -= 4294967296; r += 4; }
        if (at + size > fragment.length) throw new Error('sample beyond its segment');
        out.push({ pts: (dts + cto) / timescale, dts: dts / timescale, duration: dur / timescale, key: !(flags & 0x10000), data: fragment.subarray(at, at + size) });
        at += size; dts += dur;
      }
      moof = null;
    });
    return out;
  }
  function encryption(init) {
    var root = boxes(init, 0, init.length), descriptions = collect(init, root, 'tenc'), schemes = collect(init, root, 'schm');
    if (!descriptions.length) return null;
    if (descriptions.length !== 1 || schemes.length !== 1) throw new Error('ambiguous encryption metadata');
    var t = descriptions[0], s = schemes[0];
    needPayload(t, 24); needPayload(s, 12);
    if (init[t.payload] > 1 || init[t.payload + 6] !== 1) throw new Error('unsupported track encryption metadata');
    var hex = '';
    for (var i = 0; i < 16; i++) hex += ('0' + init[t.payload + 8 + i].toString(16)).slice(-2);
    return { kid: hex.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5'), scheme: name(init, s.payload + 4) };
  }
  function parts(url) {
    var q = url.search(/[?#]/), path = q < 0 ? url : url.slice(0, q), slash = path.lastIndexOf('/');
    return { prefix: path.slice(0, slash + 1), file: path.slice(slash + 1), suffix: q < 0 ? '' : url.slice(q) };
  }
  function template(urls) {
    if (urls.length < 2) return null;
    var first = parts(urls[0]), matches = [], re = /\d+/g, match;
    while ((match = re.exec(first.file))) matches.push({ at: match.index, text: match[0] });
    for (var i = 0; i < matches.length; i++) {
      var group = matches[i], start = +group.text;
      if (start > MAX_SAFE || start + urls.length > MAX_SAFE) continue;
      var width = /^0\d/.test(group.text) ? group.text.length : 0;
      var before = first.file.slice(0, group.at), after = first.file.slice(group.at + group.text.length);
      var fits = urls.every(function (url, k) {
        var p = parts(url), n = String(start + k);
        if (width) while (n.length < width) n = '0' + n;
        return p.prefix === first.prefix && p.suffix === first.suffix && p.file === before + n + after;
      });
      if (fits) return { media: first.prefix + before + '$Number' + (width ? '%0' + width + 'd' : '') + '$' + after + first.suffix,
        startNumber: start };
    }
    return null;
  }
  function playlist(text) {
    if (!/^#EXTM3U\s/.test(text) || !/^#EXT-X-ENDLIST\s*$/m.test(text)) throw new Error('requires a complete VOD playlist');
    if (/^#EXT-X-DISCONTINUITY\s*$/m.test(text)) throw new Error('unsupported media discontinuity');
    if (/^#EXT-X-BYTERANGE:|^#EXT-X-MAP:.*\bBYTERANGE=/m.test(text)) throw new Error('unsupported media byte range');
    var init = (/^#EXT-X-MAP:.*URI="([^"]+)"/m.exec(text) || [])[1], duration = null, segments = [], keys = [];
    if (!init) throw new Error('missing CMAF initialization map');
    text.split(/\r?\n/).forEach(function (line) {
      if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) keys.push(line);
      else if (/^#EXTINF:/.test(line)) {
        if (duration !== null) throw new Error('missing URI for media segment');
        duration = parseFloat(line.slice(8));
      } else if (line.trim() && line.charAt(0) !== '#') {
        if (!positive(duration)) throw new Error('invalid media segment duration');
        segments.push({ uri: line.trim(), duration: duration }); duration = null;
      }
    });
    if (!segments.length || duration !== null) throw new Error('incomplete media segments');
    return { init: init, segments: segments, keys: keys };
  }
  function xml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function positive(n) { return typeof n === 'number' && isFinite(n) && n > 0; }
  function timeline(track) {
    var scale = track.timing.timescale, runs = [];
    track.segments.forEach(function (s) {
      if (!positive(s.duration)) throw new Error('invalid media segment duration');
      var d = Math.round(s.duration * scale);
      if (!d) throw new Error('media segment duration rounds to zero');
      var last = runs[runs.length - 1];
      if (last && last.d === d) last.r++;
      else runs.push({ d: d, r: 0 });
    });
    return '<SegmentTimeline>' + runs.map(function (r, i) {
      return '<S' + (i ? '' : ' t="' + track.timing.baseTime + '"') + ' d="' + r.d + '"' + (r.r ? ' r="' + r.r + '"' : '') + '/>';
    }).join('') + '</SegmentTimeline>';
  }
  function addressing(track, inferred) {
    var common = ' timescale="' + track.timing.timescale + '" presentationTimeOffset="' + track.timing.baseTime + '"';
    if (inferred) return '<SegmentTemplate' + common + ' startNumber="' + inferred.startNumber + '" initialization="' + xml(track.init) +
      '" media="' + xml(inferred.media) + '">' + timeline(track) + '</SegmentTemplate>';
    return '<SegmentList' + common + '><Initialization sourceURL="' + xml(track.init) + '"/>' + timeline(track) +
      track.segments.map(function (s) { return '<SegmentURL media="' + xml(s.url) + '"/>'; }).join('') + '</SegmentList>';
  }
  function protection(p) {
    if (!p) return '';
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(p.kid)) throw new Error('invalid public encryption key identifier');
    return '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="' + p.kid + '"/>' +
      '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>' + xml(p.pssh) + '</cenc:pssh></ContentProtection>';
  }
  function manifest(tracks) {
    if (!tracks.length) throw new Error('no media tracks');
    var inferred = tracks.map(function (t) {
      if (!t.segments.length || !positive(t.timing.timescale) || t.timing.baseTime < 0 || t.timing.baseTime > MAX_SAFE) throw new Error('invalid media timing');
      return template(t.segments.map(function (s) { return s.url; }));
    });
    var duration = Math.max.apply(Math, tracks.map(function (t) { return t.segments.reduce(function (n, s) { return n + s.duration; }, 0); }));
    var profile = inferred.every(function (t) { return !!t; }) ? 'isoff-live' : 'isoff-main';
    var groups = [];
    tracks.forEach(function (t, i) {
      var group = groups.filter(function (g) {
        return g[0].t.type === t.type && g[0].t.hdr === t.hdr && g[0].t.language === t.language &&
          JSON.stringify(g[0].t.protection) === JSON.stringify(t.protection);
      })[0];
      if (!group) { group = []; groups.push(group); }
      group.push({ t: t, inferred: inferred[i] });
    });
    return '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="static" profiles="urn:mpeg:dash:profile:' + profile + ':2011" minBufferTime="PT2S" mediaPresentationDuration="PT' + duration + 'S"><Period start="PT0S">' +
      groups.map(function (group) {
        var t = group[0].t;
        var video = t.type === 'video';
        var adaptation = '<AdaptationSet contentType="' + t.type + '" mimeType="' + t.type + '/mp4" segmentAlignment="true"' + (t.language ? ' lang="' + xml(t.language) + '"' : '') + '>' + protection(t.protection);
        if (video && t.hdr) adaptation += '<EssentialProperty schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="18"/>';
        return adaptation + group.map(function (entry) {
          var t = entry.t;
          return '<Representation id="' + xml(t.id) + '" bandwidth="' + t.bandwidth + '" codecs="' + xml(t.codecs) + '"' +
            (video ? ' width="' + t.width + '" height="' + t.height + '"' : '') + '>' + addressing(t, entry.inferred) + '</Representation>';
        }).join('') + '</AdaptationSet>';
      }).join('') + '</Period></MPD>';
  }
  function put32(bytes, at, n) {
    bytes[at] = Math.floor(n / 16777216) % 256; bytes[at + 1] = Math.floor(n / 65536) % 256;
    bytes[at + 2] = Math.floor(n / 256) % 256; bytes[at + 3] = n % 256;
  }
  function equal(bytes, at, expected) {
    for (var i = 0; i < expected.length; i++) if (bytes[at + i] !== expected[i]) return false;
    return true;
  }
  function addPssh(init, pssh) {
    var p = boxes(pssh, 0, pssh.length);
    if (p.length !== 1 || p[0].type !== 'pssh' || pssh.length < 32) throw new Error('invalid PSSH initialization metadata');
    var root = boxes(init, 0, init.length), moov = root.filter(function (b) { return b.type === 'moov'; });
    if (moov.length !== 1) throw new Error('missing or ambiguous movie metadata');
    var existing = collect(init, root, 'pssh');
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].end - existing[i].start === pssh.length && equal(init, existing[i].start, pssh)) return new Uint8Array(init);
    }
    var m = moov[0], out = new Uint8Array(init.length + pssh.length), size = m.end - m.start + pssh.length;
    out.set(init.subarray(0, m.end), 0); out.set(pssh, m.end); out.set(init.subarray(m.end), m.end + pssh.length);
    if (m.header === 16) { put32(out, m.start + 8, Math.floor(size / 4294967296)); put32(out, m.start + 12, size % 4294967296); }
    else { if (size > 4294967295) throw new Error('movie metadata exceeds 32-bit size'); put32(out, m.start, size); }
    return out;
  }
  return { timing: timing, videoTrack: videoTrack, samples: samples, encryption: encryption, playlist: playlist, template: template, manifest: manifest, addPssh: addPssh };
});
