'use strict';

const { performance } = require('node:perf_hooks');

const SELECT_MS = 90_000;
const PREPARE_MS = 4_000;

function immutableSkills(skills) {
  return Object.freeze({ ...skills });
}

class BattleSelection {
  constructor({ heroes, timeoutPolicy, skillSlots, initialSkills, isValidCombination, now = () => performance.now() }) {
    if (!Array.isArray(heroes) || !heroes.length || heroes.some(id => !Number.isInteger(id) || id <= 0))
      throw new TypeError('heroes must be a nonempty list of supported hero IDs');
    if (new Set(heroes).size !== heroes.length) throw new TypeError('heroes must be unique');
    if (!timeoutPolicy || timeoutPolicy.kind !== 'selected-or-default' || !heroes.includes(timeoutPolicy.defaultHero))
      throw new TypeError('timeoutPolicy requires a supported defaultHero');
    if (!skillSlots || typeof skillSlots !== 'object' || Array.isArray(skillSlots) || !Object.keys(skillSlots).length)
      throw new TypeError('skillSlots must define at least one slot');
    if (!initialSkills || typeof initialSkills !== 'object' || Array.isArray(initialSkills))
      throw new TypeError('initialSkills must provide each slot');
    if (typeof isValidCombination !== 'function' || typeof now !== 'function')
      throw new TypeError('isValidCombination and now must be functions');

    this.heroes = new Set(heroes);
    this.timeoutPolicy = Object.freeze({ kind: timeoutPolicy.kind, defaultHero: timeoutPolicy.defaultHero });
    this.skillSlots = new Map();
    for (const [slot, choices] of Object.entries(skillSlots)) {
      if (!Array.isArray(choices) || !choices.length || choices.some(id => !Number.isInteger(id) || id <= 0))
        throw new TypeError(`Invalid skill choices for slot ${slot}`);
      this.skillSlots.set(slot, new Set(choices));
    }
    if (Object.keys(initialSkills).length !== this.skillSlots.size) throw new TypeError('initialSkills must match skillSlots');
    const skills = {};
    for (const [slot, choices] of this.skillSlots) {
      if (!choices.has(initialSkills[slot])) throw new TypeError(`Invalid initial skill for slot ${slot}`);
      skills[slot] = initialSkills[slot];
    }
    if (!isValidCombination(immutableSkills(skills))) throw new TypeError('Invalid initial skill combination');

    this.isValidCombination = isValidCombination;
    this.now = now;
    this.lastNow = null;
    this.phase = 'idle';
    this.deadlineMs = null;
    this.heroId = null;
    this.skills = skills;
    this.confirmed = false;
    this.result = null;
    this.events = [];
  }

  _time() {
    const value = this.now();
    if (!Number.isFinite(value) || (this.lastNow !== null && value < this.lastNow))
      throw new RangeError('now must return monotonic finite milliseconds');
    this.lastNow = value;
    return value;
  }

  _complete(reason, heroSource, completedAtMs) {
    this.phase = 'waiting-loading';
    this.deadlineMs = null;
    const snapshot = Object.freeze({
      type: 'selection-complete',
      reason,
      heroSource,
      heroId: this.heroId,
      skills: immutableSkills(this.skills),
      completedAtMs,
      timeoutPolicy: reason === 'timeout' ? this.timeoutPolicy.kind : null,
    });
    this.result = snapshot;
    this.events.push(snapshot);
  }

  _settle(now) {
    if (this.phase === 'selecting' && now >= this.deadlineMs) {
      const selected = this.heroId !== null;
      if (!selected) this.heroId = this.timeoutPolicy.defaultHero;
      this._complete('timeout', selected ? 'selected' : 'default', this.deadlineMs);
    } else if (this.phase === 'preparing' && now >= this.deadlineMs) {
      this._complete('confirmed', 'confirmed', this.deadlineMs);
    }
  }

  _state(now) {
    return Object.freeze({
      phase: this.phase,
      heroId: this.heroId,
      skills: immutableSkills(this.skills),
      confirmed: this.confirmed,
      deadlineMs: this.deadlineMs,
      remainingSeconds: this.deadlineMs === null ? null : Math.ceil(Math.max(0, this.deadlineMs - now) / 1000),
      result: this.result,
    });
  }

  getState() {
    const now = this._time();
    this._settle(now);
    return this._state(now);
  }

  tick() { return this.getState(); }

  enter() {
    const now = this._time();
    this._settle(now);
    if (this.phase !== 'idle') return { ok: false, reason: 'already-entered' };
    this.phase = 'selecting';
    this.deadlineMs = now + SELECT_MS;
    return { ok: true, state: this._state(now) };
  }

  chooseHero(heroId) {
    const now = this._time();
    this._settle(now);
    if (this.phase === 'preparing') return { ok: false, reason: 'hero-locked' };
    if (this.phase !== 'selecting') return { ok: false, reason: 'not-selecting' };
    if (!this.heroes.has(heroId)) return { ok: false, reason: 'unsupported-hero' };
    this.heroId = heroId;
    return { ok: true };
  }

  chooseSkill(slot, skillId) {
    return this.chooseSkills({ [slot]: skillId });
  }

  chooseSkills(changes,{commit}={}) {
    const now = this._time();
    this._settle(now);
    if (this.phase !== 'selecting' && this.phase !== 'preparing') return { ok: false, reason: 'selection-closed' };
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length)
      return { ok: false, reason: 'invalid-slot' };
    const candidate = { ...this.skills };
    for (const [key, skillId] of Object.entries(changes)) {
      const choices = this.skillSlots.get(key);
      if (!choices) return { ok: false, reason: 'invalid-slot' };
      if (!choices.has(skillId)) return { ok: false, reason: 'unsupported-skill' };
      candidate[key] = skillId;
    }
    if (!this.isValidCombination(immutableSkills(candidate))) return { ok: false, reason: 'invalid-combination' };
    if(commit!==undefined){
      if(typeof commit!=='function')throw TypeError('Invalid summoner selection commit');
      const saved=commit(immutableSkills(candidate));
      if(saved===false||saved?.ok===false)return {ok:false,reason:saved?.reason||'selection-save-failed'};
    }
    this.skills = candidate;
    // Runtime request logs need the actual native pair, not just an "ok" flag.
    // A later scene import can otherwise hide what the client selected.
    return { ok: true, skills: immutableSkills(candidate), requested: immutableSkills(changes) };
  }

  confirm() {
    const now = this._time();
    this._settle(now);
    if (this.phase === 'preparing') return { ok: true, repeated: true };
    if (this.phase !== 'selecting') return { ok: false, reason: 'not-selecting' };
    if (this.heroId === null) return { ok: false, reason: 'hero-required' };
    this.confirmed = true;
    this.phase = 'preparing';
    this.deadlineMs = now + PREPARE_MS;
    return { ok: true, state: this._state(now) };
  }

  leave() {
    const now = this._time();
    this._settle(now);
    if (this.phase === 'left' || this.phase === 'closed') return { ok: false, reason: 'terminal' };
    this.phase = 'left';
    this.deadlineMs = null;
    this.events = []; // A terminal session must not deliver an unconsumed start event.
    return { ok: true };
  }

  close() {
    const now = this._time();
    this._settle(now);
    if (this.phase === 'closed') return { ok: false, reason: 'terminal' };
    this.phase = 'closed';
    this.deadlineMs = null;
    this.events = [];
    return { ok: true };
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }
}

module.exports = { BattleSelection, SELECT_MS, PREPARE_MS };
