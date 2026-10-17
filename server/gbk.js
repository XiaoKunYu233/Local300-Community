#!/usr/bin/env node
/**
 * gbk.js -- 纯 Node 的 GBK 编解码（Node 自带 TextEncoder 只有 UTF-8，没法编 GBK 中文）
 *
 * 解码：TextDecoder('gbk')（Node 自带 ICU 支持）
 * 编码：把 GBK 的两字节空间（首字节 0x81..0xFE、次字节 0x40..0xFE）**反过来扫一遍**建表，
 *       只建一次，之后 O(1) 查表。自检：`node gbk.js "任务: 回路装备"` 会打出字节并与真服样本比对。
 */
'use strict';
const dec = new TextDecoder('gbk');

let ENC = null;
function buildTable() {
  ENC = new Map();
  for (let b1 = 0x81; b1 <= 0xfe; b1++) {
    for (let b2 = 0x40; b2 <= 0xfe; b2++) {
      if (b2 === 0x7f) continue;
      const s = dec.decode(Buffer.from([b1, b2]));
      if (s.length === 1 && s !== '\ufffd' && !ENC.has(s)) ENC.set(s, Buffer.from([b1, b2]));
    }
  }
  return ENC;
}
/** 字符串 → GBK Buffer（ASCII 原样单字节） */
function encode(str) {
  if (!ENC) buildTable();
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { out.push(Buffer.from([c])); continue; }
    const b = ENC.get(ch);
    if (b) out.push(b);
    else out.push(Buffer.from([0x3f]));      // 编不出来就 '?'
  }
  return Buffer.concat(out);
}
module.exports = { encode, decode: b => dec.decode(b) };

if (require.main === module) {
  const s = process.argv[2] || '任务: 回路装备';
  const b = encode(s);
  console.log(`"${s}" → ${b.toString('hex')}  （解回来："${dec.decode(b)}"）`);
  // 真服样本里的标题字节（cap-2026-09-27T02-56-55，邮件 0x132d5230）
  const REAL = 'c8cecef13a20bbb8c2b7d7b0b1b820';
  console.log(`真服样本         ${REAL}`);
  console.log(b.toString('hex') === REAL ? '✅ 与真服样本逐字节一致' : '⚠ 与样本不一致（样本可能带尾随空格）');
}
