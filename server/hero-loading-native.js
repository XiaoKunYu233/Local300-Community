'use strict';
const W=require('./battle-wire'),P=require('./battle-protobuf'),identity=require('./hero-bootstrap-native'),learning=require('./hero-learning-native'),skillLists=require('./hero-skill-lists-native');
const sourceParameters=new Set([2850,2854]),sourceStatuses=new Set([12842,12853]);
// Only an accepted, identity-rebound local loading segment may be converted.
// Account appearance, equipment, attributes and new per-skill parameters remain
// their respective producers' responsibility. This is not a playable scene.
function prepare(frames,{playerId,sourceHeroId=101,heroId,skinId=0,levels,extraLevels,learningTemplate}={}){
  if(!Array.isArray(frames)||sourceHeroId!==101||![53,156,234,102,138,121,283].includes(heroId))throw Error('Unsupported hero loading candidate');
  const learn=learning.forHero({heroId,playerId,levels,extraLevels,template:learningTemplate});
  const options={playerId,sourceHeroId,heroId,skinId},removed=[],retainedParameterKeys=new Set();
  // Validate every input before producing candidate frames or reporting edits.
  const flat=frames.flatMap(frame=>W.expand(frame));
  if(!flat.some(frame=>frame.readUInt16LE(8)===1328&&frame.readUInt32LE(4)===playerId&&frame.readUInt16LE(12)===sourceHeroId))
    throw Error('Local source hero transform required in loading segment');
  const transforms=flat.filter(frame=>frame.readUInt16LE(8)===1327),localSyncs=flat.filter(frame=>frame.readUInt16LE(8)===11048&&
    skillLists.readSync(frame).playerId===playerId),skillArraysRebuilt=transforms.length>0||localSyncs.length>0;
  if(skillArraysRebuilt&&(transforms.length!==1||localSyncs.length!==1))throw Error('Unique local transform and learned list required');
  if(skillArraysRebuilt&&flat.indexOf(transforms[0])>=flat.indexOf(localSyncs[0]))throw Error('Transform must precede learned-list synchronization');
  const localModels=flat.filter(frame=>frame.readUInt16LE(8)===1328&&frame.readUInt32LE(4)===playerId);
  const localResets=flat.filter(frame=>identity.resetFields(frame,playerId,sourceHeroId));
  if(skillArraysRebuilt&&(localModels.length!==1||localModels[0].length!==19||localModels[0].readUInt16LE(12)!==sourceHeroId))
    throw Error('Full local profile requires one valid source model transform');
  if(skillArraysRebuilt&&!localResets.length)throw Error('Full local profile requires source status reset');
  const converted=frames.map(frame=>W.transform(frame,part=>{
    const tag=part.readUInt16LE(8),local=part.readUInt32LE(4)===playerId;
    if(tag===1327)return skillLists.transform(part,{...options,levels,extraLevels});
    if(tag===11048){const result=skillLists.sync(part,{...options,levels,extraLevels});if(result.frame)return result.frame;return result;}
    if(local&&tag===11035){
      if(part.length!==20)throw Error('Unsupported local loading parameter shape');
      const key=part.readUInt16LE(12);
      if(sourceParameters.has(key)){removed.push({tag,key});return null;}retainedParameterKeys.add(key);
    }
    if(local&&tag===11007){
      if(part.length<13||part[12]!==part.length-13)throw Error('Unsupported local loading state shape');
      const fields=P.decode(part.subarray(13));
      if(fields.filter(row=>row.number===3).length===1&&P.get(fields,3)===sourceHeroId&&
        fields.filter(row=>row.number===5).length===1&&sourceStatuses.has(P.get(fields,5))){
        removed.push({tag,statusId:P.get(fields,5)});return null;
      }
    }
    return identity.patch(part,options);
  })).filter(Boolean);
  // Append after the existing clean-parameter/reset sequence. Preserve that
  // sequence and the source's unknown common/map/equipment status ownership.
  return {frames:[...converted,...learn.frames],removed,learning:learn.learning,
    retainedParameterKeys:[...retainedParameterKeys],heroId,playerId,
    skillArraysRebuilt,fullLocalProfileRebuilt:skillArraysRebuilt&&localModels.length===1&&localResets.length>0,
    scope:'accepted-loading-transform-and-four-slot-candidate',completePlayerBootstrap:false,playable:false};
}
module.exports={prepare};
