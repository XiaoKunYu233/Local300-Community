'use strict';

// The installed lm4JJCmap geometry/mask matches these captures byte for byte.
// Positions not observed in 002/003 are explicitly retained as provisional;
// client Monster/WorldMapCfg tables contain appearance, not server placements.
const slots=Object.freeze([
 [25258,2,95.70,95.70],[25260,2,107.20,107.20],
 [25254,2,104,126.39],[25255,2,121.28,121.28],[25256,2,126.39,104],
 [25243,2,104,132.8],[25246,2,125.75,125.75],[25249,2,132.8,104],
 [25242,2,104,158.39],[25245,2,141.12,138.56],[25248,2,158.39,104],
 [25241,2,104.64,194.24],[25244,2,152,153.92],[25247,2,194.24,104.64],
 [25250,2,108.48,112.96],[25250,2,112.96,108.48],
 [25257,1,231.98,231.98],[25259,1,220.48,220.48],
 [25253,1,223.68,201.29],[25252,1,206.4,206.4],[25251,1,201.29,223.68],
 [25239,1,223.68,194.88],[25236,1,201.93,201.93],[25233,1,194.88,223.68],
 [25238,1,223.68,169.29],[25235,1,189.12,186.56],[25232,1,169.28,224.32],
 [25237,1,223.04,133.44],[25234,1,173.76,175.68],[25231,1,133.44,223.04],
 [25240,1,219.2,214.72],[25240,1,214.72,219.2],
].map(([monsterId,team,x,z])=>Object.freeze({monsterId,team,x,z})));

function category(id){
 if(id===25257||id===25258)return 'fountain';
 if(id===25259||id===25260)return 'base';
 if(id>=25251&&id<=25256)return 'barracks';
 if(id===25240||id===25250)return 'gate';
 if(id>=25231&&id<=25249)return ['outer','middle','inner'][(id-(id<25241?25231:25241))%3];
 return null;
}
function kind(id){const c=category(id);return ['outer','middle','inner','gate'].includes(c)?'tower':c;}
const valid=e=>e&&e.kind==='monster'&&[1,2].includes(e.team)&&category(e.monsterId)&&
 Buffer.isBuffer(e.frame)&&[e.x,e.z,e.hp,e.hpMax].every(Number.isFinite)&&e.hpMax>0&&e.hp>=0&&e.hp<=e.hpMax;
const d=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
function registrationPosition(rows,slot){
 const same=rows.filter(e=>e.monsterId===slot.monsterId&&e.team===slot.team);
 const matches=category(slot.monsterId)==='gate'?same.filter(e=>d(e,slot)<.15):same;
 if(matches.length>1)throw Error(`Duplicate native map placement ${slot.monsterId}`);
 const r=matches[0];return r?{...r,x:+r.x.toFixed(2),z:+r.z.toFixed(2)}:null;
}
function validateRegistrations(rows){
 if(!Array.isArray(rows)||rows.some(r=>!r||!category(r.monsterId)||![1,2].includes(r.team)||![r.x,r.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35)))throw Error('Invalid map registration coordinates');
 return rows;
}
function build(observations,registrations=[]){
 if(!Array.isArray(observations))throw Error('Map 252 native observations required');
 validateRegistrations(registrations);const rows=observations.filter(valid),out=[];
 for(const slot of slots){
  const family=category(slot.monsterId),same=rows.filter(e=>e.monsterId===slot.monsterId&&e.team===slot.team);
  // Gate towers share an Excel ID; coordinates distinguish their two actors.
  const identity=family==='gate'?same.filter(e=>d(e,slot)<.15):same;
  if(identity.some(e=>d(e,identity[0])>.15))throw Error(`Conflicting native placement ${slot.monsterId}`);
  const registration=registrationPosition(registrations,slot),position=registration||identity[0]||slot;
  if(registration&&identity.length&&identity.some(e=>d(e,registration)>.15))throw Error(`Native map/spawn coordinates conflict ${slot.monsterId}`);
  let template=identity.find(e=>e.hp>0),templateSource='observed-alive-same-id';
  if(!template){
   template=rows.find(e=>e.team===slot.team&&category(e.monsterId)===family&&e.hp>0);
   templateSource='observed-alive-same-faction-category';
  }
  if(!template){
   // The opposing faction can be used only with native Monster ID/team
   // rebinding. This occurs for unseen blue buildings in partial captures.
   template=rows.find(e=>category(e.monsterId)===family&&e.hp>0);
   templateSource='observed-alive-opposite-faction-category';
  }
  if(!template)throw Error(`No alive native structure template ${slot.monsterId}/${family}`);
  out.push({...template,monsterId:slot.monsterId,team:slot.team,x:position.x,z:position.z,
   source:registration?'native-building-registration-coordinate':identity.length?'captured-native-coordinate':'provisional-unobserved-map-grid',
   registrationActorId:registration?.actor,
   templateSource,templateMonsterId:template.monsterId,templateActorId:template.id,
   kind:kind(slot.monsterId),direction:identity[0]?.direction??template.direction});
 }
 return out;
}
function roads(registrations=[]){
 validateRegistrations(registrations);const p=(id,team)=>{const slot=slots.find(s=>s.monsterId===id&&s.team===team),r=registrationPosition(registrations,slot)||slot;return {x:r.x,z:r.z};};
 return {
 top:[p(25260,2),p(25243,2),p(25242,2),p(25241,2),{x:108,z:215},p(25231,1),p(25232,1),p(25233,1),p(25259,1)],
 middle:[p(25260,2),p(25246,2),p(25245,2),p(25244,2),{x:163.84,z:163.84},p(25234,1),p(25235,1),p(25236,1),p(25259,1)],
 bottom:[p(25260,2),p(25249,2),p(25248,2),p(25247,2),{x:215,z:108},p(25237,1),p(25238,1),p(25239,1),p(25259,1)],
};}
module.exports={slots,category,kind,build,roads,registrationPosition};
