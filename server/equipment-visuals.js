'use strict';
const P=require('./battle-protobuf'),W=require('./battle-wire'),G=require('./gem-board');
const statuses=require('../data/current-client/skill_statuslist.json');
const effects=new Map();
for(const r of statuses){
  if(r[2]!==1||!r[35])continue;
  const m=/^(\d+)定制装备特效$/.exec(r[59]||'');
  if(m){const id=+m[1];if(!effects.has(id))effects.set(id,[]);effects.get(id).push(r[1]);}
}
function selected(slots,gemState){
  const list=slots instanceof Map?[...slots].map(([slot,e])=>({...e,slot})):slots;
  const out=new Map(),occupied=new Set();
  for(const e of list||[]){
    if(!e||e.slot<0||e.slot>=6||!e.itemId||e.itemId===65535)continue;
    occupied.add(e.slot);for(const status of effects.get(e.itemId)||[])out.set(status,1);
  }
  let count=0;
  for(const [slot,grid]of (gemState?.plans?.[gemState.activePlan]||[]).entries())
    if(occupied.has(slot))for(const gem of grid)if(gem&&G.catalog.get(gem.id)?.level===8)count++;
  // Native captures send 50110 level 12/13. Its client table provides a
  // distinct effect for every count from 1 through 24. One dual = one gem.
  if(count)out.set(50110,Math.min(24,count));
  return out;
}
const field=(number,value)=>({number,wire:0,value:BigInt(value)});
function statusPacket(actor,heroId,status,level,remove=false,skin=0){
  const fields=[field(3,heroId),field(5,status),field(6,level),
    ...(remove?[field(7,3)]:[]),field(10,1),field(11,skin)];
  const b=P.encode(fields);return W.frame(11007,actor,Buffer.concat([Buffer.from([b.length]),b]));
}
function packets(actor,heroId,next,previous=new Map(),{force=false,skin=0}={}){
  if(!Number.isInteger(heroId)||heroId<=0)return [];
  const out=[];
  for(const [status,level]of previous)if(next.get(status)!==level)out.push(statusPacket(actor,heroId,status,level,true,skin));
  for(const [status,level]of next)if(force||previous.get(status)!==level)out.push(statusPacket(actor,heroId,status,level,false,skin));
  return out;
}
module.exports={effects,selected,statusPacket,packets};
