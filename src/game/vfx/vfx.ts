// Effect recipes for every ability, enemy mechanic and celebration. Built on two particle systems
// (additive glow, alpha-blended smoke/debris) and the pooled mesh effects.
import * as THREE from 'three';
import { createAtlas, Sprite } from './atlas';
import { FxPool, type Fx } from './effects';
import {conformTelegraph} from './telegraphGround';
import { ParticleSystem, type EmitOptions } from './particles';
import type { Unit } from '../unit';
import { hdr, rand, TAU } from '../util';

export const C = {
  white: hdr('#fff6e0', 4),
  gold: hdr('#ffc94a', 3.2),
  goldSoft: hdr('#ffd98a', 1.6),
  steel: hdr('#dfe8ff', 3),
  water: hdr('#3fb8ff', 2.4),
  waterDeep: hdr('#1a5fb0', 1.4),
  foam: hdr('#d6f6ff', 2.2),
  frost: hdr('#a8ecff', 3),
  frostDeep: hdr('#3e9cff', 1.6),
  holy: hdr('#ffe39a', 4),
  holyDeep: hdr('#ff9a2a', 1.6),
  heal: hdr('#53ff86', 3),
  healDeep: hdr('#16a85a', 1.4),
  ward: hdr('#5fffe0', 1.8),
  wardDeep: hdr('#e8c25a', 1.4),
  red: hdr('#ff2a14', 1.6),
  redHot: hdr('#ff4a1a', 3),
  orange: hdr('#ff7a1a', 2.6),
  ember: hdr('#ff9a3a', 3.5),
  rust: new THREE.Color('#9a4418'),
  rustDark: new THREE.Color('#4a2010'),
  dust: new THREE.Color('#cdb48a'),
  dustDark: new THREE.Color('#7a6648'),
  smoke: new THREE.Color('#e9eef2'),
  smokeGrey: new THREE.Color('#9aa3ad'),
  purple: hdr('#c07bff', 3),
  green: hdr('#7dff6a', 3),
};

/** Saturated colours for normal-blended effects; they keep their hue on bright sand and at night. */
export const N = {
  water: new THREE.Color(0.12, 0.5, 1.25),
  waterDeep: new THREE.Color(0.03, 0.18, 0.6),
  foam: new THREE.Color(0.75, 0.95, 1.2),
  gold: new THREE.Color(1.45, 0.92, 0.18),
  holy: new THREE.Color(1.6, 1.25, 0.45),
  heal: new THREE.Color(0.28, 1.4, 0.42),
  frost: new THREE.Color(0.5, 0.88, 1.35),
  ember: new THREE.Color(1.6, 0.5, 0.1),
  ward: new THREE.Color(0.25, 1.15, 1.0),
  steel: new THREE.Color(1.5, 1.45, 1.3),
  star: new THREE.Color(1.7, 1.3, 0.25),
  red: new THREE.Color(1.45, 0.06, 0.03),
};

interface Attachment {
  t: number;
  dur: number;
  tick: (dt: number, t: number) => void;
  end?: () => void;
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const tilt = new THREE.Quaternion();

export interface ProjectileFx {
  /** The projectile reached its target (or the target died): splash and remove it. */
  land(): void;
}

export interface WardHandle {
  hit(): void;
  pop(): void;
  readonly alive: boolean;
}

export class Vfx {
  readonly group = new THREE.Group();
  readonly add: ParticleSystem;
  readonly alpha: ParticleSystem;
  readonly fx = new FxPool();
  private atlas: THREE.Texture;
  private attachments: Attachment[] = [];
  /** Ground ring under the current target. */
  readonly selection: Fx;
  /** Quality scales particle counts. */
  density = 1;

  constructor(scene: THREE.Scene, private readonly groundHeight?: (x: number, z: number) => number) {
    this.atlas = createAtlas();
    this.add = new ParticleSystem(5000, true, this.atlas);
    this.alpha = new ParticleSystem(2500, false, this.atlas);
    this.group.name = 'vfx';
    this.group.add(this.alpha.mesh, this.add.mesh, this.fx.group);
    scene.add(this.group);
    this.selection = this.fx.spawn('ring', Infinity);
    this.selection.mesh.visible = false;
    (this.selection.u.uParam.value as THREE.Vector4).x = 0.72;
  }

  /** Count scaled by quality, at least 1. */
  private n(count: number): number {
    return Math.max(1, Math.round(count * this.density));
  }

  update(dt: number): void {
    for (let i = this.attachments.length - 1; i >= 0; i--) {
      const a = this.attachments[i];
      a.t += dt;
      if (a.t >= a.dur) {
        this.attachments.splice(i, 1);
        a.end?.();
        continue;
      }
      a.tick(dt, a.t);
    }
    this.add.update(dt);
    this.alpha.update(dt);
    this.fx.update(dt);
  }

  attach(dur: number, tick: Attachment['tick'], end?: () => void): Attachment {
    const a = { t: 0, dur, tick, end };
    this.attachments.push(a);
    return a;
  }

  detach(a: Attachment): void {
    const i = this.attachments.indexOf(a);
    if (i >= 0) {
      this.attachments.splice(i, 1);
      a.end?.();
    }
  }

  clear(): void {
    for (const a of this.attachments) a.end?.();
    this.attachments.length = 0;
    this.add.clear();
    this.alpha.clear();
  }

  dispose(): void {
    this.clear();
    this.fx.dispose();
    this.add.dispose();
    this.alpha.dispose();
    this.atlas.dispose();
    this.group.removeFromParent();
  }

  // ---------------------------------------------------------------- primitives

  glow(p: THREE.Vector3, color: THREE.Color, size: number, life = 0.22, sizeEnd = size * 0.3): void {
    this.add.emit({ x: p.x, y: p.y, z: p.z, life, size, sizeEnd, color, sprite: Sprite.Glow, fadeIn: 0.02 });
  }

  sparks(p: THREE.Vector3, color: THREE.Color, count: number, speed = 7, opts: Partial<EmitOptions> = {}, solid?: THREE.Color): void {
    if (solid) {
      for (let i = 0; i < this.n(count * 0.5); i++) {
        const th = Math.random() * TAU;
        const s = speed * rand(0.4, 1);
        this.alpha.emit({
          x: p.x, y: p.y, z: p.z,
          vx: Math.cos(th) * s, vy: rand(0.2, 1) * s, vz: Math.sin(th) * s,
          life: rand(0.25, 0.45), size: rand(0.07, 0.13), sizeEnd: 0.02,
          color: solid, gravity: 9, drag: 2.5, sprite: Sprite.Spark, stretch: 0.05, fadeIn: 0,
        });
      }
    }
    for (let i = 0; i < this.n(count); i++) {
      const th = Math.random() * TAU;
      const ph = Math.acos(rand(-0.4, 1));
      const s = speed * rand(0.4, 1);
      this.add.emit({
        x: p.x,
        y: p.y,
        z: p.z,
        vx: Math.sin(ph) * Math.cos(th) * s,
        vy: Math.cos(ph) * s,
        vz: Math.sin(ph) * Math.sin(th) * s,
        life: rand(0.25, 0.5),
        size: rand(0.06, 0.12),
        sizeEnd: 0.02,
        color,
        gravity: 9,
        drag: 2.5,
        sprite: Sprite.Spark,
        stretch: 0.05,
        ...opts,
      });
    }
  }

  ring(at: THREE.Vector3, color: THREE.Color, r0: number, r1: number, dur: number, inner = 0.7, y = 0.08): Fx {
    const fx = this.fx.spawn('ring', dur, (f, _dt, k) => {
      if (f.t < 0) {
        f.u.uAlpha.value = 0;
        return;
      }
      const e = 1 - Math.pow(1 - k, 3);
      const r = r0 + (r1 - r0) * e;
      f.mesh.scale.set(r, 1, r);
      f.u.uAlpha.value = Math.min(1, (1 - k) * (1 - k) * 1.3);
    });
    (fx.u.uColor.value as THREE.Color).copy(color);
    (fx.u.uParam.value as THREE.Vector4).x = inner;
    fx.mesh.position.set(at.x, at.y + y, at.z);
    fx.mesh.scale.set(r0, 1, r0);
    return fx;
  }

  smoke(p: THREE.Vector3, color: THREE.Color, count: number, spread = 1, rise = 1, size = 0.8, life = 1.1): void {
    for (let i = 0; i < this.n(count); i++) {
      const th = Math.random() * TAU;
      const s = rand(0.3, 1) * spread;
      this.alpha.emit({
        x: p.x + Math.cos(th) * 0.2,
        y: p.y,
        z: p.z + Math.sin(th) * 0.2,
        vx: Math.cos(th) * s * 2,
        vy: rand(0.3, 1) * rise,
        vz: Math.sin(th) * s * 2,
        life: life * rand(0.7, 1.2),
        size: size * rand(0.5, 0.9),
        sizeEnd: size * rand(1.4, 2.2),
        color,
        alpha: 0.55,
        drag: 2.2,
        sprite: Sprite.Smoke,
        spin: rand(-1, 1),
        fadeIn: 0.12,
      });
    }
  }

  // ---------------------------------------------------------------- melee

  /** A curved weapon trail across the target plus sparks. */
  slash(attacker: Unit, target: Unit, color = C.steel, scale = 1): void {
    const at = target.centre(v1);
    const fx = this.fx.spawn('arc', 0.38, (f, _dt, k) => {
      f.u.uProgress.value = Math.min(1.25, k * 2.6);
      f.u.uAlpha.value = k < 0.5 ? 1 : 1 - (k - 0.5) / 0.5;
    });
    const arcCol = color === C.ember ? N.ember : color === C.gold ? N.gold : N.steel;
    (fx.u.uColor.value as THREE.Color).copy(arcCol);
    (fx.u.uColor2.value as THREE.Color).copy(color === C.ember ? N.ember : N.gold).multiplyScalar(0.7);
    fx.mesh.position.copy(at);
    fx.mesh.rotation.set(0, attacker.yaw, 0);
    fx.mesh.rotateZ(rand(-0.9, 0.9) + Math.PI * 0.62);
    const s = Math.max(1.5, target.height * 1.4) * scale;
    fx.mesh.scale.set(s, s, s);
    // Shift so the middle of the crescent sweeps across the target's centre.
    fx.mesh.translateX(-Math.cos(1.3) * 0.72 * s);
    fx.mesh.translateY(-Math.sin(1.3) * 0.72 * s);
    this.glow(at, color, 1.6 * scale, 0.16);
    this.sparks(at, C.gold, 12 * scale, 6, {}, N.star);
  }

  impact(at: THREE.Vector3, color: THREE.Color, scale = 1): void {
    this.glow(at, color, 2.2 * scale, 0.2);
    this.sparks(at, color, 16 * scale, 8 * scale, {}, N.star);
  }

  /** Orbiting stars over a stunned unit's head. */
  stunStars(unit: Unit, dur: number): void {
    this.attach(dur, (_dt, t) => {
      if (!unit.alive) return;
      const top = unit.socketPos('head', v1);
      const r = Math.max(0.35, unit.radius * 0.8);
      for (let i = 0; i < 3; i++) {
        const a = t * 5 + (i / 3) * TAU;
        const sx = top.x + Math.cos(a) * r;
        const sy = top.y + 0.35 + Math.sin(t * 7 + i) * 0.06;
        const sz = top.z + Math.sin(a) * r;
        this.alpha.emit({ x: sx, y: sy, z: sz, life: 0.1, size: 0.42, sizeEnd: 0.3, color: N.star, sprite: Sprite.Star, rot: t * 4, fadeIn: 0 });
        this.add.emit({ x: sx, y: sy, z: sz, life: 0.12, size: 0.3, sizeEnd: 0.15, color: C.gold, sprite: Sprite.Glow, fadeIn: 0, alpha: 0.6 });
      }
    });
  }

  /** Whoosh of streaks and dust while a unit dashes. */
  dashTrail(unit: Unit, dur: number): void {
    this.attach(dur, () => {
      const c = unit.centre(v1);
      for (let i = 0; i < this.n(4); i++) {
        this.add.emit({
          x: c.x + rand(-0.3, 0.3),
          y: c.y + rand(-0.3, 0.3),
          z: c.z + rand(-0.3, 0.3),
          vx: -Math.sin(unit.yaw) * 2,
          vz: -Math.cos(unit.yaw) * 2,
          life: 0.32,
          size: rand(0.08, 0.16),
          color: i % 2 ? C.steel : C.goldSoft,
          sprite: Sprite.Spark,
          stretch: 0.25,
          drag: 3,
        });
      }
      this.alpha.emit({
        x: unit.pos.x,
        y: unit.pos.y + 0.1,
        z: unit.pos.z,
        vx: rand(-1, 1),
        vy: rand(0.4, 1),
        vz: rand(-1, 1),
        life: 0.8,
        size: 0.5,
        sizeEnd: 1.4,
        color: C.dust,
        alpha: 0.45,
        sprite: Sprite.Smoke,
        drag: 2,
      });
    });
  }

  /** Warrior Whirlpool: a spinning water vortex around the unit. */
  whirlpool(unit: Unit, radius: number, dur = 0.75): void {
    const disk = this.fx.spawn('swirl', dur, (f, _dt, k) => {
      f.mesh.position.set(unit.pos.x, unit.pos.y + 0.06, unit.pos.z);
      const r = radius * (0.5 + 0.5 * Math.min(1, k * 4));
      f.mesh.scale.set(r, 1, r);
      f.u.uAlpha.value = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    });
    (disk.u.uColor.value as THREE.Color).copy(N.waterDeep);
    (disk.u.uColor2.value as THREE.Color).copy(N.foam);
    const wall = this.fx.spawn('wall', dur, (f, _dt, k) => {
      f.mesh.position.set(unit.pos.x, unit.pos.y, unit.pos.z);
      const r = radius * (0.55 + 0.4 * k);
      f.mesh.scale.set(r, 1.3 * (1 - k * 0.4), r);
      f.u.uAlpha.value = (k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4) * 0.9;
    });
    (wall.u.uColor.value as THREE.Color).copy(N.water);
    (wall.u.uColor2.value as THREE.Color).copy(N.foam);
    this.attach(dur, (_dt, t) => {
      for (let i = 0; i < this.n(8); i++) {
        const a = Math.random() * TAU;
        const r = radius * rand(0.5, 1);
        const tang = 9;
        this.add.emit({
          x: unit.pos.x + Math.cos(a) * r,
          y: unit.pos.y + rand(0.1, 1.1),
          z: unit.pos.z + Math.sin(a) * r,
          vx: -Math.sin(a) * tang + Math.cos(a) * 2,
          vy: rand(1, 3),
          vz: Math.cos(a) * tang + Math.sin(a) * 2,
          life: 0.45,
          size: rand(0.08, 0.2),
          color: i % 3 ? C.foam : C.water,
          gravity: 8,
          drag: 1.5,
          sprite: i % 2 ? Sprite.Bubble : Sprite.Spark,
          stretch: i % 2 ? 0 : 0.06,
        });
      }
      if (t < 0.05) this.ring(unit.pos, N.foam, radius * 0.4, radius * 1.15, 0.5, 0.82);
    });
  }

  // ---------------------------------------------------------------- spells

  /** Per-frame motes gathering at a claw while casting. */
  castMotes(at: THREE.Vector3, color: THREE.Color, sprite: number = Sprite.Glow): void {
    for (let i = 0; i < this.n(2); i++) {
      const th = Math.random() * TAU;
      const ph = Math.random() * Math.PI;
      const r = rand(0.5, 0.9);
      const ox = Math.sin(ph) * Math.cos(th) * r;
      const oy = Math.cos(ph) * r;
      const oz = Math.sin(ph) * Math.sin(th) * r;
      this.add.emit({
        x: at.x + ox,
        y: at.y + oy,
        z: at.z + oz,
        vx: -ox * 2.6,
        vy: -oy * 2.6,
        vz: -oz * 2.6,
        life: 0.36,
        size: rand(0.07, 0.15),
        sizeEnd: 0.03,
        color,
        sprite,
        fadeIn: 0.3,
      });
    }
    this.add.emit({ x: at.x, y: at.y, z: at.z, life: 0.08, size: 0.45, color, sprite: Sprite.Glow, alpha: 0.6, fadeIn: 0 });
  }

  /**
   * A homing projectile, drawn only: it chases the target at the simulation's speed, and the
   * simulation (src/game/projectiles.ts) says when it lands, which splashes it. style picks the look.
   */
  projectile(from: THREE.Vector3, target: Unit, style: 'bubble' | 'spark' | 'holy' | 'rust', speed: number): ProjectileFx {
    const pos = from.clone();
    const orb = style === 'bubble' ? this.fx.spawn('orb', Infinity) : null;
    if (orb) {
      (orb.u.uColor.value as THREE.Color).copy(C.water);
      (orb.u.uColor2.value as THREE.Color).set(2.2, 2.2, 2.6);
      orb.mesh.scale.setScalar(0.32);
    }
    const color = style === 'bubble' ? C.water : style === 'holy' ? C.holy : style === 'rust' ? C.ember : C.frost;
    let wobble = 0;
    let landed = false;
    // A little past the simulation's longest flight; its landing normally ends this first.
    const a = this.attach(6.5, (dt) => {
      const dest = target.centre(v2);
      const d = v1.copy(dest).sub(pos);
      const len = d.length();
      const step = speed * dt;
      if (len > step && target.alive) pos.addScaledVector(d, step / len);
      wobble += dt * 18;
      if (orb) {
        orb.mesh.position.copy(pos);
        orb.mesh.scale.set(0.32 + Math.sin(wobble) * 0.03, 0.32 - Math.sin(wobble) * 0.03, 0.32);
      }
      this.add.emit({ x: pos.x, y: pos.y, z: pos.z, life: 0.12, size: style === 'bubble' ? 0.9 : 0.55, color, sprite: Sprite.Glow, alpha: 0.7, fadeIn: 0 });
      for (let i = 0; i < this.n(2); i++) {
        this.add.emit({
          x: pos.x + rand(-0.12, 0.12),
          y: pos.y + rand(-0.12, 0.12),
          z: pos.z + rand(-0.12, 0.12),
          vx: rand(-0.6, 0.6),
          vy: rand(-0.2, 0.8),
          vz: rand(-0.6, 0.6),
          life: rand(0.3, 0.55),
          size: style === 'bubble' ? rand(0.06, 0.14) : rand(0.05, 0.1),
          sizeEnd: 0.02,
          color: style === 'bubble' ? C.foam : color,
          sprite: style === 'bubble' ? Sprite.Bubble : style === 'holy' ? Sprite.Star : Sprite.Glow,
        });
      }
    }, () => {
      if (orb) this.fx.release(orb);
      if (!landed) return;
      const at = target.centre(v2);
      if (style === 'bubble') this.bubbleSplash(at);
      else this.impact(at, color, 0.6);
    });
    return {
      land: () => {
        landed = true;
        this.detach(a);
      },
    };
  }

  bubbleSplash(at: THREE.Vector3): void {
    this.glow(at, C.water, 2.4, 0.22);
    for (let i = 0; i < this.n(26); i++) {
      const th = Math.random() * TAU;
      const s = rand(2, 6);
      this.add.emit({
        x: at.x,
        y: at.y,
        z: at.z,
        vx: Math.cos(th) * s,
        vy: rand(1, 5),
        vz: Math.sin(th) * s,
        life: rand(0.35, 0.7),
        size: rand(0.06, 0.16),
        sizeEnd: 0.03,
        color: i % 3 ? C.foam : C.water,
        gravity: 12,
        drag: 1,
        sprite: i % 2 ? Sprite.Bubble : Sprite.Glow,
      });
    }
    this.ring(v1.set(at.x, at.y - 0.4, at.z), N.foam, 0.2, 1.6, 0.35, 0.8, 0);
  }

  frostSpray(origin: THREE.Vector3, yaw: number, range: number, half: number): void {
    const decal = this.telegraphCone(origin, yaw, range, half, 0.7, N.frost);
    decal.anim = (f, _dt, k) => {
      f.u.uProgress.value = Math.min(1, k * 3);
      f.u.uAlpha.value = (1 - k) * 0.42;
    };
    this.attach(0.28, () => {
      for (let i = 0; i < this.n(14); i++) {
        const a = yaw + rand(-half, half);
        const s = rand(0.5, 1) * range * 2.2;
        this.add.emit({
          x: origin.x + Math.sin(yaw) * 0.6,
          y: origin.y + 0.5,
          z: origin.z + Math.cos(yaw) * 0.6,
          vx: Math.sin(a) * s,
          vy: rand(-0.3, 0.8),
          vz: Math.cos(a) * s,
          life: rand(0.35, 0.55),
          size: rand(0.12, 0.3),
          sizeEnd: rand(0.3, 0.6),
          color: i % 3 ? C.frost : C.foam,
          colorEnd: C.frostDeep,
          drag: 3.2,
          sprite: i % 3 === 0 ? Sprite.Snow : Sprite.Glow,
          spin: rand(-4, 4),
        });
      }
      for (let i = 0; i < this.n(5); i++) {
        const a = yaw + rand(-half, half);
        const s = rand(0.5, 1) * range * 2;
        this.alpha.emit({
          x: origin.x + Math.sin(yaw) * 0.6,
          y: origin.y + 0.5,
          z: origin.z + Math.cos(yaw) * 0.6,
          vx: Math.sin(a) * s,
          vy: rand(-0.2, 0.6),
          vz: Math.cos(a) * s,
          life: rand(0.35, 0.55),
          size: rand(0.12, 0.22),
          color: N.frost,
          drag: 3,
          sprite: Sprite.Snow,
          spin: rand(-4, 4),
          fadeIn: 0,
        });
      }
      this.alpha.emit({
        x: origin.x + Math.sin(yaw) * 1,
        y: origin.y + 0.5,
        z: origin.z + Math.cos(yaw) * 1,
        vx: Math.sin(yaw) * range * 1.4,
        vy: 0.3,
        vz: Math.cos(yaw) * range * 1.4,
        life: 0.7,
        size: 0.6,
        sizeEnd: 2.4,
        color: C.smoke,
        alpha: 0.4,
        drag: 2.5,
        sprite: Sprite.Smoke,
      });
    });
  }

  /** Frost crystals drifting around a slowed unit. */
  chill(unit: Unit): void {
    if (Math.random() > 0.35) return;
    const c = unit.centre(v1);
    const a = Math.random() * TAU;
    const r = unit.radius * rand(0.6, 1.1);
    this.add.emit({
      x: c.x + Math.cos(a) * r,
      y: c.y + rand(-0.3, 0.4),
      z: c.z + Math.sin(a) * r,
      vy: -0.3,
      life: 0.7,
      size: rand(0.1, 0.18),
      color: C.frost,
      sprite: Sprite.Snow,
      spin: 2,
    });
  }

  steamPuff(at: THREE.Vector3): void {
    this.smoke(v1.set(at.x, at.y + 0.3, at.z), C.smoke, 34, 1.8, 1.8, 1.3, 1.1);
    this.ring(at, N.foam, 0.3, 2.6, 0.45, 0.8);
    this.glow(v1.set(at.x, at.y + 0.6, at.z), C.foam, 2.2, 0.25);
    for (let i = 0; i < this.n(14); i++) {
      this.add.emit({
        x: at.x + rand(-0.5, 0.5),
        y: at.y + rand(0.2, 1.2),
        z: at.z + rand(-0.5, 0.5),
        vy: rand(0.5, 1.5),
        life: rand(0.4, 0.8),
        size: rand(0.1, 0.2),
        color: C.foam,
        sprite: Sprite.Star,
        spin: 3,
      });
    }
  }

  tidalNova(at: THREE.Vector3, radius: number): void {
    this.ring(at, N.water, 0.4, radius, 0.5, 0.6);
    const r2 = this.ring(at, N.foam, 0.2, radius * 0.85, 0.65, 0.85);
    r2.t = -0.08;
    const wall = this.fx.spawn('wall', 0.55, (f, _dt, k) => {
      const r = 0.5 + (radius - 0.5) * (1 - Math.pow(1 - k, 3));
      f.mesh.scale.set(r, 1.5 * (1 - k), r);
      f.u.uAlpha.value = 1 - k;
    });
    wall.mesh.position.copy(at);
    (wall.u.uColor.value as THREE.Color).copy(N.water);
    (wall.u.uColor2.value as THREE.Color).copy(N.foam);
    (wall.u.uParam.value as THREE.Vector4).x = -1;
    this.glow(v1.set(at.x, at.y + 0.6, at.z), C.water, 4, 0.3);
    for (let i = 0; i < this.n(70); i++) {
      const th = Math.random() * TAU;
      const s = rand(5, 11);
      this.add.emit({
        x: at.x + Math.cos(th) * 0.5,
        y: at.y + 0.3,
        z: at.z + Math.sin(th) * 0.5,
        vx: Math.cos(th) * s,
        vy: rand(2, 6),
        vz: Math.sin(th) * s,
        life: rand(0.4, 0.8),
        size: rand(0.08, 0.22),
        sizeEnd: 0.03,
        color: i % 3 ? C.foam : C.water,
        gravity: 14,
        drag: 1.6,
        sprite: i % 2 ? Sprite.Bubble : Sprite.Spark,
        stretch: i % 2 ? 0 : 0.05,
      });
    }
  }

  smite(target: Unit): void {
    const at = target.pos.clone();
    const r = Math.max(0.6, target.radius * 1.1);
    const pillar = this.fx.spawn('pillar', 0.75, (f, _dt, k) => {
      const grow = Math.min(1, k * 6);
      f.mesh.scale.set(r * (1.3 - k * 0.6), 11, r * (1.3 - k * 0.6));
      f.u.uAlpha.value = grow * (1 - k) * 1.6;
    });
    pillar.mesh.position.copy(at);
    (pillar.u.uColor.value as THREE.Color).copy(C.holy).multiplyScalar(0.6);
    (pillar.u.uColor2.value as THREE.Color).copy(C.holyDeep);
    this.ring(at, N.holy, 0.3, r * 2.6, 0.5, 0.75);
    const c = target.centre(v1);
    this.glow(c, C.holy, 3.4, 0.28);
    for (let i = 0; i < this.n(22); i++) {
      const th = Math.random() * TAU;
      this.add.emit({
        x: at.x + Math.cos(th) * r * 0.8,
        y: at.y + rand(0, 3),
        z: at.z + Math.sin(th) * r * 0.8,
        vx: Math.cos(th) * 1.5,
        vy: rand(-3, 1),
        vz: Math.sin(th) * 1.5,
        life: rand(0.4, 0.8),
        size: rand(0.12, 0.28),
        color: C.holy,
        sprite: Sprite.Star,
        spin: 3,
      });
    }
  }

  mendGlow(unit: Unit): void {
    const fx = this.ring(unit.pos, N.heal, 0.3, unit.radius * 2.4, 0.8, 0.75);
    fx.anim = (f, _dt, k) => {
      f.mesh.position.set(unit.pos.x, unit.pos.y + 0.08, unit.pos.z);
      const r = unit.radius * (1 + 1.4 * k);
      f.mesh.scale.set(r, 1, r);
      f.u.uAlpha.value = 1 - k;
    };
    this.glow(unit.centre(v1), C.heal, 2.6, 0.4);
    this.attach(0.9, (_dt, t) => {
      for (let i = 0; i < this.n(4); i++) {
        const a = t * 9 + i * (TAU / 4) + rand(-0.2, 0.2);
        const r = unit.radius * 1.1;
        this.add.emit({
          x: unit.pos.x + Math.cos(a) * r,
          y: unit.pos.y + rand(0, 0.4) + t * 1.4,
          z: unit.pos.z + Math.sin(a) * r,
          vy: rand(1.2, 2.4),
          life: rand(0.5, 0.8),
          size: rand(0.1, 0.22),
          sizeEnd: 0.04,
          color: i % 2 ? C.heal : C.green,
          sprite: i % 2 ? Sprite.Star : Sprite.Glow,
        });
      }
    });
  }

  ward(unit: Unit, dur: number): WardHandle {
    let alive = true;
    let hit = 0;
    const shield = this.fx.spawn('shield', dur, (f, dt, k) => {
      unit.centre(v1);
      f.mesh.position.copy(v1);
      const appear = Math.min(1, f.t * 5);
      const s = unit.radius * 1.9 * (0.6 + 0.4 * appear) * (1 + Math.sin(f.t * 3) * 0.02);
      f.mesh.scale.set(s, s * 0.85, s);
      hit = Math.max(0, hit - dt * 4);
      (f.u.uParam.value as THREE.Vector4).x = hit;
      f.u.uAlpha.value = appear * (k > 0.85 ? (1 - k) / 0.15 : 1) * (k > 0.7 ? 0.7 + 0.3 * Math.sin(f.t * 20) : 1);
    }, () => {
      alive = false;
    });
    (shield.u.uColor.value as THREE.Color).copy(C.ward);
    (shield.u.uColor2.value as THREE.Color).copy(C.wardDeep);
    this.ring(unit.pos, N.ward, 0.3, unit.radius * 2.2, 0.45, 0.8);
    return {
      get alive() {
        return alive;
      },
      hit: () => {
        hit = 1;
      },
      pop: () => {
        if (!alive) return;
        alive = false;
        this.fx.release(shield);
        const c = unit.centre(v1);
        for (let i = 0; i < this.n(30); i++) {
          const th = Math.random() * TAU;
          const ph = Math.random() * Math.PI;
          const s = rand(2, 5);
          this.add.emit({
            x: c.x,
            y: c.y,
            z: c.z,
            vx: Math.sin(ph) * Math.cos(th) * s,
            vy: Math.cos(ph) * s + 1,
            vz: Math.sin(ph) * Math.sin(th) * s,
            life: rand(0.4, 0.7),
            size: rand(0.1, 0.2),
            color: C.ward,
            gravity: 8,
            sprite: Sprite.Flake,
            spin: rand(-8, 8),
          });
        }
      },
    };
  }

  holyTide(at: THREE.Vector3, radius: number): void {
    this.ring(at, N.holy, 0.4, radius, 0.6, 0.55);
    const r2 = this.ring(at, N.gold, 0.2, radius * 0.75, 0.7, 0.88);
    r2.t = -0.1;
    this.glow(v1.set(at.x, at.y + 0.8, at.z), C.holy, 4.5, 0.35);
    const wave = this.fx.spawn('wall', 0.6, (f, _dt, k) => {
      const r = 0.6 + (radius - 0.6) * (1 - Math.pow(1 - k, 3));
      f.mesh.scale.set(r, 1.3 * (1 - k * 0.6), r);
      f.u.uAlpha.value = (1 - k) * 0.9;
    });
    wave.mesh.position.copy(at);
    (wave.u.uColor.value as THREE.Color).copy(N.gold);
    (wave.u.uColor2.value as THREE.Color).copy(N.holy);
    for (let i = 0; i < this.n(50); i++) {
      const th = Math.random() * TAU;
      const s = rand(4, 8);
      this.add.emit({
        x: at.x,
        y: at.y + 0.4,
        z: at.z,
        vx: Math.cos(th) * s,
        vy: rand(0.5, 2.5),
        vz: Math.sin(th) * s,
        life: rand(0.5, 0.8),
        size: rand(0.12, 0.26),
        sizeEnd: 0.04,
        color: i % 2 ? C.holy : C.gold,
        drag: 2.4,
        sprite: Sprite.Star,
        spin: 4,
      });
    }
  }

  levelUp(unit: Unit): void {
    const p = unit.pos;
    const pillar = this.fx.spawn('pillar', 1.8, (f, _dt, k) => {
      f.mesh.position.set(unit.pos.x, unit.pos.y, unit.pos.z);
      f.mesh.scale.set(1.1 + k * 0.3, 7, 1.1 + k * 0.3);
      f.u.uAlpha.value = Math.min(1, k * 8) * (1 - k) * 1.1;
    });
    (pillar.u.uColor.value as THREE.Color).copy(C.gold).multiplyScalar(0.45);
    (pillar.u.uColor2.value as THREE.Color).copy(C.holyDeep).multiplyScalar(0.6);
    this.ring(p, N.gold, 0.4, 4.5, 0.9, 0.7);
    const r2 = this.ring(p, N.holy, 0.2, 3, 1.1, 0.88);
    r2.t = -0.15;
    this.attach(1.3, (_dt, t) => {
      for (let i = 0; i < this.n(5); i++) {
        const a = Math.random() * TAU;
        const r = rand(0.3, 1.4);
        this.add.emit({
          x: unit.pos.x + Math.cos(a) * r,
          y: unit.pos.y + rand(0, 0.5) + t,
          z: unit.pos.z + Math.sin(a) * r,
          vy: rand(2, 4.5),
          life: rand(0.7, 1.1),
          size: rand(0.12, 0.3),
          sizeEnd: 0.04,
          color: i % 2 ? C.gold : C.holy,
          sprite: Sprite.Star,
          spin: 3,
        });
      }
    });
  }

  // ---------------------------------------------------------------- enemy mechanics

  /** `ground` is the normal of the ground under the mark; a sloped deck would swallow a flat one. */
  telegraphCircle(at: THREE.Vector3, radius: number, dur: number, color = N.red, ground?: THREE.Vector3): Fx {
    const fx = this.fx.spawn('decal', dur, (f, _dt, k) => {
      f.u.uProgress.value = k;
      f.u.uAlpha.value = Math.min(1, f.t * 6);
    });
    (fx.u.uColor.value as THREE.Color).copy(color);
    (fx.u.uParam.value as THREE.Vector4).x = Math.PI;
    this.placeTelegraph(fx, at, 0, radius, radius, ground);
    return fx;
  }

  telegraphCone(at: THREE.Vector3, yaw: number, range: number, half: number, dur: number, color = N.ember, ground?: THREE.Vector3): Fx {
    const fx = this.fx.spawn('decal', dur, (f, _dt, k) => {
      f.u.uProgress.value = k;
      f.u.uAlpha.value = Math.min(1, f.t * 6);
    });
    (fx.u.uColor.value as THREE.Color).copy(color);
    (fx.u.uParam.value as THREE.Vector4).x = half;
    this.placeTelegraph(fx, at, yaw, range, range, ground);
    return fx;
  }

  telegraphLane(at: THREE.Vector3, yaw: number, halfLength: number, halfWidth: number, dur: number, color = N.ember): Fx {
    const fx = this.fx.spawn('decal', dur, (f, _dt, k) => {
      f.u.uProgress.value = k;
      f.u.uAlpha.value = dur < 0.6 ? 1-k : Math.min(1, f.t*6);
    });
    (fx.u.uColor.value as THREE.Color).copy(color);
    (fx.u.uParam.value as THREE.Vector4).y = 1;
    this.placeTelegraph(fx, at, yaw, halfWidth, halfLength);
    return fx;
  }

  private placeTelegraph(fx: Fx, at: THREE.Vector3, yaw: number, width: number, length: number, ground?: THREE.Vector3): void {
    fx.mesh.position.copy(at);
    fx.mesh.rotation.set(0, yaw, 0);
    fx.mesh.scale.set(width, 1, length);
    if (this.groundHeight) {
      // Geometry belongs to this pooled instance and is reused, never allocated per frame.
      if (!fx.mesh.userData.telegraphGeometry) {
        fx.mesh.geometry = new THREE.PlaneGeometry(2, 2, 32, 32).rotateX(Math.PI/2);
        fx.mesh.userData.telegraphGeometry = true;
      }
      conformTelegraph(fx.mesh.geometry, at, yaw, width, length, this.groundHeight);
    } else {
      fx.mesh.position.y += 0.28;
      this.layDecal(fx, yaw, ground);
    }
  }

  /** Pooled decals are reused: set the whole rotation, tilted onto the ground's plane if given. */
  private layDecal(fx: Fx, yaw: number, ground?: THREE.Vector3): void {
    fx.mesh.rotation.set(0, yaw, 0);
    if (ground) fx.mesh.quaternion.premultiply(tilt.setFromUnitVectors(UP, ground));
  }

  slamImpact(at: THREE.Vector3, radius: number): void {
    this.ring(at, N.ember, 0.5, radius * 1.15, 0.45, 0.6);
    this.ring(at, C.dust, 0.3, radius * 0.8, 0.6, 0.7);
    this.glow(v1.set(at.x, at.y + 0.5, at.z), C.ember, 5, 0.3);
    for (let i = 0; i < this.n(26); i++) {
      const th = Math.random() * TAU;
      const s = rand(2, 6);
      this.alpha.emit({
        x: at.x + Math.cos(th) * radius * 0.3,
        y: at.y + 0.2,
        z: at.z + Math.sin(th) * radius * 0.3,
        vx: Math.cos(th) * s,
        vy: rand(0.5, 2),
        vz: Math.sin(th) * s,
        life: rand(0.8, 1.4),
        size: rand(0.8, 1.3),
        sizeEnd: rand(2, 3),
        color: i % 2 ? C.dust : C.dustDark,
        alpha: 0.6,
        drag: 2.4,
        sprite: Sprite.Smoke,
        spin: rand(-1, 1),
      });
    }
    for (let i = 0; i < this.n(24); i++) {
      const th = Math.random() * TAU;
      const s = rand(3, 8);
      this.alpha.emit({
        x: at.x,
        y: at.y + 0.3,
        z: at.z,
        vx: Math.cos(th) * s,
        vy: rand(4, 9),
        vz: Math.sin(th) * s,
        life: rand(0.7, 1.1),
        size: rand(0.12, 0.3),
        color: C.rust,
        colorEnd: C.rustDark,
        alpha: 1,
        gravity: 20,
        sprite: Sprite.Flake,
        spin: rand(-10, 10),
        fadeIn: 0,
      });
    }
  }

  rustSpray(origin: THREE.Vector3, yaw: number, range: number, half: number): void {
    this.attach(0.55, () => {
      for (let i = 0; i < this.n(10); i++) {
        const a = yaw + rand(-half, half);
        const s = rand(0.5, 1) * range * 1.9;
        const ember = i % 3 === 0;
        (ember ? this.add : this.alpha).emit({
          x: origin.x + Math.sin(yaw) * 1.5,
          y: origin.y + rand(1.2, 2),
          z: origin.z + Math.cos(yaw) * 1.5,
          vx: Math.sin(a) * s,
          vy: rand(-1, 1.5),
          vz: Math.cos(a) * s,
          life: rand(0.45, 0.7),
          size: ember ? rand(0.08, 0.16) : rand(0.18, 0.4),
          sizeEnd: ember ? 0.03 : rand(0.6, 1.2),
          color: ember ? C.ember : C.rust,
          colorEnd: ember ? C.orange : C.rustDark,
          alpha: ember ? 1 : 0.8,
          gravity: ember ? 2 : 4,
          drag: 2,
          sprite: ember ? Sprite.Glow : i % 2 ? Sprite.Flake : Sprite.Smoke,
          spin: rand(-6, 6),
        });
      }
    });
  }

  undertow(at: THREE.Vector3, radius: number, dur: number): void {
    const disk = this.fx.spawn('swirl', dur, (f, _dt, k) => {
      f.mesh.scale.set(radius * 2.2, 1, radius * 2.2);
      f.u.uAlpha.value = Math.min(1, k * 5) * (k > 0.85 ? (1 - k) / 0.15 : 1);
    });
    disk.mesh.position.set(at.x, at.y + 0.05, at.z);
    (disk.u.uColor.value as THREE.Color).copy(N.waterDeep);
    (disk.u.uColor2.value as THREE.Color).copy(N.water);
    (disk.u.uParam.value as THREE.Vector4).x = -1;
    this.attach(dur, () => {
      for (let i = 0; i < this.n(6); i++) {
        const a = Math.random() * TAU;
        const r = radius * rand(1.4, 2.3);
        const inward = 6;
        this.add.emit({
          x: at.x + Math.cos(a) * r,
          y: at.y + rand(0.1, 0.6),
          z: at.z + Math.sin(a) * r,
          vx: -Math.cos(a) * inward - Math.sin(a) * 4,
          vy: 0,
          vz: -Math.sin(a) * inward + Math.cos(a) * 4,
          life: 0.7,
          size: rand(0.08, 0.18),
          color: i % 2 ? C.foam : C.water,
          sprite: i % 2 ? Sprite.Bubble : Sprite.Spark,
          stretch: i % 2 ? 0 : 0.08,
        });
      }
    });
  }

  rustPeel(unit: Unit, dur: number): void {
    this.attach(dur, () => {
      for (let i = 0; i < this.n(5); i++) {
        const a = Math.random() * TAU;
        const r = unit.radius * rand(0.4, 1);
        const y = unit.pos.y + unit.height * rand(0.2, 0.9);
        const ember = Math.random() < 0.3;
        (ember ? this.add : this.alpha).emit({
          x: unit.pos.x + Math.cos(a) * r,
          y,
          z: unit.pos.z + Math.sin(a) * r,
          vx: Math.cos(a) * rand(0.5, 2),
          vy: rand(0.5, 2.5),
          vz: Math.sin(a) * rand(0.5, 2),
          life: rand(0.9, 1.6),
          size: ember ? rand(0.06, 0.12) : rand(0.18, 0.42),
          color: ember ? C.ember : C.rust,
          colorEnd: ember ? C.orange : C.rustDark,
          gravity: ember ? -0.5 : 6,
          drag: 0.6,
          sprite: ember ? Sprite.Glow : Sprite.Flake,
          spin: rand(-6, 6),
          fadeIn: 0,
        });
      }
    });
  }

  /** Steam and embers venting from an enraged boss. */
  heatVent(unit: Unit): void {
    const top = unit.socketPos('head', v1);
    this.alpha.emit({
      x: top.x + rand(-0.6, 0.6),
      y: top.y,
      z: top.z + rand(-0.6, 0.6),
      vy: rand(1.5, 3),
      life: 1.2,
      size: 0.8,
      sizeEnd: 2.4,
      color: C.smokeGrey,
      alpha: 0.35,
      sprite: Sprite.Smoke,
      spin: 1,
    });
    if (Math.random() < 0.6)
      this.add.emit({
        x: top.x + rand(-0.8, 0.8),
        y: top.y,
        z: top.z + rand(-0.8, 0.8),
        vx: rand(-1, 1),
        vy: rand(2, 4),
        vz: rand(-1, 1),
        life: 0.9,
        size: 0.12,
        color: C.ember,
        sprite: Sprite.Glow,
      });
  }

  burrow(at: THREE.Vector3): void {
    this.smoke(v1.set(at.x, at.y + 0.1, at.z), C.dust, 12, 1.2, 1.2, 0.6, 0.9);
    for (let i = 0; i < this.n(16); i++) {
      const th = Math.random() * TAU;
      this.alpha.emit({
        x: at.x,
        y: at.y + 0.2,
        z: at.z,
        vx: Math.cos(th) * rand(1, 3),
        vy: rand(3, 6),
        vz: Math.sin(th) * rand(1, 3),
        life: rand(0.6, 0.9),
        size: rand(0.08, 0.18),
        color: C.dustDark,
        gravity: 16,
        sprite: Sprite.Flake,
        spin: rand(-8, 8),
        fadeIn: 0,
      });
    }
  }

  deathPoof(unit: Unit): void {
    const c = unit.centre(v1);
    this.smoke(c, C.smokeGrey, 10, 0.8, 0.8, 0.5 * unit.height, 1.0);
    this.sparks(c, C.ember, 10, 4);
  }

  lootSparkle(at: THREE.Vector3): void {
    for (let i = 0; i < this.n(14); i++) {
      this.add.emit({
        x: at.x + rand(-0.3, 0.3),
        y: at.y + rand(0.2, 0.8),
        z: at.z + rand(-0.3, 0.3),
        vy: rand(0.8, 2),
        life: rand(0.6, 1.0),
        size: rand(0.12, 0.24),
        color: C.gold,
        sprite: Sprite.Star,
        spin: 4,
      });
    }
  }

  /** Motes flowing from a claw up to the beacon while channeling. */
  beaconStream(from: THREE.Vector3, to: THREE.Vector3, progress: number): void {
    const d = v1.copy(to).sub(from);
    const len = d.length();
    const speed = 9;
    d.normalize();
    for (let i = 0; i < this.n(3); i++) {
      this.add.emit({
        x: from.x + rand(-0.15, 0.15),
        y: from.y + rand(-0.15, 0.15),
        z: from.z + rand(-0.15, 0.15),
        vx: d.x * speed + rand(-0.4, 0.4),
        vy: d.y * speed + rand(-0.4, 0.4),
        vz: d.z * speed + rand(-0.4, 0.4),
        life: len / speed,
        size: rand(0.1, 0.22),
        sizeEnd: 0.05,
        color: i % 2 ? C.gold : C.holy,
        sprite: i % 2 ? Sprite.Star : Sprite.Glow,
        spin: 3,
      });
    }
    this.glow(to, C.holy, 1 + progress * 3, 0.1, 1 + progress * 3);
  }

  /** Big light-up flash at the beacon. */
  beaconBlaze(at: THREE.Vector3): void {
    this.glow(at, C.white, 8, 0.7, 3);
    this.sparks(at, C.gold, 80, 14, { life: 1.2, gravity: 6 });
    for (let i = 0; i < this.n(40); i++) {
      const th = Math.random() * TAU;
      this.add.emit({
        x: at.x,
        y: at.y,
        z: at.z,
        vx: Math.cos(th) * rand(3, 9),
        vy: rand(-2, 4),
        vz: Math.sin(th) * rand(3, 9),
        life: rand(1, 1.8),
        size: rand(0.2, 0.4),
        color: C.holy,
        drag: 1.4,
        sprite: Sprite.Star,
        spin: 3,
      });
    }
  }

  firework(at: THREE.Vector3, color: THREE.Color, height = rand(14, 22)): void {
    const pos = new THREE.Vector3(at.x + rand(-3, 3), at.y, at.z + rand(-3, 3));
    const apex = new THREE.Vector3(at.x + rand(-4, 4), at.y + height, at.z + rand(-4, 4));
    const climb = rand(0.9, 1.3);
    this.attach(climb, (_dt, t) => {
      const k = t / climb;
      const e = 1 - (1 - k) * (1 - k);
      v1.lerpVectors(pos, apex, e);
      for (let i = 0; i < 3; i++)
        this.add.emit({ x: v1.x + rand(-0.05, 0.05), y: v1.y - i * 0.15, z: v1.z + rand(-0.05, 0.05), vx: rand(-0.4, 0.4), vy: -2.5, vz: rand(-0.4, 0.4), life: 0.5, size: 0.16, sizeEnd: 0.03, color: C.ember, sprite: Sprite.Spark, stretch: 0.05, drag: 1 });
    }, () => {
      this.glow(apex, color, 7, 0.35, 2);
      const n = this.n(110);
      for (let i = 0; i < n; i++) {
        const th = Math.random() * TAU;
        const ph = Math.acos(rand(-1, 1));
        const s = rand(7, 10);
        this.add.emit({
          x: apex.x,
          y: apex.y,
          z: apex.z,
          vx: Math.sin(ph) * Math.cos(th) * s,
          vy: Math.cos(ph) * s,
          vz: Math.sin(ph) * Math.sin(th) * s,
          life: rand(1.2, 1.9),
          size: rand(0.3, 0.48),
          sizeEnd: 0.06,
          color,
          colorEnd: C.ember,
          gravity: 3.5,
          drag: 1.6,
          sprite: Sprite.Spark,
          stretch: 0.05,
          fadeIn: 0,
        });
      }
      for (let i = 0; i < this.n(30); i++) {
        this.add.emit({
          x: apex.x + rand(-4, 4),
          y: apex.y + rand(-4, 2),
          z: apex.z + rand(-4, 4),
          vy: -1,
          life: rand(0.8, 1.6),
          size: rand(0.15, 0.3),
          color: C.white,
          sprite: Sprite.Star,
          spin: 6,
          fadeIn: 0.5,
        });
      }
    });
  }
}
