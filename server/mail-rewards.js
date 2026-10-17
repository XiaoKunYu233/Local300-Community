'use strict';

// Resolve every attachment before inventory preflight. A display name is only
// usable when it identifies exactly one item; prefix matching is ambiguous.
function resolveAttachments(attachments, itemNames, currencyOfItem) {
  if (!Array.isArray(attachments)) return null;
  const rewards = [];
  for (const a of attachments) {
    if (!a || !Number.isSafeInteger(a.count) || a.count < 1 || a.count > 0xffffffff) return null;
    if (a.itemId !== undefined && a.itemId !== null) {
      if (!Number.isSafeInteger(a.itemId) || a.itemId < 1 || a.itemId >= 0xffff) return null;
      rewards.push({itemId: a.itemId, count: a.count});
    } else if (a.currency === true) {
      // A named gift box remains an item even if a generic shop helper can
      // derive a nominal coin value from its display name.
      if (typeof a.name !== 'string' || /礼包|箱/.test(a.name)) return null;
      const c = currencyOfItem(a.name);
      const amount = c?.amount * a.count;
      if (!Number.isInteger(c?.attr) || !Number.isSafeInteger(amount) || amount < 1 || amount > 0xffffffff) return null;
      rewards.push({attr: c.attr, amount});
    } else {
      if (typeof a.name !== 'string' || !a.name) return null;
      const matches = Object.entries(itemNames || {}).filter(([, v]) => v?.name === a.name);
      if (matches.length !== 1) return null;
      const itemId = Number(matches[0][0]);
      if (!Number.isSafeInteger(itemId) || itemId < 1 || itemId >= 0xffff) return null;
      rewards.push({itemId, count: a.count});
    }
  }
  try{return require('./player-reward-currency').convertRewards(rewards);}catch{return null;}
}

module.exports = {resolveAttachments};
