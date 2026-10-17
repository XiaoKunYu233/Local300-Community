#!/usr/bin/env node
/**
 * bag.js -- 背包消息的编解码（按结构生成，不再是回放）
 *
 * 已解出的格式（见 MSGFMT.md，实证来自 cap-2026-09-26T19-49-39）：
 *
 *   msgid 11523  背包道具数量表
 *     全量: u32 n | n × { u32 道具ID, u32 数量 }        （实测 449 条 = 3596 字节载荷）
 *     增量: n = 1 的同一种格式                          （实测 24 字节帧）
 *
 *   msgid 17002  按格子查询道具        u8 0 | u16 格子号 | u32 0xFFFFFFFF | u16 0
 *   msgid 17019  查询应答              u8 0 | u16 道具ID | u16 格子号 | u32 0xFFFFFFFF | u32 0
 *   msgid 17015  查询应答(精简)        u16 0x010F | u16 道具ID | u16 1
 *   msgid 17004  单件详情：6B头(u8未知,u8种类,u32数量=1) + 493B记录
 *                 记录：u8来源容器 | u16物理槽 | 490B完整物品实例
 *
 * 用法:
 *   node bag.js --test                     自测（构造 -> 解析 -> 比对）
 *   node bag.js --dump <cap目录>           从抓包里解出背包内容并打印
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MSG_BAG = 11523, MSG_REQ_SLOT = 17002, MSG_SLOT_ACK = 17019, MSG_SLOT_HINT = 17015, MSG_SLOT_DETAIL = 17004;
const SEED = 0xcd;

// ---------- 帧头 ----------
function mkFrame(msgid, payload, { flags = 0, stream = 0 } = {}) {
  const b = Buffer.alloc(12 + payload.length);
  b.writeUInt32LE(b.length, 0);
  b.writeUInt32LE(stream >>> 0, 4);
  b.writeUInt16LE(msgid, 8);
  b.writeUInt16LE(flags, 10);
  payload.copy(b, 12);
  return b;
}

// ---------- 11523 背包 ----------
/** @param {Array<[number,number]>|Map<number,number>} items */
function buildBagFull(items) {
  const list = items instanceof Map ? [...items.entries()] : items;
  const p = Buffer.alloc(4 + list.length * 8);
  p.writeUInt32LE(list.length, 0);
  list.forEach(([id, n], i) => { p.writeUInt32LE(id >>> 0, 4 + i * 8); p.writeUInt32LE(n >>> 0, 4 + i * 8 + 4); });
  // Native 11523 material snapshots and one-row updates use the same
  // application flag.  Without it the client accepts the frame on the wire
  // but does not merge the count into its material model.
  return mkFrame(MSG_BAG, p, { flags: 0xca });
}
function buildBagDelta(id, count) { return buildBagFull([[id, count]]); }

function parseBag(frame) {
  const p = frame.subarray(12);
  const n = p.readUInt32LE(0);
  if (p.length !== 4 + n * 8) return null;
  const items = [];
  for (let i = 0; i < n; i++) items.push([p.readUInt32LE(4 + i * 8), p.readUInt32LE(4 + i * 8 + 4)]);
  return { full: n !== 1, n, items, map: new Map(items) };
}

// ---------- 1700x 格子查询 ----------
function buildSlotQuery(slot) {
  const p = Buffer.alloc(9);
  p.writeUInt8(0, 0); p.writeUInt16LE(slot, 1); p.writeUInt32LE(0xFFFFFFFF, 3); p.writeUInt16LE(0, 7);
  return mkFrame(MSG_REQ_SLOT, p);
}
function parseSlotQuery(frame) {
  const p = frame.subarray(12);
  return { slot: p.readUInt16LE(1), raw: p.toString('hex') };
}
function buildSlotAck(itemId, slot) {
  const p = Buffer.alloc(13);
  p.writeUInt8(0, 0); p.writeUInt16LE(itemId, 1); p.writeUInt16LE(slot, 3);
  p.writeUInt32LE(0xFFFFFFFF, 5); p.writeUInt32LE(0, 9);
  return mkFrame(MSG_SLOT_ACK, p, { flags: 0xd1 });
}
function buildSlotHint(itemId) {
  const p = Buffer.alloc(6);
  p.writeUInt16LE(0x010F, 0); p.writeUInt16LE(itemId, 2); p.writeUInt16LE(1, 4);
  return mkFrame(MSG_SLOT_HINT, p, { flags: 0xd1 });
}
/**
 * Native 17004: payload header u8 unknown | u8 kind | u32 count,
 * followed by count x {u8 container | u16 physical slot | 490B instance}.
 * All 77 inspected captures contain one instance: payload 499B / frame 511B.
 * This builder intentionally supports one instance per frame only.
 * Instance item ID/count/GUID are at +0/+4/+8; enhancement and reforge bytes
 * are part of this same instance, never additional 22-byte item records.
 */
function buildSlotDetail(items) {
  if (!Array.isArray(items) || items.length !== 1)
    throw new RangeError('17004 requires exactly one item instance per frame');
  const s = items[0];
  if (!s || typeof s !== 'object') throw new TypeError('item instance required');
  const integer = (value, max, label) => {
    if (!Number.isInteger(value) || value < 0 || value > max)
      throw new RangeError('invalid ' + label);
    return value;
  };
  const p = Buffer.alloc(499);
  p[0] = 0; p[1] = 0x0f; p.writeUInt32LE(1, 2);
  p[6] = integer(s.bagType ?? 0, 0xff, 'container');
  p.writeUInt16LE(integer(s.slot ?? 0, 0xffff, 'slot'), 7);
  if (s.instance !== undefined) {
    if (!Buffer.isBuffer(s.instance) || s.instance.length !== 490)
      throw new RangeError('17004 instance must be exactly 490 bytes');
    s.instance.copy(p, 9);
  }
  if (s.itemId !== undefined || !s.instance)
    p.writeUInt32LE(integer(s.itemId ?? 0, 0xffffffff, 'item ID'), 9);
  if (s.count !== undefined || !s.instance)
    p.writeUInt32LE(integer(s.count ?? 0, 0xffffffff, 'count'), 13);
  // Legacy aliases refer to high bytes of the ID/count, not separate records.
  if (s.unk8 !== undefined) p[11] = integer(s.unk8, 0xff, 'item ID byte2');
  if (s.unk9 !== undefined) p[12] = integer(s.unk9, 0xff, 'item ID byte3');
  if (s.unk12 !== undefined) p.writeUInt16LE(integer(s.unk12, 0xffff, 'count high word'), 15);
  if (s.guid !== undefined) {
    const guid = typeof s.guid === 'string' && /^[0-9a-f]{16}$/i.test(s.guid)
      ? Buffer.from(s.guid, 'hex') : s.guid;
    if (!Buffer.isBuffer(guid) || guid.length !== 8)
      throw new RangeError('item GUID must be exactly eight bytes');
    guid.copy(p, 17);
  }
  return mkFrame(MSG_SLOT_DETAIL, p, { flags: 0xd1 });
}
function parseSlotDetail(frame, keepEmpty = false) {
  if (!Buffer.isBuffer(frame) || frame.length !== 511) return [];
  const p = frame.subarray(12);
  if (p.readUInt32LE(2) !== 1) return [];
  const itemId = p.readUInt32LE(9);
  if (!keepEmpty && (itemId === 0 || itemId === 0xffff)) return [];
  return [{
    slot: p.readUInt16LE(7), itemId, count: p.readUInt32LE(13),
    unk8: p[11], unk9: p[12],
    guid: p.subarray(17, 25).toString('hex'),
    bagType: p[6], instanceHex: p.subarray(9, 499).toString('hex'),
  }];
}

// ---------- 传输层编解码 ----------
// 注意：增量 XOR 链是**整条字节流连续**的。要连发多帧必须共用同一个 Encoder 实例，
// 每帧各自 encode() 会让第 2 帧起客户端解不出来（这个坑在 chain.js 上踩过一次）。
class Encoder {
  constructor() { this.prev = SEED; }
  encode(plain) { const o = Buffer.alloc(plain.length); for (let i = 0; i < plain.length; i++) { o[i] = plain[i] ^ this.prev; this.prev = plain[i]; } return o; }
}
function encode(plain) { return new Encoder().encode(plain); }
function encodeAll(frames) { const e = new Encoder(); return Buffer.concat(frames.map(f => e.encode(f))); }
function decode(enc) { const o = Buffer.alloc(enc.length); let prev = SEED; for (let i = 0; i < enc.length; i++) { o[i] = enc[i] ^ prev; prev = o[i]; } return o; }
function splitFrames(buf) { const fr = []; let o = 0; while (o + 12 <= buf.length) { const t = buf.readUInt32LE(o); if (t < 12 || o + t > buf.length) break; fr.push(Buffer.from(buf.subarray(o, o + t))); o += t; } return fr; }
function decodeAll(wire) { return splitFrames(decode(wire)); }

// ---------- 主 ----------
module.exports = {
  MSG_BAG, MSG_REQ_SLOT, MSG_SLOT_ACK, MSG_SLOT_HINT, MSG_SLOT_DETAIL,
  mkFrame, buildBagFull, buildBagDelta, parseBag,
  buildSlotQuery, parseSlotQuery, buildSlotAck, buildSlotHint, buildSlotDetail, parseSlotDetail,
  Encoder, encode, encodeAll, decode, decodeAll, splitFrames,
};

function cli() {
const ARGS = process.argv.slice(2);
if (ARGS.includes('--test')) {
  let pass = 0, fail = 0;
  const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '   ' + (d || '')); } };

  const demo = [[1121, 2], [1122, 6], [1127, 4], [1128, 3], [1131, 1]];
  const full = buildBagFull(demo);
  const r = parseBag(full);
  ck('全量背包 帧长 = 12 + 4 + n*8', full.length === 12 + 4 + demo.length * 8, full.length);
  ck('全量背包 解析回原样', JSON.stringify(r.items) === JSON.stringify(demo));
  ck('全量背包 full=true', r.full === true);

  const delta = buildBagDelta(6242, 7);
  const rd = parseBag(delta);
  ck('增量背包 帧长 24（与抓包实测一致）', delta.length === 24, delta.length);
  ck('增量背包 载荷 = 抓包实测字节', delta.subarray(12).toString('hex') === '010000006218000007000000', delta.subarray(12).toString('hex'));
  ck('增量背包 full=false', rd.full === false);

  const q = buildSlotQuery(13);
  ck('格子查询 帧长 21（与抓包实测一致）', q.length === 21, q.length);
  ck('格子查询 载荷 = 抓包实测字节', q.subarray(12).toString('hex') === '000d00ffffffff0000', q.subarray(12).toString('hex'));
  ck('格子查询 解析出 slot=13', parseSlotQuery(q).slot === 13);

  const ack = buildSlotAck(904, 13);
  ck('查询应答 帧长 25（与抓包实测一致）', ack.length === 25, ack.length);
  ck('查询应答 载荷 = 抓包实测字节', ack.subarray(12).toString('hex') === '0088030d00ffffffff00000000', ack.subarray(12).toString('hex'));

  const hint = buildSlotHint(904);
  ck('精简应答 帧长 18、载荷 = 抓包实测字节', hint.length === 18 && hint.subarray(12).toString('hex') === '0f0188030100', hint.subarray(12).toString('hex'));

  const det = buildSlotDetail([{ slot: 13, itemId: 904, count: 3, guid: Buffer.from('454e9dfad9d7918e', 'hex') }]);
  ck('单件详情 帧长 511（与抓包实测一致）', det.length === 511, det.length);
  const pd = parseSlotDetail(det);
  ck('单件详情 解析回原样', pd.length === 1 && pd[0].slot === 13 && pd[0].itemId === 904 && pd[0].count === 3 && pd[0].guid === '454e9dfad9d7918e', JSON.stringify(pd));

  // 传输层：链跨帧连续
  const wire = encodeAll([full, delta]);
  const back = decodeAll(wire);
  ck('两帧共用一个 Encoder 连发后可完整还原', back.length === 2 && back[0].equals(full) && back[1].equals(delta), `got ${back.length}`);
  // 反例：每帧各自起链 -> 第 2 帧解不出来
  const badWire = Buffer.concat([encode(full), encode(delta)]);
  const badBack = decodeAll(badWire);
  ck('反例：每帧各自起链会解错（说明必须共用 Encoder）', !(badBack.length === 2 && badBack[1] && badBack[1].equals(delta)), `badBack=${badBack.length}`);

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
}

if (ARGS[0] === '--dump') {
  const dir = ARGS[1];
  const ev = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const byC = new Map(); for (const e of ev) if (e.dir === 's2c') byC.set(e.c, (byC.get(e.c) || 0) + 1);
  const best = [...byC.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const frames = splitFrames(fs.readFileSync(path.join(dir, `s2c-${best}.frames.bin`)));
  for (const f of frames) {
    const id = f.readUInt16LE(8);
    if (id === MSG_BAG) {
      const r = parseBag(f);
      if (r && r.full) { console.log(`11523 全量背包: ${r.n} 种道具`); console.log('  前 20 条: ' + r.items.slice(0, 20).map(([a, b]) => `${a}×${b}`).join(', ')); }
      else if (r) console.log(`11523 增量: ${r.items[0][0]} -> ${r.items[0][1]}`);
    } else if (id === MSG_SLOT_ACK) {
      const p = f.subarray(12); console.log(`17019 格子${p.readUInt16LE(3)} = 道具${p.readUInt16LE(1)}`);
    } else if (id === MSG_SLOT_DETAIL) {
      const d = parseSlotDetail(f); if (d.length) console.log('17004 详情: ' + JSON.stringify(d));
    }
  }
  process.exit(0);
}

if (ARGS[0] === '--extract') {
  // 从抓包里抽出背包模型：道具ID->数量（来自 11523 全量） + 格子->道具（来自 17004 详情）
  const dir = ARGS[1], out = ARGS[2] || path.join(__dirname, 'bag-state.json');
  const ev = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const byC = new Map(); for (const e of ev) if (e.dir === 's2c') byC.set(e.c, (byC.get(e.c) || 0) + 1);
  const best = [...byC.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const frames = splitFrames(fs.readFileSync(path.join(dir, `s2c-${best}.frames.bin`)));
  let items = null; const slots = {};
  for (const f of frames) {
    const id = f.readUInt16LE(8);
    if (id === MSG_BAG) { const r = parseBag(f); if (r && r.full) items = r.items; }
    else if (id === MSG_SLOT_DETAIL) for (const d of parseSlotDetail(f)) if (d.itemId) slots[d.slot] = { itemId: d.itemId, count: d.count, guid: d.guid };
  }
  if (!items) { console.error('这份抓包里没有 11523 全量背包帧'); process.exit(1); }
  const state = {
    说明: `从 ${path.basename(dir)} 抽出的背包模型。items = 道具ID->数量；slots = 格子号->道具（含实例GUID）。`,
    来源: path.basename(dir),
    items: items.map(([id, n]) => [id, n]),
    slots,
  };
  fs.writeFileSync(out, JSON.stringify(state, null, 1));
  console.log(`道具 ${items.length} 种，已见格子 ${Object.keys(slots).length} 个 -> ${out}`);
  console.log('前 12 条: ' + items.slice(0, 12).map(([a, b]) => `${a}×${b}`).join(', '));
  process.exit(0);
}

if (ARGS[0] === '--show') {
  const s = JSON.parse(fs.readFileSync(ARGS[1] || path.join(__dirname, 'bag-state.json'), 'utf8'));
  console.log(`来源 ${s.来源}：道具 ${s.items.length} 种，格子 ${Object.keys(s.slots).length} 个`);
  console.log('道具: ' + s.items.slice(0, 30).map(([a, b]) => `${a}×${b}`).join(', ') + ' …');
  console.log('格子: ' + Object.entries(s.slots).map(([k, v]) => `${k}=${v.itemId}×${v.count}`).join(', '));
  process.exit(0);
}

if (ARGS[0] === '--merge') {
  // 从一次抓包里把「17002 格子查询 -> 17019/17004 应答」全部抽出来，合并进 bag-state.json
  const dir = ARGS[1], out = ARGS[2] || path.join(__dirname, 'bag-state.json');
  const ev = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byC = new Map(); for (const e of ev) if (e.dir === 's2c') byC.set(e.c, (byC.get(e.c) || 0) + 1);
  const best = [...byC.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const seq = ev.filter(e => e.c === best);
  const asFrame = e => Buffer.from(e.hex, 'hex');

  const found = new Map();      // slot -> {itemId, count, guid}
  const order = [];
  const unresolved = [];
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i];
    if (e.dir !== 'c2s' || e.msgid !== MSG_REQ_SLOT) continue;
    const q = asFrame(e);
    const slot = q.readUInt16LE(12 + 1);
    let itemId = null, count = null, guid = null, ackSlotOk = false, detailItemId = null;
    // 注意：**不能只看到下一条 C->S 就停** —— 心跳 1297/36034 会插在查询和应答中间，
    // 窗口会被截断（实测格子 45 / 62 就是这样漏掉的）。
    // 改成往后扫最多 60 条事件，配到 slot 相符的 17019 就收工；
    // 17004 只认**第一条** slot 相符的记录，后面的帧不许覆盖（实测格子 58 的窗口里
    // 还夹着一条格子 91 的 17004，覆盖会把 33679×15 写成 50353×5）。
    for (let j = i + 1; j < seq.length && j <= i + 60; j++) {
      const r = seq[j];
      if (r.dir === 'c2s' && r.msgid === MSG_REQ_SLOT) break;      // 下一次查询，停
      if (r.dir !== 's2c') continue;
      const f = asFrame(r);
      if (r.msgid === MSG_SLOT_ACK) {
        const a = f.readUInt16LE(12 + 1), s2 = f.readUInt16LE(12 + 3);
        if (s2 === slot) { itemId = a; ackSlotOk = true; }
      } else if (r.msgid === MSG_SLOT_DETAIL && count === null) {
        const rec = parseSlotDetail(f, true).find(x => x.slot === slot && (x.itemId || x.count));
        if (rec) { count = rec.count; guid = rec.guid; detailItemId = rec.itemId; if (rec.itemId && rec.itemId !== 0xffff && (itemId === null || itemId === 0xffff)) itemId = rec.itemId; }
      }
      if (ackSlotOk && count !== null) break;
    }
    if (!itemId || itemId === 0xffff) { unresolved.push(`格子${slot}: 没有可用的 17019`); continue; }
    // 17004 的详情和 17019 的应答必须在道具ID 上一致才敢写。
    // 实测格子 45 两者矛盾（17019 说 32614，17004 说 0xFFFF 空），这种情况宁可空着也不能猜。
    if (count !== null && detailItemId !== null && detailItemId !== itemId) {
      unresolved.push(`格子${slot}: 17019 说道具${itemId}，17004 说${detailItemId === 0xffff ? '空(0xFFFF)' : '道具' + detailItemId} —— 矛盾，跳过`);
      continue;
    }
    found.set(slot, { itemId, count: count === null ? 1 : count, guid: guid && guid !== '0'.repeat(16) ? guid : null });
    order.push(slot);
  }

  let state;
  try { state = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { state = { items: [], slots: {} }; }
  state.slots = state.slots || {};
  const before = Object.keys(state.slots).length;
  const added = [], updated = [];
  for (const [slot, v] of found) {
    const cur = state.slots[slot];
    const rec = { itemId: v.itemId, count: v.count };
    if (v.guid) rec.guid = v.guid;
    if (!cur) { state.slots[slot] = rec; added.push(`${slot}=${v.itemId}×${v.count}`); }
    else if (cur.itemId !== v.itemId || cur.count !== v.count) { state.slots[slot] = rec; updated.push(`${slot}: ${cur.itemId}×${cur.count} -> ${v.itemId}×${v.count}`); }
  }
  fs.writeFileSync(out, JSON.stringify(state, null, 1));
  console.log(`从 ${path.basename(dir)} 抽到 ${found.size} 个格子的映射（查询顺序: ${order.join(',')}）`);
  console.log(`  新增 ${added.length}: ${added.join('  ') || '(无)'}`);
  console.log(`  更新 ${updated.length}: ${updated.join('  ') || '(无)'}`);
  console.log(`  slots 总数 ${before} -> ${Object.keys(state.slots).length}   已写入 ${out}`);
  if (unresolved.length) { console.log(`  未解决 ${unresolved.length} 个（没有猜，保持原样）:`); unresolved.forEach(u => console.log('    - ' + u)); }
  const q = seq.filter(e => e.dir === 'c2s' && e.msgid === MSG_REQ_SLOT).length;
  if (q > found.size + unresolved.length) console.log(`  注意：有 ${q - found.size - unresolved.length} 次查询既没配对也没标未解决`);
  process.exit(0);
}

console.log('用法: node bag.js --test | --dump <cap目录> | --extract <cap目录> [输出json] | --merge <cap目录> [json] | --show [json]');
}

if (require.main === module) cli();

