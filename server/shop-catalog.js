'use strict';
const fs=require('fs'),path=require('path');
const {split}=require('./roledata');
const crypto=require('crypto');
const {currencies,offers}=require('./shop-currencies');
const CAPTURE=path.join(__dirname,'logs','cap-2026-09-27T10-13-20-match','sessions','01','s2c-30001-001.frames.bin');
function parseShopFrame(frame){
  if(frame.readUInt16LE(8)!==16804)throw new Error('not shop catalog 16804');
  const p=frame.subarray(12),n=p.readUInt32LE(0);
  if(p.length!==4+n*32||n>10000)throw new Error('invalid 16804 catalog length');
  const rows=new Map();
  for(let i=0;i<n;i++){
    const o=4+i*32,row={shelf:p.readUInt32LE(o),page:p.readUInt16LE(o+4),
      group:p.readUInt16LE(o+6),kind:p.readUInt16LE(o+8),gold:p.readUInt32LE(o+10),
      diamond:p.readUInt32LE(o+14),extra:p.readUInt32LE(o+18),
      discount:p.readUInt16LE(o+22),itemId:p.readUInt32LE(o+24),tail:p.readUInt32LE(o+28)};
    if(!row.shelf||!row.itemId||rows.has(row.shelf))throw new Error('duplicate/invalid shop shelf');
    rows.set(row.shelf,row);
  }
  return rows;
}
function loadShopCatalog(){
  const frame=split(fs.readFileSync(CAPTURE)).find(f=>f.readUInt16LE(8)===16804);
  if(!frame)throw new Error('captured shop catalog missing');
  const rows=parseShopFrame(frame);
  const configRows=require('./client-shop-config.json');
  for(const row of rows.values()){
    const matches=configRows.filter(x=>x[1]===row.shelf&&x[8]===row.itemId);
    row.config=matches.length===1?matches[0]:null;
  }
  return rows;
}
function buildShopFrame(rows) {
  const list=[...rows.values()].filter(r=>r.enabled!==false&&!r.testUnit),p=Buffer.alloc(4+list.length*32);
  p.writeUInt32LE(list.length);
  list.forEach((r,i)=>{const o=4+i*32;
    p.writeUInt32LE(r.shelf,o);p.writeUInt16LE(r.page,o+4);p.writeUInt16LE(r.group,o+6);
    p.writeUInt16LE(r.kind,o+8);p.writeUInt32LE(r.gold,o+10);p.writeUInt32LE(r.diamond,o+14);
    p.writeUInt32LE(r.extra,o+18);p.writeUInt16LE(r.discount,o+22);p.writeUInt32LE(r.itemId,o+24);p.writeUInt32LE(r.tail,o+28);
  });
  return require('./bag').mkFrame(16804,p);
}
function nativeDate(value){
  if(!value||Number(value)===0)return null;
  const v=String(value).split(',').map(Number);
  if(v.length!==5||v.some(x=>!Number.isInteger(x)))throw Error('Invalid native shop date');
  return new Date(Date.UTC(v[0],v[1]-1,v[2],v[3]-8,v[4])).toISOString();
}
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const SETTINGS=path.join(__dirname,'shop-settings.json');
function configuredCatalog(settings,base=loadShopCatalog()){
  if(settings?.version!==1||!settings.shelves||Array.isArray(settings.shelves)||typeof settings.shelves!=='object'||
      Object.keys(settings).some(k=>!['version','shelves','exchange'].includes(k)))throw Error('Invalid shop settings');
  require('./shop-exchange').configuration(settings.exchange);
  const rows=new Map();
  for(const [shelf,original] of base){
    const r={...original,config:original.config?{...original.config}:null},c=r.config;
    r.enabled=true;r.maxQuantity=Math.min(255,Number(c?.[9])||255);
    r.limit=Number(c?.[22])>0?{count:Number(c[22]),period:'lifetime'}:null;
    r.startsAt=nativeDate(c?.[23]);r.endsAt=nativeDate(c?.[24]);
    rows.set(shelf,r);
  }
  for(const [key,patch] of Object.entries(settings.shelves)){
    const shelf=Number(key);
    if(!integer(shelf,1,0xffffffff)||String(shelf)!==key||!patch||Array.isArray(patch)||typeof patch!=='object')throw Error('Invalid shelf override '+key);
    let row=rows.get(shelf);
    if(!row){
      const c=require('./client-shop-config.json').find(c=>c[1]===shelf);
      if(!c)throw Error('Unknown native shelf '+key);
      row={shelf,page:c[2],group:c[3],kind:c[4],gold:c[5],diamond:c[6],extra:c[13]||0,
        discount:c[7],itemId:c[8],tail:0,config:{...c},enabled:false,maxQuantity:Math.min(c[9]||255,255),
        limit:Number(c[22])>0?{count:Number(c[22]),period:'lifetime'}:null,
        startsAt:nativeDate(c[23]),endsAt:nativeDate(c[24])};rows.set(shelf,row);
    }
    for(const [field,value]of Object.entries(patch)){
      if(['gold','diamond','extra'].includes(field)){if(!integer(value,0,0xffffffff))throw Error('Invalid price '+key);}
      else if(field==='discount'){if(!integer(value,1,100))throw Error('Invalid discount '+key);}
      else if(field==='enabled'){if(typeof value!=='boolean')throw Error('Invalid enabled flag '+key);}
      else if(field==='maxQuantity'){if(!integer(value,1,255))throw Error('Invalid maximum quantity '+key);}
      else if(['startsAt','endsAt'].includes(field)){if(value!==null&&(typeof value!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))))throw Error('Invalid date '+key);}
      else if(field==='limit'){
        if(value!==null&&(!value||Object.keys(value).sort().join(',')!=='count,period'||!integer(value.count,1,0xffffffff)||!['lifetime','day','week','month'].includes(value.period)))throw Error('Invalid limit '+key);
      }else throw Error('Unknown shop setting '+field);
      row[field]=value;
    }
    if(row.startsAt&&row.endsAt&&Date.parse(row.startsAt)>=Date.parse(row.endsAt))throw Error('Invalid sale interval '+key);
    if(row.enabled&&!Object.keys(offers(row)).length)throw Error('Shelf has no supported payment '+key);
  }
  return rows;
}
class ShopCatalog {
  constructor(file=SETTINGS){this.file=path.resolve(file);this.base=loadShopCatalog();this.reload(true);}
  reload(force=false){
    // A bad edit blocks purchasing, rather than silently selling at old prices.
    const bytes=fs.readFileSync(this.file),revision=crypto.createHash('sha256').update(bytes).digest('hex');
    if(!force&&revision===this.revision)return false;
    const settings=JSON.parse(bytes),rows=configuredCatalog(settings,this.base);
    this.exchange=require('./shop-exchange').configuration(settings.exchange);
    this.exchangeRevision=crypto.createHash('sha256').update(JSON.stringify(this.exchange)).digest('hex');
    this.rows=rows;this.revision=revision;return true;
  }
  frame(){return buildShopFrame(this.rows);}
}
function quote(row,code,qty,discount,goldDiscount=85,now=Date.now()){
  if(!row||row.enabled===false)return {error:'商品已下架'};
  if(!integer(qty,1,row.maxQuantity||255))return {error:'数量超过商品配置上限'};
  if(discount!==row.discount)return {error:'折扣不合法'};
  if(row.startsAt&&now<Date.parse(row.startsAt))return {error:'商品尚未开售'};
  if(row.endsAt&&now>=Date.parse(row.endsAt))return {error:'商品已过销售时间'};
  const currency=currencies[code],sticker=row.testUnit||(offers(row)[code]);
  if(!currency||!sticker||(row.testUnit&&row.attr!==currency.attr))return {error:'币种不合法'};
  // Preserve the real-client per-unit gold reward discount and integer rounding.
  const unit=code===3&&!row.testUnit?Math.round(sticker*goldDiscount/100):sticker;
  const amount=Math.round(unit*qty*discount/100);
  if(!integer(amount,1,0xffffffff))return {error:'价格超出范围'};
  return {currency,amount,unit};
}
function limitKey(row,now=Date.now()){
  const date=new Date(now+8*3600000),day=date.toISOString().slice(0,10),period=row.limit?.period;
  if(period==='day')return `${row.shelf}:day:${day}`;
  if(period==='month')return `${row.shelf}:month:${day.slice(0,7)}`;
  if(period==='week'){date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));return `${row.shelf}:week:${date.toISOString().slice(0,10)}`;}
  return String(row.shelf);
}
module.exports={parseShopFrame,loadShopCatalog,buildShopFrame,configuredCatalog,ShopCatalog,quote,limitKey,SETTINGS,currencies};
