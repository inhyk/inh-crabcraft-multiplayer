// Heightfield terrain: shaped from the layout (coast, headland, hills, plazas, lots, roads),
// rendered as one mesh with a splat-painted stylised material (grass, sand, dirt, cobble, rock).
import * as THREE from 'three';
import {voyageDistance,islandHeight} from './voyage';
import { gridHeight } from '../sim/world/ground';
import { clamp, lerp, Simplex, smoothstep } from './noise';
import {
  COAST,
  GRID,
  GROVE,
  HEADLAND,
  HEADLAND_H,
  LIGHTHOUSE,
  LOTS,
  PLAZAS,
  ROADS,
  TOWN_H,
  type V2,
} from './layout';

/** Signed distance to a closed polygon, positive inside. */
export function polySignedDist(x: number, z: number, poly: readonly V2[]): number {
  let d2 = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j];
    const [bx, bz] = poly[i];
    if (az > z !== bz > z && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
    const ex = bx - ax;
    const ez = bz - az;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
    const dx = x - (ax + ex * t);
    const dz = z - (az + ez * t);
    const dd = dx * dx + dz * dz;
    if (dd < d2) d2 = dd;
  }
  const d = Math.sqrt(d2);
  return inside ? d : -d;
}

/** Distance to a polyline and the arc-length parameter of the closest point. */
export function polylineDist(x: number, z: number, pts: readonly V2[], out: { d: number; s: number; t: number; seg: number }): void {
  let best = Infinity;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const len = Math.sqrt(len2);
    const t = clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1);
    const dx = x - (ax + ex * t);
    const dz = z - (az + ez * t);
    const dd = dx * dx + dz * dz;
    if (dd < best) {
      best = dd;
      out.s = acc + t * len;
      out.t = t;
      out.seg = i;
    }
    acc += len;
  }
  out.d = Math.sqrt(best);
}

function boxDist(x: number, z: number, cx: number, cz: number, yaw: number, hx: number, hz: number): number {
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Inverse of rotation.y = yaw: local x = c*dx - s*dz, local z = s*dx + c*dz.
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  const qx = Math.abs(lx) - hx;
  const qz = Math.abs(lz) - hz;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}

export class Terrain {
  readonly nx: number;
  readonly nz: number;
  readonly step = GRID.step;
  readonly minX = GRID.minX;
  readonly minZ = GRID.minZ;
  readonly sizeX = GRID.maxX - GRID.minX;
  readonly sizeZ = GRID.maxZ - GRID.minZ;
  /** Final heights, row-major (z rows, x columns). */
  readonly h: Float32Array;
  /** Signed distance to the coast (+ inland). */
  readonly coast: Float32Array;
  /** RGBA splat: R sand, G cobble, B dirt, A painted rock. */
  readonly splat: Uint8Array;
  private readonly noise = new Simplex(7);

  constructor() {
    this.nx = Math.round(this.sizeX / this.step) + 1;
    this.nz = Math.round(this.sizeZ / this.step) + 1;
    const n = this.nx * this.nz;
    this.h = new Float32Array(n);
    this.coast = new Float32Array(n);
    this.splat = new Uint8Array(n * 4);
    this.shape();
  }

  /** Natural land before plazas, lots and roads. */
  private natural(x: number, z: number, d: number): number {
    const island=islandHeight(x,z);if(island!==null)return island;
    const N = this.noise;
    let h: number;
    if (d < 0) {
      const u = -d;
      h = Math.max(-18, -0.12 * u - 0.0016 * u * u);
    } else {
      h = d < 12 ? 0.11 * d : 1.32 + (TOWN_H - 1.32) * smoothstep(12, 55, d);
      // Dunes on the upper beach.
      h += 0.55 * (N.fbm(x * 0.06, z * 0.06, 3) * 0.5 + 0.5) * smoothstep(5, 12, d) * (1 - smoothstep(16, 34, d));
    }
    const land = smoothstep(-2, 24, d);
    // Pine hills to the west, low hills north and south, a mountain rim far inland.
    const west = Math.pow(smoothstep(-48, -170, x), 1.25);
    h += land * west * 24 * (0.65 + 0.35 * N.fbm(x / 70, z / 70, 3));
    const north = smoothstep(-62, -180, z) * (1 - smoothstep(80, 125, x));
    h += land * north * 15 * (0.7 + 0.3 * N.fbm(x / 50 + 9, z / 50, 3));
    const south = smoothstep(62, 175, z) * (1 - smoothstep(95, 135, x));
    h += land * south * 8 * (0.7 + 0.3 * N.fbm(x / 55, z / 55 + 4, 3));
    const rim = smoothstep(160, 240, Math.hypot((x - 20) * 1.0, z * 1.05));
    h += land * rim * 30 * (0.6 + 0.4 * N.fbm(x / 40, z / 40 + 20, 4));
    // Gentle rolling detail.
    h += land * 0.45 * N.fbm(x / 16, z / 16, 3);

    // Saltmere headland: plateau with sea cliffs and steep landward flanks.
    const hd = polySignedDist(x, z, HEADLAND);
    const m = smoothstep(-11, 1, hd);
    if (m > 0) {
      const plateau = HEADLAND_H + 1.2 * N.fbm(x / 22, z / 22, 3);
      let hh = lerp(h, plateau, m);
      if (d > -40) {
        // Cliff face down to the sea where the headland meets the coast.
        const cliff = -3 + (HEADLAND_H + 3) * smoothstep(0.5, 4.5, d + 1.2 * N.noise(x * 0.2, z * 0.2));
        hh = lerp(hh, Math.min(hh, cliff), m);
      }
      if (d < 0) hh = lerp(hh, Math.max(-18, -3 - 0.45 * -d), m);
      h = hh;
    }
    // Sea stack under the lighthouse.
    const rs = Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z);
    const R = LIGHTHOUSE.stackRadius;
    const stack = 1 - smoothstep(R - 2.6, R + 1.2, rs + 1.4 * N.noise(x * 0.25, z * 0.25));
    if (stack > 0) h = lerp(h, LIGHTHOUSE.stackTop + 0.3 * N.noise(x * 0.4, z * 0.4) - 0.6 * smoothstep(0, R, rs), stack);
    return h;
  }

  private shape(): void {
    const { nx, nz, step, minX, minZ } = this;
    const { h, coast, splat } = this;
    const N = this.noise;

    // 1. Coast distance and natural land.
    for (let j = 0; j < nz; j++) {
      const z = minZ + j * step;
      for (let i = 0; i < nx; i++) {
        const x = minX + i * step;
        const k = j * nx + i;
        const d = Math.max(polySignedDist(x, z, COAST),voyageDistance(x,z));
        coast[k] = d;
        h[k] = this.natural(x, z, d);
      }
    }
    const sample = (x: number, z: number): number => {
      const fi = clamp((x - minX) / step, 0, nx - 1.001);
      const fj = clamp((z - minZ) / step, 0, nz - 1.001);
      const i = Math.floor(fi);
      const j = Math.floor(fj);
      const u = fi - i;
      const v = fj - j;
      const k = j * nx + i;
      return lerp(lerp(h[k], h[k + 1], u), lerp(h[k + nx], h[k + nx + 1], u), v);
    };

    // 2. Lots without a fixed height take the natural height at their centre.
    for (const lot of LOTS) if (Number.isNaN(lot.h)) lot.h = Math.max(0.6, sample(lot.x, lot.z));

    // Helper: run fn over grid vertices inside a bounding box.
    const each = (x0: number, z0: number, x1: number, z1: number, fn: (k: number, x: number, z: number) => void) => {
      const i0 = Math.max(0, Math.floor((x0 - minX) / step));
      const i1 = Math.min(nx - 1, Math.ceil((x1 - minX) / step));
      const j0 = Math.max(0, Math.floor((z0 - minZ) / step));
      const j1 = Math.min(nz - 1, Math.ceil((z1 - minZ) / step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * nx + i, minX + i * step, minZ + j * step);
    };
    const paint = (k: number, ch: number, w: number) => {
      const v = Math.round(clamp(w, 0, 1) * 255);
      if (v > splat[k * 4 + ch]) splat[k * 4 + ch] = v;
    };

    // 3. Plazas.
    for (const p of PLAZAS) {
      each(p.x - p.r - 8, p.z - p.r - 8, p.x + p.r + 8, p.z + p.r + 8, (k, x, z) => {
        const r = Math.hypot(x - p.x, z - p.z);
        h[k] = lerp(h[k], p.h, 1 - smoothstep(p.r, p.r + 7, r));
        paint(k, 1, 1 - smoothstep(p.r - 1.5, p.r + 0.5, r));
      });
    }
    // 4. Building lots: flatten the footprint plus a yard.
    for (const lot of LOTS) {
      const hx = lot.sx + 1.5;
      const hz = lot.sz + 1.5;
      const ext = Math.max(hx, hz) + 9;
      each(lot.x - ext, lot.z - ext, lot.x + ext, lot.z + ext, (k, x, z) => {
        const bd = boxDist(x, z, lot.x, lot.z, lot.yaw, hx, hz);
        h[k] = lerp(h[k], lot.h, 1 - smoothstep(0, 6, bd));
        if (lot.kind === 'forge' || lot.kind === 'hut' || lot.kind === 'cottage') paint(k, 2, 1 - smoothstep(0, 3.5, bd - 1));
      });
    }
    // 5. Moonpool Grove: a terrace with a sunken pool.
    each(GROVE.x - GROVE.r - 10, GROVE.z - GROVE.r - 10, GROVE.x + GROVE.r + 10, GROVE.z + GROVE.r + 10, (k, x, z) => {
      const r = Math.hypot(x - GROVE.x, z - GROVE.z);
      h[k] = lerp(h[k], GROVE.h, 1 - smoothstep(GROVE.r - 3, GROVE.r + 8, r));
      const pr = GROVE.poolR + 0.8;
      if (r < pr + 1) h[k] = Math.min(h[k], GROVE.h - 1.4 * (1 - smoothstep(0, pr, r)) + 0.15 * smoothstep(pr - 1, pr + 1, r));
      paint(k, 3, (1 - smoothstep(pr - 0.4, pr + 1.4, r)) * smoothstep(pr - 2.5, pr - 0.8, r));
    });
    // 6. Roads: follow the land (or explicit heights), cut and fill the shoulders.
    const q = { d: 0, s: 0, t: 0, seg: 0 };
    for (const road of ROADS) {
      const pts = road.points;
      const half = road.width / 2;
      const shoulder = road.heights ? 4.5 : 3;
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (const [px, pz] of pts) {
        x0 = Math.min(x0, px);
        z0 = Math.min(z0, pz);
        x1 = Math.max(x1, px);
        z1 = Math.max(z1, pz);
      }
      const m = half + shoulder + 2;
      // Centre-line heights for land-following roads are sampled once, before carving.
      const centre = pts.map(([px, pz]) => sample(px, pz));
      each(x0 - m, z0 - m, x1 + m, z1 + m, (k, x, z) => {
        polylineDist(x, z, pts, q);
        if (q.d > half + shoulder) return;
        const target = road.heights
          ? lerp(road.heights[q.seg], road.heights[q.seg + 1], q.t)
          : lerp(centre[q.seg], centre[q.seg + 1], q.t) - 0.05;
        const w = 1 - smoothstep(half, half + shoulder, q.d);
        h[k] = lerp(h[k], target, w);
        const edge = 1 - smoothstep(half - 0.8, half + 0.6, q.d);
        paint(k, road.kind === 'cobble' ? 1 : road.kind === 'dirt' ? 2 : 0, edge);
      });
    }
    // 7. Splat: beaches, rocky headland, sea floor.
    for (let j = 0; j < nz; j++) {
      const z = minZ + j * step;
      for (let i = 0; i < nx; i++) {
        const x = minX + i * step;
        const k = j * nx + i;
        const d = coast[k];
        const n = N.fbm(x * 0.05, z * 0.05, 2);
        if (h[k] < 3.4 + n) paint(k, 0, (1 - smoothstep(12 + 4 * n, 17 + 4 * n, d)) * (1 - smoothstep(2.4 + n, 3.4 + n, h[k])));
        if (h[k] < 0.4) paint(k, 0, 1);
        const rs = Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z);
        if (rs < LIGHTHOUSE.stackRadius + 3) paint(k, 3, 1 - smoothstep(LIGHTHOUSE.stackRadius - 1, LIGHTHOUSE.stackRadius + 2, rs));
      }
    }
  }

  /** Exact height of the rendered triangle mesh at x,z. */
  heightAt(x: number, z: number): number {
    return gridHeight(this, x, z);
  }

  /** Coast distance (bilinear). */
  coastAt(x: number, z: number): number {
    const fi = clamp((x - this.minX) / this.step, 0, this.nx - 1.001);
    const fj = clamp((z - this.minZ) / this.step, 0, this.nz - 1.001);
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const k = j * this.nx + i;
    const u = fi - i;
    const v = fj - j;
    const c = this.coast;
    return lerp(lerp(c[k], c[k + 1], u), lerp(c[k + this.nx], c[k + this.nx + 1], u), v);
  }

  /** Splat weight 0..1 of a channel (0 sand, 1 cobble, 2 dirt, 3 rock) at the nearest vertex. */
  splatAt(x: number, z: number, ch: number): number {
    const i = clamp(Math.round((x - this.minX) / this.step), 0, this.nx - 1);
    const j = clamp(Math.round((z - this.minZ) / this.step), 0, this.nz - 1);
    return this.splat[(j * this.nx + i) * 4 + ch] / 255;
  }

  /** Upward normal y-component (1 flat, 0 vertical) from central differences. */
  slopeAt(x: number, z: number): number {
    const e = this.step;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return 2 * e / Math.sqrt(dx * dx + dz * dz + 4 * e * e);
  }

  buildMesh(material: THREE.Material): THREE.Mesh {
    const { nx, nz, step, minX, minZ, h } = this;
    const pos = new Float32Array(nx * nz * 3);
    const nor = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[k * 3] = minX + i * step;
        pos[k * 3 + 1] = h[k];
        pos[k * 3 + 2] = minZ + j * step;
        const hl = h[j * nx + Math.max(0, i - 1)];
        const hr = h[j * nx + Math.min(nx - 1, i + 1)];
        const hd = h[Math.max(0, j - 1) * nx + i];
        const hu = h[Math.min(nz - 1, j + 1) * nx + i];
        const ax = hl - hr;
        const az = hd - hu;
        const l = Math.sqrt(ax * ax + 4 * step * step + az * az);
        nor[k * 3] = ax / l;
        nor[k * 3 + 1] = (2 * step) / l;
        nor[k * 3 + 2] = az / l;
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let p = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        // (a, c, b) and (b, c, d): diagonal b-c, counter-clockwise seen from above.
        idx[p++] = a;
        idx[p++] = c;
        idx[p++] = b;
        idx[p++] = b;
        idx[p++] = c;
        idx[p++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  splatTexture(): THREE.DataTexture {
    const t = new THREE.DataTexture(this.splat, this.nx, this.nz, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  /** Heights as a half-float texture for the water shader (depth tint and shore foam). */
  heightTexture(extra?: (x: number, z: number, h: number) => number): THREE.DataTexture {
    const data = new Uint16Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i;
        let hv = this.h[k];
        if (extra) hv = extra(this.minX + i * this.step, this.minZ + j * this.step, hv);
        data[k] = THREE.DataUtils.toHalfFloat(hv);
      }
    }
    const t = new THREE.DataTexture(data, this.nx, this.nz, THREE.RedFormat, THREE.HalfFloatType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }
}

export interface TerrainTextures {
  cobble: THREE.Texture | null;
  cobbleNormal: THREE.Texture | null;
  rock: THREE.Texture | null;
}

let sharedNoise: THREE.DataTexture | null = null;
/** Tiling RGBA noise (seamless: simplex sampled on circles), shared by terrain, sky and water. */
export function noiseTexture(size = 256): THREE.DataTexture {
  if (sharedNoise && sharedNoise.image.width === size) return sharedNoise;
  const S = new Simplex(11);
  const data = new Uint8Array(size * size * 4);
  const tau = Math.PI * 2;
  // Seamless: sample 2D simplex on two circles (torus mapping), summing octaves of different radii.
  const torus = (u: number, v: number, freq: number, off: number) => {
    const a = u * tau;
    const b = v * tau;
    const r = freq / tau;
    return (S.noise(Math.cos(a) * r + off, Math.sin(a) * r) + S.noise(Math.cos(b) * r, Math.sin(b) * r + off)) * 0.5;
  };
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      const f = (fr: number, oct: number, off: number) => {
        let s = 0;
        let a = 0.5;
        let n = 0;
        for (let o = 0; o < oct; o++) {
          s += a * torus(u, v, fr * Math.pow(2, o), off + o * 13.1);
          n += a;
          a *= 0.5;
        }
        return s / n;
      };
      const k = (j * size + i) * 4;
      data[k] = Math.round(clamp(f(3, 4, 1) * 0.5 + 0.5, 0, 1) * 255);
      data[k + 1] = Math.round(clamp(f(9, 3, 7) * 0.5 + 0.5, 0, 1) * 255);
      data[k + 2] = Math.round(clamp(f(40, 2, 19) * 0.5 + 0.5, 0, 1) * 255);
      data[k + 3] = Math.round(clamp(f(5, 3, 29) * 0.5 + 0.5, 0, 1) * 255);
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  sharedNoise = t;
  return t;
}

/** Stylised splat material on top of MeshStandardMaterial (keeps lights, shadows and fog). */
export function createTerrainMaterial(terrain: Terrain, tex: TerrainTextures, uniforms: { uTime: { value: number } }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.needsUpdate = true;
  const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  flat.needsUpdate = true;
  for (const t of [tex.cobble, tex.cobbleNormal, tex.rock]) {
    if (!t) continue;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
  const u = {
    uSplat: { value: terrain.splatTexture() },
    uOrigin: { value: new THREE.Vector2(terrain.minX, terrain.minZ) },
    uSize: { value: new THREE.Vector2(terrain.sizeX, terrain.sizeZ) },
    uCobble: { value: tex.cobble ?? white },
    uCobbleN: { value: tex.cobbleNormal ?? flat },
    uRock: { value: tex.rock ?? white },
    uTime: uniforms.uTime,
    uNoise: { value: noiseTexture() },
  };
  // These textures belong to this terrain material; the kit maps/noise are shared caches.
  mat.addEventListener('dispose',()=>{
    u.uSplat.value.dispose();white.dispose();flat.dispose();
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCcWorld;\nvarying vec3 vCcNormalW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCcWorld = position;\nvCcNormalW = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCcWorld;
varying vec3 vCcNormalW;
uniform sampler2D uSplat;
uniform sampler2D uCobble;
uniform sampler2D uCobbleN;
uniform sampler2D uRock;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform float uTime;
uniform sampler2D uNoise;
vec3 cc_srgb(vec3 c) { return pow(c, vec3(2.2)); }
vec3 cc_tri(sampler2D t, vec3 p, vec3 n, float s) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z);
  return texture2D(t, p.zy * s).rgb * w.x + texture2D(t, p.xz * s).rgb * w.y + texture2D(t, p.xy * s).rgb * w.z;
}
float ccRock;
float ccCob;
float ccSandWet;`,
      )
      .replace(
        '#include <map_fragment>',
        `
vec2 ccXZ = vCcWorld.xz;
vec4 sp = texture2D(uSplat, (ccXZ - uOrigin) / uSize);
// One tiling noise texture replaces procedural fbm: r = broad fbm, g = medium, b = fine, a = patches.
vec4 nzA = texture2D(uNoise, ccXZ * (0.11 / 9.0));
vec4 nzB = texture2D(uNoise, ccXZ * (1.7 / 40.0) + 0.37);
float n1 = nzA.g;
float n2 = nzB.b;
float n3 = texture2D(uNoise, ccXZ * (0.023 / 3.0) + 0.71).r;
vec3 nW = normalize(vCcNormalW);
float slope = 1.0 - nW.y;
float sand = smoothstep(0.32, 0.62, sp.r + (n1 - 0.5) * 0.55);
ccCob = smoothstep(0.42, 0.58, sp.g + (n2 - 0.5) * 0.28 + (n1 - 0.5) * 0.2);
float dirt = smoothstep(0.3, 0.6, sp.b + (n1 - 0.5) * 0.6);
ccRock = max(smoothstep(0.30, 0.42, slope + (n1 - 0.5) * 0.18), smoothstep(0.35, 0.6, sp.a + (n2 - 0.5) * 0.3));
// Grass: warm painterly greens with dry patches.
vec3 gA = cc_srgb(vec3(0.24, 0.47, 0.11));
vec3 gB = cc_srgb(vec3(0.46, 0.64, 0.16));
vec3 gDry = cc_srgb(vec3(0.66, 0.60, 0.28));
vec3 grass = mix(gA, gB, smoothstep(0.25, 0.75, nzA.r));
grass = mix(grass, gDry, smoothstep(0.5, 0.78, n3) * 0.65);
grass *= 0.82 + 0.32 * n2;
// Sand: pale warm, darker and glossier when wet.
vec3 sandC = mix(cc_srgb(vec3(0.80, 0.63, 0.40)), cc_srgb(vec3(0.88, 0.74, 0.50)), n1);
sandC *= 0.92 + 0.1 * sin(dot(ccXZ, vec2(0.9, 0.35)) * 3.0 + n1 * 6.0);
ccSandWet = 1.0 - smoothstep(0.05, 0.75, vCcWorld.y);
sandC = mix(sandC, sandC * vec3(0.62, 0.58, 0.55), ccSandWet);
vec3 dirtC = cc_srgb(vec3(0.55, 0.40, 0.25)) * (0.82 + 0.3 * n2);
vec3 col = grass;
col = mix(col, dirtC, dirt);
col = mix(col, sandC, sand);
if (ccCob > 0.003) {
  vec3 cobC = texture2D(uCobble, ccXZ * 0.22).rgb * cc_srgb(vec3(1.08, 0.94, 0.80));
  col = mix(col, cobC, ccCob);
}
if (ccRock > 0.003) {
  vec3 rockC = cc_tri(uRock, vCcWorld, nW, 0.16) * 0.8 + texture2D(uRock, vCcWorld.xz * 0.045 + vCcWorld.y * 0.03).rgb * 0.35;
  // Layered sandstone: warm bands, darker seams, vertical cracks.
  float band = sin(vCcWorld.y * 1.35 + n1 * 2.5 + n3 * 4.0);
  float strata = 0.78 + 0.22 * smoothstep(-0.6, 0.6, band);
  float seam = smoothstep(0.92, 0.99, abs(sin(vCcWorld.y * 0.9 + n1 * 1.5)));
  float crack = smoothstep(0.62, 0.7, texture2D(uNoise, vec2(dot(vCcWorld.xz, vec2(0.7, 0.7)) * 0.05, vCcWorld.y * 0.004)).b);
  vec3 stone = mix(cc_srgb(vec3(0.66, 0.52, 0.40)), cc_srgb(vec3(0.55, 0.47, 0.42)), n2);
  rockC = mix(rockC, stone * strata, 0.55);
  rockC *= 1.0 - 0.35 * seam - 0.3 * crack;
  col = mix(col, rockC, ccRock);
}
// Underwater: darker and greener seabed.
col = mix(col, col * cc_srgb(vec3(0.55, 0.7, 0.62)), smoothstep(-0.2, -3.0, vCcWorld.y));
diffuseColor.rgb *= col;
`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.35, ccSandWet * (1.0 - ccRock));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (ccCob > 0.01) {
  vec3 tn = texture2D(uCobbleN, ccXZ * 0.22).xyz * 2.0 - 1.0;
  vec3 wn = normalize(vec3(tn.x, tn.z, -tn.y));
  vec3 vn = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
  normal = normalize(mix(normal, vn, ccCob * 0.85));
}`,
      );
  };
  mat.customProgramCacheKey = () => 'cc-terrain';
  return mat;
}
