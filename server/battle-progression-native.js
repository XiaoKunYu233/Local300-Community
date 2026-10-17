'use strict';
const effects=require('./battle-progression-effects');
const wire=require('./battle-status-native').create(require('./battle-progression-native-catalog'));
const previous=new WeakMap(),scopes=new WeakMap();let nextScope=0;
function scope(sim){if(!scopes.has(sim))scopes.set(sim,'progression:'+ ++nextScope);return scopes.get(sim);}
function entries(sim,hero){
  if(sim.heroes.closed||sim.entities.get(hero.id)!==hero||!hero.alive)return [];
  const grouped=new Map();
  for(const descriptor of effects.nativeStatuses(hero,sim.time)){
    const row=wire.catalog(descriptor.statusId,descriptor.level||1);
    if(!row)throw Error('Progression emitted an unreviewed native state: '+descriptor.statusId);
    const source=sim.entities.get(descriptor.sourceId??hero.id);
    if(!source||source.kind!=='hero'||!Number.isInteger(source.heroId)||source.heroId<1)continue;
    const entry={statusId:descriptor.statusId,level:descriptor.level||1,sourceId:source.id,
      sourceHeroId:source.heroId,sourceSkinId:source.skinId??source.skin??0,
      overlap:row.canOverlap?Math.max(1,Math.floor(descriptor.layers||1)):1,until:descriptor.until??Infinity};
    if(entry.until<=sim.time)continue;
    // The client removes by status ID. Show one deterministic owner for a
    // shared aura ID; the simulator retains each owner's actual effect.
    const old=grouped.get(entry.statusId);
    if(!old||entry.sourceId<old.sourceId)grouped.set(entry.statusId,entry);
  }
  return [...grouped.values()].sort((a,b)=>a.statusId-b.statusId);
}
function sync(sim,hero,{force=false}={}){
  if(hero.kind!=='hero'||sim.heroes.closed||sim.entities.get(hero.id)!==hero)return [];
  const result=wire.diff(force?null:previous.get(hero),{scope:scope(sim),life:hero.reviveCount||0,
    targetId:hero.id,entries:entries(sim,hero)},sim.time);
  previous.set(hero,result.state);return result.packets;
}
module.exports={sync,entries,catalog:wire.catalog};
