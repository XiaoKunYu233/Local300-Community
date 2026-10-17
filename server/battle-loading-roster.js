'use strict';
// Native loading uses four parallel 40 x 30 actor tables. 23435 initializes
// every cache slot (65cf40); 23444 updates records by actor and appends unknown
// actors. Reserve the same planned actors in each table before that update.
const ROWS=40*30;
const schemas=new Map([
  [23435,{bytes:67222,start:20,stride:56,name:8}],
  [23505,{bytes:9616,start:16,stride:8}],
  [23560,{bytes:31212,start:12,stride:26,hero:4,skin:6,level:8}],
]);
function layout(sim){
  const counts={1:0,2:0},seen=new Set();
  return require('./battle-roster-live').registrations(sim).map(actor=>{
    if(!Number.isInteger(actor.id)||actor.id<=0||actor.id>0xffffffff||seen.has(actor.id))throw Error('Invalid loading roster actor');
    seen.add(actor.id);return {actor,index:(actor.team-1)*30+counts[actor.team]++};
  });
}
function frame(template,sim){
  if(!Buffer.isBuffer(template)||template.length<12)throw Error('Invalid loading roster template');
  const schema=schemas.get(template.readUInt16LE(8));if(!schema)return template;
  if(template.length!==schema.bytes||template.readUInt32LE()!==template.length)throw Error('Unsupported loading roster layout');
  const out=Buffer.alloc(template.length),end=schema.start+ROWS*schema.stride;
  // Map/width prefix and fixed trailer stay opaque and retain native bytes.
  template.copy(out,0,0,schema.start);template.copy(out,end,end);
  const originals=new Map();
  for(let index=0;index<ROWS;index++){
    const at=schema.start+index*schema.stride,id=template.readUInt32LE(at);
    if(id){if(originals.has(id))throw Error('Duplicate captured loading actor');originals.set(id,at);}
  }
  for(const {actor,index}of layout(sim)){
    const at=schema.start+index*schema.stride,source=originals.get(actor.id);
    // Preserve only this actor's own unknown metadata. New synthetic actors
    // never inherit another captured player's fields or account identifiers.
    if(source!==undefined)template.copy(out,at,source,source+schema.stride);
    out.writeUInt32LE(actor.id,at);
    if(schema.name!==undefined){
      out.fill(0,at+schema.name,at+schema.name+15);
      (actor.nameBytes||require('./gbk').encode(actor.name||'玩家')).subarray(0,14).copy(out,at+schema.name);
    }
    if(schema.hero!==undefined){
      const entered=require('./battle-roster-live').entered(actor);
      out.writeUInt16LE(entered?(actor.heroId||0):0,at+schema.hero);
      out.writeUInt16LE(entered?(actor.skinId||0):0,at+schema.skin);
      out.writeUInt16LE(entered?(actor.level||1):1,at+schema.level);
    }
  }
  return out;
}
module.exports={schemas,layout,frame,ROWS};
