'use strict';
// Base hero 53. Current installed descriptions govern amounts; reconstruction
// policies for missing server scripts are recorded with the release evidence.
const D=require('./arthur-native-data'),S=require('./summoner-effects');
const slots=['Q','W','E','R'],ids=[1882,1888,1889,1890],clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const point=p=>p&&[p.x,p.z].every(v=>Number.isFinite(v)&&v>=0&&v<=655.35);
const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z),pos=e=>({x:e.x,z:e.z});
const current=(sim,e,life=e?.reviveCount)=>!sim.heroes.closed&&sim.winner===null&&sim.entities.get(e?.id)===e&&e.alive&&e.reviveCount===life;
const combat=(sim,e,t)=>current(sim,t)&&sim.enemies(e,t)&&['hero','minion','monster'].includes(t.kind);
const direction=(e,a)=>{let x=point(a)?a.x-e.x:a?.dirX,z=point(a)?a.z-e.z:a?.dirZ;let n=Math.hypot(x,z);if(!Number.isFinite(n)||n<=.0001){x=a?.dirX;z=a?.dirZ;n=Math.hypot(x,z);}return Number.isFinite(n)&&n>.0001?{x:x/n,z:z/n}:null;};
const end=(e,d,n)=>({x:clamp(e.x+d.x*n,0,655.35),z:clamp(e.z+d.z*n,0,655.35)});
const bonus=e=>Math.max(0,e.attributes?.[127]||0),ap=e=>Math.max(0,e.attributes?.[31]||0);
function row(id,rank){return D.skillLevels.find(r=>r.named.nSkillID===id&&r.named.nLevel===rank)?.named;}
function skill(e,slot){const i=slots.indexOf(slot),rank=e.arthur.levels[slot],id=slot==='Q'&&e.arthur.q?1887:ids[i],r=row(id,Math.max(1,rank));return {id,slot,level:rank,type:'hero-specific',range:r.fRange,mana:r.nCostMP||0,cooldown:(row(ids[i],Math.max(1,rank)).nCDTime||0)/1000};}
function resetQ(sim,e){if(!e.arthur.q)return;e.arthur.q=null;e.skills.Q=skill(e,'Q');sim.event('skill-cooldown',{id:e.id,skill:e.skills.Q,readyAt:e.cooldowns.Q||sim.time});}
function bind(sim,e,job){return {...job,life:e.reviveCount,epoch:e.arthur.epoch};}
const valid=(sim,e,j)=>current(sim,e,j.life)&&e.arthur.epoch===j.epoch;
function job(sim,e,kind,delay,more){const j=bind(sim,e,{kind,at:sim.time+delay,...more});e.arthur.jobs.push(j);return j;}
function statusBuff(sim,e,t,{slot,statusId,rank=1,until,...more}){t.buffs=t.buffs.filter(b=>b.slot!==slot);t.buffs.push({slot,until,arthur:true,owner:e,ownerLife:e.reviveCount,targetLife:t.reviveCount,statusId,statusRank:rank,negative:true,debuff:true,...more});t.arthurAffected=true;sim.updateBuffs(t);}
function triggerPassive(sim,e){const s=e.arthur;if(!s||!current(sim,e)||e.hp>=e.hpMax*.25||sim.time<(s.passiveReady||0)||s.heal)return;
 s.passiveReady=sim.time+150;s.heal={life:e.reviveCount,start:sim.time,until:sim.time+5,next:1,paid:0};
}
function cancel(sim,e,reason,{all=false}={}){const s=e.arthur;if(!s)return;if(s.r){sim.event('cast-cancel',{id:e.id,slot:'R',skill:e.skills.R,aim:s.r.aim,reason});s.r.done=true;s.r=null;}
 if(s.dash)sim.event('position',{id:e.id,...pos(e),teleport:true,reason:'arthur-dash-interrupted'});s.dash=null;s.lockUntil=0;s.jobs=[];s.epoch++;if(all){resetQ(sim,e);s.heal=null;s.count=0;} }
function cone(sim,e,origin,dir,radius,callback){const targets=[...sim.entities.values()].map(t=>({t,life:t.reviveCount})),life=e.reviveCount;
 for(const {t,life:tl}of targets){if(!current(sim,e,life))break;if(!combat(sim,e,t)||t.reviveCount!==tl)continue;const dx=t.x-origin.x,dz=t.z-origin.z,n=Math.hypot(dx,dz),along=dx*dir.x+dz*dir.z;
  if(n<=radius+(t.bodyRadius||0)&&along>=0&&(n<.01||along/n>=Math.SQRT1_2))callback(t);}
}
function hitE(sim,e,j){if(!valid(sim,e,j))return;cone(sim,e,j.origin,j.dir,3,t=>{const life=t.reviveCount;
 sim.damage(e,t,j.damage,j.passive?1895:1889,'magic',undefined,j.origin,{allowCritical:false,skillLevel:j.rank,adRatio:.9*j.ratio,apRatio:.65*j.ratio});
 if(valid(sim,e,j)&&current(sim,t,life)&&!S.cleanseActive(sim,t))statusBuff(sim,e,t,{slot:'arthur:E',statusId:11889,rank:j.rank,until:sim.time+3,attackSpeed:-(15+5*j.rank)});
 });}
function eJob(sim,e,dir,passive){const rank=e.arthur.levels.E,ratio=passive?.5:1;if(!rank||!dir)return;
 // Contact follows the native strike cue; nFlyDelay is an independent visual clock, not an additional windup.
 job(sim,e,'E',passive?.15:.222,{origin:pos(e),dir,passive,ratio,rank,damage:(35*rank+.9*e.attackDamage+.65*ap(e))*ratio});
 if(passive)sim.event('skill-prefire',{id:e.id,skill:{id:1895,level:rank},direction:dir});
 if(passive)sim.event('cast',{id:e.id,slot:'EPassive',skill:{id:1895,level:rank,cooldown:0},aim:end(e,dir,3),readyAt:sim.time});
}
function validateCast(sim,e,sk,aim){const s=e.arthur;if(!s||s.sim!==sim||!current(sim,e))return {ok:false,reason:'invalid-owner'};
 if(s.q&&sim.time>=s.q.until)resetQ(sim,e);
 if(!slots.includes(sk.slot)||!s.levels[sk.slot]||e.skills[sk.slot].id!==sk.id||aim.requestedSkillId&&aim.requestedSkillId!==sk.id)return {ok:false,reason:'unlearned-or-stale-skill'};
 if(s.r||s.dash||s.lockUntil>sim.time)return {ok:false,reason:'casting'};
 if(!(sk.slot==='Q'&&s.q)&&(e.cooldowns[sk.slot]||0)>sim.time)return {ok:false,reason:'cooldown'};
 if(e.mp<sk.mana)return {ok:false,reason:'mana'};
 if(sk.slot==='W'){const t=sim.entities.get(aim.targetId);if(!combat(sim,e,t)||t.kind!=='hero'||dist(e,t)>3.5+(t.bodyRadius||0)||!sim.vision.visibleToTeam(t,e.team))return {ok:false,reason:'target'};return {ok:true,target:t};}
 // Native line requests carry caster x/z plus an independent aim direction. Q1 alone carries its destination.
 const dir=direction(e,sk.id===1882?aim:(Number.isFinite(aim.dirX)&&Number.isFinite(aim.dirZ)&&Math.hypot(aim.dirX,aim.dirZ)>.0001?{dirX:aim.dirX,dirZ:aim.dirZ}:aim));return dir?{ok:true,dir}:{ok:false,reason:'direction'};
}
function applyCast(sim,e,sk,aim){const checked=validateCast(sim,e,sk,aim);if(!checked.ok)return checked;const s=e.arthur,rank=sk.level,recast=sk.id===1887;
 sim.cancelWindup(e);sim.cancelChannel(e,'hero-cast');e.mp-=sk.mana;
 if(!recast)e.cooldowns[sk.slot]=sim.time+sk.cooldown*(1-clamp(e.attributes?.[100]||0,0,100)/100);
 sim.event('hero-resource',{id:e.id,hp:e.hp,mp:e.mp});
 const origin=pos(e);if(checked.dir)sim.event('skill-prefire',{id:e.id,skill:{...sk},aim:{...aim},direction:checked.dir});
 let dashEnd;if(sk.slot==='Q'&&!recast){const goal=end(e,checked.dir,point(aim)?Math.min(5.5,dist(e,aim)):5.5),ignoreIds=[...sim.entities.values()].filter(t=>['hero','minion','monster','ward'].includes(t.kind)).map(t=>t.id),trace=sim.traceDisplacement(e,goal,{mode:'dash',ignoreIds});dashEnd=trace.ok?trace.position:origin;sim.stopMotion(e);e.path=[];e.targetId=null;}
 sim.event('cast',{id:e.id,slot:sk.slot,skill:{...sk},aim:{...aim,...(dashEnd||{})},castOrigin:origin,targetIds:checked.target?[checked.target.id]:[],readyAt:recast?e.cooldowns.Q:sk.slot==='Q'?sim.time:e.cooldowns[sk.slot]});
 if(sk.slot==='Q'){
  if(recast){const previous=s.q;resetQ(sim,e);s.lockUntil=sim.time+.6;job(sim,e,'Q2',.18,{origin,dir:checked.dir,rank,previous,damage:5+40*rank+1.05*bonus(e)+.5*ap(e)});}
  else{s.q={until:sim.time+4,hits:new Map()};e.skills.Q=skill(e,'Q');
   s.dash=bind(sim,e,{end:dashEnd,dir:checked.dir,damage:5+40*rank+1.05*bonus(e),rank,interrupted:false});
  }
 }else if(sk.slot==='W'){s.lockUntil=sim.time+.2;job(sim,e,'W',.1,{target:checked.target,targetLife:checked.target.reviveCount,rank});}
 else if(sk.slot==='E'){s.lockUntil=sim.time+.444;eJob(sim,e,checked.dir,false);}
 else {s.r=bind(sim,e,{start:sim.time,until:sim.time+2.5,next:0,origin,dir:checked.dir,aim:{...aim},rank,damage:15+15*rank+.32*e.attackDamage+.20*ap(e),done:false});}
 return {ok:true,recast};
}
function tickDash(sim,e,step){const s=e.arthur,d=s.dash;if(!d||!valid(sim,e,d))return;const from=pos(e),n=dist(from,d.end),length=Math.min(n,20*step),goal=n?end(from,d.dir,length):from;
 const ignoreIds=[...sim.entities.values()].filter(t=>['hero','minion','monster','ward'].includes(t.kind)).map(t=>t.id),trace=sim.traceDisplacement(e,goal,{mode:'dash',ignoreIds});
 const to=trace.ok?trace.position:from;e.x=to.x;e.z=to.z;e.lastMovedAt=sim.time;
 const dx=to.x-from.x,dz=to.z-from.z,den=dx*dx+dz*dz;
 const hits=[...sim.entities.values()].filter(t=>combat(sim,e,t)&&!s.q?.hits.has(t)).map(t=>{const u=den?clamp(((t.x-from.x)*dx+(t.z-from.z)*dz)/den,0,1):0;return {t,u,d:Math.hypot(t.x-from.x-dx*u,t.z-from.z-dz*u)};}).filter(v=>v.d<=1+(v.t.bodyRadius||0)).sort((a,b)=>a.u-b.u||a.t.id-b.t.id);
 for(const {t}of hits){if(!valid(sim,e,d)||!s.q)break;const tl=t.reviveCount;s.q.hits.set(t,tl);sim.damage(e,t,d.damage,1883,'physical',undefined,from,{allowCritical:false,skillLevel:d.rank,adRatio:1.05});
  if(!d.interrupted&&current(sim,t,tl)){d.interrupted=true;sim.control(t.id,.05,e);}}
 if(s.dash===d&&(trace.blocked||n<=length+1e-7)){s.dash=null;sim.event('position',{id:e.id,...pos(e),teleport:true,reason:'arthur-dash-landed'});}
}
function wHit(sim,e,j){const t=j.target;if(!valid(sim,e,j)||!current(sim,t,j.targetLife)||!sim.enemies(e,t))return;
 const delta=t.hp/t.hpMax-e.hp/e.hpMax,until=sim.time+(delta>0?1.5+(.25*(j.rank-1))*clamp(delta/.5,0,1):4);
 if(S.cleanseActive(sim,t)||sim.guardActive(t)||(t.controlImmuneUntil||0)>sim.time||sim.heroes.modifiers(t).controlImmune)return;
 if(delta>0){const duration=(until-sim.time)*(1-clamp(t.attributes?.[99]||0,0,100)/100),endAt=sim.time+duration;
  statusBuff(sim,e,t,{slot:'arthur:taunt',statusId:11894,until:endAt,tauntOwner:e});sim.interruptSkills(t,'taunt');sim.cancelChannel(t,'taunt');sim.cancelWindup(t);sim.stopMotion(t);t.targetId=e.id;t.path=[];
  for(const [who,other]of [[e,t],[t,e]])statusBuff(sim,e,who,{slot:'arthur:duel',statusId:0,until:endAt,negative:false,debuff:false,duelOther:other,otherLife:other.reviveCount});
 }else statusBuff(sim,e,t,{slot:'arthur:Wslow',statusId:11895,rank:j.rank,until,speed:1-(.3+.075*(j.rank-1))});
}
function tick(sim,e,step){e.buffs=e.buffs.filter(b=>!b.arthur||b.targetLife===e.reviveCount&&current(sim,b.owner,b.ownerLife));const s=e.arthur;if(!s||s.sim!==sim)return;if(!current(sim,e)){cancel(sim,e,'death',{all:true});return;}
 if(s.q&&sim.time>=s.q.until)resetQ(sim,e);triggerPassive(sim,e);
 const h=s.heal;if(h){if(h.life!==e.reviveCount)s.heal=null;else{while(h.next<=50&&sim.time+1e-8>=h.start+h.next*.1){const total=Math.floor(e.hpMax*.25*h.next/50);sim.heal(e,Math.max(0,total-h.paid),{skillId:1891,reason:'arthur-avalon'});h.paid=total;h.next++;}if(h.next>50)s.heal=null;}}
 tickDash(sim,e,step);
 const due=s.jobs.filter(j=>j.at<=sim.time+1e-8);s.jobs=s.jobs.filter(j=>j.at>sim.time+1e-8);
 for(const j of due){if(!valid(sim,e,j))continue;if(j.kind==='E')hitE(sim,e,j);else if(j.kind==='W')wHit(sim,e,j);else if(j.kind==='Q2')cone(sim,e,j.origin,j.dir,3.5,t=>{const tl=t.reviveCount;sim.damage(e,t,j.damage,1887,'physical',undefined,j.origin,{allowCritical:false,skillLevel:j.rank,adRatio:1.05,apRatio:.5});if(!valid(sim,e,j)||!current(sim,t,tl))return;
  const enhanced=j.previous.hits.get(t)===tl,height=enhanced?2:1.5,acceleration=enhanced?15:30,duration=2*Math.sqrt(2*height/acceleration);
  if(sim.knockup(t.id,duration,e,{statusId:0,warSoulEntry:false,height,acceleration})){sim.displace(t,end(t,j.dir,.6),{mode:'push',ignoreIds:[e.id]});sim.event('equipment-visuals',{id:t.id,packets:require('./battle-native').cast({type:'cast',time:sim.time,readyAt:sim.time,aim:pos(t),targetIds:[t.id]},t,{id:enhanced?1897:1896,level:1,cooldown:0})});}
 });}
 const r=s.r;if(r&&valid(sim,e,r)){
  while(s.r===r&&valid(sim,e,r)&&r.next<15&&sim.time+1e-8>=r.start+1+r.next*.1){
   if(!r.next)sim.event('arthur-beam',{id:e.id,modelJob:r});r.next++;
   for(const t of [...sim.entities.values()]){if(!valid(sim,e,r)||s.r!==r)break;if(!combat(sim,e,t))continue;const dx=t.x-r.origin.x,dz=t.z-r.origin.z,along=dx*r.dir.x+dz*r.dir.z,side=Math.abs(dx*r.dir.z-dz*r.dir.x),tl=t.reviveCount;
    if(along>=0&&along<=38+(t.bodyRadius||0)&&side<=.5+(t.bodyRadius||0)){sim.damage(e,t,r.damage,1892,'magic',undefined,r.origin,{allowCritical:false,skillLevel:r.rank,adRatio:.32,apRatio:.2});
     if(current(sim,t,tl)&&valid(sim,e,r)&&!S.cleanseActive(sim,t))statusBuff(sim,e,t,{slot:'arthur:Rslow',statusId:11898,until:sim.time+.2,speed:.5});}}
  }
  if(sim.time+1e-8>=r.until&&s.r===r){sim.event('cast-complete',{id:e.id,slot:'R',skill:e.skills.R,aim:r.aim});r.done=true;s.r=null;}
 }
}
function modifiers(sim,e){const own=e.arthur;return {attackSpeed:own?.levels.W?10+10*own.levels.W:0};}
function beforeDamage(sim,t,a,hit){let reduction=1;const h=t.arthur?.heal;if(h&&h.life===t.reviveCount&&h.until>sim.time)reduction*=.6;
 if(t.buffs.some(b=>b.duelOther&&b.until>sim.time&&b.targetLife===t.reviveCount&&current(sim,b.duelOther,b.otherLife)&&current(sim,b.owner,b.ownerLife)&&b.duelOther!==a))reduction*=.7;
 return {received:hit.received*reduction};
}
function onBasicHit(sim,e,t){const s=e.arthur,life=e.reviveCount;if(!current(sim,e)||!s)return;
 if(s.levels.W&&current(sim,t)){const difference=Math.max(0,e.clientAttackSpeed-t.clientAttackSpeed);if(difference>0)sim.damage(e,t,difference,1888,'physical',undefined,pos(e),{basic:false,ignoreArmor:true,allowCritical:false,skillLevel:s.levels.W});}
 if(!current(sim,e,life))return;if(s.levels.E&&++s.count>=4){s.count=0;eJob(sim,e,direction(e,t),true);}
}
module.exports={heroId:53,name:'arthur',isInstalled:e=>!!e.arthur,affects:e=>!!e.arthurAffected,
 install(sim,e,{levels={Q:5,W:5,E:5,R:3}}={}){if(e.heroId!==53||e.arthur)return false;if(Object.keys(levels).length!==4||!slots.every((x,i)=>Number.isInteger(levels[x])&&levels[x]>=0&&levels[x]<=(i===3?3:5)))throw Error('Explicit Arthur ranks required');
  e.arthur={sim,levels:{...levels},epoch:0,jobs:[],q:null,r:null,dash:null,lockUntil:0,count:0,passiveReady:0,heal:null};for(const slot of slots)e.skills[slot]=skill(e,slot);e.attackSkillId=1881;e.attackAliases=[1880];return true;},
 ownsSkill:(_sim,_e,sk)=>[...ids,1887].includes(sk.id),resolveSkill:(_sim,e,value)=>{const slot=slots.find(x=>x===value||e.skills[x]?.id===value);return slot?e.skills[slot]:null;},
 validateCast,applyCast,modifiers,tick,beforeDamage,onBasicHit,onDamageTaken:(sim,e)=>triggerPassive(sim,e),
 canAct:(_sim,e)=>!e.arthur.r&&!e.arthur.dash&&e.arthur.lockUntil<=_sim.time,
 onMoveOrder(sim,e){if(e.arthur.r)cancel(sim,e,'move');},onControl:(sim,e,reason)=>cancel(sim,e,reason),
 onRespawn:(sim,e)=>cancel(sim,e,'respawn',{all:true}),onLeave:(sim,e)=>cancel(sim,e,'leave',{all:true}),
 world:{onDeath(sim,_killer,e,context){if(e.arthur&&context.targetLife===e.reviveCount)cancel(sim,e,'death',{all:true});}},
 native:{castAction:(_event,_e,sk)=>sk.id===1882?0:undefined,sync:(sim,e,o)=>require('./arthur-native').sync(sim,e,o),beforeCast:(sim,e)=>require('./arthur-native').sync(sim,e),
  castPosition:(event,e,sk)=>[1887,1889,1890,1895].includes(sk.id)?event.castOrigin??e:undefined,
  isProjectileEvent:(_e,event)=>event.type==='arthur-beam',projectile:(e,event,id)=>require('./arthur-native').beam(e,event,id),
  tickProjectile:(state,time)=>require('./arthur-native').tickBeam(state,time),finishProjectile:state=>require('./arthur-native').finishBeam(state)}
};
