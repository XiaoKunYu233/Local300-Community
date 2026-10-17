'use strict';
const crypto=require('node:crypto'),role=require('./roledata');
// a978ad passes frame+34; c23680 copies it to role object+80.
// c23bdf reads object+158 => inflated 1013 offset 250, a single byte.
function validate(state,account){
  if(state?.version!==1||!Number.isInteger(state.level)||state.level<0||state.level>12||
    !Number.isSafeInteger(state.observedAt)||state.observedAt<0)throw Error('Invalid VIP state');
  if(/^development-recharge:/.test(state.source)){
    if(!account)throw Error('Development VIP state requires account receipt');
    require('./player-recharge').validateVip(state,account);
  }else if(/^(?:native-new-account|local-reference-template):/.test(state.source))require('./public-beta/native-seed').validateBaseline(state,account,'vip');
  else if(!/^capture-role:[a-f0-9]{64}$/.test(state.source))throw Error('Invalid VIP state');
  return state;
}
function fromRole(blob,account,observedAt){
  if(!Buffer.isBuffer(blob)||blob.length<=250||blob.readUInt16LE(8)!==1013||blob.readUInt32LE(role.UID_OFF)!==account.uid||blob.readUInt32LE(role.PLAYERID_OFF)!==account.playerId)throw Error('VIP role identity mismatch');
  return validate({version:1,level:blob[250],observedAt,source:'capture-role:'+crypto.createHash('sha256').update(blob).digest('hex')});
}
function patchRole(blob,account){
  if(!Buffer.isBuffer(blob)||blob.length<=250||blob.readUInt16LE(8)!==1013||blob.readUInt32LE(role.UID_OFF)!==account.uid||blob.readUInt32LE(role.PLAYERID_OFF)!==account.playerId)throw Error('VIP role identity mismatch');
  if(account.vip===undefined)return blob;
  const state=validate(account.vip,account),out=Buffer.from(blob);out[250]=state.level;return out;
}
// Current native client c527ae...: 1045 -> bfed50 -> bf6880 stores
// attribute89 in role object +0x46be0+89*4 = +0x46d44. XGetPlayerVip
// (14a0fa0) reads that exact cache; branch bf757c refreshes VIP widgets.
// This updates the level without reinitializing the 288KB role/inventory.
function levelFrame(account){
  if(account.vip===undefined)return null;
  const state=validate(account.vip,account),payload=Buffer.alloc(6);payload[0]=1;payload[1]=89;payload.writeUInt32LE(state.level,2);
  return require('./bag').mkFrame(1045,payload,{stream:account.playerId,flags:0xd3});
}
function patchAttributes(frame,account){
  if(!Buffer.isBuffer(frame)||frame.length<13||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==1045||frame.length!==13+frame[12]*5)throw Error('Invalid VIP attribute frame');
  if(frame.readUInt32LE(4)!==account.playerId)return frame;
  const rows=[];let changed=false;
  for(let i=0;i<frame[12];i++){
    const row=Buffer.from(frame.subarray(13+i*5,18+i*5));
    if(row[0]===89){changed=true;if(account.vip===undefined)continue;row.writeUInt32LE(validate(account.vip,account).level,1);}
    rows.push(row);
  }
  if(!changed)return frame;if(!rows.length)return null;
  const out=Buffer.concat([frame.subarray(0,12),Buffer.from([rows.length]),...rows]);out.writeUInt32LE(out.length);return out;
}
// Native dispatch bcee54 -> bb6b30: 1439 payload u32 is passed to
// GetPlayerCurGoldPoint, whose Lua display divides by 100.
function recharge(frame,attrs){
  if(!Buffer.isBuffer(frame)||frame.length!==16||frame.readUInt32LE(0)!==16||frame.readUInt16LE(8)!==1439)throw Error('Invalid VIP recharge frame');
  const value=attrs?.[91];if(value===undefined)return null;
  if(!Number.isInteger(value)||value<0||value>0xffffffff)throw Error('Invalid cumulative recharge amount');
  const out=Buffer.from(frame);out.writeUInt32LE(value,12);return out;
}
// XReqGetVipFirstGift(0), 14b778f: query. Confirmation callback
// 1463ef0: claim. Both send 11541, 16 bytes, u32 action at +12.
function firstGiftRequest(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==16||frame.readUInt32LE(0)!==16||frame.readUInt16LE(8)!==11541)throw Error('Invalid first recharge gift request');
  const action=frame.readUInt32LE(12);
  if(action!==0&&action!==1)throw Error('Invalid first recharge gift action');
  return action===0?'query':'claim';
}
// bd671c dispatches (11542 - 0x2cf2) through bef6c0/bef5a0 to bda6cd.
// That handler treats 0xffffffff as -1, all other values as unsigned.
// Lua SetIsCanGetVipFirstGift divides the amount by 100 for tier display.
function firstGiftReply(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==16||frame.readUInt32LE(0)!==16||frame.readUInt16LE(8)!==11542)throw Error('Invalid first recharge gift reply');
  const value=frame.readUInt32LE(12);
  if(value===0xffffffff)return {status:'claimed',amountMinor:null};
  return {status:value===0?'unavailable':'claimable',amountMinor:value};
}
module.exports={recharge,fromRole,validate,patchRole,levelFrame,patchAttributes,firstGiftRequest,firstGiftReply};
