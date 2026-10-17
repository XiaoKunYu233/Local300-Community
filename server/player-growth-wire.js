'use strict';
const crypto=require('node:crypto'),role=require('./roledata');
// Role frame +34 copied to object +0x80; c23c54 reads u16 at
// object +0xad => frame +79. e45ca0 passes cached level to SetHeroInfo.
function validate(state,account){
  if(!state||state.version!==1||!Number.isInteger(state.level)||state.level<1||state.level>300||
    !Number.isSafeInteger(state.observedAt)||state.observedAt<0)throw Error('Invalid player growth baseline');
  if(state.experience!==undefined&&(!Number.isInteger(state.experience)||state.experience<0||state.experience>0x7fffffff))throw Error('Invalid player experience');
  if(/^development-growth:/.test(state.source)){
    if(!account)throw Error('Development growth requires account receipt');
    require('./player-growth-development').validateGrowth(state,account);
  }else if(/^item-growth:/.test(state.source)){
    if(!account)throw Error('Item growth requires account receipt');
    require('./public-beta/item-growth').validateGrowth(state,account);
  }else if(/^(?:native-new-account|local-reference-template):/.test(state.source))require('./public-beta/native-seed').validateBaseline(state,account,'growth');
  else if(!/^capture-role:[a-f0-9]{64}$/.test(state.source))throw Error('Invalid player growth baseline');
  return state;
}
function identity(blob,account){
  if(!Buffer.isBuffer(blob)||blob.length<=Math.max(80,role.UID_OFF+3,role.PLAYERID_OFF+3)||blob.readUInt16LE(8)!==1013||blob.readUInt32LE(role.UID_OFF)!==account.uid||blob.readUInt32LE(role.PLAYERID_OFF)!==account.playerId)throw Error('Player growth role identity mismatch');
}
function fromRole(blob,account,observedAt){
  identity(blob,account);
  if(blob.length<141)throw Error('Player experience role truncated');
  // a977bf -> c1d580 copies signed frame+0x89 into role object+0x40.
  // c1d590 returns that cache for SetHeroInfo.currentExp.
  return validate({version:1,level:blob.readUInt16LE(79),experience:blob.readInt32LE(137),observedAt,source:'capture-role:'+crypto.createHash('sha256').update(blob).digest('hex')});
}
function patchRole(blob,account){
  identity(blob,account);if(account.growth===undefined)return blob;
  const growth=validate(account.growth,account),out=Buffer.from(blob);out.writeUInt16LE(growth.level,79);
  if(growth.experience!==undefined){if(out.length<141)throw Error('Player experience role truncated');out.writeInt32LE(growth.experience,137);}
  return out;
}
// bce409 checks 0x415 (1045), bce419 calls bfed50; bfee26 forwards
// each five-byte attribute to bf6880. Attribute 111 calls c1d580.
// bf6d30 writes attribute 110 to object+0x46be0+110*4 = +0x46d98
// (the level cache); bf7715 also updates +0x48 and the level UI.
function patchAttributes(frame,account){
  if(!Buffer.isBuffer(frame)||frame.length<13||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==1045||frame.length!==13+frame[12]*5)throw Error('Invalid growth attribute frame');
  if(frame.readUInt32LE(4)!==account.playerId)return frame;
  if(account.growth!==undefined)validate(account.growth,account);
  const rows=[];let changed=false;
  for(let i=0;i<frame[12];i++){
    const row=Buffer.from(frame.subarray(13+i*5,18+i*5));
    if(row[0]===110){changed=true;if(account.growth===undefined)continue;row.writeUInt32LE(account.growth.level,1);}
    if(row[0]===111){changed=true;if(account.growth?.experience===undefined)continue;row.writeInt32LE(account.growth.experience,1);}
    rows.push(row);
  }
  if(!changed)return frame;if(!rows.length)return null;
  const out=Buffer.concat([frame.subarray(0,12),Buffer.from([rows.length]),...rows]);out.writeUInt32LE(out.length);return out;
}
// Offline capture import only. A push is an absolute observation, never XP to add.
function importAttributes(frame,account,observedAt){
  if(/^(development-growth|item-growth):/.test(account.growth?.source||''))throw Error('Captured growth cannot replace a local development receipt');
  if(frame.readUInt32LE(4)!==account.playerId)return null;
  if(frame.length<13||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==1045||frame.length!==13+frame[12]*5)throw Error('Invalid growth attribute frame');
  const fields={};
  for(let i=0;i<frame[12];i++){
    const id=frame[13+i*5];if(id===110)fields.level=frame.readUInt32LE(14+i*5);if(id===111)fields.experience=frame.readInt32LE(14+i*5);
  }
  if(!Object.keys(fields).length)return null;
  // Startup repeats the role baseline before the first clock. It adds no new
  // observation; accept only exact agreement there, never an un-timed change.
  if(observedAt===null&&Object.entries(fields).every(([key,value])=>account.growth[key]===value))return null;
  if(!Number.isSafeInteger(observedAt)||observedAt<0)throw Error('Growth observation has no preceding server time');
  if(observedAt<account.growth.observedAt)throw Error('Growth observation time moved backwards');
  const next=validate({...account.growth,...fields,observedAt});
  account.growth=next;
  return {observedAt,playerId:account.playerId,sha256:crypto.createHash('sha256').update(frame).digest('hex'),fields};
}
module.exports={validate,fromRole,patchRole,patchAttributes,importAttributes};
