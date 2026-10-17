'use strict';
// Generic source-boundary checks. Maintainer-only identity checks are separate.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
const ROOT=path.resolve(__dirname,'..');
const compatibilitySources=new Set(require('./source-policy.json').compatibilitySources);
const ignored=new Set(['.git','.local','dist','node_modules','.vs']);
const forbiddenDirectory=/^(?:Local300-data|history|research|logs|captures?|evidence|client-backups|account-checkpoints|release-template|local-native-capture|private-original)$/i;
const forbiddenFile=/\.(?:exe|dll|pdb|jmp|bin|tga|xlsx|zip|db|sqlite|jsonl|log|pem|key|pfx)(?:-(?:wal|shm))?$/i;
const failures=[],files=[];
function walk(directory){
 for(const row of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,row.name),relative=path.relative(ROOT,file).replace(/\\/g,'/');
  if(row.isSymbolicLink()){failures.push(relative+': links are not accepted');continue;}
  if(row.isDirectory()){
   if(ignored.has(row.name)||row.name==='test-fixtures')continue;
   if(forbiddenDirectory.test(row.name)&&![...compatibilitySources].some(name=>name.startsWith(relative+'/'))){failures.push(relative+': runtime or private-data directory');continue;}walk(file);continue;
  }
  if(!row.isFile()){failures.push(relative+': unsupported file type');continue;}
  if(relative.startsWith('server/research/')&&!compatibilitySources.has(relative)){failures.push(relative+': not an approved compatibility source');continue;}
  if(forbiddenFile.test(row.name)||/^\.env(?:\.|$)/i.test(row.name)){failures.push(relative+': generated, data or credential file');continue;}
  const bytes=fs.readFileSync(file);files.push(relative);
  if(bytes.includes(0)){failures.push(relative+': binary bytes are not source');continue;}
  const source=bytes.toString('utf8');
  // Keep checks structural: do not embed a maintainer's private identifiers here.
  if(/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\s\\/"']+/i.test(source))failures.push(relative+': personal Windows profile path');
  if(/[A-Za-z]:[\\/]{1,2}Codex[\\/]{1,2}\d{4}-\d{2}-\d{2}[\\/]/i.test(source))failures.push(relative+': internal workspace path');
  if(/(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{18,}/.test(source))failures.push(relative+': possible literal access token');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source))failures.push(relative+': private key');
  if(relative.endsWith('.js'))try{new vm.Script(Module.wrap(source.replace(/^#![^\r\n]*(?:\r?\n|$)/,'')),{filename:relative});}catch(e){failures.push(relative+': JavaScript syntax: '+e.message);}
 }
}
walk(ROOT);
const result={ok:failures.length===0,sourceFiles:files.length,failures,scope:'Source-tree boundaries and common credential patterns; not a guarantee against every unknown secret or third-party rights issue'};
console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
module.exports=result;
