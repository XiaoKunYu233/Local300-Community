'use strict';
// Rules come from the installed normal client's summonerskill selection table
// and skill_skilllevel descriptions; provisional curves are documented in
// evidence/summoner-effects-plan-2026-10-02.md.
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const level = e => clamp(Number(e.level) || 1, 1, 18);
const scaled = (e, low, high) => low + (high - low) * (level(e) - 1) / 17;
const coreIds = [8023, 8026, 8028, 8029, 8030, 8031, 8032, 8033, 8035, 8059];
const specialIds = [8063, 8064, 8065, 8066];
const coreExcluded = new Set([27, 355]);
const make = (id, name, cooldown, more = {}) => Object.freeze({ id, name, cooldown,
  level: 1, mana: 0, summoner: true, type: 'summoner', ...more });
const definitions = Object.freeze({
  8008: make(8008, '机械飞爪', 40, { range: 15, width: .8, aliases: [8006], recast: true }),
  8023: make(8023, '英灵召唤', 405, { allowDead: true }),
  8026: make(8026, '逆向通灵', 200, { type: 'channel-teleport', channel: 3.8, range: 999,anchorRadius:15,aliases:[8027] }),
  8028: make(8028, 'RUA!!!', 185),
  8029: make(8029, '神圣守护', 170, { range: 5 }),
  8030: make(8030, '潜能激发', 135),
  8031: make(8031, '圣洁之光', 175),
  8032: make(8032, '奥术加速', 185),
  8033: make(8033, '锁定弹幕', 155, { range: 5 }),
  8035: make(8035, '砸瓦鲁多', 180, { type: 'dash', range: 5, clampRange: true, resetAttack: true }),
  8059: make(8059, '封印之术', 210, { range: 5 }),
  8063: make(8063, '灵魂漫步', 150),
  8064: make(8064, '闪现', 150, { type: 'dash', range: 5, clampRange: true, resetAttack: true }),
  8065: make(8065, '虚弱', 150, { range: 5 }),
  8066: make(8066, '清醒', 90),
});
const definition = id => definitions[id] ? { ...definitions[id] } : null;
const mapId = sim => Number(sim.mapId ?? sim.matchStats?.mapId ?? 252);
const battlefield = sim => sim.battlefield ?? mapId(sim) === 252;
const talent = e => e.summonerTalent === true;
function allowedSkillIds(map) {
  map = Number(map);
  const ids = coreIds.filter(id => !coreExcluded.has(map) &&
    !(id === 8023 && [32, 356, 37, 364, 45, 46, 710, 711].includes(map)) &&
    !(id === 8026 && [32, 356, 37, 364].includes(map)));
  if ([1, 37, 364].includes(map)) ids.unshift(8008);
  if ([27, 355].includes(map)) ids.push(...specialIds);
  return ids;
}
function validSelection(skills, map = 252) {
  const ids = allowedSkillIds(map);
  return !!skills && ids.includes(skills.D) && ids.includes(skills.F) && skills.D !== skills.F;
}
function state(e) {
  return e.summonerState ??= { effects: [], heals: [], healSequence: 0, shield: null };
}
function activeEffects(sim, e) { return (e.summonerState?.effects || []).filter(f => f.expires > sim.time + 1e-9); }
const nativeSources=new WeakMap();
function nativeSource(value){return nativeSources.get(value)||null;}
function effect(sim, e, kind, data = {}) {
  const s = state(e);
  s.effects = s.effects.filter(f => f.kind !== kind || data.source !== undefined && f.source !== data.source);
  const {sourceActor=e,...values}=data;
  const row = { kind, start: sim.time, expires: sim.time + (data.duration ?? 0), ...values };
  nativeSources.set(row,sourceActor);
  s.effects.push(row); return row;
}
const has = (sim, e, kind) => activeEffects(sim, e).some(f => f.kind === kind);
function cleanseActive(sim, e) { return has(sim, e, 'cleanse'); }
function cleanse(sim, e) {
  const s = state(e);
  const hadBlackRockDebuffs=(e.blackRockDebuffs?.size||0)>0;
  if(hadBlackRockDebuffs)e.blackRockDebuffs.clear();
  const changed = hadBlackRockDebuffs || s.effects.some(f => f.negative) || (e.buffs || []).some(b => b.negative || b.debuff) || e.controlUntil > sim.time;
  s.effects = s.effects.filter(f => !f.negative);
  e.buffs = (e.buffs || []).filter(b => !b.negative && !b.debuff);
  e.controlUntil = 0;
  if (changed) sim.event('summoner-cleanse', { id: e.id });
}
function canAct(sim, e, action) {
  if (cleanseActive(sim, e)) return true;
  return !activeEffects(sim, e).some(f =>
    f.kind === 'root' && action === 'move' || f.kind === 'seal' &&
    (action === 'attack' || action === 'cast') && sim.time < f.start + .75);
}
function target(sim, e, skill, aim) {
  const t = sim.entities.get(aim.targetId);
  return t?.kind === 'hero' && sim.enemies(e, t) && distance(e, t) <= skill.range ? t : null;
}
function validateCast(sim, e, skill, aim = {}) {
  if (!e || !definitions[skill?.id]) return { ok: false, reason: 'unknown-summoner-skill' };
  if (!allowedSkillIds(mapId(sim)).includes(skill.id)) return { ok: false, reason: 'summoner-map' };
  if (skill.id === 8023) {
    if (e.alive || e.kind !== 'hero') return { ok: false, reason: 'revive-requires-death' };
    return { ok: true };
  }
  if (!e.alive) return { ok: false, reason: 'dead' };
  if(skill.id===8026&&e.channel?.skillId===8026)return {ok:true,recast:true};
  if (skill.id === 8031 || skill.id === 8066) return { ok: true };
  if (!canAct(sim, e, 'cast') || e.controlUntil > sim.time) return { ok: false, reason: 'controlled' };
  if ([8033, 8059, 8065].includes(skill.id)) {
    const t = target(sim, e, skill, aim);
    if (!t) return { ok: false, reason: 'range-or-target' };
    if (skill.id === 8059 && (t.summonerState?.sealProtectedUntil || 0) > sim.time)
      return { ok: false, reason: 'seal-repeat-protection' };
    return { ok: true, targetId: t.id };
  }
  if (skill.id === 8008) {
    const mark = state(e).hookMark;
    const marked = mark && mark.expires > sim.time ? sim.entities.get(mark.targetId) : null;
    if (marked && sim.enemies(e, marked)) return { ok: true, recast: true, targetId: marked.id };
    const dx = Number.isFinite(aim.dirX) ? aim.dirX : Number.isFinite(aim.x) ? aim.x - e.x : 0;
    const dz = Number.isFinite(aim.dirZ) ? aim.dirZ : Number.isFinite(aim.z) ? aim.z - e.z : 0;
    const length = Math.hypot(dx, dz);
    if (!(length > 0) || !Number.isFinite(length)) return { ok: false, reason: 'direction' };
    const hits = [...sim.entities.values()].filter(t => {
      if (!sim.enemies(e, t) || ['tower', 'base', 'barracks', 'fountain'].includes(t.kind)) return false;
      const x = t.x - e.x, z = t.z - e.z;
      return (x * dx + z * dz) / length >= 0 && (x * dx + z * dz) / length <= skill.range &&
        Math.abs(x * dz - z * dx) / length <= skill.width + (t.bodyRadius || 0);
    }).sort((a, b) => distance(e, a) - distance(e, b));
    return { ok: true, targetId: hits[0]?.id, direction: { x: dx / length, z: dz / length } };
  }
  return { ok: true };
}
function castCooldown(sim, e, skill) {
  const base=skill.id === 8023 && !battlefield(sim)
    ? skill.cooldown * (1 + .2 * (state(e).reviveUses || 0)) : skill.cooldown;
  return base*(skill.summoner&&require('./battle-progression-effects').hasGodsend(e,6) ? .65 : 1);
}
function grantShield(sim, e, amount,sourceActor=e) {
  const s = state(e);
  if (s.shield) sim.setShield(e, Math.max(0, (e.shield || 0) - s.shield.remaining));
  s.shield = { initial: amount, remaining: amount, start: sim.time, decayStart: sim.time + .5, expires: sim.time + 1.5 };
  nativeSources.set(s.shield,sourceActor);
  sim.setShield(e, (e.shield || 0) + amount);
}
function heal(sim, e, amount, skillId) {
  if (typeof sim.heal === 'function') return sim.heal(e, amount, {skillId, reason:'summoner-healing'});
  const before = e.hp;
  e.hp = Math.min(e.hpMax, e.hp + Math.max(0, Math.floor(amount)));
  if (e.hp > before) sim.event('heal', { id: e.id, hp: e.hp, mp: e.mp, amount: e.hp - before, skillId, skillLevel:1 });
}
function applyCast(sim, e, slot, aim = {}, validated) {
  const skill = e.skills[slot], checked = validated || validateCast(sim, e, skill, aim);
  if (!checked.ok) return checked;
  const s = state(e), id = skill.id;
  if (id === 8023) {
    if (battlefield(sim)) effect(sim, e, 'revive-hp', { duration: 120, health: 1200 });
    if (talent(e)) effect(sim, e, 'revive-talent', { duration: Infinity, damageReduction: 5, skillSurge: 10 });
    s.reviveUses = (s.reviveUses || 0) + 1;
    if (typeof sim.revive !== 'function') throw new Error('Summoner revive requires sim.revive(hero)');
    sim.revive(e); sim.updateBuffs(e); e.hp = e.hpMax;
  } else if (id === 8028 || id === 8063) {
    effect(sim, e, 'run', { skillId: id, duration: id === 8028 ? 10 : 4,
      maximum: sim.time + (id === 8028 ? 10 : 12), initialSpeed: id === 8063 || e.baseRange < 3 ? 75 : 45,
      finalSpeed: id === 8028 ? 25 : 30, tenacity: id === 8028 ? 15 : 30 });
  } else if (id === 8029) {
    const baseHP = e.equipmentBase?.[8] ?? e.baseHPMax ?? e.hpMax;
    const base = clamp(baseHP * .2, 60, 315) * (battlefield(sim) ? 2 : 1);
    for (const ally of sim.entities.values()) if (ally.alive && ally.kind === 'hero' && ally.team === e.team && distance(e, ally) <= 5) {
      const a = state(ally), repeated = (a.guardProtectedUntil || 0) > sim.time;
      const missing = talent(e) && ally.id === e.id ? .8 * (1 - e.hp / e.hpMax) : 0;
      const amount = Math.floor(base * (ally.id === e.id ? 1.66 : 1) * (1 + missing) * (repeated ? .5 : 1));
      grantShield(sim, ally, amount,e); a.guardProtectedUntil = sim.time + 30;nativeSources.set(a,e);
    }
  } else if (id === 8030) {
    const factor = battlefield(sim) ? 2 : 1;
    effect(sim, e, 'potential', { duration: 12, attackSpeed: (21 + 3 * level(e)) * factor,
      abilityPower: (6 + 4 * level(e)) * factor, range: talent(e) ? 1 : 0 });
  } else if (id === 8031 || id === 8066) {
    cleanse(sim, e); effect(sim, e, 'cleanse', { duration: 1.2,
      speedPercent: id === 8066 ? 40 : 15, tenacity: id === 8031 && !battlefield(sim) ? 1000 : 0 });
    if (id === 8031 && talent(e)) effect(sim, e, 'cleanse-burst', { duration: .6, speedPercent: 200 });
  } else if (id === 8032) {
    effect(sim, e, 'arcane', { duration: 20, nextRecovery: sim.time + 1, cooldownRate: .25 });
  } else if (id === 8033) {
    const t = sim.entities.get(checked.targetId), source = `${e.id}:${slot}`;
    effect(sim, t, 'barrage-mark', { sourceActor:e,source, negative: true, duration: 5 });
    effect(sim, e, 'barrage', { source, duration: 5 + 1e-6, targetId: t.id, nextShot: sim.time + .25,
      end: sim.time + 5, consumedHealing: 0, rootTriggered: false });
  } else if (id === 8059 || id === 8065) {
    const t = sim.entities.get(checked.targetId);
    if (!cleanseActive(sim, t)) {
      effect(sim, t, id === 8059 ? 'seal' : 'weak', { sourceActor:e,duration: id === 8059 ? 1.5 : 2,
        negative: true, attackPercent: id === 8059 && talent(e) ? -20 : 0, abilityPowerPercent: id === 8059 && talent(e) ? -20 : 0 });
      if (id === 8059) {
        state(t).sealProtectedUntil = sim.time + 5;
        sim.cancelChannel(t, 'seal'); sim.cancelWindup(t); sim.stopMotion(t);
        sim.interruptSkills?.(t,'seal');
      }
      sim.updateBuffs(t);
    }
  } else if (id === 8008) {
    const t = sim.entities.get(checked.targetId);
    if (checked.recast && t) {
      const landing = sim.freeSpawn(t, e.bodyRadius || 0, e.id);
      sim.cancelWindup(e); sim.stopMotion(e); Object.assign(e, landing, { path: [], targetId: null });
      sim.event('position', { id: e.id, ...landing, teleport: true }); s.hookMark = null;
    } else if (t) {
      s.hookMark = { targetId: t.id, expires: sim.time + 3 };
      sim.damage(e, t, scaled(e, 15, 105), 8007, 'true', undefined, undefined, { summoner: true });
    }
  } else if (id === 8035 && talent(e)) {
    for (const t of sim.entities.values()) if (sim.enemies(e, t) && distance(e, t) <= 5 && !cleanseActive(sim, t))
      effect(sim, t, 'blink-slow', { sourceActor:e,duration: 2, negative: true, speedPercent: -15 });
  }
  sim.updateBuffs(e);
  return { ok: true, targets: checked.targetId !== undefined ? [checked.targetId] : [] };
}
function modifiers(sim, e) {
  const result = { speedPercent: 0, attackPercent: 0, attackSpeed: 0, abilityPower: 0, abilityPowerPercent: 0,
    tenacity: 0, health: 0, damageReduction: 0, skillSurge: 0, range: 0, cooldownRate: 0,
    damageMultiplier: 1, movementMultiplier: 1 };
  for (const f of activeEffects(sim, e)) {
    for (const key of ['speedPercent', 'attackPercent', 'attackSpeed', 'abilityPower', 'abilityPowerPercent',
      'tenacity', 'health', 'damageReduction', 'skillSurge', 'range', 'cooldownRate']) result[key] += f[key] || 0;
    if (f.kind === 'run') result.speedPercent += f.initialSpeed + (f.finalSpeed - f.initialSpeed) * clamp((sim.time - f.start) / 2.5, 0, 1);
    if (f.kind === 'weak') { result.movementMultiplier *= .4; result.damageMultiplier *= .4; }
    if (f.kind === 'seal') { const release = clamp((sim.time - f.start) / 1.5, 0, 1); result.movementMultiplier *= release; result.damageMultiplier *= release; }
    if (f.kind === 'root') { result.movementMultiplier = 0; result.rooted = true; }
  }
  return result;
}
function onHeal(sim, e, amount) {
  if (!(amount > 0)) return;
  const s = state(e); s.heals = s.heals.filter(h => h.time >= sim.time - 5);
  s.heals.push({ sequence: ++s.healSequence, time: sim.time, amount });
}
function onBasicHit(sim, e) {
  const run = activeEffects(sim, e).find(f => f.kind === 'run' && f.skillId === 8063);
  if (run) run.expires = Math.min(run.maximum, sim.time + 4);
}
function onKill(sim, e) {
  if (battlefield(sim)) return;
  for (const [slot, skill] of Object.entries(e.skills)) if (skill.id === 8023 && e.cooldowns[slot] > sim.time) {
    e.cooldowns[slot] = Math.max(sim.time, e.cooldowns[slot] - 15);
    sim.event('skill-cooldown', { id: e.id, skill, readyAt: e.cooldowns[slot] });
  }
}
function absorbShield(sim, e, amount) {
  const shield = e.summonerState?.shield;
  if (!shield) return 0;
  const consumed = Math.min(shield.remaining, Math.max(0, amount));
  shield.remaining -= consumed; return consumed;
}
function onDeath(sim, e) {
  const s = e.summonerState;
  if (!s) return;
  s.effects = []; s.heals = []; s.shield = null; s.hookMark = null;
}
function tick(sim, e, dt) {
  const s = e.summonerState;
  if (!s || !e.alive) return;
  if (cleanseActive(sim, e)) cleanse(sim, e);
  if (s.shield) {
    const q = s.shield;
    if (sim.time > q.decayStart) {
      // Consumption is subtracted by absorbShield; only unspent shield heals.
      const decay = Math.min(q.remaining, q.initial * Math.min(dt, sim.time - q.decayStart));
      const amount = Math.min(q.remaining, Math.max(0, Math.floor(decay + (q.fraction || 0))));
      q.fraction = decay + (q.fraction || 0) - amount;
      if (amount) { q.remaining -= amount; sim.setShield(e, Math.max(0, (e.shield || 0) - amount)); heal(sim, e, amount, 8029); }
    }
    if (sim.time + 1e-9 >= q.expires) {
      const rest = q.remaining; if (rest) { sim.setShield(e, Math.max(0, (e.shield || 0) - rest)); heal(sim, e, rest, 8029); }
      s.shield = null;
    }
  }
  for (const f of [...s.effects]) {
    if (f.kind === 'arcane') while (f.nextRecovery <= Math.min(sim.time, f.expires) + 1e-9) {
      const amount = Math.floor(40 + .1 * Math.max(0, e.mpMax - e.mp));
      if (talent(e) && e.mp >= e.mpMax) heal(sim, e, amount, 8032);
      else { const before = e.mp; e.mp = Math.min(e.mpMax, e.mp + amount); if (e.mp !== before) sim.event('heal', { id: e.id, hp: e.hp, mp: e.mp, amount: 0 }); }
      f.nextRecovery += 1;
    }
    if (f.kind === 'barrage') {
      const t = sim.entities.get(f.targetId), mark = t && activeEffects(sim, t).some(q => q.kind === 'barrage-mark' && q.source === f.source);
      if (!t || !sim.enemies(e, t) || (!mark && sim.time < f.end - 1e-9)) { f.expires = sim.time; continue; }
      while (f.nextShot <= Math.min(sim.time, f.end) + 1e-9 && t.alive) {
        const healing = (t.summonerState?.heals || []).filter(h => h.time >= f.nextShot - 5 && h.time <= f.nextShot && h.sequence > f.consumedHealing);
        if (healing.length) f.consumedHealing = Math.max(...healing.map(h => h.sequence));
        const amount = scaled(e, 4, 22) * (battlefield(sim) ? 2 : 1) + healing.reduce((sum, h) => sum + h.amount, 0) * .5;
        sim.damage(e, t, amount, 8038, 'true', undefined, undefined, { summoner: true });
        if (talent(e) && !f.rootTriggered && f.nextShot >= f.start + 2.5) {
          f.rootTriggered = true;
          // The talent root uses the same target tenacity clock as other
          // roots; VIP and temporary tenacity must affect gameplay here too.
          const duration=1-clamp(Number(t.attributes?.[99])||0,0,100)/100;
          if (duration>0&&!cleanseActive(sim, t)) effect(sim, t, 'root', { sourceActor:e,duration, negative: true });
        }
        f.nextShot += .25;
      }
    }
  }
  s.effects = s.effects.filter(f => f.expires > sim.time + 1e-9);
  s.heals = s.heals.filter(h => h.time >= sim.time - 5);
  if (s.hookMark?.expires <= sim.time) s.hookMark = null;
}
module.exports = { definitions, definition, allowedSkillIds, validSelection, validateCast, applyCast, castCooldown,
  nativeSource,tick, modifiers, canAct, cleanseActive, onHeal, onBasicHit, onKill, onDeath, absorbShield };
