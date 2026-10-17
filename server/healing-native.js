'use strict';
const W=require('./battle-wire');
const skills=new Map(require('../data/current-client/skill_skilllevel.json').map(row=>[`${row[1]}:${row[2]}`,row]));

// MSG_SKILL_S2C_SHOWDAMAGE also carries native healing text. At b8bafd the
// client branches on signed amount<0, negates it and renders style 6. This
// comes before the ordinary damage-type table: healing needs no invented type.
// Original healing samples have actor/source/type/critical all zero.
function showHeal(event){
  if(!event||event.silent||!Number.isInteger(event.id)||event.id<=0||event.id>0xffffffff||
    !Number.isFinite(event.amount)||event.amount<1)return null;
  const amount=Math.min(0x7fffffff,Math.floor(event.amount));
  // bf7eec skips ALL text at level 0. Preserve the originating real skill
  // where configured; unbound healing uses the known basic row for text only.
  const configured=skills.has(`${event.skillId}:${event.skillLevel||1}`);
  const skillId=configured?event.skillId:2841,skillLevel=configured?(event.skillLevel||1):1;
  const p=Buffer.alloc(20);p.writeUInt32LE(event.id,4);p.writeInt32LE(-amount,9);
  p.writeUInt16LE(skillId,13);p[15]=skillLevel;
  return W.frame(11044,0,p);
}
module.exports={showHeal,healPacket:showHeal};
