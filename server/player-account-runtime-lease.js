'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),G=require('./player-account-runtime-lease-gate');
const id=value=>Number.isInteger(value)&&value>0&&value<=0xffffffff;
function validate(value,{directory,uid}={}){
  const p=G.paths(directory);
  if(value?.version!==2||value.kind!=='account-runtime')throw Error('Legacy or unknown runtime lease cannot establish worker termination');
  if(!id(uid)||value.uid!==uid||G.fold(value.directory)!==G.fold(p.root)||!Number.isInteger(value.managerPid)||value.managerPid<1||
    typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token)||!Number.isSafeInteger(value.startedAt)||value.startedAt<0||
    !Number.isSafeInteger(value.revision)||value.revision<0||!['created','starting','running','stopping','stopped'].includes(value.phase)||
    !value.identity||!id(value.identity.playerId)||!/^[a-f0-9]{64}$/.test(value.identity.loginHash)||
    !Array.isArray(value.expectedServices)||!value.expectedServices.length||new Set(value.expectedServices).size!==value.expectedServices.length||
    value.expectedServices.some(service=>!['lobby','battle'].includes(service))||!Array.isArray(value.workers))throw Error('Invalid runtime lease identity or lifecycle');
  if(!value.storage||!['json','sqlite'].includes(value.storage.kind)||G.fold(G.inside(p.root,value.storage.path))!==G.fold(value.storage.path)||
    value.storage.kind==='sqlite'&&(typeof value.storage.scope!=='string'||!value.storage.scope))throw Error('Invalid runtime lease account storage');
  if(G.metadataCollision(p,value.storage.path))throw Error('Account storage collides with runtime lease metadata');
  const services=new Set(),pids=new Set();
  for(const worker of value.workers){
    if(worker.uid!==uid||!value.expectedServices.includes(worker.service)||services.has(worker.service)||!Number.isInteger(worker.pid)||worker.pid<1||
      worker.pid===value.managerPid||pids.has(worker.pid)||typeof worker.attempt!=='string'||!/^[a-f0-9-]{36}$/.test(worker.attempt)||
      !['registered','ready','exited'].includes(worker.phase))throw Error('Invalid registered runtime worker');services.add(worker.service);pids.add(worker.pid);
  }
  if(value.pendingSpawn!==null){
    const pending=value.pendingSpawn;if(!pending||pending.uid!==uid||!value.expectedServices.includes(pending.service)||
      typeof pending.attempt!=='string'||!/^[a-f0-9-]{36}$/.test(pending.attempt)||!Number.isSafeInteger(pending.startedAt)||pending.startedAt<0)throw Error('Invalid uncertain spawn evidence');
  }
  return value;
}
function accountProof(value){
  let bytes;
  if(value.storage.kind==='json')bytes=fs.readFileSync(value.storage.path);
  else{
    const store=new(require('./persistence/document-store').DocumentStore)(value.storage.path,{readOnly:true});
    try{bytes=Buffer.from(store.read(value.storage.scope,'player-accounts'));}finally{store.close();}
  }
  // An unfinished economic transaction need not have valid assets. Bind the
  // single ledger identity without repairing, normalizing or writing it.
  const ledger=JSON.parse(bytes),keys=Object.keys(ledger.accounts||{}),account=ledger.accounts?.[value.uid];
  if(keys.length!==1||keys[0]!==String(value.uid)||!account||account.uid!==value.uid||account.playerId!==value.identity.playerId||
    account.loginHash!==value.identity.loginHash)throw Error('Runtime lease is not bound to this single-account ledger');
  return {uid:value.uid,playerId:account.playerId,ledgerSha256:G.hash(bytes)};
}
function create(plan,{withBattle=false}={}){
  const p=G.paths(plan.directory),guard=G.acquire(p.root,{operation:'lease-create',uid:plan.account.uid});
  try{
    const backend=plan.environment.DSH_STATE_BACKEND||'json';
    const value={version:2,kind:'account-runtime',uid:plan.account.uid,directory:p.root,managerPid:process.pid,token:crypto.randomUUID(),
      startedAt:Date.now(),revision:0,phase:'created',expectedServices:withBattle?['battle','lobby']:['lobby'],workers:[],pendingSpawn:null,
      identity:{playerId:plan.account.playerId,loginHash:plan.account.loginHash},storage:backend==='sqlite'?
        {kind:'sqlite',path:G.inside(p.root,plan.environment.DSH_STATE_DB),scope:plan.environment.DSH_STATE_SCOPE}:
        {kind:'json',path:G.inside(p.root,plan.environment.DSH_PLAYER_ACCOUNTS)}};
    validate(value,{directory:p.root,uid:value.uid});accountProof(value);
    const bytes=Buffer.from(JSON.stringify(value)+'\n');G.durableNew(p.lease,bytes);
    const lease={file:p.lease,root:p.root,value,bytes,failed:null,
      update(mutator){
        if(lease.failed)throw Error('Runtime lease recording is uncertain');
        let lock;
        try{
          lock=G.acquire(p.root,{operation:'lease-update',uid:value.uid});
          const next=JSON.parse(JSON.stringify(lease.value));mutator(next);next.revision++;
          validate(next,{directory:p.root,uid:value.uid});
          const nextBytes=Buffer.from(JSON.stringify(next)+'\n');fs.mkdirSync(lock.audit,{recursive:true});G.paths(p.root);
          const prefix=path.join(lock.audit,'revision-'+lease.value.token+'-'+next.revision+'-'+lock.token),temp=prefix+'.next.lock',old=prefix+'.previous.lock';
          G.durableNew(temp,nextBytes);G.moveChecked(lease.file,lease.bytes,lock,old);
          try{fs.linkSync(temp,lease.file);}catch(error){
            try{if(!fs.existsSync(lease.file))fs.linkSync(old,lease.file);}catch(restore){error.leaseGap=true;}
            throw error;
          }
          if(!fs.readFileSync(lease.file).equals(nextBytes))throw Error('Runtime lease installation changed');
          lease.value=next;lease.bytes=nextBytes;fs.unlinkSync(temp);lock.close();lock=null;
        }catch(error){lease.failed=error.message;if(lock)try{lock.close({retain:!!error.leaseGap||!fs.existsSync(lease.file)});}catch{}throw error;}
      },
      release(){
        if(lease.failed)throw Error('Uncertain runtime lease retained: '+lease.failed);
        let lock;
        try{
          lock=G.acquire(p.root,{operation:'lease-close',uid:value.uid});fs.mkdirSync(lock.audit,{recursive:true});G.paths(p.root);
          G.moveChecked(lease.file,lease.bytes,lock,path.join(lock.audit,'closed-'+lease.value.token+'.lock'));
          lock.close();lock=null;
        }catch(error){if(lock)try{lock.close({retain:!!error.leaseGap||!fs.existsSync(lease.file)});}catch{}throw error;}
      }};
    return lease;
  }finally{guard.close({retain:false});}
}
module.exports={validate,accountProof,create};
