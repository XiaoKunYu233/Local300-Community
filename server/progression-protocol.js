'use strict';
// Small, length checked adapters for the live client requests.  The gameplay
// state machines intentionally accept plain objects; this layer keeps native
// byte layout concerns at the edge and can be used by liveserver or a replay
// harness without duplicating economy logic.
const u16 = (p, o) => p.length >= o + 2 ? p.readUInt16LE(o) : null;
const u32 = (p, o) => p.length >= o + 4 ? p.readUInt32LE(o) : null;
const runeCustomizeRows = require('./logs/cfg/charmcustomize.json');
const GBK = require('./gbk');
const RUNE_SLOT_COUNT = 48;
// The native 11679 board stores a fixed 16-byte GBK page name.  Chinese
// names therefore must not be classified as the legacy onlyId layout.
const isRuneNameByte = (value, index, bytes) => {
  if (value >= 0x20 && value <= 0x7e) return 1;
  if (value >= 0x81 && value <= 0xfe && index + 1 < bytes.length) {
    const trail = bytes[index + 1];
    return trail >= 0x40 && trail <= 0xfe && trail !== 0x7f ? 2 : 0;
  }
  return 0;
};
const isNamedRuneBoard = payload => {
  if (!Buffer.isBuffer(payload) || payload.length !== 209) return false;
  if (payload[0] > 7) return false;
  const name = payload.subarray(1, 17);
  let used = false, terminated = false;
  for (let index = 0; index < name.length;) {
    const value = name[index];
    if (terminated) { if (value !== 0) return false; index++; continue; }
    if (value === 0) { terminated = true; index++; continue; }
    const width = isRuneNameByte(value, index, name);
    if (!width) return false;
    used = true; index += width;
  }
  return used;
};
const ids32 = p => { const a = []; for (let o = 0; o + 4 <= p.length; o += 4) { const id = p.readUInt32LE(o); if (id && id !== 0xffffffff) a.push(id); } return a; };
const words = p => { const a = []; for (let o = 0; o + 4 <= p.length; o += 4) a.push(p.readUInt32LE(o)); return a; };
const ids64 = p => { const a = []; for (let o = 0; o + 8 <= p.length; o += 8) { const id = p.subarray(o, o + 8).toString('hex'); if (!/^0+$/.test(id) && !/^f{16}$/i.test(id)) a.push(id); } return a; };
const guidHex = (p, offset = 0) => p.length >= offset + 8 ? p.subarray(offset, offset + 8).toString('hex') : '';
// PBMsgDef carries the newer magic-gem requests in field 10.  The legacy
// magic-gem messages above are fixed-width, while these requests are normal
// protobuf and can be present on a generic message tag.  Keep this decoder
// deliberately small: it only accepts a complete PBMsgDef/PBMagicGems shape
// and therefore cannot steal unrelated binary requests from liveserver.
function parseMagicGemProtobuf(payload) {
  if (!Buffer.isBuffer(payload) || !payload.length) return null;
  let P;
  try { P = require('./battle-protobuf'); } catch { return null; }
  const asNumber = value => { try { const n = Number(value); return Number.isSafeInteger(n) ? n : null; } catch { return null; } };
  const asGuid = value => {
    try { const n = BigInt(value); if (n <= 0n || n > 0xffffffffffffffffn) return ''; const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b.toString('hex'); } catch { return ''; }
  };
  const scalar = (fields, number) => fields.find(f => f.number === number && f.wire === 0)?.value;
  const scalars = (fields, number) => fields.filter(f => f.number === number && f.wire === 0).map(f => f.value);
  // The native mask addresses all eight gem lanes: ordinary 0..4, advanced
  // 5..7. Also accept the full Lua vector and protobuf packed repeated form.
  const packedScalars = (fields, number) => {
    const values = scalars(fields, number);
    for (const field of fields.filter(f => f.number === number && f.wire === 2)) {
      let offset = 0;
      while (offset < field.bytes.length) {
        let value = 0n, shift = 0n;
        for (let i = 0; i < 10 && offset < field.bytes.length; i++) {
          const byte = field.bytes[offset++];
          value |= BigInt(byte & 0x7f) << shift;
          if (!(byte & 0x80)) { values.push(value); break; }
          shift += 7n;
        }
      }
    }
    return values;
  };
  const bytes = (fields, number) => fields.find(f => f.number === number && f.wire === 2)?.bytes;
  const decode = source => { try { return P.decode(source); } catch { return null; } };
  const outer = decode(payload); if (!outer) return null;
  // PBMagicGems is specifically PBMsgDef field 10.  Do not fall back to the
  // outer message: every other protobuf packet can contain a field 1 nested
  // message and would otherwise be misclassified as a magic-gem request.
  const wrapped = bytes(outer, 10); if (!wrapped) return null;
  const inner = decode(wrapped);
  if (!inner) return null;
  const nested = (field, operation, map) => {
    const body = bytes(inner, field), fields = body && decode(body); if (!fields) return null;
    const result = { system: 'magicGem', operation };
    for (const [key, number] of Object.entries(map)) {
      const value = operation === 'wash' && key === 'locks' ? packedScalars(fields, number) : scalar(fields, number);
      if (value === undefined) continue;
      const outputKey = key === 'oper' ? 'operationCode' : key;
      result[outputKey] = operation === 'wash' && key === 'locks'
        ? value.map(asNumber)
        : /guid|gemid/i.test(key) ? asGuid(value) : asNumber(value);
    }
    return result;
  };
  const result = nested(1, 'openGraph', { circuitId: 1 })
    || nested(2, 'openGraphHole', { circuitId: 1, slotId: 2 })
    || nested(3, 'refine', { gemId: 1 })
    || nested(4, 'wash', { gemId: 1, locks: 2, oper: 3 })
    || nested(5, 'direction', { gemId: 1, materialItemId: 2, oper: 3 })
    || nested(6, 'setGraph', { deviceGuid: 1, circuitId: 2 })
    || nested(15, 'setPityAttr', { pityId: 1, pityAttrId: 2 })
    || nested(16, 'lock', { gemId: 1, oper: 2 });
  if(result) Object.defineProperty(result, 'nativeEcho', {value: Buffer.from(wrapped), enumerable:false});
  if (!result && scalar(inner, 7) !== undefined) {
    const query={system:'magicGem',operation:'getGraphs'};
    // Query replies retain only the native query flag, never client-supplied
    // graph/result fields. This is a read, not an ownership import.
    Object.defineProperty(query,'nativeEcho',{value:P.encode([{number:7,wire:0,value:scalar(inner,7)}]),enumerable:false});
    return query;
  }
  if (result?.operation === 'wash') {
    const raw = Array.isArray(result.locks) ? result.locks : [];
    let flags=0;
    if (raw.length <= 1) {
      flags = Number(raw[0] || 0);
    } else if ([5,8].includes(raw.length) && raw.every(value => value === 0 || value === 1)) {
      flags = raw.reduce((mask,value,index)=>mask|(value<<index),0);
    } else {
      flags = raw.reduce((mask, value) => mask | (Number(value) || 0), 0);
    }
    const advanced=[2,4].includes(result.operationCode),offset=advanced?5:0,count=advanced?3:5;
    // Apply/cancel may echo the previous advanced mask; they do not roll or
    // charge locks, and their opcode does not identify a lane group.
    const building=[1,2,3,4].includes(result.operationCode);
    if(raw.some(v=>!Number.isInteger(v)||v<0||v>255)||(building&&(flags&~(advanced?224:31))))result.invalidNativeLocks=true;
    result.locks=Array.from({length:count},(_,i)=>i).filter(i=>flags&(1<<(offset+i)));
  }
  return result;
}

// Build the small PBMsgDef response used by the magic-gem client.  Keeping
// this encoder beside the request decoder avoids replaying stale graph/gem
// snapshots after a successful live operation.
function magicAttrLanes(attrs){return Array.from({length:8},(_,i)=>attrs?.[i]||{attrClass:0,attrId:0,value:0,setId:0,setLevel:0});}
function magicCandidateLanes(gem){
  const lanes=magicAttrLanes();
  if(gem.wash?.candidate)gem.wash.candidate.forEach((a,i)=>{lanes[(gem.wash.advanced?5:0)+i]=a;});
  return lanes;
}
function magicGemResponsePayload(state, request = {}, result = {}) {
  const P = require('./battle-protobuf');
  const vf = (number, value) => ({ number, wire: 0, value: BigInt(Math.max(0, Number(value) || 0)) });
  const bytes = (number, value) => ({ number, wire: 2, bytes: value });
  const u64 = value => { try { return typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value) ? Buffer.from(value, 'hex').readBigUInt64LE() : BigInt(value || 0); } catch { return 0n; } };
  const attr = value => P.encode([vf(1, Number(value.attrClass ?? (value.setId ? 2 : 1))), vf(2, value.attrId || 0), vf(3, value.value || 0), ...(value.setId ? [vf(4, value.setId), vf(5, value.setLevel || 0)] : [])]);
  const gemExt = gem => {
    if (!gem) return null;
    const id = gem.id ?? request.gemId;
    const fields = [{ number: 1, wire: 0, value: u64(id) }];
    for (const value of magicAttrLanes(gem.attrs)) fields.push(bytes(2, attr(value)));
    for (const value of magicCandidateLanes(gem)) fields.push(bytes(4, attr(value)));
    if (gem.direction) fields.push(bytes(5, P.encode([vf(1, gem.direction.dir), vf(2, gem.direction.type || 1), vf(3, gem.direction.attrType || 0), vf(4, gem.direction.addAttrPercent || 0), vf(5, gem.direction.addSetLevel || 0)])));
    if (gem.directionCandidate) fields.push(bytes(6, P.encode([vf(1, gem.directionCandidate.dir), vf(2, gem.directionCandidate.type || 1), vf(3, gem.directionCandidate.attrType || 0), vf(4, gem.directionCandidate.addAttrPercent || 0), vf(5, gem.directionCandidate.addSetLevel || 0)])));
    fields.push(vf(3, 1), vf(7, gem.locked ? 1 : 0)); return P.encode(fields);
  };
  const magic = request.nativeEcho ? P.decode(request.nativeEcho) : [];
  const graphs = Object.values(state?.state?.graphs || {});
  if (request.operation === 'getGraphs') {
    for (const graph of graphs) magic.push(bytes(13, P.encode([vf(2, graph.id), vf(3, graph.open===true?1+[6,7,8].filter(slot=>graph.holes?.[slot]===true).length:0)])));
  }
  else if (['openGraph', 'openGraphHole', 'setGraph'].includes(request.operation)) {
    const graphId = Number(result.circuitId || request.circuitId || 0), graph = state?.state?.graphs?.[String(graphId)];
    if (graphId) magic.push(bytes(11, P.encode([vf(2, graphId), vf(3, graph?.open ? 1 + Object.keys(graph.holes || {}).filter(slot => Number(slot)>5 && graph.holes[slot]).length : 0)])));
  } else {
    const gem = result.gem || state?.state?.gems?.[String(request.gemId)] || state?.state?.gems?.[String(request.deviceGuid)];
    const ext = gemExt(gem); if (ext) magic.push(bytes(12, ext));
  }
  if (request.operation === 'getGraphs' || request.operation === 'setPityAttr' || result.pity) {
    const pity = require('./magic-pity').normalize(state?.state?.pity);
    magic.push(bytes(14, P.encode([vf(1, pity.normal), vf(2, pity.advanced), vf(3, pity.circuit), vf(4, pity.normalPityID), vf(5, pity.normalAttrID), vf(6, pity.advancedPityID), vf(7, pity.advancedAttrID), vf(8, pity.circuitPityID), vf(9, pity.circuitAttrID)])));
  }
  return P.encode([bytes(10, P.encode(magic))]);
}

// Build the native world-state notification used by the equipment panel.
// PBMagicGems responses are useful to the operation dialog, while 13590 is
// what the lobby uses to refresh the equipped device and bag gems together.
// Keep this encoder state-driven so a wash/refine/equip immediately produces
// the same shape as the initial world snapshot instead of replaying stale
// data captured at login.
function magicGemNotifyPayload(state) {
  const P = require('./battle-protobuf');
  const vf = (number, value) => ({ number, wire: 0, value: BigInt(Math.max(0, Number(value) || 0)) });
  const bytes = (number, value) => ({ number, wire: 2, bytes: value });
  const u64 = value => {
    try {
      const hex = typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value) ? value : '';
      return hex ? Buffer.from(hex, 'hex').readBigUInt64LE() : BigInt(value || 0);
    } catch { return 0n; }
  };
  const randAttr = value => P.encode([
    vf(1, value.attrClass ?? value.type ?? 1),
    vf(2, value.attrId || value.attrType || 0),
    vf(3, value.value || value.attrValue || 0),
    ...(value.setId ? [vf(4, value.setId)] : []),
    ...(value.setLevel ? [vf(5, value.setLevel)] : [])
  ]);
  const dir = value => value ? P.encode([
    vf(1, value.dir || 0), vf(2, value.type || 0),
    vf(3, value.attrType || 0), vf(4, value.addAttrPercent || 0),
    vf(5, value.addSetLevel || 0)
  ]) : null;
  const gemAttr = gem => {
    if (!gem) return P.encode([vf(1, 0),...magicAttrLanes([]).map(attr=>bytes(2,randAttr(attr)))]);
    const fields = [vf(1, gem.itemId || 0)];
    for (const attr of magicAttrLanes(gem.attrs)) fields.push(bytes(2, randAttr(attr)));
    const direction = dir(gem.direction);
    if (direction) fields.push(bytes(3, direction));
    if (gem.locked !== undefined) fields.push(vf(4, gem.locked ? 1 : 0));
    if (gem.lockEndTime) fields.push(vf(5, gem.lockEndTime));
    return P.encode(fields);
  };
  const gemExt = (id, gem) => {
    const fields = [{ number: 1, wire: 0, value: u64(id) }];
    for (const attr of magicAttrLanes(gem?.attrs)) fields.push(bytes(2, randAttr(attr)));
    fields.push(vf(3, gem?.ver || 1));
    for (const attr of magicCandidateLanes(gem||{})) fields.push(bytes(4, randAttr(attr)));
    const direction = dir(gem?.direction), directionBack = dir(gem?.directionCandidate);
    if (direction) fields.push(bytes(5, direction));
    if (directionBack) fields.push(bytes(6, directionBack));
    if (gem?.locked !== undefined) fields.push(vf(7, gem.locked ? 1 : 0));
    if (gem?.lockEndTime) fields.push(vf(8, gem.lockEndTime));
    return P.encode(fields);
  };
  const equip = device => {
    const fields = [{ number: 1, wire: 0, value: u64(device.guid) }];
    for (const id of Array.from({ length: 8 }, (_, index) => device.gems?.[index] ?? null)) {
      const attr = gemAttr(state?.state?.gems?.[String(id)] || state?.state?.gems?.[String(Number(id))]);
      if (attr) fields.push(bytes(2, attr));
    }
    fields.push(vf(3, device.level || 0), vf(4, device.exp || 0), vf(5, device.ver || 1), vf(6, device.graph || 0));
    return P.encode(fields);
  };
  const payload = [];
  for (const device of Object.values(state?.state?.devices || {})) payload.push(bytes(1, equip(device)));
  const embedded=new Set(Object.values(state?.state?.devices||{}).flatMap(d=>d.gems||[]).filter(Boolean).map(String));
  for (const [id, gem] of Object.entries(state?.state?.gems || {})) if(!embedded.has(String(id)))payload.push(bytes(2, gemExt(id, gem)));
  // The lobby has one independent magical-device slot for each of the three
  // equipment plans.  Older local state only had currentDeviceGuid; migrate
  // that value to plan 1 at serialization time, but emit all three native
  // fields when the per-plan list is available.
  const current = state?.state?.currentDeviceGuid;
  const equippedBySet = Array.isArray(state?.state?.equippedBySet)
    ? state.state.equippedBySet.slice(0, 3)
    : [current, null, null];
  while (equippedBySet.length < 3) equippedBySet.push(null);
  equippedBySet.forEach((guid, index) => {
    payload.push({ number: 3 + index, wire: 0, value: u64(guid) });
  });
  // Unlike PBMsgDef (11888), the dedicated native protobuf messages have
  // a four-byte serialized-body length ahead of the actual protobuf bytes.
  const body = P.encode(payload), native = Buffer.alloc(4 + body.length);
  native.writeUInt32LE(body.length); body.copy(native, 4);
  return native;
}
function runeBoardAck(request = {}) {
  if (request.layout === 'named48') {
    const payload = Buffer.alloc(217);
    payload[4] = Number(request.page || 0) & 0xff;
    require('./loadout-page-wire').nameBytes(request.name, 16).copy(payload, 5);
    for (let i = 0; i < 48; i++) payload.writeUInt32LE(Number(request.values?.[i] || 0) >>> 0, 21 + i * 4);
    return payload;
  }
  const payload = Buffer.alloc(217);
  // Native 11680 starts with a five-byte result header, then the eight-byte
  // onlyId and the fifty board words.  Echoing the accepted board keeps the
  // client cache coherent without replaying an older snapshot.
  const id = Buffer.isBuffer(request.runeId) ? request.runeId : Buffer.from(String(request.runeId || '').replace(/[^0-9a-f]/gi, '').padStart(16, '0').slice(0, 16), 'hex');
  id.copy(payload, 5, 0, 8);
  for (let i = 0; i < 50; i++) payload.writeUInt32LE(Number(request.values?.[i] || 0) >>> 0, 13 + i * 4);
  return payload;
}
// Current native sender/registry evidence fixes these four base-page shapes.
// A short record has no verified scalar-upgrade/reset semantics. Keep trusted
// model methods separate from the public packet decoder.
function nativeWarSoulRequestError(tag,payload){
  const lengths={36267:203,36269:16,36271:203,36274:1};
  if(!Object.hasOwn(lengths,tag))return null;
  return Buffer.isBuffer(payload)&&payload.length===lengths[tag]?null:'invalid-war-soul-request';
}
function parse(tag, payload) {
  const nativeError=nativeWarSoulRequestError(tag,payload);
  if(nativeError)return {system:'warSoul',operation:'invalidNativeRequest',reason:nativeError};
  if (!Buffer.isBuffer(payload)) return null;
  // Rune messages are native little-endian u32 argument lists.  The client
  // passes level and the persistent rune-only-id separately from the board
  // page/slot; reading individual bytes silently changed every id above 255.
  if (tag === 11679) {
    // The live native binding sends a complete board record (page byte,
    // eight-byte onlyId, fifty u32 values and a trailing flag).  Older test
    // fixtures use the compact four-u32 shape, which remains supported.
    // Native XReqSetPuzzle is exactly 209 bytes: one page byte, one
    // eight-byte onlyId, fifty little-endian board words, and no mandatory
    // trailing flag.  Some client builds append a one-byte flag (210 bytes),
    // so accept both forms before falling back to the compact test shape.
    if (isNamedRuneBoard(payload)) return {
      system: 'rune', operation: 'nativeBoard', layout: 'named48', page: payload[0] || 0,
      name: GBK.decode(payload.subarray(1, 17)).replace(/\0.*$/, ''),
      values: words(payload.subarray(17, 209)), trailing: 0, rawPayload: payload
    };
    if (payload.length >= 209) return {
      system: 'rune', operation: 'nativeBoard', page: payload[0] || 0,
      runeId: payload.subarray(1, 9).toString('hex'),
      values: words(payload.subarray(9, 209)), trailing: payload[209] || 0
    };
    const a = words(payload); return { system: 'rune', operation: 'slot', page: a[0] || 0, index: a[1] || 0, level: a[2] || 0, runeId: a[3] || 0 };
  }
  // Information requests have an empty native payload.  They still need to
  // enter the progression state machine so the live account stays aligned
  // when the client opens a panel before performing its first mutation.
  if (tag === 11677) return { system: 'rune', operation: 'info' };
  if (tag === 11687) return { system: 'rune', operation: 'list' };
  // 神赐筛选/限定神赐合成使用的是旧版 9155/9157 消息，不属于符文
  // 1167x 面板协议。9155 无参数请求筛选状态；9157 的原生 Lua 调用
  // XReqCharmNotWant(index, id) 携带两个 u32（0,0 表示消耗次数开启
  // 限定神赐合成）。保留一字参数形式，便于兼容 ChangeCharmGodgives
  // 这类旧客户端绑定。
  if (tag === 9155) return { system: 'rune', operation: 'godsendFilterInfo' };
  if (tag === 9157) {
    // 8824 encodes a filter selection as two packed u16 values rather than
    // two aligned u32 words: [slot index][godsend id].
    if (payload.length === 4) {
      const index = payload.readUInt16LE(0), id = payload.readUInt16LE(2);
      if (index || id) return { system: 'rune', operation: 'godsendFilterApply', index, id, rawArgs: [index, id], rawPayload: payload };
    }
    const a = words(payload);
    if (a.length >= 2) return { system: 'rune', operation: 'godsendFilterApply', index: a[0] || 0, id: a[1] || 0, rawArgs: a };
    // The live client build sends the activation click as one u32 zero,
    // rather than the older two-u32 (0,0) form. Treat that exact shape as
    // the limited-pool activation; non-zero single-argument requests remain
    // wish-selection calls.
    if (a.length === 1 && a[0] === 0) return { system: 'rune', operation: 'godsendFilterApply', index: 0, id: 0, rawArgs: a };
    return { system: 'rune', operation: 'wishGodsend', type: 'auto', id: a[0] || 0, rawArgs: a };
  }
  // An empty 11854 is the panel's determination query.  A few client builds
  // reuse the same tag for the wish selector and carry one u32 id.
  if (tag === 11854) {
    const id = u32(payload, 0) || 0;
    return id
      ? { system: 'rune', operation: 'wishGodsend', type: 'auto', id, rawPayload: payload }
      : { system: 'rune', operation: 'godsendInfo', rawPayload: payload };
  }
  if (tag === 11681) { const a = words(payload), native = a[0] === 0 && a.length >= 5; return { system: 'rune', operation: 'strengthen', shortcut: payload.length % 4 ? payload[payload.length - 1] : 0, ...(native ? { mainId: a[1] || 0, materialIds: a.slice(2).filter(Boolean) } : { materialIds: a.filter(Boolean) }), rawArgs: a }; }
  if (tag === 11683) {
    const a = words(payload);
    // The native request has a one-byte mode at the end of the payload.
    // In the client protocol mode 1 is the panel refresh/preview request and
    // mode 0 is the committed click; the first u32 remains the rune id.
    return {
      system: 'rune', operation: 'demolish',
      shortcut: payload.length % 4 ? payload[payload.length - 1] : 0,
      id: a[0] || 0, level: a[1] || 0, rawArgs: a,
    };
  }
  if (tag === 11685) return { system: 'rune', operation: 'exchangeNormal', count: u32(payload, 0) || 1 };
  if (tag === 11783) {
    const a = words(payload);
    // XComposeSelectItem(mode, itemId, attr1..attr6) is the native advanced
    // exchange call. Keep the six requested attribute types so a later rules
    // pass can honour them; the compact four-word shape remains accepted by
    // old harnesses that supplied token/color/level/count directly.
    // The live client also emits the compact native form as seven words:
    // itemId followed by exactly six attribute selectors (zero selectors are
    // retained in the vector). It has no mode/count word; treating attr4 as a
    // count makes ordinary requests such as 7576 + [8,15,97,10,147,23]
    // look like a 97-item exchange and incorrectly reject them.
    if (a.length === 7) {
      const tokenRow = runeCustomizeRows.find(row => Number(row[1]) === Number(a[0]));
      // Column 4 == 2 is the regular self-select-godsend family.  The
      // 7613..7617 family uses value 3 for the same wire shape while allowing
      // activity godsend rows. Both carry five attributes followed by the
      // persistent godsend id; the last word must not become an attribute.
      const tokenId = Number(a[0]) || 0;
      const selfSelectGodsend = Number(tokenRow?.[4]) === 2 ||
        (tokenId >= 7613 && tokenId <= 7617);
      return { system: 'rune', operation: 'exchangeAdvanced', mode: 1,
        tokenId,
        attributeIds: selfSelectGodsend ? a.slice(1, 6) : a.slice(1, 7),
        ...(selfSelectGodsend ? { godsendId: a[6] || 0 } : {}),
        count: 1, rawArgs: a };
    }
    if (a.length >= 8) return { system: 'rune', operation: a[0] === 1 ? 'exchangeAdvanced' : 'exchangeAdvancedSelect', mode: a[0] || 0, tokenId: a[1] || 0, attributeIds: a.slice(2, 8), count: 1, rawArgs: a };
    return { system: 'rune', operation: 'exchangeAdvanced', tokenId: a[0] || u32(payload, 0) || 0, color: a[1] || null, level: a[2] || null, count: a[3] || 1, rawArgs: a };
  }
  if (tag === 11689) return {
    system: 'rune', operation: u32(payload, 0) === 1 ? 'addPage' : 'unlockSlot',
    kind: u32(payload, 0) ?? 0, index: 0, payment: payload[4] ?? 0,
    rawPayload: payload,
  };
  // The native panel uses 11671 for the initial/current-page selection on
  // some builds and 11691 on others.  Both carry the page index; accepting
  // both keeps a page switch from falling through as an unrelated request.
  if (tag === 11671 || tag === 11691) return {
    system: 'rune', operation: 'usePage', page: u32(payload, 0) ?? payload[0] ?? 0,
    rawPayload: payload,
  };
  if (tag === 1456 || tag === 1458) return {
    system: 'itemLock', operation: tag === 1456 ? 'lock' : 'requestUnlock',
    guid: tag === 1456 ? guidHex(payload, 1) : guidHex(payload, 2), rawPayload: payload,
  };
  // Native rune item protection is separate from page protection.  The
  // client sends the persistent rune onlyId as a u16 in both requests:
  // 11759 toggles the individual lock and 11761 starts the delayed unlock
  // workflow.  11762 echoes the id and an absolute Unix expiry timestamp.
  if (tag === 11759 || tag === 11761) return {
    system: 'rune', operation: tag === 11759 ? 'lockRune' : 'requestUnlockRune',
    runeId: u16(payload, 0) ?? 0, rawPayload: payload,
  };
  if (tag === 13580) return { system: 'magicGem', operation: 'compose', gemIds: payload.length % 8 === 0 ? ids64(payload) : ids32(payload) };
  if (tag === 13554) return {
    system: 'magicGem', operation: 'materialExchange', recipeId: u32(payload, 0) || 0,
    amount: u32(payload, 4) || 1, sourceUid: u32(payload, 8) || 0,
    sourceGuid: guidHex(payload, 12), rawPayload: payload,
  };
  if (tag === 17060) return { system: 'exstore', operation: 'list' };
  if (tag === 17062 || tag === 17064 || tag === 17066) return {
    system: 'exstore', operation: tag === 17062 ? 'fromBag' : tag === 17064 ? 'toBag' : 'expand',
    rawPayload: payload, selectorHex: payload.toString('hex'),
  };
  if (tag === 13584) return { system: 'magicGem', operation: 'raise', deviceGuid: guidHex(payload), raiseMode: payload[8] || 0, exp: u32(payload, 9) || 0 };
  if (tag === 13586) {
    // Magic-gem onlyIds are eight-byte instance ids.  Keep the native byte
    // representation and also accept the old compact four-byte test shape.
    const ids = payload.length >= 16 && (payload.length - 8) % 8 === 0
      ? Array.from({ length: (payload.length - 8) / 8 }, (_, i) => payload.subarray(8 + i * 8, 16 + i * 8).toString('hex')).map(x => /^0+$/.test(x) ? null : x)
      : ids32(payload.subarray(8));
    return { system: 'magicGem', operation: 'equip', deviceGuid: guidHex(payload), gemIds: ids };
  }
  if (tag === 13588) return { system: 'magicGem', operation: 'unequip', deviceGuid: guidHex(payload), slot: payload.length === 13 ? u32(payload,8) : payload[8] || 0, payment: payload.length === 13 ? payload[12] : payload[9] || 0 };
  // 13630 is the generic equipment-gem punch-socket request.  Magic-gem
  // circuit marking travels through PBMagicGems.SetDir and must not consume
  // that tag before the generic gem-board handler sees it.
  if (tag === 13624) return { system: 'magicGem', operation: 'compose', gemIds: payload.length % 8 === 0 ? ids64(payload) : ids32(payload) };
  if (tag === 13625) return { system: 'magicGem', operation: 'composeAck' };
  // These are not ordinary six-slot equipment changes.  The first u32 is a
  // one-based equipment-plan index and the optional following u64 is the
  // magical-device onlyId.  13593 equips the device into that plan's
  // dedicated magical-device slot; 13595 clears the same slot.
  if (tag === 13593) return {
    system: 'magicGem', operation: 'equipVisual', whichSet: u32(payload, 0) || 0,
    plan: (u32(payload, 0) ?? 0) - 1,
    deviceGuid: payload.length >= 12 ? payload.subarray(4, 12).toString('hex') : '', rawPayload: payload,
  };
  if (tag === 13595) return {
    system: 'magicGem', operation: 'unequipVisual', whichSet: u32(payload, 0) || 0,
    plan: (u32(payload, 0) ?? 0) - 1, rawPayload: payload,
  };
  if (tag === 36267) {
    // Native activation/upgrade is a fixed 203-byte record: operation mode,
    // edited page, chapter and fifty 32-bit entry selectors. 36274 selects
    // the active loadout, independently of the page currently being edited.
    return {
      system: 'warSoul', operation: 'bulkLevelUp', mode: payload[0] || 0,
      page: payload[1] || 0, stage: payload[2] || 0, chapter: payload[2] || 0, category: (payload[2] || 0) + 1,
      nodeIds: words(payload.subarray(3, 203)).filter(Boolean),
      unitIds: words(payload.subarray(3, 203)).filter(Boolean), rawPayload: payload,
    };
  }
  if (tag === 36269) return { system: 'warSoul', operation: 'renamePage', page: payload[0] || 0, name: GBK.decode(payload.subarray(1, 16)).replace(/\0.*$/, '') };
  if (tag === 36271) {
    return {
      system: 'warSoul', operation: 'bulkReset', mode: payload[0] || 0,
      page: payload[1] || 0, stage: payload[2] || 0, chapter: payload[2] || 0, category: (payload[2] || 0) + 1,
      nodeIds: words(payload.subarray(3, 203)).filter(Boolean),
      unitIds: words(payload.subarray(3, 203)).filter(Boolean), rawPayload: payload,
    };
  }
  if (tag === 36274) return { system: 'warSoul', operation: 'changePage', page: payload[0] || 0 };
  if (tag === 36295) return { system: 'warSoul', operation: 'entryInfo' };
  // WarSoulEntry is a separate five-page enhancement panel.  Its page id is
  // a u32 and the rename wire carries a fixed 15-byte GBK name.  Do not
  // interpret these bytes as the unit/set fields used by the older node tree.
  if (tag === 36297) return { system: 'warSoul', operation: 'renameEnhancementPage', page: u32(payload, 0) || 0, name: GBK.decode(payload.subarray(4, 19)).replace(/\0.*$/, '') };
  if (tag === 36298) return { system: 'warSoul', operation: 'openEnhancementPage', page: u32(payload, 0) || 0 };
  if (tag === 36299) return { system: 'warSoul', operation: 'lockEnhancement', page: u32(payload, 0), index: u32(payload, 4), entry: u32(payload, 8), locked: payload[12] === 1 };
  if (tag === 36300) return { system: 'warSoul', operation: 'washEnhancementPage', page: u32(payload, 0) || 0, index: u32(payload, 4) || 0, operationCode: u32(payload, 8) || 0 };
  if (tag === 36301) return { system: 'warSoul', operation: 'changeEnhancementPage', page: u32(payload, 0) || 0 };
  if (tag === 36302) return { system: 'warSoul', operation: 'burnEquipmentEntries', page: u32(payload, 0), index: u32(payload, 4), sourceGuid: guidHex(payload, 8) };
  if (tag === 36303) return { system: 'warSoul', operation: 'transformEquipmentEntries', sourceGuid: guidHex(payload) };
  if (tag === 36304) return { system: 'warSoul', operation: 'transformInfo' };
  // Native 0/1 (normal/directed) differs from the domain's 1/2.
  if (tag === 13578 || tag === 13622) {
    const type=u32(payload,16);
    return { system:'crafting', operation:tag===13622?'previewInherit':'inherit', sourceGuid:guidHex(payload),
      targetGuid:guidHex(payload,8), inheritType:type===0?1:type===1?2:null, mask:u32(payload,20) };
  }
  // 0x14605a0 writes GUID:u64, material:u32, wish attribute:u32.
  if (tag === 13610) return { system: 'crafting', operation: 'forge', guid: guidHex(payload), materialItemId: u32(payload, 8), wishAttrId: u32(payload, 12) };
  if (tag === 13612) return { system: 'crafting', operation: 'confirmForge', guid: payload.subarray(0, 8).toString('hex'), choice: payload[8] ? 'apply' : 'cancel' };
  if (tag === 13614) return { system: 'crafting', operation: 'lockForgeMask', guid: guidHex(payload), lockMask: payload[8] };
  if (tag === 13616) return { system: 'crafting', operation: 'washForge', guid: guidHex(payload), materialItemId: u32(payload, 8) };
  if (tag === 13620) return { system: 'crafting', operation: 'forgePityInfo', selector: u32(payload, 0) };
  if (tag === 13618) return { system: 'crafting', operation: 'confirmForgeWash', guid: payload.subarray(0, 8).toString('hex'), choice: payload[8] ? 'apply' : 'cancel', type: payload[9] || 0 };
  if (tag === 13558) return { system: 'crafting', operation: 'alchemy', recipeId: u16(payload, 0) || 0, amount: u16(payload, 2) || 1 };
  return null;
}

function handle(request, systems, context = {}) {
  const r = request?.system, op = request?.operation; if (!systems?.[r]) return { ok: false, reason: 'unsupported-progression-system' };
  const state = systems[r];
  try {
    if (r === 'rune') {
      if (op === 'info') return { ok: true, info: state.list(), page: state.state.currentPage };
      if (op === 'list') return { ok: true, runes: Object.values(state.state.inventory || {}).map(value => JSON.parse(JSON.stringify(value))), pages: state.state.pages.map(value => ({ name: value.name, active: !!value.active, slots: [...(value.slots || [])], openSlots: Array.from({ length: RUNE_SLOT_COUNT }, () => true) })) };
      if (op === 'godsendInfo') return { ok: true, godsend: state.godsendInfo() };
      if (op === 'godsendFilterInfo') return { ok: true, godsend: state.godsendInfo() };
      if (op === 'setGodsendOptions') return state.setGodsendOptions(request);
      if (op === 'wishGodsend') return state.wishGodsend(request);
      if (op === 'godsendFilterApply') {
        // (0,0) is the only mutating operation currently exposed by the Lua
        // panel: consume one opening and enable the limited pool for 24h.
        // The per-entry exclusion list is intentionally accepted as a no-op
        // until a native response carrying its rows is captured.
        if (Number(request.index) === 0 && Number(request.id) === 0) {
          return state.activateLimitedGodsend();
        }
        return state.setGodsendFilter({ index: request.index, id: request.id });
      }
      if (op === 'clearGodsendWish') return state.clearGodsendWish();
      if (op === 'unlockSlot') return { ...state.unlockSlot(request), kind: request.kind };
      if (op === 'slot') return state.setSlot({ page: request.page, index: request.index, runeId: request.runeId });
      if (op === 'nativeBoard') return state.setNativeBoard(request);
      if (op === 'renamePage') return state.renamePage(request.page, request.name);
      if (op === 'strengthen') {
        const nativeIds = request.materialIds || [];
        const mainId = request.mainId || request.runeId || nativeIds[0] || Object.values(state.state.inventory || {}).find(r => r.color === request.color && r.level === request.level)?.id;
        const materialIds = request.mainId || request.runeId ? nativeIds : nativeIds.slice(1);
        return state.strengthen({ mainId, materialIds });
      }
      if (op === 'demolish') return state.demolish({ id: request.id });
      if (op === 'compose') return request.materialIds?.length ? state.compose({ materialIds: request.materialIds }) : state.composeCount({ count: request.count });
      if (op === 'exchangeNormal') return state.exchangeNormal({ count: request.count, fragments: request.unitCost ?? 20, availableFragments: request.availableFragments });
      if (op === 'exchangeAdvancedSelect') return { ok: true, mode: Number(request.mode) || 0, tokenId: request.tokenId || 0, attributes: [...(request.attributeIds || [])] };
      if (op === 'exchangeAdvanced') { let result; const count = Math.max(1, Number(request.count) || 1), runes = []; for (let i = 0; i < count; i++) { result = state.exchangeAdvanced(request); if (!result.ok) return i ? { ok: true, count: i, runes } : result; runes.push(result.rune); } return { ...result, count, runes }; }
      if (op === 'addPage') return { ...state.addPage(request.name), kind: request.kind };
      if (op === 'usePage') return state.usePage(request.page);
      if (op === 'lockRune') return state.lockRune({ runeId: request.runeId, locked: request.locked });
      if (op === 'requestUnlockRune') return state.requestUnlockRune(request);
    } else if (r === 'magicGem') {
      if (request.deviceMissing) return { ok: false, reason: 'magic-device-not-found' };
      if (op === 'getGraphs') return { ok: true, graphs: Object.values(state.state.graphs || {}).map(graph => ({ id: graph.id, openState:graph.open===true?1+[6,7,8].filter(slot=>graph.holes?.[slot]===true).length:0 })) };
      if (op === 'setPityAttr') return state.setPityAttr(request);
      if (op === 'compose') return state.compose({ gemIds: request.gemIds });
      if (op === 'materialExchange') return state.materialExchange(request);
      if (op === 'exchange' || op === 'batchExchange') return state.exchange(request);
      if (op === 'raise') return state.raise(request);
      if (op === 'equip') return state.equip(request);
      if (op === 'unequip') return state.unequip(request);
      if (op === 'circuitMark') return state.markCircuit(request);
      if (op === 'openGraph') return state.openGraph(request);
      if (op === 'openGraphHole') return state.openGraphHole(request);
      if (op === 'setGraph') return state.setGraph(request);
      if (op === 'lock') return state.lock(request);
      if (op === 'wash' || op === 'advancedWash') return state.wash({ ...request, operation: request.operationCode ?? request.washOperation ?? 'build', advanced: op === 'advancedWash' || request.advanced });
      if (op === 'refine') return state.refine(request);
      if (op === 'direction' || op === 'circuitDirection') return state.setDir({ ...request, operation: request.operationCode ?? request.directionOperation ?? 'build' });
      if (op === 'equipVisual' || op === 'unequipVisual') {
        // A truncated native request must not become an operation on plan 1
        // or fall through device('') to the currently selected device.
        const expectedBytes = op === 'equipVisual' ? 12 : 4;
        if (request.rawPayload !== undefined && (!Buffer.isBuffer(request.rawPayload) || request.rawPayload.length !== expectedBytes))
          return { ok: false, reason: 'invalid-magic-device-request' };
        const plan = Number(request.plan);
        if (!Number.isInteger(plan) || plan < 0 || plan > 2) return { ok: false, reason: 'invalid-magic-device-plan' };
        if (op === 'equipVisual' && (typeof request.deviceGuid !== 'string' || !/^[0-9a-f]{16}$/i.test(request.deviceGuid) || /^0{16}$/.test(request.deviceGuid)))
          return { ok: false, reason: 'invalid-magic-device-id' };
        const device = op === 'equipVisual' ? state.device(request.deviceGuid) : null;
        if (op === 'equipVisual' && !device) return { ok: false, reason: 'magic-device-not-found' };
        state.state.equippedBySet ??= [state.state.currentDeviceGuid || null, null, null];
        state.state.equippedBySet = Array.from({ length: 3 }, (_, index) => state.state.equippedBySet[index] || null);
        if (op === 'equipVisual') {
          state.state.equippedBySet[plan] = device.guid;
          state.state.currentDeviceGuid = device.guid;
          device.visual = true; // legacy UI field; equippedBySet is authoritative.
        } else {
          state.state.equippedBySet[plan] = null;
        }
        state.save();
        return { ok: true, plan, guid: state.state.equippedBySet[plan], equippedBySet: [...state.state.equippedBySet] };
      }
    } else if (r === 'warSoul') {
      if(op==='invalidNativeRequest')return {ok:false,reason:request.reason};
      if (op === 'entryInfo') return { ok: true, info: state.list(), page: state.state.currentPage };
      if (op === 'transformInfo') return { ok: true, units: Object.values(state.state.units || {}).map(value => JSON.parse(JSON.stringify(value))), materials: { ...(state.state.materials || {}) } };
      if (op === 'levelUp') return state.levelUp(request);
      if (op === 'bulkLevelUp') {
        return state.bulkLevelUp(request);
      }
      if (op === 'renamePage') return state.renamePage(request.page, request.name);
      if (op === 'reset') return state.resetPage(request.page);
      if (op === 'bulkReset') {
        return state.bulkReset(request);
      }
      if (op === 'changePage') return state.changePage(request.page);
      if (op === 'renameEnhancementPage') return state.renameEnhancementPage(request.page, request.name);
      if (op === 'openEnhancementPage') return state.openEnhancementPage(request.page);
      if (op === 'changeEnhancementPage') return state.changeEnhancementPage(request.page);
      if (op === 'lockEnhancement') {
        const p = state.state.enhancementPages?.[Number(request.page) || 0];
        if (!p) return { ok: false, reason: 'war-soul-enhancement-page-not-found' };
        const index = Number(request.index) || 0, set = new Set(p.locked || []);
        request.locked ? set.add(index) : set.delete(index); p.locked = [...set].sort((a, b) => a - b); state.save();
        return { ok: true, page: Number(request.page) || 0, locked: p.locked };
      }
      if (op === 'washEnhancementPage') return state.washEnhancementPage(request);
      if (op === 'renameSet') return state.renameSet(request);
      if (op === 'openSet') return state.openSet(request);
      if (op === 'lock') return state.lock({ ...request, operation: request.operationCode ?? request.operation });
      if (op === 'wash') return state.wash({ ...request, operation: ['build', 'apply', 'cancel'][request.operationCode] || 'build' });
      if (op === 'changeSet') return state.changeSet(request);
      if (op === 'burn') return state.burn(request);
      if (op === 'transform') return state.transform(request);
    } else if (r === 'crafting') {
      if (op === 'prepareInherit') return { ok: true, sourceGuid: request.sourceGuid, targetGuid: request.targetGuid, inheritType: request.inheritType, mask: request.mask };
      if (op === 'alchemy') return state.alchemy(request);
      if (op === 'inherit') {
        const mask = Number(request.mask ?? request.mode) || 0;
        const selected = mask ? ['enhancement', 'forge', 'warSoul', 'soul'].filter((_, i) => mask & (1 << i)) : ['all'];
        const mode = selected.length === 1 ? selected[0] : selected.includes('all') ? 'all' : selected.join(',');
        return state.inherit({ source: context.source, target: context.target, mode, consumeSource: Number(request.inheritType) !== 2 });
      }
      if (op === 'forge') return state.forge(request);
      if (op === 'confirmForge') return state.confirmForge(request);
      if (op === 'lockForge') return state.lockForge(request);
      if (op === 'washForge') return state.washForge(request);
      if (op === 'confirmForgeWash') return state.confirmForge(request);
      if (op === 'determination') return state.determination(request);
    }
  } catch (error) { return { ok: false, reason: 'progression-state-error', error: error.message }; }
  return { ok: false, reason: 'unsupported-progression-operation' };
}
module.exports = { parse, nativeWarSoulRequestError, parseMagicGemProtobuf, magicGemResponsePayload, magicGemNotifyPayload, runeBoardAck, handle, ids32, ids64 };
