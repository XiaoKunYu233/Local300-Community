'use strict';
const path=require('node:path'),crypto=require('node:crypto'),stateFiles=require('./persistence/state-files');
const canonical=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function validate(value){
  if(!object(value)||value.version!==1||!object(value.units)||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>5||!Number.isInteger(value.currentPage)||value.currentPage<0||value.currentPage>=value.pages.length)throw Error('Invalid war-soul before-image');
  for(const page of value.pages)if(!object(page)||typeof page.name!=='string'||!object(page.units)||page.levels!==undefined&&!object(page.levels)||page.fragments!==undefined&&!object(page.fragments))throw Error('Invalid war-soul before-image page');
  return value;
}
function forRead(current,file,{pendingFile=process.env.DSH_EQUIPMENT_PENDING||path.join(path.dirname(file),'equipment-economy-pending.json'),uid=process.env.DSH_PLAYER_UID}={}){
  if(stateFiles.enabled()||!stateFiles.io.existsSync(pendingFile))return {state:current,frozen:false};
  let pending;
  try{pending=JSON.parse(stateFiles.io.readFileSync(pendingFile,'utf8'));}catch{return empty(current);}
  if(pending?.version!==1||!Array.isArray(pending.paths))return empty(current);
  const touched=pending.paths.filter(row=>row&&typeof row.file==='string'&&canonical(row.file)===canonical(file));
  if(!touched.length&&!/^native-war-soul-/.test(pending.kind))return {state:current,frozen:false};
  try{
    if(pending.version!==1||!/^native-war-soul-/.test(pending.kind)||typeof uid!=='string'||!/^[1-9][0-9]*$/.test(uid)||pending.guid!==uid||touched.length!==1||touched[0].name!=='war-soul')throw Error('Unbound war-soul before-image');
    const row=touched[0];if(typeof row.beforeBase64!=='string')throw Error('Missing war-soul before-image');
    const bytes=Buffer.from(row.beforeBase64,'base64');
    if(bytes.toString('base64')!==row.beforeBase64||crypto.createHash('sha256').update(bytes).digest('hex')!==row.beforeSha256)throw Error('Invalid war-soul before-image hash');
    return {state:validate(JSON.parse(bytes.toString('utf8'))),frozen:true,verified:true};
  }catch{return empty(current);}
}
function empty(current){
  // A temporary read projection, never a repair of the saved document.
  const state=JSON.parse(JSON.stringify(current));state.units={};state.sets={};delete state.entryPanel;
  for(const page of state.pages||[]){page.units={};page.levels={};page.fragments={};}
  state.materials={fragments:{}};return {state,frozen:true,verified:false};
}
module.exports={forRead,validate};
