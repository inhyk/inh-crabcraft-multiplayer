// The baked collision (public/world/collision-w*.json) must match the layout it was baked from, and the
// numbers-only loader in src/sim/world must answer exactly like the collision the browser builds.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bundle, bakedDifference, compareRuns, glbPieceNames, loadSim, readBaked, runBake, runQueries, samplePoints, WORLDS } from '../tools/collision-bake-lib.mjs';

test('baked collision files are up to date with the layout and collision sources', async () => {
  const [{ baked, source }, sim] = await Promise.all([runBake(), loadSim()]);
  for (const w of WORLDS) {
    const disk = readBaked(w);
    const diff = bakedDifference(disk, baked[w], sim.base64ToFloats);
    assert.equal(diff, null, `public/world/collision-${w}.json is stale (${diff}). Run: node tools/bake-collision.mjs`);
    assert.equal(disk.source, source, `${w}: source changed; run node tools/bake-collision.mjs`);
  }
});

test('the loader answers heightAt, resolveCollision and raycastSolid like the live collision', async () => {
  const [{ url }, sim] = await Promise.all([bundle('src/game/collisionBake.ts', 'bake-live'), loadSim()]);
  const live = (await import(url)).layoutWorlds(glbPieceNames());
  for (const w of WORLDS) {
    const data = readBaked(w);
    const loaded = sim.loadBakedWorld(data);
    assert.equal(loaded.collision.shapes.length, live[w].col.shapes.length);
    const pts = samplePoints(w, data);
    const d = compareRuns(runQueries(live[w], pts), runQueries(loaded, pts));
    assert.ok(pts.length >= 10000, `${w}: ${pts.length} points`);
    assert.equal(d.rayHitMismatch, 0, `${w}: line of sight disagrees`);
    for (const k of ['height', 'resolve', 'ray']) assert.ok(d[k] <= 1e-6, `${w}: ${k} differs by ${d[k]}`);
    console.log(`# ${w}: ${JSON.stringify(d)}`);
  }
});

// Graphic settings may reduce decoration, never the tree/rock walls used by the server.
test('low and high quality share the same solid collision and queries', async () => {
  const { url } = await bundle('src/game/collisionBake.ts', 'quality-layouts');
  const { layoutWorlds } = await import(url);
  const high = layoutWorlds(glbPieceNames(), 'high'), low = layoutWorlds(glbPieceNames(), 'low');
  for (const w of WORLDS) {
    assert.deepEqual(low[w].col.shapes, high[w].col.shapes, `${w}: solids depend on quality`);
    const pts = samplePoints(w, readBaked(w));
    assert.deepEqual(runQueries(low[w], pts), runQueries(high[w], pts), `${w}: queries depend on quality`);
  }
});

test('the standalone collision loader has no render, asset or Node dependencies', async () => {
  const { inputs, imports } = await bundle('src/sim/world/baked.ts', 'boundary');
  assert.ok(inputs.every(p => p.startsWith('src/sim/world/')), inputs.join(', '));
  assert.deepEqual(imports, []);
});
