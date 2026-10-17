'use strict';
// XTimeLimitSkinReq 14ddb70: 11562, u16 hero (14-byte frame).
// e1fe06 dispatches 11563 to e2195c; hero +12, count +14,
// records {skin:u8,remainingSeconds:u32} at +15, stride 5.
// Native registry 115aae6 declares 45 bytes; cache 253c300 is six rows.
const {mkFrame}=require('./bag'),{owns}=require('./player-account-state');
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==45||frame.readUInt32LE(0)!==45||frame.readUInt16LE(8)!==11563)throw Error('Invalid timed skin response');
  const hero=frame.readUInt16LE(12),count=frame[14],rows=[],seen=new Set();
  if(!hero||hero===65535||count>6)throw Error('Invalid timed skin response header');
  for(let i=0;i<count;i++){
    const skin=frame[15+i*5],seconds=frame.readUInt32LE(16+i*5);
    if(!skin||skin>31||seen.has(skin))throw Error('Invalid timed skin response row');
    seen.add(skin);rows.push({skin,seconds});
  }
  return {hero,rows};
}
function importObservation(account,frame,at,source){
  if(!Number.isSafeInteger(at)||at<0||typeof source!=='string'||!source)throw Error('Invalid timed skin observation');
  const {hero,rows}=decode(frame);
  for(const {skin,seconds}of rows){
    const key=hero*128+skin,expiresAt=at+seconds*1000;
    if(!Number.isSafeInteger(expiresAt))throw Error('Invalid timed skin expiry');
    // The collection mask proves availability, not permanence. An explicit
    // timer observation supersedes that initial capture-import assumption.
    account.owned.skins[key]={acquiredAt:account.owned.skins[key]?.acquiredAt??at,expiresAt,source};
    if(!seconds&&account.selected['skin:'+hero]?.id===key)delete account.selected['skin:'+hero];
  }
  return rows.length;
}
function reply(account,payload,now=Date.now()){
  if(!Buffer.isBuffer(payload)||payload.length!==2)throw Error('Invalid timed skin query');
  const hero=payload.readUInt16LE(0);if(!hero||hero===65535)throw Error('Invalid timed skin hero');
  const rows=[];
  for(let skin=1;skin<32;skin++){
    const entry=account.owned.skins[hero*128+skin];
    if(!entry||entry.expiresAt===null)continue;
    const seconds=owns(account,'heroes',hero,now)?Math.max(0,Math.ceil((entry.expiresAt-now)/1000)):0;
    rows.push({skin,seconds:Math.min(0xffffffff,seconds)});
  }
  if(rows.length>6)throw Error('Timed skin list exceeds native six-row capacity');
  const p=Buffer.alloc(33);p.writeUInt16LE(hero);p[2]=rows.length;
  rows.forEach(({skin,seconds},i)=>{p[3+i*5]=skin;p.writeUInt32LE(seconds,4+i*5);});
  return mkFrame(11563,p,{flags:0xd2});
}
module.exports={reply,decode,importObservation};
