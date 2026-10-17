'use strict';
// XReqNewTokenOp 14bf6b0, receive 16824 dc88d0; normal-client
// exchangeshop.lua and four genuine 328-byte snapshots (2026-10-07).
const native=require('./client-exchange-shop.json'),{containerOf}=require('./item-containers');
const integer=(v,min,max=0xffffffff)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function configuration(patch={}){
  if(!patch||Array.isArray(patch)||typeof patch!=='object')throw Error('Invalid exchange settings');
  const result={enabled:true,startsAt:native.startsAt,endsAt:native.endsAt,refreshSeconds:3600,
    refreshCost:native.refreshCost,pool:native.pool.filter(r=>['slot','material','resource'].includes(containerOf(r.itemId)))};
  for(const [key,value]of Object.entries(patch)){
    if(key==='enabled'){if(typeof value!=='boolean')throw Error('Invalid exchange enabled');}
    else if(['startsAt','endsAt'].includes(key)){if(!integer(value,0))throw Error('Exchange dates must be Unix seconds');}
    else if(key==='refreshSeconds'){if(!integer(value,60,604800))throw Error('Invalid exchange interval');}
    else if(key==='refreshCost'){if(!integer(value,0))throw Error('Invalid exchange refresh price');}
    else if(key==='pool'){
      if(!Array.isArray(value)||value.length>500)throw Error('Invalid exchange pool');
      const seen=new Set();for(const r of value){
        if(!r||Object.keys(r).sort().join(',')!=='count,itemId,limit,price'||!integer(r.itemId,1,65534)||
          !integer(r.count,1,255)||!integer(r.price,1)||!integer(r.limit,0)||seen.has(r.itemId)||
          !['slot','material','resource'].includes(containerOf(r.itemId)))throw Error('Invalid or unsupported exchange product');
        seen.add(r.itemId);
      }
    }else throw Error('Unknown exchange setting '+key);
    result[key]=value;
  }
  if(result.endsAt<=result.startsAt)throw Error('Invalid exchange sale interval');
  return result;
}
function available(config,now){return config.enabled&&now>=config.startsAt&&now<config.endsAt;}
function rotate(config,previous={},now=Math.floor(Date.now()/1000),randomInt=require('crypto').randomInt){
  const pool=config.pool.map(r=>({...r}));
  for(let i=pool.length-1;i>0;i--){const j=randomInt(i+1);[pool[i],pool[j]]=[pool[j],pool[i]];}
  return {version:1,generation:(previous.generation||0)+1,nextRefresh:now+config.refreshSeconds,
    rows:pool.slice(0,12),counts:{}};
}
function frame(config,state,playerId){
  const rows=state?.rows||[],p=Buffer.alloc(28+rows.length*24);
  [rows.length,native.activityId,state?.nextRefresh||0,config.startsAt,config.endsAt,1,config.refreshCost]
    .forEach((n,i)=>p.writeUInt32LE(n,i*4));
  rows.forEach((r,i)=>[r.itemId,r.count,r.price,r.price,r.limit,state.counts[r.itemId]||0]
    .forEach((n,k)=>p.writeUInt32LE(n,28+i*24+k*4)));
  return require('./bag').mkFrame(16824,p,{stream:playerId,flags:0xd3});
}
module.exports={configuration,available,rotate,frame};
