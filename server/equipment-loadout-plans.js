'use strict';

const PLAN_COUNT = 3;
const SLOTS_PER_PLAN = 6;
const TOTAL_SLOTS = PLAN_COUNT * SLOTS_PER_PLAN;

function clampPlan(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < PLAN_COUNT ? n : 0;
}

function planForSlot(slot) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 0 || n >= TOTAL_SLOTS) return null;
  return { plan: Math.floor(n / SLOTS_PER_PLAN), slot: n % SLOTS_PER_PLAN };
}

function emptyPlans() {
  return Array.from({ length: PLAN_COUNT }, () => Array(SLOTS_PER_PLAN).fill(null));
}

function line(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return null;
  const bag = Number(value.bagSlot), item = Number(value.itemId), count = Number(value.count);
  const guid = Buffer.isBuffer(value.guid) ? value.guid.toString('hex') : String(value.guid || '');
  if (!Number.isInteger(bag) || bag < 0 || bag > 0xffff || !Number.isInteger(item) || item <= 0 ||
      !Number.isInteger(count) || count < 1 || !/^[0-9a-f]{16}$/i.test(guid)) return null;
  return `${bag}|${item >>> 0}|${count >>> 0}|${guid.toLowerCase()}`;
}

function normalize(raw = {}) {
  const plans = emptyPlans();
  const source = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(source.plans)) {
    for (let p = 0; p < PLAN_COUNT; p++) {
      const values = Array.isArray(source.plans[p]) ? source.plans[p] : [];
      for (let s = 0; s < SLOTS_PER_PLAN; s++) plans[p][s] = line(values[s]);
    }
  } else if (source.plans && typeof source.plans === 'object') {
    for (let p = 0; p < PLAN_COUNT; p++) {
      const values = source.plans[p] || source.plans[String(p)] || {};
      for (let s = 0; s < SLOTS_PER_PLAN; s++) plans[p][s] = line(values[s] ?? values[String(s)]);
    }
  }
  // Legacy equip-state files contain one six-slot map. Preserve it as plan 1.
  const legacy = source.slots && typeof source.slots === 'object' ? source.slots : {};
  for (const [key, value] of Object.entries(legacy)) {
    const slot = Number(key), address = planForSlot(slot);
    // Version 2 plans are authoritative. A compatibility slots view may be
    // stale or describe another active plan; never let it overwrite plan 1.
    if (address && !source.plans)
      plans[address.plan][address.slot] = line(value);
  }
  return { version: 2, activePlan: clampPlan(source.activePlan), plans };
}

function flatten(state, plan = state?.activePlan) {
  const normalized = normalize(state);
  return normalized.plans[clampPlan(plan)].map((value, slot) => value === null ? null : { slot, line: value });
}

function setSlot(state, targetSlot, value) {
  const address = planForSlot(targetSlot);
  if (!address) return null;
  const next = normalize(state);
  next.plans[address.plan][address.slot] = line(value);
  return next;
}

module.exports = { PLAN_COUNT, SLOTS_PER_PLAN, TOTAL_SLOTS, clampPlan, planForSlot, emptyPlans, line, normalize, flatten, setSlot };
