'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net'),crypto=require('node:crypto');
const SERVER=path.resolve(__dirname,'../server');
const seed=require(path.join(SERVER,'public-beta/native-seed'));
const versions=require(path.join(SERVER,'public-beta/client-version'));
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
async function tcp(port,version){
  return new Promise((resolve,reject)=>{let settled=false;const socket=net.connect(port,'127.0.0.1'),decode=require(path.join(SERVER,'battle-transport')).decoder();
    const timer=setTimeout(()=>finish(Error('本地服务连接超时。')),6000);
    function finish(error){if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve();}
    socket.once('error',finish);socket.once('end',()=>finish(Error('本地服务在版本握手前关闭了连接。')));socket.once('close',()=>{if(!settled)finish(Error('本地服务连接已关闭。'));});
    socket.on('data',b=>{try{const frames=decode(b);if(!frames.length)return;if(!versions.isGreeting(frames[0],version))throw Error('本地服务版本握手不一致。');finish();}catch(e){finish(e);}});
  });
}
async function createBackend({dataDirectory,readyFile,ports=[30500,30501]}={}){
  dataDirectory=path.resolve(dataDirectory);fs.mkdirSync(dataDirectory,{recursive:true});
  const settingsFile=path.join(dataDirectory,'settings.json'),accountDirectory=path.join(dataDirectory,'save','admin'),capture=path.join(SERVER,'local-native-capture');
  let settings=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile)):{clientDirectory:'',clientVersion:8824,restoreOnStop:true};
  if(!versions.valid(settings.clientVersion)||typeof settings.clientDirectory!=='string')throw Error('设置文件损坏，请保留资料文件夹后联系作者。');
  seed.initialize(accountDirectory);if(!fs.existsSync(capture))seed.createCapture(capture);
  const routing=require('../client/client-routing').createRoutingManager({stateDirectory:path.join(dataDirectory,'client-backups')});
  const uncertaintyFile=path.join(dataDirectory,'unconfirmed-stop.json');
  let saveError=fs.existsSync(uncertaintyFile)?JSON.parse(fs.readFileSync(uncertaintyFile)):null;
  let service=null,phase=saveError?'error':'stopped',queue=Promise.resolve(),quitting=false,lastMessage=saveError?'上次保存尚未确认，请保留存档与诊断资料；仍可恢复客户端配置。':'请先选择已有的游戏客户端文件夹。';
  const token=crypto.randomBytes(32).toString('hex');
  const friendly=e=>/^[\x00-\x7f]+$/.test(e.message||'')?'操作未完成：'+(e.code==='EADDRINUSE'?'本地端口已被占用，请关闭另一份本工具后重试。':'请保留数据文件夹，查看诊断记录或联系作者。'):e.message;
  function recovery(){return settings.clientDirectory?routing.getRecoveryStatus({clientDirectory:settings.clientDirectory}):null;}
  function status(){return {ok:true,version:seed.isPrivateOriginal?'v0.12 原存档对照测试':'v0.12 公开测试版',privateOriginal:seed.isPrivateOriginal===true,publicSnapshot:seed.isPublicSnapshot===true,phase,running:phase==='running',saveConfirmed:!saveError,settings:{...settings},ports,lastMessage,recovery:recovery(),saveDirectory:accountDirectory};}
  async function stop({restore=true}={}){
    if(service){phase='stopping';const current=service;let journalFailure;
      try{atomic(uncertaintyFile,{at:new Date().toISOString(),message:'Save and shutdown not yet confirmed'});}catch(e){journalFailure=e;}
      try{
        const result=await current.close('launcher-save-and-stop');atomic(path.join(dataDirectory,'last-stop.json'),{at:new Date().toISOString(),...result});
        if(journalFailure)throw Error('关闭前的保存记录未能写入，请保留存档和诊断资料。');
        if(result.leaseErrors.length||result.workers.some(w=>w.code!==0||w.signal!==null))throw Error('保存未能完整确认，请保留数据文件夹并查看诊断记录。');
        fs.unlinkSync(uncertaintyFile);saveError=null;
      }catch(e){saveError={at:new Date().toISOString(),message:e.message};try{atomic(uncertaintyFile,saveError);}catch{saveError.recordWriteFailed=true;}}
      finally{if(service===current)service=null;}
    }
    phase=saveError?'error':'stopped';lastMessage=saveError?'服务已结束，但保存尚未完整确认，请保留数据文件夹并查看诊断记录。':'本地服务已保存并关闭。';
    let restored;
    if(restore&&settings.restoreOnStop&&settings.clientDirectory){const result=routing.restoreRouting({clientDirectory:settings.clientDirectory});if(!result.ok&&result.code!=='NO_BACKUP')restored=result;}
    return {...status(),ok:!saveError,...(saveError?{message:lastMessage}:{}),...(restored?{restoreResult:restored}: {})};
  }
  async function command(body){
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error('请求格式不正确。');
    const operation=body.operation;
    if(operation==='status')return status();
    if(operation==='configure'){
      if(service)throw Error('请先保存并关闭本地服务，再修改设置。');
      const dir=path.resolve(String(body.clientDirectory||'')),inspected=routing.inspectClient({clientDirectory:dir});if(!inspected.ok)return inspected;
      const version=Number(body.clientVersion);if(!versions.valid(version))throw Error('服务端版本号必须是有效整数。');
      settings={clientDirectory:dir,clientVersion:version,restoreOnStop:body.restoreOnStop!==false};atomic(settingsFile,settings);lastMessage='设置已保存，可以启动本地测试。';return status();
    }
    if(operation==='start'){
      if(saveError)throw Error('上次保存尚未确认，请先保留数据文件夹并联系作者。可使用恢复按钮返回原服。');
      if(service)return status();if(!settings.clientDirectory)throw Error('请先选择包含300.exe的游戏文件夹。');
      const inspected=routing.inspectClient({clientDirectory:settings.clientDirectory});if(!inspected.ok)return inspected;
      phase='starting';
      try{
        const environment={DSH_BAG_STATE:path.join(accountDirectory,'bag-state.live.json'),DSH_PUBLIC_BETA:'1'};
        const options=(seed.isPrivateOriginal||seed.hasRuntimeOptions)?Object.fromEntries(Object.entries(seed.runtimeOptions).map(([key,value])=>[key,value.replace(/\$\{ACCOUNT\}/g,accountDirectory).replace(/\$\{CAPTURE\}/g,capture)])):{cap:capture,bag:path.join(accountDirectory,'bag-state.json'),'bag-capacity':'192','bag-records':'552','bag-unknown':'silent','bag-sync':'full','bag-empty':'ffff','bag-merge':'off','bag-reguid':'off','bag-drop':'off','gold-push':'1045','mail-login-notify':'off','mail-startup-poll-guard':'on','shop-gold-discount':'100'};
        service=await require(path.join(SERVER,'player-account-runtime')).start({accounts:[{uid:seed.UID,directory:accountDirectory,environment,profile:{options}}],ports,withBattle:true,publicBeta:true,clientVersion:settings.clientVersion});
        atomic(uncertaintyFile,{at:new Date().toISOString(),message:'Owned local test service active'});
        await Promise.all(service.ports.map(p=>tcp(p,settings.clientVersion)));
        const applied=routing.applyRouting({clientDirectory:settings.clientDirectory,host:'127.0.0.1',gatewayPorts:service.ports,allowExistingTestRoute:body.allowExistingTestRoute===true});
        if(!applied.ok){await stop({restore:false});return applied;}
        phase='running';lastMessage=seed.isPrivateOriginal?'完整原存档已就绪。请选十二试炼（SESL）区，手动登录：admin / admin。此版仅用于本机对照测试。':'本地服务已就绪。只选十二试炼（SESL）区，手动登录：admin / admin。当前版本可能出现任何不可预期的 BUG。';
        const owned=service;owned.done.then(r=>{if(service===owned&&phase!=='stopping'){service=null;phase='error';lastMessage='本地服务意外结束，请保留数据文件夹并查看诊断记录。';saveError={at:new Date().toISOString(),message:lastMessage,result:r};try{atomic(uncertaintyFile,saveError);}catch{saveError.recordWriteFailed=true;}}}).catch(()=>{});
        return status();
      }catch(e){try{await stop({restore:false});}catch{}phase='error';throw e;}
    }
    if(operation==='stop')return stop();
    if(operation==='launch'){
      if(phase!=='running')throw Error('请先点击“启动本地服务”。');await Promise.all(service.ports.map(p=>tcp(p,settings.clientVersion)));
      const check=routing.inspectClient({clientDirectory:settings.clientDirectory});if(!check.ok)return check;
      if(check.context.routes.some(r=>r.hosts!=='127.0.0.1'||r.ports!==service.ports.join('|')))throw Error('客户端配置已经改动，当前没有指向本地服务。请关闭服务并重新检查配置，工具不会覆盖更新后的文件。');
      const target=routing.getLaunchTarget({clientDirectory:settings.clientDirectory});if(!target.ok)return target;
      // The original client requiresAdministrator. Only the visible WinForms
      // host can ask Windows to elevate this exact executable through UAC.
      return {ok:true,message:'客户端配置已核对，可以启动游戏。',launchTarget:target.context};
    }
    if(operation==='prepare-restore'){
      const stopped=await stop({restore:false});if(!stopped.ok)return stopped;
      return routing.prepareRestore({clientDirectory:settings.clientDirectory,target:body.target||'before-test',conflictPolicy:body.conflictPolicy||'keep',expectedCurrentSha256:body.expectedCurrentSha256});
    }
    if(operation==='restore'){
      const stopped=await stop({restore:false});if(!stopped.ok)return stopped;
      return routing.restoreRouting({clientDirectory:settings.clientDirectory,target:body.target||'before-test',conflictPolicy:body.conflictPolicy||'keep',expectedCurrentSha256:body.expectedCurrentSha256,preparedCurrentSha256:body.preparedCurrentSha256,preparedTargetSha256:body.preparedTargetSha256});
    }
    if(operation==='import-official'){
      if(service)throw Error('请先关闭本地服务再导入原版配置备份。');
      const inspected=routing.inspectBackup({backupPath:body.backupFile});if(!inspected.ok)return inspected;
      return routing.importOfficialBackup({clientDirectory:settings.clientDirectory,backupPath:body.backupFile,expectedSHA256:inspected.context.sha256});
    }
    if(operation==='search-items')return {ok:true,...require(path.join(SERVER,'public-beta/gm-items')).search(String(body.query||''),100)};
    if(operation==='limited-status'){
      if(!service||phase!=='running')throw Error('请先启动本地服务，再查看限定神赐状态。');
      return {ok:true,result:await service.publicBetaRequest(seed.UID,{operation:'limited-godsend-status'})};
    }
    if(operation==='gm'||operation==='retry-gm'){
      if(!service||phase!=='running')throw Error('请先启动本地服务，再使用GM工具。');
      const pendingFile=path.join(dataDirectory,'unconfirmed-gm.json');
      let payload=body.payload;
      if(fs.existsSync(pendingFile)){
        const pending=JSON.parse(fs.readFileSync(pendingFile));
        const comparable=v=>JSON.stringify({...v,transactionId:null});
        if(operation!=='retry-gm'&&comparable(payload)!==comparable(pending))throw Error('上一笔操作还未确认，请先点击“重试未确认操作”。');payload=pending;
      }else if(operation==='retry-gm'){
        const last=path.join(dataDirectory,'last-gm-result.json');
        if(fs.existsSync(last))return {ok:true,message:'上一笔操作已经确认完成，本次没有重复发放。',result:JSON.parse(fs.readFileSync(last)).result};
        return {ok:true,message:'没有尚未确认的GM操作。'};
      }
      else atomic(pendingFile,payload);
      let result;
      try{result=await service.publicBetaRequest(seed.UID,payload);}catch(error){if(error.confirmedRejected&&error.uncertain===false)fs.unlinkSync(pendingFile);throw error;}
      atomic(path.join(dataDirectory,'last-gm-result.json'),{payload,result});fs.unlinkSync(pendingFile);
      return {ok:true,result};
    }
    if(operation==='quit'){quitting=true;const result=await stop();setTimeout(()=>{server.close();process.exit(0);},150);return {...result,ok:true,...(saveError?{warning:lastMessage}:{})};}
    throw Error('不支持的操作。');
  }
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST'||req.url!=='/request'||req.headers['x-local300-token']!==token){res.writeHead(403);res.end('{"ok":false}');return;}
    let chunks=[],size=0;req.on('data',b=>{size+=b.length;if(size>32768)req.destroy();else chunks.push(b);});
    req.on('end',()=>{queue=queue.then(async()=>{try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),result=await command(body);res.end(JSON.stringify(result));}catch(e){try{fs.appendFileSync(path.join(dataDirectory,'diagnostics.jsonl'),JSON.stringify({at:new Date().toISOString(),message:e.message,code:e.code})+'\n');}catch{}res.end(JSON.stringify({ok:false,message:friendly(e),code:e.code||'OPERATION_FAILED'}));}}).catch(()=>{});});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const endpoint={port:server.address().port,token,pid:process.pid};
  if(readyFile)try{atomic(readyFile,endpoint);}catch(error){await new Promise(resolve=>server.close(resolve));throw error;}
  const shutdown=()=>{if(quitting)return;quitting=true;queue=queue.then(()=>stop()).finally(()=>{server.close();process.exit(0);});};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.stdin.resume();process.stdin.once('end',shutdown);
  return {command,status,endpoint,close:async()=>{await stop();await new Promise(resolve=>server.close(resolve));}};
}
if(require.main===module){const values=Object.fromEntries(process.argv.slice(2).map(a=>{const at=a.indexOf('=');return[a.slice(2,at),a.slice(at+1)];}));createBackend({dataDirectory:values.data,readyFile:values.ready}).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});}
module.exports={createBackend,tcp,atomic};
