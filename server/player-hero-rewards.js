'use strict';
// Native item hero/skin fields 51/52; current client row order takes precedence.
// Reward notifications use (hero << 7) | skin (e2047a), not the shop item ID.
const {loadConfig}=require('./runtime/catalogs'),state=require('./player-account-state'),heroes=require('./player-heroes');
let items,rows;
function entitlement(itemId){
  if(!items){rows=loadConfig('current-items').data;items=new Map(rows.map(r=>[r[1],r]));}
  const row=items.get(itemId);if(!row)return null;
  if(row[10]==='restore')return require('./player-trial-skins').resolve(row,rows);
  if(!['hero','skin'].includes(row[10]))return null;
  const hero=row[51],index=row[52];
  if(!Number.isInteger(hero)||hero<1||hero>=65535||!Number.isInteger(index)||index<0||index>31||
    (row[10]==='hero'?index!==0:index===0))throw Error('英雄或皮肤配置无效');
  // Trial grants need their own duration protocol, not an inferred permanent grant.
  if(/体验|限时|\d+\s*(天|小时|分钟)/.test((row[23]||'')+(row[24]||'')))throw Error('限时英雄或皮肤的领取规则尚未接入');
  return {kind:index?'skins':'heroes',itemId:index?heroes.skinKey(hero,index):hero,hero,index};
}
function prepare(account,itemId,count,source,now=Date.now()){
  const reward=entitlement(itemId);if(!reward)return null;
  if(!account?.heroWire)throw Error('账号英雄收藏尚未迁移');
  if(count!==1)throw Error('英雄和皮肤每次只能购买一个');
  if(account.owned[reward.kind][reward.itemId]?.expiresAt===null)throw Error('已永久拥有该英雄或皮肤');
  if(reward.durationMs&&state.owns(account,reward.kind,reward.itemId,now))throw Error('该体验皮肤仍有效，续期叠加规则尚未核实');
  if(reward.durationMs){
    reward.expiresAt=now+reward.durationMs;
    const timed=Object.keys(account.owned.skins).filter(key=>Math.floor(+key/128)===reward.hero&&account.owned.skins[key].expiresAt!==null&&+key!==reward.itemId);
    if(timed.length>=6)throw Error('该英雄限时皮肤记录超过客户端容量');
  }
  if(reward.index&&!state.owns(account,'heroes',reward.hero,now))throw Error('请先拥有对应英雄');
  const draft=JSON.parse(JSON.stringify(account));
  state.grant(draft,{...reward,source},now);
  // Validate the resulting wire before money or inventory can be changed.
  heroes.render(draft,now);
  return {reward,revision:account.revision,source,now,catalogItemId:itemId};
}
function apply(account,prepared){
  const {reward,source,now}=prepared;
  if(!state.grant(account,{...reward,source},now))throw Error('Hero entitlement changed during purchase');
  require('./player-avatar').recordPermanentSkin(account,prepared);
}
module.exports={entitlement,prepare,apply};
