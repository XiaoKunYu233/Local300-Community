'use strict';
const P=require('./battle-protobuf');
// Native 109f030 serializes recent rows; e4a010 copies them to 40-byte
// cache entries, e48590 passes them to SetLastFightInfo. These three modes
// share that presentation. Mode 3 overrides a statistic; do not generalize.
const modes=Object.freeze({0:'arena',1:'battlefield',7:'aram'});
function scalar(fields,number,max=0xffffffffn){
  const matches=fields.filter(f=>f.number===number);
  if(matches.length!==1||matches[0].wire!==0||matches[0].value<0n||matches[0].value>max)throw Error('Invalid native recent-match field '+number);
  return matches[0].value;
}
function decodeRow(bytes){
  const fields=P.decode(bytes),heroId=Number(scalar(fields,1,65535n)),result=Number(scalar(fields,2));
  if(!heroId||result>2)throw Error('Invalid native recent-match identity or result');
  return {heroId,result,won:result===0?null:result===1,kills:Number(scalar(fields,3)),
    assists:Number(scalar(fields,4)),monsterCount:Number(scalar(fields,5)),
    playedAt:Number(scalar(fields,6))*1000,replayId:scalar(fields,7,0xffffffffffffffffn).toString()};
}
function modeFields(profile,mode){
  if(!Object.hasOwn(modes,mode))throw Error('Unmapped native profile mode');
  const groups=profile.fields.filter(f=>f.number===12);
  if(groups.length!==13||groups.some(f=>f.wire!==2))throw Error('Invalid native profile modes');
  return P.decode(groups[mode].bytes);
}
function recent(profile,mode){
  const rows=modeFields(profile,mode).filter(f=>f.number===2);
  if(rows.some(f=>f.wire!==2))throw Error('Invalid native recent-match records');
  // Client consumes the final 20 entries in reverse wire order.
  return rows.slice(-20).reverse().map(f=>decodeRow(f.bytes));
}
function summary(profile,mode){
  const fields=modeFields(profile,mode),wins=Number(scalar(fields,3)),matches=Number(scalar(fields,4));
  if(wins>matches)throw Error('Invalid native profile totals');
  const heroes=fields.filter(f=>f.number===1).slice(0,4).map(f=>{
    if(f.wire!==2)throw Error('Invalid native common hero');
    const row=P.decode(f.bytes),heroId=Number(scalar(row,1,65535n)),wins=Number(scalar(row,2)),losses=Number(scalar(row,3));
    return {heroId,wins,losses,matches:wins+losses};
  }).filter(row=>row.heroId!==0);
  if(new Set(heroes.map(row=>row.heroId)).size!==heroes.length)throw Error('Duplicate native common hero');
  // These are the server's four displayed heroes, not a full hero ledger.
  return {mode:modes[mode],wins,matches,commonHeroes:heroes};
}
module.exports={modes,decodeRow,recent,summary};
