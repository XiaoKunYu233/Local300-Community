'use strict';
const fs=require('./persistence/state-files').io,path=require('path');
const {normalizeGuid}=require('./enhancement-state');
// Soul quantities are stored in tenths, matching CItem dynamic attributes.
const families={
  drink:{gain:5,cap:1500,loss:20},book:{gain:10,cap:2000,loss:20},
  hp:{gain:80,cap:16000,loss:20},mp:{gain:80,cap:16000,loss:20},
  sword:{gain:2,cap:300,loss:5},mr:{gain:1,cap:250,loss:20},armor:{gain:1,cap:250,loss:20},
};
const rules=new Map();
for(const r of require('./runtime/catalogs').loadConfig('current-items').data){
  const desc=String(r[24]||'');if(r[1]<26000||r[1]>=32000||!desc.includes('灵魂')||!desc.includes('储存上限'))continue;
  const kind=desc.includes('0.5点攻击力')?'drink':desc.includes('1点法术强度')?'book'
    :desc.includes('8点生命上限')?'hp':desc.includes('8点法力上限')?'mp'
    :desc.includes('0.2%攻速加成')?'sword':desc.includes('0.1点无法穿透的法术抗性')?'mr'
    :desc.includes('0.1点无法穿透的物理防御')?'armor':null;
  if(kind)rules.set(r[1],{kind,name:r[23],...families[kind]});
}
function stateFile(){return process.env.DSH_SOUL_STATE||path.join(path.dirname(
  process.env.DSH_EQUIP_STATE||process.env.DSH_ENHANCEMENT_STATE||process.env.DSH_BAG_STATE||path.join(__dirname,'equip-state.json')),'soul-state.json');}
function validate(data){
  if(data?.version!==1||!data.instances||typeof data.instances!=='object'||Array.isArray(data.instances))throw Error('Invalid soul state');
  for(const [guid,r]of Object.entries(data.instances)){
    const rule=rules.get(r.itemId);if(normalizeGuid(guid)!==guid)throw Error('Noncanonical soul GUID');
    if(!rule||![r.current,r.maximum].every(Number.isInteger)||r.current<0||r.current>r.maximum||r.maximum>rule.cap)throw Error('Invalid soul instance '+guid);
  }
  return data;
}
class SoulState{
  constructor(file=stateFile()){this.file=path.resolve(file);this.reload();}
  reload(){this.state=fs.existsSync(this.file)?validate(JSON.parse(fs.readFileSync(this.file,'utf8'))):{version:1,instances:{}};return this;}
  get(guid,itemId){
    if(!rules.has(itemId))return null;
    const key=normalizeGuid(guid),r=this.state.instances[key];
    if(r&&r.itemId!==itemId)throw Error('Soul GUID identity changed');
    return {...(r||{itemId,current:0,maximum:0})};
  }
  save(next){
    validate(next);fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.'+process.pid+'.tmp';
    try{fs.writeFileSync(tmp,JSON.stringify(next,null,2));fs.renameSync(tmp,this.file);}catch(e){try{fs.rmSync(tmp,{force:true});}catch{}throw e;}
  }
  change(entries,operation){
    this.reload();const next=structuredClone(this.state),changed=[],seen=new Set();
    for(const e of entries){
      const rule=rules.get(e.itemId);if(!rule)continue;
      const guid=normalizeGuid(e.guid);if(seen.has(guid))continue;seen.add(guid);
      const row=this.get(guid,e.itemId),before={...row};
      if(operation==='kill'){row.maximum=Math.min(rule.cap,row.maximum+rule.gain);row.current=Math.min(row.maximum,row.current+rule.gain);}
      else if(operation==='death')row.current=Math.max(0,row.current-Math.floor(row.maximum*rule.loss/100));
      else throw Error('Unknown soul operation');
      if(row.current!==before.current||row.maximum!==before.maximum){next.instances[guid]=row;changed.push({...e,soul:row});}
    }
    if(changed.length){this.save(next);this.state=next;}return changed;
  }
}
function parseRefill(p){
  if(!Buffer.isBuffer(p)||p.length!==11)return null;
  try{return {guid:normalizeGuid(p.subarray(0,8)),counts:[p[8],p[9],p[10]]};}catch{return null;}
}
function planRefill(store,request,slots,{capacity=192}={}){
  if(!request||!request.counts.some(Boolean))return {ok:false,reason:'invalid-request'};
  const found=[...slots].find(([,e])=>e?.guid?.toLowerCase()===request.guid);
  if(!found||!rules.has(found[1].itemId))return {ok:false,reason:'not-soul-equipment'};
  const [slot,item]=found,row=store.get(request.guid,item.itemId);
  if(row.current>=row.maximum)return {ok:false,reason:'soul-full'};
  const bag=new Map([...slots].map(([s,e])=>[s,{...e}])),touched=[];
  for(const [i,count]of request.counts.entries()){
    let remaining=count;const id=918+i;
    for(const [s,e]of bag){
      if(s<0||s>=capacity||e.itemId!==id)continue;
      const take=Math.min(remaining,e.count);if(!Number.isInteger(take)||take<0)return {ok:false,reason:'invalid-material'};
      if(take){remaining-=take;e.count-=take;touched.push(s);if(!e.count)bag.delete(s);}
      if(!remaining)break;
    }
    if(remaining)return {ok:false,reason:'insufficient-crystals'};
  }
  const gain=Math.floor(row.maximum*request.counts.reduce((s,n,i)=>s+n*[10,20,50][i],0)/100);
  if(gain<=0)return {ok:false,reason:'no-restoration'};
  row.current=Math.min(row.maximum,row.current+gain);
  const next=structuredClone(store.state);next.instances[request.guid]=row;
  return {ok:true,next,bag,touched:[...new Set(touched)],equipmentSlot:slot,item,soul:row};
}
function patchRecord(record,item,row){
  if(!rules.has(item.itemId))return;
  row??={current:0,maximum:0};
  // CItem base 0x1ab; current 0x21b and maximum 0x21f. Current has a +1
  // sentinel (db381d), the soul UI divides both values by 10 (db3836).
  record.writeUInt32LE(row.current+1,112);record.writeUInt16LE(row.maximum,116);
}
function bonuses(entries){
  const stats={},add=(id,n)=>stats[id]=(stats[id]||0)+n;
  let unpenetrableArmor=0,unpenetrableMR=0,drinkFull=false;
  const seen=new Set();
  for(const e of entries){
    const rule=rules.get(e.itemId),guid=Buffer.isBuffer(e.guid)?e.guid.toString('hex'):e.guid;
    if(!rule||!e.soul||(e.slot!==undefined&&(e.slot<0||e.slot>=6))||seen.has(guid))continue;seen.add(guid);
    const q=e.soul.current/10;
    switch(rule.kind){
      case 'drink':add(30,q);add(127,q);if(q>=50)add(15,30);if(q>=100)add(108,20);if(q>=150){add(97,8);drinkFull=true;}break;
      case 'book':add(31,q);add(128,q);if(q>=100)add(100,20);if(q>=200)add(37,25);break;
      case 'hp':add(1,q);add(8,q);if(q>=800){add(42,50);add(44,50);}if(q>=1600)add(96,10);break;
      case 'mp':add(2,q);add(9,q);if(q>=800)add(13,60);if(q>=1600)add(37,20);break;
      case 'sword':add(15,q);if(q>=30){add(30,50);add(127,50);add(108,10);}else{if(q>=10){add(30,25);add(127,25);}if(q>=20)add(108,5);}break;
      case 'armor':add(42,q);unpenetrableArmor+=q;if(q>=12)add(148,q>=25?3:2);break;
      case 'mr':add(44,q);unpenetrableMR+=q;if(q>=12)add(150,q>=25?3:2);break;
    }
  }
  return {stats,unpenetrableArmor,unpenetrableMR,drinkFull};
}
function tickShield(sim,hero){
  const s=hero.soulShield;if(!s)return;
  const desired=Math.max(0,Math.floor(s.initial*Math.max(0,(s.expires-sim.time)/1.5)));
  const remaining=Math.min(s.remaining,desired);
  if(remaining<s.remaining)sim.setShield(hero,Math.max(0,(hero.shield||0)-(s.remaining-remaining)));
  s.remaining=remaining;if(!remaining)hero.soulShield=null;
}
function drainShield(sim,hero,stolen){
  if(!hero.drinkFull||stolen<=0||sim.time<(hero.soulShieldReady||0))return;
  tickShield(sim,hero);const amount=Math.floor(stolen*.35);if(!amount)return;
  hero.soulShield={initial:amount,remaining:amount,expires:sim.time+1.5};
  hero.soulShieldReady=sim.time+2;sim.setShield(hero,(hero.shield||0)+amount);
}
module.exports={rules,families,stateFile,validate,SoulState,parseRefill,planRefill,patchRecord,bonuses,tickShield,drainShield};
