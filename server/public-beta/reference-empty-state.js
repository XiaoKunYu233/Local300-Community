'use strict';

// Pure seed projection: no account reads, paths, writes, captured quantities or
// existing state are accepted. Files must be written explicitly by the caller.
// Layouts without a pure constructor follow their current ENOENT/read defaults;
// isolated tests round-trip them through those real state readers.
const rune = require('../rune-system');
const magicPity = require('../magic-pity');
const gemBoard = require('../gem-board');
const soul = require('../equipment-soul');
const {MailState} = require('../mail-state');
const {RESOURCE_IDS} = require('../enhancement-resources');
const materialIds = require('../item-container-evidence.json').materialIds;

function ids(input, label, maximum=0xffffffff) {
  if (!Array.isArray(input) || input.some(id => !Number.isSafeInteger(id) || id < 1 || id > maximum))
    throw Error('Invalid extra zero-balance ' + label + ' IDs');
  return input;
}
function zeroBalances(known, extra) {
  return Object.fromEntries([...new Set([...known,...extra])].sort((a,b)=>a-b).map(id=>[id,0]));
}
function emptyMail(now) {
  // MailState explicitly supports caller-provided IO. This in-memory empty
  // document runs its actual normalization without consulting the filesystem.
  const memory = {readFileSync:()=> '{}'};
  const state = new MailState('public-beta-empty-mail',memory).snapshot();
  delete state.token;
  return {...state,updatedAt:new Date(now).toISOString()};
}
function create(options = {}) {
  if (!options || typeof options!=='object' || Array.isArray(options) ||
      Object.keys(options).some(key=>!['now','extraResourceIds','extraMaterialIds'].includes(key)))
    throw Error('Only empty-state clock and extra zero-balance IDs are accepted');
  const {now=Date.now(),extraResourceIds=[],extraMaterialIds=[]}=options;
  if (!Number.isSafeInteger(now) || now < 0 || Math.floor(now/1000)>0xffffffff)
    throw Error('Invalid empty-state clock');
  ids(extraResourceIds,'resource'); ids(extraMaterialIds,'material',65534);

  // godsendInfo is a pure wrapper around the module's internal normalizer.
  // Keep its one initial limited activation, disabled pool, zero expiry/pity,
  // base two Ban slots and current configured odds; do not copy old progress.
  const godsend = rune.RuneState.prototype.godsendInfo.call({state:{godsend:undefined}});
  const warPages = Array.from({length:5},(_,i)=>({name:'战魂配置'+(i+1),units:{},levels:{},
    active:i===0,fragments:{}}));
  const enhancementPages = Array.from({length:5},(_,i)=>({name:'加护配置'+(i+1),
    opened:i===0,active:i===0,values:Array(12).fill(0),locked:[]}));

  return {
    'rune-state.json':{version:1,nextId:1,currentPage:0,pages:[{name:'配置1',
      slots:Array(rune.SLOT_COUNT).fill(null),openSlots:Array(rune.SLOT_COUNT).fill(true),active:true}],
      inventory:{},tokens:{},fragments:0,nativeBoards:{},godsend,updatedAt:now},
    'war-soul-state.json':{version:1,currentPage:0,pages:warPages,enhancementPage:0,
      enhancementPages,units:{},sets:{},materials:{fragments:{}},updatedAt:now},
    'magic-gem-state.json':{version:1,nextGemId:1,devices:{},gems:{},graphs:{},
      pity:magicPity.normalize(),currencies:{},currentDeviceGuid:null,equippedBySet:[null,null,null],updatedAt:now},
    'gem-board-state.json':gemBoard.validate(gemBoard.initial()),
    'warehouse-state.json':{version:1,capacity:42,items:{},updatedAt:now},
    'exstore-state.json':{version:1,capacity:42,items:{},updatedAt:now},
    'item-lock-state.json':{version:1,items:{},updatedAt:now},
    'material-state.live.json':{items:zeroBalances(materialIds,extraMaterialIds),updatedAt:new Date(now).toISOString()},
    // RES first receives captured 11552/11553 balances, then overlays this
    // document. An empty object means unchanged; explicit zeros mean empty.
    'bag-state.live.resources.json':zeroBalances(RESOURCE_IDS,extraResourceIds),
    'equipment-repair-state.json':{version:1,repairs:{},updatedAt:now},
    'equipment-crafting-state.json':{version:1,forge:{},applied:{},receipts:{},
      nativeForge:{},pity:{},updatedAt:now},
    'reforge-state.json':{version:1,pending:{},applied:{}},
    'enhancement-state.json':{version:1,instances:{}},
    'soul-state.json':soul.validate({version:1,instances:{}}),
    'mail-state.json':emptyMail(now),
    'mail-extra.json':{mails:[]},
    'shop-limit-state.json':{counts:{},pending:null},
  };
}

module.exports={create};
