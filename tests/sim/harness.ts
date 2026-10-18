// The spike's headless area (server/sim/spike) as a test harness: the shipped Player, abilities,
// Combat, Enemy, Boss, Unit and projectiles in Node, with a recording event sink and traps that
// record any touch of the HUD, effects, audio, camera or "the" local player. Bundled by
// tests/run-sim.mjs into tmp/test-modules/sim-harness.js for tests/sim-*.test.mjs.
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { SimGame, stubRig } from '../../server/sim/spike/sim';
import type { SimEvent } from '../../src/game/events';
import type { Unit } from '../../src/game/unit';
import { createMotionController } from '../../src/motion/controller';
import { MotionLibrary, type ClipId } from '../../src/motion/library';
import type { MotionId, MotionPlayOptions } from '../../src/motion/types';
import { POI_DEFS } from '../../src/world/layout';
import type { Poi, PoiId, World } from '../../src/world/types';

export { SimGame, SimClient, trap, stubMotion } from '../../server/sim/spike/sim';
export { createHeadlessWorld } from '../../server/sim/spike/world';
export { CLASSES } from '../../src/data/classes';
export { BOSS_PROFILES } from '../../src/game/progression';
export { ENEMY_STATS } from '../../src/game/enemies';
export { actionHitDelay, skillWindow, skillDelay } from '../../src/motion/skills';

/** Open level ground at `height` with the World I points of interest, no walls, nothing in the way. */
export function flatWorld(height = 0): World {
  const pois = {} as Record<PoiId, Poi>;
  for (const [id, d] of Object.entries(POI_DEFS) as [PoiId, (typeof POI_DEFS)[PoiId]][]) {
    pois[id] = { id, position: new THREE.Vector3(d.x, height, d.z), yaw: d.yaw, radius: d.radius };
  }
  return {
    root: new THREE.Group(),
    pois,
    spawns: [],
    heightAt: () => height,
    resolveCollision: (x, z, _r, out) => out.set(x, z),
    raycastSolid: () => null,
    update() {},
    setBeaconLit() {},
    setMood() {},
    getEnvironment: () => ({ mood: 1, beacon: true }),
    dispose() {},
  };
}

/** A SimGame on flat ground that records every event it emits, stamped with the game time. */
export function recordingGame(world: World = flatWorld()): { game: SimGame; events: (SimEvent & { at: number })[] } {
  const game = new SimGame(world, 'normal');
  const events: (SimEvent & { at: number })[] = [];
  game.onEvent = (e) => events.push({ ...e, at: game.time });
  return { game, events };
}

/** Step the game (no bots) until `until` returns true or `seconds` pass; returns the time spent. */
export function stepUntil(game: SimGame, until: () => boolean, seconds = 10, dt = 1 / 60): number {
  const t0 = game.time;
  while (game.time - t0 < seconds) {
    game.tick(dt, false);
    if (until()) break;
  }
  return game.time - t0;
}

export function place(u: Unit, world: World, x: number, z: number, yaw = 0): void {
  u.teleport(world, x, z, yaw);
}

// ------------------------------------------------------------------ the browser's own clips

/** The game's motion library reading public/motions/ from disk (fetch is the browser's way in). */
export function diskLibrary(dir: string): MotionLibrary {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const path = String(url);
    if (!path.startsWith('disk:')) return real(url as never);
    try {
      const data = await readFile(`${dir}/${path.slice('disk:'.length)}`);
      return new Response(new Uint8Array(data));
    } catch {
      return new Response(null, { status: 404 });
    }
  }) as typeof fetch;
  return new MotionLibrary('disk:');
}

/**
 * When the browser's motion controller sends the clip's 'hit' event, in seconds after play(), for
 * the clip and options Unit.act gave it (stepped at `dt`, from the clip data on disk).
 */
export async function clipHitTime(lib: MotionLibrary, id: MotionId, opts: MotionPlayOptions, dt = 0.0005): Promise<number | null> {
  await lib.ready;
  await lib.load(id as ClipId);
  const rig = stubRig({ race: 'human', sex: 'male', classId: 'warrior', shell: 0, crest: 0, led: 0, name: 'clip' });
  const motion = createMotionController(rig, lib);
  let hit: number | null = null;
  let t = 0;
  motion.play(id, { ...opts, onEvent: (name) => { if (name === 'hit' && hit === null) hit = t; }, onEnd: undefined, carryRoot: undefined });
  for (; t < 5 && hit === null; ) {
    t += dt;
    motion.update(dt);
  }
  motion.dispose();
  return hit;
}
