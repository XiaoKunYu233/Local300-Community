'use strict';
const W = require('./battle-wire');
const P = require('./battle-protobuf');
const gbk = new TextDecoder('gbk');

function readSkill(frame) {
  const tag = frame.readUInt16LE(8), body = frame.subarray(12);
  if (![11005,11042].includes(tag)) return null;
  if (body.length < 2 || body.readUInt16LE(0) !== body.length - 2) throw new Error('Invalid skill size');
  const fields = P.decode(body.subarray(2));
  const targets = fields.filter(f => f.number === 11 && f.wire === 2).map(f => {
    const fields = P.decode(f.bytes);
    return {id: P.get(fields,1), damage:P.get(fields,2,true), hp:P.get(fields,8,true), mp:P.get(fields,9,true), fields};
  });
  return {tag, flags:frame.readUInt16LE(10), actor:frame.readUInt32LE(4), skill:P.get(fields,1), level:P.get(fields,2), action:P.get(fields,8), x:P.get(fields,4,true), z:P.get(fields,5,true), fields, targets};
}

function writeSkill(skill) {
  let index = 0;
  const fields = skill.fields.map(f => f.number === 11 && f.wire === 2
    ? {...f, bytes:P.encode(skill.targets[index++].fields)} : f);
  if (index !== skill.targets.length) throw new Error('Target count mismatch');
  const body = P.encode(fields), prefix = Buffer.alloc(2);
  if (body.length > 65535) throw new Error('Skill payload too large');
  prefix.writeUInt16LE(body.length);
  return W.frame(skill.tag, skill.actor, Buffer.concat([prefix,body]), skill.flags || 0);
}

function editTarget(skill, id, {hp, damage}) {
  return {...skill, targets:skill.targets.map(t => {
    if (t.id !== id) return t;
    let fields = t.fields;
    if (hp !== undefined) fields = P.set(fields,8,hp);
    if (damage !== undefined) fields = P.set(fields,2,damage);
    return {...t, hp:hp === undefined ? t.hp : hp, damage:damage === undefined ? t.damage : damage, fields};
  })};
}

function readSpawn(frame) {
  const tag = frame.readUInt16LE(8), p = frame.subarray(12);
  if (![1050,1052].includes(tag) || p.length < 4) return null;
  const nameLength = p.readUInt16LE(2), offset = 4 + nameLength;
  if (!nameLength || offset + 6 > p.length || p[offset-1] !== 0) return null;
  const type = p.readUInt16LE(0) & 255;
  const base = {id:frame.readUInt32LE(4), tag, type, name:gbk.decode(p.subarray(4,offset-1)),
    x:p.readUInt16LE(offset)/100, z:p.readUInt16LE(offset+2)/100,
    direction:p.readUInt16LE(offset+4), offset, frame};
  if (type === 13) return {...base, kind:'projectile'};
  if (type !== 21 && type !== 69) return {...base, kind:'unknown'};
  if (offset + 40 > p.length) return null;
  const result = {...base, kind:type === 21 ? 'monster' : 'hero', level:p[offset+8],
    hp:p.readUInt32LE(offset+9), hpMax:p.readUInt32LE(offset+13)};
  if (type === 21) {
    result.monsterId = p.readUInt32LE(offset+36);
    // The owner-name string is variable length; faction follows its NUL byte.
    if (offset + 51 > p.length) return null;
    const ownerLength = p.readUInt16LE(offset+49), teamOffset = offset+51+ownerLength;
    if (!ownerLength || teamOffset+4 > p.length || p[teamOffset-1] !== 0) return null;
    result.team = p[teamOffset];
    result.teamOffset = teamOffset;
  }else{
    if(offset+64>p.length)return null;
    result.heroId=p.readUInt16LE(offset+56);
    if(tag===1052){
      // bce215 -> bf09f0 -> c1a710/c1a780 sequential reads. Skin's
      // low u16 at +36 reaches object ed4 via b8e460 (roster skin 3e).
      // +58 is the title, not the skin: bf14e7 -> object 970;
      // +60 directly controls display at object 972 (not a hidden flag).
      result.skinId=p.readUInt16LE(offset+36);
      result.titleId=p.readUInt16LE(offset+58);
      result.titleHidden=p[offset+60]===0;
    }
    result.teamOffset=offset+63;result.team=p[result.teamOffset];
  }
  return result;
}

function readPath(frame) {
  if (frame.readUInt16LE(8) !== 27105) return null;
  const p = frame.subarray(12);
  if (p.length < 9 || p.length !== 9+8*p[8]) return null;
  const points = [{x:p.readUInt32LE(0)/100,z:p.readUInt32LE(4)/100}];
  for (let i=0;i<p[8];i++) points.push({x:p.readUInt32LE(9+8*i)/100,z:p.readUInt32LE(13+8*i)/100});
  return {id:frame.readUInt32LE(4),points};
}

function readCommand(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 12 || frame.readUInt32LE(0) !== frame.length) throw new Error('Invalid command frame');
  const tag = frame.readUInt16LE(8), p = frame.subarray(12);
  if (tag === 27111) {
    if (p.length !== 8) throw new Error('Invalid move command');
    return {type:'move',tag,x:p.readUInt32LE(0)/100,z:p.readUInt32LE(4)/100};
  }
  if (tag === 11002) {
    if (p.length !== 27) throw new Error('Invalid cast command');
    const result = {type:'cast',tag,playerId:p.readUInt32LE(0),targetId:p.readUInt32LE(4),skillId:p.readUInt16LE(8),
      x:p.readFloatLE(10),z:p.readFloatLE(14),dirX:p.readFloatLE(18),dirZ:p.readFloatLE(22),repeat:p[26]};
    if (![result.x,result.z,result.dirX,result.dirZ].every(Number.isFinite)) throw new Error('Invalid cast coordinates');
    if(![result.x,result.z].every(n=>n>=0&&n<=655.35)||Math.abs(result.dirX)>655.35||Math.abs(result.dirZ)>655.35)throw new Error('Cast coordinates outside map');
    return result;
  }
  if (tag === 11003) return require('./battle-equipment-command').readEquipmentCast(p,frame.readUInt32LE(4));
  if (tag === 11043) {
    if (p.length !== 2) throw new Error('Invalid slot command');
    // Semantics (learn/toggle/release) require UI validation. This packet does
    // not contain a skill ID or a target and must not inflict generic AOE damage.
    return {type:'slot',tag,action:p[0],slot:p[1]};
  }
  return {type:'other',tag,payload:p};
}

module.exports = {readSkill,writeSkill,editTarget,readSpawn,readPath,readCommand};
