// World II's colliders, registered without meshes. HiddenWorld builds them this way in the browser;
// tools/bake-collision.mjs bakes the same registration for the server.
import * as THREE from 'three';
import { Collision } from '../world/collision';
import { facetedStarCrystal, starCrystalRadius } from './starCrystal';
import { throneSolids } from './starThrone';
import { registerStarVillageLife } from './world2Life';
import { nearStarObjective, registerStarSettlement, STAR_OBJECTIVES, starTrailDistance } from './world2Settlement';

const rand = (i: number) => {
  const x = Math.sin(i * 127.1 + 41.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Jagged crystal gardens frame the open combat paths; spots on paths and plazas stay clear. */
export function starCrystalGarden(height: (x: number, z: number) => number) {
  const geometry = facetedStarCrystal();
  const out = [];
  for (let i = 0; i < 90; i++) {
    const a = rand(i + 1) * Math.PI * 2,
      r = 58 + rand(i + 120) * 48,
      x = Math.sin(a) * r,
      z = 10 + Math.cos(a) * r,
      h = 1.5 + rand(i + 250) * 6,
      width = 0.7 + rand(i + 300),
      scale = new THREE.Vector3(width, h, 1);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(i) * 0.25, a, 0.15));
    const radius = Math.max(Math.max(width, 1) + h * 0.15, starCrystalRadius(geometry, scale, q));
    const clear = (Math.abs(x) < 55 && z > 0 && z < 104) || Math.hypot(x, z + 75) < 27 || starTrailDistance(x, z) < radius + 2 || nearStarObjective(x, z, radius);
    const y = clear ? 0 : height(x, z);
    out.push({ x, z, y, h, q, scale, clear, solid: { x, z, r: radius, y0: y - 0.5, y1: y + h * 1.6 } });
  }
  geometry.dispose();
  return out;
}

export function layoutStarhaven(height: (x: number, z: number) => number, natureNames: readonly string[]) {
  const terrain = { minX: -140, minZ: -150, step: 2, nx: 141, nz: 161, heightAt: height, h: new Float32Array(141 * 161) };
  for (let j = 0; j < terrain.nz; j++) for (let i = 0; i < terrain.nx; i++) terrain.h[j * terrain.nx + i] = height(terrain.minX + i * 2, terrain.minZ + j * 2);
  const col = new Collision(terrain);
  registerStarSettlement(height, col, natureNames);
  const obstacles = throneSolids();
  for (const o of obstacles) col.addCircle(o.x, o.z, o.r, height(o.x, o.z), height(o.x, o.z) + 12);
  for (const c of starCrystalGarden(height)) if (!c.clear) col.addCircle(c.solid.x, c.solid.z, c.solid.r, c.solid.y0, c.solid.y1);
  registerStarVillageLife(height, col);
  // Quest props: waystone frames and ore beds.
  for (const [kind, [x, z]] of Object.entries(STAR_OBJECTIVES)) {
    const y = height(x, z);
    if (kind.startsWith('lamp-')) col.addCircle(x, z, 0.88, y, y + 3.15);
    else if (kind.startsWith('crystal-')) col.addCircle(x, z, 1.05, y, y + 0.4);
  }
  return { col, obstacles };
}
