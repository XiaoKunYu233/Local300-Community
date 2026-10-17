'use strict';
// 23440 is skin-index only. The authenticated selected hero is caller context.
const W=require('./battle-wire'),heroes=require('./player-heroes'),{owns}=require('./player-account-state');
const uint=value=>Number.isInteger(value)&&value>0&&value<=0xffffffff;
const skin=value=>Number.isInteger(value)&&value>=0&&value<32;
const clock=value=>Number.isSafeInteger(value)&&value>=0;
function request(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==14||frame.readUInt32LE(0)!==14||frame.readUInt32LE(4)!==0||
    frame.readUInt16LE(8)!==23440||frame.readUInt16LE(10)!==0||!skin(frame.readUInt16LE(12)))throw Error('Invalid native battle skin request');
  return {skinId:frame.readUInt16LE(12)};
}
function eligible(account,heroId,skinId,now){
  if(!account||!uint(account.uid)||!uint(account.playerId)||!Number.isInteger(heroId)||heroId<1||heroId>65535||!skin(skinId)||!clock(now))
    throw Error('Invalid battle skin selection identity');
  if(!owns(account,'heroes',heroId,now))throw Error('Battle skin hero is not owned or has expired');
  if(skinId&&!owns(account,'skins',heroes.skinKey(heroId,skinId),now))throw Object.assign(Error('Battle skin is not owned or has expired'),{code:'BATTLE_SKIN_NOT_OWNED'});
}
function prepare(account,frame,context,now=Date.now()){
  const selection=request(frame);
  if(!context||context.authenticated!==true||context.available!==true||!['selecting','preparing'].includes(context.phase)||
    context.uid!==account?.uid||context.playerId!==account?.playerId||!Number.isSafeInteger(account?.revision)||account.revision<0)
    throw Error('Battle skin requires an available authenticated account before loading');
  eligible(account,context.heroId,selection.skinId,now);
  return {version:1,uid:account.uid,playerId:account.playerId,heroId:context.heroId,skinId:selection.skinId,expectedRevision:account.revision,preparedAt:now};
}
function apply(account,prepared,now=Date.now()){
  if(!prepared||prepared.version!==1||prepared.uid!==account?.uid||prepared.playerId!==account?.playerId||
    !Number.isSafeInteger(prepared.expectedRevision)||prepared.expectedRevision!==account.revision||
    !clock(prepared.preparedAt)||!clock(now)||now<prepared.preparedAt)throw Error('Battle skin draft revision or identity mismatch');
  eligible(account,prepared.heroId,prepared.skinId,now);
  const payload=Buffer.alloc(8);payload.writeUInt32LE(prepared.heroId);payload.writeUInt32LE(prepared.skinId,4);
  heroes.selectSkin(account,payload,now);return {heroId:prepared.heroId,skinId:prepared.skinId};
}
function decodeNotice(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==17||frame.readUInt32LE(0)!==17||frame.readUInt32LE(4)!==0||
    frame.readUInt16LE(8)!==23499||frame.readUInt16LE(10)!==0)throw Error('Invalid native battle skin notice');
  const mask=frame.readUInt32LE(12),skinId=frame[16];
  if(!(mask&1)||!skin(skinId)||!((mask>>>skinId)&1))throw Error('Battle skin notice has an unavailable choice');
  return {mask,skinId};
}
function notice(account,heroId,now=Date.now()){
  eligible(account,heroId,0,now);
  const mask=heroes.skinMask(account,heroId,now),skinId=require('./player-battle-appearance').selectedSkin(account,heroId,now);
  const payload=Buffer.alloc(5);payload.writeUInt32LE(mask);payload[4]=skinId;
  const frame=W.frame(23499,0,payload,0);decodeNotice(frame);return frame;
}
function patchLoading(frames,{playerId,heroId,skinId}={}){
  if(!Array.isArray(frames)||!uint(playerId)||!Number.isInteger(heroId)||heroId<1||heroId>65535||!skin(skinId))
    throw Error('Invalid battle loading skin identity');
  return frames.map(frame=>W.transform(frame,part=>{
    const tag=part.readUInt16LE(8),local=part.readUInt32LE(4)===playerId;
    if(tag===1327){
      if(part.length!==1015||part.readUInt32LE(4)!==0||part.readUInt16LE(12)!==heroId)throw Error('Unexpected implicit local skin transform');
      const out=Buffer.from(part);out[14]=skinId;return out;
    }
    if(tag===1328&&local){
      if(part.length!==19||part.readUInt16LE(12)!==heroId)throw Error('Unexpected own skin transform notification');
      const out=Buffer.from(part);out[14]=skinId;return out;
    }
    return Buffer.from(part);
  }));
}
module.exports={request,prepare,apply,notice,decodeNotice,patchLoading};
