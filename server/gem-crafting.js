'use strict';
const crypto=require('crypto');
const {VISIBLE_CAPACITY,validLimits,findStack,findFree}=require('./inventory-capacity');
const {catalog,validateDual}=require('./gem-board');
const {loadConfig}=require('./runtime/catalogs');
const rows=new Map(loadConfig('gems').data.map(r=>[+r[1],r]));
const costRows=new Map(loadConfig('gem-costs').data.map(r=>[+r[1],r]));
const randomInt=maximum=>crypto.randomInt(maximum);
const signature=item=>JSON.stringify([item.itemId,item.dual?
  [[...item.dual.ids].sort((a,b)=>a-b),item.dual.percent,item.dual.quality]:null]);
const pool=level=>[...catalog.values()].filter(g=>g.level===level&&g.type===0&&
  g.color>=1&&g.color<=6&&g.id>=41000&&g.id<41400);
function randomCategory(gem){
  if(['PhysicsAttackPercent','MagicAttackPercent'].includes(gem.attribute))return 'white';
  return gem.color>=1&&gem.color<=4?'ordinary':gem.color===5?'purple':gem.color===6?'white':null;
}
function randomPools(level){const result={ordinary:[],purple:[],white:[]};for(const gem of pool(level))result[randomCategory(gem)].push(gem);return result;}
function drawBelow(maximum,rng){const value=rng(maximum);if(!Number.isInteger(value)||value<0||value>=maximum)throw Error('invalid-random-draw');return value;}
function randomGem(level,rng=randomInt){
  const groups=randomPools(level),roll=drawBelow(100,rng),group=groups[roll<90?'ordinary':roll<95?'purple':'white'];
  if(!group.length)throw Error('missing-random-gem-pool');
  return group[drawBelow(group.length,rng)];
}
function nextGem(id){
  const next=+rows.get(id)?.[6];
  return next&&catalog.get(next)?.level===catalog.get(id)?.level+1?next:null;
}
function parseRequest(msgid,payload){
  if(msgid===13562){
    if(payload.length!==9)return null;
    return {operation:'decompose',guid:payload.subarray(0,8).toString('hex')};
  }
  if(msgid!==13537||payload.length!==46)return null;
  const inputs=[];
  for(let i=0;i<5;i++){
    const token=payload.readUInt32LE(i*8),count=payload.readUInt32LE(i*8+4);
    if(token!==0&&token!==0xffffffff&&count)inputs.push({token,count});
  }
  return {operation:inputs.reduce((sum,x)=>sum+x.count,0)===2?'fuse':'compose',
    inputs,payment:payload[40],cardToken:payload.readUInt32LE(41),option:payload[45]};
}
function qualityRoll(rng=randomInt){
  const value=rng(10000);
  const quality=value<7500?0:value<9500?1:value<9999?2:3;
  // The client stores tenths: 5 normal, 6/7 fine, 8/9 high, 10 perfect.
  const percent=quality===0?50:quality===1?60+rng(2)*10:quality===2?80+rng(2)*10:100;
  return {quality,percent};
}
function fusionCard(itemId){
  if(!Number.isInteger(itemId)||itemId<7520||itemId>7529)return null;
  return {level:4+Math.floor((itemId-7520)/2),quality:(itemId-7520)%2===0?2:3};
}
function composeSuccessChance(level,count){
  // Three inputs always have the user-confirmed50 percent chance, including
  // levels5..7. The existing four-input high-level rule belongs only to4.
  if(count===3)return 50;
  if(count===4)return level>=5?100:75;
  return count===5?100:null;
}
function patchRecord(record,item){
  if(!catalog.has(item?.itemId)||!Buffer.isBuffer(record)||record.length<33)return;
  if(item.dual){
    validateDual(item.itemId,item.dual);
    if(item.dual.percent%10)throw Error('client gem ratio must use tenths');
    record.writeUInt16LE(item.dual.ids[0],0);
    record[29]=2;record.writeUInt16LE(item.dual.ids[1],30);record[32]=item.dual.percent/10;
  }else record.fill(0,29,33);
}
function operationPrice(operation,level,currency=50){
  // The native compose/fuse confirmation uses the same uComposeCostMoney.
  // Decomposition sends its GUID immediately with no currency confirmation.
  if(operation==='decompose')return 0;
  return +costRows.get(level)?.[currency===72?3:2];
}
function resolveInputs(request,inventory,{capacity=VISIBLE_CAPACITY,reserved=new Set()}={}){
  if(!validLimits(capacity))return null;
  if(request.operation==='decompose'){
    const found=[...inventory].find(([s,item])=>Number.isInteger(s)&&s>=0&&s<capacity&&!reserved.has(s)&&
      item.guid?.toLowerCase()===request.guid);
    return found?[{slot:found[0],count:1}]:null;
  }
  const wanted=new Map();
  for(const {token,count} of request.inputs){
    if(!catalog.has(token)||!Number.isInteger(count)||count<1||count>5)return null;
    wanted.set(token,(wanted.get(token)||0)+count);
  }
  if([...wanted.values()].reduce((a,b)=>a+b,0)>5)return null;
  const result=[];
  for(const [id,count] of wanted){
    let remaining=count;
    for(const [slot,item] of inventory){
      // Native material selection excludes the dual union. Its primary ID is
      // identical to a single gem's ID, so never consume those by an ID token.
      if(!Number.isInteger(slot)||slot<0||slot>=capacity||reserved.has(slot)||item.itemId!==id||item.dual)continue;
      const quantity=Math.min(remaining,item.count);
      if(quantity>0){result.push({slot,count:quantity});remaining-=quantity;}
      if(!remaining)break;
    }
    if(remaining)return null;
  }
  return result.length?result:null;
}
function plan(operation,inputs,inventory,{capacity=VISIBLE_CAPACITY,stackMax=1000,reserved=new Set(),wallet={},resources={},
  price=0,currency=50,card=null,cardGrade=null,rng=randomInt,guid=()=>crypto.randomBytes(8).toString('hex')}={}){
  const reject=reason=>({ok:false,reason});
  if(!validLimits(capacity)||!Number.isSafeInteger(stackMax)||stackMax<1||stackMax>65535)
    return reject('invalid-capacity');
  if(!['compose','decompose','fuse'].includes(operation)||!Array.isArray(inputs)||!inputs.length)
    return reject('invalid-request');
  const quantities=new Map();
  for(const input of inputs){
    if(!Number.isInteger(input.slot)||input.slot<0||input.slot>=capacity||
      !Number.isSafeInteger(input.count)||input.count<1||input.count>5||reserved.has(input.slot))
      return reject('invalid-input');
    quantities.set(input.slot,(quantities.get(input.slot)||0)+input.count);
  }
  const selected=[];
  for(const [slot,count] of quantities){
    const item=inventory.get(slot),gem=catalog.get(item?.itemId);
    if(!gem||!Number.isInteger(item.count)||item.count<count)return reject('missing-gem');
    if(item.dual||gem.color===100){try{validateDual(gem.id,item.dual);}catch{return reject('invalid-dual-gem');}}
    for(let i=0;i<count;i++)selected.push({slot,item,gem});
  }
  const count=selected.length,level=selected[0].gem.level;
  if(selected.some(x=>x.gem.level!==level))return reject('different-levels');
  if(operation==='compose'&&(count<3||count>5))return reject('invalid-compose-count');
  if(operation==='compose'&&selected.some(x=>x.item.dual))return reject('dual-compose-unsupported');
  if(operation==='decompose'&&(count!==1||level<=1))return reject('invalid-decompose-level');
  if(operation==='compose'&&level>=8)return reject('max-level');
  if(operation==='fuse'){
    if(count!==2||level<4||selected.some(x=>x.item.dual||x.gem.color===0||x.gem.color===100))
      return reject('invalid-fusion-input');
    if(selected[0].gem.attribute===selected[1].gem.attribute)
      return reject('same-fusion-attribute');
  }
  if(card!==null){
    const rule=fusionCard(card.itemId);
    if(operation!=='fuse'||!rule||rule.level!==level||
      (cardGrade!==null&&cardGrade!==rule.quality))return reject('invalid-fusion-card');
    cardGrade=rule.quality;
    if(card.source==='resource'){
      if(!Number.isSafeInteger(resources[card.itemId])||resources[card.itemId]<1)
        return reject('invalid-fusion-card');
    }else if(!Number.isInteger(card.slot)||card.slot<0||card.slot>=capacity||reserved.has(card.slot)||
      !inventory.get(card.slot)||inventory.get(card.slot).itemId!==card.itemId||
      !Number.isInteger(inventory.get(card.slot).count)||inventory.get(card.slot).count<1||
      quantities.has(card.slot))return reject('invalid-fusion-card');
  }
  if(![50,72].includes(currency)||!Number.isSafeInteger(price)||price<0||
    !Number.isSafeInteger(wallet[currency])||wallet[currency]<price)
    return reject('insufficient-currency');
  // Plan on copies. A full bag or malformed output never destroys materials.
  const bag=new Map(inventory),attrs={...wallet},nextResources={...resources},touched=new Set(quantities.keys());
  const consume=(slot,quantity)=>{
    const item=bag.get(slot);
    if(item.count===quantity)bag.delete(slot);else bag.set(slot,{...item,count:item.count-quantity});
    touched.add(slot);
  };
  for(const [slot,quantity] of quantities)consume(slot,quantity);
  if(card?.source==='resource')nextResources[card.itemId]-=1;
  else if(card!==null)consume(card.slot,1);
  attrs[currency]-=price;
  const stackFor=output=>findStack(bag,capacity,stackMax,reserved,item=>signature(item)===signature(output));
  let composeCandidates;
  if(operation==='compose'){
    const identical=selected.every(x=>signature(x.item)===signature(selected[0].item));
    const next=identical&&selected[0].gem.color!==0?nextGem(selected[0].gem.id):null;
    composeCandidates=next?[{itemId:next,count:1}]:pool(level+1).map(g=>({itemId:g.id,count:1}));
    if(!composeCandidates.length)return reject('missing-next-level');
    // Check successful delivery before drawing success/failure. A rejected
    // full-bag attempt must not become a paid failure or reroll mixed outputs.
    if(findFree(bag,capacity,reserved)===undefined&&
      composeCandidates.some(output=>stackFor(output)===undefined))return reject('bag-full');
  }
  let success=true,outputs=[],successChance=null,successRoll=null;
  if(operation==='compose'){
    successChance=composeSuccessChance(level,count);successRoll=rng(100);
    if(!Number.isInteger(successRoll)||successRoll<0||successRoll>=100)return reject('invalid-random-draw');
    success=successRoll<successChance;
    if(success){
      try{outputs=[composeCandidates.length===1?composeCandidates[0]:{itemId:randomGem(level+1,rng).id,count:1}];}
      catch(error){return reject(error.message);}
    }
  }else if(operation==='decompose'){
    const candidates=pool(level-1);
    if(!candidates.length)return reject('missing-lower-level');
    try{const quantity=2+drawBelow(4,rng);outputs=Array.from({length:quantity},()=>({itemId:randomGem(level-1,rng).id,count:1}));}
    catch(error){return reject(error.message);}
  }else{
    const grade=card===null?qualityRoll(rng):{quality:cardGrade,
      percent:cardGrade===0?50:cardGrade===1?60+rng(2)*10:cardGrade===2?80+rng(2)*10:100};
    outputs=[{itemId:selected[0].gem.id,count:1,
      dual:{ids:selected.map(x=>x.gem.id),...grade}}];
  }
  const placements=[];
  for(const output of outputs){
    if(output.dual||catalog.get(output.itemId)?.color===100){
      try{validateDual(output.itemId,output.dual);}catch{return reject('invalid-dual-gem');}
    }
    let slot=stackFor(output);
    if(slot===undefined)slot=findFree(bag,capacity,reserved);
    if(slot===undefined)return reject('bag-full');
    const held=bag.get(slot);
    bag.set(slot,held?{...held,count:held.count+1}:{...output,guid:guid()});
    touched.add(slot);placements.push({slot,...output});
  }
  return {ok:true,operation,success,successChance,successRoll,level,count,bag,attrs,price,currency,
    resources:nextResources,touched:[...touched],outputs,placements};
}
module.exports={parseRequest,resolveInputs,operationPrice,patchRecord,plan,qualityRoll,
  fusionCard,composeSuccessChance,pool,randomCategory,randomPools,randomGem,nextGem,costRows,signature};
