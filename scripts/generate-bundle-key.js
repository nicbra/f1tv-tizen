#!/usr/bin/env node
/* Redirect stdout to a PRIVATE file outside the repo; only the public entry goes in shell/config.js. */
'use strict';
const crypto = require('crypto');
const { signingKey, publicKey } = require('./sign-bundle');
const seed = crypto.randomBytes(32).toString('base64');
console.log('BUNDLE_SIGNING_KEY=' + seed);
console.log('Public entry: ' + JSON.stringify({ 'f1tv-2026': publicKey(signingKey(seed)) }));
