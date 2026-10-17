'use strict';
const P=require('./battle-protobuf'),W=require('./battle-wire');
const catalog=new Map(require('../data/current-client/skill_statuslist.json').map(row=>[`${row[1]}:${row[2]}`,row]));
const synchronized=new WeakMap();
const val=(number,value)=>({number,wire:0,value:BigInt(value)});
const IDS=Object.freeze({guard:16146,guardWindow:16147});
for(const id of Object.values(IDS))if(!catalog.has(`${id}:2`))throw Error(`Missing equipment native status ${id}:2`);

function snapshot(sim,hero){
  const out=new Map(),g=hero?.guard,now=sim.time;
  if(!hero?.alive||hero.kind!=='hero'||!hero.heroId||!hero.passives?.dagger||!g||!(g.expires>now))return out;
  if(g.remaining>0||g.windowUntil>now)out.set(IDS.guard,{id:IDS.guard,level:2,until:g.expires});
  const window=Math.min(g.expires,g.windowUntil||0);
  if(window>now)out.set(IDS.guardWindow,{id:IDS.guardWindow,level:2,until:window});
  return out;
}
function statusPacket(hero,entry,now,{remove=false}={}){
  if(!catalog.has(`${entry.id}:${entry.level}`))throw Error('Unknown equipment native status');
  // Existing verified native 11007 add/remove format, same shape as the other
  // native status adapters. Current client's skill 6146 is NOT status 6146.
  const fields=[...(remove?[]:[val(3,hero.heroId)]),val(5,entry.id),val(6,entry.level),
    ...(remove?[val(7,3)]:[val(9,Math.max(1,Math.round((entry.until-now)*1000)))]),
    val(10,1),val(11,hero.skinId??hero.skin??0)];
  const body=P.encode(fields);return W.frame(11007,hero.id,Buffer.concat([Buffer.from([body.length]),body]));
}
function sync(sim,hero,{force=false}={}){
  const next=snapshot(sim,hero),previous=synchronized.get(hero)||new Map(),packets=[];
  for(const [id,entry]of previous)if(!next.has(id))packets.push(statusPacket(hero,entry,sim.time,{remove:true}));
  for(const [id,entry]of next){const old=previous.get(id);
    if(force||!old||old.level!==entry.level||old.until!==entry.until)packets.push(statusPacket(hero,entry,sim.time));
  }
  synchronized.set(hero,next);return packets;
}
module.exports={IDS,catalog,snapshot,statusPacket,sync};
