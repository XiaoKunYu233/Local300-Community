'use strict';

// MSG_S2C_NVN_END_ATH is a fixed native structure rather than a protobuf
// list. The client scans 60 records at frame+0x0e with a 0xe40 stride.
// Keep raw bytes available when decoding so unconfirmed fields remain stable.
const SLOTS=60,STRIDE=0xe40,PAYLOAD_BYTES=2+SLOTS*STRIDE+28;
const W=require('./battle-wire');
// Native c527 scans a variable side width. Map 252 supports 1..7 per
// populated side, including a single player with an empty opposing side.
const GENERATION_READY=true;
function runtimePackets(result){
 if(result?.mapId!==252||!Array.isArray(result.players)||!result.players.length)return [];
 return [encode(result)];
}

// Corrected against c527 client 1279. Handler references use frame+slot*stride;
// the record origin is 14 bytes later. See FIELD-EVIDENCE.json.
// LEGACY_F preserves old numerical offsets solely for interpreting old reports.
// It is not an encoder contract.
const LEGACY_F=Object.freeze({
  unknownDword21:0x21,isWin:0x23,outcome:0x23,unknownDword25:0x25,
  pushTowerSelf:0x2b,totalEconomy:0x2f,gold:0x2f,kgGoal:0x33,
  equipmentEntries:0x3e,heroDamage:0xc1b,totalDamage:0xc1f,damageTaken:0xc23,
  totalHeal:0xc27,damageTakenFromPlayer:0xc45,summonerSkills:0xe2e,
  sameHero:0xe2d,worldguid:0xe32,roomCard:0xe36,camp:0xe3a,
});
const F=Object.freeze({
  actor:0x00,name:0x04,heroId:0x13,resultSide:0x15,isWin:0x15,outcome:0x15,
  heroKills:0x17,heroDeaths:0x19,assists:0x1b,towers:0x1d,pushTowerSelf:0x1d,minions:0x1f,
  totalEconomy:0x21,gold:0x21,kgGoal:0x25,unknownWord29:0x29,unknownWord2b:0x2b,
  equipmentEntries:0x30,equipmentEntryStride:497,
  heroDamage:0xc0d,totalDamage:0xc11,damageTaken:0xc15,totalHeal:0xc19,
  resultUiCounter:0xc32,damageTakenFromPlayer:0xc37,fv:0xd2b,
  summonerSkills:0xe20,skills:0xe20,sameHero:0xe1f,worldguid:0xe24,roomCard:0xe28,
  team:0xe2c,nativeTeam:0xe2c,camp:0xe2c,groupKey:0xe3c,
});

function validateFrame(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==12+PAYLOAD_BYTES||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==23510)
    throw new Error('Invalid native battle result');
}
function finiteUInt(value,max){return Number.isFinite(value)&&value>=0&&value<=max?Math.floor(value):null;}
function writeUInt(record,offset,value,bytes=4){
  const n=finiteUInt(value,bytes===2?0xffff:0xffffffff);
  if(n===null)throw Error('Invalid result statistic');
  if(bytes===2)record.writeUInt16LE(n,offset);else record.writeUInt32LE(n,offset);
}
function slotsFor(result){
  // Captures group records by the native camp u32: team 1 first, team 2
  // second.  The client result-side byte at +0x15 independently selects the
  // victory/defeat UI for the current record; it is not a team enum.
  const team1=result.players.filter(p=>p.team===1);
  const team2=result.players.filter(p=>p.team===2);
  const sideSize=Math.max(1,team1.length,team2.length);
  if(result.players.some(p=>![1,2].includes(p.team))||new Set(result.players.map(p=>p.playerId)).size!==result.players.length)throw Error('Invalid or duplicate result participant');
  if(sideSize>7)throw Error('Result sides exceed native record capacity');
  return {sideSize,entries:[...team1.map((player,i)=>[i,player]),...team2.map((player,i)=>[sideSize+i,player])]};
}
function frameFor(header,payload){
  if(Buffer.isBuffer(header)&&header.length>=12)
    return W.frame(header.readUInt16LE(8),header.readUInt32LE(4),payload,header.readUInt16LE(10));
  return W.frame(23510,0,payload);
}
function playerName(player,names){
  const name=player.nameBytes||names.get(player.playerId)||Buffer.from('Player');
  if(!Buffer.isBuffer(name)||name.length>15||name.includes(0))throw Error('Invalid native player name');
  return name;
}

function encode(result,{names=new Map(),closeAfterMs=90000}={}){
  // decode() exposes rawPayload only for evidence round trips. Runtime
  // generation never supplies it and therefore never replays a capture.
  if(result&&Buffer.isBuffer(result.rawPayload)){
    if(result.rawPayload.length!==PAYLOAD_BYTES)throw Error('Invalid native battle result payload');
    return frameFor(result.header,Buffer.from(result.rawPayload));
  }
  if(!result||!Array.isArray(result.players)||!result.players.length||result.players.length>SLOTS||![1,2].includes(result.winningTeam))throw Error('Invalid match result');
  const {sideSize,entries}=slotsFor(result),p=Buffer.alloc(PAYLOAD_BYTES);
  // Both original-server samples carry 1 here. Preserve the existing raw-byte
  // convention without identifying it as an ordinary-map gate or winner.
  const resultCode=Number.isInteger(result.resultCode)?result.resultCode:1;
  if(![0,1].includes(resultCode))throw Error('Invalid native result code');
  p[0]=resultCode;p[1]=sideSize;
  for(const [slot,player] of entries){
    if(!Number.isInteger(player.playerId)||player.playerId<=0||!Number.isInteger(player.heroId)||player.heroId<0||![1,2].includes(player.team))
      throw Error(`Invalid native result player ${player.playerId}`);
    const r=p.subarray(2+slot*STRIDE,2+(slot+1)*STRIDE);
    if(Buffer.isBuffer(player.record)){
      if(player.record.length!==STRIDE)throw Error('Invalid native result record');
      player.record.copy(r);
    }
    writeUInt(r,F.actor,player.playerId);r.fill(0,F.name,F.heroId);playerName(player,names).copy(r,F.name);
    writeUInt(r,F.heroId,player.heroId,2);
    r[F.resultSide]=player.resultSide??(player.team===result.winningTeam?1:2);
    if(![1,2].includes(r[F.resultSide]))throw Error('Invalid native result side');
    // rawIsWin, if supplied, is now the same source byte as resultSide.
    // The historical record+0x23 read was inside totalEconomy, not an outcome.
    if(player.rawIsWin!==undefined&&player.rawIsWin!==r[F.resultSide])throw Error('Conflicting result-side aliases');
    const camp=player.camp??player.nativeTeam??player.team;
    if(camp!==player.team||(player.nativeTeam!==undefined&&player.nativeTeam!==camp))throw Error('Conflicting native camp aliases');
    writeUInt(r,F.camp,camp);
    // No replay-derived 0xffff0000, kgGoal=256 or groupKey=-1 defaults.
    // Unknown fields remain unpopulated unless a trusted adapter supplies them.
    for(const [field,offset] of [['worldguid',F.worldguid],['roomCard',F.roomCard],['groupKey',F.groupKey],['kgGoal',F.kgGoal]])
      if(player[field]!==undefined)writeUInt(r,offset,player[field]);
    if(player.sameHero!==undefined){
      const value=finiteUInt(player.sameHero,0xff);
      if(value===null)throw Error('Invalid sameHero');
      r[F.sameHero]=value;
    }
    if(player.pushTowerSelf!==undefined&&player.structuresDestroyed?.tower!==undefined&&player.pushTowerSelf!==player.structuresDestroyed.tower)
      throw Error('Conflicting tower aliases');
    if(Array.isArray(player.equipmentEntries)){
      if(player.equipmentEntries.length>6)throw Error('Invalid native result equipment entries');
      for(const entry of player.equipmentEntries){
        if(!entry||!Number.isInteger(entry.slot)||entry.slot<0||entry.slot>=6)throw Error('Invalid native result equipment slot');
        const base=F.equipmentEntries+entry.slot*F.equipmentEntryStride;
        if(entry.nativeRecordHex!==undefined){
          if(typeof entry.nativeRecordHex!=='string'||!/^[0-9a-f]{994}$/i.test(entry.nativeRecordHex))throw Error('Invalid native equipment record');
          const record=Buffer.from(entry.nativeRecordHex,'hex');
          if(record.readUInt32LE(3)!==entry.itemId||record.readUInt32LE(11)!==entry.onlyIdLow||record.readUInt32LE(15)!==entry.onlyIdHigh)throw Error('Conflicting native equipment identity');
          record.copy(r,base-3);
        }
        writeUInt(r,base,entry.itemId??0);writeUInt(r,base+4,entry.count??0);
        writeUInt(r,base+8,entry.onlyIdLow??0);writeUInt(r,base+12,entry.onlyIdHigh??0);
      }
    }
    const stats=[
      [F.heroKills,player.heroKills??0,2],[F.heroDeaths,player.heroDeaths??0,2],[F.assists,player.assists??0,2],
      [F.towers,player.structuresDestroyed?.tower??player.pushTowerSelf??0,2],[F.minions,player.minionLastHits??0,2],
      [F.totalEconomy,player.totalEconomy??0,4],
      [F.heroDamage,player.damageDealt?.hero??0,4],
      [F.totalDamage,player.totalDamage??Object.values(player.damageDealt||{}).reduce((a,b)=>a+(Number.isFinite(b)?b:0),0),4],
      [F.damageTaken,player.damageTaken??0,4],
      [F.totalHeal,player.totalHeal??0,4],
      [F.damageTakenFromPlayer,player.damageTakenFromPlayer??0,4],
    ];
    for(const [offset,value,bytes] of stats)writeUInt(r,offset,value,bytes);
    if(player.unknownDword21!==undefined||player.unknownDword25!==undefined)throw Error('Legacy unknown dword aliases require migration to totalEconomy/kgGoal');
    if(player.unknownWord29!==undefined)writeUInt(r,F.unknownWord29,player.unknownWord29,2);
    if(player.unknownWord2b!==undefined)writeUInt(r,F.unknownWord2b,player.unknownWord2b,2);
    if(player.resultUiCounter!==undefined){
      const counter=finiteUInt(player.resultUiCounter,0xff);
      if(counter===null)throw Error('Invalid native result counter');
      r[F.resultUiCounter]=counter;
    }
    const skills=player.summonerSkills||{};
    writeUInt(r,F.summonerSkills,skills.D??0,2);writeUInt(r,F.summonerSkills+2,skills.F??0,2);
  }
  const footer=p.subarray(2+SLOTS*STRIDE);
  writeUInt(footer,0,closeAfterMs);
  if(Number.isFinite(result.scoreA))writeUInt(footer,4,result.scoreA);
  if(Number.isFinite(result.scoreB))writeUInt(footer,8,result.scoreB);
  if(Buffer.isBuffer(result.battleIdBytes)&&result.battleIdBytes.length<=8)result.battleIdBytes.copy(footer,12);
  else {const id=String(result.matchId||'').replace(/-/g,'');if(/^[a-f0-9]{32}$/i.test(id))Buffer.from(id.slice(0,16),'hex').copy(footer,12);}
  writeUInt(footer,20,result.mapId);writeUInt(footer,24,Number.isFinite(result.battleDurationSeconds)?result.battleDurationSeconds:0);
  return frameFor(result.header,p);
}

function decode(frame,{playerId,winningTeam}={}){
  validateFrame(frame);
  const p=Buffer.from(frame.subarray(12)),players=[];
  for(let slot=0;slot<SLOTS;slot++){
    const record=Buffer.from(p.subarray(2+slot*STRIDE,2+(slot+1)*STRIDE)),id=record.readUInt32LE(F.actor);
    if(!id)continue;
    const nameEnd=record.indexOf(0,F.name),nameBytes=Buffer.from(record.subarray(F.name,nameEnd<0?F.heroId:nameEnd));
    const rawIsWin=record[F.isWin],clientIsWin=2-rawIsWin;
    const nativeTeam=record.readUInt32LE(F.nativeTeam);
    players.push({slot,recordSlot:slot,id,playerId:id,nameBytes,heroId:record.readUInt16LE(F.heroId),resultSide:record[F.resultSide],team:nativeTeam,
      nativeTeam,worldguid:record.readUInt32LE(F.worldguid),roomCard:record.readUInt32LE(F.roomCard),camp:record.readUInt32LE(F.camp),groupKey:record.readUInt32LE(F.groupKey),
      pushTowerSelf:record.readUInt16LE(F.pushTowerSelf),kgGoal:record.readUInt32LE(F.kgGoal),rawIsWin,clientIsWin,
      isWin:rawIsWin===1?true:rawIsWin===2?false:null,outcome:rawIsWin,
      unknownWord29:record.readUInt16LE(F.unknownWord29),unknownWord2b:record.readUInt16LE(F.unknownWord2b),
      // For old evidence comparisons only. These are not business statistics.
      legacyRaw:{record23:record[0x23],record2f:record.readUInt32LE(0x2f),record33:record.readUInt32LE(0x33)},
      heroKills:record.readUInt16LE(F.heroKills),heroDeaths:record.readUInt16LE(F.heroDeaths),assists:record.readUInt16LE(F.assists),
      minionLastHits:record.readUInt16LE(F.minions),structuresDestroyed:{tower:record.readUInt16LE(F.towers),barracks:0,base:0},
      totalEconomy:record.readUInt32LE(F.totalEconomy),
      totalDamage:record.readUInt32LE(F.totalDamage),heroDamage:record.readUInt32LE(F.heroDamage),
      damageTaken:record.readUInt32LE(F.damageTaken),totalHeal:record.readUInt32LE(F.totalHeal),damageTakenFromPlayer:record.readUInt32LE(F.damageTakenFromPlayer),resultUiCounter:record[F.resultUiCounter],
      equipmentEntries:Array.from({length:6},(_,slot)=>{const base=F.equipmentEntries+slot*F.equipmentEntryStride;return {slot,itemId:record.readUInt32LE(base),count:record.readUInt32LE(base+4),onlyIdLow:record.readUInt32LE(base+8),onlyIdHigh:record.readUInt32LE(base+12)};}),
      summonerSkills:{D:record.readUInt16LE(F.summonerSkills),F:record.readUInt16LE(F.summonerSkills+2)},record});
  }
  const footer=Buffer.from(p.subarray(2+SLOTS*STRIDE));
  const self=Number.isInteger(playerId)?players.find(p=>p.id===playerId)||null:null;
  // Retain explicit business winningTeam input. Local UI win/defeat is
  // independently exposed by self.isWin from the record+0x15 source byte.
  const resolvedWinningTeam=[1,2].includes(winningTeam)?winningTeam:null;
  const localWon=self&&resolvedWinningTeam!==null?self.team===resolvedWinningTeam:null;
  return {header:Buffer.from(frame.subarray(0,12)),rawPayload:p,resultCode:p[0],sideSize:p[1],players,
    teams:{1:players.filter(x=>x.team===1),2:players.filter(x=>x.team===2)},winningTeam:resolvedWinningTeam,self,localWon,selfPlayerId:self?.id??null,ownRecordSlot:self?.recordSlot??null,
    footer,elapsed:footer.readUInt32LE(0),closeAfterMs:footer.readUInt32LE(0),scoreA:footer.readUInt32LE(4),scoreB:footer.readUInt32LE(8),
    battleIdBytes:Buffer.from(footer.subarray(12,20)),mapId:footer.readUInt32LE(20),battleDurationSeconds:footer.readUInt32LE(24)};
}

function model(result,{selfPlayerId=null}={}){
  if(!result||!Array.isArray(result.players))throw Error('Invalid match result');
  const {sideSize,entries}=slotsFor(result);
  const players=result.players.map(player=>({...player,recordSlot:entries.find(([,p])=>p.playerId===player.playerId)?.[0]??null}));
  const self=players.find(p=>p.playerId===selfPlayerId)||null;
  return {map:{mapId:result.mapId},winningTeam:result.winningTeam,teams:{1:players.filter(p=>p.team===1),2:players.filter(p=>p.team===2)},players,sideSize,self,selfRecordSlot:self?.recordSlot??null};
}

module.exports={decode,encode,model,runtimePackets,GENERATION_READY,F,LEGACY_F,SLOTS,STRIDE,PAYLOAD_BYTES};
