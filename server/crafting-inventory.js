'use strict';
// Resource counters and material counters can mirror bag records. Use the
// same authoritative-container precedence as magic-device-live, never add them.
function balances(bag, materials, resources) {
  const out={};
  for(const item of bag.values())out[item.itemId]=(out[item.itemId]||0)+Number(item.count||0);
  for(const [id,count] of materials)out[id]=Number(count);
  for(const [id,count] of Object.entries(resources))out[id]=Number(count);
  return out;
}
function debit({bag,materials,resources,wallet},costs={},walletCosts={}) {
  const inventory=new Map([...bag].map(([slot,item])=>[slot,{...item}])),mat=new Map(materials),res={...resources},money={...wallet};
  const held=balances(bag,materials,resources),changedSlots=[],changedMaterials=[],changedResources=[];
  for(const [key,amount] of Object.entries(costs)) {
    const id=Number(key);
    if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(held[id])||held[id]<amount)return {ok:false,reason:'materials-insufficient'};
    if(!amount)continue;
    if(res[id]!==undefined){res[id]-=amount;changedResources.push(id);}
    else if(mat.has(id)){mat.set(id,mat.get(id)-amount);changedMaterials.push(id);}
    else {
      let left=amount;
      for(const [slot,item] of inventory)if(item.itemId===id&&left) {
        const used=Math.min(left,item.count);item.count-=used;left-=used;
        if(!item.count)inventory.delete(slot);changedSlots.push(slot);
      }
    }
  }
  for(const [kind,amount] of Object.entries(walletCosts)) {
    const id={gold:50,diamond:72}[kind];
    if(!id||!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(money[id])||money[id]<amount)return {ok:false,reason:'wallet-insufficient'};
    money[id]-=amount;
  }
  return {ok:true,bag:inventory,materials:mat,resources:res,wallet:money,changedSlots,changedMaterials,changedResources};
}
module.exports={balances,debit};
