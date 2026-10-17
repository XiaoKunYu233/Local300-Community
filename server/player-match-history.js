'use strict';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const uint=value=>Number.isSafeInteger(value)&&value>=0;
function sameResult(prior,incoming){
  const {completedAt:ignored,...before}=prior,{completedAt:ignored2,...after}=incoming;
  // Additive fields were not saved by older versions. A retry must retain
  // the original receipt and unknown values, never silently enrich history.
  for(const key of ['minionLastHits','combat','mode'])if(!Object.hasOwn(before,key))delete after[key];
  return require('node:util').isDeepStrictEqual(before,after);
}
function combatStats(p){
  if(p.damageDealt===undefined)return undefined; // Older durable results.
  const row={damageDealt:{...p.damageDealt},structuresDestroyed:{...p.structuresDestroyed},
    damageTaken:p.damageTaken,damageTakenFromPlayer:p.damageTakenFromPlayer,totalHeal:p.totalHeal};
  validateCombat(row);return row;
}
function validateCombat(row){
  const amount=n=>Number.isFinite(n)&&n>=0;
  if(!row||!row.damageDealt||!row.structuresDestroyed||
    !['hero','minion','building'].every(k=>amount(row.damageDealt[k]))||
    !['tower','barracks','base'].every(k=>uint(row.structuresDestroyed[k]))||
    !['damageTaken','damageTakenFromPlayer','totalHeal'].every(k=>amount(row[k]))||
    row.damageTakenFromPlayer>row.damageTaken)throw Error('Invalid account combat statistics');
}
function validate(history,playerId){
  if(history?.version!==1||!history.matches||typeof history.matches!=='object'||Array.isArray(history.matches))throw Error('Invalid account match history');
  for(const [id,row]of Object.entries(history.matches)){
    const complete=row.status==='completed'&&row.endReason==='base-destroyed'&&typeof row.won==='boolean'&&uint(row.kills)&&uint(row.deaths)&&Number.isFinite(row.durationSeconds)&&row.durationSeconds>=0;
    const incomplete=row.status==='incomplete'&&['left','disconnected','server-restarted'].includes(row.endReason)&&row.won===null&&row.kills===null&&row.deaths===null&&(row.durationSeconds===null||Number.isFinite(row.durationSeconds)&&row.durationSeconds>=0);
    if(!uuid(id)||row.matchId!==id||row.playerId!==playerId||(!complete&&!incomplete)||
      !uint(row.mapId)||!row.mapId||(!(uint(row.heroId)&&row.heroId>0)&&!(incomplete&&row.heroId===null))||!uint(row.completedAt)||row.assists!==null)throw Error('Invalid account match record');
    if(row.minionLastHits!==undefined&&!(complete?uint(row.minionLastHits):row.minionLastHits===null))throw Error('Invalid account minion statistic');
    if(row.combat!==undefined){if(!complete)throw Error('Incomplete match has combat statistics');validateCombat(row.combat);}
    if(row.mode!==undefined&&(typeof row.mode!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(row.mode)))throw Error('Invalid account match mode');
  }
  return history;
}
// Only a trusted server-side match result may reach this adapter. No client
// request supplies wins or statistics; incomplete sessions are not victories.
function normalize(result,playerId){
  if(!result||!uuid(result.matchId)||result.endReason!=='base-destroyed'||![1,2].includes(result.winningTeam)||
    !uint(result.mapId)||!result.mapId||!Number.isFinite(result.battleDurationSeconds)||result.battleDurationSeconds<0||
    !Array.isArray(result.players)||result.self?.playerId!==playerId)throw Error('Untrusted or incomplete account result');
  const players=result.players.filter(row=>row.playerId===playerId);
  if(players.length!==1)throw Error('Account result participant mismatch');
  const p=players[0];if(![1,2].includes(p.team)||p.heroId!==result.self.heroId||p.team!==result.self.team||!uint(p.heroId)||!p.heroId||!uint(p.heroKills)||!uint(p.heroDeaths))throw Error('Invalid account result statistics');
  if(p.minionLastHits!==undefined&&!uint(p.minionLastHits))throw Error('Invalid account minion statistic');
  const combat=combatStats(p);
  return {matchId:result.matchId,playerId,status:'completed',endReason:result.endReason,mapId:result.mapId,heroId:p.heroId,
    won:p.team===result.winningTeam,durationSeconds:result.battleDurationSeconds,kills:p.heroKills,deaths:p.heroDeaths,assists:null,
    ...(p.minionLastHits===undefined?{}:{minionLastHits:p.minionLastHits}),...(combat===undefined?{}:{combat}),
    ...(result.mode===undefined?{}:{mode:result.mode})};
}
function record(store,uid,result,completedAt=Date.now()){
  const account=store.get(uid);if(!account)throw Error('Unknown result account');
  if(!uint(completedAt))throw Error('Invalid match completion time');
  const row=normalize(result,account.playerId);
  return recordEntry(store,uid,{...row,completedAt});
}
function recordEntry(store,uid,entry){
  const account=store.get(uid);if(!account)throw Error('Unknown result account');
  validate({version:1,matches:{[entry.matchId]:entry}},account.playerId);
  const prior=account.matchHistory?.matches[entry.matchId];
  if(prior){
    if(!sameResult(prior,entry))throw Error('Match retried with different payload');
    entry=prior;
  }
  const {completedAt,...row}=entry;
  return store.update(uid,{eventId:'match:'+row.matchId,payload:row},a=>{
    const history=a.matchHistory??={version:1,matches:{}};validate(history,a.playerId);
    if(Object.hasOwn(history.matches,row.matchId))throw Error('Match record exists without matching receipt');
    history.matches[row.matchId]={...row,completedAt};validate(history,a.playerId);
  });
}
function recent(account,limit=20){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid recent-match limit');
  if(!account.matchHistory)return [];
  return Object.values(validate(account.matchHistory,account.playerId).matches).sort((a,b)=>b.completedAt-a.completedAt||a.matchId.localeCompare(b.matchId)).slice(0,limit).map(row=>structuredClone(row));
}
function summary(account,{mapId,heroId,mode}={}){
  const rows=account.matchHistory?Object.values(validate(account.matchHistory,account.playerId).matches):[];
  return rows.filter(row=>row.status==='completed'&&(mapId===undefined||row.mapId===mapId)&&(heroId===undefined||row.heroId===heroId)&&(mode===undefined||row.mode===mode))
    .reduce((out,row)=>{out.matches++;row.won?out.wins++:out.losses++;out.kills+=row.kills;out.deaths+=row.deaths;
      out.minionLastHits=out.minionLastHits===null||row.minionLastHits===undefined?null:out.minionLastHits+row.minionLastHits;return out;},
      {matches:0,wins:0,losses:0,kills:0,deaths:0,assists:null,minionLastHits:0});
}
module.exports={validate,normalize,record,recordEntry,recent,summary,sameResult};
