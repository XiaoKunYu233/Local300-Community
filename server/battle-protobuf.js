'use strict';

// Preserve 64-bit varints, including protobuf int32 negative values, exactly.
function varint(value) {
  let n = BigInt(value);
  if (n < 0n) n = BigInt.asUintN(64, n);
  if (n > 0xffffffffffffffffn) throw new Error('Varint overflow');
  const out = [];
  do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b); } while (n);
  return Buffer.from(out);
}
function decode(input) {
  let offset = 0;
  const read = () => {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= input.length) throw new Error('Truncated protobuf varint');
      const b = input[offset++];
      if (i === 9 && b > 1) throw new Error('Protobuf varint overflow');
      n |= BigInt(b & 127) << BigInt(7 * i);
      if (!(b & 128)) return n;
    }
    throw new Error('Protobuf varint overflow');
  };
  const fields = [];
  while (offset < input.length) {
    const key = read(), number = Number(key >> 3n), wire = Number(key & 7n);
    if (number < 1 || number > 0x1fffffff) throw new Error('Invalid protobuf field');
    if (wire === 0) { fields.push({number, wire, value: read()}); continue; }
    const length = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(read()) : -1;
    if (length < 0 || !Number.isSafeInteger(length) || offset + length > input.length) throw new Error('Invalid protobuf bytes');
    fields.push({number, wire, bytes: Buffer.from(input.subarray(offset, offset + length))});
    offset += length;
  }
  return fields;
}
function encode(fields) {
  const chunks = [];
  for (const f of fields) {
    chunks.push(varint(f.number * 8 + f.wire));
    if (f.wire === 0) chunks.push(varint(f.value));
    else if ([1,2,5].includes(f.wire)) {
      if (f.wire === 2) chunks.push(varint(f.bytes.length));
      else if (f.bytes.length !== (f.wire === 1 ? 8 : 4)) throw new Error('Invalid fixed field');
      chunks.push(f.bytes);
    } else throw new Error('Unsupported protobuf wire type');
  }
  return Buffer.concat(chunks);
}
function get(fields, number, signed = false) {
  const f = fields.find(f => f.number === number && f.wire === 0);
  if (!f) return undefined;
  const n = signed ? BigInt.asIntN(32, f.value) : f.value;
  const value = Number(n);
  if (!Number.isSafeInteger(value)) throw new Error('Unsafe numeric protobuf value');
  return value;
}
function set(fields, number, value) {
  const result = fields.map(f => ({...f}));
  const found = result.find(f => f.number === number && f.wire === 0);
  if (found) found.value = BigInt(value); else result.push({number, wire:0, value:BigInt(value)});
  return result;
}
module.exports = { varint, decode, encode, get, set };
