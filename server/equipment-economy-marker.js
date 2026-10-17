'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const PROTOCOL='json-exclusive-v1',hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function owner(value){return exact(value,['pid','token'])&&Number.isInteger(value.pid)&&value.pid>0&&typeof value.token==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.token);}
function locks(marker){
  if(!Array.isArray(marker.ledgerLocks))throw Error('Invalid economic ledger lock declarations');
  for(const row of marker.ledgerLocks){
    if(!exact(row,['file','state','contentBase64','sha256'])||!path.isAbsolute(row.file)||!['requested','held'].includes(row.state)||typeof row.contentBase64!=='string')throw Error('Invalid economic ledger lock declaration');
    const bytes=Buffer.from(row.contentBase64,'base64');
    if(bytes.toString('base64')!==row.contentBase64||hash(bytes)!==row.sha256)throw Error('Invalid economic ledger lock bytes');
    const value=JSON.parse(bytes);
    if(!exact(value,['version','kind','pid','token','ledger','markerFile'])||value.version!==1||value.kind!=='equipment-economy-json-write'||
      value.pid!==marker.owner.pid||value.token!==marker.owner.token||!path.isAbsolute(value.ledger)||!path.isAbsolute(value.markerFile)||
      path.resolve(row.file)!==path.resolve(value.ledger+'.lock')||!marker.paths.some(p=>p.name==='player-accounts'&&path.resolve(p.file)===path.resolve(value.ledger)))throw Error('Economic ledger lock is not bound to the marker');
  }
}
function validateExclusive(marker){
  if(marker?.markerProtocol!==PROTOCOL||marker.version!==1||!owner(marker.owner)||typeof marker.kind!=='string'||!marker.kind||
    !(marker.guid===null||typeof marker.guid==='string'||Number.isFinite(marker.guid))||typeof marker.at!=='string'||!Number.isFinite(Date.parse(marker.at))||
    !Array.isArray(marker.paths)||!marker.paths.length)throw Error('Invalid exclusive economic marker');
  locks(marker);
  if(marker.noAssetWrites===true){
    if(!exact(marker,['version','markerProtocol','owner','kind','guid','stage','noAssetWrites','paths','ledgerLocks','at'])||marker.stage!=='beforeimages-pending'||
      marker.paths.some(row=>!exact(row,['name','file'])||typeof row.name!=='string'||!row.name||!path.isAbsolute(row.file)))throw Error('Invalid no-write economic claim');
    return true;
  }
  if(Object.hasOwn(marker,'noAssetWrites')||marker.ledgerLocks.some(row=>row.state!=='held')||marker.paths.some(row=>!Object.hasOwn(row,'beforeBase64')||!Object.hasOwn(row,'beforeSha256')))throw Error('Exclusive marker has no verified preparation');
  return false;
}
module.exports={PROTOCOL,validateExclusive};
