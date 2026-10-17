'use strict';
// One exclusive JSON marker covers beforeimages through final publication.
// Account writes additionally share the existing ledger lock with battle ticks.
const stateFiles=require('./persistence/state-files'),fs=stateFiles.io;
const path=require('node:path'),crypto=require('node:crypto');
const Locks=require('./player-account-json-lock'),{PROTOCOL}=require('./equipment-economy-marker');
const fold=require('./player-account-runtime-lease-gate').fold;
const owned=new WeakMap(),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
class EquipmentEconomyCommit {
  constructor(file){
    if(!path.isAbsolute(file))throw new TypeError('absolute pending path required');
    this.file=path.resolve(file);this.pending=null;this.failed=false;this.running=false;
    if(fs.existsSync(file))try{
      this.pending=JSON.parse(fs.readFileSync(file,'utf8'));
      if(this.pending?.version!==1||!Array.isArray(this.pending.paths))throw Error('Invalid pending marker');
    }catch{this.pending={version:1,stage:'invalid-marker',paths:[]};}
  }
  get frozen(){return this.pending!==null||this.failed;}
  verify(){
    const guard=owned.get(this);if(!guard)throw Error('Owned economic marker required');
    Locks.checked(this.file);
    if(!fs.readFileSync(this.file).equals(guard.bytes))throw Error('Economic marker ownership changed');
    for(const lock of guard.locks)lock.verify();return guard;
  }
  write(value){
    const guard=this.verify(),bytes=Buffer.from(JSON.stringify(value));
    const temp=`${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try{
      const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      this.verify();
      try{require('./persistence/atomic-rename').replace(temp,this.file,(from,to)=>{this.verify();return fs.renameSync(from,to);});}
      catch(error){try{if(fs.readFileSync(this.file).equals(bytes))guard.bytes=bytes;}catch{}throw error;}
      guard.bytes=bytes;this.verify();
    }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  run(kind,guid,steps){
    if(this.running||this.frozen)return false;
    if(typeof kind!=='string'||!kind||!Array.isArray(steps)||!steps.length||steps.some(s=>
      !s||typeof s.name!=='string'||!s.name||!path.isAbsolute(s.path)||typeof s.save!=='function'))throw new TypeError('Invalid economic steps');
    steps=steps.slice();
    const ledger=process.env.DSH_PLAYER_ACCOUNTS;
    if(ledger&&!steps.some(s=>s.name==='player-accounts'))steps.push({name:'player-accounts',path:ledger,save:()=>{}});
    const seen=new Set([fold(this.file)]);
    for(const step of steps){
      if(!path.isAbsolute(step.path))throw Error('Absolute account ledger required');
      const file=stateFiles.enabled()?path.resolve(step.path):Locks.checked(step.path),key=fold(file);
      if(seen.has(key)||key.startsWith(fold(this.file)+'.'))throw Error('Economic document paths collide');seen.add(key);
    }
    if(stateFiles.enabled()){
      if(require('node:fs').existsSync(this.file)||fs.existsSync(this.file))return false;
      this.running=true;
      try{return stateFiles.transaction(kind,steps.map(s=>s.path),()=>{
        for(const step of steps){const result=step.save();if(result&&typeof result.then==='function')throw Error('Economic save must be synchronous');}return true;
      });}catch(error){this.failed=true;this.pending={version:1,stage:'sqlite-rolled-back',kind,guid,paths:steps.map(s=>({name:s.name,file:s.path})),error:error.message};throw error;}
      finally{this.running=false;}
    }
    Locks.checked(this.file);fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const owner={pid:process.pid,token:crypto.randomUUID()};
    const claim={version:1,markerProtocol:PROTOCOL,owner,kind,guid:guid??null,stage:'beforeimages-pending',noAssetWrites:true,
      paths:steps.map(s=>({name:s.name,file:path.resolve(s.path)})),ledgerLocks:[],at:new Date().toISOString()};
    for(const step of steps)if(step.name==='player-accounts')claim.ledgerLocks.push(Locks.declaration(step.path,this.file,owner));
    for(const row of claim.ledgerLocks)if(seen.has(fold(row.file)))throw Error('Economic document collides with ledger lock');
    const bytes=Buffer.from(JSON.stringify(claim));let fd;
    try{fd=fs.openSync(this.file,'wx');}catch(error){if(error.code==='EEXIST')return false;throw error;}
    const guard={bytes,locks:[]};owned.set(this,guard);this.running=true;let marker=claim,prepared=false;
    try{
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);fd=undefined;}
      this.verify();
      for(const row of claim.ledgerLocks){
        const file=claim.paths.find(p=>p.name==='player-accounts'&&row.file===p.file+'.lock').file;
        let lock;try{lock=Locks.economic(file,this.file,row,()=>this.verify());}catch(error){
          if(error.code==='EEXIST'){
            for(const previous of guard.locks.slice().reverse())previous.close();guard.locks=[];
            this.verify();fs.unlinkSync(this.file);return false;
          }throw error;
        }
        guard.locks.push(lock);row.state='held';this.write(claim);lock.enter();
      }
      marker={version:1,markerProtocol:PROTOCOL,owner,kind,guid:guid??null,stage:'prepared',ledgerLocks:claim.ledgerLocks,at:claim.at,
        paths:steps.map(({name,path:file})=>{
          this.verify();Locks.checked(file);const before=fs.existsSync(file)?fs.readFileSync(file):null;
          return {name,file:path.resolve(file),beforeSha256:before===null?null:hash(before),beforeBase64:before===null?null:before.toString('base64')};
        })};
      this.write(marker);prepared=true;this.pending=marker;
      for(let i=0;i<steps.length;i++){
        const step=steps[i];marker.stage=`saving:${step.name}`;this.write(marker);this.verify();
        const result=step.save();if(result&&typeof result.then==='function')throw Error('Economic save must be synchronous');this.verify();
        marker.paths[i].afterSha256=fs.existsSync(step.path)?hash(fs.readFileSync(step.path)):null;
        marker.stage=`saved:${step.name}`;this.write(marker);
      }
      marker.stage='all-files-saved';this.write(marker);this.verify();
      for(const lock of guard.locks.slice().reverse())lock.close();guard.locks=[];
      this.verify();fs.unlinkSync(this.file);this.pending=null;return true;
    }catch(error){
      this.failed=true;this.pending={...marker,stage:`failed:${marker.stage}`,error:String(error.message)};
      if(prepared)try{this.write(this.pending);}catch{}
      throw error;
    }finally{
      let releaseError;
      for(const lock of guard.locks.slice().reverse())try{lock.close();}catch(error){releaseError=error;}
      if(fd!==undefined)try{fs.closeSync(fd);}catch(error){releaseError=error;}
      owned.delete(this);this.running=false;
      if(releaseError){this.failed=true;throw releaseError;}
    }
  }
}
module.exports={EquipmentEconomyCommit};
