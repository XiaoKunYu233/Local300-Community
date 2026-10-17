'use strict';
const C=require('../../../projectile-type13-native'),W=require('../../../battle-wire');
const source=require('../second-batch/snapshot.json').heroes.find(row=>row.heroId===102);
const bullets=new Map(source.bullets.map(row=>[row.named.nBulletID,row.named])),statuses=new Set(source.bulletStatuses.map(row=>row.named.nBulletStatuID));
const emitted=new WeakSet(),leases=new WeakMap(),activeIds=new WeakMap(),EPS=1e-8;
const uint=id=>Number.isInteger(id)&&id>0&&id<=0xffffffff;
function valid(owner,job){const s=owner?.kiritoBase,sim=s?.sim;return !!sim&&!sim.heroes.closed&&sim.winner===null&&sim.entities.get(owner.id)===owner&&owner.alive&&
 job?.sim===sim&&job.owner===owner&&job.life===owner.reviveCount&&job.epoch===s.epoch&&s.issued.has(job)&&!job.done;}
function current(lease){const {identity:i}=lease;return valid(i.owner,i.job)&&i.behavior.sim===i.world&&i.job.sim===i.world&&i.world.entities.get(i.ownerId)===i.owner&&i.owner.heroId===102&&i.owner.id===i.ownerId&&i.owner.kiritoBase===i.behavior&&
 i.owner.reviveCount===i.life&&i.behavior.epoch===i.epoch&&i.job.kind===i.kind&&i.job.bulletId===i.bulletId&&i.job.life===i.life&&i.job.epoch===i.epoch&&
 (i.kind!=='shadow'||i.job.id===i.id&&i.job.interaction===i.interaction&&i.world.objects.owned(i.owner,i.id)===i.interaction)&&
 !i.world.entities.has(i.id)&&activeIds.get(i.world)?.get(i.id)===lease;}
function frame(native,tag){const lease=leases.get(native);if(!lease||lease.done||!current(lease))throw Error('Invalid Kirito native lease');const {identity:i}=lease,job=i.job,e=i.owner;
 // parameter0 is the explicit no-auxiliary-circle policy proven by current
 // type13 consumer; flags0 avoid the owner-relative origin rewrite. Neither is
 // interpreted as lifetime, flight height or skill damage.
 return C.write({id:i.id,owner:i.ownerId,position:job.p,directionRaw:job.dir?[Math.round(job.dir.x*100),Math.round(job.dir.z*100)]:[0,0],
  movementWord:Math.round(job.nativeSpeed*10),bulletId:i.bulletId,stateId:i.bulletId,endpoint:job.end,team:e.team,parameterByte:0,flags:[0,0,0],tag});
}
function launch(e,event,id){const job=event?.modelJob;if(!valid(e,job)||emitted.has(job)||event.type!=='kirito-projectile'||event.id!==e.id||event.kind!==job.kind||event.bulletId!==job.bulletId)return null;
 if(![2864,2865,2869].includes(job.bulletId)||!bullets.has(job.bulletId)||!statuses.has(job.bulletId))throw Error('Current Kirito projectile resource missing');
 const s=e.kiritoBase,world=s.sim;if(!Number.isFinite(event.time)||event.time<0||event.time>world.time+EPS)return null;
 const nativeId=job.kind==='shadow'?job.interaction?.id:id;
 if(!uint(nativeId)||nativeId===e.id||world.entities.has(nativeId))throw Error('Invalid Kirito native projectile identity');
 if(job.kind==='shadow'&&(nativeId!==job.id||world.objects.owned(e,nativeId)!==job.interaction))throw Error('Kirito shadow requires its original interaction lease');
 let ids=activeIds.get(world);if(!ids){ids=new Map();activeIds.set(world,ids);}if(ids.has(nativeId))throw Error('Kirito native projectile identity already claimed');
 const identity=Object.freeze({id:nativeId,owner:e,ownerId:e.id,job,world,behavior:s,life:e.reviveCount,epoch:s.epoch,kind:job.kind,bulletId:job.bulletId,
  interaction:job.kind==='shadow'?job.interaction:undefined,expiresAt:Number.isFinite(job.until)?job.until:Infinity});
 const lease={identity,done:false,lastTime:world.time},native={};
 Object.defineProperties(native,{id:{enumerable:true,value:nativeId},owner:{enumerable:true,value:e},job:{enumerable:true,value:job},done:{enumerable:true,get:()=>lease.done}});Object.freeze(native);
 leases.set(native,lease);ids.set(nativeId,lease);let packet;try{packet=frame(native,1050);}catch(error){leases.delete(native);ids.delete(nativeId);throw error;}
 emitted.add(job);return {state:native,packets:[packet]};
}
function finish(native){const lease=leases.get(native);if(!lease||lease.done)return [];lease.done=true;const i=lease.identity,ids=activeIds.get(i.world),owned=ids?.get(i.id)===lease;
 if(owned)ids.delete(i.id);
 // The actor ID belongs to this immutable private lease. Once a real entity
 // reuses it, neither1369 nor1021 may target that unrelated actor.
 if(!owned||i.world.entities.has(i.id))return [];
 const payload=Buffer.alloc(6);payload.writeUInt16LE(1);payload.writeUInt32LE(i.id,2);
 return [W.frame(1369,i.id),W.frame(1021,i.id,payload)];}
function tick(native,time){const lease=leases.get(native);if(!lease||lease.done)return [];const i=lease.identity;
 if(!Number.isFinite(time)||time<lease.lastTime-EPS||Math.abs(time-i.world.time)>EPS)throw Error('Kirito native projectile must sample its authoritative world clock');lease.lastTime=time;
 if(!current(lease))return finish(native);
 if(time>=i.expiresAt)return finish(native);return [frame(native,1051)];}
module.exports={launch,tick,finish,frame};
