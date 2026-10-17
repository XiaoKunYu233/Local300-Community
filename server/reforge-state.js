'use strict';
const fs=require('./persistence/state-files').io;
const path=require('path');
const {normalizeGuid}=require('./enhancement-state');

function validPending(value){
  return value&&Number.isSafeInteger(value.itemId)&&value.itemId>0&&
    typeof value.baselineHash==='string'&&/^[0-9a-f]{64}$/.test(value.baselineHash)&&
    typeof value.candidateHex==='string'&&/^[0-9a-f]{84}$/.test(value.candidateHex);
}
class ReforgeState {
  constructor(file){
    if(!path.isAbsolute(file))throw new TypeError('state file must be absolute');
    this.file=file;this.pending={};this.applied={};
    if(fs.existsSync(file)){
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if(data?.version!==1||!data.pending||typeof data.pending!=='object'||Array.isArray(data.pending))
        throw new Error('invalid reforge state');
      for(const [guid,value] of Object.entries(data.pending)){
        if(normalizeGuid(guid)!==guid||!validPending(value))throw new Error('invalid reforge pending');
        this.pending[guid]={...value};
      }
      for(const [guid,value] of Object.entries(data.applied||{})){
        if(normalizeGuid(guid)!==guid||!validPending(value))throw new Error('invalid reforge applied state');
        this.applied[guid]={...value};
      }
    }
  }
  get(guid){return this.pending[normalizeGuid(guid)]||null;}
  getApplied(guid){return this.applied[normalizeGuid(guid)]||null;}
  replace(guid,value){
    const key=normalizeGuid(guid);
    if(value!==null&&!validPending(value))throw new TypeError('invalid reforge pending');
    const next={...this.pending};
    if(value===null)delete next[key];else next[key]={...value};
    const temp=`${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    try{fs.writeFileSync(temp,JSON.stringify({version:1,pending:next,applied:this.applied}));fs.renameSync(temp,this.file);}
    catch(error){try{fs.rmSync(temp,{force:true});}catch{}throw error;}
    this.pending=next;
  }
  setApplied(guid,value){
    const key=normalizeGuid(guid);
    if(!validPending(value)||this.pending[key])throw new TypeError('invalid applied blessing state');
    const applied={...this.applied,[key]:{...value}};
    const temp=`${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    try{fs.writeFileSync(temp,JSON.stringify({version:1,pending:this.pending,applied}));fs.renameSync(temp,this.file);}
    catch(error){try{fs.rmSync(temp,{force:true});}catch{}throw error;}
    this.applied=applied;
  }
  resolve(guid,choice){
    const key=normalizeGuid(guid),value=this.get(key);
    if(!value||!['apply','cancel'].includes(choice))throw new Error('invalid reforge resolution');
    const pending={...this.pending},applied={...this.applied};
    delete pending[key];
    if(choice==='apply')applied[key]={...value};
    const temp=`${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    try{fs.writeFileSync(temp,JSON.stringify({version:1,pending,applied}));fs.renameSync(temp,this.file);}
    catch(error){try{fs.rmSync(temp,{force:true});}catch{}throw error;}
    this.pending=pending;this.applied=applied;
  }
}
module.exports={ReforgeState};
