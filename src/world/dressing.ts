// Set dressing: lamp posts, market stalls, the forge yard, tavern terrace, chapel candles, the
// pier with boats, the gate arch, and Moonpool Grove's glowing pool and standing stones.
import * as THREE from 'three';
import { type Collision, rectSurface } from './collision';
import { mergeAll } from './fountain';
import { lathe, worldBox } from './geom';
import { type Kit, type StaticBatch, trs } from './kit';
import { DOCK, GROVE, LOTS, type Lot, ROADS, TOWN_H } from './layout';
import { GLSL_NOISE, rng } from './noise';
import { plankMaterial } from './materials';
import { CC_SKY, CC_SKY_UNIFORMS, type SkyUniforms } from './sky';
import type { Terrain } from './terrain';

export interface GlowSpot {
  pos: THREE.Vector3;
  color: THREE.Color;
  size: number;
  /** 'lamp' brightens at night, 'fire' flickers, 'candle' small flicker, 'magic' pulses. */
  kind: 'lamp' | 'fire' | 'candle' | 'magic';
}

export interface Dressing {
  group: THREE.Group;
  glows: GlowSpot[];
  /** Real lights worth keeping (forge, tavern door, square, grove pool). */
  lights: { pos: THREE.Vector3; color: string; intensity: number; distance: number; kind: GlowSpot['kind'] }[];
  forgeSparks: THREE.Vector3;
  chimneys: THREE.Vector3[];
  groveWater: THREE.Mesh;
  /** Shaft of moonlight over the pool; uStrength follows the mood. */
  moonbeam: THREE.ShaderMaterial;
}

const lotById = (id: string) => LOTS.find((l) => l.id === id)!;
/** World position of a point in a lot's local frame (front = +z). */
function atLot(lot: Lot, lx: number, lz: number): [number, number] {
  const c = Math.cos(lot.yaw);
  const s = Math.sin(lot.yaw);
  return [lot.x + c * lx + s * lz, lot.z - s * lx + c * lz];
}

interface DressingGfx {
  village: Kit;
  propBatch: StaticBatch;
  villageBatch: StaticBatch;
  sky: SkyUniforms;
}

/** The market, forge, tavern, pier and grove colliders, without meshes. */
export function registerDressing(terrain: Terrain, col: Collision): void {
  dress(terrain, col, null);
}

export function buildDressing(village: Kit, props: Kit, terrain: Terrain, propBatch: StaticBatch, villageBatch: StaticBatch, sky: SkyUniforms): Dressing {
  void props;
  return dress(terrain, null, { village, propBatch, villageBatch, sky })!;
}

/** One walk over the set dressing: meshes when gfx is given, colliders when col is. Both passes draw
 * the same random numbers in the same order, so they place everything identically. */
function dress(terrain: Terrain, col: Collision | null, gfx: DressingGfx | null): Dressing | null {
  const propBatch = gfx?.propBatch;
  const villageBatch = gfx?.villageBatch;
  const group = new THREE.Group();
  group.name = 'dressing';
  const glows: GlowSpot[] = [];
  const lights: Dressing['lights'] = [];
  const R = rng(99);
  const H = (x: number, z: number) => terrain.heightAt(x, z);
  // Low props block movement but not line of sight above about crab height.
  const lowCircle = (x: number, z: number, r: number) => col?.addCircle(x, z, r, H(x, z) - 1, H(x, z) + 1.1);
  const lowBox = (x: number, z: number, hx: number, hz: number, yaw: number) => col?.addBox(x, z, hx, hz, yaw, H(x, z) - 1, H(x, z) + 1.1);
  const put = (name: string, x: number, z: number, yaw = 0, s = 1, dy = 0, pitch = 0, roll = 0) => {
    propBatch?.add(name, trs(x, H(x, z) + dy, z, yaw, s, pitch, roll));
  };
  const iron = new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.5, metalness: 0.75 });
  const ironParts: THREE.BufferGeometry[] = [];
  const warm = new THREE.Color('#ffb45a');

  // Lamp posts: iron pole, bracket lantern, warm glow.
  const lamp = (x: number, z: number, yaw: number) => {
    const y = H(x, z);
    if (gfx) {
      ironParts.push(lathe([[0.32, 0], [0.32, 0.25], [0.16, 0.4], [0.1, 0.5], [0.09, 3.3], [0.14, 3.4], [0.0, 3.55]], 8).translate(x, y, z));
      gfx.propBatch.add('Lantern_Wall', trs(x, y + 2.25, z, yaw, 0.9));
    }
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const lp = new THREE.Vector3(x + s * 1.0, y + 2.75, z + c * 1.0);
    glows.push({ pos: lp, color: warm, size: 1.6, kind: 'lamp' });
    lowCircle(x, z, 0.3);
    return lp;
  };
  for (let i = 0; i < 8; i++) {
    // The post at 112.5 degrees stood a few steps in front of the first camera at the spawn and
    // filled the left of the opening shot; it moves 15 degrees round the ring, out of that view.
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8 + (i === 2 ? THREE.MathUtils.degToRad(15) : 0);
    const x = Math.cos(a) * 13.6;
    const z = Math.sin(a) * 13.6;
    const lp = lamp(x, z, Math.atan2(-x, -z));
    if (i % 2 === 0) lights.push({ pos: lp, color: '#ffb35a', intensity: 6, distance: 16, kind: 'lamp' });
  }
  // Along the streets, alternating sides.
  for (const road of ROADS.filter((r) => r.kind === 'cobble')) {
    let acc = 0;
    let side = 1;
    for (let i = 0; i < road.points.length - 1; i++) {
      const [ax, az] = road.points[i];
      const [bx, bz] = road.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      for (let t = 11 - acc; t < len; t += 11) {
        const off = road.width / 2 + 0.8;
        const x = ax + dx * t - dz * off * side;
        const z = az + dz * t + dx * off * side;
        if (Math.hypot(x, z) < 17) continue;
        lamp(x, z, Math.atan2(dz * side, -dx * side));
        side = -side;
      }
      acc = (acc + len) % 11;
    }
  }

  // Market in the square: stalls with produce, benches around the fountain.
  const market: [string, number, number][] = [
    ['Stall_Empty', 10.2, -5.2],
    ['Stall_Empty', 10.8, 4.6],
    ['Stall_Cart_Empty', -9.6, 7.5],
    ['Stall_Empty', -10.4, -5.6],
  ];
  for (const [name, x, z] of market) {
    const yaw = Math.atan2(-x, -z);
    put(name, x, z, yaw);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (let k = -1; k <= 1; k += 2) {
      const px = x + c * 0.55 * k + s * 0.75;
      const pz = z - s * 0.55 * k + c * 0.75;
      put(R() < 0.5 ? 'FarmCrate_Apple' : 'FarmCrate_Carrot', px, pz, yaw + (R() - 0.5) * 0.4, 1, 0.82);
    }
    put('Barrel_Apples', x + s * -0.2 + c * 1.5, z + c * -0.2 - s * 1.5, R() * 6);
    lowBox(x, z, 1.2, 0.7, yaw);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 7.4;
    const z = Math.sin(a) * 7.4;
    const yaw = Math.atan2(x, z) + Math.PI / 2;
    put('Bench', x, z, yaw);
    lowBox(x, z, 1.4, 0.3, yaw);
  }

  // Barnacle Forge: anvil, workbench, weapon stand, grindstone, quench barrel, a glowing hearth.
  const forge = lotById('forge');
  const fw = (lx: number, lz: number) => atLot(forge, lx, lz);
  const fy = forge.yaw;
  let [x, z] = fw(1.2, 1.6);
  put('Anvil_Log', x, z, fy + 0.4);
  lowCircle(x, z, 0.55);
  const forgeSparks = new THREE.Vector3(x, H(x, z) + 1.15, z);
  [x, z] = fw(-2.6, -1.4);
  put('Workbench', x, z, fy);
  lowBox(x, z, 1.05, 0.55, fy);
  [x, z] = fw(4.2, 0.2);
  put('WeaponStand', x, z, fy - 0.5);
  [x, z] = fw(3.6, 3.6);
  put('Whetstone', x, z, fy + 2.2);
  lowCircle(x, z, 0.6);
  [x, z] = fw(-0.6, 3.4);
  put('Barrel', x, z, 0);
  put('Bucket_Metal', x + 0.7, z + 0.2, 1);
  lowCircle(x, z, 0.45);
  [x, z] = fw(-4.8, 4.2);
  put('Crate_Wooden', x, z, fy + 0.3);
  put('Crate_Wooden', x, z, fy + 0.9, 0.8, 0.88);
  lowCircle(x, z, 0.6);
  // Hearth: a stone block with a glowing coal bed under the chimney.
  const hx = forge.sx - 2.5;
  const hz = -forge.sz + 1.4;
  const [hwx, hwz] = fw(hx, hz);
  const hy = H(hwx, hwz);
  if (gfx) {
    const hearth = worldBox(2.6, 1.0, 1.9, 0.5).rotateY(fy).translate(hwx, hy + 0.5, hwz);
    const hearthMesh = new THREE.Mesh(hearth, gfx.village.material('MI_UnevenBrick')!);
    hearthMesh.castShadow = hearthMesh.receiveShadow = true;
    group.add(hearthMesh);
    const coals = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 1.4).rotateX(-Math.PI / 2).rotateY(fy).translate(hwx, hy + 1.02, hwz),
      new THREE.MeshStandardMaterial({ color: '#1a0802', emissive: '#ff5a10', emissiveIntensity: 3.2, roughness: 1 }),
    );
    coals.userData.flicker = true;
    group.add(coals);
  }
  col?.addBox(hwx, hwz, 1.3, 0.95, fy);
  const hearthGlow = new THREE.Vector3(hwx, hy + 1.4, hwz);
  glows.push({ pos: hearthGlow, color: new THREE.Color('#ff6a1a'), size: 3.2, kind: 'fire' });
  lights.push({ pos: hearthGlow.clone().add(new THREE.Vector3(0, 0.6, 0)), color: '#ff7a2a', intensity: 22, distance: 18, kind: 'fire' });
  const chimTop = atLot(forge, forge.sx - 2.5, -forge.sz + 0.2);
  const chimneys = [new THREE.Vector3(chimTop[0], forge.h + 9.6, chimTop[1])];

  // The Molting Kettle: terrace tables, stools, barrels, mugs and a lantern by the door.
  const tav = lotById('tavern');
  const tw = (lx: number, lz: number) => atLot(tav, lx, lz);
  for (const [lx, lz, r] of [
    [-3.2, 7.4, 0.1],
    [3.4, 7.6, -0.15],
  ] as [number, number, number][]) {
    [x, z] = tw(lx, lz);
    put('Table_Large', x, z, tav.yaw + r);
    lowBox(x, z, 1.45, 0.6, tav.yaw + r);
    for (const sx of [-0.9, 0, 0.9])
      for (const sz of [-1.0, 1.0]) {
        const [px, pz] = atLot({ ...tav, x, z, yaw: tav.yaw + r }, sx, sz);
        put('Stool', px, pz, R() * 6);
      }
    put('Mug', x + 0.3, z, R() * 6, 1, 0.81);
    put('Mug', x - 0.5, z + 0.1, R() * 6, 1, 0.81);
  }
  for (const [lx, lz] of [
    [-6.5, 5.6],
    [-7.3, 4.6],
    [6.6, 5.5],
  ] as [number, number][]) {
    [x, z] = tw(lx, lz);
    put('Barrel', x, z, R() * 6);
    lowCircle(x, z, 0.45);
  }
  [x, z] = tw(-6.9, 5.1);
  put('Barrel', x, z, R() * 6, 1, 0.9);
  [x, z] = tw(5.9, 6.4);
  put('Barrel_Holder', x, z, tav.yaw);
  lowBox(x, z, 0.7, 0.4, tav.yaw);
  // Lanterns on the facade either side of the door.
  for (const lx of [-1.6, 1.6]) {
    [x, z] = tw(lx + 2.0 * 0, tav.sz * 2 + 0.05);
    propBatch?.add('Lantern_Wall', trs(x, tav.h + 1.4, z, tav.yaw, 0.85));
    const [gx, gz] = tw(lx, tav.sz * 2 + 1.0);
    glows.push({ pos: new THREE.Vector3(gx, tav.h + 1.95, gz), color: warm, size: 1.5, kind: 'lamp' });
  }
  const [tdx, tdz] = tw(0, tav.sz * 2 + 2.5);
  lights.push({ pos: new THREE.Vector3(tdx, tav.h + 3, tdz), color: '#ffaa55', intensity: 10, distance: 18, kind: 'lamp' });
  const tavChim = tw(tav.sx * 2 - 1.1, 0);
  chimneys.push(new THREE.Vector3(tavChim[0], tav.h + 12.5, tavChim[1]));

  // Chapel of the Tide: candle stands at the door, candle clusters on the steps, flower vases.
  const ch = lotById('chapel');
  const cw = (lx: number, lz: number) => atLot(ch, lx, lz);
  for (const lx of [-2.6, 2.6]) {
    [x, z] = cw(lx, ch.sz * 2 + 1.2);
    put('CandleStick_Stand', x, z, ch.yaw);
    lowCircle(x, z, 0.4);
    glows.push({ pos: new THREE.Vector3(x, H(x, z) + 1.45, z), color: new THREE.Color('#ffc070'), size: 0.9, kind: 'candle' });
  }
  for (let i = 0; i < 14; i++) {
    const lx = (R() - 0.5) * 6.5;
    const lz = ch.sz * 2 + 2.2 + R() * 1.8;
    [x, z] = cw(lx, lz);
    if (Math.abs(lx) < 1.3) continue;
    put(R() < 0.5 ? 'Candle_1' : 'Candle_2', x, z, R() * 6, 1.4);
    glows.push({ pos: new THREE.Vector3(x, H(x, z) + 0.38, z), color: new THREE.Color('#ffc070'), size: 0.45, kind: 'candle' });
  }
  for (const lx of [-3.6, 3.6]) {
    [x, z] = cw(lx, ch.sz * 2 + 0.6);
    put('Vase_2', x, z, R() * 6);
  }
  const [clx, clz] = cw(0, ch.sz * 2 + 2.5);
  lights.push({ pos: new THREE.Vector3(clx, ch.h + 1.6, clz), color: '#ffc78a', intensity: 6, distance: 12, kind: 'candle' });

  // Homes: barrels, crates, buckets and flower vases by the doors; a few fences and a wagon.
  for (const lot of LOTS.filter((l) => l.kind === 'house' || l.kind === 'cottage' || l.kind === 'hut')) {
    const front = lot.sz + 0.8;
    const doorX = -lot.sx + 1 + 2 * Math.floor((lot.sx - 1) / 2);
    const side = R() < 0.5 ? -1 : 1;
    [x, z] = atLot(lot, doorX + side * 2.1, front);
    put(R() < 0.5 ? 'Barrel' : 'Crate_Wooden', x, z, R() * 6);
    lowCircle(x, z, 0.45);
    if (R() < 0.7) {
      [x, z] = atLot(lot, doorX - side * 1.7, front - 0.2);
      put(R() < 0.5 ? 'Vase_2' : 'Bucket_Wooden_1', x, z, R() * 6, 1.1);
    }
    if (R() < 0.45) {
      [x, z] = atLot(lot, lot.sx + 1.2, (R() - 0.5) * lot.sz);
      put('Crate_Wooden', x, z, R() * 6);
      put('Crate_Wooden', x + 0.2, z - 0.1, R() * 6, 0.85, 0.87);
      lowCircle(x, z, 0.6);
    }
  }
  // Fenced kitchen gardens behind two houses.
  for (const id of ['h-w1', 'h-s3', 'h-d']) {
    const lot = lotById(id);
    for (let i = 0; i < 4; i++) {
      [x, z] = atLot(lot, -lot.sx + 1 + i * 2.05, -lot.sz - 3.5);
      villageBatch?.add(i % 3 === 0 ? 'Prop_WoodenFence_Single' : 'Prop_WoodenFence_Extension1', trs(x, H(x, z), z, lot.yaw));
    }
  }
  villageBatch?.add('Prop_Wagon', trs(58, H(58, 9), 9, 0.4));
  col?.addBox(58, 9, 1.0, 2.2, 0.4);
  put('Dummy', 59, -8, 1.2);
  col?.addCircle(59, -8, 0.45);

  // Gate arch between the watch towers, with a lantern each side.
  const gn = lotById('gate-n');
  const gs = lotById('gate-s');
  const gy = Math.min(gn.h, gs.h);
  const archLen = Math.abs(gs.z - gn.z) - 4;
  const planks = gfx ? plankMaterial() : null;
  if (planks) {
    const arch = mergeAll([
      worldBox(1.0, 0.8, archLen + 1.2, 0.5).translate(gn.x, gy + 5.6, (gn.z + gs.z) / 2),
      worldBox(1.3, 0.35, archLen + 1.6, 0.5).translate(gn.x, gy + 6.15, (gn.z + gs.z) / 2),
    ]);
    const archMesh = new THREE.Mesh(arch, planks);
    archMesh.castShadow = archMesh.receiveShadow = true;
    group.add(archMesh);
  }
  for (const zz of [gn.z + 2.3, gs.z - 2.3]) {
    propBatch?.add('Lantern_Wall', trs(gn.x - 1.0, gy + 3.6, zz, -Math.PI / 2, 0.9));
    glows.push({ pos: new THREE.Vector3(gn.x - 2.05, gy + 4.15, zz), color: warm, size: 1.6, kind: 'lamp' });
  }
  lights.push({ pos: new THREE.Vector3(gn.x - 3, gy + 4, (gn.z + gs.z) / 2), color: '#ffb35a', intensity: 6, distance: 14, kind: 'lamp' });
  for (const lot of [gn, gs]) {
    const bx = lot.x - 2.1;
    propBatch?.add('Banner_1', trs(bx, lot.h + 5.2, lot.z + (lot === gn ? -0.8 : 0.8), -Math.PI / 2, 1.1));
  }

  // The pier: plank deck on posts, mooring bollards, crates, a rowboat.
  const { x0, x1, z: dz, width, y: dy, headZ0, headZ1, headX0 } = DOCK;
  // Plank ramp from the sand up onto the pier.
  const rampLen = 5;
  const rampFoot = H(x0 - rampLen, dz);
  if (gfx) {
    const dockWood = planks!;
    const dockParts: THREE.BufferGeometry[] = [];
    for (let xx = x0; xx < x1; xx += 2) for (let zz = dz - width / 2 + 1; zz < dz + width / 2; zz += 2) gfx.villageBatch.add('Floor_WoodDark', trs(xx + 1, dy, zz, 0));
    for (let xx = headX0; xx < x1; xx += 2) for (let zz = headZ0 + 1; zz < headZ1; zz += 2) if (Math.abs(zz - dz) > width / 2) gfx.villageBatch.add('Floor_WoodDark', trs(xx + 1, dy, zz, 0));
    const post = (px: number, pz: number) => {
      const g = H(px, pz);
      const top = dy + 0.6;
      dockParts.push(new THREE.CylinderGeometry(0.18, 0.22, top - g + 2, 7).translate(px, (top + g - 2) / 2, pz));
    };
    for (let xx = x0 + 1; xx <= x1; xx += 3.5) for (const zz of [dz - width / 2, dz + width / 2]) post(xx, zz);
    for (let zz = headZ0; zz <= headZ1; zz += 4) for (const xx of [headX0, x1]) post(xx, zz);
    dockParts.push(worldBox(x1 - x0, 0.3, 0.35, 1).translate((x0 + x1) / 2, dy - 0.25, dz - width / 2));
    dockParts.push(worldBox(x1 - x0, 0.3, 0.35, 1).translate((x0 + x1) / 2, dy - 0.25, dz + width / 2));
    const dockMesh = new THREE.Mesh(mergeAll(dockParts), dockWood);
    dockMesh.castShadow = dockMesh.receiveShadow = true;
    group.add(dockMesh);
  }
  if (col) {
    col.addSurface(rectSurface((x0 + x1) / 2, dz, (x1 - x0) / 2 + 0.3, width / 2, 0, dy));
    col.addSurface(rectSurface(x0 - rampLen / 2, dz, rampLen / 2, width / 2, 0, (rampFoot + dy) / 2, (dy - rampFoot) / rampLen, 0));
    col.addSurface(rectSurface((headX0 + x1) / 2, (headZ0 + headZ1) / 2, (x1 - headX0) / 2, (headZ1 - headZ0) / 2, 0, dy));
    // Dock railings as walls along the open sides (keep the beach end open).
    col.addWall(x0 + 6, dz - width / 2, headX0, dz - width / 2, 0.2);
    col.addWall(x0 + 6, dz + width / 2, headX0, dz + width / 2, 0.2);
    col.addWall(headX0, headZ0, x1, headZ0, 0.2);
    col.addWall(headX0, headZ1, x1, headZ1, 0.2);
    col.addWall(x1, headZ0, x1, headZ1, 0.2);
    col.addWall(headX0, headZ0, headX0, dz - width / 2, 0.2);
    col.addWall(headX0, dz + width / 2, headX0, headZ1, 0.2);
  }
  for (const [px, pz, name, rot] of [
    [143, 17, 'Barrel', 0.2],
    [144.2, 17.3, 'Crate_Wooden', 0.6],
    [143.5, 29, 'Rope_2', 0],
    [131, 21.6, 'Chain_Coil', 0.4],
    [141.5, 30, 'Crate_Wooden', 1.4],
  ] as [number, number, string, number][]) {
    propBatch?.add(name, trs(px, dy, pz, rot));
    if (name === 'Barrel' || name === 'Crate_Wooden') col?.addCircle(px, pz, 0.5);
  }
  propBatch?.add('Lantern_Wall', trs(x1 - 0.2, dy + 0.4, headZ1 - 0.3, Math.PI, 0.9));
  glows.push({ pos: new THREE.Vector3(x1 - 0.2, dy + 0.95, headZ1 - 1.3), color: warm, size: 1.5, kind: 'lamp' });
  // Rowboats moored at the pier head.
  const boatGeo = gfx
    ? lathe(
        [
          [0.0, -0.45],
          [0.55, -0.4],
          [0.85, -0.15],
          [0.95, 0.25],
          [0.9, 0.3],
          [0.8, 0.05],
          [0.0, 0.0],
        ],
        16,
        0.6,
      ).scale(1, 1, 2.6)
    : null;
  const boatMat = new THREE.MeshStandardMaterial({ color: '#7a4a2a', roughness: 0.8 });
  const boatTrim = new THREE.MeshStandardMaterial({ color: '#b8342a', roughness: 0.6 });
  for (const [bx, bz, r] of [
    [149, 18.5, 0.15],
    [148.5, 26.5, -0.1],
    [133, 29, 1.2],
  ] as [number, number, number][]) {
    const plain = R() < 0.5;
    const bob = R() * 6;
    if (!boatGeo) continue;
    const b = new THREE.Mesh(boatGeo, plain ? boatMat : boatTrim);
    if(bx===149)b.name='shore-rideable-rowboat';
    b.position.set(bx, 0.15, bz);
    b.rotation.set(0, r + Math.PI / 2, 0.04);
    b.castShadow = b.receiveShadow = true;
    b.userData.bob = bob;
    group.add(b);
  }

  // Moonpool Grove: the glowing pool, a ring of standing moonstones with runes.
  const poolY = GROVE.h - 0.55;
  let pool!: THREE.Mesh;
  if (gfx) {
    const sky = gfx.sky;
    const poolMat = new THREE.ShaderMaterial({
      uniforms: { ...(sky as unknown as Record<string, THREE.IUniform>), uPoolGlow: { value: 1 }, uCentre: { value: new THREE.Vector3(GROVE.x, poolY, GROVE.z) } },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${CC_SKY_UNIFORMS}
        ${CC_SKY}
        uniform float uPoolGlow;
        uniform vec3 uCentre;
        varying vec3 vW;
        void main() {
          vec2 d = vW.xz - uCentre.xz;
          float r = length(d);
          float t = uTime;
          float ripple = sin(r * 5.0 - t * 1.2) * 0.5 + 0.5;
          vec2 g = vec2(cc_vnoise(vW.xz * 1.6 + t * 0.3), cc_vnoise(vW.zx * 1.6 - t * 0.25)) - 0.5;
          vec3 n = normalize(vec3(g.x * 0.25, 1.0, g.y * 0.25));
          vec3 v = normalize(cameraPosition - vW);
          vec3 rf = reflect(-v, n);
          rf.y = abs(rf.y);
          float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
          float caust = pow(cc_vnoise(vW.xz * 2.2 + vec2(t * 0.35, -t * 0.2)) * cc_vnoise(vW.zx * 1.9 - t * 0.3) * 2.0, 2.0);
          vec3 deep = vec3(0.0, 0.10, 0.20);
          vec3 glow = vec3(0.08, 0.85, 1.0);
          float centre = exp(-r * 0.35);
          vec3 col = deep + glow * (0.18 + 0.55 * centre + caust * 0.45 + ripple * 0.08 * centre) * uPoolGlow;
          col = mix(col, ccSky(rf, 0.0) + vec3(1.0, 0.97, 0.88) * pow(max(dot(rf, uMoonDir), 0.0), 400.0) * 8.0 * uMoon, fres * 0.3);
          float rim = smoothstep(${(GROVE.poolR - 0.6).toFixed(2)}, ${(GROVE.poolR + 0.6).toFixed(2)}, r);
          col += vec3(0.6, 1.0, 0.95) * rim * 0.35 * uPoolGlow;
          gl_FragColor = vec4(col, 0.92);
        }`,
      transparent: true,
    });
    pool = new THREE.Mesh(new THREE.CircleGeometry(GROVE.poolR + 0.9, 48).rotateX(-Math.PI / 2), poolMat);
    pool.position.set(GROVE.x, poolY, GROVE.z);
    pool.renderOrder = 3;
    group.add(pool);
  }
  col?.addCircle(GROVE.x, GROVE.z, GROVE.poolR + 0.3);
  const stoneParts: THREE.BufferGeometry[] = [];
  const runeParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.35;
    const r = GROVE.poolR + 3.4;
    const sx = GROVE.x + Math.cos(a) * r;
    const sz = GROVE.z + Math.sin(a) * r;
    if (Math.hypot(sx - (GROVE.x + 7), sz - (GROVE.z - 4)) < 3.5) continue; // keep the path in clear
    const h = 2.6 + R() * 1.4;
    const g = H(sx, sz);
    if (gfx) {
      const yaw = -a + Math.PI / 2;
      stoneParts.push(new THREE.CylinderGeometry(0.42, 0.62, h, 6, 1).scale(1.3, 1, 0.75).rotateY(yaw).translate(sx, g + h / 2 - 0.3, sz));
      stoneParts.push(new THREE.ConeGeometry(0.55, 0.7, 6).scale(1.2, 1, 0.7).rotateY(yaw).translate(sx, g + h - 0.3 + 0.3, sz));
      const facing = Math.atan2(-Math.cos(a), -Math.sin(a));
      runeParts.push(new THREE.PlaneGeometry(0.22, h * 0.5).rotateY(facing).translate(sx - Math.cos(a) * 0.5, g + h * 0.45, sz - Math.sin(a) * 0.5));
    }
    col?.addCircle(sx, sz, 0.7);
    glows.push({ pos: new THREE.Vector3(sx - Math.cos(a) * 0.62, g + h * 0.45, sz - Math.sin(a) * 0.62), color: new THREE.Color('#5ff6ff'), size: 0.7, kind: 'magic' });
  }
  lights.push({ pos: new THREE.Vector3(GROVE.x, GROVE.h + 1.2, GROVE.z), color: '#59e8ff', intensity: 14, distance: 22, kind: 'magic' });
  glows.push({ pos: new THREE.Vector3(GROVE.x, poolY + 0.3, GROVE.z), color: new THREE.Color('#58f0ff'), size: 9, kind: 'magic' });
  if (!gfx) return null;

  const stones = new THREE.Mesh(mergeAll(stoneParts), new THREE.MeshStandardMaterial({ color: '#8a8fa4', roughness: 0.8, flatShading: true }));
  stones.castShadow = stones.receiveShadow = true;
  group.add(stones);
  const runes = new THREE.Mesh(mergeAll(runeParts), new THREE.MeshBasicMaterial({ color: new THREE.Color('#6ff8ff').multiplyScalar(2.2), side: THREE.DoubleSide }));
  runes.userData.rune = true;
  group.add(runes);
  // A soft shaft of moonlight falling on the pool.
  const moonbeam = new THREE.ShaderMaterial({
    uniforms: { uTime: gfx.sky.uTime, uStrength: { value: 0.12 } },
    vertexShader: /* glsl */ `
      varying float vH;
      varying vec3 vN;
      varying vec3 vVP;
      varying vec2 vUv;
      void main() {
        vH = uv.y;
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vVP = mv.xyz;
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${GLSL_NOISE}
      uniform float uTime;
      uniform float uStrength;
      varying float vH;
      varying vec3 vN;
      varying vec3 vVP;
      varying vec2 vUv;
      void main() {
        float facing = pow(abs(dot(normalize(vN), normalize(-vVP))), 3.0);
        float fall = (1.0 - vH) * smoothstep(0.0, 0.08, vH) + 0.15 * (1.0 - vH);
        float motes = 0.75 + 0.25 * cc_vnoise(vec2(vUv.x * 20.0, vH * 6.0 - uTime * 0.15));
        float a = facing * fall * motes * uStrength;
        gl_FragColor = vec4(vec3(0.55, 0.85, 1.0) * a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4.2, GROVE.poolR - 0.5, 40, 32, 1, true).translate(0, 20, 0), moonbeam);
  shaft.position.set(GROVE.x + 2.5, poolY, GROVE.z - 1.5);
  shaft.rotation.z = -0.12;
  shaft.renderOrder = 6;
  group.add(shaft);

  const ironMesh = new THREE.Mesh(mergeAll(ironParts), iron);
  ironMesh.castShadow = true;
  ironMesh.receiveShadow = true;
  group.add(ironMesh);
  void TOWN_H;
  void GLSL_NOISE;
  return { group, glows, lights, forgeSparks, chimneys, groveWater: pool, moonbeam };
}
