'use strict';
// Original match-003: 8026 at the caster, 8027/8028 at the landing point.
// Stationary type-13 objects, with fresh actor IDs and current caster ownership.
const W=require('./battle-wire'),N=require('./battle-native'),SN=require('./summoner-native');
function spawn(id,caster,point,bullet,team){
 if(!Number.isInteger(id)||id<1||id>0xffffffff||!Number.isInteger(caster?.id)||![1,2].includes(team)||![8026,8027,8028].includes(bullet)||
  ![point?.x,point?.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35))throw Error('Invalid teleport visual');
 const p=Buffer.alloc(30);p.writeUInt16LE(13);p.writeUInt16LE(1,2);
 p.writeUInt16LE(Math.round(point.x*100),5);p.writeUInt16LE(Math.round(point.z*100),7);p[10]=100;
 p.writeUInt16LE(bullet,13);p[19]=team;p.writeUInt16LE(8026,21);p.writeUInt32LE(caster.id,23);p[27]=1;
 return W.frame(1050,id,p);
}
class TeleportNative {
 constructor(allocate){this.allocate=allocate;this.active=new Map();}
 clear(){const packets=[...this.active.values()].flatMap(row=>row.ids.map(N.remove));this.active.clear();return packets;}
 sync(sim){
  const packets=[];
  for(const [id,row]of this.active){
   const e=sim?.entities.get(id);
   if(row.sim!==sim||e!==row.caster||!e?.alive||sim.heroes?.closed||e.channel!==row.channel||e.channel?.endsAt<=sim.time+1e-9||(e.reviveCount||0)!==row.life){
    packets.push(...row.ids.map(N.remove));this.active.delete(id);
   }
  }
  if(!sim||sim.heroes?.closed)return packets;
  for(const e of sim.entities.values())if(e.kind==='hero'&&e.alive&&e.channel?.skillId===8026&&e.channel.endsAt>sim.time+1e-9&&!this.active.has(e.id)){
   const ids=[this.allocate(),this.allocate(),this.allocate()],channel=e.channel;
   packets.push(spawn(ids[0],e,e,8026,e.team),spawn(ids[1],e,channel.aim,8027,e.team),spawn(ids[2],e,channel.aim,8028,3-e.team));
   for(const id of ids.slice(1))packets.push(SN.statusPacket({id},18026,channel.endsAt,sim.time,{sourceActor:e}));
   this.active.set(e.id,{sim,caster:e,channel,life:e.reviveCount||0,ids});
  }
  return packets;
 }
}
module.exports={spawn,TeleportNative};
