'use strict';
// 1040 payload: actor +0, endpoint +4, port immediately before ticket;
// its four-byte ticket (wss-4) is echoed as the complete 1041 payload.
// Verified against the separate 001/002 native lobby and match captures.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function ticketOffset(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==310||frame.readUInt32LE()!==310||frame.readUInt16LE(8)!==1040)throw Error('Unsupported battle handoff');
  const wss=frame.indexOf(Buffer.from('wss://'),16);
  if(wss!==54)throw Error('Unverified battle endpoint layout');return wss-4;
}
class BattleTickets{
  constructor(file){if(!path.isAbsolute(file))throw Error('Absolute battle ticket path required');this.file=file;}
  update(fn){
    fs.mkdirSync(path.dirname(this.file),{recursive:true});let fd;
    const lock=this.file+'.lock',tmp=this.file+'.'+process.pid+'.tmp';
    try{
      fd=fs.openSync(lock,'wx');let value=null;
      try{value=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      const next=fn(value);if(!next)return false;
      fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,this.file);return next;
    }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  }
  issue(frame,{uid,playerId,mapId},now=Date.now()){
    const offset=ticketOffset(frame);
    if(![uid,playerId,mapId].every(n=>Number.isInteger(n)&&n>0&&n<=0xffffffff))throw Error('Invalid battle ticket identity');
    const token=crypto.randomInt(1,0x100000000);
    this.update(()=>({version:1,uid,playerId,mapId,token,issuedAt:now,expiresAt:now+120000,usedAt:null}));
    const out=Buffer.from(frame);out.writeUInt32LE(playerId,12);out.writeUInt32LE(token,offset);return out;
  }
  consume(token,{uid,playerId,mapId},now=Date.now()){
    if(!Number.isInteger(token)||token<1)return false;
    return !!this.update(value=>{
      if(!value||value.version!==1||value.token!==token||value.uid!==uid||value.playerId!==playerId||value.mapId!==mapId||
        value.usedAt!==null||!Number.isFinite(value.issuedAt)||!Number.isFinite(value.expiresAt)||now<value.issuedAt||now>=value.expiresAt)return null;
      return {...value,usedAt:now};
    });
  }
}
module.exports={BattleTickets,ticketOffset};
