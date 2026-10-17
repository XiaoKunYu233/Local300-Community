'use strict';
// JSON account writers and cross-file economic commits share the existing
// ledger lock. Re-entry is a private, synchronous capability in this process;
// a PID or token copied from a file never grants it.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Gate=require('./player-account-runtime-lease-gate');
const fold=Gate.fold,active=new Map(),bindings=new Map();
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function checked(file){
  if(typeof file!=='string'||!path.isAbsolute(file))throw Error('Absolute JSON lock path required');
  const resolved=path.resolve(file),canonical=Gate.canonical(resolved);
  if(fold(resolved)!==fold(canonical))throw Error('JSON write path is redirected');
  try{const stat=fs.lstatSync(resolved);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('JSON write path is not a private regular file');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  return resolved;
}
function bind(ledger,marker){
  const key=fold(checked(ledger)),file=checked(marker),prior=bindings.get(key);
  if(prior&&fold(prior)!==fold(file))throw Error('Conflicting account pending binding');
  bindings.set(key,file);
}
function configured(ledger){
  const key=fold(checked(ledger));
  if(process.env.DSH_PLAYER_ACCOUNTS&&fold(path.resolve(process.env.DSH_PLAYER_ACCOUNTS))===key){
    if(!path.isAbsolute(process.env.DSH_PLAYER_ACCOUNTS)||!process.env.DSH_EQUIPMENT_PENDING)throw Error('Incomplete explicit account pending binding');
    bind(ledger,process.env.DSH_EQUIPMENT_PENDING);
  }
  return bindings.get(key)||null;
}
function existingMarker(ledger){const marker=configured(ledger);if(marker&&fs.existsSync(marker))throw Error('Account writes blocked by pending economic transaction');}
function acquire(file,bytes){
  checked(file);fs.mkdirSync(path.dirname(file),{recursive:true});
  const fd=fs.openSync(file,'wx');let closed=false;
  // An incomplete write is deliberately retained, never treated as stale.
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}catch(error){fs.closeSync(fd);closed=true;throw error;}
  const verify=()=>{checked(file);if(!fs.readFileSync(file).equals(bytes))throw Error('JSON ledger lock ownership changed');};
  return {file,verify,close(){if(closed)return;verify();fs.closeSync(fd);closed=true;verify();fs.unlinkSync(file);}};
}
function declaration(ledger,marker,owner){
  const target=checked(ledger),file=checked(target+'.lock');
  const bytes=Buffer.from(JSON.stringify({version:1,kind:'equipment-economy-json-write',pid:owner.pid,token:owner.token,ledger:target,markerFile:checked(marker)})+'\n');
  return {file,state:'requested',contentBase64:bytes.toString('base64'),sha256:hash(bytes)};
}
function economic(ledger,marker,decl,verifyMarker){
  const key=fold(checked(ledger));bind(ledger,marker);
  if(active.has(key))throw Error('Nested economic account writer');
  if(typeof verifyMarker!=='function')throw Error('Economic marker verifier required');
  const guard=acquire(decl.file,Buffer.from(decl.contentBase64,'base64'));
  const capability={verify(){guard.verify();verifyMarker();}};
  let entered=false;
  return {verify:guard.verify,enter(){capability.verify();if(entered||active.has(key))throw Error('Economic account capability already entered');active.set(key,capability);entered=true;},
    close(){if(entered){if(active.get(key)!==capability)throw Error('Economic account capability changed');active.delete(key);entered=false;}guard.close();}};
}
function write(ledger,operation){
  const file=checked(ledger),key=fold(file),owned=active.get(key);
  if(owned){owned.verify();const value=operation(owned.verify);owned.verify();return value;}
  const bytes=Buffer.from(JSON.stringify({version:1,kind:'player-account-json-write',pid:process.pid,token:crypto.randomUUID(),at:Date.now()})+'\n');
  const guard=acquire(file+'.lock',bytes);
  const verify=()=>{guard.verify();existingMarker(file);};
  try{verify();const value=operation(verify);verify();return value;}finally{guard.close();}
}
module.exports={checked,bind,configured,declaration,economic,write};
