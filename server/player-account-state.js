'use strict';
// Account identity and durable ownership. Protocol adapters must supply a
// verified identity; this module never infers a new account from captured data.
const nativeFs=require('fs'),path=require('path'),crypto=require('crypto');
const stateFiles=require('./persistence/state-files'),fs=stateFiles.io;
const categories=Object.freeze(['heroes','skins','titles','medals','killEffects','killStreaks',
  'multiKills','voices','pets','outfits','sprays','chatFrames','expressions','wards','bloodSkins','cursorSkins']);
const id=n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff;
const counter=n=>Number.isSafeInteger(n)&&n>=0;
const copy=v=>JSON.parse(JSON.stringify(v));
const loginKey=login=>{
  if(typeof login!=='string'||!login.length||login.length>64||/[^\x21-\x7e]/.test(login))throw Error('Invalid account login');
  return crypto.createHash('sha256').update(login.toLowerCase()).digest('hex');
};
function empty(){return {version:1,revision:0,accounts:{}};}
function makeAccount({login,uid,playerId,name}){
  const hash=loginKey(login);
  if(!id(uid)||!id(playerId)||typeof name!=='string'||!name.length||name.length>64)throw Error('Invalid account identity');
  return {uid,playerId,name,loginHash:hash,revision:0,owned:Object.fromEntries(categories.map(k=>[k,{}])),
    selected:{},receipts:{},online:{totalMs:0,days:{}}};
}
function validate(state){
  if(state?.version!==1||!counter(state.revision)||!state.accounts||Array.isArray(state.accounts))throw Error('Invalid player account state');
  const logins=new Set(),players=new Set();
  for(const [uid,a]of Object.entries(state.accounts)){
    if(!id(a.uid)||String(a.uid)!==uid||!id(a.playerId)||!counter(a.revision)||typeof a.name!=='string'||a.name.length>64||
      !/^[a-f0-9]{64}$/.test(a.loginHash)||logins.has(a.loginHash)||players.has(a.playerId))throw Error('Conflicting player identity');
    logins.add(a.loginHash);players.add(a.playerId);
    if(!a.owned||!a.selected||!a.receipts||Array.isArray(a.receipts)||!a.online||!counter(a.online.totalMs)||!a.online.days)throw Error('Invalid player records');
    if(Object.values(a.receipts).some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))throw Error('Invalid account event receipt');
    if(a.publicBetaIdentity!==undefined){
      if(a.growth===undefined||a.vip===undefined)throw Error('Local reference account requires growth and VIP state');
      // Bind the template identity even after business receipts replace either
      // baseline. Current progress is validated by its own receipt below.
      const prefix=a.publicBetaIdentity?.version===2?'local-reference-template:':'native-new-account:';
      require('./public-beta/native-seed').validateBaseline({level:1,experience:0,source:prefix+a.publicBetaIdentity?.roleSHA256},a,'growth');
    }
    if(a.heroWire)require('./player-heroes').validateWire(a.heroWire);
    if(a.matchHistory!==undefined)require('./player-match-history').validate(a.matchHistory,a.playerId);
    if(a.profileSnapshot!==undefined)require('./player-profile-snapshot').validate(a.profileSnapshot,a);
    if(a.summonerSelection!==undefined)require('./summoner-selection-persistence').validate(a.summonerSelection,a);
    if(a.vip!==undefined)require('./player-vip-wire').validate(a.vip,a);
    if(a.growth!==undefined)require('./player-growth-wire').validate(a.growth,a);
    if(a.rechargeState!==undefined)require('./player-recharge').validate(a.rechargeState,a);
    if(a.firstGiftEntitlement!==undefined)require('./player-recharge').validateFirstGift(a.firstGiftEntitlement,a);
    if(a.growthDevelopmentState!==undefined)require('./player-growth-development').validate(a.growthDevelopmentState,a);
    if(a.itemGrowthState!==undefined)require('./public-beta/item-growth').validate(a.itemGrowthState,a);
    if(a.publicBetaGmState!==undefined)require('./public-beta/gm-operations').validate(a.publicBetaGmState,a);
    if(a.firstGiftResetState!==undefined)require('./public-beta/first-gift-reset').validate(a.firstGiftResetState,a);
    if(a.limitedGodsendControlState!==undefined)require('./public-beta/limited-godsend').validate(a.limitedGodsendControlState,a);
    if(a.firstGiftObservation!==undefined)require('./player-first-gift').validate(a.firstGiftObservation,a);
    if(a.creditObservation!==undefined)require('./player-credit').validate(a.creditObservation,a);
    if(a.titleState!==undefined)require('./player-title-state').validate(a.titleState,a);
    if(a.titleSettings!==undefined)require('./player-title-settings').validate(a.titleSettings,a);
    if(a.personalSettings!==undefined)require('./player-personal-settings').validate(a.personalSettings,a);
    if(a.medalObservation!==undefined)require('./player-medal-observation').validate(a.medalObservation,a);
    if(a.killEffectObservations!==undefined)require('./player-kill-effect-observation').validate(a.killEffectObservations,a);
    if(a.petObservations!==undefined)require('./player-pet-observation').validate(a.petObservations,a);
    if(a.inventoryHistoryObservation!==undefined)require('./player-inventory-history').validate(a.inventoryHistoryObservation,a);
    if(a.killEffectState!==undefined)require('./player-kill-effect-state').validate(a.killEffectState,a);
    if(a.fightDressState!==undefined)require('./player-fight-dress').validate(a.fightDressState,a);
    if(a.medalState!==undefined)require('./player-medals').validate(a.medalState,a);
    if(a.avatarState!==undefined)require('./player-avatar').validate(a.avatarState,a);
    if(a.avatarFrameState!==undefined)require('./player-avatar-frame').validate(a.avatarFrameState,a);
    if(a.titleOwnershipObservation!==undefined)require('./player-title-import').validate(a.titleOwnershipObservation,a);
    if(a.rewardMailState!==undefined)require('./player-reward-mail').validate(a.rewardMailState,a);
    if(a.firstGiftClaim!==undefined)require('./player-first-gift').validateClaim(a.firstGiftClaim,a);
    for(const kind of categories){
      const entries=a.owned[kind];if(!entries||Array.isArray(entries))throw Error('Invalid ownership category');
      if(kind==='titles'&&Object.keys(entries).some(key=>+key>=2400))throw Error('Title ownership exceeds native bitmap');
      for(const [key,v]of Object.entries(entries))if(!id(+key)||String(+key)!==key||!v||!counter(v.acquiredAt)||
        !(v.expiresAt===null||counter(v.expiresAt))||typeof v.source!=='string')throw Error('Invalid entitlement');
      if(kind==='skins')for(const [key,v]of Object.entries(entries))if(v.permanentProof!==undefined)require('./player-avatar').validateProof(v.permanentProof,key,v);
    }
    for(const [slot,selection]of Object.entries(a.selected)){
      if(!/^[a-zA-Z][a-zA-Z0-9:]{0,63}$/.test(slot)||!selection||!categories.includes(selection.kind)||
        !id(selection.id)||!a.owned[selection.kind][selection.id])throw Error('Invalid selected entitlement');
    }
    for(const [day,v]of Object.entries(a.online.days))if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!counter(v.milliseconds)||
      v.milliseconds>86400000||!Array.isArray(v.claimed)||v.claimed.some(x=>!id(x)||x>5)||new Set(v.claimed).size!==v.claimed.length)throw Error('Invalid online progress');
    for(const v of Object.values(a.online.days))if(v.observed!==undefined){
      if(!Array.isArray(v.observed))throw Error('Invalid online coverage');
      let end=-1,total=0;
      for(const span of v.observed){
        if(!Array.isArray(span)||span.length!==2||!counter(span[0])||!counter(span[1])||span[0]<=end||span[1]<=span[0]||span[1]>86400000)throw Error('Invalid online coverage');
        total+=span[1]-span[0];end=span[1];
      }
      if(total>v.milliseconds)throw Error('Online coverage exceeds credited time');
    }
  }
  return state;
}
function owns(account,kind,item,now=Date.now()){
  const entry=account.owned[kind]?.[item];return !!entry&&(entry.expiresAt===null||entry.expiresAt>now);
}
function grant(account,{kind,itemId,expiresAt=null,source},now=Date.now()){
  if(!categories.includes(kind)||!id(itemId)||!(expiresAt===null||counter(expiresAt)&&expiresAt>now)||typeof source!=='string'||!source)throw Error('Invalid entitlement grant');
  if(kind==='titles'&&itemId>=2400)throw Error('Title ownership exceeds native bitmap');
  const existing=account.owned[kind][itemId];
  if(existing&&(existing.expiresAt===null||expiresAt!==null&&existing.expiresAt>=expiresAt))return false;
  account.owned[kind][itemId]={acquiredAt:existing?.acquiredAt??now,expiresAt,source};return true;
}
function select(account,slot,kind,itemId,now=Date.now()){
  if(!/^[a-zA-Z][a-zA-Z0-9:]{0,63}$/.test(slot)||!categories.includes(kind))throw Error('Invalid selection slot');
  if(itemId===null){delete account.selected[slot];return;}
  if(!id(itemId)||!owns(account,kind,itemId,now))throw Error('Entitlement is not owned or has expired');
  account.selected[slot]={kind,id:itemId};
}
function chinaDay(ms){return new Date(ms+8*3600000).toISOString().slice(0,10);}
function accrue(account,from,to){
  if(!counter(from)||!counter(to)||to<from||to-from>86400000)throw Error('Invalid online interval');
  while(from<to){const day=chinaDay(from),end=Math.min(to,Date.parse(day+'T00:00:00+08:00')+86400000);
    const bucket=account.online.days[day]??={milliseconds:0,claimed:[]};
    if(bucket.milliseconds+end-from>86400000)throw Error('Online time counted more than once');
    bucket.milliseconds+=end-from;account.online.totalMs+=end-from;from=end;
  }
}
// Persist the union of server-observed intervals. Lobby and battle may flush
// in either order; a high-water timestamp would lose late, earlier intervals.
// Historical totals without coverage remain intact and are never inferred to
// cover a new connection. Offsets are relative to the China calendar day.
function accrueObserved(account,from,to){
  if(!counter(from)||!counter(to)||to<from||to-from>86400000)throw Error('Invalid online interval');
  while(from<to){
    const day=chinaDay(from),start=Date.parse(day+'T00:00:00+08:00'),end=Math.min(to,start+86400000);
    const bucket=account.online.days[day]??={milliseconds:0,claimed:[]};
    const spans=[...(bucket.observed||[]),[from-start,end-start]].sort((a,b)=>a[0]-b[0]),merged=[];
    const previous=(bucket.observed||[]).reduce((sum,[a,b])=>sum+b-a,0);
    for(const span of spans){const last=merged.at(-1);if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);else merged.push([...span]);}
    const added=merged.reduce((sum,[a,b])=>sum+b-a,0)-previous;
    if(bucket.milliseconds+added>86400000)throw Error('Online time counted more than once');
    bucket.observed=merged;bucket.milliseconds+=added;account.online.totalMs+=added;from=end;
  }
}
// This mutates a transaction draft only. The native handler must commit this
// draft together with the corresponding item/resource/wallet delivery.
function claimOnline(account,tier,gifts,now=Date.now()){
  const row=gifts.find(r=>r.tier===tier),day=chinaDay(now),bucket=account.online.days[day];
  if(!row||!id(row.itemId)||!id(row.count)||!counter(row.requiredSeconds)||!bucket||
    bucket.milliseconds<row.requiredSeconds*1000)throw Error('Online reward is not ready');
  if(bucket.claimed.includes(tier))throw Error('Online reward already claimed');
  bucket.claimed.push(tier);return {itemId:row.itemId,count:row.count};
}
class PlayerAccounts{
  constructor(file){if(!path.isAbsolute(file))throw Error('Absolute player state path required');this.file=file;}
  read(){try{return validate(JSON.parse(fs.readFileSync(this.file,'utf8')));}catch(e){if(e.code==='ENOENT')return empty();throw e;}}
  get(uid){const a=this.read().accounts[uid];return a?copy(a):null;}
  find(login){const hash=loginKey(login);return Object.values(this.read().accounts).find(a=>a.loginHash===hash)||null;}
  write(operation){
    const execute=(verify=()=>{})=>{
      verify();
      const state=this.read(),result=operation(state);if(result?.unchanged)return result.value;
      state.revision++;validate(state);
      const temp=`${this.file}.${process.pid}.tmp`;
      try{
        const bytes=JSON.stringify(state,null,2)+'\n';
        if(stateFiles.enabled())fs.writeFileSync(temp,bytes);
        else {const fd=nativeFs.openSync(temp,'w');try{nativeFs.writeFileSync(fd,bytes);nativeFs.fsyncSync(fd);}finally{nativeFs.closeSync(fd);}}
        if(stateFiles.enabled())fs.renameSync(temp,this.file);
        else require('./persistence/atomic-rename').replace(temp,this.file,(from,to)=>{verify();return fs.renameSync(from,to);});
      }
      finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
      return result;
    };
    if(stateFiles.enabled())return stateFiles.transaction('player-account',[this.file],execute);
    // The lobby and battle process may both commit account data. Serialize
    // read-modify-write across processes; a stale lock fails closed for review.
    return require('./player-account-json-lock').write(this.file,execute);
  }
  create({login,uid,playerId,name}){
    const account=makeAccount({login,uid,playerId,name}),hash=account.loginHash;
    return this.write(state=>{
      const existing=Object.values(state.accounts).find(a=>a.loginHash===hash);
      if(existing){if(existing.uid!==uid||existing.playerId!==playerId)throw Error('Account identity cannot be reassigned');return {unchanged:true,value:copy(existing)};}
      if(state.accounts[uid]||Object.values(state.accounts).some(a=>a.playerId===playerId))throw Error('UID/player ID already belongs to another account');
      state.accounts[uid]=account;return copy(account);
    });
  }
  update(uid,{expectedRevision,eventId,payload}={},operation){
    if(!id(uid)||typeof operation!=='function')throw Error('Invalid account update');
    if(eventId!==undefined&&(typeof eventId!=='string'||!eventId.length||eventId.length>160))throw Error('Invalid event identity');
    const digest=eventId?crypto.createHash('sha256').update(JSON.stringify(payload??null)).digest('hex'):null;
    return this.write(state=>{
      const a=state.accounts[uid];if(!a)throw Error('Unknown account');
      if(eventId&&Object.hasOwn(a.receipts,eventId)){
        if(a.receipts[eventId]!==digest)throw Error('Event identity reused with different payload');
        return {unchanged:true,value:{repeated:true,account:copy(a)}};
      }
      if(expectedRevision!==undefined&&a.revision!==expectedRevision)throw Error('Account revision changed');
      const identity=JSON.stringify([a.uid,a.playerId,a.loginHash]);
      const value=operation(a);if(value&&typeof value.then==='function')throw Error('Account transactions must be synchronous');
      if(identity!==JSON.stringify([a.uid,a.playerId,a.loginHash]))throw Error('Account identity is immutable');
      a.revision++;if(eventId)Object.defineProperty(a.receipts,eventId,{value:digest,enumerable:true,writable:true,configurable:true});
      return {repeated:false,account:copy(a),value};
    });
  }
}
// Volatile connection tracking counts the union of active sessions. No session
// is recovered after process restart, so offline time cannot become rewards.
class OnlineSessions{
  constructor(store,{maxGapMs=60000,canAccrue=()=>true}={}){this.store=store;this.maxGapMs=maxGapMs;this.canAccrue=canAccrue;this.active=new Map();}
  connect(uid,session,now=Date.now()){
    if(!this.store.get(uid))throw Error('Unknown account');
    const row=this.active.get(uid)||{sessions:new Set(),last:now};
    if(row.sessions.has(session))throw Error('Duplicate online session');
    if(row.sessions.size)this.tick(uid,now);
    row.sessions.add(session);this.active.set(uid,row);
  }
  tick(uid,now=Date.now()){
    const row=this.active.get(uid);if(!row?.sessions.size||now<=row.last)return;
    if(!this.canAccrue()){row.last=now;return;}
    const from=Math.max(row.last,now-this.maxGapMs);
    this.store.update(uid,{},a=>{if(this.canAccrue())accrueObserved(a,from,now);});row.last=now;
  }
  disconnect(uid,session,now=Date.now()){
    const row=this.active.get(uid);if(!row?.sessions.has(session))return;
    try{this.tick(uid,now);}finally{this.forget(uid,session);}
  }
  forget(uid,session){const row=this.active.get(uid);if(!row)return;row.sessions.delete(session);if(!row.sessions.size)this.active.delete(uid);}
}
module.exports={PlayerAccounts,OnlineSessions,validate,makeAccount,loginKey,categories,owns,grant,select,accrue,accrueObserved,claimOnline,chinaDay};
