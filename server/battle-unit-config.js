'use strict';

// Map 252 values without a verified native rule. Do not derive cadence from
// nAtkSpeed or nCDTime, or range from fRange=9999 / nFightShot by name alone.
const provisional=Object.freeze({
  minion:Object.freeze({range:5.5,acquireRange:9,attackInterval:1.25}),
  tower:Object.freeze({range:8,acquireRange:8,attackInterval:1.2}),
});
const passiveKinds=new Set(['base','barracks','fountain']);

function field(row,name,context) {
  const raw=row?.[name];
  if(raw===undefined||raw===null||raw==='')throw new Error(`Missing ${context}.${name}`);
  const value=Number(raw);
  if(!Number.isFinite(value))throw new Error(`Invalid ${context}.${name}: ${raw}`);
  return value;
}

function unitStats(monsters,skillLevel,monsterId,kind,{battle=false}={}) {
  const row=monsters.get(monsterId);
  if(!row)throw new Error(`Missing monster config ${monsterId} (${kind})`);
  const context=`monster ${monsterId}`;
  const hpMax=field(row,'nMaxHP',context),speed=field(row,'fMoveSpeed',context);
  const physicalAttack=field(row,'nMaxPhyAtk',context),armor=field(row,'nPhyDef',context);
  const bodyRadius=field(row,'fMonsterBodyRange',context),block=field(row,'nIsBlock',context);
  const configuredSkillId=field(row,'nUseSkill1',context);
  if(hpMax<=0||speed<0||physicalAttack<0||armor<0||bodyRadius<0||!Number.isInteger(configuredSkillId))
    throw new Error(`Invalid combat attributes for ${context}`);
  const magicResistance=field(row,'nMagicDef',context);
  const common={hpMax,hp:hpMax,speed,physicalAttack,armor,magicResistance,bodyRadius,staticBlock:block===2,configuredSkillId};
  if(battle){
    const id=monsterId,key=id>=25213&&id<=25218?'ranged':id>=25273&&id<=25278?'cannon'
      :id===25240||id===25250?'gate':id>=25231&&id<=25249?['outer','middle','inner'][(id-(id<25241?25231:25241))%3]
      :kind==='base'?'base':kind==='barracks'?'barracks':null;
    const override=require('./battle-unit-overrides.json')[key];
    if(override)Object.assign(common,override,{hp:override.hpMax});
  }
  // The fountain's 8062 is a configured skill, but its native behavior is not
  // established as an ordinary attack. These buildings do not attack in Sim.
  if(passiveKinds.has(kind))return {...common,attackDamage:0,attackSkillId:0,attackSkillLevel:0,
    attackWindup:0,projectileSpeed:0,range:0,acquireRange:0,attackInterval:0};
  const timing=provisional[kind];
  if(!timing)throw new Error(`Unsupported map 252 unit kind ${kind} (${monsterId})`);
  const attackSkillLevel=field(row,'nSkill1Lv',context);
  if(configuredSkillId<=0||!Number.isInteger(attackSkillLevel)||attackSkillLevel<=0)
    throw new Error(`Missing ordinary attack skill for ${context}`);
  const skill=skillLevel(configuredSkillId,attackSkillLevel);
  if(!skill)throw new Error(`Missing skill level ${configuredSkillId}/${attackSkillLevel} for ${context}`);
  const skillContext=`skill ${configuredSkillId}/${attackSkillLevel}`;
  const attackWindup=field(skill,'nSkillShakeTime',skillContext)/1000;
  const projectileSpeed=field(skill,'fSpeed',skillContext);
  if(attackWindup<0||projectileSpeed<0)throw new Error(`Invalid attack timing for ${context}`);
  // BattleSim currently treats this attack attribute as its raw damage input.
  // The native damage formula and defense reduction are not established here.
  return {...common,attackDamage:common.physicalAttack,attackSkillId:configuredSkillId,attackSkillLevel,
    attackWindup,projectileSpeed,...timing};
}

module.exports={unitStats,provisional};
