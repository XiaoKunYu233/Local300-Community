'use strict';
// Native WarSoulEntry is separate from the hero/element upgrade tree.
// Evidence: warsoulpan.lua, 0x14d79b0, 0x62ae50 and 2026-10-07 capture.
const GBK = require('./gbk');
const rows = require('./logs/cfg/warsoulsuccinct.json');
const pool = rows.filter(r => Number(r[1]) > 0 && Number(r[3]) > 0 && Number(r[5]) > 0);
const byId = new Map(pool.map(r => [Number(r[1]), r]));
const price = rows.find(r => Number(r[1]) === 10000);
const [material, amounts] = String(price[4]).split(';');
const lockCosts = amounts.split(',').map(Number);
const clone = v => JSON.parse(JSON.stringify(v));
const emptySlot = () => ({ current: [0, 0, 0], candidate: null, locks: [false, false, false] });
function initial() {
  return { version: 1, opened: 3, active: 0, pages: Array.from({ length: 5 }, (_, i) => ({ name: `战魂页${i+1}`, slots: Array.from({ length: 6 }, emptySlot) })) };
}
function decode(payload) {
  if (!Buffer.isBuffer(payload) || payload.length !== 983) throw Error('invalid-war-soul-entry-snapshot');
  const state = initial();
  state.opened = payload.readUInt32LE(975); state.active = payload.readUInt32LE(979);
  if (state.opened < 3 || state.opened > 5 || state.active >= state.opened) throw Error('invalid-war-soul-entry-pages');
  state.pages.forEach((p, page) => {
    const base = page * 195; p.name = GBK.decode(payload.subarray(base, base+15)).replace(/\0.*$/, '');
    p.slots.forEach((slot, index) => {
      const pos = base+15+index*30;
      slot.current = Array.from({ length: 3 }, (_, j) => payload.readUInt32LE(pos+j*5));
      slot.locks = Array.from({ length: 3 }, (_, j) => !!payload[pos+j*5+4]);
      const candidate = Array.from({ length: 3 }, (_, j) => payload.readUInt32LE(pos+15+j*5));
      slot.candidate = candidate.some(Boolean) ? candidate : null;
    });
  });
  return state;
}
function encode(state = initial()) {
  const out = Buffer.alloc(983);
  state.pages.forEach((p, page) => {
    const base=page*195; GBK.encode(p.name).copy(out,base,0,14);
    p.slots.forEach((slot,index) => {
      const pos=base+15+index*30;
      for(let j=0;j<3;j++) {
        out.writeUInt32LE(slot.current[j]||0,pos+j*5); out[pos+j*5+4]=slot.locks[j]?1:0;
        out.writeUInt32LE(slot.candidate?.[j]||0,pos+15+j*5);
        out[pos+15+j*5+4]=slot.candidate && slot.locks[j]?1:0;
      }
    });
  });
  out.writeUInt32LE(state.opened,975); out.writeUInt32LE(state.active,979); return out;
}
function draw(excluded, random) {
  const available=pool.filter(r=>!excluded.has(Number(r[8])));
  let value=Number(random()); if(!Number.isFinite(value)||value<0||value>=1) throw Error('invalid-random-value');
  let cursor=value*available.reduce((sum,r)=>sum+Number(r[5]),0);
  for(const r of available) { cursor-=Number(r[5]); if(cursor<0)return Number(r[1]); }
  throw Error('war-soul-entry-pool-empty');
}
// Pure transaction preparation. No writes or debits on rejected operations.
function prepare(saved, request, {materials={}, wallet={}, random=Math.random}={}) {
  const state=clone(saved || initial()), op=request.operation, costs={}, walletCosts={};
  const reject=reason=>({ok:false,reason});
  if(op==='entryInfo')return {ok:true,state,costs,walletCosts,readOnly:true};
  const page=Number(request.page);
  if(op==='openEnhancementPage') {
    // The add button sends payment mode 1, not the page to open.
    if(request.page!==1)return reject('unsupported-war-soul-entry-payment');
    if(state.opened>=5)return reject('war-soul-entry-page-limit');
    const row=require('./logs/cfg/warsoulconsumption.json').find(r=>Number(r[1])===state.opened+1);
    const amount=Number(row?.[3])/100;
    if(!amount||Number(wallet[72]||0)<amount)return reject('diamond-insufficient');
    walletCosts.diamond=amount; state.opened++;
    return {ok:true,state,costs,walletCosts};
  }
  if(!Number.isInteger(page)||page<0||page>=state.opened)return reject('war-soul-enhancement-page-not-found');
  const p=state.pages[page];
  if(op==='renameEnhancementPage') {
    const name=String(request.name||'').trim();
    if(!name||GBK.encode(name).length>14)return reject('invalid-war-soul-enhancement-page-name');
    p.name=name;return {ok:true,state,costs,walletCosts};
  }
  if(op==='changeEnhancementPage') {state.active=page;return {ok:true,state,costs,walletCosts};}
  const index=Number(request.index);
  if(!Number.isInteger(index)||index<0||index>=6)return reject('invalid-war-soul-entry-position');
  const slot=p.slots[index];
  if(op==='lockEnhancement') {
    const entry=Number(request.entry);
    if(!Number.isInteger(entry)||entry<0||entry>=3||!slot.current[entry])return reject('invalid-war-soul-entry-lock');
    // The native panel allows changing current-entry locks while a previous
    // candidate is visible. Locks govern the next roll; never rewrite the
    // already-paid candidate or apply it implicitly when toggling a lock.
    const next=[...slot.locks];next[entry]=!!request.locked;
    if(next.every(Boolean))return reject('war-soul-entry-all-locked');
    slot.locks=next;return {ok:true,state,costs,walletCosts};
  }
  if(op!=='washEnhancementPage')return reject('unsupported-war-soul-entry-operation');
  const operation=Number(request.operationCode);
  if(operation===0)slot.candidate=null;
  else if(operation===2) {
    if(!slot.candidate)return reject('no-war-soul-candidate');
    slot.current=slot.candidate;slot.candidate=null;
  } else if(operation===1) {
    const first=!slot.current.some(Boolean), locks=slot.locks.filter(Boolean).length;
    if(locks>=3)return reject('war-soul-entry-all-locked');
    const count=first?0:lockCosts[locks];
    if(Number(materials[material]||0)<count)return reject('war-soul-material-insufficient');
    if(count)costs[material]=count;
    const next=slot.current.map((id,i)=>slot.locks[i]?id:0);
    const excluded=new Set(next.filter(Boolean).map(id=>Number(byId.get(id)?.[8])));
    for(let i=0;i<3;i++)if(!next[i]) {next[i]=draw(excluded,random);excluded.add(Number(byId.get(next[i])[8]));}
    if(first)slot.current=next;else slot.candidate=next;
  } else return reject('invalid-war-soul-enhancement-operation');
  return {ok:true,state,costs,walletCosts};
}
function effects(state) {
  if(!state)return [];
  return state.pages[state.active].slots.flatMap(slot=>slot.current).filter(Boolean).map(id=>{
    const row=byId.get(id);return row ? {succinctId:id,warSoulId:Number(row[2]),statusId:Number(row[3]),type:Number(row[8]),soulValue:String(row[9]),text:String(row[4]),overlay:Number(row[7])}:null;
  }).filter(Boolean);
}
function prepareNative(saved,tag,payload,economy,random=Math.random) {
  const lengths={36295:0,36297:19,36298:4,36299:13,36300:12,36301:4,36302:16,36303:8};
  if(lengths[tag]!==payload.length)return {ok:false,reason:'invalid-war-soul-entry-request-length'};
  if(tag===36299&&payload[12]>1)return {ok:false,reason:'invalid-war-soul-entry-lock'};
  const inventory=require('./crafting-inventory');
  const request=require('./progression-protocol').parse(tag,payload);
  const result=prepare(saved,request,{materials:inventory.balances(economy.bag,economy.materials,economy.resources),wallet:economy.wallet,random});
  if(!result.ok)return result;
  const paid=inventory.debit(economy,result.costs,result.walletCosts);
  return paid.ok?{...paid,...result,request}:paid;
}
module.exports={initial,decode,encode,prepare,prepareNative,effects,byId};
