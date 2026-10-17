'use strict';

const ITEMS = require('./current-item-catalog').load().byId;
const CAPTURED_CONTAINERS = require('./item-container-evidence.json');
const {isResourceItem,MAGIC_RESOURCE_IDS} = require('./enhancement-resources');

// IDs read from the captured 11523 material list. This is protocol evidence
// for their storage location, not a numeric range or a use-effect rule.
if(CAPTURED_CONTAINERS.version!==1||![CAPTURED_CONTAINERS.materialIds,CAPTURED_CONTAINERS.slotIds].every(ids=>Array.isArray(ids)&&ids.every(id=>Number.isInteger(id)&&id>0&&id<65535)))throw Error('Invalid item container evidence');
const MATERIAL_IDS = new Set(CAPTURED_CONTAINERS.materialIds);
const CAPTURED_SLOT_IDS = new Set(CAPTURED_CONTAINERS.slotIds);

// item_item.json: 7520..7529 share type=restore and field 30=257 with
// captured 11553 resource 7421. Field 30 alone is not sufficient: other IDs
// with 257 are slot items. The client identifies these fusion cards as belonging
// to the unbounded material bag, matching 11553 rather than 11523 or 17004.
const GEM_FUSION_CARDS = new Set([7520,7521,7522,7523,7524,7525,7526,7527,7528,7529]);
const ENHANCEMENT_MATERIAL_CARDS = new Set([7499,7500,7501,7502,7503,7504,7505,7506,
  7507,7508,7509,7510,7511,7512,7513,7514,7515,7516,7517,7518,7519]);
// 21152 is an arena-match item, confirmed by the user's client test. There is
// no verified persistent container for it; reject grants before claiming mail.
const ARENA_ONLY_ITEMS = new Set([21152]);
const SLOTTED_TYPES = new Set(['restore','gem','armour','treasure','magicgem','magicgemequip']);
const DEDICATED_TYPES = new Set(['hero','skin','expression','voice','eye','bloodskin',
  'mouseskin','killeffect','VIP','Calendar','PVE','TimeBag','ExtendBag',
  'magicgemwash','currency','specialrestore','task','charm']);

function classifyItem(itemId) {
  const itemType = ITEMS[itemId]?.type || null;
  let container = 'unknown', evidence = 'no confirmed container';
  if (isResourceItem(itemId)) {
    container='resource'; evidence=itemId===7899
      ? 'user-confirmed magic circuit material panel; inheritance uses 11552/11553 resource balance'
      : GEM_FUSION_CARDS.has(itemId)
      ? 'client material-bag report; configured family matches captured 11553 rune fragment 7421'
      : ENHANCEMENT_MATERIAL_CARDS.has(itemId)
      ? 'client material-bag report; exact configured lucky/wash-card family, 11553 balance protocol'
      : MAGIC_RESOURCE_IDS.includes(itemId)
      ? 'native 11552/11553 magic materials; installed client wash/refine/direction cost tables'
      : 'captured 11553 balance update';
  } else if (ARENA_ONLY_ITEMS.has(itemId)) {
    container='dedicated'; evidence='user-confirmed arena-match-only item; persistent storage protocol unknown';
  } else if (MATERIAL_IDS.has(itemId)) {
    container='material'; evidence='captured 11523 material list';
  } else if (CAPTURED_SLOT_IDS.has(itemId)) {
    container='slot'; evidence='captured role bag record';
  } else if (SLOTTED_TYPES.has(itemType)) {
    container='slot'; evidence=`captured bag storage for item type ${itemType}`;
  } else if (DEDICATED_TYPES.has(itemType)) {
    container='dedicated'; evidence=`item type ${itemType} needs a separate storage protocol`;
  }
  return {itemId,itemType,container,evidence};
}
function containerOf(itemId) { return classifyItem(itemId).container; }
function isMaterialItem(itemId) { return containerOf(itemId)==='material'; }

// The item type describes configuration, this function describes persistence,
// and itemreward/useBagSlot separately decide what using the item does.
module.exports={classifyItem,containerOf,isMaterialItem,GEM_FUSION_CARDS,ARENA_ONLY_ITEMS};
