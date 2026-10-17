'use strict';
// Backend-independent, account-local delivery journal. These files survive
// account JSON/SQLite write failures; completed files remain audit evidence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),H=require('./player-match-history');
class MatchOutbox{
  constructor(store,uid){
    this.store=store;this.uid=uid;const a=store.get(uid);if(!a)throw Error('Unknown match journal account');this.playerId=a.playerId;
    this.directory=store.file+'.results';
    fs.mkdirSync(this.directory,{recursive:true});
    if(fs.realpathSync(this.directory)!==path.join(fs.realpathSync(path.dirname(store.file)),path.basename(this.directory)))throw Error('Match journal directory is redirected');
  }
  read(file){
    const value=JSON.parse(fs.readFileSync(file));
    if(value.version!==1||value.uid!==this.uid)throw Error('Match journal identity mismatch');
    H.validate({version:1,matches:{[value.row?.matchId]:value.row}},this.playerId);
    if(!path.basename(file).startsWith(value.row.matchId+'.'))throw Error('Match journal filename mismatch');
    return value;
  }
  enqueue(result,completedAt=Date.now()){
    this.enqueueRow({...H.normalize(result,this.playerId),completedAt});
  }
  enqueueRow(row,suffix='pending'){
    H.validate({version:1,matches:{[row.matchId]:row}},this.playerId);
    const file=path.join(this.directory,row.matchId+'.pending.json'),done=path.join(this.directory,row.matchId+'.done.json');
    for(const existing of [file,done])if(fs.existsSync(existing)){
      const prior=this.read(existing).row;
      if(!H.sameResult(prior,row))throw Error('Conflicting journal result');return;
    }
    const target=suffix==='active'?path.join(this.directory,row.matchId+'.active.json'):file;
    if(fs.existsSync(target)){
      const prior=this.read(target).row;
      if(prior.mapId!==row.mapId||prior.playerId!==row.playerId)throw Error('Active match identity changed');
      row={...row,completedAt:prior.completedAt};
    }
    const temp=target+'.'+crypto.randomUUID()+'.tmp';
    try{
      const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,JSON.stringify({version:1,uid:this.uid,row})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temp,target);
    }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  begin({matchId,mapId,heroId}){
    this.enqueueRow({matchId,playerId:this.playerId,status:'incomplete',endReason:'server-restarted',mapId,heroId,
      won:null,durationSeconds:null,kills:null,deaths:null,assists:null,completedAt:Date.now()},'active');
  }
  interrupt({matchId,mapId,heroId},endReason,durationSeconds=null){
    this.enqueueRow({matchId,playerId:this.playerId,status:'incomplete',endReason,mapId,heroId,
      won:null,durationSeconds,kills:null,deaths:null,assists:null,completedAt:Date.now()});
  }
  recoverInterrupted(){
    for(const name of fs.readdirSync(this.directory).filter(name=>name.endsWith('.active.json'))){
      const file=path.join(this.directory,name),row=this.read(file).row;
      const resolved=['pending','done'].find(suffix=>fs.existsSync(path.join(this.directory,row.matchId+'.'+suffix+'.json')));
      if(resolved)this.read(path.join(this.directory,row.matchId+'.'+resolved+'.json'));
      else this.enqueueRow({...row,endReason:'server-restarted',completedAt:Date.now()});
      fs.unlinkSync(file);
    }
  }
  flush(canWrite=()=>true){
    for(const name of fs.readdirSync(this.directory).filter(name=>name.endsWith('.pending.json')).sort()){
      if(!canWrite())return;
      const file=path.join(this.directory,name),row=this.read(file).row;
      H.recordEntry(this.store,this.uid,row);
      const done=file.replace(/\.pending\.json$/,'.done.json');
      if(fs.existsSync(done))throw Error('Conflicting completed match journal');
      fs.renameSync(file,done);
    }
  }
}
module.exports={MatchOutbox};
