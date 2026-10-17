'use strict';
// Primary captures: 1045 is u8 count + count*(u8 id,u32 absolute value),
// and 1394 is exactly 16 bytes with honour at +12. No other fields inferred.
const CURRENCY_IDS=Object.freeze([50,52,72,91,131,141,156,157,181]),currencies=new Set(CURRENCY_IDS);
const knownU32=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff;
function accountMode(value){if(typeof value!=='boolean')throw Error('Explicit wallet wire account mode must be boolean');return value;}
function shape(frame,tag,bytes){return Buffer.isBuffer(frame)&&frame.length>=12&&frame.readUInt32LE(0)===frame.length&&frame.readUInt16LE(8)===tag&&(bytes===undefined||frame.length===bytes);}
function attributes(frame,{accountMode:mode=false,authenticated=false,frozen=false,attrs}={}){
 if(!accountMode(mode))return frame;
 if(!shape(frame,1045)||frame.length<13||frame.length!==13+frame[12]*5)return null;
 const rows=[];let changed=false;
 for(let i=0;i<frame[12];i++){
  const source=frame.subarray(13+i*5,18+i*5),id=source[0];
  if(!currencies.has(id)){rows.push(source);continue;}
  const value=attrs?.[id];
  if(!authenticated||frozen||!knownU32(value)){changed=true;continue;}
  if(source.readUInt32LE(1)===value){rows.push(source);continue;}
  const row=Buffer.from(source);row.writeUInt32LE(value,1);rows.push(row);changed=true;
 }
 if(!rows.length)return null;
 if(!changed)return frame;
 const out=Buffer.concat([Buffer.from(frame.subarray(0,12)),Buffer.from([rows.length]),...rows]);out.writeUInt32LE(out.length,0);return out;
}
function honour(frame,{accountMode:mode=false,authenticated=false,frozen=false,value}={}){
 if(!accountMode(mode))return frame;
 if(!shape(frame,1394,16)||!authenticated||frozen||!knownU32(value))return null;
 const out=Buffer.from(frame);out.writeUInt32LE(value,12);return out;
}
function balance(frame,tag,bytes,{accountMode:mode=false,authenticated=false,frozen=false,value}={}){
 if(!accountMode(mode))return frame;
 if(!shape(frame,tag,bytes)||!authenticated||frozen||!knownU32(value))return null;
 const out=Buffer.from(frame);out.writeUInt32LE(value,12);return out;
}
// 1014's byte +16 is opaque status and always kept. Both primary headers use
// stream0; they are bound by the authenticated connection, never guessed role.
const diamond=(frame,options)=>balance(frame,1014,17,options);
const recharge=(frame,options)=>balance(frame,1439,16,options);
module.exports={CURRENCY_IDS,knownU32,attributes,honour,diamond,recharge};
