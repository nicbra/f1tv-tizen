'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SENSITIVE = /token|authorization|auth(?:entication)?key|apikey|password|secret|cookie|customdata/i;
const SAFE_QUERY = new Set(['contentId', 'channelId', 'player']);

function errorInfo(error) {
  if (!error) return null;
  return { name: error.name, message: error.message, stack: error.stack,
    code: error.code, status: error.status, data: error.data,
    cause: error.cause ? errorInfo(error.cause) : undefined };
}

/** Evidence about encryption and formats, without key URIs, PSSH payloads or segment URLs. */
function manifestSummary(body) {
  if (/^#EXTM3U\s/.test(body)) {
    const keys = [...body.matchAll(/^#EXT-X-(?:SESSION-)?KEY:(.*)$/gm)].map(([, line]) => {
      const attrs = {};
      for (const [, key, value] of line.matchAll(/(?:^|,)\s*([\w-]+)=("[^"]*"|[^,]*)/g)) {
        attrs[key] = value.replace(/^"|"$/g, '');
      }
      return { method: attrs.METHOD || 'unknown', keyFormat: attrs.KEYFORMAT || 'identity' };
    });
    const hlg = [];
    for (const [, line] of body.matchAll(/^#EXT-X-STREAM-INF:(.*)$/gm)) {
      if (!/(?:^|,)VIDEO-RANGE=HLG(?:,|$)/.test(line)) continue;
      const size = /(?:^|,)RESOLUTION=(\d+)x(\d+)(?:,|$)/.exec(line);
      if (size) hlg.push({ width: +size[1], height: +size[2] });
    }
    return { format: 'hls', keys, hlg, endList: /^#EXT-X-ENDLIST/m.test(body),
      programDateTimes: (body.match(/^#EXT-X-PROGRAM-DATE-TIME:/gm) || []).length };
  }
  if (/<MPD\b/.test(body)) {
    return { format: 'dash', dynamic: /<MPD\b[^>]*type="dynamic"/.test(body),
      protection: [...new Set([...body.matchAll(/<ContentProtection\b[^>]*schemeIdUri="([^"]*)"/g)].map((m) => m[1]))] };
  }
  return { format: 'invalid', bytes: Buffer.byteLength(body) };
}

/** Daily JSONL evidence in the existing data volume. Each run has its own id and async context. */
function createDiagnostics(dataDir, { now = () => new Date(), keepDays = process.env.LOG_KEEP_DAYS || 14,
  fetchImpl = globalThis.fetch } = {}) {
  const context = new AsyncLocalStorage();
  const runId = randomUUID();
  const secrets = new Set();
  const dir = path.join(dataDir, 'logs');
  const day = now().toISOString().slice(0, 10);
  const file = path.join(dir, day + '.jsonl');
  const days = Number.isInteger(+keepDays) && +keepDays > 0 ? +keepDays : 14;
  const cutoff = Date.parse(day) - (days - 1) * 86400000;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) {
    if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && Date.parse(name.slice(0, 10)) < cutoff) {
      fs.unlinkSync(path.join(dir, name));
    }
  }

  function remember(value) {
    if (typeof value === 'string' && value) {
      secrets.add(value);
      if (/^Bearer\s+\S/i.test(value)) secrets.add(value.replace(/^Bearer\s+/i, ''));
    }
  }
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE.test(key)) remember(item);
      else collect(item);
    }
  }
  function safeString(value) {
    // Query values on CDN and licence URLs expire and can authorize playback. Keep only routing ids.
    value = value.replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = ''; parsed.password = ''; parsed.hash = '';
        for (const key of [...parsed.searchParams.keys()]) {
          if (!SAFE_QUERY.has(key)) parsed.searchParams.set(key, '[redacted]');
        }
        // Notification webhook credentials can also be in the path.
        if (/discord(?:app)?\.com$/.test(parsed.hostname)) parsed.pathname = '/api/webhooks/[redacted]';
        if (parsed.hostname === 'ntfy.sh') parsed.pathname = '/[redacted]';
        return parsed.toString();
      } catch (e) { return '[redacted URL]'; }
    }).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]');
    for (const secret of secrets) value = value.split(secret).join('[redacted]');
    return value;
  }
  function clean(value) {
    if (typeof value === 'string') return safeString(value);
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      SENSITIVE.test(key) ? '[redacted]' : clean(item)]));
  }
  function log(event, fields = {}) {
    collect(fields);
    fs.appendFileSync(file, JSON.stringify(clean({ at: now().toISOString(), runId,
      ...context.getStore(), event, ...fields })) + '\n', { mode: 0o600 });
  }

  let requestId = 0;
  async function request(url, opts = {}) {
    const headers = new Headers(opts.headers);
    for (const [key, value] of headers) if (SENSITIVE.test(key)) remember(value);
    if (typeof opts.body === 'string') {
      try { collect(JSON.parse(opts.body)); } catch (e) { /* request is not JSON */ }
    }
    const meta = { requestId: ++requestId, url: String(url), method: opts.method || 'GET',
      device: headers.get('x-f1-device-info') || undefined };
    const started = Date.now();
    log('http.start', meta);
    let response;
    try { response = await fetchImpl(url, opts); }
    catch (error) {
      log('http.error', { ...meta, durationMs: Date.now() - started, error: errorInfo(error) });
      throw error;
    }
    const evidence = {};
    try {
      if (/\/CONTENT\/PLAY(?:\?|$)/.test(String(url))) {
        const body = await response.clone().text();
        try { evidence.response = JSON.parse(body); }
        catch (e) { evidence.response = { format: 'not JSON', bytes: Buffer.byteLength(body) }; }
      } else if (/\.(?:m3u8|mpd)(?:\?|$)/i.test(String(url))) {
        evidence.manifest = manifestSummary(await response.clone().text());
      }
    } catch (error) { evidence.evidenceError = errorInfo(error); }
    log('http.response', { ...meta, status: response.status, durationMs: Date.now() - started, ...evidence });
    return response;
  }

  return { file, log, fetch: request, withContext: (fields, fn) => context.run(fields, fn) };
}

module.exports = { createDiagnostics, errorInfo };
