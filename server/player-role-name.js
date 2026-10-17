'use strict';
// Current account name in the native 1013 role cache. Identity remains exact;
// only its established 15-byte GBK/NUL name field is replaced.
const role=require('./roledata'),{nameBytes}=require('./player-battle-identity');
function patchRole(blob,account){
  if(!Buffer.isBuffer(blob)||blob.length<role.NAME_OFF+15||blob.readUInt16LE(8)!==1013||
    !account||blob.readUInt32LE(role.UID_OFF)!==account.uid||blob.readUInt32LE(role.PLAYERID_OFF)!==account.playerId)
    throw Error('Player name role identity mismatch');
  const bytes=nameBytes(account.name),out=Buffer.from(blob);out.fill(0,role.NAME_OFF,role.NAME_OFF+15);bytes.copy(out,role.NAME_OFF);return out;
}
module.exports={patchRole};
