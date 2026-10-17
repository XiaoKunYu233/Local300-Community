'use strict';
const B=require('./battle-protocol'),W=require('./battle-wire');
const visible=id=>id>=25231&&id<=25256||id===25259||id===25260;
const point=(x,z)=>[x,z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35);
function read(frame){
 if(!Buffer.isBuffer(frame)||frame.length<13||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==23450||frame.readUInt32LE(4)!==0||frame.readUInt16LE(10)!==0)throw Error('Invalid native building map registration');
 const count=frame[12];if(frame.length!==13+count*26)throw Error('Invalid native building registration size');
 const rows=[],actors=new Set();
 for(let i=0;i<count;i++){
  const at=13+i*26,row={actor:frame.readUInt32LE(at),x:frame.readFloatLE(at+4),z:frame.readFloatLE(at+8),state:frame[at+12],
   monsterId:frame.readUInt32LE(at+13),team:frame[at+17],directionX:frame.readFloatLE(at+18),directionZ:frame.readFloatLE(at+22),record:Buffer.from(frame.subarray(at,at+26))};
  if(!row.actor||actors.has(row.actor)||!visible(row.monsterId)||![1,2].includes(row.team)||!point(row.x,row.z)||![row.directionX,row.directionZ].every(Number.isFinite))throw Error('Invalid native building record');
  actors.add(row.actor);rows.push(row);
 }
 return rows;
}
function category(id){return require('./battle-map-layout').category(id);}
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
function templateFor(rows,entity){
 const exact=rows.filter(r=>r.monsterId===entity.monsterId&&r.team===entity.team).sort((a,b)=>distance(a,entity)-distance(b,entity));
 if(exact.length)return exact[0];
 const family=category(entity.monsterId),same=rows.find(r=>r.team===entity.team&&category(r.monsterId)===family);
 if(same)return same;
 throw Error(`Missing native map registration template ${entity.monsterId}/${entity.team}`);
}
function packet(template,entities){
 const rows=read(template);if(!Array.isArray(entities))throw Error('Current native building entities required');
 const current=entities.filter(e=>visible(e.monsterId)&&e.alive!==false&&e.hp>0);
 if(current.length>255)throw Error('Native building map registration limit');
 const actors=new Set(),body=Buffer.alloc(1+current.length*26);body[0]=current.length;
 current.forEach((e,i)=>{
  if(!Number.isInteger(e.id)||e.id<=0||e.id>0xffffffff||actors.has(e.id)||![1,2].includes(e.team)||!point(e.x,e.z)||!['tower','base','barracks'].includes(e.kind))throw Error('Invalid current native building entity');
  actors.add(e.id);const source=templateFor(rows,e),at=1+i*26;source.record.copy(body,at);
  body.writeUInt32LE(e.id,at);body.writeFloatLE(e.x,at+4);body.writeFloatLE(e.z,at+8);body[at+12]=0;
  body.writeUInt32LE(e.monsterId,at+13);body[at+17]=e.team;
 });
 return W.frame(23450,0,body);
}
function legacyActors(frames){
 if(!Array.isArray(frames))throw Error('Native bootstrap frames required');const out=new Set();
 for(const frame of frames){
  if(frame.readUInt16LE(8)===23450)for(const r of read(frame))out.add(r.actor);
  const spawn=B.readSpawn(frame);if(spawn?.kind==='monster'&&category(spawn.monsterId))out.add(spawn.id);
 }
 return out;
}
function filterBootstrap(frames){
 const ids=legacyActors(frames);
 return frames.filter(frame=>![23450,23451].includes(frame.readUInt16LE(8))&&!ids.has(frame.readUInt32LE(4)));
}
function readUpdate(frame){
 if(!Buffer.isBuffer(frame)||frame.length!==30||frame.readUInt32LE(0)!==30||frame.readUInt16LE(8)!==23451||frame.readUInt32LE(4)!==0||frame.readUInt16LE(10)!==0)throw Error('Invalid native building map update');
 const row={operation:frame[12],actor:frame.readUInt32LE(13),monsterId:frame.readUInt32LE(17),x:frame.readFloatLE(21),z:frame.readFloatLE(25),team:frame[29]};
 if(![0,1].includes(row.operation)||!row.actor||!visible(row.monsterId)||![1,2].includes(row.team)||!point(row.x,row.z))throw Error('Invalid native building update record');
 return row;
}
function death(entity){
 if(!entity||!Number.isInteger(entity.id)||entity.id<=0||entity.id>0xffffffff||!visible(entity.monsterId)||!['tower','base','barracks'].includes(entity.kind)||!point(entity.x,entity.z)||![1,2].includes(entity.team)||entity.alive!==false||entity.hp!==0)throw Error('Dead native building required');
 const body=Buffer.alloc(18);body[0]=1;body.writeUInt32LE(entity.id,1);body.writeUInt32LE(entity.monsterId,5);body.writeFloatLE(entity.x,9);body.writeFloatLE(entity.z,13);body[17]=entity.team;
 return W.frame(23451,0,body);
}
module.exports={read,packet,templateFor,legacyActors,filterBootstrap,visible,readUpdate,death};
