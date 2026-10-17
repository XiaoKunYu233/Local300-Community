'use strict';
const path=require('node:path'),W=require('./battle-wire'),wire=require('./loadout-page-wire');
const stateFiles=require('./persistence/state-files'),protocol=require('./progression-protocol');
const tags=new Set([11677,11687,11679,11671,11691,36269,36274]);
const clone=value=>JSON.parse(JSON.stringify(value));
function fountain(session){
 const hero=session.sim?.entities.get(session.playerId);
 return !!hero?.alive&&[...session.sim.entities.values()].some(e=>e.kind==='fountain'&&e.alive&&e.team===hero.team&&Math.hypot(e.x-hero.x,e.z-hero.z)<=(e.recoveryRadius||0));
}
function runeList(state){
 const rows=Object.values(state.inventory||{}).filter(r=>Number.isInteger(Number(r.id))&&Number(r.id)>0&&Number(r.id)<=65535).sort((a,b)=>a.id-b.id);
 const p=Buffer.alloc(4+35*rows.length);p.writeUInt32LE(rows.length);
 rows.forEach((r,i)=>{const o=4+i*35,a=require('./rune-system').orderedRuneAttrs(r.attrs||{}).slice(0,7);
  p.writeUInt16LE(Number(r.id),o);p.writeUInt16LE(Number(r.itemId)||0,o+2);p[o+4]=r.level;p[o+5]=r.color;p[o+6]=a.length;
  a.forEach(([id,value],j)=>{p[o+7+3*j]=Number(id);p.writeUInt16LE(Math.max(0,Math.min(65535,Math.round(value))),o+8+3*j);});
  p[o+30]=r.level===5?(Number(r.godsendId)||0)&255:0;
 });return W.frame(11688,0,p,0xd3);
}
class BattlePages{
 constructor({session,uid,commit,available=()=>true,runeFile=path.join(path.dirname(process.env.DSH_BAG_STATE||path.join(__dirname,'bag-state.live.json')),'rune-state.json'),soulFile=path.join(path.dirname(process.env.DSH_BAG_STATE||path.join(__dirname,'bag-state.live.json')),'war-soul-state.json'),soulTemplate}={}){
  this.session=session;this.uid=uid;this.commit=commit;this.available=available;this.runeFile=runeFile;this.soulFile=soulFile;this.soulTemplate=soulTemplate;
  this.ready={rune:0,warSoul:0};
 }
 model(system){
  const file=system==='rune'?this.runeFile:this.soulFile;
  if(!file||!path.isAbsolute(file))throw Error('battle-page-state-unavailable');
  return system==='rune'?new(require('./rune-system').RuneState)({file}):new(require('./war-soul').WarSoulState)({file});
 }
 remaining(system){if(this.matchId!==this.session.matchId){this.matchId=this.session.matchId;this.ready={rune:0,warSoul:0};}return Math.max(0,Math.ceil(this.ready[system]-(this.session.sim?.time||0)));}
 frames(system,{page,includeList=false}={}){
  const model=this.model(system),s=model.state;
  if(system==='warSoul'){
   if(!this.soulTemplate)throw Error('battle-war-soul-template-unavailable');
   return [require('./war-soul').patchNativeRefreshFrame(this.soulTemplate,s)];
  }
  // Current d83164 reads 11680+0xe1 as absolute server epoch seconds.
  // 11678+0xe instead feeds CharmRaise_NumToSpecial, not the cooldown.
  const info=wire.runeInfoPayload(s),board=wire.runePagePayload(s,page??s.currentPage),remaining=this.remaining('rune');
  board.writeUInt32LE(remaining?Math.floor(Date.now()/1000)+remaining:0,213);
  return [W.frame(11678,0,info,0xd3),W.frame(11680,0,board,0xd3),...(includeList?[runeList(s)]:[])];
 }
 initial(){if(!this.available()||this.commit.frozen)throw Error('battle-pages-storage-unavailable');return stateFiles.readSnapshot(()=>[...this.frames('rune',{includeList:true}),...this.frames('warSoul')]);}
 handle(frame){
  const tag=frame.readUInt16LE(8);if(!tags.has(tag))return null;
  const s=this.session,p=frame.subarray(12),playing=s.phase==='playing';
  if(!['selecting','preparing','playing'].includes(s.phase)||!this.available()||this.commit.frozen)return {ok:false,reason:'battle-page-unavailable'};
  const lengths={11677:[0],11687:[0],11679:[209],11671:[1,4],11691:[1,4],36269:[16],36274:[1]};
  if(!lengths[tag].includes(p.length))return {ok:false,reason:'invalid-battle-page-request'};
  const request=protocol.parse(tag,p),system=request.system;
  if(tag===11679&&request.layout!=='named48')return {ok:false,reason:'invalid-native-rune-board'};
  const readOnly=[11677,11687].includes(tag),switching=['usePage','changePage'].includes(request.operation);
  let response;
  try{
   if(!readOnly&&playing&&!fountain(s))return {ok:false,reason:'fountain-required'};
   const model=this.model(system),same=switching&&model.state.currentPage===request.page;
   if(playing&&switching&&!same&&this.remaining(system)>0){s.send(this.frames(system));return {ok:false,reason:'page-switch-cooldown',remaining:this.remaining(system)};}
   if(readOnly){s.send(this.frames(system,{includeList:true}));return {ok:true};}
   const prepare=()=>{
    const current=this.model(system),draft=Object.create(Object.getPrototypeOf(current));
    Object.assign(draft,current,{state:clone(current.state),save:()=>{}});
    if(current.frozenSnapshot)throw Error('battle-page-storage-frozen');
    const result=protocol.handle(request,{[system]:draft});
    if(!result.ok)throw Error(result.reason);return {current,draft,result};
   };
   let prepared=prepare();
   const kind=system==='warSoul'?'native-war-soul-'+request.operation:'battle-rune-'+request.operation;
   if(!this.commit.run(kind,String(this.uid),[{name:system==='warSoul'?'war-soul':'rune',path:model.file,save:()=>{
    if(stateFiles.enabled())prepared=prepare();prepared.current.state=prepared.draft.state;prepared.current.save();
   }}]))throw Error('battle-page-commit-unavailable');
   if(playing&&switching&&!same)this.ready[system]=s.sim.time+60;
   response={ok:true,page:prepared.draft.state.currentPage,remaining:this.remaining(system)};
   const frames=this.frames(system,{page:request.operation==='nativeBoard'?request.page:undefined,includeList:system==='rune'});
   if(tag===36269)frames.unshift(W.frame(36270,s.playerId,wire.soulRenamePayload(request.page,prepared.result.name),0x0d));
   if(tag===36274)frames.unshift(W.frame(36275,0,Buffer.from([0,prepared.draft.state.currentPage]),2));
   s.send(frames);
   if(playing){s.sim.refreshLoadout?.();s.flush();}
   return response;
  }catch(error){return response?{...response,refreshDeferred:true,reason:error.message}:{ok:false,reason:error.message};}
 }
}
module.exports={BattlePages,fountain,runeList,tags};
