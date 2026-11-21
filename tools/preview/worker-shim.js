/* UI preview: a worker's requests to other hosts go through the preview server, as the page's do (shim.js). */
(function () {
  'use strict';
  function route(url) {
    if (typeof url !== 'string') return url;
    var m = /^https?:\/\/([^/?#]+)([^#]*)/i.exec(url);
    if (!m || m[1] === self.location.host) return url;
    return self.location.origin + '/__up/' + m[1] + (m[2] || '/');
  }
  var realFetch = self.fetch.bind(self);
  self.fetch = function (input, init) {
    if (typeof input === 'string') return realFetch(route(input), init);
    if (input && input.url) return realFetch(new Request(route(input.url), input), init);
    return realFetch(input, init);
  };
  // Live timing's SignalR socket: through the preview server, which adds the cookie F1 wants.
  var RealWS = self.WebSocket;
  if (RealWS) {
    self.WebSocket = function (url, protocols) {
      var m = /^wss?:\/\/([^/?#]+)([^#]*)/i.exec(String(url));
      if (m && m[1] !== self.location.host) url = self.location.origin.replace(/^http/, 'ws') + '/__up/' + m[1] + (m[2] || '/');
      return protocols ? new RealWS(url, protocols) : new RealWS(url);
    };
    self.WebSocket.prototype = RealWS.prototype;
  }
})();
