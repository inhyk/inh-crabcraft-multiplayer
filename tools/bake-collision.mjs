#!/usr/bin/env node
// Bakes every world's colliders to public/world/collision-w{1,2,3}.json for the server (numbers only,
// loaded by src/sim/world/baked.ts). Runs the same layout functions the browser runs, in Node,
// without the GLB kits; only the nature kit's piece names are read from its file.
//   node tools/bake-collision.mjs           # write the files
//   node tools/bake-collision.mjs --check   # exit 1 if the files on disk differ from a fresh bake
import { readFileSync } from 'node:fs';
import { bakedPath, bakedDifference, loadSim, runBake, WORLDS, writeBaked } from './collision-bake-lib.mjs';

const t0 = performance.now();
const { baked, source, inputs } = await runBake();
const ms = Math.round(performance.now() - t0);
if (process.argv.includes('--check')) {
  const sim = await loadSim();
  const stale = WORLDS.filter((w) => {
    try { const disk = JSON.parse(readFileSync(bakedPath(w), 'utf8')); return disk.source !== source || bakedDifference(disk, baked[w], sim.base64ToFloats) !== null; } catch { return true; }
  });
  if (stale.length) {
    console.error(`stale: ${stale.map((w) => `public/world/collision-${w}.json`).join(', ')}. Run node tools/bake-collision.mjs`);
    process.exit(1);
  }
  console.log(`collision bake up to date (${inputs.length} sources, ${ms} ms)`);
} else {
  writeBaked(baked);
  for (const w of WORLDS) {
    const b = baked[w];
    console.log(`public/world/collision-${w}.json  ${b.shapes.length} solids, ${b.surfaces.length} surfaces, ${readFileSync(bakedPath(w)).length} bytes`);
  }
  console.log(`source ${source.slice(0, 12)} from ${inputs.length} files, ${ms} ms`);
}
