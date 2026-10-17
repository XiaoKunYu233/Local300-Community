'use strict';
// Read-only projections of already authorized mail. Six icons per native UI
// page; all pages share the parent claim/deletion marker and grant only once.
const crypto=require('crypto'),G=require('./mailgen'),GBK=require('./gbk'),{mkFrame}=require('./bag');
function create(account,mails,claims,legacy=[]){
 const read=new Set(claims.read),claimed=new Set(claims.claimed),deleted=new Set(claims.deleted||[]),all=new Map();
 const reserved=new Set([...mails.map(m=>m.mailId),...legacy.map(m=>m.id)]);
 for(const m of mails.slice().sort((a,b)=>a.mailId-b.mailId)){
  const pages=Math.max(1,Math.ceil(m.attachments.length/6));
  for(let page=0;page<pages;page++){
   let id=m.mailId;
   if(page){let salt=0;do{id=crypto.createHash('sha256').update(`mail-view:${account.uid}:${m.mailId}:${page}:${salt++}`).digest().readUInt32LE(0);}while(!id||reserved.has(id));reserved.add(id);}
   const title=(m.kind==='gm'?m.title:m.kind==='vip-bundle'?'VIP奖励汇总':m.kind==='online'?'在线奖励':m.kind==='vip-level'?'VIP等级奖励':'VIP特权奖励')+(pages>1?` (${page+1}/${pages})`:'');
   const body=(m.kind==='gm'?m.message:'')+(pages>1?`附件共${pages}页，提取任意一页即可领取这封邮件的全部附件。`:m.kind==='gm'?'':'请领取邮件附件。');
   const build=mode=>G.buildMail({mailId:id,playerId:account.playerId,time:Math.floor(m.createdAt/1000),title:GBK.encode(title),body:GBK.encode(body),
    flag0:mode==='notify'?1:0,flag1:mode==='claimed'?2:0,claimed:mode==='claimed',attachments:mode==='claimed'?[]:m.attachments.slice(page*6,page*6+6).map((a,i)=>({...a,guidBytes:G.writeVarint((BigInt(m.mailId)<<32n)|BigInt(0x40000000+page*6+i))}))});
   all.set(id,{id,parentId:m.mailId,hasAttachments:m.attachments.length>0,reward:m,page,time:m.createdAt,build});
  }
 }
 for(const {id,frames}of legacy){
  if(all.has(id)||!claimed.has(id)||!frames)continue;
  const u=Buffer.from(frames.unread.hex,'hex'),r=Buffer.from(frames.read.hex,'hex');
  if([u,r].some(f=>f.length<44||f.readUInt32LE(12)!==id||f.readUInt32LE(20)!==account.playerId))continue;
  const build=()=>{const b=Buffer.from(r.subarray(12)),title=b.readUInt16LE(28),body=b.readUInt16LE(30+title),at=32+title+body;
   if(at+17!==b.length)throw Error('Claimed legacy mail contains attachments');b[at]=0;b[at+1]=2;return b;};
  all.set(id,{id,parentId:id,hasAttachments:true,time:u.readUInt32LE(24)*1000,page:0,build});
 }
 const entries=[...all.values()].filter(e=>!deleted.has(e.parentId)).sort((a,b)=>b.time-a.time||a.parentId-b.parentId||a.page-b.page);
 const mode=e=>claimed.has(e.parentId)?'claimed':read.has(e.parentId)?'detail':'notify';
 const frames=id=>{const e=all.get(id);if(!e||deleted.has(e.parentId))return null;return {parentId:e.parentId,reward:e.reward,
   unread:{hex:mkFrame(20308,e.build('notify'),{flags:0xd2,stream:account.playerId}).toString('hex')},read:{hex:mkFrame(20310,e.build('claimed'),{flags:0xd2}).toString('hex')}};};
 return {all,deleted,ids:entries.map(e=>e.id),frames,unread:new Set(entries.filter(e=>!read.has(e.parentId)&&!claimed.has(e.parentId)).map(e=>e.parentId)).size,
  list:()=>mkFrame(20311,G.buildMailListPayload(entries.map(e=>e.build(mode(e)))),{flags:0xd2})};
}
module.exports={create};
