// Hit timing (S1, docs/server-world.md): every swing lands on the game clock at the moment the
// skill data gives, and that moment is the one at which the browser's motion controller sends the
// clip's own 'hit' event for the same clip and options (the clips on disk, public/motions/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as H from '../tmp/test-modules/sim-harness.js';

const lib = H.diskLibrary(fileURLToPath(new URL('../public/motions', import.meta.url)));
const DT = 1 / 240;
const rows = [];

/** Record every swing that schedules a hit: when it started, its delay, and what the clip was told. */
function watchSwings(game, u) {
  const swings = [];
  const act = u.act.bind(u);
  u.act = (id, o = {}) => {
    act(id, o);
    if (o.onHit) swings.push({ id, t0: game.time, delay: u.pendingHitIn, played: u.motion.played });
  };
  return swings;
}

function tough(u) {
  u.maxHp = u.hp = 1e7;
}

/**
 * Run until `attacker` starts a swing, then until its first damage lands; compare the scheduled
 * delay with the clip's hit time and with when the damage event really came.
 */
async function measure(name, game, events, attacker, start = () => {}) {
  const swings = watchSwings(game, attacker);
  start();
  H.stepUntil(game, () => swings.length > 0, 12, DT);
  assert.ok(swings.length > 0, `${name}: no swing started`);
  const s = swings[0];
  assert.equal(s.played.id, s.id);
  const from = events.length;
  H.stepUntil(game, () => events.slice(from).some((e) => e.type === 'damage' && e.src === attacker), 3, DT);
  const landed = events.slice(from).find((e) => e.type === 'damage' && e.src === attacker);
  assert.ok(landed, `${name}: the swing never landed`);
  const clip = await H.clipHitTime(lib, s.id, s.played.opts);
  assert.notEqual(clip, null, `${name}: ${s.id} has no hit event`);
  rows.push({ name, clip: s.id, speed: s.played.opts.speed, simDelay: +s.delay.toFixed(4), clipHit: +clip.toFixed(4), landedAfter: +(landed.at - s.t0).toFixed(4), oldFallback: +(s.delay + 0.1).toFixed(4) });
  // The clip is stepped every 0.5 ms; the scheduled time is exact.
  assert.ok(Math.abs(s.delay - clip) <= 0.001, `${name}: scheduled ${s.delay}s, clip hit ${clip}s`);
  // The damage arrives in the tick that crosses the scheduled time.
  assert.ok(Math.abs(landed.at - s.t0 - s.delay) <= DT + 1e-9, `${name}: landed ${landed.at - s.t0}s after the swing, scheduled ${s.delay}s`);
}

function fighter(classId, level = 10) {
  const { game, events } = H.recordingGame();
  const c = game.addPlayer(classId, level);
  H.place(c.unit, game.world, 0, 0, 0);
  tough(c.unit);
  return { game, events, c };
}

for (const [classId, abilityId] of [['warrior', 'pincer-strike'], ['warrior', 'shell-bash'], ['priest', 'holy-tide']]) {
  test(`${classId} ${abilityId} lands at the clip's hit`, async () => {
    const { game, events, c } = fighter(classId);
    const e = game.addEnemy('scrapling', 0, 1.6);
    tough(e.unit);
    c.player.setTarget(e.unit);
    c.player.nextSwing = Infinity; // no auto-attack in the way
    c.player.resource = c.player.maxResource = 1000;
    const ab = H.CLASSES[classId].abilities.find((a) => a.id === abilityId);
    await measure(`${classId}/${abilityId}`, game, events, c.unit, () => c.player.useAbility(ab.slot));
  });
}

test('the warrior auto-attack lands at the clip hit', async () => {
  const { game, events, c } = fighter('warrior');
  const e = game.addEnemy('scrapling', 0, 1.6);
  tough(e.unit);
  c.player.setTarget(e.unit);
  await measure('warrior/auto-attack', game, events, c.unit);
});

for (const kind of ['scrapling', 'scavenger']) {
  test(`a ${kind}'s claw lands at the clip hit`, async () => {
    const { game, events, c } = fighter('warrior');
    const e = game.addEnemy(kind, 0, 1.6);
    tough(e.unit);
    await measure(`${kind}/claw`, game, events, e.unit);
  });
}

test("a sea drone's zap lands at the swipe's hit, inside its 0.9 s warning ring", async () => {
  const { game, events } = H.recordingGame(H.flatWorld(-0.5));
  const c = game.addPlayer('warrior', 10);
  H.place(c.unit, game.world, 0, 0, 0);
  tough(c.unit);
  const e = game.addEnemy('jellyfish', 0, 3);
  tough(e.unit);
  await measure('jellyfish/sea zap', game, events, e.unit);
  const warn = events.find((x) => x.type === 'attack' && x.attack === 'seaCast' && x.stage === 'start');
  assert.ok(warn, 'the zap is warned');
});

for (const enraged of [false, true]) {
  test(`Corrodius's claw lands at the clip hit${enraged ? ' when enraged' : ''}`, async () => {
    const { game, events, c } = fighter('warrior');
    const boss = game.addBoss(H.BOSS_PROFILES.rust, 0, 0, 12);
    H.place(c.unit, game.world, 0, 3.4, Math.PI);
    boss.wake();
    H.stepUntil(game, () => boss.state === 'fight', 6, DT);
    assert.equal(boss.state, 'fight');
    tough(boss.unit);
    if (enraged) {
      boss.phase = 3;
      boss.enraged = true;
    }
    await measure(`Corrodius/claw${enraged ? ' (enraged)' : ''}`, game, events, boss.unit);
  });
}

test('every other ability lands when it is used (no swing waits on a clip)', () => {
  for (const [classId, cls] of Object.entries(H.CLASSES)) {
    for (const ab of cls.abilities) {
      if (['pincer-strike', 'shell-bash', 'holy-tide'].includes(ab.id)) continue;
      const { game, events, c } = fighter(classId);
      const e = game.addEnemy('scrapling', 0, ab.id === 'sideways-charge' ? 6 : 1.6);
      tough(e.unit);
      c.player.setTarget(e.unit);
      c.player.nextSwing = Infinity;
      c.player.resource = c.player.maxResource = 1000;
      const swings = watchSwings(game, c.unit);
      c.player.useAbility(ab.slot);
      if (ab.castTime > 0) H.stepUntil(game, () => events.some((x) => x.type === 'castEnd'), ab.castTime + 1, DT);
      assert.equal(swings.length, 0, `${ab.id} schedules no clip hit`);
      const u = c.unit;
      const used = events.filter((x) => ((x.type === 'damage' || x.type === 'heal') && x.src === u) || (x.type === 'ward' && x.unit === u) || (x.type === 'ability' && x.caster === u && x.stage === 'start') || (x.type === 'projectile' && x.stage === 'spawn' && x.src === u));
      assert.ok(used.length > 0, `${ab.id} took effect at once`);
      assert.ok(used.every((x) => x.at === used[0].at), `${ab.id}: all of it in one tick: ${used.map((x) => `${x.type}@${x.at.toFixed(3)}`).join(' ')}`);
    }
  }
});

test.after(() => {
  console.log('hit timing (s):');
  for (const r of rows) console.log(`  ${r.name.padEnd(28)} ${r.clip.padEnd(13)} speed ${String(r.speed).padEnd(5)} sim ${r.simDelay.toFixed(4)}  clip ${r.clipHit.toFixed(4)}  landed ${r.landedAfter.toFixed(4)}  (old fallback ${r.oldFallback.toFixed(4)})`);
});
