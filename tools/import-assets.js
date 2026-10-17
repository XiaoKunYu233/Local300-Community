'use strict';
const fs = require('node:fs'), path = require('node:path');
const tool = require('./common');
function parse(args) {
  let exe;
  if (args.length === 1 && args[0].startsWith('--exe=')) exe = args[0].slice(6);
  else if (args.length === 2 && args[0] === '--exe') exe = args[1];
  else throw new Error('Usage: npm run import-assets -- --exe="C:\\Downloads\\Local300-v0.12.exe"');
  if (!exe || !path.isAbsolute(exe) || !/^[a-z]:[\\/]/i.test(exe) || exe.slice(2).includes(':')) throw new Error('Supply an ordinary absolute local-drive path to the accepted release EXE.');
  return exe;
}
function main() {
  tool.assertNode();
  const exe = tool.assertOrdinary(parse(process.argv.slice(2)), true);
  if (!fs.statSync(exe).isFile() || fs.statSync(exe).size !== tool.ACCEPTED_EXE_BYTES || tool.hashFile(exe) !== tool.ACCEPTED_EXE_SHA256) throw new Error('EXE size/SHA-256 does not match the accepted v0.12 release. Nothing was imported.');
  if (fs.existsSync(tool.ASSETS)) { const manifest = tool.verifyAssets(); console.log('Existing local assets verified (' + manifest.files.length + ' files).'); return; }
  console.log(tool.run(tool.helper(), ['import', exe]));
  const manifest = tool.verifyAssets(); console.log('Local-only assets verified: ' + manifest.files.length + ' files. No release EXE was executed.');
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { parse, main };
