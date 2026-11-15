#!/usr/bin/env node
/* Verify the exact signed manifest, bounded archive and every archived file. No signing secret. */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const common = require('../shell/common');
const { unpack, sha } = require('../shell/updater');

function verify(file, config) {
  const raw = fs.readFileSync(file);
  const manifest = common.metadata(JSON.parse(raw.toString('utf8')));
  const encoded = config.keys[manifest.key];
  if (!encoded || encoded.startsWith('TODO_')) throw new Error('Replace the TODO public signing key in shell/config.js before releasing');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Invalid Ed25519 public key in shell/config.js');
  const key = crypto.createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(encoded, 'base64')
  ]) });
  const signatureText = fs.readFileSync(file + '.sig', 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureText)) throw new Error('Invalid bundle signature encoding');
  const signature = Buffer.from(signatureText, 'base64');
  if (!crypto.verify(null, raw, key, signature)) throw new Error('Invalid bundle signature');
  const archivePath = path.join(path.dirname(file), manifest.archive.name);
  if (fs.statSync(archivePath).size !== manifest.archive.size) throw new Error('Archive size mismatch');
  const archive = fs.readFileSync(archivePath);
  if (sha(archive) !== manifest.archive.sha512) throw new Error('Archive hash mismatch');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-verify-'));
  try { unpack(archive, temp, manifest); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return manifest;
}
if (require.main === module) {
  try {
    const manifest = verify(process.argv[2], require(path.resolve(process.argv[3] || 'shell/config.js')));
    console.log('Verified bundle ' + manifest.version + ': signature, archive and all file hashes');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { verify };
