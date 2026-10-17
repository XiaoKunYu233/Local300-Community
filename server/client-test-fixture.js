'use strict';

// A small, idempotent fixture for the local client-test server.  It only runs
// when --progression-fixture=client is enabled; ordinary server starts keep
// their persisted account state untouched.
const fs = require('node:fs');
const path = require('node:path');

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const writeJson = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
};
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

function collectMaterialIds(value, out = new Set()) {
  if (Array.isArray(value)) for (const item of value) collectMaterialIds(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectMaterialIds(item, out);
  else if (typeof value === 'string') {
    for (const part of value.split(';')) {
      const match = /^(\d+)\s*,\s*(\d+(?:\.\d+)?)$/.exec(part.trim());
      if (match && Number(match[1]) >= 1000) out.add(Number(match[1]));
    }
  }
  return out;
}

function seedMaterials(directory) {
  const file = path.join(directory, 'material-state.live.json');
  const value = readJson(file) || { items: {} };
  value.items ||= {};
  const ids = new Set([7421, 7354, 46612, ...Array.from({ length: 19 }, (_, i) => 46601 + i), ...Array.from({ length: 14 }, (_, i) => 46201 + i)]);
  for (const name of ['warsoulstage.json', 'warsoulmaterial.json', 'warsoulconsumption.json']) {
    try { collectMaterialIds(readJson(path.join(directory, 'logs', 'cfg', name)), ids); } catch {}
  }
  for (const id of ids) value.items[String(id)] = Math.max(Number(value.items[String(id)] || 0), 99999);
  value.updatedAt = new Date().toISOString();
  writeJson(file, value);
  return { file, count: ids.size };
}

function seedProgression(directory, { rune, magicGem, warSoul }) {
  const changes = [];
  // Runes: enough fragments and a small board inventory to exercise list,
  // slot, strengthen and normal exchange without a GM step.
  const wasEmpty = !Object.keys(rune.state.inventory || {}).length;
  const levelOne = Object.values(rune.state.inventory || {}).filter(value => Number(value.level) === 1).length;
  if (levelOne < 8) {
    const granted = rune.grant({ color: 1, level: 1, count: 8 - levelOne });
    if (wasEmpty) {
      const ids = granted.runes.map(value => value.id);
      for (const [index, id] of ids.slice(0, 4).entries()) rune.slot({ page: 0, index, runeId: id });
    }
    changes.push(`runes:+${granted.runes.length}`);
  }
  // The native capture selects these persistent ids during its strengthen
  // and dismantle flows. Restore missing test ids in client-fixture mode so a
  // previous destructive click cannot make the next validation silently
  // fail with rune-not-found.
  for (const id of [4, 5, 6, 9, 13, 14, 16, 20]) {
    if (rune.state.inventory[String(id)]) continue;
    const created = rune.grant({ color: 1, level: 1, count: 1 }).runes[0];
    delete rune.state.inventory[String(created.id)];
    created.id = id;
    rune.state.inventory[String(id)] = created;
    changes.push(`rune-id:${id}`);
  }
  rune.state.fragments = Math.max(Number(rune.state.fragments || 0), 5000);
  rune.save();

  // Magic device: make the currently equipped device visible and operable.
  const device = magicGem.device() || magicGem.createDevice({ guid: magicGem.state.currentDeviceGuid || Object.keys(magicGem.state.devices || {})[0] }).device;
  if (device) {
    if (!Object.keys(magicGem.state.gems || {}).length) {
      const gems = Array.from({ length: 5 }, (_, i) => magicGem.grantGem({ itemId: 46000 + i, type: 1, quality: Math.min(5, i + 1), level: Math.min(5, i + 1), attrId: [38, 39, 17, 18, 31][i], value: 10 + i * 5 }).gem.id);
      device.gems = Array(8).fill(null); gems.forEach((id, index) => { device.gems[index] = id; });
      changes.push(`magic-gems:${gems.length}`);
    }
    device.level = Math.max(Number(device.level || 0), 3);
    device.exp = 0;
    const graphId = 1001;
    magicGem.state.graphs[String(graphId)] ||= { id: graphId, open: true, holes: {} };
    magicGem.state.graphs[String(graphId)].open = true;
    for (let slot = 1; slot <= 5; slot++) magicGem.state.graphs[String(graphId)].holes[String(slot)] = true;
    device.graph = graphId;
    magicGem.state.currentDeviceGuid = device.guid;
    magicGem.save();
  }

  // War soul: retain an existing unit if present, otherwise use the unit id
  // already observed in the client capture.  Activate one set and one node so
  // the first panel open has visible data and a combat contribution.
  const unitId = Number(Object.keys(warSoul.state.units || {})[0] || 570425346);
  const unit = warSoul.unit(unitId);
  if (unit) {
    unit.level = Math.max(Number(unit.level || 0), 5);
    unit.exp = 0;
    unit.entries ||= {};
    const entry = unit.entries['1'] ||= { name: '战魂套1', locked: [], attrs: [] };
    entry.active = true;
    entry.name ||= '战魂套1';
    entry.locked ||= [];
    entry.attrs ||= [];
    warSoul.state.pages[0] ||= { name: '战魂配置1', units: {}, active: true };
    warSoul.state.pages[0].units ||= {};
    if (!Object.keys(warSoul.state.pages[0].units).length) warSoul.state.pages[0].units[String(unitId)] = { '1': 1 };
    unit.nodes ||= {};
    unit.nodes['1'] ||= 1;
    // Rebuild the derived attribute maps using the generic stage template
    // when this capture unit id is absent from the extracted cfg.
    warSoul.levelUp({ unitId, exp: 1 });
    warSoul.save();
    changes.push(`war-soul:${unitId}`);
  }
  return changes;
}

function seedClientFixture(directory, systems) {
  const materials = seedMaterials(directory);
  const changes = seedProgression(directory, systems);
  return { materials, changes };
}

module.exports = { seedClientFixture };
