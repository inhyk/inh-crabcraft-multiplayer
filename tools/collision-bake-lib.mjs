// Shared by tools/bake-collision.mjs, tools/qa-collision-bake.mjs and tests/collision-bake.test.mjs:
// bundles the bake entry for Node, hashes every file it reads, and writes the baked files.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require('esbuild'); } catch { esbuild = require(require.resolve('esbuild', { paths: [require.resolve('wrangler')] })); }

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORLDS = ['w1', 'w2', 'w3'];
export const bakedPath = (w) => join(ROOT, 'public/world', `collision-${w}.json`);
/** The kit whose piece names the bake reads (World II's forest needs its trees). */
const NATURE_GLB = 'public/models/world/nature.glb';
/** Files that shape the output besides the bundle's own sources. */
const EXTRA_INPUTS = [NATURE_GLB, 'tools/collision-bake-lib.mjs', 'node_modules/three/package.json'];

/** Bundle a TypeScript entry for Node; returns the module path and the source files it read. */
export async function bundle(entry, name) {
  const outfile = join(ROOT, 'tmp/collision-bake', `${name}.mjs`);
  const r = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile,
    metafile: true,
    logLevel: 'warning',
    // src/core/assets reads Vite's import.meta.env at load.
    define: { 'import.meta.env': '{"BASE_URL":"./"}' },
  });
  const inputs = Object.keys(r.metafile.inputs).filter((p) => !p.includes('node_modules/') && !p.startsWith('<'));
  return { url: `${pathToFileURL(outfile).href}?t=${Date.now()}`, inputs, imports: Object.values(r.metafile.outputs).flatMap(o => o.imports) };
}

/** sha256 over the bake's sources, the kit it reads and three.js's version. */
export function sourceHash(inputs) {
  const h = createHash('sha256');
  for (const p of [...new Set([...inputs, ...EXTRA_INPUTS])].sort()) {
    h.update(p);
    h.update('\0');
    h.update(readFileSync(join(ROOT, p)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Top-level node names of a GLB, as loadKit names its pieces (GLTFLoader sanitises them). */
export function glbPieceNames(path = NATURE_GLB) {
  const b = readFileSync(join(ROOT, path));
  if (b.toString('utf8', 0, 4) !== 'glTF' || b.toString('utf8', 16, 20) !== 'JSON') throw new Error(`${path} is not a GLB`);
  const json = JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12)));
  const scene = json.scenes[json.scene ?? 0];
  return scene.nodes.map((n) => (json.nodes[n].name ?? '').replace(/\s/g, '_').replace(/[[\].:/]/g, ''));
}

/** Bundle the bake entry and run it: { baked: {w1, w2, w3}, source, inputs }. */
export async function runBake() {
  const { url, inputs } = await bundle('src/game/collisionBake.ts', 'bake');
  const source = sourceHash(inputs);
  const { bakeWorlds } = await import(url);
  return { baked: bakeWorlds(glbPieceNames(), source), source, inputs };
}

/** Stable text: one key per line, one shape per line, so diffs stay readable. */
export function serialize(b) {
  const lines = ['{'];
  const keys = Object.keys(b);
  keys.forEach((k, i) => {
    const end = i === keys.length - 1 ? '' : ',';
    if (k === 'shapes') lines.push(`"shapes":[`, ...b.shapes.map((s, j) => JSON.stringify(s) + (j === b.shapes.length - 1 ? '' : ',')), `]${end}`);
    else lines.push(`${JSON.stringify(k)}:${JSON.stringify(b[k])}${end}`);
  });
  lines.push('}', '');
  return lines.join('\n');
}

export function writeBaked(baked) {
  mkdirSync(join(ROOT, 'public/world'), { recursive: true });
  for (const w of WORLDS) writeFileSync(bakedPath(w), serialize(baked[w]));
}

export const readBaked = (w) => JSON.parse(readFileSync(bakedPath(w), 'utf8'));

/** The sim loader bundled on its own: proves it needs nothing but numbers. */
export async function loadSim() {
  const { url } = await bundle('src/sim/world/baked.ts', 'sim-baked');
  return import(url);
}

/** Where each world is sampled: x0, x1, z0, z1. */
export const SAMPLE_BOX = { w1: [-230, 270, -250, 250], w2: [-140, 140, -150, 170], w3: [-150, 150, -175, 175] };

/**
 * Query points: a jittered 100 x 100 grid over the world, plus two points at every solid (inside
 * and just past its edge) so pushes are exercised. Rows: [x, z, radius, rayEndX, rayEndZ, rayY0, rayY1].
 */
export function samplePoints(world, baked, n = 100) {
  const [x0, x1, z0, z1] = SAMPLE_BOX[world];
  const pts = [];
  const ray = (k, x, z) => {
    const a = k * 2.39996, len = 4 + (k % 7) * 2.5;
    return [x + Math.cos(a) * len, z + Math.sin(a) * len, 1.2 + (k % 4) * 0.6, 1.2 + (k % 5) * 0.5];
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = x0 + ((i + 0.5 + 0.37 * Math.sin(k * 1.7)) * (x1 - x0)) / n;
      const z = z0 + ((j + 0.5 + 0.37 * Math.cos(k * 2.3)) * (z1 - z0)) / n;
      pts.push([x, z, [0.5, 0.8, 1.3][k % 3], ...ray(k, x, z)]);
    }
  baked.shapes.forEach((s, i) => {
    const reach = s[0] === 0 ? s[3] : Math.min(s[3], s[4]);
    for (const f of [0.6, 1.15]) {
      const a = i * 2.4, k = pts.length;
      const x = s[1] + Math.cos(a) * reach * f, z = s[2] + Math.sin(a) * reach * f;
      pts.push([x, z, [0.5, 0.8, 1.3][k % 3], ...ray(k, x, z)]);
    }
  });
  return pts;
}

/** Runs heightAt, resolveCollision and raycastSolid at each point. Self-contained: it is also sent to the page. */
export function runQueries(q, pts) {
  const out = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } };
  return pts.map(([x, z, r, bx, bz, y0, y1]) => {
    const h = q.heightAt(x, z);
    q.resolveCollision(x, z, r, out);
    const hit = q.raycastSolid({ x, y: h + y0, z }, { x: bx, y: q.heightAt(bx, bz) + y1, z: bz });
    return [h, out.x, out.y, hit];
  });
}

/** Largest differences between two runQueries results. */
export function compareRuns(a, b) {
  const d = { points: a.length, height: 0, resolve: 0, ray: 0, rayHitMismatch: 0 };
  for (let i = 0; i < a.length; i++) {
    const [h0, x0, z0, r0] = a[i], [h1, x1, z1, r1] = b[i];
    d.height = Math.max(d.height, Math.abs(h0 - h1));
    d.resolve = Math.max(d.resolve, Math.abs(x0 - x1), Math.abs(z0 - z1));
    if ((r0 === null) !== (r1 === null)) d.rayHitMismatch++;
    else if (r0 !== null) d.ray = Math.max(d.ray, Math.abs(r0 - r1));
  }
  return d;
}

/** First difference between two baked files beyond float noise (|a - b| > 1e-6), ignoring `source`. */
export function bakedDifference(a, b, decodeFloats, path = '') {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 ? null : `${path}: ${a} != ${b}`;
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return null;
    if (!path.endsWith('.h')) return `${path} differs`;
    const fa = decodeFloats(a), fb = decodeFloats(b);
    if (fa.length !== fb.length) return `${path}: ${fa.length} != ${fb.length} heights`;
    for (let i = 0; i < fa.length; i++) if (Math.abs(fa[i] - fb[i]) > 1e-6) return `${path}[${i}]: ${fa[i]} != ${fb[i]}`;
    return null;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: ${a.length} != ${b.length} entries`;
    for (let i = 0; i < a.length; i++) {
      const d = bakedDifference(a[i], b[i], decodeFloats, `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== 'source'));
    for (const k of keys) {
      const d = bakedDifference(a[k], b[k], decodeFloats, `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}
