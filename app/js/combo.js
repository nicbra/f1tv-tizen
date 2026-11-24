/*
 * One HLS master for every feed of a video, so that a feed switch is a variant switch inside the running Shaka player
 * instead of loading another player (research: local/docs/INSTANT-SWITCHING.md). From F1's player_tm answer (4K HDR:
 * every feed in one answer) or from the web answers of the feeds visited so far (SDR, any tier: one PLAY per feed, as
 * every switch asks anyway). All feeds of a video share segment numbers, timestamps and clock (player_tm and the web's
 * CMAF, LV 2026), so their variants line up like the qualities of one stream.
 *
 * Each feed keeps its own HLG variants, sound and subtitles (groups renamed per feed); TRACKER and DATA, which have no
 * sound in player_tm, take F1 LIVE's (else the main feed's), as F1's own player does. A variant's feed is in the last
 * two digits of its BANDWIDTH (player.js reads it back); subtitle names start with the feed's number and "|".
 */
var FeedCombo = (function () {
  var TAG = 100;   // BANDWIDTH = floor(real / TAG) * TAG + feed number (< TAG)

  function attrs(s) {
    var out = {}, re = /(?:^|,)\s*([\w-]+)=("[^"]*"|[^,]*)/g, m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  /** A feed's part of the master: { variants: [{ line, uri, height, group }], audio: { group: [lines] }, codecs, subs }. */
  function parse(text, base, k, range) {
    var lines = text.split(/\r?\n/), media = {}, subs = {}, variants = [], codecs = {};
    lines.forEach(function (line) {
      if (!/^#EXT-X-MEDIA:/.test(line)) return;
      var a = attrs(line.slice(13));
      if (!a.URI || !a['GROUP-ID']) return;
      var abs = line.replace(/URI="([^"]*)"/, function (m, u) { return 'URI="' + new URL(u, base).toString() + '"'; });
      if (a.TYPE === 'AUDIO') (media[a['GROUP-ID']] = media[a['GROUP-ID']] || []).push(abs);
      if (a.TYPE === 'SUBTITLES') {
        // Which feed's subtitles they are: Shaka's text track label is the NAME.
        var named = abs.replace(/NAME="([^"]*)"/, function (m, n) { return 'NAME="' + k + '|' + n + '"'; });
        (subs[a['GROUP-ID']] = subs[a['GROUP-ID']] || []).push(named);
      }
    });
    lines.forEach(function (line, i) {
      if (!/^#EXT-X-STREAM-INF:/.test(line)) return;
      var a = attrs(line.slice(18)), uri = (lines[i + 1] || '').trim();
      var size = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || ''), list = (a.CODECS || '').split(',').map(function (c) { return c.trim(); });
      // HEVC, or H.264 (F1's web masters have both in SDR; Shaka picks one family for the whole master, as for one feed).
      var video = list.filter(function (c) { return /^(hev1|hvc1|avc1|avc3)\./.test(c); })[0];
      // HLS calls a variant without VIDEO-RANGE SDR (F1's SDR HEVC names none).
      if ((a['VIDEO-RANGE'] || 'SDR') !== range || !video || !size || !uri || uri.charAt(0) === '#') return;
      var audio = list.filter(function (c) { return /^(mp4a|ac-3|ec-3)/.test(c); })[0];
      if (a.AUDIO && audio) codecs[a.AUDIO] = audio;
      variants.push({ bandwidth: +a.BANDWIDTH || 0, width: +size[1], height: +size[2], video: video, rate: a['FRAME-RATE'] || '50.000',
        audio: a.AUDIO || null, subs: a.SUBTITLES || null, uri: new URL(uri, base).toString() });
    });
    return { variants: variants, media: media, subs: subs, codecs: codecs };
  }

  /*
   * Masters read in the last hour, by address: the web route builds a new master each time a feed joins, from the same
   * feeds' masters (their addresses are signed for a day).
   */
  var read = [], READ_KEEP = 60 * 60 * 1000;
  function fetchText(url, ms) {
    var now = Date.now();
    read = read.filter(function (x) { return now - x.at < READ_KEEP; });
    var known = read.filter(function (x) { return x.url === url; })[0];
    if (known) return Promise.resolve(known.got);
    return fetchFresh(url, ms).then(function (got) {
      if (got) read = [{ url: url, got: got, at: Date.now() }].concat(read.filter(function (x) { return x.url !== url; })).slice(0, 40);
      return got;
    });
  }

  function fetchFresh(url, ms) {
    return new Promise(function (resolve) {
      // Given up after `ms`: the request itself stops too.
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var done = false, timer = setTimeout(function () { done = true; if (ctl) ctl.abort(); resolve(null); }, ms);
      fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) { return r.ok ? r.text().then(function (t) { return { text: t, base: r.url || url }; }) : null; })
        .then(function (x) { if (!done) { done = true; clearTimeout(timer); resolve(x && /^#EXTM3U/.test(x.text) ? x : null); } },
          function () { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
    });
  }

  function utf8base64(s) { return btoa(unescape(encodeURIComponent(s))); }

  /*
   * The master's address. A blob: URL, not a data: URL: Shaka resolves every segment's address through the master's,
   * and decoding a data: URL holding 26 feeds' master (~100 KB) for each of ~1,400 segments blocked the page 4-6 s per
   * playlist (QE55Q77A, 2026-11-23). The latest few are kept (a slot or a frozen-start reload may still load one).
   */
  var blobs = [], BLOBS = 4;
  function addressOf(master) {
    if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      return 'data:application/x-mpegurl;base64,' + utf8base64(master);
    }
    // Out of the list at once (startAt makes a new one when asked again), revoked a minute later: a load that was
    // handed it may not have read it yet.
    while (blobs.length >= BLOBS) revokeLater(blobs.shift());
    blobs.push(URL.createObjectURL(new Blob([master], { type: 'application/x-mpegurl' })));
    return blobs[blobs.length - 1];
  }

  /*
   * The master to load when starting at feed k: only k's sound marked DEFAULT. Shaka starts with the variants of one
   * sound (its first DEFAULT one, else by channel count), not the feed asked for: with every feed's English DEFAULT it
   * took feed 0's, and the feed-locked ABR (player.js FeedAbr) had nothing to play (Shaka: "Cannot read property 'video'
   * of null", web SDR at F1 LIVE, 2026-11-23). Switches later pick variants themselves (selectVariantTrack).
   */
  function revokeLater(uri) {
    var t = setTimeout(function () { try { URL.revokeObjectURL(uri); } catch (e) { /* gone */ } }, 60000);
    if (t && t.unref) t.unref();   // node (tests)
  }

  function startAt(info, k) {
    var feed = (info.feeds || []).filter(function (f) { return f.k === k; })[0];
    if (!feed || !info.master || !feed.groups) {
      if (info.master && blobs.indexOf(info.uri) < 0 && /^blob:/.test(info.uri || '')) info.uri = addressOf(info.master);
      return info.uri;
    }
    info.starts = info.starts || {};
    var known = info.starts[k];
    if (known && blobs.indexOf(known) >= 0) return known;
    var mine = {}, yes = false;
    feed.groups.forEach(function (g) { mine[g] = true; });
    var lines = info.master.split('\n').map(function (line) {
      if (!/^#EXT-X-MEDIA:TYPE=AUDIO,/.test(line)) return line;
      var g = (/GROUP-ID="([^"]*)"/.exec(line) || [])[1];
      if (!mine[g]) return line.replace(/DEFAULT=YES/, 'DEFAULT=NO');
      if (/DEFAULT=YES/.test(line)) yes = true;
      return line;
    });
    // None of its own marked DEFAULT: its first.
    if (!yes) for (var i = 0; i < lines.length; i++) {
      var g2 = (/^#EXT-X-MEDIA:TYPE=AUDIO,.*GROUP-ID="([^"]*)"/.exec(lines[i]) || [])[1];
      if (g2 && mine[g2]) { lines[i] = /DEFAULT=NO/.test(lines[i]) ? lines[i].replace('DEFAULT=NO', 'DEFAULT=YES') : lines[i] + ',DEFAULT=YES'; break; }
    }
    return (info.starts[k] = addressOf(lines.join('\n')));
  }

  /**
   * feeds: [{ index (the app's feed number), channel, url (its master) }]; opts: { soundFrom: channels to take sound
   * from for feeds without any, in order (F1 LIVE, the main feed); range: 'HLG' (default, player_tm) or 'SDR' (web
   * answers); ms }. Resolves null unless at least two feeds came (within `ms`, 4 s). Else { uri (a blob: URL), master,
   * range, feeds: [{ index, channel, k, variants: [{ height, width, uri }], audio: { language: [{ uri, channels }] } }] }
   * with k the feed's number in the master.
   */
  function build(feeds, opts) {
    opts = opts || {};
    var urls = {}, list = feeds.filter(function (f) { if (!f.url || urls[f.url]) return false; urls[f.url] = true; return true; }).slice(0, TAG - 1);
    var range = opts.range || 'HLG';
    return Promise.all(list.map(function (f) { return fetchText(f.url, opts.ms || 4000); })).then(function (got) {
      var parts = [];
      got.forEach(function (x, n) {
        if (!x) return;
        var k = parts.length, p = parse(x.text, x.base, k, range);
        if (p.variants.length) parts.push({ feed: list[n], k: k, p: p });
      });
      if (parts.length < 2) return null;
      // Sound for the feeds that have none: the first of opts.soundFrom with sound.
      var donor = (opts.soundFrom || []).map(function (ch) {
        return parts.filter(function (x) { return String(x.feed.channel) === String(ch) && x.p.variants.some(function (v) { return v.audio; }); })[0];
      }).filter(Boolean)[0] || parts.filter(function (x) { return x.p.variants.some(function (v) { return v.audio; }); })[0];
      var head = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'], media = [], variants = [], out = [];
      parts.forEach(function (x) {
        var k = x.k, p = x.p, info = { index: x.feed.index, channel: x.feed.channel, url: x.feed.url, k: k, variants: [], audio: {}, groups: [] };
        var own = p.variants.some(function (v) { return v.audio; });
        var from = own ? x : donor;
        // The sound groups this feed's variants use: its own (renamed per feed), or the donor's (shared, named once).
        var groupName = function (g) { return 'a' + from.k + '-' + g; };
        if (own) Object.keys(p.media).forEach(function (g) {
          if (!p.variants.some(function (v) { return v.audio === g; })) return;
          p.media[g].forEach(function (l) {
            media.push(l.replace(/GROUP-ID="[^"]*"/, 'GROUP-ID="' + groupName(g) + '"'));
            addSound(info, l);
          });
        });
        if (!own && donor) Object.keys(donor.p.media).forEach(function (g) { donor.p.media[g].forEach(function (l) { addSound(info, l); }); });
        Object.keys(p.subs).forEach(function (g) {
          if (!p.variants.some(function (v) { return v.subs === g; })) return;
          p.subs[g].forEach(function (l) { media.push(l.replace(/GROUP-ID="[^"]*"/, 'GROUP-ID="s' + k + '-' + g + '"')); });
        });
        // One variant line per quality and sound group (F1 LIVE: stereo and 5.1); feeds without sound get the donor's.
        var seen = {};
        p.variants.forEach(function (v) {
          var groups = own ? (v.audio ? [v.audio] : []) : (donor ? Object.keys(donor.p.media).filter(function (g) {
            return donor.p.variants.some(function (dv) { return dv.audio === g; });
          }) : []);
          if (!groups.length) groups = [null];
          groups.forEach(function (g) {
            var key = v.uri + '|' + g;
            if (seen[key]) return;
            seen[key] = true;
            var codec = g ? (from.p.codecs[g] || 'mp4a.40.2') : null;
            if (g && info.groups.indexOf(groupName(g)) < 0) info.groups.push(groupName(g));
            if (codec && /^(ac-3|ec-3)/.test(codec)) info.surround = true;   // Dolby Digital among its sounds
            variants.push('#EXT-X-STREAM-INF:BANDWIDTH=' + (Math.floor(v.bandwidth / TAG) * TAG + k) + ',CODECS="' + (codec ? codec + ',' : '') + v.video + '"' +
              ',RESOLUTION=' + v.width + 'x' + v.height + ',FRAME-RATE=' + v.rate + ',VIDEO-RANGE=' + range + ',CLOSED-CAPTIONS=NONE' +
              (g ? ',AUDIO="' + groupName(g) + '"' : '') + (v.subs && p.subs[v.subs] ? ',SUBTITLES="s' + k + '-' + v.subs + '"' : ''), v.uri);
          });
          if (!info.variants.some(function (x2) { return x2.uri === v.uri; })) info.variants.push({ height: v.height, width: v.width, video: v.video, uri: v.uri });
        });
        out.push(info);
      });
      var master = head.concat(media, variants).join('\n') + '\n';
      return { master: master, uri: addressOf(master), range: range, at: Date.now(), feeds: out };
    });
  }

  /** A sound rendition of a feed, by language: [{ uri, channels }] (F1 LIVE: stereo and 5.1 English). */
  function addSound(info, line) {
    var a = attrs(line.slice(13)), lang = a.LANGUAGE || 'und', uri = (/URI="([^"]*)"/.exec(line) || [])[1];
    var list = info.audio[lang] = info.audio[lang] || [];
    if (uri && !list.some(function (x) { return x.uri === uri; })) list.push({ uri: uri, channels: parseInt(a.CHANNELS, 10) || 2 });
  }

  /** The feed number (k) a Shaka variant track belongs to. */
  function feedOf(track) { return track && track.bandwidth != null ? track.bandwidth % TAG : -1; }

  return { build: build, startAt: startAt, feedOf: feedOf, parse: parse, TAG: TAG };
})();
