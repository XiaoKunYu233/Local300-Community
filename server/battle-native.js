'use strict';
const B=require('./battle-protocol');
const P=require('./battle-protobuf');
const W=require('./battle-wire');
const {nativeFor}=require('./hero-runtime');
const val=(number,value)=>({number,wire:0,value:BigInt(value)});

function spawn(template,entity) {
  const source=B.readSpawn(template);
  if(!source||!['monster','hero'].includes(source.kind))throw new Error('Combat spawn template required');
  let out=Buffer.from(template);
  if(source.kind==='hero'&&entity.nameBytes){
    const header=Buffer.from(out.subarray(12,16));header.writeUInt16LE(entity.nameBytes.length+1,2);
    out=W.frame(out.readUInt16LE(8),source.id,Buffer.concat([header,entity.nameBytes,Buffer.from([0]),out.subarray(12+source.offset)]));
  }
  const p=out.subarray(12),o=4+p.readUInt16LE(2);
  if(!Number.isInteger(entity.hp)||!Number.isInteger(entity.hpMax)||entity.hp<0||entity.hp>entity.hpMax)throw new Error('Invalid spawn HP');
  for(const n of [entity.x,entity.z])if(!Number.isFinite(n)||n<0||n>655.35)throw new Error('Invalid spawn position');
  // Self-references in attached status records belong to the cloned entity too.
  const old=Buffer.alloc(4),next=Buffer.alloc(4);old.writeUInt32LE(source.id);next.writeUInt32LE(entity.id);
  for(let at=0;(at=p.indexOf(old,at))!==-1;at+=4)next.copy(p,at);
  if(entity.monsterId&&entity.monsterId!==source.monsterId) {
    const original=Buffer.alloc(4),replacement=Buffer.alloc(4);original.writeUInt32LE(source.monsterId);replacement.writeUInt32LE(entity.monsterId);
    for(let at=0;(at=p.indexOf(original,at))!==-1;at+=4)replacement.copy(p,at);
  }
  out.writeUInt32LE(entity.id,4);
  p.writeUInt16LE(Math.round(entity.x*100),o);p.writeUInt16LE(Math.round(entity.z*100),o+2);
  p.writeUInt32LE(Math.max(0,Math.round(entity.hp))>>>0,o+9);
  p.writeUInt32LE(Math.max(0,Math.round(entity.hpMax))>>>0,o+13);
  if(entity.level)p[o+8]=entity.level;
  if(source.kind==='monster'){
    p.writeUInt32LE(Math.max(0,Math.round(entity.attackDamage||0))>>>0,o+41);
    p.writeUInt16LE(Math.max(0,Math.round(entity.armor||0))&0xffff,o+45);
    p.writeUInt16LE(Math.max(0,Math.round(entity.magicResistance||0))&0xffff,o+47);
  }
  if(entity.hp>0)p[o+17]&=~4;
  if(![1,2,3].includes(entity.team))throw new Error('Invalid spawn faction');
  p[o+source.teamOffset-source.offset]=entity.team;
  return out;
}
function damage(event,attacker) {
  const simple=attacker&&attacker.kind!=='hero';
  // BRS fires the primary active and reports contact through its native hit
  // child. Preserve the real simulation skill separately in combat logs.
  const presentation=nativeFor(attacker)?.damagePresentation?.(attacker,event);
  const nativeSkill=presentation?.skillId??event.skillId;
  const known=Object.values(attacker?.skills||{}).find(skill=>skill.id===event.skillId);
  const level=event.skillLevel||presentation?.level||known?.level||1;
  const targets=(event.hits||[event]).map(hit=>{
    const fields=[val(1,hit.target),val(2,hit.amount),val(8,hit.hp)];
    const hitEffect=hit.nativeHitEffectFlag??(hit.type==='miss'?1:undefined);
    if(hitEffect!==undefined){
      if(!Number.isInteger(hitEffect)||hitEffect<0||hitEffect>0xffffffff)throw Error('Invalid native hit effect flags');
      fields.push(val(3,hitEffect));
    }
    if(hit.nativeHitPosition!==undefined){
      const p=hit.nativeHitPosition;
      if(!p||![p.x,p.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35))throw Error('Invalid native hit position');
      fields.push(val(6,Math.round(p.x*1000)),val(7,Math.round(p.z*1000)));
    }
    return {fields};
  });
  const fields=[val(2,level),val(6,1),val(7,event.replayId||0),val(8,presentation?.action??(nativeSkill!==event.skillId?2:1)),
    ...targets.map(target=>({number:11,wire:2,bytes:P.encode(target.fields)}))];
  if(nativeSkill&&!simple)fields.unshift(val(1,nativeSkill));
  const origin=event.origin||attacker;
  if(attacker&&!simple)fields.splice(event.skillId?2:1,0,val(4,Math.round(origin.x*1000)),val(5,Math.round(origin.z*1000)));
  return B.writeSkill({tag:simple||!event.skillId?11042:11005,actor:event.attacker,fields,targets});
}
function remove(id) {const p=Buffer.alloc(6);p.writeUInt16LE(1);p.writeUInt32LE(id,2);return W.frame(1021,id,p);}
function path(id,points) {
  if(!points.length||points.length>256)throw new Error('Invalid path');
  const p=Buffer.alloc(9+8*(points.length-1));p[8]=points.length-1;
  points.forEach((point,i)=>{const o=i?9+(i-1)*8:0;
    if(![point.x,point.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35))throw new Error('Invalid path coordinates');
    p.writeUInt32LE(Math.round(point.x*100),o);p.writeUInt32LE(Math.round(point.z*100),o+4);
  });
  return W.frame(27105,id,p);
}
function heroHP(id,hp) {const p=Buffer.alloc(6);p[0]=1;p[1]=1;p.writeUInt32LE(Math.max(0,Math.round(hp))>>>0,2);return W.frame(1045,id,p);}
function heroVitals(id,hp,mp,state,reviveCount) {
  if(![hp,mp].every(n=>Number.isFinite(n)&&n>=0))throw new Error('Invalid hero vitals');
  const rows=[[1,Math.round(hp)],[2,Math.round(mp)]];
  if(reviveCount!==undefined)rows.push([7,reviveCount]);
  if(state!==undefined)rows.push([74,state]);
  const p=Buffer.alloc(1+5*rows.length);p[0]=rows.length;
  rows.forEach(([attr,value],i)=>{p[1+i*5]=attr;p.writeUInt32LE(Math.max(0,Math.round(value))>>>0,2+i*5);});
  return W.frame(1045,id,p);
}
function position(id,x,z,dx=0,dz=0) {
  if(![x,z,dx,dz].every(Number.isFinite)||x<0||z<0||x>655.35||z>655.35)throw new Error('Invalid position');
  const p=Buffer.alloc(16),length=Math.hypot(dx,dz);
  p.writeUInt32LE(Math.round(x*100),0);p.writeUInt32LE(Math.round(z*100),4);
  p.writeInt32LE(length?Math.round(dx/length*10000):0,8);p.writeInt32LE(length?Math.round(dz/length*10000):0,12);
  return W.frame(1136,id,p);
}
function cast(event,hero,skill) {
  const requested=event.aim;
  // Original Black Rock E/R main replies carry the caster position, while
  // 11033 supplies the chosen direction. The hit child separately carries
  // its collision point. Preserve other skills' verified target coordinates.
  const position=nativeFor(hero)?.castPosition?.(event,hero,skill)??requested;
  const aim=position&&[position.x,position.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35)?position:hero;
  const fields=[val(1,skill.id),val(2,skill.level||1),val(4,Math.round(aim.x*1000)),val(5,Math.round(aim.z*1000)),val(13,hero.mp)];
  const ended=event.type==='cast-cancel'||event.type==='cast-complete';
  if(ended)fields.push(val(8,3));
  else {
    const action=nativeFor(hero)?.castAction?.(event,hero,skill);
    if(action!==undefined)fields.push(val(8,action));
    else if(![2848,2849,8026,8035].includes(skill.id))fields.push(val(8,2));
  }
  const blinkSelf=skill.summoner&&[8035,8064].includes(skill.id);
  const ids=blinkSelf?[hero.id]:event.targetIds?.length?event.targetIds:['buff','guard','summoner'].includes(skill.type)?[hero.id]:[];
  const targets=ids.map(id=>({fields:blinkSelf?[val(1,id)]:[val(1,id),val(2,0)]}));
  for(const target of targets)fields.push({number:11,wire:2,bytes:P.encode(target.fields)});
  const reply=B.writeSkill({tag:11005,actor:hero.id,fields,targets});
  if(ended)return [reply];
  const cd=cooldown(event,hero,skill);
  // Captures 001/002/003 send the primary BRS cooldown before its cast
  // reply. The 2940 child has the opposite order; do not generalize it.
  return nativeFor(hero)?.cooldownFirst?.(event,hero,skill)?[cd,reply]:[reply,cd];
}
function cooldown(event,hero,skill){
  const seconds=event.readyAt===undefined?skill.cooldown:Math.max(0,event.readyAt-event.time);
  const p=Buffer.alloc(7);p.writeUInt16LE(skill.id);p[2]=skill.level||1;p.writeUInt32LE(Math.round(seconds*1000),3);
  return W.frame(11031,hero.id,p);
}
function death(id){return W.frame(1155,id,Buffer.from([1]));}
function showDamage(event){
  const p=Buffer.alloc(20);p.writeUInt32LE(event.attacker);p.writeUInt32LE(event.target,4);
  p[8]=event.damageType==='magic'?1:event.damageType==='true'?2:0;
  // Native text uses a signed 32-bit field. Extreme debug damage must not
  // throw and prevent match settlement; authoritative HP loss stays separate.
  p.writeInt32LE(Math.min(0x7fffffff,Math.max(0,Math.floor(event.displayAmount??event.amount))),9);
  // Native bf7ef0 skips ALL damage text when skill level is zero. A proc uses
  // its source skill; unbound/deferred numbers use the known basic-skill row
  // only for text lookup, without casting or applying that skill's damage.
  const sourceSkill=Number.isFinite(event.skillId)&&event.skillId>0?Math.min(0xffff,Math.max(0,Math.floor(event.skillId))):2841;
  p.writeUInt16LE(sourceSkill,13);p[15]=event.skillLevel||1;
  // Native bf7f51: basic skill + final u32=1 selects critical text flag 0x10.
  p.writeUInt32LE(event.critical?1:0,16);
  return W.frame(11044,0,p);
}
function stop(id){return W.frame(27112,id);}
function respawnTimer(id,seconds){const p=Buffer.alloc(4);p.writeUInt32LE(Math.max(0,Math.round(seconds*1000)));return W.frame(23459,id,p);}
function respawn(hero){
  const id=Buffer.alloc(4);id.writeUInt32LE(hero.id);
  const pos=Buffer.alloc(9);pos.writeUInt32LE(Math.round(hero.x*100));pos.writeUInt32LE(Math.round(hero.z*100),4);
  const status=hero.reviveStatus?Buffer.from(hero.reviveStatus):null;
  if(status)status.writeUInt32LE(hero.id,4);
  if(status&&hero.testDummy){
    const body=P.encode([val(3,hero.heroId),val(10,1),val(11,0)]);
    return [W.frame(11007,hero.id,Buffer.concat([Buffer.from([body.length]),body])),W.frame(27114,hero.id,pos),heroVitals(hero.id,hero.hp,hero.mp,hero.clientState||2049,hero.reviveCount)];
  }
  return [W.frame(18606,0,id),...(status?[status]:[]),W.frame(27114,hero.id,pos),heroVitals(hero.id,hero.hp,hero.mp,hero.clientState||2049,hero.reviveCount)];
}
function prefire(attacker,target,skillId){
  const dx=target.x-attacker.x,dz=target.z-attacker.z,len=Math.hypot(dx,dz)||1;
  if(attacker.kind!=='hero'){
    const p=Buffer.alloc(10);p.writeInt8(Math.round(dx/len*100),0);p.writeInt8(Math.round(dz/len*100),1);p.writeUInt16LE(skillId,2);
    return W.frame(11041,attacker.id,p);
  }
  const body=P.encode([val(1,skillId),val(4,Math.round(dx/len*100)),val(5,Math.round(dz/len*100)),val(6,target.id),val(7,1)]);
  return W.frame(11033,attacker.id,Buffer.concat([Buffer.from([body.length]),body]));
}
function skillPrefire(event,hero,skill){
  const direction=event.direction||{x:event.aim?.dirX,z:event.aim?.dirZ};
  const dx=direction.x,dz=direction.z,length=Math.hypot(dx,dz);
  if(!Number.isFinite(length)||length<=0)return null;
  // Original E/R prefire explicitly turns the character before preparation.
  // SSkillReply field 3 is an error code, not an orientation field.
  const body=P.encode([val(1,skill.id),val(2,skill.level||1),
    val(4,Math.round(dx/length*100)),val(5,Math.round(dz/length*100)),val(6,0),val(7,1)]);
  return W.frame(11033,hero.id,Buffer.concat([Buffer.from([body.length]),body]));
}
function attackLaunch(attacker,target,skillId,replayId,aim=target){
  const targets=[{fields:[val(1,target.id)]}];
  const fields=[val(2,1),val(7,replayId),val(8,0),{number:11,wire:2,bytes:P.encode(targets[0].fields)}];
  if(attacker.kind==='hero')fields.unshift(val(1,skillId),val(4,Math.round(aim.x*1000)),val(5,Math.round(aim.z*1000)));
  return B.writeSkill({tag:attacker.kind==='hero'?11005:11042,actor:attacker.id,fields,targets});
}
function syncSideScore(score1=0,score2=0){
  if(![score1,score2].every(n=>Number.isInteger(n)&&n>=0&&n<=3000))throw new Error('Invalid side score');
  // Original map-252 frames carry fixed 3000 caps, two u32 scores and a
  // two-byte zero tail.  The event-to-score mapping remains unresolved, so
  // callers must inject authoritative scores rather than deriving them here.
  const p=Buffer.alloc(18);p.writeUInt32LE(3000,0);p.writeUInt32LE(3000,4);p.writeUInt32LE(score1,8);p.writeUInt32LE(score2,12);
  return W.frame(23495,0,p);
}
function baseDestroyed(entity){const p=Buffer.alloc(12);p.writeUInt32LE(entity.team);p.writeUInt32LE(entity.id,4);p.writeUInt32LE(entity.monsterId,8);return W.frame(23478,0,p);}
// MSG_G2C_BATTLEEVENT is the native hero-kill/kill-feed event.  The captured
// map-252 structure is a fixed 43-byte payload: event kind, up to eight actor
// references, and a small event code/tail.  Keep unused references zeroed so
// the client can safely ignore assists that the server has not resolved yet.
function battleEvent({kind=2,killer=0,victim=0,assistIds=[],eventCode=3}={}){
  const p=Buffer.alloc(43);p.writeUInt16LE(kind>>>0,0);
  const ids=[killer,victim,...assistIds].filter(Number.isInteger).slice(0,8);
  ids.forEach((id,index)=>p.writeUInt32LE(id>>>0,2+index*4));
  p.writeUInt32LE(eventCode>>>0,34);
  return W.frame(23490,0,p);
}
module.exports={spawn,damage,showDamage,remove,path,heroHP,heroVitals,position,cast,cooldown,death,stop,respawnTimer,respawn,prefire,skillPrefire,attackLaunch,syncSideScore,baseDestroyed,battleEvent};
