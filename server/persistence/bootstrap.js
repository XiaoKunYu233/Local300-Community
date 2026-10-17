'use strict';
const path=require('node:path'),fs=require('node:fs');
const stateFiles=require('./state-files');
function bootstrap({options,env=process.env,root=path.resolve(__dirname,'..')}){
  const mode=env.DSH_STATE_BACKEND||'json';if(mode==='json')return {mode};
  if(mode!=='sqlite')throw Error('Unsupported state backend');
  if(!env.DSH_STATE_DB||!path.isAbsolute(env.DSH_STATE_DB)||!env.DSH_STATE_SCOPE)throw Error('SQLite backend requires an absolute database and explicit storage scope');
  if(!fs.existsSync(env.DSH_STATE_DB))throw Error('Import the offline state before starting SQLite runtime');
  if(env.DSH_TEST_WRITE_ROOT){const base=path.resolve(env.DSH_TEST_WRITE_ROOT).toLowerCase(),file=path.resolve(env.DSH_STATE_DB).toLowerCase();
    if(!file.startsWith(base+path.sep))throw Error('Test database must stay inside isolated write root');}
  const runtimeProfile={options:{cap:options.cap,bag:options.argOf('bag','bag-state.json'),
    'mail-extra':options.argOf('mail-extra','mail-extra.json'),'account-uid':options.argOf('account-uid','account-uid.json'),
    'gm-audit-file':options.argOf('gm-audit-file','gm-audit.jsonl')}};
  const preflight=require('../runtime/preflight').storage(runtimeProfile,{env,root});
  if(!preflight.ok)throw Error('SQLite storage preflight failed: '+preflight.issues.map(issue=>issue.reason).join('; '));
  const {DocumentStore}=require('./document-store'),{resolvePaths}=require('../runtime/state-resolver');
  const store=new DocumentStore(env.DSH_STATE_DB);
  try{store.assertScope(env.DSH_STATE_SCOPE);if(!store.has(env.DSH_STATE_SCOPE,'bag-seed'))throw Error('Imported bag baseline required');
    if(!store.verify().ok)throw Error('State database integrity failed');
    const records=resolvePaths(runtimeProfile,env,root);
    stateFiles.configure({store,scope:env.DSH_STATE_SCOPE,records,root});
    return {mode,scope:env.DSH_STATE_SCOPE,database:env.DSH_STATE_DB};
  }catch(e){store.close();throw e;}
}
module.exports={bootstrap};
