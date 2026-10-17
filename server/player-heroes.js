'use strict';
// 1337 dispatch e1fdc0 -> e207ae -> e288a0; 1338 -> e20c54.
// e209cd maps wire skin mask to native hero+4; e3f94b tests bit index
// directly. e20900 puts the final word in the selected-skin map.
const {mkFrame}=require('./bag'),{owns,grant,select}=require('./player-account-state');
const SIZE=182;
const skinKey=(hero,index)=>hero*128+index;
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length<16||frame.readUInt32LE(0)!==frame.length)throw Error('Invalid hero frame');
  const message=frame.readUInt16LE(8);if(![1337,1338].includes(message))throw Error('Not a hero frame');
  const countAt=message===1337?20:12;if(frame.length<countAt+4)throw Error('Truncated hero header');
  const count=frame.readUInt32LE(countAt),end=countAt+4+count*SIZE;
  if(count>4096||end>frame.length)throw Error('Truncated hero collection');
  const records={},order=[];
  for(let p=countAt+4;p<end;p+=SIZE){const record=frame.subarray(p,p+SIZE),hero=record.readUInt16LE(0);
    if(!hero||hero===65535||records[hero])throw Error('Invalid or duplicate hero');
    records[hero]=record.toString('hex');order.push(hero);
  }
  return {version:1,message,prefixHex:frame.subarray(12,countAt).toString('hex'),order,records,tailHex:frame.subarray(end).toString('hex')};
}
function validateWire(wire){
  if(!wire||wire.version!==1||wire.message!==1337||!/^([a-f0-9]{2}){8}$/.test(wire.prefixHex)||
    !Array.isArray(wire.order)||!wire.records||!/^([a-f0-9]{2})*$/.test(wire.tailHex)||wire.tailHex.length>131072||
    wire.order.length>4096||new Set(wire.order).size!==wire.order.length||Object.keys(wire.records).length!==wire.order.length)throw Error('Invalid saved hero snapshot');
  for(const hero of wire.order)if(!Number.isInteger(hero)||hero<1||hero>=65535||
    !/^[a-f0-9]{364}$/.test(wire.records[hero])||Buffer.from(wire.records[hero],'hex').readUInt16LE(0)!==hero)throw Error('Invalid saved hero record');
}
function imported(account,frame,at,source){
  if(account.heroWire||Object.keys(account.owned.heroes).length||Object.keys(account.owned.skins).length)throw Error('Hero collection already initialized');
  const wire=decode(frame);validateWire(wire);account.heroWire=wire;
  for(const hero of wire.order){
    const r=Buffer.from(wire.records[hero],'hex'),seconds=r.readUInt32LE(16),mask=r.readUInt32LE(8),chosen=r.readUInt16LE(180);
    const expiresAt=seconds?at+seconds*1000:null;
    grant(account,{kind:'heroes',itemId:hero,expiresAt,source},at);
    for(let index=1;index<32;index++)if((mask>>>index)&1)grant(account,{kind:'skins',itemId:skinKey(hero,index),source},at);
    if(chosen&&chosen<32&&((mask>>>chosen)&1))select(account,'skin:'+hero,'skins',skinKey(hero,chosen),at);
  }
}
function render(account,now=Date.now(),{flags=0xd3,stream=0}={}){
  if(!account.heroWire)throw Error('Hero collection has not been migrated');validateWire(account.heroWire);
  const w=account.heroWire,heroes=[...w.order,...Object.keys(account.owned.heroes).map(Number).filter(id=>!w.records[id])];
  const records=[],statOverlays=require('./player-hero-history').overlays(account);
  for(const hero of heroes){
    if(!owns(account,'heroes',hero,now))continue;
    const r=statOverlays.get(hero)|| (w.records[hero]?Buffer.from(w.records[hero],'hex'):Buffer.alloc(SIZE));
    r.writeUInt16LE(hero);if(!w.records[hero])r.writeUInt16LE(1,2);
    let mask=1;for(let index=1;index<32;index++)if(owns(account,'skins',skinKey(hero,index),now))mask=(mask|(1<<index))>>>0;
    r.writeUInt32LE(mask,8);const until=account.owned.heroes[hero].expiresAt;
    r.writeUInt32LE(until===null?0:Math.min(0xffffffff,Math.ceil((until-now)/1000)),16);
    const chosen=account.selected['skin:'+hero],index=chosen?.kind==='skins'&&Math.floor(chosen.id/128)===hero?chosen.id%128:0;
    r.writeUInt16LE(index>0&&index<32&&((mask>>>index)&1)?index:0,180);records.push(r);
  }
  const count=Buffer.alloc(4);count.writeUInt32LE(records.length);
  return mkFrame(1337,Buffer.concat([Buffer.from(w.prefixHex,'hex'),count,...records,Buffer.from(w.tailHex,'hex')]),{flags,stream});
}
function skinMask(account,hero,now=Date.now()){
  let mask=1;for(let index=1;index<32;index++)if(owns(account,'skins',skinKey(hero,index),now))mask=(mask|(1<<index))>>>0;
  return mask;
}
function skinNotice(account,hero,now=Date.now(),options={}){
  if(!owns(account,'heroes',hero,now))return null;
  const p=Buffer.alloc(6);p.writeUInt16LE(hero);p.writeUInt32LE(skinMask(account,hero,now),2);
  return mkFrame(1372,p,options);
}
function incremental(account,ids,now=Date.now(),options={}){
  const current=decode(render(account,now,options));
  const records=[...new Set(ids)].filter(id=>current.records[id]).map(id=>Buffer.from(current.records[id],'hex'));
  const count=Buffer.alloc(4);count.writeUInt32LE(records.length);
  return mkFrame(1338,Buffer.concat([count,...records]),options);
}
// XClickSelAppearance -> 147ef00: MSG_C2S_CHANGE_HERO_APPEARANCE_REQ,
// 20-byte frame, u32 hero + u32 skin. The 1338 handler refreshes hero detail.
function skinRequest(frame){
  // Native 147ef56..147ef72 writes length20, stream0 and tag27616/flags0.
  if(!Buffer.isBuffer(frame)||frame.length!==20||frame.readUInt32LE(0)!==20||frame.readUInt32LE(4)!==0||
    frame.readUInt16LE(8)!==27616||frame.readUInt16LE(10)!==0)throw Error('Invalid native wardrobe skin request');
  const heroId=frame.readUInt32LE(12),skinId=frame.readUInt32LE(16);
  if(heroId<1||heroId>=65535||skinId>31)throw Error('Invalid native wardrobe skin identity');
  return {heroId,skinId};
}
function selectSkin(account,payload,now=Date.now()){
  if(!Buffer.isBuffer(payload)||payload.length!==8)throw Error('皮肤穿戴请求无效');
  const hero=payload.readUInt32LE(0),index=payload.readUInt32LE(4);
  if(!account.heroWire||hero<1||hero>=65535||index>31||!owns(account,'heroes',hero,now))throw Error('尚未拥有该英雄或英雄已过期');
  select(account,'skin:'+hero,'skins',index?skinKey(hero,index):null,now);
  return hero;
}
// 1338 (e20dd0/e21407) updates both selected skin and the owned skin mask.
// Keep the requested hero subset but source the entire record from the account;
// delayed old stats/selection/masks must never overwrite current durable data.
function authoritative(account,frame,now=Date.now()){
  const message=frame.readUInt16LE(8),options={flags:frame.readUInt16LE(10),stream:frame.readUInt32LE(4)};
  if(message===1337)return render(account,now,options);
  if(message===1372){if(frame.length!==18)throw Error('Invalid skin ownership notice');return skinNotice(account,frame.readUInt16LE(12),now,options);}
  if(message!==1338)return frame;
  return incremental(account,decode(frame).order,now,options);
}
module.exports={SIZE,skinKey,decode,validateWire,imported,render,skinMask,skinNotice,incremental,skinRequest,selectSkin,authoritative};
