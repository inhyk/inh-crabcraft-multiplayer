// Homing projectiles (Bubble Bolt, the mage's and priest's auto-attacks). Their flight is part of
// the simulation: each one homes on its target's centre at a fixed speed and lands when it gets
// there, when the target dies, or after six seconds. Effects only draw it, from its events.
import * as THREE from 'three';
import { v3, type ProjectileStyle, type SimEvents, type Vec3 } from './events';
import type { Unit } from './unit';

/** Longest flight before a projectile lands wherever its target is. */
const MAX_FLIGHT = 6;

interface Projectile {
  id: number;
  src: Unit;
  target: Unit;
  style: ProjectileStyle;
  x: number;
  y: number;
  z: number;
  speed: number;
  t: number;
  onHit: () => void;
}

const centre = new THREE.Vector3();

export class Projectiles {
  private list: Projectile[] = [];
  private nextId = 1;

  constructor(private readonly events: SimEvents) {}

  get count(): number {
    return this.list.length;
  }

  /** Launch from `from` toward `target`; onHit runs when it lands (check the target is alive). */
  spawn(src: Unit, from: Vec3, target: Unit, style: ProjectileStyle, speed: number, onHit: () => void): void {
    const p: Projectile = { id: this.nextId++, src, target, style, x: from.x, y: from.y, z: from.z, speed, t: 0, onHit };
    this.list.push(p);
    this.events.emit({ type: 'projectile', stage: 'spawn', id: p.id, src, target, from: v3(from), style, speed });
  }

  update(dt: number): void {
    // Newest first, as the effects ran them before (a projectile spawned by a landing waits a frame).
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.t += dt;
      const dest = p.target.centre(centre);
      const dx = dest.x - p.x;
      const dy = dest.y - p.y;
      const dz = dest.z - p.z;
      const len = Math.hypot(dx, dy, dz);
      const step = p.speed * dt;
      if (p.t >= MAX_FLIGHT || len <= step || !p.target.alive) {
        this.list.splice(i, 1);
        this.events.emit({ type: 'projectile', stage: 'hit', id: p.id, src: p.src, target: p.target, style: p.style, landed: p.target.alive });
        p.onHit();
        continue;
      }
      p.x += (dx / len) * step;
      p.y += (dy / len) * step;
      p.z += (dz / len) * step;
    }
  }

  /** Drop every projectile in flight without landing it (a new world). */
  clear(): void {
    this.list.length = 0;
  }
}
