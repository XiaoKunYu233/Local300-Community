'use strict';
// Exact current equip-pet observations; no grants or growth/expiry inference.
const STONE_CAPACITY=50,STONE_BYTES=314;
const u16=n=>Number.isSafeInteger(n)&&n>=0&&n<=0xffff;
const u32=n=>Number.isSafeInteger(n)&&n>=0&&n<=0xffffffff;
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length<12||frame.readUInt32LE(0)!==frame.length)throw Error('Invalid pet observation frame');
  const tag=frame.readUInt16LE(8),header=Buffer.from(frame.subarray(0,12));
  if(tag===9035){
    if(frame.length<16)throw Error('Invalid pet list frame');
    const selectedItemId=frame.readUInt16LE(12),count=frame.readUInt16LE(14);
    if(frame.length!==16+count*10)throw Error('Invalid pet list length');
    const records=[];for(let at=16;at<frame.length;at+=10)records.push({itemId:frame.readUInt16LE(at),word1:frame.readUInt32LE(at+2),word2:frame.readUInt32LE(at+6)});
    return {tag,header,selectedItemId,count,records};
  }
  if(tag!==9151||frame.length!==STONE_BYTES)throw Error('Invalid pet stone frame');
  const records=[];for(let at=12;at<312;at+=6)records.push({word1:frame.readUInt32LE(at),word2:frame.readUInt16LE(at+4)});
  return {tag,header,records,selectedWord:frame.readUInt16LE(312)};
}
function encode(model){
  if(!model||!Buffer.isBuffer(model.header)||model.header.length!==12||model.header.readUInt16LE(8)!==model.tag||![9035,9151].includes(model.tag))throw Error('Invalid pet observation model');
  let out;
  if(model.tag===9035){
    if(!u16(model.selectedItemId)||!u16(model.count)||!Array.isArray(model.records)||model.records.length!==model.count)throw Error('Invalid pet list model');
    out=Buffer.alloc(16+model.count*10);out.writeUInt16LE(model.selectedItemId,12);out.writeUInt16LE(model.count,14);
    model.records.forEach((r,i)=>{if(!r||!u16(r.itemId)||!u32(r.word1)||!u32(r.word2))throw Error('Invalid pet list record');const at=16+i*10;out.writeUInt16LE(r.itemId,at);out.writeUInt32LE(r.word1,at+2);out.writeUInt32LE(r.word2,at+6);});
  }else{
    if(!u16(model.selectedWord)||!Array.isArray(model.records)||model.records.length!==STONE_CAPACITY)throw Error('Invalid pet stone model');
    out=Buffer.alloc(STONE_BYTES);model.records.forEach((r,i)=>{if(!r||!u32(r.word1)||!u16(r.word2))throw Error('Invalid pet stone record');out.writeUInt32LE(r.word1,12+i*6);out.writeUInt16LE(r.word2,16+i*6);});out.writeUInt16LE(model.selectedWord,312);
  }
  model.header.copy(out);out.writeUInt32LE(out.length);decode(out);return out;
}
module.exports={decode,encode,STONE_CAPACITY,STONE_BYTES};
