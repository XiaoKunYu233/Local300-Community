'use strict';
// Verified policy from current-client config and the in-client help supplied
// 2026-10-09. Allocation and initial-ratio RNG are server-only unknowns: callers
// must supply an explicit policy; this module never invents original values.
const forge=new Map(require('./logs/cfg/equipforge_equipforge.json').map(r=>[r[1],r]));
const wash=new Map(require('./logs/cfg/equipforge_forgewash.json').map(r=>[r[1],r]));
const washBands=require('./logs/cfg/equipforge_forgewashattr.json');
const attrs=require('./logs/cfg/equipforge_forgeattr.json');
const weights=new Map(require('./logs/cfg/equipforge_forgeweight.json').map(row=>[row[1],row[2]]));
const {fields,nongrowing}=require('./equipment-inheritance');
const growthPoints={15:15,18:8,10:45,31:6,50:7,90:35,38:1,39:1,42:10,43:10,3:40,2:30,89:30,83:40,84:40,87:15,88:15,85:45,86:40,4:30};
const byCode=new Map(attrs.map(row=>[row[6],{id:row[6],rowId:row[1],name:row[2],growthPoints:growthPoints[row[6]],enhancementPoints:row[3],growing:!nongrowing.has(row[6])}]));
const validRandom=random=>{const n=random();if(!Number.isFinite(n)||n<0||n>=1)throw Error('invalid-forge-random');return n;};
function weighted(rows,weight,random){
  let cursor=validRandom(random)*rows.reduce((sum,row)=>sum+weight(row),0);
  for(const row of rows){cursor-=weight(row);if(cursor<0)return row;}
  throw Error('empty-forge-pool');
}
function lockedEntries(current,mask) {
  if(!Number.isInteger(mask)||mask<0||mask>31)throw Error('invalid-forge-lock-mask');
  const locked=current.filter((_,i)=>mask&(1<<i));
  if(locked.length>3||Array.from({length:5},(_,i)=>i).some(i=>(mask&(1<<i))&&!current[i]))throw Error('invalid-forge-lock-mask');
  return locked;
}
function quote(materialId,current=[],lockMask=0,operation='forge') {
  const locked=lockedEntries(current,lockMask),row=(operation==='forge'?forge:wash).get(materialId);
  if(!row)throw Error('invalid-forge-material');
  return {costs:{[materialId]:Number(row[(operation==='forge'?7:3)+locked.length])},level:row[2],pityMaximum:operation==='forge'?row[11]:null};
}
function countFor(materialId,random=Math.random){
  const row=forge.get(materialId);if(!row)throw Error('invalid-forge-material');
  return weighted(String(row[3]).split(';').map((n,i)=>({count:i+1,weight:Number(n)})),r=>r.weight,random).count;
}
function budget({base,enhanced=base,shoe=false}) {
  const out={growth:0,fixed:0,enhancement:0};
  for(const [id,attr] of byCode){
    if(shoe&&id===3)continue;
    const value=Number(base[id]||0),extra=Math.max(0,Number(enhanced[id]||0)-value);
    out[attr.growing?'growth':'fixed']+=value*attr.growthPoints;
    out.enhancement+=extra*attr.enhancementPoints;
  }
  return out;
}
function fromArmour(row){return Object.fromEntries(Object.entries(fields).map(([id,col])=>[id,Number(row[col]||0)]));}
function eligible(base,{shoe=false}={}) {return [...byCode.values()].filter(a=>(a.growing||Number(base[a.id]||0)>0)&&!(shoe&&a.id===3));}
function maxima({base,enhanced=base,ids,shares,materialId,shoe=false}) {
  const row=forge.get(materialId);if(!row)throw Error('invalid-forge-material');
  if(!ids.length||ids.length>4||new Set(ids).size!==ids.length)throw Error('invalid-forge-attributes');
  const pools=budget({base,enhanced,shoe}),allowed=new Set(eligible(base,{shoe}).map(a=>a.id)),spent={growth:0,fixed:0,enhancement:0};
  return ids.map(id=>{
    if(!allowed.has(id))throw Error('ineligible-forge-attribute');
    const attr=byCode.get(id),main=Number(base[id]||0)>0,part=shares[id]||{},kind=attr.growing?'growth':'fixed';
    for(const k of Object.keys(spent)) {
      const share=Number(part[k]||0);
      if(!Number.isFinite(share)||share<0||share>(main?.8:.4))throw Error('forge-share-cap');
      if(share&&((k==='enhancement'&&!attr.enhancementPoints)||(k!=='enhancement'&&k!==kind)))throw Error('forge-budget-class-mismatch');
      spent[k]+=share;if(spent[k]>1+1e-9)throw Error('forge-budget-exceeded');
    }
    let basic=pools[kind]*Number(part[kind]||0)/attr.growthPoints;
    if(main)basic=Math.min(basic,Number(base[id])*1.2);
    const extra=attr.enhancementPoints?pools.enhancement*Number(part.enhancement||0)/attr.enhancementPoints:0;
    // Convert each separate value budget to whole attribute units BEFORE
    // applying fire quality. E.g. attack 112 + 131, not 112.666 + 131.333.
    const maximum=Math.floor((Math.floor(basic)*Number(row[kind==='growth'?4:5])+Math.floor(extra)*Number(row[6]))/100);
    return {id,rowId:attr.rowId,maximum,main};
  });
}
function washCurrent({current,materialId,lockMask=0,random=Math.random}) {
  const q=quote(materialId,current,lockMask,'wash');
  if(!current.length)throw Error('equipment-not-forged');
  const column=q.level===1?3:4;
  return {costs:q.costs,candidate:current.map((attr,i)=>{
    if(lockMask&(1<<i))return {...attr};
    const band=weighted(washBands,r=>Number(r[column]),random),ratio=Number(band[1])+validRandom(random)*(Number(band[2])-Number(band[1]));
    return {...attr,value:Math.floor(attr.maximum*ratio/100)};
  })};
}
// Deterministic for one equipment/level/material/attribute combination.
// Weights (main:secondary 2:1) determine allocation; 80%/40% are only caps.
// Do not redistribute unused shares: the reference leaves 20% of crit unused.
function deterministicShares(base,ids){
  if(!ids.length||ids.length>4||new Set(ids).size!==ids.length||ids.some(id=>!byCode.has(id)))throw Error('invalid-forge-attributes');
  const shares=Object.fromEntries(ids.map(id=>[id,{}]));
  for(const kind of ['growth','fixed','enhancement']){
    const pool=ids.filter(id=>kind==='enhancement'?byCode.get(id).enhancementPoints:
      byCode.get(id).growing===(kind==='growth'));
    const weight=id=>weights.get(Number(base[id]||0)>0?1:2),total=pool.reduce((sum,id)=>sum+weight(id),0);
    for(const id of pool)shares[id][kind]=Math.min(Number(base[id]||0)>0?.8:.4,weight(id)/total);
  }
  return shares;
}
function fixedMaxima({base,enhanced=base,ids,materialId,shoe=false}) {
  return maxima({base,enhanced,ids,materialId,shoe,shares:deterministicShares(base,ids)});
}
// This verified portion decides which entries survive and when the selected
// pity entry must be inserted. Attribute/value generation remains explicit.
function selection({current=[],lockMask=0,materialId,wishId,pity=0,base,shoe=false,random=Math.random,selectAttribute=null}) {
  const q=quote(materialId,current,lockMask),locked=lockedEntries(current,lockMask),wish=byCode.get(wishId);
  // Native 14b5955 offers all eligible rows, including existing crit, etc.
  if(locked.some(a=>a.id===wishId))throw Error('forge-wish-is-locked');
  if(!wish||!eligible(base,{shoe}).some(a=>a.id===wishId))throw Error('invalid-forge-wish');
  const available=eligible(base,{shoe}).filter(a=>!locked.some(v=>v.id===a.id));
  const drawn=countFor(materialId,random),guaranteed=pity>=q.pityMaximum;
  const extra=guaranteed&&drawn<=locked.length&&locked.length<4?1:Math.max(0,drawn-locked.length);
  const selected=[];
  if(guaranteed&&extra)selected.push(wishId);
  while(selected.length<extra){
    const pool=available.filter(a=>!selected.includes(a.id));
    // The help's 2:1 is a value-allocation ratio, not evidence of the
    // server's attribute-selection probability. Require that policy explicitly.
    if(typeof selectAttribute!=='function')throw Error('forge-attribute-selection-policy-unconfirmed');
    const id=selectAttribute(pool.map(a=>({...a})),random);
    if(!pool.some(a=>a.id===id))throw Error('invalid-selected-forge-attribute');
    selected.push(id);
  }
  const hasWish=selected.includes(wishId),ids=[...locked.map(a=>a.id),...selected];
  return {...q,ids,locked:locked.map(a=>({...a})),pity:hasWish?0:pity+1,
    keptOnlyLocks:extra===0,guaranteed:guaranteed&&hasWish};
}
module.exports={quote,countFor,budget,maxima,fixedMaxima,deterministicShares,fromArmour,eligible,washCurrent,selection,byCode,growthPoints};
