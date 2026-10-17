'use strict';
const navigation=require('./battle-navigation'),motion=require('./battle-motion-collision');
const {BattleMatchStats}=require('./battle-match-stats');
const {moveSpeed,movePercentForSpeed,resistanceMultiplier,hitChance,warSoulMultiplier,warSoulElementMultiplier,clamp}=require('./attribute-math');
const summoners=require('./summoner-effects'),effectStats=require('./battle-effect-stats');
const warSoulEntries=require('./war-soul-entry-effects'),warSoulCombat=require('./war-soul-entry-combat');
const {HeroRuntime}=require('./hero-runtime');
const worldServices=require('./battle-world-services');
const distance = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);
const point = p => p && [p.x,p.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35);
const buildingKinds=new Set(['tower','base','barracks','fountain']);
const collidable=e=>e.bodyRadius>0&&(e.alive||buildingKinds.has(e.kind));
// Shot and queued visual events keep exact actor/life references outside the
// serializable event payload. An ID alone can refer to a replacement or revive.
const basicShotBindings=new WeakMap();
const deferredDamageBindings=new WeakMap();
const cancelledBasicShots=new WeakSet();

// Authoritative combat model. The native protocol adapter supplies verified
// spawn templates, faction, map routes, and skills. No recorded combat runs here.
class BattleSim {
  constructor({entities=[], lanes=[], waveInterval=30, respawnDelay=12,terrain=null,random=Math.random,mode='battlefield',heroRegistry,vision}={}) {
    if (!(waveInterval>0) || !(respawnDelay>0)) throw new Error('Invalid match timing');
    this.entities=new Map(); this.time=0; this.events=[]; this.winner=null;
    this.heroes=new HeroRuntime(this,heroRegistry);
    this.vision=new worldServices.BattleVision(this,vision);this.objects=new worldServices.BattleObjects(this);
    this.lanes=lanes; this.waveInterval=waveInterval; this.nextWave=waveInterval;
    this.respawnDelay=respawnDelay; this.nextId=0xff800000; this.wave=0;
    this.shots=[];this.nextShot=0;this.matchStats=null;this.deferredDamage=[];this.fields=[];
    basicShotBindings.set(this,new WeakMap());
    this.terrain=terrain;
    // Equipment economy effects such as arena bounty gold are opt-in.  The
    // ordinary combat runtime is the Eternal Battlefield ruleset; callers
    // that host a different mode must state it explicitly.
    this.mode=String(mode||'battlefield');
    this.random=random;
    for(const e of entities)this.add(e);
  }
  event(type,data={}) {const event={type,time:this.time,...data};this.events.push(event);return event;}
  basicShotEvent(type,shot,data=shot){
    const event=this.event(type,data),bindings=basicShotBindings.get(this),binding=bindings.get(shot);
    if(binding)bindings.set(event,binding);
    if(type==='attack-launch'&&binding&&this.basicShotActors(shot)?.attacker===binding.attacker)
      require('./battle-progression-effects').onCommittedAction(this,binding.attacker,{committed:true,kind:'basic-attack',
        life:binding.attackerLife,commitId:'basic:'+shot.shotId,skillId:shot.skillId});
    return event;
  }
  basicShotActors(shot,{allowDead=false}={}){
    const binding=basicShotBindings.get(this).get(shot);
    const current=(entity,life)=>!this.heroes.closed&&entity&&(allowDead||entity.alive)&&this.entities.get(entity.id)===entity&&entity.reviveCount===life;
    if(!binding||!current(binding.attacker,binding.attackerLife))return null;
    const attacker=binding.attacker,target=current(binding.target,binding.targetLife)&&(allowDead||this.enemies(attacker,binding.target))?binding.target:null;
    return {attacker,target};
  }
  queueDeferredDamage(attacker,target,amount,at){
    // Keep committed loss on its original actors. This preserves the existing
    // dead-source policy; only target revival and actor replacement invalidate it.
    const entry={attacker:attacker.id,target:target.id,amount,at,life:target.reviveCount};
    deferredDamageBindings.set(entry,{sim:this,attacker,target});
    this.deferredDamage.push(entry);
  }
  registerMatch(context) {
    if(this.matchStats)throw new Error('Match identity already registered');
    if(context.mode!==undefined&&context.mode!==this.mode)throw new Error('Match mode differs from simulation');
    this.matchStats=new BattleMatchStats({...context,mode:this.mode},this.entities);
    return this.matchStats.matchId;
  }
  beginMatch(){if(!this.matchStats)throw new Error('Missing match identity');this.matchStats.start(this.time);}
  abortMatch(reason){return this.matchStats?.abort(reason,this.time)||null;}
  getMatchResult(){return this.matchStats?.result||null;}
  getMatchOutcome(){
    if(!this.matchStats)return null;
    if(this.matchStats.result)return Object.freeze({status:'completed',reason:'base-destroyed',result:this.matchStats.result});
    return this.matchStats.incomplete;
  }
  add(data) {
    if(!Number.isInteger(data.id) || this.entities.has(data.id) || !point(data) || !(data.hpMax>0) || ![1,2,3].includes(data.team))throw new Error('Invalid combat entity');
    const passive=['base','barracks','fountain'].includes(data.kind);
    const e={kind:'minion',speed:passive?0:3,range:passive?0:2,acquireRange:passive?0:10,
      attackDamage:passive?0:50,attackInterval:passive?0:1,attackSkillId:0,armor:0,
      hp:data.hpMax,mp:0,mpMax:0,alive:true,attackAt:0,targetId:null,path:[],pathIndex:0,
      gold:0,kills:0,deaths:0,reviveCount:0,skills:{},cooldowns:{},buffs:[],...data};
    if(![e.hp,e.hpMax,e.attackDamage,e.attackInterval,e.range,e.speed,e.mp,e.mpMax].every(Number.isFinite)
      || !(e.hp>=0&&e.hp<=e.hpMax) || !(passive?e.attackInterval>=0:e.attackInterval>0)
      || !(passive?e.range>=0:e.range>0) || !(e.speed>=0) || e.attackDamage<0)throw new Error('Invalid combat stats');
    e.home={x:e.x,z:e.z};e.path=e.path.map(p=>({...p}));e.buffs=[];
    // Keep only the current life's hero contributors so equipment with an
    // assist trigger can resolve the same kill event as the combat result.
    e.damageContributors=new Map();
    e.baseSpeed=e.speed;e.baseAttackDamage=e.attackDamage;
    e.baseHPMax=e.hpMax;effectStats.install(e);
    e.baseRange=e.range;e.baseAttackInterval=e.attackInterval;e.clientAttackSpeed=e.clientBaseAttackSpeed||100;
    if(!e.path.every(point))throw new Error('Invalid lane path');
    e.skills={...e.skills};e.cooldowns={...e.cooldowns};e.alive=e.hp>0;
    this.entities.set(e.id,e);return e;
  }
  enemies(a,b) {return a.id!==b.id&&a.team!==b.team&&b.alive&&b.targetable!==false&&(!b.effectUntargetable||(a.trueSightUntil||0)>this.time);}
  observe(viewerId,targetId){
    if(this.heroes.closed)return null;const viewer=this.entities.get(viewerId),entity=this.entities.get(targetId);if(!viewer||!entity)return null;
    const policy=this.heroes.observerView(entity,viewer)||{},hp=policy.hp??entity.hp,hpMax=policy.hpMax??entity.hpMax;
    if(!Number.isFinite(hp)||!Number.isFinite(hpMax)||hp<0||hpMax<=0||hp>hpMax||['hideAttributes','hideEquipment'].some(key=>policy[key]!==undefined&&typeof policy[key]!=='boolean'))throw Error('Invalid hero observer projection');
    return Object.freeze({id:entity.id,heroId:entity.heroId,team:entity.team,alive:entity.alive,hp,hpMax,
      attributes:policy.hideAttributes?null:Object.freeze({...entity.attributes}),
      equipment:policy.hideEquipment?null:Object.freeze((entity.loadout?.slots||[]).map(item=>Object.freeze({slot:item.slot,itemId:item.itemId,enhancementLevel:item.enhancementLevel||0}))),
      hidden:!!policy.hideAttributes||!!policy.hideEquipment,hiddenAttributes:!!policy.hideAttributes,hiddenEquipment:!!policy.hideEquipment});
  }
  interact(id,objectId){const entity=this.active(id);if(!entity||entity.kind!=='hero'||!this.objects.owned(entity,objectId))return {ok:false,reason:'invalid-interaction-owner'};
    if(entity.controlUntil>this.time||!summoners.canAct(this,entity,'move'))return {ok:false,reason:'controlled'};
    if(!this.heroes.canAct(entity,'interact',this.objects.get(objectId)))return {ok:false,reason:'hero-interaction-blocked'};
    return this.objects.interact(entity,objectId);
  }
  traceDisplacement(entity,goal,options){return worldServices.traceDisplacement(this,entity,goal,options);}
  displace(entity,goal,options){const result=this.traceDisplacement(entity,goal,options);if(!result.ok)return result;
    this.cancelWindup(entity);this.stopMotion(entity);entity.path=[];entity.targetId=null;entity.x=result.position.x;entity.z=result.position.z;entity.lastMovedAt=this.time;
    this.event('position',{id:entity.id,x:entity.x,z:entity.z,teleport:true,displacementMode:result.mode});return result;
  }
  taunted(e){return e.buffs.find(b=>b.tauntOwner&&b.until>this.time&&b.targetLife===e.reviveCount&&this.entities.get(b.tauntOwner.id)===b.tauntOwner&&b.tauntOwner.alive&&b.tauntOwner.reviveCount===b.ownerLife);}
  active(id) {const e=this.entities.get(id);return !this.heroes.closed&&e&&e.alive&&this.winner===null?e:null;}
  moving(e){return this.time-(e.lastMovedAt??-Infinity)<=.5;}
  guardActive(e){
    const g=e.guard;
    return !!g&&this.time<g.expires&&(g.remaining>0||this.time<g.windowUntil);
  }
  setShield(e,amount){
    const next=Math.max(0,Math.floor(amount));
    const changed=next!==(e.shield||0);
    if(changed)this.event('shield',{id:e.id,amount:next});
    e.shield=next;if(e.attributes&&(changed||next>0||e.attributes[136]!==undefined))e.attributes[136]=next;
  }
  control(id,duration,source=null){
    const e=this.active(id);if(!e||!(duration>0))return false;
    if((e.controlImmuneUntil||0)>this.time||this.heroes.modifiers(e).controlImmune||this.guardActive(e)||summoners.cleanseActive(this,e))return false;
    const until=this.time+duration*(1-clamp(e.attributes?.[99]||0,0,100)/100);
    if(until<=this.time)return false;
    // A few battlefield artifacts unlock their follow-up dash only after the
    // owner successfully applies control. Mark the owner's installed skill
    // rather than using a global flag so two heroes cannot consume each
    // other's proc.
    if(source?.skills)for(const candidate of Object.values(source.skills))
      if(candidate?.equipment&&candidate.requiresControlHit)candidate.empowered=true;
    e.controlUntil=Math.max(e.controlUntil||0,until);
    for(const item of e.passives?.generic||[])for(const effect of item.effects||[])if(effect.type==='onControlDefense'){
      const slot=`equipment:${item.itemId}:control-defense`;
      const old=e.buffs.find(b=>b.slot===slot),layers=Math.min(Math.max(1,effect.max||30), (old?.layers||0)+1);
      e.buffs=e.buffs.filter(b=>b.slot!==slot);
      e.buffs.push({slot,until:this.time+(effect.duration||1),layers,armorBonus:layers*(effect.amount||0),magicResistanceBonus:layers*(effect.amount||0)});
    }
    this.updateBuffs(e);
    this.interruptSkills(e,'control');
    this.cancelChannel(e,'control');this.cancelWindup(e);this.stopMotion(e);return true;
  }
  airborne(e){return !!e?.buffs?.some(b=>b.airborne&&b.until>this.time);}
  knockup(id,duration,source=null,descriptor={statusId:36311}){
    const e=this.active(id);
    if(!e||!Number.isFinite(duration)||duration<=0||duration>10)return false;
    if((e.controlImmuneUntil||0)>this.time||this.heroes.modifiers(e).controlImmune||this.guardActive(e)||summoners.cleanseActive(this,e))return false;
    // Current client 405 derives this flight from height 1 and acceleration
    // 300/10. This is an airborne state with its own clock, not a stun timer.
    const slot=`war-soul-entry:knockup:${source?.id||0}`;
    e.buffs=e.buffs.filter(b=>b.slot!==slot);
    e.buffs.push({slot,until:this.time+duration,airborne:true,negative:true,debuff:true,
      warSoulEntry:descriptor.warSoulEntry!==false,statusId:descriptor.statusId,nativeStatusId:descriptor.statusId,
      sourceId:source?.id,sourceLife:source?.reviveCount,startedAt:this.time,
      jumpHeight:descriptor.height??1,jumpAcceleration:descriptor.acceleration??30});
    this.interruptSkills(e,'knockup');this.cancelChannel(e,'knockup');
    this.cancelWindup(e);this.stopMotion(e);this.updateBuffs(e);
    this.event('passive',{id:source?.id,target:id,effect:'war-soul-knockup',duration,height:descriptor.height??1,acceleration:descriptor.acceleration??30});
    return true;
  }
  interruptSkills(e,reason){this.heroes.onControl(e,reason);}
  heal(e,amount,{skillId=0,skillLevel=1,reason='healing',ignoreHealingReduction=false,ignoreHealingModifiers=false,source=e}={}){
    if(!e?.alive||!Number.isFinite(amount)||amount<=0)return 0;
    const temporary=e.buffs?.reduce((sum,b)=>Math.max(sum,Number(b.healingReduction)||0),0)||0;
    const reduction=ignoreHealingModifiers||ignoreHealingReduction?0:clamp(Math.max(Number(e.equipmentHealingReduction)||0,temporary),0,100);
    const receivedBonus=ignoreHealingModifiers?0:Math.max(0,Number(e.equipmentHealingReceivedBonus)||0);
    const soulHealingBonus=ignoreHealingModifiers?0:warSoulCombat.healingBonus(this,source,e);
    const adjusted=Math.max(0,Math.floor(amount*(1+receivedBonus/100)*(1+soulHealingBonus/100)*(1-reduction/100)));
    const before=e.hp;e.hp=Math.min(e.hpMax,e.hp+adjusted);
    const gained=e.hp-before;
    if(gained>0){summoners.onHeal(this,e,gained);this.matchStats?.recordHeal(e,gained);this.event('heal',{id:e.id,hp:e.hp,mp:e.mp,amount:gained,skillId,skillLevel,reason});}
    return gained;
  }
  revive(e){
    if(!e||e.kind!=='hero'||e.alive)return false;
    e.reviveCount=(e.reviveCount+1)>>>0;
    const spawn=this.freeSpawn(e.home,e.bodyRadius||0,e.id);
    e.alive=true;e.x=spawn.x;e.z=spawn.z;e.targetId=null;e.buffs=[];
    e.channel=null;e.guard=null;e.controlUntil=0;e.path=[];e.navigation=null;e.motionGoal=null;e.lastMovedAt=-Infinity;e.damageContributors=new Map();
    this.heroes.onRespawn(e);require('./battle-progression-effects').onRespawn(this,e);this.updateBuffs(e);e.hp=e.hpMax;e.mp=e.mpMax;
    this.event('respawn',{id:e.id,x:e.x,z:e.z,hp:e.hp});return true;
  }
  notifyCast(e,skill,context){
    this.heroes.onCast(e,skill,context);
    if(this.entities.get(e.id)===e&&e.reviveCount===context.attackerLife&&e.alive&&!this.heroes.closed)
      require('./battle-progression-effects').onCommittedAction(this,e,{committed:true,
        kind:String(skill.slot??context.slot).startsWith('R')?'ultimate':'basic-skill',
        slot:skill.slot??context.slot,cooldownKey:skill.cooldownKey??context.slot??skill.slot,
        skillId:skill.id,life:context.attackerLife,commitId:'cast:'+(this.progressionActionId=(this.progressionActionId||0)+1)});
  }
  cancelChannel(e,reason) {
    if(!e.channel)return;
    this.event('cast-cancel',{id:e.id,...e.channel,reason});e.channel=null;
  }
  cancelWindup(e) {
    this.shots=this.shots.filter(shot=>{
      if(cancelledBasicShots.has(shot))return false;
      if(shot.id!==e.id||shot.launched)return true;
      // Hit callbacks can interrupt another actor while tick is traversing
      // the previous shot array. Mark the exact shot as well as removing it,
      // so the outer traversal cannot retain or launch that cancelled windup.
      cancelledBasicShots.add(shot);
      this.basicShotEvent('attack-cancel',shot,{id:e.id,skillId:shot.skillId,shotId:shot.shotId});
      if(this.basicShotActors(shot)?.attacker===e)e.attackAt=this.time;return false;
    });
  }
  move(id,to) {
    const e=this.active(id);
    if(!e||e.kind!=='hero'||!point(to))return {ok:false,reason:'invalid-move'};
    if(this.taunted(e)||e.controlUntil>this.time||this.airborne(e)||!summoners.canAct(this,e,'move'))return {ok:false,reason:'controlled'};
    const decision=this.heroes.onMoveOrder(e,to);if(decision?.ok===false)return decision;
    if(this.heroes.modifiers(e).rooted||warSoulCombat.controlledModifiers(e,this.time).rooted)return {ok:false,reason:'rooted'};
    if(!this.heroes.canAct(e,'move'))return {ok:false,reason:'casting'};
    this.cancelChannel(e,'move');
    this.cancelWindup(e);
    const points=this.planRoute(e,to);
    if(!points)return {ok:false,reason:'blocked'};
    e.path=[{...(points.arrival||points.at(-1))}];e.pathIndex=0;e.targetId=null;e.chase=null;
    this.setRoute(e,points,e.path[0]);return {ok:true};
  }
  attack(id,targetId,skillId) {
    const e=this.active(id),t=this.entities.get(targetId);
    if(e&&this.objects.get(targetId))return this.interact(id,targetId);
    if(!e||!t||!this.enemies(e,t))return {ok:false,reason:'invalid-target'};
    if(this.taunted(e)&&this.taunted(e).tauntOwner!==t||e.controlUntil>this.time||this.airborne(e)||!summoners.canAct(this,e,'attack'))return {ok:false,reason:'controlled'};
    if(!this.heroes.canAct(e,'attack'))return {ok:false,reason:'shooter-mode'};
    this.cancelChannel(e,'attack');
    const profile=!this.heroes.managesBasicAttack(e)&&e.attackProfiles?.[skillId];
    if(profile&&skillId!==e.attackSkillId){
      this.cancelWindup(e);Object.assign(e,profile,{attackSkillId:skillId,baseRange:profile.range});this.updateBuffs(e);
      // A range change requires a fresh pursuit destination on the next step.
      this.stopMotion(e);
    }
    if(e.targetId===t.id)return {ok:true};
    if(e.targetId!==t.id)this.cancelWindup(e);
    e.targetId=t.id;e.path=[];e.pathIndex=0;this.stopMotion(e);return {ok:true};
  }
  cast(id,slot,aim={}) {
    if(this.heroes.closed)return {ok:false,reason:'world-closed'};
    const candidate=this.entities.get(id);
    const e=this.active(id)||(candidate?.skills[slot]?.allowDead&&this.winner===null?candidate:null),skill=e?.skills[slot];
    if(!e||!skill)return {ok:false,reason:'unknown-skill'};
    if(skill.equipment&&(skill.unsupportedNative||!Number.isInteger(skill.id)||skill.id<=0||skill.id>65535))return {ok:false,reason:'equipment-native-skill-unbound'};
    if(this.airborne(e)||this.taunted(e)&&![8031,8066].includes(skill.id))return {ok:false,reason:'controlled'};
    const castContext={attackerLife:e.reviveCount,slot};
    if(skill.oneUse&&skill.used)return {ok:false,reason:'consumed'};
    if(skill.requiresControlHit&&!skill.empowered)return {ok:false,reason:'not-empowered'};
    if(this.heroes.ownsSkill(e,skill)){
      if(e.controlUntil>this.time||!summoners.canAct(this,e,'cast'))return {ok:false,reason:'controlled'};
      const result=this.heroes.applyCast(e,skill,aim);
      if(result.ok){if(this.entities.get(e.id)===e&&e.reviveCount===castContext.attackerLife&&e.alive&&!this.heroes.canAct(e,'move')){this.stopMotion(e);e.path=[];}this.notifyCast(e,skill,castContext);}
      return result;
    }
    if(!this.heroes.canAct(e,skill.equipment?'equipment':'cast',skill))return {ok:false,reason:'hero-cast-blocked'};
    const checked=skill.summoner?summoners.validateCast(this,e,skill,aim):null;
    if(checked&&!checked.ok)return checked;
    const alias=skill.aliases?.includes(aim.requestedSkillId);
    if(alias&&!checked?.recast)return {ok:false,reason:'invalid-recast'};
    if(![8031,8066].includes(skill.id)&&(e.controlUntil>this.time||!summoners.canAct(this,e,'cast')))return {ok:false,reason:'controlled'};
    if(e.channel?.slot===slot&&e.channel.skillId===skill.id){this.cancelChannel(e,'recast');return {ok:true,cancelled:true};}
    if(skill.equipment){
      const ready=require('./equipment-dynamic-passives').beforeActive(this,e,skill);
      if(!ready.ok){this.event('skill-cooldown',{id:e.id,skill,readyAt:ready.readyAt});return ready;}
    }
    const cooldownSlot=skill.equipment?(skill.cooldownKey||slot):slot;
    if(!checked?.recast&&(e.cooldowns[cooldownSlot]||0)>this.time)return {ok:false,reason:'cooldown'};
    if(e.mp<(skill.mana||0))return {ok:false,reason:'mana'};
    let targets=[],anchor;
    if(skill.type==='channel-teleport') {
      // The native client sends ground coordinates and target 0xffffffff.
      // Current 8069 uses width 15 to detect a friendly unit near that point.
      const legal=t=>t?.alive&&t.id!==e.id&&t.team===e.team&&
        (t.kind!=='hero'||(e.level||1)>=18)&&
        ['hero','minion','tower','base','barracks','fountain'].includes(t.kind);
      anchor=this.entities.get(aim.targetId);
      const ground=aim.targetId===0xffffffff||aim.targetId===0||aim.targetId===undefined;
      if(ground&&point(aim))anchor=[...this.entities.values()].filter(t=>legal(t)&&
        distance(t,aim)<=(skill.anchorRadius??15)).sort((a,b)=>distance(a,aim)-distance(b,aim)||a.id-b.id)[0];
      if(!legal(anchor))return {ok:false,reason:'invalid-anchor'};
      aim=ground&&point(aim)?{x:aim.x,z:aim.z}:{x:anchor.x,z:anchor.z};
    }
    if(skill.type==='target') {
      const t=this.entities.get(aim.targetId);
      if(!t||(skill.buildingOnly&&!buildingKinds.has(t.kind))||(skill.allowAlly?t.team!==e.team:!this.enemies(e,t))||distance(e,t)>skill.range)return {ok:false,reason:'range-or-target'};
      if(skill.guardBuilding&&(t.equipmentGuardNextAt||0)>this.time)return {ok:false,reason:'building-guard-cooldown'};
      targets=[t];
    } else if(skill.type==='area') {
      const center=point(aim)?aim:e;
      if(distance(e,center)>skill.range)return {ok:false,reason:'range'};
      targets=[...this.entities.values()].filter(t=>skill.friendlyArea
        ? t.alive&&t.team===e.team&&distance(center,t)<=(skill.radius||1)
        : this.enemies(e,t)&&distance(center,t)<=(skill.radius||1));
    } else if(skill.type==='line') {
      const dx=aim.dirX||0,dz=aim.dirZ||0,length=Math.hypot(dx,dz);
      if(!length)return {ok:false,reason:'direction'};
      targets=[...this.entities.values()].filter(t=>{
        if(!this.enemies(e,t))return false;
        const x=t.x-e.x,z=t.z-e.z,along=(x*dx+z*dz)/length,across=Math.abs(x*dz-z*dx)/length;
        return along>=0&&along<=skill.range&&across<=skill.width;
      });
    } else if(skill.type==='dash') {
      if(!point(aim))return {ok:false,reason:'range'};
      const d=distance(e,aim);
      if(d>skill.range){
        if(!skill.clampRange)return {ok:false,reason:'range'};
        aim={...aim,x:e.x+(aim.x-e.x)*skill.range/d,z:e.z+(aim.z-e.z)*skill.range/d};
      }
      const requested={...aim},length=distance(e,requested),circles=this.blockers(e);
      let landing=null;
      for(let back=0;back<=length;back+=.1){
        const t=length?(length-back)/length:0,p={x:e.x+(requested.x-e.x)*t,z:e.z+(requested.z-e.z)*t};
        if((!this.terrain||this.terrain.clear(p,e.bodyRadius||0))&&circles.every(c=>distance(p,c)>=c.r)){landing=p;break;}
      }
      if(!landing)return {ok:false,reason:'blocked-landing'};
      aim={...aim,...landing};
    } else if(!['heal','buff','guard','channel-teleport','summoner'].includes(skill.type))return {ok:false,reason:'unsupported-skill'};
    this.cancelChannel(e,'cast');
    const reduction=skill.summoner||skill.equipment?0:clamp(e.attributes?.[100]||0,0,40+(e.equipmentCooldownCapBonus||0));
    const cooldown=(skill.summoner?summoners.castCooldown(this,e,skill):skill.cooldown)*(1-reduction/100);
    if(!checked?.recast){
      e.mp-=skill.mana||0;e.cooldowns[cooldownSlot]=e.cooldowns[slot]=this.time+cooldown;
      if(skill.equipment&&skill.cooldownKey)for(const [otherSlot,other]of Object.entries(e.skills)){
        if(other.equipment&&other.cooldownKey===skill.cooldownKey)e.cooldowns[otherSlot]=e.cooldowns[slot];
      }
    }
    if(skill.requiresControlHit)skill.empowered=false;
    this.event('cast',{id:e.id,slot,skillId:alias?aim.requestedSkillId:skill.id,skill:alias?{...skill,id:aim.requestedSkillId}:undefined,mp:e.mp,readyAt:e.cooldowns[slot],targetIds:checked?.targetId!==undefined?[checked.targetId]:targets.map(t=>t.id),aim:point(aim)?{x:aim.x,z:aim.z}:undefined});
    if(anchor){
      this.cancelWindup(e);this.stopMotion(e);e.path=[];e.targetId=null;
      e.channel={slot,skillId:skill.id,anchorId:anchor.id,endsAt:this.time+skill.channel,aim};
    }
    if(skill.type==='buff') {
      if(skill.switchPenetration&&e.passives?.genesis){
        e.genesisPenMode=e.genesisPenMode==='magic'?'armor':'magic';
        this.event('equipment-penetration-switch',{id:e.id,mode:e.genesisPenMode});
      }
      e.buffs=e.buffs.filter(b=>b.slot!==slot);e.buffs.push({slot,until:this.time+skill.duration,speed:skill.speedMultiplier||1,attack:skill.attackMultiplier||1,range:skill.rangeBonus||0,attackSpeed:skill.attackSpeedBonus||0,hit:skill.hitBonus||0,lifeSteal:skill.lifeStealBonus||0,firstHitDamage:skill.firstHitDamage||0,firstHitDamageScaling:skill.firstHitDamageScaling||null,damageReductionPhysical:skill.damageReductionPhysical||0,damageReductionMagic:skill.damageReductionMagic||0,healingReduction:skill.healingReduction||0,meditation:!!skill.meditation,immobilized:!!skill.immobilized,regenHp:skill.meditation?e.hpMax*(skill.healRatio||0):0,regenMp:skill.meditation?e.mpMax*(skill.manaRatio||0):0,regenInterval:1,regenNext:this.time+1,oneUse:!!skill.oneUse,cancelOnHeroDamage:!!skill.cancelOnHeroDamage});
      if(skill.meditation) e.controlUntil=Math.max(e.controlUntil||0,this.time+skill.duration);
      if(skill.trueSight)e.trueSightUntil=this.time+skill.duration;
      this.updateBuffs(e);
      if(skill.oneUse)skill.used=true;
    }
    if(skill.type==='guard')e.guard={remaining:3,windowUntil:0,expires:this.time+(skill.guardDuration||3)};
    if(skill.guardBuilding&&targets[0]){
      const building=targets[0],duration=skill.guardDuration||3.5;
      building.guard={remaining:Number.POSITIVE_INFINITY,windowUntil:this.time+duration,expires:this.time+duration};
      building.equipmentGuardNextAt=this.time+45;
      building.buffs=building.buffs.filter(b=>b.slot!==`equipment:building-guard:${e.id}`);
      building.buffs.push({slot:`equipment:building-guard:${e.id}`,until:this.time+duration,damageReductionPhysical:100,damageReductionMagic:100,
        damageBonus:Number(skill.buildingDamageBonus||0),attackSpeed:Number(skill.buildingAttackSpeedBonus||0)});
      this.updateBuffs(building);
      this.event('equipment-building-guard',{id:e.id,target:building.id,duration,damageBonus:skill.buildingDamageBonus||0,attackSpeedBonus:skill.buildingAttackSpeedBonus||0});
    }
    if(skill.guardShare&&targets[0]){
      const previous=e.guardianTargetId&&this.entities.get(e.guardianTargetId);
      if(previous?.guardian?.ownerId===e.id)previous.guardian=null;
      e.guardianTargetId=targets[0].id;
      targets[0].guardian={ownerId:e.id,percent:30+(e.enhancementLevel||skill.level||0)*2,until:Infinity};
    }
    if(skill.type==='dash') {this.cancelWindup(e);this.stopMotion(e);e.x=aim.x;e.z=aim.z;e.path=[];e.targetId=null;e.motionGoal=null;if(skill.resetAttack)e.attackAt=this.time;this.event('position',{id:e.id,x:e.x,z:e.z,teleport:true});}
    if(skill.type==='heal')this.heal(e,(skill.heal||0)+(skill.healRatio?e.hpMax*skill.healRatio:0),{skillId:skill.id,skillLevel:skill.level||1});
    if(skill.friendlyArea&&skill.heal){
      for(const ally of targets){
        const amount=skill.interval?0:skill.heal;
        const gained=this.heal(ally,amount,{source:e,skillId:skill.id,skillLevel:skill.level||1,reason:'equipment-area'});
        require('./equipment-dynamic-passives').onHeal?.(this,e,ally,gained);
        if(skill.interval){ally.buffs=ally.buffs.filter(b=>b.slot!==`equipment:active:${skill.id}`);ally.buffs.push({slot:`equipment:active:${skill.id}`,until:this.time+(skill.duration||3),regenHp:skill.heal||0,regenMp:skill.manaRestore||0,regenInterval:skill.interval,regenNext:this.time+skill.interval});}
        if(skill.manaRestore){const before=ally.mp||0;ally.mp=Math.min(ally.mpMax||before,before+skill.manaRestore);if(ally.mp>before)this.event('mana',{id:ally.id,amount:ally.mp-before,reason:'equipment-area'});}
      }
    }
    if(skill.friendlyArea&&skill.healRatio){
      for(const ally of targets){
        const gained=this.heal(ally,(ally.hpMax||0)*skill.healRatio,{source:e,skillId:skill.id,skillLevel:skill.level||1,reason:'equipment-area'});
        if(skill.shieldRatio) this.setShield(ally,Math.max(ally.shield||0,Math.floor((ally.hpMax||0)*skill.shieldRatio)));
        require('./equipment-dynamic-passives').onHeal?.(this,e,ally,gained);
      }
    }
    if(skill.vision||skill.clearObjects||skill.summon)this.event('equipment-area',{id:e.id,skillId:skill.id,x:aim.x??e.x,z:aim.z??e.z,radius:skill.radius||0,duration:skill.duration||0,vision:!!skill.vision,clearObjects:!!skill.clearObjects,summon:skill.summon||null});
    if(skill.field||skill.delayed){
      const delay=Number(skill.delayed||0),duration=Number(skill.fieldDuration||0);
      this.fields.push({ownerId:e.id,center:{x:aim.x??e.x,z:aim.z??e.z},skill,
        // A delayed impact must survive until its scheduled tick. Keep a
        // small integration margin so the expiry check cannot eat the hit.
        expires:this.time+(duration||delay||1)+(delay&&!duration ? 0.05 : 0),
        nextAt:this.time+(delay||skill.interval||.5),exploded:false});
    }
    const rawDamage=Math.max(skill.minDamage||0,(skill.damage||0)+Object.entries(skill.damageScaling||{})
      .reduce((sum,[attr,ratio])=>sum+(e.attributes?.[attr]||0)*ratio,0));
    let dealt=0;for(const t of targets){
      if(skill.cleanse&&t.alive){
        t.controlUntil=0;
        t.buffs=t.buffs.filter(b=>!String(b.slot||'').startsWith('equipment:active:')&&!b.control&&!b.negative&&!b.debuff);
        t.controlImmuneUntil=Math.max(t.controlImmuneUntil||0,this.time+(skill.controlImmune||0));
        this.updateBuffs(t);
      }
      const adaptive=skill.adaptiveDamageRatio?Math.max(t.hpMax||0,t.mpMax||0)*skill.adaptiveDamageRatio:0;
      const targetHealth=skill.targetHealthRatio?(skill.targetHealthCurrent?t.hp:t.hpMax)*skill.targetHealthRatio:0;
      let castDamage=Math.max(rawDamage+targetHealth,adaptive);
      if(skill.nonHeroDamageCap&&t.kind!=='hero')castDamage=Math.min(castDamage,skill.nonHeroDamageCap);
      const hit=this.damage(e,t,castDamage,skill.id,skill.damageType||'physical',undefined,undefined,{element:skill.element,adRatio:(skill.damageScaling?.[30]||0)+(skill.damageScaling?.[127]||0),apRatio:(skill.damageScaling?.[31]||0)+(skill.damageScaling?.[128]||0)});dealt+=hit;
      if(skill.healingReduction&&t.alive){t.buffs=t.buffs.filter(b=>b.slot!==`equipment:active:${skill.id}`);t.buffs.push({slot:`equipment:active:${skill.id}`,until:this.time+(skill.duration||3),healingReduction:skill.healingReduction});}
      if(skill.slow&&t.alive){t.buffs=t.buffs.filter(b=>b.slot!==`equipment:active:${skill.id}`);t.buffs.push({slot:`equipment:active:${skill.id}`,until:this.time+(skill.duration||3),speed:1-skill.slow/100,attackSpeed:-(skill.attackSpeedSlow||0),healingReduction:skill.healingReduction||0});}
      if(skill.interval&&skill.adaptiveDamageRatio&&t.alive){e.buffs=e.buffs.filter(b=>!(b.slot===`equipment:active:${skill.id}`&&b.dotTargetId===t.id));e.buffs.push({slot:`equipment:active:${skill.id}`,until:this.time+(skill.duration||3),dotTargetId:t.id,dotAmount:Math.max(t.hpMax||0,t.mpMax||0)*skill.adaptiveDamageRatio,dotSkillId:skill.id,dotDamageType:skill.damageType||'true',dotNext:this.time+(skill.interval||1),dotInterval:skill.interval||1});}
      if(skill.knockback&&t.alive){
        // Freeze direction before moving either participant: target movement
        // must not multiply the separately specified caster recoil distance.
        const d=Math.max(.001,distance(e,t)),dx=(t.x-e.x)/d,dz=(t.z-e.z)/d;
        t.x=clamp(t.x+dx*skill.knockback,0,655.35);t.z=clamp(t.z+dz*skill.knockback,0,655.35);
        this.stopMotion(t);this.event('position',{id:t.id,x:t.x,z:t.z,knockback:true});
        if(skill.selfKnockback){e.x=clamp(e.x-dx*skill.selfKnockback,0,655.35);e.z=clamp(e.z-dz*skill.selfKnockback,0,655.35);this.stopMotion(e);this.event('position',{id:e.id,x:e.x,z:e.z,knockback:true});}
      }
      if(skill.swap&&t.alive){const p={x:e.x,z:e.z};e.x=t.x;e.z=t.z;t.x=p.x;t.z=p.z;this.stopMotion(e);this.stopMotion(t);this.event('position',{id:e.id,x:e.x,z:e.z,swap:true});this.event('position',{id:t.id,x:t.x,z:t.z,swap:true});}
      if(skill.control&&t.alive)this.control(t.id,skill.control,e);
      require('./equipment-dynamic-passives').onSkillHit(this,e,t,{amount:hit,raw:castDamage,skillId:skill.id,damageType:skill.damageType||'physical'});
    }
    if(skill.healOnDamage&&dealt>0)this.heal(e,dealt,{skillId:skill.id,skillLevel:skill.level||1,reason:'equipment-active'});
    if(skill.oneUse)skill.used=true;
    if(skill.summoner)summoners.applyCast(this,e,slot,aim,checked);
    this.notifyCast(e,skill,castContext);
    return {ok:true,targets:targets.map(t=>t.id)};
  }
  tickFields(){
    for(const field of [...this.fields]){
      if(field.expires<=this.time){this.fields=this.fields.filter(f=>f!==field);continue;}
      const owner=this.entities.get(field.ownerId),skill=field.skill;
      if(!owner||!skill)continue;
      if(skill.delayed&&!field.exploded&&this.time+1e-9>=field.nextAt){
        field.exploded=true;
        for(const target of this.entities.values())if(target.alive&&this.enemies(owner,target)&&distance(target,field.center)<=skill.radius){
          const amount=Math.max(target.hpMax||0,target.mpMax||0)*(skill.adaptiveDamageRatio||0);
          this.damage(owner,target,amount,skill.id,skill.damageType||'true');if(skill.control)this.control(target.id,skill.control,owner);
        }
        continue;
      }
      if(this.time+1e-9<field.nextAt)continue;
      while(field.nextAt<=this.time+1e-9)field.nextAt+=skill.interval||.5;
      for(const target of this.entities.values())if(target.alive&&(skill.friendlyField?target.team===owner.team:this.enemies(owner,target))&&distance(target,field.center)<=skill.radius){
        const slot=`equipment:field:${skill.id}`;
        if(skill.field==='frost'){
          const old=target.buffs.find(b=>b.slot===slot),layers=Math.min(skill.maxStacks||8,(old?.layers||0)+1);
          target.buffs=target.buffs.filter(b=>b.slot!==slot);target.buffs.push({slot,until:this.time+(skill.fieldDuration||5),layers,speed:1-layers*(skill.slow||0)/100,attackSpeed:-layers*(skill.attackSpeedSlow||0)});
        }else if(skill.field==='poison'){
          target.buffs=target.buffs.filter(b=>b.slot!==slot);target.buffs.push({slot,until:this.time+3,healingReduction:skill.healingReduction||0});
        }else if(skill.field==='lava'){
          const amount=Math.max(target.hpMax||0,target.mpMax||0)*(skill.adaptiveDamageRatio||0);this.damage(owner,target,amount,skill.id,skill.damageType||'true');
        }else if(skill.field==='stealth'){
          target.buffs=target.buffs.filter(b=>b.slot!==slot);
          target.buffs.push({slot,until:this.time+(skill.fieldDuration||60),untargetable:true});
          this.updateBuffs(target);
        }
      }
    }
  }
  updateBuffs(e) {
    require('./battle-progression-effects').prepareUpdate(e);
    require('./equipment-soul').tickShield(this,e);
    const previousSpeed=e.speed;
    const previousRange=e.range,previousAttackSpeed=e.clientAttackSpeed;
    const previousAttack=e.attackDamage,previousDodge=e.attributes?.[18];
    e.buffs=e.buffs.filter(b=>b.until>this.time);
    require('./battle-progression-effects').tick(this,e);
    const mods=effectStats.combine(summoners.modifiers(this,e),this.heroes.modifiers(e),warSoulCombat.controlledModifiers(e,this.time),require('./battle-progression-effects').modifiers(e,this.time));
    e.effectModifiers=mods;e.effectUntargetable=!!mods.untargetable||e.buffs.some(b=>b.untargetable&&b.until>this.time);
    e.effectInvisible=!!mods.invisible||e.buffs.some(b=>b.invisible&&b.until>this.time);
    e.buffs=e.buffs.filter(b=>b.slot!=='engine:skill-effects');
    if(['speedPercent','attackPercent','attackBonus','attackSpeed','rangeBonus','range','critChance','damageReduction','hitStatReduction'].some(key=>mods[key]))e.buffs.push({slot:'engine:skill-effects',until:Infinity,
      speed:1+(mods.speedPercent||0)/100,attack:1+(mods.attackPercent||0)/100,
      attackBonus:mods.attackBonus||0,attackSpeed:mods.attackSpeed||0,lifeSteal:mods.lifeSteal||0,range:(mods.rangeBonus||0)+(mods.range||0),
      criticalChance:mods.critChance||0,hit:-Math.max(0,mods.hitStatReduction||0),damageReduction:mods.damageReduction||0});
    require('./equipment-dynamic-passives').tick(this,e);
    const soulAbilityPower=e.buffs.reduce((sum,b)=>sum+Number(b.abilityPower||0),0);
    effectStats.apply(this,e,{...mods,abilityPower:(mods.abilityPower||0)+soulAbilityPower});
    const speedBonus=e.buffs.reduce((sum,b)=>sum+((b.speed??1)-1)*100,0);
    e.speed=e.baseSpeed*Math.max(0,1+speedBonus/100)*mods.movementMultiplier;
    if(Number.isFinite(mods.moveSpeedOverride)&&mods.moveSpeedOverride>=0)e.speed=mods.moveSpeedOverride;
    if(e.clientBaseMoveSpeed>0){
      if(!(Number.isFinite(mods.moveSpeedOverride)&&mods.moveSpeedOverride>=0))e.speed=moveSpeed(e.clientBaseMoveSpeed,(e.clientMovePercent??100)+speedBonus)/100*mods.movementMultiplier;
      // The client applies the same soft caps when receiving field 17.
      const percent=Math.round(movePercentForSpeed(e.clientBaseMoveSpeed,e.speed*100));
      e.clientEffectiveMovePercent=percent;
      if(e.speed!==previousSpeed)this.event('speed',{id:e.id,percent,speed:e.speed});
    }
    const attackBonus=e.buffs.reduce((sum,b)=>sum+((b.attack??1)-1)*100,0);
    const attackFlat=e.buffs.reduce((sum,b)=>sum+(Number(b.attackBonus)||0),0);
    const tian=e.passives?.tian;
    const hpAttack=tian&&!e.passives.pangu&&e.effectBase
      ?Math.floor(e.hpMax*(1+tian.level*.1)/100)-Math.floor(e.effectBase.hpMax*(1+tian.level*.1)/100):0;
    e.attackDamage=e.flatAttackDamage!==undefined
      ?Math.round((e.flatAttackDamage+hpAttack+attackFlat)*Math.max(0,1+((e.clientAttackPercent||0)+attackBonus)/100))
      : (e.baseAttackDamage+attackFlat)*Math.max(0,1+attackBonus/100);
    e.range=e.baseRange+e.buffs.reduce((sum,b)=>sum+(b.range||0),0);
    e.clientAttackSpeed=Math.max(1,(e.clientBaseAttackSpeed||100)+e.buffs.reduce((sum,b)=>sum+(b.attackSpeed||0),0));
    e.attackInterval=e.baseAttackInterval*(e.clientBaseAttackSpeed||100)/e.clientAttackSpeed;
    if(e.attributes){
      e.attributes[30]=Math.round(e.attackDamage);
      if(e.flatBonusAttackDamage!==undefined)e.attributes[127]=Math.round((e.flatBonusAttackDamage+hpAttack+attackFlat)*Math.max(0,1+((e.clientAttackPercent||0)+attackBonus)/100));
      if(e.baseDodge!==undefined)e.attributes[18]=Math.max(0,e.baseDodge+(e.passives?.shoes&&this.moving(e)?25:0)-(e.equipmentDodgeReduction||0));
    }
    require('./battle-progression-effects').finishUpdate(this,e);
    if(e.range!==previousRange||e.clientAttackSpeed!==previousAttackSpeed||e.attackDamage!==previousAttack||e.attributes?.[18]!==previousDodge)
      this.event('attack-stats',{id:e.id,range:e.range,attackSpeed:e.clientAttackSpeed,
        attack:e.attributes?.[30],extraAttack:e.attributes?.[127],dodge:e.attributes?.[18]});
  }
  movementDamage(e){
    return e.passives?.shoes&&this.moving(e)?Math.min(e.speed*100,800)*(25+e.passives.shoes.level*2.5)/100:0;
  }
  hitBasicShot(shot,attacker,target){
    const actors=this.basicShotActors(shot);
    if(!actors||actors.attacker!==attacker||!actors.target&&!(shot.brsPiercing&&shot.launched))return;
    target=actors.target;
    const targets=target?[target]:[];
    if(shot.brsPiercing){
      const origin=shot.source,dir=shot.direction,width=this.heroes.basicPierceWidth(attacker);
      for(const other of this.entities.values()){
        if(other.id===shot.target||!this.enemies(attacker,other))continue;
        const dx=other.x-origin.x,dz=other.z-origin.z,along=dx*dir.x+dz*dir.z;
        if(along>=0&&along<=shot.pierceRange+(other.bodyRadius||0)&&
          Math.abs(dx*dir.z-dz*dir.x)<=width+(other.bodyRadius||0))targets.push(other);
      }
    }
    for(const {entity:t,life} of targets.map(entity=>({entity,life:entity.reviveCount}))){
      if(this.basicShotActors(shot)?.attacker!==attacker)break;
      if(this.entities.get(t.id)!==t||t.reviveCount!==life)continue;
      this.damage(attacker,t,shot.damage,shot.skillId,'physical',shot.shotId,shot.origin,
        {movementDamage:shot.movementDamage,forceCritical:shot.forceCritical,undodgeable:shot.undodgeable});
    }
  }
  damage(attacker,target,raw,skillId=0,type='physical',shotId,origin,options={}) {
    if(this.heroes.closed)return 0;
    if(!attacker||!target||this.entities.get(attacker.id)!==attacker||this.entities.get(target.id)!==target)return 0;
    if(this.winner!==null||(!attacker.alive&&!options.deferred)||!this.enemies(attacker,target)||!Number.isFinite(raw)||!(raw>0))return 0;
    if(target.kind==='ward')return require('./battle-ward').hit(this,attacker,target,skillId,shotId,origin,options);
    if(options.criticalMultiplier!==undefined&&(!Number.isFinite(options.criticalMultiplier)||options.criticalMultiplier<1))return 0;
    if(['skillCritical','equipmentProcs'].some(key=>options[key]!==undefined&&typeof options[key]!=='boolean'))return 0;
    const attackerLife=attacker.reviveCount,targetLife=target.reviveCount;
    const sourceCurrent=()=>attacker.alive&&this.entities.get(attacker.id)===attacker&&attacker.reviveCount===attackerLife;
    const targetCurrent=()=>this.entities.get(target.id)===target&&target.reviveCount===targetLife;
    attacker.lastCombatAt=this.time;target.lastCombatAt=this.time;target.effectUntargetable=false;
    this.updateBuffs(target);
    const a=attacker.attributes||{},t=target.attributes||{},basic=!options.deferred&&options.basic!==false&&(options.basic||shotId!==undefined||skillId===0);
    const progressionDamage=require('./battle-progression-effects').prepareOutgoingDamage(attacker,target,{raw,basic,
      adRatio:options.adRatio,apRatio:options.apRatio,alreadyModified:!!options.deferred});
    raw=progressionDamage.raw;
    const wasFullHP=attacker.hp>=attacker.hpMax,criticalDamage=a[25]??200;
    let critical=false,magicCritical=false;
    if(basic){
      const chance=hitChance(a[14]??Math.max(0,100-Math.max(0,attacker.effectModifiers?.hitStatReduction||0)),t[18]??100);
      const undodgeable=options.undodgeable||attacker.passives?.generic?.some(item=>(item.effects||[]).some(effect=>effect.type==='alwaysHit'));
      if(!undodgeable&&chance<1&&this.random()>=chance){
        this.event('miss',{attacker:attacker.id,target:target.id,amount:0,hp:target.hp,skillId,shotId,origin,miss:true});
        return 0;
      }
      const crit=clamp((a[24]||0)-(target.criticalResistance||0),0,100)/100;
      // Structures take normal basic damage even when a skill forces a crit.
      if(options.allowCritical!==false&&!buildingKinds.has(target.kind)&&(options.forceCritical||crit>0&&this.random()<crit)){
        critical=true;
        raw*=Math.max(1,((options.criticalMultiplier!==undefined?options.criticalMultiplier*100:a[25]??200)-(target.criticalDamageReduction||0))/100);
      }
    }
    const physical=type==='physical',magical=type==='magic';
    // An explicit spell critical policy keeps physical skills classified as
    // skills. A multiplier alone never grants basic-hit equipment triggers.
    if(!basic&&!options.deferred&&physical&&(options.criticalMultiplier!==undefined||options.skillCritical===true)&&
      options.allowCritical!==false&&!buildingKinds.has(target.kind)){
      const crit=clamp((a[24]||0)-(target.criticalResistance||0),0,100)/100;
      if(options.forceCritical||crit>0&&this.random()<crit){
        critical=true;raw*=Math.max(1,(options.criticalMultiplier??(a[25]??200)/100)-(target.criticalDamageReduction||0)/100);
      }
    }
    if(magical&&attacker.passives?.generic){
      const ranged=attacker.passives.generic.flatMap(item=>item.effects||[]).filter(effect=>effect.type==='rangeDamageBonus'&&distance(attacker,target)>effect.radius);
      if(ranged.length)raw*=1+ranged.reduce((sum,e)=>sum+Number(e.amount||0),0)/100;
    }
    if(options.allowCritical!==false&&!basic&&magical&&attacker.magicCritChance>0&&!buildingKinds.has(target.kind)&&this.random()<attacker.magicCritChance/100){
      magicCritical=true;raw*=Math.max(1,(attacker.magicCritDamage||200)/100);
    }
    const multiplier=physical&&options.ignoreArmor===true?1:physical?resistanceMultiplier(Math.max(0,(target.armor||0)+(target.equipmentArmorBonus||0)-(target.equipmentArmorReduction||0)),(a[106]||0)+(attacker.equipmentPenetrationBonus||0),a[108]||0,target.unpenetrableArmor||0)
      :magical?resistanceMultiplier(Math.max(0,(target.magicResistance||0)+(target.equipmentMagicResistanceBonus||0)-(target.equipmentMagicResistanceReduction||0)),a[107]||0,a[109]||0,target.unpenetrableMR||0):1;
    // Local damage policy: typed skill bonuses are percentage points. They are
    // accumulated with their other sources before being applied here.
    if(!basic&&!options.deferred){
      const typed=physical||magical?a[physical?147:149]||0:0;
      raw*=Math.max(0,1+(typed+(attacker.effectModifiers?.skillSurge||0))/100);
    }
    const reduction=(physical||magical)?clamp(t[physical?148:150]||0,0,100):0;
    const immunity=(physical||magical)?clamp(t[physical?151:152]||0,0,100):0;
    const soulChannel=options.warSoulProc?warSoulEntries.channels(options.element):null;
    const soul=options.deferred?1:soulChannel?warSoulMultiplier(Number(attacker.warSoul?.restraint?.[soulChannel.restraint]||0),Number(target.warSoul?.resistance?.[soulChannel.resistance]||0)):(options.element
      ?warSoulElementMultiplier(attacker.warSoul||{},target.warSoul||{},options.element)
      :warSoulMultiplier(attacker.warSoul?.averageRestraint,target.warSoul?.averageResistance));
    const trueBonus=basic?(options.movementDamage??this.movementDamage(attacker))*progressionDamage.masterMultiplier:0;
    const temporaryReduction=target.buffs?.reduce((max,b)=>Math.max(max,type==='physical'?Number(b.damageReductionPhysical||0):type==='magic'?Number(b.damageReductionMagic||0):0),0)||0;
    const buffDamageBonus=attacker.buffs?.reduce((sum,b)=>sum+Number(b.damageBonus||0),0)||0;
    const receivedVulnerability=target.buffs?.reduce((sum,b)=>sum+Number(b.damageTakenPercent||0),0)||0;
    const soulEntryMultiplier=options.deferred?1:warSoulEntries.damageMultiplier(attacker,target);
    const generic=options.deferred?1:Math.max(0,1+((a[95]||0)+buffDamageBonus)/100)*(1+Math.max(0,receivedVulnerability)/100)*(1-clamp(Math.max(t[96]||0,temporaryReduction),0,100)/100)*(attacker.effectModifiers?.damageMultiplier??1)*soulEntryMultiplier;
    const basicReduction=basic&&!buildingKinds.has(target.kind)?Math.max(0,...(target.passives?.generic||[]).flatMap(item=>(item.effects||[]).filter(f=>f.type==='basicDamageReduction').map(f=>f.amount||0))):0;
    const typedDamage=raw*multiplier*(1-immunity/100)*(1-reduction/100)*(1-clamp(basicReduction,0,100)/100)*soul*generic;
    const trueDamage=trueBonus*soul*generic;
    let calculatedDamage=typedDamage+trueDamage;
    let delayedEquipmentDamage=0, delayedEquipmentEffect=null;
    if(!options.deferred&&target.passives?.generic){
      delayedEquipmentEffect=target.passives.generic.flatMap(item=>item.effects||[]).find(effect=>effect.type==='delayedDamageReduction'&&calculatedDamage>effect.threshold);
      if(delayedEquipmentEffect){
        delayedEquipmentDamage=calculatedDamage*Math.max(0,Math.min(100,delayedEquipmentEffect.amount||0))/100;
        calculatedDamage=Math.max(0,calculatedDamage-delayedEquipmentDamage);
      }
    }
    let received=Math.max(0,Math.floor(calculatedDamage+1e-9));
    let guardOwner=null,guardLife=null,sharedDamage=0;
    const guardLink=target.guardian;
    if(received>0&&guardLink&&guardLink.until>this.time){
      guardOwner=this.entities.get(guardLink.ownerId);
      if(guardOwner?.alive&&guardOwner.id!==target.id&&guardOwner.team===target.team&&distance(guardOwner,target)<=900){
        guardLife=guardOwner.reviveCount;
        sharedDamage=Math.min(received,Math.floor(received*Math.max(0,Math.min(100,guardLink.percent||0))/100));
        received-=sharedDamage;
      }else target.guardian=null;
    }
    // Bind the recipient before any synchronous damage observer can revive or
    // replace it. An old split must never be charged to another life.
    const guardCurrent=()=>this.entities.get(guardOwner?.id)===guardOwner&&guardOwner?.reviveCount===guardLife;
    const totalBeforeAbsorb=received,trueBeforeAbsorb=Math.min(received,Math.floor(trueDamage+1e-9));
    const heroDecision=this.heroes.beforeDamage(target,attacker,{received,type,skillId,basic,
      deferred:!!options.deferred,critical,magicCritical});
    // Sharing already used the protected actor's mitigation. Keep the
    // established split, but apply the recipient's hero rule before HP/shield
    // mutations so an invalid decision cannot partially change HP or shields.
    const sharedDecision=guardOwner&&sharedDamage>0?this.heroes.beforeDamage(guardOwner,attacker,
      {received:sharedDamage,type,skillId,basic:false,deferred:true,shared:true,sharedFromId:target.id,critical,magicCritical}):null;
    received=Math.max(0,Math.floor(warSoulCombat.reduceIncoming(this,target,attacker,heroDecision.received,{deferred:!!options.deferred,type,skillId,basic})+1e-9));
    let absorbed=heroDecision.absorbed,blocked=heroDecision.blocked;
    if(received>0&&this.guardActive(target)){
      const g=target.guard;
      if(this.time>=g.windowUntil&&g.remaining>0){g.remaining--;g.windowUntil=this.time+.2;}
      if(this.time<g.windowUntil){absorbed+=received;received=0;blocked=true;}
    }
    if(received>0&&target.shield>0){
      const shieldAbsorbed=Math.min(received,target.shield);received-=shieldAbsorbed;absorbed+=shieldAbsorbed;
      const summonerAbsorbed=summoners.absorbShield(this,target,shieldAbsorbed);
      const soulAbsorbed=target.soulShield?Math.min(Math.max(0,target.soulShield.remaining),shieldAbsorbed-summonerAbsorbed):0;
      if(target.soulShield)target.soulShield.remaining-=soulAbsorbed;
      // Preserve the existing summoner -> drink shield order. Damage already
      // charged to either source cannot also spend the magic114 shield.
      const remainingAbsorbed=shieldAbsorbed-summonerAbsorbed-soulAbsorbed;
      this.setShield(target,target.shield-shieldAbsorbed);
      const warSoulAbsorbed=warSoulCombat.onShieldAbsorbed(this,target,remainingAbsorbed);
      const magicAbsorbed=remainingAbsorbed-warSoulAbsorbed;
      const magicGemShield=target.buffs?.find(b=>b.magicGemShieldHeal&&b.until>this.time);
      if(magicGemShield&&magicAbsorbed>0){
        const restore=Math.min(magicAbsorbed,Math.max(0,Number(magicGemShield.magicGemShieldHealRemaining??magicAbsorbed)));
        if(restore>0){magicGemShield.magicGemShieldHealRemaining=Math.max(0,Number(magicGemShield.magicGemShieldHealRemaining??magicAbsorbed)-restore);this.heal(target,restore,{reason:'magic-gem-shield'});}
        if(magicGemShield.magicGemShieldHealRemaining<=0||target.shield<=0)target.buffs=target.buffs.filter(b=>b!==magicGemShield);
      }
    }
    if(!options.deferred&&target.passives?.blood&&received>target.hpMax*.05){
      const stored=Math.floor(received*clamp(t[97]||0,0,100)/400);
      if(stored>0){
        received-=stored;
        this.queueDeferredDamage(attacker,target,stored,this.time+3);
        this.event('passive',{id:target.id,effect:'blood-deferred',amount:stored,dueAt:this.time+3});
      }
    }
    const displayAmount=received,amount=Math.min(target.hp,received);
    if(delayedEquipmentDamage>0)this.queueDeferredDamage(attacker,target,Math.floor(delayedEquipmentDamage),this.time+(delayedEquipmentEffect.delay||2));
    // Preserve one HP/shield/life-steal transaction, but display the moving
    // shoes proc as true damage instead of falsely labelling it physical.
    const trueDisplay=totalBeforeAbsorb>0?Math.min(received,Math.floor(received*trueBeforeAbsorb/totalBeforeAbsorb+1e-9)):0;
    const components=trueBonus>0?[
      {damageType:type,displayAmount:received-trueDisplay,critical,skillId},
      {damageType:'true',displayAmount:trueDisplay,critical:false,skillId}
    ].filter(c=>c.displayAmount>0):undefined;
    target.hp-=amount;
    require('./equipment-dynamic-passives').onCommittedDamage(this,target,attacker,{amount,life:targetLife});
    const committedHP=target.hp;
    const progression=require('./battle-progression-effects');
    if(sourceCurrent()&&targetCurrent())progression.onCommittedDamage(this,attacker,target,{amount,attackerLife,
      commitId:'damage:'+(this.progressionDamageId=(this.progressionDamageId||0)+1)});
    if(targetCurrent()&&target.alive&&target.hp>0)progression.onDamageTaken(this,target,attacker,{amount,life:targetLife});
    if(amount>0&&attacker.kind==='hero'&&target.kind==='hero'&&!options.deferred){
      target.damageContributors??=new Map();
      target.damageContributors.set(attacker.id,this.time);
    }
    if(guardOwner&&sharedDamage>0&&guardCurrent()&&guardOwner.alive){
      const guardBefore=guardOwner.hp;guardOwner.hp=Math.max(0,guardOwner.hp-sharedDecision.received);
      const guardLoss=guardBefore-guardOwner.hp;
      require('./equipment-dynamic-passives').onCommittedDamage(this,guardOwner,attacker,{amount:guardLoss,life:guardLife});
      if(guardLoss>0&&attacker.kind==='hero'&&guardOwner.kind==='hero'&&!options.deferred){
        guardOwner.damageContributors??=new Map();
        guardOwner.damageContributors.set(attacker.id,this.time);
      }
      if(sourceCurrent()&&guardCurrent())progression.onCommittedDamage(this,attacker,guardOwner,{amount:guardLoss,attackerLife,
        commitId:'shared-damage:'+(this.progressionDamageId=(this.progressionDamageId||0)+1)});
      if(guardCurrent()&&guardOwner.alive&&guardOwner.hp>0)progression.onDamageTaken(this,guardOwner,attacker,{amount:guardLoss,life:guardLife});
      this.matchStats?.recordDamage(attacker,guardOwner,guardLoss,this.time);
      this.event('damage-share',{attacker:attacker.id,target:target.id,guard:guardOwner.id,amount:guardLoss,
        displayAmount:sharedDecision.received,absorbed:sharedDecision.absorbed,blocked:sharedDecision.blocked,percent:guardLink.percent});
      // Shared damage used to flip the guardian's alive bit directly.  That
      // skipped the normal death lifecycle: no respawnAt was scheduled, no
      // death event reached the native adapter, and the guardian stayed dead
      // forever.  Run the same lifecycle as a direct lethal hit while keeping
      // the protected target's damage transaction intact.
      if(guardCurrent()&&guardOwner.alive&&guardOwner.hp<=0){
        const equipment=require('./equipment-dynamic-passives');
        const prevented=equipment.onDeath(this,guardOwner,attacker);
        if(!prevented&&guardCurrent()&&guardOwner.alive&&guardOwner.hp<=0){
          this.cancelChannel(guardOwner,'death');
          guardOwner.alive=false;guardOwner.deaths=(guardOwner.deaths||0)+1;
          warSoulCombat.onDeath(this,guardOwner);
          guardOwner.targetId=null;guardOwner.path=[];guardOwner.motionGoal=null;
          guardOwner.guardianTargetId=null;if(target.guardian===guardLink)target.guardian=null;
          guardOwner.guard=null;guardOwner.controlUntil=0;guardOwner.lastMovedAt=-Infinity;
          this.setShield(guardOwner,0);
          guardOwner.soulShield=null;
          this.deferredDamage=this.deferredDamage.filter(d=>d.target!==guardOwner.id);
          if(guardOwner.kind==='hero')guardOwner.respawnAt=this.time+this.respawnDelay;
          require('./battle-progression-effects').onCommittedDeath(this,guardOwner,{life:guardLife});
          if(attacker.kind==='hero'&&guardOwner.kind==='hero')attacker.kills++;
          for(const contributorId of guardOwner.damageContributors?.keys?.()||[]){
            const contributor=this.entities.get(contributorId);
            if(contributor?.alive&&contributor.team===attacker.team)equipment.onAssist?.(this,contributor,guardOwner,attacker);
          }
          if(sourceCurrent())equipment.onKill(this,attacker,guardOwner);
          guardOwner.damageContributors=new Map();
          const reward=guardOwner.reward||0;attacker.gold+=reward;
          this.matchStats?.recordDeath(attacker,guardOwner,reward,this.time);
          this.onSoulDeath?.(attacker,guardOwner);
          summoners.onDeath(this,guardOwner);
          if(sourceCurrent()&&attacker.kind==='hero'&&guardOwner.kind==='hero')summoners.onKill(this,attacker);
          this.heroes.onDeath(attacker,guardOwner,{attackerLife,targetLife:guardLife,sourceCurrent:!!sourceCurrent()});
          this.event('death',{id:guardOwner.id,killer:attacker.id,kind:guardOwner.kind,shared:true,hp:0});
        }
      }
    }
    const skillLevel=options.skillLevel||Object.values(attacker.skills||{}).find(skill=>skill.id===skillId)?.level||1;
    this.event('damage',{attacker:attacker.id,target:target.id,amount,displayAmount,hp:committedHP,attackerLife,targetLife,skillId,skillLevel,shotId,origin,critical,absorbed,blocked,deferred:!!options.deferred,
      nativeHitEffectFlag:options.nativeHitEffectFlag,nativeHitPosition:options.nativeHitPosition,
      damageType:type,critical:critical||magicCritical,magicCritical,components,calculation:{criticalDamage:a[25]??200,magicCriticalDamage:attacker.magicCritDamage||200,raw,multiplier,immunity,reduction,trueBonus,soul,generic,typedDamage,trueDamage,calculatedDamage}});
    if(!options.equipmentProc&&!options.deferred)
      require('./equipment-dynamic-passives').onDamageTaken(this,target,attacker,{amount,basic});
    if(amount>0&&attacker.kind==='hero'&&target.buffs?.some(b=>b.cancelOnHeroDamage)){
      target.buffs=target.buffs.filter(b=>!b.cancelOnHeroDamage);
      this.updateBuffs(target);
      this.event('buff-cancel',{id:target.id,reason:'hero-damage'});
    }
    this.matchStats?.recordDamage(attacker,target,amount,this.time);
    if(sourceCurrent()&&targetCurrent())warSoulCombat.onDamage(this,attacker,target,{amount,basic,skillId,type,
      deferred:!!options.deferred,equipmentProc:!!options.equipmentProc,equipmentProcs:options.equipmentProcs!==false,warSoulProc:!!options.warSoulProc});
    this.heroes.onDamage(attacker,target,{amount,critical,skillId,type,basic,attackerLife,targetLife,landed:true,displayAmount,absorbed,blocked,equipmentProcs:options.equipmentProcs!==false,equipmentProc:!!options.equipmentProc});
    if(sourceCurrent()&&targetCurrent()&&options.equipmentProcs!==false&&!options.deferred&&attacker.kind==='hero'&&!buildingKinds.has(target.kind)&&(basic||type!=='true')){
      const lifeStealReduction=attacker.buffs?.reduce((sum,b)=>sum+Number(b.lifeStealReduction||0),0)||0;
      const rate=clamp((a[basic?97:98]||0)*(1-clamp(lifeStealReduction,0,100)/100),0,100);
      const stolen=Math.floor(amount*rate/100);
      this.heal(attacker,stolen,{skillId,skillLevel,reason:basic?'life-steal':'spell-vamp'});
      if(basic&&sourceCurrent())require('./equipment-soul').drainShield(this,attacker,stolen);
    }
    if(sourceCurrent()&&targetCurrent()&&options.equipmentProcs!==false&&basic&&attacker.passives?.sword&&critical){
      attacker.buffs=attacker.buffs.filter(b=>b.slot!=='equipment:sword-crit');
      attacker.buffs.push({slot:'equipment:sword-crit',until:this.time+3,attackSpeed:10+attacker.passives.sword.level});
      this.updateBuffs(attacker);
    }
    if(basic){
      if(sourceCurrent()&&targetCurrent()&&options.equipmentProcs!==false)require('./battle-progression-effects').onBasicHit(this,attacker,target,{amount,attackerLife});
      if(sourceCurrent()&&targetCurrent()&&options.equipmentProcs!==false)require('./equipment-dynamic-passives').onBasicHit(this,attacker,target,{amount,critical,criticalDamage,wasFullHP});
      if(sourceCurrent()&&targetCurrent())summoners.onBasicHit(this,attacker,target);
      if(sourceCurrent()&&targetCurrent())this.heroes.onBasicHit(attacker,target,{amount,critical,attackerLife,targetLife});
    }
    // Attacking a hero in a tower's protection range draws tower aggro.
    if(!this.heroes.closed&&sourceCurrent()&&targetCurrent()&&attacker.kind==='hero'&&target.kind==='hero')for(const tower of this.entities.values()) {
      if(tower.kind==='tower'&&tower.alive&&tower.team===target.team&&distance(tower,attacker)<=tower.range) {
        tower.targetId=attacker.id;tower.aggroUntil=this.time+3;
      }
    }
    if(targetCurrent()&&target.alive&&target.hp===0) {
      if(require('./equipment-dynamic-passives').onDeath(this,target,attacker))return amount;
      this.cancelChannel(target,'death');
      target.alive=false;target.deaths++;target.targetId=null;target.path=[];target.motionGoal=null;
      warSoulCombat.onDeath(this,target);
      target.guard=null;target.controlUntil=0;target.lastMovedAt=-Infinity;this.setShield(target,0);
      target.soulShield=null;
      this.deferredDamage=this.deferredDamage.filter(d=>d.target!==target.id);
      if(target.kind==='hero')target.respawnAt=this.time+this.respawnDelay;
      require('./battle-progression-effects').onCommittedDeath(this,target,{life:targetLife});
      if(attacker.kind==='hero'&&target.kind==='hero')attacker.kills++;
      const equipment=require('./equipment-dynamic-passives');
      for(const contributorId of target.damageContributors?.keys?.()||[]){
        const contributor=this.entities.get(contributorId);
        if(contributor?.alive&&contributor.team===attacker.team)equipment.onAssist?.(this,contributor,target,attacker);
      }
      if(sourceCurrent())equipment.onKill(this,attacker,target);
      target.damageContributors=new Map();
      const goldAwarded=target.reward||0;
      attacker.gold+=goldAwarded;
      this.matchStats?.recordDeath(attacker,target,goldAwarded,this.time);
      this.onSoulDeath?.(attacker,target);
      summoners.onDeath(this,target);
      if(sourceCurrent()&&attacker.kind==='hero'&&target.kind==='hero')summoners.onKill(this,attacker);
      this.heroes.onDeath(attacker,target,{attackerLife,targetLife,sourceCurrent:!!sourceCurrent()});
      this.event('death',{id:target.id,killer:attacker.id,kind:target.kind});
      if(target.kind==='base') {
        this.winner=attacker.team;
        this.matchStats?.finish(this.winner,this.time,this.entities);
        this.event('victory',{team:this.winner});
      }
    }
    return amount;
  }
  skillDamage(attacker,target,raw,skillId,type='physical',origin,options={}){
    if(!Number.isInteger(skillId)||skillId<=0||skillId>65535||options.basic)return 0;
    const attackerLife=attacker?.reviveCount,targetLife=target?.reviveCount;
    const amount=this.damage(attacker,target,raw,skillId,type,undefined,origin,options);
    if(amount>0&&options.equipmentProcs!==false&&!options.equipmentProc&&!options.deferred&&attacker?.alive&&this.entities.get(attacker.id)===attacker&&attacker.reviveCount===attackerLife&&this.entities.get(target?.id)===target&&target.reviveCount===targetLife)
      require('./equipment-dynamic-passives').onSkillHit(this,attacker,target,{amount,raw,skillId,damageType:type});
    return amount;
  }
  chooseTarget(e) {
    if(e.kind==='tower'&&e.aggroUntil!==undefined&&e.aggroUntil<=this.time){e.targetId=null;delete e.aggroUntil;}
    const old=this.entities.get(e.targetId);
    if(old&&this.enemies(e,old)&&distance(e,old)<=(e.kind==='tower'?e.range:e.acquireRange))return old;
    e.targetId=null;
    const candidates=[...this.entities.values()].filter(t=>this.enemies(e,t)&&distance(e,t)<=(e.kind==='tower'?e.range:e.acquireRange));
    candidates.sort((a,b)=>{
      if(e.kind==='tower') {const priority=t=>t.kind==='minion'?0:t.kind==='hero'?1:2;const n=priority(a)-priority(b);if(n)return n;}
      return distance(e,a)-distance(e,b)||a.id-b.id;
    });
    if(candidates[0])e.targetId=candidates[0].id;
    return candidates[0];
  }
  recoverHero(e,step){
    if(e.kind!=='hero')return;
    const fountain=[...this.entities.values()].find(f=>f.kind==='fountain'&&f.team===e.team&&f.alive&&distance(e,f)<=(f.recoveryRadius||0));
    if(!fountain&&!(e.attributes?.[12]>0)&&!(e.attributes?.[13]>0)&&!(e.equipmentManaRegenRatio>0))return;
    const beforeHP=e.hp,beforeMP=e.mp;
    const soulRecovery=1+warSoulCombat.healingBonus(this,e,e)/100;
    const healingReduction=clamp(Math.max(Number(e.equipmentHealingReduction)||0,...e.buffs.map(b=>Number(b.healingReduction)||0)),0,100);
    e.recoveryHP=(e.recoveryHP||0)+(Math.max(0,e.attributes?.[12]||0)/5+e.hpMax*(fountain?.hpRecovery||0))*step*soulRecovery*(1-healingReduction/100);
    const equipmentMana=Math.max(0,e.equipmentManaRegenRatio||0)*Math.max(0,e.mpMax-(e.mp||0));
    e.recoveryMP=(e.recoveryMP||0)+(Math.max(0,e.attributes?.[13]||0)/5+e.mpMax*(fountain?.mpRecovery||0)+equipmentMana)*step;
    const hp=Math.floor(e.recoveryHP+1e-9),mp=Math.floor(e.recoveryMP+1e-9);
    e.recoveryHP=Math.max(0,e.recoveryHP-hp);e.recoveryMP=Math.max(0,e.recoveryMP-mp);
    e.hp=Math.min(e.hpMax,e.hp+hp);e.mp=Math.min(e.mpMax,e.mp+mp);
    if(e.hp!==beforeHP||e.mp!==beforeMP){summoners.onHeal(this,e,e.hp-beforeHP);this.event('heal',{id:e.id,hp:e.hp,mp:e.mp,amount:e.hp-beforeHP,silent:true,reason:'regeneration'});}
  }
  stepToward(e,p,dt,stop=0) {
    if(e.routeRetryAt>this.time)return;
    const d=distance(e,p);if(d<=stop+1e-6)return;
    const goal={x:e.x+(p.x-e.x)*(d-stop)/d,z:e.z+(p.z-e.z)*(d-stop)/d};
    if(!e.motionGoal||!e.navigation?.length||distance(e.motionGoal,goal)>0.5) {
      const points=this.planRoute(e,goal);if(!points){this.stopMotion(e);return;}
      this.setRoute(e,points,goal);
    }
    let left=e.speed*dt,replanned=false;
    while(left>1e-9&&e.navigation?.length){
      const next=e.navigation[0],length=distance(e,next);
      if(length<1e-9){e.navigation.shift();continue;}
      const step=Math.min(length,left),dx=(next.x-e.x)/length,dz=(next.z-e.z)/length;
      const candidate={x:e.x+dx*step,z:e.z+dz*step};
      const circles=this.blockers(e),terrainClear=!this.terrain||this.terrain.segment(e,candidate,e.bodyRadius||0);
      if(!navigation.segmentClear(e,candidate,circles)||!terrainClear){
        const onlyMobile=terrainClear&&navigation.segmentClear(e,candidate,circles.filter(c=>c.static));
        if(onlyMobile&&!replanned){
          replanned=true;const points=this.planRoute(e,goal);
          if(points?.length){this.setRoute(e,points,goal);continue;}
        }
        if(onlyMobile){e.routeRetryAt=this.time+.1;return;}
        this.stopMotion(e);e.routeRetryAt=this.time+.25;return;
      }
      e.x+=dx*step;e.z+=dz*step;left-=step;
      e.lastMovedAt=this.time;this.updateBuffs(e);
      this.event('position',{id:e.id,x:e.x,z:e.z,dx,dz});
      if(step>=length-1e-9)e.navigation.shift();
    }
  }
  planRoute(e,goal){
    return motion.planRoute(this,e,goal);
  }
  blockers(e){
    return motion.blockers(this,e);
  }
  freeSpawn(origin,radius,ignoreId){
    const occupied=[...this.entities.values()].filter(o=>o.id!==ignoreId&&collidable(o));
    for(let ring=0;ring<40;ring++)for(let i=0;i<(ring?ring*8:1);i++){
      const angle=i*Math.PI*2/(ring*8||1),r=ring*(radius*2+.08);
      const p={x:origin.x+Math.cos(angle)*r,z:origin.z+Math.sin(angle)*r};
      if(point(p)&&(!this.terrain||this.terrain.clear(p,radius))&&occupied.every(o=>distance(p,o)>=radius+o.bodyRadius+.04))return p;
    }
    throw new Error('No free minion spawn location');
  }
  setRoute(e,points,goal){
    e.motionGoal={...goal};e.navigation=points.map(p=>({...p}));
    e.motionArrival={...(points.arrival||points.at(-1))};e.motionWaitingForMobile=!!points.waitingForMobile;
    if(e.motionWaitingForMobile&&points.every(p=>distance(e,p)<1e-6))e.routeRetryAt=this.time+.1;
    this.event('path',{id:e.id,path:[{x:e.x,z:e.z},...points]});
  }
  stopMotion(e) {
    e.navigation=null;e.motionArrival=null;e.motionWaitingForMobile=false;
    if(e.motionGoal){e.motionGoal=null;this.event('path',{id:e.id,path:[{x:e.x,z:e.z}]});}
  }
  spawnWave() {
    this.wave++;
    for(const lane of this.lanes)for(const member of lane.members) {
      while(this.entities.has(this.nextId))this.nextId++;
      const spawn=this.freeSpawn(lane.path[0],member.bodyRadius||0);
      const e=this.add({...member,id:this.nextId++,...spawn,team:lane.team,
        path:lane.path.slice(1),lane:lane.id,hp:member.hpMax,kind:'minion'});
      this.event('spawn',{id:e.id,lane:lane.id,team:e.team,wave:this.wave});
    }
  }
  tick(dt) {
    if(!Number.isFinite(dt)||dt<0||dt>5)throw new Error('Invalid time step');
    if(this.heroes.closed)return;
    // Fixed maximum integration step keeps attack cadence and collision/range
    // decisions independent of network timer jitter.
    let left=dt;
    while(left>1e-9&&this.winner===null) {
      const step=Math.min(left,0.05);left-=step;this.time+=step;
      require('./battle-bot-ai').tick(this);
      while(this.time+1e-9>=this.nextWave) {this.spawnWave();this.nextWave+=this.waveInterval;}
      this.tickFields();
      for(const e of this.entities.values())if(e.alive){
        summoners.tick(this,e,step);this.heroes.tick(e,step);
        const rate=summoners.modifiers(this,e).cooldownRate||0;
        if(rate>0){
          const managed=this.heroes.reduceExtraCooldowns(e,step,rate);
          for(const [slot,ready]of Object.entries(e.cooldowns))if(!managed.has(slot)&&ready>this.time&&e.skills[slot]&&!e.skills[slot].summoner&&!e.skills[slot].equipment)
            e.cooldowns[slot]=Math.max(this.time,ready-step*rate);
          if((e.cooldownSyncAt||0)<=this.time){
            for(const [slot,readyAt]of Object.entries(e.cooldowns))if(readyAt>this.time&&e.skills[slot]&&!e.skills[slot].summoner&&!e.skills[slot].equipment)
              this.event('skill-cooldown',{id:e.id,skill:e.skills[slot],readyAt});
            e.cooldownSyncAt=this.time+.25;
          }
        }
      }
      const due=this.deferredDamage.filter(d=>d.at<=this.time+1e-9);
      this.deferredDamage=this.deferredDamage.filter(d=>d.at>this.time+1e-9);
      for(const d of due){
        const a=this.entities.get(d.attacker),t=this.entities.get(d.target);
        const binding=deferredDamageBindings.get(d);
        if(binding?.sim===this&&binding.attacker===a&&binding.target===t&&a&&t?.alive&&t.reviveCount===d.life)this.damage(a,t,d.amount,0,'true',undefined,undefined,{deferred:true});
      }
      this.shots=this.shots.filter(shot=>{
        if(cancelledBasicShots.has(shot))return false;
        const actors=this.basicShotActors(shot),a=actors?.attacker,t=actors?.target;
        if(!a||!t&&!(shot.brsPiercing&&shot.launched)){
          this.basicShotEvent('attack-cancel',shot,{id:shot.id,skillId:shot.skillId,shotId:shot.shotId,launched:shot.launched});return false;
        }
        if(!shot.launched&&this.time+1e-9>=shot.launchAt){shot.launched=true;shot.origin={x:t.x,z:t.z};this.basicShotEvent('attack-launch',shot);}
        if(this.time+1e-9>=shot.hitAt){this.hitBasicShot(shot,a,t);return false;}
        return true;
      }).filter(shot=>!cancelledBasicShots.has(shot));
      this.objects.tick();this.vision.tick();require('./battle-ward').tick(this);
      for(const e of this.entities.values()) {
        if(!e.alive) {
          if(e.pendingEquipmentRevive&&this.time+1e-9>=e.pendingEquipmentRevive.at){
            const pending=e.pendingEquipmentRevive,origin={x:e.x,z:e.z},home=e.home;e.pendingEquipmentRevive=null;
            e.home=origin;this.revive(e);e.home=home;
            e.hp=Math.max(1,Math.min(e.hpMax,Math.floor(pending.heal>0?pending.heal:e.hpMax)));
            e.mp=Math.max(0,Math.min(e.mpMax||0,Math.floor(pending.mana>0?pending.mana:e.mpMax||0)));
            e.respawnAt=Infinity;this.updateBuffs(e);this.event('heal',{id:e.id,hp:e.hp,mp:e.mp,amount:0,reason:'equipment-revive'});
            continue;
          }
          if(e.kind==='hero'&&this.time>=e.respawnAt) {
            this.revive(e);
          }
          continue;
        }
        this.updateBuffs(e);
        this.recoverHero(e,step);
        if(e.testDummy||e.kind==='ward')continue;
        if(e.controlUntil>this.time||this.airborne(e))continue;
        if(!this.heroes.canAct(e,'move')&&!this.heroes.canAct(e,'attack'))continue;
        if(e.channel){
          const anchor=this.entities.get(e.channel.anchorId);
          if(!anchor?.alive||anchor.team!==e.team)this.cancelChannel(e,'anchor-lost');
          else if(this.time+1e-9>=e.channel.endsAt){
            const channel=e.channel,landing=this.freeSpawn(channel.aim||anchor,e.bodyRadius||0,e.id);
            e.x=landing.x;e.z=landing.z;e.channel=null;
            this.event('cast-complete',{id:e.id,...channel});
            this.event('position',{id:e.id,x:e.x,z:e.z,teleport:true});
          }
          continue;
        }
        if(e.kind==='fountain')require('./battle-bot-ai').fountain(this,e);
        if(['base','fountain','barracks'].includes(e.kind))continue;
        const taunt=this.taunted(e);if(taunt){e.targetId=taunt.tauntOwner.id;e.path=[];}
        else if(require('./battle-bot-ai').update(this,e,step))continue;
        // A chase update during prefire resets the native attack animation.
        // Explicit player orders may cancel prefire; AI movement waits for launch.
        if(this.shots.some(shot=>shot.id===e.id&&!shot.launched))continue;
        let t;
        if(e.kind==='hero') {t=this.entities.get(e.targetId);if(t&&!this.enemies(e,t)){e.targetId=null;t=null;}}
        else t=this.chooseTarget(e);
        if(t) {
          // Attack the target's body, not a dimensionless center. Navigate
          // slightly inside the range boundary so projected/rounded endpoints
          // cannot leave a stationary target permanently just out of range.
          const reach=e.range+(t.bodyRadius||0);
          if(distance(e,t)>reach+1e-6) {if(e.kind!=='tower'&&summoners.canAct(this,e,'move')&&!e.effectModifiers?.rooted)this.stepToward(e,t,step,Math.max(0,reach-.1));}
          if(distance(e,t)<=reach+1e-6&&this.time+1e-9>=e.attackAt) {
            if(!summoners.canAct(this,e,'attack'))continue;
            if(!this.heroes.canAct(e,'attack'))continue;
            this.stopMotion(e);
            const attackSkillId=this.heroes.basicAttackSkill(e,t);
            if(this.heroes.managesBasicAttack(e))e.attackSkillId=attackSkillId;
            const profile=e.attackProfiles?.[attackSkillId];
            const attackContext={attackerLife:e.reviveCount,targetLife:t.reviveCount};
            const empowerment=this.heroes.onAttackStart(e,t);
            this.heroes.notifyAttackStart(e,t,attackContext);
            // A genuine start observer can control, kill, revive or replace an
            // actor. Revalidate before creating a shot in its current life.
            if(this.entities.get(e.id)!==e||e.reviveCount!==attackContext.attackerLife||!e.alive||e.controlUntil>this.time||
              this.entities.get(t.id)!==t||t.reviveCount!==attackContext.targetLife||!this.enemies(e,t)||
              !summoners.canAct(this,e,'attack')||!this.heroes.canAct(e,'attack'))continue;
            const damage=e.attackDamage*(empowerment.damageMultiplier||1);
            e.attackAt=this.time+e.attackInterval;
            if(attackSkillId){
              const length=distance(e,t)||1,projectileSpeed=profile?.projectileSpeed??e.projectileSpeed,
                windup=profile?.attackWindup??e.attackWindup??0;
              const shot={id:e.id,target:t.id,skillId:attackSkillId,shotId:this.nextShot++,damage,
                forceCritical:empowerment.forceCritical,undodgeable:empowerment.undodgeable,
                brsPiercing:empowerment.brsPiercing,source:{x:e.x,z:e.z},
                direction:{x:(t.x-e.x)/length,z:(t.z-e.z)/length},pierceRange:e.range,
                movementDamage:this.movementDamage(e),
                launchAt:this.time+windup,hitAt:this.time+windup+(projectileSpeed?distance(e,t)/projectileSpeed:0)};
              basicShotBindings.get(this).set(shot,Object.freeze({attacker:e,target:t,attackerLife:e.reviveCount,targetLife:t.reviveCount}));
              this.basicShotEvent('prefire',shot);
              if(shot.hitAt>this.time)this.shots.push(shot);
              else{shot.launched=true;this.basicShotEvent('attack-launch',shot);this.hitBasicShot(shot,e,t);}
            }else {
              require('./battle-progression-effects').onCommittedAction(this,e,{committed:true,kind:'basic-attack',life:e.reviveCount,
                commitId:'melee:'+(this.progressionActionId=(this.progressionActionId||0)+1)});
              this.damage(e,t,damage,0,'physical',undefined,undefined,empowerment);
            }
          }
        } else if(e.kind!=='tower'&&e.pathIndex<e.path.length&&summoners.canAct(this,e,'move')&&!e.effectModifiers?.rooted) {
          const dest=e.path[e.pathIndex];
          // A lane waypoint is a navigation guide, not an exact formation slot.
          // Once the unit's body covers an intermediate waypoint, advance it;
          // otherwise several units can surround the same point forever.
          if((e.kind==='minion'||e.battleBot)&&e.pathIndex+1<e.path.length&&distance(e,dest)<=Math.max(.05,e.bodyRadius||0)+.02){
            e.pathIndex++;this.stopMotion(e);continue;
          }
          this.stepToward(e,dest,step);
          // A lane waypoint may be inside a friendly tower. The planner projects
          // it to a reachable edge; reaching that edge also completes the waypoint.
          if(distance(e,dest)<0.001||motion.arrived(e)){
            e.pathIndex++;this.stopMotion(e);
          }
        }
        if(this.winner!==null)break;
      }
    }
  }
  drainEvents(){const out=this.events;this.events=[];return out;}
}
module.exports={BattleSim,distance};
