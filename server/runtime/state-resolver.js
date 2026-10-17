'use strict';
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function resolvePaths(p,env={},root=ROOT) {
  const defaults=require('./state-paths.json').states;
  const absolute=value=>path.resolve(root,value);
  const bag=absolute(env.DSH_BAG_STATE||'bag-state.live.json');
  const equipment=env.DSH_EQUIP_STATE==='off'?null:absolute(env.DSH_EQUIP_STATE||
    (env.DSH_BAG_STATE&&/bag-state/.test(path.basename(env.DSH_BAG_STATE))?
      path.join(path.dirname(env.DSH_BAG_STATE),path.basename(env.DSH_BAG_STATE).replace(/^bag-state/,'equip-state')):'equip-state.json'));
  const derived={bag,equipment,
    rune:path.join(path.dirname(bag),'rune-state.json'),
    'war-soul':path.join(path.dirname(bag),'war-soul-state.json'),
    'magic-gem':path.join(path.dirname(bag),'magic-gem-state.json'),
    'item-lock':path.join(path.dirname(bag),'item-lock-state.json'),
    'equipment-crafting':path.join(path.dirname(bag),'equipment-crafting-state.json'),
    warehouse:path.join(path.dirname(bag),'warehouse-state.json'),
    exstore:path.join(path.dirname(bag),'exstore-state.json'),
    resource:absolute(env.DSH_RESOURCE_STATE||path.join(path.dirname(bag),path.basename(bag).replace(/\.json$/,'.resources.json'))),
    'equipment-pending':absolute(env.DSH_EQUIPMENT_PENDING||path.join(path.dirname(bag),'equipment-economy-pending.json')),
    soul:absolute(env.DSH_SOUL_STATE||path.join(path.dirname(env.DSH_EQUIP_STATE||env.DSH_ENHANCEMENT_STATE||env.DSH_BAG_STATE||path.join(root,'equip-state.json')),'soul-state.json')),
    'account-uid':absolute(env.DSH_ACCOUNT_UID_FILE||p.options['account-uid']||'account-uid.json')};
  const records=defaults.map(r=>({...r,path:Object.hasOwn(derived,r.name)?derived[r.name]:absolute(env[r.environment]||r.default),
    overridden:!!env[r.environment],role:'mutable-state'}));
  records.unshift({name:'bag-seed',path:absolute(p.options.bag),role:'baseline-input',required:true});
  records.push({name:'extra-mail',path:absolute(p.options['mail-extra']||'mail-extra.json'),role:'mutable-catalog'},
    {name:'equipment-snapshot',path:equipment?equipment+'.snapshot':null,role:'baseline-input'},
    {name:'audit-log',path:absolute(p.options['gm-audit-file']||'gm-audit.jsonl'),role:'audit-log'},
    {name:'change-log',path:absolute(env.DSH_CHANGELOG_FILE||'logs/change-log.jsonl'),role:'audit-log'});
  return records;
}
function inspect(p,{env={},root=ROOT}={}) {
  const paths=resolvePaths(p,env,root),documents={},issues=[],records=[];
  for(const record of paths){
    if(!record.path){records.push({...record,disabled:true});continue;}
    if(record.role==='audit-log'){records.push({...record,exists:fs.existsSync(record.path)});continue;}
    try{
      const bytes=fs.readFileSync(record.path),data=JSON.parse(bytes.toString('utf8'));documents[record.name]=data;
      records.push({...record,exists:true,bytes:bytes.length,sha256:digest(bytes)});
    }catch(e){records.push({...record,exists:e.code!=='ENOENT',error:e.code==='ENOENT'?'missing':e.message});
      if(e.code!=='ENOENT'||record.required)issues.push({name:record.name,reason:e.message});}
  }
  const slots={...(documents['bag-seed']?.slots||{})};
  for(const [slot,item] of Object.entries(documents.bag?.slots||{})){if(item===null)delete slots[slot];else slots[slot]=item;}
  const seen=new Map();
  for(const [slot,item] of Object.entries(slots)){
    if(!Number.isInteger(Number(slot))||Number(slot)<0||!item||!Number.isInteger(item.itemId)||!Number.isSafeInteger(item.count)||item.count<0)
      issues.push({name:'effective-bag',slot,reason:'invalid slot record'});
    if(item?.guid){const key=String(item.guid).toLowerCase();if(!/^[0-9a-f]{16}$/.test(key)||/^0{16}$/.test(key))issues.push({name:'effective-bag',slot,reason:'invalid GUID'});
      if(seen.has(key))issues.push({name:'effective-bag',slot,otherSlot:seen.get(key),reason:'duplicate GUID; do not repair in preview'});seen.set(key,slot);}
  }
  for(const name of ['equipment-pending','mail-claims','shop-limits']){
    const value=documents[name];
    if(name==='equipment-pending'&&value)issues.push({name,reason:'unresolved equipment transaction requires recovery before migration'});
    if(name==='mail-claims'&&value?.pending?.length)issues.push({name,reason:'unresolved mail transaction requires recovery before migration'});
    if(name==='shop-limits'&&value?.pending)issues.push({name,reason:'unresolved shop transaction requires recovery before migration'});
  }
  // Detect source drift, but do not describe this sampling as an atomic snapshot.
  for(const record of records)if(record.sha256){try{if(digest(fs.readFileSync(record.path))!==record.sha256)issues.push({name:record.name,reason:'source changed during inspection'});}catch(e){issues.push({name:record.name,reason:'source became unreadable'});}}
  return {version:1,generatedAt:new Date().toISOString(),profile:p.name,
    scope:'Read-only migration preview; current live process environment is unverified. Multi-file sampling is not an atomic backup.',
    readyForMigration:false,requiredBeforeMigration:['quiesced consistent capture','explicit account/role ownership','complete non-equipment state mapping'],
    effectiveBagSlots:Object.keys(slots).length,records,issues};
}
module.exports={resolvePaths,inspect};
