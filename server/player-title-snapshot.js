'use strict';
const path=require('node:path'),crypto=require('node:crypto'),native=require('node:fs');
const copy=value=>JSON.parse(JSON.stringify(value));
const canonical=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
function verifiedPath(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw Error('Invalid before-image path');
  const resolved=path.resolve(file),literal=process.platform==='win32'?file.replace(/\//g,'\\'):file;
  if(canonical(resolved)!==(process.platform==='win32'?literal.toLowerCase():literal))throw Error('Noncanonical before-image path');
  for(let cursor=resolved;;cursor=path.dirname(cursor)){
    try{
      if(native.lstatSync(cursor).isSymbolicLink()||canonical(native.realpathSync.native(cursor))!==canonical(cursor))throw Error('Aliased before-image path');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(path.dirname(cursor)===cursor)break;
  }
  return canonical(resolved);
}
// This is the complete committed account, including selection, raw hero wire,
// history and permanent proofs. A display-only title merge is not a hero view.
function committedBefore(current,{pending,file}={}){
  try{
    const wanted=verifiedPath(file);
    if(!pending||pending.version!==1||!Array.isArray(pending.paths)||pending.paths.length<1||pending.paths.length>64||
      typeof pending.kind!=='string'||!/^[a-z0-9-]{1,96}$/.test(pending.kind)||typeof pending.guid!=='string'||pending.guid.length>256||
      typeof pending.stage!=='string'||!/^(?:prepared|(?:failed:)?(?:saving|saved):[a-z0-9-]{1,96}|(?:failed:)?all-files-saved)$/.test(pending.stage)||
      typeof pending.at!=='string'||!Number.isFinite(Date.parse(pending.at)))return null;
    const paths=new Set(),rows=[];
    for(const row of pending.paths){
      if(!row||typeof row.name!=='string'||!/^[a-z0-9-]{1,96}$/.test(row.name))return null;
      const target=verifiedPath(row.file);if(paths.has(target))return null;paths.add(target);
      if(target===wanted)rows.push(row);
    }
    if(rows.length!==1||rows[0].name!=='player-accounts')return null;
    const row=rows[0];
    if(typeof row.beforeBase64!=='string'||row.beforeBase64.length>64*1024*1024||
      typeof row.beforeSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.beforeSha256))return null;
    const bytes=Buffer.from(row.beforeBase64,'base64');
    if(bytes.toString('base64')!==row.beforeBase64||crypto.createHash('sha256').update(bytes).digest('hex')!==row.beforeSha256)return null;
    const ledger=require('./player-account-state').validate(JSON.parse(bytes.toString('utf8'))),prior=ledger.accounts[current.uid];
    if(!prior||prior.uid!==current.uid||prior.playerId!==current.playerId||prior.loginHash!==current.loginHash)return null;
    return copy(prior);
  }catch{return null;}
}
function forHeroes(current,{frozen=false,pending,file,sqlite=false}={}){
  if(!frozen)return current;
  // A physical JSON marker cannot prove a SQLite committed document. Unknown
  // or rollback freezes stay silent; restart reloads DB authority normally.
  if(sqlite)return null;
  return committedBefore(current,{pending,file});
}
// A JSON document may have been replaced before the commit journal finishes.
// Reading it while frozen must not turn that unfinalized choice into a login
// success. This is a display snapshot only; recovery evidence stays intact.
function forRole(current,{frozen=false,pending,file,sqlite=false,externalPending=false}={}){
  if(!frozen||(sqlite&&!externalPending))return current;
  const prior=sqlite?null:committedBefore(current,{pending,file});
  if(!prior){
    // Unknown/legacy pending records do not prove a committed title state.
    // Hide it in this temporary snapshot without deleting saved ownership.
    const out=copy(current);out.owned.titles={};
    delete out.titleState;delete out.titleSettings;delete out.personalSettings;delete out.titleOwnershipObservation;delete out.avatarState;delete out.avatarFrameState;return out;
  }
  const out=copy(current);out.owned.titles=copy(prior.owned.titles);
  // Avatar eligibility also depends on its permanent hero/skin proof. Use the
  // same committed before-image rather than a partially replaced collection.
  out.owned.heroes=copy(prior.owned.heroes);out.owned.skins=copy(prior.owned.skins);
  for(const key of ['titleState','titleSettings','personalSettings','titleOwnershipObservation','avatarState','avatarFrameState']){
    if(prior[key]===undefined)delete out[key];else out[key]=copy(prior[key]);
  }
  return out;
}
module.exports={forRole,forHeroes,committedBefore};
