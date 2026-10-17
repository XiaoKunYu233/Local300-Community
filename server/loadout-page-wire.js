'use strict';
const GBK = require('./gbk');
const SLOT_COUNT = 48;
// Oct 7 original-server capture: 11679 = page:u8 + name:16 + 48*u32.
// 11678 = openSlots:u8 + pageCount:u8 + cooldown:u32 + pageCount*208.
function nameBytes(name, length) {
  let text = String(name || '');
  while (GBK.encode(text).length > length) text = text.slice(0, -1);
  const out = Buffer.alloc(length); GBK.encode(text).copy(out); return out;
}
function pageRecord(page) {
  const out = Buffer.alloc(208);
  nameBytes(page?.name, 16).copy(out);
  for (let i = 0; i < SLOT_COUNT; i++) out.writeUInt32LE(Number(page?.slots?.[i]) >>> 0, 16 + i * 4);
  return out;
}
function runeInfoPayload(state, openSlots = SLOT_COUNT) {
  const pages = state.pages || [], out = Buffer.alloc(6 + pages.length * 208);
  out[0] = openSlots; out[1] = pages.length;
  pages.forEach((page, index) => pageRecord(page).copy(out, 6 + index * 208));
  return out;
}
function runePagePayload(state, index = state.currentPage) {
  const page = state.pages?.[index]; if (!page) return null;
  const out = Buffer.alloc(217); out[4] = index;
  pageRecord(page).copy(out, 5); return out;
}
function runeOpenPayload(kind, ok = true) {
  const out = Buffer.alloc(8); out.writeUInt32LE(kind); out.writeUInt32LE(ok ? 0 : 1, 4); return out;
}
function soulRenamePayload(index, name) {
  const out = Buffer.alloc(17); out[1] = index; nameBytes(name, 15).copy(out, 2); return out;
}
module.exports = { SLOT_COUNT, nameBytes, pageRecord, runeInfoPayload, runePagePayload, runeOpenPayload, soulRenamePayload };
