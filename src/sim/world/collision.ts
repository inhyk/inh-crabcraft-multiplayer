// Gameplay collision for a zone: 2D solids (circles and oriented boxes with a height range),
// walkable surfaces laid over the terrain (pier, bridge, gallery, wreck deck), and a blocked-cell
// grid for cliffs and deep water. All queries are analytic; nothing raycasts render meshes.
// Shared by the browser and the server: numbers only, no three.js.

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
export interface Vec2Out {
  set(x: number, y: number): this;
}

export interface Circle {
  x: number;
  z: number;
  r: number;
  y0: number;
  y1: number;
  /** Blocks line of sight only (raycastSolid), not movement. */
  los?: boolean;
}
export interface Box {
  x: number;
  z: number;
  hx: number;
  hz: number;
  c: number;
  s: number;
  y0: number;
  y1: number;
  los?: boolean;
}

/** The iron wreck's deck: a plane in the ship's frame plus the bow's sheer. */
export interface DeckHeight {
  kind: 'deck';
  /** Frame origin and the ship's local x and z axes in world x/z. */
  ox: number;
  oz: number;
  axx: number;
  axz: number;
  azx: number;
  azz: number;
  y0: number;
  sinPitch: number;
  sinRoll: number;
  cosPitch: number;
  halfL: number;
}
export type SurfaceSpec =
  | { kind: 'rect'; x: number; z: number; hx: number; hz: number; yaw: number; h0: number; gx: number; gz: number }
  | { kind: 'annulus'; x: number; z: number; r0: number; r1: number; h: number }
  | { kind: 'poly'; poly: [number, number][]; height: DeckHeight };

export interface Surface {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  contains(x: number, z: number): boolean;
  height(x: number, z: number): number;
  /** The constructor arguments, so a surface can be baked and rebuilt. */
  readonly spec: SurfaceSpec;
}

export type Shape = { kind: 0; c: Circle } | { kind: 1; b: Box };

const CELL = 8;
const key = (i: number, j: number) => (i + 2048) * 4096 + (j + 2048);

export interface CollisionTerrain {
  nx: number;
  nz: number;
  minX: number;
  minZ: number;
  step: number;
  h: Float32Array;
  heightAt(x: number, z: number): number;
}

export class Collision {
  readonly shapes: Shape[] = [];
  readonly surfaces: Surface[] = [];
  private hash = new Map<number, number[]>();
  private surfHash = new Map<number, number[]>();
  /** One byte per terrain cell: 1 = blocked (cliff or deep water). */
  blocked: Uint8Array;
  private bnx: number;

  constructor(readonly terrain: CollisionTerrain) {
    this.bnx = terrain.nx - 1;
    this.blocked = new Uint8Array((terrain.nx - 1) * (terrain.nz - 1));
  }

  addCircle(x: number, z: number, r: number, y0 = -50, y1 = 200, los = false): void {
    this.insert({ kind: 0, c: { x, z, r, y0, y1, los } }, x - r, z - r, x + r, z + r);
  }

  /** Oriented box: centre, half extents along its local x/z, yaw as in rotation.y. */
  addBox(x: number, z: number, hx: number, hz: number, yaw: number, y0 = -50, y1 = 200, los = false): void {
    this.addBoxCS(x, z, hx, hz, Math.cos(yaw), Math.sin(yaw), y0, y1, los);
  }

  /** Oriented box from the cosine and sine of its yaw (baked boxes keep these, not the yaw). */
  addBoxCS(x: number, z: number, hx: number, hz: number, c: number, s: number, y0 = -50, y1 = 200, los = false): void {
    const ex = Math.abs(c) * hx + Math.abs(s) * hz;
    const ez = Math.abs(s) * hx + Math.abs(c) * hz;
    this.insert({ kind: 1, b: { x, z, hx, hz, c, s, y0, y1, los } }, x - ex, z - ez, x + ex, z + ez);
  }

  /** Thin wall between two points. */
  addWall(ax: number, az: number, bx: number, bz: number, thick = 0.3, y0 = -50, y1 = 200): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    // rotation.y = yaw maps local +x to (cos, -sin); we want local x along (dx, dz).
    const yaw = Math.atan2(-dz, dx);
    this.addBox((ax + bx) / 2, (az + bz) / 2, len / 2, thick / 2, yaw, y0, y1);
  }

  addSurface(s: Surface): void {
    const idx = this.surfaces.length;
    this.surfaces.push(s);
    for (let i = Math.floor(s.minX / CELL); i <= Math.floor(s.maxX / CELL); i++)
      for (let j = Math.floor(s.minZ / CELL); j <= Math.floor(s.maxZ / CELL); j++) {
        const k = key(i, j);
        let l = this.surfHash.get(k);
        if (!l) this.surfHash.set(k, (l = []));
        l.push(idx);
      }
  }

  private insert(s: Shape, x0: number, z0: number, x1: number, z1: number): void {
    const idx = this.shapes.length;
    this.shapes.push(s);
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        const k = key(i, j);
        let l = this.hash.get(k);
        if (!l) this.hash.set(k, (l = []));
        l.push(idx);
      }
  }

  /** Mark steep or deep terrain cells as blocked; cells under walkable surfaces stay open. */
  buildBlocked(opts: { maxRise?: number; deep?: number; keepOpen?: (x: number, z: number) => boolean } = {}): void {
    const t = this.terrain;
    const maxRise = opts.maxRise ?? 1.15;
    const deep = opts.deep ?? -1.1;
    const nx = t.nx;
    for (let j = 0; j < t.nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i;
        const a = t.h[k];
        const b = t.h[k + 1];
        const c = t.h[k + nx];
        const d = t.h[k + nx + 1];
        const hi = Math.max(a, b, c, d);
        const lo = Math.min(a, b, c, d);
        let bl = hi - lo > maxRise || hi < deep ? 1 : 0;
        if (bl) {
          const x = t.minX + (i + 0.5) * t.step;
          const z = t.minZ + (j + 0.5) * t.step;
          if (this.surfaceAt(x, z) || opts.keepOpen?.(x, z)) bl = 0;
        }
        this.blocked[j * this.bnx + i] = bl;
      }
    }
  }

  surfaceAt(x: number, z: number): Surface | null {
    const l = this.surfHash.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return null;
    let best: Surface | null = null;
    let bestH = -Infinity;
    for (const i of l) {
      const s = this.surfaces[i];
      if (s.contains(x, z)) {
        const h = s.height(x, z);
        if (h > bestH) {
          bestH = h;
          best = s;
        }
      }
    }
    return best;
  }

  heightAt(x: number, z: number): number {
    const s = this.surfaceAt(x, z);
    if (s) return s.height(x, z);
    return this.terrain.heightAt(x, z);
  }

  isBlockedCell(x: number, z: number): boolean {
    const t = this.terrain;
    const i = Math.floor((x - t.minX) / t.step);
    const j = Math.floor((z - t.minZ) / t.step);
    if (i < 0 || j < 0 || i >= t.nx - 1 || j >= t.nz - 1) return true;
    return this.blocked[j * this.bnx + i] === 1;
  }

  resolve<T extends Vec2Out>(x: number, z: number, r: number, out: T): T {
    let px = x;
    let pz = z;
    const t = this.terrain;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      // Solids.
      for (const list of this.neighbours(px, pz, r)) {
        for (const si of list) {
          const s = this.shapes[si];
          if (s.kind === 0) {
            const c = s.c;
            if (c.los) continue;
            const dx = px - c.x;
            const dz = pz - c.z;
            const rr = c.r + r;
            const d2 = dx * dx + dz * dz;
            if (d2 < rr * rr) {
              const d = Math.sqrt(d2) || 1e-4;
              px = c.x + (dx / d) * rr;
              pz = c.z + (dz / d) * rr;
              moved = true;
            }
          } else {
            const b = s.b;
            if (b.los) continue;
            const dx = px - b.x;
            const dz = pz - b.z;
            const lx = b.c * dx - b.s * dz;
            const lz = b.s * dx + b.c * dz;
            const qx = Math.max(-b.hx, Math.min(b.hx, lx));
            const qz = Math.max(-b.hz, Math.min(b.hz, lz));
            const ox = lx - qx;
            const oz = lz - qz;
            const d2 = ox * ox + oz * oz;
            if (d2 < r * r) {
              let nlx: number;
              let nlz: number;
              if (d2 > 1e-8) {
                const d = Math.sqrt(d2);
                nlx = qx + (ox / d) * r;
                nlz = qz + (oz / d) * r;
              } else {
                // Centre inside the box: leave through the nearest face.
                const fx = b.hx - Math.abs(lx);
                const fz = b.hz - Math.abs(lz);
                if (fx < fz) {
                  nlx = Math.sign(lx || 1) * (b.hx + r);
                  nlz = lz;
                } else {
                  nlx = lx;
                  nlz = Math.sign(lz || 1) * (b.hz + r);
                }
              }
              // Back to world: inverse of the local transform.
              px = b.x + b.c * nlx + b.s * nlz;
              pz = b.z - b.s * nlx + b.c * nlz;
              moved = true;
            }
          }
        }
      }
      // Blocked terrain cells as unit boxes.
      const i0 = Math.floor((px - r - t.minX) / t.step);
      const i1 = Math.floor((px + r - t.minX) / t.step);
      const j0 = Math.floor((pz - r - t.minZ) / t.step);
      const j1 = Math.floor((pz + r - t.minZ) / t.step);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const outOfGrid = i < 0 || j < 0 || i >= t.nx - 1 || j >= t.nz - 1;
          if (!outOfGrid && this.blocked[j * this.bnx + i] !== 1) continue;
          const bx0 = t.minX + i * t.step;
          const bz0 = t.minZ + j * t.step;
          const cx = Math.max(bx0, Math.min(bx0 + t.step, px));
          const cz = Math.max(bz0, Math.min(bz0 + t.step, pz));
          const dx = px - cx;
          const dz = pz - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            px = cx + (dx / d) * r;
            pz = cz + (dz / d) * r;
          } else {
            const mx = bx0 + t.step / 2;
            const mz = bz0 + t.step / 2;
            if (Math.abs(px - mx) > Math.abs(pz - mz)) px = px > mx ? bx0 + t.step + r : bx0 - r;
            else pz = pz > mz ? bz0 + t.step + r : bz0 - r;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
    return out.set(px, pz);
  }

  private neighbours(x: number, z: number, r: number): number[][] {
    const res: number[][] = [];
    const i0 = Math.floor((x - r) / CELL);
    const i1 = Math.floor((x + r) / CELL);
    const j0 = Math.floor((z - r) / CELL);
    const j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const l = this.hash.get(key(i, j));
        if (l) res.push(l);
      }
    return res;
  }

  /** True if a point is inside a solid (respecting the solid's height range). */
  solidAt(x: number, y: number, z: number): boolean {
    const l = this.hash.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return false;
    for (const si of l) {
      const s = this.shapes[si];
      if (s.kind === 0) {
        const c = s.c;
        if (y < c.y0 || y > c.y1) continue;
        const dx = x - c.x;
        const dz = z - c.z;
        if (dx * dx + dz * dz < c.r * c.r) return true;
      } else {
        const b = s.b;
        if (y < b.y0 || y > b.y1) continue;
        const dx = x - b.x;
        const dz = z - b.z;
        const lx = b.c * dx - b.s * dz;
        const lz = b.s * dx + b.c * dz;
        if (Math.abs(lx) < b.hx && Math.abs(lz) < b.hz) return true;
      }
    }
    return false;
  }

  /** Distance along from->to to the first solid or ground hit, or null. */
  raycast(from: Vec3Like, to: Vec3Like): number | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-5) return null;
    const step = 0.35;
    const n = Math.ceil(len / step);
    for (let i = 1; i <= n; i++) {
      const t = Math.min(1, (i * step) / len);
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const z = from.z + dz * t;
      const surf = this.surfaceAt(x, z);
      const ground = this.terrain.heightAt(x, z);
      // Surfaces are thin decks: solid only within half a unit below their top.
      if (surf) {
        const sh = surf.height(x, z);
        if (y < sh && y > sh - 0.6) return t * len;
      }
      if (y < ground) return t * len;
      if (this.solidAt(x, y, z)) return t * len;
    }
    return null;
  }
}

/** Oriented rectangle with a planar height: h = h0 + gx * localX + gz * localZ. */
export function rectSurface(x: number, z: number, hx: number, hz: number, yaw: number, h0: number, gx = 0, gz = 0): Surface {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ex = Math.abs(c) * hx + Math.abs(s) * hz;
  const ez = Math.abs(s) * hx + Math.abs(c) * hz;
  const local = (px: number, pz: number): [number, number] => {
    const dx = px - x;
    const dz = pz - z;
    return [c * dx - s * dz, s * dx + c * dz];
  };
  return {
    minX: x - ex,
    maxX: x + ex,
    minZ: z - ez,
    maxZ: z + ez,
    contains(px, pz) {
      const [lx, lz] = local(px, pz);
      return Math.abs(lx) <= hx && Math.abs(lz) <= hz;
    },
    height(px, pz) {
      const [lx, lz] = local(px, pz);
      return h0 + gx * lx + gz * lz;
    },
    spec: { kind: 'rect', x, z, hx, hz, yaw, h0, gx, gz },
  };
}

export function annulusSurface(x: number, z: number, r0: number, r1: number, h: number): Surface {
  return {
    minX: x - r1,
    maxX: x + r1,
    minZ: z - r1,
    maxZ: z + r1,
    contains(px, pz) {
      const d = Math.hypot(px - x, pz - z);
      return d >= r0 && d <= r1;
    },
    height: () => h,
    spec: { kind: 'annulus', x, z, r0, r1, h },
  };
}

/** The bow's sheer: the deck rises toward the stem. */
export const deckSheer = (x: number, halfL: number) => Math.pow(Math.max(0, x / halfL - 0.45) * 1.8, 2) * 2.2;

export function deckHeight(d: DeckHeight, x: number, z: number): number {
  const dx = x - d.ox;
  const dz = z - d.oz;
  const lx = dx * d.axx + dz * d.axz;
  const lz = dx * d.azx + dz * d.azz;
  return d.y0 + lx * d.sinPitch - lz * d.sinRoll * d.cosPitch + deckSheer(lx, d.halfL);
}

/** Convex or concave polygon (world x/z) with a deck height. */
export function polySurface(poly: [number, number][], deck: DeckHeight): Surface {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return {
    minX,
    minZ,
    maxX,
    maxZ,
    contains(px, pz) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, az] = poly[j];
        const [bx, bz] = poly[i];
        if (az > pz !== bz > pz && px < ((ax - bx) * (pz - bz)) / (az - bz) + bx) inside = !inside;
      }
      return inside;
    },
    height: (px, pz) => deckHeight(deck, px, pz),
    spec: { kind: 'poly', poly, height: deck },
  };
}

export function surfaceFromSpec(s: SurfaceSpec): Surface {
  if (s.kind === 'rect') return rectSurface(s.x, s.z, s.hx, s.hz, s.yaw, s.h0, s.gx, s.gz);
  if (s.kind === 'annulus') return annulusSurface(s.x, s.z, s.r0, s.r1, s.h);
  return polySurface(s.poly, s.height);
}
