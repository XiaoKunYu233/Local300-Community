'use strict';
// Pure battle adapter. It never reads/writes account assets or emits native
// packets. Integrators call the committed-action/damage hooks exactly once.
const managedSetIds=Object.freeze([102,103,104,110,111,115,116]);
const setStatus=Object.freeze({101:34300,102:34303,103:34305,104:34308,105:34311,106:34312,107:34313,108:34314,109:34317,110:34318,111:34320,112:34327,113:34330,114:34333,115:34336,116:34337});
const godsendStatus=Object.freeze({4:59012,6:59018,7:59019,14:59041,16:59049,17:59067,20:59120,21:59125,23:59163,29:59175});
const stateByHero=new WeakMap();
const hopeDeathsBySim=new WeakMap();
const activeDewTicks=new WeakSet();
const number=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const safeAmount=v=>Math.max(0,number(v));
const life=e=>number(e.reviveCount);
const tier=(level,levels,values)=>values[Math.max(0,levels.reduce((at,x,i)=>level>=x?i:at,0))];
const effectKey=e=>'magicgem:'+e.setId;
const slot=(e,k,source)=>effectKey(e)+':'+k+(source===undefined?'':':'+source);
const clone=x=>JSON.parse(JSON.stringify(x));
function handles(effect){return managedSetIds.includes(Number(effect?.setId));}
function setDescriptor(effect){
  const id=number(effect?.setId),level=number(effect?.setLevel);
  if(!Number.isInteger(id)||!Number.isInteger(level)||level<1||!setStatus[id])throw Error('Unverified magic-gem set descriptor');
  if(number(effect.effectId)!==setStatus[id])throw Error('Magic-gem set/status mismatch');
  if(!handles(effect))return require('./battle-magic-gem-rules').normalize(effect);
  let out={...effect,nativeStatusId:setStatus[id]};
  if(id===102){if(level<10)throw Error('Inactive magic-gem set');Object.assign(out,{type:'magicGemDamageStack',attack:2,abilityPowerPercent:2,speed:1,duration:2.5,max:tier(level,[10,15,20,25,30],[4,6,8,10,12])});}
  if(id===103){if(level<5)throw Error('Inactive magic-gem set');Object.assign(out,{type:'magicGemGuard',delay:6,reduction:tier(level,[5,10,15,20,25],[11,18,25,32,39])});}
  if(id===104){if(level<10)throw Error('Inactive magic-gem set');Object.assign(out,{type:'magicGemSpeedSteal',amount:2,duration:3,max:tier(level,[10,15,20,25,30],[6,7,8,9,10])});}
  if(id===110){if(level<15)throw Error('Inactive magic-gem set');Object.assign(out,{type:'magicGemEnemyAura',clientRadius:600,radius:6,resistance:tier(level,[15,20,25,30,35],[2,5,8,11,14])});}
  if(id===111){if(level<5)throw Error('Inactive magic-gem set');Object.assign(out,{type:'magicGemAllyAura',clientRadius:600,radius:6,resistance:tier(level,[5,10,15,20,25],[6,9,12,15,18])});}
  if(id===115||id===116){if(level<15)throw Error('Inactive magic-gem set');Object.assign(out,{type:'magicGemDamageRecovery',threshold:5000,resource:id===115?'hp':'mp',amount:tier(level,[15,20,25,30,35],[300,600,900,1200,1500])});}
  return out;
}
function runeSelection(raw,page=raw?.currentPage){
  if(!Number.isInteger(page)||!raw?.pages?.[page]||!raw?.inventory)throw Error('Invalid rune page');
  const selected=raw.pages[page],groups=new Map();
  for(let i=0;i<selected.slots.length;i++){
    if(selected.openSlots?.[i]===false)continue;
    const id=selected.slots[i];if(!id)continue;
    const key=typeof id==='string'&&/^[a-f0-9]{16}$/i.test(id)?id.toLowerCase():String(Number(id));
    const rune=raw.inventory[key];if(!rune)throw Error('Selected rune is absent from owned inventory');
    const value=rune.godsend?.id??rune.godsendId;if(value===null||value===undefined||value===0)continue;
    const godsend=Number(value);if(!Number.isInteger(godsend)||godsend<1)throw Error('Invalid rune-godsend identity');
    if(number(rune.level)!==5)throw Error('Unsupported rune-godsend level');
    if(!groups.has(godsend))groups.set(godsend,{godsendId:godsend,name:String(rune.godsend?.name||''),nativeStatusId:godsendStatus[godsend]??null,sourceRuneIds:[]});
    if(!groups.get(godsend).sourceRuneIds.includes(key))groups.get(godsend).sourceRuneIds.push(key);
  }
  return [...groups.values()];
}
function runeDescriptors(raw,page=raw?.currentPage){return runeSelection(raw,page).filter(e=>Object.hasOwn(godsendStatus,e.godsendId));}
function state(hero){
  let s=stateByHero.get(hero);if(!s){s={sets:[],runes:[],masterLevel:null,damageRemainders:{},actionSeen:new Map(),damageSeen:new Map(),spark:{chance:{},readyAt:0},gluttony:{},installedLife:life(hero)};stateByHero.set(hero,s);}
  return s;
}
function install(sim,hero,{magicGemEffects=hero.magicGemEffects||[],runeGodsendEffects=[],runeGodsendSelection=null,masterLevel=null,collectorBonus={},forger=null,sparkRules={pool:'category',interval:'success'}}={}){
  const s=state(hero),unique=new Map();
  for(const effect of magicGemEffects){const e=setDescriptor(effect);if(unique.has(e.setId))throw Error('Duplicate magic-gem set source');unique.set(e.setId,e);}
  const hadDew=s.runes.some(e=>e.godsendId===7);
  const selection=require('./battle-godsend-policy').partition(runeGodsendSelection??runeGodsendEffects,sim,godsendStatus);
  s.sets=[...unique.values()];s.runes=clone(selection.active);
  const coverageKey=JSON.stringify(selection.coverage);
  if(s.coverageKey!==coverageKey){s.coverageKey=coverageKey;if(selection.coverage.length||s.coverage?.length)sim.event('passive',{effect:'rune-godsend-coverage',id:hero.id,mapId:sim.mapId??null,mode:sim.mode,selected:clone(selection.coverage)});}
  s.coverage=clone(selection.coverage);
  if(s.runes.some(e=>!godsendStatus[e.godsendId]||e.nativeStatusId!==godsendStatus[e.godsendId]))throw Error('Unverified rune-godsend descriptor');
  s.masterLevel=masterLevel===null?null:number(masterLevel);
  s.collectorBonus=normalizeCollectorBonus(collectorBonus);
  s.forger=normalizeForger(forger);
  if(s.runes.some(e=>e.godsendId===7)){if(!hadDew||!s.dew)s.dew={nextRegular:sim.time+1,nextBurst:sim.time+17,life:life(hero)};}
  else s.dew=null;
  if(s.masterLevel!==null&&(!Number.isInteger(s.masterLevel)||s.masterLevel<1||s.masterLevel>300))throw Error('Unverified Master level');
  // User confirmed 2026-10-13: basic skills/attacks share one pool, ultimate
  // skills another; only a successful refresh starts the one-second interval.
  if(sparkRules!==null){if(!['category','per-action'].includes(sparkRules.pool)||!['success','attempt'].includes(sparkRules.interval))throw Error('Unconfirmed spark rules');s.sparkRules={...sparkRules};}
  else s.sparkRules=null;
  hero.runeGodsendEffects=clone(s.runes);
  // Equipment.apply installs new base fields before updateBuffs. The actor's
  // current AD/AS may still belong to its previous loadout at this point.
  s.baseCombatStats={hpMax:number(hero.effectBase?.hpMax,hero.hpMax),mpMax:number(hero.effectBase?.mpMax,hero.mpMax),
    attackDamage:number(hero.effectBase?.attributes?.[30],number(hero.baseAttackDamage,hero.attackDamage)),
    abilityPower:number(hero.effectBase?.attributes?.[31],hero.attributes?.[31]),attackSpeed:number(hero.clientBaseAttackSpeed,number(hero.effectBase?.attributes?.[15],hero.clientAttackSpeed)),
    armor:number(hero.effectBase?.armor,hero.armor),magicResistance:number(hero.effectBase?.magicResistance,hero.magicResistance)};
  s.baseRaw={...(hero.effectBase?.raw||{})};s.lastProjection=null;
  s.baseFlatAttack=number(hero.flatAttackDamage,number(hero.baseAttackDamage,s.baseCombatStats.attackDamage));
  s.baseMRFactor=1+(hero.passives?.martial?5:0)/100+(hero.passives?.adapt?.level>=15?10:0)/100;
  hero.progressionEffectsProfile={sets:clone(s.sets),runes:clone(s.runes),godsendCoverage:clone(s.coverage),masterLevel:s.masterLevel,collectorBonus:{...s.collectorBonus},forger:s.forger&&clone(s.forger),sparkRules:s.sparkRules&&{...s.sparkRules}};
  // Repeated equipment refresh preserves counters/chances/cooldowns. We only
  // remove transient buffs whose actual selected source disappeared.
  const ids=new Set(s.sets.map(e=>e.setId));
  hero.buffs=(hero.buffs||[]).filter(b=>!b.progressionOwned||b.sourceId!==hero.id||ids.has(b.setId));
  return hero.progressionEffectsProfile;
}
function equipped(hero,id){return state(hero).runes.some(e=>e.godsendId===id);}
function normalizeForger(value){
  if(value===null)return null;
  const count=value?.count;
  if(!Number.isSafeInteger(count)||count<0)throw Error('Unverified forger ownership count');
  const units=Math.min(count,100)+Math.max(0,count-100)*2;
  if(value.attack!==100+units||value.abilityPower!==150+units*1.5)throw Error('Forger bonus/count mismatch');
  return {count,attack:value.attack,abilityPower:value.abilityPower};
}
function flatGodsendBonuses(hero){
  const s=state(hero),out=equipped(hero,17)?{...s.collectorBonus}:{};
  if(equipped(hero,21)&&s.forger){out[30]=number(out[30])+s.forger.attack;out[31]=number(out[31])+s.forger.abilityPower;}
  return out;
}
function normalizeCollectorBonus(value){
  const input=value||{},out={},alias={1:8,2:9,127:30,128:31};
  for(const [id,n] of Object.entries(input)){const target=alias[id]||Number(id);if(![8,9,30,31,42,44].includes(target)||!Number.isFinite(n)||n<0)throw Error('Unverified collector attribute bonus');if(out[target]!==undefined&&out[target]!==n)throw Error('Conflicting collector attribute alias');out[target]=n;}
  return out;
}
function masterMultiplier(hero){const s=state(hero);if(!equipped(hero,4)||s.masterLevel===null)return 1;return 1+(s.masterLevel===300?10:4+Math.floor((s.masterLevel-1)/50))/100;}
function prepareOutgoingDamage(hero,target,{raw,adRatio,apRatio,basic=false,alreadyModified=false}={}){
  if(!Number.isFinite(raw)||raw<0)throw Error('Invalid outgoing damage');
  if(alreadyModified)return {raw,masterMultiplier:1,greedRaw:0,greedResolved:true};
  const factor=masterMultiplier(hero);let greed=0,resolved=true;
  if(equipped(hero,23)&&target?.kind==='hero'&&hero.team!==target.team){
    const ad=basic?1:adRatio,ap=basic?0:apRatio;
    if(!Number.isFinite(ad)||!Number.isFinite(ap)||ad<0||ap<0)resolved=false;
    else greed=Math.max(number(target.hpMax),number(target.mpMax))*(ad*.01+ap*.02);
  }
  // Greed changes only proven AD/AP calculation inputs. A final-damage
  // blanket bonus would incorrectly affect fixed/percent/true components.
  return {raw:(raw+greed)*factor,masterMultiplier:factor,greedRaw:greed,greedResolved:resolved};
}
function onBeforeDamage(sim,attacker,target,raw,context={}){return prepareOutgoingDamage(attacker,target,{...context,raw}).raw;}
function combatStats(hero){return {hpMax:safeAmount(hero.hpMax),mpMax:safeAmount(hero.mpMax),attackDamage:safeAmount(hero.attackDamage),abilityPower:safeAmount(hero.attributes?.[31]),attackSpeed:safeAmount(hero.clientAttackSpeed),armor:Math.max(0,number(hero.armor??hero.attributes?.[42])+number(hero.equipmentArmorBonus)-number(hero.equipmentArmorReduction)),magicResistance:Math.max(0,number(hero.magicResistance??hero.attributes?.[44])+number(hero.equipmentMagicResistanceBonus)-number(hero.equipmentMagicResistanceReduction))};}
const battleMageIds=Object.freeze([21141,21722,27023,27029,29053,30002,30006]);
function battleMageEquipped(slots,catalog){return (slots||[]).some(e=>{const row=catalog?.byId?.[e.itemId]||catalog?.[e.itemId];return battleMageIds.includes(Number(e.itemId))&&row?.catalogSource==='current-client'&&row.type==='armour'&&/^战法师(?:指环|项链|胸甲)(?:（Plus版本）)?$/.test(row.name);});}
function effectiveBase(hero){
  const s=state(hero),b={...s.baseCombatStats};
  const c=flatGodsendBonuses(hero),factor=id=>1+number(s.baseRaw?.[id])/100;
  b.hpMax+=number(c[8])*factor(10);b.mpMax+=number(c[9])*factor(11);b.abilityPower+=number(c[31])*factor(37);b.armor+=number(c[42])*factor(43);b.magicResistance+=number(c[44])*s.baseMRFactor;
  b.attackDamage+=number(c[30])*(s.baseFlatAttack>0?s.baseCombatStats.attackDamage/s.baseFlatAttack:1);return b;
}
function onKill(sim,killer,target,{attackerLife,hasBattleMage,selfStats=combatStats(killer),targetStats=combatStats(target)}={}){
  // BattleSim commits death before onKill: enemies() additionally requires
  // target.alive and therefore cannot be used for a committed kill hook.
  if(!actorCurrent(killer,attackerLife)||target?.kind!=='hero'||killer.id===target.id||killer.team===target.team||sim.entities?.get(target.id)!==target||sim.entities?.get(killer.id)!==killer||!equipped(killer,20))return [];
  if(typeof hasBattleMage!=='boolean')throw Error('Gluttony requires verified battle-mage equipment gate');
  const s=state(killer),out=[],statusIds={hpMax:59100,mpMax:59115,attackDamage:59109,abilityPower:59112,attackSpeed:59121,armor:59103,magicResistance:59106};
  for(const name of Object.keys(statusIds)){
    if(name==='mpMax'&&!hasBattleMage)continue;
    const own=selfStats[name],enemy=targetStats[name];if(!Number.isFinite(own)||own<0||!Number.isFinite(enemy)||enemy<0)throw Error('Invalid gluttony comparison stats');
    if(enemy===own)continue;
    const higher=enemy>own,value=higher?enemy:number(effectiveBase(killer)[name])*1.05,until=sim.time+(higher?15:30),ruleStatusId=higher?statusIds[name]:name==='attackSpeed'?59119:59118;
    // Current ordinary-client 59118 has no item/icon row and 59119 is hidden.
    // The same Gluttony per-attribute visible states have generic "increase
    // XX" tooltips and the real baoshi icon. This server's presentation maps
    // both rules to the corresponding stat ID; it does not claim original
    // server packet parity or substitute an unrelated status.
    const projected={name,value,until,higher,factor:higher?null:1.05,ruleStatusId,nativeStatusId:statusIds[name],presentation:'development-gluttony-visible-per-stat'};s.gluttony[name]=projected;out.push(projected);
  }
  if(out.length){sim.event('passive',{id:killer.id,target:target.id,effect:'rune-gluttony',godsendId:20,projections:clone(out)});sim.updateBuffs?.(killer);}
  return out;
}
// Only the current native description's recovery branch is implemented here.
// Damage-stack expiry/refresh semantics remain unresolved and are not guessed.
function onCommittedDeath(sim,target,{life:expected}={}){
  if(target?.kind!=='hero'||target.alive||target.hp!==0||expected===undefined||life(target)!==expected||sim.entities?.get(target.id)!==target)return [];
  let seen=hopeDeathsBySim.get(sim);if(!seen){seen=new WeakMap();hopeDeathsBySim.set(sim,seen);}
  if(seen.get(target)===expected)return [];seen.set(target,expected);
  // Capture participants before healing callbacks; additions, replacements and
  // new lives created by a nested callback cannot inherit this death trigger.
  const recipients=[...sim.entities.values()].filter(hero=>hero!==target&&hero.kind==='hero'&&hero.alive&&hero.hp>0&&hero.team===target.team&&equipped(hero,14)&&Math.hypot(hero.x-target.x,hero.z-target.z)<=15).map(hero=>({hero,life:life(hero)}));
  const out=[];
  for(const {hero,life:expectedLife}of recipients){
    if(sim.entities.get(hero.id)!==hero||!actorCurrent(hero,expectedLife)||hero.hp<=0||!equipped(hero,14))continue;
    const hpRequested=hero.hpMax*.5,mpRequested=hero.mpMax*.25;
    const hpGained=sim.heal(hero,hpRequested,{reason:'rune-hope-recovery',ignoreHealingModifiers:true});
    // Healing notifications can reenter the simulation. Never credit mana or
    // send an old-life event to a newly revived/replaced recipient.
    if(sim.entities.get(hero.id)!==hero||!actorCurrent(hero,expectedLife)||hero.hp<=0)continue;
    const before=hero.mp;hero.mp=Math.min(hero.mpMax,hero.mp+mpRequested);const mpGained=hero.mp-before;
    if(mpGained>0)sim.event('mana',{id:hero.id,amount:mpGained,reason:'rune-hope-recovery'});
    const result={id:hero.id,target:target.id,effect:'rune-hope-recovery',godsendId:14,hpRequested,mpRequested,hpGained,mpGained,partial:true};out.push(result);sim.event('passive',result);
  }
  return out;
}
function markSeen(map,id){if(id===undefined||id===null)return true;if(map.has(String(id)))return false;map.set(String(id),true);if(map.size>4096)map.delete(map.keys().next().value);return true;}
function actorCurrent(hero,expected){return hero?.alive&&expected!==undefined&&life(hero)===expected;}
function onCommittedDamage(sim,attacker,target,{amount,attackerLife,commitId}={}){
  if(!actorCurrent(attacker,attackerLife)||!target||!sim.enemies(attacker,target)||!(amount>0)||!Number.isFinite(amount))return [];
  const s=state(attacker);if(!markSeen(s.damageSeen,commitId))return [];
  const outcomes=[];
  for(const e of s.sets)if(e.setId===115||e.setId===116){
    const total=(s.damageRemainders[e.setId]||0)+amount,count=Math.floor(total/e.threshold);
    s.damageRemainders[e.setId]=total-count*e.threshold;if(!count)continue;
    const requested=count*e.amount;let gained=0;
    if(e.resource==='hp')gained=sim.heal(attacker,requested,{reason:'magic-gem-damage-recovery'});
    else {const before=attacker.mp||0;attacker.mp=Math.min(attacker.mpMax||0,before+requested);gained=attacker.mp-before;if(gained>0)sim.event('mana',{id:attacker.id,amount:gained,reason:'magic-gem-damage-recovery'});}
    const out={id:attacker.id,setId:e.setId,nativeStatusId:e.effectId,effect:'magic-gem-damage-recovery',resource:e.resource,thresholds:count,requested,gained,remainder:s.damageRemainders[e.setId]};outcomes.push(out);sim.event('passive',out);
  }
  return outcomes;
}
function replaceBuff(hero,buff){hero.buffs=(hero.buffs||[]).filter(b=>b.slot!==buff.slot);hero.buffs.push(buff);}
function onDamageTaken(sim,hero,attacker,{amount,life:expected}={}){
  if(!actorCurrent(hero,expected)||!(amount>0))return;
  for(const e of state(hero).sets){
    if(e.setId===102){const key=slot(e,'damage-stack'),old=hero.buffs.find(b=>b.slot===key&&b.until>sim.time),layers=Math.min(e.max,(old?.layers||0)+1);replaceBuff(hero,{slot:key,setId:e.setId,progressionOwned:true,sourceId:hero.id,until:sim.time+e.duration,layers,attack:1+layers*e.attack/100,abilityPowerPercent:layers*e.abilityPowerPercent,speed:1+layers*e.speed/100,nativeStatusId:34304});}
    if(e.setId===103)hero.buffs=hero.buffs.filter(b=>b.slot!==slot(e,'guard'));
  }
}
function onBasicHit(sim,attacker,target,{amount,attackerLife}={}){
  if(!actorCurrent(attacker,attackerLife)||!(amount>0)||!target?.alive||!sim.enemies(attacker,target))return;
  for(const e of state(attacker).sets)if(e.setId===104){
    const key=slot(e,'speed-steal'),old=attacker.buffs.find(b=>b.slot===key&&b.until>sim.time),layers=Math.min(e.max,(old?.layers||0)+1),percent=layers*e.amount;
    replaceBuff(attacker,{slot:key,setId:e.setId,progressionOwned:true,sourceId:attacker.id,until:sim.time+e.duration,layers,speed:1+percent/100,attackSpeed:percent,nativeStatusId:34309});
    replaceBuff(target,{slot:slot(e,'speed-steal-target',attacker.id),setId:e.setId,progressionOwned:true,until:sim.time+e.duration,layers,speed:Math.max(0,1-percent/100),attackSpeed:-percent,negative:true,debuff:true,nativeStatusId:34310,sourceId:attacker.id});
  }
}
function tick(sim,hero){
  if(!hero?.alive)return;
  const s=state(hero);
  // Instant equipment revival increments the life without the normal respawn
  // hook. Resume the existing fresh-cycle policy for that new life as well.
  if(equipped(hero,7)&&s.dew&&s.dew.life!==life(hero))s.dew={nextRegular:sim.time+1,nextBurst:sim.time+17,life:life(hero)};
  if(equipped(hero,7)&&s.dew&&s.dew.life===life(hero)&&!activeDewTicks.has(s.dew)){
    const dew=s.dew,expectedLife=life(hero);
    const current=()=>!sim.heroes?.closed&&sim.entities?.get(hero.id)===hero&&actorCurrent(hero,expectedLife)&&hero.hp>0&&equipped(hero,7)&&s.dew===dew;
    activeDewTicks.add(dew);
    try{
    for(const [key,period,hpRate,mpRate]of [['nextRegular',1,.01,.005],['nextBurst',17,.35,.15]]){
      while(current()&&dew[key]<=sim.time+1e-9){
        const scheduledAt=dew[key];dew[key]+=period;
        const hpRequested=hero.hpMax*hpRate,mpRequested=hero.mpMax*mpRate;
        const hpGained=sim.heal(hero,hpRequested,{reason:'rune-dew'});
        if(!current())return;
        const mpBefore=hero.mp;
        hero.mp=Math.min(hero.mpMax,hero.mp+mpRequested);
        const mpGained=hero.mp-mpBefore;
        if(mpGained>0)sim.event('mana',{id:hero.id,amount:mpGained,reason:'rune-dew'});
        if(!current())return;
        sim.event('passive',{id:hero.id,effect:'rune-dew',godsendId:7,period,scheduledAt,hpRequested,mpRequested,hpGained,mpGained});
      }
    }
    }finally{activeDewTicks.delete(dew);}
  }
  for(const e of state(hero).sets){
    if(e.setId===103){const key=slot(e,'guard');if(sim.time-(hero.lastCombatAt??-Infinity)>=e.delay)replaceBuff(hero,{slot:key,setId:e.setId,progressionOwned:true,sourceId:hero.id,until:Infinity,damageReduction:e.reduction,nativeStatusId:34307});}
    if(e.setId===110||e.setId===111){
      const enemy=e.setId===110,rate=e.resistance/100;
      for(const target of sim.entities.values()){
        if(!target.alive||target.kind!=='hero'||(enemy?!sim.enemies(hero,target):target.team!==hero.team))continue;
        const key=slot(e,enemy?'enemy-aura':'ally-aura',hero.id);target.buffs=target.buffs.filter(b=>b.slot!==key);
        if(Math.hypot(hero.x-target.x,hero.z-target.z)>e.radius)continue;
        // Use immutable current-loadout stats, never a previously aura-raised
        // result. Existing buffs from different sources are handled separately.
        const armor=number(target.effectBase?.attributes?.[42],number(target.effectBase?.armor)),mr=number(target.effectBase?.attributes?.[44],number(target.effectBase?.magicResistance));
        const buff={slot:key,setId:e.setId,progressionOwned:true,until:sim.time+.25,nativeStatusId:enemy?34319:34321,sourceId:hero.id};
        Object.assign(buff,enemy?{armorReduction:armor*rate,magicResistanceReduction:mr*rate,negative:true,debuff:true}:{armorBonus:armor*rate,magicResistanceBonus:mr*rate});target.buffs.push(buff);
      }
    }
  }
}
function modifiers(hero,now){
  const s=state(hero),out={abilityPowerPercent:0};for(const b of hero.buffs||[])if(b.progressionOwned&&b.until>now)out.abilityPowerPercent+=number(b.abilityPowerPercent);
  if(equipped(hero,17)||equipped(hero,21)){const c=flatGodsendBonuses(hero);Object.assign(out,{health:number(c[8]),mana:number(c[9]),attackBonus:number(c[30]),abilityPower:number(c[31]),armor:number(c[42]),magicResistance:number(c[44])});}
  if(equipped(hero,20))for(const [name,e] of Object.entries(s.gluttony)){
    if(e.until<=now)continue;
    if(s.projectionEngine){
      if(name==='hpMax')out[e.higher?'gluttonyHealthOverride':'gluttonyHealthFactor']=e.higher?e.value:1.05;
      if(name==='mpMax')out[e.higher?'gluttonyManaOverride':'gluttonyManaFactor']=e.higher?e.value:1.05;
      continue;
    }
    const delta=e.value-number(effectiveBase(hero)[name]);
    const factor=id=>Math.max(.01,1+number(s.baseRaw?.[id])/100);
    if(name==='hpMax')out.health=(out.health||0)+delta/factor(10);
    if(name==='mpMax')out.mana=(out.mana||0)+delta/factor(11);
    if(name==='attackDamage')out.attackPercent=s.baseFlatAttack>0?delta/s.baseFlatAttack*100:0;
    if(name==='abilityPower')out.abilityPower=(out.abilityPower||0)+delta/factor(37);
    if(name==='attackSpeed')out.attackSpeed=delta;
    if(name==='armor')out.armor=(out.armor||0)+delta/factor(43);
    if(name==='magicResistance')out.magicResistance=(out.magicResistance||0)+delta/s.baseMRFactor;
  }
  return out;
}
function projectionSnapshot(hero){
  return {attackDamage:hero.attackDamage,clientAttackSpeed:hero.clientAttackSpeed,attackInterval:hero.attackInterval,armor:hero.armor,magicResistance:hero.magicResistance,
    equipmentArmorBonus:hero.equipmentArmorBonus,equipmentArmorReduction:hero.equipmentArmorReduction,equipmentMagicResistanceBonus:hero.equipmentMagicResistanceBonus,equipmentMagicResistanceReduction:hero.equipmentMagicResistanceReduction,
    attributes:Object.fromEntries([30,127,31,128,15,42,44].map(id=>[id,hero.attributes?.[id]]))};
}
function prepareUpdate(hero){
  const s=state(hero);s.projectionEngine=true;s.updateDepth=(s.updateDepth||0)+1;
  if(s.updateDepth===1&&s.lastProjection){
    const old=s.lastProjection,fields={attackDamage:['attackDamage'],abilityPower:[],attackSpeed:['clientAttackSpeed','attackInterval'],armor:['armor','equipmentArmorBonus','equipmentArmorReduction'],magicResistance:['magicResistance','equipmentMagicResistanceBonus','equipmentMagicResistanceReduction']},ids={attackDamage:[30,127],abilityPower:[31,128],attackSpeed:[15],armor:[42],magicResistance:[44]};
    for(const name of old.projectedNames){for(const key of fields[name])hero[key]=old[key];if(hero.attributes)for(const id of ids[name]){const value=old.attributes[id];if(value===undefined)delete hero.attributes[id];else hero.attributes[id]=value;}}
    s.lastProjection=null;
  }
  // Keep actual HP/MP and effective maxima available to recovery during the
  // update. EffectStats computes final maxima before derived equipment math
  // and defers its clamp; only outer finish may clamp expired projections.
  hero.progressionUpdateContext={deferResourceClamp:true,depth:s.updateDepth};
}
function finishUpdate(sim,hero){
  const s=state(hero),before=projectionSnapshot(hero),values=combatStats(hero),projectedNames=[];let changed=false;
  // Reentrant periodic damage may have caused a nested update to finish.
  // Rebuild aura totals from the active effects rather than its cleared cache.
  const buffs=(hero.buffs||[]).filter(b=>b.until>sim.time),sum=k=>buffs.reduce((n,b)=>n+number(b[k]),0);
  values.armor=Math.max(0,number(hero.armor)+sum('armorBonus')-sum('armorReduction'));
  values.magicResistance=Math.max(0,number(hero.magicResistance)+sum('magicResistanceBonus')-sum('magicResistanceReduction'));
  if(equipped(hero,20)&&hero.alive)for(const [name,e] of Object.entries(s.gluttony)){
    if(e.until<=sim.time||name==='hpMax'||name==='mpMax')continue;
    projectedNames.push(name);
    const desired=Math.max(0,Math.round(e.higher?e.value:values[name]*1.05));
    if(name==='attackDamage'){const delta=desired-hero.attackDamage;hero.attackDamage=desired;if(hero.attributes){hero.attributes[30]=desired;hero.attributes[127]=Math.max(0,number(hero.attributes[127])+delta);}}
    if(name==='abilityPower'&&hero.attributes){hero.attributes[31]=desired;hero.attributes[128]=desired;}
    if(name==='attackSpeed'){hero.clientAttackSpeed=Math.max(1,desired);if(hero.attributes)hero.attributes[15]=hero.clientAttackSpeed;hero.attackInterval=hero.baseAttackInterval*(hero.clientBaseAttackSpeed||100)/hero.clientAttackSpeed;}
    if(name==='armor'){hero.armor=desired;hero.equipmentArmorBonus=0;hero.equipmentArmorReduction=0;if(hero.attributes)hero.attributes[42]=desired;}
    if(name==='magicResistance'){hero.magicResistance=desired;hero.equipmentMagicResistanceBonus=0;hero.equipmentMagicResistanceReduction=0;if(hero.attributes)hero.attributes[44]=desired;}
  }
  s.lastProjection=projectedNames.length?{...before,projectedNames}:null;changed=JSON.stringify(before)!==JSON.stringify(projectionSnapshot(hero));
  s.updateDepth=Math.max(0,(s.updateDepth||1)-1);
  if(s.updateDepth===0){
    const hp=hero.hp,mp=hero.mp;hero.hp=Math.min(hero.hp,hero.hpMax);hero.mp=Math.min(hero.mp,hero.mpMax);
    if(hero.attributes){hero.attributes[1]=hero.hp;hero.attributes[2]=hero.mp;hero.attributes[8]=hero.hpMax;hero.attributes[9]=hero.mpMax;}
    changed ||=hp!==hero.hp||mp!==hero.mp;delete hero.progressionUpdateContext;
  }
  if(changed)sim.event('equipment-passive-attributes',{id:hero.id,reason:'rune-gluttony-projection'});
  return combatStats(hero);
}
function onCommittedAction(sim,hero,{committed=false,kind,slot:skillSlot,cooldownKey=skillSlot,skillId,life:expected,commitId}={}){
  const s=state(hero);if(!committed||!actorCurrent(hero,expected)||!equipped(hero,29)||!s.sparkRules)return {eligible:false};
  if(!['basic-attack','basic-skill','ultimate'].includes(kind))return {eligible:false};
  if(kind!=='basic-attack'&&(!skillSlot||!hero.skills?.[skillSlot]||hero.skills[skillSlot].summoner||hero.skills[skillSlot].equipment||!Number.isFinite(hero.cooldowns?.[cooldownKey])))return {eligible:false};
  if(!markSeen(s.actionSeen,commitId))return {eligible:false,duplicate:true};
  if(s.spark.readyAt>sim.time)return {eligible:false,cooldown:true};
  const category=kind==='ultimate'?'ultimate':'basic',key=s.sparkRules.pool==='category'?category:kind==='basic-attack'?'basic-attack':String(cooldownKey),base=category==='ultimate'?15:30,step=category==='ultimate'?7.5:15,chance=s.spark.chance[key]??base;
  const success=sim.random()*100<chance;s.spark.chance[key]=success?base:Math.min(100,chance+step);
  if(success||s.sparkRules.interval==='attempt')s.spark.readyAt=sim.time+1;
  if(success){if(kind==='basic-attack')hero.attackAt=sim.time;else hero.cooldowns[cooldownKey]=sim.time;sim.event('passive',{id:hero.id,effect:'rune-spark-refresh',godsendId:29,nativeStatusId:59176,kind,slot:skillSlot,skillId,chance,readyAt:s.spark.readyAt});if(kind!=='basic-attack')sim.event('skill-cooldown',{id:hero.id,slot:skillSlot,skillId,skill:hero.skills[skillSlot],readyAt:sim.time});}
  return {eligible:true,success,chance,nextChance:s.spark.chance[key],readyAt:s.spark.readyAt};
}
function nativeStatuses(hero,now){
  const s=state(hero),out=s.sets.map(e=>({statusId:e.effectId,level:1,source:'magic-gem-set',setId:e.setId,setLevel:e.setLevel}));
  for(const e of s.runes)if(e.godsendId===23||e.godsendId===29&&s.sparkRules)out.push({statusId:e.nativeStatusId,level:1,source:'rune-godsend',godsendId:e.godsendId});
  if(equipped(hero,4)&&s.masterLevel!==null)out.push({statusId:59012,level:1,source:'rune-godsend',godsendId:4});
  if(equipped(hero,6))out.push({statusId:59018,level:1,source:'rune-godsend',godsendId:6});
  if(equipped(hero,7))out.push({statusId:59019,level:1,source:'rune-godsend',godsendId:7});
  // 59125 is the exact hidden manager. The visible 59498 tooltip also needs
  // child statuslap values; fractional AP encoding is not yet proven.
  if(equipped(hero,21)&&s.forger)out.push({statusId:59125,level:1,source:'rune-godsend',godsendId:21});
  if(equipped(hero,29)&&s.sparkRules&&s.spark.readyAt>now)out.push({statusId:59176,level:1,source:'rune-spark-cooldown',godsendId:29,until:s.spark.readyAt});
  if(equipped(hero,17)&&Object.values(s.collectorBonus||{}).some(x=>x>0))out.push({statusId:59497,level:1,source:'rune-godsend',godsendId:17});
  if(equipped(hero,20))for(const e of Object.values(s.gluttony))if(e.until>now)out.push({statusId:e.nativeStatusId,level:1,source:'rune-gluttony',stat:e.name,until:e.until});
  for(const b of hero.buffs||[])if(b.progressionOwned&&b.until>now&&b.nativeStatusId)out.push({statusId:b.nativeStatusId,level:1,source:'progression-trigger',slot:b.slot,layers:b.layers||1,until:b.until,sourceId:b.sourceId??hero.id});
  return out;
}
function snapshot(hero){const s=state(hero);return {damageRemainders:{...s.damageRemainders},spark:clone(s.spark),masterLevel:s.masterLevel,sets:clone(s.sets),runes:clone(s.runes),gluttony:clone(s.gluttony),forger:s.forger&&clone(s.forger),dew:s.dew&&clone(s.dew)};}
function onRespawn(sim,hero){
  // Life-bound periodic recovery must not repay dead-time recovery to the new
  // life. Reset to a fresh 1s/17s cycle; native phase on revival/re-equip still
  // needs an original-server observation and is not claimed as proven parity.
  const current=state(hero);if(equipped(hero,7))current.dew={nextRegular:sim.time+1,nextBurst:sim.time+17,life:life(hero)};
  const s=state(hero);s.installedLife=life(hero);hero.buffs=(hero.buffs||[]).filter(b=>!b.progressionOwned);tick(sim,hero);
  // No reset of damage progress or spark chances/cooldowns is asserted by
  // the source descriptions. Equipped effects remain selected after revive.
}
module.exports={managedSetIds,setStatus,godsendStatus,hasGodsend:equipped,handles,setDescriptor,runeDescriptors,runeSelection,install,normalizeCollectorBonus,masterMultiplier,prepareOutgoingDamage,onBeforeDamage,combatStats,battleMageIds,battleMageEquipped,onKill,onCommittedDeath,onCommittedDamage,onDamageTaken,onBasicHit,tick,modifiers,prepareUpdate,finishUpdate,onCommittedAction,nativeStatuses,snapshot,onRespawn};
