'use strict';
// Current Ikaros resource candidates. Pairing same-number SBullet/SStatu is a
// documented baseline choice, not proof of the original script's type13 pair.
const T=require('../../../projectile-type13-native'),W=require('../../../battle-wire'),data=require('./parameters.json');
const MODELS={Q:3583,R:3588,explosion:3590},leases=new WeakMap(),claimed=new WeakSet(),EPS=1e-8;
for(const id of Object.values(MODELS))if(!data.hero.bullets.some(r=>r.named.nBulletID===id)||!data.hero.bulletStatuses.some(r=>r.named.nBulletStatuID===id))throw Error('Missing current Ikaros projectile candidate');
const POLICY=Object.freeze({models:MODELS,pairing:'current same-number table candidate; original script pairing unconfirmed',flags:[0,0,0],parameterByte:0,nativeAccepted:false});
function valid(l){const p=l.p,e=l.hero,sim=l.sim;return !sim.heroes.closed&&sim.entities.get(e.id)===e&&e.alive&&e.reviveCount===p.ownerLife&&!e.ikarosBattle.closed&&
  e.ikarosBattle.nativeActors.get(p.id)===p&&p.world===sim&&p.owner===e&&!p.ended&&!sim.entities.has(p.id);}
function frame(l,tag){const p=l.p,id=MODELS[p.kind],d=p.direction||{x:0,z:0},end=p.endpoint||{x:p.x,z:p.z};return T.write({id:p.id,owner:l.hero.id,position:{x:p.x,z:p.z},
  directionRaw:[Math.round(d.x*100),Math.round(d.z*100)],movementWord:p.kind==='explosion'?0:180,bulletId:id,stateId:id,endpoint:end,team:l.hero.team,parameterByte:0,flags:[0,0,0],tag,frameFlags:0});}
function launch(e,event,_id){const p=e?.ikarosBattle?.nativeActors.get(event.projectileId);if(!p||claimed.has(p)||e.heroId!==138||!e.alive||e.ikarosBattle.closed||event.id!==e.id||p.owner!==e||p.world.entities.get(e.id)!==e||e.reviveCount!==p.ownerLife||p.world.heroes.closed||p.world.entities.has(p.id))return null;
  if(!['ikaros-projectile-create','ikaros-explosion-create'].includes(event.type))return null;const l={hero:e,p,sim:p.world,done:false,lastTime:p.world.time},s={kind:'ikaros-'+p.kind,id:p.id,owner:e.id};
  Object.defineProperty(s,'done',{enumerable:true,get:()=>l.done});Object.defineProperty(s,'expires',{enumerable:true,get:()=>p.expiresAt??Infinity});claimed.add(p);leases.set(s,l);l.lastFrame=frame(l,1050);return {state:s,packets:[l.lastFrame]};}
function finish(s){const l=leases.get(s);if(!l||l.done)return [];l.done=true;if(l.hero.ikarosBattle?.nativeActors.get(l.p.id)===l.p)l.hero.ikarosBattle.nativeActors.delete(l.p.id);
  if(l.sim.entities.has(l.p.id))return [];const b=Buffer.alloc(6);b.writeUInt16LE(1);b.writeUInt32LE(l.p.id,2);return [W.frame(1369,l.p.id),W.frame(1021,l.p.id,b)];}
function tick(s,time){const l=leases.get(s);if(!l||l.done)return [];if(!Number.isFinite(time)||time<l.lastTime-EPS||Math.abs(l.sim.time-time)>EPS)throw Error('Ikaros projectile uses its authoritative world clock');l.lastTime=time;
  if(!valid(l))return finish(s);const f=frame(l,1051);if(f.subarray(12).equals(l.lastFrame.subarray(12)))return [];l.lastFrame=f;return [f];}
module.exports={POLICY,launch,tick,finish};
