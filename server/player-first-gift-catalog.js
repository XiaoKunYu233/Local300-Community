'use strict';
// Native f3be60 selects these ten string keys; f3bf88 splits ':' and
// f3c067 splits ';', then reads item ID and count into SetFirstPayItemList_PlayerVIP.
// This is the client display catalog, not proof of server grant eligibility.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const TIERS=Object.freeze([10,50,100,300,500,1000,2000,3000,5000,10000]);
function parse(rows){
  if(!Array.isArray(rows))throw Error('Invalid first gift catalog');
  return TIERS.map(amount=>{
    const key=`eClient_FirstPay${amount}_Award`,matches=rows.filter(row=>row['1']===key);
    if(matches.length!==1||typeof matches[0]['2']!=='string')throw Error('Missing or duplicate first gift tier '+key);
    const seen=new Set(),items=matches[0]['2'].split(':').map(pair=>{
      if(!/^[1-9][0-9]*;[1-9][0-9]*$/.test(pair))throw Error('Invalid first gift item pair');
      const [itemId,count]=pair.split(';').map(Number);
      if(!Number.isSafeInteger(itemId)||itemId>0xffffffff||!Number.isSafeInteger(count)||count>0xffffffff||seen.has(itemId))throw Error('Invalid or duplicate first gift item');
      seen.add(itemId);return {itemId,count};
    });
    return {amountMinor:amount*100,key,items};
  });
}
function load(){
  const bytes=fs.readFileSync(path.join(__dirname,'logs/cfg/string_client.json'));
  return {sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),tiers:parse(JSON.parse(bytes))};
}
function displayTier(catalog,observation){
  if(!observation||!['claimed','unavailable','claimable'].includes(observation.status))throw Error('Invalid first gift display status');
  if(observation.status!=='claimable')return null;
  const amount=observation.amountMinor;
  if(!Number.isInteger(amount)||amount<=0||amount>=0xffffffff)throw Error('Invalid first gift display amount');
  const tier=catalog.tiers.findLast(t=>t.amountMinor<=amount);
  return tier?structuredClone(tier):null;
}
function deliveryItems(tier){
  if(!tier||!Array.isArray(tier.items)||!tier.items.length)throw Error('Missing first gift reward tier');
  const {classifyItem}=require('./item-containers');
  return tier.items.map(item=>{
    if(!Number.isSafeInteger(item.itemId)||item.itemId<=0||item.itemId>=65535||!Number.isSafeInteger(item.count)||item.count<=0||item.count>0xffffffff)throw Error('Invalid first gift reward');
    const storage=classifyItem(item.itemId);
    if(!['slot','material','resource'].includes(storage.container))throw Error('Unverified first gift reward destination: '+item.itemId);
    // Keep item 346 as an item, and skin gift boxes unopened. Catalog labels
    // are not a currency conversion or a permanent unlock instruction.
    return {...item,container:storage.container,evidence:storage.evidence};
  });
}
module.exports={parse,load,displayTier,deliveryItems,TIERS};
