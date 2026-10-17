'use strict';
const fs=require('fs'),path=require('path');
const M=require('./matchentity'),W=require('./battle-wire'),B=require('./battle-protocol'),N=require('./battle-native'),G=require('./matchgen');
const {BattleSim}=require('./battle-sim');
const {unitStats}=require('./battle-unit-config');
const P=require('./battle-protobuf');
const {readLoadout}=require('./account-loadout');
const selectionNative=require('./battle-selection-native');
const equipment=require('./battle-equipment');
const appearance=require('./player-battle-appearance');
const summoners=require('./summoner-effects');
function table(name){const lines=fs.readFileSync(path.join(__dirname,'../decoded',name+'.tsv'),'utf8').trim().split(/\r?\n/);const head=lines.shift().split('\t');return lines.map(s=>Object.fromEntries(s.split('\t').map((v,i)=>[head[i],v])));}
function loadScenario({candidateHeroes=[]}={}) {
  if(!Array.isArray(candidateHeroes)||candidateHeroes.some(id=>![156,234,102,138].includes(id))||new Set(candidateHeroes).size!==candidateHeroes.length)
    throw Error('Unsupported explicit hero scene candidate');
  candidateHeroes=Object.freeze([...candidateHeroes]);
  const heroPool=Object.freeze([101,53,...candidateHeroes]);
  const candidateWorlds=new WeakSet();
  let candidateRegistry;
  if(candidateHeroes.length){
    const {HeroRegistry,defaultRegistry}=require('./hero-runtime');
    candidateRegistry=new HeroRegistry([...defaultRegistry.definitions(),
      ...(candidateHeroes.includes(156)?[require('./research/hero-combat-20261010/emiya/emiya-hero').createDefinition()]:[]),
      ...(candidateHeroes.includes(234)?[require('./research/hero-combat-20261010/kanna/kanna-hero').createDefinition().definition]:[]),
      ...(candidateHeroes.includes(102)?[require('./research/hero-combat-20261010/kirito/kirito-hero').createDefinition().definition]:[]),
      ...(candidateHeroes.includes(138)?[require('./research/hero-combat-20261010/ikaros/ikaros-hero').createDefinition().definition]:[])]);
  }
  const capture=M.loadMatch('002');
  const sourcePlayerId=capture.c2s.find(f=>f.readUInt16LE(8)===11002).readUInt32LE(12);
  const account=appearance.configuredAccount(),playerId=account?.playerId||sourcePlayerId;
  if(account)capture.s2c=capture.s2c.map(f=>W.transform(f,frame=>require('./player-battle-identity').patch(frame,sourcePlayerId,account)));
  const flat=capture.s2c.flatMap(f=>W.expand(f));
  const terrain=new (require('./battle-terrain').Terrain)();
  const playerIdentity=flat.find(f=>f.readUInt16LE(8)===23512&&f.readUInt32LE(12)===playerId);
  const playerNameEnd=playerIdentity?.indexOf(0,24)??-1;
  const playerNameBytes=playerIdentity&&playerNameEnd>24
    ?Buffer.from(playerIdentity.subarray(24,playerNameEnd)):undefined;
  const monsters=new Map(table('monster').map(r=>[+r.nMonsterID,r]));
  const hero=table('hero').find(r=>r.nHeroId==='101');
  const levelRows=table('skill_skilllevel');
  const skillLevel=(id,level=1)=>levelRows.find(r=>+r.nSkillID===id&&+r.nLevel===level);
  const introEnd=capture.s2c.findIndex(f=>f.readUInt16LE(8)===23439&&f.readUInt32LE(12)===playerId);
  const confirmationIndex=capture.s2c.findIndex(f=>W.expand(f).some(x=>x.readUInt16LE(8)===23437&&x.readUInt32LE(12)===playerId));
  const rosterIndex=capture.s2c.findIndex(f=>f.readUInt16LE(8)===23444);
  if(introEnd<1||confirmationIndex<introEnd||rosterIndex<confirmationIndex)throw new Error('Unrecognized battle bootstrap');
  // The first complete player attribute snapshot marks the end of loading.
  const attributesIndex=capture.s2c.findIndex((f,i)=>i>rosterIndex&&W.expand(f).some(x=>x.readUInt16LE(8)===1045&&x.readUInt32LE(4)===playerId&&x.length>100));
  if(attributesIndex<0)throw new Error('Missing initial player attributes');
  const boot=capture.s2c.slice(confirmationIndex,attributesIndex).flatMap(f=>W.expand(f));
  const selfAttributes=W.expand(capture.s2c[attributesIndex]).filter(f=>f.readUInt16LE(8)===1045&&f.readUInt32LE(4)===playerId);
  boot.push(...selfAttributes);
  const buildingNative=require('./battle-building-native');
  const buildingTemplate=boot.find(f=>f.readUInt16LE(8)===23450);
  const buildingRows=buildingNative.read(buildingTemplate);
  const attrs={};for(const f of selfAttributes)for(const r of G.attrList.decode(f.subarray(12)).rows)attrs[r.attrId]=r.value;
  const recordedEquipment=new Map();
  for(const f of capture.s2c.slice(0,attributesIndex+1).flatMap(f=>W.expand(f)))if(f.readUInt16LE(8)===1043&&f.length===510)
    recordedEquipment.set(f.readUInt16LE(12),{itemId:f.readUInt32LE(16),guid:f.subarray(24,32).toString('hex')});
  if(recordedEquipment.size!==6)throw new Error('Incomplete captured equipment baseline');
  // Captured values can contain enhancement/status bonuses beyond item base
  // columns. Rebuild naked combat attributes instead of retaining that residue.
  const equipmentBase=equipment.heroBase(hero,18,+skillLevel(2841).fRange);
  const mapEnter=boot.find(f=>f.readUInt16LE(8)===1022&&f.readUInt32LE(12)===252);
  if(!mapEnter)throw new Error('Missing map 252 transition');
  const start={x:mapEnter.readFloatLE(21),z:mapEnter.readFloatLE(25)};
  const reviveStatus=boot.find(f=>{
    if(f.readUInt16LE(8)!==11007||f.readUInt32LE(4)!==playerId)return false;
    const fields=P.decode(f.subarray(13));
    return P.get(fields,3)===101&&P.get(fields,5)===undefined&&P.get(fields,7)===undefined;
  });
  if(!reviveStatus)throw new Error('Missing hero status reset from native bootstrap');
  const observations=[...flat,...M.loadMatch('003').s2c.flatMap(f=>W.expand(f))].map(B.readSpawn).filter(Boolean);
  const monsterSpawns=observations.filter(e=>e.kind==='monster');
  const templates=new Map();for(const e of monsterSpawns)if(!templates.has(e.monsterId))templates.set(e.monsterId,e);
  const mapLayout=require('./battle-map-layout');
  const structures=mapLayout.build(monsterSpawns,buildingRows);
  // Waypoints follow the three road corridors and recorded defensive structures.
  // Intermediate waypoints and unseen mirrored towers require native visual QA.
  const roads=mapLayout.roads(buildingRows);
  const kinds=row=>mapLayout.kind(row.monsterId);
  // Restrict selection to the installed client's native map-specific pool.
  const allowedSummoners=summoners.allowedSkillIds(252);
  const selectionConfig={
    timeoutPolicy:{kind:'selected-or-default',defaultHero:101},
    skillSlots:{D:allowedSummoners,F:allowedSummoners},
    initialSkills:{D:8035,F:8026},
    isValidCombination:skills=>skills.D!==skills.F,
  };
  const makeWorld=(heroId,selectedSkills=selectionConfig.initialSkills)=>{
    if(!heroPool.includes(heroId))throw new Error('Only explicitly supported heroes have a scene bootstrap');
    if(heroId!==101&&!account)throw new Error('Candidate hero requires a configured account ownership snapshot');
    if(!summoners.validSelection(selectedSkills,252))
      throw new Error('Unsupported summoner skill selection');
    // Read once when the match starts; lobby edits apply to the next match.
    const savedAppearance=appearance.resolve(playerId,heroId);
    const currentReviveStatus=heroId===101?appearance.patch(reviveStatus,savedAppearance)
      :require('./hero-bootstrap-native').statusReset({id:playerId,heroId,skinId:savedAppearance?.skinId??0});
    let id=0xff800000;
    const entities=structures.map(s=>{const kind=kinds(s);return {id:id++,monsterId:s.monsterId,team:s.team,kind,x:s.x,z:s.z,
      ...unitStats(monsters,skillLevel,s.monsterId,kind,{battle:true}),template:s.frame,source:s.source,templateSource:s.templateSource,templateMonsterId:s.templateMonsterId,targetable:kind!=='fountain',reward:kind==='tower'?150:0,
      recoveryRadius:kind==='fountain'?9:0,hpRecovery:0.05,mpRecovery:0.05};});
    const skill=(id,type,more={})=>{const r=skillLevel(id,more.level||1);return {id,type,level:more.level||1,cooldown:+r.nCDTime/1000,mana:+r.nCostMP,range:+r.fRange,...more};};
    const summonerSkill=summoners.definition;
    const loadout=readLoadout();
    if(heroId===101)entities.push({id:playerId,heroId,skinId:P.get(P.decode(currentReviveStatus.subarray(13)),11)||0,savedAppearance,team:2,kind:'hero',nameBytes:savedAppearance?require('./player-battle-identity').nameBytes(savedAppearance.name):playerNameBytes,loadout,reviveStatus:currentReviveStatus,...start,hpMax:attrs[8]||attrs[1]||+hero.fBaseHP,hp:attrs[8]||attrs[1]||+hero.fBaseHP,
      mpMax:attrs[9]||attrs[2]||+hero.fBaseMP,mp:attrs[9]||attrs[2]||+hero.fBaseMP,
      reviveCount:0,clientBaseMoveSpeed:equipmentBase[129],speed:equipmentBase[129]*equipmentBase[17]/10000,
      clientBaseAttackSpeed:attrs[15],level:18,bodyRadius:+hero.fBodySize,
      range:(attrs[16]||550)/100,attackDamage:attrs[30]||+hero.fBaseAttack,attackInterval:0.9,attackWindup:0.2,projectileSpeed:27,attackSkillId:2841,attackAliases:[2842,2857],
      attackProfiles:Object.fromEntries([2841,2842,2857].map(id=>{const r=skillLevel(id);return [id,{range:+r.fRange,attackWindup:+r.nSkillShakeTime/1000,projectileSpeed:+r.fSpeed}];})),
      skills:{D:summonerSkill(selectedSkills.D),F:summonerSkill(selectedSkills.F)}});
    const lanes=[];
    for(const [i,[name,route]]of Object.entries(roads).entries())for(const team of [1,2]) {
      const wanted=(team===1?25213:25216)+i,source=templates.get(wanted);
      if(!source||source.team!==team)throw new Error(`Missing faction ${team} minion template ${wanted}`);
      const member={...unitStats(monsters,skillLevel,wanted,'minion',{battle:true}),reward:25,monsterId:wanted,template:source.frame};
      lanes.push({id:name,team,path:team===2?route:[...route].reverse(),members:Array.from({length:3},()=>({...member}))});
    }
    const sim=new BattleSim({entities,lanes,waveInterval:30,respawnDelay:12,terrain,heroRegistry:candidateRegistry});sim.nextWave=3;
    sim.mapId=252;sim.battlefield=true;
    const soulStore=new (require('./equipment-soul').SoulState)();
    sim.onSoulDeath=(killer,victim)=>equipment.soulDeath(sim,killer,victim,soulStore);
    let player=sim.entities.get(playerId);
    if(heroId===101){player.equipmentBase=equipmentBase;
      equipment.apply(sim,player,equipment.calculate(equipmentBase,loadout),loadout,{initial:true});
    }else{
      player=require('./hero-combat-baseline').create(sim,{id:playerId,heroId,skinId:savedAppearance?.skinId??0,level:18,team:2,position:start,loadout,
        summonerSkills:selectedSkills,installBehavior:true,heroOptions:{levels:{Q:5,W:5,E:5,R:3}},
        timing:{attackWindup:({53:.233,156:.2,234:.18,102:.2,138:.16})[heroId],projectileSpeed:[53,156,102].includes(heroId)?0:20,
          evidence:'explicit current-engine base policy in fixed level18 development scene; use own raw shake candidate, retain fly delay independently; native full attack phases pending'}}).entity;
      player.savedAppearance=savedAppearance;player.nameBytes=savedAppearance?require('./player-battle-identity').nameBytes(savedAppearance.name):playerNameBytes;
      player.sceneCandidate=true;
    }
    require('./battle-loadout-refresh').install(sim,player);
    if(heroId===101)sim.heroes.install(player);
    sim.updateBuffs(player);
    const bots=require('./battle-test-dummies').add(sim,{observations,heroes:table('hero'),skillLevel,start,reviveStatus,identities:flat,playerId});
    if(process.env.DSH_NATIVE_RESULT_EXPERIMENTAL!=='1')require('./battle-bot-ai').prepare(sim,bots);
    for(const e of sim.entities.values())if(e.kind==='fountain')e.fountainDefense=true;
    sim.drainEvents();
    if(heroId!==101)candidateWorlds.add(sim);
    return sim;
  };
  const initializedActors=[...new Set([...boot.map(B.readSpawn).filter(Boolean).map(e=>e.id),...buildingNative.legacyActors(boot)])];
  // All three native captures finish with CHANGEMAP to map 1, then
  // NOTIFY_BATTLE_WILL_CLOSE. Never replay the preceding recorded inventory,
  // equipment or hero changes as part of leaving our independently run match.
  const returnMap=flat.findLast(f=>f.readUInt16LE(8)===1022);
  const willClose=flat.at(-1);
  if(returnMap?.readUInt32LE(12)!==1||willClose?.readUInt16LE(8)!==1031||willClose.length!==12)
    throw new Error('Missing native lobby return sequence');
  const returnPackets=()=>[Buffer.from(returnMap),Buffer.from(willClose)];
  const readyPackets=sim=>[...initializedActors.filter(id=>id!==playerId).map(N.remove),
    ...[...sim.entities.values()].filter(e=>e.template&&e.alive).map(e=>N.spawn(e.template,e)),
    buildingNative.packet(buildingTemplate,[...sim.entities.values()]),
    ...[...sim.entities.values()].filter(e=>e.kind==='tower').flatMap(e=>require('./battle-structure-native').sync(sim,e,{force:true})),
      ...[...sim.entities.values()].filter(e=>e.kind==='tower').flatMap(e=>require('./battle-structure-native').syncRangeEffect(sim,e,{viewerId:playerId,force:true})),
    ...[...sim.entities.values()].filter(e=>e.testDummy).flatMap(require('./battle-test-dummies').packets),
    // Spawning the local hero reimports equipment from the capture template.
    // Restore the authoritative six slots after all scene spawns.
    ...equipment.equipmentPackets(playerId,sim.entities.get(playerId).loadout),
    W.frame(11888,0,require('./gem-board').actorPayload(sim.entities.get(playerId).loadout.gemState,playerId)),
    ...[...sim.entities.values()].filter(e=>e.kind==='hero').flatMap(e=>require('./battle-vip-native').sync(sim,e,{force:true})),
    equipment.attributePacket(sim.entities.get(playerId)),
    ...[...sim.entities.values()].filter(e=>e.kind==='hero').flatMap(e=>require('./equipment-visuals').packets(e.id,e.heroId,e.equipmentVisuals||new Map(),new Map(),{force:true})),
    N.heroHP(playerId,sim.entities.get(playerId).hp),
    selectionNative.skills(playerId,Object.fromEntries(['D','F'].map(slot=>[slot,sim.entities.get(playerId).skills[slot].id]))),
    ...sim.heroes.nativeSync(sim.entities.get(playerId),{force:true,viewerId:playerId}),
    ...[...sim.entities.values()].filter(e=>e.kind==='hero').flatMap(e=>require('./battle-progression-native').sync(sim,e,{force:true})),
    ...require('./battle-score-native').sync(sim,{viewerId:playerId,force:true})];
  const prepare=boot.find(f=>f.readUInt16LE(8)===23475);
  if(!prepare)throw new Error('Missing native preparation transition');
  const preparePackets=(heroId,skills)=>[selectionNative.confirm(playerId,heroId),selectionNative.skills(playerId,skills),Buffer.from(prepare)];
  const identity=flat.find(f=>f.readUInt16LE(8)===23512&&f.readUInt32LE(12)===playerId);
  if(!identity)throw new Error('Missing player identity');
  // Keep the live scenario result-free until a controlled winning capture
  // closes the result-side, grouping-key and footer contracts.
  const resultPackets=require('./battle-result').runtimePackets;
  const bootstrap=(heroId,skills=selectionConfig.initialSkills,sim)=>{
    if(heroId!==101&&(!sim||!candidateWorlds.has(sim)||sim.heroes.closed))throw Error('Candidate bootstrap requires its active authoritative scene');
    const bootstrapWorld=sim||makeWorld(heroId,skills);
    const player=bootstrapWorld.entities.get(playerId);
    if(player.heroId!==heroId)throw Error('Scene bootstrap differs from authoritative player');
    let sourceBoot=boot.filter(f=>![23437,23475,1043,13535,23445,23446,23458,23495].includes(f.readUInt16LE(8))&&
      !(heroId!==101&&f.readUInt16LE(8)===1045&&f.readUInt32LE(4)===playerId));
    if(heroId!==101){
      if(!heroPool.includes(heroId))throw Error('Hero scene candidate is not enabled');
      const learningTemplate=boot.find(f=>f.readUInt16LE(8)===11019&&f.readUInt32LE(4)===playerId&&f.length===20&&f[13]===0);
      const candidate=require('./hero-loading-native').prepare(sourceBoot,{playerId,heroId,skinId:player.skinId,levels:{Q:5,W:5,E:5,R:3},learningTemplate});
      if(!candidate.fullLocalProfileRebuilt)throw Error('Full hero scene requires rebuilt local profile');sourceBoot=candidate.frames;
    }
    const oldRegistrationAt=sourceBoot.findIndex(f=>f.readUInt16LE(8)===23450);
    if(oldRegistrationAt<0)throw Error('Current building registration requires native initialization position');
    const registrationAt=buildingNative.filterBootstrap(sourceBoot.slice(0,oldRegistrationAt)).length;
    sourceBoot=buildingNative.filterBootstrap(sourceBoot);
    sourceBoot.splice(registrationAt,0,buildingNative.packet(buildingTemplate,[...bootstrapWorld.entities.values()]));
    if(process.env.DSH_NATIVE_RESULT_EXPERIMENTAL!=='1')sourceBoot=require('./battle-roster-live').frames(sourceBoot,bootstrapWorld);
    const packets=sourceBoot.map(f=>{
      const out=appearance.patch(selectionNative.patchSkills(f,skills,playerId),player.savedAppearance);
      if(out.readUInt16LE(8)===1045&&out.readUInt32LE(4)===playerId){
        const p=out.subarray(12);
        for(let i=0;i<p[0];i++){
          const id=p[1+5*i];
          if(player.attributes[id]!==undefined||[95,96].includes(id))p.writeUInt32LE(Math.round(player.attributes[id]??0)>>>0,2+5*i);
        }
      }
      return out;
    });
    return [selectionNative.skills(playerId,skills),...packets,...equipment.equipmentPackets(playerId,player.loadout),
      W.frame(11888,0,require('./gem-board').actorPayload(player.loadout.gemState,playerId)),equipment.attributePacket(player)];
  };
  const intro=capture.s2c.slice(0,introEnd).flatMap(f=>W.expand(f)).map(f=>selectionNative.patchSkills(f,selectionConfig.initialSkills,playerId));
  return {playerId,heroes:[...heroPool],candidateHeroes:[...candidateHeroes],nativeClientVerified:false,
    selectionConfig,intro,introForAccount:()=>appearance.patchIntro(intro,playerId),bootstrap,preparePackets,resultPackets,createWorld:makeWorld,readyPackets,returnPackets,
    mapId:252,start,buildingTemplate:Buffer.from(buildingTemplate),legacyBuildingActors:[...buildingNative.legacyActors(boot)],structures:structures.map(({frame,...s})=>({...s,frame:undefined})),boundaries:{introEnd,confirmationIndex,rosterIndex,attributesIndex}};
}
module.exports={loadScenario,table};
