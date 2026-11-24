/* Starts the app's background service (launcher/service.js; service/service.js does the work) and builds URLs through it. */
var StreamProxy = (function () {
  var BASE = 'http://127.0.0.1:18765';
  var vodSequence = 0;

  // A helper that accepts the connection but never answers (a wedged delegate) must not hang the player or the app's
  // start. Chromium 47 has no AbortController: each step races a timer, and a late answer is ignored.
  var PING_MS = 8000, LAUNCH_MS = 10000, ENSURE_MS = 20000;
  // The helper's own failures, with their cause for the recovery (js/failure.js): busy or not started is transient; a
  // manifest it refused is this video's.
  function helperError(message, cause) {
    var e = new Error(message);
    e.failure = cause;
    e.diag = { code: 'HELPER_ERROR', platform: null };
    return e;
  }

  function within(promise, ms, late) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { if (late) late(resolve, reject); else reject(helperError('helper did not answer', 'transient')); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  /** Whether the helper answers, with this bundle's service code; the whole exchange within `ms`. */
  function ping(ms) {
    return within(fetch(BASE + '/ping', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) return false;
      if (typeof Launcher === 'undefined') return true;
      return r.json().then(function (info) {
        if (info.version === Launcher.version && info.ok) return true;
        // The fixed listener reloads the service delegate in place, preserving recovery routes.
        return fetch(BASE + '/launcher/restart?version=' + encodeURIComponent(Launcher.version), { method: 'POST' })
          .then(function (r) { if (!r.ok) return false; return r.json().then(function (info) { return info.version === Launcher.version; }); });
      });
    }), ms || PING_MS).catch(function () { return false; });
  }

  function launch() {
    return new Promise(function (resolve, reject) {
      try {
        var pkg = tizen.application.getCurrentApplication().appInfo.packageId;
        tizen.application.launchAppControl(
          new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
          pkg + '.Helper', resolve, function (e) { reject(new Error(e.message)); });
      } catch (e) { reject(e); }
    });
  }

  /**
   * Resolves once the helper answers. A start can take a while (a cold Node start, or an update being installed),
   * so it keeps asking for ENSURE_MS from the call, whether the pings are refused or hang.
   */
  function ensure() {
    var since = Date.now();
    function left() { return ENSURE_MS - (Date.now() - since); }
    return ping().then(function (up) {
      if (up) return true;
      // A launch that never calls back is not an answer either way: the pings decide.
      return within(launch(), LAUNCH_MS, function (resolve) { resolve(); }).then(function () {
        return new Promise(function (resolve, reject) {
          (function wait() {
            if (left() <= 0) return reject(helperError('Stream helper service did not start', 'transient'));
            ping(Math.max(1000, Math.min(PING_MS, left()))).then(function (ok) {
              if (ok) return resolve(true);
              setTimeout(wait, 250);
            });
          })();
        });
      });
    });
  }

  /** shift: seconds behind live. langs: preferred { audio, text } language codes. */
  function manifest(url, shift, langs) {
    langs = langs || {};
    return BASE + '/mpd?u=' + encodeURIComponent(url) + (shift > 0 ? '&shift=' + Math.round(shift) : '') +
      (langs.audio ? '&audio=' + encodeURIComponent(langs.audio) : '') +
      (langs.text ? '&text=' + encodeURIComponent(langs.text) : '');
  }

  /**
   * Resolves { url, subtitles, surround }: the local manifest for AVPlay, the subtitles the app shows itself, and how
   * many 5.1 commentaries it has (langs.surround false: none).
   */
  function hdrManifest(stream, langs) {
    return ensure().then(function () { return HdrStream.build(stream, langs); }).then(function (built) {
      var target = BASE + '/vod/' + Date.now().toString(36) + '-' + (++vodSequence) + '.mpd';
      return fetch(target, { method: 'POST', body: built.mpd }).then(function (r) {
        if (!r.ok) throw helperError('Could not prepare HDR manifest', 'content');
        return { url: target, subtitles: built.subtitles, surround: built.surround || 0 };
      });
    });
  }

  /**
   * Live HDR: the official live manifest through the helper as usual (time shift, audio fix, languages),
   * with the HLG video in place of the SDR one, the 5.1 commentary where there is one (langs.surround false: none),
   * and without subtitle sets (the app shows those). Resolves { url, subtitles, surround }.
   */
  function hdrLive(stream, shift, langs) {
    return ensure().then(function () { return HdrStream.live(stream, { surround: !langs || langs.surround !== false }); }).then(function (built) {
      var id = Date.now().toString(36) + '-' + (++vodSequence);
      return fetch(BASE + '/hdr/' + id, { method: 'POST', body: built.adaptation }).then(function (r) {
        if (!r.ok) throw helperError('Could not prepare HDR manifest', 'content');
        var url = manifest(stream.widevineManifestUrl, shift, { audio: langs && langs.audio }) + '&hdr=' + id + '&notext=1';
        // A first pass through the helper, as AVPlay will make it: it checks the HLG swap, and warms the
        // helper's connection to the CDN (AVPlay gives up after ~5 s; 2026-10-31 Qualifying, right after
        // the helper restarted). A failure here is a temporary one: the app tries HDR once more.
        return fetch(url, { cache: 'no-store' }).then(function (check) {
          if (!check.ok) throw new Error('HDR live manifest answered ' + check.status);
          // The 5.1 the helper served (it leaves it out when the official audio can't carry it): a start counted
          // against the 5.1 must have had it.
          return check.text().then(function (mpd) {
            var served = (mpd.match(/<AdaptationSet\b[^>]*contentType="audio"[\s\S]*?<\/AdaptationSet>/g) || [])
              .filter(function (set) { return /codecs="(?:ac-3|ec-3)"/.test(set); }).length;
            return { url: url, subtitles: built.subtitles, surround: Math.min(built.surround || 0, served) };
          });
        });
      });
    });
  }

  /**
   * Multiview (experiment): the feeds' offers arranged in a layout by the helper (HdrStream.grid).
   * `at`: the start position in seconds, so the helper reads that segment first. `audio`: the place of the feed
   * whose commentary and subtitles play. Resolves { url, subtitles }.
   */
  function gridManifest(streams, layout, langs, at, audio) {
    var id = 'mv' + Date.now().toString(36) + '-' + (++vodSequence);
    return ensure().then(function () { return HdrStream.grid(streams, layout, { id: id, langs: langs, at: at, audio: audio || 0 }); }).then(function (built) {
      var target = BASE + '/vod/' + id + '.mpd';
      return fetch(target, { method: 'POST', body: built.mpd }).then(function (r) {
        if (!r.ok) throw helperError('Could not prepare multiview', 'content');
        return { url: target, subtitles: built.subtitles, id: id, surround: built.surround || 0 };
      });
    });
  }

  /**
   * Live multiview (experiment): the official live manifest through the helper, as for live HDR, with the
   * helper's grid as its video (HdrStream.liveGrid). Resolves { url, subtitles }.
   */
  function gridLive(stream, shift, langs) {
    var id = 'mv' + Date.now().toString(36) + '-' + (++vodSequence);
    var lead = stream.grid.audioPos || 0;
    return ensure().then(function () { return HdrStream.liveGrid(stream.grid.streams, stream.grid.layout, { id: id, langs: langs, audio: lead }); }).then(function (built) {
      return fetch(BASE + '/hdr/' + id, { method: 'POST', body: built.adaptation }).then(function (r) {
        if (!r.ok) throw helperError('Could not prepare multiview', 'content');
        // The sound feed's official live manifest: the grid follows its clock and numbering (all feeds share them).
        var url = manifest(stream.grid.streams[lead].widevineManifestUrl, shift, { audio: langs && langs.audio }) + '&hdr=' + id + '&notext=1';
        return fetch(url, { cache: 'no-store' }).then(function (check) {
          if (!check.ok) throw new Error('Multiview live manifest answered ' + check.status);
          return { url: url, subtitles: built.subtitles, id: id };
        });
      });
    });
  }

  /** Multiview: the playing grid rearranged in the helper (HdrStream.regrid); the player keeps its manifest. */
  function regrid(stream, streams, layout, at, prepareOnly) {
    return HdrStream.regrid(streams, layout, { id: stream.grid.id, at: at, prepareOnly: prepareOnly });
  }

  return { ensure: ensure, manifest: manifest, hdrManifest: hdrManifest, hdrLive: hdrLive, gridManifest: gridManifest, gridLive: gridLive, regrid: regrid };
})();

// The helper's recent requests (CDN host, status, ms; no paths or tokens), added to warnings and errors.
if (typeof Diag !== 'undefined') {
  Diag.provideAsync('helper', function () {
    var ask = fetch('http://127.0.0.1:18765/log').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (list) { return Array.isArray(list) ? list.slice(-15) : null; });
    return Promise.race([ask, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 2000); })]);
  });
}
