// Entry for tools/bake-collision.mjs (bundled for Node): every world's colliders from their layout
// functions, the same calls the browser makes, baked to numbers for the server.
import type { Vec2Out, Vec3Like } from '../sim/world/collision';
import { type BakedCollision, bakeCollision } from '../sim/world/baked';
import { STAR_GRID, starSurfaceHeight } from '../sim/world/ground';
import { DAWN_BOUNDS, resolveOnIsland, STAR_BOUNDS } from '../sim/world/queries';
import { layoutClawhaven } from '../world/colliders';
import { Terrain } from '../world/terrain';
import { layoutStarhaven } from './world2Colliders';
import { buildStarHeights } from './world2Height';
import { layoutDawnreach } from './world3Colliders';

/**
 * The three worlds' collisions with the queries the browser puts on top of them (World II and III
 * keep everyone inside the shore). natureNames: the piece names of models/world/nature.glb.
 */
export function layoutWorlds(natureNames: readonly string[], quality: 'low' | 'high' = 'high') {
  const terrain = new Terrain();
  const w1 = layoutClawhaven(terrain, quality).col;
  const starHeights = buildStarHeights();
  if (starHeights.length !== STAR_GRID.nx * STAR_GRID.nz) throw new Error('World II heights changed size');
  const starHeight = (x: number, z: number) => starSurfaceHeight(starHeights, x, z);
  const w2 = layoutStarhaven(starHeight, natureNames);
  const w3 = layoutDawnreach();
  const ray = (col: typeof w1) => (from: Vec3Like, to: Vec3Like) => col.raycast(from, to);
  return {
    w1: {
      col: w1,
      ground: { kind: 'grid' as const, minX: terrain.minX, minZ: terrain.minZ, step: terrain.step, nx: terrain.nx, nz: terrain.nz, h: terrain.h },
      heightAt: (x: number, z: number) => w1.heightAt(x, z),
      resolveCollision: <T extends Vec2Out>(x: number, z: number, r: number, out: T) => w1.resolve(x, z, r, out),
      raycastSolid: ray(w1),
    },
    w2: {
      col: w2.col,
      ground: { kind: 'star' as const, h: starHeights },
      obstacles: w2.obstacles,
      heightAt: starHeight,
      resolveCollision: <T extends Vec2Out>(x: number, z: number, r: number, out: T) => resolveOnIsland(w2.col, STAR_BOUNDS, w2.obstacles, x, z, r, out),
      raycastSolid: ray(w2.col),
    },
    w3: {
      col: w3,
      ground: { kind: 'dawn' as const },
      heightAt: (x: number, z: number) => w3.terrain.heightAt(x, z),
      resolveCollision: <T extends Vec2Out>(x: number, z: number, r: number, out: T) => resolveOnIsland(w3, DAWN_BOUNDS, [], x, z, r, out),
      raycastSolid: ray(w3),
    },
  };
}

export function bakeWorlds(natureNames: readonly string[], source: string, quality: 'low' | 'high' = 'high'): Record<'w1' | 'w2' | 'w3', BakedCollision> {
  const l = layoutWorlds(natureNames, quality);
  return {
    w1: bakeCollision(l.w1.col, { world: 'w1', source, heightAt: 'collision', ground: l.w1.ground }),
    w2: bakeCollision(l.w2.col, { world: 'w2', source, heightAt: 'ground', ground: l.w2.ground, bounds: STAR_BOUNDS, push: l.w2.obstacles }),
    w3: bakeCollision(l.w3.col, { world: 'w3', source, heightAt: 'ground', ground: l.w3.ground, bounds: DAWN_BOUNDS }),
  };
}
