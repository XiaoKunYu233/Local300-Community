'use strict';

// The lobby and battle runtime are separate processes. A lobby-local boolean
// cannot observe the battle socket returning to the lobby, so keep a tiny
// account-scoped ownership marker in the shared state directory.
const fs = require('node:fs'), path = require('node:path');

function filePath(explicit = process.env.DSH_BATTLE_STATE_FILE) {
  return explicit ? path.resolve(explicit) : null;
}

function write(active, extra = {}, explicit) {
  const file = filePath(explicit);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = { version: 1, active: !!active, updatedAt: Date.now(), ...extra };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value) + '\n');
  fs.renameSync(temp, file);
  return true;
}

function read(explicit) {
  const file = filePath(explicit);
  if (!file) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || typeof value.active !== 'boolean') return null;
    return value;
  } catch {
    return null;
  }
}

module.exports = { filePath, write, read };
