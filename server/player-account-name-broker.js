'use strict';
// Manager-owned reservation only. This module never writes another account's
// files. All callers are bound child handles from this runtime's own plans.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const rename=require('./player-rename-card'),{validate}=require('./player-account-state');
const leasePaths=require('./player-account-runtime-lease-gate');
const MESSAGE_TYPES=new Set(['player-name-reserve','player-name-release']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const clone=value=>JSON.parse(JSON.stringify(value));
class NameBrokerError extends Error{constructor(reason,status=1002,{fatal=false,uncertain=false}={}){super(reason);Object.assign(this,{reason,status,fatal,uncertain});}}
const fail=(reason,status=1002,options)=>{throw new NameBrokerError(reason,status,options);};
function readCurrent(plan){
  const environment=plan.environment,backend=environment.DSH_STATE_BACKEND||'json';let ledger;
  // An unfinished multi-document JSON save must not expose a tentative name.
  const pending=environment.DSH_EQUIPMENT_PENDING||path.join(plan.directory,'equipment-economy-pending.json');
  const accountRoot=leasePaths.rootOf(plan.directory);
  leasePaths.inside(accountRoot,pending);
  leasePaths.inside(accountRoot,backend==='sqlite'?environment.DSH_STATE_DB:environment.DSH_PLAYER_ACCOUNTS);
  if(fs.existsSync(pending))fail('registered-account-storage-pending');
  try{
    if(backend==='json')ledger=JSON.parse(fs.readFileSync(environment.DSH_PLAYER_ACCOUNTS,'utf8'));
    else if(backend==='sqlite'){
      const file=environment.DSH_STATE_DB;
      const live=['-wal','-shm','-journal'].some(suffix=>fs.existsSync(file+suffix));
      const store=live?new(require('./persistence/document-store').DocumentStore)(file,{readOnly:true}):
        require('./persistence/document-store-offline-snapshot').open(file);
      try{ledger=store.readSnapshot(()=>JSON.parse(store.read(environment.DSH_STATE_SCOPE,'player-accounts')));}finally{store.close();}
    }else fail('unsupported-registered-account-storage',1002,{fatal:true});
    validate(ledger);const account=ledger.accounts[plan.account.uid];
    if(Object.keys(ledger.accounts).length!==1||!account||account.uid!==plan.account.uid||account.playerId!==plan.account.playerId||account.loginHash!==plan.account.loginHash)
      fail('registered-account-identity-changed',1002,{fatal:true});
    if(fs.existsSync(pending))fail('registered-account-storage-pending');
    return account;
  }catch(error){if(error instanceof NameBrokerError)throw error;fail('registered-account-read-failed',1002,{fatal:true});}
}
class NameBroker{
  constructor({plans,readAccount=readCurrent,token=()=>crypto.randomUUID()}={}){
    if(!Array.isArray(plans)||!plans.length||typeof readAccount!=='function'||typeof token!=='function')throw Error('Explicit name broker plans required');
    this.plans=plans.slice();this.readAccount=readAccount;this.token=token;this.workers=new WeakMap();this.boundServices=new Set();this.pending=new Map();this.byName=new Map();this.byUid=new Map();this.closed=false;this.queue=Promise.resolve();
    this.snapshot(); // Startup/new-registration rejects normalized duplicates.
  }
  snapshot(){
    const accounts=this.plans.map(plan=>this.readAccount(plan));
    try{return {accounts,registry:rename.createRegistry(accounts)};}
    catch(error){fail(error.reason||'registered-name-conflict',error.status||1002,{fatal:true});}
  }
  bind(actor,{uid,service}={}){
    if(!actor||typeof actor!=='object'||this.workers.has(actor)||this.boundServices.has(`${uid}:${service}`)||!this.plans.some(plan=>plan.account.uid===uid)||!['lobby','battle'].includes(service))throw Error('Invalid name broker worker binding');
    this.workers.set(actor,Object.freeze({uid,service}));this.boundServices.add(`${uid}:${service}`);return actor;
  }
  serialize(operation){
    const task=this.queue.then(()=>operation());this.queue=task.catch(()=>{});return task;
  }
  actor(actor){
    const owner=this.workers.get(actor);
    if(!owner||owner.service!=='lobby')fail('name-broker-lobby-owner-required');
    if(this.closed)fail('name-broker-closed');return owner;
  }
  reserve(actor,{requestId,name}={}){return this.serialize(()=>{
    const owner=this.actor(actor);
    if(!uuid(requestId)||typeof name!=='string')fail('invalid-name-reservation-request',1001);
    try{rename.nameBytes(name);}catch(error){fail(error.reason,error.status);}
    const existingToken=this.byUid.get(owner.uid);
    if(existingToken){
      const existing=this.pending.get(existingToken);
      if(existing.actor===actor&&existing.requestId===requestId&&existing.name===name)return clone(existing.response);
      fail('account-name-reservation-pending');
    }
    const {accounts,registry}=this.snapshot(),key=rename.nameKey(name),account=accounts.find(row=>row.uid===owner.uid);
    if(!account)fail('name-reservation-owner-missing',1002,{fatal:true});
    if(accounts.some(row=>row.uid!==owner.uid&&rename.nameKey(row.name)===key)||this.byName.has(key))fail('name-already-exists',1000);
    const token=this.token();if(!uuid(token)||this.pending.has(token))fail('invalid-name-reservation-token',1002,{fatal:true});
    const registeredAccounts=Object.values(registry.accounts);
    const response={token,uid:owner.uid,name,registeredAccounts,registry};
    this.pending.set(token,{token,actor,uid:owner.uid,requestId,name,key,beforeName:account.name,response});
    this.byUid.set(owner.uid,token);this.byName.set(key,token);return clone(response);
  });}
  release(actor,{token,committed,eventId,receiptSha256,name}={}){return this.serialize(()=>{
    const owner=this.actor(actor),reservation=this.pending.get(token);
    if(!uuid(token)||!reservation||reservation.actor!==actor||reservation.uid!==owner.uid)fail('name-reservation-not-owned');
    if(committed!==true&&committed!==false)fail('name-release-outcome-required');
    // Do not release an uncertain reservation. The caller marks committed only
    // after its own protected account+bag transaction has fully returned.
    const {accounts}=this.snapshot(),account=accounts.find(row=>row.uid===owner.uid);
    if(committed){
      if(name!==reservation.name||typeof eventId!=='string'||!eventId.startsWith(`rename-card:${owner.uid}:`)||
        !/^[a-f0-9]{64}$/.test(receiptSha256||'')||account.name!==reservation.name||account.receipts[eventId]!==receiptSha256)
        fail('rename-commit-not-durable',1002,{uncertain:true});
    }else if(account.name!==reservation.beforeName)fail('rename-cancel-outcome-uncertain',1002,{uncertain:true});
    this.pending.delete(token);this.byUid.delete(owner.uid);this.byName.delete(reservation.key);
    return {token,uid:owner.uid,released:true,committed};
  });}
  handles(message){return MESSAGE_TYPES.has(message?.type);}
  async handle(actor,message){
    const type=message?.type==='player-name-reserve'?'player-name-reserved':'player-name-released';
    const requestId=message?.requestId;
    try{
      if(!this.handles(message)||message.version!==1||!uuid(requestId))fail('invalid-name-broker-message');
      const value=message.type==='player-name-reserve'?await this.reserve(actor,message):await this.release(actor,message);
      return {type,version:1,requestId,ok:true,...value};
    }catch(error){const known=error instanceof NameBrokerError;return {type,version:1,requestId,ok:false,
      reason:known?error.reason:'name-broker-failed',status:known?error.status:1002,fatal:known?error.fatal:true,uncertain:known?error.uncertain:true};}
  }
  close({workersTerminated=false}={}){
    this.closed=true;
    if(workersTerminated){this.pending.clear();this.byName.clear();this.byUid.clear();}
  }
  diagnostics(){return {closed:this.closed,pending:[...this.pending.values()].map(row=>({uid:row.uid,name:row.name,requestId:row.requestId}))};}
}
module.exports={NameBroker,NameBrokerError,readCurrent,MESSAGE_TYPES};
