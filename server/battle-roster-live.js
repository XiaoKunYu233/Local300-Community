'use strict';
const W=require('./battle-wire');
const entered=e=>e.kind==='hero'&&(!e.battleBot||e.bot?.entered);
function registrations(sim){
 const heroes=[...sim.entities.values()].filter(e=>e.kind==='hero'),counts={1:0,2:0};
 for(const e of heroes)if(![1,2].includes(e.team)||++counts[e.team]>7)throw Error('Battle supports at most seven heroes per team');
 return heroes;
}
const participants=sim=>registrations(sim).filter(entered);
const accountUid=e=>e.accountUid??e.savedAppearance?.uid??0;
const name=e=>(e.nameBytes||require('./gbk').encode(e.name||'玩家')).subarray(0,14);
const details=(sim,e,viewerId)=>e.team===sim.entities.get(viewerId)?.team||sim.vision?.visibleToTeam(e,sim.entities.get(viewerId)?.team)===true;
// c527 65c670: new actors announce entry; existing actors update cache only.
function join(e,{visible=false}={}){
 const p=Buffer.alloc(77);p[0]=e.team-1;name(e).copy(p,1);
 p.writeUInt32LE(accountUid(e),16);p.writeUInt32LE(e.worldGuid||0,20);p.writeUInt16LE(e.heroId||0,24);
 if(visible){
  p.writeUInt16LE(e.level||1,26);p.writeUInt16LE(e.skills?.D?.id||0,28);p.writeUInt16LE(e.skills?.F?.id||0,30);
  for(const item of e.loadout?.slots||[])if(item.slot>=0&&item.slot<6)p.writeUInt16LE(item.itemId,36+2*item.slot);
 }
 return W.frame(23480,e.id,p);
}
// MSG_S2C_PLAYERCACHE is fixed 39 bytes (c527 1156c12), including a
// 15-byte NUL-padded name. Short names must not shorten the native structure.
function identity(e){const p=Buffer.alloc(27);p.writeUInt32LE(e.id);p.writeUInt16LE(e.heroId||0,4);p.writeUInt16LE(e.skinId||0,6);p.writeUInt32LE(e.team,8);name(e).copy(p,12);return W.frame(23512,0,p);}
function roster(template,sim,viewerId=sim.playerId,{knownDetails}={}){
 if(template.readUInt16LE(8)!==23444||template.length!==175292)throw Error('Invalid native roster template');
 const out=Buffer.alloc(template.length);template.copy(out,0,0,12);const counts={1:0,2:0},heroes=registrations(sim),active=heroes.filter(entered);
 // Original 002/003 rosters reserve late entrants from loading with hero=0
 // and level=1. Their 23480 then updates an existing valid native record.
 // Reserve only this world's planned actors, never captured participants.
 for(const e of heroes){
  const o=12+((e.team-1)*30+counts[e.team]++)*146;
  name(e).copy(out,o);out.writeUInt32LE(e.id,o+15);out.writeUInt32LE(accountUid(e),o+19);out.writeUInt32LE(e.worldGuid||0,o+23);
  if(!entered(e)){out.writeUInt16LE(1,o+31);continue;}
  out.writeUInt16LE(e.heroId||0,o+27);out.writeUInt16LE(e.skinId||0,o+29);
  // c527 65dde0 copies frame+0x86 to cache+0x78, whose meaning is unverified.
  // All 28 original rows leave it zero. Display side comes from array group.
  const stats=sim.matchStats?.players.get(e.id),u16=v=>Math.min(65535,Math.max(0,Math.floor(v||0)));
  out.writeUInt16LE(u16(stats?.heroKills),o+33);out.writeUInt16LE(u16(stats?.heroDeaths),o+37);
  out.writeUInt16LE(u16(stats?.heroAssists),o+41);out.writeUInt16LE(u16(stats?.minionLastHits),o+45);
  const cached=knownDetails?.get(e.id);
  if(cached){
   cached.copy(out,o+31,38,40);cached.copy(out,o+53,40,44);cached.copy(out,o+61,48,60);
  }
  if(details(sim,e,viewerId)){
   out.writeUInt16LE(e.level||1,o+31);out.writeUInt16LE(e.skills?.D?.id||0,o+53);out.writeUInt16LE(e.skills?.F?.id||0,o+55);
   for(const item of e.loadout?.slots||[])if(item.slot>=0&&item.slot<6)out.writeUInt16LE(item.itemId,o+61+item.slot*2);
  }
 }
 // Native 65e2d2 loads these into the same team-kill state used by 23446.
 // Match 002 starts 0:3 and the subsequent 23446 updates that side to 4,5,... .
 for(const team of [1,2]){
  const kills=active.filter(e=>e.team===team).reduce((sum,e)=>sum+(sim.matchStats?.players.get(e.id)?.heroKills||0),0);
  out.writeUInt16LE(Math.min(65535,Math.max(0,Math.floor(kills))),0x2ac6c+(team-1)*2);
 }
 return out;
}
function frames(frames,sim,viewerId=sim.playerId){
 const ids=new Set(participants(sim).map(e=>e.id));
 return frames.map(f=>W.transform(f,a=>{
  const tag=a.readUInt16LE(8);if(tag===23444)return roster(a,sim,viewerId);
  if([23435,23505,23560].includes(tag))return require('./battle-loading-roster').frame(a,sim);
  if([23447,23480].includes(tag))return null;
  if(tag===23512)return ids.has(a.readUInt32LE(12))?identity(sim.entities.get(a.readUInt32LE(12))):null;
  return a;
 })).filter(Boolean);
}
module.exports={roster,frames,participants,registrations,entered,details,join,identity};
