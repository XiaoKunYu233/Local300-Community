'use strict';

// Combat state belongs to an actor object and one life/loadout in one match.
// Configuration values come from warsoulsuccinct, never a status-id offset.
const entries = require('./war-soul-entry-effects');
const summoners = require('./summoner-effects');
const states = new WeakMap();
const sourceOwners = new WeakMap();
let nextOwner = 1;
const prefix = 'war-soul-entry:';
const procOptions = element => ({equipmentProc: true, warSoulProc: true,
  equipmentProcs: false, basic: false, allowCritical: false, element});
// Local reconstruction of the current client's rock-spike flight resource:
// height=1, acceleration=300/10, round-trip flat-ground flight time. This is
// a client-motion-derived baseline, not evidence of the original server timer.
const mountainClientFlightDuration = 2 * Math.sqrt(2 / 30);

function alive(sim, actor) {
  return !sim.heroes?.closed && !!actor?.alive && (!Number.isFinite(actor.hp) || actor.hp > 0) &&
    (!sim.entities || sim.entities.get(actor.id) === actor);
}
function fingerprint(model) {
  return JSON.stringify(model.effects.map(effect => [effect.element, effect.kind,
    effect.statusId, effect.values, effect.eligible, effect.coreKind]));
}
function releaseShield(state) {
  const shield = state.shield;
  state.shield = null;
  if (!shield || !(shield.remaining > 0)) return;
  const hero = state.hero;
  // A removed source can release only its own remainder, in its original life.
  if ((hero.reviveCount || 0) !== state.life ||
      state.sim.entities && state.sim.entities.get(hero.id) !== hero) return;
  state.sim.setShield?.(hero, Math.max(0, (hero.shield || 0) - shield.remaining));
}
function clear(state) {
  if (!state) return;
  const hero = state.hero;
  // Already-applied target debuffs keep their target-owned expiry even when
  // the source dies or changes equipment. Only the source's private temporary
  // buffs and clocks belong to this installation; drop target references.
  hero.buffs = (hero.buffs || []).filter(buff => buff.warSoulEntryOwner !== state.owner);
  releaseShield(state);
  state.touched.clear();
}
function install(sim, hero, policy) {
  const old = states.get(hero);
  clear(old);
  const model = entries.aggregate(hero);
  const suppliedPolicy = policy || hero.warSoulEntryPolicy || sim.warSoulEntryPolicy || {};
  if (!sourceOwners.has(hero)) sourceOwners.set(hero, nextOwner++);
  const state = {sim, hero, life: hero.reviveCount || 0, key: fingerprint(model), model,
    policy: {mountainCoreHealthBasis: 'current', mountainKnockupDuration: mountainClientFlightDuration,
      ...suppliedPolicy, procSkillId: {36311: 405, ...suppliedPolicy.procSkillId}},
    cooldowns: new Map(), touched: new Set(), owner: nextOwner++,
    sourceOwner: sourceOwners.get(hero), shield: null};
  states.set(hero, state);
  return state;
}
function getState(sim, hero) {
  if (!hero) return null;
  const model = entries.aggregate(hero), key = fingerprint(model), old = states.get(hero);
  if (!old || old.sim !== sim || old.life !== (hero.reviveCount || 0) || old.key !== key)
    return install(sim, hero, old?.sim === sim ? old.policy : undefined);
  old.model = model;
  return old;
}
function current(state) {
  return states.get(state.hero) === state && alive(state.sim, state.hero) &&
    (state.hero.reviveCount || 0) === state.life;
}
function effect(state, element, kind) {
  return entries.getEffect(state.model, element, kind);
}
function core(state, element) {
  const value = state.model.elements[element]?.core;
  return value?.eligible ? value : null;
}
function isReady(state, statusId, now) {
  return (state.cooldowns.get(statusId) ?? -Infinity) <= now;
}
function consume(state, statusId, cooldown) {
  if (!isReady(state, statusId, state.sim.time)) return false;
  state.cooldowns.set(statusId, state.sim.time + cooldown);
  return true;
}
function roll(state, value, cooldown) {
  if (!isReady(state, value.statusId, state.sim.time)) return false;
  // Duplicates are already aggregated: one roll and one clock per status.
  if (state.sim.random() >= .25) return false;
  state.cooldowns.set(value.statusId, state.sim.time + cooldown);
  return true;
}
function event(state, value, name, target, details = {}) {
  if (state.sim.heroes?.closed) return;
  state.sim.event?.('passive', {id: state.hero.id, target: target?.id,
    effect: name, statusId: value.statusId, element: value.element,
    level: value.level, ...details});
}
function refresh(state, target, value, kind, duration, fields) {
  if (!current(state) || !alive(state.sim, target) || !(duration > 0)) return false;
  // Keep one source/status slot across a source reinstall: the next proc
  // refreshes its still-live debuff rather than stacking a second slow/root.
  const slot = `${prefix}${state.sourceOwner}:${value.statusId}:${kind}`;
  target.buffs ||= [];
  target.buffs = target.buffs.filter(buff => buff.slot !== slot);
  target.buffs.push({slot, until: state.sim.time + duration,
    warSoulEntryOwner: state.owner, warSoulEntry: true,
    sourceId: state.hero.id, sourceLife: state.life, statusId: value.statusId,
    nativeStatusId: value.statusId,
    ...fields});
  state.touched.add(target);
  state.sim.updateBuffs?.(target);
  return current(state) && alive(state.sim, target);
}
function controlAllowed(state, target) {
  const sim = state.sim;
  if ((target.controlImmuneUntil || 0) > sim.time || target.effectModifiers?.controlImmune ||
      sim.heroes?.modifiers?.(target)?.controlImmune || sim.guardActive?.(target) ||
      summoners.cleanseActive(sim, target)) return false;
  if (typeof state.policy.controlAllowed === 'function') return state.policy.controlAllowed(sim, target);
  return true;
}
function procDamage(state, target, value, {enableNativeKnockup = false} = {}) {
  if (!current(state) || !alive(state.sim, target)) return 0;
  const amount = Math.max(0, Number(value.values[1]) || 0);
  if (!(amount > 0)) return 0;
  // Forest/wind use a neutral valid ID; the mountain baseline maps to the
  // audited current-client rock-spike resource 405. This local visual mapping
  // is not an original-server packet claim. Status visuals use their own ID;
  // 540000 + statusId would overflow the wire's uint16 skill field.
  const configured = Number(state.policy.procSkillId?.[value.statusId] ?? 0);
  const skillId = Number.isInteger(configured) && configured >= 0 && configured <= 0xffff ? configured : 0;
  const options = procOptions(value.element);
  // The audited 405 consumer starts its target flight from this exact hit
  // flag. Keep it confined to rock spike, never other true-damage procs.
  if (value.element === 'mountain' && value.kind === 11 && enableNativeKnockup) {
    options.nativeHitEffectFlag = 0x100;
    options.nativeHitPosition = {x: target.x, z: target.z};
  }
  return state.sim.damage(state.hero, target, amount, skillId, 'true', undefined,
    undefined, options);
}
function offensiveProc(state, target, value) {
  const sim = state.sim, life = target.reviveCount || 0;
  if (value.element === 'wind') {
    if (!roll(state, value, 6)) return;
    const amount = procDamage(state, target, value);
    if (current(state) && alive(sim, target) && (target.reviveCount || 0) === life)
      refresh(state, target, value, 'slow', 2, {negative: true, debuff: true, speed: .5});
    event(state, value, 'war-soul-blade', target, {amount});
  } else if (value.element === 'forest') {
    if (!roll(state, value, 15)) return;
    const amount = procDamage(state, target, value);
    if (current(state) && alive(sim, target) && (target.reviveCount || 0) === life && controlAllowed(state, target)) {
      const duration = .5 * (1 - Math.max(0, Math.min(100, Number(target.attributes?.[99]) || 0)) / 100);
      // Root denies only movement. It never calls the stun/interrupt API.
      if (refresh(state, target, value, 'root', duration, {negative: true, debuff: true, rooted: true}))
        sim.stopMotion?.(target);
    }
    event(state, value, 'war-soul-entangle', target, {amount, duration: .5});
  }
}
function totalBonus(hero, value) {
  return Math.max(0, Math.floor(entries.total(hero, value.element) * (Number(value.values[1]) || 0) / 100 +
    (Number(value.values[2]) || 0)));
}
function eligibleContext(context) {
  return Number(context.amount) > 0 && !context.equipmentProc && !context.warSoulProc &&
    !context.deferred && context.equipmentProcs !== false;
}
function onDamage(sim, attacker, target, context = {}) {
  if (!alive(sim, attacker) || !target || !eligibleContext(context)) return;
  const state = getState(sim, attacker), targetLife = target.reviveCount || 0;
  const canTarget = () => current(state) && alive(sim, target) && (target.reviveCount || 0) === targetLife;
  // The speed and healing effects do not depend on the victim surviving.
  const speed = core(state, 'wind');
  if (speed) {
    refresh(state, attacker, speed, 'speed', 2, {speed: 1.35});
    event(state, speed, 'war-soul-speed', attacker);
  }
  for (const value of state.model.effects) {
    if (!current(state)) return;
    if (value.kind === 12 && consume(state, value.statusId, 30)) {
      const amount = totalBonus(attacker, value);
      const gained = sim.heal(attacker, amount, {source: attacker, reason: 'war-soul-heal'});
      event(state, value, 'war-soul-heal', attacker, {amount: gained});
    } else if (value.kind === 13 && consume(state, value.statusId, 30)) {
      const amount = totalBonus(attacker, value);
      refresh(state, attacker, value, 'offense', 3, {attackBonus: amount, abilityPower: amount});
      event(state, value, 'war-soul-offense', attacker, {amount});
    }
  }
  const grievous = core(state, 'fire');
  if (grievous && canTarget()) {
    refresh(state, target, grievous, 'grievous', 3, {negative: true, debuff: true, healingReduction: 50});
    event(state, grievous, 'war-soul-grievous', target, {amount: 50, duration: 3});
  }
  for (const element of ['wind', 'forest']) {
    const value = effect(state, element, 11);
    if (value && canTarget()) offensiveProc(state, target, value);
  }
}
function onBasicHit(sim, attacker, target, context = {}) {
  if (!alive(sim, attacker) || !alive(sim, target) || !eligibleContext(context)) return;
  const state = getState(sim, attacker), life = target.reviveCount || 0;
  const fire = effect(state, 'fire', 11), mountain = effect(state, 'mountain', 11);
  if (fire && Number(state.policy.fireBurstRadius) > 0 && roll(state, fire, 8)) {
    const radius = Number(state.policy.fireBurstRadius), x = target.x, z = target.z;
    // Snapshot identities: event observers may remove or revive other targets.
    const victims = [...(sim.entities?.values() || [target])].filter(victim =>
      alive(sim, victim) && sim.enemies(attacker, victim) &&
      Math.hypot(victim.x - x, victim.z - z) <= radius).map(victim => ({victim, life: victim.reviveCount || 0}));
    let amount = 0;
    for (const entry of victims) {
      if (!current(state)) return;
      if (alive(sim, entry.victim) && (entry.victim.reviveCount || 0) === entry.life)
        amount += procDamage(state, entry.victim, fire);
    }
    event(state, fire, 'war-soul-fire-burst', target, {amount, radius});
  }
  if (!current(state) || !alive(sim, target) || (target.reviveCount || 0) !== life) return;
  if (mountain && roll(state, mountain, 15)) {
    const duration = Number(state.policy.mountainKnockupDuration);
    // Gate the native motion before creating the damage event: an immune
    // target still takes rock-spike damage, but its client must not jump.
    const provider = typeof state.policy.knockup === 'function' || typeof sim.knockup === 'function';
    const allowed = duration > 0 && provider && controlAllowed(state, target);
    const amount = procDamage(state, target, mountain, {enableNativeKnockup: allowed});
    if (current(state) && alive(sim, target) && (target.reviveCount || 0) === life &&
        allowed && controlAllowed(state, target)) {
      // A dedicated knockup provider owns displacement and native playback.
      // No duration is invented, and a stun cannot impersonate a knockup.
      if (typeof state.policy.knockup === 'function') state.policy.knockup(sim, attacker, target, duration, mountain);
      else if (typeof sim.knockup === 'function') sim.knockup(target.id, duration, attacker, mountain);
    }
    event(state, mountain, 'war-soul-rock-spike', target, {amount,
      duration: duration > 0 ? duration : undefined, knockupConfigured: duration > 0 &&
        (typeof state.policy.knockup === 'function' || typeof sim.knockup === 'function')});
  }
}
function reduceIncoming(sim, target, attacker, amount, context = {}) {
  if (!alive(sim, target) || !Number.isFinite(amount) || !(amount > 0) || context.deferred) return amount;
  const state = getState(sim, target), rock = core(state, 'mountain');
  // This hook receives post-mitigation, pre-shield damage. The HP basis must be
  // explicitly chosen from confirmed rules rather than inferred from prose.
  const basis = state.policy.mountainCoreHealthBasis;
  const health = basis === 'maximum' ? target.hpMax : basis === 'current' ? target.hp : NaN;
  if (rock && Number.isFinite(health) && health > 0 && amount > health * .25 &&
      consume(state, rock.statusId, 3)) {
    const reduced = amount * .2;
    event(state, rock, 'war-soul-rock', target, {amount, reduced, healthBasis: basis});
    return reduced;
  }
  return amount;
}
function onDamageTaken(sim, target, attacker, context = {}) {
  if (!alive(sim, target) || !(Number(context.amount) > 0) || context.deferred) return;
  const state = getState(sim, target);
  for (const value of state.model.effects) {
    if (!current(state)) return;
    if (value.kind === 14 && consume(state, value.statusId, 20)) {
      const amount = totalBonus(target, value);
      refresh(state, target, value, 'defense', 3, {armorBonus: amount, magicResistanceBonus: amount});
      event(state, value, 'war-soul-defense', target, {amount});
    } else if (value.kind === 15 && !(target.shield > 0) && consume(state, value.statusId, 30)) {
      const amount = totalBonus(target, value);
      if (!(amount > 0)) continue;
      state.shield = {remaining: amount, until: sim.time + 3};
      sim.setShield(target, amount);
      event(state, value, 'war-soul-barrier', target, {amount});
    }
  }
}
function onShieldAbsorbed(sim, target, amount) {
  const state = states.get(target);
  if (!state || state.sim !== sim || !state.shield || !(amount > 0) ||
      state.life !== (target.reviveCount || 0) ||
      sim.entities && sim.entities.get(target.id) !== target) return 0;
  const consumed = Math.min(amount, Math.max(0, state.shield.remaining));
  state.shield.remaining -= consumed;
  return consumed;
}
function healingBonus(sim, source, target) {
  if (!alive(sim, target)) return 0;
  const targetCore = core(getState(sim, target), 'forest');
  const sourceCore = alive(sim, source) ? core(getState(sim, source), 'forest') : null;
  return targetCore || sourceCore ? 50 : 0;
}
function tick(sim, hero) {
  if (sim.heroes?.closed) return;
  const state = getState(sim, hero);
  if (!state) return;
  if (!hero.alive) { clear(state); return; }
  if (state.shield && state.shield.until <= sim.time) releaseShield(state);
  for (const actor of state.touched) {
    if (!(actor.buffs || []).some(buff => buff.warSoulEntryOwner === state.owner && buff.until > sim.time))
      state.touched.delete(actor);
  }
}
function controlledModifiers(hero, time) {
  return {rooted: (hero.buffs || []).some(buff => buff.warSoulEntry && buff.rooted && buff.until > time)};
}
function onDeath(sim, hero) {
  const state = states.get(hero);
  if (state?.sim !== sim) return;
  clear(state);
  states.delete(hero);
}

module.exports = {install, tick, onDamage, onBasicHit, reduceIncoming, onDamageTaken,
  healingBonus, controlledModifiers, onShieldAbsorbed, onDeath};
