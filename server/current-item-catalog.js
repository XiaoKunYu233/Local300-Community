'use strict';

const fs = require('fs');
const {getConfigPath}=require('./runtime/catalogs');
let defaultCatalog = null;

// Keep the native item identity/type unchanged. Current client rows take
// precedence over the old PVE export; legacy-only records remain available for
// existing saves and captured mail whose IDs are no longer in the current table.
function load({currentFile = getConfigPath('current-items'),
  legacyFile = getConfigPath('legacy-items')} = {}) {
  const useDefault = arguments.length === 0;
  if (useDefault && defaultCatalog) return defaultCatalog;
  const byId = Object.create(null);
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')).道具;
    for (const [key, value] of Object.entries(legacy || {})) {
      const id = Number(key);
      if (Number.isInteger(id) && id > 0 && id < 0xffff && typeof value?.name === 'string')
        byId[id] = Object.freeze({...value, id, catalogSource:'legacy'});
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let rows = null;
  try { rows = JSON.parse(fs.readFileSync(currentFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (rows !== null && !Array.isArray(rows)) throw new Error('Invalid current client item catalog');
  for (const row of rows || []) {
    const id = row[1];
    if (!Number.isInteger(id) || id < 1 || id >= 0xffff || typeof row[23] !== 'string' || !row[23])
      throw new Error('Invalid current client item catalog row');
    const old = byId[id];
    byId[id] = Object.freeze({id, name:row[23], type:row[10] || '', icon:row[26] || '',
      quality:row[29] || '', desc:row[24] || '', catalogSource:'current-client',
      ...(old?.name && old.name !== row[23] ? {legacyName:old.name} : {})});
  }
  const items = Object.freeze(Object.values(byId).sort((a,b) => a.id - b.id));
  const result = Object.freeze({byId:Object.freeze(byId), items,
    currentCount:rows?.length || 0, legacyOnlyCount:items.filter(item=>item.catalogSource==='legacy').length,
    source:rows ? 'current-client' : 'legacy'});
  if (useDefault) defaultCatalog = result;
  return result;
}

function search(itemNames, query, limit = 50) {
  const term = String(query || '').trim().toLocaleLowerCase();
  if (!term) return {total:0,items:[]};
  const items = Object.values(itemNames || {}).filter(item =>
    String(item.id).includes(term) || item.name?.toLocaleLowerCase().includes(term) ||
    item.legacyName?.toLocaleLowerCase().includes(term));
  items.sort((a,b) => (Number(b.id === Number(term))-Number(a.id === Number(term))) || a.id-b.id);
  return {total:items.length,items:items.slice(0,Math.min(100,Math.max(1,limit))).map(item=>({
    id:item.id,name:item.name,type:item.type,quality:item.quality,source:item.catalogSource,
    description:String(item.desc || '').replace(/<[^>]*>/g,'').replace(/\\n/g,'\n').trim()}))};
}

module.exports = {load,search};
