'use strict';
const W=require('./battle-wire'),N=require('./battle-native');
// Native 002/003: hero 16; outer 200; middle 300; gate 400; barracks 50.
// Inner towers were not destroyed in the available captures: 400 is a
// provisional server rule, not a recovered client or captured value.
const STRUCTURE_POINTS=Object.freeze({
  25231:200,25232:300,25233:400,25234:200,25235:300,25236:400,25237:200,25238:300,25239:400,25240:400,
  25241:200,25242:300,25243:400,25244:200,25245:300,25246:400,25247:200,25248:300,25249:400,25250:400,
  25251:50,25252:50,25253:50,25254:50,25255:50,25256:50,
});
const PROVISIONAL_INNER=Object.freeze([25233,25236,25239,25243,25246,25249]);
const cache=new WeakMap(),counters={heroAssists:0,minionLastHits:1,heroKills:2,heroDeaths:3};
const entered=e=>e?.kind==='hero'&&(!e.battleBot||e.bot?.entered);
function pointsFor(target){return target.kind==='hero'?16:target.kind==='tower'||target.kind==='barracks'?STRUCTURE_POINTS[target.monsterId]||0:0;}
function personal(actor,type,value=0){const p=Buffer.alloc(5);p[0]=type;p.writeUInt32LE(Math.max(0,Math.min(0xffffffff,Math.floor(value))),1);return W.frame(23445,actor,p);}
function sideKills(side,kills){const p=Buffer.alloc(6);p.writeUInt32LE(side-1);p.writeUInt16LE(Math.min(65535,kills),4);return W.frame(23446,0,p);}
function personalScore(actor,value=0){return personal(actor,7,Math.min(65535,value));}
// Current client e62105: map252 countdown = 886000 - elapsedWire - clientDelta.
// This server adapts that fixed 15-minute display to the user-requested 30m.
// Negative wire time's only static read is tower idle1, disabled by map252's
// nShowTowerIdle1=0. No installed client binary/resource is patched.
function timePacket(elapsedSeconds=0){
  if(!Number.isFinite(elapsedSeconds)||elapsedSeconds<0)throw Error('Invalid battle elapsed time');
  const p=Buffer.alloc(4);p.writeInt32LE(Math.round(Math.min(1800,elapsedSeconds)*1000)-914000);return W.frame(23458,0,p);
}
function sync(sim,{viewerId=sim.playerId,force=false}={}){
  const stats=sim.matchStats;if(!stats||stats.startedAt===null||stats.mapId!==252)return [];
  let viewers=cache.get(sim);if(!viewers){viewers=new Map();cache.set(sim,viewers);}
  let state=viewers.get(viewerId);if(!state){state={players:new Map(),side:null,kills:null,clockAt:-Infinity};viewers.set(viewerId,state);}
  const out=[],now=Math.max(0,sim.time-stats.startedAt),clock=force||now-state.clockAt>=5;
  for(const e of sim.entities.values()){
    if(!entered(e))continue;const p=stats.players.get(e.id);if(!p)continue;
    const old=state.players.get(e.id)||{};
    for(const [key,type] of Object.entries(counters)){
      const delta=Math.max(0,Math.min(65535,p[key]||0)-(old[key]||0));
      for(let i=0;i<delta;i++)out.push(personal(e.id,type));
    }
    if(force||clock||old.score!==p.score)out.push(personalScore(e.id,p.score));
    state.players.set(e.id,Object.fromEntries([...Object.keys(counters),'score'].map(k=>[k,Math.min(65535,p[k]||0)])));
  }
  const kills=[1,2].map(team=>[...stats.players.values()].filter(p=>p.team===team&&entered(sim.entities.get(p.playerId))).reduce((n,p)=>n+p.heroKills,0));
  if(force||!state.kills||kills.some((n,i)=>n!==state.kills[i])){for(let i=0;i<2;i++)out.push(sideKills(i+1,kills[i]));state.kills=kills;}
  const side=[stats.teamScores[1],stats.teamScores[2]];
  if(force||!state.side||side.some((n,i)=>n!==state.side[i])){out.push(N.syncSideScore(...side));state.side=side;}
  if(clock){out.push(timePacket(now));state.clockAt=now;}
  return out;
}
module.exports={sync,timePacket,personalScore,sideKills,pointsFor,STRUCTURE_POINTS,PROVISIONAL_INNER};
