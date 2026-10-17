'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fold=value=>process.platform==='win32'?value.toLowerCase():value;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(value);
const ownedGuards=new WeakMap();
function rootOf(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||!fs.statSync(directory).isDirectory())throw Error('Existing absolute account directory required');
  return fs.realpathSync(directory);
}
function canonical(file){
  let value=path.resolve(file),tail=[];
  while(!fs.existsSync(value)){tail.unshift(path.basename(value));const parent=path.dirname(value);if(parent===value)throw Error('No existing path ancestor');value=parent;}
  return path.join(fs.realpathSync(value),...tail);
}
function inside(root,file){
  if(typeof file!=='string'||!path.isAbsolute(file))throw Error('Absolute lease path required');
  const target=canonical(file);if(!fold(target).startsWith(fold(root+path.sep)))throw Error('Lease path escapes account directory');return target;
}
function paths(directory){
  const root=rootOf(directory),gate=path.join(root,'account-runtime.operation.lock'),audit=path.join(root,'account-runtime-lease-audit'),lease=path.join(root,'account-runtime.lock');
  for(const file of [gate,audit]){
    if(fold(inside(root,file))!==fold(file))throw Error('Lease metadata directory is redirected');
    if(fs.existsSync(file)&&!fs.statSync(file).isDirectory())throw Error('Lease metadata path is not a directory');
  }
  try{const stat=fs.lstatSync(lease);if(!stat.isFile()||stat.isSymbolicLink()||fold(inside(root,lease))!==fold(lease))throw Error('Runtime lease marker is redirected or not a regular file');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  return {root,gate,audit,lease};
}
function metadataCollision(p,file){
  const target=fold(canonical(file));return [p.gate,p.audit].some(directory=>{
    const reserved=fold(directory);return target===reserved||target.startsWith(reserved+path.sep)||reserved.startsWith(target+path.sep);
  });
}
function durableNew(file,bytes){const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function probe(pid){
  if(!Number.isInteger(pid)||pid<1)return {pid,status:'unknown',reason:'invalid-pid'};
  try{process.kill(pid,0);return {pid,status:'alive'};}catch(error){return {pid,status:error.code==='ESRCH'?'terminated':'unknown',reason:error.code||error.message};}
}
function readClaim(file,expected){
  const bytes=fs.readFileSync(file),value=JSON.parse(bytes);
  if(value.version!==1||value.kind!=='account-runtime-operation'||!uuid(value.token)||!Number.isInteger(value.pid)||value.pid<1||
    value.operation!==expected.operation||value.uid!==expected.uid||value.expectedSha256!==expected.expectedSha256||
    fold(value.directory)!==fold(expected.directory)||!Number.isSafeInteger(value.startedAt)||value.startedAt<0||
    value.index!==expected.index||value.previousSha256!==expected.previousSha256||value.rootToken!==expected.rootToken)throw Error('Invalid lease operation claim');
  return {file,bytes,value,sha256:hash(bytes)};
}
function acquire(directory,{operation,uid=null,expectedSha256=null,resume=false}={}){
  if(!['lease-create','lease-update','lease-close','lease-recovery','economic-rollback','profile-history-import'].includes(operation))throw Error('Invalid lease operation');
  const p=paths(directory),rootToken=crypto.randomUUID();let created=false;
  try{fs.mkdirSync(p.gate);created=true;}catch(error){if(error.code!=='EEXIST')throw error;if(!resume||operation!=='lease-recovery')throw error;}
  let index=0,previousSha256=null,token=rootToken,previous;const priorEvidence=[];
  if(!created){
    const first=JSON.parse(fs.readFileSync(inside(p.root,path.join(p.gate,'claim-0.json'))));
    if(!uuid(first.rootToken))throw Error('Uncertain lease operation guard');token=first.rootToken;
    for(;index<10000;index++){
      const file=inside(p.root,path.join(p.gate,'claim-'+index+'.json'));
      if(!fs.existsSync(file))break;
      previous=readClaim(file,{operation,uid,expectedSha256,directory:p.root,index,previousSha256,rootToken:token});
      priorEvidence.push({file,bytes:previous.bytes});
      const finished=path.join(p.gate,'claim-'+index+'.finished.json');let released=false;
      if(fs.existsSync(finished)){
        const finishBytes=fs.readFileSync(inside(p.root,finished)),value=JSON.parse(finishBytes);
        if(value.version!==1||value.claimSha256!==previous.sha256||value.status!=='failed'||!Number.isSafeInteger(value.finishedAt)||value.finishedAt<previous.value.startedAt)throw Error('Invalid lease operation finish evidence');released=true;
        priorEvidence.push({file:finished,bytes:finishBytes});
      }
      if(!released&&probe(previous.value.pid).status!=='terminated')throw Error('Lease recovery operation still alive or cannot be verified');
      previousSha256=previous.sha256;
    }
    if(!previous||index>=10000)throw Error('Uncertain lease operation claim chain');
  }
  const claimFile=path.join(p.gate,'claim-'+index+'.json'),value={version:1,kind:'account-runtime-operation',operation,uid,expectedSha256,
    directory:p.root,rootToken:token,token:crypto.randomUUID(),pid:process.pid,index,previousSha256,startedAt:Date.now()};
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  // A deterministic successor filename is opened exclusively. Concurrent
  // recovery processes cannot replace or both take over a dead claim.
  durableNew(inside(p.root,claimFile),bytes);
  let finished=false;
  const guard={...p,token,index,claimFile,claimBytes:bytes,claimSha256:hash(bytes),
    verify(){
      paths(p.root);
      if(finished||!fs.readFileSync(inside(p.root,claimFile)).equals(bytes)||fs.existsSync(path.join(p.gate,'claim-'+(index+1)+'.json')))throw Error('Lease operation ownership changed');
      for(const evidence of priorEvidence)if(!fs.readFileSync(inside(p.root,evidence.file)).equals(evidence.bytes))throw Error('Lease operation claim chain changed');
    },
    close({retain=false}={}){
      guard.verify();
      if(retain){
        durableNew(path.join(p.gate,'claim-'+index+'.finished.json'),Buffer.from(JSON.stringify({version:1,status:'failed',claimSha256:guard.claimSha256,finishedAt:Date.now()})+'\n'));
        finished=true;return;
      }
      fs.mkdirSync(p.audit,{recursive:true});paths(p.root);guard.verify();
      const destination=inside(p.root,path.join(p.audit,'operation-'+token));
      if(fs.existsSync(destination))throw Error('Lease operation audit already exists');
      fs.renameSync(p.gate,destination);finished=true;
      if(!fs.readFileSync(path.join(destination,'claim-'+index+'.json')).equals(bytes))throw Error('Archived lease operation ownership changed');
    }};
  ownedGuards.set(guard,{...p,token,index,claimFile,bytes:Buffer.from(bytes),value,verify:guard.verify,close:guard.close});
  return guard;
}
function assertOwnedGuard(guard,{directory,operation,uid=null,expectedSha256=null}={}){
  const owned=guard&&ownedGuards.get(guard);
  if(!owned)throw Error('Caller-owned lease operation guard required');
  if(fold(rootOf(directory))!==fold(owned.root)||owned.value.operation!==operation||owned.value.uid!==uid||
    owned.value.expectedSha256!==expectedSha256||owned.value.pid!==process.pid)throw Error('Caller-owned lease operation guard does not match recovery');
  for(const key of ['root','gate','audit','lease','token','index','claimFile'])if(guard[key]!==owned[key])throw Error('Caller-owned lease operation guard changed');
  if(guard.verify!==owned.verify||guard.close!==owned.close||guard.claimSha256!==hash(owned.bytes)||
    !Buffer.isBuffer(guard.claimBytes)||!guard.claimBytes.equals(owned.bytes))throw Error('Caller-owned lease operation guard changed');
  owned.verify();
  const current=readClaim(inside(owned.root,owned.claimFile),owned.value);
  if(current.value.pid!==process.pid||current.value.token!==owned.value.token||!current.bytes.equals(owned.bytes))throw Error('Caller-owned lease operation claim changed');
  return guard;
}
function moveChecked(file,expectedBytes,guard,quarantine){
  const source=inside(guard.root,file),target=inside(guard.root,quarantine);guard.verify();
  if(!fs.readFileSync(source).equals(expectedBytes))throw Error('Account runtime lease changed');
  if(fs.existsSync(target))throw Error('Lease quarantine already exists');
  fs.renameSync(source,target);
  // The rename is not a compare-and-swap. Verify the bytes actually moved;
  // on replacement restore by exclusive hardlink, never overwrite a new lock.
  const moved=fs.readFileSync(target);
  if(!moved.equals(expectedBytes)){
    try{fs.linkSync(target,source);}catch(error){if(error.code!=='EEXIST')error.leaseGap=true;throw Object.assign(Error('Changed lease retained in quarantine: '+error.message),{leaseGap:!fs.existsSync(source)});}
    throw Error('Account runtime lease changed during move; replacement restored');
  }
  guard.verify();return target;
}
module.exports={hash,fold,rootOf,canonical,inside,paths,metadataCollision,durableNew,probe,acquire,assertOwnedGuard,moveChecked};
