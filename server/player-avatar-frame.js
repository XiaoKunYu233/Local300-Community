'use strict';
// Explicit public default selection only. Catalog endtime is not an account
// deadline. Activity/private frames and automatic fallback remain unresolved.
const catalog=require('./client-avatar-frame-catalog.json'),P=require('./battle-protobuf');
const uint=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const time=value=>{if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid avatar frame time');return value;};
function publicFrame(frameId){
  const rows=catalog.frames.filter(row=>row.frameId===frameId);
  if(catalog.version!==1||frameId!==10001||rows.length!==1||rows[0].type!==0||rows[0].public!==1||typeof rows[0].art!=='string'||!rows[0].art.length)throw Error('Unverified public avatar frame');
  return rows[0];
}
function identity(account){if(!account||!uint(account.uid)||!uint(account.playerId))throw Error('Invalid avatar frame account identity');return account;}
function validate(value,account){
  identity(account);
  const keys=['version','uid','playerId','frameId','changedAt'];
  if(!value||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||value.version!==1||value.uid!==account.uid||value.playerId!==account.playerId)throw Error('Invalid avatar frame state identity');
  publicFrame(value.frameId);time(value.changedAt);return value;
}
function request(frame,auth){
  // Native 147fb99..147fbb1 explicitly writes length16, stream0 and
  // dword message0x6bdd (therefore flags0). The only body is raw frame ID.
  if(!Buffer.isBuffer(frame)||frame.length!==16||frame.readUInt32LE(0)!==16||frame.readUInt32LE(4)!==0||frame.readUInt16LE(8)!==27613||frame.readUInt16LE(10)!==0)throw Error('Invalid avatar frame request');
  if(!auth||auth.authenticated!==true||auth.frozen!==false||!uint(auth.uid)||!uint(auth.playerId))throw Error('Avatar frame requires an available authenticated account');
  const frameId=frame.readUInt32LE(12);publicFrame(frameId);
  return {frameId,uid:auth.uid,playerId:auth.playerId};
}
function apply(account,selection,now=Date.now()){
  identity(account);time(now);
  if(!selection||selection.uid!==account.uid||selection.playerId!==account.playerId)throw Error('Avatar frame request belongs to another account');
  publicFrame(selection.frameId);
  const state={version:1,uid:account.uid,playerId:account.playerId,frameId:selection.frameId,changedAt:now};
  validate(state,account);account.avatarFrameState=state;return state;
}
function selected(account,now=Date.now()){
  identity(account);time(now);if(account.avatarFrameState===undefined)return null;
  const state=validate(account.avatarFrameState,account);if(state.changedAt>now)throw Error('Avatar frame selection is in the future');return state.frameId;
}
function reply(account,now=Date.now()){
  const frameId=selected(account,now);if(frameId===null)return null;
  // 115844e registers fixed16; beb32e consumes frame+12 as config ID,
  // with no UID/role field. Account context comes from the private connection.
  const body=Buffer.alloc(4);body.writeUInt32LE(frameId);
  return require('./bag').mkFrame(27614,body,{stream:0,flags:0xd2});
}
function outbound(account,frame,now=Date.now()){
  try{
    if(!Buffer.isBuffer(frame)||frame.length!==16||frame.readUInt32LE(0)!==16||frame.readUInt16LE(8)!==27614||frame.readUInt32LE(4)!==0||frame.readUInt32LE(12)!==10001)return null;
    const frameId=selected(account,now);if(frameId===null)return null;
    const result=Buffer.from(frame);result.writeUInt32LE(frameId,12);return result;
  }catch{return null;}
}
function publicList(frame){
  // 115846f fixed132; beb3eb..beb42e reads all30 u32 private-ID slots,
  // then beb43e/54b3b0 independently adds type0/public defaults. Clear the
  // private slots rather than replaying unverified activity permissions.
  if(!Buffer.isBuffer(frame)||frame.length!==132||frame.readUInt32LE(0)!==132||frame.readUInt32LE(4)!==0||frame.readUInt16LE(8)!==27615)throw Error('Invalid avatar frame public list template');
  publicFrame(10001);const result=Buffer.from(frame);result.fill(0,12);return result;
}
function profileFields(fields,account,now=Date.now()){
  if(!Array.isArray(fields))throw Error('Invalid avatar frame profile fields');
  identity(account);
  for(const [number,value] of [[1,account.uid],[3,account.playerId]]){
    const rows=fields.filter(field=>field.number===number);
    if(rows.length!==1||rows[0].wire!==0||rows[0].value!==BigInt(value))throw Error('Avatar frame profile belongs to another account');
  }
  const frameId=selected(account,now);if(frameId===null)return fields;
  const rows=fields.filter(field=>field.number===20);
  if(rows.length!==1||rows[0].wire!==0||typeof rows[0].value!=='bigint'||rows[0].value<0n||rows[0].value>0xffffffffn)throw Error('Invalid profile avatar frame field');
  return fields.map(field=>field.number===20?{...field,value:BigInt(frameId)}:field);
}
function patchProfile(account,frame,now=Date.now()){
  const wire=require('./player-profile-wire');wire.unpack(frame,account);
  const frameId=selected(account,now);if(frameId===null)return Buffer.from(frame);
  const bytes=frame.subarray(24),fields=P.decode(bytes);profileFields(fields,account,now);
  // P.decode validates the full message first. Keep every other field's raw
  // spelling/order, including noncanonical but valid opaque varints.
  let offset=0;
  const read=()=>{let value=0n;for(let i=0;i<10;i++){const byte=bytes[offset++];value|=BigInt(byte&127)<<BigInt(i*7);if(!(byte&128))return value;}throw Error('Invalid profile varint');};
  const chunks=[];
  for(const field of fields){
    const start=offset;read();
    if(field.wire===0)read();else {const length=field.wire===1?8:field.wire===5?4:Number(read());offset+=length;}
    chunks.push(field.number===20?P.encode([{number:20,wire:0,value:BigInt(frameId)}]):bytes.subarray(start,offset));
  }
  const payload=Buffer.concat(chunks),header=Buffer.from(frame.subarray(0,24));header.writeUInt32LE(24+payload.length,0);header.writeUInt32LE(payload.length,20);
  const result=Buffer.concat([header,payload]);wire.unpack(result,account);return result;
}
module.exports={catalog,publicFrame,request,apply,validate,selected,reply,outbound,publicList,profileFields,patchProfile};
