'use strict';
// 17015 captured payload: u8 operation, u8 entryCount,
// entryCount * {u16 itemId, u8 quantity, u8 flag}.
// The historical u16 "kind" combines operation with entryCount=1.
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length<14||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==17015)throw Error('Invalid item change frame');
  const count=frame[13];
  if(!count||count>100||frame.length!==14+count*4)throw Error('Invalid item change entry count');
  const items=[];
  for(let i=0;i<count;i++){
    const at=14+i*4;
    items.push({itemId:frame.readUInt16LE(at),count:frame[at+2],flag:frame[at+3]});
  }
  return {operation:frame[12],items};
}
// Native 46c5d0 guards index <100; 46c912/46cb14 read each u8
// quantity independently. Repeated IDs are not deduplicated in this loop.
function encode(operation,items,options={}){
  if(!Number.isInteger(operation)||operation<1||operation>255||!Array.isArray(items)||!items.length||items.length>100)throw Error('Invalid item change entries');
  const p=Buffer.alloc(2+items.length*4);p[0]=operation;p[1]=items.length;
  items.forEach((item,i)=>{
    if(!Number.isInteger(item.itemId)||item.itemId<1||item.itemId>=65535||!Number.isInteger(item.count)||item.count<1||item.count>255||![0,1].includes(item.flag))throw Error('Invalid item change entry');
    const at=2+i*4;p.writeUInt16LE(item.itemId,at);p[at+2]=item.count;p[at+3]=item.flag;
  });
  return require('./bag').mkFrame(17015,p,options);
}
function quantityFrames(operation,itemId,count,flag,options={}){
  // Bound to the role bag's per-stack u16 quantity. Larger business grants
  // must be partitioned by the inventory planner before calling this helper.
  if(!Number.isInteger(count)||count<1||count>65535)throw Error('Invalid item change quantity');
  const frames=[];let items=[];
  while(count){const part=Math.min(count,255);items.push({itemId,count:part,flag});count-=part;
    if(items.length===100||!count){frames.push(encode(operation,items,options));items=[];}
  }
  return frames;
}
module.exports={decode,encode,quantityFrames};
