'use strict';
const fs = require('node:fs'), path = require('node:path');
const tool = require('./common');
function sourceFiles() {
  const server = path.join(tool.ROOT, 'server');
  const files = tool.listFiles(server).filter(file => file.endsWith('.js'));
  for (const name of ['app/backend.js', 'client/client-routing.js']) files.push(tool.within(tool.ROOT, name));
  return files.map(file => ({ file, name: path.relative(tool.ROOT, file).split(path.sep).join('/') })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function copy(source, destination) {
  tool.assertOrdinary(source, true); tool.assertOrdinary(destination);
  if (!fs.statSync(source).isFile()) throw new Error('Source is not a regular file: ' + source);
  tool.mkdir(path.dirname(destination)); fs.copyFileSync(source, destination);
}
function main() {
  tool.assertNode(); if (process.argv.length !== 2) throw new Error('build takes no arguments; output is fixed to dist/Local300-v0.12.exe.');
  const manifest = tool.verifyAssets(), source = sourceFiles();
  const nodeLicense = process.env.NODE_LICENSE_FILE ? path.resolve(process.env.NODE_LICENSE_FILE) : path.join(tool.ROOT, 'app', 'Node-LICENSE.txt');
  if (process.versions.node !== '24.19.0' && !process.env.NODE_LICENSE_FILE) throw new Error('The bundled license belongs to Node.js 24.19.0. For another Node.js 24 release, set NODE_LICENSE_FILE to that runtime distribution\'s LICENSE.');
  tool.assertOrdinary(nodeLicense, true);
  if (fs.statSync(nodeLicense).size < 1000) throw new Error('A complete Node.js distribution LICENSE is required.');
  const artifactHelper = tool.helper();
  tool.resetBuild(); const payload = path.join(tool.BUILD, 'payload'); tool.mkdir(payload);
  for (const row of manifest.files) copy(tool.within(tool.ASSETS, row.path), tool.within(payload, row.path));
  // Keep the imported player guide while omitting the old personal byline.
  const guideFile = tool.within(payload, 'docs/使用说明.txt');
  const guide = fs.readFileSync(guideFile, 'utf8').split(/\r?\n/).filter(line => !/^\s*作者\s*[:：]/u.test(line)).join('\n');
  fs.writeFileSync(guideFile, guide, 'utf8');
  for (const row of source) copy(row.file, tool.within(payload, row.name));
  copy(process.execPath, path.join(payload, 'runtime', 'node.exe'));
  copy(nodeLicense, path.join(payload, 'runtime', 'Node-LICENSE.txt'));
  // Refresh the public diagnostic index after replacing sealed stubs with
  // editable source. The authoritative launcher index is regenerated below.
  const publicIndexFile = path.join(payload, 'public-assets-index.json');
  const publicIndex = JSON.parse(fs.readFileSync(publicIndexFile, 'utf8'));
  if (!Array.isArray(publicIndex.files)) throw new Error('Invalid public assets index.');
  for (const row of publicIndex.files) {
    const file = tool.within(payload, row.path);
    if (!fs.existsSync(file)) throw new Error('Public asset index references a missing file: ' + row.path);
    row.bytes = fs.statSync(file).size; row.sha256 = tool.hashFile(file);
    if (row.path.endsWith('.js')) { row.sourceSHA256 = row.sha256; delete row.codeWrapper; row.policy = 'community-editable-source'; }
  }
  tool.writeJson(publicIndexFile, publicIndex);
  const index = tool.listFiles(payload).map(file => ({ path: path.relative(payload, file).split(path.sep).join('/'), bytes: fs.statSync(file).size, sha256: tool.hashFile(file) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  tool.checkedRows(index); tool.writeJson(path.join(payload, 'file-index.json'), index);
  console.log(tool.run(artifactHelper, ['zip']));
  const archive = path.join(tool.BUILD, 'payload.zip'), info = path.join(tool.BUILD, 'BuildInfo.cs');
  const payloadHash = tool.hashFile(archive), indexHash = tool.hashFile(path.join(payload, 'file-index.json'));
  fs.writeFileSync(info, 'static class BuildInfo { internal const string PayloadSHA="' + payloadHash + '"; internal const string IndexSHA="' + indexHash + '"; }\n');
  const dist = path.join(tool.ROOT, 'dist'); tool.mkdir(dist);
  const exe = tool.assertOrdinary(path.join(dist, 'Local300-v0.12.exe'));
  if (fs.existsSync(exe) && !fs.statSync(exe).isFile()) throw new Error('The output EXE path is not a file.');
  const compilerOutput = tool.compile(exe, [path.join(tool.ROOT, 'app', 'Launcher.cs'), path.join(tool.ROOT, 'app', 'ClientUpdateGuard.cs'), info], ['/target:winexe', '/resource:' + archive + ',payload', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', '/reference:Microsoft.CSharp.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll']);
  if (compilerOutput) console.log(compilerOutput);
  console.log(tool.run(artifactHelper, ['verify-build']));
  const record = {
    format: 'local300-community-build-v1', version: '0.12', sourceMode: 'unsealed-editable-source',
    sourceAssetExeSha256: tool.ACCEPTED_EXE_SHA256, nodeVersion: process.versions.node,
    nodeSha256: tool.hashFile(process.execPath), nodeLicenseSha256: tool.hashFile(nodeLicense),
    payloadSha256: payloadHash, indexSha256: indexHash, sourceFiles: source.length, payloadFiles: index.length,
    exe: 'dist/Local300-v0.12.exe', bytes: fs.statSync(exe).size, sha256: tool.hashFile(exe)
  };
  tool.writeJson(path.join(dist, 'BUILD.json'), record);
  console.log(JSON.stringify(record, null, 2));
  console.log('Build complete. The EXE was compiled but was not run. Keep .local/ and dist/ out of source control.');
  return record;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { main, sourceFiles };
