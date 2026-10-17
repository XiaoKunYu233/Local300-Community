'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs');
const tool = require('./common'), { parse } = require('./import-assets');
const row = name => ({ path: name, bytes: 0, sha256: '0'.repeat(64) });
test('manifest paths reject traversal, alternate streams, reserved device names and Windows ambiguities', () => {
  for (const name of ['../secret', '/root', 'C:/root', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'x.', 'a/nul.txt', 'a/b ', 'a/evil:stream', 'a/*', 'a/<x>', 'a/\0x']) assert.throws(() => tool.safeRelative(name), /Invalid manifest path/);
  assert.equal(tool.safeRelative('server/public-beta/release-template/role.bin'), 'server/public-beta/release-template/role.bin');
});
test('import permits indexed static assets and anonymous seed but rejects code, executables and runtime saves', () => {
  for (const name of ['server/items.json', 'server/public-beta/release-template/account-template/bag-state.json', 'runtime/Node-LICENSE.txt', 'server/local-native-capture/events.jsonl', 'public-assets-index.json']) assert.equal(tool.assetAllowed(name), true, name);
  for (const name of ['server/liveserver.js', 'sealed-code/a.bin', 'sealed-loader.js', 'runtime/node.exe', 'Local300-data/save/admin/state.json', 'server/save/admin/state.json', 'server/secret.ps1']) assert.equal(tool.assetAllowed(name), false, name);
});
test('manifest rejects duplicates including case collisions, extra fields, invalid sizes and hashes', () => {
  assert.throws(() => tool.checkedRows([row('server/A.json'), row('server/a.json')]), /Duplicate/);
  for (const bad of [{ ...row('a'), bytes: -1 }, { ...row('a'), bytes: 1.5 }, { ...row('a'), bytes: 2 ** 40 }, { ...row('a'), sha256: 'bad' }, { ...row('a'), unexpected: true }]) assert.throws(() => tool.checkedRows([bad]));
  assert.throws(() => tool.checkedRows([row('server/a.js')], true), /Non-asset/);
  assert.deepEqual(tool.checkedRows([row('server/a.json')], true), [row('server/a.json')]);
});
test('all derived paths remain below fixed roots and import CLI cannot supply destinations or commands', () => {
  assert.throws(() => tool.within(tool.ASSETS, '../outside'));
  assert.equal(tool.within(tool.ASSETS, 'server/a.json'), path.join(tool.ASSETS, 'server', 'a.json'));
  for (const args of [[], ['--exe=x'], ['--exe', 'relative.exe'], ['--exe=\\\\network\\release.exe'], ['--exe=\\\\?\\C:\\release.exe'], ['--exe=C:\\release.exe:stream'], ['--exe=C:\\release.exe', '--out=C:\\elsewhere'], ['--run=game']]) assert.throws(() => parse(args));
  assert.equal(parse(['--exe=C:\\release.exe']), 'C:\\release.exe');
  assert.equal(parse(['--exe', 'C:\\release.exe']), 'C:\\release.exe');
});
test('toolchain is offline and independent of personal Python or Node locations', () => {
  for (const file of ['common.js', 'build.js', 'import-assets.js', 'ArtifactTool.cs']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(source, /https?:\/\/|[a-z]:[\\/]+users[\\/]+|\.cache[\\/]codex|spawnSync\([^\n]*shell:\s*true|python\.exe/i);
  }
});
