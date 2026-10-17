'use strict';

// Current native MSG_EQUIP_SKILL_APPLY (11003), constructor c40a30, is
// 46 bytes including the common 12-byte frame. Its selector is NOT a skill ID.
const armour=new Map(require('./logs/cfg/item_armour.json').map(row=>[row[1],row]));
for(const row of require('../data/current-client/item_armour.json'))armour.set(row[1],row);
const catalog=require('./equipment-catalog');
const activeSkills=require('./equipment-active-skills');
const guidHex=value=>Buffer.isBuffer(value)?value.toString('hex'):String(value||'').toLowerCase();

function readEquipmentCast(payload,actor){
  if(!Buffer.isBuffer(payload)||payload.length!==34)throw Error('Invalid equipment cast command');
  const result={type:'equipment-cast',tag:11003,actor,
    playerId:payload.readUInt32LE(0),targetId:payload.readUInt32LE(4),
    position:payload[8],container:payload[9],x:payload.readFloatLE(10),z:payload.readFloatLE(14),
    dirX:payload.readFloatLE(18),dirZ:payload.readFloatLE(22),guid:payload.subarray(26,34).toString('hex')};
  if(![result.x,result.z,result.dirX,result.dirZ].every(Number.isFinite))throw Error('Invalid equipment cast coordinates');
  if(![result.x,result.z].every(n=>n>=0&&n<=655.35)||Math.abs(result.dirX)>655.35||Math.abs(result.dirZ)>655.35)
    throw Error('Equipment cast coordinates outside map');
  return result;
}

// Resolve the native position/GUID selector against the server's worn items.
// A non-equipped inventory item cannot grant a skill. Native fight-bag clicks
// use container=0, position=0..5 and a zero GUID; GUID selection uses pos=255.
function resolveEquipmentCast(hero,command){
  const reject=reason=>({ok:false,reason});
  if(!hero||command?.type!=='equipment-cast')return reject('invalid-equipment-cast');
  // Send sites write the hero in both fields, but the common C2S transport can
  // leave actor=0. The explicit payload owner must still match this session.
  if(command.playerId!==hero.id||(command.actor!==undefined&&command.actor!==0&&command.actor!==hero.id))return reject('wrong-player');
  if(command.container!==0)return reject('unsupported-equipment-container');
  const guid=guidHex(command.guid),byGuid=command.position===255;
  if(!/^[a-f0-9]{16}$/.test(guid)||(byGuid?guid==='0000000000000000':guid!=='0000000000000000'))
    return reject('invalid-equipment-selector');
  if(!byGuid&&(!Number.isInteger(command.position)||command.position<0||command.position>=6))
    return reject('invalid-equipment-position');
  const entries=(hero.loadout?.slots||[]).filter(e=>Number.isInteger(e.slot)&&e.slot>=0&&e.slot<6);
  const matches=entries.filter(e=>byGuid?guidHex(e.guid)===guid:e.slot===command.position);
  if(matches.length!==1)return reject('equipment-not-equipped');
  const equipment=matches[0],item=catalog.get(equipment.itemId),resolvedSkill=activeSkills.skillFor(item,equipment),skillId=Number(resolvedSkill?.id||0);
  if(resolvedSkill?.unsupportedNative||skillId>65535)return reject('equipment-native-skill-unbound');
  if(!Number.isInteger(skillId)||skillId<=0)return reject('equipment-has-no-active');
  const installed=Object.entries(hero.skills||{}).filter(([,entry])=>entry.equipment&&entry.id===skillId&&(entry.level||1)===(resolvedSkill.level||1)&&
    (!entry.sourceItemIds||entry.sourceItemIds.includes(Number(equipment.itemId))));
  if(installed.length!==1)return reject('unsupported-equipment-skill');
  const [slot,skill]=installed[0];
  // Skill level, cooldown and cost come from the installed server skill, not
  // client bytes. An active absent from the current loadout cannot be invoked.
  return {ok:true,slot,skillId,skill,equipment,
    aim:{x:command.x,z:command.z,targetId:command.targetId,dirX:command.dirX,dirZ:command.dirZ,requestedSkillId:skillId}};
}

module.exports={readEquipmentCast,resolveEquipmentCast};
