#!/usr/bin/env node
/**
 * gold.js -- 金币 / 钻石（角色数据帧 1013，外层 msgid 1166，zlib）
 *
 * ## 结论（证据链）
 *
 * 大厅 HUD 上那串金币（截图放大后确认是 **516593**，旁边钻石 **0.08**）
 * 不在 1045 属性同步里、不在 11523/11553 资源表里、不在 20513 角色信息里 ——
 * 全量扫描 21841 帧（含 13 个 zlib 压缩帧解开后）**只有一处**出现 516593：
 *
 *     msgid=1166 帧（zlib, 6349B） 解开后 288458B，偏移 +141 的 u32
 *
 * 交叉验证：另一账号 `relay-2026-09-26T18-40-12-30000-002` 的同一条帧，
 * 同一偏移 +141 = **1675981**（该账号自己的金币），其余字段结构不变。
 * → +141 是角色数据里固定的金币字段。
 *
 * ## 帧结构
 *
 *   [外层 12B 头: u32 总长 | u32 会话 | u16 msgid=1166 | u16 flags]
 *   [zlib] -> 解开后:
 *       [内层 12B 头: u32 声明长 | u32 会话 | u16 msgid=1013 | u16 flags]
 *       [角色数据体 288458B]
 *
 * ## 发放金币的做法
 *
 * 把角色数据体里的 +141 改成新值 → 重新 zlib → 原样重发一条 1166 帧。
 * 登录时的那条 1166 也走同一函数，所以「初始金币」和「获得金币」是同一条路径。
 */
'use strict';
const fs = require('./persistence/state-files').io;
const path = require('path');
const zlib = require('zlib');
const rd = require('./roledata');

// 状态文件可以用环境变量指到别处 —— 测试脚本要用自己的钱包，别把正在跑的服务端的余额带跑偏
const STATE = process.env.DSH_GOLD_STATE || path.join(__dirname, 'gold-state.json');

/**
 * 货币属性表 —— **全部由真实服抓包实证**（logs/cap-2026-09-27T02-22-47 与 cap-2026-09-27T02-56-55）
 *
 *   50  金币        （8 次推送与用户口述逐个对上）
 *   72  钻石        （充值 10 元：`72:1008` = 10.08 元 ×100；充值前是 8 = 0.08 元）
 *   157 绑定钻石    （8800→8700→8500→7600 = 88→87→85→76，×100）
 *   52  VIP点       （110→120，充 10 元 +10 点 = 1 元 1 点）
 *   156 挑战币      （400）
 *   91  累计充值    （236000→237000 = 2360→2370 元，×100）
 *   158 1000 / 170 1200：含义未定
 *
 * 推送格式（逐字节）：`msgid=1045  u8 n | n×(u8 属性ID + u32 新值)`，
 * 帧头 `f4 = 1345739761`（玩家ID），`flags` 实测 0xd2/0xd3 都用过。
 */
const ATTR = { gold: 50, diamond: 72, bindDiamond: 157, vip: 52, challengeCoin: 156, rechargeTotal: 91, mobius: 141 };
/** ATTR_NAME 里的属性 = **服务端说了算**：登录时按钱包基线推一遍，回放录制时也要把旧值剔除
 *  （否则录制里的 7600/1008/110 会把 HUD 盖回旧数 —— 用户实测"只有金币对了，其他都不对"） */
const ATTR_NAME = { 50: '金币', 72: '钻石', 157: '绑定钻石', 52: 'VIP点', 156: '挑战币', 91: '累计充值', 141: '莫比乌斯币', 131:'功勋',181:'zen币' };

/** 道具名 → 该加哪个属性、加多少 */
function currencyOfItem(name) {
  if (!name) return null;
  const t = name.trim();
  let m = /^(\d+)\s*绑定钻石$/.exec(t);
  if (m) return { kind: 'bindDiamond', attr: ATTR.bindDiamond, amount: +m[1] };
  if (/^绑定钻石$/.test(t)) return { kind: 'bindDiamond', attr: ATTR.bindDiamond, amount: 1 };
  m = /^(\d+)\s*钻石$/.exec(t);
  if (m) return { kind: 'diamond', attr: ATTR.diamond, amount: +m[1] };
  if (/^钻石$/.test(t)) return { kind: 'diamond', attr: ATTR.diamond, amount: 1 };
  m = /^(\d+)\s*金币$/.exec(t);
  if (m) return { kind: 'gold', attr: ATTR.gold, amount: +m[1] };
  if (/^金币$/.test(t)) return { kind: 'gold', attr: ATTR.gold, amount: 1 };
  // 「N金币礼包」= 开出来就是 N 金币（邮件附件里就是这种；不这么映射的话它是个"用了没反应"的道具）
  m = /^(\d+)\s*金币礼包$/.exec(t);
  if (m) return { kind: 'goldbox', attr: ATTR.gold, amount: +m[1] };
  if (/金币礼包$/.test(t)) return { kind: 'goldbox', attr: ATTR.gold, amount: 0 };
  return null;
}

class Wallet {
  /**
   * @param {Buffer} roleFrame 录制里那条 msgid=1166 的完整帧（含 12B 头）
   */
  constructor(roleFrame, log = console.log, {accountMode = false} = {}) {
    if (typeof accountMode !== 'boolean') throw Error('Explicit wallet account mode must be boolean');
    this.accountMode = accountMode;
    this.log = log;
    this.frame = roleFrame;
    this.blob = roleFrame ? Buffer.from(rd.inflate(roleFrame.subarray(12)) || Buffer.alloc(0)) : null;
    this.session = roleFrame ? roleFrame.readUInt32LE(4) : 0;
    this.recordedGold = this.blob && this.blob.length > rd.GOLD_OFF + 4 ? rd.goldOf(this.blob) : null;
    this.state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
    if (!accountMode && this.state.gold === undefined && this.recordedGold !== null) this.state.gold = this.recordedGold;
    // 通用货币属性表：{ 属性ID: 值 } —— 50=金币 72=钻石 157=绑定钻石 …（真实服实证，见文件头）
    this.attrs = this.state.attrs || {};
    if (this.state.gold !== undefined && this.attrs[ATTR.gold] === undefined) this.attrs[ATTR.gold] = this.state.gold;
    for (const [k, v] of Object.entries(this.state.attrs || {})) this.attrs[+k] = v;
    this.gold = this.attrs[ATTR.gold];
  }

  get ok() { return !!(this.blob && this.blob.length > rd.GOLD_OFF + 4); }

  // The capture is a wire template in account mode, not a balance recovery.
  // Keep legacy first-observation/default behavior behind the explicit mode.
  seedRecordedBalances(frames) {
    if (this.accountMode) return;
    for (const frame of frames) {
      if (frame.length < 13 || frame.readUInt16LE(8) !== 1045) continue;
      const pay = frame.subarray(12), n = pay[0];
      if (1 + n * 5 !== pay.length) continue;
      for (let i = 0; i < n; i++) {
        const id = pay[1 + i * 5];
        if (this.attrs[id] === undefined) this.attrs[id] = pay.readUInt32LE(2 + i * 5);
      }
    }
    if (this.state.honour === undefined) {
      const frame = frames.find(frame => frame.length === 16 && frame.readUInt16LE(8) === 1394);
      this.state.honour = frame ? frame.readUInt32LE(12) : 0;
    }
    for (const id of [131,181]) if (this.attrs[id] === undefined) this.attrs[id] = 0;
  }

  save(strict = false) {
    this.state.gold = this.gold;
    this.state.attrs = this.attrs;
    this.state.updatedAt = new Date().toISOString();
    try { fs.writeFileSync(STATE, JSON.stringify(this.state, null, 2)); } catch (error) { if (strict) throw error; }
  }

  /** 把当前金币写进角色数据并重新打包成完整 1166 帧
   *  @param slots 可选：背包模型 Map<格子,{itemId,count,guid}> —— 一起写进去，
   *         否则客户端会拿帧里**录制时**的背包重画，"用掉的道具又回来了"。
   *  @param bagMode 'safe' | 'full'（见 roledata.syncBag）
   *  @param emptyMarker 空格子写 0xFFFF（默认）还是 0 —— 见 roledata.syncBag 的说明
   */
  frameWithGold(value = this.gold, slots = null, bagMode = 'safe', emptyMarker = 0xFFFF,
    recordPatch = null, equipmentFrames = null, visibleCapacity = 192, rolePatch = null) {
    if (!this.ok || (this.accountMode && (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff))) return null;
    let b = Buffer.from(this.blob);
    const before = b.readUInt32LE(rd.GOLD_OFF);
    b.writeUInt32LE((value >>> 0), rd.GOLD_OFF);
    let bagInfo = null;
    if (slots) { const r = rd.syncBag(b, slots, bagMode, emptyMarker, recordPatch,visibleCapacity); b = r.blob; bagInfo = r; }
    if(equipmentFrames)b=rd.syncEquipment(b,equipmentFrames);
    if(rolePatch)b=rolePatch(b);
    const r = rd.buildFrame(b, this.frame, this.session);
    this.lastBuild = { before, after: value, compressed: r.compressed, blob: b.length, bag: bagInfo };
    return r.frame;
  }

  /** 加/减某个货币属性，返回新值。attr 见 ATTR（50=金币 72=钻石 157=绑定钻石 …） */
  addAttr(attr, amount) {
    if (!this.attrs) this.attrs = {};
    const cur = this.attrs[attr] === undefined ? null : this.attrs[attr];
    if (cur === null) return null;                 // 这个属性还没有基线，不能瞎加（见 liveserver 的 seed）
    this.attrs[attr] = Math.max(0, cur + amount);
    if (attr === ATTR.gold) this.gold = this.attrs[attr];   // gold 是 attrs[50] 的别名，落盘要用它
    this.save();
    return this.attrs[attr];
  }
  /** 加/减金币，返回新值 */
  add(amount) { return this.addAttr(ATTR.gold, amount); }
}

module.exports = { Wallet, currencyOfItem, GOLD_OFF: rd.GOLD_OFF, ATTR, ATTR_NAME };
