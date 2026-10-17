'use strict';

// Project actual summoner state with current-match caster ownership. No capture
// bytes, timers, damage, statistics or account mutations belong to this module.
const S=require('./summoner-effects');
const fresh=require('./battle-progression-native-catalog');
const IDS=Object.freeze({reviveHP:18023,reviveTalent:58370,run:18070,potential:18030,
  cleanse:18082,arcane:18080,barrage:18034,sealMove:18058,sealControl:18059,
  shield:18075,shieldProtection:18076,teleportSelf:18027,teleportTarget:18026,
  blinkSlow:58375,weak:18025});
const selected=fresh.statuses.filter(r=>r[2]===1&&Object.values(IDS).includes(r[1]));
if(selected.length!==Object.keys(IDS).length)throw Error('Missing reviewed fresh summoner statuses');
// Retain the historical public read-only catalog surface for unrelated table
// duration diagnostics. Emitted summoner packets use only reviewed fresh rows.
const catalog=new Map(require('../data/current-client/skill_statuslist.json').filter(r=>r[2]===1).map(r=>[r[1],r]));
for(const row of selected)catalog.set(row[1],row);
const wire=require('./battle-status-native').create({statuses:selected,icons:fresh.icons,
  allowed:selected.map(r=>({statusId:r[1],level:1}))});
const metadata=new WeakMap();
const life=e=>e?.reviveCount||0;
const snapshot=source=>({sourceActor:source,sourceId:source.id,sourceHeroId:source.heroId,
  sourceSkinId:source.skinId??source.skin??0});
const sourceChanged=(before,after)=>before.sourceActor!==after.sourceActor||
  before.sourceId!==after.sourceId||before.sourceHeroId!==after.sourceHeroId||before.sourceSkinId!==after.sourceSkinId;
function statusPacket(target,status,expires,now,{remove=false,operation=remove?'remove':'add',sourceActor=target,
  sourceId=sourceActor.id,sourceHeroId=sourceActor.heroId,sourceSkinId=sourceActor.skinId??sourceActor.skin??0}={}){
  return wire.encode({targetId:target.id,statusId:status,level:1,sourceId,sourceHeroId,sourceSkinId,
    overlap:1,until:Number.isFinite(expires)?expires:Infinity},now,{operation});
}
function desired(sim,target){
  const out=new Map(),sources=new Map();
  metadata.set(out,{sim,target,targetLife:life(target),sources});
  if(!sim||sim.heroes?.closed||!target?.alive||sim.entities?.get(target.id)!==target)return out;
  const actualSource=row=>S.nativeSource?.(row)||target;
  const add=(id,expires,source)=>{
    if(!(expires>sim.time+1e-9)||!source||source.kind!=='hero'||
      sim.entities.get(source.id)!==source||!Number.isInteger(source.heroId)||source.heroId<1)return;
    const old=out.get(id),prior=sources.get(id);
    // A native removal selects by status ID. If multiple genuine casters have
    // this status, display its longest active expiry, with deterministic ties.
    if(old===undefined||expires>old||expires===old&&source.id<prior.sourceId){
      out.set(id,expires);sources.set(id,snapshot(source));
    }
  };
  for(const row of target.summonerState?.effects||[]){
    if(!(row.expires>sim.time+1e-9))continue;
    const source=actualSource(row);
    if(row.kind==='revive-hp')add(IDS.reviveHP,row.expires,source);
    if(row.kind==='revive-talent')add(IDS.reviveTalent,row.expires,source);
    if(row.kind==='run'&&row.skillId===8028)add(IDS.run,row.expires,source);
    if(row.kind==='potential')add(IDS.potential,row.expires,source);
    if(row.kind==='cleanse')add(IDS.cleanse,row.expires,source);
    if(row.kind==='arcane')add(IDS.arcane,row.expires,source);
    if(row.kind==='barrage-mark')add(IDS.barrage,row.expires,source);
    if(row.kind==='seal'){add(IDS.sealMove,row.expires,source);add(IDS.sealControl,Math.min(row.expires,row.start+.75),source);}
    if(row.kind==='blink-slow')add(IDS.blinkSlow,row.expires,source);
    if(row.kind==='weak')add(IDS.weak,row.expires,source);
  }
  const state=target.summonerState,shield=state?.shield;
  if(shield?.remaining>0)add(IDS.shield,shield.expires,actualSource(shield));
  add(IDS.shieldProtection,state?.guardProtectedUntil||0,actualSource(state));
  if(target.channel?.skillId===8026)add(IDS.teleportSelf,target.channel.endsAt,target);
  for(const source of sim.entities.values())if(source.alive&&source.channel?.skillId===8026&&source.channel.anchorId===target.id)
    add(IDS.teleportTarget,source.channel.endsAt,source);
  return out;
}
function sync(sim,target,previous=new Map(),{force=false}={}){
  const next=desired(sim,target),nextMeta=metadata.get(next),packets=[];
  if(!sim||sim.heroes?.closed||!target||sim.entities?.get(target.id)!==target)return {packets,next};
  if(!(previous instanceof Map))throw Error('Invalid previous native summoner state');
  const beforeMeta=metadata.get(previous),sameScope=!beforeMeta||beforeMeta.sim===sim&&beforeMeta.target===target&&beforeMeta.targetLife===life(target);
  const before=sameScope?previous:new Map(),oldSources=beforeMeta?.sources;
  const oldSource=id=>oldSources?.get(id)||snapshot(target);
  const replacement=id=>before.has(id)&&next.has(id)&&(sourceChanged(oldSource(id),nextMeta.sources.get(id))||
    (before.get(id)===Infinity)!==(next.get(id)===Infinity));
  const send=(id,expires,operation,source)=>packets.push(statusPacket(target,id,expires,sim.time,{operation,...source}));
  // Removals keep the genuine source snapshot of this target/life's last
  // emitted state. A vanished caster never gets replaced with the target.
  for(const [id,expires]of before)if(!next.has(id)||replacement(id))send(id,expires,'remove',oldSource(id));
  for(const [id,expires]of next){
    if(!before.has(id)||replacement(id)||force)send(id,expires,'add',nextMeta.sources.get(id));
    else if(before.get(id)!==expires)send(id,expires,'update',nextMeta.sources.get(id));
  }
  return {packets,next};
}
module.exports={IDS,catalog,desired,statusPacket,sync};
