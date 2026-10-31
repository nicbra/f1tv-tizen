/* Encrypted HLG VOD over native DASH. No decryption or licence handling here. */
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
    var video = sets.filter(function (s) { return attr(s.slice(0, s.indexOf('>')), 'contentType') === 'video'; })[0];
    if (!video) return fail('missing Widevine video metadata');
    var kid = /\bcenc:default_KID="([^"]+)"/.exec(video);
    var wv = (video.match(/<ContentProtection\b[^>]*>[\s\S]*?<\/ContentProtection>/g) || []).filter(function (s) { return /urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/.test(s); })[0];
    var pssh = wv && /<cenc:pssh\b[^>]*>([^<]+)<\/cenc:pssh>/.exec(wv);
    var template = /<SegmentTemplate\b([^>]*)>/.exec(video);
    if (!kid || !pssh || !template || !/value="cbcs"/.test(video)) return fail('unsupported Widevine protection');
    var timescale = +attr(template[1], 'timescale') || 1, offset = +attr(template[1], 'presentationTimeOffset');
    if (!(offset > 0)) return fail('missing source presentation clock');
    var base = new URL('.', url).toString();
    var encoded = btoa(base).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    function kind(s) {
      var head = s.slice(0, s.indexOf('>')), type = attr(head, 'contentType');
      return type === 'application' && /^(stpp|wvtt)/.test(attr(head, 'codecs')) ? 'text' : type;
    }
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
    return { kid: id(kid[1]), pssh: pssh[1].trim(), epoch: offset / timescale, others: audio.join(''), subtitles: subtitles,
      namespaces: Object.keys(bindings).filter(function (p) { return p !== 'cenc'; }).map(function (p) { return ' xmlns:' + p + '="' + bindings[p] + '"'; }).join('') };
  }
  /** An stpp subtitle set's segment addressing (for ttml.js), or null for other formats. */
  function subtitle(set, base) {
    var head = set.slice(0, set.indexOf('>')), rep = /<Representation\b([^>]*)>/.exec(set);
    var template = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/.exec(set);
    if (!rep || !template || !/^stpp/.test(attr(head, 'codecs') || attr(rep[1], 'codecs'))) return null;
    var own = /<BaseURL>([^<]*)<\/BaseURL>/.exec(set), a = template[1], runs = [];
    (template[2] || '').replace(/<S\b([^>]*)\/>/g, function (all, s) {
      runs.push({ t: attr(s, 't') === '' ? null : +attr(s, 't'), d: +attr(s, 'd'), r: attr(s, 'r') === '' ? 0 : +attr(s, 'r') });
      return all;
    });
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
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer;
    function get(url, bytes, range) {
      return fetch(url, { signal: controller ? controller.signal : undefined, headers: range ? { Range: 'bytes=0-65535' } : {} }).then(function (r) {
        if (!r.ok) return fail('media request failed (' + r.status + ')');
        return bytes ? r.arrayBuffer().then(function (b) { return new Uint8Array(b); }) :
          r.text().then(function (body) { return { body: body, url: r.url || url }; });
      });
    }
    var work = Promise.all([get(stream.url), get(stream.widevineManifestUrl)]).then(function (sources) {
      var source = official(sources[1].body, sources[1].url, langs || {});
      return Promise.all(variants(sources[0].body).map(function (v, i) {
        var playlistUrl = new URL(v.uri, sources[0].url).toString();
        return get(playlistUrl).then(function (response) {
          playlistUrl = response.url;
          var parsed = CmafDash.playlist(response.body);
          if (!parsed.keys.length) return fail('missing CBCS declaration');
          var segments = parsed.segments.map(function (s) { return { url: new URL(s.uri, playlistUrl).toString(), duration: s.duration }; });
          var init = new URL(parsed.init, playlistUrl).toString();
          return Promise.all([get(init, true), get(segments[0].url, true, true)]).then(function (data) {
            var timing = CmafDash.timing(data[0], data[1]), protection = CmafDash.encryption(data[0]);
            if (!protection || protection.scheme !== 'cbcs') return fail('unsupported media encryption');
            parsed.keys.forEach(function (line) {
              var a = attrs(line.slice(line.indexOf(':') + 1));
              if (a.METHOD !== 'SAMPLE-AES' || a.KEYFORMAT !== 'com.apple.streamingkeydelivery' || id(a.URI || '') !== protection.kid) return fail('inconsistent CBCS keys');
            });
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
    });
    return new Promise(function (resolve, reject) {
      timer = setTimeout(function () { if (controller) controller.abort(); reject(new Error('HDR preparation timed out')); }, 12000);
      work.then(function (value) { clearTimeout(timer); resolve(value); }, function (e) { clearTimeout(timer); if (controller) controller.abort(); reject(e); });
    });
  }
  return { build: build };
})();
