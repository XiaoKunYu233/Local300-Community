'use strict';
const fs = require('fs'), path = require('path');
const stateFiles=require('./persistence/state-files');
// Rebuild from the immutable level-18 base when saved loadout inputs change.
// Do not use the previous final attributes as a new base.
function install(sim, hero, { read = require('./account-loadout').readLoadout, stamp, pendingFile } = {}) {
  if (!hero.loadout?.source && !stamp) return;
  const directory = path.dirname(hero.loadout?.source || '.');
  pendingFile ||= process.env.DSH_EQUIPMENT_PENDING||path.join(directory,'equipment-economy-pending.json');
  const files = ['equip-state.json','equip-state.json.snapshot','rune-state.json','war-soul-state.json',
    'magic-gem-state.json','soul-state.json','gem-board-state.json','enhancement-state.json','reforge-state.json','equipment-crafting-state.json',
    'bag-state.json','bag-state.live.json','warehouse-state.json'];
  // Online time and mail receipts also revise the account file. Only the VIP
  // projection enters this signature, so those unrelated ledger writes do not
  // repeatedly recalculate the same battle attributes.
  const signature = stamp || (() => stateFiles.readSnapshot(()=>
    files.map(name=>`${name}:${stateFiles.changeToken(path.join(directory,name))}`).join('|')+'|'+
    require('./account-loadout').vipStateToken(hero.loadout?.source||path.join(directory,'equip-state.json'))+'|'+require('./account-loadout').progressionStateToken(hero.loadout?.source||path.join(directory,'equip-state.json'))));
  const jsonPending=()=>!stateFiles.enabled()&&fs.existsSync(pendingFile);
  let previous = signature(), nextCheck = 0, sawPending=jsonPending();
  sim.refreshLoadout = () => {
    if (sim.time < nextCheck) return;
    nextCheck = sim.time + .5;
    // Another process may see the replaced file before its JSON journal
    // finalizes. Keep the current battle projection until that commit ends;
    // do not consume its changed signature while it is unresolved. SQLite
    // snapshot reads already share the database's committed boundary.
    if(jsonPending()){sawPending=true;return;}
    const current=stateFiles.readSnapshot(()=>{
      const observed=signature();if(!sawPending&&observed===previous)return null;
      return {signature:observed,loadout:read()};
    });
    if(!current)return;
    const equipment = require('./battle-equipment'),loadout=current.loadout;
    equipment.apply(sim, hero, equipment.calculate(hero.equipmentBase, loadout), loadout);
    previous=current.signature;
    sawPending=false;
    sim.event('equipment-passive-attributes', { id: hero.id });
  };
}
module.exports = { install };
