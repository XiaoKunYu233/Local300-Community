'use strict';
const P=require('./battle-protobuf'),W=require('./battle-wire'),B=require('./battle-protocol'),N=require('./battle-native'),R=require('./battle-roster-live');
const dynamic=e=>['hero','minion','ward'].includes(e?.kind);
class BattleView {
 constructor(sim,viewerId){this.sim=sim;this.viewerId=viewerId;this.shown=new Set();this.roster=new Map();this.hiddenProjectiles=new Set();this.rosterTemplate=null;}
 corpse(e){return e?.kind==='hero'&&!e.alive&&(!e.battleBot||e.bot?.entered)&&Number.isFinite(e.respawnAt)&&e.respawnAt>this.sim.time;}
 visible(e){const self=this.sim.entities.get(this.viewerId);return e&&(!dynamic(e)||e.team===self?.team||(this.corpse(e)?this.sim.vision.visibleCorpseToTeam(e,self?.team):this.sim.vision.visibleToTeam(e,self?.team)));}
 filter(frames,{playing=false}={}){
  const sim=this.sim,out=[],before=[],after=[],announcements=[],next=new Set(),added=new Set();
  const flat=frames.flatMap(f=>W.expand(f));
  for(const e of sim.entities.values())if((e.alive||this.corpse(e))&&(!e.battleBot||e.bot?.entered)&&this.visible(e))next.add(e.id);
  const rosterFrame=flat.find(f=>f.readUInt16LE(8)===23444);
  if(rosterFrame)this.rosterTemplate=Buffer.from(rosterFrame);
  let rosterChanged=false;
  for(const e of R.participants(sim)){
   const visible=R.details(sim,e,this.viewerId),packet=R.join(e,{visible}),prior=this.roster.get(e.id);
   // Never overwrite a last-seen loadout with the hidden/empty projection.
   if(!prior||visible&&!prior.equals(packet)){
    if(!rosterFrame)before.push(packet,R.identity(e));
    if(!prior){
     rosterChanged=true;
     // 23480 registers the actor; original servers send 1104 separately.
     // Only actual entry announces, never a visibility or loadout refresh.
     if(playing&&e.battleBot&&e.bot?.entered)announcements.push(require('./battle-entry-notice').entryNotice(e.id));
    }
    this.roster.set(e.id,packet);
   }
  }
  // The complete roster refresh also binds the native remote-detail cache
  // (65d770 -> ebe3f0), which the join-only branch does not initialize.
  // Register joins before the separate entry broadcast and live table.
  const fullRoster=!!rosterFrame||!!(rosterChanged&&this.rosterTemplate);
  if(!rosterFrame&&fullRoster)before.push(R.roster(this.rosterTemplate,sim,this.viewerId,{knownDetails:this.roster}));
  if(playing){
   for(const id of next)if(!this.shown.has(id)){
    const e=sim.entities.get(id);if(id===this.viewerId||!dynamic(e)||!e.template)continue;
    before.push(N.spawn(e.template,e));added.add(id);
    if(e.kind==='hero'&&e.loadout){
     const E=require('./battle-equipment');before.push(...E.equipmentPackets(id,e.loadout),E.attributePacket(e));
     if(e.loadout.gemState)before.push(W.frame(11888,0,require('./gem-board').actorPayload(e.loadout.gemState,id)));
     before.push(...sim.heroes.nativeSync(e,{force:true,viewerId:this.viewerId}),...require('./summoner-native').sync(sim,e).packets,
      ...require('./battle-progression-native').sync(sim,e,{force:true}),...require('./equipment-active-native').sync(sim,e,{force:true}),...require('./battle-vip-native').sync(sim,e,{force:true}),...require('./war-soul-entry-native').sync(sim,e,{force:true}));
     before.push(...require('./equipment-visuals').packets(id,e.heroId,e.equipmentVisuals||new Map(),new Map(),{force:true}));
     // Current bots have no magical device. Clear the template's foreign cache.
     if(!e.loadout.dedicatedMagicGuid){const p=Buffer.alloc(2057);p[0]=255;p.writeUInt16LE(65535,1);p.writeUInt32LE(65535,3);p.writeUInt32LE(7,493);before.push(W.frame(9105,id,p));}
    }
    if(this.corpse(e))before.push(N.heroHP(id,0),N.death(id),N.respawnTimer(id,Math.max(0,e.respawnAt-sim.time)));
    else if(e.navigation?.length)before.push(N.path(id,[{x:e.x,z:e.z},...e.navigation]));
   }
   for(const id of this.shown)if(!next.has(id)&&dynamic(sim.entities.get(id)))after.push(N.remove(id));
  }
  for(const f of flat){
   const tag=f.readUInt16LE(8);let id=f.readUInt32LE(4);
   if(tag===11888){const outer=P.decode(f.subarray(12)).find(x=>x.number===18&&x.wire===2),inner=outer&&P.decode(outer.bytes).find(x=>x.number===4&&x.wire===2);if(inner)id=P.get(P.decode(inner.bytes),1);}
   // 18606 is globally addressed (header actor 0); its payload is only
   // the revived actor id. It clears Tab's clock without a location.
   if(tag===18606){if(f.length===16&&R.entered(sim.entities.get(f.readUInt32LE(12))||{}))out.push(f);continue;}
   const e=sim.entities.get(id);
   const projectile=require('./black-rock-projectiles').inspect(f);
   if(projectile&&projectile.reference!==8026&&dynamic(sim.entities.get(projectile.owner))&&!next.has(projectile.owner)){this.hiddenProjectiles.add(id);continue;}
   if(this.hiddenProjectiles.has(id)){if(tag===1021)this.hiddenProjectiles.delete(id);continue;}
   if(tag===23444){out.push(R.roster(f,sim,this.viewerId,{knownDetails:this.roster}));continue;}
   if(tag===23445&&fullRoster&&f.length>=13&&f[12]<=3)continue;
   if([23480,23447].includes(tag))continue;
   if(tag===23512){if(f.length<16||!R.entered(sim.entities.get(f.readUInt32LE(12))||{}))continue;out.push(f);continue;}
   if([1050,1052].includes(tag)){
    if(added.has(id))continue;const spawn=B.readSpawn(f);if(spawn&&['hero','monster'].includes(spawn.kind)&&!e)continue;
   }
   // Roster counters and respawn clocks are public facts, never positions.
   if([23445,23459].includes(tag)&&R.entered(e||{})){out.push(f);continue;}
   if(e&&dynamic(e)&&id!==this.viewerId&&e.team!==sim.entities.get(this.viewerId)?.team&&(!next.has(id)&&!(this.shown.has(id)&&!e.alive)))continue;
   if([11005,11042].includes(tag)){
    const skill=B.readSkill(f);let i=0;skill.fields=skill.fields.filter(field=>{if(field.number!==11||field.wire!==2)return true;const t=skill.targets[i++];return !dynamic(sim.entities.get(t.id))||next.has(t.id)||this.shown.has(t.id);});
    skill.targets=skill.targets.filter(t=>!dynamic(sim.entities.get(t.id))||next.has(t.id)||this.shown.has(t.id));
    out.push(B.writeSkill(skill));continue;
   }
   out.push(f);
  }
  // 23444 also clears/rebuilds UI-side caches. Reapply remaining duration,
  // not the original delay, after the complete snapshot and any same-batch
  // lifecycle messages so an already dead hero keeps an accurate Tab clock.
  if(fullRoster)for(const e of R.participants(sim))if(this.corpse(e))after.push(N.respawnTimer(e.id,e.respawnAt-sim.time));
  if(playing)this.shown=next;
  return [...before,...out,...announcements,...after];
 }
}
module.exports={BattleView};
