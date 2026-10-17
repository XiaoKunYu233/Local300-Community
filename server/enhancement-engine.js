'use strict';

const {normalizeGuid} = require('./enhancement-state');
const {MAX_ATTRIBUTE_LEVEL, MAX_SKILL_LEVEL} = require('./enhancement-catalog');

const currencies = new Set(['gold', 'diamond']);
const u32 = n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;
function amountMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid cost map');
  const result = {};
  for (const [id, amount] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(id) || !u32(amount)) throw new TypeError('invalid resource cost');
    result[id] = amount;
  }
  return result;
}
function attributes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid attributes');
  const result = {};
  for (const [id, amount] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(id) || !u32(amount)) throw new TypeError('invalid attribute value');
    result[id] = amount;
  }
  return result;
}

// The engine accepts an executable rule from its adapter. The ordinary catalog
// remains read-only; the local server policy is supplied separately.
class EnhancementEngine {
  constructor({findInstance, balances, ruleFor, attributesFor, commit, receiptFor = () => null, random = Math.random}) {
    for (const [name, fn] of Object.entries({findInstance, balances, ruleFor, attributesFor, commit, receiptFor, random}))
      if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
    Object.assign(this, {findInstance, balances, ruleFor, attributesFor, commit, receiptFor, random});
  }

  quote({guid, purchaseCurrency = null, luckyItemId = 0} = {}) {
    let key;
    try { key = normalizeGuid(guid); } catch { return {ok:false, reason:'invalid-guid'}; }
    if (purchaseCurrency !== null && !currencies.has(purchaseCurrency))
      return {ok:false, reason:'invalid-payment-choice'};
    if (!Number.isInteger(luckyItemId) || luckyItemId < 0 || luckyItemId > 65535)
      return {ok:false, reason:'invalid-lucky-card'};
    let instance;
    try { instance = this.findInstance(key); } catch { return {ok:false, reason:'equipment-instance-not-found'}; }
    let instanceGuid;
    try { instanceGuid = normalizeGuid(instance?.guid); } catch { return {ok:false, reason:'equipment-instance-not-found'}; }
    if (!instance || instanceGuid !== key || !Number.isSafeInteger(instance.itemId) ||
        !Number.isInteger(instance.level) || instance.level < 0 || instance.level > MAX_ATTRIBUTE_LEVEL)
      return {ok:false, reason:'equipment-instance-not-found'};
    if (instance.level === MAX_ATTRIBUTE_LEVEL) return {ok:false, reason:'maximum-level'};
    const targetLevel = instance.level + 1;
    let rule;
    try { rule = this.ruleFor({itemId:instance.itemId, currentLevel:instance.level,
      targetLevel,blessing:instance.blessing,luckyItemId}); }
    catch { return {ok:false, reason:'rule-unconfirmed'}; }
    if (!rule || rule.executionReady !== true) return {ok:false, reason:'rule-unconfirmed'};
    if (rule.itemId !== instance.itemId || rule.currentLevel !== instance.level || rule.targetLevel !== targetLevel ||
        !u32(rule.successNumerator) || !Number.isSafeInteger(rule.successDenominator) ||
        rule.successDenominator < 1 || rule.successNumerator > rule.successDenominator ||
        !Number.isInteger(rule.failureLevel) || rule.failureLevel < 0 || rule.failureLevel > instance.level)
      return {ok:false, reason:'invalid-server-rule'};
    let costs, held, wallet;
    try {
      costs = amountMap(rule.resources);
      const snapshot = this.balances();
      held = amountMap(snapshot.resources);
      wallet = snapshot.wallet;
      if (!wallet || !u32(wallet.gold) || !u32(wallet.diamond)) throw new TypeError('invalid wallet');
    } catch { return {ok:false, reason:'invalid-economy-state'}; }
    const missing = {};
    for (const [id, amount] of Object.entries(costs)) {
      const deficit = amount - (held[id] ?? 0);
      if (deficit > 0) missing[id] = deficit;
    }
    let purchaseAmount = 0;
    if (Object.keys(missing).length) {
      if (purchaseCurrency === null) return {ok:false, reason:'materials-insufficient', missing};
      const price = rule.purchasePrice?.[purchaseCurrency];
      // Prices are supplied by the authoritative rule for this exact deficit.
      if (typeof price !== 'function') return {ok:false, reason:'purchase-rule-unconfirmed'};
      try { purchaseAmount = price({...missing}); }
      catch { return {ok:false, reason:'purchase-rule-unconfirmed'}; }
      if (!u32(purchaseAmount)) return {ok:false, reason:'invalid-server-rule'};
    }
    const base = rule.walletCost || {};
    if (!u32(base.gold ?? 0) || !u32(base.diamond ?? 0)) return {ok:false, reason:'invalid-server-rule'};
    const debitWallet = {gold:base.gold ?? 0, diamond:base.diamond ?? 0};
    if (purchaseCurrency) debitWallet[purchaseCurrency] += purchaseAmount;
    if (!u32(debitWallet.gold) || !u32(debitWallet.diamond)) return {ok:false, reason:'invalid-server-rule'};
    if (debitWallet.gold > wallet.gold || debitWallet.diamond > wallet.diamond)
      return {ok:false, reason:'balance-insufficient'};
    let currentAttributes, successAttributes, failureAttributes;
    try {
      currentAttributes = attributes(this.attributesFor(instance.itemId, instance.level));
      successAttributes = attributes(this.attributesFor(instance.itemId, targetLevel));
      failureAttributes = attributes(this.attributesFor(instance.itemId, rule.failureLevel));
    } catch { return {ok:false, reason:'attribute-rule-unconfirmed'}; }
    return {ok:true, plan:{guid:key, itemId:instance.itemId, currentLevel:instance.level, targetLevel,
      costs, missing, debitResources:Object.fromEntries(Object.entries(costs).map(([id,n])=>[id,n-(missing[id]??0)])),
      debitWallet, purchaseCurrency, successNumerator:rule.successNumerator,
      successDenominator:rule.successDenominator, failureLevel:rule.failureLevel,
      luckyItemId,
      currentAttributes, successAttributes, failureAttributes,
      skillCalculationLevel:Math.min(targetLevel, MAX_SKILL_LEVEL)}};
  }

  execute(request) {
    if (request?.requestId !== undefined &&
        (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128))
      return {ok:false, reason:'invalid-request-id'};
    if (request?.requestId) {
      const previous=this.receiptFor(request.requestId);
      if (previous) return {...previous, repeated:true};
    }
    const quoted = this.quote(request);
    if (!quoted.ok) return quoted;
    const draw = this.random();
    if (typeof draw !== 'number' || !Number.isFinite(draw) || draw < 0 || draw >= 1)
      return {ok:false, reason:'invalid-random-source'};
    const plan = quoted.plan;
    const success = draw * plan.successDenominator < plan.successNumerator;
    const level = success ? plan.targetLevel : plan.failureLevel;
    const next = {guid:plan.guid, itemId:plan.itemId, level,
      skillCalculationLevel:Math.min(level, MAX_SKILL_LEVEL),
      attributes:success ? plan.successAttributes : plan.failureAttributes};
    const result = {ok:true, success, previousLevel:plan.currentLevel, ...next,
      debitResources:plan.debitResources, debitWallet:plan.debitWallet};
    try {
      // commit must revalidate the instance and all balances under its write
      // guard, then persist debits, state and optional receipt before true.
      if (this.commit({plan, next, result, requestId:request?.requestId ?? null}) !== true)
        return {ok:false, reason:'commit-rejected'};
    } catch { return {ok:false, reason:'commit-failed'}; }
    return result;
  }
}

module.exports = {EnhancementEngine};
