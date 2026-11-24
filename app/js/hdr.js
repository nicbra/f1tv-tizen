/* Encrypted HLG (replays and live) over native DASH. No decryption or licence handling here. */
var HdrStream = (function () {
  var LOCAL = 'http://127.0.0.1:18765';
  // An HDR answer or feeds this app can't use ('content'), or a media request that failed ('transient'): js/failure.js.
  function fail(why, cause) {
    var e = new Error('HDR: ' + why);
    e.failure = cause || 'content';
    e.diag = { code: e.failure === 'transient' ? 'NETWORK_ERROR' : 'UNSUPPORTED', platform: null };
    throw e;
  }
  function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function attr(s, name) { var m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(s); return m ? m[1] : ''; }
  function attrs(s) {
    var out = {}, re = /(?:^|,)\s*([\w-]+)=("[^"]*"|[^,]*)/g, m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }
  function id(s) {
    var m = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i.exec(s);
    if (m) return m[0].toLowerCase();
    m = /(?:^|[^a-f0-9])([a-f0-9]{32})(?:$|[^a-f0-9])/i.exec(s);
    if (!m) return fail('missing encryption identifier');
    return m[1].toLowerCase().replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
  }
  function b64url(s) { return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  /** A media URL through the helper's audio route, which corrects F1's CBCS audio sample counts. */
  function viaHelper(url) {
    var q = url.search(/[?#]/), path = q < 0 ? url : url.slice(0, q), slash = path.lastIndexOf('/');
    return LOCAL + '/s/' + b64url(url.slice(0, slash + 1)) + '/' + url.slice(slash + 1);
  }
  function note(kind, data) { if (typeof Diag !== 'undefined') Diag.note(kind, data); }
  var LANG3 = { en: 'eng', de: 'deu', fr: 'fra', nl: 'nld', pt: 'por', ja: 'jpn', es: 'spa', it: 'ita' };
  function lang3(l) { l = String(l || '').toLowerCase(); return LANG3[l] || l; }
  function total(segments) { return segments.reduce(function (n, s) { return n + s.duration; }, 0); }

  /*
   * F1's replays can carry EXT-X-DISCONTINUITY where the packager restarted, while the media timestamps run on to the
   * tick (São Paulo 2026: one at segment 1240 of 1396 in every feed's video and sound; only the wall clock jumped,
   * 11.52 s, which the PROGRAM-DATE-TIME marks keep). The single DASH timeline built here holds only then: the first
   * segment after each break (CmafDash.playlist breaks) is read, and must start where the durations before it end.
   * known: { init (bytes), timing } of the playlist when the caller has them. Resolves, or fails.
   */
  function continuous(io, parsed, base, known) {
    var breaks = parsed.breaks || [];
    if (!breaks.length) return Promise.resolve();
    if (breaks.length > 4) return Promise.resolve().then(function () { fail('unsupported media discontinuity (' + breaks.length + ')'); });
    var url = function (n) { return new URL(parsed.segments[n].uri, base).toString(); };
    var start$ = known ? Promise.resolve(known) : Promise.all([io.get(new URL(parsed.init, base).toString(), true), io.get(url(0), true, true)])
      .then(function (d) { return { init: d[0], timing: CmafDash.timing(d[0], d[1]) }; });
    return start$.then(function (k) {
      return Promise.all(breaks.map(function (n) {
        return io.get(url(n), true, true).then(function (fragment) {
          var at = CmafDash.timing(k.init, fragment).baseTime, want = k.timing.baseTime + total(parsed.segments.slice(0, n)) * k.timing.timescale;
          // The DASH timeline is built from the EXTINF durations: they must meet the media's own clock (F1's did to the
          // tick), within 0.1 s.
          if (Math.abs(at - want) > 0.1 * k.timing.timescale) fail('unsupported media discontinuity (timestamps jump at segment ' + n + ')');
        });
      }));
    });
  }

  /** The same breaks (or none) in every playlist of a set that shares one timeline (a grid's feeds). */
  function sameBreaks(list) {
    var first = String((list[0] && list[0].breaks) || []);
    list.forEach(function (x) { if (String(x.breaks || []) !== first) fail('feeds differ in discontinuities'); });
  }
  function binary(kid) { return kid.replace(/-/g, '').match(/../g).map(function (x) { return String.fromCharCode(parseInt(x, 16)); }).join(''); }
  function psshFor(source, kid) {
    var raw = atob(source.pssh), before = binary(source.kid);
    if (raw.indexOf(before) < 0) return fail('Widevine identifier missing from initialization metadata');
    return btoa(raw.split(before).join(binary(kid)));
  }
  function kind(set) {
    var head = set.slice(0, set.indexOf('>')), type = attr(head, 'contentType');
    return type === 'application' && /^(stpp|wvtt)/.test(attr(head, 'codecs')) ? 'text' : type;
  }
  /** The official video's CBCS Widevine metadata: { kid, pssh }. */
  function widevine(video) {
    var kid = /\bcenc:default_KID="([^"]+)"/.exec(video);
    var wv = (video.match(/<ContentProtection\b[^>]*>[\s\S]*?<\/ContentProtection>/g) || []).filter(function (s) { return /urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/.test(s); })[0];
    var pssh = wv && /<cenc:pssh\b[^>]*>([^<]+)<\/cenc:pssh>/.exec(wv);
    if (!kid || !pssh || !/value="cbcs"/.test(video)) return fail('unsupported Widevine protection');
    return { kid: id(kid[1]), pssh: pssh[1].trim() };
  }
  /** HLS key lines must all name the media's own key, as Apple's SAMPLE-AES. */
  function checkKeys(lines, kid) {
    if (!lines.length) return fail('missing CBCS declaration');
    lines.forEach(function (line) {
      var a = attrs(line.slice(line.indexOf(':') + 1));
      if (a.METHOD !== 'SAMPLE-AES' || a.KEYFORMAT !== 'com.apple.streamingkeydelivery' || id(a.URI || '') !== kid) return fail('inconsistent CBCS keys');
    });
  }
  function runsOf(timeline) {
    var runs = [];
    (timeline || '').replace(/<S\b([^>]*)\/>/g, function (all, s) {
      runs.push({ t: attr(s, 't') === '' ? null : +attr(s, 't'), d: +attr(s, 'd'), r: attr(s, 'r') === '' ? 0 : +attr(s, 'r') });
      return all;
    });
    return runs;
  }
  /** Media time (ticks) of segment `number` on a SegmentTimeline, or null outside it. */
  function timeOf(clock, number) {
    var t = 0, n = clock.startNumber;
    for (var i = 0; i < clock.runs.length; i++) {
      var run = clock.runs[i], count = run.r + 1;
      if (run.t != null) t = run.t;
      if (number < n + count) return number >= n ? t + (number - n) * run.d : null;
      n += count;
      t += count * run.d;
    }
    return null;
  }
  function isoSeconds(d) {
    var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(d || '');
    return m ? +(m[1] || 0) * 86400 + +(m[2] || 0) * 3600 + +(m[3] || 0) * 60 + +(m[4] || 0) : 0;
  }
  /** fetch() for one preparation, all of it aborted after 12 s (or `ms`). */
  function fetcher(ms) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    function get(url, bytes, range) {
      return fetch(url, { signal: controller ? controller.signal : undefined, headers: range ? { Range: 'bytes=0-65535' } : {} }).then(function (r) {
        if (!r.ok) return fail('media request failed (' + r.status + ')', 'transient');
        return bytes ? r.arrayBuffer().then(function (b) { return new Uint8Array(b); }) :
          r.text().then(function (body) { return { body: body, url: r.url || url }; });
      });
    }
    var over = false;
    function deadline(work) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { over = true; if (controller) controller.abort(); var late = new Error('HDR preparation timed out'); late.failure = 'transient'; late.diag = { code: 'NETWORK_ERROR', platform: null }; reject(late); }, ms || 12000);
        work.then(function (value) { clearTimeout(timer); resolve(value); }, function (e) { clearTimeout(timer); over = true; if (controller) controller.abort(); reject(e); });
      });
    }
    // signal: for this preparation's other requests; expired(): it timed out or failed (later work must not go on).
    return { get: get, deadline: deadline, signal: controller ? controller.signal : undefined, expired: function () { return over; } };
  }
  function official(mpd, url, langs) {
    if (!/<MPD\b[^>]*\btype="static"/.test(mpd) || (mpd.match(/<Period\b/g) || []).length !== 1 || /<BaseURL\b/.test(mpd)) return fail('unsupported Widevine VOD layout');
    var period = /<Period\b([^>]*)>/.exec(mpd);
    var bindings = {}, namespace = /\sxmlns:([\w-]+)="([^"]*)"/g, declaration;
    var scope = (/<MPD\b[^>]*>/.exec(mpd) || [''])[0] + (period ? period[1] : '');
    while ((declaration = namespace.exec(scope))) {
      var prefix = declaration[1], uri = declaration[2];
      if ((bindings[prefix] && bindings[prefix] !== uri) || (prefix === 'cenc' && uri !== 'urn:mpeg:cenc:2013')) return fail('ambiguous XML namespaces');
      bindings[prefix] = uri;
    }
    if (period && attr(period[1], 'start') && !/^PT0(?:\.0+)?S$/.test(attr(period[1], 'start'))) return fail('unsupported period origin');
    var sets = mpd.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g) || [];
    var video = sets.filter(function (s) { return kind(s) === 'video'; })[0];
    if (!video) return fail('missing Widevine video metadata');
    var protection = widevine(video), template = /<SegmentTemplate\b([^>]*)>/.exec(video);
    if (!template) return fail('unsupported Widevine protection');
    var timescale = +attr(template[1], 'timescale') || 1, offset = +attr(template[1], 'presentationTimeOffset');
    if (!(offset > 0)) return fail('missing source presentation clock');
    var base = new URL('.', url).toString();
    var encoded = b64url(base);
    var audio = sets.filter(function (s) { return kind(s) === 'audio'; });
    if (!audio.length) return fail('missing commentary');
    // Preserve complete official adaptations, including their distinct DRM metadata and clocks.
    audio = audio.map(function (s) {
      return s.replace(/^(<AdaptationSet\b[^>]*>)/, '$1<BaseURL>' + xml(LOCAL + '/s/' + encoded + '/') + '</BaseURL>');
    });
    // AVPlay starts on the first commentary.
    var pick = audio.filter(function (s) { return lang3(attr(s.slice(0, s.indexOf('>')), 'lang')) === lang3(langs.audio); })[0];
    if (pick) audio = [pick].concat(audio.filter(function (s) { return s !== pick; }));
    // Subtitles stay out of AVPlay's manifest: the app shows them (ttml.js).
    var subtitles = sets.filter(function (s) { return kind(s) === 'text'; }).map(function (s) { return subtitle(s, base); }).filter(Boolean);
    return { kid: protection.kid, pssh: protection.pssh, epoch: offset / timescale, others: audio.join(''), subtitles: subtitles,
      langs: audio.map(function (s) { return attr(s.slice(0, s.indexOf('>')), 'lang'); }),
      namespaces: Object.keys(bindings).filter(function (p) { return p !== 'cenc'; }).map(function (p) { return ' xmlns:' + p + '="' + bindings[p] + '"'; }).join('') };
  }
  /** An stpp subtitle set's segment addressing (for ttml.js), or null for other formats. */
  function subtitle(set, base) {
    var head = set.slice(0, set.indexOf('>')), rep = /<Representation\b([^>]*)>/.exec(set);
    var template = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/.exec(set);
    if (!rep || !template || !/^stpp/.test(attr(head, 'codecs') || attr(rep[1], 'codecs'))) return null;
    var own = /<BaseURL>([^<]*)<\/BaseURL>/.exec(set), a = template[1], runs = runsOf(template[2]);
    if (!attr(a, 'media') || (!runs.length && !(+attr(a, 'duration') > 0))) return null;
    return { lang: attr(head, 'lang') || attr(rep[1], 'lang'), base: own ? new URL(own[1].trim(), base).toString() : base,
      id: attr(rep[1], 'id'), bandwidth: attr(rep[1], 'bandwidth'), media: attr(a, 'media').replace(/&amp;/g, '&'),
      timescale: +attr(a, 'timescale') || 1, offset: +attr(a, 'presentationTimeOffset') || 0,
      startNumber: attr(a, 'startNumber') === '' ? 1 : +attr(a, 'startNumber'), duration: +attr(a, 'duration') || 0, runs: runs };
  }
  function variants(master) {
    if (!/^#EXTM3U\s/.test(master)) return fail('invalid HLS master');
    var lines = master.split(/\r?\n/), choices = [];
    lines.forEach(function (line, i) {
      if (!/^#EXT-X-STREAM-INF:/.test(line)) return;
      var a = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
      var codec = (a.CODECS || '').split(',').filter(function (c) { return /^(hev1|hvc1)\./.test(c); })[0];
      if (a['VIDEO-RANGE'] === 'HLG' && size && +size[2] <= 2160 && codec && +a.BANDWIDTH > 0) choices.push({ a: a, width: +size[1], height: +size[2], codec: codec, uri: (lines[i + 1] || '').trim() });
    });
    choices.sort(function (a, b) { return b.height - a.height || b.a.BANDWIDTH - a.a.BANDWIDTH; });
    if (!choices.length) return fail('no HLG qualities');
    var group = choices[0].a.AUDIO, seen = {};
    return choices.filter(function (v) {
      if (!v.uri || v.uri.charAt(0) === '#' || v.a.AUDIO !== group || seen[v.height]) return false;
      seen[v.height] = true; return true;
    });
  }
  /**
   * The HLS master's multichannel commentary as DASH audio tracks: F1's shows and the F1 LIVE feed carry AC-3 5.1
   * beside the stereo AAC in the 4K HDR offers (the official Widevine offer is stereo only). On the video's key
   * and clock, through the helper (the segments' sample counts need the same correction as the official audio).
   * Optional: its own requests, which must be done by `until` (ms, so the preparation's own deadline is never
   * reached because of it). Resolves [] when there is none, it doesn't fit or fails, or time is up: stereo plays then.
   * Tracks carry their own key id (`kid`); the caller keeps them only on the video's key.
   */
  function surround(master, masterUrl, epoch, until) {
    var lines = master.split(/\r?\n/), codecs = {};
    lines.forEach(function (line) {
      if (!/^#EXT-X-STREAM-INF:/.test(line)) return;
      var a = attrs(line.slice(18)), codec = (a.CODECS || '').split(',').map(function (c) { return c.trim(); })
        .filter(function (c) { return c === 'ac-3' || c === 'ec-3'; })[0];
      if (a.AUDIO && codec) codecs[a.AUDIO] = codec;
    });
    var list = lines.filter(function (l) { return /^#EXT-X-MEDIA:/.test(l); }).map(function (l) { return attrs(l.slice(13)); })
      .filter(function (a) { return a.TYPE === 'AUDIO' && a.URI && codecs[a['GROUP-ID']] && parseInt(a.CHANNELS, 10) > 2; });
    if (!list.length) return Promise.resolve([]);
    var left = Math.min(until - Date.now(), 6000);   // never more than 6 s of waiting for it
    if (left < 1000) { note('hdr.surround_skipped', { why: 'no time left' }); return Promise.resolve([]); }
    var io = fetcher(left);
    return io.deadline(Promise.all(list.map(function (a, i) {
      return Promise.resolve().then(function () { return io.get(new URL(a.URI, masterUrl).toString()); }).then(function (response) {
        var parsed = CmafDash.playlist(response.body, { breaks: true });
        var init = new URL(parsed.init, response.url).toString();
        var segments = parsed.segments.map(function (s) { return { url: new URL(s.uri, response.url).toString(), duration: s.duration }; });
        return Promise.all([io.get(init, true), io.get(segments[0].url, true, true)]).then(function (data) {
          var timing = CmafDash.timing(data[0], data[1]);
          return continuous(io, parsed, response.url, { init: data[0], timing: timing }).then(function () { return [data, timing]; });
        }).then(function (got) {
          var data = got[0], timing = got[1], own = CmafDash.encryption(data[0]);
          if (!own || own.scheme !== 'cbcs') return fail('surround not CBCS');
          checkKeys(parsed.keys, own.kid);
          if (Math.abs(timing.baseTime / timing.timescale - epoch) > 0.1) return fail('surround clock differs');
          return { type: 'audio', id: 'mc' + i, language: lang3(a.LANGUAGE) || 'und', codecs: codecs[a['GROUP-ID']],
            bandwidth: 384000, timing: timing, init: viaHelper(init), kid: own.kid,
            segments: segments.map(function (s) { return { url: viaHelper(s.url), duration: s.duration }; }) };
        });
      });
    }))).catch(function (e) { note('hdr.surround_skipped', { why: String(e && e.message || e).slice(0, 80) }); return []; });
  }
  /**
   * The manifest of `tracks` with the commentary: the 5.1 tracks on the video's key (`key`) and of the video's length,
   * and the official (stereo) ones from `source`. AVPlay starts on the first: 5.1 in the chosen language, else the
   * official one in it, else 5.1. Without the 5.1 when it can't be written. Returns { mpd, surround (count) }.
   */
  function withCommentary(tracks, multi, key, source, langs) {
    var length = total(tracks[0].segments);
    // The video sets the length: the 5.1 may end up to 0.5 s sooner (audio frames), but not later (it would lengthen it).
    var usable = multi.filter(function (t) { var d = total(t.segments) - length; return t.kid === key.kid && d <= 0.05 && d >= -0.5; }).map(function (t) {
      return { type: t.type, id: t.id, language: t.language, codecs: t.codecs, bandwidth: t.bandwidth, timing: t.timing,
        init: t.init, segments: t.segments, protection: key };
    });
    if (usable.length < multi.length) note('hdr.surround_skipped', { why: 'another key or length' });
    var lang = lang3((langs || {}).audio), official = source.langs.map(lang3);
    usable.sort(function (x, y) { return (y.language === lang) - (x.language === lang); });
    var first = usable.length > 0 && (!lang || usable[0].language === lang || official.indexOf(lang) < 0);
    var mpd;
    try { mpd = CmafDash.manifest(tracks.concat(usable)); } catch (e) {
      if (!usable.length) throw e;
      note('hdr.surround_skipped', { why: 'manifest: ' + String(e && e.message || e).slice(0, 60) });
      usable = []; first = false;
      mpd = CmafDash.manifest(tracks);
    }
    mpd = mpd.replace('<MPD ', '<MPD' + source.namespaces + ' ');
    var at = first ? mpd.indexOf('</Period>') : mpd.indexOf('<AdaptationSet contentType="audio"');
    if (at < 0) at = mpd.indexOf('</Period>');
    return { mpd: mpd.slice(0, at) + source.others + mpd.slice(at), surround: usable.length };
  }
  function build(stream, langs) {
    var io = fetcher(), get = io.get, until = Date.now() + 9000, want51 = (langs || {}).surround !== false;
    return io.deadline(Promise.all([get(stream.url), get(stream.widevineManifestUrl)]).then(function (sources) {
      var source = official(sources[1].body, sources[1].url, langs || {});
      var video$ = Promise.all(variants(sources[0].body).map(function (v, i) {
        var playlistUrl = new URL(v.uri, sources[0].url).toString();
        return get(playlistUrl).then(function (response) {
          playlistUrl = response.url;
          var parsed = CmafDash.playlist(response.body, { breaks: true });
          var segments = parsed.segments.map(function (s) { return { url: new URL(s.uri, playlistUrl).toString(), duration: s.duration }; });
          var init = new URL(parsed.init, playlistUrl).toString();
          return Promise.all([get(init, true), get(segments[0].url, true, true)]).then(function (data) {
            var timing = CmafDash.timing(data[0], data[1]);
            return continuous(io, parsed, playlistUrl, { init: data[0], timing: timing }).then(function () { return data; });
          }).then(function (data) {
            var timing = CmafDash.timing(data[0], data[1]), protection = CmafDash.encryption(data[0]);
            if (!protection || protection.scheme !== 'cbcs') return fail('unsupported media encryption');
            checkKeys(parsed.keys, protection.kid);
            if (Math.abs(timing.baseTime / timing.timescale - source.epoch) > 0.1) return fail('audio/video clocks differ');
            return { type: 'video', id: 'hlg' + i, hdr: true, width: v.width, height: v.height, codecs: v.codec,
              bandwidth: +v.a.BANDWIDTH, timing: timing, init: init, segments: segments,
              protection: { kid: protection.kid, pssh: psshFor(source, protection.kid) } };
          });
        });
      }));
      return Promise.all([video$, want51 ? surround(sources[0].body, sources[0].url, source.epoch, until) : []]).then(function (ready) {
        var made = withCommentary(ready[0], ready[1], ready[0][0].protection, source, langs);
        return { mpd: made.mpd, subtitles: source.subtitles, surround: made.surround };
      });
    }));
  }

  /**
   * Live 5.1: the HLS master's multichannel commentary (see surround) as audio AdaptationSets for the helper, which
   * gives them the official audio's SegmentTimeline on every manifest refresh. F1 numbers and times the HLS AC-3 and
   * the DASH AAC segments alike (48 kHz, 5.76 s; Las Vegas 2026 Pre-Race Show), checked here on a recent segment, and
   * they are on the video's key (`kid`). Optional like the replays' 5.1: resolves [] when anything doesn't fit.
   */
  function liveSurround(master, masterUrl, clock, kid, protection, until) {
    var lines = master.split(/\r?\n/), codecs = {};
    lines.forEach(function (line) {
      if (!/^#EXT-X-STREAM-INF:/.test(line)) return;
      var a = attrs(line.slice(18)), codec = (a.CODECS || '').split(',').map(function (c) { return c.trim(); })
        .filter(function (c) { return c === 'ac-3' || c === 'ec-3'; })[0];
      if (a.AUDIO && codec) codecs[a.AUDIO] = codec;
    });
    var list = lines.filter(function (l) { return /^#EXT-X-MEDIA:/.test(l); }).map(function (l) { return attrs(l.slice(13)); })
      .filter(function (a) { return a.TYPE === 'AUDIO' && a.URI && codecs[a['GROUP-ID']] && parseInt(a.CHANNELS, 10) > 2; });
    if (!list.length) return Promise.resolve([]);
    var left = Math.min(until - Date.now(), 6000);
    if (left < 1000) { note('hdr.surround_skipped', { why: 'no time left' }); return Promise.resolve([]); }
    var io = fetcher(left);
    return io.deadline(Promise.all(list.map(function (a, i) {
      // Inside the promise: a bad address must leave stereo, not fail the video (new URL throws).
      return Promise.resolve().then(function () { return io.get(new URL(a.URI, masterUrl).toString()); }).then(function (response) {
        var text = response.body, map = /^#EXT-X-MAP:.*URI="([^"]+)"/m.exec(text);
        var uris = text.split(/\r?\n/).filter(function (l) { return l.trim() && l.charAt(0) !== '#'; })
          .map(function (l) { return new URL(l.trim(), response.url).toString(); });
        if (!/^#EXTM3U\s/.test(text) || !map || uris.length < 4 || /^#EXT-X-(?:DISCONTINUITY\s*$|BYTERANGE:)/m.test(text)) return fail('unsupported live surround playlist');
        var recent = uris.slice(-4, -1), pattern = CmafDash.template(recent);
        if (!pattern) return fail('unsupported live surround segment names');
        var init = new URL(map[1], response.url).toString();
        return Promise.all([io.get(init, true), io.get(recent[0], true, true)]).then(function (data) {
          var own = CmafDash.encryption(data[0]);
          if (!own || own.scheme !== 'cbcs') return fail('surround not CBCS');
          if (own.kid !== kid) return fail('surround on another key');
          checkKeys(text.match(/^#EXT-X-KEY:.*$/gm) || [], own.kid);
          var timing = CmafDash.timing(data[0], data[1]);
          if (timing.timescale !== clock.timescale || timing.baseTime !== timeOf(clock, pattern.startNumber)) return fail('surround timeline differs');
          // The same cadence too (the manifest gives the 5.1 the official audio's segment durations): the recent
          // segments' lengths against the official timeline's, within an AC-3 frame (32 ms).
          var lengths = (text.match(/^#EXTINF:\s*([\d.]+)/gm) || []).map(function (l) { return parseFloat(l.slice(8)); }).slice(-4, -1);
          lengths.forEach(function (d, k) {
            var t0 = timeOf(clock, pattern.startNumber + k), t1 = timeOf(clock, pattern.startNumber + k + 1);
            if (t0 == null || t1 == null || Math.abs((t1 - t0) / clock.timescale - d) > 0.032) fail('surround segment lengths differ');
          });
          return '<AdaptationSet xmlns:cenc="urn:mpeg:cenc:2013" contentType="audio" mimeType="audio/mp4" lang="' + xml(lang3(a.LANGUAGE) || 'und') +
            '" segmentAlignment="true" startWithSAP="1">' + protection +
            '<Representation id="mc' + i + '" bandwidth="384000" codecs="' + xml(codecs[a['GROUP-ID']]) + '">' +
            '<SegmentTemplate timescale="' + clock.timescale + '" presentationTimeOffset="' + clock.offset + '" startNumber="' + clock.startNumber +
            '" initialization="' + xml(viaHelper(init)) + '" media="' + xml(viaHelper(pattern.media)) + '"><!--timeline--></SegmentTemplate></Representation></AdaptationSet>';
        });
      });
    }))).catch(function (e) { note('hdr.surround_skipped', { why: 'live: ' + String(e && e.message || e).slice(0, 74) }); return []; });
  }
  /**
   * Live: the HLG ladder as a video AdaptationSet for the stream helper, which puts it in place of the
   * official SDR video on every manifest refresh, with that video's current SegmentTimeline where
   * <!--timeline--> stands. F1 numbers and times the HLS and DASH segments alike (FP3, Mexico 2026);
   * that is checked here on a recent segment. With the 5.1 commentary where the HLS master has it (opts.surround not
   * false): its sets follow the video after <!--audio-->, each on the official audio's timeline (<!--timeline-->).
   * Resolves { adaptation, subtitles, surround (count) }.
   */
  function live(stream, opts) {
    var io = fetcher(), until = Date.now() + 9000, want51 = (opts || {}).surround !== false;
    return io.deadline(Promise.all([io.get(stream.url), io.get(stream.widevineManifestUrl)]).then(function (sources) {
      var mpd = sources[1].body, period = /<Period\b([^>]*)>/.exec(mpd);
      if (!/<MPD\b[^>]*\btype="dynamic"/.test(mpd) || (mpd.match(/<Period\b/g) || []).length !== 1 || /<BaseURL\b/.test(mpd)) return fail('unsupported Widevine live layout');
      // F1's live manifests bind cenc where it is used, not on the root: the HLG set declares its own.
      if (/\sxmlns:cenc="(?!urn:mpeg:cenc:2013")/.test(mpd)) return fail('ambiguous XML namespaces');
      var sets = mpd.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g) || [];
      var video = sets.filter(function (s) { return kind(s) === 'video'; })[0];
      if (!video) return fail('missing Widevine video metadata');
      var source = widevine(video), template = /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/.exec(video);
      if (!template || !/\$Number\$/.test(attr(template[1], 'media')) || !/<SegmentTimeline>/.test(template[2])) return fail('unsupported live addressing');
      var clock = { timescale: +attr(template[1], 'timescale') || 1, offset: +attr(template[1], 'presentationTimeOffset') || 0,
        startNumber: attr(template[1], 'startNumber') === '' ? 1 : +attr(template[1], 'startNumber'), runs: runsOf(template[2]) };
      var audio = sets.filter(function (s) { return kind(s) === 'audio'; })[0];
      var audioTemplate = audio && /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/.exec(audio);
      var audioClock = audioTemplate && /\$Number\$/.test(attr(audioTemplate[1], 'media')) && /<SegmentTimeline>/.test(audioTemplate[2]) ? {
        timescale: +attr(audioTemplate[1], 'timescale') || 1, offset: +attr(audioTemplate[1], 'presentationTimeOffset') || 0,
        startNumber: attr(audioTemplate[1], 'startNumber') === '' ? 1 : +attr(audioTemplate[1], 'startNumber'), runs: runsOf(audioTemplate[2]) } : null;
      var periodStart = isoSeconds(period ? attr(period[1], 'start') : '');
      var base = new URL('.', sources[1].url).toString();
      var subtitles = sets.filter(function (s) { return kind(s) === 'text'; }).map(function (s) { return subtitle(s, base); }).filter(Boolean).map(function (t) {
        // The timeline grows while live; player positions count from the period start.
        if (t.runs.length) t.runs[t.runs.length - 1].r = -1;
        t.offset -= periodStart * t.timescale;
        return t;
      });
      return Promise.all(variants(sources[0].body).map(function (v, i) {
        var playlistUrl = new URL(v.uri, sources[0].url).toString();
        return io.get(playlistUrl).then(function (response) {
          playlistUrl = response.url;
          var text = response.body, map = /^#EXT-X-MAP:.*URI="([^"]+)"/m.exec(text);
          var uris = text.split(/\r?\n/).filter(function (l) { return l.trim() && l.charAt(0) !== '#'; })
            .map(function (l) { return new URL(l.trim(), playlistUrl).toString(); });
          if (!/^#EXTM3U\s/.test(text) || !map || uris.length < 4 || /^#EXT-X-(?:DISCONTINUITY\s*$|BYTERANGE:)/m.test(text)) return fail('unsupported live playlist');
          // A few segments back from the newest: complete on the CDN.
          var recent = uris.slice(-4, -1), pattern = CmafDash.template(recent);
          if (!pattern) return fail('unsupported live segment names');
          var init = new URL(map[1], playlistUrl).toString();
          return Promise.all([io.get(init, true), i ? null : io.get(recent[0], true, true)]).then(function (data) {
            var protection = CmafDash.encryption(data[0]);
            if (!protection || protection.scheme !== 'cbcs') return fail('unsupported media encryption');
            checkKeys(text.match(/^#EXT-X-KEY:.*$/gm) || [], protection.kid);
            if (data[1]) {
              var timing = CmafDash.timing(data[0], data[1]);
              if (timing.timescale !== clock.timescale || timing.baseTime !== timeOf(clock, pattern.startNumber)) return fail('HLS and DASH timelines differ');
            }
            return { v: v, kid: protection.kid, init: init, media: pattern.media };
          });
        });
      })).then(function (tracks) {
        // One adaptation set: the qualities that share the top quality's key.
        var kid = tracks[0].kid;
        var reps = tracks.filter(function (t) { return t.kid === kid; }).map(function (t, i) {
          return '<Representation id="hlg' + i + '" bandwidth="' + (+t.v.a.BANDWIDTH) + '" codecs="' + xml(t.v.codec) + '" width="' + t.v.width + '" height="' + t.v.height + '">' +
            '<SegmentTemplate timescale="' + clock.timescale + '" presentationTimeOffset="' + clock.offset + '" startNumber="' + clock.startNumber +
            '" initialization="' + xml(t.init) + '" media="' + xml(t.media) + '"><!--timeline--></SegmentTemplate></Representation>';
        });
        var protection = '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="' + kid + '"/>' +
          '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>' + xml(psshFor(source, kid)) + '</cenc:pssh></ContentProtection>';
        var adaptation = '<AdaptationSet xmlns:cenc="urn:mpeg:cenc:2013" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">' +
          protection + '<EssentialProperty schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="18"/>' + reps.join('') + '</AdaptationSet>';
        if (!want51) return { adaptation: adaptation, subtitles: subtitles, surround: 0 };
        if (!audioClock) { note('hdr.surround_skipped', { why: 'live audio addressing' }); return { adaptation: adaptation, subtitles: subtitles, surround: 0 }; }
        return liveSurround(sources[0].body, sources[0].url, audioClock, kid, protection, until).then(function (more) {
          return { adaptation: adaptation + (more.length ? '<!--audio-->' + more.join('') : ''), subtitles: subtitles, surround: more.length };
        });
      });
    }));
  }
  /**
   * Multiview (experiment): the feeds' HEVC video arranged in a layout by the stream helper
   * (service/stitch-hevc.js), with the first feed's commentary. streams: the feeds' offers in the layout's
   * feed order: HDR ones (clear or hdrEncrypted) give their HLG variants, clear SDR HLS its SDR HEVC variants.
   * Resolves { mpd, subtitles, width, height }.
   */
  function grid(streams, layout, opts) {
    opts = opts || {};
    var known = typeof MultiviewLayouts !== 'undefined' && MultiviewLayouts.layouts[layout], heights = known && known.feeds;
    if (!heights || heights.length !== streams.length) return Promise.reject(new Error('HDR: layout ' + layout + ' needs ' + (heights ? heights.length : '?') + ' feeds'));
    var io = fetcher(20000), get = io.get, range = opts.range || gridRange(streams), id = opts.id, until = Date.now() + 16000;
    var want51 = (opts.langs || {}).surround !== false;
    // Encrypted HDR takes its commentary and Widevine metadata from the normal offer; clear HDR (some replays)
    // has its own audio in the HLS master.
    // opts.audio: the place of the feed whose commentary and subtitles play.
    var lead = opts.audio || 0, first = streams[lead], encrypted = !!first.hdrEncrypted;
    var official$ = encrypted ? get(first.widevineManifestUrl).then(function (dash) { return official(dash.body, dash.url, opts.langs || {}); }) : Promise.resolve(null);
    return io.deadline(official$.then(function (source) {
      return Promise.all(streams.map(function (stream, n) {
        var height = heights[n];
        return get(stream.url).then(function (master) {
          var lines = master.body.split(/\r?\n/), uri = null, a = null;
          lines.forEach(function (line, i) {
            if (uri || !/^#EXT-X-STREAM-INF:/.test(line)) return;
            var x = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(x.RESOLUTION || '');
            if (size && +size[2] === height && videoRange(x) === range && /(hev1|hvc1)\./.test(x.CODECS || '')) { uri = (lines[i + 1] || '').trim(); a = x; }
          });
          if (!uri) return fail('no ' + height + 'p ' + range + ' HEVC variant');
          return get(new URL(uri, master.url).toString()).then(function (response) {
            var parsed = CmafDash.playlist(response.body, { breaks: true });
            var urls = parsed.segments.map(function (s) { return new URL(s.uri, response.url).toString(); });
            return { init: new URL(parsed.init, response.url).toString(), urls: urls, durations: parsed.segments.map(function (s) { return s.duration; }),
              parsed: parsed, playlistUrl: response.url, breaks: parsed.breaks, keys: parsed.keys, bandwidth: +a.BANDWIDTH || 0, codec: (a.CODECS || '').split(',').filter(function (c) { return /^(hev1|hvc1)\./.test(c); })[0],
              master: master.body, masterUrl: master.url, audioGroup: a.AUDIO,
              audioCodec: (a.CODECS || '').split(',').filter(function (c) { return /^(mp4a|ac-3|ec-3)/.test(c); })[0] };
          });
        });
      })).then(function (feeds) {
        var count = feeds[0].urls.length;
        feeds.forEach(function (f) { if (f.urls.length !== count) fail('feeds differ in length'); });
        sameBreaks(feeds);
        return Promise.all([get(feeds[0].init, true), get(feeds[0].urls[0], true, true)]).then(function (data) {
          var timing = CmafDash.timing(data[0], data[1]);
          // Every feed of the grid (each could reset its own clock at the break): the first with what is read already.
          return Promise.all(feeds.map(function (f, n) {
            return continuous(io, f.parsed, f.playlistUrl, n === 0 ? { init: data[0], timing: timing } : null);
          })).then(function () { return data; });
        }).then(function (data) {
          var timing = CmafDash.timing(data[0], data[1]), protection = CmafDash.encryption(data[0]);
          if (encrypted) {
            if (!protection || protection.scheme !== 'cbcs') return fail('unsupported media encryption');
            feeds.forEach(function (f) { checkKeys(f.keys, protection.kid); });
            if (Math.abs(timing.baseTime / timing.timescale - source.epoch) > 0.1) return fail('audio/video clocks differ');
          } else if (protection || feeds.some(function (f) { return f.keys.length; })) return fail('encrypted media without a Widevine offer');
          var probe = 0, t = 0;
          while (opts.at > 0 && probe < feeds[0].durations.length - 1 && t + feeds[0].durations[probe] <= opts.at) t += feeds[0].durations[probe++];
          var body = { kind: 'hevc', layout: layout, probe: probe, ua: navigator.userAgent, feeds: feeds.map(function (f) {
            var tpl = CmafDash.template(f.urls);
            return tpl ? { init: f.init, media: tpl.media, startNumber: tpl.startNumber, count: f.urls.length } : { init: f.init, urls: f.urls };
          }) };
          var base = timing.baseTime / timing.timescale;
          return Promise.all([encrypted ? (want51 ? surround(feeds[lead].master, feeds[lead].masterUrl, source.epoch, until) : []) : audioTracks(io, feeds[lead], opts.langs || {}),
            encrypted ? source.subtitles : subtitleTracks(io, feeds[lead], base),
            fetch(LOCAL + '/stitch/' + id, { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
              return r.text().then(function (text) { if (!r.ok) return fail('grid helper: ' + text); return JSON.parse(text); });
            })]).then(function (done) {
            var audio = done[0], subtitles = done[1], info = done[2];
            var track = { type: 'video', id: 'grid', hdr: range === 'HLG', width: info.width, height: info.height, codecs: info.codecs,
              bandwidth: feeds.reduce(function (n, f) { return n + f.bandwidth; }, 0), timing: timing,
              init: LOCAL + '/stitch/' + id + '/init.mp4',
              segments: feeds[0].durations.map(function (d, n) { return { url: LOCAL + '/stitch/' + id + '/' + n + '.m4s', duration: d }; }),
              protection: encrypted ? { kid: protection.kid, pssh: psshFor(source, protection.kid) } : null };
            // Encrypted: the official commentary, and the sound feed's 5.1 (F1 LIVE) where it has one.
            var made = encrypted ? withCommentary([track], audio, track.protection, source, opts.langs) : { mpd: CmafDash.manifest([track].concat(audio)), surround: 0 };
            return { mpd: made.mpd, subtitles: subtitles, width: info.width, height: info.height, surround: made.surround };
          });
        });
      });
    }));
  }

  /**
   * Clear HDR: the commentary tracks of the first feed's HLS master (its variant's audio group), as DASH audio
   * tracks, the preferred language first (AVPlay starts on the first).
   */
  /**
   * A clear HDR stream's subtitles, from its HLS master: WebVTT segment lists for Ttml.reader, on the video's
   * timeline (`base`: the first segment's media time, the grid manifest's presentationTimeOffset). F1's cues
   * are timed from the stream's start (X-TIMESTAMP-MAP LOCAL 0 = MPEGTS 0). None, or a playlist that fails:
   * no subtitles rather than no multiview.
   */
  function subtitleTracks(io, feed, base) {
    var list = feed.master.split(/\r?\n/).filter(function (l) { return /^#EXT-X-MEDIA:/.test(l); })
      .map(function (l) { return attrs(l.slice(13)); }).filter(function (a) { return a.TYPE === 'SUBTITLES' && a.URI; });
    return Promise.all(list.map(function (a) {
      return io.get(new URL(a.URI, feed.masterUrl).toString()).then(function (response) {
        var t = base, segments = [], duration = null;
        response.body.split(/\r?\n/).forEach(function (line) {
          var inf = /^#EXTINF:([\d.]+)/.exec(line);
          if (inf) duration = +inf[1];
          else if (line && line.charAt(0) !== '#' && duration > 0) {
            segments.push({ url: new URL(line.trim(), response.url).toString(), start: t, end: t + duration });
            t += duration;
            duration = null;
          }
        });
        return segments.length ? { lang: a.LANGUAGE || 'und', vtt: true, list: segments, offset: base, timescale: 1 } : null;
      }, function () { return null; });
    })).then(function (tracks) { return tracks.filter(Boolean); });
  }

  function audioTracks(io, feed, langs) {
    var lines = feed.master.split(/\r?\n/).filter(function (l) { return /^#EXT-X-MEDIA:/.test(l); }), list = [];
    lines.forEach(function (l) {
      var a = attrs(l.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI && (!feed.audioGroup || a['GROUP-ID'] === feed.audioGroup)) list.push(a);
    });
    if (!list.length) return fail('no commentary in the HDR stream');
    list.sort(function (x, y) { return (y.LANGUAGE === langs.audio) - (x.LANGUAGE === langs.audio); });
    return Promise.all(list.map(function (a, i) {
      var url = new URL(a.URI, feed.masterUrl).toString();
      return io.get(url).then(function (response) {
        var parsed = CmafDash.playlist(response.body, { breaks: true });
        var segments = parsed.segments.map(function (s) { return { url: new URL(s.uri, response.url).toString(), duration: s.duration }; });
        var init = new URL(parsed.init, response.url).toString();
        return Promise.all([io.get(init, true), io.get(segments[0].url, true, true)]).then(function (data) {
          var timing = CmafDash.timing(data[0], data[1]);
          return continuous(io, parsed, response.url, { init: data[0], timing: timing }).then(function () {
            return { type: 'audio', id: 'a' + i, language: a.LANGUAGE || 'und', codecs: feed.audioCodec || 'mp4a.40.2', bandwidth: 128000,
              timing: timing, init: init, segments: segments };
          });
        });
      });
    }));
  }

  /**
   * Live multiview (experiment): like `live`, a video AdaptationSet for the stream helper to put in place of
   * the official video on every refresh, but its segments come from the helper's grid (/stitch/<id>/<n>.m4s),
   * which tiles the feeds' segment n. F1 numbers the HLS segments of every feed like the DASH ones (Mexico
   * 2026 race). Resolves { adaptation, subtitles }.
   */
  function liveGrid(streams, layout, opts) {
    opts = opts || {};
    var known = typeof MultiviewLayouts !== 'undefined' && MultiviewLayouts.layouts[layout], heights = known && known.feeds;
    if (!heights || heights.length !== streams.length) return Promise.reject(new Error('HDR: layout ' + layout + ' needs ' + (heights ? heights.length : '?') + ' feeds'));
    var io = fetcher(20000), id = opts.id, first = streams[opts.audio || 0];
    return io.deadline(io.get(first.widevineManifestUrl).then(function (dash) {
      var mpd = dash.body;
      if (!/<MPD\b[^>]*\btype="dynamic"/.test(mpd) || (mpd.match(/<Period\b/g) || []).length !== 1 || /<BaseURL\b/.test(mpd)) return fail('unsupported Widevine live layout');
      if (/\sxmlns:cenc="(?!urn:mpeg:cenc:2013")/.test(mpd)) return fail('ambiguous XML namespaces');
      var sets = mpd.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g) || [];
      var video = sets.filter(function (s) { return kind(s) === 'video'; })[0];
      if (!video) return fail('missing Widevine video metadata');
      var source = widevine(video), template = /<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/.exec(video);
      if (!template || !/\$Number\$/.test(attr(template[1], 'media')) || !/<SegmentTimeline>/.test(template[2])) return fail('unsupported live addressing');
      var clock = { timescale: +attr(template[1], 'timescale') || 1, offset: +attr(template[1], 'presentationTimeOffset') || 0,
        startNumber: attr(template[1], 'startNumber') === '' ? 1 : +attr(template[1], 'startNumber'), runs: runsOf(template[2]) };
      var period = /<Period\b([^>]*)>/.exec(mpd), periodStart = isoSeconds(period ? attr(period[1], 'start') : '');
      var base = new URL('.', dash.url).toString();
      var subtitles = sets.filter(function (s) { return kind(s) === 'text'; }).map(function (s) { return subtitle(s, base); }).filter(Boolean).map(function (t) {
        if (t.runs.length) t.runs[t.runs.length - 1].r = -1;
        t.offset -= periodStart * t.timescale;
        return t;
      });
      return Promise.all(streams.map(function (stream, n) {
        var height = heights[n];
        return io.get(stream.url).then(function (master) {
          var lines = master.body.split(/\r?\n/), uri = null, a = null;
          lines.forEach(function (line, i) {
            if (uri || !/^#EXT-X-STREAM-INF:/.test(line)) return;
            var x = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(x.RESOLUTION || '');
            if (size && +size[2] === height && x['VIDEO-RANGE'] === 'HLG' && /(hev1|hvc1)\./.test(x.CODECS || '')) { uri = (lines[i + 1] || '').trim(); a = x; }
          });
          if (!uri) return fail('no ' + height + 'p HLG variant');
          return io.get(new URL(uri, master.url).toString()).then(function (response) {
            var text = response.body, map = /^#EXT-X-MAP:.*URI="([^"]+)"/m.exec(text);
            var uris = text.split(/\r?\n/).filter(function (l) { return l.trim() && l.charAt(0) !== '#'; })
              .map(function (l) { return new URL(l.trim(), response.url).toString(); });
            if (!/^#EXTM3U\s/.test(text) || !map || uris.length < 4 || /^#EXT-X-(?:DISCONTINUITY\s*$|BYTERANGE:)/m.test(text)) return fail('unsupported live playlist');
            // A few segments back from the newest: complete on the CDN.
            var recent = uris.slice(-4, -1), pattern = CmafDash.template(recent);
            if (!pattern) return fail('unsupported live segment names');
            return { init: new URL(map[1], response.url).toString(), media: pattern.media, recent: pattern.startNumber, bandwidth: +a.BANDWIDTH || 0,
              sample: recent[0], keys: text.match(/^#EXT-X-KEY:.*$/gm) || [] };
          });
        });
      })).then(function (feeds) {
        var probe = Math.min.apply(Math, feeds.map(function (f) { return f.recent; }));
        return Promise.all([io.get(feeds[0].init, true), io.get(feeds[0].sample, true, true)]).then(function (data) {
          var protection = CmafDash.encryption(data[0]), timing = CmafDash.timing(data[0], data[1]);
          if (!protection || protection.scheme !== 'cbcs') return fail('unsupported media encryption');
          feeds.forEach(function (f) { checkKeys(f.keys, protection.kid); });
          if (timing.timescale !== clock.timescale || timing.baseTime !== timeOf(clock, feeds[0].recent)) return fail('HLS and DASH timelines differ');
          var body = { kind: 'hevc', layout: layout, live: true, probe: probe, ua: navigator.userAgent,
            feeds: feeds.map(function (f) { return { init: f.init, media: f.media, absolute: true }; }) };
          return fetch(LOCAL + '/stitch/' + id, { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
            return r.text().then(function (txt) {
              if (!r.ok) return fail('grid helper: ' + txt);
              var info = JSON.parse(txt), local = LOCAL + '/stitch/' + id;
              var rep = '<Representation id="grid" bandwidth="' + feeds.reduce(function (n, f) { return n + f.bandwidth; }, 0) + '" codecs="' + xml(info.codecs) +
                '" width="' + info.width + '" height="' + info.height + '"><SegmentTemplate timescale="' + clock.timescale + '" presentationTimeOffset="' + clock.offset +
                '" startNumber="' + clock.startNumber + '" initialization="' + xml(local + '/init.mp4') + '" media="' + xml(local + '/$Number$.m4s') + '"><!--timeline--></SegmentTemplate></Representation>';
              return {
                adaptation: '<AdaptationSet xmlns:cenc="urn:mpeg:cenc:2013" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">' +
                  '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="' + protection.kid + '"/>' +
                  '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>' + xml(psshFor(source, protection.kid)) + '</cenc:pssh></ContentProtection>' +
                  '<EssentialProperty schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="18"/>' + rep + '</AdaptationSet>',
                subtitles: subtitles
              };
            });
          });
        });
      });
    }));
  }

  /**
   * Multiview from F1's player_tm feeds (HDR_UHD_HLSCK: HLG HEVC in AES-128 TS). The stream helper decrypts, unpacks and
   * stitches the feeds' segments (service/tm-ts.js) into one clear picture, as from the CMAF offers (the same encode),
   * and serves an HLS master for Shaka: the grid's playlist (the first feed's, rewritten: replays and live alike) as
   * its video, and the commentary and subtitles of the sound feed's own master (F1's AES-128 playlists, which Shaka
   * plays like a single player_tm feed). TRACKER and DATA have no sound in player_tm (F1's player takes another
   * feed's): `sound` lists masters to take it from, in order.
   * masters: each place's player_tm master URL; opts: { id, sound: [master URL], at (replay seconds) or wall (clock time,
   * Unix seconds), keyHeaders }.
   * Resolves { url, width, height, start } (start: where the replay's first prepared segment begins, seconds).
   */
  function tmGrid(masters, layout, opts) {
    opts = opts || {};
    var known = typeof MultiviewLayouts !== 'undefined' && MultiviewLayouts.layouts[layout], heights = known && known.feeds;
    if (!heights || heights.length !== masters.length) return Promise.reject(new Error('HDR: layout ' + layout + ' needs ' + (heights ? heights.length : '?') + ' feeds'));
    var io = fetcher(20000), keys = {}, id = opts.id;
    function key(uri) {
      // The account's tokens go to F1's key server only (as Shaka's key filter in player.js does), never redirected.
      if (!/^https:\/\/f1tv\.formula1\.com\//.test(uri)) return Promise.reject(new Error('HDR: player_tm key not on F1\'s key server'));
      if (!keys[uri]) {
        keys[uri] = fetch(uri, { headers: opts.keyHeaders || {}, redirect: 'error', signal: io.signal }).then(function (r) {
          if (!r.ok) return fail('player_tm key: HTTP ' + r.status);
          return r.arrayBuffer();
        }).then(function (b) {
          var u = new Uint8Array(b), hex = '';
          if (u.length !== 16) return fail('player_tm key is not 16 bytes');
          for (var i = 0; i < 16; i++) hex += (u[i] < 16 ? '0' : '') + u[i].toString(16);
          return hex;
        });
      }
      return keys[uri];
    }
    function variantOf(url, height) {
      return io.get(url).then(function (master) {
        var lines = master.body.split(/\r?\n/), uri = null, a = null;
        lines.forEach(function (line, i) {
          if (uri || !/^#EXT-X-STREAM-INF:/.test(line)) return;
          var x = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(x.RESOLUTION || '');
          if (size && +size[2] === height && x['VIDEO-RANGE'] === 'HLG' && /(hev1|hvc1)\./.test(x.CODECS || '')) { uri = (lines[i + 1] || '').trim(); a = x; }
        });
        if (!uri) return fail('no ' + height + 'p HLG variant in player_tm');
        return io.get(new URL(uri, master.url).toString()).then(function (response) {
          var text = response.body;
          if (!/^#EXTM3U\s/.test(text) || /^#EXT-X-DISCONTINUITY\s*$/m.test(text) || /^#EXT-X-(?:BYTERANGE|MAP):/m.test(text)) return fail('unsupported player_tm playlist');
          var keyLines = text.match(/^#EXT-X-KEY:.*$/gm) || [], k = keyLines.length === 1 ? attrs(keyLines[0].slice(11)) : {};
          if (k.URI) k.URI = new URL(k.URI, response.url).toString();
          if (k.METHOD !== 'AES-128' || !/^https:\/\//.test(k.URI || '') || (k.KEYFORMAT && k.KEYFORMAT !== 'identity')) return fail('unsupported player_tm key');
          var seq = +((/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(text) || [])[1] || 0), durations = [];
          (text.match(/^#EXTINF:\s*([\d.]+)/gm) || []).forEach(function (l) { durations.push(parseFloat(l.slice(8))); });
          var uris = text.split(/\r?\n/).filter(function (l) { return l.trim() && l.charAt(0) !== '#'; })
            .map(function (l) { return new URL(l.trim(), response.url).toString(); });
          var pattern = CmafDash.template(uris);
          // The helper fetches segment n by its media sequence number: the names must carry it.
          if (!pattern || pattern.startNumber !== seq || uris.length !== durations.length) return fail('unsupported player_tm segment names');
          // Each segment's clock time: PROGRAM-DATE-TIME where the playlist gives one (replays have several: the clock
          // jumps at breaks), else the previous segment's plus its length.
          var walls = [], wall = NaN;
          text.split(/\r?\n/).forEach(function (l) {
            if (/^#EXT-X-PROGRAM-DATE-TIME:/.test(l)) wall = Date.parse(l.slice(25).trim()) / 1000;
            else if (/^#EXTINF:/.test(l)) { walls.push(wall); wall += parseFloat(l.slice(8)) || 0; }
          });
          return { url: response.url, seq: seq, count: uris.length, durations: durations, media: pattern.media, keyUri: k.URI,
            iv: k.IV || null, bandwidth: +a.BANDWIDTH || 0, end: /^#EXT-X-ENDLIST\s*$/m.test(text), walls: walls };
        });
      });
    }
    /** The renditions of the first master (of opts.sound) whose HLG variants have sound: { media, groups: [{ id, codec }], subs }. */
    function soundOf(list) {
      if (!list.length) return Promise.resolve({ media: [], groups: [], subs: null });
      return io.get(list[0]).then(function (master) {
        // The HLG variants' sound groups, each with its codec and the subtitle group those variants name.
        var lines = master.body.split(/\r?\n/), groups = {}, order = [], subs = null, used = {};
        lines.forEach(function (line) {
          if (!/^#EXT-X-STREAM-INF:/.test(line)) return;
          var x = attrs(line.slice(18));
          if (x['VIDEO-RANGE'] !== 'HLG') return;
          if (x.SUBTITLES) used[x.SUBTITLES] = true;
          if (!x.AUDIO && x.SUBTITLES && !subs) subs = x.SUBTITLES;
          if (x.AUDIO && !groups[x.AUDIO]) {
            groups[x.AUDIO] = { codec: (x.CODECS || '').split(',').map(function (c) { return c.trim(); }).filter(function (c) { return /^(mp4a|ac-3|ec-3)/.test(c); })[0] || 'mp4a.40.2',
              subs: x.SUBTITLES || null };
            order.push(x.AUDIO);
          }
        });
        var media = lines.filter(function (l) { return /^#EXT-X-MEDIA:/.test(l); }).filter(function (l) {
          var x = attrs(l.slice(13));
          return x.URI && ((x.TYPE === 'AUDIO' && groups[x['GROUP-ID']]) || (x.TYPE === 'SUBTITLES' && used[x['GROUP-ID']]));
        }).map(function (l) {
          return l.replace(/URI="([^"]*)"/, function (m, u) { return 'URI="' + new URL(u, master.url).toString() + '"'; });
        });
        if (!order.length) return list.length > 1 ? soundOf(list.slice(1)) : { media: media, groups: [], subs: subs };
        return { media: media, groups: order.map(function (g) { return { id: g, codec: groups[g].codec, subs: groups[g].subs }; }), subs: subs };
      });
    }
    var sound$ = soundOf((opts.sound || []).filter(function (u, i, all) { return u && all.indexOf(u) === i; }));
    return io.deadline(Promise.all(masters.map(function (url, n) { return variantOf(url, heights[n]); })).then(function (feeds) {
      var live = feeds.some(function (f) { return !f.end; });
      // The grid's playlist is the first feed's: a replay's feeds must cover the same segments (they do: F1 numbers and
      // times every feed of a session alike), or a seek near either end would miss a feed's segment.
      if (!live && feeds.some(function (f) { return f.seq !== feeds[0].seq || f.count !== feeds[0].count; })) return fail('player_tm feeds differ in length');
      // The segment every feed has: live a few back from the newest (complete on the CDN), a replay where `at` falls.
      var first = Math.max.apply(Math, feeds.map(function (f) { return f.seq; }));
      var last = Math.min.apply(Math, feeds.map(function (f) { return f.seq + f.count - 1; }));
      if (last < first) return fail('player_tm feeds do not overlap');
      var probe, start = 0;
      if (opts.wall > 0 && !(opts.at > 0) && feeds[0].walls.some(function (w) { return w <= opts.wall; })) {
        // A moment by the clock (a resume, a switch from one feed, a live start behind the edge): the last segment of
        // the first feed that began by then.
        var w = feeds[0].walls, j = 0;
        for (var q = 0; q < w.length; q++) if (w[q] <= opts.wall) j = q;
        j = Math.max(first - feeds[0].seq, Math.min(j, (live ? last - 3 : last) - feeds[0].seq));
        probe = feeds[0].seq + j;
        for (var d = 0; d < j; d++) start += feeds[0].durations[d];
      } else if (live) probe = Math.max(first, last - 3);
      else {
        var lead = feeds[0], i = Math.max(0, first - lead.seq), t = 0;
        for (var k = 0; k < i; k++) t += lead.durations[k];
        while (opts.at > 0 && i < lead.count - 1 && lead.seq + i < last && t + lead.durations[i] <= opts.at) t += lead.durations[i++];
        probe = lead.seq + i;
        start = t;
      }
      return Promise.all(feeds.map(function (f) { return key(f.keyUri); }).concat([sound$])).then(function (got) {
        var sound = got[feeds.length], bandwidth = feeds.reduce(function (n, f) { return n + f.bandwidth; }, 0);
        var head = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'].concat(sound.media);
        // The helper fills in the grid's codec and size once it has built it.
        // CLOSED-CAPTIONS=NONE: else Shaka fetches the first segment (a whole grid) to look for captions in it.
        var inf = '#EXT-X-STREAM-INF:BANDWIDTH=' + bandwidth + ',RESOLUTION=$GRIDRESOLUTION$,FRAME-RATE=50.000,VIDEO-RANGE=HLG,CLOSED-CAPTIONS=NONE';
        var variants = sound.groups.length ? sound.groups.map(function (g) {
          return inf + ',CODECS="$GRIDCODECS$,' + g.codec + '",AUDIO="' + g.id + '"' + (g.subs ? ',SUBTITLES="' + g.subs + '"' : '');
        }) : [inf + ',CODECS="$GRIDCODECS$"' + (sound.subs ? ',SUBTITLES="' + sound.subs + '"' : '')];
        var master = head.concat([].concat.apply([], variants.map(function (v) { return [v, 'video.m3u8']; }))).join('\n') + '\n';
        // lead: seconds of the first feed's playlist before the probe (the helper keeps every time from there on >= 0).
        var lead = 0;
        for (var b = 0; b < probe - feeds[0].seq; b++) lead += feeds[0].durations[b];
        var body = { kind: 'hevc', layout: layout, probe: probe, lead: lead, live: live, ua: navigator.userAgent, playlist: feeds[0].url, master: master,
          feeds: feeds.map(function (f, n) { return { ts: true, absolute: true, media: f.media, key: got[n], iv: f.iv }; }) };
        // Timed out or failed meanwhile (the app has gone on the usual way): no grid for nobody.
        if (io.expired()) return fail('player_tm preparation timed out');
        return fetch(LOCAL + '/stitch/' + id, { method: 'POST', body: JSON.stringify(body), signal: io.signal }).then(function (r) {
          return r.text().then(function (txt) {
            if (!r.ok) return fail('grid helper: ' + txt);
            var info = JSON.parse(txt);
            return { url: LOCAL + '/stitch/' + id + '/master.m3u8', width: info.width, height: info.height, start: start, live: live };
          });
        });
      });
    }));
  }

  /** A variant's VIDEO-RANGE; HLS defines a missing one as SDR (F1's SDR-only playlists name none). */
  function videoRange(a) { return a['VIDEO-RANGE'] || 'SDR'; }

  /** The heights of a master playlist's HEVC variants of one range (what a multiview of it can use). */
  function heights(url, range) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('master playlist: HTTP ' + r.status);
      return r.text();
    }).then(function (master) {
      var out = [];
      master.split(/\r?\n/).forEach(function (line) {
        if (!/^#EXT-X-STREAM-INF:/.test(line)) return;
        var x = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(x.RESOLUTION || '');
        if (size && videoRange(x) === range && /(hev1|hvc1)\./.test(x.CODECS || '') && out.indexOf(+size[2]) < 0) out.push(+size[2]);
      });
      return out;
    });
  }

  /** The range a multiview is built from: HLG from HDR offers, SDR HEVC from the others. */
  function gridRange(streams) { return streams[0] && streams[0].hdr ? 'HLG' : 'SDR'; }

  /** A feed's HEVC variant of one height and range: its playlist, read as a replay (complete) or live. */
  function variantOf(io, stream, height, range) {
    return io.get(stream.url).then(function (master) {
      var lines = master.body.split(/\r?\n/), uri = null, a = null;
      lines.forEach(function (line, i) {
        if (uri || !/^#EXT-X-STREAM-INF:/.test(line)) return;
        var x = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(x.RESOLUTION || '');
        if (size && +size[2] === height && videoRange(x) === range && /(hev1|hvc1)\./.test(x.CODECS || '')) { uri = (lines[i + 1] || '').trim(); a = x; }
      });
      if (!uri) return fail('no ' + height + 'p ' + range + ' HEVC variant');
      return io.get(new URL(uri, master.url).toString()).then(function (response) {
        var text = response.body, map = /^#EXT-X-MAP:.*URI="([^"]+)"/m.exec(text), keys = text.match(/^#EXT-X-KEY:.*$/gm) || [];
        if (!map) return fail('missing CMAF initialization map');
        var init = new URL(map[1], response.url).toString(), bandwidth = +a.BANDWIDTH || 0;
        if (/^#EXT-X-ENDLIST\s*$/m.test(text)) {
          var parsed = CmafDash.playlist(text, { breaks: true });
          return { init: init, urls: parsed.segments.map(function (s) { return new URL(s.uri, response.url).toString(); }),
            durations: parsed.segments.map(function (s) { return s.duration; }), keys: keys, bandwidth: bandwidth,
            parsed: parsed, playlistUrl: response.url, breaks: parsed.breaks };
        }
        var uris = text.split(/\r?\n/).filter(function (l) { return l.trim() && l.charAt(0) !== '#'; }).map(function (l) { return new URL(l.trim(), response.url).toString(); });
        var pattern = uris.length >= 4 && CmafDash.template(uris.slice(-4, -1));
        if (!pattern) return fail('unsupported live segment names');
        return { init: init, media: pattern.media, recent: pattern.startNumber, keys: keys, bandwidth: bandwidth, live: true };
      });
    });
  }

  /**
   * Multiview: rearranges a running grid (grid id `opts.id`) in the stream helper, to another layout or other
   * feeds, while the player keeps playing the same manifest. opts: { id, at (seconds into a replay),
   * prepareOnly (have the helper fetch what it needs, while the viewer chooses) }.
   */
  function regrid(streams, layout, opts) {
    var known = typeof MultiviewLayouts !== 'undefined' && MultiviewLayouts.layouts[layout], heights = known && known.feeds;
    if (!heights || heights.length !== streams.length) return Promise.reject(new Error('HDR: layout ' + layout + ' needs ' + (heights ? heights.length : '?') + ' feeds'));
    var io = fetcher(20000);
    return io.deadline(Promise.all(streams.map(function (s, n) { return variantOf(io, s, heights[n], opts.range || gridRange(streams)); })).then(function (feeds) {
      if (!feeds[0].live) sameBreaks(feeds);
      return (feeds[0].live ? Promise.resolve() : Promise.all(feeds.map(function (f) { return continuous(io, f.parsed, f.playlistUrl); })))
        .then(function () { return feeds; });
    }).then(function (feeds) {
      var live = feeds[0].live, body = { kind: 'hevc', layout: layout, live: !!live, ua: navigator.userAgent };
      if (feeds.some(function (f) { return !!f.live !== !!live; })) return fail('live and replay feeds mixed');
      if (live) {
        body.probe = Math.min.apply(Math, feeds.map(function (f) { return f.recent; }));
        body.feeds = feeds.map(function (f) { return { init: f.init, media: f.media, absolute: true }; });
      } else {
        var count = feeds[0].urls.length;
        feeds.forEach(function (f) { if (f.urls.length !== count) fail('feeds differ in length'); });
        var probe = 0, t = 0;
        while (opts.at > 0 && probe < feeds[0].durations.length - 1 && t + feeds[0].durations[probe] <= opts.at) t += feeds[0].durations[probe++];
        body.probe = probe;
        var probeStart = t;
        body.feeds = feeds.map(function (f) {
          var tpl = CmafDash.template(f.urls);
          return tpl ? { init: f.init, media: tpl.media, startNumber: tpl.startNumber, count: f.urls.length } : { init: f.init, urls: f.urls };
        });
      }
      return fetch(LOCAL + '/stitch/' + opts.id + (opts.prepareOnly ? '/prepare' : '/layout'), { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
        if (opts.prepareOnly) return r.ok ? null : r.text().then(function (txt) { return fail('grid helper: ' + txt); });
        return r.text().then(function (txt) {
          if (!r.ok) return fail('grid helper: ' + txt);
          var info = JSON.parse(txt);
          // Replays: where (seconds) the segment the helper prepared first begins.
          if (!live) info.start = probeStart;
          return info;
        });
      });
    }));
  }

  return { build: build, live: live, grid: grid, liveGrid: liveGrid, regrid: regrid, tmGrid: tmGrid, heights: heights, subtitleTracks: subtitleTracks };
})();
