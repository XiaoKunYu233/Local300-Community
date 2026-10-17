'use strict';
const path=require('node:path');
const {resolvePaths,inspect}=require('./state-resolver');
function storage(p,{env={},root=path.resolve(__dirname,'..')}={}){
  const mode=env.DSH_STATE_BACKEND||'json',issues=[],warnings=[],records=resolvePaths(p,env,root),seen=new Map();
  for(const record of records){if(!record.path)continue;const key=process.platform==='win32'?record.path.toLowerCase():record.path;
    if(seen.has(key))issues.push({name:record.name,reason:'State path collision with '+seen.get(key)});seen.set(key,record.name);}
  if(mode==='json'){
    const preview=inspect(p,{env,root});
    for(const issue of preview.issues){if(/unresolved .*transaction/.test(issue.reason))warnings.push(issue);else issues.push(issue);}
    return {ok:issues.length===0,mode,issues,warnings,records:preview.records,note:'JSON sampling is not an atomic snapshot. Pending transactions retain the existing frozen-runtime recovery behavior.'};
  }
  if(mode!=='sqlite')return {ok:false,mode,issues:[...issues,{reason:'Unsupported state backend'}],warnings};
  let store;
  try{
    if(!env.DSH_STATE_DB||!path.isAbsolute(env.DSH_STATE_DB)||!env.DSH_STATE_SCOPE)throw Error('Absolute database and explicit scope required');
    store=new (require('../persistence/document-store').DocumentStore)(env.DSH_STATE_DB,{readOnly:true});
    const result=store.readSnapshot(()=>{
      store.assertScope(env.DSH_STATE_SCOPE);const verification=store.verify();if(!verification.ok)throw Error('Database integrity verification failed');
      const snapshot=store.exportScope(env.DSH_STATE_SCOPE),documents=new Map();
      for(const row of snapshot.documents)documents.set(row.name,JSON.parse(row.content.toString('utf8')));
      if(!documents.has('bag-seed'))throw Error('Imported bag baseline required');
      if(documents.has('equipment-pending'))issues.push({name:'equipment-pending',reason:'Resolve legacy equipment pending transaction before SQLite startup'});
      if(documents.get('mail-claims')?.pending?.length)issues.push({name:'mail-claims',reason:'Resolve legacy mail pending transaction before SQLite startup'});
      if(documents.get('shop-limits')?.pending)issues.push({name:'shop-limits',reason:'Resolve legacy shop pending transaction before SQLite startup'});
      const registered=new Set(records.filter(r=>r.path&&r.role!=='audit-log').map(r=>r.name));
      for(const name of documents.keys())if(!registered.has(name))issues.push({name,reason:'Imported state is not mapped by this runtime profile'});
      return {documents:documents.size,scope:env.DSH_STATE_SCOPE,database:env.DSH_STATE_DB};
    });
    return {ok:issues.length===0,mode,...result,issues,warnings,records,note:'Read-only storage checks; does not certify all business schemas or migration readiness.'};
  }catch(e){issues.push({reason:e.message});return {ok:false,mode,issues,warnings,records};}
  finally{store?.close();}
}
module.exports={storage};
