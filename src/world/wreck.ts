// The Iron Wreck: a rusted steamship broken in two at the south end of the Brine Shore. The bow
// section ran aground with a flat iron deck (the boss arena, about 25 units across); the stern
// section lies apart, sinking at a steep angle with the funnel and wheelhouse. A plank gangway
// climbs from the beach.
import * as THREE from 'three';
import { type Collision, type DeckHeight, deckHeight, polySurface, rectSurface } from './collision';
import { mergeAll } from './fountain';
import { tube, worldBox } from './geom';
import { type StaticBatch, trs } from './kit';
import { WRECK } from './layout';
import { plankMaterial, rustMaterial } from './materials';
import { rng } from './noise';

const HALF_L = 27;
const HALF_B = 13.5;
const KEEL = -9;
const BULWARK = 1.25;
const ROLL = 0.03;
/** Where the hull broke (local x). The bow section runs from here to the stem. */
const BREAK_X = -11;
/** Arena centre in local deck coordinates. */
export const ARENA_LOCAL = { x: 3, z: 0 };

/** Half beam at local x (bow at +HALF_L). */
export function halfBeam(x: number): number {
  const s = x / HALF_L;
  if (s > 0.3) return HALF_B * Math.max(0, 1 - Math.pow((s - 0.3) / 0.7, 1.7));
  if (s < -0.62) {
    const t = (s + 0.62) / 0.38;
    return HALF_B * (1 - 0.32 * t * t);
  }
  return HALF_B;
}
const sheerAt = (x: number) => Math.pow(Math.max(0, x / HALF_L - 0.45) * 1.8, 2) * 2.2;

export interface Wreck {
  group: THREE.Group;
  toWorld(lx: number, lz: number, ly?: number): THREE.Vector3;
  deckHeight(x: number, z: number): number;
  embers: THREE.Vector3[];
  /** Brazier flames around the arena (world). */
  fires: THREE.Vector3[];
  gangwayFoot: THREE.Vector3;
  arena: THREE.Vector3;
}

/** Lofted hull between x0 and x1; a broken end gets a jagged, torn edge. */
function hullGeometry(x0: number, x1: number, broken: 'start' | 'end' | null, seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const prof: [number, number][] = [
    [1.0, BULWARK],
    [1.0, 0.0],
    [0.985, -2.2],
    [0.93, -4.6],
    [0.78, -6.8],
    [0.48, -8.4],
    [0.0, KEEL],
  ];
  const ring: [number, number][] = [...prof, ...prof.slice(0, -1).reverse().map(([b, y]) => [-b, y] as [number, number])];
  const stations = Math.max(6, Math.round((x1 - x0) / 0.9));
  const pos: number[] = [];
  const idx: number[] = [];
  const rl = ring.length;
  const jag = ring.map(() => (r() - 0.5) * 2.4);
  for (let i = 0; i <= stations; i++) {
    const x = x0 + ((x1 - x0) * i) / stations;
    for (let j = 0; j < rl; j++) {
      let xx = x;
      if (broken === 'start' && i === 0) xx = x + jag[j];
      if (broken === 'end' && i === stations) xx = x + jag[j];
      const b = Math.max(halfBeam(xx), 0.05);
      const [f, y] = ring[j];
      const sh = sheerAt(xx);
      const keelLift = y < 0 ? Math.max(0, xx / HALF_L - 0.55) * 9 * (-y / -KEEL) : 0;
      pos.push(xx, y + sh + keelLift, f * b);
    }
  }
  for (let i = 0; i < stations; i++)
    for (let j = 0; j < rl - 1; j++) {
      const a = i * rl + j;
      const c = a + rl;
      idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  // Cap the stern transom when the section ends at the stern.
  if (x0 <= -HALF_L + 0.01) {
    const c = pos.length / 3;
    pos.push(x0, -3, 0);
    for (let j = 0; j < rl - 1; j++) idx.push(j + 1, j, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}

function deckGeometry(x0: number, x1: number): THREE.BufferGeometry {
  const n = Math.round((x1 - x0) / 1.0);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    pts.push(new THREE.Vector2(x, -Math.max(halfBeam(x) - 0.05, 0.02)));
  }
  for (let i = n; i >= 0; i--) {
    const x = x0 + ((x1 - x0) * i) / n;
    pts.push(new THREE.Vector2(x, Math.max(halfBeam(x) - 0.05, 0.02)));
  }
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 1).rotateX(-Math.PI / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, sheerAt(p.getX(i)) + 0.02);
  g.computeVertexNormals();
  return g;
}

const DEBRIS: [string, number, number, number, number][] = [
  ['Barrel', 30, -6, 0.3, 1],
  ['Crate_Wooden', 31, -9, 1.1, 1.2],
  ['Chain_Coil', 29, -12, 0, 1.4],
  ['Crate_Wooden', 33, -15, 2.4, 1],
  ['Barrel', 24, -17, 1.6, 1],
  ['Rope_3', 26, -20, 0.4, 1.3],
  ['Crate_Metal', 20, -19, 0.7, 1.1],
  ['Barrel', 17, -22, 2.2, 1],
  ['Chest_Wood', 34, -3, 2.9, 1],
];
const BRAZIERS: [number, number][] = [
  [-7.5, -9.6],
  [-7.5, 9.6],
  [13.8, -8.4],
  [13.8, 8.4],
];

/** The ship's frame and every wreck collider, without meshes: the server bakes these. */
export function layoutWreck(col: Collision) {
  const group = new THREE.Group();
  group.name = 'wreck';
  const ship = new THREE.Group();
  ship.position.set(WRECK.x, WRECK.deckY, WRECK.z);
  ship.rotation.set(ROLL, WRECK.rotY, WRECK.pitch, 'YZX');
  group.add(ship);
  ship.updateMatrixWorld(true);
  const M = ship.matrixWorld.clone();
  const ax = new THREE.Vector3(1, 0, 0).transformDirection(M);
  const az = new THREE.Vector3(0, 0, 1).transformDirection(M);
  const toWorld = (lx: number, lz: number, ly = 0) => new THREE.Vector3(lx, ly, lz).applyMatrix4(M);
  const deck: DeckHeight = {
    kind: 'deck',
    ox: WRECK.x,
    oz: WRECK.z,
    axx: ax.x,
    axz: ax.z,
    azx: az.x,
    azz: az.z,
    y0: WRECK.deckY,
    sinPitch: Math.sin(WRECK.pitch),
    sinRoll: Math.sin(ROLL),
    cosPitch: Math.cos(WRECK.pitch),
    halfL: HALF_L,
  };
  const deckY = (x: number, z: number) => deckHeight(deck, x, z);
  // Stern section: broken off, settled deeper and steeply tilted.
  // Pivot at the torn end so the stern itself dives under while the break rears up.
  const pivotX = BREAK_X - 1.5;
  const stern = new THREE.Group();
  stern.position.set(pivotX - 1.4, -1.0, 1.6);
  stern.rotation.set(0.14, 0.09, 0.2, 'YZX');
  ship.add(stern);
  stern.updateMatrixWorld(true);
  const sternMatrix = stern.matrixWorld.clone();
  // The meshes add the stern back after the bow, keeping the scene's child order.
  ship.remove(stern);
  const sternWorld = (lx: number, ly: number, lz: number) => new THREE.Vector3(lx - pivotX, ly, lz).applyMatrix4(sternMatrix);

  // Collision: bow deck surface, bulwarks with a gangway gap on the beach (-z) side, the break.
  const gwX0 = 9;
  const gwX1 = 13.5;
  const xs: number[] = [];
  for (let x = BREAK_X + 0.6; x <= HALF_L + 0.001; x += 0.75) xs.push(x);
  const poly: [number, number][] = [];
  for (const x of xs) {
    const p = toWorld(x, -Math.max(halfBeam(x) - 0.15, 0));
    poly.push([p.x, p.z]);
  }
  for (let i = xs.length - 1; i >= 0; i--) {
    const p = toWorld(xs[i], Math.max(halfBeam(xs[i]) - 0.15, 0));
    poly.push([p.x, p.z]);
  }
  col.addSurface(polySurface(poly, deck));
  for (const side of [-1, 1]) {
    for (let i = 0; i < xs.length - 1; i++) {
      const xa = xs[i];
      const xb = xs[i + 1];
      if (side === -1 && xb > gwX0 && xa < gwX1) continue;
      const a = toWorld(xa, side * halfBeam(xa));
      const b = toWorld(xb, side * halfBeam(xb));
      col.addWall(a.x, a.z, b.x, b.z, 0.5, -12, WRECK.deckY + 8);
    }
  }
  const brA = toWorld(BREAK_X + 0.5, -HALF_B);
  const brB = toWorld(BREAK_X + 0.5, HALF_B);
  col.addWall(brA.x, brA.z, brB.x, brB.z, 0.6, -12, WRECK.deckY + 8);
  const cap = toWorld(21.5, 0);
  col.addCircle(cap.x, cap.z, 1.25);
  const mast = toWorld(19.2, -1.2);
  col.addCircle(mast.x, mast.z, 0.7);
  for (const z of [-4.2, 4.2]) {
    const b = toWorld(17.5, z);
    col.addCircle(b.x, b.z, 0.5);
    const v = toWorld(14.3, z * 2.3);
    col.addCircle(v.x, v.z, 0.6);
  }
  const hatch = toWorld(-7.6, -8.6);
  col.addBox(hatch.x, hatch.z, 1.6, 2.4, WRECK.rotY);
  // Hull blocks line of sight below the deck, seen from outside.
  const hc = toWorld((BREAK_X + HALF_L) / 2, 0);
  col.addBox(hc.x, hc.z, ((HALF_L - BREAK_X) / 2) * 0.9, HALF_B * 0.9, WRECK.rotY, -12, WRECK.deckY - 0.7, true);
  const sc = sternWorld(-20, 0, 0);
  col.addBox(sc.x, sc.z, 8, HALF_B, WRECK.rotY, -12, WRECK.deckY + 6);

  // Gangway: planks from the beach up to the deck gap.
  const gwMid = (gwX0 + gwX1) / 2;
  const deckEdge = toWorld(gwMid, -halfBeam(gwMid));
  const out = az.clone().setY(0).normalize().negate();
  const foot = deckEdge.clone().addScaledVector(out, 12);
  foot.y = Math.max(col.terrain.heightAt(foot.x, foot.z), 0.3);
  const topY = deckY(deckEdge.x, deckEdge.z);
  const glen = Math.hypot(foot.x - deckEdge.x, foot.z - deckEdge.z);
  const gyaw = Math.atan2(-(foot.z - deckEdge.z), foot.x - deckEdge.x);
  const gmid = deckEdge.clone().lerp(foot, 0.5);
  gmid.y = (topY + foot.y) / 2;
  const gslope = (foot.y - topY) / glen;
  col.addSurface(rectSurface(gmid.x, gmid.z, glen / 2 + 0.5, 2.0, gyaw, gmid.y, gslope, 0));
  const nx = Math.sin(gyaw);
  const nz = Math.cos(gyaw);
  for (const side of [-1, 1]) {
    col.addWall(
      deckEdge.x + nx * side * 2.05,
      deckEdge.z + nz * side * 2.05,
      foot.x + nx * side * 2.05 - (foot.x - deckEdge.x) * 0.12,
      foot.z + nz * side * 2.05 - (foot.z - deckEdge.z) * 0.12,
      0.3,
      -5,
      WRECK.deckY + 3,
    );
  }
  // Beach debris around the bow: crates, barrels, chain, rope and hull plates.
  const debris: { name: string; p: THREE.Vector3; y: number; rot: number; s: number }[] = [];
  for (const [name, lx, lz, rot, s] of DEBRIS) {
    const p = toWorld(lx, lz);
    const y = col.terrain.heightAt(p.x, p.z);
    if (y < -0.3) continue;
    debris.push({ name, p, y, rot, s });
    if (name !== 'Rope_3' && name !== 'Chain_Coil') col.addCircle(p.x, p.z, 0.55 * s);
  }
  // Iron braziers at the arena's corners: light for the night fight.
  const braziers = BRAZIERS.map(([lx, lz]) => {
    const p = toWorld(lx, lz);
    const y = deckY(p.x, p.z);
    col.addCircle(p.x, p.z, 0.75);
    return { p, y };
  });
  const ground = (x: number, z: number) => col.terrain.heightAt(x, z);
  return { group, ship, stern, pivotX, ax, toWorld, deckHeight: deckY, sternWorld, ground, gangway: { deckEdge, foot, topY, glen, gyaw, gmid, gslope, nx, nz }, debris, braziers };
}

export type WreckLayout = ReturnType<typeof layoutWreck>;

export function buildWreck(layout: WreckLayout, batch: StaticBatch, propBatch: StaticBatch): Wreck {
  const { group, ship, stern, pivotX, ax, toWorld, deckHeight, sternWorld, gangway: gw, debris, braziers, ground } = layout;
  const { deckEdge, foot, topY, glen, gyaw, gmid, gslope, nx, nz } = gw;

  const hullMat = rustMaterial({ axis: ax, base: '#36312f', rust: '#9c4a20' });
  hullMat.side = THREE.DoubleSide;
  const deckMat = rustMaterial({ axis: ax, deck: true, base: '#3e3a38', rust: '#94461f' });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#120d0b', roughness: 0.9, side: THREE.DoubleSide });

  // Bow section.
  const bowHull = new THREE.Mesh(hullGeometry(BREAK_X, HALF_L, 'start', 3), hullMat);
  const bowDeck = new THREE.Mesh(deckGeometry(BREAK_X + 0.6, HALF_L), deckMat);
  // Torn bulkhead at the break: a dark wall so you cannot see into the empty hull.
  const bulk = new THREE.Mesh(new THREE.PlaneGeometry(HALF_B * 2, -KEEL - 0.2).rotateY(Math.PI / 2).translate(BREAK_X + 0.4, KEEL / 2 - 0.2, 0), darkMat);
  for (const m of [bowHull, bowDeck]) {
    m.castShadow = m.receiveShadow = true;
    ship.add(m);
  }
  ship.add(bulk);

  // Bow fittings: bulwark cap rail, capstan, bitts, ventilator cowls, foremast stump, anchor.
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let x = BREAK_X + 0.8; x <= HALF_L - 0.3; x += 0.8) pts.push(new THREE.Vector3(x, BULWARK + sheerAt(x), side * (halfBeam(x) - 0.02)));
    parts.push(tube(pts, () => 0.16, 6, { up: new THREE.Vector3(0, 1, 0) }));
  }
  parts.push(new THREE.CylinderGeometry(0.9, 1.1, 1.0, 14).translate(21.5, 0.5 + sheerAt(21.5), 0));
  parts.push(new THREE.CylinderGeometry(1.15, 1.15, 0.2, 14).translate(21.5, 1.05 + sheerAt(21.5), 0));
  for (const z of [-4.2, 4.2]) {
    parts.push(new THREE.CylinderGeometry(0.35, 0.4, 1.2, 10).translate(17.5, 0.6 + sheerAt(17.5), z));
    // Ventilator cowl: a pipe with a bell mouth turned toward the bow.
    const base = new THREE.Vector3(14, sheerAt(14), z * 2.3);
    const cowl = [base, base.clone().add(new THREE.Vector3(0, 1.8, 0)), base.clone().add(new THREE.Vector3(0.25, 2.6, 0)), base.clone().add(new THREE.Vector3(0.9, 3.0, 0))];
    parts.push(tube(cowl, (t) => 0.35 + Math.pow(t, 4) * 0.55, 14, { up: new THREE.Vector3(0, 0, 1) }));
  }
  parts.push(new THREE.CylinderGeometry(0.4, 0.55, 8.5, 10).rotateZ(-0.42).translate(19.2, 3.6 + sheerAt(19), -1.2));
  // Hatch coaming at the arena's far edge, with a red glow inside.
  parts.push(worldBox(3.0, 0.55, 4.6, 0.4).translate(-7.6, 0.27, -8.6));
  // Anchor hanging at the bow (beach side): shank and arms.
  const anc = new THREE.Vector3(23.5, -1.5, -halfBeam(23.5) - 0.3);
  parts.push(new THREE.CylinderGeometry(0.16, 0.16, 3.2, 8).translate(anc.x, anc.y, anc.z));
  parts.push(new THREE.TorusGeometry(0.95, 0.17, 6, 14, Math.PI).rotateZ(Math.PI).translate(anc.x, anc.y - 1.3, anc.z));
  const bowMesh = new THREE.Mesh(mergeAll(parts), hullMat);
  bowMesh.castShadow = bowMesh.receiveShadow = true;
  ship.add(bowMesh);
  const glowMat = new THREE.MeshStandardMaterial({ color: '#100604', emissive: '#ff4a14', emissiveIntensity: 2.2, roughness: 1 });
  ship.add(new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.2).rotateX(-Math.PI / 2).translate(-7.6, 0.4, -8.6), glowMat));

  // Stern section (frame in layoutWreck).
  const sternHull = new THREE.Mesh(hullGeometry(-HALF_L, BREAK_X - 1.5, 'end', 9).translate(-pivotX, 0, 0), hullMat);
  const sternDeck = new THREE.Mesh(deckGeometry(-HALF_L + 0.2, BREAK_X - 2.2).translate(-pivotX, 0, 0), deckMat);
  const sp: THREE.BufferGeometry[] = [];
  sp.push(worldBox(7, 4.0, 11, 0.4).translate(-21.5, 2.0, 0));
  sp.push(worldBox(4.6, 2.3, 8.4, 0.4).translate(-22, 5.15, 0));
  sp.push(new THREE.CylinderGeometry(1.75, 1.95, 7.5, 18, 1, true).rotateZ(0.12).translate(-15.5, 3.7, 0));
  sp.push(new THREE.TorusGeometry(1.8, 0.18, 6, 18).rotateX(Math.PI / 2).translate(-15.1, 7.4, 0));
  for (const z of [-2.5, 2.5]) sp.push(new THREE.CylinderGeometry(0.12, 0.12, 4.5, 6).rotateZ(-0.3).translate(-24.5, 3.2, z * 1.8));
  const sternParts = new THREE.Mesh(mergeAll(sp).translate(-pivotX, 0, 0), hullMat);
  for (const m of [sternHull, sternDeck, sternParts]) {
    m.castShadow = m.receiveShadow = true;
    stern.add(m);
  }
  const winGeo: THREE.BufferGeometry[] = [];
  for (const z of [-3.2, -1.1, 1.1, 3.2]) winGeo.push(new THREE.PlaneGeometry(1.0, 0.85).rotateY(-Math.PI / 2).translate(-17.98, 2.8, z));
  for (const z of [-2.4, 0, 2.4]) winGeo.push(new THREE.PlaneGeometry(0.85, 0.75).rotateY(-Math.PI / 2).translate(-19.68, 5.5, z));
  stern.add(new THREE.Mesh(mergeAll(winGeo).translate(-pivotX, 0, 0), glowMat));
  ship.add(stern);
  stern.updateMatrixWorld(true);
  const embers = [toWorld(-7.6, -8.6, 0.8), sternWorld(-22, 5.4, 0), sternWorld(-15.5, 7.6, 0)];

  const wood = plankMaterial();
  const plankParts: THREE.BufferGeometry[] = [];
  const nplank = Math.ceil(glen / 0.55);
  const slopeAng = Math.atan(gslope);
  for (let i = 0; i < nplank; i++) {
    const t = (i + 0.5) / nplank;
    const px = deckEdge.x + (foot.x - deckEdge.x) * t;
    const pz = deckEdge.z + (foot.z - deckEdge.z) * t;
    const py = topY + (foot.y - topY) * t - 0.1;
    const w = 3.7 + Math.sin(i * 7.3) * 0.3;
    plankParts.push(
      worldBox(0.48, 0.12, w, 1)
        .rotateZ(slopeAng + Math.sin(i * 3.1) * 0.03)
        .rotateY(gyaw + Math.sin(i * 5.7) * 0.05)
        .translate(px, py, pz),
    );
  }
  for (const side of [-1, 1]) {
    plankParts.push(
      worldBox(glen + 0.4, 0.28, 0.28, 1)
        .rotateZ(slopeAng)
        .rotateY(gyaw)
        .translate(gmid.x + nx * side * 1.9, gmid.y - 0.25, gmid.z + nz * side * 1.9),
    );
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const px = deckEdge.x + (foot.x - deckEdge.x) * t + nx * side * 1.95;
      const pz = deckEdge.z + (foot.z - deckEdge.z) * t + nz * side * 1.95;
      const py = topY + (foot.y - topY) * t;
      plankParts.push(new THREE.CylinderGeometry(0.08, 0.1, 1.2, 6).translate(px, py + 0.5, pz));
    }
  }
  const gangway = new THREE.Mesh(mergeAll(plankParts), wood);
  gangway.castShadow = gangway.receiveShadow = true;
  group.add(gangway);
  // Anchor chain from the hawse pipe down to the sand.
  const hawse = toWorld(25.5, -halfBeam(25.5) + 0.4, 0.4 + sheerAt(25.5));
  const sandEnd = toWorld(36, -14);
  sandEnd.y = ground(sandEnd.x, sandEnd.z) - 0.1;
  const chainPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const p = hawse.clone().lerp(sandEnd, t);
    p.y -= Math.sin(t * Math.PI) * 2.2;
    chainPts.push(p);
  }
  const chain = new THREE.Mesh(tube(chainPts, () => 0.13, 6, { up: new THREE.Vector3(0, 1, 0) }), hullMat);
  chain.castShadow = true;
  group.add(chain);

  for (const { name, p, y, rot, s } of debris) {
    const tilt = name === 'Barrel' && rot > 1 ? Math.PI / 2 : 0;
    propBatch.add(name, trs(p.x, y + (tilt ? 0.33 : -0.05), p.z, WRECK.rotY + rot, s, 0, tilt));
  }
  const plateParts: THREE.BufferGeometry[] = [];
  const plates: [number, number, number, number][] = [
    [26, -24, 0.5, 0.4],
    [37, -10, 1.9, -0.3],
    [15, -27, 2.6, 0.5],
    [40, 3, 0.9, 0.25],
  ];
  for (const [lx, lz, rot, tilt] of plates) {
    const p = toWorld(lx, lz);
    const y = ground(p.x, p.z);
    plateParts.push(worldBox(3.4, 0.18, 2.4, 0.4).rotateX(tilt).rotateY(WRECK.rotY + rot).translate(p.x, y + 0.25, p.z));
  }
  const plateMesh = new THREE.Mesh(mergeAll(plateParts), hullMat);
  plateMesh.castShadow = plateMesh.receiveShadow = true;
  group.add(plateMesh);
  void batch;

  // Iron braziers at the arena's corners: light for the night fight.
  const fires: THREE.Vector3[] = [];
  const brazParts: THREE.BufferGeometry[] = [];
  const coalParts: THREE.BufferGeometry[] = [];
  for (const { p, y } of braziers) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      brazParts.push(new THREE.CylinderGeometry(0.06, 0.08, 1.7, 5).rotateZ(0.18).rotateY(a).translate(p.x + Math.cos(a) * 0.32, y + 0.8, p.z + Math.sin(a) * 0.32));
    }
    brazParts.push(
      new THREE.LatheGeometry(
        [new THREE.Vector2(0.05, 0), new THREE.Vector2(0.55, 0.12), new THREE.Vector2(0.72, 0.5), new THREE.Vector2(0.66, 0.52), new THREE.Vector2(0.5, 0.2), new THREE.Vector2(0.0, 0.14)],
        12,
      ).translate(p.x, y + 1.55, p.z),
    );
    coalParts.push(new THREE.CircleGeometry(0.6, 12).rotateX(-Math.PI / 2).translate(p.x, y + 1.95, p.z));
    fires.push(new THREE.Vector3(p.x, y + 2.35, p.z));
  }
  const brazMesh = new THREE.Mesh(mergeAll(brazParts), new THREE.MeshStandardMaterial({ color: '#2a2420', roughness: 0.6, metalness: 0.7 }));
  brazMesh.castShadow = true;
  group.add(brazMesh);
  const coalMesh = new THREE.Mesh(mergeAll(coalParts), new THREE.MeshStandardMaterial({ color: '#160603', emissive: '#ff6a1a', emissiveIntensity: 3, roughness: 1 }));
  coalMesh.userData.flicker = true;
  group.add(coalMesh);

  const arena = toWorld(ARENA_LOCAL.x, ARENA_LOCAL.z);
  arena.y = deckHeight(arena.x, arena.z);
  return { group, toWorld, deckHeight, embers, fires, gangwayFoot: foot, arena };
}
