'use strict';

// VIP privileges are already verified in the account loadout and calculated
// by battle-equipment. This adapter projects only the native visible status.
// It does not grant VIP, change attributes, or create title effects.
const wire=require('./battle-status-native').create(require('./battle-progression-native-catalog'));
const previous=new WeakMap(),scopes=new WeakMap();let sequence=0;
const statusByVIP=Object.freeze({9:53109,10:53110,11:53111,12:53112});
const integer=(n,min=0,max=0xffffffff)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
function entries(sim,hero){
  if(!sim||sim.heroes?.closed||sim.mode!=='battlefield'||!hero?.alive||hero.kind!=='hero'||sim.entities?.get(hero.id)!==hero)return [];
  const profile=hero.loadout?.vipProfile;if(profile===null||profile===undefined)return [];
  if(!integer(profile.uid,1)||!integer(profile.playerId,1)||profile.playerId!==hero.id||!integer(profile.level,0,12)||
    typeof profile.source!=='string'||
    !integer(profile.observedAt,0,Number.MAX_SAFE_INTEGER))throw Error('Invalid authoritative VIP native profile');
  if(/^(?:native-new-account|local-reference-template):/.test(profile.source)){
    require('./public-beta/native-seed').validateBaseline(profile,{uid:profile.uid,playerId:profile.playerId,publicBetaIdentity:profile.publicBetaIdentity},'vip');
  }else if(!/^(?:capture-role:[a-f0-9]{64}|development-recharge:.+)$/.test(profile.source))throw Error('Invalid authoritative VIP native profile');
  if(!statusByVIP[profile.level])return [];
  if(!integer(hero.heroId,1,0xffff)||!integer(hero.skinId??hero.skin??0,0,0xffff))throw Error('Invalid VIP native source appearance');
  const statusId=statusByVIP[profile.level],row=wire.catalog(statusId,1);
  if(!row?.showIcon||!row.icon)throw Error('Missing native VIP visible catalog');
  return [{statusId,level:1,sourceId:hero.id,sourceHeroId:hero.heroId,
    sourceSkinId:hero.skinId??hero.skin??0,overlap:1,until:Infinity}];
}
function sync(sim,hero,{force=false}={}){
  if(!sim||sim.heroes?.closed||hero?.kind!=='hero'||sim.entities?.get(hero.id)!==hero){if(hero)previous.delete(hero);return [];}
  if(!scopes.has(sim))scopes.set(sim,'vip-native:'+ ++sequence);
  const result=wire.diff(force?null:previous.get(hero),{scope:scopes.get(sim),life:hero.reviveCount||0,
    targetId:hero.id,entries:entries(sim,hero)},sim.time);
  previous.set(hero,result.state);return result.packets;
}
module.exports={entries,sync,statusByVIP,catalog:wire.catalog};
