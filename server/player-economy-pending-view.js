'use strict';
const native=require('node:fs'),path=require('node:path');
// Observe other workers' marker without poisoning this process's own commit
// or state-files rollback latch. Only the constructor's stale external cache
// can be released when the actual marker disappears.
function create({file,journal,stateFiles,physical=native}){
  if(!path.isAbsolute(file)||!journal||!stateFiles)throw Error('Pending view requires explicit state');
  let startupPending=journal.pending;
  const invalid=()=>({version:1,stage:'unreadable-external-marker',paths:[]});
  function external(){
    let physicalPresent=false,mappedPresent=false,pending=null;
    try{
      const meta=physical.lstatSync(file);physicalPresent=true;
      if(!meta.isFile()||meta.isSymbolicLink()||meta.size>64*1024*1024)pending=invalid();
      else try{pending=JSON.parse(physical.readFileSync(file,'utf8'));}catch{pending=invalid();}
    }catch(error){if(error.code!=='ENOENT'){physicalPresent=true;pending=invalid();}}
    if(stateFiles.enabled()){
      try{
        mappedPresent=stateFiles.io.existsSync(file);
        if(mappedPresent&&!physicalPresent)try{pending=JSON.parse(stateFiles.io.readFileSync(file,'utf8'));}catch{pending=invalid();}
      }catch{mappedPresent=true;pending=invalid();}
    }
    if((physicalPresent||mappedPresent)&&(!pending||pending.version!==1||!Array.isArray(pending.paths)))pending=invalid();
    return {present:physicalPresent||mappedPresent,pending,physicalPresent,mappedPresent};
  }
  function view(){
    const observed=external();
    if(startupPending!==null&&journal.pending===startupPending&&!observed.present){journal.pending=null;startupPending=null;}
    return {frozen:observed.present||journal.frozen||stateFiles.frozen(),pending:observed.present?observed.pending:journal.pending,
      externalPending:observed.present,physicalPresent:observed.physicalPresent,mappedPresent:observed.mappedPresent};
  }
  return {view};
}
module.exports={create};
