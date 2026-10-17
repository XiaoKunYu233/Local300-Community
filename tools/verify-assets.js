'use strict';
const tool = require('./common');
try { tool.assertNode(); if (process.argv.length !== 2) throw new Error('verify-assets takes no arguments.'); const manifest = tool.verifyAssets(); console.log('Verified ' + manifest.files.length + ' local-only asset files from accepted v0.12.'); }
catch (error) { console.error(error.message); process.exitCode = 1; }
