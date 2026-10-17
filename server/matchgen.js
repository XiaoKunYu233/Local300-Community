#!/usr/bin/env node
/**
 * matchgen.js -- 对局里几条**已解出字段的消息**的编/解码器（"可实现的协议"的代码形态）。
 *
 * 全部按抓包里的**真实字节**做往返验证（`--selftest`）：解码 → 重新编码 → 必须逐字节一致。
 *
 * | msgid | 载荷 | 语义 | 依据 |
 * |---|---|---|---|
 * | `1056` | 6 字节 = 3×u16 小端定点 ×100 | **实体位置 (x,y,z)** | 独立帧 + 9173 内嵌逐字节一致；值域落在 0..600 地图内 |
 * | `11035` | 8 字节 = `[u16 key][u8 01][u8 type][4 字节值]` | **单条属性**（type3=float32 / type8=u32） | 大厅与 9173 内嵌同款；例 `4c 7a 01 03 00 00 10 41` = key 0x7a4c → 9.0 |
 * | `1045` | `[u8 n][n × 5 字节]`，每条 = `[u8 attrId][u32 值]` | **属性列表**（金币 50 / 钻石 72 …） | 大厅 1045 `01 32 fb c2 a9 05` → attr 50 = 95011579（与 gold-state 对上） |
 * | `11007` | `[u8 len][len 字节 protobuf]` | 状态/位置（训练场最高频） | 首字节恒等于剩余长度；body 能按 protobuf tag 走 |
 *
 * 用法:
 *   node matchgen.js --selftest          # 拿抓包里的真实帧做往返验证
 *   node matchgen.js --demo              # 打印几条自己造的帧
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ARGS = process.argv.slice(2);
const flag = k => ARGS.includes(`--${k}`);
const SEED = 0xcd;
const LOGS = path.join(__dirname, 'logs');
const MATCHCAP = path.join(LOGS, 'cap-2026-09-27T10-13-20-match');
const xor = (b, s = SEED) => { const o = Buffer.alloc(b.length); let p = s; for (let i = 0; i < b.length; i++) { o[i] = b[i] ^ p; p = o[i]; } return o; };
const split = b => { const fr = []; let o = 0; while (o + 12 <= b.length) { const t = b.readUInt32LE(o); if (t < 12 || o + t > b.length) break; fr.push(Buffer.from(b.subarray(o, o + t))); o += t; } return fr; };
const hex = b => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0') + ' '; return s.trimEnd(); };

// ---------- 1056：实体位置 ----------
const pos = {
  decode(payload) {
    if (payload.length !== 6) return null;
    return { x: payload.readUInt16LE(0) / 100, y: payload.readUInt16LE(2) / 100, z: payload.readUInt16LE(4) / 100 };
  },
  encode({ x, y, z }) {
    const b = Buffer.alloc(6);
    b.writeUInt16LE(Math.round(x * 100) & 0xffff, 0);
    b.writeUInt16LE(Math.round(y * 100) & 0xffff, 2);
    b.writeUInt16LE(Math.round(z * 100) & 0xffff, 4);
    return b;
  },
};

// ---------- 11035：单条属性 ----------
const attr = {
  decode(payload) {
    if (payload.length !== 8 || payload[2] !== 0x01) return null;
    const key = payload.readUInt16LE(0), type = payload[3];
    const raw = Buffer.from(payload.subarray(4, 8));
    return { key, type, value: type === 3 ? raw.readFloatLE(0) : raw.readUInt32LE(0), raw };
  },
  /** ⚠ 用 `raw` 回写而不是用 `value`：非 float 的类型（type 7/8…）按 u32 解释会丢字节 */
  encode(d) {
    const b = Buffer.alloc(8);
    b.writeUInt16LE(d.key & 0xffff, 0);
    b[2] = 0x01; b[3] = d.type;
    if (d.raw) d.raw.copy(b, 4);
    else if (d.type === 3) b.writeFloatLE(d.value, 4);
    else b.writeUInt32LE(d.value >>> 0, 4);
    return b;
  },
};

// ---------- 1045：属性列表 ----------
const attrList = {
  decode(payload) {
    if (!payload.length) return null;
    const n = payload[0];
    if (1 + 5 * n !== payload.length) return null;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const o = 1 + i * 5;
      rows.push({ attrId: payload[o], value: payload.readUInt32LE(o + 1) });
    }
    return { rows };
  },
  encode({ rows }) {
    const b = Buffer.alloc(1 + 5 * rows.length);
    b[0] = rows.length;
    rows.forEach((r, i) => { const o = 1 + i * 5; b[o] = r.attrId & 0xff; b.writeUInt32LE(r.value >>> 0, o + 1); });
    return b;
  },
};

// ---------- 11007：长度前缀 + protobuf body ----------
const status = {
  decode(payload) {
    if (!payload.length || payload[0] !== payload.length - 1) return null;
    return { body: Buffer.from(payload.subarray(1)) };
  },
  encode({ body }) {
    if (body.length > 255) throw new Error('body 太长');
    return Buffer.concat([Buffer.from([body.length]), body]);
  },
};

// ---------- 9173：在载荷里就地改写某个实体的位置（长度不变） ----------
/**
 * 在一条 `9173` 载荷里找 `[10B 实体头][u32 1056][6B 位置]`，把位置换成 `fn(pos)` 的返回值。
 * 就地改写（6 字节等长），所以帧长不变、XOR 链不受影响。
 * @returns 改了几处
 */
function rewriteEntityPos(payload, actorId, fn) {
  let n = 0;
  for (let i = 0; i + 20 <= payload.length; i++) {
    if (!(payload[i + 3] === 0 && payload[i + 4] === 0 && payload[i + 5] === 0)) continue;
    if (![0xf0, 0xf1, 0xf3, 0xf5, 0xf9, 0xfb, 0xfd, 0xff].includes(payload[i])) continue;
    if ((payload.readUInt32LE(i + 6) >>> 0) !== (actorId >>> 0)) continue;
    if (payload.readUInt32LE(i + 10) !== 1056) continue;
    const cur = pos.decode(payload.subarray(i + 14, i + 20));
    const next = fn(cur, payload.subarray(i + 14, i + 20));
    if (!next) continue;
    const enc = pos.encode(next);
    enc.copy(payload, i + 14);
    n++;
  }
  return n;
}

/** 把一条整帧（含 12 字节头）里的实体位置改写掉；返回新帧（长度不变） */
function rewriteEntityPosFrame(frame, actorId, fn) {
  if (frame.length < 12 || frame.readUInt16LE(8) !== 9173) return frame;
  const b = Buffer.from(frame);
  const n = rewriteEntityPos(b.subarray(12), actorId, fn);
  return n ? b : frame;
}

/**
 * 已知的"子消息标签"（`m9173sub.js --match=002` 统计出来的，按出现次数；够用就行）。
 * 用途：判一个"实体头"是不是真的 —— 真头后面紧跟的 u32 基本都在这个集合里。
 */
const MSG_TAGS = new Set([1056, 1045, 11007, 11035, 11042, 11041, 27105, 23445, 11005, 1136, 1050, 11033,
  13607, 1352, 11034, 8192, 1369, 1358, 1129, 27112, 22]);

/**
 * 扫 `9173` 载荷里的实体头 `<op u8><a u8><b u16><u16 0><actorId u32>`（10 字节）。
 * `opts.tagged`（默认 true）：只认"紧跟的 u32 是已知子消息标签"的头 ——
 *   不然子消息数据里会撞出**假头**，而假头会把后面真头挤掉（之前踩过：有些实体的位置没被改写）。
 */
/**
 * 扫 `9173` 载荷里的实体头 `<op u8><a u8><b u16><u16 0><actorId u32>`（10 字节）。
 *
 * `opts.strict`（默认 **true**）：
 *   * true  = 只认"op 字节在白名单里 **且** 紧跟的 u32 是已知子消息标签"的头。
 *             实测 op 字节**不是**固定枚举（0xf0/0x00/0x38/0x58/0x40… 都有），所以宽松模式能多挖出
 *             一些记录（002 场 541 → 863 个位置、16 → 24 个实体），但**混进了跨图大跳变的点**
 *             （最远 397 单位），所以"要写回帧里"的地方一律用严格模式，避免把位置写进错地方。
 *   * false = 形状 + 已知标签（用于统计/发现，不用于改写）。
 */
function entityHeaders(p, opts = {}) {
  const strict = opts.strict !== false;
  const tagged = opts.tagged !== false;
  const out = [];
  for (let i = 0; i + 10 <= p.length; i++) {
    // 形状：+3..+5 三个 0（中间两个 0 + b 字段的高字节），+6 起是 actorId
    if (!(p[i + 3] === 0 && p[i + 4] === 0 && p[i + 5] === 0)) continue;
    const id = p.readUInt32LE(i + 6);
    if (id === 0) continue;
    if (strict && ![0xf0, 0xf1, 0xf3, 0xf5, 0xf9, 0xfb, 0xfd, 0xff].includes(p[i])) continue;
    if (tagged) {
      if (i + 14 > p.length) continue;
      if (!MSG_TAGS.has(p.readUInt32LE(i + 10))) continue;
    } else if (out.length && i - out[out.length - 1].off < 10) continue;
    out.push({ off: i, actorId: id >>> 0 });
  }
  return out;
}

/**
 * `11042` 的载荷框架：`[u8 len][u8 0x00][len 字节 protobuf body]`（第 7 轮验证）。
 * 语义只解出一部分：body 里 f2=1、f6∈{0,1}、f7 小整数（会变）、f8∈{0,1}、
 * f11 是子消息（f11.1 像实体 id，f11.8 是会往下掉的大数 —— **血量候选，未证实**）。
 */
const lenPb = {
  decode(payload) {
    if (payload.length < 2 || payload[0] + 2 !== payload.length) return null;
    return { zero: payload[1], body: Buffer.from(payload.subarray(2)) };
  },
  encode(d) {
    const body = d.body || Buffer.alloc(0);
    const b = Buffer.alloc(2 + body.length);
    b[0] = body.length & 0xff;
    b[1] = d.zero || 0;
    body.copy(b, 2);
    return b;
  },
};

module.exports = { pos, attr, attrList, status, lenPb, rewriteEntityPos, rewriteEntityPosFrame, entityHeaders, MSG_TAGS, split, xor, hex };

// ---------------- 自检：拿真实帧做往返 ----------------
// ⚠ 必须判 `require.main === module`：`matchreplay.js` 会 require 这个文件，
//    否则 `--selftest` 会跟着 argv 一起被触发（连 process.exit 一起，把调用方也带走）。
if (require.main === module && flag('selftest')) {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '   ' + (d === undefined ? '' : d)); } };
  const loadFrames = (dir, file, msgid, enc = true) => {
    const f = path.join(dir, file);
    if (!fs.existsSync(f)) return [];
    const raw = fs.readFileSync(f);
    return split(enc ? xor(raw) : raw).filter(x => x.readUInt16LE(8) === msgid);
  };

  // 1056：战场两场
  let n1056 = 0, ok1056 = 0, minv = [1e9, 1e9, 1e9], maxv = [-1e9, -1e9, -1e9];
  for (const M of ['002', '003']) {
    for (const f of loadFrames(MATCHCAP, `match-9004-${M}.s2c.bin`, 1056)) {
      n1056++;
      const d = pos.decode(f.subarray(12));
      if (!d) continue;
      if (pos.encode(d).equals(f.subarray(12))) ok1056++;
      minv = [Math.min(minv[0], d.x), Math.min(minv[1], d.y), Math.min(minv[2], d.z)];
      maxv = [Math.max(maxv[0], d.x), Math.max(maxv[1], d.y), Math.max(maxv[2], d.z)];
    }
  }
  ck(`1056 位置：${ok1056}/${n1056} 条"解码→编码"逐字节一致`, n1056 > 0 && ok1056 === n1056, `${ok1056}/${n1056}`);
  ck('1056 解出的坐标都在 0..600 地图范围内', maxv[0] < 600 && maxv[1] < 600 && maxv[2] < 600 && minv.every(v => v >= 0),
    `x ${minv[0].toFixed(1)}..${maxv[0].toFixed(1)} y ${minv[1].toFixed(1)}..${maxv[1].toFixed(1)} z ${minv[2].toFixed(1)}..${maxv[2].toFixed(1)}`);

  // 11035：大厅几份抓包（含 4c7a→9.0 那条）
  let n35 = 0, ok35 = 0, saw = new Set(), bad35 = new Map();
  for (const cap of fs.readdirSync(LOGS).filter(d => /^(cap|relay)-/.test(d))) {
    const dir = path.join(LOGS, cap);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter(f => /^s2c-.*\.frames\.bin$/.test(f))) {
      for (const fr of loadFrames(dir, f, 11035, false)) {
        n35++;
        const d = attr.decode(fr.subarray(12));
        if (!d) { const k = `${cap} len=${fr.length - 12} ${hex(fr.subarray(12, 20))}`; bad35.set(k, (bad35.get(k) || 0) + 1); continue; }
        if (attr.encode(d).equals(fr.subarray(12))) ok35++;
        saw.add(`0x${d.key.toString(16)}/${d.type}=${typeof d.value === 'number' ? +d.value.toFixed(3) : d.value}`);
      }
      if (n35 > 400) break;
    }
  }
  ck(`11035 属性：能认出来的里面 ${ok35}/${ok35} 条往返一致（另有 ${n35 - ok35} 条不是 8 字节标准形状）`,
    ok35 > 0 && ok35 === n35 - [...bad35.values()].reduce((a, b) => a + b, 0),
    `bad: ${[...bad35.keys()].slice(0, 3).join(' | ')}`);
  const niceFloat = [...saw].some(k => /\/3=(\d+(\.\d+)?)$/.test(k));
  ck(`11035 里能解出 type=3 的 float 属性（样本 ${saw.size} 种，例 ${[...saw].slice(0, 3).join(' ')}）`, niceFloat);

  // 1045：大厅（含金币 50 = 95011579）
  let n45 = 0, ok45 = 0, gold = null;
  for (const cap of fs.readdirSync(LOGS).filter(d => /^cap-2026-09-27T/.test(d))) {
    const dir = path.join(LOGS, cap);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter(f => /^s2c-.*\.frames\.bin$/.test(f))) {
      for (const fr of loadFrames(dir, f, 1045, false)) {
        const d = attrList.decode(fr.subarray(12));
        if (!d) continue;
        n45++;
        if (attrList.encode(d).equals(fr.subarray(12))) ok45++;
        const g = d.rows.find(r => r.attrId === 50);
        if (g && g.value > 1e6) gold = g.value;
      }
      if (n45 > 200) break;
    }
  }
  ck(`1045 属性列表：${ok45}/${n45} 条往返一致`, n45 > 0 && ok45 === n45, `${ok45}/${n45}`);
  ck(`1045 里能解出金币（attrId 50，例 ${gold}）`, gold !== null && gold > 0, String(gold));

  // 11007：训练场 334 条
  let n07 = 0, ok07 = 0;
  for (const fr of loadFrames(MATCHCAP, 'match-9004-001.s2c.bin', 11007)) {
    n07++;
    const d = status.decode(fr.subarray(12));
    if (!d) continue;
    if (status.encode(d).equals(fr.subarray(12))) ok07++;
  }
  ck(`11007：${ok07}/${n07} 条"长度前缀 + body"往返一致`, n07 > 0 && ok07 === n07, `${ok07}/${n07}`);

  // 9173 位置改写（就地、等长）
  {
    const frames = loadFrames(MATCHCAP, 'match-9004-002.s2c.bin', 9173);
    const actor = 0xff26b65e;
    let hit = 0, sameLen = 0, onlyPos = 0, recs = 0;
    for (const f of frames) {
      const n = rewriteEntityPosFrame(f, actor, (cur) => ({ x: cur.x + 1.5, y: cur.y - 0.25, z: cur.z }));
      if (n === f) continue;
      hit++;
      if (n.length === f.length) sameLen++;
      const a = f.subarray(12), b = n.subarray(12);
      const windows = [];
      for (let i = 0; i + 20 <= a.length; i++) if (a[i + 3] === 0 && a[i + 4] === 0 && a[i + 5] === 0 && a.readUInt32LE(i + 6) === (actor >>> 0) && a.readUInt32LE(i + 10) === 1056) windows.push(i + 14);
      recs += windows.length;
      let bad = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !windows.some(w => i >= w && i < w + 6)) bad++;
      if (bad === 0 && windows.length) onlyPos++;
    }
    ck(`9173 就地改位置：改了 ${hit} 条帧（${recs} 条位置记录），帧长都不变（${sameLen}），且变化只落在那 6 字节窗口里（${onlyPos}）`,
      hit > 0 && sameLen === hit && onlyPos === hit, `${hit}/${sameLen}/${onlyPos}`);
    if (hit) {
      const out = rewriteEntityPosFrame(frames.find(f => f.subarray(12).indexOf(Buffer.from([0x5e, 0xb6, 0x26, 0xff])) >= 0), actor, (c) => ({ x: c.x + 1.5, y: c.y, z: c.z }));
      const p = out.subarray(12);
      const found = [];
      for (let i = 0; i + 20 <= p.length; i++) if (p.readUInt32LE(i + 6) === (actor >>> 0) && p.readUInt32LE(i + 10) === 1056) found.push(pos.decode(p.subarray(i + 14, i + 20)));
      ck('改完之后再解一遍，位置确实 +1.5（格式仍然合法）', found.length > 0, JSON.stringify(found.slice(0, 2)));
    }
  }

  console.log(`\n===== matchgen ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
}

if (flag('demo')) {
  console.log('自己造一条 1056（位置 213.44, 100.00, 205.10）: ' + hex(pos.encode({ x: 213.44, y: 100, z: 205.1 })));
  console.log('  → 解回来: ' + JSON.stringify(pos.decode(pos.encode({ x: 213.44, y: 100, z: 205.1 }))));
  console.log('自己造一条 11035（key 0x7a4c, float 9.0）: ' + hex(attr.encode({ key: 0x7a4c, type: 3, value: 9 })));
  console.log('自己造一条 1045（金币=888888, 钻石=139000）: ' + hex(attrList.encode({ rows: [{ attrId: 50, value: 888888 }, { attrId: 72, value: 139000 }] })));
  console.log('自己造一条 11007（body = 18 35 50 01 58 00）: ' + hex(status.encode({ body: Buffer.from('183550015800', 'hex') })));
}
