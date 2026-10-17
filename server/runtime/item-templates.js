'use strict';
const fs=require('node:fs'),path=require('node:path');
function load(file){
  const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==1||!Array.isArray(data.templates))throw Error('Invalid item template bundle');
  const result=new Map();for(const row of data.templates){
    if(!Number.isInteger(row.itemId)||row.itemId<1||row.itemId>=65535||result.has(row.itemId)||!/^([a-f0-9]{2}){493}$/.test(row.recordHex||''))throw Error('Invalid item template record');
    const record=Buffer.from(row.recordHex,'hex');if(record.readUInt16LE(0)!==row.itemId||record.readUInt16LE(130)!==row.durability)throw Error('Item template identity/durability mismatch');
    result.set(row.itemId,{record,durability:row.durability});
  }return result;
}
function save(file,templates){const data={version:1,scope:'Exact existing item record templates; selected by existing maximum durability rule. Contains captured instance bytes and must be handled as project evidence.',templates:[...templates].sort((a,b)=>a[0]-b[0]).map(([itemId,row])=>({itemId,durability:row.durability,recordHex:row.record.toString('hex')}))};fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n',{flag:'wx'});return data.templates.length;}
module.exports={load,save};
function preflight(env={}){
  const file=env.DSH_ITEM_TEMPLATE_FILE||path.join(__dirname,'item-templates-20261002.json'),mode=env.DSH_ITEM_TEMPLATE_FILE?'explicit-bundle':'default-bundle';
  if(!env.DSH_ITEM_TEMPLATE_FILE&&!fs.existsSync(file))return {ok:true,mode:'legacy-directory-scan'};
  try{if(!path.isAbsolute(file))throw Error('Absolute item template bundle required');const templates=load(file);
    return {ok:true,mode,file,count:templates.size};
  }catch(error){return {ok:false,mode,file,error:error.message};}
}
module.exports.preflight=preflight;
