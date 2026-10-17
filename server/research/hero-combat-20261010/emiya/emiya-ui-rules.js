'use strict';
// The user authorized current client descriptions as the base-version rule.
// Values are extracted per rank; upgrade hints do not generate a linear table.
const snapshot=require('./snapshot.json');
const row=(id,rank)=>snapshot.skillLevels.find(x=>x.named.nSkillID===id&&x.named.nLevel===rank)?.named;
const text=(id,rank)=>String(row(id,rank)?.strSkillUI_SkillInfo||'').replace(/<color=[^>]*>/g,'');
const extract=(source,regex,label)=>{const hit=source.match(regex);if(!hit)throw Error('Missing UI value '+label);return Number(hit[1]);};
const common=(id,rank)=>{const source=text(id,rank),config=row(id,rank);return {skillId:id,rank,
  mana:extract(source,/(\d+)法力值/,'mana'),cooldown:extract(source,/#\[(\d+)\]秒冷却时间/,'cooldown'),
  configuredCooldown:config.nCDTime/1000,source};};
const Q=Array.from({length:5},(_,i)=>{const rank=i+1,source=text(6521,rank);return {...common(6521,rank),
  coefficient:extract(source,/造成一次(\d+)%伤害/,'Q coefficient')/100,ranges:[3.5,4.5,5.5],window:2};});
const W=Array.from({length:5},(_,i)=>{const rank=i+1,source=text(6527,rank);return {...common(6527,rank),
  baseDamage:extract(source,/造成(\d+)\(/,'W base'),bonusAdRatio:extract(source,/\{~127\*([\d.]+)\}/,'W bonus AD'),
  startRange:8,maxRange:extract(source,/射程从800逐渐提升至(\d+)/,'W max range')/100,
  rampSeconds:3,maxCharge:4.5,vulnerabilityPerTenth:1,vulnerabilityCap:20,vulnerabilityDuration:2,vulnerabilityMaxLife:5,maxExtraCooldown:20};});
const E=Array.from({length:5},(_,i)=>{const rank=i+1,source=text(3966,rank);return {...common(3966,rank),
  thresholdBase:extract(source,/伤害超过(\d+)/,'E threshold'),bonusAdRatio:.1,layers:7,duration:3,range:row(3966,rank).fRange};});
const R=Array.from({length:3},(_,i)=>{const rank=i+1,source=text(6529,rank);return {...common(6529,rank),
  baseDamage:extract(source,/每次投影造成(\d+)\(/,'R base'),totalAdRatio:extract(source,/\{~30\*([\d.]+)\}/,'R total AD'),
  slow:extract(source,/减少(\d+)%移动速度/,'R slow'),criticalMultiplier:extract(source,/造成(\d+)%伤害/,'R crit')/100,
  duration:5,globalRange:15,globalPerHero:3,nearMaximum:10};});
const passive={killAttackPercent:8,killDuration:8,maxKillStacks:7,attackCount:3,
  levelThresholds:[4,8,12,16],outgoingBase:[5,10,15,20,25],returnBase:[15,30,45,60,75],outgoingBonusAd:.25,returnBonusAd:.55};
const policies=Object.freeze({
  qCooldownStarts:'first accepted cast',qRecastDelay:.01,qLandingOffset:.2,qKnockback:1,
  qDashSpeeds:[24,24,28],qWindup:.01,qCountsForPassive:false,
  bladeRange:8,bladeSpeed:18,bladeWidth:.7,bladeBasicCountPhase:'successful basic damage',
  stackRefresh:'refresh all stacks on contribution',assistWindow:10,
  wCostPhase:'charge start',wCooldownPhase:'release/cancel',wExtraCooldown:'20 * charge / 4.5',
  wProjectileSpeed:18,wProjectileWidth:.5,wExplosionRadius:3.35,wStartSkill:6527,wReleaseSkill:3965,
  eLayerLoss:'incoming > threshold ? ceil(incoming/threshold)-1 : 0',eDamagePhase:'post-mitigation-before-shields',
  eDashSpeed:18,eDashDistance:'up to 5 toward point; explicit direction uses 5',
  rNearRadius:5,rBlastRadius:1,rFarPulseAt:[0,5/3,10/3],rNearInterval:.5,rNearFirstAt:.5,
  rFarTargeting:'dynamic heroes within 15, at most 3 per exact object',rNearTargeting:'least-hit then distance/id',
  rSlowDuration:'remaining field life',kannaExtraDamageBasis:null,
  wImpactVisualLife:.35,rProjectionVisualLife:.35,
});
module.exports={Q,W,E,R,passive,policies,source:snapshot.sources.find(x=>x.table==='skill_skilllevel'),
  conflicts:[{skill:6521,uiCooldown:10,configuredCooldown:11},{skill:6527,uiCooldown:W.map(x=>x.cooldown),configuredCooldown:0},
    {skill:6529,uiCooldown:R.map(x=>x.cooldown),configuredCooldown:0},
    {skill:3966,field:'threshold',chosen:E.map(x=>x.thresholdBase),note:'rank2/3 upgrade hints 19→23/23→27 conflict with full per-rank skill descriptions 18/24/30; full current description wins'}]};
