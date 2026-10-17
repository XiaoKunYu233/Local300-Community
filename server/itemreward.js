'use strict';
// Consume only rewards supported by a complete configuration or an exact description.
const fs = require('fs');
const path = require('path');
const config = path.join(__dirname, 'logs', 'cfg');
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const rows = read(path.join(config, 'item_item.json'), []);
const items = new Map(rows.map(r => [+r[1], { name: String(r[23] || ''), desc: String(r[24] || ''), type: String(r[2] || '') }]));
const preview = read(path.join(__dirname, 'items.json'), {}).道具 || {};
const currentItems = require('./current-item-catalog').load().byId;
const grantTypes = new Set(['restore','armour','gem','magicgem','magicgemequip','treasure']);
const shopRows = read(path.join(config, 'shopcommodity.json'), []);
const overrides = read(path.join(__dirname, 'item-reward.json'), {});
const names = new Map();
for (const [id, item] of items) {
  if (!item.name) continue;
  if (!names.has(item.name)) names.set(item.name, []);
  names.get(item.name).push(id);
}
const exactId = name => {
  const ids = names.get(name.trim()) || [];
  return ids.length === 1 ? ids[0] : null;
};
const clean = s => String(s || '').replace(/<color=[^>]*>/gi, '').replace(/\\n/g, '\n').trim();
const validGrant = x => x && Number.isInteger(+x.itemId) && +x.itemId > 0 && +x.itemId <= 65535 &&
  Number.isSafeInteger(+x.count) && +x.count > 0 && items.has(+x.itemId) &&
  grantTypes.has(preview[+x.itemId]?.type);
// shopcommodity[35] also contains probability-pool alternatives. Its presence
// does not prove that every listed reward is granted together. In particular,
// 49725 lacks verified odds and a durable fifth-open guarantee counter.
function unverifiedProbability(itemId) {
  const probability = /概率|几率|机率/;
  return probability.test(clean(currentItems[itemId]?.desc || items.get(itemId)?.desc)) ||
    shopRows.some(r => +r[8] === itemId && /随机|概率|几率|机率/.test(clean(r[36])));
}
function explicitFixed(itemId) {
  if (unverifiedProbability(itemId)) return null;
  const matches = shopRows.filter(r => +r[8] === itemId && typeof r[35] === 'string' && r[35] !== '0.000000');
  if (!matches.length) return null;
  const lists = matches.map(r => r[35].split(':').map(part => {
    const m = /^(\d+);(\d+)$/.exec(part);
    return m ? { itemId: +m[1], count: +m[2] } : null;
  }));
  if (lists.some(list => !list.length || list.some(x => !validGrant(x) || x.itemId === itemId))) return null;
  const first = JSON.stringify(lists[0]);
  return lists.every(list => JSON.stringify(list) === first) ? lists[0] : null;
}
function currencyByItem(itemId) {
  const item = items.get(+itemId);
  if (!item) return null;
  const d = clean(item.desc);
  if (/随机|任选|自选|自由选择/.test(d)) return null;
  const m = /^(\d+)\s*(金币|绑定钻石|钻石)$/.exec(item.name);
  const text = /^(?:使用后)?获得\s*(\d+)\s*个?\s*(金币|绑定钻石|钻石|莫比乌斯币)$/.exec(d);
  const found = text || m;
  if (!found || !Number.isSafeInteger(+found[1]) || +found[1] <= 0) return null;
  return { kind: 'attr', attr: { 金币: 50, 绑定钻石: 157, 钻石: 72, 莫比乌斯币: 141 }[found[2]], amount: +found[1] };
}
function describedItems(itemId) {
  const lines = clean(items.get(itemId).desc).split('\n').map(s => s.trim()).filter(Boolean);
  const grants = [];
  for (let line of lines) {
    if (/^按住Ctrl|^该礼包在|^已拥有/.test(line)) continue;
    if (/^(?:使用后|开启后|打开后).*[:：]$/.test(line)) continue;
    if (/使用后|开启后|打开后/.test(line) && /以下|下列|任选|选择|随机/.test(line)) continue;
    line = line.replace(/^(?:使用后|开启后|打开后)?(?:可)?(?:获得|得到|领取)/, '').trim();
    let m = /^(\d+)\s*个?\s*(.+)$/.exec(line);
    let count, name;
    if (m) { count = +m[1]; name = m[2]; }
    else {
      m = /^(.+?)[*×](\d+)(?:个)?[。.]?$/.exec(line);
      if (m) { name = m[1]; count = +m[2]; }
      else {
        m = /^(.+?)(\d+)颗[。.]?$/.exec(line);
        if (!m) return null;
        name = m[1]; count = +m[2];
      }
    }
    const id = exactId(name.trim());
    if (!id || id === itemId || !validGrant({ itemId: id, count })) return null;
    grants.push({ itemId: id, count });
  }
  return grants.length ? grants : null;
}
function rewardFor(id) {
  const itemId = +id, item = items.get(itemId);
  if (!item) return null;
  const override = overrides[itemId];
  if (override) {
    if (override.kind === 'items' && Array.isArray(override.items) && override.items.length &&
        override.items.every(validGrant) && override.items.every(x => +x.itemId !== itemId)) {
      if (override.pool && (override.choice || !Array.isArray(override.weights) || override.weights.length !== override.items.length ||
          override.weights.some(w => !Number.isSafeInteger(w) || w <= 0))) return null;
      return override;
    }
    if (override.kind === 'attr' && Number.isInteger(override.attr) && Number.isSafeInteger(override.amount) && override.amount > 0) return override;
    return null;
  }
  const d = clean(item.desc);
  if (/随机/.test(d)) return null; // No verified weights for these pools.
  const choice = /自由选择|任选|自选/.test(d);
  if (choice) {
    const grants = describedItems(itemId);
    return grants && grants.length >= 2 ? { kind: 'items', items: grants, choice: true, pool: false } : null;
  }
  if (unverifiedProbability(itemId)) return null; // Keep unsupported pools/pity boxes unopened.
  const fixed = explicitFixed(itemId);
  if (fixed) return { kind: 'items', items: fixed, choice: false, pool: false };
  const currency = currencyByItem(itemId);
  if (currency) return currency;
  if (!/^(?:使用后|开启后|打开后)/.test(d)) return null;
  const grants = describedItems(itemId);
  return grants ? { kind: 'items', items: grants, choice: false, pool: false } : null;
}
function sampleReward(rule, random = Math.random) {
  if (!rule || rule.choice) return null;
  if (!rule.pool) return rule;
  const n = random();
  if (!(n >= 0 && n < 1)) return null;
  const total = rule.weights.reduce((sum, w) => sum + w, 0);
  if (!Number.isSafeInteger(total)) return null;
  let mark = n * total;
  for (let i = 0; i < rule.items.length; i++) {
    mark -= rule.weights[i];
    if (mark < 0) return { kind: 'items', items: [rule.items[i]], pool: true, choice: false };
  }
  return null;
}
function resolveReward(itemId, random = Math.random) { return sampleReward(rewardFor(itemId), random); }
function rewardOptions(itemId) {
  const r = rewardFor(itemId);
  return r && r.kind === 'items' ? { choice: !!r.choice, pool: !!r.pool,
    items: r.items.map(x => ({ itemId: +x.itemId, count: +x.count })) } : null;
}
module.exports = { rewardFor, resolveReward, rewardOptions, currencyByItem, sampleReward };
