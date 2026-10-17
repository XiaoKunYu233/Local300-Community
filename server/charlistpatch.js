#!/usr/bin/env node
/* Native character-list account adapter. */
'use strict';
const fs = require('fs');
const path = require('path');
const rd = require('./roledata');

const NAME_OFF = 21;    // **帧**偏移（= 12 字节头 + 载荷 9）：ASCII 账号名起始（紧接 4 字节 UID）
const UID_OFF = 17;     // **帧**偏移（= 载荷 +5）：登录账号 UID（u32 LE）

/** 取出 1287 里的账号名；认不出返回 null */
function readAccount(frame) {
  if (!frame || frame.length < 40 || frame.readUInt16LE(8) !== 1287) return null;
  let e = NAME_OFF;
  while (e < frame.length && frame[e] !== 0) e++;
  const s = frame.subarray(NAME_OFF, e).toString('latin1');
  return /^[A-Za-z0-9_.\-]{2,39}$/.test(s) ? s : null;
}

/** 取出 1287 里的账号 UID；认不出返回 null */
function readUid(frame) {
  if (!frame || frame.length < 24 || frame.readUInt16LE(8) !== 1287) return null;
  return frame.readUInt32LE(UID_OFF) >>> 0;
}

/**
 * 找出账号名在**载荷**里的位置（返回 {start, end, uid}，start/end 是载荷偏移，end 不含结尾 NUL）。
 * 布局：载荷 +0..1 = 0，+2 = 角色数，+3..4 = ?，+5..8 = UID，+9 起 = NUL 结尾的 ASCII 账号名。
 * 认不出返回 null。`capsession.js` 用它分会话。
 */
function findAccountSpan(frame) {
  const p = frame.subarray(12);
  if (p.length < 16) return null;
  let e = 9;
  while (e < p.length && p[e] !== 0) e++;
  const s = p.subarray(9, e).toString('latin1');
  if (!/^[A-Za-z0-9_.\-]{2,39}$/.test(s)) return null;
  return { start: 9, end: e, uid: p.readUInt32LE(5) >>> 0, account: s };
}

/** 把 1287 里的账号名换成 account（长度可以不同，帧总长字段一起改）；uid 给了就一起换 */
function patchCharlist(frame, account, uid) {
  const cur = readAccount(frame);
  let out = frame;
  if (cur !== null && cur !== account) {
    let e = NAME_OFF; while (e < frame.length && frame[e] !== 0) e++;
    const nb = Buffer.from(account, 'latin1');
    out = Buffer.concat([frame.subarray(0, NAME_OFF), nb, Buffer.from([0]), frame.subarray(e + 1)]);
    out.writeUInt32LE(out.length, 0);
  } else if (cur === null) {
    return frame;                                  // 认不出账号名就整条原样发，不要瞎改
  }
  if (uid !== undefined && uid !== null && out.length >= UID_OFF + 4) {
    const want = typeof uid === 'string' ? parseInt(uid.replace(/^0x/, ''), 16) : (uid >>> 0);
    if (Number.isFinite(want) && (out.readUInt32LE(UID_OFF) >>> 0) !== (want >>> 0)) {
      out = Buffer.from(out);                      // 别改到共享的录制缓冲
      out.writeUInt32LE(want >>> 0, UID_OFF);
    }
  }
  return out;
}

module.exports = { patchCharlist, readAccount, readUid, findAccountSpan, NAME_OFF, UID_OFF };

if (require.main === module) {
  const files = [
    ['A(-006)', 'logs/relay-2026-09-26T19-03-20-30000-006.s2c.bin'],
    ['B(18-40-12)', 'logs/relay-2026-09-26T18-40-12-30000-002.s2c.bin'],
    ['C(20-22-26)', 'logs/cap-2026-09-26T20-22-26/s2c-30001-002.frames.bin'],
    ['D(19-43-21)', 'logs/cap-2026-09-26T19-43-21/s2c-30000-001.frames.bin'],
  ];
  let bad = 0, good = 0;
  const ck = (name, ok, detail) => { if (ok) { good++; console.log('  PASS  ' + name); } else { bad++; console.log('  FAIL  ' + name + '   ' + (detail === undefined ? '' : detail)); } };
  for (const [tag, rel] of files) {
    const raw = fs.readFileSync(path.join(__dirname, rel));
    let fr = rd.split(raw); if (fr.length < 5) fr = rd.split(rd.decodeXor(raw));
    const f = fr.find(x => x.readUInt16LE(8) === 1287);
    if (!f) { console.log(`${tag}: 没有 1287`); continue; }
    const cur = readAccount(f);
    const uid = readUid(f);
    const p = patchCharlist(f, 'yzlyzl2836425191', 0x0E81665C);
    const okUid = p.readUInt32LE(UID_OFF) === 0x0E81665C;
    const okName = readAccount(p) === 'yzlyzl2836425191';
    const okLen = p.readUInt32LE(0) === p.length;
    // 除名字区段和 UID 外，其余字节必须一模一样
    let same = true;
    const tailA = f.subarray(NAME_OFF + cur.length + 1), tailB = p.subarray(NAME_OFF + 'yzlyzl2836425191'.length + 1);
    if (tailA.length !== tailB.length || !tailA.equals(tailB)) same = false;
    const headSame = f.subarray(4, UID_OFF).equals(p.subarray(4, UID_OFF))
      && f.subarray(UID_OFF + 4, NAME_OFF).equals(p.subarray(UID_OFF + 4, NAME_OFF));   // 跳过 u32 总长和 UID
    ck(`${tag} 换账号+UID：名字 ${okName ? 'OK' : '!!'} UID ${okUid ? 'OK' : '!!'} 总长 ${okLen ? 'OK' : '!!'} 其余字节 ${same && headSame ? '一致' : '!!不一致'}`,
      okUid && okName && okLen && same && headSame,
      `原名 "${cur}" UID 0x${(uid >>> 0).toString(16)} -> 换账号+UID 后`);
  }
  // 只有名字要换（UID 未知）时，UID 必须原样不动
  {
    const raw = fs.readFileSync(path.join(__dirname, files[0][1]));
    const f = rd.split(rd.decodeXor(raw)).find(x => x.readUInt16LE(8) === 1287);
    if (f) {
      const uid = readUid(f);
      const p = patchCharlist(f, 'abc12345');
      ck('只换名字（UID 未知）时 UID 不变、名字已换、总长正确',
        readUid(p) === uid && readAccount(p) === 'abc12345' && p.readUInt32LE(0) === p.length,
        `UID ${readUid(p) === uid ? 'OK' : '!!变了'} 名字 ${readAccount(p) === 'abc12345' ? 'OK' : '!!'}`);
    }
  }
  console.log(`\n===== charlistpatch ${good} passed, ${bad} failed =====`);
  process.exit(bad ? 1 : 0);
}
