#!/usr/bin/env node
/**
 * liveserver.js -- 按客户端实时请求推进的服务端（取代盲目定时回放）
 *
 * 为什么要这样：真实服不是「一问一答」。客户端�?*流水�?*发一串请求，
 * 服务端按阶段**成批**下发。所以推进的节奏应该由「客户端走到了哪一步」决定，而不是墙上的时钟�? *
 * 触发模型（比 chain.js 的定时回放稳，也比「第 k 条消息」稳）：
 *   录制时给每个 S->C 帧标注触发它的那条客户端请求 = (msgid, �?msgid 的第几次出现)�? *   把触发条件相同的连续 S->C 帧并成一�?batch�? *   运行时：连入 -> �?connect 批；收到 msgid=m 且这是第 n �?-> �?trigger={m,n} 的批�? *   这样客户端多�?少发无关消息都不会让后面的批次错位�? *   兜底：客户端静默超过 --safety 毫秒且还有批次没�?-> 直接推下一批，并在日志里标警告�? *
 * 出错分类（本日志 + 客户�?app log 对照）：
 *   收到请求但没有对应批�?         -> 逻辑没写（或该请求本来就不需要应答）
 *   兜底推送被触发                  -> 客户端进度与录制不一致，需要更�?更贴近的录制
 *   批次推完了客户端还在请求        -> 数据缺了（录制的会话不够长）
 *
 * 用法:
 *   node liveserver.js --cap=logs/cap-2026-09-26T19-43-21 --ports=30000,30001
 *   node liveserver.js --cap=logs/gsdbg-session5-... --ports=31099 --safety=0
 */
'use strict';
const net = require('net');
const fs = require('./persistence/state-files').io;
const path = require('path');
const battleOwnership = require('./battle-ownership');
const loadoutPageWire = require('./loadout-page-wire');
const {isEnhancementResource, isResourceItem, MAGIC_RESOURCE_IDS, addResourceBalance, findLegacyResourceSlots} = require('./enhancement-resources');

// Windows can briefly deny an atomic replace while the client, indexer, or
// backup scanner still has the destination open.  Keep the replace atomic;
// retry only the transient sharing violations instead of falling back to an
// in-place write that could leave a partial state document.
function renameWithRetry(from, to, attempts = 24) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      last = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 50 * (i + 1));
    }
  }
  throw last;
}

const SEED = 0xcd;
const runtimeOptions=require('./runtime/options').parseOptions(process.argv.slice(2));
const {argOf}=runtimeOptions;
const CLIENT_PROGRESS_FIXTURE = argOf('progression-fixture','') === 'client';
require('./runtime/catalogs').assertRelease();
const stateBackend=require('./persistence/bootstrap').bootstrap({options:runtimeOptions});
// Validate before loading or repairing any persistent state.
const BAG_VISIBLE_CAPACITY = runtimeOptions.visibleCapacity;
const BAG_RECORD_CAPACITY = runtimeOptions.recordCapacity;
if(!require('./inventory-capacity').validLimits(BAG_VISIBLE_CAPACITY,BAG_RECORD_CAPACITY))
  throw new Error('Invalid bag capacity/record space: client cache supports <=352; role records may be 552');
const MAIL_STATE_FILE = process.env.DSH_MAIL_STATE || path.join(__dirname, 'mail-state.json');
const MAIL_STATE = new (require('./mail-state').MailState)(MAIL_STATE_FILE);
const EQUIPMENT_PENDING_FILE = process.env.DSH_EQUIPMENT_PENDING ||
  path.join(path.dirname(process.env.DSH_BAG_STATE || path.join(__dirname,'bag-state.live.json')),
    'equipment-economy-pending.json');
const EQUIPMENT_COMMIT = new (require('./equipment-economy-commit').EquipmentEconomyCommit)(EQUIPMENT_PENDING_FILE);
const gemRules = require('./gem-board');
const gemCrafting = require('./gem-crafting');
const GEM_BOARD = new gemRules.GemBoard();
const soulRules=require('./equipment-soul');
const SOULS=new soulRules.SoulState();
const progressionProtocol=require('./progression-protocol');
const magicDeviceLive=require('./magic-device-live');
let magicCapturedGems=null;
function hydrateMagicGems(){
  if(!magicCapturedGems)magicCapturedGems=magicDeviceLive.captureGemIndex([
    path.join(__dirname,'logs/cap-2026-10-05T08-23-25/events.jsonl'),
    path.join(__dirname,'logs/cap-2026-10-07T07-59-09/events.jsonl')]);
  if(BAG?.slotMap)magicDeviceLive.hydrate(PROGRESSION.magicGem,BAG.slotMap,magicCapturedGems);
}
const runeModule=require('./rune-system');
const {writeRuneAttributeTriples}=require('./rune-wire');
const warSoulModule=require('./war-soul');
const warSoulEntry=require('./war-soul-entry');
const warSoulTransaction=require('./player-war-soul-transaction');
const warSoulWire=require('./player-war-soul-wire');
const progressionDir=path.dirname(process.env.DSH_BAG_STATE||path.join(__dirname,'bag-state.live.json'));
const PROGRESSION={
  rune:new runeModule.RuneState({file:path.join(progressionDir,'rune-state.json')}),
  magicGem:new (require('./magic-gem-system').MagicGemState)({file:path.join(progressionDir,'magic-gem-state.json')}),
  exstore:new (require('./exstore').ExStoreState)({file:path.join(progressionDir,'exstore-state.json'),capacity:42}),
  warehouse:new (require('./exstore').ExStoreState)({file:path.join(progressionDir,'warehouse-state.json'),capacity:42}),
  itemLock:new (require('./item-lock-state').ItemLockState)({file:path.join(progressionDir,'item-lock-state.json')}),
  warSoul:new warSoulModule.WarSoulState({file:path.join(progressionDir,'war-soul-state.json')}),
  crafting:new (require('./equipment-crafting').EquipmentCrafting)({file:path.join(progressionDir,'equipment-crafting-state.json')}),
};
if(argOf('progression-fixture','')==='client'){
  try{
    const fixture=require('./client-test-fixture').seedClientFixture(progressionDir,PROGRESSION);
    console.log(`客户端进阶测试档案已就绪：材料 ${fixture.materials.count} 类；${fixture.changes.join('，')||'沿用已有状态'}`);
  }catch(error){
    throw new Error(`无法准备客户端进阶测试档案：${error.message}`);
  }
}
const ECONOMY_PENDING_VIEW=require('./player-economy-pending-view').create({file:EQUIPMENT_PENDING_FILE,journal:EQUIPMENT_COMMIT,stateFiles:require('./persistence/state-files')});
const economyPendingState = () => {
  const observed=ECONOMY_PENDING_VIEW.view();
  try{return {...observed,frozen:MAIL_STATE.hasUnresolvedPending()||observed.frozen};}
  catch{return {...observed,frozen:true};}
};
const economyFrozen = () => economyPendingState().frozen;
const ECONOMY_WRITE_MESSAGES = new Set([17002,11670,13546,13504,13502,13512,13518,13553,13575,13537,13562,13630,13631,13632,16811,20303,20305,17005,17012,17003,13542,
  13558,13560,13578,11679,11681,11683,11685,11689,11691,13580,13584,13586,13588,13593,13595,13624,13625,13610,13612,13614,13616,13618,13620,
  36267,36269,36271,36274,36297,36298,36299,36300,36301,36302,36303,13554,11759,11761,11888,1456,1458,17044,17046,17048,17062,17064,17066,9018,27613]);
// Queries and the alternate native selector/filter tags also expose or change
// the private rune state. They need the same authenticated/finalized account
// boundary as economic writes, without changing legacy capture-only servers.
ECONOMY_WRITE_MESSAGES.add(1086);
ECONOMY_WRITE_MESSAGES.add(11783);
const ACCOUNT_RUNE_MESSAGES = new Set([11671,11677,11679,11681,11683,11685,11687,11689,11691,9155,9157,11854,11783,11759,11761]);
const ACCOUNT_RUNE_REPLIES = new Set([11678,11680,11682,11684,11686,11688,11690,9156,9158,11855,11784,11760,11762]);
const ACCOUNT_WAR_SOUL_MESSAGES = new Set([36267,36269,36271,36274,36295,36297,36298,36299,36300,36301,36302,36303,36304]);
const ACCOUNT_WAR_SOUL_REPLIES = new Set([36268,36270,36272,36273,36275,36296]);
// Captured Pokemon lists contain historical assets and worn selections. Their
// zero expiry words do not prove permanent ownership. Until the corresponding
// authority and refresh chains are implemented, neither queries nor writes
// may fall through to a captured list or success acknowledgement.
const ACCOUNT_PET_MESSAGES = new Set([9034,9036,9038,9150]);
const ACCOUNT_PET_REPLIES = new Set([9035,9037,9039,9151,9152]);
// 9159 replaces the whole KV table, including appearance choices as well as
// privacy. Unknown KV rules cannot be replaced by a guessed key10-only table.
const ACCOUNT_KV_MESSAGES = new Set([9160]);
const ACCOUNT_MAIL_MESSAGES = new Set([20303,20305,20306,20307]);
const ACCOUNT_MAIL_REPLIES = new Set([20308,20309,20310,20311,20313]);
const ACCOUNT_ONLINE_MESSAGES = new Set([11532,11543,11545,11547]);
// These replies contain a role, owned assets or account balances. A direct
// initialization trigger must not publish them before the verified 1012.
const ACCOUNT_PRIVATE_INITIALIZATION = new Set([1013,1166,1043,1045,1014,11523,11552,11553,1337,1338,1372,13535,13590,13594,13596,1394,1439,9019,9020,27614,27615]);

const CAP = runtimeOptions.cap;
const PORTS = runtimeOptions.ports;
const SAFETY = runtimeOptions.safety;
const PATCH_ACCT = argOf('patch-account', '1') !== '0';
if (!CAP) { console.error('必须�?--cap=<抓包目录>'); process.exit(2); }

// The replay capture carries the game's clock from the capture date.  Native
// countdown widgets subtract that clock from the absolute expiry timestamp;
// using the host clock here makes a 24-hour local activation render as several
// days old.  Keep the wire timestamp on the capture clock while the state
// machine continues to use the real host clock for expiry checks.
const CAPTURE_CLOCK_BASE_MS = (() => {
  const match = String(CAP).match(/cap-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/i);
  if (!match) return 0;
  const iso = `${match[1]}:${match[2]}:${match[3]}Z`;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
})();
const CAPTURE_CLOCK_STARTED_MS = Date.now();
const wireClockNowMs = () => CAPTURE_CLOCK_BASE_MS
  ? CAPTURE_CLOCK_BASE_MS + (Date.now() - CAPTURE_CLOCK_STARTED_MS)
  : Date.now();

// ================= 载入会话 =================
function splitFrames(buf) {
  const fr = []; let o = 0;
  while (o + 12 <= buf.length) {
    const t = buf.readUInt32LE(o);
    if (t < 12 || o + t > buf.length) break;
    fr.push(Buffer.from(buf.subarray(o, o + t))); o += t;
  }
  return fr;
}

function loadSession(dir) {
  const evFile = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(evFile)) throw new Error('找不�?' + evFile);
  const all = fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const hasConn = all.some(e => e.c);

  let ev = all, frames, mode;
  if (hasConn) {
    mode = 'caprelay';
    const byC = new Map();
    for (const e of all) if (e.dir === 's2c') byC.set(e.c, (byC.get(e.c) || 0) + 1);
    const best = [...byC.entries()].sort((a, b) => b[1] - a[1])[0][0];
    ev = all.filter(e => e.c === best);
    const f = path.join(dir, `s2c-${best}.frames.bin`);
    if (!fs.existsSync(f)) throw new Error('找不�?' + f);
    frames = splitFrames(fs.readFileSync(f));
    console.log(`caprelay 模式：连�?${best}，S->C ${frames.length} 帧（字节完整）`);
  } else {
    mode = 'gsdbg';
    frames = ev.filter(e => e.dir === 's2c').map(e => {
      const b = Buffer.alloc(Math.max(e.len, 12));
      Buffer.from(e.hex, 'hex').copy(b);
      return b;
    });
    console.log(`gsdbg 模式：S->C ${frames.length} 帧（来自 gs_0.log，大帧内容被截断，仅 msgid/长度可信）`);
  }

  // 按顺序走事件，给每个 S->C 帧算出触发它的请�?
  const occ = new Map();
  let last = null;                       // {msgid, occ} �?null(=连入)
  const s2cMeta = [];
  const reqLog = [];
  for (const e of ev) {
    if (e.dir === 'c2s') {
      const n = (occ.get(e.msgid) || 0) + 1; occ.set(e.msgid, n);
      last = { msgid: e.msgid, occ: n };
      reqLog.push({ msgid: e.msgid, len: e.len, occ: n });
    } else {
      s2cMeta.push({ trigger: last, msgid: e.msgid, len: e.len });
    }
  }
  const n = Math.min(frames.length, s2cMeta.length);
  if (frames.length !== s2cMeta.length) console.log(`注意：帧�?${frames.length} 与事件数 ${s2cMeta.length} 不一致，�?${n} 处理`);

  // 触发条件相同的连续帧并成一�?
  const batches = [];
  const key = t => t ? `${t.msgid}#${t.occ}` : 'connect';
  for (let i = 0; i < n; i++) {
    const m = s2cMeta[i], k = key(m.trigger);
    if (!batches.length || batches[batches.length - 1].key !== k)
      batches.push({ key: k, trigger: m.trigger, frames: [] });
    batches[batches.length - 1].frames.push({ frame: frames[i], msgid: m.msgid, len: m.len });
  }
  const byKey = new Map(batches.map(b => [b.key, b]));
  // 哪些请求「重复发可以拿到同样的应答」——只有这些才允许在录制用完后回退重发第一批�?  // 判据是数据驱动：同一 msgid 的多次出现，如果每次的应答帧签名完全一样，才算可重复�?  // 反例�?7002（按格子查询），每次答的道具都不同，绝不能回退 —�?否则点未知格子会拿到
  //       �?13 格的答案，客户端就显示成「不符合我开的道具名」的奇怪东西�?
  const sig = b => b.frames.map(f => `${f.msgid}:${f.len}`).join('|');
  const byMsg = new Map();
  for (const b of batches) {
    const m = /^(\d+)#(\d+)$/.exec(b.key);
    if (!m) continue;
    if (!byMsg.has(+m[1])) byMsg.set(+m[1], []);
    byMsg.get(+m[1]).push(sig(b));
  }
  const repeatable = new Set();
  for (const [msgid, sigs] of byMsg) if (sigs.length >= 2 && sigs.every(s => s === sigs[0])) repeatable.add(msgid);
  const answered = new Set(reqLog.map(r => `${r.msgid}#${r.occ}`));
  return { mode, batches, byKey, repeatable, reqLog, answered, totalFrames: n };
}

const S = loadSession(CAP);
const CAPTURE_REQUEST_PAYLOAD = new Map();
try {
  for (const line of fs.readFileSync(path.join(CAP, 'events.jsonl'), 'utf8').split(/\r?\n/)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.dir === 'c2s' && [1456, 1458].includes(Number(event.msgid)) && !CAPTURE_REQUEST_PAYLOAD.has(Number(event.msgid)))
      CAPTURE_REQUEST_PAYLOAD.set(Number(event.msgid), Buffer.from(String(event.hex || ''), 'hex').subarray(12));
  }
} catch { }
console.log(`批次 ${S.batches.length} 个（最大一�?${Math.max(0, ...S.batches.map(b => b.frames.length))} 帧），共 ${S.totalFrames} �?/ ${S.reqLog.length} 条客户端请求`);
// The capture contains valid native acknowledgement envelopes for the
// progression panels.  Use them as a conservative wire fallback until the
// account-specific state encoders are available; mutations still go through
// the live state machines above.
const CAPTURED_NATIVE_ACK = new Map();
const CAPTURED_NATIVE_PREVIEW_ACK = new Map();
for(const batch of S.batches) for(const packet of batch.frames){
  if(!CAPTURED_NATIVE_ACK.has(packet.msgid)) CAPTURED_NATIVE_ACK.set(packet.msgid,Buffer.from(packet.frame));
}
let ACCOUNT_KILL_EFFECT_TEMPLATE;
for(const batch of S.batches)for(const packet of batch.frames){
  if(packet.msgid!==9019||packet.frame.length!==20||packet.frame.readUInt32LE(16)!==6||ACCOUNT_KILL_EFFECT_TEMPLATE)continue;
  require('./player-kill-effect-wire').decode(packet.frame);ACCOUNT_KILL_EFFECT_TEMPLATE=Buffer.from(packet.frame);
}
let ACCOUNT_FIGHT_DRESS_TEMPLATE;
for(const batch of S.batches)for(const packet of batch.frames){
  if(packet.msgid!==9019||packet.frame.length!==20||packet.frame.readUInt32LE(16)!==9||ACCOUNT_FIGHT_DRESS_TEMPLATE)continue;
  const model=require('./player-fight-dress').decode(packet.frame);
  if(model.header.readUInt32LE(4)===0)ACCOUNT_FIGHT_DRESS_TEMPLATE=Buffer.from(packet.frame);
}
const ACCOUNT_FRAME_LIST_TEMPLATE=CAPTURED_NATIVE_ACK.get(27615);
const progressionAck = Object.freeze({
  11677:11678, 11687:11688, 11679:11680, 11681:11682, 11683:11684, 11685:11686,
  11759:11760, 11761:11762,
  1456:1457, 1458:1459,
  9155:9156, 9157:9158, 11854:11855,
  13580:13581, 13584:13585, 13586:13587, 13588:13589, 13622:13623,
  36267:36268, 36269:36270, 36271:36272, 36274:36275, 36295:36296,
});
// The current login capture does not contain every small panel acknowledgement
// (notably rune exchange/strengthen). Reuse the longest matching native
// response from the older progression capture when the live capture has none.
// These are wire envelopes only; mutation data still comes from live state.
try {
  // Keep the two native result envelopes separate.  11682/11684 use the
  // same message id for preview and commit, but the trailing status bytes
  // tell the client which path it is on.  Reusing the first captured frame
  // for both paths makes a refresh look like a completed operation.
  const fallbackFiles=[
    path.join(__dirname,'logs','cap-2026-09-26T21-26-40','events.jsonl'),
    // This capture contains the native demolish envelopes; the older one
    // has the most complete strengthen sequence.
    path.join(__dirname,'logs','cap-2026-10-04T12-34-47','events.jsonl'),
  ];
  for(const fallbackFile of fallbackFiles) if(fs.existsSync(fallbackFile)){
    const fallbackRows=fs.readFileSync(fallbackFile,'utf8').split(/\r?\n/).filter(Boolean);
    for(const line of fallbackRows){
      let event; try{event=JSON.parse(line);}catch{continue;}
      if(event?.dir!=='s2c'||(!Object.values(progressionAck).includes(Number(event.msgid))&&Number(event.msgid)!==11855)||!event.hex)continue;
      const frame=Buffer.from(event.hex,'hex'), tag=Number(event.msgid);
      // The 10/04 capture uses a different 11682 tail variant and contains
      // several unrelated panel refreshes.  Keep the paired 09/26
      // strengthen envelopes above; use this file only for 11684, which the
      // active login capture lacks entirely.
      if(tag===11682&&fallbackFile.includes('cap-2026-10-04T12-34-47')) continue;
      if(tag===11682){
        // Current native d832ec dispatches the111-byte envelope by byte106:
        // zero enters commit/error handling, nonzero enters the preview.
        // The nearby DWORDs at90/94/98 are formatted values, not an onlyId.
        if(frame.length!==111||![0,1].includes(frame[106]))continue;
        const preview=frame[106]===1;
        if(preview&&!CAPTURED_NATIVE_PREVIEW_ACK.has(tag)) CAPTURED_NATIVE_PREVIEW_ACK.set(tag,frame);
        if(!preview) CAPTURED_NATIVE_ACK.set(tag,frame);
        continue;
      }
      if(tag===11684){
        const preview=frame.length>=99&&frame[86]===0x00&&frame[90]===0x01;
        if(preview&&!CAPTURED_NATIVE_PREVIEW_ACK.has(tag)) CAPTURED_NATIVE_PREVIEW_ACK.set(tag,frame);
        if(!preview) CAPTURED_NATIVE_ACK.set(tag,frame);
        continue;
      }
      const prior=CAPTURED_NATIVE_ACK.get(tag);
      // The current login capture contains a zero-filled placeholder for
      // 11855. Prefer the real native determination packet from the older
      // progression capture even when both envelopes have the same length.
      if(tag===11855 || !prior || frame.length>prior.length)CAPTURED_NATIVE_ACK.set(tag,frame);
    }
  }
} catch(error) { console.warn(`进阶确认包回退加载失败：${error.message}`); }
// Public builds omit private fallback captures. Register only the neutral,
// validated variants prepared from the pinned accepted sources. Register
// templates directly rather than scheduling fake successful operations.
if(process.env.DSH_PUBLIC_BETA==='1'){
  const nativeSeed=require('./public-beta/native-seed');
  if(Number(process.env.DSH_PLAYER_UID)!==nativeSeed.UID)throw Error('Public feature templates require the local admin account');
  if(!nativeSeed.isPrivateOriginal){
    const features=nativeSeed.isPublicSnapshot?nativeSeed.featureFrames():require('./public-beta/reference-feature-frames').create({
      featureFramesHex:require('./public-beta/reference-assets/manifest.json').featureFramesHex,
      playerId:nativeSeed.PLAYER_ID,
    });
    for(const {frame}of features.templateFrames)CAPTURED_NATIVE_ACK.set(frame.readUInt16LE(8),frame);
    for(const {frame}of features.previewFrames)CAPTURED_NATIVE_PREVIEW_ACK.set(frame.readUInt16LE(8),frame);
  }
}
// The native rune dialog sends the same strengthen/demolish selection more
// than once while it waits for the acknowledgement animation.  Keep the
// last successful result keyed by the logical selection (the trailing
// preview/confirm byte is intentionally excluded) so a retry replays the
// acknowledgement instead of consuming the same runes a second time.
const RECENT_RUNE_MUTATIONS = new Map();
function runeMutationKey(request) {
  if(request?.system!=='rune'||!['strengthen','demolish'].includes(request.operation)) return null;
  const args=Array.isArray(request.rawArgs)?request.rawArgs.join(','):'';
  return `${request.operation}:${args}`;
}
function simulateRuneMutation(request) {
  const source=PROGRESSION.rune;
  const makeShadow=random=>{
    const shadow=Object.create(Object.getPrototypeOf(source));
    shadow.file=source.file;
    shadow.random=random||source.random;
    shadow.state=JSON.parse(JSON.stringify(source.state));
    shadow.save=()=>{};
    return shadow;
  };
  // Run the exact state-machine operation against an in-memory copy. This
  // guarantees that panel refreshes never consume inventory or fragments.
  if(request.operation==='demolish') return makeShadow().demolish({id:request.id});
  const ids=Array.isArray(request.materialIds)?request.materialIds:[];
  const native=!(request.mainId||request.runeId);
  const mainId=request.mainId||request.runeId||ids[0];
  const materialIds=native?ids.slice(1):ids;
  // A strengthen preview is a possibility set.  The live client uses the
  // descriptor's attribute list to render every eligible next line; sending
  // one RNG roll here incorrectly turns the preview into a fake final result.
  // Sample every selection bucket on isolated copies, then merge the possible
  // newly unlocked attributes while retaining the upgraded base lines.
  const trials=[];
  const buckets=64;
  for(let i=0;i<buckets;i++){
    const unit=(i+0.5)/buckets;
    const result=makeShadow(()=>unit).strengthen({mainId,materialIds});
    if(result?.ok&&result.rune) trials.push(result);
  }
  if(!trials.length) return {ok:false,reason:'rune-material-not-found'};
  const first=trials[0], original=source.state.inventory[String(mainId)]||
    Object.values(source.state.inventory||{}).find(entry=>String(entry.id)===String(mainId));
  const baseAttrs=new Set(Object.keys(original?.attrs||{}));
  const possible=new Map();
  const colors=new Set();
  for(const trial of trials){
    colors.add(Number(trial.rune.color));
    for(const [attr,value] of Object.entries(trial.rune.attrs||{}))
      if(!baseAttrs.has(String(attr))) possible.set(String(attr),Number(value)||0);
  }
  const preview=JSON.parse(JSON.stringify(first.rune));
  for(const [attr,value] of possible) preview.attrs[attr]=value;
  if(colors.size>1||colors.has(5)){
    preview.color=5; preview.colorName='multi';
    try{
      const row=runeModule.template(5,Number(preview.level));
      preview.itemId=row.itemId; preview.name=row.name;
    }catch{}
  }
  preview.attrs=runeModule.sortRuneAttrs(preview.attrs||{});
  preview.nativeAttrIds=runeModule.orderedRuneAttrs(preview.attrs).map(([id])=>Number(id));
  return {...first,rune:preview};
}
function liveRuneInfoAck() {
  return bagMod.mkFrame(11678, loadoutPageWire.runeInfoPayload(PROGRESSION.rune.state), { flags: 0xd3 });
}
function liveRunePageAck(index = PROGRESSION.rune.state.currentPage) {
  const payload = loadoutPageWire.runePagePayload(PROGRESSION.rune.state, index);
  return payload ? bagMod.mkFrame(11680, payload, { flags: 0xd3 }) : null;
}
function liveRuneExchangeAck(result) {
  const template=CAPTURED_NATIVE_ACK.get(11686), runes=Array.isArray(result?.runes)&&result.runes.length?result.runes:result?.rune?[result.rune]:[];
  if(!template||!runes.length||!bagMod) return null;
  // 11686 uses: u32 count, count × 35-byte rune records, u32 trailer.
  // The descriptor fields are a six-byte reserved prefix, itemId(u16),
  // level, colour, attrCount, then contiguous attr id/u16-value triples;
  // the remaining bytes are reserved by the native client. Keep the
  // envelope/flags from the capture and fill the records from the live result.
  const payload=Buffer.alloc(8+runes.length*35);
  payload.writeUInt32LE(runes.length,0);
  for(const [index,rune] of runes.entries()){
    const offset=4+index*35;
    // The compose acknowledgement's six-byte prefix is reserved/zero in
    // every native capture.  The persistent onlyId is assigned by the list
    // response (11688), not copied into this result record.
    payload.writeUInt16LE(Number(rune.itemId)||0,offset+6);
    // Native rune descriptors store level before colour: itemId, level,
    // colour, attrCount, then attr id/value pairs.
    payload[offset+8]=Number(rune.level)||0;
    payload[offset+9]=Number(rune.color)||0;
    const attrs=runeModule.orderedRuneAttrs(rune.attrs||{});
    // Native rune attributes are three bytes each: attribute id followed by
    // a little-endian u16 value. There is no padding byte between records.
    const count=Math.min(Math.floor((35-10)/3),attrs.length);
    payload[offset+10]=count;
    writeRuneAttributeTriples(payload,offset+11,attrs,count);
    // Level-V exchange results carry the godsend table key in the final
    // reserved byte of the 35-byte native descriptor. Without this byte the
    // result popup resolves the newly created rune as an unknown/stale entry.
    payload[offset+6+0x1c]=Number(rune?.level)===5 ? (Number(rune?.godsendId)||0) & 0xff : 0;
  }
  return bagMod.mkFrame(11686,payload,{flags:template.readUInt16LE(10),stream:template.readUInt32LE(4)});
}
// Senior exchange has its own native handler (11784).  The first u32 is a
// result code (zero means success), followed by the generated rune record;
// ordinary compose's leading count is not valid here.  Keep this envelope
// isolated so a native capture can replace it without touching 11686.
function liveRuneSeniorExchangeAck(result) {
  const template = CAPTURED_NATIVE_ACK.get(11682), rune =
    Array.isArray(result?.runes) && result.runes.length ? result.runes[0] : result?.rune;
  if (!template || !bagMod || !result?.ok || !rune) return null;
  // CharmGet's confirmed 11682 envelope is fixed at 99 payload bytes: a
  // six-byte operation header followed by source/result 35-byte records and
  // an 11-byte tail. The 11784 handler reads the first record for CharmGet;
  // the second-record placement showed the captured stale red level-one
  // rune. Put the generated result at offset 6 and clear the old second
  // record. Only the message tag changes to 11784.
  const frame = Buffer.from(template), payload = frame.subarray(12);
  const seniorRecord = runeAckDescriptor(rune);
  // Do not encode the godsend table key as a sixth synthetic attribute.  The
  // native mapper renders attr id 3 as RESERVE_3 with an empty label, so the
  // value leaks into the result tooltip as a misleading raw “+<id>”.  The
  // verified 11688 list record remains the sole source of the godsend state
  // until a real senior-compose capture exposes a name-bearing field.
  seniorRecord.copy(payload, 6);
  payload.fill(0, 6 + 35, 6 + 70);
  frame.writeUInt16LE(11784, 8);
  return frame;
}
function runeAckDescriptor(rune) {
  const record=Buffer.alloc(35), attrs=runeModule.orderedRuneAttrs(rune?.attrs||{});
  record.writeUInt16LE(Number(rune?.itemId)||0,0);
  // Native rune descriptors store level before colour.
  record[2]=Number(rune?.level)||0;
  record[3]=Number(rune?.color)||0;
  const count=Math.min(Math.floor((record.length-5)/3),attrs.length);
  record[4]=count;
  writeRuneAttributeTriples(record,5,attrs,count);
  // Native result descriptors keep the godsend table key in byte 28
  // (0x1c), after the normal attribute area.  The level-V result callback
  // reads this byte and resolves the display name through charmexeffect;
  // putting it in the reserved tail or in 11855 makes the pity UI change
  // while leaving the result popup blank.
  record[0x1c]=Number(rune?.level)===5 ? (Number(rune?.godsendId)||0) & 0xff : 0;
  return record;
}
function liveRuneStrengthenAck(result) {
  const template=(result?.preview&&CAPTURED_NATIVE_PREVIEW_ACK.get(11682))||CAPTURED_NATIVE_ACK.get(11682), rune=result?.rune;
  if(!template||!rune) return null;
  const frame=Buffer.from(template), payload=frame.subarray(12);
  // 11682: six-byte operation header, then the selected/source descriptor
  // and the resulting descriptor. Native captures leave the first record
  // unchanged and put the upgraded rune in the second 35-byte record.
  if(result?.sourceRune) runeAckDescriptor(result.sourceRune).copy(payload,6);
  runeAckDescriptor(rune).copy(payload,6+35);
  // Current native preview reads DWORD102 as CharmRaise_NumToSpecial's
  // small-pity count. It is a current business value, not a captured marker.
  if(frame.length===111){
    const smallPity=Number(PROGRESSION.rune.godsendInfo().smallPity);
    if(!Number.isInteger(smallPity)||smallPity<0||smallPity>10)return null;
    frame.writeUInt32LE(smallPity,102);
  }
  return frame;
}
function liveRuneDemolishAck(result) {
  // Native 11684 is a 99-byte demolish envelope.  The first record is the
  // source descriptor without its item id; the second is the lowered rune
  // descriptor.  A level-I dismantle leaves the second record empty and puts
  // the fragment item/count in the tail.  A four-byte synthetic response is
  // rejected by the client and causes the dialog to resend indefinitely.
  if(!bagMod) return null;
  const candidates=[];
  for(const batch of S.batches) for(const packet of batch.frames)
    if(packet.msgid===11684 && packet.frame.length>=99) candidates.push(packet.frame);
  const high=candidates.find(frame=>frame.subarray(12)[41]!==0);
  const low=candidates.find(frame=>frame.subarray(12)[41]===0);
  const captured=(result?.preview&&CAPTURED_NATIVE_PREVIEW_ACK.get(11684))||CAPTURED_NATIVE_ACK.get(11684);
  // The active lobby capture does not always contain a 11684 frame. Keep a
  // protocol-shaped 99-byte envelope as the fallback; a 16-byte fragment
  // packet makes the native client wait for the missing descriptor and drop
  // the connection.
  const fallback = captured?.length >= 99 ? Buffer.from(captured) :
    bagMod.mkFrame(11684, Buffer.alloc(87), {flags: 0x0d, stream: 0});
  const selected=result?.preview
    ? captured
    : (result?.returned ? high||candidates[0] : low||candidates[0]);
  const frame=Buffer.from(selected?.length>=99 ? selected : fallback);
  if(frame.length>=99){
    const payload=frame.subarray(12), source=result?.sourceRune||result?.returned;
    if(source) runeAckDescriptor(source).subarray(2).copy(payload,8,0,33);
    if(result?.returned){
      runeAckDescriptor(result.returned).copy(payload,41);
      // The native high-level dismantle envelope reserves byte 78 as the
      // result-present flag and stores the fragment id/count at 79..86.
      // Reusing a captured level-I frame can leave those stale fragment
      // fields behind, making a level-II/III downgrade look like it also
      // awarded fragments. Keep the flag but clear the fragment record when
      // a lowered rune is returned.
      payload.fill(0,79,87);
    }
    else {
      payload.fill(0,41,76);
      payload.writeUInt32LE(7421,79);
      payload.writeUInt32LE(Math.max(0,Number(result?.fragments)||0)>>>0,83);
    }
    return frame;
  }
  const template=CAPTURED_NATIVE_ACK.get(11682), payload=Buffer.alloc(87);
  payload.writeUInt32LE(0,0);
  payload.writeUInt32LE(7421,79);
  payload.writeUInt32LE(Math.max(0,Number(result?.fragments)||0)>>>0,83);
  return bagMod.mkFrame(11684,payload,{flags:template?.readUInt16LE(10) ?? 0x0d,stream:template?.readUInt32LE(4) ?? 0});
}
function liveRuneListAck() {
  const template=CAPTURED_NATIVE_ACK.get(11688);
  if(!template||!bagMod) return null;
  const runes=Object.values(PROGRESSION.rune.state.inventory||{})
    .filter(value=>Number.isSafeInteger(Number(value.id))&&Number(value.id)>=0&&Number(value.id)<=0xffff)
    .sort((a,b)=>Number(a.id)-Number(b.id));
  const payload=Buffer.alloc(4+runes.length*35);
  payload.writeUInt32LE(runes.length,0);
  for(const [index,rune] of runes.entries()){
    const offset=4+index*35, attrs=runeModule.orderedRuneAttrs(rune.attrs||{});
    payload.writeUInt16LE(Number(rune.id)&0xffff,offset);
    payload.writeUInt16LE(Number(rune.itemId)||0,offset+2);
    payload[offset+4]=Number(rune.level)||0;
    payload[offset+5]=Number(rune.color)||0;
    const count=Math.min(Math.floor((35-7)/3),attrs.length);
    payload[offset+6]=count;
    writeRuneAttributeTriples(payload,offset+7,attrs,count);
    // Keep the established live-list encoding.  The 11688 path already
    // displayed godsend correctly before the isolated 11784 popup work; do
    // not repurpose its reserved bytes while fixing the senior-compose ack.
    payload[offset+0x1e]=Number(rune.level)===5 ? (Number(rune.godsendId)||0) & 0xff : 0;
  }
  return bagMod.mkFrame(11688,payload,{flags:template.readUInt16LE(10),stream:template.readUInt32LE(4)});
}
// 神赐筛选使用独立的旧版 9155/9157 消息。9158 在现有录制中没有出现，
// 因而必须构造确认包；9156 是一个固定 40 字节的 packed native record，
// 由剩余次数、Unix 到期秒数、筛选条目数量及记录组成，最终映射到 Lua
// InitCharmNotWantData(rest, number, times)。
function liveGodsendFilterInfoAck() {
  const captured = CAPTURED_NATIVE_ACK.get(9156);
  if (!captured) return null;
  const frame = Buffer.from(captured), payload = frame.subarray(12);
  const godsend = PROGRESSION?.rune?.godsendInfo?.() || {};
  const expires = Number(godsend.limitedExpiresAt) || 0;
  // Limited synthesis is active only while the explicit 24-hour activation
  // window is valid. A legacy enabled flag without an expiry must remain
  // visually and functionally disabled.
  const active = Boolean(godsend.enabledLimited && expires > Date.now());
  const remaining = Math.max(0, Number(godsend.limitedRemaining) || 0);
  // The original 8824 response is a packed native record, not three aligned
  // u32 values.  Captured bytes are:
  //   [u16 remaining][u32 expiryUnixSeconds][u16 filterSlots][u16 bans...]
  // The expiry uses the existing translated server-clock absolute Unix
  // timestamp. The native Lua rest value is derived from expiry, not filterSlots.
  if (payload.length >= 2) payload.writeUInt16LE(remaining & 0xffff, 0);
  if (payload.length >= 6) {
    const remainingMs = active && expires ? Math.max(0, expires - Date.now()) : 0;
    payload.writeUInt32LE(remainingMs ? Math.floor((wireClockNowMs() + remainingMs) / 1000) : 0, 2);
  }
  // The native cached +0x323 u16 controls the existing filter-slot loop.
  // Preserve the existing two-slot value; do not infer new quota or permissions.
  if (payload.length >= 10) payload.writeUInt32LE(2, 6);
  if (payload.length >= 10) payload.fill(0, 10);
  const bans = Array.isArray(godsend.filterBans) ? godsend.filterBans : [];
  for (let i = 0; i < bans.length && 8 + i * 2 + 2 <= payload.length; i++) {
    payload.writeUInt16LE(Number(bans[i]) & 0xffff, 8 + i * 2);
  }
  return frame;
}
function liveGodsendFilterAck(requestTag, result = null) {
  const info = liveGodsendFilterInfoAck();
  if (requestTag === 9155) return info;
  if (requestTag !== 9157 || !bagMod) return null;
  const template = CAPTURED_NATIVE_ACK.get(9158) || info;
  // Original 8824 MSG_S2C_SHENCI_FILTER_APPLY is len=18: six zero payload
  // bytes on a successful activation.
  const payload = Buffer.alloc(6);
  if (result?.index || result?.id) {
    payload.writeUInt16LE(Number(result.index) & 0xffff, 2);
    payload.writeUInt16LE(Number(result.id) & 0xffff, 4);
  }
  payload.writeUInt32LE(result?.ok ? 0 : 1, 0);
  return bagMod.mkFrame(9158, payload, {
    flags: template?.readUInt16LE(10) ?? 0xca,
    stream: template?.readUInt32LE(4) ?? 0,
  });
}
const capturedProgressionAck = (requestTag, result = null) => {
  if (requestTag === 11759 || requestTag === 11761) {
    const tag = requestTag === 11759 ? 11760 : 11762;
    const captured = CAPTURED_NATIVE_ACK.get(tag);
    if (!captured || !bagMod) return null;
    const frame = Buffer.from(captured), payload = frame.subarray(12);
    const id = Number(result?.runeId) || 0;
    if (requestTag === 11759) {
      if (payload.length >= 3) { payload[0] = result?.ok ? 0 : 1; payload.writeUInt16LE(id & 0xffff, 1); }
    } else if (payload.length >= 7) {
      payload[0] = result?.ok ? 0 : 1;
      payload.writeUInt16LE(id & 0xffff, 1);
      payload.writeUInt32LE(Number(result?.unlockAt) >>> 0, 3);
    }
    return frame;
  }
  if(requestTag===36295){
    const live=liveWarSoulEntryRefresh();
    if(live) return live;
  }
  if (requestTag === 11689) {
    return bagMod.mkFrame(11690, loadoutPageWire.runeOpenPayload(result?.kind || 2), { flags: 0xd3, stream: PLAYERID });
  }
  if (requestTag === 11671 || requestTag === 11691) {
    return liveRunePageAck(result?.index);
  }
  if (requestTag === 9155 || requestTag === 9157) {
    const live = liveGodsendFilterAck(requestTag, result);
    if (live) return live;
  }
  if(requestTag===11685){
    const live=liveRuneExchangeAck(result);
    if(live) return live;
  }
  if(requestTag===11783){
    const live=liveRuneSeniorExchangeAck(result);
    if(live) return live;
  }
  if(requestTag===11681){
    const live=liveRuneStrengthenAck(result);
    if(live) return live;
  }
  if(requestTag===11677){
    const live=liveRuneInfoAck();
    if(live) return live;
  }
  if(requestTag===11683){
    const live=liveRuneDemolishAck(result);
    if(live) return live;
  }
  if(requestTag===11687){
    const live=liveRuneListAck();
    if(live) return live;
  }
  // 11854 is the wish-selector request.  Return a live-patched 11855 here;
  // the generic determination path below is reserved for strengthen/
  // demolish, otherwise the main emitter would send the same frame twice.
  if(requestTag===11854) return liveRuneDeterminationAck(11854);
  if (requestTag === 36269) {
    return bagMod.mkFrame(36270, loadoutPageWire.soulRenamePayload(result.index, result.name), { flags: 0x0d, stream: PLAYERID });
  }
  if (requestTag === 36274) {
    const captured = CAPTURED_NATIVE_ACK.get(36275);
    if (!captured) return null;
    const frame = Buffer.from(captured), payload = frame.subarray(12);
    if (payload.length >= 2) {
      payload[0] = 0;
      payload[1] = Number(result?.index || 0) & 0xff;
    }
    return frame;
  }
  const tag=progressionAck[requestTag];
  const frame=tag===undefined?null:CAPTURED_NATIVE_ACK.get(tag);
  return frame?Buffer.from(frame):null;
};
const liveWarSoulRefresh = (pageOverride = null) => {
  const template = CAPTURED_NATIVE_ACK.get(36273);
  if (!template) return null;
  const state = pageOverride === null || pageOverride === undefined
    ? PROGRESSION.warSoul.state
    : { ...PROGRESSION.warSoul.state, currentPage: Number(pageOverride) || 0 };
  return warSoulModule.patchNativeRefreshFrame(template, state);
};
// Five native pages, each six positions of three current/candidate entries.
// Do not migrate the old placeholder random bytes into real succinct IDs.
const liveWarSoulEntryRefresh = () => bagMod.mkFrame(36296,
  warSoulEntry.encode(PROGRESSION.warSoul.state.entryPanel),{flags:2});
let warSoulMaterialsInitialized = false;
const ensureWarSoulMaterials = () => {
  if (warSoulMaterialsInitialized) return;
  if(PLAYER_ACCOUNTS||PROGRESSION.warSoul.frozenSnapshot){warSoulMaterialsInitialized=true;return;}
  const fragments = PROGRESSION.warSoul.state.materials?.fragments || {};
  if (Object.keys(fragments).length) {
    PROGRESSION.warSoul.state.pages.forEach((_, index) => PROGRESSION.warSoul.pageFragments(index));
    warSoulMaterialsInitialized = true; return;
  }
  const parsed = warSoulModule.nativeMaterialBalances(CAPTURED_NATIVE_ACK.get(36273));
  if (Object.keys(parsed).length) {
    PROGRESSION.warSoul.state.materials.fragments = parsed;
    PROGRESSION.warSoul.state.pages.forEach((page, index) => {
      if (!page.fragments || !Object.keys(page.fragments).length) page.fragments = warSoulModule.nativeMaterialBalances(CAPTURED_NATIVE_ACK.get(36273), index);
    });
    PROGRESSION.warSoul.save();
  }
  warSoulMaterialsInitialized = true;
};
// The native rune dialog consumes this small determination packet immediately
// after a strengthen/demolish result. Without it the dialog keeps retrying
// the same request even when the main acknowledgement is valid.
function liveRuneDeterminationAck(requestTag, template = CAPTURED_NATIVE_ACK.get(11855)) {
  if(requestTag!==11681 && requestTag!==11683 && requestTag!==11854) return null;
  if(!template || template.length!==40 || template.readUInt32LE()!==40 || template.readUInt16LE(8)!==11855) return null;
  const frame=Buffer.from(template), payload=frame.subarray(12);
  const godsend=PROGRESSION?.rune?.godsendInfo?.() || {};
  const wish=godsend.wish && typeof godsend.wish === 'object' ? godsend.wish : {};
  const wishId=Number(wish.id)||0;
  const wishType=wish.type==='limited'||wish.type==='regular' ? wish.type : null;
  // Current native receiver (c527, bdbe4a..bdbf41) chooses the regular or
  // limited wish/pity pair using the last word. The 10/20 maxima come from
  // the client's charm table; they are not fields in this packet. Keep both
  // saved pity counters even when no wish is currently selected.
  const values=[
    Math.max(0, Math.min(10, Number(godsend.smallPity)||0)),
    wishType==='regular' ? wishId : 0,
    Math.max(0, Math.min(20, Number(godsend.largePity?.regular)||0)),
    wishType==='limited' ? wishId : 0,
    Math.max(0, Math.min(20, Number(godsend.largePity?.limited)||0)),
    Number(wishType==='limited'),
  ];
  const statusBytes=4;
  for(let i=0;i<values.length && statusBytes+4*i+4<=payload.length;i++)
    payload.writeUInt32LE(values[i]>>>0,statusBytes+4*i);
  return frame;
}

function equipSnapshot() {
  const o = {};
  for (const [pos, e] of EQUIP) if (e && e.itemId && e.itemId !== 0xffff) o[pos] = { 背包格: e.bagSlot, 道具: e.itemId, 数量: e.count };
  return o;
}
/**
 * 读落盘的装备栏差异文件（**只解析，不建模型**）——写在文件靠前的位置，因为
 * `findFreeSlot()` 给奖励/卸装找空格时**必须跳过装备栏占用的那一格**（见 equippedBagSlots）。
 * 解析结果缓存，后面的 `loadEquipState()` 复用同一份，不会读两次。
 */
let EQUIP_SAVED = null, EQUIP_SAVED_READ = false;
function readEquipSaved() {
  if (EQUIP_SAVED_READ) return EQUIP_SAVED;
  EQUIP_SAVED_READ = true;
  if (process.env.DSH_EQUIP_STATE === 'off') return (EQUIP_SAVED = null);
  try {
    const j = JSON.parse(fs.readFileSync(EQUIP_STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (!j || (!j.plans && (!j.slots || typeof j.slots !== 'object'))) throw new Error('invalid equipment state');
    EQUIP_SAVED = j;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot load equipment state ${EQUIP_STATE_FILE}: ${e.message}`);
    EQUIP_SAVED = null;
  }
  return EQUIP_SAVED;
}
/** 装备栏占用的背包格（找空格时要避开） */
function equippedBagSlots() {
  const s = new Set();
  for (const e of EQUIP.values()) if (e && e.itemId && e.itemId !== 0xffff && e.bagSlot !== 0xffff) s.add(e.bagSlot);
  return s;
}

// ===== 背包：改成服务端生成（不再回放录制里那几帧）=====
const BAG_FILE = argOf('bag', '');
const BAG_UNKNOWN = argOf('bag-unknown', 'assign');   // silent | empty | assign
const BAG_FREE_MODE = BAG_UNKNOWN;                    // 用空格的应答方式，跟未知格子保持一�?const BAG_CATALOG = (argOf('bag-catalog', '904,911,404,27046,32614,32696,33679,33880,50353')).split(',').map(Number);
/** Current client names/types also validate GM attachments and inventory grants. */
const ITEM_NAMES = require('./current-item-catalog').load().byId;
const EQUIPMENT_TYPES = new Set(['armour', 'treasure', 'weapon', 'magicgemequip']);
function isEquipmentItem(itemId) { return EQUIPMENT_TYPES.has(ITEM_NAMES?.[itemId]?.type); }
function canStackItem(itemId) { return !isEquipmentItem(itemId); }
let BAG = null, bagMod = null;
/**
 * 背包模型�?*落盘覆盖�?*：发出去的道具（商城购买/邮件附件）和用掉的道具必须记住，
 * 否则服务端一重启就退回抓包那 188 �?—�?客户端还显示着 190/192�? * 我们却以�?188~191 是空的、塞满之后又�?背包已满"（用户实测踩到过）�? */
const BAG_LIVE = process.env.DSH_BAG_STATE || path.join(__dirname, 'bag-state.live.json');
const BAG_FIX_STAMP = process.env.DSH_BAG_FIX_STAMP || path.join(__dirname, 'bag-fix.stamp.json');
// 11523 materials do not occupy slots, so the slot-delta file cannot preserve
// purchases of them. Keep this state beside the slot delta without replaying
// stale material frames from a capture on restart.
const MATERIAL_LIVE = process.env.DSH_MATERIAL_STATE || path.join(__dirname, 'material-state.live.json');
let materialBaseline=null;
function loadMaterialLive() {
  try {
    const j=JSON.parse(fs.readFileSync(MATERIAL_LIVE,'utf8'));
    return new Map(Object.entries(j.items||{}).map(([id,count])=>[+id,+count]).filter(([id,count])=>Number.isInteger(id)&&Number.isSafeInteger(count)&&count>=0));
  } catch { return new Map(); }
}
function saveMaterialLive(itemMap, strict = false) {
  if(!itemMap)return;
  const items={},base=materialBaseline||new Map();
  for(const id of new Set([...base.keys(),...itemMap.keys()])){
    const before=base.get(id)||0,after=itemMap.get(id)||0;
    if(before!==after)items[id]=after;
  }
  try {fs.writeFileSync(MATERIAL_LIVE,JSON.stringify({items,updatedAt:new Date().toISOString()},null,1));}catch(error){if(strict)throw error;}
}
function loadBagLive() {
  try { const j = JSON.parse(fs.readFileSync(BAG_LIVE, 'utf8')); return j && j.slots ? j.slots : null; } catch { return null; }
}
/**
 * 落盘"服务端自己改过的格子"。**只写与 bag-state.json 基准不同的部分**
 * （以前写整包，结果混进了旧布局的快照 → 模型变成两种布局的混合体，客户端点错格子）。
 */
let bagLiveBaseline = null;
function bagBaseline() {
  if (bagLiveBaseline) return bagLiveBaseline;
  bagLiveBaseline = new Map();
  try {
    const p = BAG_FILE ? (path.isAbsolute(BAG_FILE) ? BAG_FILE : path.join(__dirname, BAG_FILE)) : null;
    const j = p ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    for (const [k, v] of Object.entries((j && j.slots) || {})) bagLiveBaseline.set(+k, v);
  } catch { }
  return bagLiveBaseline;
}
function saveBagLive(slotMap, strict = false) {
  if (!slotMap) return;
  try {
    const base = bagBaseline();
    const slots = {};
    for (const [s, v] of slotMap) {
      const b = base.get(s);
      if (!b) { slots[s] = v; continue; }                       // 基准里没有 → 记"新增"
      if (b.itemId !== v.itemId || b.count !== v.count || (b.guid || '') !== (v.guid || '') ||
        JSON.stringify(b.dual||null)!==JSON.stringify(v.dual||null)||b.instanceHex!==v.instanceHex) slots[s] = v;
    }
    for (const s of base.keys()) if (!slotMap.has(s)) slots[s] = null;   // 基准里有、现在没了 → 记"清空"
    fs.writeFileSync(BAG_LIVE, JSON.stringify({ 说明: '只记录与 bag-state.json 的差异', slots, updatedAt: new Date().toISOString() }, null, 1));
    noteModelChange('bag', Object.keys(slots).length);
  } catch (error) { if (strict) throw error; }
}

/**
 * ===== 模型变更流水（change-log.jsonl）=====
 *
 * 为什么要有：这个工程里最容易出错的不是"协议写错"，而是
 * **"客户端那边的布局"和"服务端模型"什么时候分家的**。日志里现在只有我们的动作，
 * 没有"这一刻模型长什么样、是哪个请求引起的"。
 *
 * 做的事：每次背包/装备栏模型落盘，就追加一行：
 *   {t, 触发请求, 类型, 变化格数, 关键几格的新旧值, 装备栏快照}
 * 不看的时候零成本（攒够 20 条或每 2 秒写一次），排查时直接读这个文件即可。
 */
const CHANGELOG_FILE = process.env.DSH_CHANGELOG_FILE || path.join(__dirname, 'logs', 'change-log.jsonl');
const CHANGE_LOG_ON = process.env.DSH_CHANGELOG !== 'off';
let LAST_REQ = null;              // 最近一条客户端请求 {msgid,n,payload}（变更流水里用来标"谁引起的"）
let changeBuf = [];
function noteModelChange(kind, n, detail) {
  if (!CHANGE_LOG_ON || !n) return;
  // 整份重推（登录/落空自愈时会给 259 格发帧）也会走到这里 —— 那是"同步"不是"改动"，
  // 记进去只会把日志刷满，所以只记**小改动**（真正的动作都不超过几十格）。
  if (kind === 'bag' && n > 50) return;
  const req = LAST_REQ || (BAG && BAG.lastReq) || null;      // 兜底：会话自己记的最近请求
  changeBuf.push({
    t: new Date().toISOString(), 触发: req ? `${req.msgid}#${req.n}` : '(服务端自身)',
    类型: kind, 变化格数: n, ...(detail ? { 细节: detail } : {}),
  });
  if (changeBuf.length >= 20) flushChangeLog();
  else { clearTimeout(noteModelChange._t); noteModelChange._t = setTimeout(flushChangeLog, 2000); }
}
function flushChangeLog() {
  if (!changeBuf.length) return;
  const rows = changeBuf; changeBuf = [];
  try { fs.appendFileSync(CHANGELOG_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); } catch { }
}
/** 解析 --bag-free=1,2,3 列表（空串不能变成 0 号格子） */
const parseSlots = s => String(s).split(',').map(x => x.trim()).filter(x => x !== '').map(Number).filter(n => Number.isInteger(n) && n >= 0);

if (BAG_FILE) {
  require('./persistence/state-files').transaction('startup-bag-initialization',[],()=>{
  bagMod = require('./bag');
  const p = path.isAbsolute(BAG_FILE) ? BAG_FILE : path.join(__dirname, BAG_FILE);
  BAG = JSON.parse(fs.readFileSync(p, 'utf8'));
  BAG.slotMap = new Map(Object.entries(BAG.slots || {}).map(([k, v]) => [+k, v]));
// 叠加"服务端自己发出去�?用掉�?那部分（落盘�?bag-state.live.json）—�?// 不加载的话重启就退回抓包快照，和客户端显示对不上（用户实测：客户端 190/192，我们却报满�?
{
  const live = loadBagLive();
  if (live) {
    let added = 0, removed = 0;
    for (const [k, v] of Object.entries(live)) {
      const s = +k;
      if (v === null) { if (BAG.slotMap.delete(s)) removed++; }
      else { if (!BAG.slotMap.has(s)) added++; BAG.slotMap.set(s, v); }
    }
    console.log(`背包落盘覆盖（${path.basename(BAG_LIVE)}）：新增/修正 ${added} 格，清空 ${removed} 格`);
  }
}
// **自愈：一个实例 GUID 只能占一个格子**（客户端按 GUID 认道具，重复会让它只画一个、
// 另一格变成"放不进东西的空洞"）。历史上装备/卸装的 bug 写过一批重复进来，
// 这里在启动时统一清一遍：优先保留"服务端最近告诉过客户端的那一格"（live 差异里的），否则保留格号小的。
if (!economyFrozen()) {
  const seen = new Map();          // guid -> 保留的格子
  const liveKeys = new Set(Object.keys(loadBagLive() || {}).map(Number));
  const drop = [];
  for (const [s, v] of [...BAG.slotMap.entries()].sort((a, b) => a[0] - b[0])) {
    if (!v || !v.guid) continue;
    const prev = seen.get(v.guid);
    if (prev === undefined) { seen.set(v.guid, s); continue; }
    // 冲突：live 里那一格优先留下
    const keepPrev = liveKeys.has(prev) || !liveKeys.has(s);
    const [keep, lose] = keepPrev ? [prev, s] : [s, prev];
    seen.set(v.guid, keep);
    BAG.slotMap.delete(lose);
    drop.push(`${lose}(道具${v.itemId})→保留${keep}`);
  }
  if (drop.length) {
    console.log(`背包自愈：清掉 ${drop.length} 个"同一实例占两格"的记录 → ${drop.slice(0, 8).join(' ')}${drop.length > 8 ? ' …' : ''}`);
    saveBagLive(BAG.slotMap);
  }
}
  // 数组解错的格子（用户确认是空的）要从模型里删掉，否则"找空格子"永远跳过它们
  // �?默认**不再**清掉 45 号：2026-09-27 实测用户点背包里�?300金币，客户端发的就是
  //   `17002 格子45`（服务端日志两条），说明模型�?45=道具404(300金币) 是对的�?  
  for (const s of (economyFrozen() ? [] : parseSlots(argOf('bag-free', '')))) {
    if (BAG.slotMap.has(s)) { console.log(`按 --bag-free 把格子 ${s} 当成空的（模型里原本记的是道具 ${BAG.slotMap.get(s).itemId}）`); BAG.slotMap.delete(s); }
  }
  BAG.itemMap = new Map(BAG.items || []);
  // Persist only changes made by this local server. The baseline from BAG.items
  // remains authoritative for materials that have never been bought/used here.
  materialBaseline=new Map(BAG.itemMap);
  for(const [id,count] of loadMaterialLive()) {if(count===0)BAG.itemMap.delete(id);else BAG.itemMap.set(id,count);}
  // --bag-put=191:399:1  往模型里塞一件道具（测试/演示用：给个金币道具点点看）
  for (const spec of (economyFrozen() ? [] : String(argOf('bag-put', '')).split(';').filter(x => x.trim()))) {
    const [slot, itemId, count] = spec.split(':').map(Number);
    if (!Number.isInteger(slot) || slot<0 || slot>=BAG_VISIBLE_CAPACITY ||
        !Number.isInteger(itemId)) throw new Error('bag-put must target an opened client bag slot');
    BAG.slotMap.set(slot, { itemId, count: count || 1, guid: synthGuid(slot, itemId).toString('hex') });
    const nm = ITEM_NAMES && ITEM_NAMES[itemId] ? ITEM_NAMES[itemId].name : String(itemId);
    console.log(`�?--bag-put 把格�?{slot} 设成 ${nm}×${count || 1}（会写进角色数据帧，客户端直接能看到）`);
  }
  // Normal startup preserves slots and GUIDs. Legacy repair is explicit only.
  if(argOf('bag-fix-again','off')==='on')bagFixPass();
  const legacyResources = findLegacyResourceSlots(BAG.slotMap);
  if (legacyResources.length) console.log(`只读诊断：${legacyResources.length} 个已确认资源仍在背包格，未自动迁移：${JSON.stringify(legacyResources)}`);
  console.log(`背包模型 ${path.basename(p)}：道�?${BAG.itemMap.size} 种，已见格子 ${BAG.slotMap.size} 个`);
  });
}

/**
 * 让"服务端模型"和"客户端画出来的格子"对齐，并腾出真空格给商城/邮件用。
 * 见本文件 patch-bagfix 的注释；实证都写在 ITEMGRANT.md / BAGSYNC.md。
 */
function bagFixPass() {
  return require('./persistence/state-files').transaction('startup-bag-repair',[],bagFixPassBody);
}
function bagFixPassBody() {
  if (economyFrozen()) { console.log('经济提交待核对：跳过启动时背包整理与落盘'); return; }
  const fp = (() => { try { const m = [...BAG.slotMap].map(([s, v]) => `${s}:${v.itemId}:${v.count}`).join(','); return require('crypto').createHash('sha1').update(m).digest('hex').slice(0, 16); } catch { return 'x'; } })();
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(BAG_FIX_STAMP, 'utf8')); } catch { }
  if (stamp && stamp.fp === fp && argOf('bag-fix-again', 'off') !== 'on') {
    console.log(`背包整理：布局与上次一致（指纹 ${fp}），**跳过**（避免每次重启都动布局 → 客户端点错格子）`);
    return;
  }
  if (!BAG || !BAG.slotMap) return;
  const nmOf = id => (ITEM_NAMES && ITEM_NAMES[id] ? ITEM_NAMES[id].name : String(id));

  // --- (3) 丢掉指定道具（默认：客户端本来就画成空的两件失效/限量道具）
  const dropIds = String(argOf('bag-drop', '7011,25131')).split(',').map(x => +x.trim()).filter(Boolean);
  if (argOf('bag-drop', 'off') !== 'off') {
    for (const [s, v] of [...BAG.slotMap]) {
      if (v && dropIds.includes(v.itemId)) {
        console.log(`背包整理：丢掉格子 ${s} 的 "${nmOf(v.itemId)}"×${v.count}（客户端本来就不显示它，见 --bag-drop）`);
        BAG.slotMap.delete(s);
        if (BAG.itemMap && BAG.itemMap.has(v.itemId)) {
          const left = Math.max(0, (BAG.itemMap.get(v.itemId) || 0) - 1);
          if (left === 0) BAG.itemMap.delete(v.itemId); else BAG.itemMap.set(v.itemId, left);
        }
      }
    }
  }

  // --- (2) 同道具合并成一摞（真服行为）
  if (argOf('bag-merge', 'off') !== 'off') {
    const STACK_MAX = +(argOf('stack-max', '1000'));
    const first = new Map();      // itemId -> {slot, count}
    let merged = 0;
    for (const s of [...BAG.slotMap.keys()].sort((a, b) => a - b)) {
      const v = BAG.slotMap.get(s);
      if (!v) continue;
      if (!canStackItem(v.itemId)||v.dual) continue;
      const f = first.get(v.itemId);
      if (!f) { first.set(v.itemId, { slot: s, count: v.count || 1 }); continue; }
      if (f.count + (v.count || 1) > STACK_MAX) { first.set(v.itemId, { slot: s, count: v.count || 1 }); continue; }
      f.count += (v.count || 1);
      const keep = BAG.slotMap.get(f.slot);
      BAG.slotMap.set(f.slot, { ...keep,itemId: v.itemId, count: f.count, guid: keep && keep.guid ? keep.guid : synthGuid(f.slot, v.itemId, REGUID_SALT()).toString('hex') });
      BAG.slotMap.delete(s);
      merged++;
    }
    if (merged) console.log(`背包整理：同道具合并 ${merged} 摞（真服也这么合并，见 ITEMGRANT.md）→ 空出 ${merged} 格`);
  }

  // --- (1) 换新实例 GUID（让客户端不再把"它记得用掉过的实例"画成空气）
  if (argOf('bag-reguid', 'off') !== 'off') {
    let n = 0;
    for (const [s, v] of BAG.slotMap) {
      if (!v) continue;
      v.guid = synthGuid(s, v.itemId, REGUID_SALT()).toString('hex');
      n++;
    }
    console.log(`背包整理：给 ${n} 格换了新的实例 GUID（客户端按 GUID 记"用掉了"，换掉就重新显示；salt=0x${REGUID_SALT().toString(16)}）`);
  }

  try { saveBagLive(BAG.slotMap); } catch { }
  const BAG_CAP_LOG = +(argOf('bag-capacity', '192'));
  const free = [];
  for (let s = 0; s < BAG_CAP_LOG; s++) if (!BAG.slotMap.has(s)) free.push(s);
  console.log(`背包整理完成：${BAG.slotMap.size} 格有道具，空 ${free.length} 格${free.length ? '（' + free.slice(0, 12).join(',') + (free.length > 12 ? '…' : '') + '）' : ''}`);
  try { fs.writeFileSync(BAG_FIX_STAMP, JSON.stringify({ fp, at: new Date().toISOString() })); } catch { }
}
/** 换 GUID 用的盐（固定值：同一格每次启动生成同一个新 GUID，避免每次登录都变）。
 *  写成函数而不是 const —— bagFixPass() 在模块加载早期就会被调用，const 会撞 TDZ。 */
function REGUID_SALT() {
  const a = argOf('bag-reguid-salt', '');
  return a === '' ? 0x9e3779b9 : (+a >>> 0);
}

/** 没有实例GUID的格子，�?(格子,道具) 生成一个稳定的 64 位值，保证同一格子每次一�?*/
function synthGuid(slot, itemId, salt) {
  const b = Buffer.alloc(8);
  let h = (0x811c9dc5 ^ Math.imul(slot, 2654435761) ^ itemId ^ ((salt || 0) >>> 0)) >>> 0;
  for (let i = 0; i < 8; i++) { h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0; b[i] = (h >>> ((i % 4) * 8)) & 0xff; }
  return b;
}

/** 用户亲眼确认是空的格子（默认没有；`--bag-free=45` 可临时把某格当空�?*/
const BAG_FREE = parseSlots(argOf('bag-free', ''));

/**
 * 私服自己的背包规格（bag-slots.json，由 items.js --build-bag 生成）�? * 查找顺序：bag-state.json 的真实格�? �? bag-slots.json 的规�? �? �?catalog 指派
 */
const SPEC_FILE = argOf('bag-spec', '');       // 默认**不加�?*：私服规格必须显式指定，否则会盖掉客户端的真实背�?let BAG_SPEC = null;
if (SPEC_FILE) {
  const p = path.isAbsolute(SPEC_FILE) ? SPEC_FILE : path.join(__dirname, SPEC_FILE);
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    BAG_SPEC = new Map(Object.entries(j.格子 || {}).map(([k, v]) => [+k, v]));
    console.log(`背包规格 ${path.basename(p)}�?{BAG_SPEC.size} 个格子（${j.来源 || ''}）—�?会覆盖客户端的真实背包显示`);
  }
}
function bagFullFrame() {
  const items=[...BAG.itemMap.entries()]
    // 7421 is a 11552/11553 resource, not a 11523 material row.  Sending it
    // in both containers leaves the rune exchange page with the stale 11523
    // count after a resource update.
    // 7421 is the native rune-fragment resource and 7354 is the old local
    // test mirror.  Neither belongs in the 11523 material table; exposing
    // 7354 here is what caused the client to show the “符文碎片(测试)” popup.
    .filter(([id])=>!isResourceItem(Number(id)) && Number(id)!==7354)
    .sort((a, b) => a[0] - b[0]);
  return bagMod.buildBagFull(items);
}

/**
 * assign 模式下，被指派的格子�?*落盘**�? *  - 同一个格子下次进来还是同一件道具（否则背包每次都不一样）
 *  - 顺便把「客户端问过哪些格子」全部记下来，这就是补真实映射时要点的清�? */
const ASSIGN_FILE = process.env.DSH_ASSIGN_FILE || path.join(__dirname, 'bag-assigned.json');
let ASSIGN = {};
try { ASSIGN = JSON.parse(fs.readFileSync(ASSIGN_FILE, 'utf8')); } catch { ASSIGN = {}; }
let assignDirty = false;
function persistAssign(slot, itemId, count, guid) {
  ASSIGN[slot] = { itemId, count, guid: guid.toString('hex') };
  assignDirty = true;
  clearTimeout(persistAssign._t);
  persistAssign._t = setTimeout(() => {
    assignDirty = false;
    try { fs.writeFileSync(ASSIGN_FILE, JSON.stringify(ASSIGN, null, 1)); } catch { }
  }, 300);
}
function loadAssigned() {
  const m = new Map();
  for (const [k, v] of Object.entries(ASSIGN)) m.set(+k, { itemId: v.itemId, count: v.count, guid: v.guid });
  return m;
}

// ===== 装备栏记�?msgid=1043�?10 字节定长�?====
// 布局（实证，用背包模型交叉验证过 6/6）：
//   +0  u16 装备�?| +2 u16 背包格子 | +4 u32 道具ID | +8 u32 数量 | +12 u64 实例GUID | 其余字段照抄模板
// 做法：从录制里取一帧当模板，只改前 20 字节 —�?比凭空构造安全得多�?
let EQ_TEMPLATE = null;
for (const b of S.batches) { for (const fr of b.frames) { if (fr.msgid === 1043 && fr.frame.length === 510) { EQ_TEMPLATE = fr.frame; break; } } if (EQ_TEMPLATE) break; }
if (EQ_TEMPLATE) console.log(`装备栏模�?msgid=1043 已就绪（${EQ_TEMPLATE.length} 字节）`); else console.log('!! 录制里没找到 1043 模板');


/** 道具ID -> type（items.json），用来判"神器"(treasure) */
const ITEM_TYPES = Object.fromEntries(Object.entries(ITEM_NAMES).map(([id,item])=>[id,item.type]));
const EQUIP = new Map();      // active plan's six slots -> {bagSlot, itemId, count, guid}
const EQUIP_PLANS = new Map(); // global slot 0..17; plans may reuse one bag instance
let activeEquipmentPlan = 0;
const equipmentAttributes = require('./equipment-attributes');
/**
 * 装备栏**落盘**（`equip-state.json`）。
 *
 * 为什么必须落盘：背包有 `bag-state.live.json`（买/用/销毁/拖拽都记），装备栏却一直只是
 * "启动时用录制里的 1043 浇筑" —— 于是一重启就出现**两边对不上**：
 *   用户装上去的装备没了（模型退回录制里那 6 件），而那件装备早被我们从背包里移走，
 *   背包格也是空的 ⇒ 这件道具**同时在两处消失**，客户端点它就"没反应"。
 * 做法：每次装备栏变化都只写"与录制的差异"（和背包同一套路），启动时在录制之上叠加。
 */
/**
 * 装备栏状态文件。默认 `equip-state.json`（线上用这个）。
 * ⚠ 但**测试必须彼此隔离**：每个测试都用 `DSH_BAG_STATE` 指定自己的背包状态文件，
 *   如果装备栏大家共用默认文件，前一个测试装过的装备会污染后一个（实测：
 *   treasuretest 在整套里跑会红、单独跑就绿）。所以这里**从背包状态文件名推导**：
 *   `bag-state.X.json` → `equip-state.X.json`；没指定就用默认。
 */
const EQUIP_STATE_FILE = process.env.DSH_EQUIP_STATE || (() => {
  const b = process.env.DSH_BAG_STATE;
  if (b && /bag-state/.test(path.basename(b))) return path.join(path.dirname(b), path.basename(b).replace(/^bag-state/, 'equip-state'));
  return path.join(__dirname, 'equip-state.json');
})();
const EQUIP_SAVE_OFF = argOf('equip-state', 'on') === 'off';
const equipmentRules=require('./equipment-rules');
let equipDiskVersion=null;
// Read a persisted slot by its global plan position. The active six-slot
// view is a presentation cache and must never overwrite plan 1 while plan 2
// or 3 is selected.
const planEntry=pos=>EQUIP_PLANS.get(pos);
function equipmentPlanMap(plan) {
  return new Map(Array.from({length:6},(_,slot)=>[slot,EQUIP_PLANS.get(plan*6+slot)]).filter(([,e])=>e));
}
function refreshActiveEquipment() {
  EQUIP.clear();
  for(const [slot,e] of equipmentPlanMap(activeEquipmentPlan)) EQUIP.set(slot,e);
}
function replaceEquipmentPlan(plan, entries) {
  for(let slot=0;slot<6;slot++) {
    const e=entries.get(slot),pos=plan*6+slot;
    if(e)EQUIP_PLANS.set(pos,e);else EQUIP_PLANS.delete(pos);
  }
  // A bag relocation must update all plans referring to the same instance.
  for(const [pos,e] of EQUIP_PLANS) {
    const match=[...BAG.slotMap].find(([,v])=>v.itemId===e.itemId && v.guid===e.guid?.toString('hex'));
    if(match)EQUIP_PLANS.set(pos,{...e,bagSlot:match[0]});
  }
  refreshActiveEquipment();
}
function syncBattleEquipment(){
  if(EQUIP_SAVE_OFF||fs.existsSync(EQUIPMENT_PENDING_FILE))return;
  try{
    const raw=fs.readFileSync(EQUIP_STATE_FILE,'utf8');
    if(raw===equipDiskVersion)return;
    const data=JSON.parse(raw.replace(/^\uFEFF/, ''));
    // Battle commits the bag and references together. Reload that bag before
    // validating references; otherwise a moved GUID looks like a lost item.
    const live=loadBagLive();
    if(live&&BAG){
      const next=new Map(bagBaseline());
      for(const [key,value]of Object.entries(live))if(value)next.set(+key,value);else next.delete(+key);
      BAG.slotMap=next;
    }
    const savedPlans=require('./equipment-loadout-plans').normalize(data);
    EQUIP_PLANS.clear();
    activeEquipmentPlan = savedPlans.activePlan;
    for(let plan=0;plan<3;plan++)for(let slot=0;slot<6;slot++){
      const pos=plan*6+slot,line=savedPlans.plans[plan][slot];
      if(line===null){EQUIP_PLANS.delete(pos);if(pos<6)EQUIP.delete(pos);continue;}
      const e=parseEquipLine(line),match=[...BAG.slotMap].find(([,v])=>v.itemId===e.itemId&&v.guid===e.guid.toString('hex'));
      if(match){const value={...e,bagSlot:match[0]};EQUIP_PLANS.set(pos,value);refreshActiveEquipment();}
    }
    EQUIP.clear();
    for (let slot = 0; slot < 6; slot++) { const entry = EQUIP_PLANS.get(activeEquipmentPlan * 6 + slot); if (entry) EQUIP.set(slot, entry); }
    equipDiskVersion=raw;
  }catch{}
}
function selectEquipmentPlan(plan) {
  plan = Number(plan);
  if (!Number.isInteger(plan) || plan < 0 || plan > 2) return false;
  activeEquipmentPlan = plan;
  EQUIP.clear();
  for (let slot = 0; slot < 6; slot++) {
    const entry = EQUIP_PLANS.get(plan * 6 + slot);
    if (entry) EQUIP.set(slot, entry);
  }
  try {
    const data = JSON.parse(fs.readFileSync(EQUIP_STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const normalized = require('./equipment-loadout-plans').normalize(data);
    fs.writeFileSync(EQUIP_STATE_FILE, JSON.stringify({ ...data, version: 2, activePlan: plan, plans: normalized.plans }, null, 1));
    equipDiskVersion = fs.readFileSync(EQUIP_STATE_FILE, 'utf8');
  } catch {}
  return true;
}
function publishBattleInventory(){
  if(EQUIP_SAVE_OFF)return;
  const equipment={};
  for(let slot=0;slot<6;slot++){
    const e=EQUIP.get(slot);
    equipment[slot]=validEquipRef(e)?`${e.bagSlot}|${e.itemId}|${e.count}|${e.guid.toString('hex')}`:null;
  }
  const plans=require('./equipment-loadout-plans').normalize({
    plans:Array.from({length:3},(_,plan)=>Array.from({length:6},(_,slot)=>{
      const e=planEntry(plan*6+slot);return validEquipRef(e)?`${e.bagSlot}|${e.itemId}|${e.count}|${e.guid.toString('hex')}`:null;
    })),activePlan:activeEquipmentPlan
  });
  const file=EQUIP_STATE_FILE+'.snapshot',tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({capacity:BAG_VISIBLE_CAPACITY,
    bagBaseFile:path.isAbsolute(BAG_FILE)?BAG_FILE:path.join(__dirname,BAG_FILE),
    equipment,plans:plans.plans,activePlan:plans.activePlan,inventory:Object.fromEntries(BAG?.slotMap||[])}));
  renameWithRetry(tmp,file);
}
function saveEquipState(strict = false) {
  if (EQUIP_SAVE_OFF) return;
  try {
    const plans = Array.from({length:3},(_,plan)=>Array.from({length:6},(_,slot)=>{
      const e=planEntry(plan*6+slot);
      return validEquipRef(e)?`${e.bagSlot}|${e.itemId}|${e.count}|${e.guid.toString('hex')}`:null;
    }));
    const slots = Object.fromEntries(plans[0].map((line,slot)=>[slot,line]));
    const tmp=EQUIP_STATE_FILE+'.'+process.pid+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({version:2,activePlan:activeEquipmentPlan,plans,slots,
      updatedAt:new Date().toISOString()},null,1));
    renameWithRetry(tmp,EQUIP_STATE_FILE);
    noteModelChange('equip', EQUIP.size, { 装备栏: equipSnapshot(), 差异位: Object.keys(slots).length });
    equipDiskVersion=fs.readFileSync(EQUIP_STATE_FILE,'utf8');
  } catch (error) { if (strict) throw error; }
}
function parseEquipLine(line) {
  const [b, i, c, g] = String(line).split('|');
  return { bagSlot: (+b) & 0xffff, itemId: (+i) >>> 0, count: (+c) >>> 0, guid: Buffer.from(String(g || '').padEnd(16, '0').slice(0, 16), 'hex') };
}
/** 清掉一份被写坏的状态（不写磁盘），用于 `--equip-state=off` 和坏文件兜底 */
function resetEquipState(why) {
  if (economyFrozen()) return;
  try { fs.unlinkSync(EQUIP_STATE_FILE); } catch { }
  console.log(`装备栏落盘：${why} → 已丢弃，回到录制里的装备栏`);
}
/** 1043：+0 u8装备位，+1 u8容器类型，+2 u16背包格，+4起490B实例，末尾u32=7。 */
(function seedEquip() {
  for (const b of S.batches) for (const fr of b.frames) {
    if (fr.msgid !== 1043 || fr.frame.length !== 510) continue;
    const p = fr.frame.subarray(12);
    const pos = p.readUInt16LE(0);
    if (EQUIP_PLANS.has(pos)) continue;
    const entry={ bagSlot: p.readUInt16LE(2), itemId: p.readUInt32LE(4), count: p.readUInt32LE(8), guid: Buffer.from(p.subarray(12, 20)) };
    EQUIP_PLANS.set(pos,entry); if(pos<6)EQUIP.set(pos,entry);
  }
  if (EQUIP_PLANS.size) console.log('装备栏模型：' + EQUIP_PLANS.size + ' 个装备位（来源：录制里的 1043）');
})();

/**
 * 启动时把落盘的装备栏**叠加**到录制基线之上（见 saveEquipState 的说明），
 * 然后做三项自检/修复：
 *   ① 神器唯一：每套（服务端目前只有"当前生效的那一套"）最多 1 件 type=treasure
 *      —— 用户明确要求；真服 1043 的 +1 恒为 0，所以不存在"第几套"这个维度；
 *   ② 同一实例 GUID 不许占两个装备位（客户端按 GUID 认实例，重复会出现空洞）；
 *   ③ 按 GUID 核验背包实例；实例搬过格则修正引用，实例消失则清掉失效引用。
 */
(function loadEquipState() {
  if (EQUIP_SAVE_OFF) return;
  const j = readEquipSaved();
  if (!j) return;
  let applied = 0, removed = 0;
  const savedPlans=require('./equipment-loadout-plans').normalize(j);
  activeEquipmentPlan = savedPlans.activePlan;
  for(let plan=0;plan<3;plan++)for(let slot=0;slot<6;slot++){
    const pos=plan*6+slot,v=savedPlans.plans[plan][slot];
    if(v===null){if(EQUIP_PLANS.has(pos)){EQUIP_PLANS.delete(pos);if(pos<6)EQUIP.delete(pos);removed++;}continue;}
    try{const e=parseEquipLine(v);EQUIP_PLANS.set(pos,e);if(pos<6)EQUIP.set(pos,e);applied++;}catch{}
  }
  EQUIP.clear();
  for (let slot = 0; slot < 6; slot++) { const entry = EQUIP_PLANS.get(activeEquipmentPlan * 6 + slot); if (entry) EQUIP.set(slot, entry); }
  if (applied || removed) console.log(`装备栏落盘：叠加 ${applied} 个装备位、删除 ${removed} 个（${path.basename(EQUIP_STATE_FILE)}）`);

  let repaired = 0;
  // ① 神器唯一
  const seenGroups=new Map();
  for (const [pos, e] of [...EQUIP_PLANS].sort((a, b) => a[0] - b[0])) {
    if (!e || !e.itemId || e.itemId === 0xffff) continue;
    const group=equipmentRules.exclusiveGroup(e.itemId),plan=Math.floor(pos/6);
    if(group){
      const key=`${plan}:${group}`;
      if(seenGroups.has(key)){clearEquipSlot(pos,e.bagSlot);repaired++;}
      else seenGroups.set(key,pos);
    }
  }
  // ② 同一 GUID 不许占两个装备位
  const byGuid = new Map();
  for (const [pos, e] of [...EQUIP_PLANS].sort((a, b) => a[0] - b[0])) {
    if (!e || !e.itemId || e.itemId === 0xffff || !e.guid || /^0+$/.test(e.guid.toString('hex'))) continue;
    const g = e.guid.toString('hex');
    const key=`${Math.floor(pos/6)}:${g}`;
    if (byGuid.has(key)) {
      console.log(`装备栏自检：GUID ${g.slice(0, 8)}… 在同一方案内同时占着装备位${byGuid.get(key)} 和 ${pos} → 清空${pos}`);
      clearEquipSlot(pos, e.bagSlot);
      repaired++;
    } else byGuid.set(key, pos);
  }
  // ③ 背包实例必须由 GUID 定位。同道具 ID 的另一件不能顶替它。
  let stale = 0;
  for (const [pos, e] of EQUIP_PLANS) {
    if (!e || !e.itemId || e.itemId === 0xffff) continue;
    const guid=e.guid?.toString('hex');
    const match=guid && !/^0+$/.test(guid) && BAG?.slotMap
      ? [...BAG.slotMap].find(([,v])=>v?.guid?.toLowerCase()===guid && v.itemId===e.itemId)
      : null;
    if (!match) {clearEquipSlot(pos,0xffff);stale++;repaired++;continue;}
    if (e.bagSlot!==match[0]) {EQUIP_PLANS.set(pos,{...e,bagSlot:match[0]});repaired++;}
  }
  if (stale) console.log(`装备栏自检：${stale} 个装备位的 GUID 已不在背包，清除失效引用（背包物品不变）`);
  refreshActiveEquipment();
  if (repaired && !economyFrozen()) saveEquipState();
})();
/** 把一帧 1043 的前 20 字节按 EQUIP 模型改写（其余字节照抄模板）*/
function applyEquipModel(frame) {
  if (!frame || frame.readUInt16LE(8) !== 1043 || frame.length !== 510) return frame;
  const p = frame.subarray(12);
  const pos=p[0],e=planEntry(pos);
  return e ? equipFrame(pos,e.bagSlot,e.itemId,e.count,e.guid)
    : equipFrame(pos,0xffff,0xffff,0,Buffer.alloc(8));
}
/** 装备位变空（卸下）：真服实证 itemId=0xFFFF、GUID 全零，并带上"道具回到哪个背包格子" */
function clearEquipSlot(pos, bagSlot) {
  const value={ bagSlot, itemId: 0xffff, count: 0, guid: Buffer.alloc(8) };
  EQUIP_PLANS.set(pos,value);refreshActiveEquipment();
}
function validEquipRef(e) {
  if (!e || !e.itemId || e.itemId===0xffff || !Buffer.isBuffer(e.guid) || e.guid.length!==8) return false;
  if (/^0+$/.test(e.guid.toString('hex'))) return false;
  const held=BAG?.slotMap?.get(e.bagSlot);
  return !!held && held.itemId===e.itemId && held.guid?.toLowerCase()===e.guid.toString('hex');
}
/**
 * 背包格子被"搬家"之后，把装备栏里指向这些格子的引用一起改掉。
 *
 * ⚠ **必须按实例 GUID 判断，不能只看格子号**（2026-09-27 实测踩到）：
 * 拖拽"两格互换"时，A 格里的道具搬到 B、B 格里的道具搬到 A。
 * 如果无脑把"指向 A 的引用"改成 B，就会把装备位指到**另一件道具**身上
 * （实测：装备位引用格子93 的撼天锤，把格子0 的永恒号角拖到 93 之后，
 *  引用被改成 0，卸下时撼天锤被塞进了 0 号格）。
 * 正确做法：只有"那一格里装的还是**同一件实例**"时才跟着改；换成了别的实例就保持原样。
 * 返回发生变化的装备位，供调用方逐位发送 1043。
 */
function remapEquipRefs(mapOldToNew, slotMap) {
  const map = slotMap || (BAG && BAG.slotMap);
  // 统一成"16 位小写 hex"：装备栏里 guid 是 Buffer（synthGuid 的产物），背包模型里是 hex 字符串，
  // 直接 String() 会拿 Buffer 去比字符串 → 永远不相等（实测踩过，引用就乱搬了）。
  const hexOf = v => {
    if (!v || !v.guid) return '';
    const g = v.guid;
    if (Buffer.isBuffer(g)) return g.toString('hex').toLowerCase();
    const str = String(g).toLowerCase();
    return /^[0-9a-f]{16}$/.test(str) ? str : '';
  };
  const changed = [];
  for (const [pos, e] of [...EQUIP_PLANS]) {
    if (!e || !e.itemId || e.itemId===0xffff) continue;
    const from = e.bagSlot;
    const to = mapOldToNew.get(from);
    if (to === undefined || to === from) continue;
    if (map && hexOf(e) && hexOf(map.get(to)) !== hexOf(e)) continue;   // 那一格现在不是它了 → 不搬引用
    EQUIP_PLANS.set(pos, { ...e, bagSlot: to });
    changed.push(pos);
  }
  refreshActiveEquipment();
  return changed;
}
 function patchEnhancementLevel(record, held) {
  if(held?.dual)gemCrafting.patchRecord(record,held);
  if (!Buffer.isBuffer(record) || record.length < 75 || !held?.guid ||
      record.readUInt16LE(0)!==held.itemId ||
      record.subarray(8,16).toString('hex')!==held.guid.toLowerCase())return;
  try {
    if(!ordinaryEnhancementRules.eligibility(held.itemId).supported)return;
    const current=EQUIPMENT_ADAPTER.findInstance(held.guid);
    if(current?.itemId!==held.itemId || !Number.isInteger(current.level))return;
    // Both bytes move together in every observed 17004 success transition and
    // match the independent login record's existing enhancement level.
    record[73]=current.level;
    record[74]=current.level;
    require('./reforge-record').patch(record,held,EQUIPMENT_ADAPTER.reforge);
  }catch{}finally{
    soulRules.patchRecord(record,held,SOULS.get(held.guid,held.itemId));
    require('./equipment-forging').patchRecord(record,PROGRESSION.crafting.state,held.guid);
  }
}
function equipFrame(pos, bagSlot, itemId, count, guid) {
  if (!EQ_TEMPLATE) return null;
  const b = Buffer.from(EQ_TEMPLATE);
  b.fill(0,16,506);
  const held = BAG?.slotMap?.get(bagSlot);
  if (held && held.itemId===itemId && held.guid?.toLowerCase()===guid?.toString('hex') && WALLET?.blob) {
    const record=require('./roledata').itemRecord(WALLET.blob,bagSlot,held);
    patchEnhancementLevel(record,held);
    record.subarray(0,490).copy(b,16);
  }
  b[12]=pos;b[13]=itemId===0xffff?0xff:0;
  b.writeUInt16LE(bagSlot & 0xffff, 14);
  b.writeUInt32LE(itemId >>> 0, 16);
  b.writeUInt32LE(count >>> 0, 20);
  (guid || Buffer.alloc(8)).copy(b, 24);
  b.writeUInt32LE(7,506);
  return b;
}
function activeEquipmentFrames(){
  return Array.from({length:6},(_,slot)=>{
    const e=EQUIP.get(slot);
    return e&&e.itemId!==0xffff?equipFrame(slot,e.bagSlot,e.itemId,e.count,e.guid):equipFrame(slot,65535,65535,0,Buffer.alloc(8));
  }).filter(Boolean);
}
function equipmentSnapshotFrames(all=false){
  const count=18;
  return Array.from({length:count},(_,pos)=>{
    const e=planEntry(pos);
    return e&&e.itemId!==0xffff?equipFrame(pos,e.bagSlot,e.itemId,e.count,e.guid):
      equipFrame(pos,0xffff,0xffff,0,Buffer.alloc(8));
  }).filter(Boolean);
}

// 角色列表账号替换�?287）。结构见 charlistpatch.js�?//   +17..20 = 账号 UID(4 字节)�?21 起是 NUL 结尾�?ASCII 账号名�?// �?旧版把名字长度当成在 +20（其实是 UID 最高字节），换账号时会�?UID 写坏 —�?//   实测后果：客户端�?`1016`(建角�? 而不�?`1012`(进游�?，卡�?GameState=4�?
const patchCharlist = require('./charlistpatch').patchCharlist;

// ===== 登录账号 → UID（1287 里必须和客户端本地缓存的一致，否则客户端发 1016 建角色）=====
// 表是 account-uid.json（值从真机抓包量出来的）；客户端发 1012 时会把它自己的 UID 带上来，
// 那时如果表里没有/不一致就学一笔并落盘（下次启动就认得这个账号了）。
const ACCOUNT_UID_FILE = process.env.DSH_ACCOUNT_UID_FILE || path.join(__dirname, argOf('account-uid', 'account-uid.json'));
const ACCOUNT_UID = (() => { try { return JSON.parse(fs.readFileSync(ACCOUNT_UID_FILE, 'utf8')); } catch { return {}; } })();
// Opt-in until the rest of the legacy role snapshot is migrated. One lobby
// process has one explicit economy owner; never attach a second login to it.
const playerState=require('./player-account-state');
const onlineWire=require('./player-online-protocol');
const rewardMail=require('./player-reward-mail');
const playerHeroes=require('./player-heroes'),heroRewards=require('./player-hero-rewards');
const PLAYER_ACCOUNTS=process.env.DSH_PLAYER_ACCOUNTS ? new playerState.PlayerAccounts(path.resolve(process.env.DSH_PLAYER_ACCOUNTS)) : null;
const PLAYER_SCOPE=PLAYER_ACCOUNTS?.get(Number(process.env.DSH_PLAYER_UID));
const BATTLE_TICKETS=process.env.DSH_BATTLE_TICKETS?new (require('./player-battle-ticket').BattleTickets)(process.env.DSH_BATTLE_TICKETS):null;
if(BATTLE_TICKETS&&!PLAYER_SCOPE)throw Error('Battle tickets require an explicit account');
if(PLAYER_ACCOUNTS&&!PLAYER_SCOPE)throw Error('Explicit existing DSH_PLAYER_UID required for account runtime');
const NAME_BROKER=PLAYER_ACCOUNTS&&process.connected?require('./player-account-name-client').create({uid:PLAYER_SCOPE.uid}):null;
const PLAYER_ONLINE=PLAYER_ACCOUNTS ? new playerState.OnlineSessions(PLAYER_ACCOUNTS,{canAccrue:()=>!economyFrozen()}) : null;
if(PLAYER_ONLINE){
  ECONOMY_WRITE_MESSAGES.add(11545);
  ECONOMY_WRITE_MESSAGES.add(27616);
  ECONOMY_WRITE_MESSAGES.add(27602);
  ECONOMY_WRITE_MESSAGES.add(27613);
  ECONOMY_WRITE_MESSAGES.add(14004);
  ECONOMY_WRITE_MESSAGES.add(1452);
  setInterval(()=>{if(economyFrozen())return;for(const uid of PLAYER_ONLINE.active.keys()){
    try{PLAYER_ONLINE.tick(uid);}catch(error){log('Account online save failed: '+error.message);}
  }},10000).unref();
}
const ACCOUNT_AVATAR_POLICY=PLAYER_ACCOUNTS?require('./player-avatar').policyFromFrames(S.batches.flatMap(batch=>batch.frames.map(packet=>packet.frame))):null;
function findLoginAccount(login){
  if(process.env.DSH_PUBLIC_BETA==='1'){
    const localSeed=require('./public-beta/native-seed');
    if(localSeed.isPrivateOriginal||localSeed.isPublicSnapshot)return localSeed.findAccount(PLAYER_ACCOUNTS,login);
  }
  return PLAYER_ACCOUNTS.find(login);
}
function lookupUid(account) {
  if (!account) return null;
  if(PLAYER_ACCOUNTS)return findLoginAccount(account)?.uid??null;
  const v = ACCOUNT_UID[account] !== undefined ? ACCOUNT_UID[account] : ACCOUNT_UID[account.toLowerCase()];
  if (v === undefined || v === null) return null;
  const n = typeof v === 'string' ? parseInt(v.replace(/^0x/, ''), 16) : (v >>> 0);
  return Number.isFinite(n) ? (n >>> 0) : null;
}
function learnUid(account, uid, why) {
  if (!account || uid === null || uid === undefined) return false;
  if(PLAYER_ACCOUNTS){if(lookupUid(account)!==uid)throw Error('Account UID mismatch');return false;}
  const cur = lookupUid(account);
  if (cur === (uid >>> 0)) return false;
  ACCOUNT_UID[account] = '0' + (uid >>> 0).toString(16);
  try { fs.writeFileSync(ACCOUNT_UID_FILE, JSON.stringify(ACCOUNT_UID, null, 1)); } catch { }
  log(`账号 UID 学习：${account} = 0x${(uid >>> 0).toString(16)}${cur === null ? '' : `（原 0x${cur.toString(16)}）`}  来源：${why}`);
  return true;
}

// ================= 日志 =================
/** 已知的 UI/轮询类请求：载荷有时也长得像"两个格子号"，绝不能被当成调换位置 */
const UI_NOISE_MSGS = new Set([11582, 11529, 11874, 9117, 9125, 13620, 11541, 1020, 11543, 23533, 23543,
  11551, 11646, 11650, 11532, 11547, 11554, 11588, 13573, 17042, 11705, 1447, 27605, 27608, 9034, 11752,
  11801, 9155, 11919, 36279, 36290, 36295, 13203, 1547, 17603, 11888, 20102, 1493, 23563, 23519, 23518,
  11562, 20305, 20306, 20307, 17002, 13502, 13504, 16811, 17005, 9063, 1297, 36034, 20002, 1012, 1287]);

/**
 * 客户端"只上报状态、连真服都不回应答"的请求（**实证：抓包里零应答**）。
 * 真服里这些是纯通知；我们以前不回，客户端会静默到 6000ms 的兜底批次才被动，
 * 体感就是"点了没反应"。现在明确当已知：记一笔、清掉兜底计时器、不推任何帧。
 *
 * 证据：`node msgscount.js <msgid>`（req/resp 计数里 resp 全 0）。
 *   ⚠ 这些**不能**当成"要处理的动作" —— 例如 17012 只是"背包页签/筛选变了"，
 *     真动道具的是紧随其后的 17003(拖拽)。
 *   ⚠ **23513 / 20102 / 11058 不在这里**：它们正是"装备栏怎么画的"那条链
 *     （真人会话里 `23513#2` 批里就是 6 条 1043；把它们当静默会让装备面板永远是空的）。
 */
const SILENT_NOTIFY = new Map([
  [17012, '背包 UI 通知（真人会话里紧跟拖拽/卸装之后，1 字节载荷）'],
  [9013, 'UI 上报（抓包里 7 次 / 0 次应答）'],
  [16802, '商城 UI 上报（抓包里 7 次 / 0 次应答）'],
  [17602, 'UI 上报（抓包里 1 次 / 0 次应答）'],
  [11545, '新在线奖励查询的伴随通知（抓包里 0 次应答）'],
  [11677, 'UI 上报（真人会话里与 11687 成对）'],
  [11687, 'UI 上报（真人会话里与 11677 成对）'],
  // ⚠ 27298 曾经被当成"UI 上报（0 应答）"，**其实是战场进图请求**：
  //   `logs/cap-2026-09-27T10-13-20-match` 里 3 次 27298 对应 3 场对局，每次都紧跟 1040
  //   （见 modeentry.js 的规则）。所以它**不能**留在这个"静默"表里 —— 上面"进玩法模式"那段会先接住它。
  [27348, '房间 UI 上报（真人会话里 1 次 / 0 次应答）'],
]);

const LOG_DIR = process.env.DSH_LOG_DIR || path.join(__dirname, 'logs');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// `DSH_LOG_FILE` 可以**把日志钉到指定文件**：离线测试要断言"某条日志写出来了"（见 `sorttest.js`），
// 而"取 logs 下最新的 liveserver-*.log"这种做法会被**同时跑着的私服**写的新日志抢走（实测踩到）。
const LOG = process.env.DSH_LOG_FILE || path.join(LOG_DIR, `liveserver-${stamp}.log`);
const fd = fs.openSync(LOG, 'a');
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23);
function log(s) { const l = `[${ts()}] ${s}`; console.log(l); try { fs.writeSync(fd, l + '\n'); } catch { } }
if (economyFrozen())
  log(`经济写入冻结：邮件=${JSON.stringify(MAIL_STATE.pendingDiagnostics())} 装备=${JSON.stringify(EQUIPMENT_COMMIT.pending)}`);
const hx = (b, n = 32) => b.subarray(0, Math.min(b.length, n)).toString('hex').replace(/(..)/g, '$1 ').trim();

// ===== 金币 / 钻石：角色数据帧(msgid 1013，外�?1166) =====
// 证据�?gold.js 头注释：金币 = 解开后的角色数据 +141 �?u32，两个账号交叉验证�?
const GOLD_ENABLED = argOf('gold', 'on') !== 'off';
const currencyOfItem = require('./gold').currencyOfItem;
/** 使用道具给什么：按道具描述/覆盖表（itemreward.js）—— 见 USEREWARD 说明 */
const resolveReward = require('./itemreward').resolveReward;
const rewardOptions = require('./itemreward').rewardOptions;
let WALLET = null;
if (GOLD_ENABLED) {
  let roleFrame = null;
  for (const b of S.batches) {
    for (const p of b.frames) if (p.msgid === 1166) {
      const blob=require('./roledata').inflate(p.frame.subarray(12));
      if(blob?.length===288458&&blob.readUInt16LE(8)===1013&&(!PLAYER_SCOPE||blob.readUInt32LE(22)===PLAYER_SCOPE.playerId&&blob.readUInt32LE(26)===PLAYER_SCOPE.uid)){roleFrame=p.frame;break;}
    }
    if (roleFrame) break;
  }
  if (roleFrame) {
    WALLET = new (require('./gold').Wallet)(roleFrame, s => log(s), {accountMode:!!PLAYER_SCOPE});
    const want = argOf('gold-value', '');
    if (!economyFrozen() && want !== '' && Number.isFinite(+want)) { WALLET.gold = +want; WALLET.save(); }
    if (!WALLET.ok) { log('!! 角色数据帧解不开，金币功能关闭'); WALLET = null; }
    else log(`金币功能开：录制�?${WALLET.recordedGold} �?当前 ${WALLET.gold}（状态文�?gold-state.json）`);
    // 从录制里�?1045 帧取各货币属性的**基线�?*�?045 只推变化过的属性，没出现的就没基线�?
    if (WALLET.attrs) {
      WALLET.seedRecordedBalances(S.batches.flatMap(b=>b.frames.map(p=>p.frame)));
      for (const spec of (economyFrozen() ? [] : String(argOf('attr-seed', '')).split(';').filter(x => x.trim()))) {
        const [id, v] = spec.split(':').map(Number);
        if (Number.isInteger(id) && Number.isFinite(v)) { WALLET.attrs[id] = v; log(`�?--attr-seed 设属�?${id} = ${v}`); }
      }
      const nm = require('./gold').ATTR_NAME;
      const have = Object.keys(nm).map(Number).filter(id => WALLET.attrs[id] !== undefined)
        .map(id => `${nm[id]}(${id})=${WALLET.attrs[id]}`).join('  ');
      log(`货币属性基线：${have || '(�?'}`);
    }
  } else log('!! 录制里没有 msgid=1166 的角色数据帧，金币功能关闭');
}
// 测试钩子�?-give-gold=1000@1297#3  表示「客户端�?3 次发 1297 时，�?1000 金币并重发角色数据帧」�?// 用来验证"运行中发�?这条路径（正常玩法里由「使用金币道具」触发，�?useBagSlot）�?
const GIVE = (() =>
{
  const a = argOf('give-gold', '');
  const m = /^(\d+)@(\d+)#(\d+)$/.exec(a);
  return m ? { amount: +m[1], msgid: +m[2], nth: +m[3] } : null;
})();
if (GIVE) log(`测试钩子：客户端�?${GIVE.nth} 次发 ${GIVE.msgid} 时加 ${GIVE.amount} 金币并重推角色数据帧`);

/**
 * 造一条当前状态的角色数据帧（金币 + 背包一起写进去）�? * �?为什么必须连背包一起写：角色数据体里存着**整张背包**（每�?493 字节定长记录�? *   �?roledata.js）。只改金币重发，客户端会用帧�?*录制�?*的背包重�?—�? *   表现就是「刚用掉的道具又回来了」�? */
const BAG_SYNC = argOf('bag-sync', 'full');        // Also clear captured items in empty slots.
/** 空格子写什么（只有 bag-sync=full 时用得上）：ffff（默认，协议里"空"就是这么表示的）| zero */
const BAG_EMPTY = (argOf('bag-empty', 'ffff') === 'zero') ? 0x0000 : 0xFFFF;
/**
 * 金币变更用哪条通道推给客户端（**已由真实服抓包定�?*，见 GOLD_RESULT.md）：
 *   1045 = 只发一条属性同�?`01 32 <u32 新�?`   �?**真实服就是这么干�?*，轻量、有飘字、不卡不跳面�? *   roledata = 重发整条角色数据�?1166/1013)      �?能用但太重：客户端要重解 288KB + 重建背包�? *                                                   实测「卡一下并跳到个人信息面板」（真实服不会这样）
 *   both / off
 *
 * 实证（logs/cap-2026-09-27T02-22-47，用户在真实服上花钱/赚钱）：
 *   msgid=1045 flags=0xd3  `01 32 95 e6 07 00` = 属�?50 = 517781   （跳跃红�?+888�? *   …�?8 次推送与用户口述的每一次金币变�?*逐个对上**
 *   同类：属�?157 = 绑定钻石（�?×100�?800 = 88.00）�?2 = VIP点�?56 = 挑战�? */
const GOLD_PUSH = argOf('gold-push', '1045');   // 1045 = 逐字节复刻真实服那条（默认）；roledata = 重发整条角色数据（会卡）
/**
 * 角色数据帧（1166）的记录区和客户端开放的背包格子是两种容量。
 * 以前 roledata.js 写死 192：只重写前 192 格，**后面 360 格原样留着录制时的旧道具**，
 * 于是客户端显示的道具我们模型里没有（点它装备会串格、还有放不进东西的空洞），
 * 而且客户端算出来的空格比我们少 → "背包没满却提示满"（用户实测）。
 * --bag-records=552 保持角色记录区完整；--bag-capacity=192 限制所有客户端可操作格子。
 */
const BAG_SLOTS_FOR_FRAME = (() => {
  const n = BAG_RECORD_CAPACITY;
  const got = require('./roledata').setBagSlots(n);
  if (got !== n || !require('./inventory-capacity').validLimits(BAG_VISIBLE_CAPACITY,n))
    throw new Error('Invalid bag capacity/record space: client cache supports <=352; role records may be 552');
  console.log(`角色记录空间 ${got} 格；客户端可访问背包 ${BAG_VISIBLE_CAPACITY} 格`);
  return got;
})();
/**
 * 登录时要不要主动推"有新邮件"（20308）？
 *   off（默认）—— 什么都不推。用户实测"登录会自动打开邮件"，就是因为推了 20308（它是"新邮件"通知，
 *                  客户端收到就弹邮箱）；真服也只在真有新邮件到账时推。邮箱数据等客户端发 20307 再回 20311。
 *   all         —— 恢复旧行为：登录把每封邮件推一条 20308（调试/对比用）。
 */
const MAIL_LOGIN_NOTIFY = String(argOf('mail-login-notify', 'off')).toLowerCase();
// Legacy --mail-startup-poll-guard is intentionally ignored. Native 20311
// initializes its mailbox silently on the first response (0xaee0b2), then
// clears the startup flag at 0xaee1fc. Dropping it eats the first user click.
const BAG_BRACKET = argOf('bag-use-bracket', 'off') === 'on';   // 14007/14008 那对（实测会让界面乱，默认不发）

/**
 * ===== 商城购买（msgid 16811�?====
 * 真实服实证（logs/cap-2026-09-27T02-22-47，用�?5 次购买）�? *
 *   C→S 16811 len=30（载�?18�?
 *       +0  u32 货架id      +4 u16 数量      +6 u16 货币类型(3=金币, 12=绑定钻石)
 *       +8  u32 道具ID      +12 u16 0        +14 u32 100(含义未定，五次都�?100)
 *   S→C:
 *       16805 len=18  载荷 `00 00 <货架id u32>`          购买回执（第 1 字节像是结果码）
 *       17015 len=18  载荷 `08 01 <道具ID u16> 01 01`    道具入包（kind 0x0108�? *       11523 / 11553                                    材料类到账（增量�? *       1045          `01 <货币属�? <新�?`              扣钱
 *
 * Current catalog, currency evidence and operator settings: SHOP-OPERATIONS.md.
 */
// The captured 16804 server catalog has 2076 exact shelf/item/price rows.
// It includes 2412 and the newly observed 2482/2663, which the old handwritten
// map missed. A request is still gated by page, currency, discount and storage.
const shopCatalog = require('./shop-catalog');
const SHOP_CATALOG = new shopCatalog.ShopCatalog(process.env.DSH_SHOP_SETTINGS || shopCatalog.SETTINGS);
const exchangeShop=require('./shop-exchange');
ECONOMY_WRITE_MESSAGES.add(16823);
let SHOP = SHOP_CATALOG.rows;
// Isolated grant tests may supply an explicit catalog inside their private
// state directory. This route is unavailable to normal server processes.
if (process.env.DSH_TEST_WRITE_ROOT && process.env.DSH_TEST_SHOP_CATALOG) {
  const root = path.resolve(process.env.DSH_TEST_WRITE_ROOT);
  const file = path.resolve(process.env.DSH_TEST_SHOP_CATALOG);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('test shop catalog outside isolation');
  for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    if (!Number.isInteger(r.shelf) || !Number.isInteger(r.itemId) || ![50,72,157].includes(r.attr) ||
        !Number.isSafeInteger(r.unit) || r.unit <= 0 || SHOP.has(r.shelf)) throw new Error('invalid test shop catalog');
    const row={shelf:r.shelf,itemId:r.itemId,attr:r.attr,testUnit:r.unit,discount:100,enabled:true,maxQuantity:255};
    SHOP.set(r.shelf,row);SHOP_CATALOG.base.set(r.shelf,row);
  }
}
const CUR_ATTR = Object.fromEntries(Object.entries(shopCatalog.currencies).filter(([,c])=>c.attr).map(([id,c])=>[id,c.attr]));
const SHOP_LIMIT_FILE=process.env.DSH_SHOP_LIMIT_STATE||path.join(__dirname,'shop-limit-state.json');
let SHOP_LIMIT_STATE;
try{SHOP_LIMIT_STATE=JSON.parse(fs.readFileSync(SHOP_LIMIT_FILE,'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;SHOP_LIMIT_STATE={counts:{},pending:null};}
if(!SHOP_LIMIT_STATE||typeof SHOP_LIMIT_STATE!=='object'||!SHOP_LIMIT_STATE.counts)
  throw new Error('invalid shop limit state');
function saveShopLimit(){
  const tmp=`${SHOP_LIMIT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(SHOP_LIMIT_STATE,null,2));renameWithRetry(tmp,SHOP_LIMIT_FILE);
}
function configuredShopLimit(row){return row.limit?.count||null;}
function shopLimitFailure(row,shelf,qty){
  if(SHOP_LIMIT_STATE.pending)return '限购交易待核对';
  const limit=configuredShopLimit(row),key=shopCatalog.limitKey(row);
  return limit&&(SHOP_LIMIT_STATE.counts[key]||0)+qty>limit?'已达限购数量':null;
}
/** Gold-only login reward discount observed in five genuine purchases. */
const SHOP_GOLD_DISCOUNT = (() => {
  const value=+argOf('shop-gold-discount','85');
  if(![85,95,100].includes(value))throw new Error('invalid shop-gold-discount');
  return value;
})();
/** Normal client prices take precedence, including a zero current refund. */
const DESTROY_REFUND = require('./item-destroy-refund').refunds;

const RES = {};
const RESOURCE_FILE = process.env.DSH_RESOURCE_STATE || path.join(path.dirname(BAG_LIVE),path.basename(BAG_LIVE).replace(/\.json$/,'.resources.json'));
for (const b of S.batches) for (const p of b.frames) {
  // The login inventory is a full 11552 snapshot. Medals can exist only here:
  // an absent key in the saved delta means "unchanged", not a zero balance.
  if(p.msgid===11552){
    const body=p.frame.subarray(12);
    if(body.length>=4){
      const count=body.readUInt32LE(0);
      if(count<=4096 && body.length===4+count*8)for(let i=0;i<count;i++){
        const id=body.readUInt32LE(4+i*8);
        if(isResourceItem(id) && RES[id]===undefined)
          RES[id]=body.readUInt32LE(8+i*8);
      }
    }
  }
  if(p.msgid===11553 && p.frame.length===20){const id=p.frame.readUInt32LE(12);if(RES[id]===undefined)RES[id]=p.frame.readUInt32LE(16);}
}
try { Object.assign(RES,JSON.parse(fs.readFileSync(RESOURCE_FILE,'utf8'))); } catch {}
// Current clients keep rune fragments (7421) in the resource container.  A
// previous local state stored the same pool only in MATERIAL_LIVE, so hydrate
// RES before building the login 11552 snapshot to keep both views coherent.
if(BAG?.itemMap?.has(7421)) RES[7421]=Math.max(0,Number(BAG.itemMap.get(7421))||0);
function saveResources(){fs.writeFileSync(RESOURCE_FILE,JSON.stringify(RES));}
const {containerOf,classifyItem} = require('./item-containers');
const isolatedEquipmentRules = (() => {
  if(process.env.DSH_EQUIPMENT_TEST_RULES!=='1')return null;
  const root=process.env.DSH_TEST_WRITE_ROOT;
  const underRoot=file=>file && path.resolve(file).toLowerCase().startsWith(path.resolve(root).toLowerCase()+path.sep);
  if(!root || !path.resolve(root).toLowerCase().startsWith(path.resolve(require('os').tmpdir()).toLowerCase()+path.sep) ||
     argOf('ports','')!=='0' || !process.execArgv.some(x=>x.endsWith('test-write-guard.js')) ||
     ![BAG_LIVE,MATERIAL_LIVE,RESOURCE_FILE,EQUIP_STATE_FILE,process.env.DSH_GOLD_STATE,
       process.env.DSH_ENHANCEMENT_STATE,process.env.DSH_REFORGE_STATE,EQUIPMENT_PENDING_FILE].every(underRoot))
    throw new Error('equipment test rules require guarded temporary state and random TCP port');
  return require('./equipment-isolated-rules');
})();
const ordinaryEnhancementRules=require('./enhancement-rules');
const ordinaryEnhancementWire=require('./enhancement-query-wire');
const localEquipmentRules=require('./equipment-local-rules');
const localEquipmentWire=require('./equipment-live-wire');
const localEquipmentEnabled=process.env.DSH_EQUIPMENT_POLICY!=='off';
const guardedEquipmentDraw=process.env.DSH_TEST_WRITE_ROOT &&
  process.execArgv.some(x=>x.endsWith('test-write-guard.js')) &&
  argOf('ports','')==='0' && process.env.DSH_TEST_EQUIPMENT_DRAW!==undefined;
const legacyEnhancement=new (require('./enhancement-instance').LegacyEnhancementInstances)(
  WALLET?.blob,[path.resolve(CAP),path.join(__dirname,'logs','cap-2026-09-29T10-14-06')]);
const EQUIPMENT_ADAPTER = BAG ? new (require('./equipment-persistence-adapter').EquipmentPersistenceAdapter)({
  bag:BAG,resources:RES,wallet:WALLET,
  files:{enhancement:process.env.DSH_ENHANCEMENT_STATE || path.join(__dirname,'enhancement-state.json'),
    reforge:process.env.DSH_REFORGE_STATE || path.join(__dirname,'reforge-state.json'),
    pending:EQUIPMENT_PENDING_FILE,resource:RESOURCE_FILE,material:MATERIAL_LIVE,
    wallet:process.env.DSH_GOLD_STATE || path.join(__dirname,'gold-state.json'),
    saveResources,saveMaterials:()=>saveMaterialLive(BAG.itemMap,true)},
  isEquipment:isEquipmentItem,isFrozen:()=>MAIL_STATE.hasUnresolvedPending(),
  journal:EQUIPMENT_COMMIT,
  rules:isolatedEquipmentRules?.rules || (localEquipmentEnabled?localEquipmentRules:{
    enhancementRuleFor:ordinaryEnhancementRules.ruleFor,
    attributesFor:ordinaryEnhancementRules.attributesFor}),
  wire:isolatedEquipmentRules?.wire || (localEquipmentEnabled?localEquipmentWire:
    {enhancementQuery:ordinaryEnhancementWire.enhancementQuery}),
  legacyFor:(guid,itemId)=>legacyEnhancement.get(guid,itemId),
  random:isolatedEquipmentRules || guardedEquipmentDraw
    ? ()=>Number(process.env.DSH_TEST_EQUIPMENT_DRAW ?? 0) : Math.random,
}) : null;
function slotReward(item){return containerOf(item.itemId)==='slot';}
function runeFragmentBalance(){
  const resource=Number(RES?.[7421]);
  if(Number.isSafeInteger(resource)&&resource>=0)return resource;
  const primary=Number(BAG?.itemMap?.get(7421));
  if(Number.isSafeInteger(primary)&&primary>=0)return primary;
  const legacy=Number(BAG?.itemMap?.get(7354));
  return Number.isSafeInteger(legacy)&&legacy>=0?legacy:0;
}
function setRuneFragmentBalance(value){
  const count=Math.max(0,Math.min(0xffffffff,Number(value)||0));
  RES[7421]=count;
  if(BAG?.itemMap?.has(7421)||!BAG?.itemMap?.has(7354))BAG?.itemMap?.set(7421,count);
  if(CLIENT_PROGRESS_FIXTURE&&BAG?.itemMap?.has(7354))BAG.itemMap.set(7354,count);
  return count;
}
function runeTokenBalance(itemId){
  const id=Number(itemId); if(!BAG?.slotMap||!Number.isInteger(id)||id<=0)return 0;
  return [...BAG.slotMap.values()].reduce((sum,value)=>sum+(Number(value?.itemId)===id?Math.max(0,Number(value.count)||0):0),0);
}
// Native resource/material flags are session-specific.  The 8824 rune
// capture uses 0x000d for 11553 (and the same flag is present on the paired
// 11686/11688 replies); older sessions used 0xca/0xd3.  Reusing a hard-coded
// flag makes the frame arrive on the socket but the client silently ignores
// the balance update.  Prefer the flag from the active capture whenever it is
// available, then fall back to the legacy value for older recordings.
function nativeFrameFlags(msgid, fallback) {
  try {
    const sample=CAPTURED_NATIVE_ACK?.get(Number(msgid));
    if(sample?.length>=12) return sample.readUInt16LE(10);
  } catch {}
  return fallback;
}
function resourceBalanceFrame(itemId, balance, flags = null) {
  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(itemId, 0);
  payload.writeUInt32LE(balance, 4);
  return bagMod.mkFrame(11553, payload, {flags:flags===null?nativeFrameFlags(11553,0xd3):flags});
}
function runeMaterialDeltaFrames(changes) {
  if(!bagMod || !BAG?.itemMap || !Array.isArray(changes) || !changes.length) return [];
  const frames=[];
  for(const change of changes){
    const id=Number(change?.id), count=Math.max(0,Number(change?.count)||0);
    if(!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(count)) continue;
    // The rune dialog listens to the 11523 material container. Its delta has
    // the same shape as a one-row snapshot: u32 row count, then item id and
    // balance. A bare 11553 counter is accepted by some inventory panels but
    // does not refresh the fragment number shown on the exchange page.
    const payload=Buffer.alloc(12);
    payload.writeUInt32LE(1,0);
    payload.writeUInt32LE(id>>>0,4);
    payload.writeUInt32LE(count>>>0,8);
    frames.push(bagMod.mkFrame(11523,payload,{flags:nativeFrameFlags(11523,0xca)}));
  }
  return frames;
}
// Rune fragments are stored in the resource container (item 7421), not the
// ordinary 11523 material table.  The real exchange/demolish sequence sends a
// one-row 11553 balance update before 11686/11684.  Keep the legacy 7354 test
// item on 11523 for old fixture accounts, but route the native fragment id
// through 11553 so the exchange page refreshes immediately.
function runeFragmentDeltaFrames(changes) {
  if(!Array.isArray(changes)||!changes.length) return [];
  const frames=[];
  for(const change of changes){
    const id=Number(change?.id), count=Math.max(0,Number(change?.count)||0);
    if(id===7421) frames.push(resourceBalanceFrame(id,count,nativeFrameFlags(11553,0x0d)));
    else if(id===7354) frames.push(...runeMaterialDeltaFrames([{id,count}]));
  }
  return frames;
}
function addRuneFragmentsToBag(amount) {
  const delta=Number(amount)||0;
  if(delta===0 || (!BAG?.itemMap && RES?.[7421]===undefined)) return [];
  // 7421 is the native resource item. Keep the optional 7354 mirror in sync
  // for the fixture, but emit only the 11553 update for the real client.
  const count=setRuneFragmentBalance(runeFragmentBalance()+delta);
  return runeFragmentDeltaFrames([{id:7421,count}]);
}
// 11552 is the complete resource inventory. A login-time 11553 for a saved
// item can arrive before this recorded snapshot; replaying the old snapshot
// then removes that item from the client's material bag. Preserve the captured
// row order and replace balances with the live state, appending confirmed new
// resource IDs such as fusion cards that were absent from the recording.
function resourceFullFrame(recorded) {
  const body=recorded.subarray(12), count=body.readUInt32LE(0);
  if(body.length!==4+count*8 || count>4096) throw new Error('invalid captured 11552 resource snapshot');
  const rows=new Map();
  for(let i=0;i<count;i++){
    const id=body.readUInt32LE(4+i*8), balance=body.readUInt32LE(8+i*8);
    if(!id||rows.has(id))throw new Error('invalid captured 11552 resource row');
    rows.set(id,balance);
  }
  for(const [key,balance] of Object.entries(RES)){
    const id=+key;
    if(!Number.isInteger(id)||id<1||id>0xffffffff||
        !Number.isSafeInteger(balance)||balance<0||balance>0xffffffff)
      throw new Error('invalid saved resource balance');
    if(rows.has(id)||containerOf(id)==='resource')rows.set(id,balance);
  }
  const payload=Buffer.alloc(4+rows.size*8);payload.writeUInt32LE(rows.size,0);
  let i=0;
  for(const [id,balance] of rows){payload.writeUInt32LE(id,4+i*8);payload.writeUInt32LE(balance,8+i*8);i++;}
  return bagMod.mkFrame(11552,payload,{flags:recorded.readUInt16LE(10),stream:recorded.readUInt32LE(4)});
}

/**
 * ===== 邮件（msgid 20305/20306/20307�?====
 * 真实服实证（logs/cap-2026-09-27T02-56-55，用户开�?6 �?+ 在线奖励那封）：
 *
 *   C→S 20305 len=17  载荷 `<u32 邮件id> 05`   �?读信/选信
 *   C→S 20306 len=16  载荷 `<u32 邮件id>`      �?领取这一�? *   C→S 20307 len=12  载荷 �?                 �?全选一键领�? *   S→C 20308/20310   载荷 = `[u32 邮件id][u32 0][u32 玩家ID][u32 时间][u32 serverId][…GBK 标题+正文]`
 *                     长度随标题变长；**同一封邮�?未领�?�?已领�?�?*（例�?49 �?98�? *                     实测标题：累计充�?钻（限一次）/ 累计充�?�?/ 2026灵梦の赛钱箱 /
 *                               日常挑战�?莫比乌斯�?10已自动使�? / 夏日签到 / 活动期间每日登陆
 *   附件到账：道具走 `17015(0x0117)+17004`、货币走 `1045`（用户口�?+ 抓包一致）
 *
 * 服务端做法：**直接回放抓下来的真实�?*（`mail-recorded.json`，由 `mailextract.js` 生成），
 * �?已领�?未领�?挑长度不同的那条；领取时按附件表发东西�? */
const MAIL = (() => { try { return JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'mail-recorded.json'), 'utf8')); } catch { return null; } })();
// The deployed A baseline has all seven recorded mails claimed. A positive
// source recipient plus its current claim record permits that historical
// display; it does not import unread rights into a newly initialized scope.
// Future unclaimed legacy migration requires a separate explicit contract.
const LEGACY_MAIL_IDS=(()=>{
  if(!PLAYER_ACCOUNTS)return new Set();
  try{return require('./player-mail-legacy-proof').ownedIds(PLAYER_SCOPE,MAIL);}
  catch(error){log('Legacy mail source unavailable: '+error.message);return new Set();}
})();
/** 邮件"已领�?状态（跨重启保留）：领过的不再发附件，读信也回"已领�?短帧 */
// Authoritative current mapping: registry + cap-2026-09-27T02-56-55 establish
// 20305=claim (u32 ID + 05), 20306=read (u32 ID), 20307=refresh (empty).
// Older investigative comments above this line used provisional labels.

// ===== 进玩法模式（训练场 / 战场）→ 送客户端去我们自己的对局服 =====
// 配方由 `node modeentry.js` 从真机抓包里抽出。**不写死 msgid**：抓包里"每条 1040 之前
// 最后一条 C→S 请求"就是进图触发请求（训练场是 `27360`，战场是 `27298`），
// 选模式那步（`27348` → `27349`+`27398`）单独一条。结构见 mode-entry.json。
const MODE_ENTRY = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, argOf('mode-entry', 'mode-entry.json')), 'utf8')); } catch { return null; }
})();
const MATCH_HOST = argOf('match-host', '127.0.0.1');
const MATCH_PORT = +argOf('match-port', '9004');
const BATTLE_HANDOFF_GATE=BATTLE_TICKETS?require('./player-battle-handoff-gate').createGate({
  ticketFile:process.env.DSH_BATTLE_TICKETS,uid:PLAYER_SCOPE.uid,playerId:PLAYER_SCOPE.playerId,
  mapId:252,host:MATCH_HOST,port:MATCH_PORT}):null;
/**
 * 每条进图触发可以指向**不同的对局服**：`--match-port-map=27360:9004,27298:9005`
 * （训练场一个、战场一个；我们的对局服一次只回放一场，所以两条路要分端口）。
 * 值可以写端口号（用 MATCH_HOST）或 `host:port`。
 */
const MATCH_PORT_MAP = (() => {
  const m = new Map();
  for (const kv of argOf('match-port-map', '').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = kv.indexOf(':');
    if (i < 0) continue;
    const k = +kv.slice(0, i), v = kv.slice(i + 1);
    m.set(k, v.includes(':') ? v : `${MATCH_HOST}:${v}`);
  }
  return m;
})();
/** 某条触发请求对应的配方（可能多条：按载荷里的模式号区分） */
function entriesFor(msgid) {
  if (!MODE_ENTRY) return [];
  const list = Array.isArray(MODE_ENTRY.触发) ? MODE_ENTRY.触发.filter(t => t.触发msgid === msgid) : [];
  return list.length ? list : [];
}
/**
 * 把 1040 帧里的"对局服地址"改写成我们自己的（IP 用 ASCII NUL 补齐、端口是 wss 前 6 字节处的 u16 LE）。
 * 记录里本来就是 127.0.0.1:9004，但换端口/换机器时必须能改；配方里给了 `对局`（"host:port"）就用它。
 */
function fixMatchAddr(frame, tagPrefix, 对局) {
  const b = Buffer.from(frame);
  if (b.length < 24 || b.readUInt16LE(8) !== 1040) return b;
  const [host, portStr] = (typeof 对局 === 'string' && 对局.includes(':')) ? 对局.split(':') : [MATCH_HOST, String(MATCH_PORT)];
  const port = +portStr;
  const payload = b.subarray(12);
  let end = 4; while (end < payload.length && payload[end] !== 0) end++;
  const wssIdx = payload.indexOf(Buffer.from('wss://', 'latin1'));
  if (end <= 4 || wssIdx < 6) return b;
  const oldIp = payload.subarray(4, end).toString('latin1');
  const oldPort = payload.readUInt16LE(wssIdx - 6);
  if (oldIp.length >= host.length) {
    const to = Buffer.alloc(end - 4, 0);
    Buffer.from(host, 'latin1').copy(to, 0);
    to.copy(b, 12 + 4);
    b.writeUInt16LE(port, 12 + wssIdx - 6);
    log(`${tagPrefix}· 1040 对局地址 ${oldIp}:${oldPort} → ${host}:${port}`);
  } else {
    log(`${tagPrefix}!! 1040 里的旧 IP "${oldIp}"(${oldIp.length}字节) 装不下 "${host}"(${host.length}字节) → 保持原样`);
  }
  return b;
}

const {resolveAttachments} = require('./mail-rewards');
/**
 * 邮件id → 附件（**真服实证**：logs/cap-2026-09-27T02-56-55 那次"全选领取"发的 6 条 17015 kind=0x0117，
 * 顺序与邮件顺序一一对应，见 `node mailmap.js`）：
 *   0x132d5230 → 7887 回路自选礼包（50）×2     0x132d5231 → 7887 ×3
 *   0x132d5232 →  408 2000金币 ×1              0x132d00c2 →  398 5000金币 ×1
 *   0x132d00c3 → 7888 回路自选礼包（40）×1     0x132d00c4 → 32695 激爽周末自选礼包 ×1
 *   0x132d5422 → 空（莫比乌斯币×10 是登录时自动用的，走 1045 属性 141）
 * ⚠ 以前这里写的是「2000金币礼包」(39355) /「5000金币礼包」(32316) —— 那是**猜的**，
 *   真服给的是道具 **408/398「2000金币/5000金币」**（要玩家自己点开用，和 404「300金币」同一族）。
 *   所以下面直接钉死 itemId，不再用「名字里有金币就折成货币」那条捷径（那条捷径会把道具吞掉、
 *   客户端背包里什么都看不到）。
 */
const MAIL_ATTACH = {
  0x132d5230: [{ name: '回路自选礼包（50）', count: 2, itemId: 7887 }],
  0x132d5231: [{ name: '回路自选礼包（50）', count: 3, itemId: 7887 }],
  0x132d5232: [{ name: '2000金币', count: 1, itemId: 408 }],
  0x132d5422: [],                                   // 莫比乌斯币*10 已自动使用
  0x132d00c2: [{ name: '5000金币', count: 1, itemId: 398 }],
  0x132d00c3: [{ name: '回路自选礼包（40）', count: 1, itemId: 7888 }],
  0x132d00c4: [{ name: '激爽周末自选礼包', count: 1, itemId: 32695 }],
};

/**
 * ===== 服务端生成的邮件（--mail-extra）=====
 * 用 mailgen.js 按协议**造**载荷：头 28B + GBK 标题/正文 + 附件段（FEFD 标记 + 长度 + protobuf）。
 * 造出来的帧和录制的走同一条路径（列表/读/领/全领），附件仍然由 grantToBag 发放。
 */
const MAILGEN = require('./mailgen');
const GBK = require('./gbk');
const MAIL_PLAYERID = (() => {
  for (const b of S.batches) for (const p of b.frames) if (p.msgid === 20308 || p.msgid === 20310) return p.frame.readUInt32LE(4) || 1345739761;
  return 1345739761;
})();
/** 附件实例 GUID（10 字节 varint）：由 (邮件id, 序号) 决定，稳定可复现 */
function mailGuidVarint(mailId, idx) {
  const v = (BigInt(mailId >>> 0) << 32n) | BigInt(0x40000000 + idx);
  return MAILGEN.writeVarint(v);
}
const EXTRA_MAILS = new Map();      // id(number) -> { id, unread:{hex}, read:{hex}, attach:[{name,count,itemId}] }
const MAIL_EXTRA_FILE = (() => {
  const f = process.env.DSH_MAIL_EXTRA || argOf('mail-extra', 'mail-extra.json');
  if (!f || f === 'off') return null;
  return path.isAbsolute(f) ? f : path.join(__dirname, f);
})();
let mailExtraMtime = 0;
/** 配置变了就重新生成（热加载）：邮件交互/登录时各调一次 */
function reloadExtraMails(why, force = false) {
  if (!MAIL_EXTRA_FILE) return false;
  try {
    const token = require('./persistence/state-files').changeToken(MAIL_EXTRA_FILE);
    if (!force && token === mailExtraMtime) return false;
    mailExtraMtime = token;
    EXTRA_MAILS.clear();
    loadExtraMails();
    console.log(`邮件配置已重新加载（${why}）：${EXTRA_MAILS.size} 封`);
    return true;
  } catch { return false; }
}
function loadExtraMails() {
  const f = process.env.DSH_MAIL_EXTRA || argOf('mail-extra', 'mail-extra.json');
  if (!f || f === 'off') return;
  const p = path.isAbsolute(f) ? f : path.join(__dirname, f);
  let list = [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    list = Array.isArray(j) ? j : (j.mails || []);
  } catch (e) { return; }
  // 没有背包模型（没给 --bag）就造不出邮件帧（要 bag.mkFrame）——以前这里会**启动即崩**
  // （TypeError: Cannot read properties of null），现在直接跳过并说明原因。
  if (!bagMod) { console.log(`--mail-extra=${path.basename(p)} 已忽略：没给 --bag，造不出邮件帧`); return; }
  for (const m of list) {
    const id = (m.id >>> 0) || (0x13300000 + EXTRA_MAILS.size + 1);
    const date = typeof m.createdAt === 'string' ? Date.parse(m.createdAt) : NaN;
    const createdAt = Number.isFinite(date) && date >= 0 ? Math.floor(date / 1000) : 0;
    const title = Buffer.isBuffer(m.title) ? m.title : GBK.encode(m.title || '私服邮件');
    const body = Buffer.isBuffer(m.body) ? m.body : GBK.encode(m.body || '');
    const atts = (m.attachments || []).map(a => ({ itemId: a.itemId, count: a.count }));
    if (atts.some(a => !Number.isSafeInteger(a.itemId) || a.itemId < 1 || a.itemId >= 0xffff ||
        !Number.isSafeInteger(a.count) || a.count < 1 || a.count > 0xffffffff)) {
      console.log(`邮件 0x${id.toString(16)} 附件含非法道具ID或数量，拒绝生成`);
      continue;
    }
    const unread = MAILGEN.buildMail({
      mailId: id, playerId: MAIL_PLAYERID, time: createdAt, title, body, flag0: 1, flag1: 0,
      attachments: atts.map((a, i) => ({ itemId: a.itemId, count: a.count, guidBytes: mailGuidVarint(id, i) })),
    });
    const claimed = MAILGEN.buildMail({ mailId: id, playerId: MAIL_PLAYERID, time: createdAt, title, body, claimed: true, attachments: [] });
    const wrap = (payload, msgid) => bagMod.mkFrame(msgid, payload, { flags: 0xd2, stream: MAIL_PLAYERID }).toString('hex');
    EXTRA_MAILS.set(id, {
      id, createdAt, unread: { hex: wrap(unread, 20308) }, read: { hex: wrap(claimed, 20310) },
      attach: atts.map((a, i) => ({ name: (ITEM_NAMES && ITEM_NAMES[a.itemId] ? ITEM_NAMES[a.itemId].name : String(a.itemId)), count: a.count, itemId: a.itemId })),
    });
    console.log(`邮件生成：0x${id.toString(16)} "${GBK.decode(title)}" 附件 ${atts.map(a => `${a.itemId}×${a.count}`).join('+') || '（无）'}（${unread.length} 字节，逐字段按协议造）`);
  }
  if (EXTRA_MAILS.size) console.log(`共生成 ${EXTRA_MAILS.size} 封服务端邮件（--mail-extra=${path.basename(p)}）`);
  try { mailExtraMtime = require('./persistence/state-files').changeToken(p); } catch { }
}
loadExtraMails();

function mailFrames(mailId) {
  const ex = EXTRA_MAILS.get(mailId >>> 0);
  if (ex) return { unread: ex.unread, read: ex.read, extra: true };
  const rec = MAIL && (MAIL['0x' + mailId.toString(16)] || null);
  if (!rec) return null;
  const sorted = [...rec.reads].sort((a, b) => b.len - a.len);   // �?未领取，�?已领�?
  return { unread: sorted[0], read: sorted[sorted.length - 1] };
}
function mkShopReceipt(shelf, code = 0) {
  const p = Buffer.alloc(6); p.writeUInt16LE(code, 0); p.writeUInt32LE(shelf >>> 0, 2);
  return bagMod.mkFrame(16805, p, { flags: 0xd3 });
}
function mkItemIn(itemId) {
  const p = Buffer.alloc(6); p.writeUInt8(0x08, 0); p.writeUInt8(0x01, 1);
  p.writeUInt16LE(itemId & 0xffff, 2); p.writeUInt8(0x01, 4); p.writeUInt8(0x01, 5);
  return bagMod.mkFrame(17015, p, { flags: 0xd3 });
}
const GOLD_ATTR = +argOf('gold-attr', '50');       // 50 = 金币（真实服实证�?const DIAMOND_ATTR = +argOf('diamond-attr', '157');// 157 = 绑定钻石（�?×100），钻石(0.08)那个还没定位
/**
 * 帧头偏移 4 �?会话/�?字段�?*逐字�?diff 出来�?*（真实服 vs 我们，见 diff1045.js）：
 *
 *   真实�? 12000000 f15b3650 1504 d300 | 013295e60700
 *   我们(�? 12000000 5b365026 1504 d300 | 013295e60700      �?f4 差一个字节，客户端就不认这条属性更�? *
 * 所以别再自己算�?*沿用录制�?1045 帧自带的那个�?*（同一场会话里它是一致的）�? * 实测该�?= 1345739761 = 0x50365BF1�? 玩家ID，与 20513 角色信息帧同源）�? */
const PLAYERID = (() => {
  for (const b of S.batches) for (const p of b.frames) if (p.msgid === 1045) { const v = p.frame.readUInt32LE(4); if (v) return v; }
  return 0;
})();
if(PLAYER_SCOPE&&PLAYER_SCOPE.playerId!==PLAYERID)throw Error('Account player ID does not match this role/economy scope');
const equipmentVisuals=require('./equipment-visuals');
let lobbyVisualState=new Map();
let lobbyVisualProfession=(()=>{
  for(const b of S.batches)for(const p of b.frames)if(p.msgid===11007&&p.frame.readUInt32LE(4)===PLAYERID){
    try{const id=require('./battle-protobuf').get(require('./battle-protobuf').decode(p.frame.subarray(13)),3);if(id)return id;}catch{}
  }
  return 53;
})();
function equipmentContextFrames(force=false){
  const next=equipmentVisuals.selected(EQUIP,GEM_BOARD.state);
  const out=[bagMod.mkFrame(11888,gemRules.actorPayload(GEM_BOARD.state,PLAYERID),{flags:0xca}),
    ...equipmentVisuals.packets(PLAYERID,lobbyVisualProfession,next,lobbyVisualState,{force})];
  lobbyVisualState=next;return out;
}
function mkAttrFrame(attrId, value, flags = 0xd3) {
  const p = Buffer.alloc(6);
  p.writeUInt8(1, 0); p.writeUInt8(attrId & 0xff, 1); p.writeUInt32LE(Math.round(value) >>> 0, 2);
  return bagMod.mkFrame(1045, p, { flags, stream: PLAYERID });   // 真实服这条的 flags = 0xd3
}
function honourFrame() {
  if(PLAYER_SCOPE&&!require('./player-wallet-wire').knownU32(WALLET?.state?.honour))return null;
  const p=Buffer.alloc(4);p.writeUInt32LE(WALLET.state.honour);
  return bagMod.mkFrame(1394,p,{flags:0xd3,stream:PLAYERID});
}
 function equippedEnhancementLevel(e){
  try{
    const state=EQUIPMENT_ADAPTER?.findInstance(e.guid);
    return state?.itemId===e.itemId && Number.isInteger(state.level) ? state.level : null;
  }catch{return null;}
 }
function equippedReforgeHex(e){
   try{
     const state=EQUIPMENT_ADAPTER?.findInstance(e.guid);
     return state?.itemId===e.itemId ? state.baselineHex : null;
   }catch{return null;}
 }
// Lobby-side attributes include the persistent rune board, magic-device gems,
// and currently allocated war-soul entries.  Keeping this merge here makes
// every 1045 rebuild use the same progression state that the battle loadout
// will consume after the next equipment change.
function progressionAttributeSources(){
  const proto=require('./progression-systems').ProgressionSystems.prototype;
  const model={...PROGRESSION,activeWarSoulUnits:proto.activeWarSoulUnits};
  const ids=[...EQUIP.values()].filter(e=>e&&ITEM_TYPES[e.itemId]==='magicgemequip').map(e=>Buffer.isBuffer(e.guid)?e.guid.toString('hex'):e.guid);
  const magic=PROGRESSION.magicGem.state;
  const activePlan=Number(activeEquipmentPlan)||0;
  const dedicated=magic.equippedBySet?.[activePlan]||(!magic.equippedBySet?magic.currentDeviceGuid:null);
  if(dedicated)ids.push(dedicated);
  return proto.bonusSources.call(model,{deviceGuids:ids});
}

 function equipmentAttributeFrames(compact=false) {
  const occupied=new Set([...EQUIP].filter(([,e])=>e&&e.itemId&&e.itemId!==0xffff)
    .map(([pos])=>pos));
  const gemBonus=gemRules.bonuses(GEM_BOARD.state,occupied);
  const rows=Object.entries(equipmentAttributes.attributes(EQUIP,
    {currentClient:true,enhancementLevelFor:equippedEnhancementLevel,
      reforgeFor:equippedReforgeHex,forgeFor:e=>require('./equipment-forging').applied(PROGRESSION.crafting.state,e?.guid),
      gemBonus,progressionSources:progressionAttributeSources(),soulFor:e=>SOULS.get(e.guid,e.itemId)}));
  if(compact){
    const payload=Buffer.alloc(1+rows.length*5);payload[0]=rows.length;
    rows.forEach(([id,v],i)=>{payload[1+i*5]=+id;payload.writeUInt32LE(Math.round(v)>>>0,2+i*5);});
    return [bagMod.mkFrame(1045,payload,{flags:0xd3,stream:PLAYERID}),...equipmentContextFrames(true)];
  }
  return [...rows.map(([id,v])=>mkAttrFrame(+id,v)),...equipmentContextFrames()];
}
function roleFrameNow(why) {
  if(PLAYER_SCOPE&&economyFrozen())return null;
  if (!WALLET || !WALLET.ok) return null;
  try{
  const slots = (BAG && BAG_SYNC !== 'off') ? BAG.slotMap : null;
  const f = WALLET.frameWithGold(WALLET.gold, slots, BAG_SYNC === 'full' ? 'full' : 'safe',
    BAG_EMPTY, patchEnhancementLevel,activeEquipmentFrames(),BAG_VISIBLE_CAPACITY,
    PLAYER_ACCOUNTS?blob=>{
      const account=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
      const titleAccount=require('./player-title-snapshot').forRole(account,{...economyPendingState(),file:PLAYER_ACCOUNTS.file,sqlite:require('./persistence/state-files').enabled()});
      blob=require('./player-role-name').patchRole(blob,account);
      return require('./player-avatar').patchRole(require('./player-title-wire').patchRole(require('./player-growth-wire').patchRole(require('./player-vip-wire').patchRole(blob,account),account),titleAccount),titleAccount,ACCOUNT_AVATAR_POLICY);
    }:null);
  if (f && WALLET.lastBuild && WALLET.lastBuild.bag) {
    log(`     ${why}：角色数据帧 金币=${WALLET.gold} 背包写入 ${WALLET.lastBuild.bag.written} 格（模式 ${BAG_SYNC}，跳过空�?${WALLET.lastBuild.bag.skipped}）`);
  }
  return f;
  }catch(error){
    // An avatar may lose eligibility while its historical choice remains.
    // No default conversion/revocation fallback has been verified. Refuse the
    // role frame without letting a read failure terminate another account's
    // runtime or turn a SQLite login into a failed write transaction.
    log(`Role initialization unavailable: ${error.message}`);return null;
  }
}

/**
 * 把「金币变了」这件事推给客户端。返回要追加的帧数组�? * 通道�?--gold-push 决定（见上面的说明）�?045 那条只是**假设**，需要真客户端确认�? */
function goldPushFrames(why, attr = GOLD_ATTR) {
  const out = [];
  if (!WALLET || !WALLET.ok || GOLD_PUSH === 'off') return out;
  const val = WALLET.attrs ? WALLET.attrs[attr] : undefined;
  if (val === undefined) { log(`     �?${why}：属�?${attr} 没有基线值，不推（用 --attr-seed=${attr}:<�? 或先让它出现一次）`); return out; }
  if (GOLD_PUSH === '1045' || GOLD_PUSH === 'both') {
    out.push(mkAttrFrame(attr, val));
    log(`     ${why}：属性同�?1045  id=${attr}(${(require('./gold').ATTR_NAME || {})[attr] || '?'}) = ${val}  f4=${PLAYERID}  �?真实服同款通道`);
  }
  if ((GOLD_PUSH === 'roledata' || GOLD_PUSH === 'both') && attr === GOLD_ATTR) {
    const f = roleFrameNow(why);
    if (f) out.push(f);
  }
  return out;
}

// ================= 传输�?=================
class Encoder { constructor() { this.prev = SEED; } encode(buf) { const o = Buffer.alloc(buf.length); for (let i = 0; i < buf.length; i++) { o[i] = buf[i] ^ this.prev; this.prev = buf[i]; } return o; } }
class Decoder {
  constructor() { this.prev = SEED; this.buf = Buffer.alloc(0); }
  push(chunk) {
    const out = Buffer.alloc(chunk.length);
    for (let i = 0; i < chunk.length; i++) { out[i] = chunk[i] ^ this.prev; this.prev = out[i]; }
    this.buf = Buffer.concat([this.buf, out]);
    const frames = [];
    while (this.buf.length >= 12) {
      const t = this.buf.readUInt32LE(0);
      if (t < 12 || t > (1 << 24)) { frames.push({ bad: this.buf }); this.buf = Buffer.alloc(0); break; }
      if (this.buf.length < t) break;
      frames.push({ raw: this.buf.subarray(0, t) }); this.buf = this.buf.subarray(t);
    }
    return frames;
  }
}

let connSeq = 0;
const PENDING_CHOICE = new Map(); // Shared by connections using this lobby state.
const LIVE_CURRENCY_PUSH = new Set();
const LIVE_MAIL_PUSH = new Set();
const LIVE_OWNED_MAIL_PUSH = new Set();
const LIVE_PUBLIC_BETA_PUSH = new Set();
const LIVE_TITLE_PUSH = new Set();
const LIVE_PERSONAL_SETTINGS_PUSH = new Set();
const LIVE_MEDAL_PUSH = new Set();
const LIVE_AVATAR_PUSH = new Set();
const LIVE_WAR_SOUL_PUSH = new Set();
const LIVE_KILL_EFFECT_PUSH = new Set();
const LIVE_FIGHT_DRESS_PUSH = new Set();
const LIVE_AVATAR_FRAME_PUSH = new Set();
function handle(sock, port) {
  const id = String(++connSeq).padStart(3, '0');
  const tag = `[${port}]#${id}`;
  const enc = new Encoder(), dec = new Decoder();
  const occ = new Map();
  const done = new Set();
  const items_in_bag = new Map();      // 这一局里发出去的奖励，按道具ID 累计（只为日志好看）
  let k = 0, sent = 0, account = '', safetyHits = 0;
  let accountOnline=false,publicBetaWorldId=null;
  let inMatch = false;
  let battleOwnershipUpdatedAt = 0;
  let heroSignatures=null;
  function syncBattleOwnership() {
    const state = battleOwnership.read();
    if (!state || Number(state.updatedAt) <= battleOwnershipUpdatedAt) return;
    battleOwnershipUpdatedAt = Number(state.updatedAt);
    // Returning to the lobby can discard the native hero collection. An
    // unchanged server mask is still needed: 1338 only updates existing native
    // rows, whereas 1337 restores the complete committed collection. Keep this
    // invalidation pending through authentication or economic freezes.
    if (!state.active) heroSignatures=null;
    if (inMatch === state.active) return;
    inMatch = state.active;
    log(`${tag} battle ownership -> ${inMatch ? 'active' : 'returned'} (${state.reason || 'state-file'})`);
    // The battle connection owns the map session, but the lobby connection
    // remains alive.  On return the native client drops its in-memory war-
    // soul panel and waits for the authoritative 36273 snapshot again.  The
    // normal return replay only refreshes equipment, so without this push a
    // saved plan is rendered as an empty plan until the user reopens/reloads
    // the panel.  Read the persisted state and refresh it at the handoff.
    if (!inMatch) {
      const refresh = liveWarSoulRefresh();
      if (refresh) emitLive([Buffer.from(refresh)], 'war-soul return refresh');
    }
  }
  let roleReadyAt = 0, startupComplete = false;
  let equipmentPreviewKey = null;
  const notifiedMailIds = new Set();
  let ownedMailSignature=null;
  let ownedMailIds=null;
  const lastSentFrames = [];       // 最近发出的帧（msgid:len），给"未实现请求"做上下文
  const recentReqs = [];           // 最近收到的请求（msgid#第几次）
  const t0 = Date.now();
  sock.setNoDelay(true);
  log(`${tag} 连入 ${sock.remoteAddress}:${sock.remotePort}   录制 ${S.totalFrames} �?/ ${S.batches.length} �?/ ${S.reqLog.length} 条请求`);

  /**
   * 邮件载荷里"附件段"的起始偏移。段首字节 = flag0：
   *   **1 = 有未领取附件**（真服 20308 通知帧、20311 列表记录里都是 1）
   *   **0 = 已读但还没领**（真服 20310 详情帧里是 0）
   * 实证：同一封邮件 0x132d00c2 在 20311 记录里 flag0=01、在 20310 详情里 flag0=00（node mail11rec.js）。
   */
  function segOffOf(payload) {
    const t = payload.readUInt16LE(28);
    const bl = payload.readUInt16LE(30 + t);
    return 32 + t + bl;
  }
  /**
   * 邮件帧：把录制/生成的载荷套上指定 msgid，并按用途把 flag0 摆正。
   *   mode='notify'  → 登录推的新邮件通知 / 20311 列表记录（flag0=1）
   *   mode='detail'  → 20310 详情（flag0=0）
   *   mode='claimed' → 已领取形态（短帧，flag0=0/flag1=2）
   * 实证：20310/20311 的 f4 字段是 **0**，20308 才是 playerId（cap-2026-09-27T02-56-55）。
   */
  function mailFrameAs(mf, mode, msgid) {
    const b = Buffer.from((mode === 'claimed' ? mf.read : mf.unread).hex, 'hex');
    const payload = b.subarray(12);
    if (payload.length > 32) {
      const off = segOffOf(payload);
      if (mode === 'claimed' && off + 17 === payload.length) {
        // One recorded no-attachment mail has a short "read" frame whose
        // flags still say unread. Claimed state is authoritative, even for it.
        payload[off] = 0;
        payload[off + 1] = 2;
      } else if (mode !== 'claimed' && off < payload.length) {
        payload[off] = (mode === 'notify') ? 1 : 0;
      }
    }
    b.writeUInt32LE(msgid===20308?PLAYER_SCOPE?.playerId||MAIL_PLAYERID:0, 4);
    b.writeUInt16LE(msgid, 8);
    b.writeUInt16LE(0xd2, 10);
    return b;
  }
  function mailContext(){return {authenticated:accountOnline===true,frozen:economyFrozen(),uid:PLAYER_SCOPE?.uid,playerId:PLAYER_SCOPE?.playerId};}
  function mailboxView(){
    if(!PLAYER_ACCOUNTS||!accountOnline||economyFrozen())return null;
    const account=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),claims=MAIL_STATE.snapshot();
    const legacy=[...LEGACY_MAIL_IDS];if(LEGACY_MAIL_IDS.size)legacy.push(...EXTRA_MAILS.keys());
    const mails=rewardMail.displaySnapshot(account,mailContext());
    if(process.env.DSH_PUBLIC_BETA==='1')mails.push(...require('./public-beta/gm-operations').displaySnapshot(account,mailContext()));
    return require('./mail-native-view').create(account,mails,claims,
      [...new Set(legacy)].map(id=>({id,frames:mailFrames(id)})));
  }
  function currentMailIds(){
    if(PLAYER_ACCOUNTS)return mailboxView()?.ids||[];
    return [...Object.keys(MAIL||{}).map(x=>parseInt(x,16)),...EXTRA_MAILS.keys()].filter(id=>!MAIL_STATE.hasDeleted(id));
  }
  function currentMailBadgeFrame(){
    const view=PLAYER_ACCOUNTS?mailboxView():null;
    const unread=view?view.unread:currentMailIds().filter(id=>!MAIL_STATE.hasRead(id)&&!MAIL_STATE.hasClaimed(id)).length;
    if(!unread)return null;const payload=Buffer.alloc(4);payload.writeUInt32LE(unread);return bagMod.mkFrame(20313,payload,{flags:0xd2,stream:0});
  }
  function pushCurrentMailBadge(why){const frame=currentMailBadgeFrame();if(frame)emitLive([frame],why);}
  function currentMailFrames(id){
    if(PLAYER_ACCOUNTS)return mailboxView()?.frames(id)||null;
    return MAIL_STATE.hasDeleted(id)?null:mailFrames(id);
  }
  /**
   * ===== 20311 = 真服的**邮件列表**帧（实证：node mailpair.js / node mail11.js / node mail11rec.js）=====
   *   载荷 = u32 0 | u32 条数 | 条数 × 邮件载荷（每条记录就是邮件载荷本身，逐字节相同）
   * 为什么重要：客户端"打开邮箱"发的是 C→S 20307（空载荷），真服回的就是这条 20311。
   * 我们以前把列表做成"一串 20308"推回去 —— 20308 其实是**服务端主动推的新邮件通知**，
   * 客户端拿不到 20311 就渲染不出列表（用户实测："邮件依然打不开"）。
   */
  function mailList11Frame(why,quiet=false) {
    if(PLAYER_ACCOUNTS){const view=mailboxView();if(!view)throw Error('Mailbox unavailable');return view.list();}
    const ids = currentMailIds()
      .map((id,index) => {
        const mf = currentMailFrames(id);
        const frame = mf && mailFrameAs(mf,'notify',20311);
        return {id,index,time:EXTRA_MAILS.get(id)?.createdAt || (frame?.length >= 28 ? frame.readUInt32LE(24) : 0)};
      }).sort((a,b) => b.time - a.time || a.index - b.index).map(x => x.id);
    const recs = [];
    for (const id of ids) {
      const mf = currentMailFrames(id);
      if (!mf) continue;
      recs.push(mailFrameAs(mf, MAIL_STATE.hasClaimed(id) ? 'claimed' : (MAIL_STATE.hasRead(id) ? 'detail' : 'notify'), 20311).subarray(12));
    }
    // Native 0xaedfd9 reads one final byte after all records; the captured
    // complete lists end in 00. It is separate from each mail's own trailer.
    const frame = bagMod.mkFrame(20311, MAILGEN.buildMailListPayload(recs), { flags: 0xd2 });
    if(!quiet)log(`     ${why}：邮件列表 20311（${recs.length} 封，${frame.length} 字节）`);
    return frame;
  }

  /**
   * 邮件"有新邮件"通知：每封一条 **20308**（真服实证：登录/新邮件时就是这么推的；f4=playerId、flag0=1）。
   * 注意 20308 **不是列表** —— 列表是客户端发 20307 后回的 20311。
   */
  function mailListFrames(why) {
    const out = [];
    const ids = currentMailIds();
    for (const id of ids) {
      const mf = currentMailFrames(id);
      if (!mf) continue;
      out.push(mailFrameAs(mf, MAIL_STATE.hasClaimed(id) ? 'claimed' : (MAIL_STATE.hasRead(id) ? 'detail' : 'notify'), 20308));
    }
    log(`     ${why}：推新邮件通知 ${out.length} 封（20308）`);
    return out;
  }

  /** 我们说了算的货币属性（gold.js 的 ATTR_NAME：50 金币 / 52 VIP / 72 钻石 / 91 累计充值 / 141 莫比乌斯币 / 156 挑战币 / 157 绑定钻石）*/
  const MANAGED_ATTRS = new Set([...Object.keys(require('./gold').ATTR_NAME || {}).map(Number),
    ...equipmentAttributes.allManaged,...Object.values(gemRules.ATTRIBUTE_IDS).flat()]);
  const CURRENCY_ATTRS = new Set(Object.keys(require('./gold').ATTR_NAME || {}).map(Number));
  // Every outbound path, including delayed capture batches and live GM/shop
  // writes, must use the same wallet. The client also accepts 1014 as a
  // diamond balance update; an old 1014 can overwrite a newer 1045 in its HUD.
  let shopRevision = SHOP_CATALOG.revision;
  let exchangeView = null;
  // Only the synchronous, read-only login display segment owns this snapshot.
  // Every native read and dynamic freeze check retains its original guards.
  let loginAccountProjection=null;
  function loginProjectionAccount(){
    if(!loginAccountProjection)return PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
    if(loginAccountProjection.error)throw loginAccountProjection.error;
    const current=loginAccountProjection.current;
    if(!accountOnline||current.uid!==PLAYER_SCOPE.uid||current.playerId!==PLAYER_SCOPE.playerId||current.loginHash!==PLAYER_SCOPE.loginHash)
      throw Error('Login display account identity changed');
    return current;
  }
  function loginProjectionFailure(error){
    if(loginAccountProjection&&!loginAccountProjection.error)loginAccountProjection.error=error;
  }
  function withLoginAccountProjection(project){
    if(loginAccountProjection)throw Error('Nested login display projection rejected');
    const scope={current:null,wire:[],error:null};loginAccountProjection=scope;
    try{
      const current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
      if(!accountOnline||!current||current.uid!==PLAYER_SCOPE.uid||current.playerId!==PLAYER_SCOPE.playerId||current.loginHash!==PLAYER_SCOPE.loginHash)
        throw Error('Login display account identity mismatch');
      const image=JSON.stringify(current);
      const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
      scope.current=freeze(current);
      const result=project();
      if(scope.error)throw scope.error;
      if(result&&typeof result.then==='function')throw Error('Login display projection must be synchronous');
      // A new guarded read checks the full current account, including identity.
      const saved=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
      if(!accountOnline||!saved||saved.uid!==PLAYER_SCOPE.uid||saved.playerId!==PLAYER_SCOPE.playerId||saved.loginHash!==PLAYER_SCOPE.loginHash||JSON.stringify(saved)!==image)
        throw Error('Login display account changed during projection');
      const frames=scope.wire;loginAccountProjection=null;
      for(const bytes of frames)if(!sock.destroyed)sendWire(bytes);
      return result;
    }catch(error){sock.destroy();throw error;}
    finally{loginAccountProjection=null;}
  }
  function authoritativeOutbound(frame,{captured=false}={}) {
    // Captured sanctions belong to the old official-server session.
    if(captured&&[23491,23506].includes(frame.readUInt16LE(8)))return null;
    if(PLAYER_ACCOUNTS&&ACCOUNT_MAIL_REPLIES.has(frame.readUInt16LE(8))){
      if(captured||!accountOnline||economyFrozen())return null;
      try{
        const message=frame.readUInt16LE(8);
        if(message===20309){if(frame.length!==16)return null;const view=mailboxView(),entry=view?.all.get(frame.readUInt32LE(12));return entry&&view.deleted.has(entry.parentId)?frame:null;}
        if(message===20313){const badge=currentMailBadgeFrame();return badge&&frame.equals(badge)?frame:null;}
        if(message===20311)return frame.equals(mailList11Frame('current mailbox',true))?frame:null;
        if(frame.length<40)return null;
        const mf=currentMailFrames(frame.readUInt32LE(12));if(!mf)return null;
        const mode=MAIL_STATE.hasClaimed(mf.parentId??frame.readUInt32LE(12))?'claimed':message===20308?'notify':'detail';
        return frame.equals(mailFrameAs(mf,mode,message))?frame:null;
      }catch(error){log('Owned mail response rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&onlineWire.responses.has(frame.readUInt16LE(8))&&(captured||!accountOnline||economyFrozen()))return null;
    // MSG_CHAT belongs to its original conversation. Retain raw evidence,
    // while account sessions expose only future explicit live chat producers.
    if(PLAYER_ACCOUNTS&&frame.readUInt16LE(8)===1087&&(captured||!accountOnline||economyFrozen()))return null;
    if(PLAYER_ACCOUNTS&&captured&&frame.readUInt16LE(8)===12002)return null;
    // A mixed recorded PB envelope containing magic state is also atomic:
    // never split it into a new successful reply for another branch.
    if(PLAYER_ACCOUNTS&&captured&&require('./magic-feature-snapshot').magicReply(frame))return null;
    if(PLAYER_ACCOUNTS&&frame.readUInt16LE(8)===1040)return BATTLE_HANDOFF_GATE?.outbound(frame,{
      authenticated:accountOnline===true,frozen:economyFrozen(),uid:PLAYER_SCOPE.uid,playerId:PLAYER_SCOPE.playerId,mapId:252})||null;
    if(PLAYER_ACCOUNTS&&frame.readUInt16LE(8)===9159)return null;
    if(PLAYER_ACCOUNTS&&ACCOUNT_PET_REPLIES.has(frame.readUInt16LE(8)))return null;
    if(PLAYER_ACCOUNTS&&!accountOnline&&ACCOUNT_PRIVATE_INITIALIZATION.has(frame.readUInt16LE(8)))return null;
    if(PLAYER_ACCOUNTS&&ACCOUNT_RUNE_REPLIES.has(frame.readUInt16LE(8))&&(!accountOnline||economyFrozen()))return null;
    if(PLAYER_ACCOUNTS&&frame.readUInt16LE(8)===9156){
      // Late 9170 capture replay must not restore a historical opening count.
      // Identity comes from the authenticated account context, not header +4.
      if(!accountOnline||economyFrozen()||frame.length!==40||frame.readUInt32LE()!==40)return null;
      const current=liveGodsendFilterInfoAck();
      if(!current||current.length!==40||current.readUInt32LE()!==40||current.readUInt16LE(8)!==9156)return null;
      current.writeUInt32LE(frame.readUInt32LE(4),4);
      current.writeUInt16LE(frame.readUInt16LE(10),10);
      return current;
    }
    if(PLAYER_ACCOUNTS&&ACCOUNT_WAR_SOUL_REPLIES.has(frame.readUInt16LE(8))&&(!accountOnline||economyFrozen()))return null;
    const msgid = frame.readUInt16LE(8);
    if(PLAYER_ACCOUNTS&&msgid===1015){
      if(!accountOnline||economyFrozen())return null;
      try{return require('./player-merits-wire').patch(frame,PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),WALLET?.ok?WALLET.attrs?.[131]:undefined);}
      catch(error){log('Merits response rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&[9019,9020].includes(msgid)&&frame.length>=20&&[2,5].includes(frame.readUInt32LE(msgid===9019?16:12))){
      if(!accountOnline||economyFrozen())return null;
      const a=loginProjectionAccount(),c=require('./player-battle-cosmetics'),category=frame.readUInt32LE(msgid===9019?16:12);
      // The first explicit migration is performed before hero selection; once
      // migrated, reconnect/login must not overwrite it with captured choices.
      if(a.cosmeticsImport?.version===1)return msgid===9019?c.reply(a,category):c.owned(a,category);
    }
    if(PLAYER_ACCOUNTS&&[9019,9020].includes(msgid)&&frame.length>=20&&frame.readUInt32LE(msgid===9019?16:12)===6){
      if(!accountOnline||economyFrozen()||msgid===9020)return null;
      // Historical zero deadlines do not authorize a current ownership list
      // or selection. Only an explicitly persisted item0 removal is live.
      try{return require('./player-kill-effect-state').outbound(loginProjectionAccount(),frame);}
      catch(error){loginProjectionFailure(error);log('Kill effect response rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&[9019,9020].includes(msgid)&&frame.length>=(msgid===9019?20:16)&&frame.readUInt32LE(msgid===9019?16:12)===9){
      if(!accountOnline||economyFrozen())return null;
      try{return require('./player-fight-dress').outbound(loginProjectionAccount(),frame);}
      catch(error){loginProjectionFailure(error);log('Fight dress response rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&msgid===27614){
      if(!accountOnline||economyFrozen())return null;
      return require('./player-avatar-frame').outbound(loginProjectionAccount(),frame);
    }
    if(PLAYER_ACCOUNTS&&msgid===27615){
      if(!accountOnline||economyFrozen())return null;
      try{return require('./player-avatar-frame').publicList(frame);}
      catch(error){loginProjectionFailure(error);log('Avatar frame candidate list rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&msgid===27603){
      if(!accountOnline||economyFrozen())return null;
      try{return require('./player-avatar').outbound(loginProjectionAccount(),frame,ACCOUNT_AVATAR_POLICY);}
      catch(error){loginProjectionFailure(error);log('Avatar response rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&msgid===14003){
      if(!accountOnline||economyFrozen())return null;
      try{
        const wire=require('./player-title-wire'),id=wire.decodeOwnership(frame).titleId;
        return wire.ownership(loginProjectionAccount(),id);
      }catch(error){loginProjectionFailure(error);log('Title ownership response rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&msgid===1454){
      if(!accountOnline||economyFrozen())return null;
      try{return require('./player-personal-settings').outbound(accountOnline?loginProjectionAccount():null,frame);}
      catch(error){loginProjectionFailure(error);log('Title effect settings response rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&msgid===14005){
      if(!accountOnline||economyFrozen())return null;
      try{return require('./player-title-wire').outbound(accountOnline?loginProjectionAccount():null,frame);}
      catch(error){loginProjectionFailure(error);log('Title response rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&msgid===11888){
      try{frame=require('./player-credit').outbound(accountOnline?loginProjectionAccount():null,frame);}
      catch(error){loginProjectionFailure(error);log('Credit response rejected: '+error.message);return null;}
      if(!frame)return null;
      try{frame=require('./player-medals').outbound(frame,accountOnline?loginProjectionAccount():null,Date.now(),{enabled:accountOnline&&!economyFrozen()});}
      catch(error){loginProjectionFailure(error);log('Medal response rejected: '+error.message);return null;}
      if(!frame)return null;
    }
    if(PLAYER_ACCOUNTS&&msgid===1045){
      try{
        const current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
        frame=require('./player-growth-wire').patchAttributes(frame,current);
        if(frame)frame=require('./player-vip-wire').patchAttributes(frame,current);
      }
      catch(error){log('Growth attribute rejected: '+error.message);return null;}
      if(!frame)return null;
    }
    if(PLAYER_SCOPE&&msgid===1045){
      frame=require('./player-wallet-wire').attributes(frame,{accountMode:!!PLAYER_SCOPE,
        authenticated:accountOnline===true,frozen:economyFrozen(),attrs:WALLET?.ok?WALLET.attrs:undefined});
      if(!frame)return null;
    }
    // First recharge gift replies cannot be replayed as this account's claim state.
    // Restore only with verified reply semantics and a durable grant transaction.
    if(PLAYER_ACCOUNTS&&msgid===11542){
      if(!accountOnline||economyFrozen())return null;
      try{return require('./player-first-gift').reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid));}catch{return null;}
    }
    if(PLAYER_ACCOUNTS&&msgid===20513){
      if(!accountOnline||economyFrozen())return null;
      try{
        const saved=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),world=require('./public-beta/reference-world');
        const account=process.env.DSH_PUBLIC_BETA==='1'?world.projectAccount(saved,publicBetaWorldId):saved;
        const display=process.env.DSH_PUBLIC_BETA==='1'?world.projectProfile(frame,saved,publicBetaWorldId):frame;
        return require('./player-profile-response').outbound(account,display,{avatarPolicy:ACCOUNT_AVATAR_POLICY});
      }catch(error){loginProjectionFailure(error);log('Profile display projection rejected: '+error.message);return null;}
    }
    if(PLAYER_ACCOUNTS&&[1337,1338,1372].includes(msgid)){
      if(!accountOnline||!PLAYER_SCOPE?.heroWire)return null;
      try{
        const current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),account=require('./player-title-snapshot').forHeroes(current,{...economyPendingState(),file:PLAYER_ACCOUNTS.file,sqlite:require('./persistence/state-files').enabled()});
        return account?playerHeroes.authoritative(account,frame):null;
      }catch(error){log('Hero committed snapshot unavailable: '+error.message);return null;}
    }
    if(msgid===16804){shopRevision=SHOP_CATALOG.revision;return SHOP_CATALOG.frame();}
    if(msgid===1394&&PLAYER_SCOPE)return require('./player-wallet-wire').honour(frame,{accountMode:!!PLAYER_SCOPE,
      authenticated:accountOnline===true,frozen:economyFrozen(),value:WALLET?.state?.honour});
    if(msgid===1394&&WALLET)return honourFrame();
    if(msgid===1439&&PLAYER_SCOPE)return require('./player-wallet-wire').recharge(frame,{accountMode:!!PLAYER_SCOPE,
      authenticated:accountOnline===true,frozen:economyFrozen(),value:WALLET?.attrs?.[91]});
    if(msgid===1439&&WALLET)return require('./player-vip-wire').recharge(frame,WALLET.attrs);
    // All send paths, including delayed capture batches, use saved loadouts.
    if (msgid === 1043) return applyEquipModel(frame);
    if (msgid === 13590) {
      if(PLAYER_ACCOUNTS&&(!accountOnline||economyFrozen()))return null;
      hydrateMagicGems();return bagMod.mkFrame(13590,progressionProtocol.magicGemNotifyPayload(PROGRESSION.magicGem),{flags:frame.readUInt16LE(10),stream:PLAYERID});
    }
    if (msgid === 13594 || msgid === 13596) {
      const plan=frame.length>=16?frame.readUInt32LE(12)-1:-1;
      if(plan<0||plan>2)return null;
      const id=PROGRESSION.magicGem.state.equippedBySet?.[plan];
      return magicDeviceLive.ack(id?13593:13595,{plan,deviceGuid:id},{});
    }
    if (msgid === 11678) return liveRuneInfoAck();
    if (msgid === 11680) return liveRunePageAck(frame[16]);
    if (msgid === 11855) return liveRuneDeterminationAck(11854, frame);
    if (msgid === 36273) { ensureWarSoulMaterials(); return warSoulModule.patchNativeRefreshFrame(frame, PROGRESSION.warSoul.state); }
    // Account login replay skips captured online responses in emitBatch. A
    // validated 11532 request still needs its fresh clock through emitLive.
    if (msgid === 11533) return PLAYER_ACCOUNTS&&accountOnline&&frame.length===16?
      onlineWire.serverTime(Date.now()):null;
    if(msgid===1014&&PLAYER_SCOPE)return require('./player-wallet-wire').diamond(frame,{accountMode:!!PLAYER_SCOPE,
      authenticated:accountOnline===true,frozen:economyFrozen(),value:WALLET?.ok?WALLET.attrs?.[72]:undefined});
    if (msgid === 1014 && WALLET?.ok) {
      if (frame.length !== 17) { log(`${tag} dropped malformed 1014 len=${frame.length}`); return null; }
      const value = WALLET.attrs?.[72];
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
      const current = Buffer.from(frame);
      current.writeUInt32LE(value, 12); // preserve the captured trailing status byte
      return current;
    }
    if (msgid === 13535 && BAG && frame.readUInt32LE(12)===PLAYERID) {
      try{return require('./roledata').syncEquipmentSummary(frame,activeEquipmentFrames());}
      catch(error){log(`${tag} dropped equipment summary: ${error.message}`);return null;}
    }
    if (msgid === 1045 && WALLET?.ok) {
      const pay = frame.subarray(12);
      if (!pay.length || pay.length !== 1 + pay[0] * 5) {
        log(`${tag} dropped unrecognized 1045 len=${frame.length}`);
        return null;
      }
      let current = null;
      const occupied=new Set([...EQUIP].filter(([,e])=>e&&e.itemId&&e.itemId!==0xffff)
        .map(([pos])=>pos));
       const equipAttrs = equipmentAttributes.attributes(EQUIP,
         {currentClient:true,enhancementLevelFor:equippedEnhancementLevel,
          reforgeFor:equippedReforgeHex,forgeFor:e=>require('./equipment-forging').applied(PROGRESSION.crafting.state,e?.guid),
          gemBonus:gemRules.bonuses(GEM_BOARD.state,occupied),progressionSources:progressionAttributeSources(),soulFor:e=>SOULS.get(e.guid,e.itemId)});
      for (let i = 0; i < pay[0]; i++) {
        const id = pay[1 + i * 5];
        const computed = CURRENCY_ATTRS.has(id) ? WALLET.attrs?.[id]
          : MANAGED_ATTRS.has(id) ? equipAttrs[id] : undefined;
        if (computed === undefined) continue;
        const value=CURRENCY_ATTRS.has(id)?computed:Math.round(computed);
        if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
        if (!current) current = Buffer.from(frame);
        current.writeUInt32LE(value, 14 + i * 5);
      }
      return current || frame;
    }
    if(msgid===1166&&PLAYER_SCOPE){
      if(!accountOnline||economyFrozen()||!WALLET?.ok)return null;
      const current=roleFrameNow('统一出站角色数据');if(!current)return null;
      try{return process.env.DSH_PUBLIC_BETA==='1'?require('./public-beta/reference-world').projectRoleFrame(current,PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),publicBetaWorldId):current;}
      catch(error){loginProjectionFailure(error);log('Role world projection rejected: '+error.message);return null;}
    }
    if(msgid===1013&&PLAYER_SCOPE&&process.env.DSH_PUBLIC_BETA==='1'){
      if(!accountOnline||economyFrozen())return null;
      try{return require('./public-beta/reference-world').projectRoleFrame(frame,PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),publicBetaWorldId);}
      catch(error){loginProjectionFailure(error);log('Role world projection rejected: '+error.message);return null;}
    }
    if (msgid === 1166 && WALLET?.ok){const current=roleFrameNow('统一出站角色数据');return current||frame;}
    return frame;
  }
  function currentEquipmentFrames() {
    return equipmentSnapshotFrames();
  }
  /**
   * 把录制帧里的"我们管的属性"摘掉。
   * 返回 { frame, stripped }：frame=null 表示整条都别发；stripped 表示摘掉了几条属性。
   */
  function stripManagedAttrs(frame, preserveWallet = false) {
    if (frame.readUInt16LE(8) !== 1045) return { frame, stripped: 0 };
    const pay = frame.subarray(12);
    const attrs = [];
    if (pay.length === 6 && pay[0] === 1) attrs.push({ id: pay[1], val: pay.readUInt32LE(2) });
    else {
      const n = pay[0];
      if (1 + n * 5 !== pay.length) return { frame, stripped: 0 };   // 形态不认识，原样发
      for (let i = 0; i < n; i++) attrs.push({ id: pay[1 + i * 5], val: pay.readUInt32LE(2 + i * 5) });
    }
    const keep = attrs.filter(a => !MANAGED_ATTRS.has(a.id) || (preserveWallet && CURRENCY_ATTRS.has(a.id)));
    const stripped = attrs.length - keep.length;
    if (!stripped) return { frame, stripped: 0 };
    if (!keep.length) return { frame: null, stripped };
    const p = Buffer.alloc(1 + keep.length * 5);
    p.writeUInt8(keep.length, 0);
    keep.forEach((a, i) => { p.writeUInt8(a.id, 1 + i * 5); p.writeUInt32LE(a.val, 2 + i * 5); });
    return { frame: bagMod.mkFrame(1045, p, { flags: frame.readUInt16LE(10), stream: frame.readUInt32LE(4) }), stripped };
  }

  let pendingWire=null;
  const heroDelivery=PLAYER_SCOPE?.heroWire?require('./player-hero-incremental-delivery').createTracker({
    getSignatures:()=>heroSignatures,
    canApply:()=>Boolean(accountOnline&&roleReadyAt&&!sock.destroyed&&!economyFrozen()),stream:PLAYERID
  }):null;
  function sendWire(bytes){
    if(loginAccountProjection)loginAccountProjection.wire.push(Buffer.from(bytes));
    else if(pendingWire)pendingWire.push(bytes);
    else {sock.write(bytes);heroDelivery?.written(bytes);}
  }
  function emitBatch(b, why) {
    // Lobby polling (notably 9026) has captured return-to-lobby hero changes.
    // Once handed to a match, only that match may own the player's world state.
    if (inMatch) { log(`${tag} suppressed lobby replay ${b.key} during match`); return; }
    if (done.has(b.key)) return;
    done.add(b.key);
    let strippedAttrs = 0;
    for (const p of b.frames) {
      if (sock.destroyed) return;
      // Recorded inventory operations belong to the old session. Replaying
      // them can restore destroyed items or overwrite freshly granted rewards.
      if (BAG && [17004,17015,17019,13503,13505,11669,13511,13513,13519].includes(p.msgid)) continue;
      // Mail state is generated from the live store. A captured mailbox frame
      // embedded in an unrelated login batch can open the UI and show stale mail.
      if ([20308,20310,20311].includes(p.msgid)) continue;
      if(p.msgid===16824)continue; // Exchange catalog is generated only from its live persistent rotation.
      if(PLAYER_ACCOUNTS&&onlineWire.responses.has(p.msgid))continue;
      // 20313 unconditionally lights the native notification dot, even for
      // zero. Never replay an old account's unread-mail notification.
      if (p.msgid === 20313) {
        pushCurrentMailBadge('current owned unread mail');
        continue;
      }
      let f = p.frame, note = '';
      if(process.env.DSH_PUBLIC_BETA==='1'&&p.msgid===20002&&require('./public-beta/client-version').isGreeting(f))
        f=require('./public-beta/client-version').greeting(Number(process.env.DSH_CLIENT_VERSION||8824));
      // The captured greeting predates the current client by one protocol
      // build.  8824 rejects the old 10 F7 44 value before it sends its
      // login request; the current server handshake is 10 F8 44.
      if (p.msgid === 20002 && f.length === 23 && f[12] === 0x05 &&
          f[20] === 0x10 && f[21] === 0xf7 && f[22] === 0x44) {
        f = Buffer.from(f);
        f[21] = 0xf8;
        note = ' [8824 握手]';
      }
      if(p.msgid===11888 && f[12]===0x92 && f[13]===0x01){
        f=bagMod.mkFrame(11888,gemRules.boardPayload(GEM_BOARD.state),
          {flags:p.frame.readUInt16LE(10),stream:p.frame.readUInt32LE(4)});
        note=' [当前宝石盘]';
      }
      if(p.msgid===13590){
        try{
          const payload=progressionProtocol.magicGemNotifyPayload(PROGRESSION.magicGem);
          if(payload.length>4){
            f=bagMod.mkFrame(13590,payload,{flags:p.frame.readUInt16LE(10),stream:p.frame.readUInt32LE(4)});
            note=' [当前魔导石状态]';
          }
        }catch(error){ log(`${tag} 魔导石登录快照生成失败：${error.message}`); }
      }
      if(p.msgid===36296){ f=liveWarSoulEntryRefresh(); note=' [当前账号战魂词条]'; }
      if (p.msgid===11553 && f.length===20 && RES[f.readUInt32LE(12)]!==undefined) {
        f=Buffer.from(f);f.writeUInt32LE(RES[f.readUInt32LE(12)],16);
      }
      if (p.msgid===11552) { f=resourceFullFrame(f);note=' [服务端当前资源全量]'; }
      if ([13591,13592].includes(p.msgid)) continue;
      if (p.msgid === 1043) continue; // Publish a single current six-slot snapshot below.
      if (p.msgid === 1045) {
        // The native first initialization batch carries current wallet
        // values at the client's expected point in the login sequence.
        // Patch those values in place; later capture replays still drop them.
        const r = stripManagedAttrs(f, b.key === '11058#1');
        if (!r.frame) { strippedAttrs += r.stripped; log(`${tag}     · 丢弃录制里的 1045（${r.stripped} 条货币属性，改用我们钱包的值）`); continue; }
        if (r.stripped) { strippedAttrs += r.stripped; f = r.frame; note += ' [已剔除录制里的旧货币值]'; }
      }
      if (BAG && p.msgid === 11523 && f.length > 24) { f = bagFullFrame(); note = ' [服务端生成]'; }
      if (PATCH_ACCT && account && f.length >= 40 && f.readUInt16LE(8) === 1287)
        f = patchCharlist(f, account, lookupUid(account));
      if(process.env.DSH_PUBLIC_BETA==='1'&&p.msgid===1287)
        f=require('./public-beta/native-seed').bindCharlistWorld(f,publicBetaWorldId);
      f = authoritativeOutbound(f,{captured:true});
      if (!f) continue;
      sendWire(enc.encode(f));
      sent++;
      lastSentFrames.push(`${p.msgid}:${f.length}`); if (lastSentFrames.length > 30) lastSentFrames.shift();
      log(`${tag} >>> #${sent - 1} msgid=${p.msgid} len=${f.length}  批[${b.key}] (${why})${note}  ${hx(f.subarray(12), 32)}`);
      emitMagicGraphsAfterNotify(f);
    }
    // The recorded values have been removed. Re-sending the entire wallet on
    // every later replay batch causes the client to show phantom 0-gold and
    // diamond gain notices despite no transaction. Login and real writes have
    // their own authoritative sync below.
    if (strippedAttrs) emitLive(equipmentAttributeFrames(true),'equipment attributes');
    if(b.key==='11058#1'&&WALLET){
      // These currencies may never change in the reference capture. Supply
      // missing values once at native login initialization, never on polling.
      const present=new Set(b.frames.filter(p=>p.msgid===1045).flatMap(p=>{
        const body=p.frame.subarray(12);return body.length===1+body[0]*5
          ?Array.from({length:body[0]},(_,i)=>body[1+i*5]):[];
      }));
      emitLive([...CURRENCY_ATTRS].filter(id=>!present.has(id)&&WALLET.attrs[id]!==undefined)
        .map(id=>mkAttrFrame(id,WALLET.attrs[id])),'initial missing currency balances');
    }
    if (b.frames.some(p => p.msgid === 1166)) {
      roleReadyAt = Date.now();
      if(PLAYER_ACCOUNTS&&accountOnline){
        withLoginAccountProjection(()=>{
        const credit=require('./player-credit').reply(loginProjectionAccount());
        if(credit)emitLive([credit],'current account credit observation');
        pushTitle(true);
        pushMedals(true);
        pushAvatar(true);
        pushKillEffect(true);
        pushFightDress();
        pushAvatarFrame(true);
        });
        pushOwnedMails();
      }
      if(PLAYER_SCOPE&&WALLET){
        const vip=require('./player-wallet-wire').recharge(bagMod.mkFrame(1439,Buffer.alloc(4),{stream:PLAYERID,flags:0xd2}),{
          accountMode:!!PLAYER_SCOPE,authenticated:accountOnline===true,frozen:economyFrozen(),value:WALLET.attrs?.[91]});
        if(vip)emitLive([vip],'current VIP cumulative recharge');
      }
      if(WALLET){const honour=honourFrame();if(honour)emitLive([honour],'current honour balance');}
      // The recorded 11058 initialization includes 1014/1045 and a full
      // 11552 resource snapshot. Sending per-currency 1045 or per-resource
      // 11553 here makes the client show false purchase/reward notices.
      // Native 17004 contains a 490-byte instance plus its container/slot.
      // The old 22-byte packed-record assumption truncated item metadata.
      if (BAG){
        // Correct container/slot headers in the full role frame initialize
        // every item. Supplements are only needed for worn and dual instances.
        const mode=argOf('login-bag-details','special');
        const slots=mode==='all'?[...BAG.slotMap.keys()]:[...BAG.slotMap]
          .filter(([slot,item])=>equippedBagSlots().has(slot)||item.dual).map(([slot])=>slot);
        emitLive(bagResyncFrames('login inventory',slots),'login inventory');
      }
      // The recording does not necessarily contain every equipment position.
      // Publish the six live references after the bag details, one 1043 per
      // position, so a restart cannot leave the client showing captured gear.
      emitLive(currentEquipmentFrames(), 'login equipment');
      emitLive(magicDeviceLive.inventoryFrames(null,PROGRESSION.magicGem.state),'login magic-gem inventory');
      if (!strippedAttrs && [...EQUIP.values()].some(e=>equippedEnhancementLevel(e)>0))
        emitLive(equipmentAttributeFrames(true), 'login enhanced equipment attributes');
      reloadExtraMails('登录');
      // 登录时**不再主动推 203xx** —— 用户实测："登录会自动打开邮件"。
      // 原因是 20308 是"有新邮件"通知，客户端收到就会弹邮箱；每次登录把 9 封全推一遍，它当然每次都弹。
      // 真服也只在**真有新邮件**时推（抓包里那几条 20308 是邮件到账那一刻，不是登录时）。
      // 邮箱面板的数据由客户端自己发 20307 时要（我们回 20311 整份列表，实证见 mailpair.js）。
      // 想恢复旧行为：--mail-login-notify=all。
      if (MAIL_LOGIN_NOTIFY === 'all') {
        const ml = mailListFrames('登录');
        if (ml.length) emitLive(ml, '新邮件通知(登录推送)');
      }
    }else if(!b.key.startsWith('23513#')&&b.frames.some(p=>p.msgid===1043))
      emitLive(currentEquipmentFrames(),'current equipment snapshot');
  }

  /** 直接发一组现场生成的帧（不走录制的批次） */
  function emitMagicGraphsAfterNotify(frame){
    if(frame.readUInt16LE(8)!==13590)return;
    try{
      const reply=require('./magic-feature-snapshot').afterNotify(PROGRESSION.magicGem,frame,{
        authenticated:PLAYER_ACCOUNTS?accountOnline===true:!!account,frozen:economyFrozen(),role:PLAYERID});
      if(reply)emitLive([reply],'current magic feature snapshot');
    }catch(error){log(`${tag} magic feature snapshot rejected: ${error.message}`);}
  }
  function emitLive(list, why, {captured=false,trackHeroIncremental=false}={}) {
    const emitted=[];
    for (const candidate of list) {
      if (sock.destroyed) return emitted;
      const f = authoritativeOutbound(candidate,{captured});
      if (!f) continue;
      const bytes=enc.encode(f);
      if(trackHeroIncremental)heroDelivery?.stage(f,bytes);
      sendWire(bytes);
      emitted.push(f);
      sent++;
      lastSentFrames.push(`${f.readUInt16LE(8)}:${f.length}`); if (lastSentFrames.length > 30) lastSentFrames.shift();
      log(`${tag} >>> #${sent - 1} msgid=${f.readUInt16LE(8)} len=${f.length}  (${why}) [服务端生成]  ${hx(f.subarray(12), 32)}`);
      emitMagicGraphsAfterNotify(f);
    }
    return emitted;
  }
  const pushGmCurrency = (attr, value) => {
    if (roleReadyAt && !sock.destroyed && !inMatch) emitLive([mkAttrFrame(attr, value)], 'GM 充值同步');
  };
  LIVE_CURRENCY_PUSH.add(pushGmCurrency);
  const publicBetaPush={pushFrame:frame=>{if(accountOnline&&roleReadyAt&&!sock.destroyed&&!inMatch&&frame)emitLive([frame],'local GM current account');}};
  if(process.env.DSH_PUBLIC_BETA==='1')LIVE_PUBLIC_BETA_PUSH.add(publicBetaPush);
  sock.once('close',()=>LIVE_PUBLIC_BETA_PUSH.delete(publicBetaPush));
  const pushGmMail = id => {
    if(PLAYER_ACCOUNTS)return false; // Unbound legacy extras cannot create rights.
    if (!roleReadyAt || sock.destroyed || inMatch || notifiedMailIds.has(id) ||
        MAIL_STATE.hasClaimed(id) || MAIL_STATE.hasRead(id) || MAIL_STATE.hasNotified(id)) return false;
    const mf = mailFrames(id);
    if (!mf) return false;
    notifiedMailIds.add(id);
    emitLive([mailFrameAs(mf,'notify',20308)], 'GM 新邮件通知');
    return true;
  };
  LIVE_MAIL_PUSH.add(pushGmMail);
  const pushOfflineNewMails = () => {
    if(PLAYER_ACCOUNTS)return;
    if (!startupComplete || !roleReadyAt || sock.destroyed || inMatch) return;
    for (const [id,mail] of EXTRA_MAILS) {
      if (!mail.createdAt || !pushGmMail(id)) continue;
      try { MAIL_STATE.markNotified(id); }
      catch (error) { log(`${tag} 新邮件通知状态保存失败 ${id}: ${error.message}`); }
    }
  };
  function pushOwnedMails(){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||inMatch||economyFrozen())return;
    try{
      const current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),ids=mailboxView()?.ids||[];
      const signature=JSON.stringify(ids.sort((a,b)=>a-b).map(id=>[id,MAIL_STATE.hasRead(id),MAIL_STATE.hasClaimed(id)]));
      if(ownedMailIds===null){ownedMailIds=new Set(ids);ownedMailSignature=signature;for(const id of ids)notifiedMailIds.add(id);pushCurrentMailBadge('login owned unread mail');return;}
      if(signature===ownedMailSignature&&ids.every(id=>notifiedMailIds.has(id)||MAIL_STATE.hasClaimed(id)))return;
      // 20308 opens the mailbox; unsolicited 20311 may reopen it as well.
      // Keep delivery visible as showtext and serve lists only on client request.
      const fresh=ids.filter(id=>!notifiedMailIds.has(id)&&!MAIL_STATE.hasClaimed(id));
      if(fresh.length)inventoryNotice('奖励已发送至邮箱，请手动打开邮箱领取。');
      pushCurrentMailBadge('owned unread mail state changed');
      if(!economyFrozen()){
        for(const id of ids)notifiedMailIds.add(id);
        ownedMailIds=new Set(ids);ownedMailSignature=signature;
      }
    }catch(error){log('Owned mail refresh failed: '+error.message);}
  }
  LIVE_OWNED_MAIL_PUSH.add(pushOwnedMails);
  const ownedMailTimer=PLAYER_ACCOUNTS?setInterval(pushOwnedMails,1000):null;
  ownedMailTimer?.unref();
  sock.once('close',()=>{clearInterval(ownedMailTimer);LIVE_OWNED_MAIL_PUSH.delete(pushOwnedMails);});

  /**
   * 背包格子 = **使用/打开**该格里的道具（不�?查询"！）
   *
   * 实证：用户依次打开 6 件，客户端发�?17002 格子�?= 49/89/178/58/80/85�?   *       与背包模型里�?6 格的道具名（符文碎片/2级随机绿色宝石箱/金币英雄随机礼包/
   *       随机战魂碎片�?签到奖励自选礼�?4级紫色宝石自选箱）逐条吻合�?   *
   * 真实服的应答（实测）�?   *   17015  种类0x010F | 道具ID(用的那件) | 1        确认使用
   *   17004  种类0x0F   | 格子N | 道具ID | 剩余数量      该格新状态（数量已减�?   *   17019  道具ID | 格子N                            使用的那�?   *   17015  种类0x010A | 道具ID(获得�? | 257          获得�?   *   17004  种类0x0A   | 格子M | 道具ID | 数量           奖励落在哪一�?   */
  function useBagSlot(slot, why) {
    const cur = BAG.slotMap.get(slot);
    if (slot < 0 || slot >= BAG_CAPACITY || equippedBagSlots().has(slot)) return;

    if (!cur) {   // 这一格本来就�?—�?什么都不做
      // 例外：这一格是**我们自己刚用空的**。客户端网格上可能还画着那件道具
      //（它�?11523 画的，格子上"用了不消�?），此时明确回一�?空格"把它抹掉�?
      if (EMPTIED.has(slot) && BAG_FREE_MODE !== 'silent') {
        const g = synthGuid(slot, 0);
        log(`${tag}     使用 格子${slot} —�?这一格是我们刚用空的，明确回"空格"把客户端网格清掉`);
        emitLive([bagMod.mkFrame(17019, slotAck(0xFFFF, slot), { flags: 0xd6 }),
        liveDetail(0x0F, slot, 0xFFFF, 0, Buffer.alloc(8))].filter(Boolean), why);
        EMPTIED.delete(slot);
        return;
      }
      log(`${tag}     使用 格子${slot} —�?模型里这一格是空的，不发任何东西`);
      return;
    }

    const nmUsed = ITEM_NAMES && ITEM_NAMES[cur.itemId] ? ITEM_NAMES[cur.itemId].name : String(cur.itemId);
    if(process.env.DSH_PUBLIC_BETA==='1'&&PLAYER_ACCOUNTS){
      try{
        const used=require('./public-beta/item-growth').useSlot({...publicBetaContext(),bag:BAG.slotMap,bagPath:path.resolve(BAG_LIVE),capacity:BAG_CAPACITY,reserved:equippedBagSlots(),saveBag:next=>saveBagLive(next,true),replaceBag:next=>{BAG.slotMap=next;}},slot);
        if(used){noteConsumed(slot,cur.itemId);if(!used.remaining)EMPTIED.add(slot);
          emitLive([bagMod.mkFrame(17015,u16p(0x010F,cur.itemId,1),{flags:0xd6}),bagMod.mkFrame(17019,slotAck(cur.itemId,slot),{flags:0xd6}),
            liveDetail(0x0F,slot,used.remaining?cur.itemId:0xffff,used.remaining,used.remaining?Buffer.from(cur.guid,'hex'):Buffer.alloc(8)),...used.frames].filter(Boolean),'experience item consumed');return;
        }
      }catch(error){inventoryNotice(error.message);return;}
    }

    // ---- 货币类道具：300金币 / 10000金币 / 5绑定钻石 �?----
    // 这类道具**不进背包**，效果是加钱。加完把角色数据�?1013/外层1166)重发一遍，
    // 大厅 HUD 的金币就刷新（HUD 的金币就是这条帧 +141 的字段，�?gold.js）�?
    const coin = currencyOfItem(nmUsed);
    if (coin && (coin.kind === 'gold' || coin.kind === 'diamond')) {
      const delivery = prepareDelivery([{attr:coin.attr,amount:coin.amount}],{consumeSlot:slot});
      if (!delivery) {inventoryNotice('货币数量不合法，道具未消耗。');return;}
      const left0 = cur.count - 1;
      const emptied0 = left0 === 0;
      const granted = grantToBag(delivery, 0x0120, 0, 0xd3);
      if (emptied0) EMPTIED.add(slot);
      noteConsumed(slot, cur.itemId);

      // **逐帧对齐真实�?*（logs/cap-2026-09-27T02-22-47）时真实服发的是�?      //   14008 060000000000 / 14007 060000000000 / 17015 / 17019 / 1045�?*没有 17004**
      // 但实测：�?14007/14008 也发出去，客户端**界面会乱**（它们显然还带着我们没复现的上下文）�?      // 所以默�?*不发**�?-bag-use-bracket=on 才发，留给以后实验）�?
      const out = [
        bagMod.mkFrame(17015, u16p(0x010F, cur.itemId, 1), { flags: 0xd3 }),
        bagMod.mkFrame(17019, slotAck(cur.itemId, slot), { flags: 0xd3 }),
      ];
      if (BAG_BRACKET) {
        const B6 = Buffer.from('060000000000', 'hex');
        out.unshift(bagMod.mkFrame(14008, B6, { flags: 0xd3 }), bagMod.mkFrame(14007, B6, { flags: 0xd3 }));
      }
      if (coin.attr) {
        const now = WALLET.attrs[coin.attr];
        out.push(...granted.frames);
        log(`${tag}     使用 格子${slot} �?${nmUsed} �?**${coin.kind} +${coin.amount} = ${now}**（属�?${coin.attr}，真实服同款序列）`);
      } else {
        log(`${tag}     使用 格子${slot} �?${nmUsed} �?不是货币类道具`);
      }
      // 用完了要让客户端把图标去掉。真服靠客户端自己清；我们的客户端不清，
      // 所以补�?*实测能清掉它**的那一对（就是"再点一�?时生效的 17019+17004，放在最后，免得被别的帧盖回去）�?
      if (emptied0) {
        out.push(bagMod.mkFrame(17019, slotAck(0xFFFF, slot), { flags: 0xd3 }));
        const fe = liveDetail(0x0F, slot, 0xFFFF, 0, Buffer.alloc(8));
        if (fe) out.push(fe);
        log(`${tag}     格子${slot} 用完了，清空（补�?17019/17004 �?空格"）`);
      }
      emitLive(out, why);
      return;
    }

    const left = Math.max(0, cur.count - 1);   // 用掉一个之后这一格剩多少（自选链和普通链都要用）

    // ---- 「自选礼包」走两步：先回 11669 给清单，客户端再发 11670 选哪个 ----
    // 实证（logs/cap-2026-09-26T20-22-26，20:24:10 那一串，`node s2cfind.js 11669` 可复现）：
    //   C→S 17002(格子48) → S→C 11669（263 字节：8B GUID + 8B 0 + u16 条数 + u16 道具ID×N）
    //   → S→C 12002（GBK 文本，是**选项的名字**："自选礼包·A / ·B"）
    //   → C→S 11670（载荷前 8 字节 = 同一个 GUID，后面 `0000 0100` = 选了第 1 个）
    //   → S→C 17015(0x0103, 选中道具, 1) + 17004（奖励落到背包）
    // 以前我们**只消耗、不产出**（rollReward 里 `/自选/` 直接 return null，怕画错格子），
    // 现在照实证给：选项清单我们自己算（客户端只认我们给的 ID，见 itemreward.rewardOptions），
    // 回执靠那 8 字节 GUID 关联。--choice=off 可退回旧行为。
    // ⚠ 判据要用 `rewardOptions`（整份清单）**而不是** resolveReward —— 后者会把自选收敛成"第一个"，
    //   光看它分不出"自选"和"固定奖励"（踩过：条件写成 `!rewardItems.length` 永远不成立）。
    if (CHOICE_FLOW && cur.itemId) {
      const opt = accountGiftRule(cur.itemId) || rewardOptions(cur.itemId);
      if (opt && opt.choice && opt.items.length >= 2 && opt.items.length <= 120) {
        if(!opt.items.some(it=>{try{return prepareGiftDelivery([it],slot,cur.itemId);}catch{return false;}})) {
          inventoryNotice('没有可领取的选项：请检查已拥有英雄/皮肤、对应英雄及背包容量。礼包未消耗。');return;
        }
        const guidB = cur.guid && cur.guid.length === 16 ? Buffer.from(cur.guid, 'hex') : synthGuid(slot, cur.itemId);
        const pl = Buffer.alloc(251);
        // Captured 11669: instance GUID at 0, fixed choice IDs from 10.
        guidB.copy(pl, 0);
        opt.items.slice(0,120).forEach((it, i) => pl.writeUInt16LE(it.itemId & 0xffff, 10 + i * 2));
        // 消耗一个 + 报"这一格的新状态"（和普通使用一样）
        // Opening the selection dialog is not consumption; commit on selection.
        const out2 = [
          bagMod.mkFrame(11669, pl, { flags: 0xd2 }),
          bagMod.mkFrame(17019, slotAck(cur.itemId, slot), { flags: 0xd2 }),
        ];
        const fcur = liveDetail(0x0F, slot, cur.itemId, cur.count, guidB);
        if (fcur) out2.push(fcur);
        PENDING_CHOICE.set(guidB.toString('hex'), {
          guid: guidB.toString('hex'), box: cur.itemId, slot,
          选项: opt.items.slice(0,120), at: Date.now(), 剩余: left,
        });
        log(`${tag}     使用 格子${slot} 的「${nmUsed}」→ **自选礼包**：回 11669 列 ${opt.items.length} 个选项`
          + `（${opt.items.map(x => `${ITEM_NAMES && ITEM_NAMES[x.itemId] ? ITEM_NAMES[x.itemId].name : x.itemId}×${x.count}`).join(' / ')}）`
          + `  等客户端发 11670（GUID ${guidB.toString('hex').slice(0, 8)}…）`);
        emitLive(out2, why);
        return;
      }
    }

    const giftRule=accountGiftRule(cur.itemId);
    const reward = giftRule ? (giftRule.choice ? null : giftRule) : resolveReward(cur.itemId);
    const rewardItems = (reward && reward.kind === 'items') ? reward.items : [];

    if (!reward || (reward.kind !== 'attr' && !rewardItems.length)) {
      inventoryNotice('该道具已被禁止使用');
      log(`${tag} use protected: item=${cur.itemId} "${nmUsed}"; preserved without consuming`);
      return;
    }
    const grants = reward.kind === 'attr' ? [{attr:reward.attr,amount:reward.amount}] : rewardItems;
    let delivery;
    try{delivery=prepareGiftDelivery(grants,slot,cur.itemId);}
    catch(error){inventoryNotice(`礼包未消耗：${error.message}。`);return;}
    if (!delivery) {
      inventoryNotice('背包容量或奖励数量不合法，道具未消耗。');
      log(`${tag} use rejected: complete reward preflight failed`);
      return;
    }

    const out = [
      bagMod.mkFrame(17015, u16p(0x010F, cur.itemId, 1), { flags: 0xd6 }),
      bagMod.mkFrame(17019, slotAck(cur.itemId, slot), { flags: 0xd6 }),
    ];
    // 数量减到 0 时必�?*明确报空**：道具ID 换成 0xFFFF（真实服就是这么表示空格子的），
    // 否则客户端看到道具ID 还在，就继续把这一格画着，表现成"用了最后一个也不消�?�?
    const emptied = left === 0;
    const f = emptied
      ? liveDetail(0x0F, slot, 0xFFFF, 0, Buffer.alloc(8))
      : liveDetail(0x0F, slot, cur.itemId, left, cur.guid ? Buffer.from(cur.guid, 'hex') : synthGuid(slot, cur.itemId));
    if (f) out.push(f);

    let granted;
    try{granted=grantGiftDelivery(delivery,0x0120,0xd3,cur.guid);}
    catch(error){log(`${tag} gift commit failed: ${error.message}`);inventoryNotice('礼包领取未完成：保存失败，交易已暂停，请联系管理员核对。');return;}
    if (reward && reward.kind === 'attr') {
      const now = WALLET.attrs[reward.attr];
      out.push(...granted.frames);
      const an = (require('./gold').ATTR_NAME || {})[reward.attr] || reward.attr;
      log(`${tag}     使用 格子${slot} -> ${nmUsed} ×${cur.count} -> ${left}，${an} +${reward.amount} = ${now}${reward.randomPool ? `（描述里的随机面额：${reward.randomPool.join('/')}）` : ''}`);
    } else if (rewardItems.length) {
      out.push(...granted.frames);
      log(`${tag}     使用 格子${slot} -> ${nmUsed} ×${cur.count} -> ${left}，`
        + `${rewardItems.length} 项奖励发放到 ${granted.placements.length} 格${reward.choice ? '（自选类：按描述取第一项）' : ''}`);
    } else {
      log(`${tag}     使用 格子${slot} 的「${nmUsed}」×${cur.count} → 剩 ${left} —— 不是礼包，无产出`);
    }

    // The consumed slot may already contain a reward. Never overwrite it here.
    noteConsumed(slot, cur.itemId);
    emitLive(out, why);
  }

  const u16p = (a, b, c) => { const p = Buffer.alloc(6); p.writeUInt16LE(a, 0); p.writeUInt16LE(b, 2); p.writeUInt16LE(c, 4); return p; };

  /**
   * 「自选礼包」第二步：客户端发 11670 告诉我们**选了哪一个**。
   *
   * 实证（cap-2026-09-26T20-22-26，`node s2cfind.js 11670 --all` 可复现）：
   *   C→S 11670 载荷 = 8 字节 GUID + 12 字节 0（130 字节，后面补 0）
   *   S→C 17015 `0301 <选中道具 u16> 01 01`（kind=0x0103 = 发放）+ 17004 落格
   * 找不到待选记录（或选了清单外的）时：退回"给第一个"并把原因写进日志，不让客户端空等。
   */
  function deliverChoice(guidHex, pickedItemId, why) {
    const pend = PENDING_CHOICE.get(guidHex);
    if (!pend) {
      log(`${tag}     11670 选择回执 GUID ${String(guidHex).slice(0, 16)}… —— **没有待选记录**（可能服务端重启过）→ 不回帧，让客户端自己重开礼包`);
      return [];
    }
    if (Date.now() - pend.at > 10 * 60 * 1000) { PENDING_CHOICE.delete(guidHex); return []; }
    const current = accountGiftRule(pend.box) || rewardOptions(pend.box);
    if (!current || !current.choice || JSON.stringify(current.items.slice(0,120)) !== JSON.stringify(pend.选项)) {
      PENDING_CHOICE.delete(guidHex); return [];
    }
    const pick = current.items[pickedItemId]; // Native 11670 uses a zero-based choice index.
    if (!pick) {
      log(`${tag} choice rejected: unknown selection ${pickedItemId}; box preserved`);
      return [];
    }
    const out = [];
    const nmPick = ITEM_NAMES && ITEM_NAMES[pick.itemId] ? ITEM_NAMES[pick.itemId].name : String(pick.itemId);
    const found = [...BAG.slotMap].find(([,v]) => v && v.guid === pend.guid);
    if (!found || found[1].itemId !== pend.box || !validCount(found[1].count)) { PENDING_CHOICE.delete(guidHex); return []; }
    const slot = found[0];
    let delivery;
    try{delivery=prepareGiftDelivery([pick],slot,pend.box);}
    catch(error){inventoryNotice(`礼包未消耗：${error.message}。`);return [];}
    if (!delivery) {inventoryNotice('背包容量或奖励数量不合法，礼包未消耗。');return [];}
    const remaining = delivery.slots.afterConsume.get(slot);
    out.push(bagMod.mkFrame(17015,u16p(0x010f,pend.box,1),{flags:0xd2}));
    out.push(liveDetail(0x0f,slot,remaining ? remaining.itemId : 0xffff,remaining ? remaining.count : 0,remaining ? Buffer.from(remaining.guid,'hex') : Buffer.alloc(8)));
    let g;
    try{g=grantGiftDelivery(delivery,0x0103,0xd2,guidHex);}
    catch(error){log(`${tag} choice commit failed: ${error.message}`);inventoryNotice('礼包领取未完成：保存失败，交易已暂停，请联系管理员核对。');return [];}
    PENDING_CHOICE.delete(guidHex);
    out.push(...g.frames);
    log(`${tag}     自选礼包「${ITEM_NAMES && ITEM_NAMES[pend.box] ? ITEM_NAMES[pend.box].name : pend.box}」选定：`
      + `${nmPick}×${pick.count}（发放到 ${g.placements.length} 格）`)
    ;
    emitLive(out, why);
    return out;
  }

  /**
   * 道具真的被用掉一个之后：
   *  1) **11523 全量�?*里也要减（客户端背包网格是按这张表画的）—�?   *     否则"用了最后一个，格子上那件还�?，点第二下服务端说这格是空的，看着像卡住�?   *  2) 记进 EMPTIED，之后客户端再点这一格，就明确回"空格"把它抹掉（只�?*我们自己用空�?*格子这么做，
   *     模型外的格子仍然不回，避免误删客户端显示的道具）�?   */
  const EMPTIED = new Set();
  /**
   * 「自选礼包」待选表：GUID(16位hex) -> {guid, box, slot, 选项:[{itemId,count}], at}
   * 客户端点选项后发 11670（载荷前 8 字节 = 同一个 GUID），我们照它把选中的那件发出去。
   * 超时（默认 10 分钟）自动清掉，避免表越攒越大。
   */
  const CHOICE_FLOW = argOf('choice', 'on') !== 'off';
  function noteConsumed(slot, itemId) {
    // The material container is independent of the 192 slot inventory.
    if (!BAG.slotMap.has(slot)) EMPTIED.add(slot);
  }
  const bagListFrame = () => BAG && BAG.itemMap ? bagFullFrame() : null;
  const slotAck = (itemId, slot) => { const p = Buffer.alloc(13); p.writeUInt8(0, 0); p.writeUInt16LE(itemId, 1); p.writeUInt16LE(slot, 3); p.writeUInt32LE(0xFFFFFFFF, 5); p.writeUInt32LE(0, 9); return p; };
  /** �?1043 那套模板的思路造一�?17004：带 3 字节头（种类码）+ 一条记�?*/
  function liveDetail(kind, slot, itemId, count, guid, reforgeOverrideHex=null) {
    if (!EQ_TEMPLATE) return null;
    // 17004：6B头（u8 unknown、u8 kind、u32数量1）+493B容器/格子/实例。
    const p = Buffer.alloc(499);
    p.writeUInt8(0x00, 0); p.writeUInt8(kind, 1); p.writeUInt8(0x01, 2);
    const o = 3;
    p.writeUInt16LE(slot, o + 4); p.writeUInt16LE(itemId & 0xffff, o + 6);
    p.writeUInt16LE(count, o + 10);
    (guid || Buffer.alloc(8)).copy(p, o + 14);
    if (isEquipmentItem(itemId) && WALLET?.blob && BAG?.slotMap) {
      const held=BAG.slotMap.get(slot),key=guid?.toString('hex');
      if (held?.itemId===itemId && held.guid?.toLowerCase()===key) {
        // 17004 carries the same 490-byte instance as the login bag record
        // at payload +9. Preserve the *same GUID's* full record
        // when available; never borrow another instance's unknown fields.
        const record=require('./roledata').itemRecord(WALLET.blob,slot,held);
        patchEnhancementLevel(record,held);
        record.subarray(0,490).copy(p,9);
      }
    }
    if(reforgeOverrideHex!==null){
      if(typeof reforgeOverrideHex!=='string'||! /^[0-9a-f]{84}$/.test(reforgeOverrideHex))
        throw new RangeError('invalid reforge detail override');
      Buffer.from(reforgeOverrideHex,'hex').copy(p,85);
    }
    const gemHeld=BAG?.slotMap?.get(slot);
    if(gemHeld?.itemId===itemId&&gemHeld.guid?.toLowerCase()===guid?.toString('hex'))
      gemCrafting.patchRecord(p.subarray(9),gemHeld);
    return bagMod.mkFrame(17004, p, { flags: 0xd6 });
  }
  /**
   * 找一个空格子放奖励�?   *  1) 先用�?bag-state.json �?"空格�? 里明确列出的（用户亲眼确认是空的那些�?   *     例如 45 �?—�?数组解出来说它装着 32614，但客户端显示是空的，解错了�?   *  2) 再用模型末尾之后的格�?   *  3) 只在容量内找；找不到就返�?null -> 调用方判�?背包已满，不许打开"
   */
  const BAG_CAPACITY = BAG_VISIBLE_CAPACITY;
  function findFreeSlot() {
    // 装备栏引用的背包格**不能当空格用**：那格在客户端那边画着"被装备的那件"，
    // 我们往里放东西会造成"两件道具抢一格"（用户实测的"格子占了却看不见/点它没反应"）。
    const reserved = equippedBagSlots();
    const free = s => !BAG.slotMap.has(s) && !reserved.has(s);
    for (let s = 0; s < BAG_CAPACITY; s++) if (free(s)) return s;
    return null;
  }
  /**
   * 一件实例在背包里**只能占一个格子**。
   * 为什么必须做：客户端是按**实例 GUID** 认道具的 —— 同一个 GUID 出现在两格时它只画一个，
   * 另一格就变成"空洞"，而且那种空洞还放不进东西（用户实测："老是空出格子，还不能放东西"）。
   * 穿装备/卸装备/邮件返回/整理 这些"把已有实例搬到另一格"的路径，写新格之前先把旧格清掉。
   * 返回被清掉的格子号数组（写日志用）。
   */
  function bagClearGuid(guidHex, exceptSlot) {
    const hit = [];
    if (!BAG || !BAG.slotMap || !guidHex) return hit;
    for (const [s, v] of [...BAG.slotMap]) {
      if (s !== exceptSlot && v && v.guid === guidHex) { BAG.slotMap.delete(s); hit.push(s); }
    }
    return hit;
  }
  /** 把一件已有实例放回背包（保证 GUID 唯一）；返回槽号或 0xffff（满）
   *  prefer：优先放回这个格子（**卸装备时要放回它原来那一格** ——
   *  实证：2026-09-27 06:22 真人会话里我们把"鲷鱼烧"卸到格子70，客户端却把它显示在 76，
   *  5 秒后用户点 76 想装备，我们模型里是空的 → "点了没反应/有空格不会放"。放回原格最符合客户端预期。）*/
  function putBackToBag(rec, why, prefer) {
    let free = null;
    if (Number.isInteger(prefer) && prefer >= 0 && prefer < BAG_CAPACITY) {
      const held = BAG.slotMap.get(prefer);
      // 那一格空着 → 就用它（客户端那边这件道具本来就画在这里）。
      // 那一格装着**别的实例** → 也用它，但先把那件挤走的实例换个格子放（不能在客户端画着 A 的格子里塞 B，
      //   否则就是"点这个装那个"的来源之一）。
      if (!held || (held.guid || '') !== (rec.guid || '')) free = prefer;
    }
    if (free === null) free = findFreeSlot();
    if (free === null) return 0xffff;
    const guidHex = rec.guid && Buffer.from(rec.guid, 'hex').length === 8 ? Buffer.from(rec.guid, 'hex').toString('hex') : synthGuid(free, rec.itemId).toString('hex');
    const occupant = BAG.slotMap.get(free);
    if (occupant && occupant.guid !== guidHex) {
      const alt = findFreeSlot();
      if (alt !== null) {
        BAG.slotMap.set(alt, occupant);
        log(`${tag}     · ${why}：优先格 ${free} 被「${ITEM_NAMES && ITEM_NAMES[occupant.itemId] ? ITEM_NAMES[occupant.itemId].name : occupant.itemId}」占着 → 先把那件挪到 ${alt}，再把本件放回 ${free}`);
      } else {
        log(`${tag}     · ${why}：优先格 ${free} 被占且背包已满，拒绝覆盖原物品`);
        return 0xffff;
      }
    }
    const cleared = bagClearGuid(guidHex, free);
    if (cleared.length) log(`${tag}     · ${why}：GUID ${guidHex.slice(0, 8)}… 原来还在格子${cleared.join(',')}（同一实例不能占两格）→ 清掉`);
    BAG.slotMap.set(free, { itemId: rec.itemId, count: rec.count || 1, guid: guidHex });
    saveBagLive(BAG.slotMap);
    return free;
  }
  /**
   * 把服务端权威背包**整份重推**给客户端（每个占用格一条 17004）。
   * 用途：客户端布局和我们不一致时（它把道具画在我们模型里是空的格子上）——
   *  与其让用户"点了没反应"，不如强制它按我们的布局重画一遍，两边立刻回到同一个状态。
   * 实证依据：真人会话里出现过"客户端点第76格、我们模型是空的"（2026-09-27 06:22:38）。
   */
  function inventoryNotice(text) {
    // Real-server 17002 bag-full rejection emits 1103 MSG_SHOWTEXT with
    // "包裹空间不足" in this fixed 256-byte GBK field (capture 02-56-55,
    // 03:05:47.201). 12002 is a chat channel, not a floating error.
    const encoded = GBK.encode(text);
    if (encoded.length >= 256) { log(`${tag} showtext too long`); return; }
    const payload = Buffer.concat([
      Buffer.from('00e803000000ecffff04ffffffff', 'hex'),
      Buffer.alloc(256),
    ]);
    encoded.copy(payload, 14);
    emitLive([bagMod.mkFrame(1103, payload, {flags:0xd2, stream:PLAYERID})], 'inventory showtext');
  }
  function bagResyncFrames(why, slots) {
    const out = [];
    const targets = slots ? [...new Set(slots)].filter(s => Number.isInteger(s) && s >= 0 && s < BAG_CAPACITY).sort((a, b) => a - b)
      : Array.from({ length: BAG_CAPACITY }, (_, s) => s);
    for (const s of targets) {
      const v = BAG.slotMap.get(s);
      const frame = liveDetail(0x0f, s, v ? v.itemId : 0xffff, v ? v.count : 0,
        v && v.guid ? Buffer.from(v.guid, 'hex') : Buffer.alloc(8));
      if (frame) out.push(frame);
    }
    log(`${tag}     ↻ ${why}：逐格校准 ${out.length}/${targets.length} 格`);
    return out;
  }

  // ---- 道具进背包：**真服实证的帧格式**（logs/cap-2026-09-27T02-22-47 / 02-56-55）------
  //   17015 载荷 = u16 种类码 | u16 道具ID | u8 本次数量 | u8 标志（1=获得, 0=使用/销毁）
  //   17004 载荷 = 00 <种类码低字节> 01 + 一条 22 字节记录(slot, itemId, **合并后的总数**, GUID)
  //   同类道具第二次进包会**合并到同一格**并把总数报给客户端
  //   （实证：邮件 7887 先 ×2 进格子102，再 ×3 **还是格子102**，数量 5）
  //   flags：商城那条链用 0xd3、邮件/销毁用 0xd2（各自抓包里实测，别混用）
  const STACK_MAX = +(argOf('stack-max', '1000'));
  const MAX_U32 = 0xffffffff, MAX_HINT_QUANTITY = 0xffff;
  if (!Number.isSafeInteger(STACK_MAX) || STACK_MAX < 1 || STACK_MAX > 0xffff)
    throw new Error(`Invalid --stack-max=${STACK_MAX}; slot detail count is u16`);
  const {planAccessible} = require('./inventory-transaction');
  const validCount = n => Number.isSafeInteger(n) && n > 0;
  const validCounter = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_U32;

  // Preview the whole business action without touching any live model. The
  // same slot plan is later committed, including a consumed box's freed slot.
  function prepareDelivery(rewards, {consumeSlot = null, debit = null} = {}) {
    if (!BAG?.slotMap || !Array.isArray(rewards)) return null;
    // Coin item346 is a currency reward: every grant source credits the
    // same wallet transaction rather than allocating ordinary bag slots.
    try{rewards=require('./player-reward-currency').convertRewards(rewards);}catch{return null;}
    const slotItems = [], slotIndexes = [], materials = new Map(BAG.itemMap), resources = {...RES};
    const attrs = new Map(Object.entries(WALLET?.attrs || {}).map(([id, value]) => [+id, value]));
    const totals = [];
    for (let index = 0; index < rewards.length; index++) {
      const r = rewards[index];
      if (!r || typeof r !== 'object') return null;
      if (r.attr !== undefined) {
        if (!WALLET?.ok) return null;
        if (!Number.isSafeInteger(r.attr) || r.attr < 0 || r.attr > 255 || !validCount(r.amount)) return null;
        const current = attrs.get(r.attr), total = current + r.amount;
        if (!validCounter(current) || !validCounter(total)) return null;
        attrs.set(r.attr, total); totals[index] = total;
        continue;
      }
      if (!Number.isSafeInteger(r.itemId) || r.itemId < 1 || r.itemId >= 0xffff || !validCount(r.count)) return null;
      const container=containerOf(r.itemId);
      if (container==='unknown' || container==='dedicated') {
        log(`reward storage rejected item ${r.itemId}: ${JSON.stringify(classifyItem(r.itemId))}`);
        return null;
      }
      if (container==='slot') {
        // Native item-change processing supports independent repeated entries;
        // each quantity is u8 and each frame must stay within 100 entries.
        if (r.count > MAX_HINT_QUANTITY) return null;
        slotItems.push(r); slotIndexes.push(index);
      } else if (container==='resource') {
        const current = resources[r.itemId] ?? 0, total = addResourceBalance(r.itemId, current, r.count);
        if (total === null) return null;
        resources[r.itemId] = total; totals[index] = total;
      } else {
        const current = materials.get(r.itemId) ?? 0, total = current + r.count;
        if (!validCounter(current) || !validCounter(total)) return null;
        materials.set(r.itemId, total); totals[index] = total;
      }
    }
    let walletExtra = null;
    if (debit) {
      if (!validCount(debit.amount)) return null;
      if(debit.resource){
        const current=RES[debit.resource]??0;
        if(!isResourceItem(debit.resource)||!validCounter(current)||current<debit.amount)return null;
        resources[debit.resource]=(resources[debit.resource]??0)-debit.amount;
      }else if(debit.walletKey==='honour'){
        const current=WALLET?.state.honour;
        if(!WALLET?.ok||!validCounter(current)||current<debit.amount)return null;
        walletExtra={honour:current-debit.amount};
      }else{
        if(!WALLET?.ok||!Number.isSafeInteger(debit.attr)||debit.attr<0||debit.attr>255)return null;
        const current=Number(WALLET.attrs[debit.attr]);
        if(!validCounter(current)||current<debit.amount)return null;
        attrs.set(debit.attr,attrs.get(debit.attr)-debit.amount);
      }
    }
    const slots = planAccessible(BAG.slotMap, slotItems, BAG_CAPACITY, BAG_SLOTS_FOR_FRAME,
      STACK_MAX, EQUIP.entries(), canStackItem, consumeSlot);
    if (!slots) return null;
    return {rewards, slots, slotIndexes, materials, resources, attrs, totals, debit, walletExtra,
      changedBag: consumeSlot !== null || slotItems.length > 0 || slots.relocations.length > 0,
      changedEquipment: slots.relocations.length > 0,
      changedMaterials: rewards.some(r => r.itemId !== undefined && containerOf(r.itemId)==='material'),
      changedResources: !!debit?.resource || rewards.some(r => r.itemId !== undefined && containerOf(r.itemId)==='resource'),
      changedAttrs: rewards.some(r => r.attr !== undefined) || (!!debit && !debit.resource)};
  }

  function economySnapshot() {
    return {slots:new Map([...BAG.slotMap].map(([slot,value])=>[slot,value ? {...value} : value])),
      plans:new Map([...EQUIP_PLANS].map(([pos,e])=>[pos,e ? {...e,guid:Buffer.from(e.guid)} : e])),
      equipment:new Map([...EQUIP].map(([pos,e])=>[pos,e ? {...e,guid:Buffer.from(e.guid)} : e])),
      items:new Map(BAG.itemMap),resources:{...RES},
      walletAttrs:WALLET ? {...WALLET.attrs} : null,
      walletGold:WALLET?.gold,
      walletAttrsAliased:!!WALLET&&WALLET.state?.attrs===WALLET.attrs,
      walletState:WALLET ? JSON.parse(JSON.stringify(WALLET.state)) : null};
  }
  function restoreEconomy(snapshot) {
    BAG.slotMap = new Map([...snapshot.slots].map(([slot,value])=>[slot,value ? {...value} : value]));
    EQUIP_PLANS.clear(); for(const [pos,e] of snapshot.plans) EQUIP_PLANS.set(pos,e ? {...e,guid:Buffer.from(e.guid)} : e);
    EQUIP.clear(); for (const [pos,e] of snapshot.equipment) EQUIP.set(pos,e ? {...e,guid:Buffer.from(e.guid)} : e);
    BAG.itemMap = new Map(snapshot.items);
    for (const id of Object.keys(RES)) delete RES[id];
    Object.assign(RES,snapshot.resources);
    if (WALLET) {
      WALLET.attrs = {...snapshot.walletAttrs};
      WALLET.gold = snapshot.walletGold;
      WALLET.state = JSON.parse(JSON.stringify(snapshot.walletState));
      if(snapshot.walletAttrsAliased)WALLET.state.attrs=WALLET.attrs;
    }
  }
  function copyCache(value,seen=new Map()) {
    if(value===null||typeof value!=='object')return value;
    if(seen.has(value))return seen.get(value);
    if(Buffer.isBuffer(value)){const result=Buffer.from(value);seen.set(value,result);return result;}
    if(value instanceof ArrayBuffer)return value.slice(0);
    if(value instanceof DataView)return new DataView(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength));
    if(ArrayBuffer.isView(value))return new value.constructor(value);
    if(value instanceof Date)return new Date(value.getTime());
    const result=value instanceof Map?new Map():value instanceof Set?new Set():Array.isArray(value)?[]:Object.create(Object.getPrototypeOf(value));
    seen.set(value,result);
    if(value instanceof Map)for(const [key,item]of value)result.set(copyCache(key,seen),copyCache(item,seen));
    else if(value instanceof Set)for(const item of value)result.add(copyCache(item,seen));
    else for(const key of Object.keys(value))Object.defineProperty(result,key,{value:copyCache(value[key],seen),enumerable:true,writable:true,configurable:true});
    return result;
  }
  function sqliteCacheSnapshot() {
    return {
      economy:BAG?.slotMap?copyCache(economySnapshot()):null,
      wallet:WALLET?copyCache({attrs:WALLET.attrs,gold:WALLET.gold,state:WALLET.state}):null,
      progression:Object.fromEntries(Object.entries(PROGRESSION).filter(([,store])=>store?.state!==undefined).map(([key,store])=>[key,copyCache(store.state)])),
      gems:copyCache(GEM_BOARD.state),souls:copyCache(SOULS.state),shopLimits:copyCache(SHOP_LIMIT_STATE),
      equipmentPlan:activeEquipmentPlan,equipmentSaved:copyCache(EQUIP_SAVED),equipmentSavedRead:EQUIP_SAVED_READ,
      enhancement:copyCache(EQUIPMENT_ADAPTER?.enhancement.instances),reforgeApplied:copyCache(EQUIPMENT_ADAPTER?.reforge.applied),reforgePending:copyCache(EQUIPMENT_ADAPTER?.reforge.pending),
      equipmentFrames:copyCache(EQUIPMENT_ADAPTER?.lastFrames),equipmentDebits:copyCache(EQUIPMENT_ADAPTER?.lastDebits),
      runeMutations:copyCache(RECENT_RUNE_MUTATIONS)
      ,mail:MAIL_STATE.snapshot(),mailNotified:[...notifiedMailIds],ownedMailSignature,ownedMailIds:ownedMailIds===null?null:[...ownedMailIds]
    };
  }
  function restoreSqliteCaches(snapshot) {
    // Restore mutable runtime views together with the rolled-back documents.
    // Keep storage/commit freezing and its diagnostics intact; this writes no
    // files and does not finalize or erase any pending transaction.
    if(snapshot.economy)restoreEconomy(snapshot.economy);
    else if(snapshot.wallet){WALLET.attrs=snapshot.wallet.attrs;WALLET.gold=snapshot.wallet.gold;WALLET.state=snapshot.wallet.state;}
    for(const [key,state]of Object.entries(snapshot.progression))PROGRESSION[key].state=state;
    GEM_BOARD.state=snapshot.gems;SOULS.state=snapshot.souls;SHOP_LIMIT_STATE=snapshot.shopLimits;
    activeEquipmentPlan=snapshot.equipmentPlan;EQUIP_SAVED=snapshot.equipmentSaved;EQUIP_SAVED_READ=snapshot.equipmentSavedRead;
    if(EQUIPMENT_ADAPTER){EQUIPMENT_ADAPTER.enhancement.instances=snapshot.enhancement;EQUIPMENT_ADAPTER.reforge.applied=snapshot.reforgeApplied;EQUIPMENT_ADAPTER.reforge.pending=snapshot.reforgePending;EQUIPMENT_ADAPTER.lastFrames=snapshot.equipmentFrames;EQUIPMENT_ADAPTER.lastDebits=snapshot.equipmentDebits;}
    RECENT_RUNE_MUTATIONS.clear();for(const [key,value]of snapshot.runeMutations)RECENT_RUNE_MUTATIONS.set(key,value);
    MAIL_STATE.restore(snapshot.mail);notifiedMailIds.clear();for(const id of snapshot.mailNotified)notifiedMailIds.add(id);
    ownedMailSignature=snapshot.ownedMailSignature;ownedMailIds=snapshot.ownedMailIds===null?null:new Set(snapshot.ownedMailIds);
  }
  function rewardPaths(plan) {
    return Object.fromEntries([
      plan.changedBag && ['bag',BAG_LIVE],
      plan.changedEquipment && ['equip',EQUIP_STATE_FILE],
      plan.changedMaterials && ['material',MATERIAL_LIVE],
      plan.changedResources && ['resource',RESOURCE_FILE],
      plan.changedAttrs && ['wallet',process.env.DSH_GOLD_STATE || path.join(__dirname,'gold-state.json')],
    ].filter(Boolean));
  }
  let personalSettingsSignature;
  function pushPersonalSettings(force=false){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||economyFrozen())return;
    try{
      const reply=require('./player-personal-settings').reply(loginProjectionAccount());
      const signature=reply?.subarray(12).toString('hex');
      if(reply&&(force||signature!==personalSettingsSignature)){
        emitLive([reply],'current account personal settings');personalSettingsSignature=signature;
      }
    }catch(error){loginProjectionFailure(error);log('Personal settings refresh failed: '+error.message);}
  }
  LIVE_PERSONAL_SETTINGS_PUSH.add(pushPersonalSettings);
  let titleSignature,titleOwnedIds=null;
  function pushTitle(force=false){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||economyFrozen())return;
    if(inMatch){pushPersonalSettings(force);return;}
    try{
      const wire=require('./player-title-wire'),current=loginProjectionAccount(),state=wire.display(current);
      const ownership=wire.ownershipChanges(current,titleOwnedIds);
      if(ownership.frames.length)emitLive(ownership.frames,'current account title ownership change');
      titleOwnedIds=ownership.ids;
      const signature=JSON.stringify(state);
      if(force||signature!==titleSignature){
        emitLive([wire.reply(current)],'current account title');titleSignature=signature;
      }
      pushPersonalSettings(force);
    }catch(error){loginProjectionFailure(error);log('Title refresh failed: '+error.message);}
  }
  LIVE_TITLE_PUSH.add(pushTitle);
  const titleTimer=PLAYER_ACCOUNTS?setInterval(()=>{pushTitle();pushPersonalSettings();},1000):null;
  function pushHeroes(){
    syncBattleOwnership();
    if(!PLAYER_SCOPE?.heroWire||!accountOnline||!roleReadyAt||sock.destroyed||inMatch||economyFrozen())return;
    try{
      const now=Date.now(),account=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),full=playerHeroes.render(account,now,{flags:0xd3,stream:PLAYERID}),wire=playerHeroes.decode(full);
      if(economyFrozen())return;
      const current=new Map(wire.order.map(id=>{const row=Buffer.from(wire.records[id],'hex');return [id,row.readUInt32LE(8)+':'+row.readUInt16LE(180)];}));
      const removed=heroSignatures&&[...heroSignatures.keys()].some(id=>!current.has(id));
      const changed=[...current.keys()].filter(id=>heroSignatures?.get(id)!==current.get(id));
      if(!heroSignatures||removed)emitLive([full],'current account hero collection refresh');
      else if(changed.length)emitLive([playerHeroes.incremental(account,changed,now,{flags:0xd3,stream:PLAYERID})],'current account skin choice refresh');
      // A recovery marker appearing during projection must not consume the
      // refresh: the next finalized read will repeat it.
      if(!economyFrozen())heroSignatures=current;
    }catch(error){log('Hero collection refresh failed: '+error.message);}
  }
  const heroTimer=PLAYER_ACCOUNTS?setInterval(pushHeroes,1000):null;
  sock.once('close',()=>clearInterval(heroTimer));
  titleTimer?.unref();
  let medalSignature;
  function pushMedals(force=false,operation=1){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||inMatch||economyFrozen())return;
    try{
      const account=loginProjectionAccount(),medals=require('./player-medals'),now=Date.now(),query=medals.reply(account,1,now);
      if(!query)return;
      const signature=query.subarray(12).toString('hex');
      if(force||signature!==medalSignature){
        emitLive([operation===1?query:medals.reply(account,operation,now)],'current account medals');medalSignature=signature;
      }
    }catch(error){loginProjectionFailure(error);log('Medal refresh failed: '+error.message);}
  }
  LIVE_MEDAL_PUSH.add(pushMedals);
  const medalTimer=PLAYER_ACCOUNTS?setInterval(pushMedals,1000):null;
  medalTimer?.unref();
  sock.once('close',()=>{LIVE_MEDAL_PUSH.delete(pushMedals);clearInterval(medalTimer);});

  let avatarSignature;
  function pushAvatar(force=false){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||inMatch||economyFrozen())return;
    try{
      const reply=require('./player-avatar').reply(loginProjectionAccount(),ACCOUNT_AVATAR_POLICY);if(!reply)return;
      const signature=reply.subarray(12).toString('hex');
      if(force||signature!==avatarSignature){emitLive([reply],'current account avatar');avatarSignature=signature;}
    }catch(error){loginProjectionFailure(error);log('Avatar refresh failed: '+error.message);}
  }
  LIVE_AVATAR_PUSH.add(pushAvatar);
  sock.once('close',()=>LIVE_AVATAR_PUSH.delete(pushAvatar));
  function pushWarSoul(){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||inMatch||economyFrozen())return;
    const refresh=liveWarSoulRefresh();if(refresh)emitLive([refresh,...equipmentAttributeFrames(true)],'saved account war-soul peer refresh');
  }
  LIVE_WAR_SOUL_PUSH.add(pushWarSoul);
  sock.once('close',()=>LIVE_WAR_SOUL_PUSH.delete(pushWarSoul));
  function pushKillEffect(){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||inMatch||economyFrozen())return;
    try{const reply=require('./player-kill-effect-state').reply(loginProjectionAccount(),ACCOUNT_KILL_EFFECT_TEMPLATE);
      if(reply)emitLive([reply],'saved account kill effect removal');
    }catch(error){loginProjectionFailure(error);log('Kill effect refresh failed: '+error.message);}
  }
  LIVE_KILL_EFFECT_PUSH.add(pushKillEffect);
  sock.once('close',()=>LIVE_KILL_EFFECT_PUSH.delete(pushKillEffect));
  function pushFightDress(){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||inMatch||economyFrozen())return;
    try{const reply=require('./player-fight-dress').reply(loginProjectionAccount(),ACCOUNT_FIGHT_DRESS_TEMPLATE);
      if(reply)emitLive([reply],'saved account fight dress removal');
    }catch(error){loginProjectionFailure(error);log('Fight dress refresh failed: '+error.message);}
  }
  LIVE_FIGHT_DRESS_PUSH.add(pushFightDress);
  sock.once('close',()=>LIVE_FIGHT_DRESS_PUSH.delete(pushFightDress));
  function pushAvatarFrame(){
    if(!PLAYER_ACCOUNTS||!accountOnline||!roleReadyAt||sock.destroyed||inMatch||economyFrozen())return;
    try{const frames=require('./player-avatar-frame'),list=ACCOUNT_FRAME_LIST_TEMPLATE?frames.publicList(ACCOUNT_FRAME_LIST_TEMPLATE):null;
      const reply=frames.reply(loginProjectionAccount());
      if(list||reply)emitLive([list,reply].filter(Boolean),'current public avatar frame candidates and saved choice');}
    catch(error){loginProjectionFailure(error);log('Avatar frame refresh failed: '+error.message);}
  }
  LIVE_AVATAR_FRAME_PUSH.add(pushAvatarFrame);
  sock.once('close',()=>LIVE_AVATAR_FRAME_PUSH.delete(pushAvatarFrame));

  function accountGiftRule(itemId){
    return PLAYER_SCOPE?.heroWire?require('./player-hero-gifts').rule(itemId):null;
  }
  function prepareGiftDelivery(rewards,slot,box){
    if(!PLAYER_SCOPE?.heroWire)return prepareDelivery(rewards,{consumeSlot:slot});
    const prepared=require('./player-hero-gifts').prepare(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),rewards,`gift:${box}`);
    const delivery=prepareDelivery(prepared.ordinary,{consumeSlot:slot});
    if(delivery&&prepared.grants.length)delivery.accountGift=prepared;
    return delivery;
  }
  function grantGiftDelivery(delivery,kind,flags,guid){
    if(!delivery.accountGift)return grantToBag(delivery,kind,0,flags);
    const snapshot=economySnapshot(),prepared=delivery.accountGift;
    try{
      const granted=grantToBag(delivery,kind,0,flags,true,false);
      const savers={bag:()=>saveBagLive(BAG.slotMap,true),equip:()=>saveEquipState(true),
        material:()=>saveMaterialLive(BAG.itemMap,true),resource:()=>saveResources(),wallet:()=>WALLET.save(true)};
      const steps=Object.entries(rewardPaths(delivery)).map(([name,file])=>({name,path:path.resolve(file),save:savers[name]}));
      steps.push({name:'player-accounts',path:PLAYER_ACCOUNTS.file,
        save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:prepared.revision},a=>{
          for(const grant of prepared.grants)heroRewards.apply(a,grant);
        })});
      if(!EQUIPMENT_COMMIT.run('hero-gift',String(guid),steps))throw Error('economy frozen');
      granted.frames.push(...require('./player-hero-gifts').frames(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),prepared.grants,{flags,stream:PLAYERID}));
      return granted;
    }catch(error){restoreEconomy(snapshot);throw error;}
  }

  /** Commit one validated transaction. Return quantity-safe 17015 batches per
   * reward and one 17004 for every touched slot, retaining message order. */
  function grantToBag(plan, kind, flag, flags, strictSave = false, persist = true) {
    if (!plan) return null;
    const used = new Set([...BAG.slotMap.values()].map(v => v?.guid?.toLowerCase()).filter(Boolean));
    const next = plan.slots.next;
    for (const [slot, v] of next) if (v?.guid === null) {
      let guid;
      do { guid = require('crypto').randomBytes(8).toString('hex'); }
      while (/^0+$/.test(guid) || used.has(guid));
      used.add(guid);
      next.set(slot, {...v, guid});
    }
    const byReward = new Map();
    for (const p of plan.slots.placements) {
      const index = plan.slotIndexes[p.rewardIndex];
      if (!byReward.has(index)) byReward.set(index, []);
      byReward.get(index).push(p);
    }
    BAG.slotMap = next;
    for (const move of plan.slots.relocations || []) {
      const e = EQUIP.get(move.pos);
      if (!e || e.bagSlot !== move.from || e.itemId !== move.itemId ||
          e.guid?.toString('hex') !== move.guid || next.get(move.to)?.guid !== move.guid)
        throw new Error('equipment relocation changed after preflight');
      remapEquipRefs(new Map([[move.from,move.to]]),next);
    }
    if (plan.changedMaterials) BAG.itemMap = plan.materials;
    if (plan.changedResources) Object.assign(RES, plan.resources);
    if (plan.changedAttrs && WALLET) {
      for (const [attr, value] of plan.attrs) WALLET.attrs[attr] = value;
      WALLET.gold = WALLET.attrs[50];
      if(plan.walletExtra)Object.assign(WALLET.state,plan.walletExtra);
    }
    const save = (container, fn) => {
      try { if(persist)fn(); } catch (error) { error.mailSaveContainer = container; throw error; }
    };
    if (plan.changedBag) save('bag',()=>saveBagLive(BAG.slotMap, strictSave));
    if (plan.changedEquipment) save('equip',()=>saveEquipState(strictSave));
    if (plan.changedMaterials) save('material',()=>saveMaterialLive(BAG.itemMap, strictSave));
    if (plan.changedResources) save('resource',()=>saveResources());
    if (plan.changedAttrs && WALLET) save('wallet',()=>WALLET.save(strictSave));
    const frames = [];
    for (const move of plan.slots.relocations || []) {
      const e=EQUIP.get(move.pos),frame=equipFrame(move.pos,e.bagSlot,e.itemId,e.count,e.guid);
      if(frame)frames.push(frame);
    }
    for (let index = 0; index < plan.rewards.length; index++) {
      const r = plan.rewards[index];
      if (r.attr !== undefined) {
        if (GOLD_PUSH === '1045' || GOLD_PUSH === 'both') frames.push(mkAttrFrame(r.attr, plan.totals[index]));
        if ((GOLD_PUSH === 'roledata' || GOLD_PUSH === 'both') && r.attr === GOLD_ATTR) {
          const f = roleFrameNow('grant currency'); if (f) frames.push(f);
        }
      } else if (containerOf(r.itemId)==='resource') {
        frames.push(resourceBalanceFrame(r.itemId, plan.totals[index], flags ?? 0xd3));
      } else if (containerOf(r.itemId)==='material') {
        frames.push(bagMod.buildBagDelta(r.itemId, plan.totals[index]));
      } else {
        frames.push(...require('./item-change-wire').quantityFrames(kind & 0xff,r.itemId,r.count,flag?1:0,{flags:flags??0xd3}));
        for (const placement of byReward.get(index) || []) {
          const v = next.get(placement.slot);
          const detail = liveDetail(kind & 0xff, placement.slot, r.itemId, placement.total, Buffer.from(v.guid, 'hex'));
          if (detail) frames.push(detail);
        }
      }
    }
    const paymentFrames = !plan.debit?[]:plan.debit.resource
      ?[resourceBalanceFrame(plan.debit.resource,RES[plan.debit.resource],flags??0xd3)]
      :plan.debit.walletKey==='honour'?[honourFrame()].filter(Boolean)
      :goldPushFrames('purchase',plan.debit.attr);
    return {frames, paymentFrames, placements: plan.slots.placements};
  }

  // Advanced rune exchange tokens are real restore items in the visible bag,
  // so consume one slot item per generated rune and send the same use/detail
  // notifications as the native item-use path.  The RuneState mutation is
  // deliberately kept separate from this inventory debit: the protocol row
  // validates the token and this function owns its persistent storage.
  function consumeRuneExchangeTokens(itemId, count) {
    const out=[];
    for(let i=0;i<Math.max(0,Number(count)||0);i++){
      const found=[...BAG.slotMap].find(([,value])=>Number(value?.itemId)===Number(itemId)&&Number(value?.count)>0);
      if(!found) return null;
      const [slot,current]=found;
      const delivery=prepareDelivery([],{consumeSlot:slot});
      if(!delivery) return null;
      const remaining=delivery.slots.afterConsume.get(slot);
      grantToBag(delivery,0x0120,0,0xd2,true);
      out.push(bagMod.mkFrame(17015,u16p(0x010f,Number(itemId),1),{flags:0xd2}));
      out.push(liveDetail(0x0f,slot,remaining?remaining.itemId:0xffff,
        remaining?remaining.count:0,remaining?.guid?Buffer.from(remaining.guid,'hex'):Buffer.alloc(8)));
    }
    return out.filter(Boolean);
  }

  /** 礼包开什么：按道具ID 稳定地挑一�?—�?具体给什么以后可以随便改 */
  const REWARD_POOL = [41072, 41073, 41074, 41075, 41076, 41077, 41078, 41079, 379, 380, 381];
  function rollReward(itemId) {
    const nm = ITEM_NAMES && ITEM_NAMES[itemId] ? ITEM_NAMES[itemId].name : '';
    // 「自选」类要走两步：真实服先回 11669 给一份选项列表，用户选完客户端再�?1493�?    // 我们还没实现那个流程 —�?现在硬给奖励会让客户端把结果画到别的格子上（用户实测：替换掉旁边的格子）�?    // 所以自选类**暂时只消耗、不产出**，宁可不给，也不要画错�?
    if (/自选/.test(nm))
    return null;
    const isBox = /礼包|箱|宝箱|碎片/.test(nm);
    if (!isBox) return null;
    const pick = REWARD_POOL[itemId % REWARD_POOL.length];
    return { itemId: pick, count: 1 };
  }

  /** 背包格子查询：真实映�?> 私服规格 > 指派 */
  function answerSlotQuery(slot, why) {
    return useBagSlot(slot, why);
  }
  function answerSlotQueryOld(slot, why) {
    const cur = BAG.slotMap.get(slot) || (BAG_SPEC && BAG_SPEC.get(slot));
    const from = BAG.slotMap.has(slot) ? '真实映射' : (BAG_SPEC && BAG_SPEC.has(slot) ? '私服规格' : null);
    if (!cur) {
      // 模型里没有这个格子。三种处理方式：
      //   silent（默认）: 什么都不发，客户端保留自己显示的东�?      //   empty        : 答「空」—�?实测客户端会把道具抹掉，别用
      //   assign       : �?*服务端指�?*一个道具。用来验证「客户端到底认不认我们给的背包�?
      if (BAG_UNKNOWN === 'silent') {
        log(`${tag}     背包查询 格子${slot} -> 模型里没�?�?不发应答（避免客户端把道具抹掉）  �?逻辑没写：需要补这个格子的映射`);
        return;
      }
      if (BAG_UNKNOWN === 'assign') {
        // 之前指派过的格子优先用记录（保证跨会话一致）
        const remembered = ASSIGN[slot];
        const itemId = remembered ? remembered.itemId : BAG_CATALOG[slot % BAG_CATALOG.length];
        const count = remembered ? remembered.count : 1 + (slot % 5);
        const g = remembered ? Buffer.from(remembered.guid, 'hex') : synthGuid(slot, itemId);
        if (!remembered) persistAssign(slot, itemId, count, g);
        log(`${tag}     背包查询 格子${slot} -> 【服务端指派】道具${itemId}×${count}${remembered ? '（沿用记录）' : '（新指派，已落盘）'}`);
        emitLive([
          bagMod.buildSlotAck(itemId, slot),
          bagMod.buildSlotHint(itemId),
          bagMod.buildSlotDetail([{ slot, itemId, count, guid: g }]),
        ], why);
        return;
      }
      const g = synthGuid(slot, 0);
      log(`${tag}     背包查询 格子${slot} -> 模型里没�?�?�?--bag-unknown=empty 答「空」`);
      emitLive([bagMod.buildSlotAck(0xFFFF, slot), bagMod.buildSlotDetail([{ slot, itemId: 0, count: 0, guid: g }])], why);
      return;
    }
    const out = [bagMod.buildSlotAck(cur.itemId, slot), bagMod.buildSlotHint(cur.itemId)];
    out.push(bagMod.buildSlotDetail([{
      slot, itemId: cur.itemId, count: cur.count,
      guid: cur.guid ? Buffer.from(cur.guid, 'hex') : synthGuid(slot, cur.itemId),
    }]));
    const nm = ITEM_NAMES && ITEM_NAMES[cur.itemId] ? `�?{ITEM_NAMES[cur.itemId].name}）` : '';
    log(`${tag}     背包查询 格子${slot} -> 道具${cur.itemId}${nm}×${cur.count}   [${from}]`);
    emitLive(out, why);
  }

  /**
   * 兜底推�?*只允许推白名单里�?msgid**�?   *
   * 教训（两次都是这里出的）�?   *   - 黑名单永远会漏。先前用黑名单，结果�?   *     · 推出了一条带非法道具ID(0xFFFF) �?17004 -> 客户端查配置失败，崩溃报�?   *     · 推出�?1020(退出游�? 那一批（一�?1319 清理帧）-> 客户端干净地关掉了窗口
   *   - 所以改成白名单：只�?*周期性、无状�?*的推送才允许在客户端静默时补发�?   */
  const SAFE_PUSH = new Set([
    1298,      // 心跳应答
    1313,      // �?~5 秒的服务端主动推（带递增计数器）
    20703,     // 同类周期推送
  ]);
  let safetyTimer = null;
  function armSafety() {
    if (!SAFETY || inMatch) return;
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => {
      if (sock.destroyed || inMatch) return;
      // 找到下一个「安全」的待发批次：只推心�?普通推送，状态帧跳过
      let b = null, skipped = 0;
      for (const cand of S.batches) {
        if (done.has(cand.key)) continue;
        if (cand.frames.some(f => !SAFE_PUSH.has(f.msgid))) { done.add(cand.key); skipped++; continue; }
        b = cand; break;
      }
      if (!b) { if (skipped) log(`${tag}     兜底跳过 ${skipped} 个含状态帧的批次（不能脱离上下文推）`); return; }
      safetyHits++;
      log(`${tag} !! 客户端静�?${SAFETY}ms，兜底推送批[${b.key}]（跳�?${skipped} 个不安全批次）`);
      emitBatch(b, '兜底');
      armSafety();
    }, SAFETY);
  }

  emitBatch(S.byKey.get('connect') || { key: 'connect', frames: [] }, '连入即发');
  armSafety();

  let renamePending=false;
  function handleRename(frame){
    const rename=require('./player-rename-card');
    if(renamePending){emitLive([rename.reply({ok:false,status:1003})],'rename already pending');return;}
    let parsed;
    try{parsed=rename.request(frame);}catch(error){emitLive([rename.reply({ok:false,status:error.status||1001})],'rename invalid');return;}
    if(!accountOnline||inMatch||economyFrozen()){emitLive([rename.reply({ok:false,status:1002})],'rename unavailable');return;}
    renamePending=true;
    let reservation,attempted=false,committed=false;
    void (async()=>{
      try{
        reservation=await NAME_BROKER.reserve(parsed.name);
        if(sock.destroyed||!accountOnline||inMatch||economyFrozen())throw Error('Rename account unavailable after reservation');
        const current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
        const prepared=rename.prepare({account:current,registeredAccounts:reservation.registeredAccounts,
          registry:reservation.registry,slots:BAG.slotMap,locks:PROGRESSION.itemLock,name:parsed.name,authenticated:accountOnline,
          frozen:economyFrozen(),inMatch,now:Date.now()});
        if(!prepared.ok){const error=Error(prepared.reason);error.status=prepared.status;throw error;}
        if(!prepared.repeated){
          rename.checkAccount(current,prepared);rename.checkSlots(BAG.slotMap,prepared,PROGRESSION.itemLock);
          const before=economySnapshot();
          try{
            attempted=true;
            if(!EQUIPMENT_COMMIT.run('rename-card',prepared.eventId,[
              {name:'player-accounts',path:PLAYER_ACCOUNTS.file,save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,
                {expectedRevision:prepared.expectedRevision,eventId:prepared.eventId,payload:prepared.payload},a=>rename.applyAccount(a,prepared))},
              {name:'bag',path:path.resolve(BAG_LIVE),save:()=>{rename.applySlots(BAG.slotMap,prepared);saveBagLive(BAG.slotMap,true);}},
            ])){attempted=false;throw Error('Rename storage unavailable');}
            committed=true;
          }catch(error){restoreEconomy(before);throw error;}
        }
        await NAME_BROKER.release(reservation.token,{committed:!prepared.repeated,eventId:prepared.eventId,
          receiptSha256:prepared.receiptSHA256,name:parsed.name});
        reservation=null;
        if(!sock.destroyed){
          const currentRole=roleFrameNow('rename current role cache refresh');
          emitLive([...(prepared.repeated?[]:bagResyncFrames('rename card consumed',[prepared.slot])),
            rename.reply({ok:true,name:PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid).name}),...(currentRole?[currentRole]:[])],'rename card committed');
        }
      }catch(error){
        if(reservation&&!attempted){try{await NAME_BROKER.release(reservation.token,{committed:false});reservation=null;}catch{}}
        // An uncertain or committed-but-unacknowledged reservation stays held
        // until manager shutdown. Its name cannot be awarded to another worker.
        log(`${tag} rename ${committed?'saved; broker finalization pending':'rejected'}: ${error.message}`);
        if(!sock.destroyed)emitLive([rename.reply({ok:false,status:error.status||1002})],'rename failed');
      }finally{renamePending=false;}
    })();
  }

  function onData(decoded) {
    let previousMailList=false;
    incomingFrames: for (const fr of decoded) {
      if (fr.bad) { log(`${tag} <<< 解码失步 ${fr.bad.length}B ${hx(fr.bad, 32)}`); continue; }
      const f = fr.raw, msgid = f.readUInt16LE(8);
      // Native opening invokes both the title filter and visibility callbacks.
      // Coalesce only adjacent identical valid empty requests in this batch;
      // never delay a click, suppress a later request, or reorder a mutation.
      const emptyMailList=f.length===12&&msgid===20307&&f.readUInt32LE(4)===0&&f.readUInt16LE(10)===0;
      if(emptyMailList&&previousMailList)continue;
      previousMailList=emptyMailList;
      if(PLAYER_ACCOUNTS&&!accountOnline&&(ECONOMY_WRITE_MESSAGES.has(msgid)||ACCOUNT_RUNE_MESSAGES.has(msgid)||ACCOUNT_WAR_SOUL_MESSAGES.has(msgid)||ACCOUNT_PET_MESSAGES.has(msgid)||ACCOUNT_KV_MESSAGES.has(msgid)||ACCOUNT_MAIL_MESSAGES.has(msgid)||ACCOUNT_ONLINE_MESSAGES.has(msgid))){
        log(`${tag} rejected private account request before login`);continue;
      }
      if(PLAYER_ACCOUNTS&&(ACCOUNT_MAIL_MESSAGES.has(msgid)||ACCOUNT_ONLINE_MESSAGES.has(msgid))){
        if(economyFrozen()){log(`${tag} rejected mail/online request while storage is frozen`);continue;}
        try{ACCOUNT_MAIL_MESSAGES.has(msgid)?rewardMail.request(f):rewardMail.onlineRequest(f);}
        catch{log(`${tag} rejected invalid native mail/online header or fields msgid=${msgid}`);continue;}
      }
      if(PLAYER_ACCOUNTS&&ACCOUNT_PET_MESSAGES.has(msgid)){
        log(`${tag} rejected pet request without implemented ownership and refresh rules msgid=${msgid}`);continue;
      }
      if(PLAYER_ACCOUNTS&&ACCOUNT_KV_MESSAGES.has(msgid)){
        log(`${tag} rejected KV setting request without implemented full-table rules`);continue;
      }
      if(progressionProtocol.nativeWarSoulRequestError(msgid,f.subarray(12))){
        // Reject before occurrence/replay state, page hydration or writes.
        // An invalid record must not consume a real initialization trigger.
        log(`${tag} rejected invalid war-soul native request msgid=${msgid} bodyLength=${f.length-12}`);
        inventoryNotice('战魂请求格式无效，请重新打开页面。');continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===9018&&f.length!==20){log(`${tag} rejected malformed special item request`);inventoryNotice('场内表现请求格式无效。');continue;}
      syncBattleOwnership();
      if(PLAYER_ACCOUNTS&&(ACCOUNT_RUNE_MESSAGES.has(msgid)||ACCOUNT_WAR_SOUL_MESSAGES.has(msgid))&&economyFrozen()){
        inventoryNotice('配装存档待核对，暂不能读取或修改。');continue;
      }
      if (msgid === 11058) { startupComplete = true; setImmediate(pushOfflineNewMails); }
      if (!economyFrozen()) syncBattleEquipment();
      SOULS.reload();
      // Do not clear the local match gate merely because a login-shaped
      // 1012/1016 arrives.  During battle return the lobby request can race
      // the runtime's ownership-file write: clearing here while the marker is
      // still active would make the later `returned` transition look like no
      // transition at all, suppressing the authoritative 36273 war-soul
      // refresh.  The explicit inactive marker remains the safe fallback for
      // an initial/reconnected lobby session.
      if ((msgid === 1012 || msgid === 1016) && battleOwnership.read()?.active === false) inMatch = false;
      k++;
      const n = (occ.get(msgid) || 0) + 1; occ.set(msgid, n);
      LAST_REQ = { msgid, n, len: f.length - 12, payload: hx(f.subarray(12), 24) };   // 变更流水里标"谁引起的"
      if (BAG) BAG.lastReq = LAST_REQ;                                               // 会话侧兜底（异步路径也能拿到）
      log(`${tag} <<< �?{k}�?msgid=${msgid}(�?{n}�? len=${f.length}  ${hx(f.subarray(12), 40)}`);
      if(PLAYER_ACCOUNTS&&msgid===1086){
        const rb=S.byKey.get(`${msgid}#${n}`);if(rb)done.add(rb.key);
        handleRename(f);armSafety();continue;
      }
      if (msgid === 20002 && f.length > 20 && f[18] === 0x0a) {
        const ln = f[19];
        if (ln > 0 && ln <= 64 && 20 + ln <= f.length) account = f.subarray(20, 20 + ln).toString('ascii');
        if(PLAYER_ACCOUNTS&&(!ln||ln>64||20+ln>f.length||/[^\x21-\x7e]/.test(account)||findLoginAccount(account)?.uid!==PLAYER_SCOPE.uid)){
          log(`${tag} rejected login outside account economy scope`);sock.destroy();return;
        }
        if(process.env.DSH_PUBLIC_BETA==='1'){
          try{const world=require('./public-beta/login').worldId(f),localSeed=require('./public-beta/native-seed');if(localSeed.isPrivateOriginal||localSeed.isPublicSnapshot)localSeed.requireWorld(world);if(publicBetaWorldId!==null&&publicBetaWorldId!==world)throw Error('World switching requires a new login connection');publicBetaWorldId=world;}
          catch{log(`${tag} rejected unsupported local login world`);sock.destroy();return;}
        }
        const u = lookupUid(account);
        log(`${tag}     登录请求 账号="${account}"`
          + `（1287 里会把账号名和 UID 换成这个账号的：UID ${u === null ? '**表里没有 → 先用录制里的**（account-uid.json 可以补）' : '0x' + u.toString(16)}）`);
      }
      // 客户端自己把 UID 带上来了（`1012` 载荷 +5 = 帧 +17，真人会话 type=3 重连时最可信）：
      // 学下来，下次回 1287 就能用它，客户端才不会认为"这份角色列表不是我的"。
      if (msgid === 1012 && f.length >= 21) {
        const uid = f.readUInt32LE(17) >>> 0;
        if(PLAYER_ACCOUNTS){
          if(!account||findLoginAccount(account)?.uid!==PLAYER_SCOPE.uid||uid!==PLAYER_SCOPE.uid||f.readUInt32LE(13)!==PLAYER_SCOPE.playerId){
            log(`${tag} rejected mismatched persistent identity`);sock.destroy();return;
          }
          if(!accountOnline){PLAYER_ONLINE.connect(uid,sock);accountOnline=true;}
        }
        const t = f[12];
        if (uid && account) learnUid(account, uid, `客户端 1012（type=${t}）`);
        log(`${tag}     进入游戏请求 1012 type=${t} playerId=0x${f.readUInt32LE(13).toString(16)} uid=0x${uid.toString(16)}`);
      }
      if (economyFrozen() && ECONOMY_WRITE_MESSAGES.has(msgid)) {
        log(`${tag}     经济写入 ${msgid} 已冻结：邮件=${MAIL_STATE.pendingDiagnostics().map(x=>x.hex).join(',')} 装备=${EQUIPMENT_COMMIT.pending?.stage||'无'}`);
        if (msgid === 16811 && f.length >= 16) emitLive([mkShopReceipt(f.readUInt32LE(12),1)],'mail pending: shop denied');
        else inventoryNotice('经济存档待核对，背包与货币操作暂不可用。');
        armSafety(); continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===9018&&[2,5].includes(f.readUInt32LE(16))){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        try{
          if(!accountOnline||economyFrozen())throw Error('Cosmetic account unavailable');
          const c=require('./player-battle-cosmetics'),a=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),plan=c.importPlan(a),r=c.request(f),draft=JSON.parse(JSON.stringify(a));
          if(plan)c.importApply(draft,plan);c.apply(draft,r);
          if(!EQUIPMENT_COMMIT.run('cosmetic-selection',String(a.uid),[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(a.uid,{expectedRevision:a.revision},next=>{if(plan)c.importApply(next,plan);c.apply(next,r);})}]))throw Error('Cosmetic storage frozen');
          emitLive(c.initial(PLAYER_ACCOUNTS.get(a.uid)),'committed cosmetic selection');
        }catch(error){log(`${tag} cosmetic selection rejected: ${error.message}`);inventoryNotice('该外观未拥有、已过期，或存档暂不可用。');}
        armSafety();continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===9018&&f.readUInt32LE(16)===6){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        try{
          if(!accountOnline||economyFrozen()||!ACCOUNT_KILL_EFFECT_TEMPLATE)throw Error('Kill effect account or reply evidence unavailable');
          const effects=require('./player-kill-effect-state'),current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),requested=effects.request(f,PLAYER_SCOPE),now=Date.now();
          const draft=JSON.parse(JSON.stringify(current));effects.apply(draft,requested,now);effects.reply(draft,ACCOUNT_KILL_EFFECT_TEMPLATE);
          if(!EQUIPMENT_COMMIT.run('kill-effect-removal',String(PLAYER_SCOPE.uid),[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:current.revision},a=>effects.apply(a,requested,now))}]))throw Error('Kill effect storage frozen');
          emitLive([effects.reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),ACCOUNT_KILL_EFFECT_TEMPLATE)],'committed kill effect removal');
          setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_KILL_EFFECT_PUSH)if(refresh!==pushKillEffect)refresh();});
        }catch(error){log(`${tag} kill effect selection rejected: ${error.message}`);inventoryNotice(economyFrozen()?'场内表现存档待核对，已暂停操作。':'击杀特效仅支持卸下；非零选用的归属及期限尚待核对。');}
        armSafety();continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===9018&&f.readUInt32LE(16)===9){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        try{
          if(!ACCOUNT_FIGHT_DRESS_TEMPLATE)throw Error('Fight dress reply evidence unavailable');
          const dress=require('./player-fight-dress'),current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),requested=dress.request(f,{authenticated:accountOnline,frozen:economyFrozen(),uid:PLAYER_SCOPE.uid,playerId:PLAYER_SCOPE.playerId}),now=Date.now();
          const draft=JSON.parse(JSON.stringify(current));dress.apply(draft,requested,now);dress.reply(draft,ACCOUNT_FIGHT_DRESS_TEMPLATE);
          if(!EQUIPMENT_COMMIT.run('fight-dress-removal',String(PLAYER_SCOPE.uid),[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:current.revision},a=>dress.apply(a,requested,now))}]))throw Error('Fight dress storage frozen');
          emitLive([dress.reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),ACCOUNT_FIGHT_DRESS_TEMPLATE)],'committed fight dress removal');
          setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_FIGHT_DRESS_PUSH)if(refresh!==pushFightDress)refresh();});
        }catch(error){log(`${tag} fight dress selection rejected: ${error.message}`);inventoryNotice(economyFrozen()?'装扮存档待核对，已暂停操作。':'装扮选用暂不可用。');}
        armSafety();continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===27613){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        try{
          const frames=require('./player-avatar-frame'),requested=frames.request(f,{authenticated:accountOnline,frozen:economyFrozen(),uid:PLAYER_SCOPE.uid,playerId:PLAYER_SCOPE.playerId}),current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),now=Date.now();
          const draft=JSON.parse(JSON.stringify(current));frames.apply(draft,requested,now);frames.reply(draft,now);
          if(!EQUIPMENT_COMMIT.run('avatar-frame-selection',String(PLAYER_SCOPE.uid),[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:current.revision},a=>frames.apply(a,requested,now))}]))throw Error('Avatar frame storage frozen');
          emitLive([frames.reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),now)],'committed public avatar frame');
          setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_AVATAR_FRAME_PUSH)if(refresh!==pushAvatarFrame)refresh();});
        }catch(error){log(`${tag} avatar frame selection rejected: ${error.message}`);inventoryNotice(economyFrozen()?'头像框存档待核对，已暂停操作。':'当前支持选择默认头像框；活动框归属和期限尚待核对。');}
        armSafety();continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===27602){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        try{
          if(!accountOnline||economyFrozen())throw Error('Avatar account unavailable');
          const avatars=require('./player-avatar'),selection=avatars.request(f),current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),now=Date.now(),draft=JSON.parse(JSON.stringify(current));
          avatars.apply(draft,selection,ACCOUNT_AVATAR_POLICY,now);avatars.reply(draft,ACCOUNT_AVATAR_POLICY,now);
          if(!EQUIPMENT_COMMIT.run('avatar-selection',String(PLAYER_SCOPE.uid),[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:current.revision},a=>avatars.apply(a,selection,ACCOUNT_AVATAR_POLICY,now))}]))throw Error('Avatar storage frozen');
          // The direct acknowledgement must survive the lobby inMatch gate;
          // peers only refresh after the outer SQLite batch commits.
          emitLive([avatars.reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),ACCOUNT_AVATAR_POLICY,now)],'saved account avatar');
          setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_AVATAR_PUSH)refresh();});
        }catch(error){log(`${tag} avatar selection failed: ${error.message}`);inventoryNotice('头像设置未完成，请检查已确认的永久归属或存档状态。');}
        armSafety();continue;
      }
      if(PLAYER_SCOPE?.heroWire&&msgid===27616){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        try{
          if(!accountOnline||economyFrozen())throw Error('Hero skin account storage unavailable');
          playerHeroes.skinRequest(f);
          const now=Date.now(),current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),draft=JSON.parse(JSON.stringify(current));
          const hero=playerHeroes.selectSkin(draft,f.subarray(12),now);
          playerHeroes.incremental(draft,[hero],now);
          if(!EQUIPMENT_COMMIT.run('hero-skin-selection',`${PLAYER_SCOPE.uid}:${hero}`,[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:current.revision},a=>playerHeroes.selectSkin(a,f.subarray(12),now))}]))throw Error('经济存档待核对');
          emitLive([playerHeroes.incremental(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),[hero],now,{flags:0xd3,stream:PLAYERID})],'selected hero skin',{trackHeroIncremental:true});
        }catch(error){log(`${tag} hero skin selection failed: ${error.message}`);inventoryNotice('皮肤穿戴未完成：请检查英雄和皮肤归属，或联系管理员核对存档。');}
        armSafety();continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===1452&&f[13]===0){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        try{
          if(!accountOnline||economyFrozen())throw Error('Personal settings account unavailable');
          const settings=require('./player-personal-settings'),current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),now=Date.now();
          const request=settings.request(f,{authenticated:true,frozen:false,uid:PLAYER_SCOPE.uid,playerId:PLAYERID});
          const draft=JSON.parse(JSON.stringify(current));settings.apply(draft,request,now);settings.reply(draft);
          if(!EQUIPMENT_COMMIT.run('personal-settings',String(PLAYER_SCOPE.uid),[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:current.revision},a=>settings.apply(a,request,now))}]))throw Error('Personal settings storage frozen');
          const reply=settings.reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid));
          emitLive([reply],'saved account personal settings');personalSettingsSignature=reply.subarray(12).toString('hex');
          setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_PERSONAL_SETTINGS_PUSH)refresh();});
        }catch(error){log(`${tag} personal settings update failed: ${error.message}`);inventoryNotice('个人设置未保存，请检查请求或存档状态。');}
        armSafety();continue;
      }
      if(PLAYER_ACCOUNTS&&[14004,1452,1453].includes(msgid)){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        if(!accountOnline){inventoryNotice('请先完成账号登录。');continue;}
        try{
          const wire=require('./player-title-wire'),titles=require('./player-title-state'),settings=require('./player-title-settings'),now=Date.now();
          const current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
          if(msgid===1453){
            if(economyFrozen()){inventoryNotice('称号存档待核对，暂不能读取设置。');continue;}
            settings.query(f);const reply=require('./player-personal-settings').reply(current);
            if(reply)emitLive([reply],'queried account title effect preference');
            else inventoryNotice('称号特效设置尚无已验证记录。');
            continue;
          }
          const request=msgid===14004?wire.request(f):settings.request(f);
          const apply=msgid===14004?titles.apply:settings.apply;
          // Reject ownership, expiry and unsupported setting changes before
          // entering the durable transaction; invalid input must not freeze it.
          apply(JSON.parse(JSON.stringify(current)),request,now);
          if(msgid===1452){const draft=JSON.parse(JSON.stringify(current));apply(draft,request,now);require('./player-personal-settings').reply(draft);}
          if(!EQUIPMENT_COMMIT.run(msgid===14004?'title-selection':'title-effect-setting',String(PLAYER_SCOPE.uid),[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:current.revision},a=>apply(a,request,now))}]))throw Error('Title storage frozen');
          if(msgid===1452){const reply=require('./player-personal-settings').reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid));emitLive([reply],'saved account title effect preference');personalSettingsSignature=reply.subarray(12).toString('hex');}
          else pushTitle(true);
          // SQLite wraps the whole incoming batch. Other connections may only
          // see the selection after that outer commit has returned successfully.
          setImmediate(()=>{if(!economyFrozen()){
            for(const refresh of LIVE_TITLE_PUSH)refresh();
            for(const refresh of LIVE_PERSONAL_SETTINGS_PUSH)refresh();
          }});
        }catch(error){log(`${tag} title selection failed: ${error.message}`);inventoryNotice('称号设置未完成，请检查归属、有效期或存档状态。');}
        armSafety();continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===11888){
        let parsed;
        try{parsed=require('./player-medal-wire').decode(f);}
        catch(error){log('Medal request rejected: '+error.message);inventoryNotice('勋章请求格式无效。');continue;}
        if(parsed.medal){
          const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
          try{
            if(!accountOnline||economyFrozen())throw Error('Medal account unavailable');
            // Native medal constructors send a single branch. A mixed write
            // must not silently discard another economy operation.
            if(parsed.fields.length!==1)throw Error('Mixed medal request is not supported');
            const request=require('./player-medal-wire').request(f),medals=require('./player-medals'),current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),now=Date.now();
            if(request.unknownFields.length)throw Error('Unsupported medal request fields');
            if(request.operation===1){
              const reply=medals.reply(current,1,now);if(!reply)throw Error('No verified medal observation');
              emitLive([reply],'queried account medals');
            }else{
              const draft=JSON.parse(JSON.stringify(current));medals.apply(draft,request,now);
              medals.reply(draft,request.operation,now);
              if(!EQUIPMENT_COMMIT.run(request.operation===2?'medal-view':'medal-equip',String(PLAYER_SCOPE.uid),[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,
                save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:current.revision},account=>medals.apply(account,request,now))}]))throw Error('Medal storage frozen');
              const saved=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
              // A committed native operation always needs its full-info ACK,
              // including before roleReady and while this connection is in a
              // match. The lobby-only timer must not suppress that ACK.
              emitLive([medals.reply(saved,request.operation,now)],'committed account medal operation');
              medalSignature=medals.reply(saved,1,now).subarray(12).toString('hex');
              setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_MEDAL_PUSH)refresh();});
            }
          }catch(error){log(`${tag} medal request failed: ${error.message}`);inventoryNotice('勋章设置未完成，请检查归属、有效期或存档状态。');}
          armSafety();continue;
        }
      }
      if(PLAYER_ACCOUNTS&&[11532,11543,11545,11547].includes(msgid)){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        if(!accountOnline){inventoryNotice('请先完成账号登录。');continue;}
        let request;
        try{request=rewardMail.onlineRequest(f);}
        catch(error){inventoryNotice('在线奖励请求无效。');continue;}
        const now=Date.now(),uid=PLAYER_SCOPE.uid;
        try{
          if(!economyFrozen())PLAYER_ONLINE.tick(uid,now);
          if(request.operation==='time'){emitLive([onlineWire.serverTime(now)],'current server time');continue;}
          if(request.operation==='event'){emitLive([onlineWire.event()],'current online reward event');continue;}
          if(request.operation==='status'){emitLive([onlineWire.status(PLAYER_ACCOUNTS.get(uid),now)],'account online status');continue;}
          if(request.tier>5)throw Error('Online reward tier is not enabled in this development release');
          const occupied=[...new Set([...Object.keys(MAIL||{}).map(Number),...EXTRA_MAILS.keys(),
            ...MAIL_STATE.claimed,...MAIL_STATE.read,...MAIL_STATE.notified,...MAIL_STATE.pending])];
          const context=mailContext();
          const prepared=rewardMail.prepareOnline(PLAYER_ACCOUNTS.get(uid),request.tier,{...context,now,occupiedIds:occupied});
          const steps=[{name:'player-accounts',path:PLAYER_ACCOUNTS.file,save:()=>PLAYER_ACCOUNTS.update(uid,
            {expectedRevision:prepared.expectedRevision,eventId:prepared.eventId,payload:prepared.payload},
            a=>rewardMail.applyOnline(a,prepared,{...context,now:Date.now()}))}];
          if(!EQUIPMENT_COMMIT.run('online-reward-mail',prepared.eventId,steps))throw Error('Economy frozen');
          const saved=PLAYER_ACCOUNTS.get(uid);
          const committed=Object.values(saved.rewardMailState.mails).find(mail=>mail.eventId===prepared.eventId);
          if(!committed)throw Error('Committed reward mail is unavailable');
          const emitted=emitLive([onlineWire.result(request.tier,true,saved,now)],'online reward mail committed');
          if(!economyFrozen()&&emitted.some(frame=>frame.readUInt16LE(8)===11546)){
            inventoryNotice('奖励已发送至邮箱，请手动打开邮箱领取。');
            notifiedMailIds.add(committed.mailId);
          }
          setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_OWNED_MAIL_PUSH)refresh();});
        }catch(error){
          log(`${tag} online request failed: ${error.message}`);
          if(request.operation==='claim')emitLive([onlineWire.result(request.tier,false,PLAYER_ACCOUNTS.get(uid),now)],'online reward rejected');
          inventoryNotice(economyFrozen()?'奖励存档待核对，已暂停领取。':'奖励邮件未发送：请检查在线时长和领取状态。');
        }
        continue;
      }
      // Progression systems are stateful even when the client response is
      // supplied by the recorded session below.  Applying the request here
      // keeps the live server's next battle/loadout in sync with the native UI
      // without inventing an incompatible protobuf payload.
      const progressionPayload=f.subarray(12);
      const storage=require('./native-storage');
      if(storage.matches(msgid,progressionPayload)){
        const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
        let request,prepared,store;
        const record=(item,slot)=>{const r=require('./roledata').itemRecord(WALLET.blob,slot,item);patchEnhancementLevel(r,item);gemCrafting.patchRecord(r,item);return r;};
        try{
          request=storage.parse(msgid,progressionPayload);store=PROGRESSION[request.system];
          prepared=storage.prepare({request,state:store.state,bag:BAG.slotMap,bagCapacity:BAG_VISIBLE_CAPACITY,
            reserved:equippedBagSlots(),equipped:new Set([...EQUIP_PLANS.values()].map(v=>Buffer.isBuffer(v.guid)?v.guid.toString('hex'):v.guid)),
            locked:id=>!!PROGRESSION.itemLock.get(id)?.locked,stackable:canStackItem,diamonds:WALLET?.attrs?.[72]||0,record});
        }catch(error){
          log(`${tag} storage rejected: ${error.message}`);
          inventoryNotice({'storage-equipped':'请先将该装备从三套配装全部卸下，再存入。','storage-locked':'已锁定或正在解锁的物品不能存入。',
            'storage-stackable':'次元行囊只能存放不可堆叠的装备。','storage-not-storable':'该物品不能存入仓库。',
            'storage-full':'目标容器空间不足，请先腾出足够空位。','storage-diamonds':'钻石不足，扩容未完成。',
            'storage-max-capacity':'容量已达到上限。'}[error.message]||'存取请求无效，物品未移动。');continue;
        }
        if(request.operation!=='list'){
          const before=economySnapshot(),old=store.state;
          try{
            store.state=prepared.state;BAG.slotMap=prepared.bag;
            const steps=[{name:request.system,path:store.file,save:()=>store.save()}];
            if(prepared.changedSlots.length)steps.push({name:'storage-bag',path:BAG_LIVE,save:()=>saveBagLive(BAG.slotMap,true)});
            if(prepared.cost){WALLET.attrs[72]-=prepared.cost;steps.push({name:'storage-wallet',path:process.env.DSH_GOLD_STATE||path.join(__dirname,'gold-state.json'),save:()=>WALLET.save(true)});}
            if(!EQUIPMENT_COMMIT.run(request.system+'-'+request.operation,'',steps))throw Error('commit frozen');
          }catch(error){store.state=old;restoreEconomy(before);log(`${tag} storage commit failed: ${error.message}`);inventoryNotice('存取存档待核对，已暂停后续操作。');continue;}
        }
        // Deposit ack must run while the native bag still contains the GUID.
        // c21f00 copies that cache record before removing it from the bag.
        const frames=[];
        if(request.operation!=='list'){const ack=storage.acknowledgement(msgid,progressionPayload,prepared);if(ack)frames.push(ack);}
        frames.push(...bagResyncFrames('storage inventory',prepared.changedSlots),storage.listFrame(request.system,store.state,record));
        if(prepared.cost)frames.push(mkAttrFrame(72,WALLET.attrs[72]));
        emitLive(frames,'native storage '+request.operation);armSafety();continue;
      }
      let progressionRequest=progressionProtocol.parse(msgid,progressionPayload) ||
        (msgid===11888 ? progressionProtocol.parseMagicGemProtobuf(progressionPayload) : null);
      if(msgid===17002&&progressionPayload.length===9&&progressionPayload[0]===0){
        const slot=progressionPayload.readUInt16LE(1),held=BAG?.slotMap?.get(slot);
        if(held&&held.itemId>=46810&&held.itemId<=46814)progressionRequest={system:'magicGem',operation:'openRaw',slot};
      }
      if(progressionRequest){
        if(msgid===13620){
          const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
          if(progressionPayload.length===4){
            const payload=Buffer.alloc(20);
            for(let i=0;i<4;i++)payload.writeUInt32LE(PROGRESSION.crafting.state.pity?.[7901+i]||0,4+i*4);
            emitLive([bagMod.mkFrame(13621,payload,{flags:2})],'forge account pity');
          }
          continue;
        }
        if([13610,13612,13614,13616,13618].includes(msgid)){
          const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
          if(economyFrozen()){inventoryNotice('存档待核对，暂不能锻造。');continue;}
          const forge=require('./equipment-forging'),inventory=require('./crafting-inventory');
          const guid=progressionPayload.subarray(0,8).toString('hex');
          let instance;try{instance=EQUIPMENT_ADAPTER.findInstance(guid);}catch{}
          if(instance)instance={...instance,locked:!!(PROGRESSION.itemLock.get(guid)?.locked||BAG.slotMap.get(instance.slot)?.locked),pendingReforge:!!EQUIPMENT_ADAPTER.reforge.get(guid)};
          const prepared=forge.prepare(PROGRESSION.crafting.state,msgid,progressionPayload,instance,{plans:EQUIP_PLANS});
          if(!prepared.ok){log(`${tag} forge rejected: ${prepared.reason}`);inventoryNotice({
            'forge-equipment-locked':'请先解除这件装备的物品锁定，再进行锻造。',
            'forge-material-not-selected':'请先选择锻造火，再进行锻造。',
            'wash-material-not-selected':'请先选择锻造结晶，再进行洗练。',
            'forge-wish-is-locked':'保底属性与已锁定的词条相同，请更换保底属性或解除该词条的锁定。',
            'forge-equipment-must-be-unequipped':'请先将这件装备从三套装备栏全部卸下，再锻造或启用锻造属性。',
            'one-forged-equipment-per-plan':'每套配装只能装备一件锻造装备，请先卸下另一件。',
          }[prepared.reason]||'锻造未完成：请检查材料、装备锁定及候选属性。');continue;}
          const paid=inventory.debit({bag:BAG.slotMap,materials:BAG.itemMap,resources:RES,wallet:WALLET?.attrs||{}},prepared.costs);
          if(!paid.ok){inventoryNotice('锻造材料不足，本次未改动装备。');continue;}
          const before=economySnapshot(),old=PROGRESSION.crafting.state;
          try{
            PROGRESSION.crafting.state=prepared.state;BAG.slotMap=paid.bag;BAG.itemMap=paid.materials;Object.assign(RES,paid.resources);
            const steps=[{name:'forge-state',path:PROGRESSION.crafting.file,save:()=>PROGRESSION.crafting.save()}];
            if(paid.changedSlots.length)steps.push({name:'forge-bag',path:BAG_LIVE,save:()=>saveBagLive(BAG.slotMap,true)});
            if(paid.changedMaterials.length)steps.push({name:'forge-material',path:MATERIAL_LIVE,save:()=>saveMaterialLive(BAG.itemMap,true)});
            if(paid.changedResources.length)steps.push({name:'forge-resource',path:RESOURCE_FILE,save:saveResources});
            if(!EQUIPMENT_COMMIT.run('equipment-forge',guid,steps))throw Error('commit frozen');
          }catch(error){restoreEconomy(before);PROGRESSION.crafting.state=old;log(`${tag} forge commit failed: ${error.message}`);inventoryNotice('锻造存档待核对，已暂停后续操作。');continue;}
          const frames=bagResyncFrames('forge inventory',[instance.slot,...paid.changedSlots]);
          for(const id of paid.changedMaterials)frames.push(bagMod.buildBagDelta(id,BAG.itemMap.get(id)||0));
          for(const id of paid.changedResources)frames.push(resourceBalanceFrame(id,RES[id]||0,0x0d));
          const pity=Buffer.alloc(20);for(let i=0;i<4;i++)pity.writeUInt32LE(prepared.state.pity[7901+i]||0,4+i*4);
          frames.push(...equipmentSnapshotFrames(),forge.acknowledgement(msgid,progressionPayload),bagMod.mkFrame(13621,pity,{flags:2}));
          emitLive(frames,'forge committed');if(roleReadyAt&&!inMatch)emitLive(equipmentAttributeFrames(true),'forge attributes');
          log(`${tag} forge committed msg=${msgid} guid=${guid} costs=${JSON.stringify(prepared.costs)}`);continue;
        }
        if(msgid===13578||msgid===13622){
          const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
          if(progressionPayload.length!==24||economyFrozen()){inventoryNotice('继承请求或存档状态异常，本次未消耗物品。');continue;}
          const inherit=require('./equipment-inheritance'),inventory=require('./crafting-inventory');
          const instance=guid=>{
            const value=EQUIPMENT_ADAPTER.findInstance(guid);if(!value)return null;
            const held=BAG.slotMap.get(value.slot),lock=PROGRESSION.itemLock.get(guid);
            const hasGems=[...EQUIP_PLANS].some(([pos,e])=>e.guid?.toString('hex')===guid&&
              GEM_BOARD.state.plans[Math.floor(pos/6)]?.[pos%6]?.some(g=>g&&g.id));
            const forge=PROGRESSION.crafting.getApplied(guid);
            return {...value,locked:!!(lock?.locked||held.locked),hasGems,
              pending:!!(PROGRESSION.crafting.state.forge[guid]?.pending||require('./equipment-forging').pending(PROGRESSION.crafting.state,guid)),
              forge:Array.isArray(forge)?forge:forge?[forge]:null,soul:SOULS.get(guid,value.itemId)};
          };
          let source,target,prepared;
          try{
            source=instance(progressionRequest.sourceGuid);target=instance(progressionRequest.targetGuid);
            prepared=inherit.prepare({source,target,mask:progressionRequest.mask,inheritType:progressionRequest.inheritType,
              materials:inventory.balances(BAG.slotMap,BAG.itemMap,RES)});
            if(prepared.ok&&!require('./equipment-forging').validPlans(PROGRESSION.crafting.state,EQUIP_PLANS,
              {[source.guid]:prepared.source.forge,[target.guid]:prepared.target.forge}))throw Error('one-forged-equipment-per-plan');
          }catch(error){prepared={ok:false,reason:error.message};}
          if(!prepared.ok){log(`${tag} inheritance rejected: ${prepared.reason}`);inventoryNotice('继承未完成：请检查材料、等级、锁定、宝石、待启用属性及每套锻造数量。装备战魂刻录继承暂未接入。');continue;}
          if(msgid===13622){
            const rd=require('./roledata'),v=prepared.target,held=BAG.slotMap.get(target.slot);
            const record=rd.itemRecord(WALLET.blob,target.slot,held);patchEnhancementLevel(record,held);
            record[73]=v.level;record[74]=v.level;Buffer.from(v.baselineHex,'hex').copy(record,76);
            soulRules.patchRecord(record,held,v.soul);
            require('./equipment-forging').patchRecord(record,{...PROGRESSION.crafting.state,
              applied:{...PROGRESSION.crafting.state.applied,[target.guid]:v.forge},nativeForge:{}},target.guid);
            const payload=Buffer.alloc(493);payload[0]=0;payload.writeUInt16LE(target.slot,1);record.copy(payload,3,0,490);
            emitLive([bagMod.mkFrame(13623,payload,{flags:2})],'inheritance preview');continue;
          }
          const paid=inventory.debit({bag:BAG.slotMap,materials:BAG.itemMap,resources:RES,wallet:WALLET?.attrs||{}},prepared.costs);
          if(!paid.ok){inventoryNotice('继承材料不足，本次未消耗物品。');continue;}
          const before=economySnapshot(),adapter=EQUIPMENT_ADAPTER,
            oldEnhancement=structuredClone(adapter.enhancement.instances),oldApplied=structuredClone(adapter.reforge.applied),oldPending=structuredClone(adapter.reforge.pending),
            oldCrafting=structuredClone(PROGRESSION.crafting.state),oldSoul=structuredClone(SOULS.state);
          try{
            BAG.slotMap=paid.bag;BAG.itemMap=paid.materials;Object.assign(RES,paid.resources);
            const steps=[];
            steps.push({name:'inherit-enhancement',path:adapter.enhancement.file,save:()=>{
              for(const v of [prepared.source,prepared.target])adapter.enhancement.set(v.guid,v.itemId,v.level,v.blessing);
            }});
            if(prepared.mask&1)steps.push({name:'inherit-blessing',path:adapter.reforge.file,save:()=>{
              // Transfer only applied attributes. Discard stale previews on
              // both changed baselines atomically, so they cannot be reapplied.
              for(const v of [prepared.source,prepared.target])adapter.reforge.replace(v.guid,null);
              for(const v of [prepared.source,prepared.target])adapter.reforge.setApplied(v.guid,{itemId:v.itemId,
                candidateHex:v.baselineHex,baselineHash:require('crypto').createHash('sha256').update(v.baselineHex).digest('hex')});
            }});
            if(prepared.mask&2)steps.push({name:'inherit-forge',path:PROGRESSION.crafting.file,save:()=>{
              for(const v of [prepared.source,prepared.target]){delete PROGRESSION.crafting.state.nativeForge?.[v.guid];PROGRESSION.crafting.setApplied(v.guid,v.forge);}
            }});
            if(prepared.mask&8)steps.push({name:'inherit-soul',path:SOULS.file,save:()=>{
              const next=structuredClone(SOULS.state);
              for(const v of [prepared.source,prepared.target])next.instances[v.guid]=v.soul;
              SOULS.save(next);SOULS.state=next;
            }});
            if(paid.changedSlots.length)steps.push({name:'inherit-bag',path:BAG_LIVE,save:()=>saveBagLive(BAG.slotMap,true)});
            if(paid.changedMaterials.length)steps.push({name:'inherit-material',path:MATERIAL_LIVE,save:()=>saveMaterialLive(BAG.itemMap,true)});
            if(paid.changedResources.length)steps.push({name:'inherit-resource',path:RESOURCE_FILE,save:saveResources});
            if(!EQUIPMENT_COMMIT.run('equipment-inheritance',source.guid,steps))throw Error('commit frozen');
          }catch(error){
            restoreEconomy(before);adapter.enhancement.instances=oldEnhancement;adapter.reforge.applied=oldApplied;adapter.reforge.pending=oldPending;
            PROGRESSION.crafting.state=oldCrafting;SOULS.state=oldSoul;
            log(`${tag} inheritance commit failed: ${error.message}`);inventoryNotice('继承存档待核对，已暂停后续操作。');continue;
          }
          for(const v of [prepared.source,prepared.target])for(const held of [...BAG.slotMap.values(),...EQUIP_PLANS.values(),...EQUIP.values()]){
            const guid=Buffer.isBuffer(held.guid)?held.guid.toString('hex'):held.guid;
            if(guid===v.guid){held.forge=v.forge;held.enhancementLevel=v.level;held.reforgeHex=v.baselineHex;}
          }
          const frames=bagResyncFrames('inheritance inventory',[source.slot,target.slot,...paid.changedSlots]);
          for(const id of paid.changedMaterials)frames.push(bagMod.buildBagDelta(id,BAG.itemMap.get(id)||0));
          for(const id of paid.changedResources)frames.push(resourceBalanceFrame(id,RES[id]||0,0x0d));
          frames.push(...equipmentSnapshotFrames(),inherit.ack(0,source.guid,target.guid,prepared.inheritType));
          emitLive(frames,'inheritance committed');if(roleReadyAt&&!inMatch)emitLive(equipmentAttributeFrames(true),'inheritance attributes');
          log(`${tag} inheritance committed mask=${prepared.mask} source=${source.guid} target=${target.guid}`);continue;
        }
        if(PLAYER_ACCOUNTS&&[36267,36269,36271,36274].includes(msgid)){
          const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
          const prepared=warSoulTransaction.prepare(PROGRESSION.warSoul,progressionRequest);
          if(!prepared.ok){log(`${tag} native war-soul rejected: ${prepared.reason}`);inventoryNotice('战魂操作未完成，请检查方案、章节条件、材料和存档状态。');continue;}
          const old=PROGRESSION.warSoul.state;let replies=[];
          try{
            // Validate the exact native success envelope before any write.
            if(msgid===36267)replies=warSoulWire.levelUpReplies(progressionRequest,prepared.result,PLAYERID);
            if(!EQUIPMENT_COMMIT.run('native-war-soul-'+progressionRequest.operation,String(PLAYER_SCOPE.uid),[
              {name:'war-soul',path:PROGRESSION.warSoul.file,save:()=>{PROGRESSION.warSoul.state=prepared.state;PROGRESSION.warSoul.save();}}
            ]))throw Error('war-soul-storage-frozen');
          }catch(error){PROGRESSION.warSoul.state=old;log(`${tag} native war-soul commit failed: ${error.message}`);inventoryNotice('战魂存档待核对，已暂停后续操作。');continue;}
          if(msgid===36269||msgid===36274){const ack=capturedProgressionAck(msgid,prepared.result);if(ack)replies.push(ack);}
          // 36272's body is not consumed by the native dispatcher; its status
          // semantics are still unknown. The verified full snapshot follows
          // a reset. Do not manufacture a small reset success packet.
          // This is the operation's own account snapshot. Its native consumer
          // clears/rebuilds cached war-soul data without opening the panel;
          // a reset also needs a reply while the lobby owns an active battle.
          const refresh=liveWarSoulRefresh();if(refresh)replies.push(refresh);
          emitLive(replies,'native war-soul committed');
          if(roleReadyAt&&!inMatch)emitLive(equipmentAttributeFrames(true),'native war-soul committed attributes');
          setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_WAR_SOUL_PUSH)if(refresh!==pushWarSoul)refresh();});
          log(`${tag} native war-soul ${progressionRequest.operation} committed`);continue;
        }
        if([36295,36297,36298,36299,36300,36301,36302,36303].includes(msgid)){
          const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
          if(economyFrozen()){inventoryNotice('存档待核对，暂不能操作战魂词条。');continue;}
          const prepared=warSoulEntry.prepareNative(PROGRESSION.warSoul.state.entryPanel,msgid,progressionPayload,
            {bag:BAG.slotMap,materials:BAG.itemMap,resources:RES,wallet:WALLET?.attrs||{}});
          if(!prepared.ok){
            log(`${tag} war-soul-entry rejected: ${prepared.reason}`);
            inventoryNotice([36302,36303].includes(msgid)?'刻录/转化规则仍在核对，本次未消耗物品。':'战魂词条操作未完成：材料、锁定或方案状态不满足条件。');
            emitLive([liveWarSoulEntryRefresh()],'war-soul-entry rejected refresh');continue;
          }
          const before=economySnapshot(),oldWarSoul=PROGRESSION.warSoul.state;
          if(!prepared.readOnly){
            PROGRESSION.warSoul.state={...oldWarSoul,entryPanel:prepared.state};
            BAG.slotMap=prepared.bag;BAG.itemMap=prepared.materials;
            Object.assign(RES,prepared.resources);
            if(WALLET){WALLET.attrs=prepared.wallet;WALLET.gold=WALLET.attrs[50];}
            try{
              const steps=[{name:'war-soul-entry',path:PROGRESSION.warSoul.file,save:()=>PROGRESSION.warSoul.save()}];
              if(prepared.changedSlots.length)steps.push({name:'entry-bag',path:BAG_LIVE,save:()=>saveBagLive(BAG.slotMap,true)});
              if(prepared.changedMaterials.length)steps.push({name:'entry-material',path:MATERIAL_LIVE,save:()=>saveMaterialLive(BAG.itemMap,true)});
              if(prepared.changedResources.length)steps.push({name:'entry-resource',path:RESOURCE_FILE,save:saveResources});
              if(Object.keys(prepared.walletCosts).length)steps.push({name:'entry-wallet',path:process.env.DSH_GOLD_STATE||path.join(__dirname,'gold-state.json'),save:()=>WALLET.save(true)});
              if(!EQUIPMENT_COMMIT.run('war-soul-entry-'+prepared.request.operation,'',steps))throw Error('commit frozen');
            }catch(error){PROGRESSION.warSoul.state=oldWarSoul;restoreEconomy(before);log(`${tag} war-soul-entry commit failed: ${error.message}`);inventoryNotice('战魂词条存档待核对，已暂停后续操作。');continue;}
          }
          const frames=bagResyncFrames('war-soul-entry inventory',prepared.changedSlots);
          for(const id of prepared.changedMaterials)frames.push(bagMod.buildBagDelta(id,BAG.itemMap.get(id)||0));
          for(const id of prepared.changedResources)frames.push(resourceBalanceFrame(id,RES[id]||0,0x0d));
          if(before.walletAttrs?.[72]!==WALLET?.attrs?.[72])frames.push(mkAttrFrame(72,WALLET.attrs[72]));
          frames.push(liveWarSoulEntryRefresh());emitLive(frames,'war-soul-entry committed');
          if(roleReadyAt&&!inMatch)emitLive(equipmentAttributeFrames(true),'war-soul-entry attributes');
          log(`${tag} war-soul-entry ${prepared.request.operation} committed`);continue;
        }
        if(progressionRequest.system==='magicGem'){
          const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
          if(PLAYER_ACCOUNTS&&msgid===11888&&!require('./magic-feature-snapshot').validRequest(f)){
            log(`${tag} rejected invalid native magic protobuf header or fields length=${f.length} declaredLength=${f.readUInt32LE()} flags=${f.readUInt16LE(10)} opaqueHeader4=${f.readUInt32LE(4)}`);continue;
          }
          if(economyFrozen()){inventoryNotice('存档待核对，暂不能操作魔导器。');continue;}
          if(progressionRequest.operation==='setGraph')log(`${tag} magic-device setGraph request deviceGuid=${progressionRequest.deviceGuid||'missing'} circuitId=${progressionRequest.circuitId??'missing'} flags=${f.readUInt16LE(10)} opaqueHeader4=${f.readUInt32LE(4)}`);
          if(!magicCapturedGems)magicCapturedGems=magicDeviceLive.captureGemIndex([
            path.join(__dirname,'logs/cap-2026-10-05T08-23-25/events.jsonl'),
            path.join(__dirname,'logs/cap-2026-10-07T07-59-09/events.jsonl')]);
          const prepared=magicDeviceLive.prepare({state:PROGRESSION.magicGem,request:progressionRequest,
            tag:msgid,payload:progressionPayload,bag:BAG.slotMap,materials:BAG.itemMap,
            resources:RES,wallet:WALLET?.attrs||{},capacity:BAG_VISIBLE_CAPACITY,
            captured:magicCapturedGems,containerOf,stackMax:STACK_MAX,canStackItem});
          if(!prepared.ok){
            log(`${tag} magic-device ${progressionRequest.operation} rejected: ${prepared.reason}`);
            inventoryNotice('魔导器操作未完成：材料、空位或物品状态不满足条件。');continue;
          }
          const before=economySnapshot(),oldMagic=PROGRESSION.magicGem.state;
          const readOnly=progressionRequest.operation==='getGraphs';
          if(!readOnly){
            PROGRESSION.magicGem.state=prepared.state;BAG.slotMap=prepared.bag;BAG.itemMap=prepared.materials;
            for(const id of Object.keys(RES))delete RES[id];Object.assign(RES,prepared.resources);
            WALLET.attrs=prepared.wallet;WALLET.gold=WALLET.attrs[50];
            try{
              const steps=[{name:'magic-device',path:PROGRESSION.magicGem.file,save:()=>PROGRESSION.magicGem.save()}];
              if(prepared.changedSlots.length)steps.push({name:'magic-bag',path:BAG_LIVE,save:()=>saveBagLive(BAG.slotMap,true)});
              if(prepared.changedMaterials.length)steps.push({name:'magic-material',path:MATERIAL_LIVE,save:()=>saveMaterialLive(BAG.itemMap,true)});
              if(prepared.changedResources.length)steps.push({name:'magic-resource',path:RESOURCE_FILE,save:saveResources});
              if(prepared.result.walletCosts)steps.push({name:'magic-wallet',path:process.env.DSH_GOLD_STATE||path.join(__dirname,'gold-state.json'),save:()=>WALLET.save()});
              if(!EQUIPMENT_COMMIT.run('magic-'+progressionRequest.operation,progressionRequest.deviceGuid||progressionRequest.gemId||'',steps))throw Error('commit frozen');
            }catch(error){PROGRESSION.magicGem.state=oldMagic;restoreEconomy(before);log(`${tag} magic-device commit failed: ${error.message}`);inventoryNotice('魔导器存档待核对，已暂停后续操作。');continue;}
          }
          const frames=[...bagResyncFrames('magic-device inventory',prepared.changedSlots),...magicDeviceLive.inventoryFrames(oldMagic,prepared.state)];
          for(const id of prepared.changedMaterials)frames.push(bagMod.buildBagDelta(id,BAG.itemMap.get(id)||0));
          for(const id of prepared.changedResources)frames.push(resourceBalanceFrame(id,RES[id]||0,0x0d));
          // The model must contain the new instance before the dialog processes its success callback.
          frames.push(bagMod.mkFrame(13590,progressionProtocol.magicGemNotifyPayload(PROGRESSION.magicGem),{flags:0xc9,stream:PLAYERID}));
          frames.push(...magicDeviceLive.incrementalFrames(PROGRESSION.magicGem.state));
          if(msgid===11888)frames.push(bagMod.mkFrame(11888,progressionProtocol.magicGemResponsePayload(PROGRESSION.magicGem,progressionRequest,prepared.result),{flags:0xca,stream:PLAYERID}));
          if(progressionRequest.operation==='openRaw'){
            const p=Buffer.alloc(13);p.writeUInt16LE(prepared.result.rawItemId,1);p.writeUInt16LE(prepared.result.rawSlot,3);p.fill(255,5,9);
            frames.push(bagMod.mkFrame(17019,p,{flags:0x0d}));
          }
          const ack=magicDeviceLive.ack(msgid,progressionRequest,prepared.result);if(ack)frames.push(ack);
          if(prepared.result.walletCosts)for(const id of [50,72])if(before.walletAttrs[id]!==WALLET.attrs[id])frames.push(mkAttrFrame(id,WALLET.attrs[id]));
          emitLive(frames,'magic-device committed');
          if(roleReadyAt&&!inMatch)emitLive(equipmentAttributeFrames(true),'magic-device attributes');
          log(`${tag} magic-device ${progressionRequest.operation} committed`);continue;
        }

        if (progressionRequest.system === 'itemLock') {
          const replayBatch = S.byKey.get(`${msgid}#${n}`); if (replayBatch) done.add(replayBatch.key);
          const all = [...(BAG?.slotMap?.values?.() || []), ...(EQUIP?.values?.() || [])];
          const item = all.find(value => String(value?.guid || '').toLowerCase() === progressionRequest.guid);
          // The Lua panel routes both equipment and ordinary gems through
          // XBagEquipLock. Gems are catalog-level locks: one 2-level mana
          // gem protects every identical 2-level mana gem, while armour and
          // magical devices remain individual GUID instances.
          const targets = item && ITEM_NAMES?.[item.itemId]?.type === 'gem'
            ? all.filter(value => Number(value?.itemId) === Number(item.itemId))
            : item ? [item] : [];
          const results = targets.map(value => progressionRequest.operation === 'lock'
            ? PROGRESSION.itemLock.lock(value.guid, true)
            : PROGRESSION.itemLock.requestUnlock(value.guid, wireClockNowMs()));
          const result = results[0] || (progressionRequest.operation === 'lock'
            ? PROGRESSION.itemLock.lock(progressionRequest.guid, true)
            : PROGRESSION.itemLock.requestUnlock(progressionRequest.guid, wireClockNowMs()));
          if (result.ok) for (const target of targets) { target.locked = result.locked; target.unlockAt = result.unlockAt || 0; }
          if (result.ok && targets.length) { try { saveBagLive(BAG?.slotMap, true); saveEquipState(true); } catch (error) { log(`${tag} item lock persist failed: ${error.message}`); } }
          const ackTag = progressionRequest.operation === 'lock' ? 1457 : 1459, captured = CAPTURED_NATIVE_ACK.get(ackTag);
          if (captured && result.ok) {
            const frame = Buffer.from(captured), source = CAPTURE_REQUEST_PAYLOAD.get(progressionRequest.operation === 'lock' ? 1456 : 1458) || Buffer.alloc(0);
            const old = source.subarray(progressionRequest.operation === 'lock' ? 1 : 2, progressionRequest.operation === 'lock' ? 9 : 10);
            const next = Buffer.from(progressionRequest.guid, 'hex');
            for (let offset = 12; offset + 8 <= frame.length; offset++) if (frame.subarray(offset, offset + 8).equals(old)) next.copy(frame, offset);
            const payload = frame.subarray(12);
            emitLive([frame], `item ${progressionRequest.operation} ack`);
          } else if (!result.ok) log(`${tag} item lock rejected: ${result.reason}`);
          armSafety(); continue;
        }
        if(PLAYER_ACCOUNTS&&msgid===11783){
          const choice=require('./player-rune-choice'),payload=f.subarray(12);
          // The verified token has two native layouts. It must not fall back
          // to the legacy permissive planner when any of its selectors fail.
          const recognized=payload.length>=4&&(payload.readUInt32LE(0)===choice.TOKEN_ID||
            payload.length>=8&&payload.readUInt32LE(4)===choice.TOKEN_ID);
          if(recognized){
            const rb=S.byKey.get(`${msgid}#${n}`);if(rb)done.add(rb.key);
            try{
              if(inMatch)throw Error('Rune exchange requires lobby');
              const request=choice.parseNative(payload);if(!request)throw Error('Invalid rune choice native layout');
              const owner=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),oldRune=PROGRESSION.rune.state,oldBag=BAG.slotMap;
              const prepared=choice.prepare(oldRune,request,{bag:oldBag,owner,locks:PROGRESSION.itemLock});
              if(!prepared.ok)throw Error(prepared.reason);
              if(!prepared.readOnly){
                choice.assertCurrent(prepared,oldRune,{bag:oldBag,owner:PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid)});
                try{
                  if(!EQUIPMENT_COMMIT.run('rune-choice-v5',prepared.guid,[
                    {name:'rune',path:path.resolve(PROGRESSION.rune.file),save:()=>{PROGRESSION.rune.state=prepared.state;PROGRESSION.rune.save();}},
                    {name:'bag',path:path.resolve(BAG_LIVE),save:()=>{BAG.slotMap=prepared.bag;saveBagLive(BAG.slotMap,true);}},
                  ]))throw Error('Rune exchange storage unavailable');
                }catch(error){PROGRESSION.rune.state=oldRune;BAG.slotMap=oldBag;throw error;}
                const list=liveRuneListAck(),ack=liveRuneSeniorExchangeAck(prepared.result);
                emitLive([...bagResyncFrames('rune choice token consumed',prepared.changedSlots),list,ack].filter(Boolean),'rune choice v5 committed');
              }
              // Modes 0/2 select/preview locally; they neither publish a rune
              // nor reuse the success popup acknowledgement.
            }catch(error){log(`${tag} rune choice rejected: ${error.message}`);inventoryNotice('符文自选未完成，请检查选择、道具或背包状态。');}
            armSafety();continue;
          }
        }

        const progressionContext={};
        if(progressionRequest.system==='crafting'){
          const normalize=item=>item?.guid?.toString?.('hex')||String(item?.guid||'').toLowerCase();
          const all=[...EQUIP.values(),...(BAG?.slotMap?.values?.()||[])];
          if(progressionRequest.operation==='inherit'){
            progressionContext.source=all.find(item=>normalize(item)===progressionRequest.sourceGuid);
            progressionContext.target=all.find(item=>normalize(item)===progressionRequest.targetGuid);
          }
          if(progressionRequest.operation==='forge'){
            const item=all.find(entry=>normalize(entry)===progressionRequest.guid);
            if(item){
              progressionRequest.itemId=item.itemId;
              progressionRequest.level=Number(item.enhancementLevel||0);
              progressionRequest.attributes=item.attributes||{};
            }else progressionRequest.instanceMissing=true;
          }
          if(progressionRequest.operation==='alchemy')
            { progressionRequest.inventory=Object.fromEntries(BAG?.itemMap||[]); if(WALLET?.attrs) progressionRequest.wallet={gold:WALLET.attrs[50],diamond:WALLET.attrs[72]}; }
        }
        if(progressionRequest.system==='rune'&&progressionRequest.operation==='exchangeNormal'&&
           (BAG?.itemMap||RES?.[7421]!==undefined)){
          // Rune fragments live in resource item 7421 on the native client.
          // Keep the state machine on that same balance; 7354 remains only a
          // compatibility mirror for the local fixture.
          progressionRequest.availableFragments=runeFragmentBalance();
        }
        if(progressionRequest.system==='rune'&&progressionRequest.operation==='exchangeAdvanced'&&BAG?.slotMap){
          const requestedCount=Math.max(1,Number(progressionRequest.count)||1);
          const available=runeTokenBalance(progressionRequest.tokenId);
          progressionRequest.availableTokenCount=available;
          if(available<requestedCount) progressionRequest.inventoryTokenMissing=true;
        }
        if(progressionRequest.system==='magicGem'&&BAG?.itemMap){
          // The magic-gem panel draws ordinary crystals from 11523, while
          // raw stones are real slot instances.  Build one logical balance
          // view for validation without double-counting an id that happens
          // to be present in both captured stores.
          const materials=new Map(BAG.itemMap);
          const putBalance=(id,value)=>{
            const numericId=Number(id), count=Math.max(0,Number(value)||0);
            if(!Number.isInteger(numericId)||numericId<=0)return;
            materials.set(numericId,Math.max(Number(materials.get(numericId)||0),count));
          };
          for(const [id,value] of Object.entries(RES)) putBalance(id,value);
          for(const value of BAG.slotMap?.values?.()||[])
            if(value?.itemId) putBalance(value.itemId,value.count);
          progressionRequest.availableMaterials=Object.fromEntries(materials);
        }
        if(progressionRequest.system==='warSoul'){
          ensureWarSoulMaterials();
          progressionRequest.availableMaterials={...(PROGRESSION.warSoul.pageFragments(progressionRequest.page ?? PROGRESSION.warSoul.state.currentPage) || {})};
        }
        if(progressionRequest.system==='magicGem'&&WALLET?.attrs)
          progressionRequest.availableWallet={gold:WALLET.attrs[50],diamond:WALLET.attrs[72]};
        if (progressionRequest.system === 'rune' && progressionRequest.operation === 'requestUnlockRune')
          progressionRequest.now = wireClockNowMs();
        if(progressionRequest.system==='magicGem'&&progressionRequest.deviceGuid&&!PROGRESSION.magicGem.device(progressionRequest.deviceGuid)){
          const normalize=item=>item?.guid?.toString?.('hex')||String(item?.guid||'').toLowerCase();
          const instance=[...EQUIP.values(),...(BAG?.slotMap?.values?.()||[])].find(item=>normalize(item)===String(progressionRequest.deviceGuid).toLowerCase());
          if(instance&&ITEM_TYPES[instance.itemId]==='magicgemequip')
            PROGRESSION.magicGem.createDevice({guid:progressionRequest.deviceGuid,itemId:instance.itemId});
          else progressionRequest.deviceMissing=true;
        }
        const mutationKey=runeMutationKey(progressionRequest);
         const runeAckSource=progressionRequest.system==='rune'&&
           ['strengthen','demolish'].includes(progressionRequest.operation)
           ? (()=>{
               const id=progressionRequest.operation==='strengthen'
                 ? (progressionRequest.mainId || progressionRequest.rawArgs?.[0])
                 : (progressionRequest.id || progressionRequest.rawArgs?.[0]);
               const value=Object.values(PROGRESSION.rune.state.inventory||{})
                 .find(entry=>String(entry.id)===String(id));
               return value?JSON.parse(JSON.stringify(value)):null;
             })() : null;
         const replayedMutation=mutationKey&&RECENT_RUNE_MUTATIONS.has(mutationKey)
           ? RECENT_RUNE_MUTATIONS.get(mutationKey) : null;
        // The Lua client uses mode 1 while refreshing the panel (preview)
        // and mode 0 only after the player presses the confirm button.
        const runePreview=progressionRequest.system==='rune'&&
          ['strengthen','demolish'].includes(progressionRequest.operation)&&
          Number(progressionRequest.shortcut)===1;
        let progressionResult;
        if(runePreview){
          // Refreshing the panel must not commit anything, but it still has
          // to show the actual predicted result. Run the same state machine
          // against a deep in-memory copy so demolish previews contain the
          // fragment/lowered-rune result and strengthen previews contain the
          // newly rolled attributes.
          if(replayedMutation){
            progressionResult={...JSON.parse(JSON.stringify(replayedMutation)),repeated:true,preview:true};
          }else{
            progressionResult=simulateRuneMutation(progressionRequest);
            progressionResult={...progressionResult,preview:true};
            if(runeAckSource) progressionResult.sourceRune=runeAckSource;
          }
        }else if(replayedMutation){
          progressionResult={...JSON.parse(JSON.stringify(replayedMutation)),repeated:true};
        }else{
          progressionResult=progressionRequest.instanceMissing
            ? {ok:false,reason:'equipment-instance-not-found'}
            : progressionRequest.inventoryTokenMissing
            ? {ok:false,reason:'rune-exchange-token-insufficient'}
            : progressionProtocol.handle(progressionRequest,PROGRESSION,progressionContext);
        }
        if(progressionResult.ok&&runeAckSource&&
           ['strengthen','demolish'].includes(progressionRequest.operation)&&
           !progressionResult.sourceRune) progressionResult.sourceRune=runeAckSource;
        // Keep the authoritative inventory aligned with the committed native
        // result.  This is idempotent and protects against a legacy client
        // path that received the 11684 success envelope but skipped the
        // in-memory downgrade before the subsequent list refresh.
        if(progressionResult.ok && progressionRequest.system==='rune' &&
           progressionRequest.operation==='demolish' &&
           !progressionResult.preview && !progressionResult.repeated &&
           progressionResult.returned){
          const returnedId=String(progressionResult.returned.id);
          const liveRune=Object.values(PROGRESSION.rune.state.inventory||{})
            .find(entry=>String(entry?.id)===returnedId);
          if(liveRune){
            Object.assign(liveRune, JSON.parse(JSON.stringify(progressionResult.returned)));
            PROGRESSION.rune.save();
          }
        }
        if(progressionResult.ok&&mutationKey&&!replayedMutation&&!runePreview){
          RECENT_RUNE_MUTATIONS.set(mutationKey,JSON.parse(JSON.stringify(progressionResult)));
          while(RECENT_RUNE_MUTATIONS.size>32) RECENT_RUNE_MUTATIONS.delete(RECENT_RUNE_MUTATIONS.keys().next().value);
        }
        let runeExchangeFrames=[], runeDemolishFrames=[], runeTokenFrames=[];
        if(progressionResult.ok&&progressionRequest.system==='rune'&&
           progressionRequest.operation==='exchangeAdvanced'&&!progressionResult.repeated){
          runeTokenFrames=consumeRuneExchangeTokens(progressionRequest.tokenId,
            Math.max(1,Number(progressionResult.count)||Number(progressionRequest.count)||1));
          if(!runeTokenFrames){
            log(`${tag} progression advanced rune token debit failed after validation: item=${progressionRequest.tokenId}`);
            progressionResult={ok:false,reason:'rune-exchange-token-save-failed'};
          }
        }
        if(progressionResult.ok&&progressionRequest.system==='rune'&&
           progressionRequest.operation==='exchangeNormal'&&!progressionResult.repeated&&
           progressionResult.cost&&(BAG?.itemMap||RES?.[7421]!==undefined)){
          const cost=Number(progressionResult.cost)||0;
          const next=setRuneFragmentBalance(runeFragmentBalance()-cost);
          try{saveResources();saveMaterialLive(BAG?.itemMap,true);}catch(error){log(`${tag} progression rune exchange material save failed: ${error.message}`);}
          runeExchangeFrames=runeFragmentDeltaFrames([{id:7421,count:next}]);
        }
        // Native demolish commits send the 11553 fragment balance before the
        // 11684 result envelope. Queue that update now so the result dialog
        // reads the new balance instead of the old one.
        if(progressionResult.ok&&progressionRequest.system==='rune'&&
           progressionRequest.operation==='demolish'&&!progressionResult.repeated&&
           !progressionResult.preview&&Number(progressionResult.fragments)>0){
          runeDemolishFrames=addRuneFragmentsToBag(progressionResult.fragments);
          try{saveResources();saveMaterialLive(BAG?.itemMap,true);}catch(error){log(`${tag} progression rune demolish material save failed: ${error.message}`);}
        }
        // Keep the server-side V-level decision observable while the native
        // V-level 11682 special-field layout is still being captured.  This
        // proves whether a missing popup is a wire/display issue or a pity
        // decision issue without guessing into the reserved tail bytes.
        if(progressionResult.ok&&progressionRequest.system==='rune'&&
           progressionRequest.operation==='strengthen'&&!progressionResult.preview&&
           !progressionResult.repeated&&Number(progressionResult.rune?.level)===5){
          const godsend=progressionResult.rune?.godsend;
          const pity=PROGRESSION.rune.godsendInfo?.()||{};
          log(`${tag} rune level5 result godsend=${godsend?.id||0}:${godsend?.name||''} `+
              `small=${Number(pity.smallPity)||0} largeR=${Number(pity.largePity?.regular)||0} `+
              `largeL=${Number(pity.largePity?.limited)||0}`);
        }
        if(!progressionResult.ok){
          log(`${tag} progression ${msgid} rejected: ${progressionResult.reason}`);
          if(PLAYER_ACCOUNTS&&accountOnline&&!economyFrozen()&&msgid===9157&&
             progressionRequest.system==='rune'&&progressionRequest.operation==='godsendFilterApply'&&
             progressionResult.reason==='limited-godsend-activation-insufficient'){
            inventoryNotice('限定神赐剩余开启次数不足，当前无法开启。');
            const current=liveGodsendFilterInfoAck();
            if(current)emitLive([current],'current limited godsend activation unavailable');
          }
        }
        else {
          // A successful native progression request owns its captured batch.
          // Mark it consumed immediately; otherwise the replay scheduler can
          // send the old 13584/13588/13554 response later and overwrite the
          // live magic-gem state we just committed.
          if(['magicGem','rune','warSoul'].includes(progressionRequest.system)){
            const replayBatch=S.byKey.get(`${msgid}#${n}`);
            if(replayBatch)done.add(replayBatch.key);
          }
          // Panel-open requests are not mutations, so the capture-driven
          // batch scheduler has no matching response for them.  Replay the
          // corresponding native acknowledgement immediately; this keeps the
          // client UI populated while the live state remains authoritative.
          // Rune panels can remain open while the client is in a match.  The
          // old lobby-only gate silently dropped their 11682/11684 replies,
          // leaving the UI to retry an already-committed operation forever.
          const allowProgressionAck=!inMatch || progressionRequest.system==='rune';
          let deferredSeniorExchangeAck = null;
          if(allowProgressionAck && ![11679].includes(msgid)){
            const ack=capturedProgressionAck(msgid,progressionResult);
            // The captured native preview path returns only 11682/11684.
            // Sending the separate determination packet during mode=1 makes
            // the Lua dialog open the committed “强化成功/拆解成功” popup
            // before the player presses confirm.
            const determination=progressionResult.preview||msgid===11854?null:liveRuneDeterminationAck(msgid);
            if(runeExchangeFrames.length) emitLive(runeExchangeFrames,'rune exchange fragments');
            if(runeDemolishFrames.length) emitLive(runeDemolishFrames,'rune demolish fragments');
            const godsendInfoAck = msgid === 9157 ? liveGodsendFilterAck(9155, progressionResult) : null;
            // The senior-compose handler opens CharmGet immediately.  Its
            // native callback resolves the new rune from the list snapshot,
            // so send the 11784 success status after the 11688 refresh below.
            if (msgid === 11783) deferredSeniorExchangeAck = ack;
            if((ack && msgid !== 11783) || determination || godsendInfoAck) {
            const frames = [];
              if(ack && msgid !== 11783) frames.push(ack);
              if(determination) frames.push(determination);
              if(godsendInfoAck) frames.push(godsendInfoAck);
              emitLive(frames,`progression ${msgid} native ack`);
            }
          }
          if(progressionRequest.system==='rune'&&progressionRequest.operation==='exchangeAdvanced'&&!progressionResult.repeated){
            if(runeTokenFrames.length) emitLive(runeTokenFrames,'advanced rune exchange token debit');
            const refresh=liveRuneListAck();
            if(refresh) emitLive([refresh],'advanced rune exchange list refresh');
            if(deferredSeniorExchangeAck) {
              // Keep the list refresh ahead of the native 11784 result window
              // so the committed rune is visible immediately after the
              // generic reward dialog closes.  The result payload contains
              // only confirmed ordinary attributes; godsend naming is not
              // guessed here.
              const seniorAck = deferredSeniorExchangeAck;
              emitLive([seniorAck], 'senior rune exchange success ack');
            }
          }
          if(progressionRequest.system==='rune'&&['unlockSlot','addPage'].includes(progressionRequest.operation)){
            const refresh=liveRuneInfoAck();
            if(refresh) emitLive([refresh],'rune grid all-slots-open refresh');
          }
          // Crafting state produces a normalized instance result.  Apply the
          // reversible part back to the live equipment object immediately so
          // the next 1043/loadout rebuild sees inherited and forged values.
          if(progressionRequest.system==='crafting'&&progressionRequest.operation==='inherit'&&progressionResult.target&&progressionContext.target){
            const target=progressionContext.target;for(const [key,value] of Object.entries(progressionResult.target))if(key!=='guid')target[key]=value;
            if(progressionResult.source&&progressionContext.source){
              const source=progressionContext.source;
              for(const [key,value] of Object.entries(progressionResult.source))if(key!=='guid')source[key]=value;
            }
            try{saveBagLive(BAG.slotMap,true);saveEquipState(true);}catch(error){log(`${tag} progression inherit save failed: ${error.message}`);}
          }
          if(progressionRequest.system==='crafting'&&['confirmForge','confirmForgeWash'].includes(progressionRequest.operation)&&progressionResult.forge){
            const normalize=item=>item?.guid?.toString?.('hex')||String(item?.guid||'').toLowerCase();
            const target=[...EQUIP.values(),...(BAG?.slotMap?.values?.()||[])].find(item=>normalize(item)===progressionResult.guid);
            if(target){target.forge=progressionResult.forge;try{PROGRESSION.crafting.setApplied(progressionResult.guid,progressionResult.forge);saveBagLive(BAG.slotMap,true);saveEquipState(true);}catch(error){log(`${tag} progression forge save failed: ${error.message}`);}}
          }
          if(progressionRequest.system==='crafting'&&progressionRequest.operation==='alchemy'&&!progressionResult.repeated&&progressionResult.costs&&BAG?.itemMap){
            // Alchemy is a material transaction, so persist the debit and
            // output beside the slot-based bag state.  The crafting state
            // validates the complete recipe before this mutation happens.
            for(const [id,count] of Object.entries(progressionResult.costs)){
              const left=Math.max(0,(BAG.itemMap.get(+id)||0)-Number(count||0));
              if(left)BAG.itemMap.set(+id,left);else BAG.itemMap.delete(+id);
            }
            const output=Number(progressionResult.outputItemId),amount=Number(progressionResult.outputCount)||0;
            if(output>0&&amount>0)BAG.itemMap.set(output,(BAG.itemMap.get(output)||0)+amount);
            try{saveMaterialLive(BAG.itemMap,true);}catch(error){log(`${tag} progression alchemy save failed: ${error.message}`);}
            if(WALLET?.attrs&&progressionResult.walletCosts){
              const gold=Number(progressionResult.walletCosts.gold)||0,diamond=Number(progressionResult.walletCosts.diamond)||0;
              if(gold)WALLET.attrs[50]=Math.max(0,(WALLET.attrs[50]||0)-gold);
              if(diamond)WALLET.attrs[72]=Math.max(0,(WALLET.attrs[72]||0)-diamond);
              WALLET.gold=WALLET.attrs[50];
              try{WALLET.save();}catch(error){log(`${tag} progression alchemy wallet save failed: ${error.message}`);}
            }
          }
          if(progressionRequest.system==='rune'&&progressionRequest.operation==='demolish'&&!progressionResult.repeated&&!progressionResult.preview){
            const refresh=liveRuneListAck();
            if(refresh) emitLive([refresh],'rune demolish list refresh');
          }
          if(progressionRequest.system==='rune'&&progressionRequest.operation==='exchangeNormal'&&!progressionResult.repeated){
            // The exchange page redraws its owned-rune list after the
            // material delta. The captured flow sends 11688 immediately
            // after 11523; without it the new rune appears only after a
            // later panel reopen.
            const refresh=liveRuneListAck();
            if(refresh) emitLive([refresh],'rune exchange list refresh');
          }
          let magicGemMaterialFrames=[];
          if(progressionRequest.system==='magicGem'&&
             progressionRequest.operation==='materialExchange'&&
             !progressionResult.repeated&&BAG?.slotMap){
            const changedSlots=new Set(), changedMaterials=new Set(), changedResources=new Set();
            const sourceGuid=String(progressionRequest.sourceGuid||'').toLowerCase();
            const costs=Object.entries(progressionResult.costs||{}).map(([id,count])=>[Number(id),Math.max(0,Number(count)||0)]);
            const outputs=Object.entries(progressionResult.outputs||{}).map(([id,count])=>[Number(id),Math.max(0,Number(count)||0)]);
            const availableFor=(itemId)=>{
              const slotTotal=[...BAG.slotMap.values()].filter(v=>Number(v?.itemId)===itemId)
                .reduce((sum,v)=>sum+Math.max(0,Number(v?.count)||0),0);
              const material=Number(BAG.itemMap?.get(itemId)||0);
              const resource=Number(RES[itemId]||0);
              return Math.max(slotTotal,material,resource);
            };
            const enough=costs.every(([itemId,count])=>count>0&&availableFor(itemId)>=count);
            if(!enough){
              progressionResult.ok=false;
              progressionResult.reason='magic-exchange-material-state-desync';
              log(`${tag} magic-gem material exchange state desync: ${JSON.stringify(progressionResult.costs||{})}`);
            }else{
              const debit=(itemId,count)=>{
                let left=count;
                const entries=[...BAG.slotMap.entries()]
                  .filter(([,value])=>Number(value?.itemId)===itemId)
                  .sort(([a,va],[b,vb])=>{
                    const ag=sourceGuid&&String(va?.guid||'').toLowerCase()===sourceGuid?0:1;
                    const bg=sourceGuid&&String(vb?.guid||'').toLowerCase()===sourceGuid?0:1;
                    return ag-bg||a-b;
                  });
                for(const [slot,value] of entries){
                  if(left<=0)break;
                  const used=Math.min(left,Math.max(0,Number(value.count)||0));
                  if(!used)continue;
                  const rest=Math.max(0,Number(value.count||0)-used);
                  if(rest)BAG.slotMap.set(slot,{...value,count:rest});
                  else BAG.slotMap.delete(slot);
                  changedSlots.add(slot); left-=used;
                }
                if(left>0&&BAG.itemMap?.has(itemId)){
                  const used=Math.min(left,Math.max(0,Number(BAG.itemMap.get(itemId)||0)));
                  const rest=Math.max(0,Number(BAG.itemMap.get(itemId)||0)-used);
                  if(rest)BAG.itemMap.set(itemId,rest);else BAG.itemMap.delete(itemId);
                  if(used)changedMaterials.add(itemId);
                  left-=used;
                }
                if(left>0&&RES[itemId]!==undefined){
                  const used=Math.min(left,Math.max(0,Number(RES[itemId]||0)));
                  RES[itemId]=Math.max(0,Number(RES[itemId]||0)-used);
                  if(used)changedResources.add(itemId);
                  left-=used;
                }
                return left===0;
              };
              const placed=[], outputSlots=new Set();
              const place=(itemId,count)=>{
                if(!count)return true;
                if(containerOf(itemId)==='slot'){
                  let slot=[...BAG.slotMap.entries()].find(([,value])=>Number(value?.itemId)===itemId&&!value?.dual)?.[0];
                  if(slot===undefined)slot=placed.find(entry=>entry.itemId===itemId)?.slot;
                  if(slot===undefined){
                    const reserved=new Set([...BAG.slotMap.keys(),...placed.map(entry=>entry.slot)]);
                    const equipped=equippedBagSlots();
                    for(let candidate=0;candidate<BAG_CAPACITY;candidate++)
                      if(!reserved.has(candidate)&&!equipped.has(candidate)){slot=candidate;break;}
                  }
                  if(slot===undefined||slot===null)return false;
                  const current=BAG.slotMap.get(slot);
                  if(current)BAG.slotMap.set(slot,{...current,count:Number(current.count||0)+count});
                  else BAG.slotMap.set(slot,{itemId,count,guid:synthGuid(slot,itemId,REGUID_SALT()).toString('hex')});
                  placed.push({itemId,slot}); outputSlots.add(slot); changedSlots.add(slot); return true;
                }
                if(containerOf(itemId)==='resource'){
                  RES[itemId]=Math.max(0,Number(RES[itemId]||0)+count); changedResources.add(itemId); return true;
                }
                if(!BAG.itemMap)return false;
                BAG.itemMap.set(itemId,Math.max(0,Number(BAG.itemMap.get(itemId)||0)+count));
                changedMaterials.add(itemId); return true;
              };
              const debited=costs.every(([itemId,count])=>debit(itemId,count));
              const placedOk=debited&&outputs.every(([itemId,count])=>place(itemId,count));
              if(!placedOk){
                progressionResult.ok=false;
                progressionResult.reason='magic-exchange-storage-full';
                log(`${tag} magic-gem material exchange storage failed: ${JSON.stringify(progressionResult.outputs||{})}`);
              }else{
                try{
                  if(changedSlots.size)saveBagLive(BAG.slotMap,true);
                  if(changedMaterials.size)saveMaterialLive(BAG.itemMap,true);
                  if(changedResources.size)saveResources();
                }catch(error){log(`${tag} progression magic gem material save failed: ${error.message}`);}
                for(const id of changedMaterials)magicGemMaterialFrames.push(bagMod.buildBagDelta(id,BAG.itemMap.get(id)||0));
                for(const id of changedResources)magicGemMaterialFrames.push(resourceBalanceFrame(id,RES[id]||0,0x0d));
                const inputId=Number(progressionResult.sourceItemId||costs[0]?.[0]||0);
                const outputId=Number(progressionResult.outputItemId||outputs[0]?.[0]||0);
                const inputCount=Number(costs.find(([id])=>id===inputId)?.[1]||0);
                const outputCount=Number(outputs.find(([id])=>id===outputId)?.[1]||0);
                const detailSlots=[...outputSlots,...[...changedSlots].filter(slot=>!outputSlots.has(slot))];
                let detail=null;
                if(detailSlots.length&&EQ_TEMPLATE){
                  const records=[];
                  for(const slot of detailSlots){
                    const value=BAG.slotMap.get(slot);
                    const frame=liveDetail(0x03,slot,value?.itemId||0xffff,value?.count||0,
                      value?.guid?Buffer.from(value.guid,'hex'):Buffer.alloc(8));
                    if(frame)records.push(frame.subarray(12+6));
                  }
                  if(records.length){
                    const payload=Buffer.alloc(6+records.length*493);
                    payload[0]=0; payload[1]=3; payload.writeUInt32LE(records.length,2);
                    records.forEach((record,index)=>record.copy(payload,6+index*493));
                    detail=bagMod.mkFrame(17004,payload,{flags:0x0d,stream:PLAYERID});
                  }
                }
                const itemFrames=[];
                const make17015=kind=>{
                  const payload=Buffer.alloc(10);
                  payload.writeUInt16LE(kind,0); payload.writeUInt16LE(inputId,2); payload.writeUInt16LE(inputCount,4);
                  payload.writeUInt16LE(outputId,6); payload.writeUInt16LE(outputCount,8);
                  return bagMod.mkFrame(17015,payload,{flags:0x0d,stream:PLAYERID});
                };
                itemFrames.push(make17015(0x0203)); if(detail)itemFrames.push(detail); itemFrames.push(make17015(0x0211));
                const ack=Buffer.alloc(5); ack[0]=1; ack.writeUInt32LE(Number(progressionRequest.recipeId)||0,1);
                magicGemMaterialFrames.push(...itemFrames,bagMod.mkFrame(13555,ack,{flags:0x0d,stream:PLAYERID}));
              }
            }
          }
          if(progressionRequest.system==='magicGem'&&progressionResult.costs&&BAG?.itemMap&&
             progressionRequest.operation!=='materialExchange'){
            for(const [id,count] of Object.entries(progressionResult.costs)){
              const numericId=Number(id),left=Math.max(0,Number(BAG.itemMap.get(numericId)||0)-Number(count||0));
              if(left)BAG.itemMap.set(numericId,left);else BAG.itemMap.delete(numericId);
              // 13584 is followed by a native 11553 balance update.  Without
              // this delta the server state changes but the crystal counter
              // stays at its old value until a relogin.
              magicGemMaterialFrames.push(numericId===46612
                ? resourceBalanceFrame(numericId,left,0x0d)
                : bagMod.buildBagDelta(numericId,left));
            }
            try{saveMaterialLive(BAG.itemMap,true);}catch(error){log(`${tag} progression magic gem material save failed: ${error.message}`);}
          }
          if(progressionRequest.system==='magicGem'&&progressionResult.walletCosts&&WALLET?.attrs){
            const gold=Number(progressionResult.walletCosts.gold)||0,diamond=Number(progressionResult.walletCosts.diamond)||0;
            if(gold)WALLET.attrs[50]=Math.max(0,(WALLET.attrs[50]||0)-gold);
            if(diamond)WALLET.attrs[72]=Math.max(0,(WALLET.attrs[72]||0)-diamond);
            WALLET.gold=WALLET.attrs[50];
            try{WALLET.save();}catch(error){log(`${tag} progression magic gem wallet save failed: ${error.message}`);}
          }
          if(progressionRequest.system==='warSoul'&&progressionResult.costs){
            ensureWarSoulMaterials();
            const fragments=PROGRESSION.warSoul.pageFragments(progressionRequest.page ?? PROGRESSION.warSoul.state.currentPage);
            for(const [id,count] of Object.entries(progressionResult.costs)){
              const numericId=Number(id),left=Math.max(0,Number(fragments[numericId]||0)-Number(count||0));
              fragments[numericId]=left;
            }
            try{PROGRESSION.warSoul.save();}catch(error){log(`${tag} progression war soul material save failed: ${error.message}`);}
          }
          if(progressionRequest.system==='warSoul'&&progressionResult.refunds){
            ensureWarSoulMaterials();
            const fragments=PROGRESSION.warSoul.pageFragments(progressionRequest.page ?? PROGRESSION.warSoul.state.currentPage);
            for(const [id,count] of Object.entries(progressionResult.refunds)){
              const numericId=Number(id),next=Math.max(0,Number(fragments[numericId]||0)+Number(count||0));
              fragments[numericId]=next;
            }
            try{PROGRESSION.warSoul.save();}catch(error){log(`${tag} progression war soul material refund save failed: ${error.message}`);}
          }
          if(progressionRequest.system==='magicGem' && !inMatch){
            try{
              if(magicGemMaterialFrames.length) emitLive(magicGemMaterialFrames,'magic-gem material exchange');
              const payload=progressionProtocol.magicGemResponsePayload(PROGRESSION.magicGem,progressionRequest,progressionResult);
              if(payload.length>2) emitLive([bagMod.mkFrame(11888,payload,{flags:0xca,stream:PLAYERID})],'magic-gem state');
              // The native lobby model listens to 13590 for the complete
              // equipped-device/gem snapshot.  Keep the PB operation reply
              // above for the dialog, then push this authoritative refresh
              // so equip, wash, refine and circuit changes are visible at
              // once without reopening the panel.
              const notify=progressionProtocol.magicGemNotifyPayload(PROGRESSION.magicGem);
              if(notify.length>2) emitLive([bagMod.mkFrame(13590,notify,{flags:0xc9,stream:PLAYERID})],'magic-gem attributes');
            }catch(error){log(`${tag} progression magic gem response failed: ${error.message}`);}
          }
          if(progressionRequest.system==='rune' && progressionRequest.operation==='nativeBoard' && !inMatch){
            try{emitLive([liveRunePageAck(progressionRequest.page)],'rune board state');}
            catch(error){log(`${tag} progression rune response failed: ${error.message}`);}
          }
          if(progressionRequest.system==='warSoul' && !inMatch && progressionRequest.operation!=='renamePage'){
            // 36268/other small operation replies are not present in the
            // available captures. The native war-soul panel does consume the
            // large 36273 world refresh, so push it after every live war-soul
            // mutation; equipment soul entries remain on their separate path.
            const refresh = ['renameEnhancementPage','openEnhancementPage','changeEnhancementPage','lockEnhancement','washEnhancementPage'].includes(progressionRequest.operation)
              ? liveWarSoulEntryRefresh() : liveWarSoulRefresh();
            if(refresh) emitLive([Buffer.from(refresh)],'war-soul state refresh');
          }
          log(`${tag} progression ${msgid} committed (${progressionRequest.system}/${progressionRequest.operation})`);
          if(roleReadyAt && !inMatch && ['rune','magicGem','warSoul'].includes(progressionRequest.system))
            emitLive(equipmentAttributeFrames(true), 'progression attributes');
        }
      }
      if ([13510,13512,13518,13553,13575].includes(msgid)) {
        const result=EQUIPMENT_ADAPTER?.handle(msgid,f.subarray(12)) ||
          {ok:false,reason:'equipment-container-unavailable'};
        if(result.ok){
          const updates=[];
          for(const [key,amount] of Object.entries(result.debits?.resources||{})){
            if(!amount)continue;
            const id=+key;
            if(containerOf(id)==='resource')updates.push(resourceBalanceFrame(id,RES[id]));
            else if(containerOf(id)==='material')updates.push(bagMod.buildBagDelta(id,BAG.itemMap.get(id)));
          }
          if(result.debits?.wallet?.gold)updates.push(mkAttrFrame(50,WALLET.attrs[50]));
          if(result.debits?.wallet?.diamond)updates.push(mkAttrFrame(72,WALLET.attrs[72]));
          const details=[];
          if(localEquipmentEnabled && !isolatedEquipmentRules && msgid!==13510){
            const guid=f.subarray(12,20).toString('hex');
            const current=EQUIPMENT_ADAPTER.findInstance(guid);
            if(current){
              const guidBytes=Buffer.from(guid,'hex');
              if(msgid===13518){
                details.push(liveDetail(0x11,current.slot,current.itemId,1,guidBytes,
                  current.baselineHex));
              }else{
                details.push(liveDetail(msgid===13512?0x0f:0x11,current.slot,
                  current.itemId,1,guidBytes));
              }
              if(msgid===13512||msgid===13553){
                let worn=false;
                for(const [pos,e] of EQUIP){
                  const wornGuid=Buffer.isBuffer(e?.guid)?e.guid.toString('hex'):e?.guid;
                  if(wornGuid!==guid)continue;
                  const equipped=equipFrame(pos,current.slot,current.itemId,1,guidBytes);
                  if(equipped)details.push(equipped);
                  worn=true;
                }
                if(worn)details.push(...equipmentAttributeFrames());
              }
            }
          }
          emitLive([...updates,...details,...result.frames],`equipment ${msgid} committed`);
        } else {
          log(`${tag} equipment ${msgid} rejected: ${result.reason}${result.error?` (${result.error})`:''}`);
          if(msgid!==13510 && msgid!==13575)inventoryNotice(result.reason==='economy-frozen'
            ? '经济存档待核对，装备操作暂不可用。':'装备规则尚未核实或操作失败，暂不可执行。');
        }
        armSafety();continue;
      }
      if(msgid===13542){
        const request=soulRules.parseRefill(f.subarray(12));
        const result=soulRules.planRefill(SOULS,request,BAG?.slotMap||new Map(),{capacity:BAG_VISIBLE_CAPACITY});
        if(!result.ok){inventoryNotice({
          'soul-full':'当前魂量已达到储存上限，不能使用灵魂晶体。',
          'insufficient-crystals':'灵魂晶体不足。',
          'not-soul-equipment':'这件装备不能铸魂。',
        }[result.reason]||'铸魂失败，请检查装备和灵魂晶体。');armSafety();continue;}
        try{
          if(!EQUIPMENT_COMMIT.run('soul-refill',request.guid,[
            {name:'soul-bag',path:BAG_LIVE,save:()=>saveBagLive(result.bag,true)},
            {name:'soul-state',path:SOULS.file,save:()=>SOULS.save(result.next)},
          ]))throw Error('Economic writes frozen');
        }catch(error){log(`${tag} soul refill save failed: ${error.message}`);inventoryNotice('铸魂存档待核对，暂不能操作。');armSafety();continue;}
        BAG.slotMap=result.bag;SOULS.state=result.next;
        emitLive([...bagResyncFrames('soul refill',[...result.touched,result.equipmentSlot]),
          ...equipmentSnapshotFrames(),...equipmentAttributeFrames(),
          bagMod.mkFrame(13453,Buffer.from([0]),{flags:0xca})], 'soul refill');
        inventoryNotice('铸魂成功。');armSafety();continue;
      }
      if(msgid===11888 && f[12]===0x92 && f[13]===0x01){
        const selected=gemRules.parsePanQuery(f.subarray(12));
        if(selected===null){armSafety();continue;}
        if(selected!==0xffffffff && selected!==GEM_BOARD.state.activePlan){
          const next=GEM_BOARD.snapshot();next.activePlan=selected;
          try{GEM_BOARD.save(next);GEM_BOARD.replace(next);}
          catch(error){log(`${tag} gem plan selection save failed: ${error.message}`);
            inventoryNotice('宝石方案保存失败。');armSafety();continue;}
        }
        const board=gemRules.boardPayload(GEM_BOARD.state,
          selected===0xffffffff?null:selected);
        emitLive([bagMod.mkFrame(11888,board,{flags:0xca}),
          ...equipmentContextFrames(),
          ...(selected===0xffffffff?[]:equipmentAttributeFrames())],'gem board query');
        armSafety();continue;
      }
      if(msgid===13630||msgid===13631||msgid===13632){
        const operation=msgid===13630?'open':msgid===13631?'remove':'insert';
        const occupied=equippedBagSlots();
        const result=gemRules.planChange(GEM_BOARD.state,
          operation==='remove'&&require('./gem-removal-batch').isRemoveAll(f)?'remove-all':operation,f.subarray(12),
          BAG?.slotMap||new Map(),{capacity:BAG_VISIBLE_CAPACITY,stackMax:STACK_MAX,reserved:occupied,
            wallet:WALLET?.attrs||{}});
        if(!result.ok){
          log(`${tag} gem ${operation} rejected: ${result.reason}`);
          if(operation==='remove' && (result.reason==='socket-empty'||
            result.reason==='socket-locked')){armSafety();continue;}
          inventoryNotice({
            'duplicate-color':'同一装备的宝石颜色不能重复。',
            'bag-full':'背包已满，请先留出空格。',
            'insufficient-currency':'金币或钻石不足。',
            'invalid-dual-gem':'双色宝石属性记录不完整，请反馈这颗宝石。',
          }[result.reason]||'宝石操作失败，请检查孔位和背包。');
          armSafety();continue;
        }
        const bagChanged=operation!=='open';
        const walletChanged=!!result.cost;
        const steps=[{name:'gem-board',path:GEM_BOARD.file,
          save:()=>GEM_BOARD.save(result.next)}];
        if(bagChanged)steps.push({name:'gem-bag',path:BAG_LIVE,
          save:()=>saveBagLive(result.bag,true)});
        if(walletChanged)steps.push({name:'gem-wallet',
          path:path.resolve(process.env.DSH_GOLD_STATE||path.join(__dirname,'gold-state.json')),
          save:()=>fs.writeFileSync(process.env.DSH_GOLD_STATE||path.join(__dirname,'gold-state.json'),
            JSON.stringify({...WALLET.state,attrs:result.attrs,
              gold:result.attrs[50],updatedAt:new Date().toISOString()},null,2))});
        try{
          if(!EQUIPMENT_COMMIT.run(`gem-${operation}`,
            `${result.input.plan}:${result.input.grid}:${result.input.socket??gridLength()}`,steps))throw Error('Economy frozen');
        }catch(error){
          log(`${tag} gem ${operation} save failed: ${error.message}`);
          inventoryNotice('宝石存档待核对，操作暂不可用。');
          armSafety();continue;
        }
        function gridLength(){return GEM_BOARD.state.plans[result.input.plan][result.input.grid].length;}
        GEM_BOARD.replace(result.next);
        if(bagChanged)BAG.slotMap=result.bag;
        if(walletChanged){WALLET.attrs=result.attrs;WALLET.gold=result.attrs[50];
          WALLET.state={...WALLET.state,attrs:result.attrs,gold:result.attrs[50]};}
        const updates=[];
        if(bagChanged){
          for(const entry of result.removed||[{itemId:result.itemId}])
            updates.push(bagMod.mkFrame(17015,gemRules.itemNotice(entry.itemId,operation),{flags:0xca}));
          for(const slot of result.touched){
            const held=BAG.slotMap.get(slot);
            const detail=liveDetail(0x11,slot,held?.itemId??0xffff,held?.count??0,
              held?.guid?Buffer.from(held.guid,'hex'):Buffer.alloc(8));
            if(detail)updates.push(detail);
          }
        }
        updates.push(bagMod.mkFrame(13552,
          gemRules.resultPayload(operation,result.itemId),{flags:0xca}));
        updates.push(bagMod.mkFrame(11888,
          gemRules.boardPayload(GEM_BOARD.state,result.input.plan),{flags:0xca}));
        if(walletChanged)updates.push(...goldPushFrames('gem socket',result.cost.attr));
        updates.push(...equipmentAttributeFrames());
        emitLive(updates,`gem ${operation}`);
        armSafety();continue;
      }
      if(msgid===13537||msgid===13562){
        const request=gemCrafting.parseRequest(msgid,f.subarray(12));
        const reserved=equippedBagSlots();
        const inputs=request&&gemCrafting.resolveInputs(request,BAG?.slotMap||new Map(),
          {capacity:BAG_VISIBLE_CAPACITY,reserved});
        if(!request||!inputs){
          log(`${tag} gem crafting rejected: unresolved materials ${f.subarray(12).toString('hex')}`);
          inventoryNotice('宝石材料不足或请求不合法，请重新放入材料。');armSafety();continue;
        }
        const first=gemRules.catalog.get(BAG.slotMap.get(inputs[0].slot)?.itemId);
        let card=null,cardGrade=null;
        if(request.cardToken){
          const id=request.cardToken,rule=gemCrafting.fusionCard(id);
          if(request.operation!=='fuse'||!rule||rule.level!==first?.level||
            !Number.isSafeInteger(RES[id])||RES[id]<1){
            log(`${tag} gem fusion card rejected: id=${id} gemLevel=${first?.level} `+
              `cardLevel=${rule?.level} resourceBalance=${RES[id]??0}`);
            inventoryNotice('融合卡不足或等级不匹配。');armSafety();continue;
          }
          card={source:'resource',itemId:id};cardGrade=rule.quality;
        }
        const currency=request.payment===1?72:50;
        if(request.operation!=='decompose'&&![0,1,3].includes(request.payment)){
          inventoryNotice('宝石支付方式无效，材料未消耗。');armSafety();continue;
        }
        const price=gemCrafting.operationPrice(request.operation,first?.level,currency);
        const before=BAG.slotMap;
        const result=gemCrafting.plan(request.operation,inputs,before,
          {capacity:BAG_VISIBLE_CAPACITY,stackMax:STACK_MAX,reserved,wallet:WALLET?.attrs||{},resources:RES,
            price,currency,card,cardGrade});
        if(!result.ok){
          log(`${tag} gem ${request.operation} rejected: ${result.reason}`);
          inventoryNotice({
            'different-levels':'只能使用同等级的宝石。',
            'max-level':'八级宝石已经是最高等级。',
            'invalid-compose-count':'合成需要三至五颗宝石。',
            'invalid-decompose-level':'一级宝石不能分解。',
            'invalid-fusion-input':'融合需要两颗四级及以上的不同属性单色宝石，棱彩不能融合。',
            'same-fusion-attribute':'请放入两种不同属性的宝石。',
            'bag-full':'背包空间不足，材料未消耗。',
            'insufficient-currency':'金币或钻石不足，材料未消耗。',
          }[result.reason]||'宝石操作失败，材料未消耗。');armSafety();continue;
        }
        const walletFile=path.resolve(process.env.DSH_GOLD_STATE||path.join(__dirname,'gold-state.json'));
        try{
          if(!EQUIPMENT_COMMIT.run(`gem-${request.operation}`,`${first.id}:${result.count}`,[
            {name:'gem-crafting-bag',path:BAG_LIVE,save:()=>saveBagLive(result.bag,true)},
            ...(card?.source==='resource'?[{name:'gem-fusion-card',path:path.resolve(RESOURCE_FILE),
              save:()=>fs.writeFileSync(RESOURCE_FILE,JSON.stringify(result.resources))}]:[]),
            {name:'gem-crafting-wallet',path:walletFile,save:()=>fs.writeFileSync(walletFile,
              JSON.stringify({...WALLET.state,attrs:result.attrs,gold:result.attrs[50],
                updatedAt:new Date().toISOString()},null,2))},
          ]))throw Error('Economy frozen');
        }catch(error){
          log(`${tag} gem crafting save failed: ${error.message}`);
          inventoryNotice('宝石存档待核对，操作暂不可用。');armSafety();continue;
        }
        BAG.slotMap=result.bag;WALLET.attrs=result.attrs;WALLET.gold=result.attrs[50];
        if(card?.source==='resource')Object.assign(RES,result.resources);
        WALLET.state={...WALLET.state,attrs:result.attrs,gold:result.attrs[50]};
        const updates=[];
        const consumed=new Map();
        for(const {slot,count} of inputs){const id=before.get(slot).itemId;
          consumed.set(id,(consumed.get(id)||0)+count);}
        if(card?.source==='resource')updates.push(resourceBalanceFrame(card.itemId,RES[card.itemId]));
        else if(card)consumed.set(card.itemId,1);
        for(const [id,count] of consumed)updates.push(bagMod.mkFrame(17015,
          u16p(0x010f,id,count),{flags:0xca}));
        const gained=new Map();
        for(const {itemId,count} of result.outputs)gained.set(itemId,(gained.get(itemId)||0)+count);
        for(const [id,count] of gained)updates.push(bagMod.mkFrame(17015,
          u16p(0x010a,id,0x0100+count),{flags:0xca}));
        updates.push(...bagResyncFrames(`gem ${request.operation}`,result.touched));
        // Native success animation looks up the output GUID in the bag, so all
        // instance updates must precede 13550.
        if(request.operation==='decompose'){
          const payload=Buffer.alloc(20);
          result.outputs.forEach((item,i)=>payload.writeUInt32LE(item.itemId,i*4));
          updates.push(bagMod.mkFrame(13563,payload,{flags:0xca}));
        }else if(result.success){
          const payload=Buffer.alloc(17),item=BAG.slotMap.get(result.placements[0].slot);
          Buffer.from(item.guid,'hex').copy(payload);
          updates.push(bagMod.mkFrame(13550,payload,{flags:0xca}));
        }else updates.push(bagMod.mkFrame(13551,Buffer.alloc(0),{flags:0xca}));
        if(price)updates.push(...goldPushFrames(`gem ${request.operation}`,currency));
        emitLive(updates,`gem ${request.operation} ${result.success?'success':'failed'}`);
        log(`${tag} gem ${request.operation}: level=${result.level} input=${result.count} `+
          `success=${result.success} chance=${result.successChance??'n/a'} roll=${result.successRoll??'n/a'} price=${price} outputs=${JSON.stringify(result.outputs)}`);
        armSafety();continue;
      }
      if (BAG && msgid === 17002) {
        if (f.length < 15) continue;
        // 背包格子查询：不再回放录制里的那几帧，改成按模型现场生成
        const slot = f.readUInt16LE(13);
        answerSlotQuery(slot, `�?{k}条请�?17002#${n}`);
        const rb = S.byKey.get(`17002#${n}`); if (rb) done.add(rb.key);   // 录制的那批作�?        armSafety(); continue;
      }
      // ---- 心跳：录制里只有有限的几次，客户端却会一直发 ----
      // 不自己造应答的话，超过录制长度后就再也不回 1298，客户端 ~30 秒后判定掉线
      // （实测：�?6 �?1297/36034 起无应答 -> 「正在重新连接服务器.. 状�?64」）
      if (msgid === 11532) {
        const payload = Buffer.alloc(4); payload.writeUInt32LE(Math.floor(wireClockNowMs() / 1000));
        const reply = bagMod.mkFrame(11533, payload, { flags: 0x0d });
        sendWire(enc.encode(reply));
        const recorded = S.byKey.get(`${msgid}#${n}`); if (recorded) done.add(recorded.key);
        log(`${tag} >>> msgid=11533 live server time (request ${n})`);
        continue;
      }
      if (msgid === 1297 || msgid === 36034) {
        emitLive([bagMod.mkFrame(1298, Buffer.alloc(0), { flags: 0 })], `�?{k}�?心跳应答(服务端生�?`);
      }

      // ---- 测试钩子：运行中发钱（验�?重发角色数据�?�?HUD 金币刷新"这条路）----
      if (!economyFrozen() && GIVE && WALLET && WALLET.ok && msgid === GIVE.msgid && n === GIVE.nth) {
        const now = WALLET.add(GIVE.amount);
        const fs2 = goldPushFrames('测试钩子');
        if (fs2.length) emitLive(fs2, `测试钩子 �?${GIVE.amount} 金币 �?${now}（通道 ${GOLD_PUSH}）`);
      }

      // ---- 进玩法模式（训练场 / 战场）→ 把客户端送到**我们自己的对局服** ----
      // 配方来自 mode-entry.json（`node modeentry.js` 生成，规则见那边的注释）：
      //   27348（选模式，载荷+1 = 模式号）→ 27349 + 27398
      //   27360（进训练场）              → 23417 + 27361 + **1040**（对局服地址）
      //   27298（进战场，模式 252）      → 23417 + **1040**
      // 这里按"触发 msgid"查表回放；1040 里的地址按配方的 `对局`（没写就用 --match-host/--match-port）改写。
      if (MODE_ENTRY) {
        let list = entriesFor(msgid);
        if (list.length > 1) {                       // 同一触发对应多个模式：按载荷里的模式号挑
          const mid = msgid === 27348 ? f.readUInt16LE(12 + 1) : (msgid === 27298 ? f.readUInt32LE(12) : null);
          if (mid !== null) { const hit = list.filter(x => x.模式号 === mid); if (hit.length) list = hit; }
        }
        const ent = list[0];
        if (ent) {
          if(BATTLE_TICKETS&&ent.应答.some(x=>x.msgid===1040)&&(!accountOnline||ent.模式号!==252)){
            inventoryNotice('当前账号尚未接通此玩法。');armSafety();continue;
          }
          if (economyFrozen()) {
            log(`${tag}     进入玩法会发布背包装备快照，邮件待核对期间拒绝`);
            inventoryNotice('邮件领取待核对，暂不能进入玩法。');
            armSafety(); continue;
          }
          publishBattleInventory();
          const 对局 = MATCH_PORT_MAP.get(msgid) || ent.对局;
          const out = [];
          for (const item of ent.应答) {
            let fr = Buffer.from(item.hex, 'hex');
            if (item.msgid === 1040) fr = fixMatchAddr(fr, `${tag}     `, 对局);
            if(item.msgid===1040&&BATTLE_HANDOFF_GATE)fr=BATTLE_HANDOFF_GATE.issue(fr,{
              authenticated:accountOnline===true,frozen:economyFrozen(),uid:PLAYER_SCOPE.uid,playerId:PLAYER_SCOPE.playerId,mapId:ent.模式号});
            out.push(fr);
          }
          const 去向 = ent.应答.some(x => x.msgid === 1040)
            ? `，对局服指向 ${对局 || `${MATCH_HOST}:${MATCH_PORT}`}` : '';
          log(`${tag}     ${msgid} = ${ent.名称}（模式号 ${ent.模式号}，触发载荷 ${ent.触发载荷}）→ 回放 ${out.map(x => x.readUInt16LE(8)).join('/')}${去向}`);
          emitLive(out, `${k} ${msgid} ${ent.名称}`,{captured:true});
          if (out.some(frame => frame.readUInt16LE(8) === 1040)) {
            inMatch = true; clearTimeout(safetyTimer);
          }
          armSafety(); continue;
        }
      }

      // ---- 自选礼包第二步：客户端发 11670（GUID + 12 字节 0）告诉我们选了哪一个 ----
      // 实证见 deliverChoice 的注释（cap-2026-09-26T20-22-26 20:24:13）。
      if (msgid === 11670) {
        const pay = Buffer.from(f.subarray(12));
        if (pay.length >= 12) {
          const guidHex = pay.subarray(0, 8).toString('hex');
          deliverChoice(guidHex, pay.readUInt16LE(10), `${k} 11670 自选`);
          armSafety(); continue;
        }
        log(`${tag}     11670 载荷只有 ${pay.length} 字节，拒绝短请求`);
        armSafety(); continue;
      }

      // ---- 装备穿脱 / 使用道具：格式已从真实样本解出，这里**自己生成**，不再回�?----
      // 来源 cap-2026-09-26T20-22-26（用户各做了 6 次），flags 都是 0xd6
      // 注意�?3502 第一个字段是**背包格子�?*，不是道具ID�?      //   实测 13502(122,0,2)�?3502(123,1,3)�?3502(121,2,4)�?3502(120,3,5)�?3502(126,4,6)�?3502(127,5,7)
      //   而背�?120/121/122/123/126/127 格里分别�?蔷薇双枪/无尽法力魔杖/以太斗篷/魔女之吻/死棘之枪/鲷鱼�?
      if(msgid===13546){
        if(f.length!==16)continue;
        const from=f.readUInt16LE(12),to=f.readUInt16LE(14);
        if(from>=18||to>=18||Math.floor(from/6)!==Math.floor(to/6))continue;
        const a=EQUIP_PLANS.get(from),b=EQUIP_PLANS.get(to);
        if(b)EQUIP_PLANS.set(from,b);else EQUIP_PLANS.delete(from);
        if(a)EQUIP_PLANS.set(to,a);else EQUIP_PLANS.delete(to);
        refreshActiveEquipment();
        saveEquipState();
        const packets=[from,to].map(slot=>applyEquipModel(equipFrame(slot,65535,65535,0,Buffer.alloc(8)))).filter(Boolean);
        packets.push(bagMod.mkFrame(13547,Buffer.alloc(0),{flags:0xd6}));
        packets.push(...equipmentAttributeFrames());
        emitLive(packets,'equipment swap');continue;
      }
      if (msgid === 13504) {                       // unequip: real server replies 1043 + 13505
        if (f.length < 14 || f.readUInt16LE(12)>=18) continue;
        const pos = f.readUInt16LE(12);
        const plan=Math.floor(pos/6), localPos=pos%6, cur=EQUIP_PLANS.get(pos);
        if (!validEquipRef(cur)) {
          log(`${tag}     unequip slot${pos} rejected: empty or stale equipment instance`);
          continue;
        }
        const p2 = Buffer.alloc(2); p2.writeUInt16LE(pos, 0);
        const out = [];
        const nmEq = ITEM_NAMES && ITEM_NAMES[cur.itemId] ? ITEM_NAMES[cur.itemId].name : String(cur.itemId);
        const before=economySnapshot(),references=new Map([...equipmentPlanMap(plan)].filter(([,e])=>validEquipRef(e)));
        references.delete(localPos);
        const result=require('./inventory-capacity').recoverVisible(BAG.slotMap,references,
          {capacity:BAG_CAPACITY,records:BAG_SLOTS_FOR_FRAME});
        if(!result.ok){inventoryNotice('背包已满，无法卸下装备。');continue;}
        BAG.slotMap=result.bag;replaceEquipmentPlan(plan,result.equipped);
        try{
          if(!EQUIPMENT_COMMIT.run('unequip',cur.guid.toString('hex'),[
            {name:'unequip-bag',path:BAG_LIVE,save:()=>saveBagLive(BAG.slotMap,true)},
            {name:'unequip-reference',path:EQUIP_STATE_FILE,save:()=>saveEquipState(true)},
            {name:'unequip-snapshot',path:EQUIP_STATE_FILE+'.snapshot',save:()=>publishBattleInventory()},
          ]))throw Error('equipment commit frozen');
        }catch(error){restoreEconomy(before);inventoryNotice('装备存档待核对，操作暂不可用。');continue;}
        const back=[...BAG.slotMap].find(([,v])=>v.guid===cur.guid.toString('hex'))?.[0];
        const changed=Array.from({length:BAG_CAPACITY},(_,s)=>s)
          .filter(s=>JSON.stringify(before.slots.get(s))!==JSON.stringify(BAG.slotMap.get(s)));
        out.push(...bagResyncFrames('equipment return',changed),...equipmentSnapshotFrames());
        log(`${tag}     unequip slot${pos} "${nmEq}" -> clear equipment reference; bag slot ${back} remains unchanged`);
        out.push(bagMod.mkFrame(13505, p2, { flags: 0xd6 }));
        emitLive(out, `${k} unequip`);
        emitLive(equipmentAttributeFrames(), 'unequip attributes');
        continue;
      }      if (msgid === 13502) {
        if (f.length < 17) continue;
        // ---- 护栏：这一格若**不可装备**，说明客户端布局和我们不同步 ----
        {
          const bs0 = f.readUInt16LE(12);
          if (bs0 >= BAG_CAPACITY || f.readUInt16LE(14) >= 18) { armSafety(); continue; }
          const held0 = BAG.slotMap.get(bs0);
          if (!held0 || !isEquipmentItem(held0.itemId)) {
            const nmH = held0 && ITEM_NAMES && ITEM_NAMES[held0.itemId] ? ITEM_NAMES[held0.itemId].name : (held0 ? String(held0.itemId) : '空格子');
            const p0 = Buffer.alloc(5);
            p0.writeUInt16LE(f.readUInt16LE(14), 0); p0.writeUInt16LE(bs0, 2); p0.writeUInt8(f.readUInt8(16), 4);
            log(`${tag}     !! 装备请求落空：背包格子${bs0} 在模型里是「${nmH}」(${held0 ? ITEM_TYPES[held0.itemId] : '空'})，不是装备 → 回 13503 + 该格校正`);
            const fixSlot = liveDetail(0x0F, bs0, held0 ? held0.itemId : 0xFFFF, held0 ? held0.count : 0, held0 && held0.guid ? Buffer.from(held0.guid, 'hex') : Buffer.alloc(8));
            emitLive([bagMod.mkFrame(13503, p0, { flags: 0xd6 }), fixSlot].filter(Boolean), `${k} equip-mismatch`);
            continue;
          }
          if (!/^[0-9a-f]{16}$/i.test(held0.guid||'') || /^0+$/.test(held0.guid)) {
            log(`${tag}     equip rejected: bag slot ${bs0} has no valid instance GUID`);
            continue;
          }
        }
        // Refuse a second eternal artifact before touching any reference or
        // save file. Ordinary treasure replacement retains its older rule.
        {
          const bs0 = f.readUInt16LE(12), ps0 = f.readUInt16LE(14);
          const held0 = BAG.slotMap.get(bs0);
          const conflict = equipmentRules.eternalConflict(held0,equipmentPlanMap(Math.floor(ps0/6)).values());
          if (conflict) {
            log(`${tag}     eternal artifact rejected: bag slot ${bs0}, equipment slot ${ps0}; original reference unchanged`);
            const current = Array.from({length:6},(_,pos)=>applyEquipModel(equipFrame(pos,65535,65535,0,Buffer.alloc(8)))).filter(Boolean);
            emitLive([...current,...bagResyncFrames('eternal artifact rejected',[bs0,conflict.bagSlot]),...equipmentAttributeFrames()],
              `${k} eternal artifact rejected`);
            inventoryNotice('只能装备一件永恒神器。');
            continue;
          }
        }
        const bagSlot=f.readUInt16LE(12),pos=f.readUInt16LE(14),idx=f[16],plan=Math.floor(pos/6),localPos=pos%6;
        const original=BAG.slotMap.get(bagSlot),before=economySnapshot();
        const result=equipmentRules.planEquip(BAG.slotMap,
          new Map([...equipmentPlanMap(plan)].filter(([,e])=>validEquipRef(e))),bagSlot,localPos,
          {capacity:BAG_CAPACITY,records:BAG_SLOTS_FOR_FRAME,forgeFor:e=>require('./equipment-forging').applied(PROGRESSION.crafting.state,e.guid)});
        if(!result.ok){
          log(`${tag} equip rejected: ${result.reason}; no instance changed`);
          inventoryNotice(result.reason==='one-forged-equipment-per-plan'?'每套配装只能装备一件锻造装备。':'背包已满，无法放回被替换的装备。');armSafety();continue;
        }
        const changed=[];
        for(let slot=0;slot<BAG_CAPACITY;slot++)
          if(JSON.stringify(before.slots.get(slot))!==JSON.stringify(result.bag.get(slot)))changed.push(slot);
        BAG.slotMap=result.bag;replaceEquipmentPlan(plan,result.equipped);
        try{
          EQUIPMENT_COMMIT.run('equip',original.guid,[
            ...(result.moves.length?[{name:'equip-bag',path:BAG_LIVE,save:()=>saveBagLive(BAG.slotMap,true)}]:[]),
            {name:'equip-reference',path:EQUIP_STATE_FILE,save:()=>saveEquipState(true)},
            {name:'equip-snapshot',path:EQUIP_STATE_FILE+'.snapshot',save:()=>publishBattleInventory()},
          ]);
        }catch(error){
          restoreEconomy(before);log(`${tag} equip save failed: ${error.message}`);
          inventoryNotice('装备存档待核对，操作暂不可用。');armSafety();continue;
        }
        const reply=Buffer.alloc(5);reply.writeUInt16LE(pos);reply.writeUInt16LE(bagSlot,2);reply[4]=idx;
        const out=[bagMod.mkFrame(13503,reply,{flags:0xd6})];
        out.push(...equipmentSnapshotFrames(true));
        out.push(...bagResyncFrames('equipment return',changed),...equipmentAttributeFrames());
        log(`${tag} equip bag ${bagSlot} -> position ${pos}; visible returns ${changed.join(',')}`);
        emitLive(out,`第${k}条 装备`);continue;
      }
      if(PLAYER_ACCOUNTS&&msgid===20512){
        const rb=S.byKey.get(`20512#${n}`);if(rb)done.add(rb.key);
        if(!accountOnline){inventoryNotice('请先完成账号登录。');continue;}
        if(economyFrozen()){inventoryNotice('账号存档待核对，暂不能读取个人资料。');continue;}
        try{
          const saved=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),account=process.env.DSH_PUBLIC_BETA==='1'?require('./public-beta/reference-world').projectAccount(saved,publicBetaWorldId):saved;
          emitLive([require('./player-profile-response').reply(account,f,{avatarPolicy:ACCOUNT_AVATAR_POLICY})],'account profile');
        }
        catch(error){log('Profile query rejected: '+error.message);inventoryNotice('个人资料尚未准备完成。');}
        armSafety();continue;
      }
      if (msgid === 11562) { // XTimeLimitSkinReq: u16 hero; migrated accounts use verified native layout.
        if(PLAYER_ACCOUNTS){
          if(!accountOnline){inventoryNotice('请先完成账号登录。');continue;}
          const rb=S.byKey.get(`11562#${n}`);if(rb)done.add(rb.key);
          try{emitLive([require('./player-skin-time').reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),f.subarray(12))],'account timed skins');}
          catch(error){log('Timed skin query rejected: '+error.message);}
          armSafety();continue;
        }
        const qslot = f.readUInt16LE(12);
        const p = Buffer.alloc(21); p.writeUInt16LE(qslot, 0);
        const rb = S.byKey.get(`11562#${n}`); if (rb) done.add(rb.key);      // 录制里那批就不重复发了
        const held = BAG && BAG.slotMap ? BAG.slotMap.get(qslot) : null;
        const nmQ = held && ITEM_NAMES && ITEM_NAMES[held.itemId] ? ITEM_NAMES[held.itemId].name : (held ? String(held.itemId) : '空格');
        log(`${tag}     11562 问格子${qslot}（模型里是 ${nmQ}）-> 回 11563（真服同款形态：格子号 + 19 个 0，flags=0xd2）`);
        emitLive([bagMod.mkFrame(11563, p, { flags: 0xd2 })], `${k} 11562 格子查询`);
        armSafety(); continue;
      }
      if (msgid === 9063) {                        // 使用道具
        log(`${tag}     使用道具 -> 生成 9064`);
        emitLive([bagMod.mkFrame(9064, Buffer.from('0101000000000000', 'hex'), { flags: 0xd6 })], `�?{k}�?使用道具`);
        continue;
      }
      if (msgid === 11541) { // First recharge gift query/claim, not a generic item acknowledgement.
        if(PLAYER_ACCOUNTS){
          const rb=S.byKey.get(`11541#${n}`);if(rb)done.add(rb.key);
          if(!accountOnline){inventoryNotice('请先完成账号登录。');continue;}
          try{
            const action=require('./player-vip-wire').firstGiftRequest(f);
            if(economyFrozen())throw Error('Economy frozen');
            const gift=require('./player-first-gift'),account=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid);
            if(action==='query'||gift.entitlement(account).status==='claimed'){
              emitLive([gift.reply(account)],'first recharge gift state');
            }else{
              const prepared=gift.prepare(account),delivery=prepareDelivery(prepared.rewards);
              if(!delivery)throw Error('First gift delivery cannot fit');
              const snapshot=economySnapshot();let granted;
              try{
                granted=grantToBag(delivery,0x0117,1,0xd2,true,false);
                const savers={bag:()=>saveBagLive(BAG.slotMap,true),equip:()=>saveEquipState(true),material:()=>saveMaterialLive(BAG.itemMap,true),resource:()=>saveResources(),wallet:()=>WALLET.save(true)};
                const steps=Object.entries(rewardPaths(delivery)).map(([name,file])=>({name,path:path.resolve(file),save:savers[name]}));
                steps.push({name:'player-accounts',path:PLAYER_ACCOUNTS.file,save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:prepared.revision},a=>gift.record(a,prepared))});
                if(!EQUIPMENT_COMMIT.run('first-recharge-gift',String(PLAYER_SCOPE.uid),steps))throw Error('Economy frozen');
              }catch(error){restoreEconomy(snapshot);throw error;}
              emitLive([...granted.frames,gift.reply(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid))],'first recharge gift committed');
            }
          }catch(error){log('First recharge gift request rejected: '+error.message);inventoryNotice('首充礼包暂不可领取，请检查领取资格、背包空间或存档状态。');}
          armSafety();continue;
        }
        emitLive([bagMod.mkFrame(11542, Buffer.alloc(4), { flags: 0xd6 })], `�?{k}�?11541 确认`);
        continue;
      }

      // ---- 这几条在「当前这份录制」里没有，但客户端会发；不回就会掉线 ----
      // 实测证据�?429 载荷 35 00 00（英雄ID 53），更早那份大厅录制�?1429 -> 1430，载荷原样回显�?      // 21:11:11 客户端发�?1429 而服务端没回，几秒后「Master逃离永恒之地…正在重新连接服务器」�?
      if (msgid === 1491) {
        // In the capture, 1491 acknowledges a server 1490 with no reply.
        // Echoing 1490 here made the client answer 1491 forever.
        armSafety();continue;
      }
      if (msgid === 1429) {
        log(`${tag}     1429 -> 生成 1430（原样回显）`);
        emitLive([bagMod.mkFrame(1430, Buffer.from(f.subarray(12)),
          { flags: f.readUInt16LE(10) })], `�?{k}�?1429`);
        armSafety();
        continue;
      }

      // ---- 商城购买（msgid 16811，格式见文件上方 SHOP 注释�?---
      if(msgid===16802){
        try{SHOP_CATALOG.reload();SHOP=SHOP_CATALOG.rows;emitLive([SHOP_CATALOG.frame()],'shop catalog request');}
        catch(error){log(`${tag} shop catalog unavailable: ${error.message}`);inventoryNotice('商城配置暂不可用，请稍后再试。');}
        armSafety();continue;
      }
      if(msgid===16823){
        const p=f.subarray(12),now=Math.floor(Date.now()/1000);
        if(p.length!==12){inventoryNotice('兑换请求格式不正确。');armSafety();continue;}
        const op=p.readUInt32LE(),index=p.readUInt32LE(4),item=p.readUInt32LE(8);
        try{SHOP_CATALOG.reload();SHOP=SHOP_CATALOG.rows;}
        catch(error){inventoryNotice('商城配置暂不可用，请稍后再试。');armSafety();continue;}
        const config=SHOP_CATALOG.exchange,revision=SHOP_CATALOG.exchangeRevision;
        const show=()=>{exchangeView=`${revision}:${SHOP_LIMIT_STATE.exchange?.generation}`;
          emitLive([exchangeShop.frame(config,SHOP_LIMIT_STATE.exchange,PLAYERID)],'exchange shop current state');};
        if(![0,1,2].includes(op)||!exchangeShop.available(config,now)){
          inventoryNotice('兑换商城未开放或操作无效。');armSafety();continue;
        }
        if(SHOP_LIMIT_STATE.pending){inventoryNotice('商城交易待核对，暂时无法兑换。');armSafety();continue;}
        // Persist each free timed/configuration rotation as well. A reconnect
        // must not reroll the catalog or restore consumed exchange limits.
        const previous=JSON.parse(JSON.stringify(SHOP_LIMIT_STATE)),snapshot=economySnapshot();
        try{
          let state=SHOP_LIMIT_STATE.exchange;
          if(!state||state.nextRefresh<=now||state.revision!==revision){
            state={...exchangeShop.rotate(config,state,now),revision};
            SHOP_LIMIT_STATE.exchange=state;
            if(!EQUIPMENT_COMMIT.run('shop-exchange-rotation','',[
              {name:'shop-limit',path:path.resolve(SHOP_LIMIT_FILE),save:saveShopLimit}]))throw Error('economy frozen');
            show();if(op!==0)inventoryNotice('兑换列表已刷新，请重新选择商品。');armSafety();continue;
          }
          if(op===0){show();armSafety();continue;}
          if(exchangeView!==`${revision}:${state.generation}`){show();inventoryNotice('兑换列表已更新，请重新选择商品。');armSafety();continue;}
          let delivery;
          if(op===1){
            delivery=prepareDelivery([],{debit:config.refreshCost?{attr:72,amount:config.refreshCost}:null});
            if(!delivery){inventoryNotice('钻石不足，无法刷新兑换列表。');show();armSafety();continue;}
            SHOP_LIMIT_STATE.exchange={...exchangeShop.rotate(config,state,now),revision};
          }else{
            const row=state.rows[index];
            if(!row||row.itemId!==item){inventoryNotice('兑换商品不匹配，请刷新列表。');show();armSafety();continue;}
            if(row.limit&&(state.counts[item]||0)>=row.limit){inventoryNotice('已达到本轮兑换上限。');show();armSafety();continue;}
            delivery=prepareDelivery([{itemId:item,count:row.count}],{debit:{attr:141,amount:row.price}});
            if(!delivery){inventoryNotice('兑换失败：莫比乌斯币不足、背包已满或道具未支持；未扣除货币。');show();armSafety();continue;}
            state.counts[item]=(state.counts[item]||0)+1;
          }
          const granted=grantToBag(delivery,0x0108,1,0xd3,true,false);
          const savers={bag:()=>saveBagLive(BAG.slotMap,true),equip:()=>saveEquipState(true),
            material:()=>saveMaterialLive(BAG.itemMap,true),resource:()=>saveResources(),wallet:()=>WALLET.save(true)};
          const steps=Object.entries(rewardPaths(delivery)).map(([name,file])=>({name,path:path.resolve(file),save:savers[name]}));
          steps.push({name:'shop-limit',path:path.resolve(SHOP_LIMIT_FILE),save:saveShopLimit});
          if(!EQUIPMENT_COMMIT.run(op===1?'shop-exchange-refresh':'shop-exchange-buy',String(item),steps))throw Error('economy frozen');
          emitLive([...granted.frames,...granted.paymentFrames],'exchange purchase committed');show();
          log(`${tag} exchange committed operation=${op} item=${item}`);
        }catch(error){
          restoreEconomy(snapshot);SHOP_LIMIT_STATE=previous;
          log(`${tag} exchange commit failed: ${error.message}`);
          inventoryNotice('兑换未完成：保存失败，交易已暂停，请联系管理员核对。');
        }
        armSafety();continue;
      }
      if (msgid === 16811) {
        const p = f.subarray(12);
        if(p.length!==18){log(`${tag} malformed shop request (${p.length} bytes)`);armSafety();continue;}
        const shelf = p.readUInt32LE(0), qty = p.readUInt16LE(4), curType = p.readUInt16LE(6), itemId = p.readUInt32LE(8);
        let catalogError=null;
        try{SHOP_CATALOG.reload();SHOP=SHOP_CATALOG.rows;}catch(error){catalogError='商城配置暂不可用';log(`${tag} shop config: ${error.message}`);}
        const row=SHOP.get(shelf),tail=p.readUInt32LE(14);
        const quoted=shopCatalog.quote(row,curType,qty,tail,SHOP_GOLD_DISCOUNT);
        const stale=shopRevision!==SHOP_CATALOG.revision;
        if(stale)emitLive([SHOP_CATALOG.frame()],'shop catalog changed');
        const invalid=catalogError||(stale?'商品信息已更新，请重新打开购买窗口':null)||(!row?'未知货架':row.itemId!==itemId?'商品与货架不符'
          :!qty||qty>255?'数量不合法':!itemId||itemId>=65535||p.readUInt16LE(12)!==0?'请求字段不合法'
          :quoted.error||shopLimitFailure(row,shelf,qty));
        if(invalid){
          log(`${tag} shop rejected: ${invalid} shelf=${shelf} item=${itemId} qty=${qty} currency=${curType}`);
          inventoryNotice(`购买失败：${invalid}。`);
          emitLive([mkShopReceipt(shelf,1)],'invalid shop request');armSafety();continue;
        }
        const {currency,amount:price}=quoted,attr=currency.attr;
        const nm=ITEM_NAMES?.[itemId]?.name||String(itemId),nmCur=currency.name;
        const balance=currency.resource?(RES[currency.resource]??0):currency.walletKey?WALLET?.state[currency.walletKey]:WALLET?.attrs?.[attr];
        const paymentFailure=!validCounter(balance)?'余额不可用':balance<price?'余额不足':null;
        if(paymentFailure){
          log(`${tag} shop rejected: ${paymentFailure} shelf=${shelf} item=${itemId} qty=${qty} currency=${curType}`);
          inventoryNotice(`购买失败：${paymentFailure}。`);
          emitLive([mkShopReceipt(shelf,1)],'shop payment rejected');armSafety();continue;
        }
        let entitlement=null;
        if(PLAYER_SCOPE?.heroWire){
          try{entitlement=heroRewards.prepare(PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),itemId,qty,`shop:${shelf}`);}
          catch(error){inventoryNotice(`购买失败：${error.message}，未扣除货币。`);emitLive([mkShopReceipt(shelf,1)],'hero shop rejected');armSafety();continue;}
        }
        const delivery = prepareDelivery(entitlement?[]:[{itemId,count:qty}], {debit:{...currency,amount:price}});
        if (!delivery) {
          const container=containerOf(itemId);
          const reason = container==='unknown'||container==='dedicated' ? '商品存放方式未确认'
            : container==='slot' ? '背包可见格或装备保留记录不足' : '交付数量或容器余额不合法';
          log(`${tag} shop rejected: ${reason} shelf=${shelf} item=${itemId} qty=${qty} visible=${BAG_CAPACITY} records=${BAG_SLOTS_FOR_FRAME}`);
          inventoryNotice(`购买失败：${reason}，未扣除货币。`);
          emitLive([mkShopReceipt(shelf,1)], 'shop grant rejected');armSafety();continue;
        }
        const snapshot=economySnapshot(),oldLimits=JSON.parse(JSON.stringify(SHOP_LIMIT_STATE));
        let granted;
        try{
          granted=grantToBag(delivery,0x0108,1,0xd3,true,false);
          const paths=rewardPaths(delivery),savers={bag:()=>saveBagLive(BAG.slotMap,true),equip:()=>saveEquipState(true),
            material:()=>saveMaterialLive(BAG.itemMap,true),resource:()=>saveResources(),wallet:()=>WALLET.save(true)};
          const steps=Object.entries(paths).map(([name,file])=>({name,path:path.resolve(file),save:savers[name]}));
          if(configuredShopLimit(row)){
            const key=shopCatalog.limitKey(row);SHOP_LIMIT_STATE.counts[key]=(SHOP_LIMIT_STATE.counts[key]||0)+qty;
            steps.push({name:'shop-limit',path:path.resolve(SHOP_LIMIT_FILE),save:saveShopLimit});
          }
          if(entitlement)steps.push({name:'player-accounts',path:PLAYER_ACCOUNTS.file,
            save:()=>PLAYER_ACCOUNTS.update(PLAYER_SCOPE.uid,{expectedRevision:entitlement.revision},a=>heroRewards.apply(a,entitlement))});
          if(!EQUIPMENT_COMMIT.run('shop-purchase',String(shelf),steps))throw Error('economy frozen');
        }catch(error){
          restoreEconomy(snapshot);SHOP_LIMIT_STATE=oldLimits;
          log(`${tag} shop commit failed: ${error.message}`);
          inventoryNotice('购买未完成：保存失败，交易已暂停，请联系管理员核对。');
          emitLive([mkShopReceipt(shelf,1)],'shop save failure');armSafety();continue;
        }
        const collectionFrames=[];
        if(entitlement){
          const current=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),options={flags:0xd3,stream:PLAYERID};
          if(entitlement.reward.index)collectionFrames.push(playerHeroes.skinNotice(current,entitlement.reward.hero,Date.now(),options));
          // 1338 runs the native hero-detail purchase refresh immediately.
          // Skins require an already-owned hero, so update that existing row
          // instead of rebuilding the collection while its detail page is open.
          collectionFrames.push(entitlement.reward.index?playerHeroes.incremental(current,[entitlement.reward.hero],Date.now(),options):playerHeroes.render(current,Date.now(),options));
        }
        emitLive([...granted.frames,...collectionFrames,mkShopReceipt(shelf,0),...granted.paymentFrames],'shop purchase committed',{trackHeroIncremental:true});
        log(`${tag} shop committed shelf=${shelf} item=${itemId} qty=${qty} currency=${curType} charge=${price}`);
        armSafety(); continue;
      }

      // ---- 邮件（msgid 20305/20306/20307，格式见文件上方 MAIL 注释�?---
      // ---- 邮件（20305 领附件 / 20306 看详情 / 20307 要列表）----
      // 真服实证（node mailpair.js / node mail11.js / node mail11rec.js，cap-2026-09-27T02-56-55）：
      //   C→S 20307 len=12（空载荷）        → S→C 20311 = 邮件列表（u32 0 | u32 条数 | 条数×邮件载荷）
      //   C→S 20306 len=16（u32 邮件id）    → S→C 20310 = 该封邮件（未领取=长帧 / 已领取=短帧）
      //   C→S 20305 len=17（u32 邮件id+u8） → 17015+17004 附件进背包 + 20310（已领取形态）
      //   S→C 20308 = 服务端主动推"有新邮件"（登录时），**不是列表**
      // 以前我们把列表做成一串 20308、还把 20306/20307 当成"领取" —— 两头都错，所以用户看到"邮件打不开"。
      if (msgid === 20303 || msgid === 20305 || msgid === 20306 || msgid === 20307) {
        reloadExtraMails('邮件交互');
        if(PLAYER_ACCOUNTS){
          const recorded=S.byKey.get(`${msgid}#${n}`);if(recorded)done.add(recorded.key);
          try{
            const request=rewardMail.request(f);
            if(request.operation==='list'){emitLive([mailList11Frame('owned mailbox request')],'owned mailbox request');armSafety();continue;}
            const view=mailboxView(),entry=view?.all.get(request.mailId);
            if(!entry){log(tag+' rejected mail ID outside current account');continue;}
            const id=entry.parentId;
            if(request.operation==='delete'){
              if(MAIL_STATE.hasPending(id)||(entry.hasAttachments&&!MAIL_STATE.hasClaimed(id)))throw Error('Mail attachments must be claimed before deletion');
              if(!MAIL_STATE.hasDeleted(id)&&!EQUIPMENT_COMMIT.run('reward-mail-delete',String(id),[{name:'mail-claims',path:path.resolve(MAIL_STATE_FILE),save:()=>MAIL_STATE.markDeleted(id,{hasAttachments:entry.hasAttachments})}]))throw Error('Mail storage is frozen');
              emitLive([...view.all.values()].filter(e=>e.parentId===id).map(e=>{const p=Buffer.alloc(4);p.writeUInt32LE(e.id);return bagMod.mkFrame(20309,p,{flags:0xd2});}),'owned mail deleted');continue;
            }
            const mf=view.frames(request.mailId);
            if(!mf){log(`${tag} rejected mail ID outside current account`);continue;}
            if(request.operation==='read'){
              // Reading has no economic delivery. SQLite includes this state
              // and its response in the same outer request transaction.
              if(!MAIL_STATE.hasRead(id)&&!EQUIPMENT_COMMIT.run('reward-mail-read',`${PLAYER_SCOPE.uid}:${id}`,
                [{name:'mail-claims',path:path.resolve(MAIL_STATE_FILE),save:()=>MAIL_STATE.markRead(id)}]))throw Error('Mail storage is frozen');
              emitLive([mailFrameAs(mf,MAIL_STATE.hasClaimed(id)?'claimed':'detail',20310)],'owned mail detail');
              setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_OWNED_MAIL_PUSH)refresh();});
              continue;
            }
            if(MAIL_STATE.hasClaimed(id)){emitLive([mailFrameAs(mf,'claimed',20310)],'already claimed owned mail');continue;}
            // Only explicit new reward mails can reach this unclaimed branch.
            // Legacy unread source imports have no current permission contract.
            if(!mf.reward)throw Error('Unclaimed legacy mail authority is unavailable');
            const rewards=resolveAttachments(mf.reward.attachments,ITEM_NAMES,currencyOfItem),delivery=rewards?prepareDelivery(rewards):null;
            if(!delivery){
              inventoryNotice('邮件附件未能全部发放，请整理背包后重新领取。');
              emitLive([mailFrameAs(mf,'detail',20310)],'owned mail attachments retained');
              continue;
            }
            const before=economySnapshot();let granted;
            try{
              granted=grantToBag(delivery,0x0117,1,0xd2,true,false);
              const savers={bag:()=>saveBagLive(BAG.slotMap,true),equip:()=>saveEquipState(true),
                material:()=>saveMaterialLive(BAG.itemMap,true),resource:()=>saveResources(),wallet:()=>WALLET.save(true)};
              const paths=rewardPaths(delivery),steps=Object.entries(paths).map(([name,file])=>({name,path:path.resolve(file),save:savers[name]}));
              steps.push({name:'mail-claims',path:path.resolve(MAIL_STATE_FILE),save:()=>{
                if(!MAIL_STATE.beginClaim(id,paths))throw Error('Mail claim is already in progress');
                MAIL_STATE.updatePending(id,'reward-files-saved');MAIL_STATE.finishClaim(id);
              }});
              if(!EQUIPMENT_COMMIT.run('reward-mail-attachment',`${PLAYER_SCOPE.uid}:${id}`,steps))throw Error('Mail storage is frozen');
            }catch(error){restoreEconomy(before);throw error;}
            emitLive([...granted.frames,mailFrameAs(mf,'claimed',20310)],'owned mail attachment committed');
            setImmediate(()=>{if(!economyFrozen())for(const refresh of LIVE_OWNED_MAIL_PUSH)refresh();});
          }catch(error){
            log(`${tag} owned mail request failed: ${error.message}`);
            inventoryNotice(economyFrozen()?'邮件存档待核对，已暂停领取。':error.message==='Mail attachments must be claimed before deletion'?'请先提取附件，再删除邮件。':'邮件操作未完成，附件已保留。');
          }
          armSafety();continue;
        }
        const p = f.subarray(12);
        const out = [];
        if ((msgid === 20307 && p.length !== 0) || ([20303,20306].includes(msgid) && p.length !== 4) ||
            (msgid === 20305 && (p.length !== 5 || p[4] !== 5))) {
          log(`${tag}     邮件 ${msgid} 载荷长度/参数错误（${p.length} 字节），拒绝`);
          armSafety(); continue;
        }
        if (msgid === 20307) {
          // Always answer: the client consumes its first list as silent
          // initialization. A subsequent user click can then open the panel.
          // 要列表 → 一条 20311（客户端据此渲染整个邮箱面板）
          out.push(mailList11Frame('邮件交互'));
        } else {
          const id = p.readUInt32LE(0);
          const mf = MAIL_STATE.hasDeleted(id)?null:mailFrames(id);
          if (!mf) {
            log(`${tag}     ⚠ 邮件 0x${id.toString(16)} 没有录制帧也没有生成帧，跳过`);
          } else if (msgid === 20303) {
            const attachments=EXTRA_MAILS.get(id>>>0)?.attach??MAIL_ATTACH[id];
            if(!MAIL_STATE.hasClaimed(id)&&(!Array.isArray(attachments)||attachments.length))inventoryNotice('请先提取附件，再删除邮件。');
            else try{MAIL_STATE.markDeleted(id,{hasAttachments:!!attachments?.length});out.push(bagMod.mkFrame(20309,p,{flags:0xd2}));}catch(error){inventoryNotice('邮件状态保存失败，请稍后重试。');}
          } else if (msgid === 20306) {
            // Reading persists independently of claiming; no reward path runs.
            try {
              MAIL_STATE.markRead(id);
              const claimed = MAIL_STATE.hasClaimed(id);
              out.push(mailFrameAs(mf, claimed ? 'claimed' : 'detail', 20310));
              log(`${tag}     邮件 0x${id.toString(16)} 详情 → 20310（${claimed ? '已领取' : '已读未领取'}形态）`);
            } catch (error) {
              log(`${tag}     邮件 0x${id.toString(16)} 已读状态保存失败：${error.message}`);
              inventoryNotice('邮件状态保存失败，请稍后重试。');
            }
          } else {
            // 20305 = 领取附件
            const already = MAIL_STATE.hasClaimed(id);
            if (already) {
              log(`${tag}     · 邮件 0x${id.toString(16)} 之前已领取过 → 只回详情，不重复发附件`);
            } else if (MAIL_STATE.hasPending(id)) {
              log(`${tag}     邮件 0x${id.toString(16)} 有未核对的领取提交，拒绝重复发放`);
              inventoryNotice('邮件领取状态待核对，请勿重复领取。');
            } else {
              const extraAtt = EXTRA_MAILS.get(id >>> 0);
              // Missing recorded mapping is not evidence of an empty mail.
              const attachments = extraAtt ? extraAtt.attach : MAIL_ATTACH[id];
              const rewards = resolveAttachments(attachments, ITEM_NAMES, currencyOfItem);
              const delivery = rewards ? prepareDelivery(rewards) : null;
              if (delivery) {
                const before = economySnapshot();
                let prepared = false, rewardFilesSaved = false;
                try {
                  if (!MAIL_STATE.beginClaim(id,rewardPaths(delivery))) throw new Error('claim already in progress');
                  prepared = true;
                  MAIL_STATE.updatePending(id,'reward-commit-started');
                  const granted = grantToBag(delivery, 0x0117, 1, 0xd2, true);
                  rewardFilesSaved = true;
                  MAIL_STATE.updatePending(id,'reward-files-saved');
                  MAIL_STATE.finishClaim(id);
                  out.push(...granted.frames);
                  log(`${tag}     邮件 0x${id.toString(16)}：${rewards.length} 项附件发放到 ${granted.placements.length} 格`);
                } catch (error) {
                  restoreEconomy(before);
                  if (prepared && MAIL_STATE.hasPending(id)) {
                    const stage = error.mailSaveContainer ? 'reward-save-failed'
                      : rewardFilesSaved ? 'reward-files-saved' : 'reward-commit-started';
                    try { MAIL_STATE.updatePending(id,stage,error.mailSaveContainer || null); }
                    catch (diagnosticError) { log(`${tag}     邮件诊断阶段保存失败：${diagnosticError.message}`); }
                  }
                  log(`${tag}     邮件 0x${id.toString(16)} 提交失败：${error.message}；pending=${MAIL_STATE.hasPending(id)}；失败容器=${error.mailSaveContainer || '未确认'}`);
                  inventoryNotice('邮件领取保存失败，请稍后核对状态。');
                }
              } else {
                const unsupported=rewards?.find(r=>r.itemId !== undefined &&
                  ['unknown','dedicated'].includes(containerOf(r.itemId)));
                inventoryNotice(unsupported ? '邮件附件含尚未确认存放位置的道具，附件已保留。'
                  : '邮件附件未能全部发放，请整理背包后重新领取。');
                log(`${tag}     邮件 0x${id.toString(16)}：附件预检失败，背包/钱包/领取状态均未修改`);
                out.push(mailFrameAs(mf, MAIL_STATE.hasRead(id) ? 'detail' : 'notify', 20310));
              }
            }
            if (MAIL_STATE.hasClaimed(id)) out.push(mailFrameAs(mf, 'claimed', 20310));
          }
        }
        log(`${tag}     邮件 ${msgid}：回 ${out.length} 帧`);
        emitLive(out, `第${k}条 邮件`);
        armSafety(); continue;
      }
      
      // ---- 销毁道具（msgid 17005）----
      // 真实服实证（logs/cap-2026-09-27T02-22-47 与 02-56-55，用户共销毁 9 次）：
      //   C→S 17005 len=24  载荷 = u16 序号(逐次+1) | u16 格子号 | u64 实例GUID
      //   S→C 17015 len=18  载荷 = u16 0x0102 | u16 道具ID | u16 数量        ← 销毁确认
      //   若该道具有"销毁返还"：紧随一条 1045 加金币（实证：破法拳套 26028 → +112）
      if (msgid === 17005) {
        const p = f.subarray(12);
        if (p.length < 12) continue;
        const seq = p.readUInt16LE(0), slot = p.readUInt16LE(2);
        const guid = p.length >= 12 ? p.subarray(4, 12).toString('hex') : '';
        const cur = BAG.slotMap.get(slot);
        if (slot >= BAG_CAPACITY || (cur && guid !== cur.guid) || equippedBagSlots().has(slot)) {
          log(`${tag} destroy rejected: stale instance, out-of-range or equipped item at ${slot}`);
          emitLive(bagResyncFrames('destroy rejected'), 'destroy rejected');
          armSafety(); continue;
        }
        if (!cur) {
          log(`${tag}     销毁 格子${slot} —— 模型里没有这一格（客户端布局不同步）→ 整份背包重推，把它拉回来`);
          emitLive(bagResyncFrames(`销毁格子${slot} 落空`), `第${k}条 销毁(落空)`);
          armSafety(); continue;
        }
        const itemId = cur.itemId, count = cur.count;
        const nm = ITEM_NAMES && ITEM_NAMES[itemId] ? ITEM_NAMES[itemId].name : String(itemId);
        BAG.slotMap.delete(slot);
        saveBagLive(BAG.slotMap);
        const pay = Buffer.alloc(6);
        pay.writeUInt16LE(0x0102, 0); pay.writeUInt16LE(itemId & 0xffff, 2); pay.writeUInt16LE(count & 0xffff, 4);
        const out = [bagMod.mkFrame(17015, pay, { flags: 0xd2 })];
        out.push(bagMod.mkFrame(17019, slotAck(0xffff, slot), {flags:0xd2}));
        const cleared = liveDetail(0x0f, slot, 0xffff, 0, Buffer.alloc(8));
        if (cleared) out.push(cleared);
        const unit = DESTROY_REFUND.get(itemId) || 0;
        if (unit > 0 && WALLET && WALLET.ok) {
          const refund = unit * count;
          const now = WALLET.addAttr(50, refund);
          for (const x of goldPushFrames(`销毁 ${nm}`, 50)) out.push(x);
          log(`${tag}     销毁 格子${slot} 的 ${nm}×${count}（GUID ${guid}）→ 返还金币 +${refund} = ${now}`);
        } else {
          log(`${tag}     销毁 格子${slot} 的 ${nm}×${count}（GUID ${guid}）→ 无返还`);
        }
        emitLive(out, `第${k}条 销毁道具`);
        armSafety(); continue;
      }

      // Native 10580 is platform reconnect, never an inventory operation.
      if(msgid===10580){armSafety();continue;}
      // XEquip_BagEquipSortAll -> d6e170 -> 17012, one-byte container.
      if(msgid===17012){
        const p=f.subarray(12);
        if(p.length!==1||p[0]!==0){log(tag+' unsupported sort container');armSafety();continue;}
        if(!BAG?.slotMap){armSafety();continue;}
        const sortSnapshot=economySnapshot();
        const before = new Map(BAG.slotMap);
        const entries = [...BAG.slotMap].filter(([s,v])=>s>=0 && s<BAG_CAPACITY && v && v.itemId && v.itemId!==65535)
          .sort((a,b)=>a[1].itemId-b[1].itemId || a[0]-b[0]);
        const remap = new Map();
        for (let s=0;s<BAG_CAPACITY;s++) BAG.slotMap.delete(s);
        entries.forEach(([from,v],to)=>{BAG.slotMap.set(to,v);remap.set(from,to);});
        const changedSlots = [];
        for (let s = 0; s < BAG_CAPACITY; s++) {
          const old = before.get(s), now = BAG.slotMap.get(s);
          if ((old?.itemId !== now?.itemId) || (old?.count !== now?.count) || (old?.guid !== now?.guid)) changedSlots.push(s);
        }
        if (!changedSlots.length) {
          log(`${tag}     ✓ 整理背包：当前布局已紧凑有序，无需重发背包数据`);
          armSafety(); continue;
        }
        const remapped = remapEquipRefs(remap);
        const steps=[{name:'sort-bag',path:BAG_LIVE,save:()=>saveBagLive(BAG.slotMap,true)}];
        if(remapped.length)steps.push({name:'sort-equip',path:EQUIP_STATE_FILE,save:()=>saveEquipState(true)});
        try{if(!EQUIPMENT_COMMIT.run('inventory-sort','',steps))throw Error('Inventory sort storage frozen');}
        catch(error){restoreEconomy(sortSnapshot);log(tag+' inventory sort failed: '+error.message);inventoryNotice('整理未完成：存档待核对，请稍后再试。');armSafety();continue;}
        const out = bagResyncFrames('compact inventory', changedSlots);
        for (const pos of remapped) {
          const e=planEntry(pos);
          const frame=equipFrame(pos,e.bagSlot,e.itemId,e.count,e.guid);
          if(frame)out.push(frame);
        }
        emitLive(out,'sort inventory');
        armSafety(); continue;
      }
      // ---- 17003：**真人客户端拖拽"两个物品调换位置"**（本轮实证，见 PHASE_NOTES 第十六轮）----
      // 实证：2026-09-27 06:46/06:53/06:55 用户拖拽 10 次，每次一条 `C→S 17003 len=26（载荷 14 字节）`：
      //   载荷 = float32(拖拽时的屏幕坐标，与我们无关) | u16 序号 | u8 0 | u8 格子A | u16 0 | u8 格子B | u8 0 | u16 标志
      //   例：`00 00 83 43 | 20 00 | 00 | 50 | 00 00 | 37 | 00 | 01 00`
      //       → 序号32、格子A=80(梦想手电×1)、格子B=55(护身匕首×1)
      //   06:46 那三条的序号是 10/11/12 连续递增，和"一秒拖一次"完全吻合 → 字段位置可信。
      // 处理：对 A/B 两格做"交换或搬运"（都有就换、一边空就搬），再回两条 17004 让客户端和服务端对齐。
      if (msgid === 17003) {
        const pay = Buffer.from(f.subarray(12));
        if (pay.length >= 12 && BAG && BAG.slotMap) {
          // 格子号按 **u16 小端**读（字节7..8 / 字节10..11）：客户端实测的 56/63/80/55 在低字节，
          // 高位恒 0；用 u16 读才能表达 255 以上的格子（背包有 552 格）。
          const A = pay.readUInt16LE(7), B = pay.readUInt16LE(10);
          const seqNo = pay.length >= 6 ? pay.readUInt16LE(4) : -1;
          const flag = pay.length >= 14 ? pay.readUInt16LE(12) : -1;
          const va = BAG.slotMap.get(A), vb = BAG.slotMap.get(B);
          const nmOf = v => v ? (ITEM_NAMES && ITEM_NAMES[v.itemId] ? ITEM_NAMES[v.itemId].name : String(v.itemId)) : '空';
          const nmA = nmOf(va), nmB = nmOf(vb);
          const cap = BAG_CAPACITY;
          log(`${tag}     ★17003 = 拖拽调换位置（真客户端实证）：格子${A}「${nmA}」 ←→ 格子${B}「${nmB}」`
            + `  序号${seqNo} 标志${flag}  载荷 ${pay.toString('hex')}`);
          // ---- 护栏（宁可不动，也不要瞎动模型）----
          if (A === B) {
            log(`${tag}        两个格子号相同 → 不动`);
          } else if (A >= cap || B >= cap) {
            log(`${tag}        格子号越界（容量 ${cap}）→ 不动，只留证据（客户端布局可能已经乱，等它重登）`);
          } else if (!va && !vb) {
            log(`${tag}        模型里两格都是空的 → 不动（不瞎猜）`);
          } else {
            const out = [];
            // 道具搬走之后，"装备栏引用的那格"要跟着道具走：**只映射真正装东西的那一格**
            //  （两格都有 → 两边都映射；一格空 → 只把"有货那格"映射到"空格"那格）。
            // 全量双向映射是错的：逆向那条会把"装备位引用的空格"改指到另一格去。
            const remap = new Map();
            if (va && vb) { BAG.slotMap.set(A, vb); BAG.slotMap.set(B, va); remap.set(A, B); remap.set(B, A); }
            else if (va && !vb) { BAG.slotMap.set(B, va); BAG.slotMap.delete(A); remap.set(A, B); }
            else { BAG.slotMap.set(A, vb); BAG.slotMap.delete(B); remap.set(B, A); }
            saveBagLive(BAG.slotMap);
            // 装备栏引用的背包格子跟着换（否则"装备面板上那件"会指向别人的格子）
            const remapped = remapEquipRefs(remap);
            if (remapped.length) saveEquipState();
            if (remapped.length) log(`${tag}        装备栏引用跟着搬了 ${remapped.length} 个（装备位 -> 新的背包格）`);
            for (const s of [A, B]) {
              const v = BAG.slotMap.get(s);
              const fr = v
                ? liveDetail(0x0F, s, v.itemId, v.count, v.guid ? Buffer.from(v.guid, 'hex') : synthGuid(s, v.itemId))
                : liveDetail(0x0F, s, 0xFFFF, 0, Buffer.alloc(8));
              if (fr) out.push(fr);
            }
            for (const pos of remapped) {
              const e=planEntry(pos),frame=equipFrame(pos,e.bagSlot,e.itemId,e.count,e.guid);
              if(frame)out.push(frame);
            }
            log(`${tag}        模型已跟着换：格子${A}=「${nmB}」，格子${B}=「${nmA}」（回 2 条 17004 对齐客户端`
              + `${remapped.length ? `；装备栏引用跟着改 ${remapped.length} 个` : ''}）`);
            try {
              fs.appendFileSync(path.join(LOG_DIR, 'unknown-requests.jsonl'), JSON.stringify({
                t: ts(), msgid, len: pay.length, payload: pay.toString('hex'),
                实证: '拖拽调换位置（字节7=格子A(u16)、字节10=格子B(u16)、字节4-5=序号）', 已执行: true,
                动作: `格子${A}「${nmA}」<-> 格子${B}「${nmB}」` + (remapped.length ? `（装备栏引用改 ${remapped.length}）` : ''),
              }) + '\n');
            } catch { }
            emitLive(out, `第${k}条 17003(拖拽)`);
          }
          armSafety(); continue;
        }
      }
      // ---- 疑似"两个物品调换位置"（形状推断 + 严格护栏）----
      if (!economyFrozen() && argOf('bag-guess-swap', 'off') === 'on' && !UI_NOISE_MSGS.has(msgid) && !S.reqLog.some(r => r.msgid === msgid)) {
        const pay = Buffer.from(f.subarray(12));
        const cap = BAG_CAPACITY;
        if (pay.length === 4) {
          const a = pay.readUInt16LE(0), b2 = pay.readUInt16LE(2);
          const va = BAG && BAG.slotMap ? BAG.slotMap.get(a) : null;
          const vb = BAG && BAG.slotMap ? BAG.slotMap.get(b2) : null;
          if (a !== b2 && a < cap && b2 < cap && va && vb) {
            BAG.slotMap.set(a, vb); BAG.slotMap.set(b2, va);
            saveBagLive(BAG.slotMap);
            const remapped=remapEquipRefs(new Map([[a,b2],[b2,a]]));
            if(remapped.length)saveEquipState();
            const nmA = ITEM_NAMES && ITEM_NAMES[va.itemId] ? ITEM_NAMES[va.itemId].name : String(va.itemId);
            const nmB = ITEM_NAMES && ITEM_NAMES[vb.itemId] ? ITEM_NAMES[vb.itemId].name : String(vb.itemId);
            log(`${tag}     ★ 疑似调换位置（msgid=${msgid}）：格子${a}「${nmA}」 <-> 格子${b2}「${nmB}」（按形状推断，--bag-guess-swap=off 可关）`);
            const out = [];
            const fa = liveDetail(0x0F, a, vb.itemId, vb.count, vb.guid ? Buffer.from(vb.guid, 'hex') : synthGuid(a, vb.itemId));
            const fb = liveDetail(0x0F, b2, va.itemId, va.count, va.guid ? Buffer.from(va.guid, 'hex') : synthGuid(b2, va.itemId));
            if (fa) out.push(fa);
            if (fb) out.push(fb);
            for(const pos of remapped){const e=planEntry(pos),frame=equipFrame(pos,e.bagSlot,e.itemId,e.count,e.guid);if(frame)out.push(frame);}
            try {
              fs.appendFileSync(path.join(LOG_DIR, 'unknown-requests.jsonl'), JSON.stringify({
                t: ts(), msgid, len: 4, payload: pay.toString('hex'),
                疑似: `调换位置：格子${a} <-> 格子${b2}`, 已执行: true, 动作: `${nmA} <-> ${nmB}`,
              }) + '\n');
            } catch { }
            emitLive(out, `${k} 调换位置`);
            armSafety(); continue;
          }
        }
      }
      // ---- `1016`：录制里**没有**这条请求（11 份抓包里客户端都是发 1012 进游戏）----
      // 真人客户端实测：登录后收到 1287（角色列表），紧接着发 `1016`（59 字节）——
      //   载荷 = `00 00 | <账号UID u32> | 客服<毫秒计数 9~10 位> | 00… | 01 | 00… | 40 4e(服号20032) | …`
      //   形状和 1287 里**每条角色记录**几乎一样（角色名 14 字节处也是 `d3cebfcd`+"数字"），
      //   且那个数字两次登录相差 394454，正好等于两次相隔的 395 秒（毫秒计数）。
      // ⇒ 现在的处理：**当成"进游戏"**，回放录制里 `1012#1` 那批（客户端日志会给出通过标准：
      //   `LoginSuccess Begin` / `CreateMe playerid = …`）。这一步是**实验**，见
      //   README_MATCH_NEXT.md「1016 怎么处理」。
      if (msgid === 1016 && argOf('treat-1016', 'as-1012') !== 'off') {
        const pay = Buffer.from(f.subarray(12));
        const uid = pay.length >= 6 ? pay.readUInt32LE(2) : 0;
        const alias = S.byKey.get('1012#1');
        if (alias) {
          log(`${tag}     1016（录制里没有）= 登录后"进游戏"，按 1012#1 那批回（UID 0x${uid.toString(16)}）`);
          emitBatch(alias, `${k} 1016→1012#1`);
          armSafety(); continue;
        }
        log(`${tag}     1016：录制里连 1012#1 都没有 → 没法当别名处理`);
      }
      // ---- 已确认"客户端只上报、真服也不回"的请求：明确当成已知，别记成"未实现" ----
      // 判据：① 11 份抓包里出现过、**没有任何应答帧**（`node msgscount.js`）；
      //       ② 或真人会话里紧跟在同一批 UI 操作里、后面就接心跳（`node reqnb.js 17012`）。
      // 这么做的好处：这些动作不再触发 6000ms 兜底批次（兜底会推心跳/普通推送，
      // 在"装备栏刚变"的上下文里推帧会让客户端画错），也不再往证据文件里灌噪音。
      if (SILENT_NOTIFY.has(msgid)) {
        const pay = Buffer.from(f.subarray(12));
        log(`${tag}     · ${msgid}（` + (SILENT_NOTIFY.get(msgid) || '已知单向通知') + `）len=${pay.length} —— 真服也不回应答，记一笔就过`);
        armSafety(); continue;
      }
      // ---- 只有"录制里从未出现过"的请求才算我们没实现：落盘证据 + 标疑似形状 ----
      if (!S.reqLog.some(r => r.msgid === msgid)) try {
        const pay = Buffer.from(f.subarray(12));
        let guess = '';
        if (pay.length === 0) guess = '空载荷：纯 UI 动作 / 或"整理"（等实证，别当成已知）';
        else if (pay.length === 4) {
          const a = pay.readUInt16LE(0), c = pay.readUInt16LE(2);
          if (a < 600 && c < 600) guess = `疑似"调换位置"：格子${a} <-> 格子${c}`;
        } else if (pay.length === 2) {
          const a = pay.readUInt16LE(0);
          if (a < 600) guess = `疑似"对某一格做动作"：格子${a}`;
        }
        recentReqs.push(`${msgid}#${n}`); if (recentReqs.length > 20) recentReqs.shift();
        fs.appendFileSync(path.join(LOG_DIR, 'unknown-requests.jsonl'), JSON.stringify({
          t: ts(), msgid, len: pay.length, payload: pay.toString('hex'), 疑似: guess,
          最近请求: recentReqs.slice(-5), 最近发出的帧: lastSentFrames.slice(-5),
          背包格数: (BAG && BAG.slotMap) ? BAG.slotMap.size : null,
        }) + '\n');
        log(`${tag} <<< 未实现 msgid=${msgid} len=${pay.length} payload=${hx(pay, 48)}${guess ? '  ★' + guess : ''}`);
      } catch { }
      // First/new hero previews still receive the captured world initialization.
      // Reopening the same equipment page only needs the current six references.
      if(msgid===23513 && roleReadyAt && !inMatch && f.length===15){
        const profession=f.readUInt16LE(12);if(profession>0&&profession<1000)lobbyVisualProfession=profession;
        // The third byte is the client-local equipment plan selector (0..2).
        // XBagChangeSendMsg changes the active view without a separate c2s
        // frame, so persist and publish it when the native preview arrives.
        if (f[14] <= 2 && selectEquipmentPlan(f[14])) {
          emitLive([...currentEquipmentFrames(), ...equipmentAttributeFrames(true)], 'selected equipment plan');
        }
        const previewKey=f.subarray(12).toString('hex');
        if(equipmentPreviewKey&&previewKey.slice(0,4)===equipmentPreviewKey.slice(0,4)){
          equipmentPreviewKey=previewKey;
          if(S.byKey.has(`${msgid}#${n}`))done.add(`${msgid}#${n}`);
          emitLive([...currentEquipmentFrames(),...equipmentAttributeFrames(true)],
            'current equipment panel');
          armSafety();continue;
        }
        equipmentPreviewKey=previewKey;
      }
      let b = S.byKey.get(`${msgid}#${n}`);
      if (!b && S.repeatable.has(msgid)) {
        // 只有「每次应答都一样」的请求才允许回退（心跳、轮询这类）�?
        const first =
        S.byKey.get(`${msgid}#1`);
        if (first && first.frames.length <= 3) {
          b = first;
          log(`${tag}     · 录制�?${msgid} 只有 ${[...S.byKey.keys()].filter(x => x.startsWith(msgid + '#')).length} 次，回退发第 1 次（该请求的应答每次都一样）`);
        }
      } else if (!b && !S.repeatable.has(msgid) && S.byKey.has(`${msgid}#1`)) {
        log(`${tag}     �?${msgid} 的应答是「每次不同」的，超出录制长度后没法�?—�?逻辑没写`);
      }
      if (b) emitBatch(b, `�?{k}条请�?${msgid}#${n}`);
      else if (!S.reqLog.some(r => r.msgid === msgid))
        log(`${tag}     �?请求 ${msgid} 在录制里从未出现 —�?逻辑没写（需要新的录制）`);
      else
        log(`${tag}     · 该请求在录制里没有对应应答段（本来就不需要应答，或录制不够长）`);
      if (msgid === 23513 && roleReadyAt && !inMatch)
        emitLive([...currentEquipmentFrames(),...equipmentAttributeFrames(true)],
          'equipment panel snapshot and attributes');
      armSafety();
    }
  }
  sock.on('close',()=>{
    if(!accountOnline)return;
    try{
      if(economyFrozen()){
        PLAYER_ONLINE.forget(PLAYER_SCOPE.uid,sock);
      }else PLAYER_ONLINE.disconnect(PLAYER_SCOPE.uid,sock);
    }catch(error){PLAYER_ONLINE.forget(PLAYER_SCOPE.uid,sock);log('Online disconnect save failed: '+error.message);}
  });
  const gemRemovals=new(require('./gem-removal-batch').GemRemovalBatch)({frameOf:fr=>fr.raw,deliver:decoded=>{
    if(sock.destroyed)return;
    if(!require('./persistence/state-files').enabled()){onData(decoded);return;}
    const accountUidBefore={...ACCOUNT_UID};
    const cachesBefore=sqliteCacheSnapshot();
    pendingWire=[];
    try{
      require('./persistence/state-files').transaction('native-request-batch',[],()=>onData(decoded));
      const frames=pendingWire;pendingWire=null;for(const bytes of frames)if(!sock.destroyed)sendWire(bytes);
    }catch(error){
      restoreSqliteCaches(cachesBefore);
      for(const key of Object.keys(ACCOUNT_UID))delete ACCOUNT_UID[key];
      Object.assign(ACCOUNT_UID,accountUidBefore);
      if(pendingWire)for(const bytes of pendingWire)heroDelivery?.discard(bytes);
      pendingWire=null;log(`${tag} SQLite request rolled back; runtime writes frozen: ${error.message}`);sock.destroy();
    }
  }});
  sock.on('data',d=>gemRemovals.push(dec.push(d)));
  sock.on('end', () => {gemRemovals.close();log(`${tag} 对端 FIN  (${((Date.now() - t0) / 1000).toFixed(1)}s, 已发 ${sent}/${S.totalFrames} �? 兜底 ${safetyHits} �?`);});
  sock.on('error', e => {gemRemovals.close();log(`${tag} 错误 ${e.code || ''} ${e.message}`);});
  sock.on('close', () => { gemRemovals.close();LIVE_CURRENCY_PUSH.delete(pushGmCurrency); LIVE_MAIL_PUSH.delete(pushGmMail); LIVE_TITLE_PUSH.delete(pushTitle); LIVE_PERSONAL_SETTINGS_PUSH.delete(pushPersonalSettings); clearInterval(titleTimer); clearTimeout(safetyTimer); log(`${tag} 关闭  持续 ${((Date.now() - t0) / 1000).toFixed(1)}s  �?${k} �? �?${sent} �? 兜底 ${safetyHits} 次`); });
}

log('='.repeat(72));
log(`liveserver.js  数据�?${path.basename(CAP)} (${S.mode})`);
log(`端口 ${PORTS.join(', ')}   兜底静默 ${SAFETY}ms   账号替换 ${PATCH_ACCT ? '开' : '关'}   背包生成 ${BAG ? '开' : '关'}${BAG ? `   未知格子=${BAG_UNKNOWN}` : ''}`);
log(`录制：${S.reqLog.length} 条客户端请求 -> ${S.batches.length} 批 -> ${S.totalFrames} 帧服务端应答`);
log(`通过标准：客户端能完成下一步操作`);
log('='.repeat(72));

log(`State storage backend: ${stateBackend.mode}${stateBackend.scope?' scope='+stateBackend.scope:''}`);
if(stateBackend.mode==='sqlite'&&require('./persistence/state-files').frozen()){
  require('./persistence/state-files').close();
  throw Error('Startup state write failed; refusing to open service listeners');
}
const servers = PORTS.map(port => {
  const s = net.createServer(sock => handle(sock, port));
  s.on('error', e => log(`[${port}] !! ${e.code} ${e.message}`));
  s.listen(port, runtimeOptions.host, () => log(`[${s.address().port}] 已监听`));
  return s;
});
const gmPortArg = argOf('gm-port', '');
let gmServer = null;
if (gmPortArg !== '') {
  const gmPort = Number(gmPortArg);
  const localFile = (key, fallback) => {
    const file = argOf(key, fallback);
    return path.isAbsolute(file) ? file : path.join(__dirname, file);
  };
  gmServer = require('./gm-tool').startGmTool({
    port:gmPort,tokenFile:localFile('gm-token-file','gm-token.txt'),
    auditFile:localFile('gm-audit-file','gm-audit.jsonl'),mailFile:MAIL_EXTRA_FILE,
    wallet:WALLET,itemNames:ITEM_NAMES,
    mailExists:id=>EXTRA_MAILS.has(id) || !!(MAIL && MAIL['0x'+id.toString(16)]),
    reloadMail:reloadExtraMails,isFrozen:()=>economyFrozen(),
    onCurrency:(attr,value)=>{for(const push of LIVE_CURRENCY_PUSH) push(attr,value);},log,
    onMail:id=>{
      let sent=false;for(const push of LIVE_MAIL_PUSH) if(push(id)) sent=true;
      if(sent) MAIL_STATE.markNotified(id);
    },
  });
}
function publicBetaContext(){
  if(process.env.DSH_PUBLIC_BETA!=='1'||!PLAYER_SCOPE)throw Error('Local test control is not enabled');
  return {enabled:true,uid:PLAYER_SCOPE.uid,playerId:PLAYER_SCOPE.playerId,store:PLAYER_ACCOUNTS,commit:EQUIPMENT_COMMIT,
    isFrozen:()=>economyFrozen()||!!(battleOwnership.filePath()&&require('node:fs').existsSync(battleOwnership.filePath())&&!battleOwnership.read()),inBattle:()=>battleOwnership.read()?.active===true,wallet:WALLET,walletPath:path.resolve(process.env.DSH_GOLD_STATE||path.join(__dirname,'gold-state.json')),
    rune:PROGRESSION.rune,refreshLimitedGodsend:()=>{for(const push of LIVE_PUBLIC_BETA_PUSH){push.pushFrame(liveGodsendFilterInfoAck());push.pushFrame(liveRuneDeterminationAck(11854));}},
    occupiedMailIds:()=>{
      const account=PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid),claims=MAIL_STATE.snapshot();
      return [...new Set([...['claimed','read','notified','deleted','pending'].flatMap(k=>claims[k]||[]),
        ...Object.keys(account.rewardMailState?.mails||{}).map(Number),...require('./player-reward-mail').retiredMailIds(account),
        ...Object.values(account.publicBetaGmState?.events||{}).filter(v=>v.kind==='gm-mail').map(v=>v.mailId)])];
    },notifyMail:()=>{for(const push of LIVE_OWNED_MAIL_PUSH)push();},pushCurrency:(attr,value)=>{for(const push of LIVE_CURRENCY_PUSH)push(attr,value);},
    pushFrame:frame=>{for(const push of LIVE_PUBLIC_BETA_PUSH)push.pushFrame(frame);},now:()=>Date.now()};
}
if(process.env.DSH_PUBLIC_BETA==='1'&&process.connected){
  process.on('message',message=>{
    if(message?.type!=='public-beta-request')return;
    if(message.uid!==PLAYER_SCOPE?.uid||typeof message.requestId!=='string'||!message.payload)return;
    try{
      const context=publicBetaContext(),payload=message.payload;
      const result=payload.operation==='status'?{wallet:{...WALLET.attrs},vip:PLAYER_ACCOUNTS.get(PLAYER_SCOPE.uid).vip.level}:
        payload.operation==='limited-godsend-status'?require('./public-beta/limited-godsend').info(PROGRESSION.rune.state):
        ['reset-limited-godsend','close-limited-godsend'].includes(payload.operation)?require('./public-beta/limited-godsend').API(context,payload):
        ['recharge','reset-first-gift'].includes(payload.operation)?require('./public-beta/recharge').execute(context,payload):require('./public-beta/gm-operations').API(context,payload);
      process.send({type:'public-beta-result',requestId:message.requestId,uid:PLAYER_SCOPE.uid,ok:true,result});
    }catch(error){process.send({type:'public-beta-result',requestId:message.requestId,uid:PLAYER_SCOPE.uid,ok:false,error:error.message,uncertain:economyFrozen()});}
  });
}
require('./runtime/lifecycle').installLifecycle({servers,extraServers:()=>[gmServer],log,
  onReady:ports=>{if(process.connected)process.send({type:'runtime-ready',service:'lobby',ports});}});
