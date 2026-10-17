'use strict';
// Do not import liveserver: importing it loads/repairs state and binds ports.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const {spawn} = require('child_process');
const ROOT = path.resolve(__dirname, '..');
function profile(file = path.join(__dirname, 'profile.json')) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (p.version !== 1 || p.entry !== 'liveserver.js' || !p.options || typeof p.options !== 'object' || Array.isArray(p.options))
    throw Error('Invalid runtime profile');
  for (const [k,v] of Object.entries(p.options))
    if (!/^[a-z][a-z0-9-]*$/.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v)) throw Error('Invalid option: ' + k);
  const ports = (p.options.ports || '').split(',').map(Number);
  if (!ports.length || ports.some(n=>!Number.isInteger(n)||n<1||n>65535) || new Set(ports).size!==ports.length)
    throw Error('Invalid ports');
  if (!p.options.cap || !p.options.bag) throw Error('Capture and bag seed required');
  if (!require('../inventory-capacity').validLimits(Number(p.options['bag-capacity']),Number(p.options['bag-records'])))
    throw Error('Invalid inventory capacity');
  require('./options').parseOptions(Object.entries(p.options).map(([k,v])=>`--${k}=${v}`));
  return p;
}
function plan(p, env = process.env) {
  return {cwd:ROOT, executable:process.execPath, entry:p.entry,
    args:[p.entry,...Object.entries(p.options).map(([k,v])=>`--${k}=${v}`)],
    inheritedOverrides:Object.fromEntries(Object.entries(env).filter(([k])=>k.startsWith('DSH_')))};
}
function fileInfo(file, json = false) {
  const absolute = path.resolve(ROOT,file);
  try {
    const data = fs.readFileSync(absolute);
    if(json) JSON.parse(data.toString('utf8'));
    return {path:absolute,exists:true,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};
  } catch(e) {return {path:absolute,exists:e.code!=='ENOENT',error:e.code==='ENOENT'?'missing':e.message};}
}
function inventory() {
  const files=fs.readdirSync(ROOT).filter(f=>f.endsWith('.js')).sort();
  const modules=[]; const references=[]; const environments=new Map();
  for(const file of files) {
    const source=fs.readFileSync(path.join(ROOT,file),'utf8');
    const category=/\.test\.js$|test\.js$|^test-/.test(file)?'test'
      :/^patch-|^append-|^repair-/.test(file)?'historical-mutation-tool':'unclassified';
    modules.push({file,category,bytes:Buffer.byteLength(source)});
    const lines=source.split(/\r?\n/);
    lines.forEach((line,i)=>{
      for(const m of line.matchAll(/\bmsgid\s*===?\s*(\d+)|\bcase\s+(\d+)\s*:/g))
        references.push({msgid:Number(m[1]||m[2]),file,line:i+1,status:'source-reference; direction and semantics require review'});
      for(const m of line.matchAll(/process\.env\.(DSH_[A-Z_]+)/g)) {
        const refs=environments.get(m[1])||[]; refs.push({file,line:i+1});environments.set(m[1],refs);
      }
    });
  }
  const configFiles=[];
  for(const dir of ['logs/cfg','../data/current-client','../data/enhancement']) {
    const absolute=path.resolve(ROOT,dir);
    if(fs.existsSync(absolute)) for(const file of fs.readdirSync(absolute).sort())
      if(file.endsWith('.json')) configFiles.push({group:dir,...fileInfo(path.join(dir,file),true)});
  }
  const stateFiles=fs.readdirSync(ROOT).filter(f=>/state.*\.json$|pending.*\.json$|^account-uid\.json$|^bag-assigned\.json$|^bag-fix\.stamp\.json$/.test(f))
    .sort().map(f=>fileInfo(f,true));
  return {version:1,generatedAt:new Date().toISOString(),root:ROOT,
    scope:'Static inventory; not a complete call graph or verified wire schema. State paths may be overridden.',
    modules,protocolReferences:references,environmentReferences:Object.fromEntries(environments),configFiles,stateFiles};
}
async function probe(port) {
  return new Promise(resolve=>{
    const sock=net.createConnection({host:'127.0.0.1',port});let settled=false;
    const done=status=>{if(settled)return;settled=true;sock.destroy();resolve({port,status});};
    sock.setTimeout(500,()=>done('timeout'));
    sock.once('connect',()=>done('reachable; service identity unverified'));
    sock.once('error',e=>done(e.code||'error'));
  });
}
function check(p,env={}) {
  const required=[p.entry,path.join(p.options.cap,'events.jsonl'),
    ...((env.DSH_STATE_BACKEND||'json')==='json'?[p.options.bag]:[]),
    'logs/cfg/shopcommodity.json','logs/cfg/item_gem.json','logs/cfg/gemopercost.json',
    '../data/current-client/item_item.json',
    'logs/cap-2026-09-27T10-13-20-match/sessions/01/s2c-30001-001.frames.bin'];
  const files=required.map(f=>fileInfo(f,f.endsWith('.json')));
  const cap=path.resolve(ROOT,p.options.cap);
  try {
    const events=fs.readFileSync(path.join(cap,'events.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const counts=new Map();for(const e of events) if(e.dir==='s2c'&&e.c) counts.set(e.c,(counts.get(e.c)||0)+1);
    if(counts.size) {const best=[...counts].sort((a,b)=>b[1]-a[1])[0][0];files.push(fileInfo(path.join(cap,`s2c-${best}.frames.bin`)));}
    if(!events.some(e=>e.dir==='s2c'))files.push({path:cap,error:'No server frames'});
  } catch(e){files.push({path:cap,error:'Invalid capture: '+e.message});}
  const storage=require('./preflight').storage(p,{env}),configurations=require('./catalogs').manifest({manifestFile:env.DSH_CONFIG_MANIFEST||null});
  if(env.DSH_CONFIG_MANIFEST&&!path.isAbsolute(env.DSH_CONFIG_MANIFEST))for(const row of configurations.catalogs){row.ok=false;row.error='Absolute configuration release manifest required';}
  let protocols;try{protocols={ok:true,count:require('../protocols/catalog').catalog().messages.length};}catch(e){protocols={ok:false,error:e.message};}
  const itemTemplates=require('./item-templates').preflight(env);
  const host=require('./host-check').checkHost({sqlite:env.DSH_STATE_BACKEND==='sqlite'});
  return {ok:files.every(f=>!f.error)&&storage.ok&&configurations.catalogs.every(r=>r.ok)&&protocols.ok&&itemTemplates.ok&&host.ok,files,storage,configurations,protocols,itemTemplates,host};
}
async function main(argv=process.argv.slice(2)) {
  const command=argv[0]||'doctor';
  if(!['plan','doctor','status','inventory','start'].includes(command))throw Error('Use plan, doctor, status, inventory, or start');
  if(command==='inventory') {
    const result=inventory();const output=argv[1];
    if(output) {fs.writeFileSync(path.resolve(output),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log('Inventory created: '+path.resolve(output));}
    else console.log(JSON.stringify(result,null,2));
    return;
  }
  const p=profile(argv[1]);const launch=plan(p);
  if(command==='plan'){console.log(JSON.stringify(launch,null,2));return;}
  if(command==='status'){console.log(JSON.stringify(await Promise.all(p.options.ports.split(',').map(Number).map(probe)),null,2));return;}
  const result=check(p,process.env);
  if(command==='doctor'){console.log(JSON.stringify({...result,launch,note:'Read-only prerequisites; does not verify gameplay or state schema.'},null,2));if(!result.ok)process.exitCode=1;return;}
  if(!result.ok)throw Error('Prerequisites failed; run doctor');
  // Profile is explicitly pinned; avoid silently changing state paths or policy via inherited env.
  if(Object.keys(launch.inheritedOverrides).length)throw Error('DSH overrides detected; review plan and launch legacy entry explicitly');
  const child=spawn(process.execPath,launch.args,{cwd:ROOT,stdio:'inherit',env:process.env});
  child.once('error',e=>{console.error(e.message);process.exitCode=1;});
  child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={profile,plan,inventory,check,fileInfo};
