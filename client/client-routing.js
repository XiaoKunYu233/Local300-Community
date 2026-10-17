'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const RELATIVE_CONFIG=path.join('Config','serverlist.ini');
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
class RoutingError extends Error{
 constructor(code,message,context={}){super(message);this.code=code;this.context=context;}
}
function fail(code,message,context){throw new RoutingError(code,message,context);}
function result(fn){try{return fn();}catch(error){return {ok:false,code:error instanceof RoutingError?error.code:'IO_ERROR',message:error instanceof RoutingError?error.message:'操作未完成，请查看恢复状态后重试。工具不会跳过备份直接修改配置。',context:error instanceof RoutingError?error.context:{systemCode:error.code||null}};}}
function contained(root,file){const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function readPlain(file,{missing=false,max=2*1024*1024}={}){
 let stat;try{stat=fs.lstatSync(file);}catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}
 if(!stat.isFile()||stat.isSymbolicLink())fail('UNSAFE_FILE','选择的文件不是普通文件，已停止操作。',{file});
 if(stat.size>max)fail('UNSUPPORTED_FILE','配置文件大小异常，已停止操作。',{file,bytes:stat.size});
 return fs.readFileSync(file);
}
function syncDirectory(directory){try{const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(error){if(!['EISDIR','EPERM','EACCES','EINVAL','ENOTSUP'].includes(error.code))throw error;}}
function durableNew(file,bytes,mode=0o600){
 const fd=fs.openSync(file,'wx',mode);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(sha256(readPlain(file))!==sha256(bytes))fail('BACKUP_VERIFY_FAILED','备份写入核对失败，客户端配置没有被修改。',{file});
 syncDirectory(path.dirname(file));
}
function atomicWrite(file,bytes,{expectedHash,hook,mode=0o600}={}){
 const temporary=path.join(path.dirname(file),'.'+path.basename(file)+'.'+crypto.randomUUID()+'.tmp');
 try{
  durableNew(temporary,bytes,mode);
  if(hook)hook();
  if(expectedHash!==undefined){const current=readPlain(file,{missing:true});const actual=current===null?null:sha256(current);if(actual!==expectedHash)fail('FILE_CHANGED','配置在操作期间发生变化，已保留新配置，请重新查看恢复状态。',{expectedSha256:expectedHash,currentSha256:actual});}
  fs.renameSync(temporary,file);syncDirectory(path.dirname(file));
  if(sha256(readPlain(file))!==sha256(bytes))fail('WRITE_VERIFY_FAILED','配置写入后的核对未通过，请查看恢复状态；原备份仍保留。');
 }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function parseRoutes(bytes){
 if(bytes.length>=2&&((bytes[0]===255&&bytes[1]===254)||(bytes[0]===254&&bytes[1]===255))||bytes.includes(0))fail('UNSUPPORTED_ENCODING','这个客户端配置格式暂不支持，未修改任何配置。');
 const text=bytes.toString('latin1'),entries=[];
 for(const [code,zoneId]of [['SESL','20034'],['ZHJ','20032']]){
  const expression=new RegExp('^node AREA SERVER [^\\r\\n]*'+code+'[^\\r\\n]*[ \\t]+(?<hosts>[^ \\t\\r\\n]+)[ \\t]+(?<ports>[^ \\t\\r\\n]+)(?<tail>[ \\t]+'+zoneId+'(?:[ \\t][^\\r\\n]*)?)\\r?$','gm');
  const matches=[...text.matchAll(expression)];if(matches.length!==1)fail('ROUTE_FORMAT_MISMATCH','未找到唯一的 SESL 和 ZHJ 区服配置，已停止修改。',{code,matches:matches.length});
  const match=matches[0];
  // Locate the confirmed final host/port pair; high GBK bytes are never decoded.
  const pair=new RegExp('('+match.groups.hosts.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')[ \\t]+('+match.groups.ports.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')(?=[ \\t]+'+zoneId+')');
  const pairMatch=pair.exec(match[0]);if(!pairMatch)fail('ROUTE_FORMAT_MISMATCH','区服地址位置无法核对，未修改配置。',{code});
  const start=match.index+pairMatch.index,end=start+pairMatch[0].length;
  if(!/^[A-Za-z0-9._:|-]+$/.test(match.groups.hosts)||!/^\d+\|\d+$/.test(match.groups.ports))fail('ROUTE_FORMAT_MISMATCH','区服地址或端口格式无法核对，未修改配置。',{code});
  entries.push({code,zoneId,hosts:match.groups.hosts,ports:match.groups.ports,start,end});
 }
 return entries;
}
const loopback=host=>/^(?:localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0)$/i.test(host);
function baselineKind(entries){return entries.some(e=>e.hosts.split('|').some(loopback))?'before-test':'remote-original';}
function rewriteRoutes(bytes,host,gatewayPorts){
 if(typeof host!=='string'||!host||host.length>253||!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host))fail('INVALID_HOST','测试服地址格式不正确。');
 if(!Array.isArray(gatewayPorts)||gatewayPorts.length!==2||gatewayPorts.some(p=>!Number.isInteger(p)||p<1||p>65535)||gatewayPorts[0]===gatewayPorts[1])fail('INVALID_PORTS','需要两个不同的有效测试服端口。');
 const entries=parseRoutes(bytes),text=bytes.toString('latin1');let output=text;
 for(const entry of [...entries].sort((a,b)=>b.start-a.start))output=output.slice(0,entry.start)+host+' '+gatewayPorts.join('|')+output.slice(entry.end);
 const next=Buffer.from(output,'latin1');const checked=parseRoutes(next);if(checked.some(e=>e.hosts!==host||e.ports!==gatewayPorts.join('|')))fail('ROUTE_VERIFY_FAILED','测试服地址核对失败，未修改配置。');
 return next;
}
function resolveClient(clientDirectory,{allowMissingConfig=false}={}){
 if(typeof clientDirectory!=='string'||!clientDirectory)fail('CLIENT_DIRECTORY_REQUIRED','请先选择安装 300.exe 的游戏文件夹。');
 const root=fs.realpathSync(path.resolve(clientDirectory));if(!fs.statSync(root).isDirectory())fail('CLIENT_DIRECTORY_REQUIRED','请选择游戏文件夹，不是文件。');
 const executable=path.join(root,'300.exe'),exeStat=fs.lstatSync(executable);if(!exeStat.isFile()||exeStat.isSymbolicLink())fail('CLIENT_NOT_FOUND','这个文件夹没有可直接运行的 300.exe。');
 const fd=fs.openSync(executable,'r'),magic=Buffer.alloc(2);try{fs.readSync(fd,magic,0,2,0);}finally{fs.closeSync(fd);}if(magic.toString('ascii')!=='MZ')fail('CLIENT_NOT_FOUND','300.exe 不是有效的 Windows 客户端。');
 const configDirectory=fs.realpathSync(path.join(root,'Config'));if(!contained(root,configDirectory))fail('UNSAFE_CLIENT_PATH','客户端配置指向游戏文件夹之外，已停止操作。');
 const file=path.join(configDirectory,'serverlist.ini'),bytes=readPlain(file,{missing:allowMissingConfig});
 return {root,executable,file,bytes};
}
function createRoutingManager({stateDirectory,hooks={}}={}){
 if(typeof stateDirectory!=='string'||!stateDirectory)throw new TypeError('stateDirectory is required');
 const stateRoot=path.resolve(stateDirectory);
 function paths(client){
  if(samePath(stateRoot,client.root)||contained(client.root,stateRoot))fail('UNSAFE_BACKUP_DIRECTORY','恢复资料必须保存在游戏文件夹之外，避免客户端更新覆盖备份。');
  const key=sha256(Buffer.from(process.platform==='win32'?client.root.toLowerCase():client.root)),directory=path.join(stateRoot,key);
  return {key,directory,record:path.join(directory,'current.json'),official:path.join(directory,'official.json'),lock:path.join(directory,'operation.lock')};
 }
 function ensureStore(p){fs.mkdirSync(p.directory,{recursive:true});const actual=fs.realpathSync(p.directory);if(!samePath(actual,p.directory))fail('UNSAFE_BACKUP_DIRECTORY','恢复资料目录存在链接或转向，已停止操作。');}
 function loadJson(file){const bytes=readPlain(file,{missing:true});if(bytes===null)return null;try{return JSON.parse(bytes.toString('utf8'));}catch{fail('RECOVERY_RECORD_INVALID','恢复记录损坏，未修改配置。请保留整个恢复资料文件夹。');}}
 function validateBackupShape(backup){if(!backup||!validHash(backup.sha256)||!Number.isInteger(backup.bytes)||backup.bytes<0||typeof backup.relativePath!=='string'||!/^(?:original|official|conflicts)\/[a-f0-9-]{36}\.bin$/.test(backup.relativePath))fail('RECOVERY_RECORD_INVALID','恢复记录中的备份信息无法核对，未修改配置。');}
 function readBackup(p,backup){validateBackupShape(backup);const file=path.join(p.directory,...backup.relativePath.split('/'));let bytes;try{const actual=fs.realpathSync(file);if(!contained(p.directory,actual)||!samePath(actual,file))fail('UNSAFE_BACKUP_DIRECTORY','备份路径存在链接或转向，未修改配置。');bytes=readPlain(file);}catch(error){if(error.code==='ENOENT')fail('BACKUP_MISSING','找不到完整备份，工具不会修改客户端配置。');throw error;}if(bytes.length!==backup.bytes||sha256(bytes)!==backup.sha256)fail('BACKUP_CORRUPT','备份已变化或损坏，工具不会修改客户端配置。',{relativePath:backup.relativePath});return bytes;}
 function loadRecord(p,client){const record=loadJson(p.record);if(record===null)return null;if(record.version!==1||record.key!==p.key||!samePath(record.clientDirectory||'',client.root)||record.configRelativePath!==RELATIVE_CONFIG||!['prepared','applying','applied','restoring','restored'].includes(record.phase)||!/^[a-f0-9-]{36}$/.test(record.sessionId||'')||!['remote-original','before-test'].includes(record.baselineKind)||!Array.isArray(record.displacedBackups))fail('RECOVERY_RECORD_INVALID','恢复记录与所选客户端不一致，未修改配置。');const originalBytes=readBackup(p,record.original);if(baselineKind(parseRoutes(originalBytes))!==record.baselineKind)fail('RECOVERY_RECORD_INVALID','恢复记录的原服标记与完整备份不一致，未修改配置。');if(record.installed&&(!validHash(record.installed.sha256)||!Number.isInteger(record.installed.bytes)))fail('RECOVERY_RECORD_INVALID','恢复记录无法核对，未修改配置。');if(record.intent&&(!['apply','restore'].includes(record.intent.operation)||record.intent.fromSha256!==null&&!validHash(record.intent.fromSha256)||!validHash(record.intent.to?.sha256)))fail('RECOVERY_RECORD_INVALID','未完成操作的恢复记录损坏，未修改配置。');return record;}
 function saveRecord(p,record){record.updatedAt=new Date().toISOString();atomicWrite(p.record,Buffer.from(JSON.stringify(record,null,2)+'\n'));}
 function official(p){const record=loadJson(p.official);if(record===null)return null;if(record.version!==1||record.key!==p.key)fail('RECOVERY_RECORD_INVALID','原版备份记录无法核对，未修改配置。');const bytes=readBackup(p,record.backup);if(baselineKind(parseRoutes(bytes))!=='remote-original')fail('OFFICIAL_BACKUP_INVALID','导入的备份包含本地测试路由，不能当作原服配置。');return {...record,bytes};}
 function backup(p,kind,bytes){hooks.beforeBackupWrite?.(kind);const relativePath=kind+'/'+crypto.randomUUID()+'.bin',file=path.join(p.directory,...relativePath.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});if(!samePath(fs.realpathSync(path.dirname(file)),path.dirname(file)))fail('UNSAFE_BACKUP_DIRECTORY','备份目录存在链接或转向，未修改配置。');durableNew(file,bytes);return {relativePath,bytes:bytes.length,sha256:sha256(bytes)};}
 function withLock(p,fn){
  ensureStore(p);const token=crypto.randomUUID();
  try{durableNew(p.lock,Buffer.from(JSON.stringify({version:1,pid:process.pid,token,createdAt:new Date().toISOString()})));}catch(error){
   if(error.code!=='EEXIST')throw error;const owner=loadJson(p.lock);if(!owner||!Number.isInteger(owner.pid)||owner.pid<1||typeof owner.token!=='string')fail('RECOVERY_LOCK_INVALID','上次操作锁无法核对，请保留恢复资料并联系作者。');let alive=true;try{process.kill(owner.pid,0);}catch(probe){if(probe.code==='ESRCH')alive=false;else if(probe.code!=='EPERM')throw probe;}
   if(alive)fail('BUSY','另一个工具实例正在操作这个客户端，请先关闭它。');fs.unlinkSync(p.lock);durableNew(p.lock,Buffer.from(JSON.stringify({version:1,pid:process.pid,token,createdAt:new Date().toISOString()})));
  }
  try{return fn();}finally{const owner=loadJson(p.lock);if(owner?.token===token)fs.unlinkSync(p.lock);}
 }
 function freshRecord(p,client){const entries=parseRoutes(client.bytes),record={version:1,key:p.key,clientDirectory:client.root,configRelativePath:RELATIVE_CONFIG,sessionId:crypto.randomUUID(),createdAt:new Date().toISOString(),phase:'prepared',baselineKind:baselineKind(entries),original:backup(p,'original',client.bytes),originalRoutes:entries.map(({code,hosts,ports,zoneId})=>({code,hosts,ports,zoneId})),installed:null,intent:null,displacedBackups:[]};saveRecord(p,record);return record;}
 function knownHashes(record){return [record.original.sha256,record.installed?.sha256,record.intent?.fromSha256,record.intent?.to.sha256,record.lastRestored?.sha256].filter(Boolean);}
 function settleCompletedIntent(p,record,currentHash){if(record.intent&&record.intent.to.sha256===currentHash){if(record.intent.operation==='apply'){record.installed=record.intent.to;record.phase='applied';}else{record.lastRestored={...record.intent.to,target:record.intent.target};record.phase='restored';}record.intent=null;saveRecord(p,record);}return record;}
 function inspectClient({clientDirectory}={}){return result(()=>{const client=resolveClient(clientDirectory),entries=parseRoutes(client.bytes);return {ok:true,code:'CLIENT_READY',message:'已找到客户端。',context:{clientDirectory:client.root,configPath:client.file,executable:client.executable,bytes:client.bytes.length,sha256:sha256(client.bytes),baselineKind:baselineKind(entries),routes:entries.map(({code,hosts,ports,zoneId})=>({code,hosts,ports,zoneId}))}};});}
 function getRecoveryStatus({clientDirectory}={}){return result(()=>{const client=resolveClient(clientDirectory,{allowMissingConfig:true}),p=paths(client),record=loadRecord(p,client),imported=official(p),currentHash=client.bytes===null?null:sha256(client.bytes);let status=record?'ready':'no-backup';if(record){if(client.bytes===null)status='missing-config';else if(record.intent?.to.sha256===currentHash)status='completed-pending-record';else if(!knownHashes(record).includes(currentHash))status='external-change';else status=record.phase;}return {ok:true,code:'RECOVERY_STATUS',message:status==='external-change'?'客户端配置被其他程序或原版更新改动，自动恢复不会覆盖它。':status==='no-backup'?'尚未创建本工具备份。':'恢复资料已核对。',context:{clientDirectory:client.root,status,phase:record?.phase||null,currentSha256:currentHash,baselineKind:record?.baselineKind||null,hasBackup:!!record,officialRestoreAvailable:!!imported||record?.baselineKind==='remote-original',originalSha256:record?.original.sha256||null,backupDirectory:p.directory,displacedBackups:record?.displacedBackups||[]}};});}
 function applyRouting({clientDirectory,host,gatewayPorts,allowExistingTestRoute=false}={}){return result(()=>{
  const client=resolveClient(clientDirectory),p=paths(client),next=rewriteRoutes(client.bytes,host,gatewayPorts),currentHash=sha256(client.bytes);
  return withLock(p,()=>{let record=loadRecord(p,client);if(record)record=settleCompletedIntent(p,record,currentHash);if(record?.phase==='restored'){fs.mkdirSync(path.join(p.directory,'records'),{recursive:true});atomicWrite(path.join(p.directory,'records',record.sessionId+'.json'),Buffer.from(JSON.stringify(record,null,2)+'\n'));record=null;}
   if(record&&!knownHashes(record).includes(currentHash))fail('EXTERNAL_CHANGE','客户端配置已经变化，未切换测试服。请先查看恢复选项。',{currentSha256:currentHash,expectedSha256:record.installed?.sha256||record.original.sha256});
   if(!record){if(baselineKind(parseRoutes(client.bytes))==='before-test'&&!allowExistingTestRoute&&!official(p))fail('EXISTING_TEST_ROUTE','当前配置已经指向本地测试服。可明确选择“保存当前配置用于本地测试”，该备份不会被标为原服。');record=freshRecord(p,client);}
   readBackup(p,record.original);record.phase='applying';record.intent={operation:'apply',fromSha256:currentHash,to:{sha256:sha256(next),bytes:next.length},route:{host,gatewayPorts:[...gatewayPorts]}};saveRecord(p,record);hooks.afterJournal?.('apply-intent',record);
   atomicWrite(client.file,next,{expectedHash:currentHash,mode:fs.statSync(client.file).mode&0o777,hook:()=>{readBackup(p,record.original);hooks.beforeClientCommit?.('apply');}});hooks.afterClientCommit?.('apply');
   record.installed=record.intent.to;record.route=record.intent.route;record.intent=null;record.phase='applied';saveRecord(p,record);
   return {ok:true,code:'ROUTING_APPLIED',message:'测试服配置已保存，完整恢复备份已核对。',context:{clientDirectory:client.root,sha256:record.installed.sha256,baselineKind:record.baselineKind,backupDirectory:p.directory,officialRestoreAvailable:record.baselineKind==='remote-original'||!!official(p)}};
  });
 });}
 function inspectBackup({backupPath}={}){return result(()=>{if(typeof backupPath!=='string'||!backupPath)fail('BACKUP_REQUIRED','请先选择你保留的原版配置备份。');const bytes=readPlain(path.resolve(backupPath)),entries=parseRoutes(bytes);return {ok:true,code:'BACKUP_INSPECTED',message:baselineKind(entries)==='remote-original'?'备份格式符合原版外网配置；请确认它来自你信任的原版客户端。':'这个备份含本地测试路由，不能标为原服。',context:{backupPath:path.resolve(backupPath),bytes:bytes.length,sha256:sha256(bytes),baselineKind:baselineKind(entries),routes:entries.map(({code,hosts,ports,zoneId})=>({code,hosts,ports,zoneId}))}};});}
 function importOfficialBackup({clientDirectory,backupPath,expectedSHA256}={}){return result(()=>{const client=resolveClient(clientDirectory,{allowMissingConfig:true}),p=paths(client);if(!validHash(expectedSHA256))fail('BACKUP_HASH_REQUIRED','必须先核对所选原版备份，才能导入。');const bytes=readPlain(path.resolve(backupPath));if(sha256(bytes)!==expectedSHA256.toLowerCase())fail('BACKUP_CHANGED','所选备份已变化，请重新核对后再导入。');if(baselineKind(parseRoutes(bytes))!=='remote-original')fail('OFFICIAL_BACKUP_INVALID','该备份含本地测试路由，不能当作原服配置。');return withLock(p,()=>{const copied=backup(p,'official',bytes),record={version:1,key:p.key,importedAt:new Date().toISOString(),sourceName:path.basename(backupPath),backup:copied,scope:'User-selected historical original configuration; remote routes verified, present official availability not asserted.'};atomicWrite(p.official,Buffer.from(JSON.stringify(record,null,2)+'\n'));return {ok:true,code:'OFFICIAL_BACKUP_IMPORTED',message:'原版配置备份已独立保存并核对。客户端配置尚未修改。',context:{sha256:copied.sha256,bytes:copied.bytes,officialRestoreAvailable:true}};});});}
 function prepareRestore({clientDirectory,target='before-test',conflictPolicy='keep',expectedCurrentSha256}={}){return result(()=>{
  if(!['before-test','official'].includes(target)||!['keep','backup-and-restore'].includes(conflictPolicy))fail('INVALID_RESTORE_OPTION','恢复选项不正确。');
  const client=resolveClient(clientDirectory,{allowMissingConfig:true}),p=paths(client),record=loadRecord(p,client),imported=target==='official'?official(p):null;
  if(!record&&!imported)fail('NO_BACKUP','没有本工具的完整备份，不能修改或恢复客户端配置。');
  if(target==='official'&&!imported&&record?.baselineKind!=='remote-original')fail('NO_OFFICIAL_BACKUP','修改前配置原本就是本地测试服，不能当作原服。请导入可信原版备份，或选择恢复使用前配置。');
  if(client.bytes===null)fail('CURRENT_CONFIG_MISSING','当前配置文件不存在，请先保留恢复资料并联系作者。');
  const restored=readBackup(p,imported?imported.backup:record.original);parseRoutes(restored);
  const currentHash=sha256(client.bytes),targetHash=sha256(restored);
  if(currentHash!==targetHash&&record&&!knownHashes(record).includes(currentHash)){
   if(conflictPolicy!=='backup-and-restore')fail('RESTORE_CONFLICT','客户端配置已被其他程序或原版更新改动，未覆盖新配置。可取消，或明确选择“保存当前配置后恢复备份”。',{currentSha256:currentHash,backupSha256:targetHash});
   if(expectedCurrentSha256!==currentHash)fail('CONFIRMATION_STALE','配置在确认后又发生变化，未恢复。请重新查看并确认。',{currentSha256:currentHash});
  }
  return {ok:true,code:'RESTORE_PREPARED',message:'恢复备份和当前配置已核对，尚未修改客户端。',context:{currentSha256:currentHash,targetSha256:targetHash,target}};
 });}
 function restoreRouting({clientDirectory,target='before-test',conflictPolicy='keep',expectedCurrentSha256,restoreMissing=false,preparedCurrentSha256,preparedTargetSha256}={}){return result(()=>{
  if(!['before-test','official'].includes(target)||!['keep','backup-and-restore'].includes(conflictPolicy))fail('INVALID_RESTORE_OPTION','恢复选项不正确。');
  const client=resolveClient(clientDirectory,{allowMissingConfig:true}),p=paths(client),currentHash=client.bytes===null?null:sha256(client.bytes);
  if(preparedCurrentSha256!==undefined&&preparedCurrentSha256!==currentHash)fail('CONFIRMATION_STALE','配置在恢复准备后发生变化，已停止恢复。请重新查看并确认。',{currentSha256:currentHash});
  return withLock(p,()=>{let record=loadRecord(p,client);if(record)record=settleCompletedIntent(p,record,currentHash);const imported=target==='official'?official(p):null;
   if(!record){if(!imported)fail('NO_BACKUP','没有本工具的完整备份，不能修改或恢复客户端配置。');if(client.bytes===null)fail('NO_BACKUP','当前配置缺失且没有修改前备份，不能自动恢复。');record=freshRecord(p,client);}
   const targetBackup=target==='official'&&imported?imported.backup:record.original;
   if(target==='official'&&!imported&&record.baselineKind!=='remote-original')fail('NO_OFFICIAL_BACKUP','修改前配置原本就是本地测试服，不能当作原服。请导入可信原版备份，或选择恢复使用前配置。');
   const restored=readBackup(p,targetBackup);parseRoutes(restored);const targetHash=sha256(restored);
   if(preparedTargetSha256!==undefined&&preparedTargetSha256!==targetHash)fail('CONFIRMATION_STALE','恢复备份在准备后发生变化，已停止恢复。请重新查看并确认。');
   if(currentHash===targetHash){record.phase='restored';record.intent=null;record.lastRestored={sha256:targetHash,bytes:restored.length,target};saveRecord(p,record);return {ok:true,code:'ALREADY_RESTORED',message:target==='official'?'原版备份配置已经恢复。':'已经是使用本工具前的配置。',context:{sha256:targetHash,target}};}
   if(client.bytes===null){if(!restoreMissing||expectedCurrentSha256!==null)fail('CURRENT_CONFIG_MISSING','当前配置文件不存在。请确认需要用完整备份重新建立它。',{currentSha256:null});}
   else if(!knownHashes(record).includes(currentHash)){
    if(conflictPolicy!=='backup-and-restore')fail('RESTORE_CONFLICT','客户端配置已被其他程序或原版更新改动，未覆盖新配置。可取消，或明确选择“保存当前配置后恢复备份”。',{currentSha256:currentHash,installedSha256:record.installed?.sha256||null,backupSha256:targetHash});
    if(expectedCurrentSha256!==currentHash)fail('CONFIRMATION_STALE','配置在确认后又发生变化，未恢复。请重新查看并确认。',{currentSha256:currentHash});
    record.displacedBackups.push({...backup(p,'conflicts',client.bytes),savedAt:new Date().toISOString()});saveRecord(p,record);
   }
   record.phase='restoring';record.intent={operation:'restore',target,fromSha256:currentHash,to:{sha256:targetHash,bytes:restored.length},backup:targetBackup};saveRecord(p,record);hooks.afterJournal?.('restore-intent',record);
   atomicWrite(client.file,restored,{expectedHash:currentHash,mode:client.bytes===null?0o644:fs.statSync(client.file).mode&0o777,hook:()=>{readBackup(p,record.original);readBackup(p,targetBackup);hooks.beforeClientCommit?.('restore');}});hooks.afterClientCommit?.('restore');
   record.lastRestored={...record.intent.to,target};record.intent=null;record.phase='restored';saveRecord(p,record);
   return {ok:true,code:'ROUTING_RESTORED',message:target==='official'?'已按原版备份恢复配置。':'已恢复使用本工具前的配置。',context:{sha256:targetHash,target,displacedBackups:record.displacedBackups,backupDirectory:p.directory}};
  });
 });}
 function getLaunchTarget({clientDirectory}={}){return result(()=>{const client=resolveClient(clientDirectory);parseRoutes(client.bytes);return {ok:true,code:'DIRECT_CLIENT_TARGET',message:'请直接启动客户端并手动登录。',context:{file:client.executable,cwd:client.root,args:[],shell:false}};});}
 return {inspectClient,getRecoveryStatus,applyRouting,inspectBackup,importOfficialBackup,prepareRestore,restoreRouting,getLaunchTarget};
}
// Each call may run in a fresh Node backend. All recovery decisions use durable
// on-disk records and hashes; no process-local session is required.
module.exports={createRoutingManager,sha256};
