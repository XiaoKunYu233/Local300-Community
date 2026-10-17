#!/usr/bin/env node
/**
 * roledata.js -- 角色数据帧（外层 msgid 1166，内层 msgid 1013，zlib 压缩）
 *
 * 结构（实测，全部 8 份抓包一致，解开后固定 288458 字节）：
 *   [外层帧 12B 头: u32 总长 | u32 会话 | u16 msgid=1166 | u16 flags]
 *   [zlib 压缩体] -> 解开后:
 *       [内层帧 12B 头: u32 声明长(288540) | u32 会话 | u16 msgid=1013 | u16 flags]
 *       [角色数据体 ...]
 *
 * 关键字段（本账号）：
 *   +22  u32  玩家ID 1345739761 (0x50365BF1，与帧头会话字段相同)
 *   +26  u32  账号UID 245439782
 *   +34  char[15] 角色名(GBK，包含结尾 NUL)
 *   +60  u32  61020
 *   +141 u32  **金币 516593**   ← 全 288458 字节里只出现这一次，且与大厅 HUD 显示一致
 *   +145 角色数据里的一段会话串(每次登录不同)
 *
 * 用法:
 *   node roledata.js extract <流文件|cap目录> [--out=前缀]
 *   node roledata.js show <blob文件>
 *   node roledata.js setgold <blob文件> <新值> [--out=新文件]
 *   node roledata.js diff <blobA> <blobB>
 */
'use strict';
const fs = require('./persistence/state-files').io;
const path = require('path');
const zlib = require('zlib');

const GOLD_OFF = 141;     // 金币字段（u32 LE）——两个不同账号都落在同一偏移，已交叉验证
// Cross-checked against 1012 for both captured accounts. These are offsets
// in the inflated frame including its 12-byte header, not payload offsets.
const PLAYERID_OFF = 22;
const UID_OFF = 26;
const NAME_OFF = 34, NAME_LEN = 15;

/**
 * 背包原生记录：15718 + 493 × 数组下标。
 *   +0 u8容器类型；+1 u16物理格子；+3开始490B实例。
 * 实例起点15721，字段+0 u16道具ID、+4 u16数量、+8 u64 GUID。
 * 数组下标和物理格子不一定相同；从录制查实例必须按GUID。
 * 写回权威模型时同步容器头和格子，只复制490B实例，避免带上下一条记录头。
 */
const BAG_BASE = 15721, BAG_STRIDE = 493, INSTANCE_SIZE=490;
const EQUIP_CONFIG = (() => {
  try {
    const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'logs','cfg','item_equip.json'),'utf8'));
    const rows=Array.isArray(cfg)?cfg:Object.values(cfg).find(Array.isArray);
    return new Map(rows.map(row=>[row['1'],row]));
  } catch { return new Map(); }
})();
const ITEM_RECORD_TEMPLATES = new Map();
// Per-instance repairs are kept outside the equipment reference file so a
// repair never changes item identity or bag placement.  The live state file
// is intentionally small and keyed by GUID; absent entries keep the captured
// durability untouched.
const REPAIR_STATE_FILE = process.env.DSH_EQUIPMENT_REPAIR_STATE ||
  path.join(__dirname, 'equipment-repair-state.json');
let REPAIR_STATE = null;
function repairFor(value) {
  if (!value?.guid) return null;
  if (REPAIR_STATE === null) {
    try {
      const data = JSON.parse(fs.readFileSync(REPAIR_STATE_FILE, 'utf8'));
      REPAIR_STATE = data?.version === 1 && data.repairs && typeof data.repairs === 'object'
        ? data.repairs : {};
    } catch { REPAIR_STATE = {}; }
  }
  const guid = Buffer.isBuffer(value.guid) ? value.guid.toString('hex') : String(value.guid).toLowerCase();
  const row = REPAIR_STATE[guid];
  return row && row.itemId === Number(value.itemId) && Number.isInteger(row.durability) &&
    row.durability >= 0 && row.durability <= 0xffff ? row.durability : null;
}
function loadItemRecordTemplates() {
  const explicit=process.env.DSH_ITEM_TEMPLATE_FILE;
  if(explicit&&!path.isAbsolute(explicit))throw Error('Absolute item template bundle required');
  const bundle=explicit||path.join(__dirname,'runtime','item-templates-20261002.json');
  // The reviewed 303-record bundle matches the existing maximum-durability
  // scan byte for byte. Prefer it so packaged servers do not traverse captures.
  // A present but damaged bundle is an error, never a reason to change sources.
  if(explicit||fs.existsSync(bundle)){
    for(const [id,row] of require('./runtime/item-templates').load(bundle))ITEM_RECORD_TEMPLATES.set(id,row);
    return;
  }
  try {
    const dirs=fs.readdirSync(path.join(__dirname,'logs')).filter(x=>x.startsWith('cap-')).sort();
    for(const name of dirs){
      const dir=path.join(__dirname,'logs',name);
      let file;try{file=fs.readdirSync(dir).find(x=>/^s2c-.*\.frames\.bin$/.test(x));}catch{continue;}
      if(!file)continue;
      const capture=extractFrom(path.join(dir,file));if(!capture)continue;
      for(let slot=0;slot<192;slot++){
        const item=readBagSlot(capture.blob,slot);
        if(!item||item.itemId===0xffff)continue;
        const record=Buffer.from(capture.blob.subarray(BAG_BASE+slot*BAG_STRIDE,BAG_BASE+(slot+1)*BAG_STRIDE));
        const old=ITEM_RECORD_TEMPLATES.get(item.itemId);
        const durability=record.readUInt16LE(130);
        if(!old||durability>old.durability)ITEM_RECORD_TEMPLATES.set(item.itemId,{record,durability});
      }
    }
  }catch{}
}
loadItemRecordTemplates();
/**
 * 角色数据帧里到底能写多少格背包 —— **这是被误设为 192 很久的一个坑**。
 *
 * 实证：解压后的角色数据体 288458 字节，背包记录区从 +15721 开始、每格 493 字节；
 * (288458 - 15721) / 493 ≈ 553 → **至少 552 格**（`node bagcap.js` / `bagrebuild.js` 也是这么重建的，
 * 真账号的 259 件道具里有一批就在 192 格之后）。
 * 以前写死 192 → 只重写前 192 格，后 360 格**原样留着录制时的旧道具**，
 * 于是"客户端看到的背包"和"服务端模型"各说各话：客户端说还有空格、服务端说满了；
 * 客户端显示的道具我们模型里没有（点它装备就串格、还有放不进东西的空洞）。
 * 记录区按 `--bag-records=552` 完整重写；实际可操作格子由
 * `--bag-capacity=192` 单独限制。记录区长度不是背包的开放容量。
 */
let BAG_SLOTS = 192;
function setBagSlots(n) { const v = +n; if (Number.isInteger(v) && v > 0 && v <= 552) BAG_SLOTS = v; return BAG_SLOTS; }

function indexRecords(blob){
  const index=new Map();
  for(let slot=0;slot<BAG_SLOTS;slot++){
    const old=readBagSlot(blob,slot);
    if(!old||old.itemId===0xffff||!old.count)continue;
    const key=`${old.itemId}:${old.guid.toString('hex')}`;
    if(!index.has(key))index.set(key,slot);
  }
  return index;
}
function itemRecord(blob, slot, value, index=null) {
  const record = Buffer.alloc(BAG_STRIDE);
  if (!value) {record.writeUInt16LE(0xffff); return record;}
  // Move the complete instance record, including enhancement/gems, with its GUID.
  // A new item must not inherit the previous occupant's metadata.
  const guid = value.guid;
  // A warehouse round trip may outlive the captured login blob. Carry the
  // complete instance; the original login capture can be older than it.
  let savedInstance=false;
  if(typeof value.instanceHex==='string' && /^[0-9a-f]{980}$/i.test(value.instanceHex)){
    const saved=Buffer.from(value.instanceHex,'hex');
    if(saved.readUInt16LE(0)===value.itemId&&saved.subarray(8,16).toString('hex')===guid){saved.copy(record);savedInstance=true;}
  }
  if(!savedInstance&&index){
    const source=index.get(`${value.itemId}:${guid}`);
    if(source!==undefined)blob.copy(record,0,BAG_BASE+source*BAG_STRIDE,BAG_BASE+source*BAG_STRIDE+INSTANCE_SIZE);
  }else if(!savedInstance)for (let s=0; s<BAG_SLOTS; s++) {
    const old=readBagSlot(blob,s);
    if (old && old.itemId===value.itemId && old.guid.toString('hex')===guid) {
      blob.copy(record,0,BAG_BASE+s*BAG_STRIDE,BAG_BASE+s*BAG_STRIDE+INSTANCE_SIZE); break;
    }
  }
  if(record.readUInt16LE(0)!==value.itemId){
    const template=ITEM_RECORD_TEMPLATES.get(value.itemId);
    if(template){
      template.record.copy(record);
      // Templates provide item layout and durability. Enhancement and
      // blessing lines belong to the captured GUID, not to this new item.
      record[73]=0;record[74]=0;
      record.fill(0,76,118);
    }
    else {
      // The captured equipment records agree with item_equip column 7 in all
      // 118 available examples: protocol durability = column 7 * 256.
      // Initialize only this confirmed field; never copy another item's gems.
      const units=EQUIP_CONFIG.get(value.itemId)?.['7'];
      if(Number.isInteger(units) && units>0 && units<=255)
        record.writeUInt16LE(units*256,130);
    }
  }
  record.writeUInt16LE(value.itemId,0);
  record.writeUInt16LE(value.count,4);
  if (guid) Buffer.from(guid,'hex').copy(record,8);
  const repairedDurability = repairFor(value);
  if (repairedDurability !== null) record.writeUInt16LE(repairedDurability,130);
  record.fill(0,INSTANCE_SIZE);
  return record;
}

function readBagSlot(blob, slot) {
  const o = BAG_BASE + BAG_STRIDE * slot;
  if (o + 16 > blob.length) return null;
  return { itemId: blob.readUInt16LE(o), count: blob.readUInt16LE(o + 4), guid: blob.subarray(o + 8, o + 16) };
}

/** 写回指定数组记录的实例字段；容器头由syncBag单独写入。 */
function writeBagSlot(blob, slot, itemId, count, guid) {
  const o = BAG_BASE + BAG_STRIDE * slot;
  if (o + 16 > blob.length) return false;
  blob.writeUInt16LE(itemId & 0xffff, o);
  blob.writeUInt16LE(count & 0xffff, o + 4);
  if (guid) guid.copy(blob, o + 8);
  return true;
}

/**
 * 把服务端背包模型写进角色数据体（返回新 Buffer）。
 * @param slots Map<格子号, {itemId,count,guid?}>
 * @param mode  'safe' = 只同步有道具的格子（不碰空格，避免写没实证的空值编码）
 *              'full' = 模型里没有的格子也写成空
 * @param emptyMarker 空格子写什么道具ID：0xFFFF（协议里"空"就是这么表示的，默认）或 0（全零）
 *
 * full会删除录制中残留的物品；空记录容器头=FF/FFFF，实例ID按emptyMarker写入。
 * 旧存档超过visibleCapacity的实例保留数据，容器头=FF/FFFF，需离线恢复。
 * 新写入的穿戴与未穿戴实例均占开放背包格，六件穿戴另由syncEquipment同步。
 */
function syncBag(blob, slots, mode = 'safe', emptyMarker = 0xFFFF, recordPatch = null,
  visibleCapacity = 192) {
  if(!Number.isInteger(visibleCapacity)||visibleCapacity<1||visibleCapacity>352)
    throw new RangeError('invalid visible bag capacity');
  const b = Buffer.from(blob);
  // Native c23640 loads the seven u16 container capacities here. Only the
  // ordinary bag is managed by this server; preserve all other containers.
  b.writeUInt16LE(visibleCapacity,15704);
  const index=indexRecords(blob);
  let n = 0, skipped = 0;
  for (let slot = 0; slot < BAG_SLOTS; slot++) {
    const v = slots.get(slot);
    if (v) {
      const record=itemRecord(blob,slot,v,index);
      if(recordPatch)recordPatch(record,v,slot);
      const start=BAG_BASE+slot*BAG_STRIDE;
      // Native 46c0b0/46cc75 searches only the opened container's first N
      // cache entries. Legacy high records stay outside that cache until
      // recovery moves them visibly and increases the opened capacity to fit.
      b[start-3]=slot<visibleCapacity?0:0xff;
      b.writeUInt16LE(slot<visibleCapacity?slot:0xffff,start-2);
      record.subarray(0,INSTANCE_SIZE).copy(b,start); n++;
    } else if (mode === 'full') {
      const start=BAG_BASE+slot*BAG_STRIDE;
      b[start-3]=0xff;b.writeUInt16LE(0xffff,start-2);
      b.fill(0,start,Math.min(start+INSTANCE_SIZE,b.length));
      if (writeBagSlot(b, slot, emptyMarker & 0xffff, 0, Buffer.alloc(8))) n++;
    } else skipped++;
  }
  return { blob: b, written: n, skipped };
}
// Six 497-byte cached equipment records are also carried in role data. Each
// equals the current 1043 frame from byte13 onward in all fourteen captures.
const EQUIP_BASE=4751,EQUIP_STRIDE=497;
function syncEquipment(blob,frames){
  const b=Buffer.from(blob);
  for(const frame of frames||[]){
    if(!Buffer.isBuffer(frame)||frame.length!==510||frame.readUInt16LE(8)!==1043)
      throw Error('invalid equipment snapshot frame');
    const position=frame[12];
    if(position>=6||EQUIP_BASE+(position+1)*EQUIP_STRIDE>b.length)
      throw Error('invalid role equipment position');
    frame.subarray(13,510).copy(b,EQUIP_BASE+position*EQUIP_STRIDE);
  }
  return b;
}

// MSG_SMC_CHAR_EQUIP: actor u32, 22 cached 497-byte equipment records,
// then the captured 17-byte trailer. The first six records are the active set.
// Use the same complete records as 1043 and role data, including +level/GUID.
function syncEquipmentSummary(frame,frames){
  if(!Buffer.isBuffer(frame)||frame.length!==10967||frame.readUInt16LE(8)!==13535)
    throw Error('unrecognized equipment summary');
  const out=Buffer.from(frame),seen=new Set();
  for(const current of frames||[]){
    if(!Buffer.isBuffer(current)||current.length!==510||current.readUInt16LE(8)!==1043||
      current[12]>=6||seen.has(current[12]))throw Error('invalid equipment summary record');
    seen.add(current[12]);
    current.subarray(13,510).copy(out,16+current[12]*EQUIP_STRIDE);
  }
  if(seen.size!==6)throw Error('incomplete equipment summary');
  return out;
}

function decodeXor(e) { const o = Buffer.alloc(e.length); let p = 0xcd; for (let i = 0; i < e.length; i++) { o[i] = e[i] ^ p; p = o[i]; } return o; }
function split(buf) { const fr = []; let o = 0; while (o + 12 <= buf.length) { const t = buf.readUInt32LE(o); if (t < 12 || o + t > buf.length) break; fr.push(Buffer.from(buf.subarray(o, o + t))); o += t; } return fr; }
function inflate(b) { for (const fn of ['inflateSync', 'unzipSync', 'inflateRawSync']) { try { const o = zlib[fn](b); if (o && o.length > b.length) return o; } catch { } } return null; }

/** 从一条已解码的帧流里取出 1166（压缩角色数据）帧，返回 {outer, blob} */
function extractFrom(file) {
  const raw = fs.readFileSync(file);
  let frames = split(raw);
  if (frames.length < 5) frames = split(decodeXor(raw));
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.readUInt16LE(8) !== 1166) continue;
    const blob = inflate(f.subarray(12));
    if (!blob) continue;
    return { outer: f, blob, idx: i, name: path.basename(file), frames: frames.length };
  }
  return null;
}

function findStream(src) {
  const st = fs.statSync(src);
  if (st.isFile()) return src;
  const cands = fs.readdirSync(src).filter(f => /^s2c-.*\.frames\.bin$/.test(f) && fs.statSync(path.join(src, f)).size > 1000);
  if (cands.length) return path.join(src, cands[0]);
  throw new Error('目录里没有 s2c-*.frames.bin');
}

/** 把 blob 重新包成完整帧。
 *  实测：外层帧(1166) 会话=0 flags=0，压缩体解开后 **本身就是一条完整内层帧**
 *  （12B 头 + 数据，声明长 288540）。所以最稳的做法是原样保留 blob，
 *  只重新 zlib —— 一个字节都不动，避免把内层头写坏。
 */
function buildFrame(blob, outer, session, flags) {
  const comp = zlib.deflateSync(blob, { level: 9 });
  const f = Buffer.alloc(12 + comp.length);
  f.writeUInt32LE(12 + comp.length, 0);
  f.writeUInt32LE(outer ? outer.readUInt32LE(4) : (session || 0), 4);
  f.writeUInt16LE(1166, 8);
  f.writeUInt16LE(flags !== undefined ? flags : (outer ? outer.readUInt16LE(10) : 0), 10);
  comp.copy(f, 12);
  return { frame: f, inner: blob, compressed: comp.length };
}

const goldOf = blob => blob.readUInt32LE(GOLD_OFF);
const nameOf = blob => {
  const bytes=blob.subarray(NAME_OFF,NAME_OFF+NAME_LEN),nul=bytes.indexOf(0);
  return new TextDecoder('gb18030').decode(nul<0?bytes:bytes.subarray(0,nul));
};

module.exports = {
  GOLD_OFF, BAG_BASE, BAG_STRIDE, get BAG_SLOTS() { return BAG_SLOTS; }, setBagSlots, PLAYERID_OFF, UID_OFF, NAME_OFF,
  extractFrom, buildFrame, goldOf, nameOf, findStream, inflate, split, decodeXor,
  readBagSlot, writeBagSlot, syncBag, ITEM_RECORD_TEMPLATES,
  itemRecord,indexRecords,syncEquipment,syncEquipmentSummary,EQUIP_BASE,EQUIP_STRIDE,INSTANCE_SIZE,
};

// ---------------- CLI ----------------
if (require.main === module) {
  const ARGS = process.argv.slice(2);
  const argOf = (k, d) => { const a = ARGS.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
  const pos = ARGS.filter(a => !a.startsWith('--'));
  const cmd = pos[0];

  if (cmd === 'extract') {
    const r = extractFrom(findStream(pos[1]));
    if (!r) { console.error('这条流里没有 msgid=1166 的压缩帧'); process.exit(1); }
    const out = (argOf('out', 'blob')) + '.bin';
    fs.writeFileSync(out, r.blob);
    console.log(`${r.name}: 帧#${r.idx}/${r.frames} 外层 ${r.outer.length}B -> 解开 ${r.blob.length}B -> ${out}`);
    console.log(`  玩家ID ${r.blob.readUInt32LE(PLAYERID_OFF)}  角色名 ${nameOf(r.blob)}  金币(+${GOLD_OFF}) ${goldOf(r.blob)}`);
  } else if (cmd === 'show') {
    const b = fs.readFileSync(pos[1]);
    console.log(`文件 ${pos[1]}  ${b.length} 字节`);
    console.log(`  +${PLAYERID_OFF} 玩家ID = ${b.readUInt32LE(PLAYERID_OFF)}`);
    console.log(`  +${NAME_OFF}  角色名 = ${nameOf(b)}`);
    console.log(`  +60    字段   = ${b.readUInt32LE(60)}`);
    console.log(`  +${GOLD_OFF} 金币   = ${goldOf(b)}`);
  } else if (cmd === 'setgold') {
    const b = Buffer.from(fs.readFileSync(pos[1]));
    const v = Number(pos[2]);
    const old = goldOf(b);
    b.writeUInt32LE(v >>> 0, GOLD_OFF);
    const out = argOf('out', pos[1].replace(/\.bin$/, '') + `.gold${v}.bin`);
    fs.writeFileSync(out, b);
    console.log(`金币 ${old} -> ${v}   写出 ${out}`);
  } else if (cmd === 'diff') {
    const a = fs.readFileSync(pos[1]), b = fs.readFileSync(pos[2]);
    if (a.length !== b.length) { console.log(`长度不同: ${a.length} vs ${b.length}`); process.exit(1); }
    const ranges = [];
    let s = -1;
    for (let i = 0; i <= a.length; i++) {
      const diff = i < a.length && a[i] !== b[i];
      if (diff && s < 0) s = i;
      if (!diff && s >= 0) { ranges.push([s, i]); s = -1; }
    }
    console.log(`${pos[1]} vs ${pos[2]}: ${ranges.length} 段不同`);
    for (const [x, y] of ranges.slice(0, 40)) {
      console.log(`  ${x}..${y} (${y - x}B)  A=${a.subarray(x, Math.min(y, x + 16)).toString('hex')}  B=${b.subarray(x, Math.min(y, x + 16)).toString('hex')}`);
    }
  } else {
    console.log('用法: node roledata.js extract|show|setgold|diff ...');
  }
}
