'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ACCEPTED_EXE_SHA256 = 'c453821d4380fd66761e4810e24e6543d9a55470c61695cdfd70e30c69cbc051';
const ACCEPTED_EXE_BYTES = 43215872;
const ACCEPTED_PAYLOAD_SHA256 = 'fdf4dac26404deeb6f3e193532b7975318304d442db6a5425116fecc0e0a71fe';
const ACCEPTED_INDEX_SHA256 = '19b209ca8e046eb7c09095f436b99c503af1c13eac2fc863e8d45e326dc3a9af';
const ASSET_MANIFEST = 'ASSET-IMPORT.json';
const SOURCE_INDEX = 'SOURCE-FILE-INDEX.json';
const LOCAL = path.join(ROOT, '.local');
const ASSETS = path.join(LOCAL, 'assets');
const BUILD = path.join(LOCAL, 'build');
const HEX = /^[0-9a-f]{64}$/;
const ALLOWED_EXTENSIONS = new Set(['.json', '.jsonl', '.bin', '.tga', '.tsv', '.lua', '.txt', '.md']);
const ALLOWED_ROOTS = new Set(['data', 'decoded', 'docs', 'map', 'runtime', 'server']);

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hashFile(file) { return sha256(fs.readFileSync(file)); }
function assertNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 19) throw new Error('Please use Node.js 24.19 or a later Node.js 24 release.');
  if (process.platform !== 'win32') throw new Error('The launcher build requires Windows and .NET Framework 4.x.');
  if (process.arch !== 'x64') throw new Error('Use the Windows x64 edition of Node.js for the x64 launcher build.');
}
function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || /[\\:\x00-\x1f<>"|?*]/.test(name)) throw new Error('Invalid manifest path');
  if (name.split('/').some(x => !x || x === '.' || x === '..' || /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) throw new Error('Invalid manifest path');
  return name;
}
function assetAllowed(name) {
  safeRelative(name);
  const parts = name.split('/'), lower = name.toLowerCase();
  if (parts.some(x => /^(local300-data|save|\.git|\.local|sealed-code)$/i.test(x))) return false;
  if (lower === 'public-assets-index.json') return true;
  return ALLOWED_ROOTS.has(parts[0]) && ALLOWED_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
}
function checkedRows(rows, assetsOnly = false) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10000) throw new Error('Invalid file manifest');
  const seen = new Set();
  return rows.map(row => {
    if (!row || Object.keys(row).sort().join(',') !== 'bytes,path,sha256') throw new Error('Invalid manifest row');
    const name = safeRelative(row.path), key = name.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate manifest path');
    seen.add(key);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 512 * 1024 * 1024 || !HEX.test(row.sha256)) throw new Error('Invalid manifest size/hash');
    if (assetsOnly && !assetAllowed(name)) throw new Error('Non-asset in imported manifest: ' + name);
    return { path: name, bytes: row.bytes, sha256: row.sha256 };
  });
}
function assertOrdinary(target, requireExists = false) {
  let cursor = path.resolve(target);
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(cursor)) throw new Error('Use an ordinary absolute local-drive path.');
  if (requireExists && !fs.existsSync(cursor)) throw new Error('Required file or directory is missing: ' + cursor);
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Redirected paths are not supported: ' + cursor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return path.resolve(target);
}
function within(base, name) {
  safeRelative(name);
  const result = path.resolve(base, ...name.split('/')), relative = path.relative(base, result);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Path leaves its fixed directory');
  return assertOrdinary(result);
}
function mkdir(directory) { assertOrdinary(directory); fs.mkdirSync(directory, { recursive: true }); }
function writeJson(file, value) { assertOrdinary(file); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function run(file, args) {
  const result = cp.spawnSync(file, args, { shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, cwd: ROOT });
  if (result.error || result.status !== 0) throw new Error([result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n') || 'Command failed: ' + file);
  return result.stdout.trim();
}
function compiler() {
  const selected = process.env.CSC_EXE || path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!path.isAbsolute(selected)) throw new Error('CSC_EXE must be an absolute path to the .NET Framework C# compiler.');
  assertOrdinary(selected, true);
  if (!fs.statSync(selected).isFile()) throw new Error('C# compiler path is not a file');
  return selected;
}
function compile(output, inputs, extra = []) {
  assertOrdinary(output);
  if (fs.existsSync(output) && !fs.statSync(output).isFile()) throw new Error('Compiler output path is not a regular file.');
  mkdir(path.dirname(output));
  return run(compiler(), ['/nologo', '/optimize+', '/platform:x64', '/out:' + output, ...extra, ...inputs]);
}
function helper() {
  assertNode();
  const destination = path.join(LOCAL, 'tools', 'ArtifactTool.exe');
  compile(destination, [path.join(__dirname, 'ArtifactTool.cs')], ['/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll']);
  return destination;
}
function listFiles(directory) {
  assertOrdinary(directory, true);
  const result = [];
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Redirected files are not supported: ' + file);
      if (stat.isDirectory()) walk(file); else if (stat.isFile()) result.push(file); else throw new Error('Unsupported file type: ' + file);
    }
  }
  walk(directory); return result;
}
function verifyAssets() {
  assertOrdinary(ASSETS, true);
  const manifest = JSON.parse(fs.readFileSync(assertOrdinary(path.join(ASSETS, ASSET_MANIFEST), true), 'utf8'));
  if (manifest.format !== 'local300-local-assets-v1' || manifest.sourceExeSha256 !== ACCEPTED_EXE_SHA256 || manifest.payloadSha256 !== ACCEPTED_PAYLOAD_SHA256 || manifest.indexSha256 !== ACCEPTED_INDEX_SHA256) throw new Error('Assets were not imported from the accepted v0.12 release.');
  const indexBytes = fs.readFileSync(assertOrdinary(path.join(ASSETS, SOURCE_INDEX), true));
  if (sha256(indexBytes) !== ACCEPTED_INDEX_SHA256) throw new Error('Original asset allowlist SHA-256 mismatch.');
  const original = checkedRows(JSON.parse(indexBytes)).filter(row => assetAllowed(row.path));
  const rows = checkedRows(manifest.files, true);
  if (JSON.stringify(rows) !== JSON.stringify(original)) throw new Error('Imported manifest differs from the pinned asset allowlist.');
  const expected = new Set(rows.map(row => row.path)); expected.add(ASSET_MANIFEST); expected.add(SOURCE_INDEX);
  for (const file of listFiles(ASSETS)) {
    const name = path.relative(ASSETS, file).split(path.sep).join('/');
    if (!expected.has(name)) throw new Error('Unlisted asset: ' + name);
  }
  for (const row of rows) {
    const file = within(ASSETS, row.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size !== row.bytes || hashFile(file) !== row.sha256) throw new Error('Asset size/hash mismatch: ' + row.path);
  }
  for (const required of ['runtime/Node-LICENSE.txt', 'server/public-beta/release-template/manifest.json', 'server/public-beta/release-template/role.bin', 'server/local-native-capture/events.jsonl', 'public-assets-index.json']) if (!expected.has(required)) throw new Error('Required asset is missing: ' + required);
  return { ...manifest, files: rows };
}
function resetBuild() {
  assertOrdinary(ROOT, true); assertOrdinary(BUILD);
  // Only this exact generated directory can be recursively removed.
  if (path.resolve(BUILD) !== path.join(path.resolve(ROOT), '.local', 'build')) throw new Error('Unsafe build directory');
  if (fs.existsSync(BUILD)) { listFiles(BUILD); fs.rmSync(BUILD, { recursive: true }); }
  mkdir(BUILD);
}
module.exports = { ROOT, LOCAL, ASSETS, BUILD, ACCEPTED_EXE_SHA256, ACCEPTED_EXE_BYTES, ACCEPTED_PAYLOAD_SHA256, ACCEPTED_INDEX_SHA256, ASSET_MANIFEST, SOURCE_INDEX, assertNode, safeRelative, assetAllowed, checkedRows, assertOrdinary, within, mkdir, writeJson, run, compiler, compile, helper, listFiles, verifyAssets, resetBuild, sha256, hashFile };
