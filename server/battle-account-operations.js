'use strict';
const path=require('node:path'),stateFiles=require('./persistence/state-files'),fs=stateFiles.io,W=require('./battle-wire');
const E=require('./battle-equipment'),G=require('./gem-board'),M=require('./magic-device-live'),protocol=require('./progression-protocol');
const tags=new Set([13510,13512,13542,13586,13588,13593,13595,13631,13632,11888]);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,value)=>{const tmp=file+'.'+process.pid+'.battle.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);};
function bagSteps(bag,hero){
 const live=process.env.DSH_BAG_STATE,equip=hero.loadout.source,snapshot=equip+'.snapshot';
 if(!live||!path.isAbsolute(live)||!equip||!path.isAbsolute(equip))throw Error('battle-account-paths-unavailable');
 const old=read(snapshot),overlay=read(live),inventory=Object.fromEntries([...bag].map(([slot,item])=>{
  const next={...item};for(const key of ['slot','bagSlot','enhancementLevel','enhancementSkillLevel','reforgeHex','soul'])delete next[key];return [slot,next];
 }));
 const slots={...inventory};for(const key of new Set([...Object.keys(old.inventory||{}),...Object.keys(overlay.slots||{})]))if(!bag.has(+key))slots[key]=null;
 return [{name:'battle-bag',path:live,save:()=>write(live,{...overlay,slots,updatedAt:new Date().toISOString()})},
  {name:'battle-snapshot',path:snapshot,save:()=>write(snapshot,{...old,inventory})}];
}
function currencyFrames(playerId,attrs){
 const rows=[50,72].filter(id=>Number.isSafeInteger(attrs[id]));const p=Buffer.alloc(1+5*rows.length);p[0]=rows.length;
 rows.forEach((id,i)=>{p[1+i*5]=id;p.writeUInt32LE(attrs[id],2+i*5);});return rows.length?[W.frame(1045,playerId,p)]:[];
}
class BattleAccountOperations{
 constructor({session,commit,available=()=>true}={}){Object.assign(this,{session,commit,available});}
 refresh(){
  const s=this.session,hero=s.sim.entities.get(s.playerId),loadout=require('./account-loadout').readLoadout();
  E.apply(s.sim,hero,E.calculate(hero.equipmentBase,loadout),loadout);
  return [...E.equipmentPackets(s.playerId,loadout),E.attributePacket(hero),W.frame(11888,0,G.actorPayload(loadout.gemState,s.playerId),0xca)];
 }
 handle(frame){
  const tag=frame.readUInt16LE(8);if(!tags.has(tag))return null;
  const s=this.session,p=frame.subarray(12),pan=tag===11888&&p[0]===0x92&&p[1]===1;
  // Other protobuf systems continue to their own dispatcher.
  const request=tag===11888&&!pan?protocol.parseMagicGemProtobuf(p):null;
  if(tag===11888&&!pan&&!request)return null;
  if(s.phase!=='playing'||!this.available()||this.commit.frozen)return {ok:false,reason:'battle-account-unavailable'};
  const readOnly=tag===13510||pan||request?.operation==='getGraphs';
  if(!readOnly&&![13512,13542].includes(tag)&&!require('./battle-page-selection').fountain(s))return {ok:false,reason:'fountain-required'};
  const hero=s.sim.entities.get(s.playerId),directory=path.dirname(hero.loadout.source);
  const file=(env,name)=>process.env[env]||path.join(directory,name);
  let committed=false;
  try{
   const bag=E.readInventory(),capacity=hero.loadout.capacity||192;
   if(pan){
    const selected=G.parsePanQuery(p);if(selected===null)return {ok:false,reason:'invalid-gem-board-query'};
    const board=new G.GemBoard(file('DSH_GEM_BOARD_STATE','gem-board-state.json'));
    // Viewing another plan must not secretly change the active battle plan.
    s.send([W.frame(11888,0,G.boardPayload(board.state,selected===0xffffffff?null:selected),0xca)]);return {ok:true};
   }
   if(tag===13510||tag===13512){
    const resource=file('DSH_RESOURCE_STATE','bag-state.live.resources.json'),material=file('DSH_MATERIAL_STATE','material-state.live.json'),walletFile=file('DSH_GOLD_STATE','gold-state.json');
    const resources=read(resource),materialState=read(material),itemMap=new Map(Object.entries(materialState.items||{}).map(([id,n])=>[+id,n]));
    const walletState=read(walletFile),wallet={ok:true,state:walletState,attrs:{...walletState.attrs},save(){write(walletFile,{...this.state,gold:this.attrs[50],attrs:this.attrs,updatedAt:new Date().toISOString()});}};
    const adapter=new(require('./equipment-persistence-adapter').EquipmentPersistenceAdapter)({bag:{slotMap:bag,itemMap},resources,wallet,journal:this.commit,
     files:{enhancement:file('DSH_ENHANCEMENT_STATE','enhancement-state.json'),reforge:file('DSH_REFORGE_STATE','reforge-state.json'),pending:this.commit.file,resource,material,wallet:walletFile,
      saveResources:()=>write(resource,resources),saveMaterials:()=>write(material,{...materialState,items:Object.fromEntries(itemMap),updatedAt:new Date().toISOString()})},
     isEquipment:id=>['equip','armour','weapon','treasure'].includes(require('./current-item-catalog').load().byId[id]?.type),
     isFrozen:()=>!this.available(),rules:require('./equipment-local-rules'),wire:require('./equipment-live-wire'),
     legacyFor:(guid,id)=>{const held=[...bag.values()].find(i=>i.guid===guid&&i.itemId===id);return held?{level:held.enhancementLevel,record:require('./roledata').itemRecord(Buffer.alloc(0),0,held)}:null;}});
    const result=adapter.handle(tag,p);if(!result.ok)return result;
    committed=tag===13512;const frames=[...(result.frames||[])];
    if(committed){
     const guid=p.subarray(0,8).toString('hex'),current=E.readInventory();for(const [slot,held]of current)if(held.guid===guid)frames.push(E.inventoryPacket(slot,held));
     for(const id of Object.keys(result.debits?.resources||{}).map(Number)){
      if(require('./item-containers').containerOf(id)==='material')frames.push(require('./bag').buildBagDelta(id,itemMap.get(id)||0));
      else {const body=Buffer.alloc(8);body.writeUInt32LE(id);body.writeUInt32LE(resources[id]||0,4);frames.push(W.frame(11553,0,body,0x0d));}
     }
     frames.push(...currencyFrames(s.playerId,wallet.attrs),...this.refresh());
    }
    s.send(frames);s.flush();return {ok:true};
   }
   let prepared,steps,frames=[];
   if(tag===13542){
    const soul=require('./equipment-soul'),model=new soul.SoulState(file('DSH_SOUL_STATE','soul-state.json'));
    prepared=soul.planRefill(model,soul.parseRefill(p),bag,{capacity});if(!prepared.ok)return prepared;
    steps=[...bagSteps(prepared.bag,hero),{name:'soul-state',path:model.file,save:()=>model.save(prepared.next)}];
    frames=[W.frame(13453,0,Buffer.from([0]),0xca)];prepared.changedSlots=[...prepared.touched,prepared.equipmentSlot];
   }else if(tag===13631||tag===13632){
    const model=new G.GemBoard(file('DSH_GEM_BOARD_STATE','gem-board-state.json')),operation=tag===13631?'remove':'insert';
    prepared=G.planChange(model.state,operation==='remove'&&require('./gem-removal-batch').isRemoveAll(frame)?'remove-all':operation,p,bag,{capacity,stackMax:1000,reserved:new Set(hero.loadout.slots.map(e=>e.bagSlot))});if(!prepared.ok)return prepared;
    steps=[...bagSteps(prepared.bag,hero),{name:'gem-board',path:model.file,save:()=>model.save(prepared.next)}];
    prepared.changedSlots=prepared.touched;
    frames=[...(prepared.removed||[{itemId:prepared.itemId}]).map(entry=>W.frame(17015,0,G.itemNotice(entry.itemId,operation),0xca)),W.frame(13552,0,G.resultPayload(operation,prepared.itemId),0xca),W.frame(11888,0,G.boardPayload(prepared.next,prepared.input.plan),0xca)];
   }else{
    const q=request||protocol.parse(tag,p),allowed=['equipVisual','unequipVisual','equip','unequip','getGraphs','setGraph'];
    if(!q||q.system!=='magicGem'||!allowed.includes(q.operation))return {ok:false,reason:'unsupported-battle-magic-operation'};
    if(tag===11888&&!require('./magic-feature-snapshot').validRequest(frame))return {ok:false,reason:'invalid-magic-protobuf'};
    const model=new(require('./magic-gem-system').MagicGemState)({file:file('DSH_MAGIC_GEM_STATE','magic-gem-state.json')}),old=model.state;
    const resource=file('DSH_RESOURCE_STATE','bag-state.live.resources.json'),material=file('DSH_MATERIAL_STATE','material-state.live.json'),walletFile=file('DSH_GOLD_STATE','gold-state.json');
    const materialState=read(material),walletState=read(walletFile);
    prepared=M.prepare({state:model,request:q,tag,payload:p,bag,materials:new Map(Object.entries(materialState.items||{}).map(([id,n])=>[+id,n])),resources:read(resource),wallet:walletState.attrs||{},capacity,containerOf:require('./item-containers').containerOf});if(!prepared.ok)return prepared;
    const next={state:prepared.state};
    frames=[...M.inventoryFrames(old,prepared.state),W.frame(13590,s.playerId,protocol.magicGemNotifyPayload(next),0xc9),...M.incrementalFrames(prepared.state)];
    if(tag===11888)frames.push(W.frame(11888,s.playerId,protocol.magicGemResponsePayload(next,q,prepared.result),0xca));
    const ack=M.ack(tag,q,prepared.result);if(ack)frames.push(ack);
    if(q.operation==='getGraphs'){s.send(frames);return {ok:true};}
    steps=[{name:'magic-device',path:model.file,save:()=>{model.state=prepared.state;model.save();}},...(prepared.changedSlots.length?bagSteps(prepared.bag,hero):[])];
    if(prepared.changedMaterials.length)steps.push({name:'material',path:material,save:()=>write(material,{...materialState,items:Object.fromEntries(prepared.materials)})});
    if(prepared.changedResources.length)steps.push({name:'resource',path:resource,save:()=>write(resource,prepared.resources)});
    if(Object.values(prepared.result.walletCosts||{}).some(n=>n))steps.push({name:'wallet',path:walletFile,save:()=>write(walletFile,{...walletState,gold:prepared.wallet[50],attrs:prepared.wallet})});
    for(const id of prepared.changedMaterials)frames.push(require('./bag').buildBagDelta(id,prepared.materials.get(id)||0));
    for(const id of prepared.changedResources){const body=Buffer.alloc(8);body.writeUInt32LE(id);body.writeUInt32LE(prepared.resources[id]||0,4);frames.push(W.frame(11553,0,body,0x0d));}
    frames.push(...currencyFrames(s.playerId,prepared.wallet));
   }
   if(!this.commit.run('battle-account-'+tag,String(s.playerId),steps))return {ok:false,reason:'battle-account-commit-unavailable'};
   committed=true;const current=E.readInventory();
   frames.unshift(...(prepared.changedSlots||[]).map(slot=>E.inventoryPacket(slot,current.get(slot))));
   s.send([...frames,...this.refresh()]);s.flush();return {ok:true};
  }catch(error){return {ok:committed,reason:error.message,...(committed?{refreshDeferred:true}:{})};}
 }
}
module.exports={BattleAccountOperations,bagSteps,tags};
