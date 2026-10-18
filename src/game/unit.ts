// A crab in the world: rig + motion controller + combat stats. Player, NPCs, townsfolk, enemies
// and the boss are all Units; their behaviour lives in separate controllers.
import * as THREE from 'three';
import type { CrabRig, Expression } from '../crab/types';
import { actionHitDelay, isSkill, skillWindow, type SkillPart } from '../motion/skills';
import type { MotionController, MotionId } from '../motion/types';
import type { World } from '../world/types';
import { angleDiff, clamp, damp } from './util';

export type UnitKind = 'player' | 'remote' | 'npc' | 'townsfolk' | 'scrapling' | 'scavenger' | 'jellyfish' | 'boss' | 'freed';
export type Reaction = 'hostile' | 'friendly' | 'neutral' | 'player';

const tmpV = new THREE.Vector3();
const tmp2 = new THREE.Vector2();
const tmpTo = new THREE.Vector3();

export interface ActionOptions {
  /** Claws only; the legs keep walking. */
  upper?: boolean;
  /**
   * Seconds after start when onHit fires. Skill clips default to their own hit moment
   * (src/motion/skills.ts actionHitDelay), other clips to 0.3 s. Game time decides it, not the clip.
   */
  hitAt?: number;
  onHit?: () => void;
  onEnd?: () => void;
  speed?: number;
  loop?: boolean;
  fade?: number;
  /**
   * Clip window in clip seconds (see MotionPlayOptions.from/to). Skill clips default to their
   * move's window (src/motion/skills.ts); `part` picks the cast's channel or release instead.
   */
  from?: number;
  to?: number;
  part?: SkillPart;
  /** Named clip events other than 'hit' ('takeoff', 'land', ...). */
  onEvent?: (name: string) => void;
  /**
   * The clip moves the crab: its travel and turn are carried over to the crab's position and
   * heading when it fades out (MotionPlayOptions.carryRoot), instead of being taken out.
   */
  carryRoot?: boolean;
}

/**
 * Whether `to` can be seen from `from`'s eyes: nothing solid between them short of `to`'s own
 * shell. Abilities check it from the caster, enemies from the player they hunt.
 */
export function lineOfSight(world: World, from: Unit, to: Unit): boolean {
  const eye = tmpV.set(from.pos.x, from.pos.y + from.height * 0.8, from.pos.z);
  const at = to.centre(tmpTo);
  const hit = world.raycastSolid(eye, at);
  return hit === null || hit >= eye.distanceTo(at) - to.radius - 0.3;
}

export class Unit {
  private static nextId = 1;
  readonly id = Unit.nextId++;
  title = '';
  onAction: ((action: MotionId) => void) | null = null;
  /**
   * The breakdance routine (src/game/breakdance.ts) on this crab was cut short. Its moves reach
   * onAction as they start; one that plays to its end reports nothing more.
   */
  onBreakdanceStop: (() => void) | null = null;
  level = 1;
  yaw = 0;
  /** Collision circle radius and shell-top height, measured from the rig's sockets. */
  radius = 0.55;
  height = 1;
  hp = 100;
  maxHp = 100;
  alive = true;
  /** Status effects; times are game seconds. */
  stunUntil = 0;
  slowUntil = 0;
  slowPct = 0;
  rust = 0;
  rustUntil = 0;
  absorb = 0;
  absorbMax = 0;
  absorbUntil = 0;
  blessingUntil = 0;
  lastCombat = -1e9;
  /** External displacement velocity (knockback, pull), decays over pushTime. */
  pushX = 0;
  pushZ = 0;
  pushTime = 0;
  /** Extra height added on top of the ground (leaps, the dash hop). */
  lift = 0;
  /** Skipped by motion/rig updates when far away. */
  culled = false;
  /** Level of detail the rig is drawn at (0 full, 1 far). */
  lod = 0;
  /** Removed from play (dead and sunk, not yet spawned). */
  hidden = false;
  targetable = true;
  invulnerable = false;
  portrait = '';
  /** LED tint to return to after a hit flash; null = the rig's own colour. */
  baseTint: THREE.ColorRepresentation | null = null;
  /** Owner controller, for click/interaction dispatch. */
  ctrl: unknown = null;
  npcId = '';
  footstepT = 0;

  private locoX = 0;
  private locoZ = 0;
  private locoW = 0;
  private prevX = 0;
  private prevZ = 0;
  private prevYaw = 0;
  private flashT = 0;
  private pendingHit: { fn: () => void; left: number } | null = null;
  private exprHold = 0;
  /** Seconds since the death clip started; -1 while alive. */
  private deathT = -1;

  constructor(
    public name: string,
    public kind: UnitKind,
    public reaction: Reaction,
    readonly rig: CrabRig,
    readonly motion: MotionController,
  ) {
    rig.root.userData.unitId = this.id;
  }

  get pos(): THREE.Vector3 {
    return this.rig.root.position;
  }

  get hostile(): boolean {
    return this.reaction === 'hostile';
  }

  /** Measure height and radius from the rig's head socket (contract: top of the upper shell). */
  measure(): void {
    const root = this.rig.root;
    root.updateMatrixWorld(true);
    const head = this.rig.getSocket('head').getWorldPosition(tmpV);
    const h = head.y - root.position.y;
    this.height = h > 0.2 ? h : 1;
    this.radius = clamp(this.height * 0.58, 0.35, 2.6);
  }

  setYaw(y: number): void {
    this.yaw = y;
    this.rig.root.rotation.y = y;
  }

  /** Place without interpolation (spawn, respawn, teleport). */
  teleport(world: World, x: number, z: number, yaw?: number): void {
    const p = world.resolveCollision(x, z, this.radius, tmp2);
    this.pos.set(p.x, world.heightAt(p.x, p.y), p.y);
    this.prevX = this.pos.x;
    this.prevZ = this.pos.z;
    if (yaw !== undefined) this.setYaw(yaw);
    this.prevYaw = this.yaw;
    this.locoX = this.locoZ = this.locoW = 0;
    this.pushTime = 0;
  }

  /** Move to x,z with collision and ground following. */
  moveTo(world: World, x: number, z: number, dt: number): void {
    const p = world.resolveCollision(x, z, this.radius, tmp2);
    this.pos.x = p.x;
    this.pos.z = p.y;
    const gy = world.heightAt(p.x, p.y) + this.lift;
    this.pos.y = Math.abs(gy - this.pos.y) > 3 ? gy : damp(this.pos.y, gy, 18, dt);
  }

  forwardX(): number {
    return Math.sin(this.yaw);
  }
  forwardZ(): number {
    return Math.cos(this.yaw);
  }

  distTo(o: Unit): number {
    return Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
  }

  /** Edge-to-edge distance, what melee range is measured against. */
  gapTo(o: Unit): number {
    return Math.max(0, this.distTo(o) - this.radius - o.radius);
  }

  stunned(now: number): boolean {
    return now < this.stunUntil;
  }

  /** Movement multiplier from slows and rust. */
  speedMul(now: number): number {
    let m = 1;
    if (now < this.slowUntil) m *= 1 - this.slowPct;
    if (now < this.rustUntil) m *= 1 - 0.1 * this.rust;
    return m;
  }

  centre(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + this.height * 0.5, this.pos.z);
  }

  nameplatePos(out: THREE.Vector3): THREE.Vector3 {
    return this.rig.getSocket('nameplate').getWorldPosition(out);
  }

  socketPos(name: Parameters<CrabRig['getSocket']>[0], out: THREE.Vector3): THREE.Vector3 {
    return this.rig.getSocket(name).getWorldPosition(out);
  }

  /**
   * Play a clip. onHit fires on the game clock (updateHit) at the clip's hit moment from the skill
   * data, or after hitAt seconds; the clip's own events never land a blow.
   */
  act(id: MotionId, o: ActionOptions = {}): void {
    this.onAction?.(id);
    // A skill clip is the whole recorded rollout: play its move, at its rate, unless told otherwise.
    const w = isSkill(id) ? skillWindow(id, o.part ?? (o.loop ? 'channel' : 'move'), o.speed) : null;
    if (o.onHit) {
      // A swing interrupted by the next one still lands.
      if (this.pendingHit) this.pendingHit.fn();
      this.pendingHit = { fn: o.onHit, left: o.hitAt ?? actionHitDelay(id, o) ?? 0.3 };
    }
    if (id === 'death') this.deathT = 0;
    this.motion.play(id, {
      upperBodyOnly: o.upper,
      speed: w ? w.speed : o.speed,
      loop: o.loop,
      fade: o.fade ?? 0.12,
      from: o.from ?? w?.from,
      to: o.to ?? w?.to,
      loopFrom: w?.loopFrom,
      onEvent: o.onEvent,
      onEnd: o.onEnd,
      carryRoot: o.carryRoot ? (dx, dz, dyaw) => this.carryRoot(dx, dz, dyaw) : undefined,
    });
  }

  /**
   * Move the root by a clip's travel and turn (robot metres in the crab's local frame, x to its
   * left, z forward; radians, positive = left). Ground and collisions follow on the next moveTo;
   * locomotion is told nothing moved, since the body was already there.
   */
  carryRoot(dx: number, dz: number, dyaw: number): void {
    const m = this.rig.metersToUnits;
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    this.pos.x += (dx * c + dz * s) * m;
    this.pos.z += (-dx * s + dz * c) * m;
    this.setYaw(this.yaw + dyaw);
    this.prevX = this.pos.x;
    this.prevZ = this.pos.z;
    this.prevYaw = this.yaw;
  }

  express(e: Expression, hold = 0.8): void {
    this.rig.face.setExpression(e, hold);
    this.exprHold = hold;
  }

  flash(color: THREE.ColorRepresentation, seconds = 0.12): void {
    this.rig.face.setTint(color);
    this.flashT = seconds;
  }

  setBaseTint(c: THREE.ColorRepresentation | null): void {
    this.baseTint = c;
    if (this.flashT <= 0) this.rig.face.setTint(c);
  }

  /**
   * Feed locomotion from the actual displacement this frame, in the crab's local frame
   * (vx toward its left, vz forward, yawRate positive = left).
   */
  feedLocomotion(dt: number): void {
    if (dt <= 0) return;
    let dx = (this.pos.x - this.prevX) / dt;
    let dz = (this.pos.z - this.prevZ) / dt;
    const sp = Math.hypot(dx, dz);
    if (sp > 14) {
      dx *= 14 / sp;
      dz *= 14 / sp;
    }
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    // left = (cos yaw, -sin yaw)
    const vz = dx * fx + dz * fz;
    const vx = dx * fz - dz * fx;
    const w = clamp(angleDiff(this.yaw, this.prevYaw) / dt, -6, 6);
    this.locoX = damp(this.locoX, vx, 14, dt);
    this.locoZ = damp(this.locoZ, vz, 14, dt);
    this.locoW = damp(this.locoW, w, 12, dt);
    const tiny = Math.abs(this.locoX) < 0.05 && Math.abs(this.locoZ) < 0.05 && Math.abs(this.locoW) < 0.05;
    this.motion.setLocomotion(tiny ? 0 : this.locoX, tiny ? 0 : this.locoZ, tiny ? 0 : this.locoW);
    this.prevX = this.pos.x;
    this.prevZ = this.pos.z;
    this.prevYaw = this.yaw;
  }

  get moveSpeed(): number {
    return Math.hypot(this.locoX, this.locoZ);
  }

  /** Simulation step: a pending swing lands when its time comes, on screen or not. */
  updateHit(dt: number): void {
    if (!this.pendingHit) return;
    this.pendingHit.left -= dt;
    if (this.pendingHit.left <= 0) {
      const fn = this.pendingHit.fn;
      this.pendingHit = null;
      fn();
    }
  }

  /** Seconds until the pending swing lands, or null. */
  get pendingHitIn(): number | null {
    return this.pendingHit ? this.pendingHit.left : null;
  }

  /** Per-frame visuals: LED flash, motion and rig update. */
  updateVisual(dt: number): void {
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.rig.face.setTint(this.baseTint);
    }
    if (this.exprHold > 0) this.exprHold -= dt;
    if (this.culled || this.hidden) return;
    if (!this.alive && this.deathT >= 0) {
      this.deathT += dt;
      // Some runtimes return to idle after a one-shot clip; a dead crab keeps its last pose.
      if (this.deathT > 0.3 && this.motion.action !== 'death') {
        this.rig.update(dt);
        return;
      }
    } else if (this.alive) this.deathT = -1;
    this.motion.update(dt);
    this.rig.update(dt);
  }

  cancelPendingHit(): void {
    this.pendingHit = null;
  }

  private shadowMeshes: THREE.Mesh[] | null = null;
  private shadows = true;

  /** Crabs far from the camera stop casting shadows; the sun's shadow map is the costliest pass. */
  setShadows(on: boolean): void {
    if (on === this.shadows) return;
    this.shadows = on;
    if (!this.shadowMeshes) {
      this.shadowMeshes = [];
      this.rig.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.castShadow) this.shadowMeshes!.push(m);
      });
    }
    for (const m of this.shadowMeshes) m.castShadow = on;
  }

  dispose(): void {
    this.motion.dispose();
    this.rig.dispose();
  }
}
