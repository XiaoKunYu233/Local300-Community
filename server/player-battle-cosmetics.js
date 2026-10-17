'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),W=require('./battle-wire'),A=require('./player-account-state');
const kinds={2:'wards',5:'bloodSkins'},slots={2:'ward',5:'bloodSkin'},types={2:'eye',5:'bloodskin'};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function validItem(category,id){return id===0||require('./current-item-catalog').load().byId[id]?.type===types[category];}
function request(f){
 if(!Buffer.isBuffer(f)||f.length!==20||f.readUInt32LE(0)!==20||f.readUInt16LE(8)!==9018||f.readUInt32LE(4)!==0||f.readUInt16LE(10)!==0)throw Error('invalid-cosmetic-selection');
 const category=f.readUInt32LE(16),id=f.readUInt32LE(12);if(!kinds[category]||!validItem(category,id))throw Error('invalid-cosmetic-item');return {category,id};
}
function selected(a,category,now=Date.now()){const r=a.selected[slots[category]];return r?.kind===kinds[category]&&A.owns(a,r.kind,r.id,now)&&validItem(category,r.id)?r.id:0;}
function apply(a,r,now=Date.now()){if(!kinds[r.category]||!validItem(r.category,r.id))throw Error('invalid-cosmetic-item');A.select(a,slots[r.category],kinds[r.category],r.id||null,now);}
function reply(a,category){const p=Buffer.alloc(8);p.writeUInt32LE(selected(a,category));p.writeUInt32LE(category,4);return W.frame(9019,0,p);}
function owned(a,category){
 const ids=Object.keys(a.owned[kinds[category]]).map(Number).filter(id=>A.owns(a,kinds[category],id)&&validItem(category,id)).sort((a,b)=>a-b);
 if(ids.length>200)throw Error('cosmetic-list-capacity');const p=Buffer.alloc(2408);p.writeUInt32LE(category);p.writeUInt32LE(ids.length,4);
 ids.forEach((id,i)=>{const expiry=a.owned[kinds[category]][id].expiresAt;p.writeUInt32LE(id,8+i*12);p.writeUInt32LE(category,12+i*12);p.writeUInt32LE(expiry===null?0:Math.floor(expiry/1000),16+i*12);});return W.frame(9020,0,p);
}
function initial(a){return [2,5].flatMap(c=>[owned(a,c),reply(a,c)]);}
function scene(a){const p=Buffer.alloc(12);p.writeUInt32LE(a.playerId);p.writeUInt32LE(selected(a,5),4);p.writeUInt32LE(5,8);return W.frame(9101,0,p);}
function isFrame(f){if(!Buffer.isBuffer(f)||f.length<20)return false;const tag=f.readUInt16LE(8);return [9019,9020,9101].includes(tag)&&(tag!==9101||f.length>=24)&&!!kinds[f.readUInt32LE(tag===9019?16:tag===9020?12:20)];}
// Explicit migration of this account's original full owned-list, never the
// selected-item notice. The ward consumer copies word2 into the standard item
// expiry field (a3bb15..a3bb18); zero is the native no-expiry representation.
function importPlan(a){
 if(a.cosmeticsImport?.version===1)return null;
 const m=a.migration;if(!m?.s2c||!m.s2cSha256)return {version:1,source:null,records:[],selections:[]};
 const bytes=fs.readFileSync(m.s2c);if(hash(bytes)!==m.s2cSha256)throw Error('cosmetic-source-integrity');
 const R=require('./roledata'),frames=R.split(bytes),records=[],selections=[];let bound=false;
 if(frames.reduce((n,f)=>n+f.length,0)!==bytes.length)throw Error('cosmetic-source-truncated');
 for(const f of frames){const tag=f.readUInt16LE(8);
  if(tag===1166){const role=R.inflate(f.subarray(12));bound=!!role&&role.readUInt32LE(R.UID_OFF)===a.uid&&role.readUInt32LE(R.PLAYERID_OFF)===a.playerId;}
  if(![9019,9020].includes(tag)||f.length<20)continue;const category=f.readUInt32LE(tag===9019?16:12);if(!kinds[category])continue;if(!bound)throw Error('cosmetic-source-identity');
  if(tag===9019){if(f.length!==20)throw Error('cosmetic-selector-size');selections.push({category,id:f.readUInt32LE(12)});continue;}
  if(f.length!==2420||f.readUInt32LE(16)>200)throw Error('cosmetic-source-size');
  // The last authoritative full list supersedes any earlier list in this stream.
  for(let i=records.length-1;i>=0;i--)if(records[i].category===category)records.splice(i,1);
  for(let i=0;i<f.readUInt32LE(16);i++){const at=20+i*12,id=f.readUInt32LE(at),kind=f.readUInt32LE(at+4),expires=f.readUInt32LE(at+8);
   if(kind!==category||!validItem(category,id)||!id)throw Error('cosmetic-source-item');records.push({category,id,expiresAt:expires?expires*1000:null});
  }
 }
 return {version:1,source:m.s2cSha256,records,selections};
}
function importApply(a,plan){
 if(a.cosmeticsImport?.version===1)return;
 for(const r of plan.records)if(r.expiresAt===null||r.expiresAt>Date.now())A.grant(a,{kind:kinds[r.category],itemId:r.id,expiresAt:r.expiresAt,source:'capture-cosmetic:'+plan.source});
 for(const r of plan.selections)if(!a.selected[slots[r.category]]&&r.id&&A.owns(a,kinds[r.category],r.id))apply(a,r);
 a.cosmeticsImport={version:1,source:plan.source,at:new Date().toISOString()};
}
module.exports={kinds,request,selected,apply,reply,owned,initial,scene,isFrame,importPlan,importApply};
