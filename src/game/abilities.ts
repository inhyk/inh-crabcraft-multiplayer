// What each class ability does once it is paid for. Numbers are tuned so a first quest run takes
// 8 to 12 minutes and Corrodius about 90 seconds (see docs/design.md "Quest chain"). Effects and
// sounds leave as 'ability' events (src/game/events.ts); the projectile flies in the simulation.
import * as THREE from 'three';
import type { AbilityDef } from '../data/classes';
import type { Game } from './game';
import type { Player } from './player';
import type { Unit } from './unit';
import { rollCrit, CRIT_MULT } from './combat';
import { v3 } from './events';
import { angleDiff, rand, yawTo } from './util';

const TARGETED = new Set(['pincer-strike', 'shell-bash', 'sideways-charge', 'bubble-bolt', 'smite']);
const MELEE = new Set(['pincer-strike', 'shell-bash']);

export function abilityNeedsTarget(a: AbilityDef): boolean {
  return TARGETED.has(a.id);
}

export function isMeleeAbility(a: AbilityDef): boolean {
  return MELEE.has(a.id);
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector2();

/** Hostile, living units whose edge is within `radius` of a point. */
export function enemiesNear(g: Game, x: number, z: number, radius: number): Unit[] {
  return g.units.filter((o) => o.hostile && o.alive && !o.hidden && Math.hypot(o.pos.x - x, o.pos.z - z) - o.radius <= radius);
}

function hit(g: Game, p: Player, t: Unit, min: number, max: number, school: 'physical' | 'frost' | 'water' | 'holy', critBonus = 0): number {
  const crit = rollCrit(0.12 + critBonus);
  return g.combat.damage(p.unit, t, rand(min, max) * p.dmgMul * (crit ? CRIT_MULT : 1), { crit, school });
}

function knockback(g: Game, t: Unit, fromX: number, fromZ: number, dist: number, seconds = 0.35): void {
  if (t.kind === 'boss') return;
  const dx = t.pos.x - fromX;
  const dz = t.pos.z - fromZ;
  const len = Math.hypot(dx, dz) || 1;
  t.pushX = (dx / len) * (dist / seconds);
  t.pushZ = (dz / len) * (dist / seconds);
  t.pushTime = seconds;
  g.multiplayer?.battle.condition(t);
}

export function executeAbility(g: Game, p: Player, ab: AbilityDef, target: Unit | null): void {
  const u = p.unit;
  const now = g.time;
  const ev = g.events;
  const fx = (stage: 'start' | 'hit', more: { target?: Unit | null; from?: THREE.Vector3; amount?: number; stun?: number; half?: number } = {}) =>
    ev.emit({ type: 'ability', caster: u, ability: ab.id, stage, range: ab.range, ...more, from: more.from && v3(more.from) });
  switch (ab.id) {
    // ------------------------------------------------------------ Warrior
    case 'pincer-strike': {
      const t = target!;
      u.act('attack_swipe', {
        upper: true,
        speed: 1.3,
        onHit: () => {
          if (!t.alive) return;
          hit(g, p, t, 16, 21, 'physical', 0.05);
          fx('hit', { target: t });
        },
      });
      break;
    }
    case 'shell-bash': {
      const t = target!;
      u.act('attack_slam', {
        upper: true,
        onHit: () => {
          if (!t.alive) return;
          hit(g, p, t, 10, 13, 'physical');
          const stun = t.kind === 'boss' ? 1 : 2;
          t.stunUntil = Math.max(t.stunUntil, g.time + stun);
          t.cancelPendingHit();
          g.multiplayer?.battle.condition(t);
          fx('hit', { target: t, stun });
        },
      });
      break;
    }
    case 'sideways-charge': {
      p.startDash(target!);
      fx('start', { target });
      break;
    }
    case 'whirlpool': {
      p.spin();
      u.act('attack_swipe', { upper: true, speed: 1.4 });
      fx('start');
      for (const t of enemiesNear(g, u.pos.x, u.pos.z, ab.range)) {
        hit(g, p, t, 15, 20, 'water');
        knockback(g, t, u.pos.x, u.pos.z, 1.6);
      }
      break;
    }
    // ------------------------------------------------------------ Mage
    case 'bubble-bolt': {
      const t = target!;
      const from = u.socketPos('clawR', v1).clone();
      u.act('attack_swipe', { upper: true, speed: 1.5 });
      g.projectiles.spawn(u, from, t, 'bubble', 17, () => {
        if (!t.alive) return;
        hit(g, p, t, 33, 39, 'water');
      });
      break;
    }
    case 'frost-spray': {
      const half = 0.55;
      u.act('attack_swipe', { upper: true, speed: 1.3 });
      fx('start', { half });
      for (const t of enemiesNear(g, u.pos.x, u.pos.z, ab.range)) {
        const a = yawTo(u.pos.x, u.pos.z, t.pos.x, t.pos.z);
        if (Math.abs(angleDiff(a, u.yaw)) > half + Math.atan2(t.radius, Math.max(0.5, u.distTo(t)))) continue;
        hit(g, p, t, 15, 19, 'frost');
        t.slowUntil = now + 4;
        t.slowPct = 0.5;
        g.multiplayer?.battle.condition(t);
      }
      break;
    }
    case 'steam-blink': {
      const from = u.pos.clone();
      const dx = Math.sin(u.yaw);
      const dz = Math.cos(u.yaw);
      let x = u.pos.x;
      let z = u.pos.z;
      for (let d = 0.5; d <= ab.range + 1e-6; d += 0.5) {
        const tx = from.x + dx * d;
        const tz = from.z + dz * d;
        const r = g.world.resolveCollision(tx, tz, u.radius, v2);
        if (Math.hypot(r.x - tx, r.y - tz) > 0.25) break;
        if (Math.abs(g.world.heightAt(tx, tz) - g.world.heightAt(x, z)) > 2.5) break;
        x = r.x;
        z = r.y;
      }
      u.teleport(g.world, x, z);
      // A puff where the crab left and one where it stands.
      fx('start', { from });
      break;
    }
    case 'tidal-nova': {
      u.act('attack_slam', { upper: true });
      fx('start');
      for (const t of enemiesNear(g, u.pos.x, u.pos.z, ab.range)) {
        hit(g, p, t, 20, 26, 'water');
        knockback(g, t, u.pos.x, u.pos.z, 5);
        t.stunUntil = Math.max(t.stunUntil, now + 0.6);
        g.multiplayer?.battle.condition(t);
      }
      break;
    }
    // ------------------------------------------------------------ Priest
    case 'smite': {
      const t = target!;
      fx('start', { target: t });
      const dmg = hit(g, p, t, 27, 33, 'holy');
      fx('hit', { target: t, amount: dmg });
      break;
    }
    case 'mend-shell': {
      const crit = rollCrit();
      g.combat.heal(u, u, u.maxHp * 0.35 * (crit ? 1.5 : 1), crit);
      fx('start');
      u.express('happy', 1);
      break;
    }
    case 'barnacle-ward': {
      u.absorbMax = u.absorb = Math.round(u.maxHp * 0.3);
      u.absorbUntil = now + 10;
      p.warded = true;
      ev.emit({ type: 'ward', unit: u, stage: 'up', seconds: 10 });
      fx('start');
      break;
    }
    case 'holy-tide': {
      // The tide breaks on the cast's release: the claws flung wide.
      u.act('cast', {
        upper: true,
        part: 'release',
        speed: 1.5,
        onHit: () => {
          if (!u.alive) return;
          fx('hit');
          for (const t of enemiesNear(g, u.pos.x, u.pos.z, ab.range)) hit(g, p, t, 15, 19, 'holy');
          g.combat.heal(u, u, u.maxHp * 0.15);
        },
      });
      break;
    }
  }
}
