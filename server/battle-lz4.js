'use strict';

// Raw LZ4 block, with no frame header. All reads and output growth are bounded.
function decode(input, maxOutput = 32 * 1024 * 1024) {
  let ip = 0, op = 0;
  let out = Buffer.alloc(Math.min(Math.max(input.length * 4, 256), maxOutput));
  const reserve = n => {
    if (op + n > maxOutput) throw new Error('LZ4 output limit');
    if (op + n <= out.length) return;
    const next = Buffer.alloc(Math.min(maxOutput, Math.max(op + n, out.length * 2)));
    out.copy(next, 0, 0, op); out = next;
  };
  const length = base => {
    let n = base;
    if (base === 15) {
      let b;
      do {
        if (ip >= input.length) throw new Error('Truncated LZ4 length');
        b = input[ip++]; n += b;
        if (n > maxOutput) throw new Error('LZ4 length limit');
      } while (b === 255);
    }
    return n;
  };
  while (ip < input.length) {
    const token = input[ip++];
    const literals = length(token >>> 4);
    if (ip + literals > input.length) throw new Error('Truncated LZ4 literals');
    reserve(literals); input.copy(out, op, ip, ip + literals); ip += literals; op += literals;
    if (ip === input.length) return out.subarray(0, op);
    if (ip + 2 > input.length) throw new Error('Truncated LZ4 offset');
    const offset = input.readUInt16LE(ip); ip += 2;
    if (!offset || offset > op) throw new Error('Invalid LZ4 offset');
    const match = length(token & 15) + 4;
    reserve(match);
    for (let i = 0; i < match; i++) { out[op] = out[op - offset]; op++; }
  }
  return out.subarray(0, op);
}

// Standards-compliant literal-only block; useful for independent round-trip tests.
function encode(input) {
  const head = [Math.min(input.length, 15) << 4];
  if (input.length >= 15) {
    let n = input.length - 15;
    while (n >= 255) { head.push(255); n -= 255; }
    head.push(n);
  }
  return Buffer.concat([Buffer.from(head), input]);
}

module.exports = { decode, encode };
