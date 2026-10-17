'use strict';
// Lobby IPC client. Timeouts and disconnects never cancel a manager reservation:
// a lost reply cannot prove whether a name was reserved or a commit completed.
const crypto=require('node:crypto'),rename=require('./player-rename-card');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function create({uid,process:channel=process,timeoutMs=30000}={}){
  if(!Number.isInteger(uid)||uid<1||uid>0xffffffff||!channel||typeof channel.send!=='function'||typeof channel.on!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('Explicit lobby name IPC identity required');
  const pending=new Map(),owned=new Map();let closed=false,uncertain=false;
  const error=(reason,fields={})=>Object.assign(Error(reason),{reason,status:1002,...fields});
  function receive(message){
    if(!['player-name-reserved','player-name-released'].includes(message?.type)||message.version!==1||!uuid(message.requestId))return;
    const row=pending.get(message.requestId);if(!row)return;
    if(message.type!==row.replyType)return finish(row,error('name-broker-reply-type-mismatch',{uncertain:true}));
    if(message.ok!==true)return finish(row,error(message.reason||'name-broker-rejected',{status:message.status||1002,uncertain:!!message.uncertain,fatal:!!message.fatal}));
    try{
      if(message.uid!==uid||!uuid(message.token))throw Error('Name broker reply identity mismatch');
      if(row.kind==='reserve'){
        if(message.name!==row.name)throw Error('Name broker reply target mismatch');
        const registry=rename.createRegistry(message.registeredAccounts);
        if(JSON.stringify(registry.accounts)!==JSON.stringify(message.registry?.accounts)||!registry.accounts[uid])throw Error('Name broker registered snapshot mismatch');
        owned.set(message.token,{name:message.name,requestId:row.requestId});
      }else if(message.token!==row.token||message.released!==true||message.committed!==row.committed)throw Error('Name broker release mismatch');
      else owned.delete(row.token);
      finish(row,null,message);
    }catch(cause){finish(row,error(cause.message,{uncertain:true}));}
  }
  function finish(row,failure,value){
    if(!pending.has(row.requestId))return;clearTimeout(row.timer);pending.delete(row.requestId);
    if(failure?.uncertain)uncertain=true;failure?row.reject(failure):row.resolve(value);
  }
  function lost(){closed=true;uncertain=uncertain||owned.size>0||pending.size>0;for(const row of [...pending.values()])finish(row,error('name-broker-disconnected',{uncertain:true}));}
  channel.on('message',receive);channel.on('disconnect',lost);
  function send(kind,body){
    if(closed||channel.connected===false)return Promise.reject(error('name-broker-disconnected',{uncertain:true}));
    const requestId=crypto.randomUUID(),replyType=kind==='reserve'?'player-name-reserved':'player-name-released';
    return new Promise((resolve,reject)=>{
      const row={kind,requestId,replyType,...body,resolve,reject};
      row.timer=setTimeout(()=>finish(row,error('name-broker-timeout',{uncertain:true})),timeoutMs);pending.set(requestId,row);
      try{channel.send({type:kind==='reserve'?'player-name-reserve':'player-name-release',version:1,requestId,...body},failure=>{
        if(failure)finish(row,error('name-broker-send-failed',{uncertain:true}));
      });}catch(cause){finish(row,error('name-broker-send-failed',{uncertain:true}));}
    });
  }
  return {
    reserve(name){
      try{rename.nameBytes(name);}catch(cause){return Promise.reject(cause);}
      if(uncertain||owned.size||[...pending.values()].some(row=>row.kind==='reserve'))return Promise.reject(error('account-name-reservation-pending',{uncertain}));
      return send('reserve',{name});
    },
    release(token,{committed,eventId,receiptSha256,name}={}){
      if(!owned.has(token))return Promise.reject(error('name-reservation-not-owned'));
      if(committed!==true&&committed!==false)return Promise.reject(error('name-release-outcome-required'));
      return send('release',{token,committed,...(committed?{eventId,receiptSha256,name:name??owned.get(token).name}:{})});
    },
    close(){lost();channel.off('message',receive);channel.off('disconnect',lost);},
    diagnostics(){return {closed,uncertain,pending:pending.size,reservations:owned.size};},
  };
}
module.exports={create};
