'use strict';

const fs = require('./persistence/state-files').io;
const path = require('path');
const crypto = require('crypto');
const {VISIBLE_CAPACITY,validLimits,findStack,findFree}=require('./inventory-capacity');

const {loadConfig}=require('./runtime/catalogs');
const catalog = new Map(loadConfig('gems').data.map(row => [+row[1], {
  id:+row[1], level:+row[2], type:+row[3], color:+row[4], category:+row[5],
  attribute:String(row[7]), value:+row[8],
}]));
const costs = new Map(loadConfig('gem-costs').data.map(row => [+row[1], {
  // The popup prints uAddSocketMoney directly; diamond wallet uses 1/100 units.
  gold:+row[6], diamond:+row[7],
}]));
const ATTRIBUTE_IDS = {
  PhysicsAttack:[30,127], MagicAttack:[31,128], PhysicsDefence:[42], MagicDefence:[44],
  MaxHP:[1,8], MaxMP:[2,9], AttackSpeed:[15], MoveSpeed:[17],
  ArmorPuncture:[106], MagicArmorPuncture:[107],
  ArmorPuncturePercent:[108], MagicArmorPuncturePercent:[109],
  CriticalOdds:[24], CriticalDamage:[25],
  HPAbsorb:[97], MPAbsorb:[98], ColdDownMinus:[100],
  PhysicsAttackPercent:[36], MagicAttackPercent:[37], MaxHPPercent:[10], MaxMPPercent:[11],
  HpRecover:[12], MpRecover:[13], SuperArmor:[99],
  PhysicalSkill:[147], PhysicalSkillReduction:[148],
  MagicSkill:[149], MagicSkillReduction:[150],
};
function initial() {
  return {version:1,activePlan:0,plans:Array.from({length:3},()=>
    Array.from({length:6},()=>[null]))};
}
function validateDual(id,dual) {
  const gem=catalog.get(id);
  if(!gem||!dual||!Array.isArray(dual.ids)||dual.ids.length!==2||
    !dual.ids.every(Number.isInteger)||dual.ids[0]===dual.ids[1]||
    !Number.isInteger(dual.percent)||dual.percent%10!==0||!Number.isInteger(dual.quality))
    throw Error('invalid dual gem');
  const components=dual.ids.map(id=>catalog.get(id));
  if(components.some(part=>!part||part.color<1||part.color>6||part.level!==gem.level)||
    components[0].attribute===components[1].attribute||
    (gem.color!==100&&id!==dual.ids[0]))
    throw Error('invalid dual gem components');
  const ranges=[[50,50],[60,70],[80,90],[100,100]],range=ranges[dual.quality];
  if(!range||dual.percent<range[0]||dual.percent>range[1])
    throw Error('invalid dual gem quality');
  return dual;
}
function validateGemDual(id,dual) {
  if(dual!==undefined&&dual!==null)return validateDual(id,dual);
  if(catalog.get(id)?.color===100)throw Error('missing dual gem components');
}
function validate(data) {
  if(data?.version!==1 || !Array.isArray(data.plans) || data.plans.length!==3)
    throw Error('invalid gem board state');
  for(const plan of data.plans){
    if(!Array.isArray(plan)||plan.length!==6)throw Error('invalid gem board plan');
    for(const grid of plan){
      if(!Array.isArray(grid)||grid.length<1||grid.length>4)throw Error('invalid gem board grid');
      for(const gem of grid)if(gem!==null){
        if(!Number.isInteger(gem.id)||!catalog.has(gem.id)||
          !Number.isInteger(gem.sourceSlot)||gem.sourceSlot<0||gem.sourceSlot>65535||
          typeof gem.guid!=='string'||!/^[a-f0-9]{16}$/i.test(gem.guid))
          throw Error('invalid gem board socket');
        validateGemDual(gem.id,gem.dual);
      }
    }
  }
  if(!Number.isInteger(data.activePlan)||data.activePlan<0||data.activePlan>2)
    throw Error('invalid gem board active plan');
  return data;
}
function store(file,data) {
  validate(data);
  const tmp=`${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try {
    fs.writeFileSync(tmp,JSON.stringify(data,null,2));
    fs.renameSync(tmp,file);
  } catch(error) { try{fs.rmSync(tmp,{force:true});}catch{} throw error; }
}
class GemBoard {
  constructor(file=process.env.DSH_GEM_BOARD_STATE||path.join(__dirname,'gem-board-state.json')) {
    this.file=path.resolve(file);
    this.state=fs.existsSync(file)?validate(JSON.parse(fs.readFileSync(file,'utf8'))):initial();
  }
  snapshot(){return structuredClone(this.state);}
  save(data){store(this.file,data);}
  replace(data){this.state=validate(data);}
}
const n=v=>{
  if(!Number.isSafeInteger(v)||v<0||v>0xffffffff)throw RangeError('bad protobuf integer');
  const a=[];do{let b=v&127;v=Math.floor(v/128);if(v)b|=128;a.push(b);}while(v);return Buffer.from(a);
};
const scalar=(field,value)=>Buffer.concat([n(field*8),n(value)]);
const nested=(field,payload)=>Buffer.concat([n(field*8+2),n(payload.length),payload]);
function gemMessage(gem){
  if(!gem)return Buffer.alloc(0);
  if(gem.dual){
    const dual=validateDual(gem.id,gem.dual);
    return nested(2,Buffer.concat([scalar(1,dual.ids[0]),scalar(2,0),
      scalar(3,dual.ids[1]),scalar(4,dual.percent/10)]));
  }
  const normal=Buffer.concat([scalar(1,gem.id),scalar(2,0)]);
  return nested(1,normal);
}
function panMessage(plan){
  const grids=plan.map(grid=>nested(1,Buffer.concat(grid.map(gem=>nested(1,gemMessage(gem))))));
  return Buffer.concat([...grids,nested(2,Buffer.alloc(0))]);
}
function planMessage(plan,id){
  return nested(2,Buffer.concat([scalar(1,id),nested(2,panMessage(plan))]));
}
function boardPayload(state,selected=null){
  const ids=selected===null?[0,1,2]:[selected];
  const body=Buffer.concat([...ids.map(id=>planMessage(state.plans[id],id)),scalar(3,state.activePlan)]);
  return nested(18,body);
}
// RetPanInfo populates the editor. PanChanged populates the per-player cache
// used by all six equipment tooltips (client bcbfc4..bcc069).
function actorPayload(state,playerId){
  return nested(18,nested(4,Buffer.concat([scalar(1,playerId),
    nested(2,panMessage(state.plans[state.activePlan]))])));
}
function resultPayload(operation,itemId){
  const body=Buffer.alloc(6);body[0]={insert:0,open:1,remove:2}[operation];
  body[1]=1;body.writeUInt16LE(itemId||0,4);return body;
}
function itemNotice(itemId,op){
  const body=Buffer.alloc(6);body.writeUInt16LE(0x0111,0);
  body.writeUInt16LE(itemId,2);body[4]=1;body[5]=op==='remove'?1:0;
  return body;
}
function parseRequest(operation,payload){
  if(!Buffer.isBuffer(payload)||payload.length!==(operation==='open'?3:5))return null;
  const plan=payload[0],grid=payload[1];
  if(plan>2||grid>5)return null;
  if(operation==='open')return {plan,grid,payment:payload[2]};
  const socket=payload[2];if(socket>3)return null;
  return {plan,grid,socket,extra:payload.readUInt16LE(3)};
}
function parsePanQuery(payload){
  if(!Buffer.isBuffer(payload)||payload.length<5||payload[0]!==0x92||payload[1]!==0x01)
    return null;
  function read(offset){
    let value=0,scale=1;
    for(let i=0;i<5&&offset+i<payload.length;i++){
      const byte=payload[offset+i];value+=(byte&127)*scale;
      if(!(byte&128))return {value,next:offset+i+1};
      scale*=128;
    }
    return null;
  }
  const length=read(2);
  // Older captures encode the selected plan as protobuf field 1 (0x08),
  // while the current client build uses field 3 (0x18).  Both carry the
  // same unsigned-varint plan index; keep the wire distinction at the edge.
  if(!length||length.next+length.value!==payload.length||
    ![0x08,0x18].includes(payload[length.next]))return null;
  const index=read(length.next+1);
  if(!index||index.next!==payload.length)return null;
  return index.value===0xffffffff?index.value:index.value<3?index.value:null;
}
function colors(id,dual){
  // A dual is an independent color. Its primary wire ID remains source one,
  // but its two attribute sources do not reserve their ordinary gem colors.
  const part=catalog.get(id);
  if(dual||part?.color===100)return new Set([100]);
  // Native color zero is prismatic, not an unclassified/empty color.
  return new Set(part&&part.color>=0&&part.color<=6?[part.color]:[]);
}
function colorConflict(grid,id,dual,except){
  const selected=colors(id,dual);
  return grid.some((entry,i)=>i!==except&&entry&&
    [...colors(entry.id,entry.dual)].some(color=>selected.has(color)));
}
function sameDual(a,b){
  if(!a||!b)return !a&&!b;
  return Array.isArray(a.ids)&&Array.isArray(b.ids)&&
    a.percent===b.percent&&a.quality===b.quality&&
    a.ids.length===2&&b.ids.length===2&&
    a.ids.every(id=>b.ids.includes(id));
}
function planChange(state,operation,request,inventory,{capacity=VISIBLE_CAPACITY,stackMax=1000,reserved=new Set(),wallet={}}={}){
  if(!validLimits(capacity)||!Number.isSafeInteger(stackMax)||stackMax<1||stackMax>65535)
    return {ok:false,reason:'invalid-capacity'};
  const input=parseRequest(operation==='remove-all'?'remove':operation,request);
  if(!input)return {ok:false,reason:'invalid-request'};
  const next=structuredClone(state),grid=next.plans[input.plan][input.grid];
  if(!grid)return {ok:false,reason:'invalid-grid'};
  const bag=new Map(inventory),attrs={...wallet};
  if(operation==='open'){
    if(grid.length>=4)return {ok:false,reason:'all-sockets-open'};
    const price=costs.get(grid.length+1);
    const attr=input.payment===3?50:input.payment===1?72:null;
    if(!price||!attr)return {ok:false,reason:'invalid-payment'};
    const amount=attr===50?price.gold:price.diamond;
    if(!Number.isSafeInteger(attrs[attr])||attrs[attr]<amount)
      return {ok:false,reason:'insufficient-currency'};
    attrs[attr]-=amount;grid.push(null);
    return {ok:true,operation,input,next,bag,attrs,cost:{attr,amount},itemId:0};
  }
  if(operation!=='remove-all'&&input.socket>=grid.length)return {ok:false,reason:'socket-locked'};
  if(operation==='insert'){
    if(input.extra>=capacity||reserved.has(input.extra))return {ok:false,reason:'invalid-input'};
    // Double-click insertion sends socket zero even after that socket is full.
    // The client expects the server to choose the next available open socket.
    if(grid[input.socket]){
      const nextEmpty=grid.findIndex(entry=>entry===null);
      if(nextEmpty<0)return {ok:false,reason:'socket-occupied'};
      input.socket=nextEmpty;
    }
    const item=bag.get(input.extra),gem=catalog.get(item?.itemId);
    if(!gem||!Number.isInteger(item.count)||item.count<1)return {ok:false,reason:'missing-gem'};
    try{validateGemDual(gem.id,item.dual);}catch{return {ok:false,reason:'invalid-dual-gem'};}
    if(colorConflict(grid,gem.id,item.dual,input.socket))return {ok:false,reason:'duplicate-color'};
    const guid=/^[a-f0-9]{16}$/i.test(item.guid||'')?item.guid:
      crypto.randomBytes(8).toString('hex');
    grid[input.socket]={id:gem.id,sourceSlot:input.extra,guid};
    if(item.dual)grid[input.socket].dual=structuredClone(item.dual);
    if(item.count===1)bag.delete(input.extra);
    else bag.set(input.extra,{...item,count:item.count-1});
    return {ok:true,operation,input,next,bag,attrs,itemId:gem.id,
      touched:[input.extra]};
  }
  const sockets=operation==='remove-all'?grid.flatMap((entry,index)=>entry?[index]:[]):[input.socket];
  if(!sockets.length||!grid[sockets[0]])return {ok:false,reason:'socket-empty'};
  const removed=[];
  for(const socket of sockets){
    const entry=grid[socket];
    let target=findStack(bag,capacity,stackMax,reserved,item=>item.itemId===entry.id&&sameDual(item.dual,entry.dual));
    if(target===undefined){
      const free=s=>!bag.has(s)&&!reserved.has(s);
      if(entry.sourceSlot>=0&&entry.sourceSlot<capacity&&free(entry.sourceSlot))target=entry.sourceSlot;
      else target=findFree(bag,capacity,reserved);
    }
    // Allocation occurs in the private plan. Failure returns neither a partly
    // cleared board nor a partly credited inventory to either live caller.
    if(target===undefined)return {ok:false,reason:'bag-full'};
    const prior=bag.get(target);
    bag.set(target,prior?{...prior,count:prior.count+1}:
      {itemId:entry.id,count:1,guid:entry.guid,
        ...(entry.dual?{dual:structuredClone(entry.dual)}:{})});
    grid[socket]=null;removed.push({socket,itemId:entry.id,target});
  }
  return {ok:true,operation:'remove',input,next,bag,attrs,itemId:removed[0].itemId,
    removed,all:operation==='remove-all',touched:[...new Set(removed.map(entry=>entry.target))]};
}
function bonuses(state,equipment){
  const out={};
  const plan=state.plans[state.activePlan];
  for(let board=0;board<6;board++){
    if(equipment && !equipment.has(board))continue;
    // Repeated true penetration is local to one equipped item's gem grid.
    // A gem on another item starts a fresh physical/magic penetration count.
    const seenPercent={108:0,109:0};
    for(const entry of plan[board]){
      if(!entry)continue;
      const parts=entry.dual?validateDual(entry.id,entry.dual).ids.map(id=>catalog.get(id)):
        [catalog.get(entry.id)];
      const socketBonus={};
      for(const gem of parts){
        const ids=ATTRIBUTE_IDS[gem.attribute];
        if(!ids||!gem.value)continue;
        const value=entry.dual?Math.floor(gem.value*entry.dual.percent/100):gem.value;
        for(const id of ids)socketBonus[id]=(socketBonus[id]||0)+value;
      }
      for(const [key,bonus] of Object.entries(socketBonus)){
        const id=+key;
        let value=bonus;
        if(id===108||id===109){
          if(seenPercent[id]++)value=entry.dual?Math.floor(value/2):Math.round(value/2);
        }
        out[id]=(out[id]||0)+value;
      }
    }
  }
  return out;
}
// These native gem names have no verified 1045 IDs. Their actual combat effects
// remain separate rather than using fabricated numeric IDs in client packets.
function combatEffects(state,equipment){
  const out={CriticalResistance:0,CriticalDamageReduction:0};
  for(const [board,grid] of state.plans[state.activePlan].entries()){
    if(equipment&&!equipment.has(board))continue;
    for(const entry of grid){
      if(!entry)continue;
      const parts=entry.dual?validateDual(entry.id,entry.dual).ids:[entry.id];
      for(const id of parts){
        const gem=catalog.get(id);
        if(gem&&Object.hasOwn(out,gem.attribute))
          out[gem.attribute]+=entry.dual?Math.floor(gem.value*entry.dual.percent/100):gem.value;
      }
    }
  }
  return out;
}
module.exports={GemBoard,catalog,costs,initial,validate,validateDual,boardPayload,actorPayload,resultPayload,
  itemNotice,parseRequest,parsePanQuery,planChange,bonuses,combatEffects,ATTRIBUTE_IDS};
