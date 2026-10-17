'use strict';
const W=require('./battle-wire'),B=require('./battle-protocol'),N=require('./battle-native');
const {BattleSelection}=require('./battle-selection');
const selectionNative=require('./battle-selection-native');
const healingNative=require('./healing-native');
const {instantPosition}=require('./battle-position-native');

// Explicit phases prevent the recorded timer from choosing the hero or starting
// combat before the client has loaded. Callers supply bootstrap packets only;
// there is deliberately no replay stream or loop in this session.
class BattleSession {
  constructor({playerId,mapId,intro=[],bootstrap,createWorld,heroes,selectionConfig,now,send,authorizeEntry=()=>true,onSelectionState=()=>{},onSummonerSelection=()=>({ok:true}),onMatchResult=()=>{},onBattleOwnership=()=>{},resultPackets=require('./battle-result').runtimePackets,preparePackets=()=>[],readyPackets=()=>[],returnPackets=()=>[],returnOnDeferredResult=false}) {
    if(!Number.isInteger(playerId)||!Number.isInteger(mapId)||mapId<=0||!Array.isArray(heroes)||!heroes.length||typeof send!=='function'||!selectionConfig||
      typeof bootstrap!=='function'||typeof createWorld!=='function'||typeof onSelectionState!=='function'||typeof onMatchResult!=='function')throw new Error('Invalid session configuration');
    this.playerId=playerId;this.mapId=mapId;this.intro=intro;this.bootstrap=bootstrap;this.createWorld=createWorld;
    this.matchId=require('node:crypto').randomUUID();
    if(typeof authorizeEntry!=='function')throw Error('Invalid battle entry validator');this.authorizeEntry=authorizeEntry;
    this.heroes=new Set(heroes);this.send=packets=>{
 if(this.sim&&this.mapId===252){if(!this.view||this.view.sim!==this.sim)this.view=new(require('./battle-view').BattleView)(this.sim,this.playerId);packets=this.view.filter(packets,{playing:this.phase==='playing'});}
 if(packets.length)send(packets);
 };this.readyPackets=readyPackets;this.phase='connected';this.heroId=null;this.sim=null;this.notes=[];this.replayId=0;
    this.selection=new BattleSelection({...selectionConfig,heroes,now});
    if(typeof onSummonerSelection!=='function')throw Error('Invalid summoner selection callback');
    this.onSummonerSelection=onSummonerSelection;
    this.selectionResult=null;this.onSelectionState=onSelectionState;this.lastSelectionNotice=null;
    this.attackIds=new Map();
    this.clientRoutes=new Set();
    this.nativeSummoners=new Map();
    this.nativeProjectiles=[];this.nextProjectileId=0xffa00000;
    this.teleportNative=new(require('./battle-teleport-native').TeleportNative)(()=>{
      while(this.sim.entities.has(this.nextProjectileId))this.nextProjectileId++;
      return this.nextProjectileId++;
    });
    this.returnPackets=returnPackets;this.onMatchResult=onMatchResult;this.onBattleOwnership=onBattleOwnership;
    this.battleOwnershipActive=false;
    this.matchOutcome=null;this.matchResultPublished=false;
    this.preparePackets=preparePackets;
    this.resultPackets=resultPackets;
    if(typeof returnOnDeferredResult!=='boolean')throw Error('Invalid deferred-result return policy');
    this.returnOnDeferredResult=returnOnDeferredResult;
  }
  selectionNotice(phase,remainingSeconds,deadlineMs) {
    const previous=this.lastSelectionNotice;
    if(previous&&previous.phase===phase&&previous.remainingSeconds===remainingSeconds)return;
    this.lastSelectionNotice={phase,remainingSeconds};
    this.onSelectionState(Object.freeze({phase,remainingSeconds,deadlineMs,heroId:this.heroId}));
  }
  setBattleOwnership(active,reason) {
    active=!!active;
    if(this.battleOwnershipActive===active)return;
    this.battleOwnershipActive=active;
    try{this.onBattleOwnership({active,reason,playerId:this.playerId,mapId:this.mapId});}catch{}
  }
  advanceSelection() {
    if(this.phase!=='selecting'&&this.phase!=='preparing')return;
    const state=this.selection.tick();
    const events=this.selection.drainEvents();
    if(events.length){
      const final=events[0];
      if(this.selectionResult)return;
      let sim,packets;
      try {
        sim=this.createWorld(final.heroId,final.skills);
        const player=sim.entities.get(this.playerId);
        const participants=[...sim.entities.values()].filter(entity=>entity.kind==='hero').map(entity=>({
          playerId:entity.id,heroId:entity.heroId??(entity.id===this.playerId?final.heroId:0),team:entity.team,
          nameBytes:entity.nameBytes?Buffer.from(entity.nameBytes):undefined,
          summonerSkills:entity.id===this.playerId?{...final.skills}:{D:entity.skills?.D?.id??0,F:entity.skills?.F?.id??0},
        }));
        if(!participants.some(participant=>participant.playerId===this.playerId))participants.unshift({
          playerId:this.playerId,heroId:final.heroId,team:player?.team,summonerSkills:final.skills});
        sim.registerMatch({matchId:this.matchId,mapId:this.mapId,selfPlayerId:this.playerId,players:participants});
        packets=[...(final.reason==='timeout'?this.preparePackets(final.heroId,final.skills):[]),...this.bootstrap(final.heroId,final.skills,sim)];
      }
      catch(error){
        // The candidate world is not committed to this.sim until bootstrap
        // succeeds. Release its lifecycle explicitly if conversion rejects it.
        const failures=[];
        if(sim&&sim!==this.sim){
          try{sim.abortMatch?.('bootstrap-failed');}catch(cleanupError){failures.push(cleanupError);}
          try{sim.heroes?.close();}catch(cleanupError){failures.push(cleanupError);}
        }
        try{this.close();}catch(cleanupError){failures.push(cleanupError);}
        if(failures.length)throw new AggregateError([error,...failures],'Battle bootstrap and cleanup failed',{cause:error});
        throw error;
      }
      this.selectionResult=final;this.heroId=final.heroId;this.sim=sim;
      this.phase='loading';this.send(packets);
      this.selectionNotice('loading',null,null);
      return;
    }
    this.selectionNotice(state.phase,state.remainingSeconds,state.deadlineMs);
  }
  chooseSummonerSkill(slot,id) {
    if(this.phase==='closed'||this.phase==='returning')return {ok:false,reason:'selection-closed'};
    return this.chooseSummonerSkills({[slot]:id});
  }
  chooseSummonerSkills(changes) {
    if(this.phase==='closed'||this.phase==='returning')return {ok:false,reason:'selection-closed'};
    const result=this.selection.chooseSkills(changes,{commit:skills=>this.onSummonerSelection({skills,mapId:this.mapId,phase:this.phase})});
    this.advanceSelection();
    return result;
  }
  publishMatchResult({allowReturn=true}={}) {
    const result=this.sim?.getMatchResult();
    if(!result||this.matchResultPublished)return;
    this.onMatchResult(result);
    this.matchResultPublished=true;
    this.matchOutcome=Object.freeze({status:'completed',reason:result.endReason,result});
    if(this.phase==='playing'){this.phase='finished';this.finishedElapsed=0;}
    const packets=this.resultPackets(result);
    if(packets.length)this.send(packets);
    else {
      this.notes.push({type:'native-result-deferred',reason:'result-field-contract-incomplete',matchId:result.matchId});
      // Completion is already recorded. An unavailable result page must not
      // leave the native client trapped in an inert finished battlefield.
      if(allowReturn&&this.returnOnDeferredResult&&this.phase==='finished') {
        const returned=this.returnToLobby();
        this.notes.push({type:'completed-match-return',matchId:result.matchId,close:returned.close});
      }
    }
  }
  returnToLobby() {
    if(this.phase==='returning')return {ok:true,close:false};
    if(this.phase==='closed')return {ok:true,close:true};
    this.selection.leave();this.selection.drainEvents();
    this.clearProjectiles();
    const packets=this.returnPackets();
    this.phase=packets.length?'returning':'closed';
    this.setBattleOwnership(false,'battle-return');
    this.attackIds.clear();
    if(packets.length)this.send(packets);
    this.selectionNotice(this.phase,null,null);
    // The verified 1022(map 1), then 1031 handoff keeps the socket alive
    // until the client closes it. Never replace this with an early TCP EOF.
    return {ok:true,close:!packets.length};
  }
  markIncomplete(reason) {
    if(this.matchOutcome)return;
    this.matchOutcome=this.sim?.abortMatch(reason)||Object.freeze({status:'incomplete',reason,battleDurationSeconds:0});
  }
  getMatchOutcome(){return this.matchOutcome;}
  close() {
    if(this.phase==='closed')return;
    this.setBattleOwnership(false,'battle-close');
    this.publishMatchResult({allowReturn:false});this.markIncomplete('disconnected');
    this.selection.close();this.selection.drainEvents();this.clearProjectiles();
    this.phase='closed';this.attackIds.clear();this.clientRoutes.clear();this.clearSettlement();
    this.selectionNotice('closed',null,null);
  }
  clearSettlement(){
    // Keep the immutable matchOutcome for logging/inspection, but release the
    // mutable simulation and native per-entity state once the socket leaves.
    try{this.sim?.heroes.close();}finally{
      this.sim=null;this.view=null;this.selectionResult=null;this.nativeSummoners.clear();this.nativeProjectiles=[];
    }
  }
  clearProjectiles(){
    const packets=this.nativeProjectiles.flatMap(state=>this.sim.heroes.finishProjectile(state));
    packets.push(...this.teleportNative.clear());
    this.nativeProjectiles=[];if(packets.length)this.send(packets);
  }
  receive(frame) {
    let req;try{req=B.readCommand(frame);}catch(error){return {ok:false,reason:error.message};}
    if(this.phase==='closed')return {ok:false,reason:'closed'};
    const tag=req.tag,p=frame.subarray(12);
    if(tag===23483||tag===23409){
      if(p.length)return {ok:false,reason:'invalid-leave'};
      if(this.phase==='returning')return {ok:true};
      if(!['selecting','preparing','loading','playing','finished'].includes(this.phase))return {ok:false,reason:'not-in-match'};
      this.publishMatchResult({allowReturn:false});this.markIncomplete('left');
      return this.returnToLobby();
    }
    this.advanceSelection();
    if(tag===1297){this.send([W.frame(1298,0)]);return {ok:true};}
    if(tag===1041) {
      if(p.length!==4)return {ok:false,reason:'invalid-entry'};
      if(this.phase==='connected'){
        if(!this.authorizeEntry(p.readUInt32LE(0)))return {ok:false,close:true,reason:'invalid-account-battle-ticket'};
        const entered=this.selection.enter();
        this.phase='selecting';this.send(this.intro);
        this.setBattleOwnership(true,'battle-entry');
        this.selectionNotice('selecting',entered.state.remainingSeconds,entered.state.deadlineMs);
      }
      return {ok:true};
    }
    if(tag===23438) {
      if(this.phase!=='selecting'||p.length!==2)return {ok:false,reason:'not-selecting'};
      const hero=p.readUInt16LE(0);
      const chosen=this.selection.chooseHero(hero);
      this.advanceSelection();
      if(!chosen.ok)return {ok:false,reason:chosen.reason==='unsupported-hero'?'hero-bootstrap-unavailable':chosen.reason};
      this.heroId=hero;
      const response=Buffer.alloc(8);response.writeUInt32LE(this.playerId);response.writeUInt16LE(hero,6);
      this.send([W.frame(23439,0,response)]);return {ok:true};
    }
    if(tag===11562) {
      if(p.length!==2||this.phase==='connected')return {ok:false,reason:'invalid-slot-query'};
      const response=Buffer.alloc(33);p.copy(response,0,0,2);this.send([W.frame(11563,0,response)]);return {ok:true};
    }
    if(tag===23436) {
      if(p.length!==2||p.readUInt16LE(0)!==this.heroId)return {ok:false,reason:'hero-not-selected'};
      const result=this.selection.confirm();
      this.phase=this.selection.phase==='preparing'?'preparing':this.phase;
      if(result.ok&&!result.repeated)this.send(this.preparePackets(this.heroId,this.selection.skills));
      this.advanceSelection();
      return result;
    }
    if(tag===23442){
      if(p.length!==4)return {ok:false,reason:'invalid-summoner-selection'};
      const result=this.chooseSummonerSkills({D:p.readUInt16LE(0),F:p.readUInt16LE(2)});
      // Echo the authoritative pair on rejection too, undoing optimistic UI edits.
      if(this.phase==='selecting'||this.phase==='preparing')this.send([selectionNative.skills(this.playerId,this.selection.skills)]);
      return result;
    }
    if(tag===1023){
      if(p.length)return {ok:false,reason:'invalid-load-complete'};
      if(this.phase!=='loading')return {ok:false,reason:'not-loading'};
      this.sim.beginMatch();this.phase='playing';this.send(this.readyPackets(this.sim));return {ok:true};
    }
    if(this.phase!=='playing')return {ok:false,reason:'not-playing'};
    if(tag===13502||tag===13504||tag===13546){
      const result=require('./battle-equipment').change(this.sim,this.playerId,tag,p);
      if(result.packets)this.send(result.packets);
      this.flush();return {ok:result.ok,reason:result.reason};
    }
    let result={ok:true};
    if(req.type==='move'||req.type==='cast'){
      const h=this.sim.entities.get(this.playerId);
      this.notes.push({type:'player-command',worldTime:this.sim.time,command:req.type,
        server:{x:h.x,z:h.z,speed:h.speed,alive:h.alive},
        requested:{x:req.x,z:req.z,dirX:req.dirX,dirZ:req.dirZ,skillId:req.skillId,targetId:req.targetId,repeat:req.repeat},
        previousGoal:h.motionGoal?{...h.motionGoal}:null});
    }
    if(req.type==='move')result=this.sim.move(this.playerId,{x:req.x,z:req.z});
    if(req.type==='equipment-cast'){
      const hero=this.sim.entities.get(this.playerId);
      const activation=require('./battle-equipment-command').resolveEquipmentCast(hero,req);
      result=activation.ok?this.sim.cast(this.playerId,activation.slot,activation.aim):activation;
      this.notes.push({type:'equipment-skill-command',slot:req.slot,result,
        guard:hero.guard?{...hero.guard}:undefined});
    }
    if(req.type==='cast') {
      if(req.playerId!==this.playerId)return {ok:false,reason:'wrong-player'};
      const hero=this.sim.entities.get(this.playerId);
      const target=this.sim.entities.get(req.targetId);
      if(target&&target.team!==hero.team&&!this.sim.vision.visibleToTeam(target,hero.team))return {ok:false,reason:'target-not-visible'};
      if(req.skillId===8034)result=require('./battle-ward').cast(this.sim,hero,req);
      else if(req.skillId===hero.attackSkillId||hero.attackProfiles?.[req.skillId]||hero.attackAliases?.includes(req.skillId))result=this.sim.attack(this.playerId,req.targetId,req.skillId);
      else {
        const entry=Object.entries(hero.skills).find(([,s])=>s.id===req.skillId||s.aliases?.includes(req.skillId));
        result=entry?this.sim.cast(this.playerId,entry[0],{x:req.x,z:req.z,targetId:req.targetId,dirX:req.dirX,dirZ:req.dirZ,requestedSkillId:req.skillId,nativePoint:true}):{ok:false,reason:'unknown-skill',skillId:req.skillId};
      }
    }
    if(req.type==='cast'&&!this.sim.entities.get(this.playerId).attackProfiles?.[req.skillId]){
      const h=this.sim.entities.get(this.playerId),s=h.blackRock;
      this.notes.push({type:'skill-command-result',skillId:req.skillId,result,
        skills:Object.fromEntries(Object.entries(h.skills).map(([slot,skill])=>[slot,skill.id])),
        blackRock:s?{hearts:s.hearts,qUntil:s.qUntil,blueUntil:s.blueUntil,
          secondReady:s.wSecondReady,forcedRemaining:s.forcedRemaining,r:s.r,
          penUntil:s.penUntil,pending:s.pending.map(item=>({skillId:item.skill.id,at:item.at}))}:undefined});
    }
    if(req.type==='slot'){
      const reply=this.sim.heroes.nativeCooldownState(this.sim.entities.get(this.playerId),req,this.playerId);
      if(reply)this.send([reply]);else result={ok:false,reason:'invalid-cooldown-state'};
    }
    this.flush();return result;
  }
  tick(dt){this.advanceSelection();if(this.phase==='finished'){this.finishedElapsed+=(Number.isFinite(dt)&&dt>0?dt:0);if(this.finishedElapsed>=90)this.returnToLobby();return;}if(this.phase!=='playing')return;this.sim.refreshLoadout?.();this.sim.tick(dt);this.flush();}
  flush() {
    const packets=[],positions=new Map(),vitals=new Map(),heals=new Map(),attackIds=this.attackIds,announcedDeaths=new Set(),announcedKills=new Set(),buildingDeaths=new Set();
    const events=this.sim.drainEvents(),shotHits=new Map(),sentShots=new Set();
    for(const e of events)if(e.type==='damage'&&e.shotId!==undefined){
      if(!shotHits.has(e.shotId))shotHits.set(e.shotId,[]);
      shotHits.get(e.shotId).push(e);
    }
    for(const e of events) {
      if(this.sim.heroes.isProjectileEvent(this.sim.entities.get(e.id),e)){
        while(this.sim.entities.has(this.nextProjectileId))this.nextProjectileId++;
        const native=this.sim.heroes.projectile(this.sim.entities.get(e.id),e,this.nextProjectileId++);
        if(native){packets.push(...native.packets);this.nativeProjectiles.push(native.state);}
      }
      if(e.type==='equipment-visuals')packets.push(...e.packets);
      if(e.type==='soul-change'){packets.push(...e.packets);this.notes.push({type:e.type,id:e.id,operation:e.operation});}
      if(e.type==='equipment-passive-attributes')packets.push(require('./battle-equipment').attributePacket(this.sim.entities.get(e.id)));
      if(e.type==='attack-stats'){
        const rows=[[15,e.attackSpeed],[16,Math.round(e.range*100)]];
        for(const [id,value] of [[30,e.attack],[127,e.extraAttack],[18,e.dodge]])if(value!==undefined)rows.push([id,value]);
        const p=Buffer.alloc(1+rows.length*5);p[0]=rows.length;
        rows.forEach(([id,value],i)=>{p[1+i*5]=id;p.writeUInt32LE(Math.round(value)>>>0,2+i*5);});
        packets.push(W.frame(1045,e.id,p));
      }
      if(e.type==='shield'){
        const p=Buffer.alloc(6);p[0]=1;p[1]=136;p.writeUInt32LE(e.amount,2);packets.push(W.frame(1045,e.id,p));
      }
      if(e.type==='passive')this.notes.push(e);
      if(e.type==='speed'){
        const p=Buffer.alloc(6);p[0]=1;p[1]=17;p.writeUInt32LE(e.percent,2);
        packets.push(W.frame(1045,e.id,p));
      }
      if(e.type==='damage') {
        if(e.attacker===this.playerId)this.notes.push({type:'combat-hit',worldTime:e.time,
          target:e.target,skillId:e.skillId,critical:e.critical,amount:e.amount,
          displayAmount:e.displayAmount,components:e.components,absorbed:e.absorbed,blocked:e.blocked,calculation:e.calculation});
        if(e.hp===0&&this.sim.entities.get(e.target)?.kind==='hero'){
          const victim=this.sim.entities.get(e.target),killer=this.sim.entities.get(e.attacker);
          if(killer?.kind==='hero'&&victim.team!==killer.team){
            packets.push(N.battleEvent({kind:2,killer:killer.id,victim:victim.id,eventCode:3}));
            announcedKills.add(victim.id);this.notes.push({type:'hero-kill',worldTime:this.sim.time,killer:killer.id,victim:victim.id});
          }
          packets.push(N.respawnTimer(e.target,this.sim.respawnDelay),N.death(e.target));announcedDeaths.add(e.target);
        }
        if(e.shotId===undefined||!sentShots.has(e.shotId)){
          packets.push(N.damage({...e,hits:shotHits.get(e.shotId),replayId:attackIds.get(e.shotId)??this.replayId++%256},this.sim.entities.get(e.attacker)));
          if(e.shotId!==undefined)sentShots.add(e.shotId);
        }
        for(const component of e.components||[e])if((component.displayAmount??component.amount)>0)
          packets.push(N.showDamage({...e,...component}));
        attackIds.delete(e.shotId);
        if(this.sim.entities.get(e.target)?.kind==='hero')packets.push(N.heroHP(e.target,e.hp));
      }
      if(e.type==='miss'){
        // Complete the projectile, keeping HP unchanged. No damage number,
        // life steal, combat damage statistic or critical proc is generated.
        packets.push(N.damage({...e,replayId:attackIds.get(e.shotId)??this.replayId++%256},this.sim.entities.get(e.attacker)));
        attackIds.delete(e.shotId);
        this.notes.push({type:'combat-miss',attacker:e.attacker,target:e.target,skillId:e.skillId});
      }
      if(e.type==='path'){
        const reset=this.clientRoutes.has(e.id);
        if(e.id===this.playerId)this.notes.push({type:'player-path',worldTime:e.time,points:e.path.map(p=>({...p})),reset});
        if(reset)packets.push(N.stop(e.id));
        if(e.path.length>1){packets.push(N.path(e.id,e.path));this.clientRoutes.add(e.id);}
        else {
          this.clientRoutes.delete(e.id);
          // A one-point path is the native stop acknowledgement emitted when
          // a cast, attack, or a replacement ground click cancels the current
          // route.  27112 already stops the client's interpolation queue;
          // sending 27114 here as well made every cast snap the model to the
          // server's slightly older position and skewed the next E/R aim.
        }
      }
      if(e.type==='prefire'){
        const actors=this.sim.basicShotActors(e,{allowDead:true});if(!actors?.target)continue;
        const {attacker,target}=actors,id=this.replayId++%256;
        attackIds.set(e.shotId,id);packets.push(N.prefire(attacker,target,e.skillId));
        if(e.id===this.playerId)this.notes.push({type:'attack-timing',worldTime:e.time,shotId:e.shotId,
          skillId:e.skillId,target:e.target,launchAt:e.launchAt,hitAt:e.hitAt,piercing:!!e.brsPiercing});
      }
      if(e.type==='skill-prefire'){
        const packet=N.skillPrefire(e,this.sim.entities.get(e.id),e.skill);if(packet)packets.push(packet);
      }
      if(e.type==='attack-launch'){
        const actors=this.sim.basicShotActors(e,{allowDead:true});if(!actors?.target)continue;
        const {attacker,target}=actors;
        packets.push(N.attackLaunch(attacker,target,e.skillId,attackIds.get(e.shotId),e.origin));
        while(this.sim.entities.has(this.nextProjectileId))this.nextProjectileId++;
        const native=this.sim.heroes.projectile(attacker,e,this.nextProjectileId,true);
        if(native){this.nextProjectileId++;packets.push(...native.packets);this.nativeProjectiles.push(native.state);}
      }
      if(e.type==='attack-cancel'){
        attackIds.delete(e.shotId);
        if(!e.launched&&e.id!==undefined&&e.skillId&&this.sim.basicShotActors(e)){
          const p=Buffer.alloc(2);p.writeUInt16LE(e.skillId);packets.push(W.frame(11034,e.id,p));
        }
      }
      if(e.type==='spawn') {
        const entity=this.sim.entities.get(e.id);
        if(entity.template){packets.push(N.spawn(entity.template,entity));if(entity.battleBot)packets.push(...require('./battle-test-dummies').packets(entity));}
        else this.notes.push({type:'missing-spawn-template',id:e.id});
      }
      // Ordinary walking is interpolated by the native client from 27105 paths.
      // Instant movement resets both logical position and model motion queues.
      // Verification 1136 does not immediately relocate the rendered model.
      if(e.type==='position'&&e.teleport){positions.set(e.id,e);this.clientRoutes.delete(e.id);}
      if(['cast','cast-cancel','cast-complete'].includes(e.type)) {
        const hero=this.sim.entities.get(e.id),skill=e.skill||hero?.skills[e.slot];
        // The native client installs the Q/W state before consuming the cast
        // reply.  In the original BRS captures this is observable as
        // 11007(12848/12855/12858) preceding 11031/11005.  Emit only these
        // state-machine transitions here; E/R have a different ordering
        // because their child projectile is prepared after the cast reply.
        packets.push(...this.sim.heroes.beforeNativeCast(hero,e,skill,{viewerId:this.playerId}));
        packets.push(...this.teleportNative.sync(this.sim));
        packets.push(...N.cast(e,hero,skill));
      }
      if(e.type==='skill-cooldown')packets.push(N.cooldown(e,this.sim.entities.get(e.id),e.skill));
      if(e.type==='ward-cast')packets.push(...N.cast(e,this.sim.entities.get(e.id),require('./battle-ward').skill));
      if(e.type==='ward-remove')packets.push(N.remove(e.id));
      if(e.type.startsWith('summoner-')||e.type.startsWith('brs-'))this.notes.push(e);
      if(e.type==='death') {
        this.clientRoutes.delete(e.id);
        const victim=this.sim.entities.get(e.id),killer=this.sim.entities.get(e.killer);
        if(victim?.kind==='hero'&&killer?.kind==='hero'&&victim.team!==killer.team&&!announcedKills.has(victim.id)){
          // Native map-252 sends the battle-event feed before the death timer;
          // this is what drives the in-match enemy-hero kill announcement.
          packets.push(N.battleEvent({kind:2,killer:killer.id,victim:victim.id,eventCode:3}));
          this.notes.push({type:'hero-kill',worldTime:this.sim.time,killer:killer.id,victim:victim.id});
        }
        if(!announcedDeaths.has(e.id)){
          if(e.kind==='hero')packets.push(N.respawnTimer(e.id,this.sim.respawnDelay));
          packets.push(N.death(e.id));
        }
        // A guardian can die from damage shared out of another hero's hit.
        // That path emits a lifecycle death event without a separate damage
        // event for the guardian, so publish the zero vitals explicitly.
        if(e.kind==='hero'&&e.shared)packets.push(N.heroHP(e.id,0));
        if(require('./battle-building-native').visible(victim?.monsterId)&&!buildingDeaths.has(e.id)){
          packets.push(require('./battle-building-native').death(victim));buildingDeaths.add(e.id);
        }
        if(e.kind==='base')packets.push(N.baseDestroyed(this.sim.entities.get(e.id)));
        if(e.kind==='minion')packets.push(N.remove(e.id));
      }
      if(e.type==='heal'||e.type==='hero-resource')vitals.set(e.id,e);
      if(e.type==='heal'&&!e.silent&&e.amount>0){
        // Multiple contacts in one simulation step share a single actual heal
        // number per source. Passive regeneration never enters this display.
        const key=`${e.id}:${e.skillId||0}:${e.skillLevel||1}`,previous=heals.get(key);
        heals.set(key,previous?{...previous,amount:previous.amount+e.amount}:e);
      }
      if(e.type==='respawn'){
        this.clientRoutes.delete(e.id);const hero=this.sim.entities.get(e.id);
        packets.push(...N.respawn(hero),...require('./equipment-visuals').packets(hero.id,hero.heroId,hero.equipmentVisuals||new Map(),new Map(),{force:true}));
      }
      // The native end-screen still needs its result record adapter.
      if(e.type==='victory')this.notes.push(e);
    }
    for(const e of positions.values())packets.push(instantPosition(e.id,e.x,e.z));
    for(const e of vitals.values()){const hero=this.sim.entities.get(e.id);packets.push(N.heroVitals(e.id,hero.hp,hero.mp));}
    for(const e of heals.values()){
      const packet=healingNative.healPacket(e);if(packet){
        packets.push(packet);if(e.id===this.playerId)this.notes.push({type:'combat-heal',worldTime:e.time,
          amount:e.amount,skillId:e.skillId,reason:e.reason});
      }
    }
    for(const hero of this.sim.entities.values())if(hero.kind==='hero'){
      packets.push(...this.sim.heroes.nativeSync(hero,{viewerId:this.playerId}));
      packets.push(...require('./war-soul-entry-native').sync(this.sim,hero));
      packets.push(...require('./equipment-active-native').sync(this.sim,hero));
      packets.push(...require('./battle-progression-native').sync(this.sim,hero));
      const vipPackets=require('./battle-vip-native').sync(this.sim,hero);
      packets.push(...vipPackets);if(vipPackets.length&&hero.alive)packets.push(require('./battle-equipment').attributePacket(hero));

    }
    for(const e of this.sim.entities.values())if(e.kind!=='hero'&&e.arthurAffected)packets.push(...this.sim.heroes.nativeSync(e,{viewerId:this.playerId}));
    for(const tower of this.sim.entities.values())if(tower.kind==='tower'){
      packets.push(...require('./battle-structure-native').sync(this.sim,tower));
      packets.push(...require('./battle-structure-native').syncRangeEffect(this.sim,tower,{viewerId:this.playerId}));
    }
    const channelAnchors=new Set([...this.sim.entities.values()].filter(e=>e.channel?.skillId===8026).map(e=>e.channel.anchorId));
    for(const id of this.nativeSummoners.keys())if(!this.sim.entities.has(id))this.nativeSummoners.delete(id);
    for(const actor of this.sim.entities.values())if(actor.kind==='hero'||channelAnchors.has(actor.id)||this.nativeSummoners.has(actor.id)){
      const native=require('./summoner-native').sync(this.sim,actor,this.nativeSummoners.get(actor.id));
      this.nativeSummoners.set(actor.id,native.next);packets.push(...native.packets);
    }
    for(const state of this.nativeProjectiles)packets.push(...this.sim.heroes.tickProjectile(state,this.sim.time));
    packets.push(...this.teleportNative.sync(this.sim));
    this.nativeProjectiles=this.nativeProjectiles.filter(state=>!state.done);
    packets.push(...require('./battle-score-native').sync(this.sim,{viewerId:this.playerId}));
    this.send(packets);
    if(this.sim.winner!==null)this.publishMatchResult();
  }
  drainNotes(){const n=this.notes;this.notes=[];return n;}
}
module.exports={BattleSession};
