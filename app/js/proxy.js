/* Starts the app's background service (service/service.js) and builds URLs through it. */
var StreamProxy = (function () {
  var BASE = 'http://127.0.0.1:18765';

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

  return { ensure: ensure, manifest: manifest };
})();
