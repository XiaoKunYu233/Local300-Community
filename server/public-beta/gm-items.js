'use strict';
const catalog=require('../current-item-catalog').load(),containers=require('../item-containers');
const current=require('../runtime/catalogs').loadConfig('current-items');
const rows=new Map(current.data.map(row=>[row[1],row]));
const EXPERIENCE=Object.freeze({33843:6666,33916:10000,39806:100,39807:200,39808:500,39809:1000,39810:2000});
function experience(itemId){
 const amount=EXPERIENCE[itemId];if(!amount)return null;
 const row=rows.get(itemId),description=String(row?.[24]||'').replace(/<[^>]*>/g,'').trim();
 if(row?.[10]!=='restore'||description!==`使用后获得${amount}经验`)throw Error('Experience item differs from verified client description');
 return {itemId,amount,catalogSha256:current.sha256,policy:'development-next-level-threshold-carry-v1'};
}
function classify(itemId){
 const item=catalog.byId[itemId];
 if(!Number.isInteger(itemId)||itemId<1||itemId>=65535||item?.catalogSource!=='current-client')throw Error('道具不在当前客户端道具表中');
 const container=containers.containerOf(itemId);
 if(!['slot','material','resource'].includes(container))throw Error(['hero','skin'].includes(item.type)?'英雄和皮肤请发送原生解锁礼包，再由玩家在背包使用':'该道具的领取容器尚未支持');
 return {itemId,name:item.name,type:item.type,container,experience:experience(itemId),catalogSha256:current.sha256};
}
function attachments(input){
 if(!Array.isArray(input)||input.length<1||input.length>8)throw Error('每封邮件需要1–8项附件');
 const result=[];
 for(const entry of input){
  if(!entry||Object.keys(entry).sort().join('|')!=='count|itemId'||!Number.isInteger(entry.count)||entry.count<1||entry.count>1000)throw Error('附件数量须为1–1000的整数');
  const item=classify(entry.itemId),maximum=item.container==='slot'?255:1000;
  for(let left=entry.count;left>0;left-=maximum)result.push({itemId:entry.itemId,count:Math.min(left,maximum)});
 }
 if(result.length>32)throw Error('拆分后的邮件附件过多');return result;
}
function validateAttachments(input){
 if(!Array.isArray(input)||input.length<1||input.length>32)throw Error('Invalid prepared GM attachments');
 for(const entry of input){
  if(!entry||Object.keys(entry).sort().join('|')!=='count|itemId')throw Error('Invalid prepared GM attachment fields');
  const item=classify(entry.itemId),maximum=item.container==='slot'?255:1000;
  if(!Number.isInteger(entry.count)||entry.count<1||entry.count>maximum)throw Error('Invalid prepared GM attachment quantity');
 }
 return input.map(entry=>({...entry}));
}
function search(query,limit=50){
 if(typeof query!=='string'||query.length>100)throw Error('道具搜索内容过长');
 const term=query.trim().toLocaleLowerCase();if(!term)return {total:0,items:[]};
 const matches=[];
 for(const item of catalog.items){
  if(!String(item.id).includes(term)&&!item.name.toLocaleLowerCase().includes(term)&&!item.legacyName?.toLocaleLowerCase().includes(term))continue;
  try{matches.push({item,rule:classify(item.id)});}catch{}
 }
 matches.sort((a,b)=>Number(b.item.id===Number(term))-Number(a.item.id===Number(term))||a.item.id-b.item.id);
 return {total:matches.length,items:matches.slice(0,Math.min(100,Math.max(1,limit))).map(({item,rule})=>({id:item.id,name:item.name,type:item.type,quality:item.quality,source:item.catalogSource,
  description:String(item.desc||'').replace(/<[^>]*>/g,'').replace(/\\n/g,'\n').trim(),container:rule.container,use:rule.experience?'experience':require('../player-hero-gifts').rule(item.id)?'hero-skin-gift':'ordinary'}))};
}
module.exports={EXPERIENCE,experience,classify,attachments,validateAttachments,search};
