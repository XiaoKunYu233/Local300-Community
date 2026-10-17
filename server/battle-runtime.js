'use strict';
const fs=require('fs'),path=require('path');
require('./runtime/catalogs').assertRelease();
const {loadScenario}=require('./battle-scenario');
const {BattleSession}=require('./battle-session');
const {serve}=require('./battle-transport');
const ownership=require('./battle-ownership');

async function start({port=19015,profileFile,runtimeArgs,onResult=()=>{},onSelectionState=()=>{},onMatchResult=()=>{},now,tickMs=50}={}) {
  const stateFiles=require('./persistence/state-files');let ownsStorage=false;
  try{
  ownership.write(false,{reason:'runtime-start'});
  if(process.env.DSH_STATE_BACKEND==='sqlite'&&!require('./persistence/state-files').enabled()){
    const args=runtimeArgs||Object.entries(require('./runtime/control').profile(profileFile).options).map(([key,value])=>`--${key}=${value}`);
    if(!Array.isArray(args)||args.some(value=>typeof value!=='string'))throw Error('Invalid battle runtime options');
    const options=require('./runtime/options').parseOptions(args);
    require('./persistence/bootstrap').bootstrap({options});
    ownsStorage=true;
  }
  const scenario=loadScenario();
  const ticketAccount=process.env.DSH_BATTLE_TICKETS?require('./player-battle-appearance').accountFor(scenario.playerId):null;
  if(process.env.DSH_BATTLE_TICKETS&&!ticketAccount)throw Error('Battle tickets require an explicit account');
  const tickets=ticketAccount?new (require('./player-battle-ticket').BattleTickets)(process.env.DSH_BATTLE_TICKETS):null;
  const accountAvailable=()=>{
    if(stateFiles.frozen())return false;
    const pending=process.env.DSH_EQUIPMENT_PENDING||path.join(path.dirname(process.env.DSH_BAG_STATE||path.join(__dirname,'bag-state.live.json')),'equipment-economy-pending.json');
    // An unresolved physical recovery marker remains a stop condition even
    // when SQLite is authoritative and the mapped pending document is absent.
    if(fs.existsSync(pending))return false;
    if(new (require('./equipment-economy-commit').EquipmentEconomyCommit)(pending).frozen)return false;
    return !new (require('./mail-state').MailState)(process.env.DSH_MAIL_STATE||path.join(__dirname,'mail-state.json')).hasUnresolvedPending();
  };
  // Only authenticated account sessions earn online time. Legacy capture-only
  // battles cannot establish an account identity and remain uncredited.
  const online=ticketAccount?new (require('./player-account-state').OnlineSessions)(
    new (require('./player-account-state').PlayerAccounts)(path.resolve(process.env.DSH_PLAYER_ACCOUNTS)),{
      canAccrue:accountAvailable
    }):null;
  const updateOnline=(session,active)=>{
    if(!online)return;
    try{active?online.connect(ticketAccount.uid,session):online.disconnect(ticketAccount.uid,session);}
    catch(error){onResult({type:'online-save-error',message:error.message});}
  };
  const resultStore=ticketAccount?new (require('./player-account-state').PlayerAccounts)(path.resolve(process.env.DSH_PLAYER_ACCOUNTS)):null;
  const battleSkins=require('./player-battle-skin-selection'),summonerSelection=require('./summoner-selection-persistence'),selectionNative=require('./battle-selection-native');
  const skinCommit=resultStore?new (require('./equipment-economy-commit').EquipmentEconomyCommit)(
    process.env.DSH_EQUIPMENT_PENDING||path.join(path.dirname(process.env.DSH_BAG_STATE||path.join(__dirname,'bag-state.live.json')),'equipment-economy-pending.json')):null;
  const outbox=resultStore?new (require('./player-match-outbox').MatchOutbox)(resultStore,ticketAccount.uid):null;
  outbox?.recoverInterrupted();
  const flushResults=()=>{if(!outbox)return;try{outbox.flush(online.canAccrue);}catch(error){onResult({type:'match-save-deferred',message:error.message});}};
  flushResults();
  // The ownership marker is shared with the lobby process. A runtime can
  // briefly have more than one battle socket (for example while the client
  // hands the old socket back and opens the next match), so one session
  // returning must not release the lobby while another session is active.
  const activeSessions=new Set();
  const cosmetics=require('./player-battle-cosmetics');
  function cosmeticAccount(){
    const account=resultStore.get(ticketAccount.uid),plan=cosmetics.importPlan(account);
    if(plan){
      if(!accountAvailable()||skinCommit.frozen)throw Error('cosmetics-storage-unavailable');
      if(!skinCommit.run('battle-cosmetics-import',String(account.uid),[{name:'player-accounts',path:resultStore.file,save:()=>
        resultStore.update(account.uid,{expectedRevision:stateFiles.enabled()?resultStore.get(account.uid).revision:account.revision},a=>cosmetics.importApply(a,plan))}]))throw Error('cosmetics-import-frozen');
    }
    return resultStore.get(ticketAccount.uid);
  }
  function pushSkin(session,{force=false}={}){
    if(!ticketAccount||!activeSessions.has(session)||!['selecting','preparing'].includes(session.phase)||!session.heroId||!accountAvailable()||skinCommit.frozen)return;
    const frame=stateFiles.readSnapshot(()=>battleSkins.notice(resultStore.get(ticketAccount.uid),session.heroId));
    if(!accountAvailable()||skinCommit.frozen)return;
    const signature=session.heroId+':'+frame.subarray(12).toString('hex');
    if(force||session.skinSignature!==signature){session.send([frame]);session.skinSignature=signature;
      onResult({type:'battle-skin-notice-queued',uid:ticketAccount.uid,playerId:scenario.playerId,phase:session.phase,heroId:session.heroId,
        ...battleSkins.decodeNotice(frame),sha256:require('node:crypto').createHash('sha256').update(frame).digest('hex')});}
  }
  function titleSnapshot(){
    if(!ticketAccount||!accountAvailable())return null;
    const account=require('./player-battle-appearance').accountFor(scenario.playerId);
    return {account,frames:[require('./player-title-wire').reply(account),require('./player-personal-settings').reply(account)].filter(Boolean)};
  }
  function accountIntro(){
    if(!accountAvailable())throw Error('Account storage is unavailable for hero selection');
    const account=cosmeticAccount(),candidate=require('./player-heroes-selection');
    const original=scenario.introForAccount().filter(frame=>frame.readUInt16LE(8)!==23499&&!cosmetics.isFrame(frame));original.push(...cosmetics.initial(account));let pool=null;
    const frames=original.map(frame=>{
      if(frame.readUInt16LE(8)!==candidate.TAG)return frame;
      if(pool!==null)throw Error('Multiple native hero candidate lists in intro');
      const projected=candidate.project(account,frame,scenario.heroes);
      pool=candidate.decode(projected).rows.map(row=>row.heroId);return projected;
    });
    if(!pool?.length)throw Error('No currently owned hero has a verified battle bootstrap');
    if(!pool.includes(scenario.selectionConfig.timeoutPolicy.defaultHero))throw Error('Verified timeout hero is unavailable');
    const skills=summonerSelection.read(account,scenario.mapId,scenario.selectionConfig.initialSkills);
    return {frames:frames.map(frame=>require('./battle-wire').transform(frame,f=>selectionNative.patchSkills(f,skills,scenario.playerId))),pool,skills};
  }
  function requireCurrentHero(heroId){
    if(!ticketAccount)return;
    let reason;
    try{
      if(!accountAvailable())throw Error('Account storage is unavailable for hero selection');
      const account=require('./player-battle-appearance').accountFor(scenario.playerId);
      if(account.uid!==ticketAccount.uid||!require('./player-account-state').owns(account,'heroes',heroId))
        throw Error('Selected hero is not currently owned or has expired');
    }catch(error){reason=error.message;}
    if(reason){onResult({type:'hero-selection-finalization-rejected',uid:ticketAccount.uid,playerId:scenario.playerId,heroId,reason});throw Error(reason);}
  }
  function requireSceneSkin(heroId,skinId){
    if(!ticketAccount)return;
    requireCurrentHero(heroId);
    const account=resultStore.get(ticketAccount.uid);
    if(!Number.isInteger(skinId)||skinId<0||skinId>31||
      skinId&&!require('./player-account-state').owns(account,'skins',require('./player-heroes').skinKey(heroId,skinId))){
      onResult({type:'battle-skin-finalization-rejected',uid:ticketAccount.uid,playerId:scenario.playerId,heroId,skinId,reason:'scene-skin-not-owned-or-expired'});
      throw Error('Scene skin is not currently owned or has expired');
    }
    if(!accountAvailable()||skinCommit.frozen)throw Error('Scene skin storage is unavailable');
  }
  const runtime=await serve(send=>{
    let session,pages;
    const saveSummonerSelection=({skills,mapId,phase})=>{
      if(!ticketAccount)return {ok:true};
      if(!activeSessions.has(session)||!accountAvailable()||skinCommit.frozen)return {ok:false,reason:'summoner-selection-unavailable'};
      const payload=Buffer.alloc(4);payload.writeUInt16LE(skills.D);payload.writeUInt16LE(skills.F,2);
      const frame=require('./battle-wire').frame(23442,0,payload),entity=session.sim?.entities.get(scenario.playerId);
      const context={authenticated:true,available:true,uid:ticketAccount.uid,playerId:scenario.playerId,mapId,phase,
        currentSkills:phase==='playing'?{D:entity?.skills.D?.id,F:entity?.skills.F?.id}:undefined,sim:phase==='playing'?session.sim:undefined,entity:phase==='playing'?entity:undefined};
      try{
        summonerSelection.prepare(resultStore.get(ticketAccount.uid),frame,context);
        if(!skinCommit.run('summoner-selection',String(ticketAccount.uid),[{name:'player-accounts',path:resultStore.file,save:()=>{
          if(stateFiles.frozen())throw Error('Summoner selection storage frozen');
          const draft=summonerSelection.prepare(resultStore.get(ticketAccount.uid),frame,context);
          return resultStore.update(ticketAccount.uid,{expectedRevision:draft.expectedRevision},account=>summonerSelection.apply(account,draft));
        }}]))throw Error('Summoner selection storage frozen');
        onResult({type:'summoner-selection-committed',uid:ticketAccount.uid,playerId:scenario.playerId,mapId,phase,skills});return {ok:true};
      }catch(error){onResult({type:'summoner-selection-save-rejected',uid:ticketAccount.uid,playerId:scenario.playerId,mapId,phase,reason:error.message});return {ok:false,reason:'summoner-selection-save-failed'};}
    };
    const sendChecked=frames=>{
      send(frames);
      for(const row of require('./battle-roster-audit').inspect(frames))onResult({...row,matchId:session?.matchId,phase:session?.phase,worldTime:session?.sim?.time});
      for(const row of require('./battle-appearance-audit').inspect(frames,{playerId:scenario.playerId,heroId:session?.heroId}))
        onResult({...row,matchId:session?.matchId,phase:session?.phase,worldTime:session?.sim?.time});
      for(const frame of frames)if(frame.readUInt16LE(8)===27008){
        const rows=require('./player-heroes-selection').decode(frame).rows;
        onResult({type:'hero-candidates-send-queued',tag:27008,uid:ticketAccount?.uid??null,playerId:scenario.playerId,
          count:rows.length,bytes:frame.length,stream:frame.readUInt32LE(4),flags:frame.readUInt16LE(10),
          sha256:require('node:crypto').createHash('sha256').update(frame).digest('hex')});
      }
    };
    session=new BattleSession({...scenario,onSummonerSelection:saveSummonerSelection,intro:ticketAccount?[]:scenario.introForAccount(),send:sendChecked,now,returnOnDeferredResult:true,
      createWorld:(heroId,skills)=>{requireCurrentHero(heroId);const sim=scenario.createWorld(heroId,skills);if(ticketAccount)sim.entities.get(scenario.playerId).wardSkinItem=cosmetics.selected(resultStore.get(ticketAccount.uid),2);return sim;},
      bootstrap:(heroId,skills,sim)=>{
        requireCurrentHero(heroId);let frames=scenario.bootstrap(heroId,skills,sim);
        if(pages){const authoritative=pages.initial();frames=frames.map(frame=>require('./battle-wire').transform(frame,f=>{
          if(f.readUInt16LE(8)!==36273)return f;return authoritative.find(a=>a.readUInt16LE(8)===36273);
        }));}
        if(!ticketAccount)return frames;
        frames=frames.map(f=>require('./battle-wire').transform(f,part=>cosmetics.isFrame(part)?null:part)).filter(Boolean);
        requireSceneSkin(heroId,sim.entities.get(scenario.playerId).skinId);
        return battleSkins.patchLoading(frames.filter(frame=>frame.readUInt16LE(8)!==23499),{playerId:scenario.playerId,heroId,skinId:sim.entities.get(scenario.playerId).skinId});
      },
      preparePackets:(heroId,skills)=>{requireCurrentHero(heroId);return scenario.preparePackets(heroId,skills);},
      onMatchResult:result=>{
      if(outbox){outbox.enqueue(result);flushResults();}onMatchResult(result);
    },
      readyPackets:sim=>{
        requireSceneSkin(session.heroId,sim.entities.get(scenario.playerId).skinId);
        // 14005 addresses the role's scene object. Send it after the native
        // spawns, including local actors with no recorded 1052 template.
        const snapshot=titleSnapshot(),frames=snapshot?.frames||[];session.titleSignature=Buffer.concat(frames).toString('hex');
        session.titleOwnedIds=snapshot?require('./player-title-wire').ownedIds(snapshot.account):null;
        return [...scenario.readyPackets(sim),...frames,...(pages?pages.initial():[]),...(ticketAccount?[cosmetics.scene(resultStore.get(ticketAccount.uid))]:[])];
      },
      authorizeEntry:token=>{
        if(tickets&&!tickets.consume(token,{uid:ticketAccount.uid,playerId:scenario.playerId,mapId:scenario.mapId}))return false;
        if(ticketAccount){
          try{
            const intro=accountIntro();session.intro=[...intro.frames.filter(frame=>![11678,11680,11688,36273].includes(frame.readUInt16LE(8))),...pages.initial()];session.selection.skills={...intro.skills};session.heroes=new Set(intro.pool);session.selection.heroes=new Set(intro.pool);
          }catch(error){
            onResult({type:'hero-selection-unavailable',uid:ticketAccount.uid,playerId:scenario.playerId,reason:error.message});return false;
          }
        }
        outbox?.begin({matchId:session.matchId,mapId:session.mapId,heroId:null});return true;
      },
      onBattleOwnership:state=>{
        if(state.active)activeSessions.add(session);else activeSessions.delete(session);
        updateOnline(session,state.active);
        if(outbox&&!state.active&&!session.sim?.getMatchResult()){
          const stats=session.sim?.matchStats;
          try{outbox.interrupt({matchId:session.matchId,mapId:session.mapId,heroId:session.heroId},state.reason==='battle-return'?'left':'disconnected',!stats||stats.startedAt===null?0:Math.max(0,session.sim.time-stats.startedAt));flushResults();}
          catch(error){onResult({type:'match-interruption-save-error',message:error.message});}
        }
        ownership.write(activeSessions.size>0,{reason:activeSessions.size>0?'battle-active':state.reason,
          playerId:state.playerId,mapId:state.mapId,activeSessions:activeSessions.size});
      },
      onSelectionState:state=>{
        if(outbox&&state.phase==='loading')outbox.begin({matchId:session.sim.matchStats.matchId,mapId:session.mapId,heroId:session.heroId});
        onSelectionState(state);onResult({type:'selection-state',...state});}});
    if(ticketAccount){
      const soulTemplate=require('./matchentity').loadMatch('002').s2c.flatMap(f=>require('./battle-wire').expand(f)).find(f=>f.readUInt16LE(8)===36273);
      pages=new(require('./battle-page-selection').BattlePages)({session,uid:ticketAccount.uid,commit:skinCommit,available:accountAvailable,soulTemplate});
      const accountOperations=new(require('./battle-account-operations').BattleAccountOperations)({session,commit:skinCommit,available:accountAvailable});
      const receive=session.receive.bind(session);
      session.receive=frame=>{
        if(Buffer.isBuffer(frame)&&frame.length>=12&&frame.readUInt32LE(0)===frame.length){
          if(frame.readUInt16LE(8)===9018&&frame.length>=20&&[2,5].includes(frame.readUInt32LE(16))){
            try{
              if(!activeSessions.has(session)||!['selecting','preparing'].includes(session.phase)||!accountAvailable()||skinCommit.frozen)return {ok:false,reason:'cosmetic-selection-unavailable'};
              const r=cosmetics.request(frame),a=resultStore.get(ticketAccount.uid);cosmetics.apply(JSON.parse(JSON.stringify(a)),r);
              if(!skinCommit.run('battle-cosmetic-selection',String(a.uid),[{name:'player-accounts',path:resultStore.file,save:()=>
                resultStore.update(a.uid,{expectedRevision:stateFiles.enabled()?resultStore.get(a.uid).revision:a.revision},next=>cosmetics.apply(next,r))}]))throw Error('cosmetic-selection-frozen');
              session.send([cosmetics.reply(resultStore.get(a.uid),r.category)]);return {ok:true};
            }catch(error){return {ok:false,reason:error.message};}
          }
          const result=pages.handle(frame);if(result!==null)return result;
          if(session.phase==='playing'){const operation=accountOperations.handle(frame);if(operation!==null)return operation;}
        }
        if(Buffer.isBuffer(frame)&&frame.length>=12&&frame.readUInt16LE(8)===23442){
          let skills;try{skills=summonerSelection.request(frame);}catch{return {ok:false,reason:'invalid-summoner-selection'};}
          if(session.phase==='playing'){
            const entity=session.sim?.entities.get(scenario.playerId);let plan;
            try{plan=summonerSelection.changePlan(session.sim,entity,skills);}catch{return {ok:false,reason:'playing-summoner-reorder-only'};}
            const saved=saveSummonerSelection({skills,mapId:session.mapId,phase:session.phase});
            if(saved.ok)summonerSelection.applyChange(session.sim,entity,plan);
            const actual={D:entity.skills.D.id,F:entity.skills.F.id};if(saved.ok)session.selection.skills={...actual};
            const body=Buffer.alloc(8);body.writeUInt32LE(actual.D);body.writeUInt32LE(actual.F,4);
            const frames=[require('./battle-wire').frame(9017,0,body),selectionNative.skills(scenario.playerId,actual)];
            for(const slot of ['D','F'])frames.push(require('./battle-native').cooldown({time:session.sim.time,readyAt:entity.cooldowns[slot]??session.sim.time},entity,entity.skills[slot]));
            session.send(frames);return saved.ok?{ok:true,skills:actual}:saved;
          }
        }
        if(Buffer.isBuffer(frame)&&frame.length>=12&&frame.readUInt16LE(8)===23440){
          let requested;
          try{requested=battleSkins.request(frame);}catch{return {ok:false,reason:'invalid-battle-skin-request'};}
          session.advanceSelection();
          onResult({type:'battle-skin-selection-request',uid:ticketAccount.uid,playerId:scenario.playerId,phase:session.phase,heroId:session.heroId,skinId:requested.skinId});
          if(!activeSessions.has(session)||!['selecting','preparing'].includes(session.phase)||!session.heroId||!accountAvailable()||skinCommit.frozen)
            return {ok:false,reason:'battle-skin-selection-unavailable'};
          let prepared,context;
          try{
            const account=resultStore.get(ticketAccount.uid);context={authenticated:true,available:true,
              uid:ticketAccount.uid,playerId:scenario.playerId,phase:session.phase,heroId:session.heroId};
            prepared=battleSkins.prepare(account,frame,context);
            battleSkins.apply(JSON.parse(JSON.stringify(account)),prepared);
          }catch(error){
            const previewOnly=error.code==='BATTLE_SKIN_NOT_OWNED';
            onResult({type:'battle-skin-selection-rejected',uid:ticketAccount.uid,playerId:scenario.playerId,phase:session.phase,heroId:session.heroId,
              skinId:requested.skinId,reason:error.message,previewOnly});
            // The native button also sends23440 for a local model preview.
            // An unavailable skin cannot become the saved choice, but sending
            // 23499 here clears/rebuilds the UI at the previous saved skin and
            // prevents browsing past an unowned card to another owned skin.
            if(!previewOnly)try{pushSkin(session,{force:true});}catch{}
            return {ok:false,reason:error.message,previewOnly};
          }
          try{
            if(!skinCommit.run('battle-skin-selection',`${ticketAccount.uid}:${prepared.heroId}`,[{name:'player-accounts',path:resultStore.file,
              save:()=>{
                // Our own prepared marker is expected here; other state and
                // identity checks still run inside the serialized update.
                if(stateFiles.frozen())throw Error('Battle skin storage frozen');
                // SQLite has now acquired BEGIN IMMEDIATE. Refresh the draft
                // revision and eligibility under that lock: a legitimate
                // lobby online tick between preflight and this transaction
                // must not freeze a pure selection with no protocol revision.
                const committed=stateFiles.enabled()?battleSkins.prepare(resultStore.get(ticketAccount.uid),frame,context):prepared;
                return resultStore.update(ticketAccount.uid,{expectedRevision:committed.expectedRevision},account=>battleSkins.apply(account,committed));
              }}]))throw Error('Battle skin storage frozen');
            for(const peer of activeSessions)if(peer.heroId===prepared.heroId)pushSkin(peer,{force:peer===session});
            onResult({type:'battle-skin-selection-committed',uid:ticketAccount.uid,playerId:scenario.playerId,heroId:prepared.heroId,skinId:prepared.skinId});
            return {ok:true};
          }catch(error){
            onResult({type:'battle-skin-selection-save-rejected',uid:ticketAccount.uid,playerId:scenario.playerId,heroId:prepared.heroId,reason:error.message});
            return {ok:false,reason:'battle-skin-save-failed'};
          }
        }
        if(session.phase==='loading'&&Buffer.isBuffer(frame)&&frame.length===12&&frame.readUInt16LE(8)===1023){
          try{requireSceneSkin(session.heroId,session.sim.entities.get(scenario.playerId).skinId);}catch(error){session.close();return {ok:false,close:true,reason:error.message};}
        }
        if(['selecting','preparing'].includes(session.phase)&&Buffer.isBuffer(frame)&&frame.length===14&&[23438,23436].includes(frame.readUInt16LE(8))){
          try{
            if(!accountAvailable())return {ok:false,reason:'account-hero-selection-unavailable'};
            const account=require('./player-battle-appearance').accountFor(scenario.playerId),heroId=frame.readUInt16LE(12);
            if(!require('./player-account-state').owns(account,'heroes',heroId))return {ok:false,reason:'hero-not-owned-or-expired'};
          }catch{return {ok:false,reason:'account-hero-selection-unavailable'};}
        }
        const result=receive(frame);
        if(result?.ok&&Buffer.isBuffer(frame)&&frame.length===14&&frame.readUInt16LE(8)===23438){
          try{pushSkin(session,{force:true});}catch(error){return {ok:false,reason:error.message};}
        }
        return result;
      };
    }
    return session;
  },{port,tickMs,onResult});
  const onlineTimer=online?setInterval(()=>{flushResults();try{online.tick(ticketAccount.uid);}catch(error){onResult({type:'online-save-error',message:error.message});}},10000):null;
  onlineTimer?.unref();
  const titleTimer=process.env.DSH_PLAYER_ACCOUNTS?setInterval(()=>{
    try{
      const snapshot=titleSnapshot();if(!snapshot)return;
      const {account,frames}=snapshot,signature=Buffer.concat(frames).toString('hex');
      for(const {session}of runtime.clients)if(['playing','finished'].includes(session.phase)){
        const ownership=require('./player-title-wire').ownershipChanges(account,session.titleOwnedIds);
        if(ownership.frames.length||session.titleSignature!==signature){session.send([...ownership.frames,...frames]);session.titleSignature=signature;}
        session.titleOwnedIds=ownership.ids;
      }
    }catch(error){onResult({type:'title-refresh-error',message:error.message});}
  },1000):null;
  titleTimer?.unref();
  const skinTimer=ticketAccount?setInterval(()=>{
    for(const session of activeSessions)try{pushSkin(session);}catch(error){onResult({type:'battle-skin-refresh-error',message:error.message});}
  },1000):null;
  skinTimer?.unref();
  let closePromise;
  return {...runtime,scenario,close:()=>{if(!closePromise){clearInterval(onlineTimer);clearInterval(titleTimer);clearInterval(skinTimer);closePromise=runtime.close().finally(()=>{if(ownsStorage)stateFiles.close();});}return closePromise;}};
  }catch(error){ownership.write(false,{reason:'runtime-error'});if(ownsStorage)stateFiles.close();throw error;}
}

if(require.main===module) {
  const parentWasConnected=process.connected;let parentLost=false,shutdownOnParentLoss;
  if(parentWasConnected)process.once('disconnect',()=>{parentLost=true;shutdownOnParentLoss?.();});
  const arg=process.argv.slice(2).find(x=>x.startsWith('--port='));
  const port=arg?Number(arg.slice(7)):19015;
  const profileArg=process.argv.slice(2).find(x=>x.startsWith('--profile='));
  const profileFile=profileArg?path.resolve(profileArg.slice(10)):undefined;
  const runtimeArg=process.argv.slice(2).find(x=>x.startsWith('--runtime-options='));
  const runtimeArgs=runtimeArg?JSON.parse(runtimeArg.slice(18)):undefined;
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
  const logPath=process.env.DSH_BATTLE_LOG_FILE||path.join(process.env.DSH_LOG_DIR||path.join(__dirname,'logs'),'battle-runtime.jsonl');
  fs.mkdirSync(path.dirname(logPath),{recursive:true});
  const log=event=>fs.appendFileSync(logPath,JSON.stringify({time:new Date().toISOString(),...event})+'\n');
  start({port,profileFile,runtimeArgs,onResult:log,onMatchResult:result=>log({type:'match-result',result})}).then(runtime=>{
    const state={type:'listening',pid:process.pid,host:'127.0.0.1',port:runtime.port,
      map:runtime.scenario.mapId,heroes:runtime.scenario.heroes,nativeClientVerified:false};
    log(state);console.log(JSON.stringify(state));
    const watch=setInterval(()=>{
      for(const {session:s} of runtime.clients){
        if(!s.sim)continue;const h=s.sim.entities.get(s.playerId),target=s.sim.entities.get(h.targetId);
        log({type:'state',phase:s.phase,worldTime:s.sim.time,wave:s.sim.wave,
          hero:{x:h.x,z:h.z,hp:h.hp,mp:h.mp,speed:h.speed,alive:h.alive,target:h.targetId},
          target:target?{x:target.x,z:target.z,hp:target.hp,alive:target.alive,distance:Math.hypot(h.x-target.x,h.z-target.z)}:null});
      }
    },3000);
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;clearInterval(watch);await runtime.close();ownership.write(false,{reason:'runtime-stop'});log({type:'stopped'});if(process.connected)process.disconnect();};
    shutdownOnParentLoss=stop;
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    if(parentLost){stop();return;}
    if(process.connected){process.on('message',message=>{if(message?.type==='runtime-stop')stop();});
      process.send({type:'runtime-ready',service:'battle',ports:[runtime.port]});}
  }).catch(error=>{ownership.write(false,{reason:'startup-error'});log({type:'startup-error',message:error.message});console.error(error.message);process.exitCode=1;});
}
module.exports={start};
