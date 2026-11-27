'use strict';
// The player harness: the real settings, service launcher and player.js in a vm with a fake AVPlay and Shaka.
// Used by player-engine.test.js and feature-matrix.test.js.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const textTrack = () => ({ kind: 'subtitles', cues: [], removeCue(c) { this.cues.splice(this.cues.indexOf(c), 1); } });

const el = () => {
  const listeners = {};
  return {
    classList: { add() {}, remove() {}, toggle() {} }, style: {}, textTracks: [textTrack()],
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire: (type) => (listeners[type] || []).forEach((fn) => fn())
  };
};

/** A fake Samsung AVPlay that records what the app asks of it. */
function fakeAvPlay({ liveWindow = '', duration = 0 } = {}) {
  const calls = [];
  let state = 'NONE';
  const av = {
    calls,
    listener: null,
    open: (url) => { calls.push(['open', url]); state = 'IDLE'; },
    setListener: (l) => { av.listener = l; },
    setDrm: (...a) => calls.push(['setDrm', a[0], a[1]]),
    setStreamingProperty: (k, v) => calls.push(['setStreamingProperty', k, v]),
    getStreamingProperty: (k) => k === 'GET_LIVE_DURATION' ? liveWindow : '',
    setBufferingParam: () => {},
    setDisplayRect() {}, setDisplayMethod() {},
    seekTo: (ms, ok) => { calls.push(['seekTo', ms]); setImmediate(ok); },
    prepareAsync: (ok) => { calls.push(['prepareAsync']); state = 'READY'; setImmediate(ok); },
    getDuration: () => duration,
    getTotalTrackInfo: () => [],
    getCurrentStreamInfo: () => [],
    getCurrentTime: () => av.time || 0,
    play: () => { calls.push(['play']); state = 'PLAYING'; },
    pause() {}, setSilentSubtitle() {},
    getState: () => state,
    stop: () => calls.push(['stop']),
    close: () => calls.push(['close'])
  };
  return av;
}

/** Loads the real settings, service launcher and player with a fake AVPlay and Shaka. shakaLoad: Shaka's load(). */
async function player(av, storage, shakaLoad, globals, manifest) {
  const store = Object.assign({}, storage);
  const configs = [], languages = [], manifests = [], channels = [];
  // Shaka's SimpleTextDisplayer as far as it matters here: append() adds the cues to the video's track.
  class SimpleTextDisplayer {
    constructor(video) { this.track = video.textTracks[0]; }
    append(cues) {
      cues.forEach((c) => this.track.cues.push(Object.assign({}, c)));
      this.track.cues.sort((a, b) => a.startTime - b.startTime);
    }
  }
  class ShakaPlayer {
    constructor() { this.responseFilters = []; (context.shakaPlayers = context.shakaPlayers || []).push(this); }
    // As on the TV once the MediaSource is lost (context.mseGone): an attach that sets one up never finishes.
    attach(video, initMediaSource) {
      (context.attaches = context.attaches || []).push(initMediaSource);
      return context.mseGone && initMediaSource !== false ? new Promise(() => {}) : Promise.resolve();
    }
    resetConfiguration() { this.abrFactory = null; }
    configure(config, value) { configs.push(config); if (config === 'abrFactory') this.abrFactory = value; }
    async load(url, start) {
      if (this.abrFactory) this.abrFactory();   // as Shaka: the ABR manager of this load
      if (manifest != null) {
        const response = { data: Buffer.from(manifest), uri: url };
        for (const filter of this.responseFilters) await filter(0, response);
        manifests.push(Buffer.from(response.data).toString('utf8'));
      }
      return shakaLoad ? shakaLoad(url, start) : Promise.reject(new Error('no stream'));
    }
    getNetworkingEngine() { return { registerRequestFilter: (fn) => { (this.requestFilters = this.requestFilters || []).push(fn); }, registerResponseFilter: (fn) => this.responseFilters.push(fn) }; }
    getBufferedInfo() { return context.buffered || { video: [{ start: 0, end: 10 }] }; }
    selectAudioLanguage(l, role, count) { languages.push(['audio', l]); channels.push(count); }
    getAudioLanguages() { return context.audioLanguages || []; }
    // A combined master's text tracks; selections recorded in context.selected (variants: context.variants).
    getTextTracks() { return context.textTracks || []; }
    selectVariantTrack(t, clear, margin) { (context.selected = context.selected || []).push([t.id, clear, margin]); (context.variants || []).forEach((x) => { x.active = x === t; }); }
    selectTextTrack(t) { (context.selected = context.selected || []).push(['text', t.id]); }
    getManifest() { return { variants: [] }; }
    getVariantTracks() { return context.variants || []; }
    getStats() { return { estimatedBandwidth: context.bandwidth || NaN }; }
    selectTextLanguage(l) { languages.push(['text', l]); }
    setTextTrackVisibility(on) { languages.push(['subtitles', on]); }
    addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = fn; }
    unload() { return Promise.resolve(); }
  }
  const context = vm.createContext(Object.assign({
    webapis: { avplay: av },
    shaka: { polyfill: { installAll() {} }, Player: ShakaPlayer, text: { SimpleTextDisplayer },
      net: { NetworkingEngine: { RequestType: { MANIFEST: 0, LICENSE: 2, KEY: 6 } } },
      util: { Error: { Category: {} }, StringUtils: { fromUTF8: (b) => Buffer.from(b).toString('utf8'), toUTF8: (s) => Buffer.from(s) } } },
    document: { body: el() },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    fetch: async () => ({ ok: true }), // the stream helper service answers its ping
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, encodeURIComponent, URL, TextDecoder
  }, globals));
  for (const f of ['settings.js', 'failure.js', 'ways.js', 'proxy.js', 'ttml.js', 'player.js']) vm.runInContext(readFileSync(path.join(__dirname, '..', '..', 'app/js', f), 'utf8'), context);
  const second = el();
  const video = Object.assign(el(), { cloneNode: () => second, parentNode: { insertBefore() {} } });
  await context.Player.init(video, el());
  context.Player.videos = [video, second];
  context.Player.configs = configs;
  context.Player.SimpleTextDisplayer = SimpleTextDisplayer;
  context.Player.languages = languages;
  context.Player.channels = channels;
  context.Player.manifests = manifests;
  context.Player.context = context;
  return context.Player;
}

module.exports = { textTrack, el, fakeAvPlay, player };
