#!/usr/bin/env node
'use strict';
const fs = require('fs');
const crypto = require('crypto');
function signingKey(value) {
  if (!value) throw new Error('BUNDLE_SIGNING_KEY is required (Ed25519 PEM or base64 32-byte seed)');
  if (value.includes('BEGIN')) {
    const key = crypto.createPrivateKey(value);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('BUNDLE_SIGNING_KEY must be Ed25519');
    return key;
  }
  const seed = Buffer.from(value.trim(), 'base64');
  if (seed.length !== 32) throw new Error('BUNDLE_SIGNING_KEY seed must be 32 bytes');
  return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}
function publicKey(key) { return crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'); }
function sign(file, config) {
  const key = signingKey(process.env.BUNDLE_SIGNING_KEY);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.keys[manifest.key] || config.keys[manifest.key].startsWith('TODO_')) throw new Error('Replace the TODO public signing key in shell/config.js before releasing');
  if (config.keys[manifest.key] !== publicKey(key)) throw new Error('Signing key does not match shell public key');
  fs.writeFileSync(file + '.sig', crypto.sign(null, fs.readFileSync(file), key).toString('base64') + '\n');
}
if (require.main === module) {
  try { sign(process.argv[2], require(require('path').resolve(process.argv[3] || 'shell/config.js'))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { signingKey, publicKey, sign };
