// World III's colliders, registered without meshes, and the placements they share with the meshes.
// DawnIsland builds its collision this way; tools/bake-collision.mjs bakes the same registration.
import { dawnHeight } from '../sim/world/ground';
import { TownBuilder } from '../world/buildings';
import { Collision } from '../world/collision';
import type { Lot } from '../world/layout';
import { registerDawnScenery } from './dawnScenery';
import type { IslandPath } from './islandPaths';

export const DAWN_PATHS: IslandPath[] = [
  { points: [[0, 94], [0, 26], [0, -49]], width: 8.4, trim: true },
  { points: [[-26, 53], [26, 53]], width: 6, trim: true },
  { points: [[-5, 74], [-28, 75], [-50, 64], [-62, 48]], width: 2.6, trim: true },
  { points: [[4, 75], [28, 84], [48, 84], [61, 76]], width: 2.6, trim: true },
  ...[26, 45, 64, 83].flatMap((z) => [-1, 1].map((side) => ({ points: [[side * 4.2, z], [side * 29, z]] as [number, number][], width: 2.4, trim: false }))),
];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const roadClearance = (x: number, z: number) => {
  let best = Infinity;
  for (const path of DAWN_PATHS)
    for (let i = 1; i < path.points.length; i++) {
      const [ax, az] = path.points[i - 1],
        [bx, bz] = path.points[i],
        dx = bx - ax,
        dz = bz - az,
        t = clamp01(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz));
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t) - path.width / 2);
    }
  return best;
};

/** Volcanic rocks ringing the citadel, leaving the avenue open. */
export function dawnRocks() {
  const rocks: { i: number; x: number; z: number; r: number }[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2,
      x = Math.sin(a) * 67,
      z = -45 + Math.cos(a) * 50;
    if (Math.abs(x) < 12) continue;
    rocks.push({ i, x, z, r: 2 + (i % 3) });
  }
  return rocks;
}

/** Dawnharbor's homes, forge and tavern on both sides of the avenue. */
export function dawnLots(): Lot[] {
  const lots: Lot[] = [];
  for (const side of [-1, 1])
    for (let i = 0; i < 4; i++) {
      const x = side * (i % 2 ? 38 : 35),
        z = 26 + i * 19;
      lots.push({ id: `dawn-${side}-${i}`, kind: i === 2 ? (side === 1 ? 'forge' : 'tavern') : 'house', x, z, yaw: side < 0 ? Math.PI / 2 : -Math.PI / 2, sx: i === 2 ? 4 : 3, sz: i === 2 ? 4 : 3, floors: i % 2 ? 2 : 1, style: (i + (side > 0 ? 2 : 0)) % 4, h: dawnHeight(x, z) });
    }
  return lots;
}

/** Leafy trees around the town, clear of roads, plazas, the lighthouse and the citadel. */
export function dawnForest() {
  const trees: { i: number; x: number; z: number; a: number; scale: number }[] = [];
  for (let i = 0; i < 75; i++) {
    const a = i * 2.39996,
      x = Math.sin(a) * (56 + (i % 5) * 5),
      z = 30 + Math.cos(a) * 66;
    if (roadClearance(x, z) < 4 || Math.abs(x) < 14 || Math.hypot(x - 67, z - 72) < 12 || Math.hypot(x, z + 72) < 32 || (Math.abs(x) > 28 && Math.abs(x) < 48 && z > 17 && z < 96)) continue;
    if ((Math.abs(z - (75 + (x + 5) * 0.15)) < 4 && x < 0 && x > -53) || (Math.abs(z - 84) < 5 && x > 14 && x < 61)) continue;
    trees.push({ i, x, z, a, scale: 0.75 + (i % 4) * 0.12 });
  }
  return trees;
}

/** A small grove in Seabreeze Gardens. */
export function dawnGrove() {
  const trees: { i: number; x: number; z: number; a: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const a = i * 2.39996,
      x = -65 + Math.cos(a) * (7 + (i % 3) * 2),
      z = 45 + Math.sin(a) * (8 + (i % 4) * 2);
    if (Math.hypot(x + 62, z - 48) < 4 || roadClearance(x, z) < 3) continue;
    trees.push({ i, x, z, a });
  }
  return trees;
}

export function layoutDawnreach(): Collision {
  const h = dawnHeight;
  const col = new Collision({ minX: -150, minZ: -175, step: 2, nx: 151, nz: 176, h: new Float32Array(151 * 176), heightAt: h });
  // The town fountain, the citadel's flanking towers and the rock ring.
  col.addCircle(-11, 53, 3.7, 4, 9);
  for (const side of [-1, 1]) col.addCircle(side * 27, -56, 4.5, 4, 35);
  for (const { x, z, r } of dawnRocks()) {
    const y = h(x, z);
    col.addCircle(x, z, r + 1, y, y + 7);
  }
  registerDawnScenery(h, col);
  const builder = new TownBuilder(null, null, col, {});
  for (const lot of dawnLots()) builder.build(lot);
  for (const { x, z, scale } of dawnForest()) col.addCircle(x, z, 0.5 * scale, h(x, z), h(x, z) + 10);
  for (const { x, z } of dawnGrove()) col.addCircle(x, z, 0.4, h(x, z), h(x, z) + 8);
  return col;
}
