'use strict';
// Prepare a complete device/inventory transaction without writing any files.
const crypto=require('crypto');
const protocol=require('./progression-protocol');
const {MagicGemState}=require('./magic-gem-system');
const cfg=require('./client-magic-config/magicgem.json');
const P=require('./battle-protobuf');
const clone=value=>JSON.parse(JSON.stringify(value));
const hex=value=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(value));return b.toString('hex');};

function captureGemIndex(files){
 const out=new Map();
 for(const file of files){
  if(!require('fs').existsSync(file))continue;
  for(const line of require('fs').readFileSync(file,'utf8').split(/\r?\n/)){
   let row;try{row=JSON.parse(line);}catch{continue;}
   if(row.dir!=='s2c'||![13590,11888].includes(row.msgid))continue;
   try{
    const payload=Buffer.from(row.hex,'hex').subarray(12);
    let fields=P.decode(payload.subarray(row.msgid===13590?4:0));
    if(row.msgid===11888)fields=P.decode(fields.find(f=>f.number===10&&f.wire===2)?.bytes||Buffer.alloc(0));
    for(const field of fields.filter(f=>f.number===(row.msgid===13590?2:12)&&f.wire===2)){
     const f=P.decode(field.bytes), scalar=(n)=>Number(f.find(v=>v.number===n&&v.wire===0)?.value||0);
     const id=f.find(v=>v.number===1&&v.wire===0)?.value;if(!id)continue;
     const attrs=f.filter(v=>v.number===2&&v.wire===2).map(v=>{
      const a=P.decode(v.bytes),n=k=>Number(a.find(x=>x.number===k)?.value||0);
      return {attrClass:n(1),attrId:n(2),value:n(3),setId:n(4),setLevel:n(5)};
     });
     out.set(hex(id),{attrs,locked:!!scalar(7),lockEndTime:scalar(8)});
    }
   }catch{}
  }
 }
 return out;
}

function hydrate(state,bag,captured){
 for(const held of bag.values()){
  const row=cfg.find(r=>Number(r[1])===held.itemId),observed=captured.get(held.guid);
  if(!row||!observed||state.state.gems[held.guid])continue;
  state.state.gems[held.guid]={id:held.guid,itemId:held.itemId,type:Number(row[2]),quality:Number(row[3]),level:Number(row[3]),
   refined:Math.max(0,observed.attrs.filter(a=>a.attrClass).length-5),...clone(observed)};
 }
}

function prepare({state,request,tag,payload,bag,materials,resources,wallet,capacity,captured=new Map(),containerOf=()=> 'material',stackMax=1000,canStackItem=()=>true}){
 const fail=reason=>({ok:false,reason});
 if(request.invalidNativeLocks)return fail('invalid-magic-native-lock-mask');
 const lengths={13580:40,13584:9,13586:72,13588:13,13593:12,13595:4};
 if(lengths[tag]!==undefined&&payload.length!==lengths[tag])return fail('invalid-magic-request-length');
 if(tag===13584&&payload[8]>1)return fail('invalid-magic-raise-mode');
 if(tag===13588&&(payload.readUInt32LE(8)>7||payload[12]>1))return fail('invalid-magic-unequip');
 const next=Object.create(MagicGemState.prototype);next.state=clone(state.state);next.random=state.random;next.save=()=>{};
 const inventory=new Map([...bag].map(([s,v])=>[s,clone(v)])),mat=new Map(materials),res={...resources},money={...wallet};
 const changedSlots=new Set(),changedMaterials=new Set(),changedResources=new Set();
 const byGuid=id=>[...inventory].find(([,v])=>v.guid===id);
 const op=request.operation;
 if(request.deviceGuid){
  const held=byGuid(request.deviceGuid)?.[1];
  if(!held||![46500,46501,46502,46503].includes(held.itemId))return fail('magic-device-not-owned');
  if(!next.device(request.deviceGuid))next.createDevice({guid:request.deviceGuid,itemId:held.itemId});
 }
 const changedGems=new Set();
 const gemIds=request.gemId?[request.gemId]:(request.gemIds||[]).filter(Boolean);
 for(const id of gemIds){
  const owned=next.state.gems[id];
  const held=byGuid(id)?.[1] || (Number.isInteger(owned?.inventorySlot)?{itemId:owned.itemId,guid:id}:null),row=cfg.find(r=>Number(r[1])===held?.itemId);
  if(!row)return fail('magic-gem-not-in-bag');
  if(!next.state.gems[id]){
   const observed=captured.get(id);if(!observed)return fail('magic-gem-attributes-unavailable');
   next.state.gems[id]={id,itemId:held.itemId,type:Number(row[2]),quality:Number(row[3]),level:Number(row[3]),refined:Math.max(0,observed.attrs.filter(a=>a.attrClass).length-5),...clone(observed)};
  }
 }
 const freeGems=()=>Object.values(next.state.gems).filter(g=>Number.isInteger(g.inventorySlot)&&!g.locked);
 const balance=id=>res[id]!==undefined?Number(res[id]):mat.has(id)?Number(mat.get(id)):[...inventory.values()].filter(v=>v.itemId===id).reduce((a,v)=>a+v.count,0)+freeGems().filter(g=>g.itemId===id).length;
 const ids=new Set([...mat.keys(),...Object.keys(res).map(Number),...[...inventory.values()].map(v=>v.itemId),...freeGems().map(g=>g.itemId)]);
 const q={...request,availableMaterials:Object.fromEntries([...ids].map(id=>[id,balance(id)])),availableWallet:{gold:money[50]||0,diamond:money[72]||0}};
 let result;
 if(op==='openRaw'){
  const held=inventory.get(request.slot);
  if(!held||held.itemId<46810||held.itemId>46814||held.count<1)return fail('invalid-magic-raw-stone');
  result=next.grantGem({itemId:46000+held.itemId-46810,quality:held.itemId-46810+1,level:held.itemId-46810+1});
  result.rawItemId=held.itemId;result.rawSlot=request.slot;
  held.count--;if(!held.count)inventory.delete(request.slot);changedSlots.add(request.slot);
 }else result=protocol.handle(q,{magicGem:next});
 if(!result.ok)return result;
 const debit=(id,count)=>{
  if(balance(id)<count)return false;
  if(res[id]!==undefined){res[id]-=count;changedResources.add(id);return true;}
  if(mat.has(id)){mat.set(id,mat.get(id)-count);changedMaterials.add(id);return true;}
  for(const [slot,value] of inventory){if(value.itemId!==id)continue;const used=Math.min(value.count,count);value.count-=used;count-=used;if(!value.count)inventory.delete(slot);changedSlots.add(slot);if(!count)break;}
  for(const gem of freeGems().sort((a,b)=>(a.id===request.sourceGuid?-1:0)-(b.id===request.sourceGuid?-1:0))){if(!count)break;if(gem.itemId!==id)continue;delete next.state.gems[gem.id];changedGems.add(gem.id);count--;}
  return count===0;
 };
 const put=(itemId,count,id=null)=>{
  if(!id&&containerOf(itemId)==='resource'){res[itemId]=(res[itemId]||0)+count;changedResources.add(itemId);return null;}
  if(!id&&containerOf(itemId)==='material'){mat.set(itemId,(mat.get(itemId)||0)+count);changedMaterials.add(itemId);return null;}
  if(!['slot'].includes(containerOf(itemId)))throw Error('magic-output-container-unknown');
  const limit=!id&&canStackItem(itemId)?stackMax:1;
  if(limit>1)for(const [slot,held] of inventory){
   if(slot>=capacity||held.itemId!==itemId||held.count>=limit||held.locked||held.forge)continue;
   const added=Math.min(limit-held.count,count);held.count+=added;count-=added;changedSlots.add(slot);if(!count)return held.guid;
  }
  let last;
  while(count>0){
   let slot;for(let i=0;i<capacity;i++)if(!inventory.has(i)){slot=i;break;}
   if(slot===undefined)throw Error('magic-gem-bag-full');
   const guid=id||crypto.randomBytes(8).toString('hex'),added=Math.min(limit,count);
   inventory.set(slot,{itemId,count:added,guid});changedSlots.add(slot);count-=added;last=guid;
  }
  return last;
 };
 try{
  for(const [id,count] of Object.entries(result.costs||{}))if(!debit(Number(id),Number(count)))return fail('magic-material-insufficient');
  for(const [kind,count] of Object.entries(result.walletCosts||{})){
   const id=kind==='gold'?50:72;
   if(!Number.isSafeInteger(count)||count<0||count>0xffffffff)return fail('magic-wallet-insufficient');
   // A proved free operation does not establish a previously unknown balance.
   if(count===0)continue;
   if(!Number.isSafeInteger(money[id])||money[id]<0||money[id]>0xffffffff||money[id]<count)return fail('magic-wallet-insufficient');
   money[id]-=count;
  }
  if(op==='equip'||op==='compose')for(const id of gemIds){
   const entry=byGuid(id);if(entry){inventory.delete(entry[0]);changedSlots.add(entry[0]);}
   if(next.state.gems[id])delete next.state.gems[id].inventorySlot;
   changedGems.add(id);
  }
  const putGem=(gem,id)=>{
   const occupied=new Set(Object.values(next.state.gems).filter(g=>g.id!==gem.id&&Number.isInteger(g.inventorySlot)).map(g=>g.inventorySlot));
   let slot=0;while(occupied.has(slot))slot++;
   if(slot>=65535)throw Error('magic-gem-bag-full');
   delete next.state.gems[gem.id];gem.id=id;gem.inventorySlot=slot;next.state.gems[id]=gem;changedGems.add(id);
  };
  if(op==='unequip'){
   const gem=next.state.gems[result.gemId];if(!gem)return fail('magic-gem-not-found');
   const id=typeof gem.id==='string'&&/^[a-f0-9]{16}$/.test(gem.id)?gem.id:crypto.randomBytes(8).toString('hex');
   if(byGuid(id)||Number.isInteger(gem.inventorySlot))return fail('magic-gem-already-in-bag');
   putGem(gem,id);
  }
  if(op==='setGraph'||op==='circuitMark'){
   // Switching a feature is a recoverable inventory move. Keep each gem's
   // instance id and return every socketed gem to a visible bag slot before
   // committing the new circuit, so no stale socket index can survive.
   for(const id of result.detachedGemIds||[]) {
    const gem=next.state.gems[id];
    if(!gem)return fail('magic-gem-not-found');
    if(Number.isInteger(gem.inventorySlot))return fail('magic-gem-already-in-bag');
    putGem(gem,id);
   }
  }
  if(op==='compose'||op==='openRaw')putGem(result.gem,crypto.randomBytes(8).toString('hex'));
  for(const [id,count] of Object.entries(result.outputs||{}))put(Number(id),Number(count));
 }catch(e){return fail(e.message);}
 return {ok:true,result,changedGems:[...changedGems],state:next.state,bag:inventory,materials:mat,resources:res,wallet:money,changedSlots:[...changedSlots],changedMaterials:[...changedMaterials],changedResources:[...changedResources]};
}

function ack(tag,request,result){
 const mk=require('./bag').mkFrame;
 if([13584,13586,13588].includes(tag))return mk(tag+1,Buffer.alloc(0),{flags:0x0d});
 if(tag===13593||tag===13595){const p=Buffer.alloc(tag===13593?12:4);p.writeUInt32LE(request.plan+1);if(tag===13593)Buffer.from(request.deviceGuid,'hex').copy(p,4);return mk(tag+1,p,{flags:0x0d});}
 if(tag===13580){const p=Buffer.alloc(12);p.writeUInt32LE(result.success?0:1);Buffer.from(result.gem.id,'hex').copy(p,4);return mk(13581,p,{flags:0x0d});}
 if(tag===13554){const p=Buffer.alloc(5);p[0]=1;p.writeUInt32LE(request.recipeId,1);return mk(13555,p,{flags:0x0d});}
 return null;
}
function inventoryFrames(before,after){
 const mk=require('./bag').mkFrame,slots=state=>new Map(Object.values(state?.gems||{}).filter(g=>Number.isInteger(g.inventorySlot)).map(g=>[g.inventorySlot,g]));
 const old=slots(before),next=slots(after),frames=[];
 for(const slot of new Set([...old.keys(),...next.keys()])){
  const a=old.get(slot),g=next.get(slot);if(JSON.stringify(a)===JSON.stringify(g))continue;
  const p=Buffer.alloc(499);p[1]=g?0x0a:0x0f;p.writeUInt32LE(1,2);p[6]=6;p.writeUInt16LE(slot,7);
  p.writeUInt32LE(g?.itemId||65535,9);p.writeUInt32LE(g?1:0,13);
  if(g)Buffer.from(g.id,'hex').copy(p,17);
  frames.push(mk(17004,p,{flags:0x0d}));
 }
 return frames;
}
function incrementalFrames(state){
 const mk=require('./bag').mkFrame,frames=[];
 for(const field of P.decode(protocol.magicGemNotifyPayload({state}).subarray(4))){
  if(field.wire!==2||![1,2].includes(field.number))continue;
  const body=P.encode([{number:1,wire:0,value:1n},{number:2,wire:2,bytes:field.bytes}]).toString('base64');
  const p=Buffer.alloc(2+body.length+1);p.writeUInt16LE(body.length+1);p.write(body,2,'ascii');
  frames.push(mk(field.number===1?13592:13591,p,{flags:0x0d}));
 }
 return frames;
}
module.exports={captureGemIndex,hydrate,prepare,ack,inventoryFrames,incrementalFrames};
