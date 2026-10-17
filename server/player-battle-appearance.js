'use strict';
const path=require('path'),{PlayerAccounts,owns}=require('./player-account-state');
const P=require('./battle-protobuf'),W=require('./battle-wire'),B=require('./battle-protocol');
const {rosterSkills}=require('./battle-selection-native');
function configuredAccount(){
  if(!process.env.DSH_PLAYER_ACCOUNTS)return null;
  const a=new PlayerAccounts(path.resolve(process.env.DSH_PLAYER_ACCOUNTS)).get(Number(process.env.DSH_PLAYER_UID));
  if(!a?.heroWire)throw Error('Battle account identity or hero migration does not match');
  return a;
}
function accountFor(playerId){const a=configuredAccount();if(a&&a.playerId!==playerId)throw Error('Battle account identity or hero migration does not match');return a;}
function selectedSkin(account,heroId,now=Date.now()){
  const selected=account.selected['skin:'+heroId];
  if(!owns(account,'heroes',heroId,now)||selected?.kind!=='skins'||Math.floor(selected.id/128)!==heroId||!owns(account,'skins',selected.id,now))return 0;
  const index=selected.id%128;return index>0&&index<32?index:0;
}
function resolve(playerId,heroId,now=Date.now()){
  const a=accountFor(playerId);if(!a)return null;
  if(!owns(a,'heroes',heroId,now))throw Error('Selected battle hero is not owned or has expired');
  return {uid:a.uid,playerId,name:a.name,heroId,skinId:selectedSkin(a,heroId,now),...require('./player-title-wire').display(a,now)};
}
// Native roster 65dc98/65dcd3: hero +0x27 and skin +0x29 relative to
// each record, actor +0x1b. Identity 23512 and hero spawn agree with captures.
// Status 11007 protobuf field 11 also controls form/status visual appearance.
function patch(frame,appearance){
  if(!appearance)return Buffer.from(frame);
  const {playerId,heroId,skinId,titleId,hidden}=appearance,tag=frame.readUInt16LE(8);
  if(!Number.isInteger(skinId)||skinId<0||skinId>31)throw Error('Invalid saved battle skin');
  if(titleId!==undefined&&(!Number.isInteger(titleId)||titleId<0||titleId>65535||typeof hidden!=='boolean'))throw Error('Invalid saved battle title');
  const out=appearance.name?require('./player-battle-identity').patch(frame,playerId,appearance):Buffer.from(frame);
  if(tag===23512&&out.length>=20&&out.readUInt32LE(12)===playerId&&out.readUInt16LE(16)===heroId)out.writeUInt16LE(skinId,18);
  const row=rosterSkills(out,playerId);
  if(row&&out.readUInt16LE(row.actorOffset+12)===heroId)out.writeUInt16LE(skinId,row.actorOffset+14);
  if(out.readUInt32LE(4)!==playerId)return out;
  const spawn=B.readSpawn(out);
  if(tag===1052&&spawn?.kind==='hero'){
    if(spawn.heroId===heroId)out.writeUInt16LE(skinId,12+spawn.offset+36);
    if(titleId!==undefined){out.writeUInt16LE(titleId,12+spawn.offset+58);out[12+spawn.offset+60]=Number(!hidden);}
  }
  if(tag===11007){
    if(out.length<13||out[12]!==out.length-13)throw Error('Invalid hero appearance status');
    const fields=P.decode(out.subarray(13)),target=P.get(fields,3);
    if((target===heroId||target===undefined&&P.get(fields,11)!==undefined)){
      const bytes=P.encode(P.set(fields,11,skinId));if(bytes.length>255)throw Error('Appearance status too long');
      return W.frame(tag,playerId,Buffer.concat([Buffer.from([bytes.length]),bytes]),out.readUInt16LE(10));
    }
  }
  return out;
}
function patchIntro(frames,playerId){
  const a=accountFor(playerId);if(!a)return frames.map(frame=>Buffer.from(frame));
  return frames.map(frame=>{
    const tag=frame.readUInt16LE(8);let hero;
    if(tag===23512&&frame.readUInt32LE(12)===playerId)hero=frame.readUInt16LE(16);
    else if(tag===11007&&frame.readUInt32LE(4)===playerId)hero=P.get(P.decode(frame.subarray(13)),3);
    if(hero)return patch(frame,{playerId,uid:a.uid,name:a.name,heroId:hero,skinId:selectedSkin(a,hero),...require('./player-title-wire').display(a)});
    return require('./player-battle-identity').patch(frame,playerId,a);
  });
}
module.exports={configuredAccount,accountFor,selectedSkin,resolve,patch,patchIntro};
