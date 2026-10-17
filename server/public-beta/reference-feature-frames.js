'use strict';
// Public trial envelopes only. Original inventory, nonces, memory pointers,
// names and quantities are never copied from the selected private captures.
const B=require('../bag'),W=require('../war-soul'),P=require('../loadout-page-wire');
const EMPTY=require('./reference-empty-state');
const INITIAL=[11678,11688,36273,27615];
const REQUESTS=Object.freeze({11687:11688,11681:11682,11683:11684,11685:11686,36274:36275});
const PREVIEWS=Object.freeze({11681:11682,11683:11684});
function player(id){if(!Number.isSafeInteger(id)||id<1||id>0xffffffff)throw Error('Explicit feature player ID required');return id;}
function header(f){if(!Buffer.isBuffer(f)||f.length<12||f.readUInt32LE()!==f.length)throw Error('Invalid feature envelope');return f.readUInt16LE(8);}
function neutral(source,id,{preview=false}={}){
 const tag=header(source),flags=source.readUInt16LE(10),stream=source.readUInt32LE(4)?player(id):0;
 let payload;
 if(tag===11678){payload=P.runeInfoPayload(EMPTY.create({now:0})['rune-state.json']);}
 else if(tag===11688){if(source.length<16||(source.length-16)%35)throw Error('Invalid native rune list');payload=Buffer.alloc(4);}
 else if(tag===11686){if(source.length<20||(source.length-20)%35)throw Error('Invalid native rune compose');payload=Buffer.alloc(8);}
 else if(tag===11682){
  if(source.length!==111||![0,1].includes(source.readUInt32LE(102))||![0,1].includes(source[106]))throw Error('Unsupported native strengthen envelope');
  payload=Buffer.alloc(99);
  // Byte106 distinguishes the paired native result paths in all three
  // original09/26 operations and current native d832ec. Clear the
  // formatted DWORDs at frame90/94/98 and all other source payload bytes;
  // they are not an onlyId. Live descriptors/list supply actual rune identity.
  // DWORD102 is the live small-pity count, not a control marker. New empty
  // state has count0; liveRuneStrengthenAck fills its current business value.
  payload[94]=Number(preview);
 }
 else if(tag===11684){
  if(source.length!==99||![0,1].includes(source[86])||![0,1].includes(source[90]))throw Error('Unsupported native demolish envelope');
  payload=Buffer.alloc(87);payload[74]=Number(!preview);payload[78]=Number(preview);
 }
 else if(tag===36275){if(source.length!==14)throw Error('Unsupported native soul reset envelope');payload=Buffer.alloc(2);}
 else if(tag===27615){if(source.length!==132)throw Error('Unsupported native avatar-frame list');payload=Buffer.alloc(120);}
 else if(tag===36273){
  if(source.length!==49780)throw Error('Unsupported native war-soul snapshot');
  const blank=B.mkFrame(tag,Buffer.alloc(49768),{flags,stream});
  const result=W.patchNativeRefreshFrame(blank,EMPTY.create({now:0})['war-soul-state.json']);
  if(!result)throw Error('Empty war-soul snapshot unavailable');return result;
 }else throw Error('Unknown public feature envelope');
 return B.mkFrame(tag,payload,{flags,stream});
}
function prepare({sourceFrames,playerId}={}){
 player(playerId);if(!Array.isArray(sourceFrames))throw Error('Explicit pinned feature sources required');
 const grouped=new Map();for(const f of sourceFrames){const tag=header(f);if(!grouped.has(tag))grouped.set(tag,[]);grouped.get(tag).push(f);}
 const first=tag=>{const f=grouped.get(tag)?.[0];if(!f)throw Error('Required native feature source missing: '+tag);return f;};
 const initial=INITIAL.map(tag=>neutral(first(tag),playerId).toString('hex'));
 const templates=Object.entries(REQUESTS).map(([request,tag])=>{
  const candidates=grouped.get(tag)||[];
  const f=tag===11682?candidates.find(f=>f.length===111&&f[106]===0):tag===11684?candidates.find(f=>f.length===99&&!(f[86]===0&&f[90]===1)):first(tag);
  if(!f)throw Error('Required native commit source missing: '+tag);
  return {requestMsgid:Number(request),hex:neutral(f,playerId).toString('hex')};
 });
 const previews=Object.entries(PREVIEWS).map(([request,tag])=>{
  const f=(grouped.get(tag)||[]).find(f=>tag===11682?f.length===111&&f[106]===1:f.length===99&&f[86]===0&&f[90]===1);
  if(!f)throw Error('Required native preview source missing: '+tag);
  return {requestMsgid:Number(request),hex:neutral(f,playerId,{preview:true}).toString('hex')};
 });
 return {version:1,initial,templates,previews};
}
function decodeHex(hex){if(typeof hex!=='string'||hex.length>100000||!/^([a-f0-9]{2})+$/.test(hex))throw Error('Invalid public feature bytes');return Buffer.from(hex,'hex');}
function create({featureFramesHex,playerId}={}){
 player(playerId);const value=featureFramesHex;
 if(!value||value.version!==1||!Array.isArray(value.initial)||value.initial.length!==INITIAL.length)throw Error('Prepared public feature manifest required');
 const initialFrames=value.initial.map((hex,i)=>{const f=decodeHex(hex);if(header(f)!==INITIAL[i])throw Error('Unexpected initial feature');const out=neutral(f,playerId),expected=Buffer.from(out);expected.writeUInt32LE(f.readUInt32LE(4),4);if(!expected.equals(f))throw Error('Feature initialization is not neutral');return out;});
 const rows=(input,map,preview)=>{
  if(!Array.isArray(input)||input.length!==Object.keys(map).length)throw Error('Incomplete public feature templates');
  const seen=new Set();return input.map(row=>{
   if(!row||!Number.isInteger(row.requestMsgid)||seen.has(row.requestMsgid)||map[row.requestMsgid]===undefined)throw Error('Unexpected feature request mapping');seen.add(row.requestMsgid);
   const f=decodeHex(row.hex);if(header(f)!==map[row.requestMsgid])throw Error('Feature request/response mismatch');
   const out=neutral(f,playerId,{preview});
   // Only the caller-owned stream can change. Every other byte must already
   // equal the neutral constructor, preventing hidden source assets in JSON.
   const expected=Buffer.from(out);expected.writeUInt32LE(f.readUInt32LE(4),4);if(!expected.equals(f))throw Error('Feature template contains non-neutral data');
   return {requestMsgid:row.requestMsgid,frame:out};
  });
 };
 return {initialFrames,templateFrames:rows(value.templates,REQUESTS,false),previewFrames:rows(value.previews,PREVIEWS,true),audit:{initialTags:[...INITIAL],templateRequests:Object.keys(REQUESTS).map(Number),previewRequests:Object.keys(PREVIEWS).map(Number),privateSourcePayloadCopied:false,nativeUIAcceptancePending:true}};
}
module.exports={prepare,create,INITIAL,REQUESTS,PREVIEWS};
