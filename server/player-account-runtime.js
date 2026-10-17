'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {resolvePaths}=require('./runtime/state-resolver'),{validate}=require('./player-account-state');
const gateway=require('./player-account-gateway');
const runtimeLeases=require('./player-account-runtime-lease');
const leaseGate=require('./player-account-runtime-lease-gate');
const {NameBroker}=require('./player-account-name-broker');
const ROOT=__dirname;
function canonical(file){
  let target=path.resolve(file),tail=[];
  while(!fs.existsSync(target)){tail.unshift(path.basename(target));const parent=path.dirname(target);if(parent===target)break;target=parent;}
  const value=path.join(fs.realpathSync(target),...tail);return process.platform==='win32'?value.toLowerCase():value;
}
function prepare(entries){
  if(!Array.isArray(entries)||!entries.length)throw Error('Explicit account runtimes required');
  const identities=new Set(),uids=new Set(),roles=new Set(),roots=[];
  const plans=entries.map(entry=>{
    if(!entry.directory||!path.isAbsolute(entry.directory)||!fs.statSync(entry.directory).isDirectory())throw Error('Existing absolute account directory required');
    const directory=canonical(entry.directory);
    if(roots.some(root=>directory===root||directory.startsWith(root+path.sep)||root.startsWith(directory+path.sep)))throw Error('Account directories overlap');
    roots.push(directory);
    const inside=file=>{if(!path.isAbsolute(file))throw Error('Absolute account state path required');const resolved=canonical(file);if(!resolved.startsWith(directory+path.sep))throw Error('Account state escapes its directory: '+path.basename(file));return file;};
    const environment={...entry.environment};
    for(const row of require('./runtime/state-paths.json').states)if(row.environment&&!environment[row.environment])environment[row.environment]=path.join(entry.directory,row.default);
    Object.assign(environment,{
      DSH_PLAYER_UID:String(entry.uid),
      DSH_LOG_DIR:environment.DSH_LOG_DIR||path.join(entry.directory,'logs'),
      DSH_LOG_FILE:environment.DSH_LOG_FILE||path.join(entry.directory,'logs','liveserver.log'),
      DSH_CHANGELOG_FILE:environment.DSH_CHANGELOG_FILE||path.join(entry.directory,'logs','change-log.jsonl'),
      DSH_BATTLE_STATE_FILE:environment.DSH_BATTLE_STATE_FILE||path.join(entry.directory,'battle-session-state.json'),
      DSH_BATTLE_LOG_FILE:environment.DSH_BATTLE_LOG_FILE||path.join(entry.directory,'logs','battle-runtime.jsonl'),
    });
    const options={...entry.profile?.options,ports:'0',host:'127.0.0.1',safety:'0','progression-fixture':'off',
      bag:entry.profile?.options?.bag||path.join(entry.directory,'bag-state.json'),
      'mail-extra':environment.DSH_MAIL_EXTRA||path.join(entry.directory,'mail-extra.json'),
      'account-uid':environment.DSH_ACCOUNT_UID_FILE,'gm-audit-file':path.join(entry.directory,'gm-audit.jsonl')};
    delete options['gm-port'];delete options['gm-token-file'];
    const args=Object.entries(options).map(([key,value])=>{
      if(!/^[a-z][a-z0-9-]*$/.test(key)||typeof value!=='string'||/[\r\n\0]/.test(value))throw Error('Invalid account runtime option');return `--${key}=${value}`;
    });
    require('./runtime/options').parseOptions(args);
    const records=resolvePaths({options},environment,ROOT);
    const files=new Set();
    for(const record of [...records,{path:environment.DSH_LOG_FILE},{path:environment.DSH_BATTLE_LOG_FILE},{path:environment.DSH_BATTLE_STATE_FILE},{path:path.join(entry.directory,'account-runtime.lock')}])if(record.path){
      inside(record.path);const file=canonical(record.path);if(files.has(file))throw Error('Account state paths collide');files.add(file);
    }
    for(const key of ['DSH_LOG_DIR','DSH_LOG_FILE','DSH_CHANGELOG_FILE','DSH_BATTLE_STATE_FILE'])inside(environment[key]);
    if(environment.DSH_BATTLE_TICKETS){inside(environment.DSH_BATTLE_TICKETS);const ticketPath=canonical(environment.DSH_BATTLE_TICKETS);if(files.has(ticketPath))throw Error('Battle ticket path collides with account state');files.add(ticketPath);}
    let ledger;
    const resultsDirectory=inside(environment.DSH_PLAYER_ACCOUNTS+'.results'),resultsCanonical=canonical(resultsDirectory);
    if([...files].some(file=>file===resultsCanonical||file.startsWith(resultsCanonical+path.sep)))throw Error('Account state collides with match journal directory');
    const metadata=leaseGate.paths(entry.directory);
    for(const reserved of [metadata.gate,metadata.audit].map(canonical)){
      if([...files].some(file=>file===reserved||file.startsWith(reserved+path.sep)||reserved.startsWith(file+path.sep))||
        [environment.DSH_LOG_DIR,environment.DSH_CHANGELOG_FILE].some(file=>canonical(file)===reserved||canonical(file).startsWith(reserved+path.sep)))
        throw Error('Account state collides with runtime lease metadata');
    }
    const backend=environment.DSH_STATE_BACKEND||'json';
    if(backend==='sqlite'){
      if(!environment.DSH_STATE_DB||!path.isAbsolute(environment.DSH_STATE_DB)||!environment.DSH_STATE_SCOPE)throw Error('Explicit account database and scope required');
      inside(environment.DSH_STATE_DB);
      if(leaseGate.metadataCollision(metadata,environment.DSH_STATE_DB))throw Error('Account database collides with runtime lease metadata');
      if(files.has(canonical(environment.DSH_STATE_DB)))throw Error('Account database path collides with account state');
      // A checkpointed main-file preflight must not create WAL/SHM metadata.
      // Existing live journals still require the real SQLite reader: they may
      // contain committed authority newer than the main-file bytes. The service
      // manifest separately requires fully checkpointed, offline start inputs.
      const liveJournal=['-wal','-shm','-journal'].some(s=>fs.existsSync(environment.DSH_STATE_DB+s));
      const db=liveJournal?new(require('./persistence/document-store').DocumentStore)(environment.DSH_STATE_DB,{readOnly:true}):
        require('./persistence/document-store-offline-snapshot').open(environment.DSH_STATE_DB);
      try{ledger=JSON.parse(db.read(environment.DSH_STATE_SCOPE,'player-accounts'));}finally{db.close();}
    }else if(backend==='json')ledger=JSON.parse(fs.readFileSync(environment.DSH_PLAYER_ACCOUNTS,'utf8'));
    else throw Error('Unsupported account state backend');
    validate(ledger);const account=ledger.accounts[entry.uid];
    if(!account||Object.keys(ledger.accounts).length!==1)throw Error('Account worker requires its own single-account ledger');
    if(identities.has(account.loginHash)||uids.has(account.uid)||roles.has(account.playerId))throw Error('Duplicate account runtime identity');
    identities.add(account.loginHash);uids.add(account.uid);roles.add(account.playerId);
    return {directory:entry.directory,environment,args,account:{loginHash:account.loginHash,uid:account.uid,playerId:account.playerId}};
  });
  // Account registration/startup shares the same normalized current-name
  // policy as live card use. Never register captured or archived identities.
  new NameBroker({plans});
  return plans;
}
async function start({accounts,withBattle=false,port=0,ports,host='127.0.0.1',startupMs=15000,shutdownMs=4000,publicBeta=false,clientVersion=8824}={}){
  if(typeof publicBeta!=='boolean'||!require('./public-beta/client-version').valid(clientVersion)||!publicBeta&&clientVersion!==8824)throw Error('Invalid public test options');
  if(publicBeta&&(accounts?.length!==1||accounts[0].uid!==require('./public-beta/native-seed').UID))throw Error('Public beta requires its own new local account');
  if(publicBeta)accounts=accounts.map(a=>({...a,environment:{...a.environment,DSH_PUBLIC_BETA:'1',DSH_CLIENT_VERSION:String(clientVersion)}}));
  const requestedPorts=ports===undefined?[port]:ports;
  if(ports!==undefined&&port!==0||!Array.isArray(requestedPorts)||!requestedPorts.length||requestedPorts.length>2||requestedPorts.some(value=>!Number.isInteger(value)||value<0||value>65535)||new Set(requestedPorts.filter(Boolean)).size!==requestedPorts.filter(Boolean).length)throw Error('Invalid account entry ports');
  // Validate every identity/path before any worker can repair or write state.
  const plans=prepare(withBattle?accounts.map(entry=>({...entry,environment:{...entry.environment,
    DSH_BATTLE_TICKETS:entry.environment?.DSH_BATTLE_TICKETS||path.join(entry.directory,'battle-ticket.json'),
  }})):accounts),workers=[],leases=[],entryGateways=[];let closing=false,closePromise,resolveDone,nameBroker;
  const privateSeed=publicBeta?require('./public-beta/native-seed'):null;
  if(privateSeed?.isPrivateOriginal||privateSeed?.isPublicSnapshot)for(const plan of plans){
    const expectedLogin=privateSeed.isPrivateOriginal?privateSeed.privateLoginHash:require('./player-account-state').loginKey('admin');
    if(plan.account.uid!==privateSeed.UID||plan.account.playerId!==privateSeed.PLAYER_ID||plan.account.loginHash!==expectedLogin)throw Error('Local snapshot account identity mismatch');
  }
  // Establish the shared public greeting before taking leases or launching
  // writers. Explicit captures must agree; private account frames stay in
  // their own workers and are never used to greet an unknown connection.
  const greetingModule=require('./player-account-greeting');
  let greeting=greetingModule.publicFrame(plans.map(plan=>{
    const options=require('./runtime/options').parseOptions(plan.args);
    const source=fs.readFileSync(require('./roledata').findStream(path.resolve(ROOT,options.cap)));
    return greetingModule.fromCapture(source,{sourceSha256:require('node:crypto').createHash('sha256').update(source).digest('hex')});
  }));
  if(publicBeta)greeting=require('./public-beta/client-version').greeting(clientVersion);
  const done=new Promise(resolve=>resolveDone=resolve);
  function close(reason='requested'){
    if(closePromise)return closePromise;closing=true;nameBroker?.close();
    closePromise=(async()=>{
      for(const lease of leases)if(!lease.failed)try{lease.update(value=>{value.phase='stopping';});}catch{}
      await Promise.all(entryGateways.map(entry=>entry.close()));
      await Promise.all(workers.map(async row=>{
        if(row.exited)return;
        if(row.child.connected)row.child.send({type:'runtime-stop'},()=>{});else row.child.kill();
        const timer=setTimeout(()=>row.child.kill('SIGKILL'),shutdownMs);
        try{await row.finished;}finally{clearTimeout(timer);}
      }));
      // Reservations cannot outlive the worker group. Keep them held while
      // owned workers may still be committing or reporting an uncertain save.
      nameBroker?.close({workersTerminated:true});
      const leaseErrors=[];
      for(const lease of leases){
        // Only release this manager's lease, after every owned worker exited.
        // A stale or replaced lease requires inspection, never deletion by PID.
        try{
          if(!lease.failed)lease.update(value=>{value.phase='stopped';});
          lease.release();
        }catch(error){leaseErrors.push({file:lease.file,error:error.message});}
      }
      const result={reason,leaseErrors,workers:workers.map(row=>({service:row.service,uid:row.uid,pid:row.child.pid,code:row.code,signal:row.signal}))};resolveDone(result);return result;
    })();return closePromise;
  }
  try{
    for(const plan of plans){
      plan.lease=runtimeLeases.create(plan,{withBattle});leases.push(plan.lease);
    }
    // Re-read under every account lease before starting any name writer.
    nameBroker=new NameBroker({plans});
    async function launch(plan,service,args){
      if(closing)throw Error('Account runtime stopped during startup');
      fs.mkdirSync(path.dirname(plan.environment.DSH_LOG_FILE),{recursive:true});
      fs.mkdirSync(path.dirname(plan.environment.DSH_CHANGELOG_FILE),{recursive:true});
      const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('DSH_')&&key.toUpperCase()!=='NODE_OPTIONS')),...plan.environment};
      const guard=env.DSH_TEST_WRITE_ROOT?['--require',path.join(ROOT,'test-write-guard.js')]:[];
      const attempt=require('node:crypto').randomUUID();
      // Persist the uncertainty before spawn. A crash before PID registration
      // leaves a lock that offline recovery must refuse, even if its manager
      // has terminated. Never infer that no orphan worker was started.
      plan.lease.update(value=>{value.phase='starting';value.pendingSpawn={attempt,service,uid:plan.account.uid,startedAt:Date.now()};});
      const child=spawn(process.execPath,[...guard,path.join(ROOT,service==='battle'?'battle-runtime.js':'liveserver.js'),...args],{cwd:ROOT,env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
      let startupError='';child.stderr.on('data',bytes=>{startupError=(startupError+bytes.toString('utf8')).slice(-2000);});
      let finish;const row={service,uid:plan.account.uid,child,exited:false,finished:new Promise(resolve=>finish=resolve)};workers.push(row);
      nameBroker.bind(child,{uid:plan.account.uid,service});
      child.on('message',value=>{
        if(!nameBroker.handles(value))return;
        void nameBroker.handle(child,value).then(reply=>{
          if(reply.fatal){void close('registered account name authority failed');return;}
          if(closing||!child.connected)return;
          child.send(reply,error=>{if(error&&!closing)void close('name broker IPC reply failed');});
        }).catch(()=>{if(!closing)void close('name broker IPC handler failed');});
      });
      child.on('disconnect',()=>{if(!closing&&!row.exited)void close('worker IPC disconnected');});
      child.on('error',()=>{if(!child.pid){row.exited=true;finish();}void close('worker process failure');});
      child.on('exit',(code,signal)=>{
        row.exited=true;row.code=code;row.signal=signal;
        if(!plan.lease.failed)try{plan.lease.update(value=>{
          const worker=value.workers.find(worker=>worker.attempt===attempt);
          if(worker){worker.phase='exited';worker.exit={code,signal};}
        });}catch{}
        finish();if(!closing)void close('worker exited');
      });
      plan.lease.update(value=>{value.workers.push({attempt,service,uid:plan.account.uid,pid:child.pid,phase:'registered'});value.pendingSpawn=null;});
      row.port=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>complete(Error('Account worker readiness timeout')),startupMs);
        const message=value=>{if(value?.type==='runtime-ready'){
          if(value.service!==service||!Array.isArray(value.ports)||value.ports.length!==1||!Number.isInteger(value.ports[0])||value.ports[0]<1||value.ports[0]>65535)return complete(Error('Invalid worker readiness'));
          complete(null,value.ports[0]);
        }};
        const exited=()=>complete(Error('Account worker exited before ready: '+startupError)),failed=error=>complete(error);
        function complete(error,value){clearTimeout(timer);child.off('message',message);child.off('exit',exited);child.off('error',failed);error?reject(error):resolve(value);}
        child.on('message',message);child.once('exit',exited);child.once('error',failed);
      });
      row.route={...plan.account,port:row.port};
      plan.lease.update(value=>{value.workers.find(worker=>worker.attempt===attempt).phase='ready';});
      return row;
    }
    for(const plan of plans){
      let args=plan.args;
      if(withBattle){
        const battle=await launch(plan,'battle',['--port=0','--runtime-options='+JSON.stringify(args)]);
        args=args.filter(arg=>!/^--match-(host|port|port-map)=/.test(arg)).concat('--match-host=127.0.0.1',`--match-port=${battle.port}`,`--match-port-map=27298:${battle.port}`);
      }
      await launch(plan,'lobby',args);
    }
    if(closing)throw Error('Account worker exited during startup');
    for(const entryPort of requestedPorts){
      if(closing)throw Error('Account worker exited while opening gateways');
      const localSeed=publicBeta?require('./public-beta/native-seed'):null;
      const routes=workers.filter(row=>row.service==='lobby').map(row=>{
        if(!localSeed?.isPrivateOriginal)return row.route;
        // The private full-save diagnosis keeps every original proof and the
        // persisted login hash. Only this authenticated entrance uses admin.
        if(row.route.uid!==localSeed.UID||row.route.playerId!==localSeed.PLAYER_ID||row.route.loginHash!==localSeed.privateLoginHash)throw Error('Private diagnostic entrance owner mismatch');
        return {...row.route,loginHash:require('./player-account-state').loginKey('admin')};
      });
      const entry=await gateway.start({routes,port:entryPort,host,greeting,clientVersion,...(publicBeta?{verifyLogin:require('./public-beta/login').verify}: {})});entryGateways.push(entry);
      if(closing){await entry.close();throw Error('Account worker exited while opening gateway');}
    }
    for(const lease of leases)lease.update(value=>{value.phase='running';});
    const publicBetaRequest=(uid,payload)=>{
      if(!publicBeta||closing||uid!==accounts[0].uid||!payload||typeof payload!=='object'||Array.isArray(payload)||!['gold','mail','recharge','reset-first-gift','reset-limited-godsend','close-limited-godsend','limited-godsend-status','status'].includes(payload.operation)||Buffer.byteLength(JSON.stringify(payload))>8192)throw Error('Invalid local GM request');
      const row=workers.find(w=>w.uid===uid&&w.service==='lobby');if(!row?.child.connected||row.exited)throw Error('Local account worker unavailable');
      const requestId=require('node:crypto').randomUUID();
      return new Promise((resolve,reject)=>{const child=row.child,timer=setTimeout(()=>finish(Error('GM操作尚未确认，请点击“重试未确认操作”。')),20000);
        const message=v=>{if(v?.type==='public-beta-result'&&v.requestId===requestId&&v.uid===uid)finish(v.ok?null:Object.assign(Error(v.error||'GM操作失败'),{confirmedRejected:true,uncertain:v.uncertain!==false}),v.result);};
        const exited=()=>finish(Error('GM保存结果尚未确认，服务已退出。'));
        function finish(error,value){clearTimeout(timer);child.off('message',message);child.off('exit',exited);error?reject(error):resolve(value);}
        child.on('message',message);child.once('exit',exited);child.send({type:'public-beta-request',requestId,uid,payload},e=>{if(e)finish(e);});
      });
    };
    return {port:entryGateways[0].port,ports:entryGateways.map(entry=>entry.port),workers:workers.map(row=>({service:row.service,uid:row.uid,pid:row.child.pid,port:row.port})),close,done,...(publicBeta?{publicBetaRequest}:{})};
  }catch(error){await close('startup failed');throw error;}
}
module.exports={prepare,start};
