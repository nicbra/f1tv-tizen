#!/usr/bin/env node
/* Local TV fixture generator. No test key is embedded or copied into committed source. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assemble } = require('./build-bundle');
const { signingKey, publicKey, sign } = require('./sign-bundle');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || '/tmp/f1tv-test-source');
const version = process.env.TEST_VERSION || '9.0.1';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid TEST_VERSION');
const publicValue = publicKey(signingKey(process.env.BUNDLE_SIGNING_KEY));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'f1tv-test-source-'));
try {
  fs.cpSync(path.join(root, 'app'), path.join(stage, 'app'), { recursive: true });
  fs.cpSync(path.join(root, 'shell'), path.join(stage, 'shell'), { recursive: true });
  const cfg = { ...require('../shell/config'), keys: { 'local-test': publicValue } };
  cfg.SHELL_LEVEL = Number(process.env.TEST_MIN_SHELL || cfg.SHELL_LEVEL);
  fs.writeFileSync(path.join(stage, 'shell/config.js'), 'module.exports = ' + JSON.stringify(cfg) + ';\n');
  const xml = path.join(stage, 'app/config.xml');
  fs.writeFileSync(xml, fs.readFileSync(xml, 'utf8').replace(/(<widget\b[^>]*\bversion=")[^"]+"/, '$1' + version + '"'));
  if (process.env.FAULT === 'timeout') {
    const app = path.join(stage, 'app/js/app.js');
    fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('function launcherReady() {', 'function launcherReady() { return; // local timeout fixture'));
  } else if (process.env.FAULT === 'service') {
    fs.writeFileSync(path.join(stage, 'app/service/service.js'), "throw new Error('Local service rollback fixture');\n");
  } else if (process.env.FAULT) throw new Error('FAULT must be timeout or service');
  process.env.BUNDLE_KEY_ID = 'local-test';
  assemble(path.join(stage, 'app'), path.join(stage, 'shell'), out);
  const manifest = path.join(out, 'bundle.json'), m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (process.env.BUNDLE_REVOKES) m.revokes = m.revokes.concat(process.env.BUNDLE_REVOKES.split(','));
  m.notes = 'Local launcher test ' + version + (process.env.FAULT ? ': ' + process.env.FAULT : '');
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n'); sign(manifest, cfg);
  if (process.env.LAUNCHER_TEST_SOURCE) {
    const localBuild = { updates: true, source: process.env.LAUNCHER_TEST_SOURCE, keys: { 'local-test': publicValue } };
    fs.mkdirSync(path.join(root, 'local/app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'local/app/launcher-build.js'), '(function(root){var build=' + JSON.stringify(localBuild) + ';if(typeof module!=="undefined"&&module.exports)module.exports=build;else root.LauncherBuild=build;})(this);\n');
  }
  console.log('Signed local test source: ' + out);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
