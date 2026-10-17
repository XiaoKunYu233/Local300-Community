'use strict';
// Accept only an exact single-skin duration description and an unambiguous
// matching permanent skin row. Pool/gift prose and ambiguous names are not rules.
const clean=s=>String(s||'').replace(/<color=[^>]*>/gi,'').replace(/\\n/g,'').trim();
function resolve(item,rows){
  if(item?.[10]!=='restore')return null;
  const name=clean(item[23]),match=/^(皮肤\s+.+[）)])\s*([1-9]\d*)天$/.exec(name);
  if(!match||clean(item[24])!==name)return null;
  const days=Number(match[2]);if(!Number.isSafeInteger(days)||days>3650)return null;
  const candidates=rows.filter(r=>r[10]==='skin'&&clean(r[23])===match[1]);
  const identities=new Set(candidates.map(r=>`${r[51]}:${r[52]}`));
  if(identities.size!==1)return null;
  const hero=candidates[0][51],index=candidates[0][52];
  if(!Number.isInteger(hero)||hero<1||hero>=65535||!Number.isInteger(index)||index<1||index>31)return null;
  return {kind:'skins',itemId:hero*128+index,hero,index,durationMs:days*86400000};
}
module.exports={resolve};
