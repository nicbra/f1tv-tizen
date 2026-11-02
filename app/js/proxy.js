/* Starts the app's background service (service/service.js) and builds URLs through it. */
var StreamProxy = (function () {
  var BASE = 'http://127.0.0.1:18765';
  var vodSequence = 0;

  function ping() {
    return fetch(BASE + '/ping', { cache: 'no-store' }).then(function (r) { return r.ok; }, function () { return false; });
  }

  function launch() {
    return new Promise(function (resolve, reject) {
      try {
        var pkg = tizen.application.getCurrentApplication().appInfo.packageId;
        tizen.application.launchAppControl(
          new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
          pkg + '.Proxy', resolve, function (e) { reject(new Error(e.message)); });
      } catch (e) { reject(e); }
    });
  }

  function ensure() {
    return ping().then(function (up) {
      if (up) return true;
      return launch().then(function () {
        var tries = 0;
        return new Promise(function (resolve, reject) {
          (function wait() {
            ping().then(function (ok) {
              if (ok) return resolve(true);
              if (++tries > 20) return reject(new Error('Stream helper service did not start'));
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

  /** Resolves { url, subtitles }: the local manifest for AVPlay, and the subtitles the app shows itself. */
  function hdrManifest(stream, langs) {
    return ensure().then(function () { return HdrStream.build(stream, langs); }).then(function (built) {
      var target = BASE + '/vod/' + Date.now().toString(36) + '-' + (++vodSequence) + '.mpd';
      return fetch(target, { method: 'POST', body: built.mpd }).then(function (r) {
        if (!r.ok) throw new Error('Could not prepare HDR manifest');
        return { url: target, subtitles: built.subtitles };
      });
    });
  }

  /**
   * Live HDR: the official live manifest through the helper as usual (time shift, audio fix, languages),
   * with the HLG video in place of the SDR one and without subtitle sets (the app shows those).
   * Resolves { url, subtitles }.
   */
  function hdrLive(stream, shift, langs) {
    return ensure().then(function () { return HdrStream.live(stream); }).then(function (built) {
      var id = Date.now().toString(36) + '-' + (++vodSequence);
      return fetch(BASE + '/hdr/' + id, { method: 'POST', body: built.adaptation }).then(function (r) {
        if (!r.ok) throw new Error('Could not prepare HDR manifest');
        var url = manifest(stream.widevineManifestUrl, shift, { audio: langs && langs.audio }) + '&hdr=' + id + '&notext=1';
        // A first pass through the helper, as AVPlay will make it: it checks the HLG swap, and warms the
        // helper's connection to the CDN (AVPlay gives up after ~5 s; 2026-10-31 Qualifying, right after
        // the helper restarted). A failure here is a temporary one: the app tries HDR once more.
        return fetch(url, { cache: 'no-store' }).then(function (check) {
          if (!check.ok) throw new Error('HDR live manifest answered ' + check.status);
          return { url: url, subtitles: built.subtitles };
        });
      });
    });
  }

  /**
   * Multiview (experiment): the feeds' Premium offers arranged in a layout by the helper (HdrStream.grid).
   * `at`: the start position in seconds, so the helper reads that segment first. `audio`: the place of the feed
   * whose commentary and subtitles play. Resolves { url, subtitles }.
   */
  function gridManifest(streams, layout, langs, at, audio) {
    var id = 'mv' + Date.now().toString(36) + '-' + (++vodSequence);
    return ensure().then(function () { return HdrStream.grid(streams, layout, { id: id, langs: langs, at: at, audio: audio || 0 }); }).then(function (built) {
      var target = BASE + '/vod/' + id + '.mpd';
      return fetch(target, { method: 'POST', body: built.mpd }).then(function (r) {
        if (!r.ok) throw new Error('Could not prepare multiview');
        return { url: target, subtitles: built.subtitles, id: id };
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
        if (!r.ok) throw new Error('Could not prepare multiview');
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
