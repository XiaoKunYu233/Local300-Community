'use strict';
const B=require('./battle-protocol'),P=require('./battle-protobuf'),W=require('./battle-wire');
// Model-changing identity messages are distinct from ordinary status messages:
// field 3 in an attached status describes its source hero, not the target hero.
// Keep bounded diagnostics so a client report can be matched to actual sends.
function inspect(frames,{playerId,heroId}={}){
 if(!Number.isInteger(playerId)||!Number.isInteger(heroId))return [];
 const rows=[];
 for(const f of frames.flatMap(frame=>W.expand(frame))){
  const tag=f.readUInt16LE(8);let observedHeroId,skinId,operation;
  if(tag===23512&&f.length>=20&&f.readUInt32LE(12)===playerId){
   observedHeroId=f.readUInt16LE(16);skinId=f.readUInt16LE(18);operation='identity';
  }else if(tag===1052&&f.readUInt32LE(4)===playerId){
   const spawn=B.readSpawn(f);if(spawn?.kind!=='hero')continue;
   observedHeroId=spawn.heroId;skinId=spawn.skinId;operation='spawn';
  }else if(tag===11007&&f.readUInt32LE(4)===playerId&&f.length>=13&&f[12]===f.length-13){
   const fields=P.decode(f.subarray(13));if(P.get(fields,5)!==undefined)continue;
   observedHeroId=P.get(fields,3);if(observedHeroId===undefined)continue;
   skinId=P.get(fields,11)??0;operation='status-reset';
  }else continue;
  rows.push({type:'battle-self-appearance-send-queued',tag,playerId,selectedHeroId:heroId,
   heroId:observedHeroId,skinId,operation,consistent:observedHeroId===heroId});
 }
 return rows;
}
module.exports={inspect};
