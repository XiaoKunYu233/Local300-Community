'use strict';
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const registry=require('./catalogs.json');
const byName=new Map();for(const entry of registry.catalogs){if(byName.has(entry.name))throw Error('Duplicate configuration name');byName.set(entry.name,entry);}
function getConfigPath(name){const entry=byName.get(name);if(!entry)throw Error('Unknown configuration: '+name);return path.resolve(__dirname,'..',entry.path);}
function validate(entry,data){
  const uniqueRows=(minimum,idIndex,nameIndex,allowRepeated=false)=>{
    if(!Array.isArray(data))throw Error('Expected row array');const ids=new Set();
    for(const row of data){if(!row||typeof row!=='object'||!Object.hasOwn(row,String(minimum-1))||!Number.isInteger(row[idIndex])||row[idIndex]<=0||(!allowRepeated&&ids.has(row[idIndex])))throw Error('Invalid or duplicate configuration row ID');
      if(nameIndex!==undefined&&(typeof row[nameIndex]!=='string'||!row[nameIndex]))throw Error('Invalid item name');ids.add(row[idIndex]);}
  };
  if(entry.schema==='current-items-v1')uniqueRows(24,1,23,true);
  else if(entry.schema==='native-id-rows-v1')uniqueRows(2,1,undefined,true);
  else if(entry.schema==='gems-v1')uniqueRows(9,1);
  else if(entry.schema==='rows-v1'){if(!Array.isArray(data)||data.some(r=>!r||typeof r!=='object'||!Object.hasOwn(r,'7')))throw Error('Invalid cost rows');}
  else if(entry.schema==='legacy-items-v1'){if(!data?.道具||typeof data.道具!=='object'||Array.isArray(data.道具))throw Error('Invalid legacy catalog');}
  else if(entry.schema==='shop-v1'){if(!data||typeof data!=='object'||(!Array.isArray(data)&&!Object.values(data).some(Array.isArray)))throw Error('Invalid shop rows');}
  else if(entry.schema==='thresholds-v1'){if(!data?.boundsByCode||typeof data.boundsByCode!=='object')throw Error('Invalid threshold map');}
  else throw Error('Unknown schema');
}
function lockedRevisions(file){
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(value.version!==1||!Array.isArray(value.catalogs))throw Error('Invalid configuration release manifest');
  const revisions=new Map();for(const row of value.catalogs){if(!byName.has(row.name)||revisions.has(row.name)||!/^[a-f0-9]{64}$/.test(row.sha256||''))throw Error('Invalid configuration release entry');revisions.set(row.name,row.sha256);}
  if(revisions.size!==byName.size)throw Error('Incomplete configuration release manifest');return revisions;
}
function loadConfig(name,{expectedSha256,manifestFile=process.env.DSH_CONFIG_MANIFEST}={}){
  if(manifestFile){const pinned=lockedRevisions(manifestFile).get(name);if(expectedSha256&&expectedSha256!==pinned)throw Error('Conflicting configuration revision: '+name);expectedSha256=pinned;}
  const entry=byName.get(name),file=getConfigPath(name),bytes=fs.readFileSync(file);
  const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  if(expectedSha256&&sha256!==expectedSha256)throw Error('Configuration revision mismatch: '+name);
  const data=JSON.parse(bytes.toString('utf8'));try{validate(entry,data);}catch(e){throw Error(name+': '+e.message);}
  const diagnostics=[];
  if(['current-items-v1','native-id-rows-v1'].includes(entry.schema)){
    const seen=new Map();let repeated=0;const ids=new Set();
    for(let i=0;i<data.length;i++){const id=data[i][1];if(seen.has(id)){repeated++;ids.add(id);}seen.set(id,i);}
    if(repeated)diagnostics.push({kind:'repeated-native-item-id',rows:repeated,ids:[...ids],policy:'preserve native row order; existing catalog resolves last row; variants require review'});
  }
  return {...entry,path:file,bytes:bytes.length,sha256,diagnostics,data};
}
function manifest(options={}){return {version:1,generatedAt:new Date().toISOString(),catalogs:registry.catalogs.map(entry=>{
  try{const {data,...record}=loadConfig(entry.name,options);return {...record,ok:true};}
  catch(e){return {...entry,path:getConfigPath(entry.name),ok:false,error:e.message};}
})};}
function assertRelease(env=process.env){if(!env.DSH_CONFIG_MANIFEST)return;
  if(!path.isAbsolute(env.DSH_CONFIG_MANIFEST))throw Error('Absolute configuration release manifest required');
  const result=manifest({manifestFile:env.DSH_CONFIG_MANIFEST}),failed=result.catalogs.filter(row=>!row.ok);
  if(failed.length)throw Error('Configuration release check failed: '+failed.map(row=>row.name+': '+row.error).join('; '));return result;
}
function table(result=manifest()){
  const escape=value=>String(value??'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
  return ['| Name | Purpose | Source | Schema | Bytes | SHA256 | Valid |','| --- | --- | --- | --- | --- | --- | --- |',
    ...result.catalogs.map(row=>'| '+[row.name,row.role,row.source,row.schema,row.bytes,row.sha256,row.ok?'yes':row.error].map(escape).join(' | ')+' |'),
    '',...result.catalogs.map(row=>row.name+': '+row.path),
    '',...result.catalogs.flatMap(row=>(row.diagnostics||[]).map(d=>row.name+': '+JSON.stringify(d)))].join('\n')+'\n';
}
if(require.main===module){try{
  const command=process.argv[2],file=process.argv[3];if(command&&!['--verify','--lock','--table'].includes(command))throw Error('Use --table, --verify <manifest> or --lock <new manifest>');
  if(command&&command!=='--table'&&!file)throw Error('Manifest path required');
  const result=manifest(command==='--verify'?{manifestFile:path.resolve(file)}:{});
  if(result.catalogs.some(r=>!r.ok))process.exitCode=1;
  else if(command==='--lock')fs.writeFileSync(path.resolve(file),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(command==='--table'?table(result):JSON.stringify(result,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={getConfigPath,loadConfig,manifest,validate,lockedRevisions,assertRelease,table};
