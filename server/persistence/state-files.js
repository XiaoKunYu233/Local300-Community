'use strict';
const native=require('node:fs'),path=require('node:path');
let mounted=null;
const canonical=file=>process.platform==='win32'?path.resolve(String(file)).toLowerCase():path.resolve(String(file));
function configure({store,scope,records,root}){
  if(mounted)throw Error('State repository already configured');store.assertScope(scope);
  const names=new Map();for(const record of records){if(!record.path||record.role==='audit-log')continue;
    const file=canonical(record.path);if(names.has(file))throw Error('Colliding state paths');
    names.set(file,{name:record.name,writable:record.name!=='bag-seed'});}
  mounted={store,scope,names,root:path.resolve(root),temps:new Map(),revisions:new Map(),frozen:false};
}
function lookup(target){if(!mounted||typeof target==='number')return null;const file=canonical(target);
  if(mounted.names.has(file))return {file,...mounted.names.get(file),temp:false};
  for(const [base,record] of mounted.names)if(file.startsWith(base+'.')&&/^\.(?:\d+\.)*(?:[a-f0-9]{8}\.)?tmp$/.test(file.slice(base.length)))return {file,...record,temp:true};
  return null;
}
function forbidUnmappedStateWrite(target){if(!mounted||typeof target==='number')return;
  const file=path.resolve(String(target));if(/\.json(?:\..*tmp)?$/i.test(file))throw mounted.store.poison(Error('Unregistered JSON write in SQLite runtime: '+file));}
function writable(record){if(mounted.frozen)throw Error('Storage frozen after transaction failure; restart to reload rolled-back state');
  if(!record.writable)throw rejected('Immutable baseline cannot be rewritten');}
function rejected(message){const error=Error(message);return mounted?mounted.store.poison(error):error;}
const io=Object.create(native);
io.readFileSync=(target,options)=>{const record=lookup(target);if(!record)return native.readFileSync(target,options);
  let bytes;if(record.temp){bytes=mounted.temps.get(record.file);if(!bytes)throw Object.assign(Error('Temporary document not found'),{code:'ENOENT'});}
  else {const row=mounted.store.record(mounted.scope,record.name);if(!row){mounted.revisions.set(record.name,0);throw Object.assign(Error('Document not found: '+record.name),{code:'ENOENT'});}
    mounted.revisions.set(record.name,row.revision);bytes=row.bytes;}
  const encoding=typeof options==='string'?options:options?.encoding;return encoding?bytes.toString(encoding):Buffer.from(bytes);};
io.existsSync=target=>{const record=lookup(target);return record?(record.temp?mounted.temps.has(record.file):mounted.store.has(mounted.scope,record.name)):native.existsSync(target);};
io.writeFileSync=(target,data,options)=>{const record=lookup(target);if(!record){forbidUnmappedStateWrite(target);return native.writeFileSync(target,data,options);}
  writable(record);const flag=typeof options==='object'?options.flag:undefined;
  if(flag==='wx'&&io.existsSync(target))throw Object.assign(Error('Document exists'),{code:'EEXIST'});
  const encoding=typeof options==='string'?options:options?.encoding;const bytes=Buffer.isBuffer(data)?Buffer.from(data):Buffer.from(data,encoding||'utf8');
  try{JSON.parse(bytes.toString('utf8'));}catch(e){throw mounted.store.poison(e);}
  if(record.temp)mounted.temps.set(record.file,bytes);else save(record,bytes);};
function save(record,bytes){const expectedRevision=mounted.revisions.has(record.name)?mounted.revisions.get(record.name):(mounted.store.record(mounted.scope,record.name)?.revision||0);
  try{mounted.store.put(mounted.scope,record.name,bytes,{expectedRevision});mounted.revisions.set(record.name,expectedRevision+1);}
  catch(e){if(!mounted.store.active)mounted.frozen=true;throw e;}}
io.renameSync=(from,to)=>{const a=lookup(from),b=lookup(to);if(!a&&!b){forbidUnmappedStateWrite(to);return native.renameSync(from,to);}
  if(!a||!b||a.name!==b.name||!a.temp||b.temp)throw rejected('Unsupported state document rename');writable(b);
  const bytes=io.readFileSync(from);save(b,bytes);mounted.temps.delete(a.file);};
io.unlinkSync=target=>{const record=lookup(target);if(!record){forbidUnmappedStateWrite(target);return native.unlinkSync(target);}
  writable(record);if(!io.existsSync(target))throw Object.assign(Error('Document not found'),{code:'ENOENT'});
  if(record.temp)mounted.temps.delete(record.file);else {
    const expectedRevision=mounted.revisions.has(record.name)?mounted.revisions.get(record.name):(mounted.store.record(mounted.scope,record.name)?.revision||0);
    try{mounted.store.delete(mounted.scope,record.name,{expectedRevision});mounted.revisions.set(record.name,0);}catch(e){if(!mounted.store.active)mounted.frozen=true;throw e;}
  }};
io.rmSync=(target,options)=>{const record=lookup(target);if(!record){forbidUnmappedStateWrite(target);return native.rmSync(target,options);}
  if(!io.existsSync(target)&&options?.force)return;return io.unlinkSync(target);};
// Never let an unadapted writer open a physical shadow file for mapped state.
io.openSync=(target,flags,...args)=>{if(lookup(target))throw rejected('Mapped state must use document read/write operations');
  if(typeof flags==='number'||/[wa+]/.test(String(flags)))forbidUnmappedStateWrite(target);return native.openSync(target,flags,...args);};
io.appendFileSync=(target,...args)=>{if(lookup(target))throw rejected('Appending JSON state is unsupported');forbidUnmappedStateWrite(target);return native.appendFileSync(target,...args);};
// Async/stream/copy state writers must be explicitly adapted, rather than
// silently creating physical shadow files beside the database authority.
for(const [name,indices] of [['readFile',[0]],['writeFile',[0]],['appendFile',[0]],['rename',[0,1]],['unlink',[0]],['rm',[0]],['open',[0]],
  ['copyFile',[0,1]],['copyFileSync',[0,1]],['createWriteStream',[0]],['createReadStream',[0]]]){
  io[name]=(...args)=>{if(mounted)for(const i of indices){if(lookup(args[i]))throw rejected('Unsupported state I/O: '+name);if(!['createReadStream','readFile'].includes(name))forbidUnmappedStateWrite(args[i]);}
    return native[name](...args);};
}
Object.defineProperty(io,'promises',{get:()=>new Proxy(native.promises,{get:(target,key)=>{
  const value=target[key];if(typeof value!=='function')return value;
  return (...args)=>{if(mounted&&(lookup(args[0])||(['rename','copyFile'].includes(key)&&lookup(args[1]))))return Promise.reject(rejected('Unsupported state promise I/O: '+String(key)));
    if(mounted&&['writeFile','appendFile','rename','unlink','rm','open','copyFile'].includes(key)){forbidUnmappedStateWrite(args[0]);if(['rename','copyFile'].includes(key))forbidUnmappedStateWrite(args[1]);}
    return value.apply(target,args);};
}})});
function transaction(kind,paths,operation){if(!mounted)return operation();
  if(mounted.frozen)throw Error('Storage frozen');for(const file of paths)if(!lookup(file)||lookup(file).temp)throw Error('Transaction contains an unmapped state path');
  if(mounted.store.active){
    // A handler may catch an ordinary callback failure. The enclosing native
    // request must still roll back every prior document write, as for put/CAS
    // errors; nested operations cannot partially commit their prefix.
    try{return operation();}catch(error){throw mounted.store.poison(error);}
  }
  const temps=new Map(mounted.temps),revisions=new Map(mounted.revisions);
  try{return mounted.store.transaction(mounted.scope,kind,operation);}
  catch(e){mounted.temps=temps;mounted.revisions=revisions;mounted.frozen=true;throw e;}
}
function enabled(){return !!mounted;}
function frozen(){return !!mounted?.frozen;}
function readSnapshot(operation){return mounted?mounted.store.readSnapshot(operation):operation();}
function changeToken(file){const record=lookup(file);
  if(record&&!record.temp)return mounted.store.changeToken(mounted.scope,record.name);
  try{const stat=native.statSync(file);return `${stat.mtimeMs}:${stat.size}`;}catch(error){if(error.code!=='ENOENT')throw error;return 'missing';}
}
function documentPath(name){if(!mounted)return null;for(const [file,record] of mounted.names)if(record.name===name)return file;
  throw rejected('Unregistered state document: '+name);}
function close(){if(mounted){mounted.store.close();mounted=null;}}
module.exports={io,configure,transaction,enabled,frozen,readSnapshot,changeToken,documentPath,close,lookup};
