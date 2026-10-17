'use strict';
const snapshot=require('./research/hero-combat-20261010/emiya/bootstrap-slots.json');
const second=require('./research/hero-combat-20261010/second-native/bootstrap-profiles.json');
const third=require('./research/hero-combat-20261010/third-native/bootstrap-profiles.json');
const profiles=[...snapshot.profiles,...second.profiles,...third.profiles,require('./arthur-native-data').profile];
const slots=['Q','W','E','R'];
// Current native slot construction and linked-rank consumer are documented in
// emiya/bootstrap-contract.md. Learning never authorizes a server cast.
function acknowledgement(template,{playerId,skillId,level}={}){
  if(!Buffer.isBuffer(template)||template.length!==20||template.readUInt32LE(0)!==20||
    template.readUInt16LE(8)!==11019||template[13]!==0)throw Error('Successful native learning template required');
  if(!Number.isInteger(playerId)||playerId<1||playerId>0xffffffff||!Number.isInteger(skillId)||skillId<1||skillId>65535||
    !Number.isInteger(level)||level<1||level>65535)throw Error('Invalid native learning identity or rank');
  const out=Buffer.from(template);out.writeUInt32LE(playerId,4);out.writeUInt16LE(skillId,16);out.writeUInt16LE(level,18);return out;
}
function extraRanks(profile,levels){
  if(levels===undefined)return [];
  const extra=profile.extraUiSkills||[];
  if(!extra.length||!levels||typeof levels!=='object'||Array.isArray(levels)||Object.keys(levels).length!==extra.length||
    !extra.every(row=>Object.hasOwn(levels,row.skillId)&&Number.isInteger(levels[row.skillId])&&levels[row.skillId]>=0&&levels[row.skillId]<=row.configuredCap))
    throw Error('Explicit current extra UI ranks required');
  return extra.filter(row=>levels[row.skillId]>0).map(row=>({profile:row,rank:levels[row.skillId]}));
}
function forHero({heroId,playerId,levels,extraLevels,template}={}){
  const profile=profiles.find(row=>row.heroId===heroId);
  if(!profile||!levels||typeof levels!=='object'||Array.isArray(levels)||Object.keys(levels).length!==4||
    !slots.every((slot,index)=>Number.isInteger(levels[slot])&&levels[slot]>=0&&levels[slot]<=profile.rankCaps[index]))
    throw Error('Explicit current hero QWER ranks required');
  // Validate even when every skill is intentionally unlearned.
  acknowledgement(template,{playerId,skillId:profile.QWER[0],level:1});
  const frames=[],learning=[];
  for(let index=0;index<4;index++){
    const slot=slots[index],rank=levels[slot],skillId=profile.QWER[index];if(rank===0)continue;
    const availability=profile.bindings.find(row=>row.skillId===skillId)?.rankAvailability.find(row=>row.rank===rank);
    if(!availability)throw Error('Missing current native skill rank');
    frames.push(acknowledgement(template,{playerId,skillId,level:rank}));
    learning.push({slot,skillId,rank,linkedSkills:availability.linkedSkillIds.filter(id=>!availability.missingLinkedRank.includes(id)),
      missingLinkedRank:[...availability.missingLinkedRank]});
  }
  for(const {profile:row,rank}of extraRanks(profile,extraLevels)){
    const availability=row.rankAvailability.find(value=>value.rank===rank);
    if(!availability)throw Error('Missing current extra native skill rank');
    frames.push(acknowledgement(template,{playerId,skillId:row.skillId,level:rank}));
    learning.push({slot:row.slot,skillId:row.skillId,rank,linkedSkills:availability.linkedSkillIds.filter(id=>!availability.missingLinkedRank.includes(id)),missingLinkedRank:[...availability.missingLinkedRank]});
  }
  return {frames,learning,heroId,playerId,scope:extraLevels===undefined?'native-four-slot-learning-candidate':'native-eleven-slot-learning-candidate',completePlayerBootstrap:false,playable:false};
}
module.exports={acknowledgement,forHero,extraRanks};
