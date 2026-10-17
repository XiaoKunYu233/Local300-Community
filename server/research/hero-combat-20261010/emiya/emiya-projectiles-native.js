'use strict';
const path=require('path'),codec=require(path.resolve(__dirname,'../../../projectile-type13-native')),
 W=require(path.resolve(__dirname,'../../../battle-wire'));
const snapshot=require('./snapshot.json'),states=new WeakSet(),launchedJobs=new WeakSet();
const bullets=new Map(snapshot.bullets.map(x=>[x.named.nBulletID,x.named])),
 bulletStates=new Map(snapshot.bulletStatuses.map(x=>[x.named.nBulletStatuID,x.named]));
const resources=Object.freeze({blade:{bulletId:3961,stateId:3961},return:{bulletId:3960,stateId:3960},
 w:{bulletId:3968,stateId:3968},'w-impact':{bulletId:3969,stateId:3969},'r-projection':{bulletId:6530,stateId:6530}});
for(const r of Object.values(resources))if(!bullets.get(r.bulletId)?.strModelFile||!bulletStates.has(r.stateId))throw Error('Missing current Emiya native projectile resource');
const point=p=>p&&[p.x,p.z].every(v=>Number.isFinite(v)&&v>=0&&v<=655.35);
const uint=x=>Number.isInteger(x)&&x>0&&x<=0xffffffff;
function current(state){const {sim,owner,behavior,job,epoch,life}=state;
 return !sim.heroes.closed&&sim.winner===null&&sim.entities.get(owner.id)===owner&&owner.alive&&
  owner.emiyaBase===behavior&&behavior.epoch===epoch&&owner.reviveCount===life&&behavior.issuedJobs.has(job);
}
function data(state,{initial=false,stopped=false}={}){
 const {job,owner}=state,kind=job.kind==='blade'&&job.leg==='return'?'return':job.kind,r=resources[kind];
 if(!r)throw Error('Unknown native Emiya job kind');
 const position=initial?job.origin:job.p,endpoint=stopped?job.p:
  job.kind==='blade'&&job.leg==='return'?job.returnEnd:job.end;
 if(!point(position)||!point(endpoint)||!Number.isFinite(job.nativeSpeed)||job.nativeSpeed<0)throw Error('Invalid native Emiya job geometry');
 const dx=endpoint.x-position.x,dz=endpoint.z-position.z,length=Math.hypot(dx,dz);
 return {id:state.id,owner:owner.id,position:{...position},endpoint:{...endpoint},
  directionRaw:length>1e-9?[Math.round(dx/length*100),Math.round(dz/length*100)]:[0,0],
  movementWord:stopped?0:Math.round(job.nativeSpeed*10),bulletId:r.bulletId,stateId:r.stateId,team:owner.team,
  // Current bf4239 divides this byte by ten into +4444; world queue 143f5c0
  // skips the circular submission for <=0. The base visual adds no radius.
  parameterByte:0,
  // First byte zero skips bf42ef's owner-relative spawn repositioning.
  // The remaining two zero bytes are preserved observed compact defaults.
  flags:[0,0,0]};
}
function signature(value){return JSON.stringify([Math.round(value.position.x*100),Math.round(value.position.z*100),
 Math.round(value.endpoint.x*100),Math.round(value.endpoint.z*100),...value.directionRaw,value.movementWord,value.bulletId,value.stateId]);}
function launch(owner,event,id){
 const sim=owner?.emiyaBase?.sim,behavior=owner?.emiyaBase,job=event?.modelJob;
 if(!sim||!behavior||event.type!=='emiya-projectile'||event.id!==owner.id||!job||!resources[job.kind]||
   !behavior.issuedJobs.has(job)||job.epoch!==behavior.epoch||job.life!==owner.reviveCount||
   sim.entities.get(owner.id)!==owner||!owner.alive||sim.heroes.closed||sim.winner!==null)return null;
 if(!Number.isFinite(event.time)||event.time<0||event.time>sim.time)return null;
 if(!uint(id)||id===owner.id||sim.entities.has(id))throw Error('Invalid Emiya native projectile identity');
 if(launchedJobs.has(job))return null;
 const state={id,owner,sim,behavior,job,epoch:behavior.epoch,life:owner.reviveCount,
  done:false,lastAt:event.time,last:null};
 // Always create with the original outgoing resource, even if flush sees the
 // same model already returning. tick sends its current phase on this actor.
 const originalLeg=job.leg;let initial;
 if(job.kind==='blade'&&originalLeg==='return'){
  const source={...job,leg:'out'};initial=data({...state,job:source},{initial:true});
 }else initial=data(state,{initial:true});
 const packet=codec.write(initial);state.last=signature(initial);states.add(state);launchedJobs.add(job);
 return {state,packets:[packet]};
}
function finish(state){
 if(!states.has(state)||state.done)return [];
 state.done=true;
 const payload=Buffer.alloc(6);payload.writeUInt16LE(1);payload.writeUInt32LE(state.id,2);
 // Current bfc1b0 applies projectile finish; bfbb50 removes the actor list.
 return [W.frame(1369,state.id),W.frame(1021,state.id,payload)];
}
function tick(state,time){
 if(!states.has(state)||state.done)return [];
 if(!Number.isFinite(time)||time<state.lastAt||time!==state.sim.time)throw Error('Native projectile must sample its current model clock');
 state.lastAt=time;if(!current(state))return finish(state);
 const next=data(state,{stopped:!!state.job.done}),key=signature(next),packets=[];
 if(key!==state.last){packets.push(codec.write({...next,tag:1051}));state.last=key;}
 if(state.job.done)packets.push(...finish(state));return packets;
}
module.exports={resources,launch,tick,finish};
