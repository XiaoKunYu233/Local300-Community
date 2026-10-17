'use strict';

// A native handoff is private routing authority, not a replayable capture.
// Only this gate's own issue() result is eligible for its outbound() check.
// The ticket is checked without consuming it; 1041 remains the consumer.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {BattleTickets,ticketOffset}=require('./player-battle-ticket');
const unsigned=value=>Number.isInteger(value)&&value>0&&value<=0xffffffff;
const clock=value=>Number.isSafeInteger(value)&&value>=0;
const sha=frame=>crypto.createHash('sha256').update(frame).digest('hex');
const ticketKeys=['expiresAt','issuedAt','mapId','playerId','token','uid','usedAt','version'];

function createGate({ticketFile,uid,playerId,mapId=252,host='127.0.0.1',port}={}){
  if(typeof ticketFile!=='string'||!path.isAbsolute(ticketFile)||!unsigned(uid)||!unsigned(playerId)||mapId!==252||
    host!=='127.0.0.1'||!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid battle handoff gate configuration');
  const tickets=new BattleTickets(ticketFile),issued=new WeakMap();
  function authorized(auth){return auth?.authenticated===true&&auth.frozen===false&&auth.uid===uid&&auth.playerId===playerId&&auth.mapId===mapId;}
  function native(frame,{ownRole=true}={}){
    ticketOffset(frame);
    const end=frame.indexOf(0,16);
    if(end<16||end>=48||frame.subarray(16,end).toString('ascii')!==host||
      !frame.subarray(16,end).equals(Buffer.from(host,'ascii'))||frame.readUInt16LE(48)!==port||
      (ownRole&&frame.readUInt32LE(12)!==playerId))throw Error('Invalid current battle handoff endpoint or role');
  }
  function current(expected,now){
    if(!clock(now)||now<expected.issuedAt||now>=expected.expiresAt)return false;
    // Generated credentials are tiny. Refuse redirects and unexpected shapes.
    const stat=fs.lstatSync(ticketFile);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096)return false;
    const value=JSON.parse(fs.readFileSync(ticketFile,'utf8'));
    return !!value&&typeof value==='object'&&!Array.isArray(value)&&
      Object.keys(value).sort().join(',')===ticketKeys.join(',')&&value.version===1&&
      value.uid===uid&&value.playerId===playerId&&value.mapId===mapId&&unsigned(value.token)&&
      value.token===expected.token&&value.issuedAt===expected.issuedAt&&value.expiresAt===expected.expiresAt&&
      clock(value.issuedAt)&&clock(value.expiresAt)&&value.expiresAt-value.issuedAt===120000&&value.usedAt===null;
  }
  function issue(frame,auth,now=Date.now()){
    if(!authorized(auth)||!clock(now)||!clock(now+120000))throw Error('Battle handoff authorization required');
    // The recorded role may belong to the template account. Existing issue()
    // replaces it with this authenticated role; the endpoint must already be
    // fixed to the owned worker before any credential is written.
    native(frame,{ownRole:false});
    const out=tickets.issue(frame,{uid,playerId,mapId},now);
    native(out);
    const expected={token:out.readUInt32LE(50),issuedAt:now,expiresAt:now+120000};
    if(!current(expected,now))throw Error('Current battle handoff credential unavailable');
    issued.set(out,{...expected,sha256:sha(out)});
    return out;
  }
  function outbound(frame,auth,now=Date.now()){
    if(!authorized(auth)||!Buffer.isBuffer(frame))return null;
    const expected=issued.get(frame);if(!expected)return null;
    try{
      native(frame);
      if(expected.sha256!==sha(frame)||!current(expected,now))return null;
      return frame;
    }catch{return null;}
  }
  return Object.freeze({issue,outbound});
}
module.exports={createGate};
