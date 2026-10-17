'use strict';

// Native rune records use compact triples: attribute id (u8), value (u16 LE).
// There is no padding byte between adjacent attributes. Keeping this in one
// helper prevents values above 255 from losing their high byte.
function writeRuneAttributeTriples(record, start, attrs, maxCount = Infinity) {
  const list = Array.isArray(attrs) ? attrs : Object.entries(attrs || {});
  const count = Math.min(
    Math.floor(Math.max(0, record.length - start) / 3),
    Math.max(0, Number(maxCount) || 0),
    list.length,
  );
  for (let index = 0; index < count; index++) {
    const offset = start + index * 3;
    const id = Number(list[index][0]);
    const value = Math.max(0, Math.min(0xffff, Math.round(Number(list[index][1]) || 0)));
    record[offset] = Number.isFinite(id) ? id & 0xff : 0;
    record.writeUInt16LE(value, offset + 1);
  }
  return count;
}

module.exports = { writeRuneAttributeTriples };
