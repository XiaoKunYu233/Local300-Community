'use strict';
const LZ4 = require('./battle-lz4');
const MAX_FRAME = 32 * 1024 * 1024;

function split(plain) {
  const frames = [];
  let offset = 0;
  while (offset < plain.length) {
    if (plain.length - offset < 12) throw new Error('Truncated battle frame header');
    const length = plain.readUInt32LE(offset);
    if (length < 12 || length > MAX_FRAME || offset + length > plain.length) throw new Error('Invalid battle frame length');
    frames.push(plain.subarray(offset, offset + length)); offset += length;
  }
  return frames;
}

function expand(frame, depth = 0) {
  if (depth > 8) throw new Error('Nested battle envelope limit');
  if (frame.length < 12 || frame.length !== frame.readUInt32LE(0)) throw new Error('Invalid battle frame');
  if (frame.readUInt16LE(8) !== 9173) return [frame];
  return split(LZ4.decode(frame.subarray(12))).flatMap(f => expand(f, depth + 1));
}

function frame(tag, actor, payload = Buffer.alloc(0), flags = 0) {
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32LE(out.length, 0); out.writeUInt32LE(actor >>> 0, 4);
  out.writeUInt16LE(tag, 8); out.writeUInt16LE(flags, 10); payload.copy(out, 12);
  return out;
}

function pack(frames) { return frame(9173, 0, LZ4.encode(Buffer.concat(frames))); }

// Return the original compressed bytes when nothing changed. Changes apply only
// after decompression, then the envelope is re-encoded as a valid LZ4 block.
function transform(input, edit) {
  if (input.readUInt16LE(8) !== 9173) return edit(input);
  const plain = LZ4.decode(input.subarray(12));
  const original = split(plain);
  const edited = original.map(f => transform(f, edit));
  if (edited.every((f, i) => f && f.equals(original[i]))) return input;
  return frame(9173, input.readUInt32LE(4), LZ4.encode(Buffer.concat(edited.filter(Boolean))), input.readUInt16LE(10));
}

module.exports = { split, expand, frame, pack, transform };
