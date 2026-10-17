'use strict';
// Normal-client b44270 dispatch, b442c2 status, b44541 claim result,
// 148b2d0 request. Payload offsets are relative to the 12-byte frame header.
const {mkFrame}=require('./bag');
const {chinaDay,claimOnline}=require('./player-account-state');
const rows=require('./client-online-gifts.json');
const responses=new Set([11533,11544,11546,11548]);
function gifts(group=9){
  const result=rows.filter(r=>r[5]===group).map(r=>({tier:r[1],itemId:r[2],count:r[3],requiredSeconds:r[4]}));
  if(result.length!==5||result.some((r,i)=>r.tier!==i+1||!Number.isInteger(r.requiredSeconds)||r.requiredSeconds<0))throw Error('Invalid online gift group');
  return result;
}
function parse(message,payload){
  if(![11532,11543,11545,11547].includes(message))return null;
  if(!Buffer.isBuffer(payload)||payload.length!==(message===11545?1:0))throw Error('Invalid online request length');
  if(message===11545){if(payload[0]>4)throw Error('Invalid online tier');return {operation:'claim',tier:payload[0]+1};}
  return {operation:{11532:'time',11543:'status',11547:'event'}[message]};
}
function progress(account,now){
  const row=account.online.days[chinaDay(now)];
  return {seconds:Math.floor((row?.milliseconds||0)/1000),mask:(row?.claimed||[]).reduce((mask,tier)=>mask|(1<<(tier-1)),0)};
}
function status(account,now=Date.now()){
  const {seconds,mask}=progress(account,now),payload=Buffer.alloc(5);payload[0]=mask;payload.writeUInt32LE(seconds,1);return mkFrame(11544,payload);
}
function result(tier,ok,account,now=Date.now()){
  if(!Number.isInteger(tier)||tier<1||tier>5)throw Error('Invalid online tier');
  const payload=Buffer.alloc(6);payload.writeUInt32LE(ok?0:1);payload[4]=tier-1;payload[5]=progress(account,now).mask;return mkFrame(11546,payload);
}
function serverTime(now=Date.now()){const p=Buffer.alloc(4);p.writeUInt32LE(Math.floor(now/1000));return mkFrame(11533,p);}
// Installed-client b44770 selects group 9 for event 10163/10138. The current
// captured 11548 is 01 b3 27 00 00. Keep event and rewards coupled.
function event(){return mkFrame(11548,Buffer.from('01b3270000','hex'));}
function prepare(account,tier,now=Date.now()){
  const draft=JSON.parse(JSON.stringify(account)),reward=claimOnline(draft,tier,gifts(),now);
  return {revision:account.revision,reward,draft};
}
module.exports={gifts,parse,progress,status,result,serverTime,event,prepare,responses};
