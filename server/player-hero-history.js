'use strict';
const heroes=require('./player-heroes'),native=require('./player-profile-history');
// 1337 decoder e288a0: packed arrays at +57/+109 become aligned +3c/+70.
// e20970 copies 13 values into the profile cache. XHeroDetailType
// (1491e91..1499233e) exposes wins/total from those arrays to Lua.
function read(account,mode){
  if(!Object.hasOwn(native.modes,mode))throw Error('Unmapped hero history mode');
  heroes.validateWire(account.heroWire);
  return account.heroWire.order.map(heroId=>{
    const bytes=Buffer.from(account.heroWire.records[heroId],'hex');
    const wins=bytes.readUInt32LE(57+mode*4),matches=bytes.readUInt32LE(109+mode*4);
    if(wins>matches)throw Error('Invalid captured hero history');
    return {heroId,wins,matches};
  });
}
function compare(account,profile,mode){
  const rows=read(account,mode),total=native.summary(profile,mode);
  const observed=rows.reduce((sum,row)=>({wins:sum.wins+row.wins,matches:sum.matches+row.matches}),{wins:0,matches:0});
  const mismatchedHeroes=total.commonHeroes.filter(hero=>{
    const row=rows.find(row=>row.heroId===hero.heroId);return !row||row.wins!==hero.wins||row.matches!==hero.matches;
  }).map(row=>row.heroId);
  // Equal sums are consistency evidence, not proof of a complete roster or
  // equal snapshot times. Never zero-fill an unlisted hero using this result.
  return {rows,observed,profile:{wins:total.wins,matches:total.matches},
    totalsAgree:observed.wins===total.wins&&observed.matches===total.matches,mismatchedHeroes};
}
function overlays(account){
  const result=new Map();if(!account.matchHistory)return result;
  const rows=Object.values(require('./player-match-history').validate(account.matchHistory,account.playerId).matches);
  for(const row of rows){
    if(row.status!=='completed')continue;
    const mode=Object.keys(native.modes).find(key=>native.modes[key]===row.mode);
    if(mode===undefined)throw Error('Hero history needs an explicit mapped mode');
    if(!Number.isSafeInteger(account.migration?.capturedAt)||row.completedAt<=account.migration.capturedAt)throw Error('Hero history overlaps capture baseline');
    const original=account.heroWire.records[row.heroId];if(!original)throw Error('Hero history baseline missing');
    const bytes=result.get(row.heroId)||Buffer.from(original,'hex'),winAt=57+Number(mode)*4,totalAt=109+Number(mode)*4;
    const wins=bytes.readUInt32LE(winAt),matches=bytes.readUInt32LE(totalAt);
    if(wins>matches||matches===0xffffffff)throw Error('Hero history totals invalid or overflowing');
    bytes.writeUInt32LE(wins+(row.won?1:0),winAt);bytes.writeUInt32LE(matches+1,totalAt);result.set(row.heroId,bytes);
  }
  return result;
}
module.exports={read,compare,overlays};
