#!/usr/bin/env node
/* Assemble a WGT tree and portable USTAR bundle without external dependencies. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function hash(b) { return crypto.createHash('sha512').update(b).digest('hex'); }
function walk(dir, prefix = '') {
  return fs.readdirSync(dir).sort().flatMap((name) => {
    const p = prefix + name, full = path.join(dir, name), st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new Error('Source symlink: ' + full);
    return st.isDirectory() ? walk(full, p + '/') : [p];
  });
}
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
}
function tar(files) {
  const chunks = [];
  for (const [name, body] of files) {
    if (Buffer.byteLength(name) > 100) throw new Error('USTAR path too long: ' + name);
    const h = Buffer.alloc(512);
    function str(s, at, len) { h.write(s, at, len, 'ascii'); }
    function oct(n, at, len) { str(n.toString(8).padStart(len - 1, '0') + '\0', at, len); }
    str(name, 0, 100); oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8);
    oct(body.length, 124, 12); oct(0, 136, 12); h.fill(32, 148, 156); h[156] = 48;
    str('ustar\0', 257, 6); str('00', 263, 2);
    const sum = [...h].reduce((a, b) => a + b, 0);
    str(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(h, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); return Buffer.concat(chunks);
}
function assemble(app, shell, out) {
  const dest = path.join(out, 'src');
  const config = require(path.resolve(shell, 'config.js'));
  const version = /<widget\b[^>]*\bversion="([^"]+)"/.exec(fs.readFileSync(path.join(app, 'config.xml'), 'utf8'))[1];
  const files = walk(app).filter((p) => p !== 'config.xml' && p !== 'launcher-build.js');
  const bodies = files.map((p) => [p, fs.readFileSync(path.join(app, p))]);
  const archive = tar(bodies), name = 'bundle-' + version + '.tar';
  const manifest = { format: 1, version, minShell: config.SHELL_LEVEL, built: new Date().toISOString(),
    archive: { name, size: archive.length, sha512: hash(archive) }, files: {},
    revokes: JSON.parse(fs.readFileSync(path.join(__dirname, 'revokes.json'), 'utf8')), key: process.env.BUNDLE_KEY_ID || 'f1tv-2026' };
  if (!Array.isArray(manifest.revokes) || manifest.revokes.some((v) => typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v))) throw new Error('Invalid revokes');
  for (const [p, body] of bodies) { manifest.files[p] = { size: body.length, sha512: hash(body) }; copy(path.join(app, p), path.join(dest, 'builtin', p)); }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name), archive);
  fs.writeFileSync(path.join(out, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const p of walk(shell).filter((p) => p !== 'launcher-build.js')) copy(path.join(shell, p), path.join(dest, 'launcher', p));
  const builtin = { manifest };
  fs.writeFileSync(path.join(dest, 'launcher/builtin.json'), JSON.stringify(builtin));
  fs.writeFileSync(path.join(dest, 'launcher/builtin.js'), 'var LauncherBuiltin = ' + JSON.stringify(builtin) + ';\n');
  copy(path.join(app, 'config.xml'), path.join(dest, 'config.xml'));
  copy(path.join(app, 'img/icon.png'), path.join(dest, 'img/icon.png'));
  copy(path.join(shell, 'launcher-build.js'), path.join(dest, 'launcher-build.js'));
  return manifest;
}
if (require.main === module) {
  try { assemble(process.argv[2], process.argv[3], process.argv[4]); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { assemble, tar };
