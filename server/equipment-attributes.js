'use strict';
const fs=require('fs'),path=require('path');
const {loadConfig}=require('./runtime/catalogs');
const rows=new Map(loadConfig('legacy-armour').data.map(r=>[r[1],r]));
const currentRows=new Map(loadConfig('current-armour').data.map(r=>[r[1],r]));
const enhancementRules=require('./enhancement-rules');
const passives=require('./equipment-passives');
const gemAttributeIds=new Set(Object.values(require('./gem-board').ATTRIBUTE_IDS).flat());
const raiseIdForColumn=Object.fromEntries(Object.entries(enhancementRules.ARMOUR_FIELDS)
 .map(([id,column])=>[column,+id]));
// Columns named in DeepSeek's SItem_Armour schema. Attribute IDs verified by
// comparing 13502 operations and their following 1045 frames in this capture.
const columns={2:[30,127],4:[15],5:[42],6:[31,128],7:[44],11:[1,8],12:[2,9],14:[17],16:[13],17:[97],18:[98],19:[99]};
const managed=new Set(Object.values(columns).flat());
const combatColumns={...columns,3:[24],8:[14],9:[18],10:[25],13:[100],15:[12],25:[106],26:[107],27:[108],28:[109],31:[129]};
// Forge results carry native equipforge attribute codes. Translate them to
// character combat attributes at the same aggregation boundary as equipment
// rows so lobby and battle values stay consistent.
const forgeCombatColumns=Object.freeze({
  15:[30,127],18:[31,128],10:[24],31:[42],50:[44],38:[1,8],39:[2,9],
  42:[12],43:[13],3:[17],2:[15],89:[100],90:[99],83:[97],84:[98],
  87:[106],88:[107],85:[108],86:[109],4:[18]
});
const forgedIds=[...new Set(Object.values(forgeCombatColumns).flat())];
function forgeEntries(raw){
 if(!raw)return [];
 if(Array.isArray(raw))return raw.flatMap(forgeEntries);
 if(raw.candidate)return forgeEntries(raw.candidate);
 if(Number.isFinite(Number(raw.id))||Number.isFinite(Number(raw.attrId))){
  const id=Number(raw.id??raw.attrId),value=Number(raw.value??raw.amount);
  return Number.isFinite(id)&&Number.isFinite(value)?[{id,value}]:[];
 }
 if(typeof raw==='object')return Object.entries(raw).flatMap(([id,value])=>
  Number.isFinite(Number(id))&&Number.isFinite(Number(value))?[{id:Number(id),value:Number(value)}]:[]);
 return [];
}
// Blessing records use their own attribute codes, distinct from the
// equipattrraisevalue IDs used by ordinary enhancement. This mapping follows
// the client's grade thresholds and the supplied reforge table/video.
const reforgeColumns={3:14,15:2,18:6,31:5,38:11,50:7,87:25,88:26};
function sumEquipment(equipment,{combat=false,enhancementLevelFor=null,reforgeFor=null,forgeFor=null,currentClient=true}={}){
 const selected=combat?combatColumns:columns;
 const totals=Object.fromEntries([...Object.values(selected).flat(),...(combat?forgedIds:[])].map(id=>[id,0]));
 const seen=new Set();
 for(const [pos,e] of equipment){
  if(pos<0||pos>=6||!e||!e.itemId||e.itemId===65535)continue;
  const key=Buffer.isBuffer(e.guid)?e.guid.toString('hex'):e.guid;
  if(key&&seen.has(key))continue;if(key)seen.add(key);
  const r=currentClient?(currentRows.get(e.itemId)||rows.get(e.itemId)):rows.get(e.itemId);if(!r)continue;
  let raised=null;
  if(enhancementLevelFor&&enhancementRules.eligibility(e.itemId,{currentClient}).supported){
   const level=enhancementLevelFor(e,pos);
   if(Number.isInteger(level)&&level>=0&&level<=17)
     raised=enhancementRules.attributesFor(e.itemId,level,{currentClient});
  }
  const blessingByColumn={};
  if(reforgeFor){
   const raw=reforgeFor(e,pos);
   const blessing=Buffer.isBuffer(raw)?raw:typeof raw==='string'&&/^[0-9a-f]{84}$/i.test(raw)
    ?Buffer.from(raw,'hex'):null;
   if(blessing?.length===42)for(let slot=0;slot<6;slot++){
    const offset=slot*7,code=blessing[offset],
      field=reforgeColumns[code]??enhancementRules.ARMOUR_FIELDS[code];
    if(field&&selected[field]&&blessing.readUInt16LE(offset+5)===1)
     blessingByColumn[field]=(blessingByColumn[field]||0)+blessing.readUInt32LE(offset+1);
   }
  }
  const forge=forgeEntries(forgeFor?forgeFor(e,pos):e.forge);
  const replaced=new Set(forge.length?Object.values(require('./equipment-inheritance').fields):[]);
  for(const [col,ids]of Object.entries(selected)){
   const baseValue=Number(r[col])||0,raiseId=raiseIdForColumn[col];
   const value=(replaced.has(Number(col))?0:(raiseId&&raised ? raised[raiseId] : baseValue))+(blessingByColumn[col]||0);
   for(const id of ids)totals[id]+=value;
  }
  for(const {id,value} of forge)
   for(const combatId of forgeCombatColumns[id]||[])if(Object.hasOwn(totals,combatId))totals[combatId]+=value;
 }
 return totals;
}
function capturedBase(){
 const file=path.join(__dirname,'logs/cap-2026-09-26T20-22-26/events.jsonl');
 const events=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 const firstEquip=events.find(e=>e.dir==='c2s'&&e.msgid===13502);
 const lastUnequip=events.filter(e=>e.dir==='c2s'&&e.msgid===13504&&e.t<firstEquip.t).at(-1);
 if(!lastUnequip)throw Error('Missing unequipped attribute evidence');
 const base={};
 for(const e of events){
  if(e.dir!=='s2c'||e.msgid!==1045||e.t<lastUnequip.t||e.t>=firstEquip.t)continue;
  const p=Buffer.from(e.hex,'hex').subarray(12);if(p.length!==1+p[0]*5)continue;
  for(let i=0;i<p[0];i++){const id=p[1+i*5];base[id]=p.readUInt32LE(2+i*5);}
 }
 for(const id of managed)if(base[id]===undefined)throw Error('Missing equipment baseline '+id);
 return base;
}
const base=capturedBase();
function attributes(equipment,options={}){
 const bonus=sumEquipment(equipment,{...options,combat:true}),gem=options.gemBonus||{};
 const soul=require('./equipment-soul').bonuses([...equipment].map(([slot,e])=>({...e,slot,soul:options.soulFor?options.soulFor(e):e?.soul}))).stats;
 for(const [id,value]of Object.entries(soul))bonus[id]=(bonus[id]||0)+value;
 const sources=options.progressionSources||{progression:options.progressionBonus||{}};
 const calcBase={...base,95:base[95]||0,96:base[96]||0};
 // Progression systems introduce native attributes that are absent from old
 // captured 1045 baselines (for example skill damage/immunity 147..152).
 // Seed those keys before aggregation so their values are not discarded by
 // the legacy sparse-map reducer.
 for(const source of [bonus,gem,...Object.values(sources)]) for(const id of Object.keys(source||{})) calcBase[id]??=0;
 const totals=passives.calculate(calcBase,bonus,gem,passives.compile(equipment,options.enhancementLevelFor),sources);
 // Native movement recalculation applies the soft caps itself. Field 17 is
 // the total input percentage, not an already capped display percentage.
 // A removed final gem must still emit the attribute's baseline. Omitting
 // the key would leave its previous value cached in the client.
 const ids=new Set([...Object.keys(bonus),...Object.keys(gem),...Object.values(sources).flatMap(Object.keys),...gemAttributeIds,24,25,36,97,95,96]);
 return Object.fromEntries([...ids].filter(id=>totals[id]!==undefined)
  .map(id=>[id,totals[id]]));
}
module.exports={attributes,sumEquipment,managed,base,
 allManaged:new Set([...Object.values(combatColumns).flat(),...gemAttributeIds,43,136,151,152])};
