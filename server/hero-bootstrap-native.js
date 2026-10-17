'use strict';
const W=require('./battle-wire'),P=require('./battle-protobuf');
const identity=require('./player-battle-identity');
function optionsFor(options){
  const {playerId,sourceHeroId,heroId,skinId}=options||{};
  if(!Number.isInteger(playerId)||playerId<1||playerId>0xffffffff||
    !Number.isInteger(sourceHeroId)||sourceHeroId<1||sourceHeroId>65535||
    !Number.isInteger(heroId)||heroId<1||heroId>65535||
    !Number.isInteger(skinId)||skinId<0||skinId>31)throw Error('Invalid local hero bootstrap identity');
  return {playerId,sourceHeroId,heroId,skinId};
}
function checkFrame(frame){
  if(!Buffer.isBuffer(frame)||frame.length<12||frame.readUInt32LE(0)!==frame.length)
    throw Error('Invalid hero bootstrap frame');
}
// Only the captured no-status reset is a target-hero initialization message.
// In all other 11007 states field 3 is the *source* profession. Do not rewrite
// incoming statuses, unnamed extensions, forms, or another actor's profession.
function resetFields(frame,playerId,sourceHeroId){
  if(frame.readUInt16LE(8)!==11007||frame.readUInt32LE(4)!==playerId)return null;
  if(frame.length<13||frame[12]!==frame.length-13)throw Error('Invalid hero bootstrap status length');
  const fields=P.decode(frame.subarray(13));
  if(fields.length!==3||fields.some(f=>f.wire!==0||![3,10,11].includes(f.number))||
    new Set(fields.map(f=>f.number)).size!==3||P.get(fields,3)!==sourceHeroId||P.get(fields,10)!==1)
    return null;
  const skin=P.get(fields,11);return skin>=0&&skin<=31?fields:null;
}
function rewrite(frame,options){
  checkFrame(frame);
  const {playerId,sourceHeroId,heroId,skinId}=options,tag=frame.readUInt16LE(8),out=Buffer.from(frame);
  if(tag===23439||tag===23437){
    const length=tag===23439?20:19,heroAt=tag===23439?18:16;
    if(frame.length!==length)throw Error('Unsupported hero selection frame');
    if(frame.readUInt32LE(12)===playerId&&frame.readUInt16LE(heroAt)===sourceHeroId)
      out.writeUInt16LE(heroId,heroAt);
  }else if(tag===1328){
    if(frame.readUInt32LE(4)!==playerId)return out;
    if(frame.length!==19)throw Error('Unsupported local hero transform');
    if(frame.readUInt16LE(12)===sourceHeroId){
      out.writeUInt16LE(heroId,12);out.writeUInt8(skinId,14);
    }
    // frame+15 dword is copied to native profile+a8; its meaning is unknown.
  }else if(tag===23512){
    if(frame.length<25)throw Error('Unsupported hero cache frame');
    if(frame.readUInt32LE(12)===playerId&&frame.readUInt16LE(16)===sourceHeroId){
      // MSG_S2C_PLAYERCACHE has a fixed 15-byte name field. Rebound short
      // names terminate before the final byte and retain the native padding.
      if(frame.length!==39||frame[38]!==0)throw Error('Unsupported hero cache name layout');
      out.writeUInt16LE(heroId,16);out.writeUInt16LE(skinId,18);
    }
  }else if(tag===23444){
    const row=identity.row(frame,playerId);
    if(row&&frame.readUInt16LE(row.offset+12)===sourceHeroId){
      out.writeUInt16LE(heroId,row.offset+12);out.writeUInt16LE(skinId,row.offset+14);
    }
  }else if(tag===11007){
    const fields=resetFields(frame,playerId,sourceHeroId);
    if(fields){
      const bytes=P.encode(P.set(P.set(fields,3,heroId),11,skinId));
      if(bytes.length>255)throw Error('Hero bootstrap reset too long');
      return W.frame(tag,playerId,Buffer.concat([Buffer.from([bytes.length]),bytes]),frame.readUInt16LE(10));
    }
  }
  return out;
}
// Call only for the accepted selection/loading segment, after actor identity
// rebinding and before saved appearance. This codec does not authorize a hero,
// install gameplay, initialize QWER, or rebuild its attributes/parameters.
function patch(frame,options){
  checkFrame(frame);const selected=optionsFor(options);
  return W.transform(frame,part=>rewrite(part,selected));
}
function statusReset({id,heroId,skinId=0}={}){
  optionsFor({playerId:id,sourceHeroId:heroId,heroId,skinId});
  const bytes=P.encode([{number:3,wire:0,value:BigInt(heroId)},
    {number:10,wire:0,value:1n},{number:11,wire:0,value:BigInt(skinId)}]);
  return W.frame(11007,id,Buffer.concat([Buffer.from([bytes.length]),bytes]));
}
module.exports={patch,resetFields,statusReset};
