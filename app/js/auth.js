/* Pairing and token renewal. The saved device key renews the subscription token. */
var Auth = (function () {
  var KEY = 'f1tv.session';
  var ACCOUNT_API = 'https://api.formula1.com';

  // Android tablet profile; this is how the TV appears in the F1 account's device list.
  var PROFILE = {
    apiKey: 'PpJW2yg3t1S4K4SoKNGZVLsI1G8GsLTm',
    systemId: '60a9ad84-e93d-480f-80d6-af37494f2e22',
    distributionChannel: 'dcc8bbf4-f5af-49db-b168-22c389d189f8',
    deviceType: 17,
    physicalDeviceType: 1001,
    language: 'en-US'
  };
  var STATUS = { COMPLETE: '1', PENDING: '2', EXPIRED: '3', INVALID: '4' };
  var POLL_MS = 5000;
  var PAIR_PAGE = 'https://f1tv.formula1.com/tv';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }

  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* storage full / disabled */ }
  }

  function update(fields) {
    var s = load();
    Object.keys(fields).forEach(function (k) {
      if (fields[k] == null) delete s[k]; else s[k] = fields[k];
    });
    save(s);
  }

  function jwtPayload(token) {
    try {
      var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      // atob gives bytes; the payload is UTF-8 (names like "Søren").
      var bytes = atob(part), escaped = '';
      for (var i = 0; i < bytes.length; i++) escaped += '%' + ('0' + bytes.charCodeAt(i).toString(16)).slice(-2);
      return JSON.parse(decodeURIComponent(escaped));
    } catch (e) { return null; }
  }

  /** Seconds left on the token, or null when it has no readable exp. */
  function secondsLeft(token) {
    var p = jwtPayload(token);
    if (!p || !p.exp) return null;
    return p.exp - Math.floor(Date.now() / 1000);
  }

  function deviceId() {
    var s = load();
    if (!s.deviceId) {
      s.deviceId = 'tizen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      save(s);
    }
    return s.deviceId;
  }

  /** The stored token if it is still valid for at least a minute. */
  function token() {
    var t = load().subscriptionToken;
    if (!t) return null;
    var left = secondsLeft(t);
    return left === null || left > 60 ? t : null;
  }

  function isPaired() { return !!load().authKey; }

  function profile() {
    var p = jwtPayload(load().subscriptionToken || '') || {};
    return { firstName: p.FirstName || '', lastName: p.LastName || '', product: p.SubscribedProduct || '' };
  }

  /** Signs out: forgets the token and the device key (the device stays listed in the account). */
  function clear() { update({ subscriptionToken: null, authKey: null }); }

  // PIN pairing

  /** The page that confirms a code; F1 pre-fills the code from ?pin=. */
  function pairUrl(code) { return PAIR_PAGE + '?pin=' + encodeURIComponent(code.toLowerCase()); }

  function accountPost(path, body, withSystemId) {
    var headers = {
      'Content-Type': 'application/json',
      apikey: PROFILE.apiKey,
      'CD-DistributionChannel': PROFILE.distributionChannel,
      'CD-DeviceType': String(PROFILE.deviceType)
    };
    if (withSystemId) {
      headers['CD-SystemID'] = PROFILE.systemId;
      headers['CD-Language'] = PROFILE.language;
    }
    return F1Api.http(ACCOUNT_API + path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (data) {
      if (data && data.Fault) {
        var err = new Error(data.Fault.Message || ('Account API fault ' + data.Fault.Code));
        err.fault = data.Fault;
        throw err;
      }
      return data;
    });
  }

  function generateCode() {
    return accountPost('/v1/account/Subscriber/GenerateDeviceRendezvousCode', {
      DeviceId: deviceId(),
      DeviceType: PROFILE.deviceType,
      PhysicalDeviceType: PROFILE.physicalDeviceType
    }, true);
  }

  /** Resolves with a token; the promise has cancel(). onCode receives each new or renewed code. */
  function pair(onCode) {
    var cancelled = false;
    var timer = null;
    var p = new Promise(function (resolve, reject) {
      function fresh() {
        if (cancelled) return;
        generateCode().then(function (res) {
          if (cancelled) return;
          onCode(String(res.RendezvousCode).toUpperCase());
          poll(res.RendezvousCode, res.AuthenticationKey);
        }).catch(function (e) {
          if (!cancelled) reject(e);
        });
      }
      function poll(code, key) {
        timer = setTimeout(function () {
          if (cancelled) return;
          accountPost('/v1/account/Subscriber/RetrieveDeviceRendezvousStatus', { RendezvousCode: code }, true)
            .then(function (st) {
              // Cancelled while this answer was on its way (the viewer chose to browse): stay out of it.
              if (cancelled) return;
              var status = String(st.Status);
              if (status === STATUS.COMPLETE) {
                update({ authKey: key });
                return byDevice().then(resolve, reject);
              }
              if (status === STATUS.EXPIRED || status === STATUS.INVALID) return fresh();
              poll(code, key);
            })
            .catch(function () { poll(code, key); });
        }, POLL_MS);
      }
      fresh();
    });
    p.cancel = function () { cancelled = true; clearTimeout(timer); };
    return p;
  }

  /** Trades the paired device's key for a fresh subscription token. */
  function byDevice() {
    var s = load();
    return accountPost('/v2/account/subscriber/authenticate/by-device', {
      AuthenticationKey: s.authKey,
      DeviceId: s.deviceId,
      DistributionChannel: PROFILE.distributionChannel,
      Language: PROFILE.language
    }, false).then(function (res) {
      var t = res.data && res.data.subscriptionToken;
      if (!t) throw new Error('No token in by-device response');
      update({ subscriptionToken: t, authKey: res.AuthenticationKey || s.authKey });
      return t;
    });
  }

  /**
   * Silent renewal for a paired TV: a fresh token, or null when F1 refuses the device key (removed from
   * the account). A network or server error rejects, so a blip does not look like being signed out.
   */
  function renew() {
    if (!isPaired()) return Promise.resolve(null);
    return byDevice().catch(function (e) {
      if (e && (e.fault || (e.status >= 400 && e.status < 500) || /No token/.test(e.message))) return null;
      throw e;
    });
  }

  return {
    PAIR_PAGE: PAIR_PAGE,
    token: token,
    isPaired: isPaired,
    profile: profile,
    clear: clear,
    pairUrl: pairUrl,
    pair: pair,
    renew: renew
  };
})();
