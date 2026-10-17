'use strict';
const W=require('./battle-wire');
const P=require('./battle-protobuf');
const statusRows=require('../data/current-client/skill_statuslist.json');
const statuses=new Map(statusRows.map(row=>[`${row[1]}:${row[2]}`,row]));
const synchronized=new WeakMap();
const val=(number,value)=>({number,wire:0,value:BigInt(value)});
const {cooldownState}=require('./skill-slot-native');

// Native 11043 is UPDATECOLDDOWNSTATE (action 0/1, slot 1..4),
// not a skill cast or a request to learn a skill. The captured server echoes
// the state through 11006 with player identity inside the payload (actor 0).
function statusPacket(hero,entry,now,{remove=false,skin=0}={}){
  if(!statuses.has(`${entry.id}:${entry.level}`))throw Error('Unknown BRS native status');
  // 11007 native add/update/remove shape is verified against all three
  // original native recordings; field 7=3 removes a specific instance.
  const fields=[...(remove?[]:[val(3,hero.heroId)]),val(5,entry.id),val(6,entry.level),
    ...(remove?[val(7,3)]:[]),
    ...(Number.isFinite(entry.until)?[val(9,Math.max(1,Math.round((entry.until-now)*1000)))]:[]),
    val(10,entry.instance||1),val(11,skin)];
  const body=P.encode(fields);return W.frame(11007,hero.id,Buffer.concat([Buffer.from([body.length]),body]));
}
function snapshot(sim,e){
  const out=new Map(),s=e.blackRock,now=sim.time;if(!s||!e.alive)return out;
  const add=(id,level=1,until=Infinity,instance=1)=>{if(until>now+1e-9)out.set(id,{id,level,until,instance});};
  // Every switch uses the normal client's own 51/52/53 replacement pair.
  if(s.modeChoice==='shooter')add(39738);
  if(s.classicGun){add(58438);add(58439);add(12848,s.levels.Q,s.classicSpeedUntil);}
  else if(s.qUntil>now){add(12848,s.levels.Q,s.qUntil);add(38526,1,s.qUntil);}
  if(s.shooter){add(39742);add(39744);add(39743);}
  if(s.blueUntil>now){add(12849,s.levels.W,s.blueUntil);add(12494,s.levels.W,s.blueUntil);}
  if(s.wSecondReady&&s.hearts>0)add(12855,1,s.wSecondUntil??s.blueUntil);
  if(s.forcedRemaining>0)add(12858,1,s.forcedUntil);
  if(s.penUntil>now)add(12499,s.levels.E,s.penUntil);
  if(s.r)add(s.r.next===2?39728:39729,1,s.r.expires);
  if(s.hearts>0){add(12853,1,Infinity,s.hearts);add(12861,1,Infinity,s.hearts);}
  return out;
}
function sync(sim,e,{force=false,skin=e.skinId??e.skin??0}={}){
  if(!e.blackRock)return [];
  const next=snapshot(sim,e),previous=synchronized.get(e)||new Map(),packets=[];
  // Remove old replacement before adding the next one (R2→R3, shooter mode).
  for(const [id,entry]of previous){const n=next.get(id);
    if(!n||n.level!==entry.level||n.instance!==entry.instance)packets.push(statusPacket(e,entry,sim.time,{remove:true,skin}));}
  for(const [id,entry]of next){const old=previous.get(id);
    if(force||!old||old.level!==entry.level||old.instance!==entry.instance||old.until!==entry.until)
      packets.push(statusPacket(e,entry,sim.time,{skin}));}
  synchronized.set(e,next);return packets;
}
module.exports={cooldownState,statusPacket,snapshot,sync};
