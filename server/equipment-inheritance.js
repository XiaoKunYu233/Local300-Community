'use strict';
const {cleanGuid}=require('./equipment-crafting');
const {rules:soulRules}=require('./equipment-soul');
const armour=new Map(require('../data/current-client/item_armour.json').map(r=>[r[1],r]));
const fields={15:2,18:6,10:3,31:5,50:7,90:19,38:11,39:12,42:15,43:16,3:14,2:4,89:13,83:17,84:18,87:25,88:26,85:27,86:28,4:9};
const nongrowing=new Set([10,90,3,2,89,83,84,85,86,4]);
// Native c20bcd obtains globalconfig 10050 and splits ';' then ':'.
const directedPairs=new Set(String(require('./logs/cfg/globalconfig.json').find(r=>r[1]===10050)?.[3]||'').split(';').filter(pair=>/^\d+:\d+$/.test(pair)));
const clone=v=>structuredClone(v);
function prepare({source,target,mask,inheritType=1,materials={},directedPairs:allowedPairs=directedPairs}) {
  const fail=reason=>({ok:false,reason});
  let a,b;try{a=cleanGuid(source?.guid);b=cleanGuid(target?.guid);}catch{return fail('invalid-equipment-guid');}
  if(a===b||!armour.has(source.itemId)||!armour.has(target.itemId))return fail('invalid-inherit-equipment');
  // Native 14c1e39/14c2053/14c20d3: directed selection hidden, mask=0
  // implicitly transfers enhancement, existing engraving, and compatible soul.
  // Forging remains opt-in (14c1f85). Engraving is still unsupported here.
  if(inheritType===2&&mask===0)mask=1|(source.warSoul?.length?4:0)|
    (soulRules.has(source.itemId)&&soulRules.has(target.itemId)?8:0);
  if(!Number.isInteger(mask)||mask<1||mask>15||![1,2].includes(inheritType))return fail('invalid-inherit-selection');
  if(source.locked||target.locked||source.hasGems||((mask&1)&&target.hasGems))return fail('inherit-locked-or-socketed');
  if(source.pending||target.pending)return fail('inherit-pending-candidate');
  if(inheritType===2&&!allowedPairs.has(`${source.itemId}:${target.itemId}`))return fail('invalid-directed-inherit-pair');
  const costs=inheritType===1?{7899:1}:{};
  if(inheritType===1&&Number(materials[7899]||0)<1)return fail('materials-insufficient');
  if(!Number.isInteger(source.blessing)||source.blessing<0||![source.level,target.level].every(v=>Number.isInteger(v)&&v>=0&&v<=17))return fail('inherit-enhancement-unavailable');
  if(mask&1) {
    if(!Number.isInteger(source.level)||!Number.isInteger(target.level)||source.level<target.level)return fail('inherit-level-too-low');
    if(typeof source.baselineHex!=='string'||!/^[0-9a-f]{84}$/.test(source.baselineHex))return fail('inherit-reforge-unavailable');
  }
  if((mask&4)&&!Array.isArray(source.warSoul))return fail('equipment-war-soul-schema-unconfirmed');
  const s={...clone(source),guid:a},t={...clone(target),guid:b};
  // Luck is transferred on every successful inheritance, independently of
  // the selected property checkboxes (client help, point 4).
  t.blessing=s.blessing;s.blessing=0;
  if(mask&1){t.level=s.level;t.baselineHex=s.baselineHex;s.level=0;s.baselineHex='00'.repeat(42);}
  if(mask&2) {
    if(inheritType===2&&!s.forge?.length)return fail('inherit-no-source-forge');
    // An un-forged source does not erase the target's forging.
    if(s.forge?.length) {
      const row=armour.get(t.itemId);
      t.forge=clone(s.forge).filter(attr=>!nongrowing.has(attr.id)||Number(row[fields[attr.id]]||0)>0);
      s.forge=null;
    }
  }
  if(mask&4){t.warSoul=clone(s.warSoul);s.warSoul=[];}
  if(mask&8) {
    const sr=soulRules.get(s.itemId),tr=soulRules.get(t.itemId);
    if(!sr||!tr)return fail('inherit-not-soul-equipment');
    const old=s.soul||{current:0,maximum:0};
    if(!Number.isInteger(old.current)||!Number.isInteger(old.maximum)||old.current<0||old.current>old.maximum||old.maximum>sr.cap)return fail('invalid-source-soul');
    t.soul={itemId:t.itemId,current:Math.floor(old.current*tr.cap/sr.cap),maximum:Math.floor(old.maximum*tr.cap/sr.cap)};
    s.soul={itemId:s.itemId,current:0,maximum:0};
  }
  return {ok:true,source:s,target:t,costs,mask,inheritType};
}
// Native be4149 passes the final u32 + 1 to ReqGetInheritClientData:
// this is the zero-based inheritance mode, NOT a target bag slot.
function ack(result,sourceGuid,targetGuid,inheritType=1){
  const p=Buffer.alloc(21);p[0]=result;
  Buffer.from(sourceGuid,'hex').copy(p,1);Buffer.from(targetGuid,'hex').copy(p,9);p.writeUInt32LE(inheritType-1,17);
  return require('./bag').mkFrame(13579,p,{flags:2});
}
module.exports={prepare,ack,fields,nongrowing,directedPairs};
