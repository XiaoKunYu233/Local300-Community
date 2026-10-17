'use strict';
const wire=require('./player-profile-wire'),snapshots=require('./player-profile-snapshot');
function needsHistoryMerge(account){
  if(account.matchHistory===undefined)return false;
  const history=require('./player-match-history').validate(account.matchHistory,account.playerId);
  // Interrupted sessions carry no result statistics and add no native recent
  // match row. Keep the interruption audit without hiding unaffected profile data.
  return Object.values(history.matches).some(row=>row.status==='completed');
}
function current(profile,account,now=Date.now(),avatarPolicy){
  if(account.name!==undefined){
    // Native20513 identity field4 is the GBK role name. The persisted account
    // name, rather than an older observed nickname, owns the current display.
    const bytes=require('./player-battle-identity').nameBytes(account.name);
    const rows=profile.fields.filter(field=>field.number===4);if(rows.length!==1||rows[0].wire!==2)throw Error('Invalid profile name field');
    profile.fields=profile.fields.map(field=>field.number===4?{...field,bytes:Buffer.from(bytes)}:field);profile.nameBytes=Buffer.from(bytes);
  }
  // 109c010 decodes fields 8/9/10 into +24/+28/+48; e4a742..
  // e4a90d supplies those members as level/VIP/currentExp to SetHeroInfo.
  const values=new Map();
  if(account.growth!==undefined){const g=require('./player-growth-wire').validate(account.growth,account);values.set(8,g.level);if(g.experience!==undefined)values.set(10,g.experience);}
  if(account.vip!==undefined)values.set(9,require('./player-vip-wire').validate(account.vip,account).level);
  const P=require('./battle-protobuf');
  if(account.avatarState!==undefined)values.set(5,require('./player-avatar').selected(account,avatarPolicy,now));
  for(const [number,value]of values){
    const rows=profile.fields.filter(f=>f.number===number);
    if(rows.length!==1||rows[0].wire!==0)throw Error('Invalid profile growth field '+number);
    profile.fields=P.set(profile.fields,number,value);
  }
  if(account.avatarFrameState!==undefined)profile.fields=require('./player-avatar-frame').profileFields(profile.fields,account,now);
  // Native 20513 parser 109c8e1/109c971 reads repeated u32 field21;
  // e49759 displays at most four equipped medal IDs in this own profile.
  // It establishes no ownership and preserves the original profile identity.
  if(account.medalState!==undefined){
    profile.fields=profile.fields.filter(field=>field.number!==21);
    for(const id of require('./player-medals').effectiveEquipped(account,now))profile.fields.push({number:21,wire:0,value:BigInt(id)});
  }
  return wire.pack(profile);
}
function reply(account,request,{avatarPolicy}={}){
  const target=wire.request(request);
  if(target.playerId!==account.playerId)throw Error('Profile target is outside this account');
  if(!account.profileSnapshot)throw Error('No verified profile snapshot');
  const profile=snapshots.validate(account.profileSnapshot,account);
  if(target.serverId!==profile.serverId)throw Error('Profile server mismatch');
  // Do not present an old baseline as current after local matches exist.
  if(needsHistoryMerge(account))throw Error('Profile history merge is not implemented');
  return current(profile,account,Date.now(),avatarPolicy);
}
function outbound(account,frame,{avatarPolicy}={}){
  try{
    if(!account?.profileSnapshot||needsHistoryMerge(account))return null;
    const profile=snapshots.validate(account.profileSnapshot,account);
    wire.unpack(frame,account);
    const baseline=wire.pack(profile);
    const updated=current(profile,account,Date.now(),avatarPolicy);
    return frame.equals(baseline)||frame.equals(updated)?updated:null;
  }catch{return null;}
}
module.exports={reply,outbound};
