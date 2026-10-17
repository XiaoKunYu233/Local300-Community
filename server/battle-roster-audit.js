'use strict';
const crypto=require('node:crypto');
// Bounded diagnostics after view filtering. This records no login, name,
// inventory GUID, credentials or coordinates, and is not a client-render ACK.
function inspect(frames){
 const rows=[];
 for(const f of frames){
  const tag=f.readUInt16LE(8),players=[];
  if(tag===23444&&f.length===175292){
   for(let i=0;i<1200;i++){const at=12+i*146,id=f.readUInt32LE(at+15);if(id){players.push({id,heroId:f.readUInt16LE(at+27),group:Math.floor(i/30)});if(players.length===14)break;}}
  }else if(tag===23510&&f.length===12+2+60*0xe40+28){
   for(let i=0;i<60;i++){const at=14+i*0xe40,id=f.readUInt32LE(at);if(id){players.push({id,heroId:f.readUInt16LE(at+0x13),team:f.readUInt32LE(at+0xe2c)});if(players.length===14)break;}}
  }else if(tag===1104&&f.length===278&&f.subarray(22,30).equals(Buffer.from('bdf8c8ebd5bdb3a1','hex'))){
   players.push({id:f.readUInt32LE(12)});
  }else continue;
  rows.push({type:'battle-roster-send-queued',tag,bytes:f.length,players,sha256:crypto.createHash('sha256').update(f).digest('hex')});
 }
 return rows;
}
module.exports={inspect};
