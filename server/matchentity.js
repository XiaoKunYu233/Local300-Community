#!/usr/bin/env node
/**
 * matchentity.js -- **把 `9173` 的"实体记录"拆成"结构 + 数值"两层**，好让服务端按自己的世界重造帧。
 *
 * ## 为什么要它
 *
 * 第 10 轮踩的坑：`matchworld.makeEntityUpdateFrame()` 自己拼 `[op][a][u16 len][u16 0][actor][1056][6B]`，
 * 离线自检全绿，但推给**真客户端**会把 `300.exe` 推进 100% CPU 死循环（见 `README_MATCH_NEXT.md` §5.10）。
 * 怀疑点：每个实体在真流里**不是只带 `1056`**，而是"一小批记录"（`1056`+`1045`+`11007`+`11041`+`27112`…），
 * 而且记录前面那两字节 `[u8 op][u8 a]` 在我们造的帧里是**瞎写的**（实测真流里这两个字节**每条记录都不一样**，
 * 像是发送侧的游标/渠道路由）。
 *
 * ## 本模块的口径（保守，可验证）
 *
 * > **结构照抄录制，数值换成我们的。**
 *
 * 具体做法：
 *   1. 从录制里按"实体"收集它在真流里**用过的记录形态**（tag 序列 + 载荷长度 + 记录前面的 `op/a` 前缀）；
 *   2. 造帧时挑一个真流里**出现过**的形态，把块里的数值字段**等长改写**（`1056` 6 字节位置、`1045` 属性行、`11035` 单属性）；
 *   3. `op/a` 前缀**按录制里出现过的取值循环用**，不瞎编；
 *   4. 其余（`11007`/`11005`/`11041`/`23445`/`27105`… 这些还没解出字段语义的）**原样照抄模板**，一个字节都不动。
 *
 * 这样"帧的结构分布"和真服一致，客户端那套状态机看到的东西和它预期的一样。
 *
 * ## 用法
 *   node matchentity.js --match=002                 # 看每个实体的"记录形态"表
 *   node matchentity.js --match=002 --actor=0xff26b65e --forms
 *   node matchentity.js --selftest                  # 契约测试（形态自洽 + 数值改写往返）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const MG = require('./matchgen');
const REC = require('./m9173rec');

const TAGS = new Set([...MG.MSG_TAGS]);
const DEFAULT_DIR = path.join(__dirname, 'logs', 'cap-2026-09-27T10-13-20-match');

/** 读一场录制的 S→C / C→S 帧 */
function loadMatch(match, dir = DEFAULT_DIR) {
  const read = suf => {
    const f = path.join(dir, `match-9004-${String(match).padStart(3, '0')}.${suf}.bin`);
    if (!fs.existsSync(f)) throw new Error(`找不到 ${f}`);
    return MG.split(MG.xor(fs.readFileSync(f)));
  };
  return { s2c: read('s2c'), c2s: read('c2s'), dir };
}

/** 一条记录的"形态指纹"：前缀 + tag + 载荷长度（数值之外的骨架） */
const formKey = b => `${b.prefix ? b.prefix.op.toString(16) + ':' + b.prefix.a : '-'}|${b.tag}|${b.plen}`;

/**
 * 从录制里学"每个实体的记录形态库"。
 *
 * @returns {{forms: Map<number, Map<string, {key, samples, count, bytes: Buffer[]}>>, frames: Buffer[]}}
 *   `forms[actor][formKey].bytes[0]` 是该形态的**原始记录字节**（含 op/a 前缀），当模板用。
 */
function learn(match = '002', dir = DEFAULT_DIR, opts = {}) {
  const { s2c } = loadMatch(match, dir);
  const f9173 = s2c.filter(f => f.readUInt16LE(8) === 9173);
  const forms = new Map();
  const maxSamples = opts.maxSamples || 4;
  f9173.forEach((f, gi) => {
    const p = f.subarray(12);
    for (const b of REC.cover(p, { tags: TAGS }).picks) {
      const key = formKey(b);
      if (!forms.has(b.actor)) forms.set(b.actor, new Map());
      const m = forms.get(b.actor);
      if (!m.has(key)) m.set(key, { key, actor: b.actor, tag: b.tag, plen: b.plen, prefix: b.prefix, count: 0, bytes: [], gi: [] });
      const e = m.get(key);
      e.count++;
      if (e.bytes.length < maxSamples) { e.bytes.push(Buffer.from(p.subarray(b.o - (b.prefix ? 2 : 0), b.end))); e.gi.push(gi); }
    }
  });
  return { forms, frames: s2c, f9173 };
}

/** 一个实体的"记录形态"按出现次数排序 */
function formsOf(forms, actor) {
  const m = forms.get(actor >>> 0);
  return m ? [...m.values()].sort((a, b) => b.count - a.count) : [];
}

// ---------- 数值改写（等长） ----------
const REWRITABLE = new Set([1056, 1045, 11035]);

/**
 * 把一条模板记录里的**数值字段**换成我们的值。等长改写 ⇒ 整条记录长度不变。
 * @param {Buffer} rec 模板记录（含 op/a 前缀）
 * @param {object} vals `{pos:{x,y,z}, attrs:{[attrId]:value}}`
 * @returns {Buffer} 新记录（未命中可改写字段时返回模板的副本）
 */
function applyValues(rec, vals = {}) {
  const out = Buffer.from(rec);
  const pre = (out.length >= 12 + 2 && out.readUInt16LE(2) >= 12 && out.readUInt16LE(4) === 0
    && out.readUInt32LE(6) !== 0) ? 2 : 0;   // 有 op/a 前缀的判据：块从 +2 开始
  if (out.length < pre + 12) return out;
  const len = out.readUInt16LE(pre);
  if (len < 12 || pre + len > out.length) return out;
  const tag = out.readUInt32LE(pre + 8);
  const pl = out.subarray(pre + 12, pre + len);
  if (tag === 1056 && pl.length === 6 && vals.pos) {
    const enc = MG.pos.encode({ x: vals.pos.x, y: vals.pos.y === undefined ? 0 : vals.pos.y, z: vals.pos.z });
    if (enc.length === 6) enc.copy(out, pre + 12);
  } else if (tag === 1045 && vals.attrs) {
    const d = MG.attrList.decode(pl);
    if (d) {
      const rows = d.rows.map(r => (vals.attrs[r.attrId] === undefined ? r : { attrId: r.attrId, value: vals.attrs[r.attrId] >>> 0 }));
      const enc = MG.attrList.encode({ rows });
      if (enc.length === pl.length) enc.copy(out, pre + 12);
    }
  } else if (tag === 11035 && pl.length === 8 && vals.attrs) {
    const d = MG.attr.decode(pl);
    if (d && vals.attrs[d.key] !== undefined && d.type !== 3) {
      const enc = MG.attr.encode({ key: d.key, type: d.type, value: vals.attrs[d.key] >>> 0 });
      if (enc.length === 8) enc.copy(out, pre + 12);
    }
  }
  return out;
}

/** 从一条记录里读出它的数值（位置 / 属性行），给"学习初始状态"用 */
function readValues(rec) {
  const pre = (rec.length >= 14 && rec.readUInt16LE(2) >= 12 && rec.readUInt16LE(4) === 0 && rec.readUInt32LE(6) !== 0) ? 2 : 0;
  if (rec.length < pre + 12) return null;
  const len = rec.readUInt16LE(pre);
  if (len < 12 || pre + len > rec.length) return null;
  const tag = rec.readUInt32LE(pre + 8);
  const pl = rec.subarray(pre + 12, pre + len);
  if (tag === 1056 && pl.length === 6) return { tag, pos: MG.pos.decode(pl) };
  if (tag === 1045) { const d = MG.attrList.decode(pl); if (d) return { tag, attrs: d.rows }; }
  if (tag === 11035 && pl.length === 8) { const d = MG.attr.decode(pl); if (d) return { tag, attr: d }; }
  return { tag };
}

/**
 * 造一条"实体更新帧"：`records` 是若干条记录字节（已含 op/a 前缀），拼进一条 `9173` 帧。
 * `stream` 用录制里 `9173` 帧出现过的取值（0）。
 */
function frameOf(records, { stream = 0 } = {}) {
  const payload = Buffer.concat(records);
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32LE(out.length, 0);
  out.writeUInt32LE(stream >>> 0, 4);
  out.writeUInt16LE(9173, 8);
  out.writeUInt16LE(0, 10);
  payload.copy(out, 12);
  return out;
}
/** 造一条 `1056` 独立位置帧（录制里战场有 266 条这种裸帧） */
function posFrame(pos, { stream = 0 } = {}) {
  const payload = MG.pos.encode(pos);
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32LE(out.length, 0);
  out.writeUInt32LE(stream >>> 0, 4);
  out.writeUInt16LE(1056, 8);
  out.writeUInt16LE(0, 10);
  payload.copy(out, 12);
  return out;
}
/** 造一条 `1045` 独立属性帧（`[u8 n][n×([u8 attrId][u32 值])]`） */
function attrFrame(rows, { stream = 0 } = {}) {
  const payload = MG.attrList.encode({ rows });
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32LE(out.length, 0);
  out.writeUInt32LE(stream >>> 0, 4);
  out.writeUInt16LE(1045, 8);
  out.writeUInt16LE(0, 10);
  payload.copy(out, 12);
  return out;
}

module.exports = {
  TAGS, DEFAULT_DIR, loadMatch, learn, formsOf, formKey,
  applyValues, readValues, frameOf, posFrame, attrFrame, REWRITABLE,
};

// ---------------- CLI ----------------
if (require.main === module) {
  const ARGS = process.argv.slice(2);
  const argOf = (k, d) => { const p = `--${k}=`; const a = ARGS.find(x => x.startsWith(p)); return a ? a.slice(p.length) : d; };
  const flag = k => ARGS.includes(`--${k}`);
  const M = String(argOf('match', '002')).padStart(3, '0');

  if (flag('selftest')) {
    let pass = 0, fail = 0;
    const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '   ' + (d === undefined ? '' : d)); } };
    for (const MM of ['002', '003']) {
      const { forms, f9173 } = learn(MM);
      ck(`${MM}: 学到实体的记录形态（≥10 个实体）`, forms.size >= 10, String(forms.size));
      // 每个形态的模板都必须能按记录框架重新解析出来（tag/长度一致）
      let n = 0, ok = 0, tagOk = 0;
      for (const [actor, m] of forms) for (const e of m.values()) {
        n++;
        const picks = REC.cover(e.bytes[0], { tags: TAGS }).picks;
        if (picks.length) {
          ok++;
          const b = picks[picks.length - 1];
          if (b.tag === e.tag && b.actor === actor) tagOk++;
        }
      }
      ck(`${MM}: 形态模板能被记录框架解回来（${ok}/${n}，tag/actor 一致 ${tagOk}）`, n > 0 && ok === n && tagOk === n, `${ok}/${n}/${tagOk}`);

      // applyValues 等长 + 位置改写可解回
      let m2 = 0, lenOk = 0, round = 0;
      for (const m of forms.values()) for (const e of m.values()) {
        if (e.tag !== 1056 || e.plen !== 6) continue;
        m2++;
        const out = applyValues(e.bytes[0], { pos: { x: 123.45, y: 6.78, z: 234.56 } });
        if (out.length === e.bytes[0].length) lenOk++;
        const picks = REC.cover(out, { tags: TAGS }).picks.filter(b => b.tag === 1056);
        if (picks.some(b => { const d = MG.pos.decode(b.payload); return Math.abs(d.x - 123.45) < 0.005 && Math.abs(d.z - 234.56) < 0.005; })) round++;
      }
      ck(`${MM}: 1056 模板等长改写（${lenOk}/${m2}）且能解回新位置（${round}/${m2}）`, m2 > 0 && lenOk === m2 && round === m2, `${lenOk}/${round}/${m2}`);

      // 1045 属性改写
      let m3 = 0, lenOk3 = 0, round3 = 0;
      for (const m of forms.values()) for (const e of m.values()) {
        if (e.tag !== 1045) continue;
        const d = MG.attrList.decode(e.bytes[0].subarray(e.bytes[0].length - e.plen));
        if (!d || !d.rows.length) continue;
        for (const r of d.rows) {
          m3++;
          const out = applyValues(e.bytes[0], { attrs: { [r.attrId]: 12345 } });
          if (out.length === e.bytes[0].length) lenOk3++;
          const pl = out.subarray(out.length - e.plen);
          const d2 = MG.attrList.decode(pl);
          if (d2 && d2.rows.some(x => x.attrId === r.attrId && x.value === 12345)) round3++;
          break;   // 每条模板只试第一行
        }
      }
      ck(`${MM}: 1045 属性等长改写（${lenOk3}/${m3}）且能解回新值（${round3}/${m3}）`, m3 > 0 && lenOk3 === m3 && round3 === m3, `${lenOk3}/${round3}/${m3}`);

      // 自己拼的帧：长度自洽 + 能被记录框架铺满
      const anyActor = [...forms.keys()][0];
      const list = formsOf(forms, anyActor).slice(0, 3).map(e => e.bytes[0]);
      const fr = frameOf(list);
      const full = REC.cover(fr.subarray(12), { tags: TAGS }).picks;
      ck(`${MM}: frameOf 拼出的帧长度自洽且记录框架能铺满（${full.length}/${list.length} 条）`,
        fr.readUInt32LE(0) === fr.length && fr.readUInt16LE(8) === 9173 && full.length === list.length, `${full.length}/${list.length}`);
    }
    console.log(`\n===== matchentity ${pass} passed, ${fail} failed =====`);
    process.exit(fail ? 1 : 0);
  }

  const { forms, f9173 } = learn(M);
  console.log(`== 第 ${M} 场：${f9173.length} 条 9173，${forms.size} 个实体 ==`);
  const only = argOf('actor', '');
  const show = (actor) => {
    const list = formsOf(forms, actor);
    if (!list.length) { console.log(`  0x${actor.toString(16)} 没有记录`); return; }
    console.log(`\n0x${actor.toString(16).padStart(8, '0')}：${list.length} 种记录形态`);
    for (const e of list.slice(0, +argOf('n', '14'))) {
      const pre = e.prefix ? `${e.prefix.op.toString(16).padStart(2, '0')}:${e.prefix.a.toString(16).padStart(2, '0')}` : '  -  ';
      console.log(`    ×${String(e.count).padStart(4)}  [${pre}]  tag=${String(e.tag).padStart(6)}  载荷${String(e.plen).padStart(4)}B  模板 ${e.bytes[0].subarray(0, Math.min(20, e.bytes[0].length)).toString('hex')}${e.bytes[0].length > 20 ? '…' : ''}`);
    }
  };
  if (only) show(/^0x/i.test(only) ? parseInt(only, 16) >>> 0 : parseInt(only, 10) >>> 0);
  else {
    const top = [...forms.entries()].map(([a, m]) => ({ a, n: [...m.values()].reduce((s, e) => s + e.count, 0), kinds: m.size }))
      .sort((x, y) => y.n - x.n).slice(0, +argOf('top', '24'));
    for (const t of top) console.log(`  0x${t.a.toString(16).padStart(8, '0')}  记录 ${String(t.n).padStart(5)}  形态 ${String(t.kinds).padStart(3)} 种`);
    console.log('\n（用 --actor=0x… 看某个实体的形态表）');
  }
}
