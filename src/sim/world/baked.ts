// Baked collision: a world's colliders as plain numbers (public/world/collision-w*.json), written by
// tools/bake-collision.mjs and loaded here by the server and the browser alike. Loading rebuilds the
// same Collision the browser builds from its layout, so queries agree to the last bit.
import { Collision, type Shape, type SurfaceSpec, surfaceFromSpec, type Vec2Out, type Vec3Like } from './collision';
import { dawnHeight, gridHeight, STAR_GRID, starSurfaceHeight } from './ground';
import { type IslandBounds, type PushCircle, resolveOnIsland } from './queries';

export type WorldId = 'w1' | 'w2' | 'w3';

/** Ground height: World I's terrain triangles, World II's height samples, World III's formula. */
export type BakedGround =
  | { kind: 'grid'; minX: number; minZ: number; step: number; nx: number; nz: number; h: string }
  | { kind: 'star'; h: string }
  | { kind: 'dawn' };

export interface BakedCollision {
  format: 'crabcraft-collision';
  version: 1;
  world: WorldId;
  /** sha256 of every source file the bake read; tests compare it with the files on disk. */
  source: string;
  ground: BakedGround;
  /** 'collision': surfaces (pier, bridge, deck) over the ground; 'ground': the ground alone. */
  heightAt: 'collision' | 'ground';
  /** Cell grid of the blocked mask (null: no cell blocked); cells outside the grid block movement. */
  cells: { minX: number; minZ: number; step: number; nx: number; nz: number; blocked: string | null };
  /** The island shore (World II, III) and circles pushed out before the solids (World II). */
  bounds: IslandBounds | null;
  push: [number, number, number][];
  /** Circles [0, x, z, r, y0, y1, los] and boxes [1, x, z, hx, hz, cos, sin, y0, y1, los], in registration order. */
  shapes: number[][];
  surfaces: SurfaceSpec[];
}

export interface BakedWorld {
  readonly collision: Collision;
  heightAt(x: number, z: number): number;
  resolveCollision<T extends Vec2Out>(x: number, z: number, r: number, out: T): T;
  raycastSolid(from: Vec3Like, to: Vec3Like): number | null;
}

// Base64 without Buffer or atob, so the same code runs in Node and the browser.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}
export function base64ToBytes(s: string): Uint8Array {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  const v = (c: number) => (c > 96 ? c - 71 : c > 64 ? c - 65 : c > 47 ? c + 4 : c === 43 ? 62 : 63);
  for (let i = 0, o = 0; i < s.length; i += 4) {
    const n = (v(s.charCodeAt(i)) << 18) | (v(s.charCodeAt(i + 1)) << 12) | (v(s.charCodeAt(i + 2)) << 6) | v(s.charCodeAt(i + 3));
    out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
/** Float32 values, little-endian. */
export function floatsToBase64(f: Float32Array): string {
  const b = new Uint8Array(f.length * 4);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < f.length; i++) dv.setFloat32(i * 4, f[i], true);
  return bytesToBase64(b);
}
export function base64ToFloats(s: string): Float32Array {
  const b = base64ToBytes(s);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const f = new Float32Array(b.length / 4);
  for (let i = 0; i < f.length; i++) f[i] = dv.getFloat32(i * 4, true);
  return f;
}
/** One bit per cell, low bit first. */
export function bitsToBase64(cells: Uint8Array): string {
  const b = new Uint8Array(Math.ceil(cells.length / 8));
  for (let i = 0; i < cells.length; i++) if (cells[i]) b[i >> 3] |= 1 << (i & 7);
  return bytesToBase64(b);
}
export function base64ToBits(s: string, n: number): Uint8Array {
  const b = base64ToBytes(s);
  const cells = new Uint8Array(n);
  for (let i = 0; i < n; i++) cells[i] = (b[i >> 3] >> (i & 7)) & 1;
  return cells;
}

export interface BakeOptions {
  world: WorldId;
  source: string;
  ground: { kind: 'grid'; minX: number; minZ: number; step: number; nx: number; nz: number; h: Float32Array } | { kind: 'star'; h: Float32Array } | { kind: 'dawn' };
  heightAt: 'collision' | 'ground';
  bounds?: IslandBounds | null;
  push?: readonly PushCircle[];
}

export function bakeCollision(col: Collision, o: BakeOptions): BakedCollision {
  const t = col.terrain;
  const g = o.ground;
  return {
    format: 'crabcraft-collision',
    version: 1,
    world: o.world,
    source: o.source,
    ground: g.kind === 'grid' ? { ...g, h: floatsToBase64(g.h) } : g.kind === 'star' ? { kind: 'star', h: floatsToBase64(g.h) } : { kind: 'dawn' },
    heightAt: o.heightAt,
    cells: { minX: t.minX, minZ: t.minZ, step: t.step, nx: t.nx, nz: t.nz, blocked: col.blocked.some((b) => b) ? bitsToBase64(col.blocked) : null },
    bounds: o.bounds ?? null,
    push: (o.push ?? []).map((p) => [p.x, p.z, p.r]),
    shapes: col.shapes.map((s: Shape) =>
      s.kind === 0 ? [0, s.c.x, s.c.z, s.c.r, s.c.y0, s.c.y1, s.c.los ? 1 : 0] : [1, s.b.x, s.b.z, s.b.hx, s.b.hz, s.b.c, s.b.s, s.b.y0, s.b.y1, s.b.los ? 1 : 0],
    ),
    surfaces: col.surfaces.map((s) => s.spec),
  };
}

export function groundOf(g: BakedGround): (x: number, z: number) => number {
  if (g.kind === 'grid') {
    const grid = { minX: g.minX, minZ: g.minZ, step: g.step, nx: g.nx, nz: g.nz, h: base64ToFloats(g.h) };
    return (x, z) => gridHeight(grid, x, z);
  }
  if (g.kind === 'star') {
    const h = base64ToFloats(g.h);
    if (h.length !== STAR_GRID.nx * STAR_GRID.nz) throw new Error('baked World II heights have the wrong size');
    return (x, z) => starSurfaceHeight(h, x, z);
  }
  return dawnHeight;
}

export function loadBakedWorld(data: BakedCollision): BakedWorld {
  if (data.format !== 'crabcraft-collision' || data.version !== 1) throw new Error(`unknown collision bake ${data.format} v${data.version}`);
  const ground = groundOf(data.ground);
  const c = data.cells;
  const collision = new Collision({ minX: c.minX, minZ: c.minZ, step: c.step, nx: c.nx, nz: c.nz, h: new Float32Array(0), heightAt: ground });
  if (c.blocked) collision.blocked = base64ToBits(c.blocked, (c.nx - 1) * (c.nz - 1));
  for (const s of data.shapes) {
    if (s[0] === 0) collision.addCircle(s[1], s[2], s[3], s[4], s[5], s[6] === 1);
    else collision.addBoxCS(s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9] === 1);
  }
  for (const spec of data.surfaces) collision.addSurface(surfaceFromSpec(spec));
  const bounds = data.bounds;
  const push = data.push.map(([x, z, r]) => ({ x, z, r }));
  return {
    collision,
    heightAt: data.heightAt === 'collision' ? (x, z) => collision.heightAt(x, z) : ground,
    resolveCollision: (x, z, r, out) => (bounds ? resolveOnIsland(collision, bounds, push, x, z, r, out) : collision.resolve(x, z, r, out)),
    raycastSolid: (from, to) => collision.raycast(from, to),
  };
}
