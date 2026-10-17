'use strict';

// Deterministic rules only. See HANDOFF-ASTRA-ENHANCE-RULES.md for evidence
// and the distinction between client display probability and server RNG.
const legacyArmour = require('./logs/cfg/item_armour.json');
const currentArmour = require('../data/current-client/item_armour.json');
const levels = require('../data/enhancement/equipraiselv-normal.json');
const coefficients = require('../data/enhancement/equipattrraisevalue-normal.json');
const {userCostFor} = require('./enhancement-user-costs');
const legacyItems = require('./logs/cfg/item_item.json');
const currentItems = require('../data/current-client/item_item.json');
function preferCurrent(current,legacy){
  const ids=new Set(current.map(row=>row[1]));
  return [...current,...legacy.filter(row=>!ids.has(row[1]))];
}
const armour=preferCurrent(currentArmour,legacyArmour),itemRows=preferCurrent(currentItems,legacyItems);
const REGRESSION_ITEM_IDS = Object.freeze([26046, 26056, 27024, 27062]);
// Keys are 13511 / equipattrraisevalue IDs, NOT character 1045 IDs.
const ARMOUR_FIELDS = Object.freeze({1:2,2:6,3:3,4:5,5:7,6:19,7:11,8:12,
  9:15,10:16,11:14,12:4,13:13,14:17,15:18,16:25,17:26,18:27,19:28,20:9});
const DISPLAY_RATE_BPS = Object.freeze([10000,10000,10000,9000,8000,7100,5400,
  4500,3300,2000,1400,800,500,300,200,100,50]);
const DISPLAY_FAILURE_CAPS = Object.freeze([1,1,1,2,2,3,4,5,7,13,19,33,54,90,135,180,225]);
const DISPLAY_CARDS = Object.freeze([7501,7502,7503,7504,7505,7506,7507,7508,
  7509,7510,7511,7512,7513,7514,7515,7500,7499]);
const DEFAULT_PRICES = Object.freeze({gold:Object.freeze({40001:15,40002:15,40003:500}),
  diamond:Object.freeze({40001:10,40002:10,40003:100})});
function integer(n, max = 0xffffffff) {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new RangeError('invalid nonnegative integer');
  return n;
}
function indexRows(rows) {
  const result=new Map();
  for(const row of rows){const id=row[1];if(!result.has(id))result.set(id,[]);result.get(id).push(row);}
  return result;
}
const ARMOUR_BY_ID=indexRows(armour),ITEM_BY_ID=indexRows(itemRows);
const LEGACY_ARMOUR_BY_ID=indexRows(legacyArmour),LEGACY_ITEM_BY_ID=indexRows(legacyItems);
function eligibility(itemId,{currentClient=true}={}) {
  if(!Number.isSafeInteger(itemId)||itemId<=0)return {supported:false,reason:'invalid-item-id'};
  const items=(currentClient?ITEM_BY_ID:LEGACY_ITEM_BY_ID).get(itemId),
    arms=(currentClient?ARMOUR_BY_ID:LEGACY_ARMOUR_BY_ID).get(itemId);
  if(!items?.length)return {supported:false,reason:'missing-item-config'};
  if(items.length!==1)return {supported:false,reason:'ambiguous-item-config'};
  const item=items[0];
  if(item[10]!=='armour')return {supported:false,reason:'non-armour-type'};
  if(item[41]!==1)return {supported:false,reason:'not-enhanceable'};
  if(item[59]!==0)return {supported:false,reason:'season-or-special-branch'};
  if(!arms?.length)return {supported:false,reason:'missing-armour-config'};
  if(arms.length!==1)return {supported:false,reason:'ambiguous-armour-config'};
  const row=arms[0];
  // nIsPlus selects the second point column in the ordinary client table.
  // The armour row already contains the raised base values; scaling those a
  // second time would incorrectly apply the 30% bonus twice.
  if(![0,1].includes(row[41]))return {supported:false,reason:'unknown-plus-branch'};
  const base={};
  for(const [id,field] of Object.entries(ARMOUR_FIELDS)){
    const value=row[field];
    if(!Number.isSafeInteger(value)||value<0||value>65535)
      return {supported:false,reason:'incomplete-or-invalid-attribute-map',field};
    base[id]=value;
  }
  try { growBase(base,17,row[41]===1); }
  catch(error){return {supported:false,reason:error.message==='zero weighted base'
    ? 'zero-weighted-base' : 'growth-overflow-or-invalid'};}
  return {supported:true,itemId,base,row,item,plus:row[41]===1};
}
function supported(itemId,options) {
  const result=eligibility(itemId,options);
  if(!result.supported)throw new RangeError(`equipment growth unavailable: ${result.reason}`);
  return result;
}
function scanEquipment({currentClient=true}={}) {
  const selectedArmour=currentClient?ARMOUR_BY_ID:LEGACY_ARMOUR_BY_ID,
    selectedItems=currentClient?itemRows:legacyItems;
  const ids=new Set([...selectedArmour.keys(),...selectedItems.filter(r=>
    ['armour','treasure','weapon','magicgemequip'].includes(r[10])).map(r=>r[1])]);
  const reasons={},examples={};let supportedCount=0;
  for(const id of [...ids].sort((a,b)=>a-b)){
    const result=eligibility(id,{currentClient}),reason=result.supported?'supported':result.reason;
    reasons[reason]=(reasons[reason]||0)+1;
    if(!examples[reason])examples[reason]=[];
    if(examples[reason].length<8)examples[reason].push(id);
    if(result.supported)supportedCount++;
  }
  return {total:ids.size,supported:supportedCount,reasons,examples};
}
function growBase(base, level, plus = false) {
  integer(level,17);
  const levelRow=level===0 ? null : levels.find(r=>r[1]===level && r[8]===0);
  if(level!==0 && !levelRow)throw new RangeError('missing ordinary growth point');
  const point=level===0 ? 0 : levelRow[plus ? 12 : 5];
  integer(point);
  let budget = 0n;
  for (const c of coefficients) budget += BigInt(integer(base[c[1]] ?? 0)) * BigInt(c[3]);
  if (!budget) throw new RangeError('zero weighted base');
  const result = {};
  for (const [id, value] of Object.entries(base)) {
    integer(value,65535);
    const coefficient = coefficients.find(c=>String(c[1])===id)?.[3] ?? 0;
    const delta = coefficient > 0 ? Number(BigInt(value)*BigInt(point)/budget) : 0;
    result[id] = integer(value+delta,65535);
  }
  return result;
}
function attributesFor(itemId, level, options) {
  const {base,plus}=supported(itemId,options);
  return growBase(base,level,plus);
}
function materialsFor(itemId, currentLevel) {
  supported(itemId);
  const row = userCostFor(currentLevel);
  return {resources:{...row.resources}, currentLevel, targetLevel:currentLevel+1,
    source:currentLevel===16?'user-specified 2026-09-29':'official-13511-capture',
    deterministicReady:true};
}
function purchasePrice(currency, missing, overrides = {}) {
  if (!Object.hasOwn(DEFAULT_PRICES,currency)) throw new RangeError('invalid currency');
  let sum = 0;
  for (const [id,n] of Object.entries(missing)) {
    if (!Object.hasOwn(DEFAULT_PRICES[currency],id)) throw new RangeError('unknown material');
    integer(n);
    const price = overrides[id] ?? DEFAULT_PRICES[currency][id];
    sum += n*integer(price);
    integer(sum);
  }
  return sum; // diamond wallet uses integer cents; never round to whole diamonds.
}
function purchaseQuote(required, held, overrides = {}) {
  const missing = {}, debitResources = {};
  for (const [id,need] of Object.entries(required)) {
    if (!Object.hasOwn(DEFAULT_PRICES.gold,id)) throw new RangeError('unknown material');
    integer(need); integer(held[id]??0);
    debitResources[id] = Math.min(need,held[id]??0);
    if (need>debitResources[id]) missing[id]=need-debitResources[id];
  }
  return {missing,debitResources,gold:purchasePrice('gold',missing,overrides.gold),
    diamond:purchasePrice('diamond',missing,overrides.diamond)};
}
function clientDisplay(currentLevel, failureCount, luckySelected = false) {
  integer(currentLevel,16); integer(failureCount);
  if (typeof luckySelected !== 'boolean') throw new TypeError('invalid lucky selection');
  const progressPercent=Math.floor(failureCount/DISPLAY_FAILURE_CAPS[currentLevel]*100);
  return {source:'300x_982_index.js display only',serverProbabilityKnown:false,
    blessingPoints:failureCount*10,blessingMaximum:DISPLAY_FAILURE_CAPS[currentLevel]*10,
    progressPercent,rateBps:luckySelected||progressPercent===100?10000:DISPLAY_RATE_BPS[currentLevel],
    luckyItemId:DISPLAY_CARDS[currentLevel],failureCap:DISPLAY_FAILURE_CAPS[currentLevel]};
}
function readiness(itemId,currentLevel) {
  materialsFor(itemId,currentLevel);
  return {deterministicReady:true,executionReady:false,
    blockers:['server-random-policy-unconfirmed',
      ...([4,9,15].includes(currentLevel+1)?['new-blessing-attribute-pool-unconfirmed']:[])],
    attributes:attributesFor(itemId,currentLevel+1)};
}
// Existing Sol engine accepts these two signatures directly. A stochastic
// rule must be supplied separately after an explicit policy decision.
function ruleFor({itemId,currentLevel,targetLevel}) {
  if(targetLevel!==currentLevel+1) throw new RangeError('invalid target level');
  const status=readiness(itemId,currentLevel);
  return {...status,itemId,currentLevel,targetLevel,...materialsFor(itemId,currentLevel),
    executionReady:false,purchasePrice:{gold:missing=>purchasePrice('gold',missing),
      diamond:missing=>purchasePrice('diamond',missing)}};
}
// Disabled by default. This narrow first release needs no random blessing pool
// or failure counter. Calling it requires an explicit recorded user decision;
// it does not claim the local 100% policy is measured official-server RNG.
function createLocalStartRules(authorization) {
  if(authorization?.policy!=='ordinary-start-v1' || authorization?.authorized!==true ||
      typeof authorization?.decisionRecord!=='string' || !authorization.decisionRecord.trim())
    throw new Error('explicit user authorization record required');
  const record=authorization.decisionRecord;
  return {attributesFor,ruleFor(input){
    const rule=ruleFor(input);
    if(input.currentLevel>2)return {...rule,blockers:['local-start-v1-stops-at-level-3']};
    return {...rule,executionReady:true,blockers:[],successNumerator:1,successDenominator:1,
      failureLevel:input.currentLevel,walletCost:{gold:0,diamond:0},
      stochasticSource:'user-authorized local policy ordinary-start-v1',decisionRecord:record};
  }};
}
module.exports={REGRESSION_ITEM_IDS,ARMOUR_FIELDS,DISPLAY_RATE_BPS,DISPLAY_FAILURE_CAPS,DISPLAY_CARDS,
  DEFAULT_PRICES,attributesFor,growBase,materialsFor,purchasePrice,purchaseQuote,clientDisplay,readiness,ruleFor,
  eligibility,scanEquipment,createLocalStartRules};
