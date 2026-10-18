// World-level queries the islands add on top of their collision: an elliptic shore that keeps
// everyone on the island, and (World II) the throne's columns pushed out first.
import type { Collision, Vec2Out } from './collision';

/** An ellipse centred on x = 0: |(x / rx, (z - cz) / rz)| <= max. */
export interface IslandBounds {
  cz: number;
  rx: number;
  rz: number;
  max: number;
}
export const STAR_BOUNDS: IslandBounds = { cz: 10, rx: 110, rz: 132, max: 0.91 };
export const DAWN_BOUNDS: IslandBounds = { cz: 3, rx: 122, rz: 149, max: 0.81 };

export interface PushCircle {
  x: number;
  z: number;
  r: number;
}

export function resolveOnIsland<T extends Vec2Out>(col: Collision | null, bounds: IslandBounds, push: readonly PushCircle[], x: number, z: number, r: number, out: T): T {
  const d = Math.hypot(x / bounds.rx, (z - bounds.cz) / bounds.rz);
  if (d > bounds.max) {
    x *= bounds.max / d;
    z = bounds.cz + ((z - bounds.cz) * bounds.max) / d;
  }
  for (const o of push) {
    const dx = x - o.x,
      dz = z - o.z,
      dist = Math.hypot(dx, dz),
      min = r + o.r;
    if (dist < min) {
      x = o.x + (dx / (dist || 1)) * min;
      z = o.z + (dz / (dist || 1)) * min;
    }
  }
  return col ? col.resolve(x, z, r, out) : out.set(x, z);
}
