/*
 * Subtitles for native HDR replays. Above 1080p, AVPlay's own TTML renderer loops over one segment's
 * lines (hundreds of changes a second) and never moves on (QE55Q77A), so the app reads F1's stpp
 * subtitle segments itself and shows their cues at the player's position. Clear HDR multiviews take
 * theirs from the HLS master instead: WebVTT segments (tracks with `vtt` and a segment `list`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ttml = factory();
})(this, function () {
  'use strict';

  function attr(s, name) { var m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(s); return m ? m[1] : null; }

  /** A TTML time expression in seconds (clock time, optionally with frames, or an offset), or null. */
  function seconds(expr, frameRate, tickRate) {
    var m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/.exec(expr || '');
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +m[4] / frameRate : 0);
    m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(expr || '');
    if (!m) return null;
    return +m[1] * { h: 3600, m: 60, s: 1, ms: 0.001, f: 1 / frameRate, t: 1 / tickRate }[m[2]];
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, function (all, e) {
      if (e.charAt(0) !== '#') return ENTITIES[e] != null ? ENTITIES[e] : all;
      var code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1);
      try { return String.fromCodePoint(code); } catch (err) { return all; }
    });
  }

  /** The cues of one TTML document: [{ begin, end, text }], times in seconds as written. */
  function cues(xml) {
    var tt = /<tt\b[^>]*>/.exec(xml);
    if (!tt) return [];
    var frameRate = +attr(tt[0], 'ttp:frameRate') || 30, tickRate = +attr(tt[0], 'ttp:tickRate') || 1, out = [];
    xml.replace(/<p\b([^>]*?)(?:\/>|>([\s\S]*?)<\/p>)/g, function (all, a, body) {
      var begin = seconds(attr(a, 'begin'), frameRate, tickRate), end = seconds(attr(a, 'end'), frameRate, tickRate);
      var dur = seconds(attr(a, 'dur'), frameRate, tickRate);
      if (end == null && begin != null && dur != null) end = begin + dur;
      var text = decode((body || '').replace(/<br\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''))
        .split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean).join('\n');
      if (begin != null && end > begin && text) out.push({ begin: begin, end: end, text: text });
      return all;
    });
    return out;
  }

  function utf8(buffer) {
    var bytes = new Uint8Array(buffer), text;
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
    text = '';
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    try { text = decodeURIComponent(escape(text)); } catch (e) { /* keep Latin-1 */ }
    return text;
  }

  /** The TTML documents in an stpp segment (the XML sits in mdat, between binary boxes). */
  function documents(buffer) {
    return utf8(buffer).match(/<tt\b[\s\S]*?<\/tt>/g) || [];
  }

  /** A WebVTT time ("01:07:13.804" or "07:13.804") in seconds, or null. */
  function vttTime(t) {
    var m = /^(?:(\d+):)?(\d{2}):(\d{2}\.\d{3})$/.exec(t || '');
    return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : null;
  }

  /**
   * The cues of a WebVTT segment, on the media timeline: [{ begin, end, text }]. X-TIMESTAMP-MAP maps the cue
   * times onto it (F1's: LOCAL 0 at MPEGTS 0, so cue times are the stream's own seconds).
   */
  function vttCues(text) {
    var blocks = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    if (!/^WEBVTT/.test(blocks[0] || '')) return [];
    var map = /X-TIMESTAMP-MAP=([^\n]*)/.exec(blocks[0]), shift = 0;
    if (map) {
      var local = /LOCAL:([\d:.]+)/.exec(map[1]), ts = /MPEGTS:(\d+)/.exec(map[1]);
      shift = (ts ? +ts[1] / 90000 : 0) - (local ? vttTime(local[1]) || 0 : 0);
    }
    var out = [];
    blocks.slice(1).forEach(function (block) {
      var lines = block.split('\n'), k = 0;
      while (k < lines.length && lines[k].indexOf('-->') < 0) k++;
      var times = /^\s*([\d:.]+)\s+-->\s+([\d:.]+)/.exec(lines[k] || '');
      if (!times) return;
      var begin = vttTime(times[1]), end = vttTime(times[2]);
      var body = decode(lines.slice(k + 1).join('\n').replace(/<[^>]+>/g, ''))
        .split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean).join('\n');
      if (begin != null && end > begin && body) out.push({ begin: begin + shift, end: end + shift, text: body });
    });
    return out;
  }

  /**
   * The segment holding media time m (seconds) of a track { timescale, startNumber, runs: [{ t, d, r }] }
   * or { duration, offset }: { number, time (template ticks), start, end (seconds) }, or null.
   */
  function segmentAt(track, m) {
    if (track.list) {
      // A segment list ({ url, start, end } in seconds, in order): numbered from 0.
      var lo = 0, hi = track.list.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1, x = track.list[mid];
        if (m < x.start) hi = mid - 1; else if (m >= x.end) lo = mid + 1;
        else return { number: mid, time: x.start, start: x.start, end: x.end, url: x.url };
      }
      return null;
    }
    var ticks = m * track.timescale, n = track.startNumber;
    function seg(number, time, d) { return { number: number, time: time, start: time / track.timescale, end: (time + d) / track.timescale }; }
    if (track.runs && track.runs.length) {
      var t = 0;
      for (var i = 0; i < track.runs.length; i++) {
        var run = track.runs[i], following = track.runs[i + 1];
        if (run.t != null) t = run.t;
        if (!(run.d > 0) || ticks < t) return null;
        var count = run.r >= 0 ? run.r + 1 : (following && following.t != null ? Math.ceil((following.t - t) / run.d) : Infinity);
        var k = Math.floor((ticks - t) / run.d);
        if (k < count) return seg(n + k, t + k * run.d, run.d);
        n += count;
        t += count * run.d;
      }
      return null;
    }
    if (!(track.duration > 0)) return null;
    var j = Math.floor((ticks - track.offset) / track.duration);
    return j < 0 ? null : seg(n + j, track.offset + j * track.duration, track.duration);
  }

  /** A segment's address from the track's SegmentTemplate media pattern. */
  function url(track, s) {
    if (s.url) return s.url;
    var values = { RepresentationID: track.id, Number: s.number, Time: s.time, Bandwidth: track.bandwidth };
    var path = track.media.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, function (all, key, width) {
      var v = String(values[key]);
      if (width && key !== 'RepresentationID') while (v.length < +width) v = '0' + v;
      return v;
    }).replace(/\$\$/g, '$');
    return new URL(path, track.base).toString();
  }

  /**
   * Shows the cues of one of `tracks` at the player's position.
   *   opts.position(): seconds on the period timeline (null while unknown)
   *   opts.show({ text, ms } | { text: '' } | null): null when subtitles are switched off
   *   opts.same(a, b): whether two language codes match; opts.fetch: fetch()
   * select(lang) starts a language (null or an unknown one: off); stop() ends it all.
   */
  function reader(tracks, opts) {
    var track = null, loaded = {}, timer = null, shown = null, shownAt = 0, gen = 0;
    var get = opts.fetch || function (u) { return fetch(u); };
    var same = opts.same || function (a, b) { return a === b; };

    function load(s) {
      var entry = loaded[s.number];
      // Failed: retry after a few seconds (a CDN blip), not on every tick.
      if (entry && (!entry.failed || Date.now() - entry.at < 4000)) return;
      var g = gen, mine = loaded[s.number] = { at: Date.now(), cues: [] };
      get(url(track, s)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buffer) {
        if (g !== gen || loaded[s.number] !== mine) return;
        var found = track.vtt ? vttCues(utf8(buffer)) : documents(buffer).reduce(function (all, xml) { return all.concat(cues(xml)); }, []);
        mine.cues = found.map(function (c) {
          // Some packagers time cues from the segment's start instead of on the track's timeline.
          return c.begin < s.start - 3600 ? { begin: c.begin + s.start, end: c.end + s.start, text: c.text } : c;
        });
        tick();
      }).catch(function () { if (g === gen && loaded[s.number] === mine) mine.failed = true; });
    }

    function show(text, ms) {
      // A change at once; the same line again each second, so the box stays up through a pause.
      if (text === shown && (!text || Date.now() - shownAt < 1000)) return;
      shown = text;
      shownAt = Date.now();
      opts.show(text ? { text: text, ms: Math.max(0, Math.round(ms)) } : { text: '' });
    }

    function tick() {
      if (!track) return;
      var p = opts.position();
      if (p == null || !isFinite(p)) return;
      var m = p + (track.offset || 0) / (track.timescale || 1), s = segmentAt(track, m);
      if (!s) return show('', 0);
      load(s);
      var next = segmentAt(track, s.end + 0.001);
      if (next) load(next);
      // Keep only the segments around the playhead; a seek back loads its segments again.
      Object.keys(loaded).forEach(function (n) { if (Math.abs(n - s.number) > 3) delete loaded[n]; });
      // F1 repeats each cue in the following segments: one line per text.
      var active = [], texts = {};
      [s.number - 1, s.number].forEach(function (n) {
        ((loaded[n] && loaded[n].cues) || []).forEach(function (c) {
          if (c.begin <= m && m < c.end && !texts[c.text]) { texts[c.text] = true; active.push(c); }
        });
      });
      active.sort(function (a, b) { return a.begin - b.begin; });
      show(active.map(function (c) { return c.text; }).join('\n'),
        active.length ? Math.min.apply(Math, active.map(function (c) { return (c.end - m) * 1000; })) : 0);
    }

    function select(lang) {
      gen++;
      loaded = {};
      shown = null;
      track = (lang && tracks.filter(function (t) { return same(t.lang, lang); })[0]) || null;
      if (!track) {
        if (timer) { clearInterval(timer); timer = null; }
        opts.show(null);
        return;
      }
      if (!timer) timer = setInterval(tick, 200);
      tick();
    }

    function stop() {
      gen++;
      track = null;
      loaded = {};
      if (timer) { clearInterval(timer); timer = null; }
    }

    return { select: select, stop: stop, langs: function () { return tracks.map(function (t) { return t.lang; }); } };
  }

  return { seconds: seconds, cues: cues, documents: documents, vttCues: vttCues, segmentAt: segmentAt, url: url, reader: reader };
});
