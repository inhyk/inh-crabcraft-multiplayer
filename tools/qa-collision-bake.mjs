#!/usr/bin/env node
// Compares the baked collision (public/world/collision-w*.json, loaded in Node by src/sim/world) with
// the collision of a real browser world. For each world it checks that the browser registered the same
// solids, surfaces, blocked cells and ground heights, then runs heightAt, resolveCollision and
// raycastSolid at the same points (a 100 x 100 grid plus two points at every solid) on both sides.
//   node tools/qa-collision-bake.mjs [--url http://localhost:4173/] [--quality high]
// Needs a dev or preview server (pnpm build && pnpm preview). Both quality settings must use
// the same solid placements; only visual decoration and detail may change.
// Tolerance: Chrome's Math.sin, cos, atan2 and exp differ from Node's in the last bit, so colliders
// placed with them (box angles, World II's sin-hash scatter) agree to about 1e-9, not exactly.
import { chromium } from 'playwright';
import { compareRuns, loadSim, readBaked, runQueries, samplePoints, WORLDS } from './collision-bake-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const url = opt('--url', process.env.CC_QA_URL ?? 'http://localhost:4173/');
const quality = opt('--quality', 'high');
const TOL = 1e-6;

const sim = await loadSim();
const browser = await chromium.launch({ channel: 'chrome', headless: !args.includes('--headed'), args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((q) => {
    localStorage.setItem('cc.hintsSeen', '1');
    localStorage.setItem('cc.quality', q);
  }, quality);
  await page.goto(`${url}?screen=game`);
  await page.locator('.launch-notice-start').click({ timeout: 60000 });
  await page.waitForFunction(() => window.app?.current?.game?.loaded, null, { timeout: 180000 });
  for (const w of WORLDS) {
    const baked = readBaked(w);
    const pts = samplePoints(w, baked);
    const browserSide = await page.evaluate(
      ([w, src, pts]) => {
        const g = window.app.current.game;
        g.creatorTravel = true;
        g.world2.go(w === 'w1' ? 1 : w === 'w2' ? 2 : 3);
        const col = w === 'w1' ? g.world.debug.collision : w === 'w2' ? g.world2.collision : g.world2.third.collision;
        const shapes = col.shapes.map((s) => (s.kind === 0 ? [0, s.c.x, s.c.z, s.c.r, s.c.y0, s.c.y1, s.c.los ? 1 : 0] : [1, s.b.x, s.b.z, s.b.hx, s.b.hz, s.b.c, s.b.s, s.b.y0, s.b.y1, s.b.los ? 1 : 0]));
        const blocked = [];
        col.blocked.forEach((b, i) => b && blocked.push(i));
        const t = col.terrain;
        const ground = w === 'w1' ? Array.from(t.h) : w === 'w2' ? Array.from(g.world2.groundHeights) : null;
        const run = new Function(`return ${src}`)();
        return { quality: window.app.engine.quality, shapes, surfaces: col.surfaces.map((s) => s.spec), blocked, cells: [t.minX, t.minZ, t.step, t.nx, t.nz], ground, rows: run(g.world, pts) };
      },
      [w, runQueries.toString(), pts],
    );
    const loaded = sim.loadBakedWorld(baked);
    const bakedBlocked = [];
    loaded.collision.blocked.forEach((b, i) => b && bakedBlocked.push(i));
    const c = baked.cells;
    const bakedGround = baked.ground.kind === 'dawn' ? null : Array.from(sim.base64ToFloats(baked.ground.h));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // Largest numeric difference between two structures, or Infinity if their shapes differ.
    const maxDiff = (a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b);
      if (Array.isArray(a) && Array.isArray(b)) return a.length !== b.length ? Infinity : a.reduce((m, v, i) => Math.max(m, maxDiff(v, b[i])), 0);
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = Object.keys(a);
        return same(keys, Object.keys(b)) ? keys.reduce((m, k) => Math.max(m, maxDiff(a[k], b[k])), 0) : Infinity;
      }
      return a === b ? 0 : Infinity;
    };
    const describe = (n, d) => (d === 0 ? `${n} identical` : d <= TOL ? `${n} within ${d.toExponential(1)}` : `DIFFER (${d})`);
    const checks = {
      quality: browserSide.quality === quality ? browserSide.quality : `DIFFER (${browserSide.quality}, asked ${quality})`,
      solids: describe(baked.shapes.length, maxDiff(browserSide.shapes, baked.shapes)),
      surfaces: describe(baked.surfaces.length, maxDiff(browserSide.surfaces, baked.surfaces)),
      blocked: same(browserSide.blocked, bakedBlocked) && same(browserSide.cells, [c.minX, c.minZ, c.step, c.nx, c.nz]) ? `${bakedBlocked.length} cells identical` : 'DIFFER',
      ground: bakedGround ? describe(bakedGround.length, maxDiff(browserSide.ground, bakedGround)) : 'formula',
    };
    const d = compareRuns(browserSide.rows, runQueries(loaded, pts));
    const ok = !Object.values(checks).some((v) => String(v).includes('DIFFER')) && d.height <= TOL && d.resolve <= TOL && d.ray <= TOL && d.rayHitMismatch === 0;
    failed ||= !ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${w}`, JSON.stringify({ ...checks, points: d.points, maxDiff: { heightAt: d.height, resolveCollision: d.resolve, raycastSolid: d.ray }, rayHitMismatch: d.rayHitMismatch }));
  }
  if (errors.length) {
    failed = true;
    console.log('page errors:', errors);
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
