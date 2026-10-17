'use strict';
// Pure candidate conversion of an explicitly selected, accepted reference.
// No files, ledgers, services or existing accounts are written here. Opaque
// non-asset role regions remain a local-trial boundary, not a publication claim.
const crypto=require('node:crypto'),R=require('../roledata'),H=require('../player-heroes'),B=require('../bag'),GBK=require('../gbk');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const HERO_IDS=Object.freeze([101,53]),PID_OFFSETS=Object.freeze([4,22,1844,1855,1866]);
const WALLET_ATTRIBUTES=Object.freeze([50,52,72,91,131,141,156,157,181]);
const ROLE_BYTES=288458,NAME_LEN=15,WORLD_OFF=288432,BAG_BASE=15718,BAG_STRIDE=493,BAG_COUNT=552,EQUIP_BASE=4751,EQUIP_STRIDE=497,EQUIP_COUNT=22;
const uint=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
function target(value){
 if(!value||!uint(value.uid)||!uint(value.playerId)||typeof value.name!=='string')throw Error('Reference target identity missing');
 const bytes=GBK.encode(value.name);
 if(!bytes.length||bytes.length>14||bytes.includes(0)||GBK.decode(bytes)!==value.name)throw Error('Reference target name is invalid');
 if(![20032,20034].includes(value.worldId))throw Error('Reference target world is unsupported');
 const capacity=value.bagCapacity??192;if(!Number.isInteger(capacity)||capacity<1||capacity>352)throw Error('Reference bag capacity is invalid');
 const avatarItemId=value.avatarItemId??5500;require('../player-avatar').defaultRow(avatarItemId);
 return {...value,nameBytes:bytes,bagCapacity:capacity,avatarItemId};
}
function checkRole(source){
 if(!Buffer.isBuffer(source)||source.length!==ROLE_BYTES||source.readUInt32LE(0)!==288540||source.readUInt16LE(8)!==1013||source[12]!==1)throw Error('Reference role layout or success marker is invalid');
 const playerId=source.readUInt32LE(R.PLAYERID_OFF),uid=source.readUInt32LE(R.UID_OFF);
 if(!uint(playerId)||!uint(uid)||PID_OFFSETS.some(at=>source.readUInt32LE(at)!==playerId))throw Error('Reference repeated identity fields disagree');
 // This explicitly selected source has a neutral span here. Its historical
 // "session string" comment does not establish adjacent-field widths, so
 // reject other nonzero sources instead of guessing a broader erase range.
 if(!source.subarray(145,176).every(value=>value===0))throw Error('Reference session metadata is not neutral');
 return {playerId,uid};
}
function emptyEquipmentRecord(){
 const record=Buffer.alloc(EQUIP_STRIDE);record[0]=255;record.writeUInt16LE(65535,1);record.writeUInt32LE(65535,3);record.writeUInt32LE(7,493);return record;
}
function role(source,identity){
 checkRole(source);const t=target(identity),out=Buffer.from(source);
 for(const at of PID_OFFSETS)out.writeUInt32LE(t.playerId,at);out.writeUInt32LE(t.uid,R.UID_OFF);
 out.fill(0,R.NAME_OFF,R.NAME_OFF+NAME_LEN);t.nameBytes.copy(out,R.NAME_OFF);
 // a9802a/a9802f reads this positive avatar item ID. Only the verified
 // unconditional default-avatar branch is admitted, without skin ownership.
 out.writeUInt32LE(t.avatarItemId,60);
 // a9755e/a97564 sets CDragoonGame+2c374 from the native role world.
 out.writeUInt32LE(t.worldId,WORLD_OFF);
 out.writeUInt16LE(1,79);out.writeInt32LE(0,137);out.writeUInt32LE(0,R.GOLD_OFF);out[250]=0;
 const empty=emptyEquipmentRecord();for(let slot=0;slot<EQUIP_COUNT;slot++)empty.copy(out,EQUIP_BASE+slot*EQUIP_STRIDE);
 out.writeUInt16LE(t.bagCapacity,15704);
 for(let slot=0;slot<BAG_COUNT;slot++){
  const at=BAG_BASE+slot*BAG_STRIDE;out.fill(0,at,at+BAG_STRIDE);out[at]=255;out.writeUInt16LE(65535,at+1);out.writeUInt16LE(65535,at+3);
 }
 // The last inventory record ends exactly where the verified title fields start.
 const titles=require('../player-title-import');out.writeUInt16LE(0,titles.TITLE_OFF);out[titles.HIDDEN_OFF]=1;out.fill(0,titles.MASK_OFF,titles.MASK_OFF+titles.MASK_BYTES);
 return out;
}
function heroWire(source){
 H.validateWire(source);
 if(!HERO_IDS.every(id=>source.records[id]))throw Error('Accepted reference does not contain both requested heroes');
 if(!/^0{16}$/.test(source.prefixHex))throw Error('Unknown nonzero reference hero prefix');
 const records={};for(const id of HERO_IDS){
  // player-heroes.render uses this exact default for newly owned heroes.
  const record=Buffer.alloc(H.SIZE);record.writeUInt16LE(id);record.writeUInt16LE(1,2);record.writeUInt32LE(1,8);records[id]=record.toString('hex');
 }
 // Current native1337 consumes the two prefix words and the hero vector.
 // Never carry the reference's additional opaque tail/skin data into the trial.
 const result={version:1,message:1337,prefixHex:source.prefixHex,order:[...HERO_IDS],records,tailHex:'00000000'};H.validateWire(result);return result;
}
function heroesFrame(wire,options={}){
 H.validateWire(wire);const count=Buffer.alloc(4);count.writeUInt32LE(wire.order.length);
 return B.mkFrame(1337,Buffer.concat([Buffer.from(wire.prefixHex,'hex'),count,...wire.order.map(id=>Buffer.from(wire.records[id],'hex')),Buffer.from(wire.tailHex,'hex')]),options);
}
function equipmentFrames(identity,{flags=0xd2}={}){
 const t=target(identity);return Array.from({length:6},(_,slot)=>B.mkFrame(1043,Buffer.concat([Buffer.from([slot]),emptyEquipmentRecord()]),{flags,stream:t.playerId}));
}
function equipmentSummary(source,identity){
 const t=target(identity);if(!Buffer.isBuffer(source)||source.length!==10967||source.readUInt32LE(0)!==10967||source.readUInt16LE(8)!==13535)throw Error('Reference equipment summary is invalid');
 const out=Buffer.from(source);out.writeUInt32LE(t.playerId,12);if(out.readUInt32LE(4))out.writeUInt32LE(t.playerId,4);
 const empty=emptyEquipmentRecord();for(let slot=0;slot<EQUIP_COUNT;slot++)empty.copy(out,16+slot*EQUIP_STRIDE);return out;
}
function attributes(source,identity){
 const t=target(identity);if(!Buffer.isBuffer(source)||source.length<13||source.readUInt32LE(0)!==source.length||source.readUInt16LE(8)!==1045||source.length!==13+source[12]*5)throw Error('Reference attribute frame is invalid');
 const out=Buffer.from(source);out.writeUInt32LE(t.playerId,4);
 for(let at=13;at<out.length;at+=5){const id=out[at];if(WALLET_ATTRIBUTES.includes(id)||id===111)out.writeUInt32LE(0,at+1);else if(id===110)out.writeUInt32LE(1,at+1);}
 return out;
}
function profile(source,identity){
 const t=target(identity),wire=require('../player-profile-wire'),P=require('../battle-protobuf'),old=wire.unpack(source),header=Buffer.from(old.header);
 header.writeUInt32LE(t.worldId,12);header.writeUInt32LE(t.playerId,16);if(header.readUInt32LE(4))header.writeUInt32LE(t.playerId,4);
 // Only established identity/growth and empty history encodings are generated.
 // Unknown cosmetics, dates, notes and opaque bytes are not copied as defaults.
 const fields=[{number:1,wire:0,value:BigInt(t.uid)},{number:2,wire:0,value:BigInt(t.worldId)},{number:3,wire:0,value:BigInt(t.playerId)},
  {number:4,wire:2,bytes:t.nameBytes},{number:5,wire:0,value:BigInt(t.avatarItemId)},{number:8,wire:0,value:1n},{number:9,wire:0,value:0n},{number:10,wire:0,value:0n}];
 for(let mode=0;mode<13;mode++)fields.push({number:12,wire:2,bytes:P.encode([{number:3,wire:0,value:0n},{number:4,wire:0,value:0n}])});
 return wire.pack({uid:t.uid,playerId:t.playerId,serverId:t.worldId,nameBytes:t.nameBytes,header,fields});
}
function prepare(source,identity){
 if(!source||!Buffer.isBuffer(source.role))throw Error('Explicit accepted role and hero source required');
 const original=checkRole(source.role),t=target(identity),old=source.oldAccount;
 if(source.expectedRoleSha256!==undefined&&source.expectedRoleSha256!==sha(source.role))throw Error('Reference role source drift');
 if(old&&(old.uid!==original.uid||old.playerId!==original.playerId))throw Error('Reference account and role identity mismatch');
 const sourceHeroes=source.heroWire||old?.heroWire;if(!sourceHeroes)throw Error('Explicit accepted role and hero source required');
 let sourceProfile=source.profileFrame;
 if(!sourceProfile&&old?.profileSnapshot){require('../player-profile-snapshot').validate(old.profileSnapshot,old);sourceProfile=Buffer.from(old.profileSnapshot.frameBase64,'base64');}
 if(sourceProfile)require('../player-profile-wire').unpack(sourceProfile,original);
 const cleanRole=role(source.role,t),wire=heroWire(sourceHeroes);
 const leftovers=[];for(const [kind,value]of [['playerId',original.playerId],['uid',original.uid]]){
  if(value===t[kind])continue;const needle=Buffer.alloc(4);needle.writeUInt32LE(value);let at=0;while((at=cleanRole.indexOf(needle,at))!==-1){leftovers.push({kind,offset:at});at++;}
 }
 const names=[],oldNameField=source.role.subarray(R.NAME_OFF,R.NAME_OFF+NAME_LEN),nul=oldNameField.indexOf(0),oldName=oldNameField.subarray(0,nul<0?NAME_LEN:nul);
 if(oldName.length&&!oldName.equals(t.nameBytes)){let at=0;while((at=cleanRole.indexOf(oldName,at))!==-1){names.push(at);at++;}}
 return {role:cleanRole,heroWire:wire,heroFrame:heroesFrame(wire),equipmentFrames:equipmentFrames(t),profileFrame:sourceProfile?profile(sourceProfile,t):null,
  attributeFrames:(source.attributeFrames||[]).map(frame=>attributes(frame,t)),equipmentSummary:source.equipmentSummary?equipmentSummary(source.equipmentSummary,t):null,
  ownedHeroIds:[...HERO_IDS],ownedSkinIds:[],walletAttributes:Object.fromEntries(WALLET_ATTRIBUTES.map(id=>[id,0])),
  baseline:{level:1,experience:0,vip:0,roleSha256:sha(cleanRole)},audit:{sourceRoleSha256:sha(source.role),sourceHeroWireSha256:sha(JSON.stringify(sourceHeroes)),sourceProfileSha256:sourceProfile?sha(sourceProfile):null,
   equipmentRecordsCleared:EQUIP_COUNT,bagRecordsCleared:BAG_COUNT,opaqueHeroTailRemovedBytes:sourceHeroes.tailHex.length/2,knownIdentityPatternRemainders:leftovers,knownNamePatternRemainders:names,neutralSessionMetadata:true,
   opaqueRoleRegionsPreserved:true,profileUnavailable:!sourceProfile,publicPublicationReviewed:false}};
}
module.exports={prepare,role,heroWire,heroesFrame,equipmentFrames,equipmentSummary,attributes,profile,emptyEquipmentRecord,HERO_IDS,PID_OFFSETS,WALLET_ATTRIBUTES,ROLE_BYTES,WORLD_OFF,BAG_BASE,BAG_STRIDE,BAG_COUNT,EQUIP_BASE,EQUIP_STRIDE,EQUIP_COUNT};
