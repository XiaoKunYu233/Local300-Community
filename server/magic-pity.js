'use strict';
const rows = require('./client-magic-config/magicgempity.json');
const gains = require('./client-magic-config/magicgempityget.json');
const keys = ['normal', 'advanced', 'circuit'];
const list = text => String(text || '').split(';').map(Number).filter(Boolean);
function selection(id, attr) {
  const row = rows.find(row => Number(row[1]) === Number(id));
  if (!row || !Number.isInteger(Number(attr))) return null;
  const field = row[6] !== undefined ? 6 : row[7] !== undefined ? 7 : 5;
  const attrClass = field === 6 ? 2 : 1;
  if (!list(row[field]).includes(Number(attr))) return null;
  return { id: Number(id), attr: Number(attr), attrClass, kind: keys[Number(row[3]) - 1], limit: Number(row[4]) };
}
function normalize(value = {}) {
  const result = {};
  for (const [index, kind] of keys.entries()) {
    result[kind] = Math.max(0, Math.min(0xffffffff, Math.floor(Number(value[kind]) || 0)));
    const selected = selection(value[kind + 'PityID'], value[kind + 'AttrID']);
    const valid = selected?.kind === kind;
    result[kind + 'PityID'] = valid ? selected.id : [1, 3, 5][index];
    result[kind + 'AttrID'] = valid ? selected.attr : 38;
  }
  return result;
}
function current(value, kind) {
  const state = normalize(value), target = selection(state[kind + 'PityID'], state[kind + 'AttrID']);
  return { state, target, due: state[kind] >= target.limit };
}
function earn(costs) {
  return Object.entries(costs).reduce((total, [id, count]) => total + Number(count) * Number(gains.find(row => Number(row[3]) === Number(id))?.[4] || 0), 0);
}
function advance(state, kind, costs, consumed = false) {
  const { state: next, target } = current(state, kind);
  next[kind] = Math.min(0xffffffff, next[kind] - (consumed ? target.limit : 0) + earn(costs));
  return next;
}
module.exports = { keys, selection, normalize, current, earn, advance };
