'use strict';
const G=require('./gem-board'),E=require('./battle-equipment'),W=require('./battle-wire');
const GBK=require('./gbk'),summoners=require('./summoner-effects');
const config=require('./battle-test-dummies.json');
function add(sim,options){
  const {playerId}=options;
  // The native-result acceptance profile has a complete captured 7v7 roster
  // (23444 actor ids plus 1052 hero templates). Use those exact actors in the
  // experimental world so the result gate can represent the same fourteen
  // participants without copying unknown result statistics from old matches.
  if(process.env.DSH_NATIVE_RESULT_EXPERIMENTAL==='1'&&Number.isInteger(playerId))
    return addCapturedRoster(sim,options);
  const {observations,heroes,skillLevel,start,reviveStatus,identities=[]}=options;
  if(!config.enabled)return [];
  const template=observations.find(e=>e.kind==='hero'&&e.heroId===config.heroId);
  const row=heroes.find(r=>+r.nHeroId===config.heroId);
  if(!template||!row)throw Error('Missing test dummy hero template');
  const skillId=+row.nCommonAttackSkillID,skill=skillLevel(skillId,1),range=+skill.fRange;
  const base=E.heroBase(row,config.level,range),out=[];
  for(const [index,set]of config.sets.entries()){
    const id=0xff900001+index,gemState=G.initial();
    for(let slot=0;slot<6;slot++)gemState.plans[0][slot]=[{id:config.gemId,sourceSlot:slot,guid:(id.toString(16)+(slot+1).toString(16).padStart(8,'0'))}];
    const slots=set.items.map((itemId,slot)=>({slot,bagSlot:slot,itemId,count:1,
      guid:id.toString(16)+(slot+1).toString(16).padStart(8,'0'),enhancementLevel:config.enhancementLevel}));
    const loadout={slots,gemState,currentClient:true,gemBonus:G.bonuses(gemState,new Set([0,1,2,3,4,5])),gemEffects:G.combatEffects(gemState,new Set([0,1,2,3,4,5]))};
    let spawn=null;
    // Keep test targets beyond allied towers/fountain so those structures do
    // not kill them automatically; all three remain close to the starting base.
    const desired={x:start.x+23+index*4,z:start.z+18-index*4};
    for(let ring=0;ring<=30&&!spawn;ring++)for(let step=0;step<32;step++){
      const angle=step*Math.PI/16,p={x:desired.x+ring*Math.cos(angle),z:desired.z+ring*Math.sin(angle)};
      if(!sim.terrain.clear(p,+row.fBodySize)||[...sim.entities.values()].some(e=>
        Math.hypot(e.x-p.x,e.z-p.z)<(e.kind==='tower'&&e.team===2?e.range+2:e.kind==='fountain'?12:(e.bodyRadius||0)+1)))continue;
      spawn=p;break;
    }
    if(!spawn)throw Error('No free test dummy spawn');
    const hero=sim.add({id,heroId:config.heroId,team:1,kind:'hero',testDummy:true,name:set.name,
      nameBytes:Buffer.concat([Buffer.from('b2e2cad4bcd9c8cb','hex'),Buffer.from(String(index+1))]),
      ...spawn,template:template.frame,level:config.level,bodyRadius:+row.fBodySize,
      hpMax:base[8],mpMax:base[9],range,attackDamage:base[30],attackInterval:1,speed:0,
      attackSkillId:skillId,reviveStatus:Buffer.from(reviveStatus),equipmentBase:base});
    E.apply(sim,hero,E.calculate(base,loadout),loadout,{initial:true});
    const identity=identities.find(f=>f.readUInt16LE(8)===23512&&f.readUInt32LE(12)===template.id);
    if(identity){hero.identity=Buffer.from(identity);hero.identity.writeUInt32LE(id,12);hero.identity.writeUInt32LE(1,20);
      hero.identity.fill(0,24,39);hero.nameBytes.copy(hero.identity,24,0,14);}
    out.push(hero);
  }
  return out;
}
function addCapturedRoster(sim,{observations,heroes,skillLevel,start,identities=[],playerId}){
  if(!config.enabled)return [];
  const roster=identities.find(f=>f.readUInt16LE(8)===23444);
  if(!roster||roster.length!==175292)throw Error('Missing complete native roster template');
  const actors=[];
  for(let index=0;index<40*30;index++){
    const offset=0x1b+index*0x92,actor=roster.readUInt32LE(offset);
    if(actor&&actor!==playerId)actors.push({actor,index});
  }
  if(actors.length!==13)throw Error(`Native roster requires 13 remote actors, got ${actors.length}`);
  const out=[],teamCounts={1:0,2:0};
  const heroesById=new Map(heroes.map(row=>[Number(row.nHeroId),row]));
  const findFree=(team,bodyRadius,ordinal)=>{
    const base=team===2?start:{x:327.68-start.x,z:327.68-start.z};
    const desired={x:base.x+12+(ordinal%3)*3,z:base.z+12+Math.floor(ordinal/3)*3};
    for(let ring=0;ring<=40;ring++)for(let step=0;step<32;step++){
      const angle=step*Math.PI/16,p={x:desired.x+ring*Math.cos(angle),z:desired.z+ring*Math.sin(angle)};
      if(!sim.terrain.clear(p,bodyRadius)||[...sim.entities.values()].some(e=>
        Math.hypot(e.x-p.x,e.z-p.z)<Math.max(1,(e.bodyRadius||0)+bodyRadius+0.5)))continue;
      return p;
    }
    throw Error(`No free captured roster spawn for team ${team} actor ${ordinal}`);
  };
  for(const {actor,index} of actors){
    const template=observations.find(e=>e.kind==='hero'&&e.id===actor);
    if(!template)throw Error(`Missing captured hero template for roster actor 0x${actor.toString(16)}`);
    const row=heroesById.get(Number(template.heroId));
    if(!row)throw Error(`Missing hero catalog row ${template.heroId} for roster actor 0x${actor.toString(16)}`);
    const basicId=Number(row.nCommonAttackSkillID)||2841,basic=skillLevel(basicId,1),range=Number(basic?.fRange||5.5);
    const base=E.heroBase(row,config.level,range),loadout={slots:[],gemState:G.initial(),currentClient:true,
      gemBonus:{},gemEffects:{}};
    const ordinal=teamCounts[template.team]++;
    const spawn=findFree(template.team,Number(row.fBodySize)||0.5,ordinal);
    const identity=identities.find(f=>f.readUInt16LE(8)===23512&&f.readUInt32LE(12)===actor);
    const identityEnd=identity?identity.indexOf(0,24):-1;
    const nameBytes=identity&&identityEnd>24
      ?Buffer.from(identity.subarray(24,identityEnd))
      :GBK.encode(template.name||`Bot${index}`).subarray(0,15);
    const rosterOffset=0x1b+index*0x92;
    const skillIdD=roster.readUInt16LE(rosterOffset+38),skillIdF=roster.readUInt16LE(rosterOffset+40);
    const skill=(id)=>summoners.definition(id)||{id,level:1,cooldown:0,mana:0,summoner:true,type:'summoner'};
    const hero=sim.add({id:actor,heroId:template.heroId,team:template.team,kind:'hero',testDummy:true,
      name:template.name||`Bot${index}`,nameBytes,...spawn,template:template.frame,level:config.level,bodyRadius:Number(row.fBodySize)||0.5,
      hpMax:base[8],mpMax:base[9],range,attackDamage:base[30],attackInterval:1,speed:0,
      attackSkillId:basicId,attackProfiles:{[basicId]:{range,attackWindup:Number(basic?.nSkillShakeTime||200)/1000,projectileSpeed:Number(basic?.fSpeed||8)},
        2841:{range,attackWindup:0.2,projectileSpeed:8}},skills:{D:skill(skillIdD),F:skill(skillIdF)},equipmentBase:base});
    if(identity)hero.identity=Buffer.from(identity);
    E.apply(sim,hero,E.calculate(base,loadout),loadout,{initial:true});
    out.push(hero);
  }
  if(teamCounts[1]!==7||teamCounts[2]!==6)throw Error(`Captured roster team split invalid ${teamCounts[1]}+${teamCounts[2]}`);
  return out;
}
function packets(hero){return [...(hero.identity?[hero.identity]:[]),...E.equipmentPackets(hero.id,hero.loadout),E.attributePacket(hero),
  W.frame(11888,0,G.actorPayload(hero.loadout.gemState,hero.id))];}
module.exports={config,add,addCapturedRoster,packets};
