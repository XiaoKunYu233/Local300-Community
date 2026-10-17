#!/usr/bin/env node
/**
 * mailgen.js -- 邮件载荷的**生成器 / 解析器**（服务端自己造邮件，不再只回放录制的 7 封）
 *
 * 结构（从 20 条真服帧反推，见 `node mailseg.js` / `node mailpb2.js`）：
 *
 *   头（28 字节，固定）
 *     +0  u32 邮件id
 *     +4  u32 0
 *     +8  u32 玩家ID
 *     +12 u32 时间（unix 秒）
 *     +16 u32 0
 *     +20 u32 20034（7 封全一样，疑似 serverId/渠道常量）
 *     +22 u16 0
 *     +24 u16 2
 *     +26 u16 49（7 封全一样，疑似标题+正文缓冲上限）
 *   文本段
 *     +28 u16 标题字节数
 *     +30 char[标题]（GBK）
 *     +30+标题长 u16 正文字节数
 *     +32+标题长 char[正文]（GBK）
 *   附件段（正文之后）
 *     +0  u8   标志：1=有未领取附件 / 0=已读 / （另一版 0x00）
 *     +1  14 字节 0
 *     +15 u8   附件条数（0..8；原生 Lua 界面每页 6 格）
 *     +16 u16  0xFEFD  ← 标记
 *     +18 u32  附件 protobuf 的字节数
 *     +22 protobuf 单个附件描述，逐个重复标记、长度与描述
 *     末尾 u8  0
 *
 *   附件 protobuf（**这一段才是 protobuf**，整条邮件不是）：
 *     field1(0x0a, 嵌套消息) = 道具：08 <varint 道具ID> 10 <varint 数量> 18 <varint 实例GUID> 20 00 28 00 30 00
 *     field2(0x12, 嵌套, 7 字节) = 08 ff 01 10 ff ff 03        ← 恒定（255 / 65535）
 *     field6(0x32) = ""（空串）
 *     field9(0x4a) = "restore"                                  ← items.json 里的 type 字段
 *     field10(0x50) = 0
 *
 * 「已领取」版：头一样，附件段换成 17 字节 `00 02` + 15 个 0。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ITEMS = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'items.json'), 'utf8')).道具; } catch { return {}; } })();
const gbk = new TextDecoder('gbk');
const gbkEnc = new TextEncoder();   // Node 没有内置 GBK 编码器，标题/正文只支持 ASCII/已有字节

function readVarint(b, o) { let v = 0n, s = 0n, i = o; while (i < b.length) { const x = b[i++]; v |= BigInt(x & 0x7f) << s; if (!(x & 0x80)) break; s += 7n; } return { value: v, bytes: i - o }; }
function writeVarint(v) {
  let x = BigInt(v); const out = [];
  do { let byte = Number(x & 0x7fn); x >>= 7n; if (x) byte |= 0x80; out.push(byte); } while (x);
  return Buffer.from(out);
}
const tag = (field, wire) => Buffer.from([(field << 3) | wire]);
const pbVarint = (field, v) => Buffer.concat([tag(field, 0), writeVarint(v)]);
const pbBytes = (field, b) => Buffer.concat([tag(field, 2), writeVarint(b.length), b]);

/** 一件附件的 protobuf（外层消息） */
function attachmentPB(itemId, count, guidBytes) {
  const item = Buffer.concat([
    pbVarint(1, itemId),
    pbVarint(2, count),
    Buffer.concat([tag(3, 0), guidBytes]),           // field3 = 64 位实例GUID（varint 原样带过来）
    pbVarint(4, 0), pbVarint(5, 0), pbVarint(6, 0),
  ]);
  const type = (ITEMS[itemId] && ITEMS[itemId].type) || 'restore';
  return Buffer.concat([
    pbBytes(1, item),
    pbBytes(2, Buffer.from([0x08, 0xff, 0x01, 0x10, 0xff, 0xff, 0x03])),
    pbBytes(6, Buffer.alloc(0)),
    pbBytes(9, Buffer.from(type, 'ascii')),
    pbVarint(10, 0),
  ]);
}

/** 生成一条邮件载荷 */
function buildMail(o) {
  const title = Buffer.isBuffer(o.title) ? o.title : Buffer.from(o.title, 'latin1');
  const body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body, 'latin1');
  const head = Buffer.alloc(28);
  head.writeUInt32LE(o.mailId >>> 0, 0);
  head.writeUInt32LE(o.f4 || 0, 4);
  head.writeUInt32LE(o.playerId >>> 0, 8);
  head.writeUInt32LE(o.time >>> 0, 12);
  head.writeUInt32LE(o.f16 || 0, 16);
  head.writeUInt32LE(o.serverId === undefined ? 20034 : o.serverId, 20);
  head.writeUInt16LE(o.h22 || 0, 22);
  head.writeUInt16LE(o.h24 === undefined ? 2 : o.h24, 24);
  head.writeUInt16LE(o.h26 === undefined ? 49 : o.h26, 26);
  const t = Buffer.alloc(2); t.writeUInt16LE(title.length, 0);
  const bl = Buffer.alloc(2); bl.writeUInt16LE(body.length, 0);
  let seg;
  if (o.attachments && o.attachments.length) {
    if(o.attachments.length>8)throw Error('Native mail supports at most eight attachment records');
    const pre=Buffer.alloc(16);pre[0]=o.flag0===undefined?1:o.flag0;pre[1]=o.flag1||0;pre[15]=o.attachments.length;
    const records=o.attachments.map(a=>{const pb=attachmentPB(a.itemId,a.count,a.guidBytes),mark=Buffer.alloc(6);mark.writeUInt16LE(0xfefd);mark.writeUInt32LE(pb.length,2);return Buffer.concat([mark,pb]);});
    seg=Buffer.concat([pre,...records,Buffer.from([0])]);
  } else {
    // 17 字节版：`01 00` + 15 个 0 = 没有可领附件；`00 02` + 15 个 0 = 已领取
    const pre = Buffer.alloc(17);
    pre.writeUInt8(o.flag0 === undefined ? (o.claimed ? 0 : 1) : o.flag0, 0);
    pre.writeUInt8(o.flag1 === undefined ? (o.claimed ? 2 : 0) : o.flag1, 1);
    seg = pre;
  }
  return Buffer.concat([head, t, title, bl, body, seg]);
}

/** 解析一条邮件载荷（validate=true 时对结构做严格校验） */
function parseMail(b) {
  const o = {
    mailId: b.readUInt32LE(0), f4: b.readUInt32LE(4), playerId: b.readUInt32LE(8), time: b.readUInt32LE(12),
    f16: b.readUInt32LE(16), serverId: b.readUInt32LE(20), h22: b.readUInt16LE(22), h24: b.readUInt16LE(24), h26: b.readUInt16LE(26),
  };
  const titleLen = b.readUInt16LE(28);
  o.titleRaw = b.subarray(30, 30 + titleLen);
  o.title = gbk.decode(o.titleRaw);
  const bodyLen = b.readUInt16LE(30 + titleLen);
  o.bodyRaw = b.subarray(32 + titleLen, 32 + titleLen + bodyLen);
  o.body = gbk.decode(o.bodyRaw);
  const seg = b.subarray(32 + titleLen + bodyLen);
  o.segLen = seg.length;
  o.flag0 = seg[0];
  o.flag1 = seg[1];
  o.claimed = seg.length === 17 && seg[1] === 2;
  o.hasPb = seg.length > 17;
  o.attachments = [];
  if(seg.length>17){
    try{let offset=16;const count=seg[15];if(count>8)throw Error('Too many native attachments');o.attachmentCount=count;
      for(let i=0;i<count;i++){if(offset+6>seg.length)throw Error('Truncated attachment header');const marker=seg.readUInt16LE(offset),len=seg.readUInt32LE(offset+2);if(marker!==0xfefd||offset+6+len>seg.length-1)throw Error('Invalid attachment record');if(i===0){o.marker=marker;o.pbLen=len;}o.attachments.push(...parseAttachments(seg.subarray(offset+6,offset+6+len)));offset+=6+len;}
      if(offset!==seg.length-1)throw Error('Trailing mail bytes');
    }catch(e){o.pbError=String(e.message);}
  }
  return o;
}

/** 解析附件 protobuf（可含多件：field1 重复出现） */
function parseAttachments(pb) {
  const out = []; let i = 0;
  while (i < pb.length) {
    const key = pb[i]; const field = key >> 3, wire = key & 7;
    if (wire !== 2) { i++; continue; }
    const r = readVarint(pb, i + 1); const len = Number(r.value);
    const payload = pb.subarray(i + 1 + r.bytes, i + 1 + r.bytes + len);
    if (field === 1) {
      const it = { itemId: 0, count: 0, guidBytes: null, type: null };
      let j = 0;
      while (j < payload.length) {
        const k2 = payload[j], f2 = k2 >> 3, w2 = k2 & 7; j++;
        if (w2 === 0) { const rv = readVarint(payload, j); const raw = Buffer.from(payload.subarray(j, j + rv.bytes)); j += rv.bytes; if (f2 === 1) it.itemId = Number(rv.value); if (f2 === 2) it.count = Number(rv.value); if (f2 === 3) { it.guid = rv.value.toString(); it.guidBytes = raw; } }
        else if (w2 === 2) { const rv = readVarint(payload, j); const L = Number(rv.value); j += rv.bytes; if (f2 === 3) it.guidBytes = Buffer.from(payload.subarray(j, j + L)); j += L; }
      }
      out.push(it);
    } else if (field === 9 && out.length) {
      out[out.length - 1].type = payload.toString('ascii');
    }
    i += 1 + r.bytes + len;
  }
  return out;
}

// 20311: start index, record count, mail records, final continuation byte.
// Native 0xaedfd9 reads this byte even after a single complete list.
function mailRecordLength(b,start=0){
  const title=b.readUInt16LE(start+28),body=b.readUInt16LE(start+30+title),seg=start+32+title+body;
  if(seg+17>b.length)throw Error('Truncated mail');let p=seg+16;const count=b[seg+15];if(count>8)throw Error('Too many native attachments');
  for(let i=0;i<count;i++){if(p+6>b.length||b.readUInt16LE(p)!==0xfefd)throw Error('Invalid mail attachment');p+=6+b.readUInt32LE(p+2);if(p>=b.length)throw Error('Truncated mail attachment');}
  return p+1-start;
}
function buildMailListPayload(records) {
  const head=Buffer.alloc(8);head.writeUInt32LE(records.length,4);
  return Buffer.concat([head,...records,Buffer.from([0])]);
}
module.exports = { mailRecordLength, buildMail, buildMailListPayload, parseMail, parseAttachments, attachmentPB, writeVarint, readVarint };

// ---------------- CLI：自检 / 对录制帧做逐字节复现 ----------------
if (require.main === module) {
  const CAP = process.argv[2] || path.join(__dirname, 'logs', 'cap-2026-09-27T02-56-55');
  const rd = require('./roledata');
  const all = [];
  for (const f of fs.readdirSync(CAP).filter(x => /frames\.bin$/.test(x))) {
    try { all.push(...rd.split(fs.readFileSync(path.join(CAP, f))).map(b => ({ msgid: b.readUInt16LE(8), body: b.subarray(12) }))); } catch { }
  }
  const frames = all.filter(m => m.msgid === 20308 || m.msgid === 20310).map(m => m.body);
  console.log(`抓包 ${path.basename(CAP)}：邮件帧 ${frames.length} 条\n`);
  let ok = 0, bad = 0;
  for (const b of frames) {
    const p = parseMail(b);
    const rebuilt = buildMail({
      mailId: p.mailId, f4: p.f4, playerId: p.playerId, time: p.time, f16: p.f16, serverId: p.serverId,
      h22: p.h22, h24: p.h24, h26: p.h26, title: p.titleRaw, body: p.bodyRaw,
      flag0: p.flag0, flag1: p.flag1,
      attachments: p.hasPb ? p.attachments : [],
    });
    const same = rebuilt.equals(b);
    if (same) ok++; else {
      bad++;
      if (bad <= 3) {
        console.log(`✗ 0x${p.mailId.toString(16)} ${b.length}B 复现失败（重建 ${rebuilt.length}B）`);
        for (let i = 0; i < Math.max(b.length, rebuilt.length); i++) if (b[i] !== rebuilt[i]) { console.log(`   首个不同字节 +${i}: 原=${b[i] === undefined ? '-' : b[i].toString(16)} 重建=${rebuilt[i] === undefined ? '-' : rebuilt[i].toString(16)}`); break; }
      }
    }
  }
  console.log(`逐字节复现：成功 ${ok} / ${frames.length}，失败 ${bad}`);
  const sample = frames.reduce((a, b) => (b.length > a.length ? b : a));
  const p = parseMail(sample);
  console.log(`\n样本 0x${p.mailId.toString(16)} 标题="${p.title}" 正文="${p.body}" 附件=${JSON.stringify(p.attachments)}`);
}
