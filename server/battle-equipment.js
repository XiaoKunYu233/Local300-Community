'use strict';
const stateFiles=require('./persistence/state-files');
const fs=stateFiles.io,path=require('path'),W=require('./battle-wire');
const {sumEquipment,managed,allManaged}=require('./equipment-attributes');
const {moveSpeed,rawAttributes}=require('./attribute-math');
const passives=require('./equipment-passives');
const {readInstanceProperties}=require('./account-loadout');
const types=require('./current-item-catalog').load().byId;
const rules=require('./equipment-rules');
const map=loadout=>new Map(loadout.slots.map(e=>[e.slot,e]));
function heroBase(row,level,range){
  const grow=(base,per)=>Math.round(+row[base]+(+row[per]||0)*(level-1));
  const a=Object.fromEntries([...allManaged].map(id=>[id,0]));
  Object.assign(a,{4:level,7:0,1:grow('fBaseHP','fLevelUpHP'),8:grow('fBaseHP','fLevelUpHP'),
    2:grow('fBaseMP','fLevelUpMP'),9:grow('fBaseMP','fLevelUpMP'),10:0,11:0,
    12:grow('fHPRecover','fLevelupHPRecover'),13:grow('fMPRecover','fLevelupMPRecover'),
    15:Math.round(100+(+row.fLevelUpAttackSpeed||0)*(level-1)),16:Math.round(range*100),17:100,
    14:+row.fHitRate||0,18:+row.fDodge||0,24:+row.fCriticalHit||0,25:200,30:grow('fBaseAttack','fLevelUpAttack'),
    31:+row.fMagicAttack||0,36:0,37:0,42:grow('fBaseArmor','fLevelUpArmor'),44:grow('fBaseMagicArmor','fLevelUpMagicArmor'),
    97:+row.fHPAbsorb||0,98:+row.fMPAbsorb||0,99:+row.fSuperArmor||0,100:+row.fColdDownMinusPercent||0,
    106:+row.fArmorPuncture||0,107:+row.fMagicArmorPuncture||0,108:+row.fArmorPuncturePercent||0,109:+row.fMagicArmorPuncturePercent||0,
    127:0,128:0,129:Math.round(+row.fMoveSpeed*100),130:+row.fBaseAttackSpeed});
  return Object.freeze(a);
}
function baseAttributes(recorded,recordedEquipment){
  const bonus=sumEquipment(recordedEquipment),base={...recorded};
  for(const id of managed)if(base[id]!==undefined){
    base[id]-=bonus[id];if(base[id]<0)throw Error('Recorded equipment exceeds attribute snapshot '+id);
  }
  return Object.freeze(base);
}
function calculate(base,loadout){
  const bonus=sumEquipment(map(loadout),{combat:true,currentClient:loadout.currentClient!==false,
    enhancementLevelFor:e=>e.enhancementLevel,
    reforgeFor:e=>e.reforgeHex,forgeFor:e=>e.forge});
  const soul=require('./equipment-soul').bonuses(loadout.slots).stats;
  for(const [id,value]of Object.entries(soul))bonus[id]=(bonus[id]||0)+value;
  const sources=loadout.progressionSources||{progression:loadout.progressionBonus||{}};
  const result=passives.calculate({...base,95:base[95]||0,96:base[96]||0},bonus,loadout.gemBonus,passives.compile(map(loadout)),sources);
  // A few persistent progression snapshots contain a complete zero-filled
  // attribute map.  Do not make a previously absent attribute appear merely
  // because that snapshot contributed a zero; native attribute comparisons
  // and older loadout callers rely on the sparse shape of the base record.
  for(const [id,value] of Object.entries(result))
    if(Number(value)===0 && !Object.prototype.hasOwnProperty.call(base,id)) delete result[id];
  return result;
}
function apply(sim,hero,a,loadout,{initial=false}={}){
  const hp=hero.hp,mp=hero.mp,raw=rawAttributes(a);
  Object.assign(hero,{loadout,attributes:{...a},hpMax:a[8],mpMax:a[9],armor:a[42],
    baseAttackDamage:a[30],magicResistance:a[44],clientBaseAttackSpeed:a[15],baseAttackInterval:a[130]>0?10000/(a[130]*a[15]):.9*194/a[15],
    flatAttackDamage:raw[30],flatBonusAttackDamage:raw[127]||0,clientAttackPercent:raw[36]||0,
    baseDodge:a[18],
    clientBaseMoveSpeed:a[129],clientMovePercent:a[17],
    baseSpeed:moveSpeed(a[129],a[17])/100,
    criticalResistance:loadout.gemEffects?.CriticalResistance||0,
    criticalDamageReduction:loadout.gemEffects?.CriticalDamageReduction||0,
    // Keep advanced magic-gem set descriptors on the combat entity. They are
    // intentionally separate from numeric attributes so set-trigger hooks can
    // consume the native effectId/setLevel without corrupting the stat map.
     magicGemEffects:[...(loadout.magicGemEffects||[])],
     warSoulEffects:[...(loadout.warSoulEffects||[])],
     warSoul:{averageRestraint:Number(loadout.warSoulProfile?.averageRestraint||0),
       averageResistance:Number(loadout.warSoulProfile?.averageResistance||0),
       restraint:{...(loadout.warSoulProfile?.restraint||{})},
       resistance:{...(loadout.warSoulProfile?.resistance||{})}}});
  hero.hp=initial?a[8]:Math.min(hp,a[8]);hero.mp=initial?a[9]:Math.min(mp,a[9]);
  Object.assign(hero,require('./equipment-soul').bonuses(loadout.slots));
  passives.install(sim,hero,passives.compile(map(loadout)));
  require('./battle-effect-stats').install(hero,a);
  require('./battle-progression-effects').install(sim,hero,{magicGemEffects:loadout.magicGemEffects||[],
    runeGodsendEffects:loadout.runeGodsendEffects||[],runeGodsendSelection:loadout.runeGodsendSelection??null,masterLevel:loadout.accountProgression?.masterLevel??null,
    collectorBonus:loadout.accountProgression?.collectorBonus??{},forger:loadout.accountProgression?.forger??null});
  const visuals=require('./equipment-visuals'),next=visuals.selected(loadout.slots,loadout.gemState);
  const packets=visuals.packets(hero.id,hero.heroId,next,hero.equipmentVisuals);
  hero.equipmentVisuals=next;
  if(packets.length)sim.event('equipment-visuals',{id:hero.id,packets});
  sim.updateBuffs(hero);
  // Initial scene resources must include permanent progression added by the
  // final projection. Ordinary refreshes retain current resources above.
  if(initial){hero.hp=hero.hpMax;hero.mp=hero.mpMax;}
}
function attributePacket(hero){
  const movementPercent=Math.max(0,(hero.clientMovePercent??100)+
    hero.buffs.reduce((sum,b)=>sum+((b.speed??1)-1)*100,0));
  // Restraint/resistance are kept as a separate combat profile so the damage
  // formula cannot accidentally treat them as ordinary attack attributes.
  // They still have native attribute rows (32..35 and 45..48), and the
  // battle panel reads those rows to display elemental counters.  Merge the
  // selected profile only at the wire boundary.
  const soul=hero.warSoul||{},a={...hero.attributes,95:hero.attributes[95]??0,96:hero.attributes[96]??0,1:hero.hp,2:hero.mp,15:hero.clientAttackSpeed,
    16:Math.round(hero.range*100),17:hero.clientEffectiveMovePercent??Math.round(movementPercent)};
  // The battle uses aura/debuff-adjusted resistances. Send those same final
  // values so the native panel cannot keep a lower baseline after a proc.
  a[42]=Math.max(0,Number(hero.armor??a[42]??0)+Number(hero.equipmentArmorBonus||0)-Number(hero.equipmentArmorReduction||0));
  a[44]=Math.max(0,Number(hero.magicResistance??a[44]??0)+Number(hero.equipmentMagicResistanceBonus||0)-Number(hero.equipmentMagicResistanceReduction||0));
  // Explicit zeros clear the native cached channels after a page refund.
  // Omitting a now-absent row leaves the client's prior resistance visible.
  for(const id of [32,33,34,35])a[id]=Number(soul.restraint?.[id])||0;
  for(const id of [45,46,47,48])a[id]=Number(soul.resistance?.[id])||0;
  // Relive (7) is an instruction in the native client: every occurrence runs
  // its respawn flow, even value 0. Only battle-native.respawn sends it.
  const rows=Object.entries(a).filter(([id])=>+id!==7),p=Buffer.alloc(1+rows.length*5);p[0]=rows.length;
  rows.forEach(([id,value],i)=>{p[1+i*5]=+id;p.writeUInt32LE(Math.round(value)>>>0,2+i*5);});
  return W.frame(1045,hero.id,p);
}
function equipmentPackets(playerId,loadout){
  const slots=map(loadout),rd=require('./roledata');
  return Array.from({length:6},(_,slot)=>{
    const e=slots.get(slot),p=Buffer.alloc(498);p[0]=slot;p[1]=e?0:255;p.writeUInt16LE(e?.bagSlot??65535,2);
    if(e){
      const record=rd.itemRecord(Buffer.alloc(0),e.bagSlot,e);
      record[73]=e.enhancementLevel||0;record[74]=e.enhancementLevel||0;
      if(/^[0-9a-f]{84}$/i.test(e.reforgeHex||''))Buffer.from(e.reforgeHex,'hex').copy(record,76);
      require('./equipment-soul').patchRecord(record,e,e.soul);
      require('./equipment-forging').patchRecord(record,{applied:{[e.guid]:e.forge}},e.guid);
      record.subarray(0,490).copy(p,4);
    }
    else p.writeUInt32LE(65535,4);
    p.writeUInt32LE(7,494);
    return W.frame(1043,playerId,p);
  });
}
function readInventory(){return stateFiles.readSnapshot(()=>readInventorySnapshot());}
function readInventorySnapshot(){
  const equipFile=process.env.DSH_EQUIP_STATE||path.join(__dirname,'equip-state.json');
  let slots;
  try{slots=new Map(Object.entries(JSON.parse(fs.readFileSync(equipFile+'.snapshot','utf8')).inventory).map(([k,v])=>[+k,v]));}catch{}
  if(!slots){
    slots=new Map();
    const liveFile=process.env.DSH_BAG_STATE||path.join(__dirname,'bag-state.live.json');
    for(const file of [path.join(path.dirname(liveFile),'bag-state.json'),liveFile]){
      const j=JSON.parse(fs.readFileSync(file,'utf8'));
      for(const [key,value]of Object.entries(j.slots||{}))if(value)slots.set(+key,{...value});else slots.delete(+key);
    }
  }
  const propertiesFor=readInstanceProperties();
  return new Map([...slots].map(([slot,item])=>[slot,{...item,...propertiesFor(item)}]));
}
function change(sim,playerId,tag,p,{inventory=readInventory,save=saveLoadout}={}){
  const hero=sim.entities.get(playerId);
  if(!hero?.alive||(tag!==13546&&!sim.entities.values().some(e=>e.kind==='fountain'&&e.alive&&e.team===hero.team&&Math.hypot(e.x-hero.x,e.z-hero.z)<=(e.recoveryRadius||0))))
    return {ok:false,reason:'fountain-required'};
  if((tag===13502&&p.length!==5)||(tag===13504&&![2,5].includes(p.length))||(tag===13546&&p.length!==4))return {ok:false,reason:'invalid-equipment-request'};
  let slots=map(hero.loadout);
  let bag=inventory();const beforeBag=bag,capacity=hero.loadout.capacity||192;
  const slot=p.readUInt16LE(tag===13502?2:0);
  if(slot>=6)return {ok:false,reason:'invalid-equipment-slot'};
  let reply;
  if(tag===13502){
    const bagSlot=p.readUInt16LE(0),held=bag.get(bagSlot);
    if(!held||!['equip','armour','weapon','treasure'].includes(types[held.itemId]?.type)||!Number.isInteger(held.count)||held.count<1||!(/^[a-f0-9]{16}$/i.test(held.guid||''))||/^0+$/.test(held.guid))
      return {ok:false,reason:'invalid-equipment-instance'};
    if(rules.eternalConflict(held,slots.values()))
      return {ok:false,reason:'eternal-artifact-already-equipped',packets:[...equipmentPackets(playerId,hero.loadout),attributePacket(hero)]};
    const planned=rules.planEquip(bag,slots,bagSlot,slot,{capacity,records:552});
    if(!planned.ok)return {ok:false,reason:planned.reason};
    slots=planned.equipped;bag=planned.bag;
    reply=Buffer.from(p);reply.writeUInt16LE(slot);reply.writeUInt16LE(bagSlot,2);
  }else if(tag===13546){
    const to=p.readUInt16LE(2);if(to>=6)return {ok:false,reason:'invalid-equipment-slot'};
    const a=slots.get(slot),b=slots.get(to);slots.delete(slot);slots.delete(to);
    if(a)slots.set(to,{...a,slot:to});if(b)slots.set(slot,{...b,slot});reply=Buffer.alloc(0);
  }else {slots.delete(slot);reply=Buffer.alloc(2);reply.writeUInt16LE(slot);}
  const plan=require('./inventory-capacity').recoverVisible(bag,slots,{capacity,records:552});
  if(!plan.ok)return {ok:false,reason:plan.reason,packets:equipmentPackets(playerId,hero.loadout)};
  const nextSlots=[...plan.equipped].map(([position,e])=>({...plan.bag.get(e.bagSlot),...e,
    slot:position,guid:Buffer.isBuffer(e.guid)?e.guid.toString('hex'):e.guid})).sort((a,b)=>a.slot-b.slot);
  const gemRules=require('./gem-board');
  const gemFile=process.env.DSH_GEM_BOARD_STATE||path.join(
    path.dirname(hero.loadout.source||path.join(__dirname,'equip-state.json')),
    'gem-board-state.json');
  const gemState=new gemRules.GemBoard(gemFile).state,occupied=new Set(nextSlots.map(entry=>entry.slot));
  const gemBonus=gemRules.bonuses(gemState,occupied),gemEffects=gemRules.combatEffects(gemState,occupied);
  const loadout={...hero.loadout,slots:nextSlots,gemBonus,gemEffects,gemState};
  const a=calculate(hero.equipmentBase,loadout);
  try{if(save(loadout,{bag:plan.bag})===false)return {ok:false,reason:'equipment-save-frozen'};}
  catch(error){return {ok:false,reason:'equipment-save-failed',error:error.message};}
  apply(sim,hero,a,loadout);
  const details=[];
  for(let index=0;index<capacity;index++)if(JSON.stringify(beforeBag.get(index))!==JSON.stringify(plan.bag.get(index)))
    details.push(inventoryPacket(index,plan.bag.get(index)));
  return {ok:true,packets:[...details,W.frame(tag+1,0,reply),...equipmentPackets(playerId,loadout),
    W.frame(11888,0,gemRules.actorPayload(gemState,playerId)),attributePacket(hero)]};
}
function inventoryPacket(slot,item){
  const record=require('./roledata').itemRecord(Buffer.alloc(0),slot,item).subarray(0,490);
  if(item){record[73]=item.enhancementLevel||0;record[74]=item.enhancementLevel||0;
    if(/^[a-f0-9]{84}$/i.test(item.reforgeHex||''))Buffer.from(item.reforgeHex,'hex').copy(record,76);
    require('./equipment-soul').patchRecord(record,item,item.soul);
    require('./equipment-forging').patchRecord(record,{applied:{[item.guid]:item.forge}},item.guid);}
  return require('./bag').buildSlotDetail([{slot,instance:record}]);
}
function saveLoadout(loadout,{bag}={}){
  const file=loadout.source,slots=Object.fromEntries(Array.from({length:6},(_,i)=>[i,null]));
  for(const e of loadout.slots)slots[e.slot]=[e.bagSlot,e.itemId,e.count,e.guid].join('|');
  const loadoutPlans=require('./equipment-loadout-plans');
  const hasPlans=Array.isArray(loadout.plans);
  const planState=hasPlans?loadoutPlans.normalize({plans:loadout.plans,activePlan:loadout.activePlan}):null;
  if(planState){
    planState.plans[planState.activePlan]=Array(6).fill(null);
    for(const e of loadout.slots)if(Number.isInteger(e.slot)&&e.slot>=0&&e.slot<6)
      planState.plans[planState.activePlan][e.slot]=[e.bagSlot,e.itemId,e.count,e.guid].join('|');
  }
  const persisted=planState?{version:2,activePlan:planState.activePlan,plans:planState.plans}: {slots};
  const liveFile=process.env.DSH_BAG_STATE||path.join(path.dirname(file),'bag-state.live.json');
  const baseFile=loadout.bagBaseFile||path.join(path.dirname(liveFile),'bag-state.json');
  const pendingFile=process.env.DSH_EQUIPMENT_PENDING||path.join(path.dirname(file),'equipment-economy-pending.json');
  const journal=new (require('./equipment-economy-commit').EquipmentEconomyCommit)(pendingFile);
  const atomic=(target,value)=>{const tmp=target+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,1));fs.renameSync(tmp,target);};
  const steps=[];
  if(bag){
    let base={};try{base=JSON.parse(fs.readFileSync(baseFile,'utf8')).slots||{};}catch{}
    const inventory=Object.fromEntries([...bag].map(([index,item])=>{
      const value={...item};for(const key of ['slot','bagSlot','enhancementLevel','enhancementSkillLevel','reforgeHex','soul'])delete value[key];
      return [index,value];
    }));
    let previous={};try{previous=JSON.parse(fs.readFileSync(file+'.snapshot','utf8')).inventory||{};}catch{}
    let previousLive={};try{previousLive=JSON.parse(fs.readFileSync(liveFile,'utf8')).slots||{};}catch{}
    const overlay={...inventory};for(const key of new Set([...Object.keys(base),...Object.keys(previous),...Object.keys(previousLive)]))if(!bag.has(+key))overlay[key]=null;
    steps.push({name:'battle-bag',path:liveFile,save:()=>atomic(liveFile,{slots:overlay,updatedAt:new Date().toISOString()})});
    steps.push({name:'battle-equipment',path:file,save:()=>atomic(file,{...persisted,updatedAt:new Date().toISOString()})});
    steps.push({name:'battle-snapshot',path:file+'.snapshot',save:()=>atomic(file+'.snapshot',{
      capacity:loadout.capacity||192,bagBaseFile:baseFile,equipment:slots,plans:planState?.plans||null,activePlan:planState?.activePlan??0,inventory})});
  }else steps.push({name:'battle-equipment',path:file,save:()=>atomic(file,{...persisted,updatedAt:new Date().toISOString()})});
  return journal.run('battle-equipment',loadout.slots.map(e=>e.guid).join(','),steps);
}
function soulDeath(sim,killer,victim,store){
  if(victim.kind!=='hero')return;
  for(const [hero,operation]of [[victim,'death'],[killer,'kill']]){
    if(hero.kind!=='hero'||hero.testDummy||!hero.loadout)continue;
    const changed=store.change(hero.loadout.slots,operation);if(!changed.length)continue;
    const slots=hero.loadout.slots.map(e=>({...e,soul:store.get(e.guid,e.itemId)}));
    const loadout={...hero.loadout,slots};apply(sim,hero,calculate(hero.equipmentBase,loadout),loadout);
    sim.event('soul-change',{id:hero.id,operation,packets:[...equipmentPackets(hero.id,loadout),attributePacket(hero)]});
  }
}
module.exports={heroBase,baseAttributes,calculate,apply,attributePacket,equipmentPackets,change,readInventory,map,soulDeath,inventoryPacket,saveLoadout};
