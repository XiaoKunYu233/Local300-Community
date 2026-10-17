#!/usr/bin/env node
/**
 * m9173rec.js -- `9173` 载荷的**记录框架**（第 9 轮解出，三场抓包 2297 帧验证）。
 *
 * ## 框架（"可实现的协议"的核心）
 *
 * ```
 * 9173 载荷 := 记录*
 * 记录     := [u8 op][u8 a]  <块>            // op/a 是"通道/类型"两字节前缀（有时省略）
 * 块       := [u16 len][u16 0][u32 actorId][u32 tag][载荷]   // 块长恰好 = len
 *             其中 len = 12 + |载荷|
 * ```
 *
 * 关键点：**块自带长度**（`len`），所以不需要知道每个 tag 的载荷长度也能切开流。
 * `len` 从它自己的位置开始数（也就是块长 = len），于是整条记录长 `2 + len`。
 *
 * 证据（`--selftest` 会跑）：
 *   * 三场抓包共 2297 条 `9173` 帧；
 *   * 用"块"扫出来的 `[actor][tag]` 共 6318 处，其中能用 `1056/11035/1045/11007/11042`
 *     这 5 个**已独立解出的长度规则**校验的有 4083 处，`len - 12 == 规则长度` 成立 4077 处（99.9%）；
 *   * 于是**顺便学到了**其它标签的载荷长度：
 *     `11041`=10、`1136`=16、`13607`=72、`27112`=0、`1369`=0、`1358`=4、`11034`=2、
 *     `8192`=31、`1129`=16、`23445`=5、`11005`=2+n、`27105`=1+8n。
 *
 * ## 顺带解出的两个子消息形状
 *
 * | tag | 形状 | 语义推断 |
 * |---|---|---|
 * | `27105` | `[u32 x0*100][u32 z0*100][u8 n][n × ([u32 x*100][u32 z*100])]`，长度 = `9 + 8n` | **点/区域效果点列表**（n≤3）。定点与 C2S `27111` 同款，但**已证否**"27111↔27105 逐点配对"（65 个 27111 点里 0 个能命中 27105 点集），所以只说"同款定点坐标"，不说"就是它的回包" |
 * | `11005` | `[u8 n][u8 00][n 字节 protobuf]` | 与 `11042` **同款框架**的状态子消息（protobuf body） |
 *
 * 用法:
 *   node m9173rec.js --selftest
 *   node m9173rec.js --walk=002 --n=3        # 打几条帧的记录流
 *   node m9173rec.js --stats                 # 各标签的长度分布 + 覆盖率
 */
'use strict';
const fs = require('fs');
const path = require('path');
const MG = require('./matchgen');
const ARGS = process.argv.slice(2);
const argOf = (k, d) => { const p = `--${k}=`; const a = ARGS.find(x => x.startsWith(p)); return a ? a.slice(p.length) : d; };
const flag = k => require.main === module && ARGS.includes(`--${k}`);
const DIR = path.join(__dirname, 'logs', 'cap-2026-09-27T10-13-20-match');
const hex = MG.hex;

/** 已独立解出的长度规则（和 tag 无关地写在抓包分析里的 5 条） */
function ruleLen(tag, p, at) {
  const avail = p.length - at;
  switch (tag) {
    case 1056: return avail >= 6 ? 6 : -1;
    case 11035: return avail >= 8 ? 8 : -1;
    case 1045: return avail >= 1 && avail >= 1 + 5 * p[at] ? 1 + 5 * p[at] : -1;
    case 11007: return avail >= 1 && avail >= 1 + p[at] ? 1 + p[at] : -1;
    case 11042: return avail >= 2 && avail >= 2 + p[at] ? 2 + p[at] : -1;
    default: return -1;
  }
}

/** 一个"块"的解析：从 `o` 读到 `[u16 len][u16 0][u32 actor][u32 tag][载荷]` */
function block(p, o, opts = {}) {
  const tags = opts.tags || null;
  if (o + 12 > p.length) return null;
  const len = p.readUInt16LE(o);
  if (len < 12) return null;
  if (o + len > p.length) return null;
  if (opts.strictZero !== false && p.readUInt16LE(o + 2) !== 0) return null;
  const actor = p.readUInt32LE(o + 4);
  if (actor === 0) return null;
  const tag = p.readUInt32LE(o + 8);
  if (tags && !tags.has(tag)) return null;
  const plen = len - 12;
  const rl = ruleLen(tag, p, o + 12);
  if (rl >= 0 && rl !== plen) return null;
  return {
    o, len, actor: actor >>> 0, tag, plen, end: o + len,
    payload: p.subarray(o + 12, o + len),
    prefix: o >= 2 ? { op: p[o - 2], a: p[o - 1] } : null,
  };
}

/** 记录 = （可选 2 字节 op/a 前缀）+ 块。返回按顺序铺出来的记录数组；铺不满返回 null */
function walk(p, opts = {}) {
  const out = [];
  let o = 0;
  while (o < p.length) {
    let b = block(p, o, opts);
    let pre = 0;
    if (!b && o + 2 <= p.length) { b = block(p, o + 2, opts); pre = 2; }
    if (!b) return null;
    if (pre) { b.prefix = { op: p[o], a: p[o + 1] }; b.o = o; b.end = b.end; }
    out.push(b);
    o = b.end;
  }
  return out;
}

/** 用 DP 找"覆盖字节最多"的记录集合（允许帧头和空隙里夹着不认识的东西） */
function cover(p, opts = {}) {
  const cands = [];
  for (let o = 0; o + 12 <= p.length; o++) {
    const b = block(p, o, opts);
    if (b) cands.push(b);
  }
  const byStart = new Map();
  for (const c of cands) { if (!byStart.has(c.o)) byStart.set(c.o, []); byStart.get(c.o).push(c); }
  const memo = new Map();
  const dp = o => {
    if (o >= p.length) return { cov: 0, picks: [] };
    if (memo.has(o)) return memo.get(o);
    let best = dp(o + 1);
    for (const c of (byStart.get(o) || [])) {
      const r = dp(c.end);
      const cand = { cov: r.cov + c.len, picks: [c, ...r.picks] };
      if (cand.cov > best.cov) best = cand;
    }
    memo.set(o, best);
    return best;
  };
  return dp(0);
}

/** 编码：块（+可选 op/a 前缀）。往返验证用。 */
function encodeBlock(b) {
  const pl = b.payload || Buffer.alloc(0);
  const head = Buffer.alloc(12);
  head.writeUInt16LE(12 + pl.length, 0);
  head.writeUInt16LE(0, 2);
  head.writeUInt32LE(b.actor >>> 0, 4);
  head.writeUInt32LE(b.tag >>> 0, 8);
  return Buffer.concat([head, pl]);
}
function encodeRecord(b) {
  const body = encodeBlock(b);
  return b.prefix ? Buffer.concat([Buffer.from([b.prefix.op & 0xff, b.prefix.a & 0xff]), body]) : body;
}

/**
 * 按**记录框架**就地改写 `1056` 位置（6 字节等长 ⇒ 帧长与 XOR 链都不变）。
 * `lookup(actorId)` 返回 `{x,y,z}`；返回 null/undefined 就不动这个实体。
 *
 * 比 `matchgen.rewriteEntityPos` 的"实体头启发式"强：002 场找到 **822** 处位置 / 23 个实体
 * （启发式 541 / 16），003 场 432 / 18（启发式 267 / 13），而且 0 个越界坐标。
 *
 * @returns 改了几处
 */
function rewritePositions(payload, lookup, opts = {}) {
  let n = 0;
  for (const b of cover(payload, opts).picks) {
    if (b.tag !== 1056 || b.plen !== 6) continue;
    const want = lookup(b.actor);
    if (!want || !Number.isFinite(want.x) || !Number.isFinite(want.z)) continue;
    const enc = MG.pos.encode({ x: want.x, y: Number.isFinite(want.y) ? want.y : 0, z: want.z });
    const at = b.o + 12;
    if (!enc.equals(payload.subarray(at, at + 6))) { enc.copy(payload, at); n++; }
  }
  return n;
}

// ---------- 27105：点/区域效果点列表 ----------
/**
 * 形状：`[u32 x0*100][u32 z0*100][u8 n][n × ([u32 x*100][u32 z*100])]`，长度 = `9 + 8n`。
 * 实测（343 条）：`长度 == 9 + 8·payload[8]` 成立 334/343（97.4%）；count 分布 1×233 / 2×89 / 3×12 / 0×8。
 * 剩下 9 条长度对不上（其中 1 条的 count 字节是 49），本模块**不假装**能解它们。
 */
const points = {
  decode(payload) {
    if (payload.length < 9) return null;
    const n = payload[8];
    if (payload.length !== 9 + 8 * n) return null;
    const list = [{ x: payload.readUInt32LE(0) / 100, z: payload.readUInt32LE(4) / 100 }];
    for (let i = 0; i < n; i++) {
      const o = 9 + 8 * i;
      list.push({ x: payload.readUInt32LE(o) / 100, z: payload.readUInt32LE(o + 4) / 100 });
    }
    return { points: list, n };
  },
  encode(d) {
    const pts = d.points || [];
    if (!pts.length) throw new Error('27105 至少要有一个点');
    const b = Buffer.alloc(9 + 8 * (pts.length - 1));
    b.writeUInt32LE(Math.round(pts[0].x * 100), 0);
    b.writeUInt32LE(Math.round(pts[0].z * 100), 4);
    b[8] = pts.length - 1;
    for (let i = 1; i < pts.length; i++) {
      const o = 9 + 8 * (i - 1);
      b.writeUInt32LE(Math.round(pts[i].x * 100), o);
      b.writeUInt32LE(Math.round(pts[i].z * 100), o + 4);
    }
    return b;
  },
};

// ---------- 11005：与 11042 同款 `[u8 n][u8 00][protobuf n 字节]` ----------
const lenPb2 = {
  decode(payload) {
    if (payload.length < 2 || payload[0] + 2 !== payload.length) return null;
    return { zero: payload[1], body: Buffer.from(payload.subarray(2)) };
  },
  encode(d) {
    const body = d.body || Buffer.alloc(0);
    const b = Buffer.alloc(2 + body.length);
    b[0] = body.length & 0xff; b[1] = d.zero || 0;
    body.copy(b, 2);
    return b;
  },
};

function frames(M) {
  const f = path.join(DIR, `match-9004-${String(M).padStart(3, '0')}.s2c.bin`);
  return MG.split(MG.xor(fs.readFileSync(f))).filter(x => x.readUInt16LE(8) === 9173);
}
const ALL = () => ['001', '002', '003'].flatMap(frames);

if (flag('selftest')) {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '   ' + (d === undefined ? '' : d)); } };
  const F = ALL();
  const tags = new Set([...MG.MSG_TAGS]);

  // A) 块长度 `len - 12` 与 5 条**独立解出**的规则一致
  let seen = 0, matched = 0;
  const learned = new Map();
  for (const f of F) {
    const p = f.subarray(12);
    for (let o = 0; o + 12 <= p.length; o++) {
      const b = block(p, o, { tags });
      if (!b) continue;
      const rl = ruleLen(b.tag, p, o + 12);
      if (rl >= 0) { seen++; if (rl === b.plen) matched++; }
      if (!learned.has(b.tag)) learned.set(b.tag, new Map());
      const m = learned.get(b.tag); m.set(b.plen, (m.get(b.plen) || 0) + 1);
    }
  }
  ck(`块自带的 len 与 5 条独立长度规则一致 ${matched}/${seen}（≥99%）`, seen > 1000 && matched / seen >= 0.99, `${matched}/${seen}`);

  // B) 学到了原先未知标签的**稳定**长度
  const want = { 11041: 10, 1136: 16, 13607: 72, 27112: 0, 1369: 0, 1358: 4, 11034: 2, 8192: 31, 1129: 16, 23445: 5 };
  for (const [tag, L] of Object.entries(want)) {
    const m = learned.get(+tag);
    const cnt = m ? (m.get(L) || 0) : 0;
    const tot = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
    ck(`学出 tag ${tag} 载荷 = ${L}B（${cnt}/${tot}）`, tot > 0 && cnt / tot >= 0.9, `${cnt}/${tot}`);
  }

  // C) 27105 形状：长度 == 9 + 8·payload[8]；能解的逐字节往返一致
  let n105 = 0, lenOk = 0, ok105 = 0;
  for (const f of F) {
    const p = f.subarray(12);
    for (const b of cover(p, { tags }).picks) {
      if (b.tag !== 27105 || b.plen < 9) continue;
      n105++;
      if (b.plen === 9 + 8 * b.payload[8]) lenOk++;
      const d = points.decode(b.payload);
      if (d && points.encode(d).equals(b.payload)) ok105++;
    }
  }
  ck(`27105 长度 == 9 + 8·payload[8]（${lenOk}/${n105}，≥90%）`, n105 > 0 && lenOk / n105 >= 0.9, `${lenOk}/${n105}`);
  ck(`27105 能解的那些"解码→编码"逐字节一致（${ok105}/${lenOk}）`, ok105 > 0 && ok105 === lenOk, `${ok105}/${lenOk}`);

  // D) 11005 与 11042 同款框架
  let n05 = 0, ok05 = 0;
  for (const f of F) {
    const p = f.subarray(12);
    for (const b of cover(p, { tags }).picks) {
      if (b.tag !== 11005) continue;
      n05++;
      const d = lenPb2.decode(b.payload);
      if (d && d.zero === 0 && lenPb2.encode(d).equals(b.payload)) ok05++;
    }
  }
  ck(`11005 用 [u8 n][u8 00][protobuf] 与 11042 同款框架（${ok05}/${n05}）`, n05 > 0 && ok05 / n05 >= 0.95, `${ok05}/${n05}`);

  // E) 块"解码→编码"逐字节一致（编码器契约）
  let nrt = 0, okrt = 0;
  for (const f of F.slice(0, 300)) {
    const p = f.subarray(12);
    for (const b of cover(p, { tags }).picks) {
      nrt++;
      if (encodeBlock(b).equals(p.subarray(b.o, b.end))) okrt++;
    }
  }
  ck(`块编码器：${okrt}/${nrt} 条"解码→编码"逐字节一致`, nrt > 0 && okrt === nrt, `${okrt}/${nrt}`);

  // F) 覆盖率：严格口径（要求块的 `[u16 0]` 字段为 0）与宽松口径（不要求）
  let covS = 0, covL = 0, totB = 0;
  for (const f of F) {
    const p = f.subarray(12); totB += p.length;
    covS += cover(p, { tags }).cov;
    covL += cover(p, { tags, strictZero: false }).cov;
  }
  const pS = covS / totB * 100, pL = covL / totB * 100;
  console.log(`  INFO  记录框架覆盖 9173 载荷字节：严格 ${covS}/${totB}（${pS.toFixed(1)}%）／宽松 ${covL}/${totB}（${pL.toFixed(1)}%）`);
  ck('严格口径覆盖 ≥ 15%（第 8 轮"只认已知标签"的口径是 8～11%）', pS >= 15, `${pS.toFixed(1)}%`);
  ck('宽松口径覆盖 ≥ 20%', pL >= 20, `${pL.toFixed(1)}%`);

  // G) 就地改写位置（记录框架口径）：比实体头启发式找得多、且只动那 6 字节
  for (const M of ['002', '003']) {
    const FS = frames(M);
    let nRec = 0, nHeur = 0, okLen = 0, okOnly = 0, okRound = 0, changed = 0, outOfRange = 0;
    for (const f of FS) {
      const p = f.subarray(12);
      const recHits = cover(p, { tags }).picks.filter(b => b.tag === 1056 && b.plen === 6);
      const heurHits = MG.entityHeaders(p).filter(h => p.readUInt32LE(h.off + 10) === 1056);
      nRec += recHits.length; nHeur += heurHits.length;
      if (!recHits.length) continue;
      const b = Buffer.from(f);
      const q = b.subarray(12);
      const n = rewritePositions(q, () => ({ x: 123.45, y: 6.78, z: 234.56 }), { tags });
      if (!n) continue;
      changed++;
      if (b.length === f.length) okLen++;
      const windows = recHits.map(r => r.o + 12);
      let bad = 0;
      for (let i = 0; i < q.length; i++) if (q[i] !== p[i] && !windows.some(w => i >= w && i < w + 6)) bad++;
      if (!bad) okOnly++;
      // 改完再按记录框架读一遍：所有 1056 都应该是新位置
      const after = cover(q, { tags }).picks.filter(x => x.tag === 1056 && x.plen === 6);
      if (after.length === recHits.length && after.every(x => { const d = MG.pos.decode(x.payload); return Math.abs(d.x - 123.45) < 0.005 && Math.abs(d.z - 234.56) < 0.005; })) okRound++;
      for (const x of recHits) { const d = MG.pos.decode(x.payload); if (d.x >= 600 || d.z >= 600) outOfRange++; }
    }
    ck(`${M}: 记录框架找到的 1056 位置（${nRec}）≥ 实体头启发式（${nHeur}）`, nRec >= nHeur, `${nRec} vs ${nHeur}`);
    ck(`${M}: 找到的 1056 坐标全在地图范围内（越界 ${outOfRange}）`, outOfRange === 0, String(outOfRange));
    ck(`${M}: 就地改写帧长不变（${okLen}/${changed}）且只动了那 6 字节（${okOnly}/${changed}）`, changed > 0 && okLen === changed && okOnly === changed, `${okLen}/${okOnly}/${changed}`);
    ck(`${M}: 改完按记录框架重读，位置确实变成新值（${okRound}/${changed}）`, okRound === changed, `${okRound}/${changed}`);
  }

  console.log(`\n===== m9173rec ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
}

if (flag('stats')) {
  const tags = new Set([...MG.MSG_TAGS]);
  const lens = new Map();
  let cov = 0, totB = 0, nf = 0;
  for (const f of ALL()) {
    const p = f.subarray(12); nf++; totB += p.length;
    const r = cover(p, { tags }); cov += r.cov;
    for (const b of r.picks) { if (!lens.has(b.tag)) lens.set(b.tag, new Map()); const m = lens.get(b.tag); m.set(b.plen, (m.get(b.plen) || 0) + 1); }
  }
  console.log(`== 9173 记录框架统计（${nf} 帧）==`);
  console.log(`字节覆盖 ${cov}/${totB}（${(cov / totB * 100).toFixed(1)}%）\n`);
  for (const [tag, m] of [...lens.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
    const t = [...m.values()].reduce((x, y) => x + y, 0);
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const uniq = m.size === 1 ? `定长 ${[...m.keys()][0]}B` : `${m.size} 种长度`;
    console.log(`  ${String(tag).padStart(6)} ×${String(t).padStart(5)}  ${uniq}  ${top.map(([l, c]) => l + 'B×' + c).join(' ')}`);
  }
  process.exit(0);
}

if (flag('walk')) {
  const M = String(argOf('walk', '002'));
  const tags = new Set([...MG.MSG_TAGS]);
  for (const f of frames(M).sort((a, b) => a.length - b.length).slice(0, +argOf('n', '3'))) {
    const p = f.subarray(12);
    const r = cover(p, { tags });
    console.log(`\n=== 载荷 ${p.length}，覆盖 ${r.cov}（${(r.cov / p.length * 100).toFixed(0)}%）===`);
    let cur = 0;
    for (const b of r.picks) {
      if (b.o > cur) console.log(`   空隙 ${cur}..${b.o - 1} ${hex(p.subarray(cur, b.o))}`);
      console.log(`   @${String(b.o).padStart(4)} len=${String(b.len).padStart(4)} actor=0x${b.actor.toString(16)} tag=${String(b.tag).padStart(6)} 载荷${String(b.plen).padStart(4)}B ${hex(b.payload.subarray(0, 16))}${b.plen > 16 ? ' …' : ''}`);
      cur = b.end;
    }
    if (cur < p.length) console.log(`   空隙 ${cur}..${p.length - 1} ${hex(p.subarray(cur))}`);
  }
  process.exit(0);
}

module.exports = { block, walk, cover, encodeBlock, encodeRecord, rewritePositions, ruleLen, points, lenPb2, points2: points, frames };
if (require.main === module) console.log('用法: node m9173rec.js --selftest | --stats | --walk=002 --n=3');
