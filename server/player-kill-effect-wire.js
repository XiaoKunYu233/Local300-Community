'use strict';
// Current normal client: XSendKillEffect -> 14d68d0. Special-item category 6
// has no account/object key. This codec never grants ownership or expiry.
const CATEGORY=6,CAPACITY=200,LIST_BYTES=2420;
const u32=n=>Number.isSafeInteger(n)&&n>=0&&n<=0xffffffff;
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length<12||frame.readUInt32LE(0)!==frame.length)throw Error('Invalid kill effect frame');
  const tag=frame.readUInt16LE(8),header=Buffer.from(frame.subarray(0,12));
  if(tag===9018||tag===9019){
    if(frame.length!==20||frame.readUInt32LE(16)!==CATEGORY)throw Error('Invalid kill effect selector');
    const itemId=frame.readUInt32LE(12);return {tag,header,category:CATEGORY,itemId,removed:itemId===0};
  }
  if(tag!==9020||frame.length!==LIST_BYTES||frame.readUInt32LE(12)!==CATEGORY)throw Error('Invalid kill effect ownership frame');
  const count=frame.readUInt32LE(16);if(count>CAPACITY)throw Error('Invalid kill effect ownership count');
  const records=[];for(let at=20;at<LIST_BYTES;at+=12)records.push({id:frame.readUInt32LE(at),word1:frame.readUInt32LE(at+4),word2:frame.readUInt32LE(at+8)});
  return {tag,header,category:CATEGORY,count,records};
}
function encode(model){
  if(!Buffer.isBuffer(model?.header)||model.header.length!==12||model.category!==CATEGORY)throw Error('Invalid kill effect model');
  const tag=model.header.readUInt16LE(8);if(tag!==model.tag||![9018,9019,9020].includes(tag))throw Error('Invalid kill effect model tag');
  const out=Buffer.alloc(tag===9020?LIST_BYTES:20);model.header.copy(out);out.writeUInt32LE(out.length);
  if(tag===9020){
    if(!u32(model.count)||model.count>CAPACITY||!Array.isArray(model.records)||model.records.length!==CAPACITY)throw Error('Invalid kill effect ownership model');
    out.writeUInt32LE(CATEGORY,12);out.writeUInt32LE(model.count,16);
    model.records.forEach((r,i)=>{if(!r||![r.id,r.word1,r.word2].every(u32))throw Error('Invalid kill effect record');const at=20+i*12;out.writeUInt32LE(r.id,at);out.writeUInt32LE(r.word1,at+4);out.writeUInt32LE(r.word2,at+8);});
  }else{
    if(!u32(model.itemId))throw Error('Invalid kill effect item ID');out.writeUInt32LE(model.itemId,12);out.writeUInt32LE(CATEGORY,16);
  }
  decode(out);return out;
}
function request(frame){const model=decode(frame);if(model.tag!==9018)throw Error('Not a kill effect request');return {itemId:model.itemId,removed:model.removed};}
module.exports={decode,encode,request,CATEGORY,CAPACITY,LIST_BYTES};
