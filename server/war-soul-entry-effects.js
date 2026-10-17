'use strict';

// Pure projection of the installed WarSoulEntry catalog (succinct 1..160).
// No account reads/writes, clocks, random rolls, damage or buff application.
//
// aggregate(heroOrEntries) accepts hero.warSoulEffects or the descriptor array
// returned by war-soul-entry.effects(). Each descriptor must identify an exact
// installed succinctId, statusId and soulValue. Unknown node effects and altered
// descriptors are rejected instead of being interpreted as WarSoulEntry rules.
//
// The result has elements[element].regular[kind], .core and
// .distinctRegularCount. Regular kinds are 1 (increase), 6 (reduction), 11
// (proc), 12 (heal), 13 (offense), 14 (defense) and 15 (barrier). values starts
// with the summed level, followed by summed catalog parameters; count and
// succinctIds retain the number and IDs of contributing entries. Cores use
// kind 20, the highest constituent level, a threshold and an eligible flag;
// their values/parameters are never added together. effects contains regular
// effects and eligible cores; cores also includes the selected inactive cores.
//
// Element names follow actual channels: wind 32/45, forest 33/46, fire 34/47,
// mountain 35/48. The old fire/frost/light/dark labels are available only with
// {convention:'legacy'} because legacy fire means wind. In native mode fire
// always means actual fire; unambiguous frost/light/dark aliases are accepted.
// Entry damage increase/reduction follows the user's confirmed global rule:
// add all four percentages and divide by four, then apply to all damage once.
// An element tag only identifies stage channels; it never changes that entry
// multiplier. This module never assigns an element to ordinary damage.

const ELEMENTS=Object.freeze(['wind','forest','fire','mountain']);
const CHANNELS=Object.freeze(Object.fromEntries(ELEMENTS.map((element,index)=>[
  element,Object.freeze({element,restraint:32+index,resistance:45+index})
])));
const NATIVE_ALIASES=Object.freeze({wind:'wind',forest:'forest',fire:'fire',mountain:'mountain',
  frost:'forest',light:'fire',dark:'mountain'});
const LEGACY_ALIASES=Object.freeze({fire:'wind',frost:'forest',light:'fire',dark:'mountain',
  wind:'wind',forest:'forest',mountain:'mountain'});
const REGULAR_NAMES=Object.freeze({1:'damageIncrease',6:'damageReduction',11:'proc',
  12:'heal',13:'offense',14:'defense',15:'barrier'});
const CORE_RULES=Object.freeze({
  wind:Object.freeze({coreKind:'speed',parameters:Object.freeze({speedPercent:35,duration:2})}),
  forest:Object.freeze({coreKind:'healing',parameters:Object.freeze({healingPercent:50,nonStacking:true})}),
  fire:Object.freeze({coreKind:'grievous',parameters:Object.freeze({healingReductionPercent:50,duration:3})}),
  mountain:Object.freeze({coreKind:'rock',parameters:Object.freeze({damageThresholdPercent:25,damageReductionPercent:80,cooldown:3})}),
});
const catalog=new Map();
for(const row of require('./logs/cfg/warsoulsuccinct.json')){
  const id=Number(row[1]),statusId=Number(row[3]),prefix=Math.floor(statusId/100),tail=statusId%100;
  if(!Number.isInteger(id)||id<1||id>160||prefix<360||prefix>363)continue;
  const core=tail>=16&&tail<=20,kind=core?20:tail;
  if(!core&&!Object.hasOwn(REGULAR_NAMES,kind))continue;
  const values=String(row[9]).split(';').map(Number);
  if(!values.every(Number.isSafeInteger)||values[0]<1||values[0]>5)continue;
  catalog.set(id,{id,statusId,element:ELEMENTS[prefix-360],kind,core,values,
    type:Number(row[8]),warSoulId:Number(row[2]),text:String(row[4])});
}
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function integer(value){
  if(typeof value==='number')return Number.isSafeInteger(value)?value:null;
  if(typeof value==='string'&&/^[1-9][0-9]*$/.test(value)){
    const n=Number(value);return Number.isSafeInteger(n)?n:null;
  }
  return null;
}
function normalizeElement(element,options){
  const convention=options===undefined||options===null?'native':object(options)?options.convention??'native':null;
  if(typeof element!=='string'||!['native','legacy'].includes(convention))return null;
  const tag=element.trim().toLowerCase(),aliases=convention==='legacy'?LEGACY_ALIASES:NATIVE_ALIASES;
  return own(aliases,tag)?aliases[tag]:null;
}
function channels(element,options){
  const normalized=normalizeElement(element,options);return normalized?CHANNELS[normalized]:null;
}
function descriptor(entry){
  if(!object(entry))return null;
  const id=integer(entry.succinctId),statusId=integer(entry.statusId),row=catalog.get(id);
  if(!row||statusId!==row.statusId||typeof entry.soulValue!=='string')return null;
  const raw=entry.soulValue.trim();
  if(!/^[0-9]+(?:;[0-9]+)*$/.test(raw))return null;
  const values=raw.split(';').map(Number);
  if(values.length!==row.values.length||values.some((n,index)=>!Number.isSafeInteger(n)||n!==row.values[index]))return null;
  if(own(entry,'type')&&integer(entry.type)!==row.type||own(entry,'warSoulId')&&integer(entry.warSoulId)!==row.warSoulId)return null;
  return {succinctId:id,statusId,element:row.element,kind:row.kind,name:row.core?'core':REGULAR_NAMES[row.kind],
    core:row.core,level:values[0],values,type:row.type,warSoulId:row.warSoulId,text:row.text};
}
function aggregate(source){
  const input=Array.isArray(source)?source:Array.isArray(source?.warSoulEffects)?source.warSoulEffects:[];
  const elements=Object.fromEntries(ELEMENTS.map(element=>[element,{element,regular:{},core:null,distinctRegularCount:0}]));
  const entries=[],effects=[],cores=[];let rejectedCount=0;
  for(const inputEntry of input){
    const entry=descriptor(inputEntry);if(!entry){rejectedCount++;continue;}entries.push(entry);
    const group=elements[entry.element];
    if(entry.core){
      const prior=group.core,selected=!prior||entry.level>prior.level?entry:prior;
      // The selected descriptor is independent of the number of duplicate
      // core records. Preserve counts for diagnostics, never for arithmetic.
      group.core={...selected,values:[...selected.values],count:(prior?.count||0)+1,
        succinctIds:[...(prior?.succinctIds||[]),entry.succinctId]};
    }else{
      const prior=group.regular[entry.kind];
      if(prior){
        prior.level+=entry.level;prior.count++;
        prior.values=prior.values.map((n,index)=>n+entry.values[index]);
        prior.succinctIds.push(entry.succinctId);
      }else group.regular[entry.kind]={...entry,values:[...entry.values],count:1,succinctIds:[entry.succinctId]};
    }
  }
  for(const element of ELEMENTS){
    const group=elements[element];group.distinctRegularCount=Object.keys(group.regular).length;
    effects.push(...Object.values(group.regular));
    if(group.core){
      const rule=CORE_RULES[element];Object.assign(group.core,{threshold:group.core.values[1],
        distinctRegularCount:group.distinctRegularCount,eligible:group.distinctRegularCount>=group.core.values[1],
        coreKind:rule.coreKind,parameters:{...rule.parameters}});
      cores.push(group.core);if(group.core.eligible)effects.push(group.core);
    }
  }
  return {version:1,elements,effects,cores,entries,rejectedCount};
}
function modelFor(source){
  return object(source)&&source.version===1&&object(source.elements)&&Array.isArray(source.effects)&&Array.isArray(source.cores)
    ?source:aggregate(source);
}
function getEffect(source,element,kind,options){
  const normalized=normalizeElement(element,options);if(!normalized)return null;
  const group=modelFor(source).elements[normalized];if(!object(group))return null;
  if(kind===20||kind==='core')return group.core||null;
  return own(REGULAR_NAMES,kind)&&object(group.regular)&&own(group.regular,kind)?group.regular[kind]:null;
}
function positive(value){
  if(typeof value!=='number'&&typeof value!=='string')return 0;
  const n=Number(value);return Number.isFinite(n)?Math.max(0,n):0;
}
// The two matching stage channels are a separate combat profile. Do not fall
// back to average values, or map these IDs into ordinary character attributes.
function total(source,element,options){
  const channel=channels(element,options);if(!channel)return 0;
  const profile=object(source?.warSoul)?source.warSoul:source;
  return positive(profile?.restraint?.[channel.restraint])+positive(profile?.resistance?.[channel.resistance]);
}
function damageFactors(attacker,target,element,options){
  const normalized=normalizeElement(element,options);
  return {...aggregateAllDamageFactors(attacker,target),element:normalized};
}
// Both averages always divide by four, including absent elements. These entry
// percentages are global modifiers, separate from any stage-channel multiplier.
// Reduction is bounded at 100% so stacked entries cannot invert damage/heal.
function aggregateAllDamageFactors(attacker,target){
  const sum=(source,kind)=>{
    const model=modelFor(source),n=ELEMENTS.reduce((value,element)=>
      value+positive(getEffect(model,element,kind)?.values?.[1]),0);
    return Number.isFinite(n)?n:0;
  };
  const bonusTotalPercent=sum(attacker,1),reductionTotalPercent=sum(target,6),
    bonusPercent=bonusTotalPercent/4,reductionPercent=Math.min(100,reductionTotalPercent/4);
  return {element:null,bonusTotalPercent,reductionTotalPercent,bonusPercent,reductionPercent,
    multiplier:(1+bonusPercent/100)*(1-reductionPercent/100)};
}
function damageMultiplier(attacker,target,element,options){return damageFactors(attacker,target,element,options).multiplier;}
module.exports={ELEMENTS,aggregate,normalizeElement,channels,total,getEffect,aggregateAllDamageFactors,damageFactors,damageMultiplier};
