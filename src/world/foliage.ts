// Vegetation and rocks: pine woods, meadow trees, bushes, flowers and grass tufts (wind sway),
// scattered by rules over the terrain and the layout. Trees and big rocks get collision circles.
import * as THREE from 'three';
import type { Collision } from './collision';
import { type Kit, trs } from './kit';
import { InstanceField, type LodPart, lowPine } from './instances';
import { GROVE, LIGHTHOUSE, LOTS, PLAZAS, ROADS, WRECK } from './layout';
import { windSway, stylise, addPatch } from './materials';
import { rng, Simplex, smoothstep } from './noise';
import { polylineDist, type Terrain } from './terrain';

interface Mask {
  road: number;
  built: number;
}

export interface FoliageResult {
  group: THREE.Group;
  counts: Record<string, number>;
  /** Re-pack visible instances (call every frame with the render camera). */
  update(camera: THREE.Camera): void;
  /** Spots for fireflies and glowing mushrooms in the grove. */
  groveGlow: THREE.Vector3[];
}

/** Collects placements per kit piece. */
class Placements {
  readonly items = new Map<string, THREE.Matrix4[]>();
  add(piece: string, m: THREE.Matrix4): void {
    let l = this.items.get(piece);
    if (!l) this.items.set(piece, (l = []));
    l.push(m.clone());
  }
}

/** Distance-to-feature helpers precomputed on a coarse grid for scattering. */
class Features {
  private q = { d: 0, s: 0, t: 0, seg: 0 };
  road(x: number, z: number): number {
    let best = Infinity;
    for (const r of ROADS) {
      polylineDist(x, z, r.points, this.q);
      best = Math.min(best, this.q.d - r.width / 2);
    }
    for (const p of PLAZAS) best = Math.min(best, Math.hypot(x - p.x, z - p.z) - p.r);
    return best;
  }
  built(x: number, z: number): number {
    let best = Infinity;
    for (const l of LOTS) {
      const dx = x - l.x;
      const dz = z - l.z;
      const c = Math.cos(l.yaw);
      const s = Math.sin(l.yaw);
      const lx = c * dx - s * dz;
      const lz = s * dx + c * dz;
      const qx = Math.abs(lx) - l.sx;
      const qz = Math.abs(lz) - l.sz;
      best = Math.min(best, Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0));
    }
    // Landmarks: fountain, lighthouse, wreck, grove pool.
    best = Math.min(best, Math.hypot(x, z) - 5.5);
    best = Math.min(best, Math.hypot(x - GROVE.x, z - GROVE.z) - GROVE.poolR - 1.5);
    best = Math.min(best, Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) - 6);
    best = Math.min(best, Math.hypot(x - WRECK.x, z - WRECK.z) - 30);
    return best;
  }
  mask(x: number, z: number): Mask {
    return { road: this.road(x, z), built: this.built(x, z) };
  }
}

/** A grass tuft: a fan of tapered, bent blades with a dark-root to bright-tip vertex gradient. */
function tuftGeometry(blades: number, height: number, seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const root = new THREE.Color('#2c4a12');
  const tip = new THREE.Color('#9cc23e');
  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI * 2 + r() * 0.8;
    const lean = 0.25 + r() * 0.45;
    const h = height * (0.6 + r() * 0.6);
    const w = 0.07 + r() * 0.05;
    const ox = Math.cos(ang) * 0.12 * r();
    const oz = Math.sin(ang) * 0.12 * r();
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const px = -dz;
    const pz = dx;
    const base = pos.length / 3;
    const segs = 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const y = h * t;
      const off = lean * h * t * t;
      const ww = w * (1 - t * 0.92);
      const cx = ox + dx * off;
      const cz = oz + dz * off;
      pos.push(cx - px * ww, y, cz - pz * ww, cx + px * ww, y, cz + pz * ww);
      const c = root.clone().lerp(tip, Math.pow(t, 0.8)).multiplyScalar(0.85 + r() * 0.3);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      // Normals tilted up so tufts shade like the ground under them.
      nor.push(dx * 0.3, 0.95, dz * 0.3, dx * 0.3, 0.95, dz * 0.3);
    }
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** Every foliage placement, and the collision circles of trees and big rocks, without meshes. */
export interface FoliageScatter {
  trees: Placements;
  small: Placements;
  /** Grass tuft transforms for the three tuft shapes. */
  tufts: THREE.Matrix4[][];
  counts: Record<string, number>;
  groveGlow: THREE.Vector3[];
}

export function scatterFoliage(terrain: Terrain, col: Collision, quality: 'low' | 'high'): FoliageScatter {
  const F = new Features();
  const N = new Simplex(31);
  const R = rng(1234);
  const trees = new Placements();
  const small = new Placements();
  const counts: Record<string, number> = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  // Solid placements must be identical for every client and the server bake.
  // Consume the same random sequence at both quality settings; only decoration is thinned later.
  const dense = 1;

  const groundOk = (x: number, z: number, minH = 0.9) => {
    const h = terrain.heightAt(x, z);
    if (h < minH) return null;
    if (terrain.slopeAt(x, z) < 0.78) return null;
    if (terrain.splatAt(x, z, 0) > 0.4) return null; // sand
    return h;
  };

  // Pine woods: density field favouring the west hills, north ridge and headland.
  const pineNames = ['Pine_1', 'Pine_2', 'Pine_3', 'Pine_4', 'Pine_5'];
  const step = 5.6;
  for (let z = -240; z <= 240; z += step) {
    for (let x = -225; x <= 265; x += step) {
      const jx = x + (R() - 0.5) * step * 0.9;
      const jz = z + (R() - 0.5) * step * 0.9;
      const n = N.fbm(jx / 45, jz / 45, 3) * 0.5 + 0.5;
      let d = 0;
      d = Math.max(d, smoothstep(-48, -95, jx)); // west woods
      d = Math.max(d, smoothstep(-58, -110, jz) * (1 - smoothstep(60, 120, jx)) * 0.9); // north ridge
      d = Math.max(d, smoothstep(70, 120, jz) * (1 - smoothstep(70, 112, jx)) * 0.75); // south hills
      const head = jx > 112 && jz < -92 && jz > -175;
      if (head) d = Math.max(d, 0.32);
      if (jz > 150 && jx > 120) d = Math.max(d, 0.7); // south arm of the bay
      // Keep the lighthouse bridgehead and the view of the tower clear.
      if (Math.hypot(jx - LIGHTHOUSE.bridgeFrom[0], jz - LIGHTHOUSE.bridgeFrom[1]) < 26) continue;
      if (Math.hypot(jx - WRECK.x, jz - WRECK.z) < 52) continue;
      d *= 0.35 + 0.9 * n;
      // Keep the grove clearing open with a ring of trees around it.
      const gr = Math.hypot(jx - GROVE.x, jz - GROVE.z);
      if (gr < GROVE.r + 2) continue;
      if (gr < GROVE.r + 14) d = Math.max(d, 0.9);
      if (R() > d * 0.85) continue;
      const m = F.mask(jx, jz);
      if (m.road < 3 || m.built < 4) continue;
      const h = groundOk(jx, jz, 1.6);
      if (h === null) continue;
      // Near paths any pine; deep in the woods mostly the light Pine_5.
      const far = m.road > 35 && m.built > 35;
      const name = far ? (R() < 0.75 ? 'Pine_5' : 'Pine_4') : pineNames[Math.floor(R() * pineNames.length)];
      const s = 1.05 + R() * 0.9 + (gr < GROVE.r + 14 ? 0.4 : 0);
      trees.add(name, trs(jx, h - 0.15, jz, R() * Math.PI * 2, s));
      col.addCircle(jx, jz, 0.45 * s, h - 1, h + 9 * s);
      count('pine');
    }
  }

  // Meadow and town trees: scattered between the town and the shore, along the roads.
  const commons = ['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_4', 'CommonTree_5'];
  for (let i = 0; i < 420 * dense; i++) {
    const x = -60 + R() * 170;
    const z = -80 + R() * 170;
    const n = N.fbm(x / 30 + 5, z / 30, 2) * 0.5 + 0.5;
    if (R() > n * 0.9) continue;
    const m = F.mask(x, z);
    if (m.road < 3.5 || m.built < 4.5) continue;
    if (Math.hypot(x, z) < 22) continue;
    const h = groundOk(x, z, 1.8);
    if (h === null) continue;
    const s = 0.85 + R() * 0.5;
    trees.add(commons[Math.floor(R() * commons.length)], trs(x, h - 0.15, z, R() * Math.PI * 2, s));
    col.addCircle(x, z, 0.4 * s, h - 1, h + 7 * s);
    count('tree');
  }
  // Hero trees: twisted giants framing the grove, one on the headland, dead trees on the shore.
  const hero: [string, number, number, number, number][] = [
    ['TwistedTree_1', GROVE.x - 13, GROVE.z - 6, 0.6, 0.85],
    ['TwistedTree_2', GROVE.x + 9, GROVE.z + 12, 2.4, 0.8],
    ['TwistedTree_3', GROVE.x - 4, GROVE.z + 15, 4.1, 0.75],
    ['TwistedTree_2', 136, -122, 1.2, 0.7],
    ['DeadTree_1', 104, 70, 0.4, 0.55],
    ['DeadTree_3', 108, -30, 2.1, 0.5],
    ['DeadTree_2', 121, 92, 3.3, 0.45],
  ];
  for (const [name, x, z, rot, s] of hero) {
    const h = terrain.heightAt(x, z);
    trees.add(name, trs(x, h - 0.2, z, rot, s));
    col.addCircle(x, z, 0.9 * s, h - 1, h + 12 * s);
    count('hero');
  }

  // Bushes: along building bases and road edges in town, and the forest edge.
  for (let i = 0; i < 900 * dense; i++) {
    const x = -90 + R() * 210;
    const z = -90 + R() * 180;
    const m = F.mask(x, z);
    const nearBuild = m.built > 0.6 && m.built < 2.4;
    const nearRoad = m.road > 0.8 && m.road < 2.2 && R() < 0.25;
    const forestEdge = x < -45 && R() < 0.3;
    if (!(nearBuild || nearRoad || forestEdge)) continue;
    const h = groundOk(x, z, 1.2);
    if (h === null) continue;
    const name = R() < 0.4 ? 'Bush_Common_Flowers' : 'Bush_Common';
    small.add(name, trs(x, h - 0.1, z, R() * 6.3, 0.7 + R() * 0.6));
    count('bush');
  }
  // Flowers and ferns: meadow patches; ferns under the pines; petals sprinkled everywhere green.
  for (let i = 0; i < 2600 * dense; i++) {
    const x = -130 + R() * 260;
    const z = -150 + R() * 280;
    const m = F.mask(x, z);
    if (m.road < 0.8 || m.built < 1) continue;
    const h = groundOk(x, z, 1.4);
    if (h === null) continue;
    const forest = x < -55 || z < -70;
    const patch = N.fbm(x / 18, z / 18 + 40, 2);
    if (forest) {
      if (R() < 0.5) small.add('Fern_1', trs(x, h - 0.05, z, R() * 6.3, 0.8 + R() * 0.7)), count('fern');
    } else if (patch > 0.15) {
      const name = R() < 0.5 ? 'Flower_3_Group' : R() < 0.5 ? 'Flower_4_Group' : 'Clover_1';
      small.add(name, trs(x, h - 0.05, z, R() * 6.3, 0.45 + R() * 0.3));
      count('flower');
    } else if (R() < 0.6) {
      small.add(`Petal_${1 + Math.floor(R() * 5)}`, trs(x, h + 0.01, z, R() * 6.3, 0.9 + R() * 0.6));
      count('petal');
    }
  }
  // Rocks: cliff feet, beach, headland and forest.
  for (let i = 0; i < 1400 * dense; i++) {
    const x = -220 + R() * 400;
    const z = -230 + R() * 460;
    const h = terrain.heightAt(x, z);
    const slope = terrain.slopeAt(x, z);
    const m = F.mask(x, z);
    if (m.road < 1.5 || m.built < 2) continue;
    const coast = terrain.coastAt(x, z);
    let s = 0;
    if (slope < 0.72 && slope > 0.45 && R() < 0.45) s = 1.2 + R() * 1.6; // cliff dressing
    else if (coast > -6 && coast < 4 && R() < 0.35) s = 0.6 + R() * 1.6; // shore boulders
    else if (x < -60 && R() < 0.12) s = 0.7 + R() * 1.4; // forest
    else continue;
    if (h < -4) continue;
    const name = `Rock_Medium_${1 + Math.floor(R() * 3)}`;
    small.add(name, trs(x, h - 0.65 * s, z, R() * 6.3, s, (R() - 0.5) * 0.3, (R() - 0.5) * 0.3));
    if (s > 1.2 && h > 0) col.addCircle(x, z, 1.1 * s, h - 2, h + 2 * s);
    count('rock');
  }
  // Pebble paths and mushrooms in the grove.
  const groveGlow: THREE.Vector3[] = [];
  for (let i = 0; i < 70; i++) {
    const a = R() * Math.PI * 2;
    const rr = GROVE.poolR + 1.5 + R() * 8;
    const x = GROVE.x + Math.cos(a) * rr;
    const z = GROVE.z + Math.sin(a) * rr;
    const h = terrain.heightAt(x, z);
    if (R() < 0.55) {
      small.add('Mushroom_Common', trs(x, h - 0.02, z, R() * 6.3, 0.45 + R() * 0.45));
      groveGlow.push(new THREE.Vector3(x, h + 0.4, z));
    } else small.add(`Pebble_Round_${1 + Math.floor(R() * 3)}`, trs(x, h - 0.02, z, R() * 6.3, 1 + R() * 2));
  }

  // Grass tufts: dense on meadows near paths and buildings, sparser elsewhere.
  const tuftCount = quality === 'high' ? 18000 : 8000;
  const tufts: THREE.Matrix4[][] = [[], [], []];
  let placedTufts = 0;
  for (let i = 0; i < tuftCount * 3 && placedTufts < tuftCount; i++) {
    const x = -140 + R() * 270;
    const z = -150 + R() * 300;
    const dist = Math.hypot(x - 20, z);
    if (R() > 1.15 - dist / 160) continue;
    if (Math.hypot(x, z) < 30 && R() < 0.6) continue;
    const m = F.mask(x, z);
    if (m.road < 0.3 || m.built < 0.4) continue;
    const h = groundOk(x, z, 1.0);
    if (h === null) continue;
    if (terrain.splatAt(x, z, 2) > 0.3 || terrain.splatAt(x, z, 1) > 0.3) continue;
    const patch = N.fbm(x / 9, z / 9 + 70, 2);
    if (patch < -0.25 && R() < 0.7) continue;
    const s = 0.8 + R() * 0.7 + Math.max(0, patch) * 0.6;
    const tm = trs(x, h - 0.03, z, R() * 6.3, s);
    tufts[Math.floor(R() * 3)].push(tm);
    placedTufts++;
  }
  counts.tufts = placedTufts;
  if (quality === 'low') {
    for (const [name, matrices] of small.items) {
      // All rocks stay visible because the larger ones block movement.
      if (!name.startsWith('Rock_')) small.items.set(name, matrices.filter((_, i) => i % 5 < 3));
    }
  }
  return { trees, small, tufts, counts, groveGlow };
}

export function buildFoliage(nature: Kit, scatter: FoliageScatter, quality: 'low' | 'high'): FoliageResult {
  const group = new THREE.Group();
  group.name = 'foliage';
  const { trees, small, tufts: tuftPlacements, counts, groveGlow } = scatter;

  // Materials: saturate, recolour, sway. Twisted trees become the grove's moonlit teal; the same
  // leaf atlas on bushes turns summer green.
  const variants = new Map<string, THREE.Material>();
  const styled = (m: THREE.Material, variant: 'tree' | 'small') => {
    const n = m.name;
    const key = `${n}:${variant}`;
    let out = variants.get(key);
    if (out) return out;
    out = m.clone();
    if (n === 'Leaves_TwistedTree') {
      if (variant === 'tree') stylise(out, 1.25, [0.85, 1.05, 1.15], -3.1);
      else stylise(out, 1.1, [0.95, 1.05, 0.85], -1.9);
    } else if (n.startsWith('Leaves')) stylise(out, 1.2, [1.0, 1.03, 0.88]);
    else if (n.startsWith('Bark')) stylise(out, 0.7, [0.85, 0.8, 0.78]);
    else stylise(out, 1.1, [1.0, 1.0, 0.95]);
    if (n.startsWith('Leaves_Pine')) windSway(out, 0.25, 9, 0.8);
    else if (n.startsWith('Leaves')) windSway(out, 0.18, 6, 1.0, 0.03);
    else if (n === 'Grass' || n === 'Flowers') windSway(out, 0.12, 1.2, 1.4);
    if (n === 'Mushrooms') {
      const mm = out as THREE.MeshStandardMaterial;
      mm.emissive = new THREE.Color('#40ffd0');
      mm.emissiveIntensity = 0.12;
      mm.userData.glow = true;
    }
    variants.set(key, out);
    return out;
  };
  const fields: InstanceField[] = [];
  const partsFor = (piece: string, variant: 'tree' | 'small'): LodPart[] =>
    nature.get(piece).parts.map((p) => ({ geometry: p.geometry, material: styled(p.material, variant) }));
  const lowPineMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
  stylise(lowPineMat, 1.1, [1.0, 1.0, 0.95]);
  windSway(lowPineMat, 0.25, 9, 0.8);
  // Pines: full kit models up close, the light Pine_5 mid-range, cone pines far away. Only the
  // ranges inside the sun's shadow frustum cast shadows.
  const NEAR = quality === 'high' ? 48 : 36;
  const MID = quality === 'high' ? 125 : 95;
  const pineFar = new InstanceField(
    'pine-far',
    [
      { parts: [], maxDist: NEAR },
      { parts: partsFor('Pine_5', 'tree'), maxDist: MID },
      { parts: [{ geometry: lowPine(), material: lowPineMat }], maxDist: 900, castShadow: false },
    ],
    40,
    8,
  );
  for (const [name, mats] of trees.items) {
    if (name.startsWith('Pine_')) {
      const near = new InstanceField(`pine-near-${name}`, [{ parts: partsFor(name, 'tree'), maxDist: NEAR }], 40, 8);
      for (const m of mats) {
        near.add(m);
        pineFar.add(m);
      }
      fields.push(near);
    } else {
      const parts = partsFor(name, 'tree');
      const f = new InstanceField(name, [{ parts, maxDist: 100 }, { parts, maxDist: 340, castShadow: false }], 50, 12);
      for (const m of mats) f.add(m);
      fields.push(f);
    }
  }
  fields.push(pineFar);
  const smallRange = (n: string) =>
    n.startsWith('Petal') || n.startsWith('Pebble') ? 45 : n.startsWith('Mushroom') ? 60 : n.startsWith('Flower') || n.startsWith('Clover') ? 75 : n.startsWith('Fern') ? 85 : n.startsWith('Bush') ? 150 : 420;
  for (const [name, mats] of small.items) {
    const shadow = quality === 'high' && (name.startsWith('Bush') || name.startsWith('Rock'));
    const parts = partsFor(name, 'small');
    const range = smallRange(name);
    const levels = shadow && range > 90 ? [{ parts, maxDist: 90, castShadow: true }, { parts, maxDist: range, castShadow: false }] : [{ parts, maxDist: range, castShadow: shadow }];
    const f = new InstanceField(name, levels, 30, 4);
    for (const m of mats) f.add(m);
    fields.push(f);
  }

  // Grass tufts.
  const tufts = [tuftGeometry(8, 0.5, 1), tuftGeometry(6, 0.7, 2), tuftGeometry(9, 0.4, 3)];
  const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide });
  windSway(grassMat, 0.14, 0.9, 1.6);
  addPatch(grassMat, 'grass-tint', (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0;');
  });
  const tuftFields = tufts.map(
    (g, i) => new InstanceField(`grass-${i}`, [{ parts: [{ geometry: g, material: grassMat }], maxDist: quality === 'high' ? 60 : 42, castShadow: false }], 18, 1.2),
  );
  tuftPlacements.forEach((list, i) => {
    for (const m of list) tuftFields[i].add(m);
  });
  fields.push(...tuftFields);
  for (const f of fields) group.add(f.build());

  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  const lastPos = new THREE.Vector3(Infinity, 0, 0);
  const lastQ = new THREE.Quaternion();
  const camPos = new THREE.Vector3();
  const camQ = new THREE.Quaternion();
  const update = (camera: THREE.Camera) => {
    camera.getWorldPosition(camPos);
    camera.getWorldQuaternion(camQ);
    if (camPos.distanceToSquared(lastPos) < 0.25 && camQ.angleTo(lastQ) < 0.015) return;
    lastPos.copy(camPos);
    lastQ.copy(camQ);
    camera.updateMatrixWorld();
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);
    for (const f of fields) f.update(camPos, frustum, 24);
  };
  return { group, counts, groveGlow, update };
}
