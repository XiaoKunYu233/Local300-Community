'use strict';
const stateFiles=require('./persistence/state-files');
const fs=stateFiles.io,path=require('path');
const loadoutPlans=require('./equipment-loadout-plans');

// VIP privileges belong to the authenticated account ledger. The source
// equipment directory and ledger must agree, including in multi-account runs.
function readVIP(file,{accountFile=process.env.DSH_PLAYER_ACCOUNTS,uid=Number(process.env.DSH_PLAYER_UID)}={}){
  if(!accountFile)return null;
  if(!path.isAbsolute(accountFile)||!Number.isSafeInteger(uid)||uid<1||uid>0xffffffff||
    path.dirname(path.resolve(file))!==path.dirname(path.resolve(accountFile)))throw Error('VIP ledger is outside the current loadout account');
  const account=new(require('./player-account-state').PlayerAccounts)(accountFile).get(uid);
  if(!account)throw Error('VIP loadout account is unavailable');
  if(account.vip===undefined)return null;
  const vip=require('./player-vip-wire').validate(account.vip,account),catalog=require('./player-vip-catalog').load();
  return {profile:{uid:account.uid,playerId:account.playerId,level:vip.level,source:vip.source,
    observedAt:vip.observedAt,receiptSha256:vip.receiptSha256??null,catalogSha256:catalog.combatSha256,
    ...(/^(?:native-new-account|local-reference-template):/.test(vip.source)?{publicBetaIdentity:{...account.publicBetaIdentity}}:{})},bonus:require('./player-vip-catalog').bonuses(vip.level,catalog)};
}
function vipStateToken(file){
  const value=readVIP(file);return value?'vip:'+JSON.stringify(value.profile):'vip:none';
}

// Read persisted instance properties once for a loadout or inventory snapshot.
// The GUID remains authoritative when an item moves between equipment and bag.
function readInstanceProperties(
  enhancementFile=process.env.DSH_ENHANCEMENT_STATE||path.join(__dirname,'enhancement-state.json'),
  reforgeFile=process.env.DSH_REFORGE_STATE||path.join(path.dirname(enhancementFile),'reforge-state.json'),
  craftingFile=process.env.DSH_CRAFTING_STATE||path.join(path.dirname(enhancementFile),'equipment-crafting-state.json')){
  const enhancement=new (require('./enhancement-state').EnhancementState)(enhancementFile);
  const reforge=new (require('./reforge-state').ReforgeState)(reforgeFile);
  const souls=new (require('./equipment-soul').SoulState)(process.env.DSH_SOUL_STATE||path.join(path.dirname(enhancementFile),'soul-state.json'));
  const crafting=new (require('./equipment-crafting').EquipmentCrafting)({file:craftingFile});
  return entry=>{
    const validGuid=/^[a-f0-9]{16}$/i.test(entry.guid||'')&&!/^0{16}$/.test(entry.guid);
    const level=validGuid?enhancement.get(entry.guid,entry.itemId):0;
    const applied=validGuid?reforge.getApplied(entry.guid):null;
    return {enhancementLevel:level,enhancementSkillLevel:Math.min(level,15),
      reforgeHex:applied?.itemId===entry.itemId?applied.candidateHex:null,
      soul:validGuid?souls.get(entry.guid,entry.itemId):null,
      forge:validGuid?crafting.getApplied(entry.guid):null};
  };
}

// Shared, read-only bridge from the lobby's persisted equipment model to a
// battle session. Saved enhancement and reforge properties follow each GUID.
function readLoadout(...args){return stateFiles.readSnapshot(()=>readLoadoutSnapshot(...args));}
function readLoadoutSnapshot(file=process.env.DSH_EQUIP_STATE||path.join(__dirname,'equip-state.json'),
  enhancementFile=process.env.DSH_ENHANCEMENT_STATE||path.join(__dirname,'enhancement-state.json'),
  reforgeFile=process.env.DSH_REFORGE_STATE||path.join(path.dirname(enhancementFile),'reforge-state.json')){
  let data,missing=false;
  try{data=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;data={slots:{}};missing=true;}
  let baseline={},snapshot={};
  if(!missing)try{snapshot=JSON.parse(fs.readFileSync(file+'.snapshot','utf8'));baseline=snapshot.equipment||{};}catch{}
  const slots=[];
  const hasPlans=Array.isArray(data.plans)||(data.plans&&typeof data.plans==='object');
  const planState=hasPlans?loadoutPlans.normalize(data):null;
  const activeLines=planState?Object.fromEntries(planState.plans[planState.activePlan].map((value,slot)=>[slot,value])):null;
  const sourceSlots=activeLines||{...baseline,...data.slots};
  for(const [slot,line] of Object.entries(sourceSlots)){
    if(line===null)continue;
    const [bagSlot,itemId,count,guid]=String(line).split('|');
    const entry={slot:+slot,bagSlot:+bagSlot,itemId:+itemId,count:+count,guid};
    if(Number.isInteger(entry.slot)&&entry.slot>=0&&Number.isInteger(entry.itemId)&&entry.itemId>0&&entry.itemId!==0xffff)slots.push(entry);
  }
  const propertiesFor=readInstanceProperties(enhancementFile,reforgeFile);
  for(const entry of slots)Object.assign(entry,propertiesFor(entry));
  const normalized=require('./equipment-rules').normalize(slots);
  const gemFile=process.env.DSH_GEM_BOARD_STATE||
    path.join(path.dirname(file),'gem-board-state.json');
  const gemBoard=new (require('./gem-board').GemBoard)(gemFile);
  const gemBonus=require('./gem-board').bonuses(gemBoard.state,
    new Set(normalized.map(entry=>entry.slot)));
  const gemEffects=require('./gem-board').combatEffects(gemBoard.state,
    new Set(normalized.map(entry=>entry.slot)));
  const progression=require('./progression-systems').ProgressionSystems;
  const systems=new progression({directory:path.dirname(file)});
  const types=require('./current-item-catalog').load().byId;
  const magicDevices=normalized.filter(entry=>types[entry.itemId]?.type==='magicgemequip');
  // Magical devices occupy a dedicated per-plan slot and therefore do not
  // appear in the six ordinary equipment records. Include the selected plan's
  // device GUID in the progression snapshot so its level, gems and circuit
  // bonuses reach battle attribute calculation.
  const activePlan=Math.max(0,Math.min(2,Number(planState?.activePlan ?? snapshot.activePlan ?? data.activePlan ?? 0)||0));
  const magicStateFile=process.env.DSH_MAGIC_GEM_STATE||path.join(path.dirname(file),'magic-gem-state.json');
  let magicState={};try{magicState=JSON.parse(fs.readFileSync(magicStateFile,'utf8'));}catch{}
  const magicDeviceByPlan=Array.isArray(magicState.equippedBySet)
    ? Array.from({length:3},(_,index)=>magicState.equippedBySet[index]||null)
    : [magicState.currentDeviceGuid||null,null,null];
  const dedicatedMagicGuid=magicDeviceByPlan[activePlan];
  // Snapshot assembly is deliberately read-only. A device record is created
  // by the live progression request when the native equipment instance is
  // first used; loading a battle snapshot must never mutate account state.
  const deviceGuids=magicDevices.map(entry=>entry.guid);
  const progressionOptions={deviceGuids:[...deviceGuids,...(dedicatedMagicGuid?[dedicatedMagicGuid]:[])]};
  const progressionBonus=systems.bonuses(progressionOptions), magicGemEffects=systems.magicGemEffects(progressionOptions), warSoulEffects=systems.warSoulEffects(), warSoulProfile=systems.warSoulProfile();
  const progressionSources=systems.bonusSources(progressionOptions),vip=readVIP(file);
  const runeGodsendSelection=require('./battle-progression-effects').runeSelection(systems.rune.state);
  const runeGodsendEffects=runeGodsendSelection.filter(e=>e.nativeStatusId!==null);
  const accountProgression=require('./battle-account-progression').read(file);
  if(runeGodsendEffects.some(e=>e.godsendId===21))accountProgression.forger=require('./battle-forger-progression').read(file,{
    enhancementFile,bagFile:process.env.DSH_BAG_STATE||path.join(path.dirname(file),'bag-state.live.json')});
  if(vip)progressionSources.vip=vip.bonus;
  return {slots:normalized,source:file,currentClient:true,capacity:snapshot.capacity||192,
    activePlan:planState?.activePlan??activePlan,plans:planState?.plans??null,magicDeviceByPlan,dedicatedMagicGuid,
    bagBaseFile:stateFiles.enabled()?stateFiles.documentPath('bag-seed'):snapshot.bagBaseFile,
    gemBonus,gemEffects,progressionBonus,progressionSources,vipProfile:vip?.profile??null,vipBonus:vip?.bonus??{},runeGodsendEffects,runeGodsendSelection,accountProgression,magicGemEffects,warSoulEffects,warSoulProfile,gemState:gemBoard.snapshot()};
}
function progressionStateToken(file){const value=require('./battle-account-progression').read(file);return 'account-progression:'+JSON.stringify(value.profile);}
module.exports={readLoadout,readInstanceProperties,readVIP,vipStateToken,progressionStateToken};
