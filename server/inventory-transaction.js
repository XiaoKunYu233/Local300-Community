'use strict';
const {validLimits}=require('./inventory-capacity');

// Pure capacity plan. New instances have no GUID here; the committer assigns
// unique GUIDs only after the entire transaction has passed validation.
function planGrants(slots, rewards, capacity, stackMax, reserved = new Set(), canStack = () => true) {
  if (!(slots instanceof Map) || !Array.isArray(rewards) || !Number.isSafeInteger(capacity) ||
      !validLimits(capacity) || !Number.isSafeInteger(stackMax) || stackMax < 1 || stackMax > 65535) return null;
  const next = new Map([...slots].map(([s, v]) => [s, {...v}]));
  const placements = [];
  for (let index = 0; index < rewards.length; index++) {
    const {itemId, count} = rewards[index] || {};
    if (!Number.isSafeInteger(itemId) || itemId < 1 || itemId >= 0xffff ||
        !Number.isSafeInteger(count) || count < 1) return null;
    const stackable = !!canStack(itemId);
    let remaining = count;
    if (!stackable) {
      const free = Array.from({length: capacity}, (_, s) => s).filter(s => !next.has(s) && !reserved.has(s));
      if (free.length < count) return null;
      for (let n = 0; n < count; n++) {
        const slot = free[n];
        next.set(slot, {itemId, count: 1, guid: null});
        placements.push({rewardIndex: index, itemId, slot, count: 1, total: 1, merged: false, newInstance: true});
      }
      continue;
    }
    while (remaining > 0) {
      const existing = [...next].filter(([s, v]) =>
        s >= 0 && s < capacity && !reserved.has(s) && v?.itemId === itemId &&
        // Dual gems use their first component's item ID. A normal gem reward
        // must not merge into that instance or erase its second attribute.
        !v.dual &&
        Number.isSafeInteger(v.count) && v.count >= 1 && v.count < stackMax &&
        (v.guid === null || (typeof v.guid === 'string' && /^[0-9a-f]{16}$/i.test(v.guid) && !/^0+$/.test(v.guid))))
        .sort((a, b) => Number(a[1].guid === null) - Number(b[1].guid === null) || a[0] - b[0])[0];
      let slot, prev;
      if (existing) [slot, prev] = existing;
      else {
        for (let s = 0; s < capacity; s++) if (!next.has(s) && !reserved.has(s)) {slot = s; break;}
        if (slot === undefined) return null;
      }
      const amount = Math.min(remaining, stackMax - (prev?.count || 0));
      const total = (prev?.count || 0) + amount;
      next.set(slot, {...prev, itemId, count: total, guid: prev?.guid || null});
      placements.push({rewardIndex: index, itemId, slot, count: amount, total,
        merged: !!prev, newInstance: !prev});
      remaining -= amount;
    }
  }
  return {next, placements};
}

// A consumed box's slot becomes available to its own rewards when the last
// unit was used. The same result is used for preflight and the final grant.
function planUse(slots, slot, rewards, capacity, stackMax, reserved = new Set(), canStack = () => true) {
  const current = slots.get(slot);
  if (!current || !Number.isSafeInteger(slot) || slot < 0 || slot >= capacity ||
      !Number.isSafeInteger(current.count) || current.count < 1 || reserved.has(slot)) return null;
  const afterConsume = new Map([...slots].map(([s, v]) => [s, {...v}]));
  if (current.count === 1) afterConsume.delete(slot);
  else afterConsume.set(slot, {...current, count: current.count - 1});
  const plan = planGrants(afterConsume, rewards, capacity, stackMax, reserved, canStack);
  return plan ? {afterConsume, ...plan} : null;
}

// Worn instances remain in the visible bag and count toward its capacity.
// A reward cannot make room by hiding an equipped item in an extra role record.
function planAccessible(slots, rewards, capacity, records, stackMax, equipped,
  canStack = () => true, consumeSlot = null) {
  if (!(slots instanceof Map) || !validLimits(capacity,records))
    return null;
  const working = new Map(slots);
  const reserved = new Set([...equipped].map(([,e]) => e?.bagSlot).filter(Number.isInteger));
  const attempt = () => consumeSlot === null
    ? planGrants(working,rewards,capacity,stackMax,reserved,canStack)
    : planUse(working,consumeSlot,rewards,capacity,stackMax,reserved,canStack);
  const planned=attempt();
  return planned?{...planned,relocations:[]}:null;
}

module.exports = {planGrants, planUse, planAccessible};
