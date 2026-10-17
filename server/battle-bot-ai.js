'use strict';
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
function prepare(sim,bots){
 const lanes=sim.lanes.filter(l=>l.team===1);
 const home=[...sim.entities.values()].find(e=>e.kind==='fountain'&&e.team===1);
 if(!home||lanes.length!==3||bots.length!==3)throw Error('Three enemy lanes and a fountain are required');
 bots.forEach((e,index)=>{
  const spawn=sim.freeSpawn({x:home.x+(index-1)*2,z:home.z+2},e.bodyRadius,e.id);
  Object.assign(e,{testDummy:false,battleBot:true,skinId:require('./battle-protocol').readSpawn(e.template).skinId||0,alive:false,hp:0,respawnAt:Infinity,home:spawn,x:spawn.x,z:spawn.z,
   name:`敌方英雄${index+1}`,nameBytes:require('./gbk').encode(`敌方英雄${index+1}`),
   bot:{enterAt:[10,30,50][index],entered:false,lane:lanes[index].path.map(p=>({...p})),retreatUntil:0}});
  e.reviveStatus=require('./hero-bootstrap-native').statusReset({id:e.id,heroId:e.heroId,skinId:e.skinId});e.skills.D=require('./summoner-effects').definition(8035);e.skills.F=require('./summoner-effects').definition(8026);
  if(e.identity){e.identity.fill(0,24,39);e.nameBytes.copy(e.identity,24,0,14);}
 });
}
function tick(sim){
 for(const e of sim.entities.values())if(e.battleBot&&!e.bot.entered&&sim.time+1e-9>=e.bot.enterAt){
  const pos=sim.freeSpawn(e.home,e.bodyRadius,e.id);Object.assign(e,pos,{alive:true,hp:e.hpMax,mp:e.mpMax});
  e.bot.entered=true;e.path=e.bot.lane.map(p=>({...p}));e.pathIndex=0;
  sim.event('spawn',{id:e.id});sim.event('bot-enter',{id:e.id,lane:sim.lanes.filter(l=>l.team===1)[[...sim.entities.values()].filter(v=>v.battleBot).indexOf(e)]?.id});
 }
}
function update(sim,e,step){
 if(!e.battleBot||!e.bot.entered||!e.alive)return false;
 const towers=[...sim.entities.values()].filter(t=>t.kind==='tower'&&t.alive&&t.team!==e.team);
 const threatened=towers.some(t=>(t.targetId===e.id&&distance(t,e)<=t.range+(e.bodyRadius||0))||sim.shots.some(s=>s.id===t.id&&s.target===e.id));
 if(threatened)e.bot.retreatUntil=sim.time+3;
 if(e.hp<e.hpMax*.3)e.bot.low=true;
 if(e.bot.low&&e.hp>=e.hpMax*.9)e.bot.low=false;
 if(e.bot.low||sim.time<e.bot.retreatUntil){
  sim.cancelWindup(e);e.targetId=null;
  if(!e.bot.retreatPath){
   let nearest=0;for(let i=1;i<e.bot.lane.length;i++)if(distance(e,e.bot.lane[i])<distance(e,e.bot.lane[nearest]))nearest=i;
   e.bot.retreatPath=[...e.bot.lane.slice(0,nearest+1).reverse().map(p=>({...p})),{...e.home}];e.bot.retreatIndex=0;sim.stopMotion(e);
  }
  const route=e.bot.retreatPath;
  while(e.bot.retreatIndex<route.length-1&&(distance(e,route[e.bot.retreatIndex])<=(e.bodyRadius||.4)+.1||require('./battle-motion-collision').arrived(e))){e.bot.retreatIndex++;sim.stopMotion(e);}
  if(distance(e,e.home)>1&&require('./summoner-effects').canAct(sim,e,'move')&&!e.effectModifiers?.rooted)sim.stepToward(e,route[e.bot.retreatIndex],step,.1);else sim.stopMotion(e);
  return true;
 }
 if(e.bot.retreatPath){delete e.bot.retreatPath;e.path=[];sim.stopMotion(e);}
 const candidates=[...sim.entities.values()].filter(t=>sim.enemies(e,t)&&sim.vision.visibleToTeam(t,e.team)&&distance(e,t)<=12&&['hero','minion','tower','barracks','base'].includes(t.kind));
 candidates.sort((a,b)=>(a.kind==='hero'?0:a.kind==='minion'?1:2)-(b.kind==='hero'?0:b.kind==='minion'?1:2)||distance(e,a)-distance(e,b)||a.id-b.id);
 e.targetId=candidates[0]?.id??null;
 if(!e.targetId&&(!e.path.length||e.pathIndex>=e.path.length)){
  e.path=e.bot.lane.map(p=>({...p}));let nearest=0;
  for(let i=1;i<e.path.length;i++)if(distance(e,e.path[i])<distance(e,e.path[nearest]))nearest=i;e.pathIndex=nearest;
 }
 return false;
}
function fountain(sim,e){
 if(!e.alive||!e.fountainDefense||sim.time+1e-9<(e.fountainAttackAt||0))return;
 const targets=[...sim.entities.values()].filter(t=>sim.enemies(e,t)&&['hero','minion'].includes(t.kind)&&distance(e,t)<=(e.recoveryRadius||9));
 targets.sort((a,b)=>(a.kind==='hero'?0:1)-(b.kind==='hero'?0:1)||distance(e,a)-distance(e,b)||a.id-b.id);
 const target=targets[0];if(!target)return;
 e.fountainAttackAt=sim.time+.4;
 sim.damage(e,target,5000+target.hpMax*.1,8062,'true',undefined,undefined,{basic:false,equipmentProcs:false});
}
module.exports={prepare,tick,update,fountain};
