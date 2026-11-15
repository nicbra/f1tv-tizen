/* Shared ES5 policy and Ed25519 verification. Signed bytes are never reserialized. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./vendor/nacl-fast.js'));
  else root.LauncherCommon = factory(root.nacl);
})(this, function (nacl) {
  'use strict';
  function version(v) { return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v); }
  function compare(a, b) {
    var x = a.split('.'), y = b.split('.'), i;
    for (i = 0; i < 3; i++) { if (+x[i] !== +y[i]) return +x[i] > +y[i] ? 1 : -1; }
    return 0;
  }
  function safePath(p) {
    return typeof p === 'string' && p.length <= 180 && /^[a-zA-Z0-9_.\/-]+$/.test(p) &&
      p.charAt(0) !== '/' && p.split('/').every(function (s) { return s && s !== '.' && s !== '..'; });
  }
  function bytes(text) {
    var s = unescape(encodeURIComponent(text)), out = new Uint8Array(s.length), i;
    for (i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function unbase64(s) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = [], n = 0, bits = 0, i, v;
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) throw new Error('Invalid base64');
    for (i = 0; i < s.replace(/=+$/, '').length; i++) {
      v = alphabet.indexOf(s.charAt(i)); n = (n << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((n >>> bits) & 255); }
    }
    return new Uint8Array(out);
  }
  function hex(b) { var out = '', i; for (i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2); return out; }
  function hash(b) { return hex(nacl.hash(new Uint8Array(b))); }
  function metadata(m) {
    if (!m || m.format !== 1 || !version(m.version) || typeof m.minShell !== 'number' || m.minShell < 1 || m.minShell % 1 || !m.archive ||
        m.archive.name !== 'bundle-' + m.version + '.tar' || !validFile(m.archive) || !m.files ||
        typeof m.files !== 'object' || !Object.keys(m.files).length || Object.keys(m.files).length > 2048 ||
        !m.files['index.html'] || !m.files['service/service.js']) throw new Error('Invalid manifest');
    var total = 0;
    Object.keys(m.files).forEach(function (p) { if (!safePath(p) || !validFile(m.files[p]) || p === 'bundle.json' || p === 'bundle.json.sig') throw new Error('Invalid file'); total += m.files[p].size; });
    if (total > 67108864) throw new Error('Bundle size limit');
    if (!Array.isArray(m.revokes) || m.revokes.some(function (v) { return !version(v); })) throw new Error('Invalid revokes');
    return m;
  }
  function validFile(f) { return f && typeof f.size === 'number' && f.size >= 0 && f.size % 1 === 0 && f.size <= 67108864 && /^[a-f0-9]{128}$/.test(f.sha512); }
  function verify(raw, sig, keys) {
    var m = metadata(JSON.parse(raw)), key = keys[m.key];
    if (!key || !nacl.sign.detached.verify(bytes(raw), unbase64(sig.trim()), unbase64(key))) throw new Error('Invalid signature');
    return m;
  }
  function object(v) { return !!v && Object.prototype.toString.call(v) === '[object Object]'; }
  function normalize(state) {
    if (!object(state)) state = {};
    // Start-up health only, shared by the boot page and the service; the service's update fields: updater.js.
    ['bad', 'failures'].forEach(function (field) {
      var value = state[field], clean = {};
      if (object(value)) Object.keys(value).forEach(function (v) {
        if (!version(v)) return;
        if (field === 'bad') { if (value[v] === true || typeof value[v] === 'string') clean[v] = value[v]; }
        else if (typeof value[v] === 'number' && isFinite(value[v]) && value[v] >= 0) clean[v] = value[v];
      });
      state[field] = clean;
    });
    state.revokes = Array.isArray(state.revokes) ? state.revokes.filter(version) : [];
    if (!object(state.boot) || !version(state.boot.version)) state.boot = null;
    else state.boot = { version: state.boot.version, failed: state.boot.failed === true };
    if (!version(state.good)) delete state.good;
    if (!version(state.fallback)) delete state.fallback;
    return state;
  }
  function select(list, level, state) {
    state = state || {};
    var eligible = list.filter(function (b) {
      return b && b.manifest && (b.builtin || (b.manifest.format === 1 && b.manifest.minShell <= level &&
        !(state.bad || {})[b.manifest.version] && (state.revokes || []).indexOf(b.manifest.version) < 0));
    });
    function lowered(b) { return b.builtin && ((state.bad || {})[b.manifest.version] || (state.revokes || []).indexOf(b.manifest.version) >= 0); }
    return eligible.sort(function (a, b) {
      return Number(!!lowered(a)) - Number(!!lowered(b)) || compare(b.manifest.version, a.manifest.version) || (a.builtin ? -1 : 1);
    })[0] || null;
  }
  function begin(state, v, builtin) {
    state.bad = state.bad || {}; state.failures = state.failures || {};
    // An interrupted process is one failure, just like an explicit timeout.
    if (state.boot && !state.boot.failed) {
      fail(state, state.boot.version, 'interrupted start');
    }
    if (state.bad[v] && !builtin) return false;
    state.boot = { version: v, failed: false };
    return true;
  }
  function fail(state, v, reason) {
    if (state.boot && state.boot.version === v && state.boot.failed) return;
    state.failures = state.failures || {}; state.bad = state.bad || {};
    state.failures[v] = (state.failures[v] || 0) + 1;
    if (state.failures[v] >= 2) state.bad[v] = reason;
    state.boot = { version: v, failed: true };
  }
  function ready(state, v) {
    if (state.boot && state.boot.version === v) state.boot = null;
    state.failures = state.failures || {}; delete state.failures[v];
    state.good = v;
  }
  return { version: version, compare: compare, safePath: safePath, bytes: bytes, hash: hash, verify: verify,
    metadata: metadata, normalize: normalize, select: select, begin: begin, fail: fail, ready: ready };
});
