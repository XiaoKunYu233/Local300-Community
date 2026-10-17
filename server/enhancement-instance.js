'use strict';
const fs=require('fs');
const path=require('path');
const {BAG_BASE,BAG_STRIDE}=require('./roledata');
const rules=require('./enhancement-rules');
const {normalizeGuid}=require('./enhancement-state');

// Exact GUID lookup in the captured 493-byte instance records. Never use an
// item-ID template for a legacy item's level or blessing attributes.
function findRecord(blob,guid,itemId){
  const key=normalizeGuid(guid);
  if(!Buffer.isBuffer(blob)||!Number.isInteger(itemId))return null;
  let found=null;
  const slots=Math.floor((blob.length-BAG_BASE)/BAG_STRIDE);
  for(let slot=0;slot<slots;slot++){
    const start=BAG_BASE+slot*BAG_STRIDE;
    if(blob.subarray(start+8,start+16).toString('hex')!==key)continue;
    if(blob.readUInt16LE(start)!==itemId||found)return null;
    found={slot,record:Buffer.from(blob.subarray(start,start+BAG_STRIDE))};
  }
  return found;
}

function readLegacyLevel(record){
  if(!Buffer.isBuffer(record)||record.length!==BAG_STRIDE)return null;
  // In the two account login records, both bytes agree with the independent
  // +4/+10/+14/+15 panel quotes. A disagreement is an unknown record variant.
  const a=record[73],b=record[74];
  return a===b&&a<=17?a:null;
}

function initialCapturedCounts(captureDir){
  const counts=new Map(),file=path.join(captureDir,'events.jsonl');
  if(!fs.existsSync(file))return counts;
  const queued=new Map(),executed=new Set();
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line)continue;
    let event;try{event=JSON.parse(line);}catch{continue;}
    if(![13510,13511,13512].includes(event.msgid)||!event.hex)continue;
    const payload=Buffer.from(event.hex,'hex').subarray(12),conn=event.c||'single';
    if(event.msgid===13512){executed.add(payload.subarray(0,8).toString('hex'));continue;}
    if(event.msgid===13510){
      if(payload.length!==9)continue;
      if(!queued.has(conn))queued.set(conn,[]);
      queued.get(conn).push({guid:payload.subarray(0,8).toString('hex'),type:payload[8]});
      continue;
    }
    const query=queued.get(conn)?.shift();
    if(!query||query.type!==2||payload.length!==1286||payload[0]!==2||
       executed.has(query.guid)||counts.has(query.guid))continue;
    counts.set(query.guid,{required:{40001:payload.readUInt32LE(1),
      40002:payload.readUInt32LE(5),40003:payload.readUInt32LE(9)},
      count:payload.readUInt16LE(1276)});
  }
  return counts;
}

class LegacyEnhancementInstances{
  constructor(blob,captureDirs=[]){
    this.blob=blob;this.counts=new Map();
    for(const dir of [captureDirs].flat())for(const [guid,quote] of initialCapturedCounts(dir)){
      const previous=this.counts.get(guid);
      if(previous && JSON.stringify(previous)!==JSON.stringify(quote))
        this.counts.set(guid,null); // Conflicting historical observations are not state.
      else if(!this.counts.has(guid))this.counts.set(guid,quote);
    }
  }
  get(guid,itemId){
    const found=findRecord(this.blob,guid,itemId);
    if(!found)return null;
    const level=readLegacyLevel(found.record);
    if(level===null)return {level:null,blessing:null,record:found.record};
    const quote=this.counts.get(normalizeGuid(guid));
    let blessing=null;
    if(quote){
      try{
        const required=level===17?{40001:0,40002:0,40003:0}
          : rules.materialsFor(itemId,level).resources;
        if(Object.keys(required).every(id=>required[id]===quote.required[id]))
          blessing=quote.count;
      }catch{}
    }
    return {level,blessing,record:found.record};
  }
}

module.exports={findRecord,readLegacyLevel,initialCapturedCounts,LegacyEnhancementInstances};
