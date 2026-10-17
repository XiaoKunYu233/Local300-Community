'use strict';
const fs = require('node:fs'), path = require('node:path');
const tool = require('./common');
try {
  tool.assertNode(); if (process.argv.length !== 2) throw new Error('test takes no arguments.');
  console.log(tool.run(process.execPath, ['--test', 'tools/tools.test.js', 'client/client-routing.test.js']));
  console.log(tool.run(tool.helper(), ['self-test']));
  const guardTests = path.join(tool.LOCAL, 'tools', 'ClientUpdateGuardTests.exe');
  const compiled = tool.compile(guardTests, [path.join(tool.ROOT, 'app', 'ClientUpdateGuard.cs'), path.join(tool.ROOT, 'app', 'ClientUpdateGuardTests.cs')], ['/target:exe', '/reference:System.Core.dll', '/reference:Microsoft.CSharp.dll']);
  if (compiled) console.log(compiled);
  console.log(tool.run(guardTests, []));
  const audit = path.join(tool.ROOT, 'scripts', 'audit-source.js');
  if (!fs.existsSync(audit)) throw new Error('Source audit script is missing: scripts/audit-source.js');
  console.log(tool.run(process.execPath, [audit]));
  console.log('All checks passed. Only synthetic test fixtures were used; no game, service or real firewall was started.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
