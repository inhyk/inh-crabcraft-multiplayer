// The player's crab: WASD movement with acceleration, WoW-style turning and steering, jumping,
// targeting, auto-attack, casts and channels, resources, cooldowns and the global cooldown. What the
// player sees and hears of it (cast bar, errors, XP, effects) leaves as events (src/game/events.ts).
// Keyboard, mouse and camera are still read here; S2 splits them off into an input layer.
import * as THREE from 'three';
import type { AbilityDef, ClassDef } from '../data/classes';
import type { Game } from './game';
import { lineOfSight, type Unit } from './unit';
import { executeAbility, abilityNeedsTarget, isMeleeAbility } from './abilities';
import { BreakRoutine } from './breakdance';
import { rollCrit, CRIT_MULT, type CombatController } from './combat';
import { v3, type ErrorReason, type Label } from './events';
import { angleDiff, damp, dampAngle, rand, turnToward, yawTo } from './util';

/** Window of the recorded jump clip that is played: crouch, take-off (1.08 s), landing (1.37 s). */
export const JUMP_CLIP = { from: 0.8, to: 1.56, speed: 1.15 };

export const GCD = 1.0;
import { xpForLevel, levelForXp } from './progression';
export { xpForLevel, levelForXp } from './progression';
const WALK_SPEED = 5;
const MELEE_GAP = 1.5;
const RANGED_AUTO = 20;

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const ray = new THREE.Ray();
const sphere = new THREE.Sphere();

export interface CastState {
  ability: AbilityDef;
  start: number;
  end: number;
  target: Unit | null;
}

export interface ChannelState {
  label: Label;
  start: number;
  end: number;
  key: string;
  to: THREE.Vector3;
  onDone: () => void;
}

export class Player implements CombatController {
  resource = 0;
  maxResource = 100;
  xp = 0;
  coins = 0;
  attackRank = 0;
  gcdStart = 0;
  gcdEnd = 0;
  readonly cooldowns = new Map<string, { start: number; end: number }>();
  cast: CastState | null = null;
  channel: ChannelState | null = null;
  target: Unit | null = null;
  /** Barnacle Ward is up (its absorb lives on the unit). */
  warded = false;
  private nextSwing = 0;
  private lastAttack = -10;
  private queued: AbilityDef | null = null;
  private velX = 0;
  private velZ = 0;
  private jumpT = 0;
  private spinT = 0;
  private dash: { target: Unit; t: number } | null = null;
  private lastSpend = -10;
  private targetDeadAt = 0;
  baseMaxHp: number;
  /**
   * The B emote: the breakdance routine, every move a trained Jumper policy. Moving, turning,
   * jumping, an ability, a hit or a fight ends it; B again does too.
   */
  readonly breakdance: BreakRoutine;

  constructor(private readonly game: Game, readonly unit: Unit, readonly cls: ClassDef) {
    this.breakdance = new BreakRoutine(unit, {
      onEvent: (name, step) => this.game.events.emit({ type: 'dance', unit, stage: 'moment', moment: name, move: step.id }),
    });
    unit.ctrl = this;
    this.baseMaxHp = cls.baseHp;
    unit.maxHp = unit.hp = cls.baseHp;
    if (cls.resource === 'mana') this.maxResource = this.resource = 120;
  }

  get isRage(): boolean {
    return this.cls.resource === 'rage';
  }

  get level(): number {
    return this.unit.level;
  }

  get dmgMul(): number {
    return (1 + 0.12 * (this.unit.level - 1)) * (1 + this.attackRank * .08);
  }

  get inCombat(): boolean {
    return this.game.time - this.unit.lastCombat < 5;
  }

  cooldownLeft(a: AbilityDef): number {
    const cd = this.cooldowns.get(a.id);
    return cd ? Math.max(0, cd.end - this.game.time) : 0;
  }

  gainRage(n: number): void {
    if (!this.isRage) return;
    this.resource = Math.min(this.maxResource, this.resource + n);
  }

  onHurt(dmg: number): void {
    this.breakdance.cancel(0.12);
    if (this.isRage) this.gainRage(dmg * 0.5);
    if (this.cast && this.cast.ability.castTime > 0) {
      // Pushback: taking damage delays the cast a little, like the old games.
      this.cast.end = Math.min(this.cast.end + 0.25, this.cast.start + this.cast.ability.castTime + 0.75);
    }
  }

  onWardHit(broken: boolean): void {
    if (!this.warded) return;
    if (broken) {
      this.warded = false;
      this.unit.absorb = 0;
    }
    this.game.events.emit({ type: 'ward', unit: this.unit, stage: broken ? 'down' : 'hit' });
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number): void {
    const g = this.game;
    const u = this.unit;
    const now = g.time;
    const inp = g.input;
    if (!u.alive) {
      u.feedLocomotion(dt);
      return;
    }
    const free = !g.controlsLocked;
    let fwd = 0;
    let strafe = 0;
    let turn = 0;
    if (free) {
      fwd = (inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0) - (inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0);
      strafe = (inp.isDown('KeyA') ? 1 : 0) - (inp.isDown('KeyD') ? 1 : 0);
      turn = (inp.isDown('KeyQ') || inp.isDown('ArrowLeft') ? 1 : 0) - (inp.isDown('KeyE') || inp.isDown('ArrowRight') ? 1 : 0);
      if (inp.isButtonDown(0) && inp.isButtonDown(2)) fwd = 1;
    }
    const stunned = u.stunned(now);
    if (stunned || this.dash) fwd = strafe = turn = 0;

    // Breakdance (B). Anything that moves the crab or starts a fight ends it, as an emote ends.
    if (free && inp.wasPressed('KeyB')) this.toggleBreakdance();
    if (
      this.breakdance.active &&
      (fwd !== 0 || strafe !== 0 || turn !== 0 || stunned || this.dash || g.follow.steering ||
        (free && inp.wasPressed('Space')) || this.cast || this.channel || this.inCombat)
    ) {
      this.breakdance.cancel();
    }
    this.breakdance.update(dt);

    // Facing: right-drag steers to the camera, Q/E turn and drag the camera along.
    if (free && g.follow.steering && !stunned && !this.dash) {
      u.setYaw(g.follow.forwardYaw);
    } else if (turn) {
      const d = turn * 2.9 * dt;
      u.setYaw(u.yaw + d);
      if (!inp.isButtonDown(0)) g.follow.yaw += d;
    }
    const moving = fwd !== 0 || strafe !== 0;
    if (moving) {
      if (this.cast && this.cast.ability.castTime > 0) this.interruptCast();
      if (this.channel) this.cancelChannel();
    }
    // Face the target while fighting from a standstill.
    const t = this.target;
    if (!moving && !turn && !g.follow.steering && t && t.alive && t !== u && (this.cast || now - this.lastAttack < 1.6)) {
      u.setYaw(turnToward(u.yaw, yawTo(u.pos.x, u.pos.z, t.pos.x, t.pos.z), 9, dt));
    }
    // Turn to the crab you are talking to, so the dialogue shot looks over your shoulder at it.
    const talk = g.talkPartner;
    if (talk && !moving && !turn && !g.follow.steering && !stunned && !this.dash) {
      u.setYaw(turnToward(u.yaw, yawTo(u.pos.x, u.pos.z, talk.pos.x, talk.pos.z), 4.5, dt));
    }

    // Jump
    if (free && inp.wasPressed('Space') && this.jumpT <= 0 && !stunned && !this.dash) {
      // The recorded jump rollout spends 1.08 s getting ready before take-off and another 2 s
      // settling after landing. Play only crouch, flight and landing, a little faster, so the
      // crab leaves the ground at once and walks on as soon as it lands (the sink plays JUMP_CLIP).
      this.jumpT = (JUMP_CLIP.to - JUMP_CLIP.from) / JUMP_CLIP.speed;
      g.events.emit({ type: 'jump', unit: u });
      if (this.cast && this.cast.ability.castTime > 0) this.interruptCast();
      if (this.channel) this.cancelChannel();
    }
    if (this.jumpT > 0) this.jumpT -= dt;

    // Velocity
    let nx = u.pos.x;
    let nz = u.pos.z;
    if (this.dash) {
      this.updateDash(dt);
      nx = u.pos.x;
      nz = u.pos.z;
    } else {
      const sprint = free && !stunned && moving && (inp.isDown('ShiftLeft') || inp.isDown('ShiftRight'));
      const sp = WALK_SPEED * (sprint ? 1.65 : 1) * u.speedMul(now);
      let lx = strafe;
      let lz = fwd;
      const len = Math.hypot(lx, lz);
      if (len > 0) {
        lx /= len;
        lz /= len;
      }
      if (lz < 0) {
        lz *= 0.62;
        lx *= 0.8;
      }
      const s = Math.sin(u.yaw);
      const c = Math.cos(u.yaw);
      const tx = (lx * c + lz * s) * sp;
      const tz = (-lx * s + lz * c) * sp;
      const k = moving ? 12 : 16;
      this.velX = damp(this.velX, tx, k, dt);
      this.velZ = damp(this.velZ, tz, k, dt);
      nx += this.velX * dt;
      nz += this.velZ * dt;
    }
    if (u.pushTime > 0) {
      const pushDt = Math.min(dt, u.pushTime);
      u.pushTime = Math.max(0, u.pushTime - dt);
      nx += u.pushX * pushDt;
      nz += u.pushZ * pushDt;
    }
    u.moveTo(g.world, nx, nz, dt);
    if (this.spinT > 0) {
      this.spinT = Math.max(0, this.spinT - dt);
      u.rig.root.rotation.y = u.yaw + (1 - this.spinT / 0.6) * Math.PI * 4;
    } else {
      u.rig.root.rotation.y = u.yaw;
    }

    // Camera swings behind the crab while walking, unless the player is holding a mouse button.
    if (moving && !inp.isButtonDown(0) && !inp.isButtonDown(2)) {
      g.follow.yaw = dampAngle(g.follow.yaw, u.yaw + Math.PI, fwd !== 0 ? 1.7 : 0.6, dt);
    }

    // Footsteps
    const speed = Math.hypot(this.velX, this.velZ);
    if (speed > 1 && this.jumpT <= 0) {
      u.footstepT -= dt * speed / WALK_SPEED;
      if (u.footstepT <= 0) {
        u.footstepT = 0.34;
        g.events.emit({ type: 'footstep', unit: u });
      }
    }

    u.feedLocomotion(dt);
    this.updateCombat();
    this.updateResources(dt);
  }

  private updateCombat(): void {
    const g = this.game;
    const u = this.unit;
    const now = g.time;
    const t = this.target;
    if (t && (t.hidden || (!t.alive && now - this.targetDeadAt > 1.5))) this.setTarget(null);
    if (t && !t.alive && this.targetDeadAt === 0) this.targetDeadAt = now;

    // Cast bar (the motes at the claw are drawn from this state, src/game/browserSink.ts)
    if (this.cast) {
      const c = this.cast;
      if (c.target && !c.target.alive) {
        this.interruptCast('Invalid target');
      } else if (now >= c.end) {
        this.cast = null;
        // The channel hands over to the cast's release: the claws fling wide as the spell goes.
        u.act('cast', { upper: true, part: 'release', fade: 0.1 });
        g.events.emit({ type: 'castEnd', unit: u, channel: false, result: 'done' });
        if (c.target && abilityNeedsTarget(c.ability) && !this.checkReach(c.ability, c.target)) return;
        this.commit(c.ability, c.target);
      }
    }

    // Channel (beacon)
    if (this.channel) {
      const ch = this.channel;
      if (!g.input.isDown(ch.key)) {
        this.cancelChannel();
      } else if (now >= ch.end) {
        this.channel = null;
        u.act('cast', { upper: true, part: 'release', fade: 0.1 });
        g.events.emit({ type: 'castEnd', unit: u, channel: true, result: 'done' });
        ch.onDone();
      }
    }

    // Queued ability fires as soon as the GCD ends.
    if (this.queued && now >= this.gcdEnd && !this.cast) {
      const q = this.queued;
      this.queued = null;
      this.useAbility(q.slot);
    }

    // Auto-attack
    if (!g.villageGames?.playing && t && t.alive && t.hostile && !this.cast && !this.channel && !this.dash && now >= this.nextSwing && u.alive && !u.stunned(now)) {
      if (this.isRage) {
        if (u.gapTo(t) <= MELEE_GAP) {
          this.nextSwing = now + 2.0;
          this.lastAttack = now;
          u.act('attack_swipe', {
            upper: true,
            onHit: () => {
              if (!t.alive || u.gapTo(t) > MELEE_GAP + 0.8) return;
              const crit = rollCrit();
              const dmg = rand(8, 11) * this.dmgMul * (crit ? CRIT_MULT : 1);
              g.combat.damage(u, t, dmg, { crit, rage: crit ? 15 : 9 });
              g.events.emit({ type: 'attack', src: u, attack: 'auto', stage: 'hit', target: t });
            },
          });
        }
      } else if (u.distTo(t) <= RANGED_AUTO && this.lineOfSight(t)) {
        this.nextSwing = now + 1.8;
        this.lastAttack = now;
        const from = u.socketPos('clawR', v1).clone();
        const style = this.cls.id === 'priest' ? 'holy' : 'spark';
        g.projectiles.spawn(u, from, t, style, 22, () => {
          if (!t.alive) return;
          const crit = rollCrit();
          g.combat.damage(u, t, rand(5, 7) * this.dmgMul * (crit ? CRIT_MULT : 1), { crit, school: style === 'holy' ? 'holy' : 'frost', noReact: true });
        });
      }
    }
  }

  private updateResources(dt: number): void {
    const g = this.game;
    const u = this.unit;
    const now = g.time;
    const ooc = now - u.lastCombat > 5;
    if (this.isRage) {
      if (now - u.lastCombat > 3) this.resource = Math.max(0, this.resource - 4 * dt);
    } else {
      const rate = ooc ? 10 : now - this.lastSpend > 5 ? 5 : 2.8;
      this.resource = Math.min(this.maxResource, this.resource + rate * dt);
    }
    if (u.alive) {
      let regen = 0;
      if (ooc) regen += u.maxHp * 0.05;
      if (now < u.blessingUntil) regen += u.maxHp * 0.02;
      if (regen > 0 && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + regen * dt);
    }
    if (u.absorb > 0 && now >= u.absorbUntil) {
      u.absorb = 0;
      this.dropWard();
    }
  }

  // ---------------------------------------------------------------- breakdance

  /** B: start the routine from standing, or end it. */
  toggleBreakdance(): void {
    const g = this.game;
    const u = this.unit;
    if (this.breakdance.active) {
      this.breakdance.cancel();
      return;
    }
    if (!u.alive || g.controlsLocked) return;
    if (this.inCombat) return this.error("You can't dance while in combat.");
    if (u.stunned(g.time)) return this.error('You are stunned.');
    if (this.cast || this.channel || this.dash) return this.error('Another action is in progress.');
    if (this.jumpT > 0 || Math.hypot(this.velX, this.velZ) > 0.6) return this.error('Stand still to dance.');
    this.velX = this.velZ = 0;
    this.breakdance.start();
    u.express('happy', 3);
    g.events.emit({ type: 'dance', unit: u, stage: 'start' });
  }

  private dropWard(): void {
    if (!this.warded) return;
    this.warded = false;
    this.game.events.emit({ type: 'ward', unit: this.unit, stage: 'down' });
  }

  // ---------------------------------------------------------------- abilities

  useAbility(slot: number): void {
    const g = this.game;
    const u = this.unit;
    const ab = this.cls.abilities[slot - 1];
    if (!ab || !u.alive || g.controlsLocked || g.villageGames?.playing) return;
    this.breakdance.cancel(0.12);
    const now = g.time;
    g.events.emit({ type: 'press', unit: u, slot });
    if (u.stunned(now)) return this.error('You are stunned.');
    if (this.channel) return this.error('Another action is in progress.');
    if (this.cast) {
      if (now > this.cast.end - 0.3) this.queued = ab;
      else this.error('Another action is in progress.');
      return;
    }
    const wait = Math.max(this.gcdEnd - now, this.cooldownLeft(ab));
    if (wait > 0) {
      if (wait < 0.4 && this.cooldownLeft(ab) < 0.4) this.queued = ab;
      else this.error('Ability is not ready yet.');
      return;
    }
    if (this.resource < ab.cost) return this.error(this.isRage ? 'Not enough rage.' : 'Not enough mana.');
    let target: Unit | null = null;
    if (abilityNeedsTarget(ab)) {
      target = this.target;
      if (!target) return this.error('You have no target.');
      if (!target.alive || !target.hostile) return this.error('Invalid target.');
      if (!this.checkReach(ab, target)) return;
    }
    this.gcdStart = now;
    this.gcdEnd = now + GCD;
    this.lastAttack = now;
    if (ab.castTime > 0) {
      this.cast = { ability: ab, start: now, end: now + ab.castTime, target };
      u.act('cast', { upper: true, loop: true, fade: 0.15 });
      g.events.emit({ type: 'castStart', unit: u, seconds: ab.castTime, ability: ab });
    } else {
      this.commit(ab, target);
    }
  }

  private checkReach(ab: AbilityDef, t: Unit): boolean {
    const u = this.unit;
    const d = u.distTo(t) - t.radius;
    let err: ErrorReason | '' = '';
    if (isMeleeAbility(ab)) err = u.gapTo(t) > MELEE_GAP + 0.3 ? 'Out of range.' : '';
    else if (d > ab.range) err = 'Out of range.';
    else if (ab.id === 'sideways-charge' && u.gapTo(t) < 2) err = 'Target too close.';
    else if (!this.lineOfSight(t)) err = 'Target not in line of sight.';
    if (err) this.error(err);
    return !err;
  }

  lineOfSight(t: Unit): boolean {
    return lineOfSight(this.game.world, this.unit, t);
  }

  /** Pay, start the cooldown, run the ability. */
  private commit(ab: AbilityDef, target: Unit | null): void {
    const g = this.game;
    if (this.resource < ab.cost) return this.error(this.isRage ? 'Not enough rage.' : 'Not enough mana.');
    this.resource -= ab.cost;
    if (ab.cost > 0) this.lastSpend = g.time;
    if (ab.generates) this.gainRage(ab.generates);
    if (ab.cooldown > 0) this.cooldowns.set(ab.id, { start: g.time, end: g.time + ab.cooldown });
    this.lastAttack = g.time;
    executeAbility(g, this, ab, target);
  }

  interruptCast(reason = 'Interrupted'): void {
    if (!this.cast) return;
    this.cast = null;
    this.unit.motion.stop('cast', 0.15);
    this.game.events.emit({ type: 'castEnd', unit: this.unit, channel: false, result: 'interrupted', reason });
  }

  startChannel(label: Label, seconds: number, key: string, to: THREE.Vector3, onDone: () => void): void {
    if (this.cast) this.interruptCast();
    const now = this.game.time;
    this.channel = { label, start: now, end: now + seconds, key, to, onDone };
    this.velX = this.velZ = 0;
    this.unit.act('cast', { upper: true, loop: true, fade: 0.2 });
    this.game.events.emit({ type: 'castStart', unit: this.unit, seconds, channel: { label, to: v3(to), start: now, end: now + seconds } });
  }

  cancelChannel(): void {
    if (!this.channel) return;
    this.channel = null;
    this.unit.motion.stop('cast', 0.2);
    this.game.events.emit({ type: 'castEnd', unit: this.unit, channel: true, result: 'interrupted', reason: 'Interrupted' });
  }

  // Ability helpers used by abilities.ts

  startDash(target: Unit): void {
    this.dash = { target, t: 0 };
    this.velX = this.velZ = 0;
  }

  private updateDash(dt: number): void {
    const d = this.dash!;
    const u = this.unit;
    const t = d.target;
    d.t += dt;
    const dist = u.gapTo(t);
    const step = 26 * dt;
    // Crabs charge sideways: face along the dash with the body turned, it reads as a scuttle.
    const yaw = yawTo(u.pos.x, u.pos.z, t.pos.x, t.pos.z);
    u.setYaw(yaw);
    if (dist <= 0.6 + step || d.t > 0.9 || !t.alive) {
      this.dash = null;
      u.lift = 0;
      const g = this.game;
      g.events.emit({ type: 'ability', caster: u, ability: 'sideways-charge', stage: 'hit', target: t });
      this.nextSwing = Math.min(this.nextSwing, g.time + 0.1);
      return;
    }
    const k = step / Math.max(0.001, u.distTo(t));
    u.pos.x += (t.pos.x - u.pos.x) * k;
    u.pos.z += (t.pos.z - u.pos.z) * k;
    u.lift = Math.sin(Math.min(1, d.t / 0.45) * Math.PI) * 0.25;
  }

  spin(): void {
    this.spinT = 0.6;
  }

  error(reason: ErrorReason): void {
    this.game.events.emit({ type: 'error', unit: this.unit, reason });
  }

  // ---------------------------------------------------------------- targeting

  setTarget(t: Unit | null): void {
    if (t === this.target) return;
    this.target = t;
    this.targetDeadAt = t && !t.alive ? this.game.time : 0;
    this.game.events.emit({ type: 'target', unit: this.unit, target: t });
  }

  /** Nearest hostile in front of the camera; repeated presses cycle. */
  tabTarget(): void {
    const g = this.game;
    const u = this.unit;
    const fy = g.follow.forwardYaw;
    const list = g.units
      .filter((o) => o.hostile && o.alive && !o.hidden && o.targetable && u.distTo(o) < 32)
      .filter((o) => Math.abs(angleDiff(yawTo(u.pos.x, u.pos.z, o.pos.x, o.pos.z), fy)) < 1.45 || u.distTo(o) < 4)
      .sort((a, b) => u.distTo(a) - u.distTo(b));
    if (!list.length) return;
    const i = this.target ? list.indexOf(this.target) : -1;
    this.setTarget(list[(i + 1) % list.length]);
  }

  /** Ray-pick a crab under the mouse. */
  pick(clientX: number, clientY: number): Unit | null {
    const g = this.game;
    const cam = g.camera;
    const ndc = v1.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1, 0.5);
    ndc.unproject(cam);
    ray.origin.copy(cam.position);
    ray.direction.copy(ndc.sub(cam.position).normalize());
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const o of g.units) {
      if (o === this.unit || o.hidden || !o.targetable || o.culled) continue;
      sphere.center.set(o.pos.x, o.pos.y + o.height * 0.5, o.pos.z);
      sphere.radius = Math.max(o.radius * 1.05, o.height * 0.6);
      const hit = ray.intersectSphere(sphere, v2);
      if (!hit) continue;
      const d = hit.distanceTo(cam.position);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- progression

  gainXp(n: number): void {
    const g = this.game;
    if(!Number.isFinite(n) || n<=0)return;
    this.xp = Math.min(Number.MAX_SAFE_INTEGER,this.xp+n);
    g.events.emit({ type: 'xp', unit: this.unit, amount: n });
    const targetLevel=levelForXp(this.xp);
    if(targetLevel-this.level>10){this.restoreXp(this.xp);g.events.emit({ type: 'levelUp', unit: this.unit, level: this.level, oldMaxHp: this.unit.maxHp, maxHp: this.unit.maxHp, jump: true });}
    else while (this.xp >= xpForLevel(this.unit.level+1)) this.levelUp();
  }

  restoreXp(xp: number): void {
    this.xp = Number.isFinite(xp) ? Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,xp)) : 0;
    this.unit.level = levelForXp(this.xp);
    this.unit.maxHp = this.unit.hp = Math.round(this.baseMaxHp * (1 + 0.15 * (this.level - 1)));
    if (!this.isRage) this.maxResource = this.resource = 120 + 20 * (this.level - 1);
  }

  private levelUp(): void {
    const g = this.game;
    const u = this.unit;
    u.level++;
    const oldMax = u.maxHp;
    u.maxHp = Math.round(this.baseMaxHp * (1 + 0.15 * (u.level - 1)));
    u.hp = u.maxHp;
    if (!this.isRage) {
      this.maxResource = 120 + 20 * (u.level - 1);
      this.resource = this.maxResource;
    }
    g.events.emit({ type: 'levelUp', unit: u, level: u.level, oldMaxHp: oldMax, maxHp: u.maxHp, jump: false });
    u.express('happy', 2);
  }

  returnToSquare(): void {
    const g = this.game;
    const spawn = g.world.pois.spawn;
    // Island arrival gates are at the docks; recall goes to the inhabited square.
    const chapter = g.world2.chapter;
    const x = chapter === 1 ? spawn.position.x : 0;
    const z = chapter === 1 ? spawn.position.z : chapter === 2 ? 63 : 60;
    this.velX = this.velZ = 0;
    this.dash = null;
    this.queued = null;
    this.setTarget(null);
    g.world2.resetPortalArrival();
    this.unit.teleport(g.world, x, z, spawn.yaw);
    g.events.emit({ type: 'recall', unit: this.unit });
  }

  respawn(): void {
    const u = this.unit;
    u.alive = true;
    u.hp = u.maxHp;
    this.resource = this.isRage ? 0 : this.maxResource;
    this.cast = null;
    this.channel = null;
    this.dash = null;
    this.queued = null;
    u.stunUntil = u.slowUntil = u.rustUntil = 0;
    u.rust = 0;
    u.absorb = 0;
    u.lift = 0;
    this.dropWard();
    this.velX = this.velZ = 0;
    u.lastCombat = -1e9;
    this.breakdance.cancel(0);
    u.motion.stop(undefined, 0);
    u.express('neutral', 0.1);
    u.rig.face.setTint(null);
    this.setTarget(null);
  }
}
