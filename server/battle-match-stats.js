'use strict';
const {randomUUID}=require('crypto');

const buildings=new Set(['tower','barracks','base','fountain']);
const unsupported=Object.freeze({killStreakRewards:'unsupported',
  experience:'unsupported',accountCurrencyRewards:'unsupported',medals:'unsupported'});
const elapsed=(start,end)=>Math.round((end-start)*1e6)/1e6;
function equipmentEntries(entity){
  const slots=Array.isArray(entity?.loadout?.slots)?entity.loadout.slots:[];
  const validSlots=slots.map(item=>({...item,guid:Buffer.isBuffer(item.guid)?item.guid.toString('hex'):item.guid})).filter(item=>/^[0-9a-f]{16}$/i.test(item.guid||'')&&!/^0+$/.test(item.guid));
  const records=entity?.loadout?require('./battle-equipment').equipmentPackets(entity.id,{...entity.loadout,slots:validSlots}):null;
  return Array.from({length:6},(_,slot)=>{
    const item=slots.find(entry=>entry?.slot===slot);
    if(!item)return {slot,itemId:0,count:0,onlyIdLow:0,onlyIdHigh:0};
    // Inventory/loadout GUID strings preserve the original eight byte order.
    // Preserve missing/invalid identity as unavailable rather than forging zero.
    const raw=Buffer.isBuffer(item.guid)?Buffer.from(item.guid):
      typeof item.guid==='string'&&/^[0-9a-f]{16}$/i.test(item.guid)?Buffer.from(item.guid,'hex'):null;
    if(!raw||raw.length!==8||raw.every(v=>v===0))
      return {slot,itemId:Number(item.itemId)||0,count:Number(item.count)||0,
        onlyIdLow:null,onlyIdHigh:null,unavailable:'invalid-instance-guid'};
    return {slot,itemId:Number(item.itemId)||0,count:Number(item.count)||0,
      nativeRecordHex:records?.[slot].subarray(13).toString('hex'),onlyIdLow:raw.readUInt32LE(0),onlyIdHigh:raw.readUInt32LE(4)};
  });
}
function freezeDeep(value) {
  if(ArrayBuffer.isView(value))return value;
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

class BattleMatchStats {
  constructor({matchId=randomUUID(),mapId,mode,players,selfPlayerId=null},entities) {
    if(typeof matchId!=='string'||!matchId||!Number.isInteger(mapId)||mapId<=0||!Array.isArray(players)||!players.length)
      throw new Error('Invalid match identity');
    this.matchId=matchId;this.mapId=mapId;this.selfPlayerId=selfPlayerId;this.players=new Map();
    if(mode!==undefined&&(typeof mode!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(mode)))throw Error('Invalid match mode');
    this.mode=mode;this.entities=entities;this.teamScores={1:0,2:0};this.contributions=new WeakMap();this.committedDeaths=new WeakMap();
    this.startedAt=null;this.result=null;this.incomplete=null;
    const counts={1:0,2:0};
    for(const player of players){
      if(![1,2].includes(player.team)||++counts[player.team]>7)throw Error('Battle supports at most seven heroes per team');
      const {playerId,heroId,team,summonerSkills,nameBytes}=player,entity=entities.get(playerId);
      if(!Number.isInteger(playerId)||!Number.isInteger(heroId)||!entity||entity.kind!=='hero'||entity.team!==team||
        (entity.heroId!==undefined&&entity.heroId!==heroId)||
        this.players.has(playerId)||!summonerSkills||typeof summonerSkills!=='object')
        throw new Error(`Invalid match participant ${playerId}`);
      this.players.set(playerId,{
      playerId,heroId,team,nameBytes:nameBytes?Buffer.from(nameBytes):undefined,summonerSkills:{...summonerSkills},
        heroKills:0,heroDeaths:0,heroAssists:0,score:0,minionLastHits:0,
        structuresDestroyed:{tower:0,barracks:0,base:0},
        damageDealt:{hero:0,minion:0,building:0},damageTaken:0,damageTakenFromPlayer:0,totalHeal:0,goldEarned:0,
      });
    }
  }
  start(time){
    if(this.startedAt!==null||this.result||this.incomplete)throw new Error('Match already started or ended');
    if(!Number.isFinite(time)||time<0)throw new Error('Invalid match start time');
    this.startedAt=time;
  }
  recordDamage(attacker,target,amount,time=this.startedAt){
    if(this.startedAt===null||this.result||this.incomplete||!(amount>0))return;
    const dealt=this.players.get(attacker.id),taken=this.players.get(target.id);
    if(dealt&&target.kind==='hero'&&attacker.team!==target.team&&this.entities.get(attacker.id)===attacker&&this.entities.get(target.id)===target&&Number.isFinite(time)){
      let ledger=this.contributions.get(target);
      if(!ledger||ledger.life!==target.reviveCount){ledger={life:target.reviveCount,contributors:new Map()};this.contributions.set(target,ledger);}
      ledger.contributors.set(attacker.id,{entity:attacker,life:attacker.reviveCount,time});
    }
    if(dealt&&attacker.kind==='hero'){
      const category=buildings.has(target.kind)?'building':target.kind;
      if(Object.hasOwn(dealt.damageDealt,category))dealt.damageDealt[category]+=amount;
    }
    if(taken&&target.kind==='hero'){
      taken.damageTaken+=amount;
      if(attacker.kind==='hero')taken.damageTakenFromPlayer+=amount;
    }
  }
  recordHeal(target,amount){
    if(this.startedAt===null||this.result||this.incomplete||!(amount>0))return;
    const healed=this.players.get(target.id);
    if(healed&&target.kind==='hero')healed.totalHeal+=amount;
  }
  recordDeath(attacker,target,goldAwarded,time=this.startedAt){
    if(this.startedAt===null||this.result||this.incomplete)return;
    if(this.entities.get(target.id)!==target||this.entities.get(attacker.id)!==attacker||attacker.team===target.team)return;
    const life=target.reviveCount??0;
    if(this.committedDeaths.get(target)===life)return;
    this.committedDeaths.set(target,life);
    const killer=this.players.get(attacker.id),victim=this.players.get(target.id);
    if(victim&&target.kind==='hero')victim.heroDeaths++;
    if(target.kind==='hero'){
      const ledger=this.contributions.get(target);
      if(ledger?.life===target.reviveCount&&Number.isFinite(time))for(const [id,c] of ledger.contributors){
        const record=this.players.get(id);
        if(id!==attacker.id&&record&&record.team===attacker.team&&c.entity.team===attacker.team&&this.entities.get(id)===c.entity&&c.entity.reviveCount===c.life&&time>=c.time&&time-c.time<=10)record.heroAssists++;
      }
      this.contributions.delete(target);
    }
    const points=this.mapId===252&&this.mode!=='arena'?require('./battle-score-native').pointsFor(target):0;
    if(points&&[1,2].includes(attacker.team))this.teamScores[attacker.team]=Math.min(3000,this.teamScores[attacker.team]+points);
    if(!killer||attacker.kind!=='hero')return;
    if(target.kind==='hero')killer.heroKills++;
    else if(target.kind==='minion')killer.minionLastHits++;
    else if(Object.hasOwn(killer.structuresDestroyed,target.kind))killer.structuresDestroyed[target.kind]++;
    killer.score+=points;
    killer.goldEarned+=Number.isFinite(goldAwarded)?goldAwarded:0;
  }
  finish(winningTeam,time,entities){
    if(this.result)return this.result;
    if(this.startedAt===null||this.incomplete)return null;
    if(!Number.isInteger(winningTeam)||!Number.isFinite(time)||time<this.startedAt)
      throw new Error('Invalid match finish');
    const players=[...this.players.values()].filter(p=>{const e=entities.get(p.playerId);return e&&(!e.battleBot||e.bot?.entered);}).map(p=>({
      ...p,assists:p.heroAssists,totalEconomy:p.goldEarned,summonerSkills:{D:entities.get(p.playerId).skills?.D?.id??p.summonerSkills.D,F:entities.get(p.playerId).skills?.F?.id??p.summonerSkills.F},structuresDestroyed:{...p.structuresDestroyed},
      damageDealt:{...p.damageDealt},equipmentEntries:equipmentEntries(entities.get(p.playerId)),
      goldAtEnd:entities.get(p.playerId).gold,unsupported:{...unsupported},
    }));
    const teams={1:players.filter(player=>player.team===1),2:players.filter(player=>player.team===2)};
    const selfPlayer=players.find(player=>player.playerId===this.selfPlayerId)||null;
    const sideSize=Math.max(1,teams[1].length,teams[2].length);
    const selfRecordSlot=selfPlayer
      ? teams[selfPlayer.team].findIndex(player=>player.playerId===selfPlayer.playerId)+(selfPlayer.team===1?0:sideSize)
      : null;
    this.result=freezeDeep({matchId:this.matchId,mapId:this.mapId,...(this.mode===undefined?{}:{mode:this.mode}),winningTeam,
      endReason:'base-destroyed',scoreA:this.teamScores[1],scoreB:this.teamScores[2],battleDurationSeconds:elapsed(this.startedAt,time),players,teams,
      self:selfPlayer?{playerId:selfPlayer.playerId,heroId:selfPlayer.heroId,team:selfPlayer.team,recordSlot:selfRecordSlot}:null,
      selfRecordSlot});
    return this.result;
  }
  abort(reason,time){
    if(this.result||this.incomplete)return this.incomplete;
    if(typeof reason!=='string'||!reason)throw new Error('Invalid incomplete-match reason');
    this.incomplete=freezeDeep({status:'incomplete',reason,
      battleDurationSeconds:this.startedAt===null?0:Math.max(0,elapsed(this.startedAt,time))});
    return this.incomplete;
  }
}
module.exports={BattleMatchStats};
