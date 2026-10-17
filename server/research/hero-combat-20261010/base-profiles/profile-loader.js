'use strict';
// A data loader, not a combat implementation or hero-selection allowlist.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const requiredInputFields=['fBaseHP','fLevelUpHP','fBaseMP','fLevelUpMP','fHPRecover','fLevelupHPRecover','fMPRecover','fLevelupMPRecover','fLevelUpAttackSpeed','fHitRate','fDodge','fCriticalHit','fBaseAttack','fLevelUpAttack','fMagicAttack','fBaseArmor','fLevelUpArmor','fBaseMagicArmor','fLevelUpMagicArmor','fHPAbsorb','fMPAbsorb','fSuperArmor','fColdDownMinusPercent','fArmorPuncture','fMagicArmorPuncture','fArmorPuncturePercent','fMagicArmorPuncturePercent','fMoveSpeed','fBaseAttackSpeed'];
function freeze(value){
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const item of Object.values(value))freeze(item);
  Object.freeze(value);
 }
 return value;
}
function load({snapshotPath=path.join(__dirname,'profiles.json'),manifestPath=path.join(path.dirname(snapshotPath),'source-manifest.json')}={}){
 const bytes=fs.readFileSync(snapshotPath),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 const recorded=manifest.artifacts?.find(a=>a.file===path.basename(snapshotPath));
 if(!recorded||recorded.sha256!==sha(bytes))throw Error('Profile snapshot checksum mismatch');
 const data=JSON.parse(bytes);
 if(data.formatVersion!==1||data.profiles?.length!==33)throw Error('Unsupported profile snapshot');
 const byId=new Map();
 for(const profile of data.profiles){
  if(!Number.isSafeInteger(profile.heroId)||profile.heroId<=0||byId.has(profile.heroId))throw Error('Invalid or duplicate profile ID');
  if(profile.hero.named.nHeroId!==profile.heroId||profile.hero.named.nCommonAttackSkillID!==profile.defaultAttackId)throw Error('Profile hero/attack identity mismatch');
  const attack=profile.defaultAttack;
  if(attack.nSkillID!==profile.defaultAttackId||attack.nLevel!==1||!Number.isFinite(attack.fRange)||attack.fRange<=0)throw Error('Invalid default attack range');
  const row=profile.attackLevels.filter(r=>r.named.nSkillID===profile.defaultAttackId&&r.named.nLevel===1);
  if(row.length!==1||row[0].named.fRange!==attack.fRange)throw Error('Default attack source mismatch');
  if(Object.keys(profile.heroBaseInput||{}).length!==requiredInputFields.length||requiredInputFields.some(key=>!Object.hasOwn(profile.heroBaseInput,key)))throw Error('Incomplete heroBase source input set');
  for(const [key,value]of Object.entries(profile.heroBaseInput)){
   if(!Number.isFinite(value)||profile.hero.named[key]!==value)throw Error('Invalid or defaulted heroBase source input '+key);
  }
  if(profile.heroBaseDefaultedFields?.length)throw Error('Unverified protobuf-default heroBase inputs');
  byId.set(profile.heroId,profile);
 }
 freeze(data);
 function get(heroId){
  if(!Number.isSafeInteger(heroId))throw Error('Hero ID must be a numeric integer');
  const profile=byId.get(heroId);if(!profile)throw Error('Hero has no reviewed base source profile: '+heroId);
  return profile;
 }
 function inputs(heroId){
  const profile=get(heroId),heroBaseInput={...profile.heroBaseInput};
  const sourceAttack=profile.attackLevels.find(r=>r.named.nSkillID===profile.defaultAttackId&&r.named.nLevel===1);
  return freeze({heroId,nHeroId:heroId,attackId:profile.defaultAttackId,commonAttackSkillID:profile.defaultAttackId,
   heroRow:heroBaseInput,heroBaseInput,range:profile.defaultAttack.fRange,attackRow:sourceAttack.named,
   runtimeMode:{status:'unverified',evidence:profile.attackModeEvidence},
   sourceHeroRowSha256:profile.hero.sha256,sourceAttackRowSha256:sourceAttack.sha256});
 }
 function attributes(heroId,level,heroBase){
  if(!Number.isSafeInteger(level)||level<1)throw Error('Hero level must be a positive safe integer');
  if(typeof heroBase!=='function')throw Error('Supply the current battle-equipment.heroBase function');
  const input=inputs(heroId),result=heroBase(input.heroRow,level,input.range);
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Invalid heroBase attribute result');
  const copied={...result};
  for(const [key,value]of Object.entries(copied))if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw Error('Invalid heroBase attribute '+key);
  if(copied[4]!==level||copied[16]!==Math.round(input.range*100)||copied[130]!==input.heroRow.fBaseAttackSpeed)throw Error('Unexpected heroBase consumer mapping');
  return freeze(copied);
 }
 return Object.freeze({data,get,inputs,attributes,list:()=>data.profiles});
}
module.exports={load,requiredInputFields:Object.freeze(requiredInputFields)};
