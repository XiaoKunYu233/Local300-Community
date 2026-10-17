'use strict';
const W=require('./battle-wire');
// 11043 UPDATECOLDDOWNSTATE is a shared four-slot notification, not a cast
// or a learn request. The verified 11006 reply carries the player in its body.
function cooldownState(playerId,command){
  if(!Number.isInteger(playerId)||playerId<1||playerId>0xffffffff||
    command?.tag!==11043||command.type!=='slot'||
    !Number.isInteger(command.action)||command.action<0||command.action>1||
    !Number.isInteger(command.slot)||command.slot<1||command.slot>4)return null;
  const payload=Buffer.alloc(6);payload.writeUInt32LE(playerId);payload[4]=command.action;payload[5]=command.slot;
  return W.frame(11006,0,payload);
}
module.exports={cooldownState};
