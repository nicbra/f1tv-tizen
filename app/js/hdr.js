/* Encrypted HLG (replays and live) over native DASH. No decryption or licence handling here. */
var HdrStream = (function () {
  var LOCAL = 'http://127.0.0.1:18765';
  function fail(why) { throw new Error('HDR: ' + why); }
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
        if (!r.ok) return fail('media request failed (' + r.status + ')');
        return bytes ? r.arrayBuffer().then(function (b) { return new Uint8Array(b); }) :
          r.text().then(function (body) { return { body: body, url: r.url || url }; });
      });
    }
    function deadline(work) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { if (controller) controller.abort(); reject(new Error('HDR preparation timed out')); }, ms || 12000);
        work.then(function (value) { clearTimeout(timer); resolve(value); }, function (e) { clearTimeout(timer); if (controller) controller.abort(); reject(e); });
      });
    }
    return { get: get, deadline: deadline };
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
    var encoded = btoa(base).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    var audio = sets.filter(function (s) { return kind(s) === 'audio'; });
    if (!audio.length) return fail('missing commentary');
    // Preserve complete official adaptations, including their distinct DRM metadata and clocks.
    audio = audio.map(function (s) {
      return s.replace(/^(<AdaptationSet\b[^>]*>)/, '$1<BaseURL>' + xml(LOCAL + '/s/' + encoded + '/') + '</BaseURL>');
    });
    // AVPlay starts on the first commentary.
    var pick = audio.filter(function (s) { return attr(s.slice(0, s.indexOf('>')), 'lang') === langs.audio; })[0];
    if (pick) audio = [pick].concat(audio.filter(function (s) { return s !== pick; }));
    // Subtitles stay out of AVPlay's manifest: the app shows them (ttml.js).
    var subtitles = sets.filter(function (s) { return kind(s) === 'text'; }).map(function (s) { return subtitle(s, base); }).filter(Boolean);
    return { kid: protection.kid, pssh: protection.pssh, epoch: offset / timescale, others: audio.join(''), subtitles: subtitles,
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
  function build(stream, langs) {
    var io = fetcher(), get = io.get;
    return io.deadline(Promise.all([get(stream.url), get(stream.widevineManifestUrl)]).then(function (sources) {
      var source = official(sources[1].body, sources[1].url, langs || {});
      return Promise.all(variants(sources[0].body).map(function (v, i) {
        var playlistUrl = new URL(v.uri, sources[0].url).toString();
        return get(playlistUrl).then(function (response) {
          playlistUrl = response.url;
          var parsed = CmafDash.playlist(response.body);
          var segments = parsed.segments.map(function (s) { return { url: new URL(s.uri, playlistUrl).toString(), duration: s.duration }; });
          var init = new URL(parsed.init, playlistUrl).toString();
          return Promise.all([get(init, true), get(segments[0].url, true, true)]).then(function (data) {
            var timing = CmafDash.timing(data[0], data[1]), protection = CmafDash.encryption(data[0]);
            if (!protection || protection.scheme !== 'cbcs') return fail('unsupported media encryption');
            checkKeys(parsed.keys, protection.kid);
            if (Math.abs(timing.baseTime / timing.timescale - source.epoch) > 0.1) return fail('audio/video clocks differ');
            return { type: 'video', id: 'hlg' + i, hdr: true, width: v.width, height: v.height, codecs: v.codec,
              bandwidth: +v.a.BANDWIDTH, timing: timing, init: init, segments: segments,
              protection: { kid: protection.kid, pssh: psshFor(source, protection.kid) } };
          });
        });
      })).then(function (tracks) {
        var mpd = CmafDash.manifest(tracks);
        return { mpd: mpd.replace('<MPD ', '<MPD' + source.namespaces + ' ').replace('</Period>', source.others + '</Period>'),
          subtitles: source.subtitles };
      });
    }));
  }

  /**
   * Live: the HLG ladder as a video AdaptationSet for the stream helper, which puts it in place of the
   * official SDR video on every manifest refresh, with that video's current SegmentTimeline where
   * <!--timeline--> stands. F1 numbers and times the HLS and DASH segments alike (FP3, Mexico 2026);
   * that is checked here on a recent segment. Resolves { adaptation, subtitles }.
   */
  function live(stream) {
    var io = fetcher();
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
        return {
          adaptation: '<AdaptationSet xmlns:cenc="urn:mpeg:cenc:2013" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">' +
            '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="' + kid + '"/>' +
            '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>' + xml(psshFor(source, kid)) + '</cenc:pssh></ContentProtection>' +
            '<EssentialProperty schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics" value="18"/>' + reps.join('') + '</AdaptationSet>',
          subtitles: subtitles
        };
      });
    }));
  }
  /**
   * Multiview (experiment): the feeds' HEVC video arranged in a layout by the stream helper
   * (service/stitch-hevc.js), with the first feed's commentary. streams: the feeds' Premium offers
   * (hdrEncrypted), in the layout's feed order. Resolves { mpd, subtitles, width, height }.
   */
  function grid(streams, layout, opts) {
    opts = opts || {};
    var known = typeof MultiviewLayouts !== 'undefined' && MultiviewLayouts.layouts[layout], heights = known && known.feeds;
    if (!heights || heights.length !== streams.length) return Promise.reject(new Error('HDR: layout ' + layout + ' needs ' + (heights ? heights.length : '?') + ' feeds'));
    var io = fetcher(20000), get = io.get, range = opts.range || 'HLG', id = opts.id;
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
            if (size && +size[2] === height && x['VIDEO-RANGE'] === range && /(hev1|hvc1)\./.test(x.CODECS || '')) { uri = (lines[i + 1] || '').trim(); a = x; }
          });
          if (!uri) return fail('no ' + height + 'p ' + range + ' HEVC variant');
          return get(new URL(uri, master.url).toString()).then(function (response) {
            var parsed = CmafDash.playlist(response.body);
            var urls = parsed.segments.map(function (s) { return new URL(s.uri, response.url).toString(); });
            return { init: new URL(parsed.init, response.url).toString(), urls: urls, durations: parsed.segments.map(function (s) { return s.duration; }),
              keys: parsed.keys, bandwidth: +a.BANDWIDTH || 0, codec: (a.CODECS || '').split(',').filter(function (c) { return /^(hev1|hvc1)\./.test(c); })[0],
              master: master.body, masterUrl: master.url, audioGroup: a.AUDIO,
              audioCodec: (a.CODECS || '').split(',').filter(function (c) { return /^(mp4a|ac-3|ec-3)/.test(c); })[0] };
          });
        });
      })).then(function (feeds) {
        var count = feeds[0].urls.length;
        feeds.forEach(function (f) { if (f.urls.length !== count) fail('feeds differ in length'); });
        return Promise.all([get(feeds[0].init, true), get(feeds[0].urls[0], true, true)]).then(function (data) {
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
          return Promise.all([encrypted ? [] : audioTracks(io, feeds[lead], opts.langs || {}),
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
            var mpd = CmafDash.manifest([track].concat(audio));
            if (encrypted) mpd = mpd.replace('<MPD ', '<MPD' + source.namespaces + ' ').replace('</Period>', source.others + '</Period>');
            return { mpd: mpd, subtitles: subtitles, width: info.width, height: info.height };
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
        var parsed = CmafDash.playlist(response.body);
        var segments = parsed.segments.map(function (s) { return { url: new URL(s.uri, response.url).toString(), duration: s.duration }; });
        var init = new URL(parsed.init, response.url).toString();
        return Promise.all([io.get(init, true), io.get(segments[0].url, true, true)]).then(function (data) {
          return { type: 'audio', id: 'a' + i, language: a.LANGUAGE || 'und', codecs: feed.audioCodec || 'mp4a.40.2', bandwidth: 128000,
            timing: CmafDash.timing(data[0], data[1]), init: init, segments: segments };
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

  /** A feed's HEVC variant of one height and range: its playlist, read as a replay (complete) or live. */
  function variantOf(io, stream, height, range) {
    return io.get(stream.url).then(function (master) {
      var lines = master.body.split(/\r?\n/), uri = null, a = null;
      lines.forEach(function (line, i) {
        if (uri || !/^#EXT-X-STREAM-INF:/.test(line)) return;
        var x = attrs(line.slice(18)), size = /^(\d+)x(\d+)$/.exec(x.RESOLUTION || '');
        if (size && +size[2] === height && x['VIDEO-RANGE'] === range && /(hev1|hvc1)\./.test(x.CODECS || '')) { uri = (lines[i + 1] || '').trim(); a = x; }
      });
      if (!uri) return fail('no ' + height + 'p ' + range + ' HEVC variant');
      return io.get(new URL(uri, master.url).toString()).then(function (response) {
        var text = response.body, map = /^#EXT-X-MAP:.*URI="([^"]+)"/m.exec(text), keys = text.match(/^#EXT-X-KEY:.*$/gm) || [];
        if (!map) return fail('missing CMAF initialization map');
        var init = new URL(map[1], response.url).toString(), bandwidth = +a.BANDWIDTH || 0;
        if (/^#EXT-X-ENDLIST\s*$/m.test(text)) {
          var parsed = CmafDash.playlist(text);
          return { init: init, urls: parsed.segments.map(function (s) { return new URL(s.uri, response.url).toString(); }),
            durations: parsed.segments.map(function (s) { return s.duration; }), keys: keys, bandwidth: bandwidth };
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
    return io.deadline(Promise.all(streams.map(function (s, n) { return variantOf(io, s, heights[n], opts.range || 'HLG'); })).then(function (feeds) {
      var live = feeds[0].live, body = { kind: 'hevc', layout: layout, live: !!live, ua: navigator.userAgent };
      if (feeds.some(function (f) { return !!f.live !== !!live; })) return fail('live and replay feeds mixed');
      if (live) {
        body.probe = Math.min.apply(Math, feeds.map(function (f) { return f.recent; }));
        body.feeds = feeds.map(function (f) { return { init: f.init, media: f.media, absolute: true }; });
      } else {
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

  return { build: build, live: live, grid: grid, liveGrid: liveGrid, regrid: regrid, subtitleTracks: subtitleTracks };
})();
