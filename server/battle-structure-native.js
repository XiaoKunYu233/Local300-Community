'use strict';
// Dedicated installed tower range presentation; it does not change combat.
// NPC status sources use profession 0xffffffff and MonsterID in field 11,
// as observed in original map-252 50086 packets. No hero skin is substituted.
const W=require('./battle-wire'),P=require('./battle-protobuf');
const state=new WeakMap(),attributes=new WeakMap(),scopes=new WeakMap();let nextScope=0;
const reviewed=Object.freeze({statusId:50088,levels:Object.freeze({
  1:Object.freeze({name:'防御塔攻击范围',effect:'common\\xinhaobiaoji\\tx_common_paotabiaoji_01.ini'}),
  2:Object.freeze({name:'防御塔攻击范围-红',effect:'common\\xinhaobiaoji\\tx_common_paotabiaoji_02.ini'})
})});
const validTower=e=>e?.kind==='tower'&&Number.isSafeInteger(e.id)&&e.id>0&&e.id<=0xffffffff&&
  Number.isSafeInteger(e.monsterId)&&e.monsterId>=25231&&e.monsterId<=25250&&[1,2].includes(e.team);
function encode(tower,level,{remove=false}={}){
 if(!validTower(tower)||![1,2].includes(level))throw Error('Invalid native tower range');
 const f=(number,value)=>({number,wire:0,value:BigInt(value)});
 const fields=[f(2,tower.id),f(3,0xffffffff),f(5,reviewed.statusId),f(6,level)];
 if(remove)fields.push(f(7,3));
 fields.push(f(10,1),f(11,tower.monsterId));
 const body=P.encode(fields);return W.frame(11007,tower.id,Buffer.concat([Buffer.from([body.length]),body]));
}
function entries(sim,tower,{viewerId,enabled=true}={}){
 const viewer=sim?.entities?.get(viewerId);
 if(!enabled||sim?.mapId!==252||sim.battlefield!==true||sim.heroes?.closed||!validTower(tower)||
    sim.entities.get(tower.id)!==tower||!tower.alive||tower.targetable===false||
    !viewer||viewer.kind!=='hero'||![1,2].includes(viewer.team))return [];
 // Installed dedicated tower asset at its native scale. Geometry alignment
 // remains a client visual acceptance item; do not alter global effect scale.
 return [{statusId:reviewed.statusId,level:tower.team!==viewer.team?2:1}];
}
function syncRangeEffect(sim,tower,{viewerId,force=false,enabled=true}={}){
 if(!validTower(tower))return [];
 if(!scopes.has(sim))scopes.set(sim,++nextScope);
 const scope=scopes.get(sim),life=tower.reviveCount||0,next=entries(sim,tower,{viewerId,enabled})[0]||null;
 const old=state.get(tower),same=old?.scope===scope&&old.life===life;
 const packets=[];
 if(!force&&same&&old.level&&old.level!==next?.level)packets.push(encode(tower,old.level,{remove:true}));
 if(next&&(force||!same||old?.level!==next.level))packets.push(encode(tower,next.level));
 state.set(tower,{scope,life,level:next?.level||0});return packets;
}
function attributePacket(tower){
 if(!validTower(tower)||!Number.isFinite(tower.range)||tower.range<0||tower.range>655.35)throw Error('Invalid authoritative tower range');
 const body=Buffer.alloc(6);body[0]=1;body[1]=16;body.writeUInt32LE(Math.round(tower.range*100),2);return W.frame(1045,tower.id,body);
}
function sync(sim,tower,{force=false}={}){
 if(sim?.mapId!==252||sim.battlefield!==true||sim.heroes?.closed||!validTower(tower)||sim.entities.get(tower.id)!==tower||!tower.alive)return [];
 const range=Math.round(tower.range*100),old=attributes.get(tower);
 if(!force&&old?.sim===sim&&old.life===(tower.reviveCount||0)&&old.range===range)return [];
 const packet=attributePacket(tower);attributes.set(tower,{sim,life:tower.reviveCount||0,range});return[packet];
}
module.exports={reviewed,validTower,entries,encode,syncRangeEffect,attributePacket,sync};
