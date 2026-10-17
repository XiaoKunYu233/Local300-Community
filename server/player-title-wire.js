'use strict';
// XClickComboBoxList -> 147a5c0 -> e438f0. e439a8 constructs a
// 15-byte 14004 frame: u16 current/selected title, u8 hidden flag.
// Hiding retains the current title ID; this request proves no ownership.
function request(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==15||frame.readUInt32LE(0)!==15||frame.readUInt16LE(8)!==14004||frame[14]>1)throw Error('Invalid title selection request');
  return {titleId:frame.readUInt16LE(12),hidden:frame[14]===1};
}
// XShowTitleEffect -> 14dc050 constructs a sparse settings update. The first
// setting is a changed/value pair; every other pair is the 00ff sentinel.
// Accept only this proven variant until the other settings are mapped.
function settingsRequest(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==77||frame.readUInt32LE(0)!==77||frame.readUInt16LE(8)!==1452||frame[12]!==1||frame[13]!==1||frame[14]>1)throw Error('Invalid title visibility settings request');
  for(let at=15;at<77;at+=2)if(frame.readUInt16LE(at)!==255)throw Error('Unsupported settings update');
  return {effectHidden:frame[14]===1};
}
const TITLE_OFF=287854,HIDDEN_OFF=287856,OWNED_OFF=287857,OWNED_BYTES=300;
function display(account,now=Date.now()){
  const state=account.titleState;
  if(!state)return {titleId:0,hidden:true};
  require('./player-title-state').validate(state,account);
  const owned=state.titleId&&require('./player-account-state').owns(account,'titles',state.titleId,now);
  return {titleId:owned?state.titleId:0,hidden:state.hidden||!owned};
}
function ownedIds(account,now=Date.now()){
  return Object.keys(account.owned.titles).map(Number).filter(id=>require('./player-account-state').owns(account,'titles',id,now)).sort((a,b)=>a-b);
}
function decodeOwnership(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==15||frame.readUInt32LE(0)!==15||frame.readUInt16LE(8)!==14003||frame[14]>1||frame.readUInt16LE(12)<1||frame.readUInt16LE(12)>=2400)throw Error('Invalid title ownership notification');
  return {titleId:frame.readUInt16LE(12),enabled:frame[14]===1};
}
// 66e020 writes the same global ownership tree as the 1013 bitmap. This is
// a self-only notification: its body has no account or scene object identity.
// enable=0 also clears the matching native self wear ID, so the subsequent
// 14005 must use effective ID zero instead of restoring an expired choice.
function ownership(account,titleId,now=Date.now()){
  if(!Number.isInteger(titleId)||titleId<1||titleId>=2400)throw Error('Invalid title ownership notification');
  const p=Buffer.alloc(3);p.writeUInt16LE(titleId);p[2]=Number(require('./player-account-state').owns(account,'titles',titleId,now));
  return require('./bag').mkFrame(14003,p,{stream:account.playerId,flags:0xd2});
}
function ownershipChanges(account,previous,now=Date.now()){
  const current=ownedIds(account,now),next=new Set(current),before=new Set(previous||[]);
  const ids=[...new Set([...before,...next])].filter(id=>before.has(id)!==next.has(id));
  return {ids:current,frames:previous===null?[]:ids.map(id=>ownership(account,id,now))};
}
function decodeReply(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==34||frame.readUInt32LE(0)!==34||frame.readUInt16LE(8)!==14005||frame[14]>1)throw Error('Invalid title reply');
  return {titleId:frame.readUInt16LE(12),hidden:frame[14]===1,playerId:frame.readUInt32LE(15)};
}
// a976a4 supplies 1013+22 to badbc0: that role ID becomes the +94
// object-table key and the manager's +40 self key. bff0b0 looks up
// 14005+15 in that table. It does not read the remaining fifteen bytes.
// 1152ad8 registers 34 bytes. Newly built frames zero unused tail bytes;
// rewriting a captured frame preserves its tail without assigning meaning.
function reply(account,now=Date.now()){
  const p=Buffer.alloc(22),state=display(account,now);
  p.writeUInt16LE(state.titleId);p[2]=Number(state.hidden);p.writeUInt32LE(account.playerId,3);
  return require('./bag').mkFrame(14005,p,{stream:account.playerId,flags:0xd2});
}
function outbound(account,frame,now=Date.now()){
  const parsed=decodeReply(frame);
  if(!account||parsed.playerId!==account.playerId)return null;
  const state=display(account,now),out=Buffer.from(frame);
  out.writeUInt16LE(state.titleId,12);out[14]=Number(state.hidden);return out;
}
// a97a9d/a97b14 copy these 1013 fields into object+970/+972,
// the same fields updated by 14005. Missing state clears stale capture wear.
function patchRole(blob,account,now=Date.now()){
  const role=require('./roledata');
  // Inflated captured 1013 declares 288540 but contains 288458 bytes;
  // roledata preserves that native header. Validate the required fields and
  // identity here, rather than treating this body as an outer TCP envelope.
  if(!Buffer.isBuffer(blob)||blob.length<OWNED_OFF+OWNED_BYTES||blob.readUInt16LE(8)!==1013||blob.readUInt32LE(role.UID_OFF)!==account.uid||blob.readUInt32LE(role.PLAYERID_OFF)!==account.playerId)throw Error('Player title role identity mismatch');
  const state=display(account,now),out=Buffer.from(blob);
  out.writeUInt16LE(state.titleId,TITLE_OFF);out[HIDDEN_OFF]=Number(state.hidden);
  // a979e0..a97a92 loads 2400 ownership bits independently of current wear.
  // Rebuild it as well so rejected/expired capture entitlements cannot return.
  out.fill(0,OWNED_OFF,OWNED_OFF+OWNED_BYTES);
  for(const key of Object.keys(account.owned.titles))if(require('./player-account-state').owns(account,'titles',+key,now)){
    const id=+key;if(!Number.isInteger(id)||id<1||id>=OWNED_BYTES*8)throw Error('Title ownership exceeds native bitmap');
    out[OWNED_OFF+(id>>3)]|=1<<(id&7);
  }
  return out;
}
module.exports={request,settingsRequest,display,ownedIds,decodeOwnership,ownership,ownershipChanges,reply,decodeReply,outbound,patchRole,TITLE_OFF,HIDDEN_OFF,OWNED_OFF,OWNED_BYTES};
