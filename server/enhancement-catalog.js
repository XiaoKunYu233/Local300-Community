'use strict';

// Read-only evidence catalog. None of these rows is an executable enhancement recipe.
const path = require('path');
const fs = require('fs');
const CFG = path.join(__dirname, 'logs', 'cfg');
const SCHEMA = path.join(__dirname, '..', 'data', 'protocol', 'schema-index.tsv');
const MAX_ATTRIBUTE_LEVEL = 17;
const MAX_SKILL_LEVEL = 15;
const LEVEL_FIELDS = ['uEquipRaiseLv', 'uNeedPoint1', 'uNeedPoint2', 'uNeedPoint3',
  'uValuePoint', 'uExpOnce', 'uMaxCount', 'uSeason', 'uPieceID1',
  'uNeedPiece1', 'uRaiseRand', 'uValuePointPlus', 'uLuckyItem'];
const ATTR_FIELDS = ['uRaiseAttrID', 'strName', 'uValuePerPoint', 'uGS'];

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function schemaFields(file, message) {
  const rows = fs.readFileSync(SCHEMA, 'utf8').trim().split(/\r?\n/).slice(1);
  const fields = new Map();
  for (const line of rows) {
    const [source, msg, field, number, , type] = line.split('\t');
    if (source === file && msg === message) fields.set(Number(number), { field, type });
  }
  if (!fields.size) throw new Error(`Missing schema ${file}/${message}`);
  return fields;
}

function namedRows(file, proto, message, expected) {
  const defs = schemaFields(proto, message);
  for (let i = 0; i < expected.length; i++) {
    if (defs.get(i + 1)?.field !== expected[i])
      throw new Error(`Schema mismatch ${file} column ${i + 1}`);
  }
  const rows = JSON.parse(fs.readFileSync(path.join(CFG, file), 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`Invalid table ${file}`);
  return rows.map((raw, index) => {
    const fields = {};
    for (const [number, value] of Object.entries(raw)) {
      const def = defs.get(Number(number));
      if (!def) throw new Error(`Unmapped ${file} column ${number}`);
      if (def.type === 'uint32' && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
        throw new Error(`Invalid ${file} row ${index + 1} ${def.field}`);
      if (def.type === 'bytes' && typeof value !== 'string')
        throw new Error(`Invalid ${file} row ${index + 1} ${def.field}`);
      fields[def.field] = value;
    }
    return { index: index + 1, fields };
  });
}

function source(file, row, field, key, evidence) {
  return { file: `work/server/logs/cfg/${file}`, row, key, schemaField: field, evidence };
}

function fact(value, file, row, field, key, evidence) {
  return { value, source: source(file, row, field, key, evidence) };
}

function readCatalog({ levelRows } = {}) {
  const levels = levelRows === undefined
    ? namedRows('equipraiselv.json', 'EquipRaise.proto', 'SExcelEquipRaiseLvData', LEVEL_FIELDS)
    : levelRows.map(({ index, fields }) => ({ index, fields: { ...fields } }));
  const attrs = namedRows('equipattrraisevalue.json', 'EquipRaise.proto', 'SExcelEquipRaiseAttrData', ATTR_FIELDS);
  // The common numeric JSON was exported by protobuf field number. Do not infer this
  // solely from matching numbers: cfgdecode.js parses each protobuf record's wire key;
  // sample values in the queried tables also match their schema types and names.
  const armour = namedRows('item_armour.json', 'Item.proto', 'SItem_Armour', ['nID']);
  const item = namedRows('item_item.json', 'Item.proto', 'SItem_Item', ['nID']);
  const byLevel = new Map();
  for (const row of levels) {
    const level = row.fields.uEquipRaiseLv;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(row);
  }
  const byArmour = new Map(armour.map(row => [row.fields.nID, row]));
  const byItem = new Map(item.map(row => [row.fields.nID, row]));

  function query({ equipmentId, targetLevel, season } = {}) {
    if (!Number.isSafeInteger(equipmentId) || equipmentId <= 0) throw new RangeError('equipmentId must be a positive safe integer');
    if (!Number.isSafeInteger(targetLevel) || targetLevel < 1 || targetLevel > MAX_ATTRIBUTE_LEVEL)
      throw new RangeError('targetLevel must be 1..17');
    if (season !== undefined && (!Number.isSafeInteger(season) || season < 0))
      throw new RangeError('season must be a nonnegative safe integer');
    const a = byArmour.get(equipmentId);
    const i = byItem.get(equipmentId);
    const problems = [];
    if (!a || !i) problems.push('EQUIPMENT_NOT_FOUND');
    if (i && i.fields.nIsRaise !== 1) problems.push('EQUIPMENT_NOT_ENHANCEABLE');
    const configuredSeason = i?.fields.uSeason;
    if (i && configuredSeason === undefined) problems.push('EQUIPMENT_SEASON_UNKNOWN');
    if (season !== undefined && configuredSeason !== undefined && season !== configuredSeason)
      throw new RangeError('season does not match item_item.uSeason');
    const selectedSeason = season ?? configuredSeason;
    const candidates = (byLevel.get(targetLevel) || []).filter(row =>
      selectedSeason === undefined || row.fields.uSeason === selectedSeason);
    if (!candidates.length) problems.push('LEVEL_RULE_NOT_FOUND');
    if (season === undefined && candidates.length > 1) problems.push('SEASON_SELECTOR_REQUIRED');
    problems.push('LEVEL_DIRECTION_UNKNOWN',
      'MEDAL_POINT_CONVERSION_UNKNOWN', 'UPGRADE_SYMBOL_REQUIREMENT_UNKNOWN',
      'PROBABILITY_DENOMINATOR_UNKNOWN', 'ATTRIBUTE_FIELD_MAPPING_UNKNOWN',
      'ATTRIBUTE_GROWTH_FORMULA_UNKNOWN',
      'ENHANCEMENT_PURCHASE_PRICE_UNKNOWN');
    const itemKey = `nID=${equipmentId}`;
    const equipment = a && i ? {
      id: fact(equipmentId, 'item_armour.json', a.index, 'nID', itemKey, 'Armour and item records share this ID.'),
      name: fact(i.fields.strItemName, 'item_item.json', i.index, 'strItemName', itemKey, 'Item display name; item identity is verified by nID.'),
      season: configuredSeason === undefined ? null : fact(configuredSeason, 'item_item.json', i.index,
        'uSeason', itemKey, 'Item season selects the matching uSeason enhancement row.'),
      enhanceable: fact(i.fields.nIsRaise, 'item_item.json', i.index, 'nIsRaise', itemKey,
        'Item flag identifies equipment offered for enhancement.'),
      baseFields: Object.fromEntries(Object.entries(a.fields).filter(([name, value]) =>
        name !== 'nID' && typeof value === 'number' && value !== 0).map(([name, value]) =>
        [name, fact(value, 'item_armour.json', a.index, name, itemKey,
          'Raw armour configuration field, not an enhancement delta.')])),
    } : null;
    const rules = candidates.map(row => {
      const f = row.fields;
      const key = `uEquipRaiseLv=${f.uEquipRaiseLv};uSeason=${f.uSeason};row=${row.index}`;
      const raw = Object.fromEntries(Object.entries(f).map(([name, value]) =>
        [name, fact(value, 'equipraiselv.json', row.index, name, key,
          'Protobuf field number and type checked against EquipRaise.proto; operational meaning is not inferred.') ]));
      const piece = f.uPieceID1 ? {
        itemId: fact(f.uPieceID1, 'equipraiselv.json', row.index, 'uPieceID1', key, 'Referenced piece item ID.'),
        rawNeed: raw.uNeedPiece1,
        name: byItem.has(f.uPieceID1)
          ? fact(byItem.get(f.uPieceID1).fields.strItemName, 'item_item.json',
            byItem.get(f.uPieceID1).index, 'strItemName', `nID=${f.uPieceID1}`, 'Referenced piece display name.')
          : null,
      } : null;
      return { key, raw, piece,
        materials: { rawPointNeeds: [raw.uNeedPoint1, raw.uNeedPoint2, raw.uNeedPoint3],
          rawExperiencePerAttempt: raw.uExpOnce, piece },
        probability: { raw: raw.uRaiseRand, denominator: null, successRate: null },
        growth: { rawValuePoint: raw.uValuePoint, rawValuePointPlus: raw.uValuePointPlus,
          interpretation: 'unknown' } };
    });
    const attrRules = attrs.map(row => {
      const key = `uRaiseAttrID=${row.fields.uRaiseAttrID};row=${row.index}`;
      return { key, raw: Object.fromEntries(Object.entries(row.fields).map(([name, value]) =>
        [name, fact(value, 'equipattrraisevalue.json', row.index, name, key,
          'Raw enhancement attribute row; per-point conversion and rounding are unconfirmed.')])) };
    });
    return freeze({ equipmentId, targetLevel, attributeLevel: targetLevel,
      skillCalculationLevel: Math.min(targetLevel, MAX_SKILL_LEVEL),
      levelMeaning: 'unknown (current or target)', equipment, rules, attributeRules: attrRules,
      materialIdentities: Object.fromEntries([
        ['battleMedal', 40001], ['arenaMedal', 40002], ['upgradeSymbol', 40003],
      ].map(([role, id]) => {
        const itemRow = byItem.get(id);
        return [role, {
          id: fact(id, 'item_item.json', itemRow.index, 'nID', `nID=${id}`,
            `Name ${itemRow.fields.strItemName}; 11553 resource-count frames in cap-2026-09-26T21-26-40/events.jsonl identify the storage channel.`),
          name: fact(itemRow.fields.strItemName, 'item_item.json', itemRow.index,
            'strItemName', `nID=${id}`, 'Exact item name, excluding similarly named gift boxes.'),
          container: { value: '11553 resource count', source: {
            file: 'work/server/logs/cap-2026-09-26T21-26-40/events.jsonl',
            row: '2026-09-26 21:39:35.356', key: `msgid=11553;itemId=${id}`,
            schemaField: null,
            evidence: 'S2C payload contains uint32 item ID followed by uint32 current count during 13510 attempts.',
          } }, quantity: null,
        }];
      })),
      purchasePrice: { gold: null, diamond: null, context: 'enhancement screen' },
      executionReady: false, gaps: [...new Set(problems)] });
  }

  function coverage(equipmentId, season) {
    return freeze(Array.from({ length: MAX_ATTRIBUTE_LEVEL }, (_, current) => ({
      transition: `${current}→${current + 1}`,
      query: query({ equipmentId, targetLevel: current + 1, season }),
    })));
  }

  function listLevelVariants(level) {
    if (!Number.isSafeInteger(level) || level < 1 || level > MAX_ATTRIBUTE_LEVEL)
      throw new RangeError('level must be 1..17');
    return freeze((byLevel.get(level) || []).map(({ index, fields }) => ({
      key: `uEquipRaiseLv=${level};uSeason=${fields.uSeason};row=${index}`,
      season: fields.uSeason, row: index,
    })));
  }

  function requireExecutable(input) {
    const result = query(input);
    throw new Error(`Enhancement rule incomplete: ${result.gaps.join(', ')}`);
  }
  return freeze({ query, coverage, listLevelVariants, requireExecutable });
}

module.exports = { readCatalog, MAX_ATTRIBUTE_LEVEL, MAX_SKILL_LEVEL };
