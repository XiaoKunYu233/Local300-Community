'use strict';
const W=require('./battle-wire'),evidence=require('./research/hero-combat-20261010/full-bootstrap/skill-array-snapshot.json');
const slotIds=require('./research/hero-combat-20261010/emiya/bootstrap-slots.json').profiles;
const secondProfiles=require('./research/hero-combat-20261010/second-native/bootstrap-profiles.json').profiles,
  secondTargets=require('./research/hero-combat-20261010/second-native/skill-list-profiles.json').targets;
const thirdProfiles=require('./research/hero-combat-20261010/third-native/bootstrap-profiles.json').profiles,
  thirdTargets=require('./research/hero-combat-20261010/third-native/skill-list-profiles.json').targets;
const snapshots=new Map([[156,require('./research/hero-combat-20261010/emiya/snapshot.json')],[234,require('./research/hero-combat-20261010/kanna/snapshot.json')]]);
for(const profile of require('./research/hero-combat-20261010/second-native/snapshot.json').heroes)snapshots.set(profile.heroId,profile);
for(const profile of require('./research/hero-combat-20261010/third-native/snapshot.json').heroes)snapshots.set(profile.heroId,profile);
snapshots.set(53,require('./arthur-native-data'));
const sources=new Map(evidence.syncs[0].rows.map(row=>[row.skillId,row]));
const sourceTransform=evidence.transforms[0].rows.filter(row=>row.profession===101);
const slots=['Q','W','E','R'];
const uint=(value,max=65535)=>Number.isInteger(value)&&value>0&&value<=max;
function frameCheck(frame,tag){if(!Buffer.isBuffer(frame)||frame.length<12||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==tag)throw Error('Invalid native skill-list frame');}
function readTransform(frame){
  frameCheck(frame,1327);if(frame.length!==1015||frame.readUInt32LE(4)!==0)throw Error('Unsupported local transform skill-array shape');
  const rows=Array.from({length:200},(_,index)=>({index,unknownByte:frame[15+index*5],rank:frame.readUInt16LE(16+index*5),skillId:frame.readUInt16LE(18+index*5)}));
  let padding=false;for(const row of rows){if(!row.skillId){if(row.rank||row.unknownByte)throw Error('Unsupported transform padding');padding=true;}
    else if(padding||!row.rank)throw Error('Noncontiguous transform skill records');}
  return {heroId:frame.readUInt16LE(12),skinId:frame[14],rows};
}
function readSync(frame){
  frameCheck(frame,11048);if(frame.length<20)throw Error('Truncated native learned list');
  const count=frame.readUInt16LE(18);if(frame.length!==20+count*4||count>199)throw Error('Unsupported native learned-list size');
  return {headerActor:frame.readUInt32LE(4),playerId:frame.readUInt32LE(12),heroId:frame.readUInt16LE(16),rows:Array.from({length:count},(_,index)=>({index,
    skillId:frame.readUInt16LE(20+index*4),rank:frame.readUInt16LE(22+index*4)}))};
}
function target({playerId,sourceHeroId=101,heroId,skinId=0,levels,extraLevels}={}){
  const profile=[...evidence.targets,...secondTargets,...thirdTargets,require('./arthur-native-data').target].find(row=>row.heroId===heroId),slotProfile=[...slotIds,...secondProfiles,...thirdProfiles,require('./arthur-native-data').profile].find(row=>row.heroId===heroId);
  if(sourceHeroId!==101||!uint(playerId,0xffffffff)||!profile||!Number.isInteger(skinId)||skinId<0||skinId>31||
    !levels||Object.keys(levels).length!==4||!slots.every((slot,index)=>uint(levels[slot],slotProfile.rankCaps[index])))
    throw Error('Explicit learned candidate hero ranks required');
  const config=snapshots.get(heroId),rows=new Map(config.skillLevels.map(row=>[`${row.named.nSkillID}:${row.named.nLevel}`,row.named]));
  const seeds=[{skillId:profile.defaultAttackId,rank:1},{skillId:profile.passiveId,rank:1},
    ...slotProfile.QWER.map((skillId,index)=>({skillId,rank:levels[slots[index]]}))];
  for(const {profile:row,rank}of require('./hero-learning-native').extraRanks(slotProfile,extraLevels))seeds.push({skillId:row.skillId,rank});
  for(const seed of seeds)if(!rows.has(`${seed.skillId}:${seed.rank}`))throw Error('Missing current target native skill rank');
  return {playerId,sourceHeroId,heroId,skinId,profile,seeds,rows};
}
function transform(frame,options){
  const chosen=target(options),source=readTransform(frame);
  if(source.heroId!==chosen.sourceHeroId||source.skinId>31)throw Error('Unexpected local source profession');
  if(sourceTransform.length!==2)throw Error('Unsupported source ordinary/passive transform set');
  const replacement=new Map([[2841,chosen.profile.defaultAttackId],[2856,chosen.profile.passiveId]]),found=new Set(),all=new Set();
  for(const row of source.rows)if(row.skillId){
    const known=sources.get(row.skillId);if(!known||known.rank!==row.rank||all.has(row.skillId))throw Error('Unclassified source transform skill');all.add(row.skillId);
    if(known.profession===101){if(!replacement.has(row.skillId)||row.rank!==1||row.unknownByte!==0||found.has(row.skillId))throw Error('Unsupported source transform hero record');found.add(row.skillId);}
  }
  if(found.size!==2)throw Error('Missing source ordinary/passive transform records');
  const expected=evidence.transforms[0].rows.filter(row=>row.skillId);
  if(all.size!==expected.length||expected.some(row=>!all.has(row.skillId)))throw Error('Source transform skill set differs from current capture');
  const out=Buffer.from(frame);out.writeUInt16LE(chosen.heroId,12);out[14]=chosen.skinId;
  for(const row of source.rows)if(replacement.has(row.skillId))out.writeUInt16LE(replacement.get(row.skillId),18+row.index*5);
  return out;
}
function sync(frame,options){
  const chosen=target(options),source=readSync(frame);
  // bf9301 selects the profile from the OUTER actor. Only header0 is proven
  // as the local loading path; the payload actor alone cannot authorize it.
  if(source.headerActor!==0){if(source.playerId===chosen.playerId||source.headerActor===chosen.playerId)throw Error('Foreign learned-list header conflicts with local identity');
    return {frame:Buffer.from(frame),foreign:true,removed:[],retainedCount:source.rows.length,seedCount:0};}
  if(source.playerId!==chosen.playerId)throw Error('Implicit local learned-list actor mismatch');
  if(source.heroId!==chosen.sourceHeroId)throw Error('Unexpected source learned profession');
  const retained=[],removed=[],seen=new Set();
  for(const row of source.rows){const known=sources.get(row.skillId);
    if(!known||row.rank!==known.rank||seen.has(row.skillId))throw Error('Unclassified source learned skill');seen.add(row.skillId);
    if(known.profession===101)removed.push(row.skillId);else retained.push(row);
  }
  if(seen.size!==sources.size)throw Error('Source learned skill set differs from current capture');
  // A conservative union bounds c1c880's 199-record storage. The verified
  // retained bindings and target bindings cannot restore a source101 family.
  const expanded=new Set([...Object.keys(chosen.profile.proposedSync.expandedRanks).map(Number),...retained.map(row=>row.skillId)]);
  for(const seed of chosen.seeds){expanded.add(seed.skillId);const row=chosen.rows.get(`${seed.skillId}:${seed.rank}`);
    for(const id of (row.strLevelUpBindSkill||'').split(';').map(Number).filter(id=>uint(id)))if(chosen.rows.has(`${id}:${seed.rank}`))expanded.add(id);}
  if(expanded.size>199)throw Error('Native learned skill capacity exceeded');
  const rows=[...retained,...chosen.seeds];if(rows.length>199)throw Error('Native learned list capacity exceeded');
  const payload=Buffer.alloc(8+rows.length*4);payload.writeUInt32LE(chosen.playerId,0);payload.writeUInt16LE(chosen.heroId,4);payload.writeUInt16LE(rows.length,6);
  rows.forEach((row,index)=>{payload.writeUInt16LE(row.skillId,8+index*4);payload.writeUInt16LE(row.rank,10+index*4);});
  return {frame:W.frame(11048,frame.readUInt32LE(4),payload,frame.readUInt16LE(10)),removed,retainedCount:retained.length,
    seedCount:chosen.seeds.length,expandedCapacityBound:expanded.size};
}
module.exports={readTransform,readSync,transform,sync};
