'use strict';
const contracts=require('../second-batch/base-contracts.json');
const source=contracts.heroes.find(row=>row.heroId===102);
if(!source||source.defaultAttackId!==2861||source.passiveId!==2870)throw Error('Current Kirito contract missing');
const compact=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['completeSourceText','normalPresentationText','recast'].includes(key)));
const UI=Object.freeze({Q:source.Q.map(compact),W:source.W.map(compact),E:source.E.map(row=>({...compact(row),recastCooldown:row.recast.cooldownSeconds,recastRange:row.recast.configured.fRange})),R:source.R.map(compact),passive:source.passive,
 sourceSnapshotSha256:contracts.sourceSnapshotSha256,conditionalDeferred:source.conditionalDeferred});
const POLICY=Object.freeze({basis:'current full UI arithmetic; explicit base geometry/timing, pending installed-client acceptance',
 basicWindup:.2,basicProjectileSpeed:0,alternateAttack2860:false,
 qSpeed:15,qPushDistance:1,qWidth:.45,qLandingOffset:.15,qFollowTarget:false,qStructuresKnockback:false,
 wHalfAngle:Math.PI*.33,wContactDelay:.164,wAttackBonus:'refresh one flat bonus; compute damage before own new bonus',
 eSpeed:15,eWidth:.6,eCastDelay:.3,eRange:7.5,eMarkStart:'on actual contact',eRecastWindowStart:'first cast',
 eRecastConsumesMark:false,eShadowConsumedOnClick:true,eShadowClickRange:12,eBlinkOffset:.15,
 rPairCount:8,rPairInterval:.15,rFirstAt:.264,rRadius:.8,rFollowTarget:true,rEnd:'after eighth paired contact or target unavailable',
 rReductionRefresh:'each pair refreshes one second; final pair leaves one second reduction',rVisualLife:.15,
 equalityHalfDisplay:'half',visionRadius:10,visionFallback:'enemy alive entities within radius and terrain line of sight',
 passiveBreak:'landed actual attack, including absorption/block, disables speed for3s; miss/invalid invulnerable hit does not',rounding:'BattleSim damage floors once after modifiers',
 talent:false,exclusiveEquipment:false});
module.exports={UI,POLICY};
