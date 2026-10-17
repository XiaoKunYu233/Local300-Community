'use strict';

// The three IDs observed as u32 resource balances in real 11553 frames.
// Similar named boxes remain ordinary inventory items until they are used.
const ENHANCEMENT_RESOURCE_IDS = Object.freeze([40001, 40002, 40003]);
// Captured 11553 includes 7421 (rune fragments). The client's material bag
// also identifies the 7520..7529 fusion-card family as unbounded materials;
// these share restore / item_item[30]=257 with captured resource 7421. The
// old 11523 counter is a different ID namespace and did not display 7529.
// WarSoulPan 0x62aeaa -> 0x46bca0 reads material 7700 from the
// 11552/11553 resource map, not the GUID bag. 0x46bcf0 handles that map.
// Forge material counts: native 14b5b8c -> 46bca0 resource lookup.
// 7899 magic circuit belongs to the material panel (user-confirmed native
// inheritance test, 2026-10-09); never grant it as a GUID bag item.
const MATERIAL_RESOURCE_IDS = Object.freeze([7421,7700,7899,7901,7902,7903,7904,7905,7906,
  7499,7500,7501,7502,7503,7504,7505,7506,7507,7508,7509,7510,7511,7512,7513,7514,7515,
  7516,7517,7518,7519,7520,7521,7522,7523,7524,7525,7526,7527,7528,7529]);
// Native 11552/11553 capture contains 46612 and 46604. Lua treats all
// configured wash, refinement and direction costs as materials without GUIDs.
const magicTemplates=require('./client-magic-config/magicgem.json');
const MAGIC_RESOURCE_IDS=Object.freeze([...new Set([
  46612,
  ...require('./client-magic-config/magicgemwash.json').flatMap(row=>Object.entries(row).filter(([k])=>Number(k)>1).map(([,v])=>Number(v))),
  ...magicTemplates.flatMap(row=>[33,38,43,44,45,46,47].map(k=>Number(String(row[k]||'0').split(';')[0]))),
  ...magicTemplates.flatMap(row=>String(row[48]||'').split(';').map(Number))
].filter(id=>id>0))]);
// Shop fa3cae..fa3d66 reads these IDs via the native material balance lookup.
const SHOP_RESOURCE_IDS=Object.freeze([7814,7865,9007,9017]);
const RESOURCE_IDS = Object.freeze([...ENHANCEMENT_RESOURCE_IDS,...MATERIAL_RESOURCE_IDS,...MAGIC_RESOURCE_IDS,...SHOP_RESOURCE_IDS]);
const RESOURCE_ID_SET = new Set(RESOURCE_IDS);
const ENHANCEMENT_ID_SET = new Set(ENHANCEMENT_RESOURCE_IDS);

function isEnhancementResource(itemId) {
  return ENHANCEMENT_ID_SET.has(itemId);
}
function isResourceItem(itemId) { return RESOURCE_ID_SET.has(itemId); }

function addResourceBalance(itemId, current, count) {
  if (!isResourceItem(itemId) || !Number.isSafeInteger(current) || current < 0 || current > 0xffffffff ||
      !Number.isSafeInteger(count) || count <= 0) return null;
  const total = current + count;
  return Number.isSafeInteger(total) && total <= 0xffffffff ? total : null;
}

// Read only: old saves may already contain these IDs as slot instances. A
// migration needs its own evidence and must not be hidden in normal startup.
function findLegacyResourceSlots(slotMap) {
  return [...slotMap].filter(([, item]) => item && isResourceItem(item.itemId))
    .map(([slot, item]) => ({slot, itemId: item.itemId, count: item.count, guid: item.guid}));
}

module.exports = {RESOURCE_IDS,ENHANCEMENT_RESOURCE_IDS,MATERIAL_RESOURCE_IDS,MAGIC_RESOURCE_IDS,isEnhancementResource,
  isResourceItem,addResourceBalance,findLegacyResourceSlots};
