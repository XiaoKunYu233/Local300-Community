'use strict';
const W=require('./battle-wire');
// Native 65d770: 40 factions/groups with 30 player records, 0x92 bytes each.
// 65d868 reads actor at frame+0x1b; 65e060 copies frame+0x41/+0x43
// into profile+0x40/+0x42. 65e392 then reimports the local D/F bar.
const ROSTER_TAG=23444,ROSTER_RECORD_BYTES=0x92,ROSTER_RECORD_COUNT=40*30;
const ROSTER_BYTES=175292;
function rosterSkills(frame,playerId){
  if(!Buffer.isBuffer(frame)||frame.length!==ROSTER_BYTES||frame.readUInt16LE(8)!==ROSTER_TAG)return null;
  for(let index=0;index<ROSTER_RECORD_COUNT;index++){
    const actorOffset=0x1b+index*ROSTER_RECORD_BYTES;
    if(frame.readUInt32LE(actorOffset)!==playerId)continue;
    return {index,actorOffset,D:frame.readUInt16LE(actorOffset+38),F:frame.readUInt16LE(actorOffset+40),
      skinD:frame.readUInt16LE(actorOffset+42),skinF:frame.readUInt16LE(actorOffset+44)};
  }
  return null;
}
// 23442 construction: client eb7b90..eb7c33, 16-byte frame with two u16 IDs.
// 23443 consumption: e756c0..e75749; actor, two skills, two skin IDs.
function skills(playerId,chosen){
  const p=Buffer.alloc(12);p.writeUInt32LE(playerId);p.writeUInt16LE(chosen.D,4);p.writeUInt16LE(chosen.F,6);
  return W.frame(23443,0,p);
}
function confirm(playerId,heroId){
  const p=Buffer.alloc(7);p.writeUInt32LE(playerId);p.writeUInt16LE(heroId,4);
  return W.frame(23437,0,p);
}
function patchSkills(frame,chosen,playerId){
  const f=Buffer.from(frame),tag=f.readUInt16LE(8);
  if(tag===27008){f.writeUInt32LE(90000,12);f.writeUInt16LE(chosen.D,16);f.writeUInt16LE(chosen.F,18);}
  if(tag===9017){f.writeUInt32LE(chosen.D,12);f.writeUInt32LE(chosen.F,16);}
  if(tag===23443&&f.length===24&&f.readUInt32LE(12)===playerId){
    f.writeUInt16LE(chosen.D,16);f.writeUInt16LE(chosen.F,18);
    f.writeUInt16LE(0,20);f.writeUInt16LE(0,22);
  }
  const row=rosterSkills(f,playerId);
  if(row){
    f.writeUInt16LE(chosen.D,row.actorOffset+38);f.writeUInt16LE(chosen.F,row.actorOffset+40);
    f.writeUInt16LE(0,row.actorOffset+42);f.writeUInt16LE(0,row.actorOffset+44);
  }
  return f;
}
module.exports={skills,confirm,patchSkills,rosterSkills};
