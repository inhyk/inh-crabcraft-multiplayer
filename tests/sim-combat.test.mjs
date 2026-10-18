// The shipped combat code headless (S1, docs/server-world.md): what it does is read from its events
// alone, and it never touches the HUD, effects, audio, camera or a single local player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../tmp/test-modules/sim-harness.js';

const DT = 1 / 30;
const of = (events, type, pred = () => true) => events.filter((e) => e.type === type && pred(e));

function duel(classId, enemyKind = 'scrapling', at = 1.6, level = 3) {
  const { game, events } = H.recordingGame();
  const c = game.addPlayer(classId, level);
  H.place(c.unit, game.world, 0, 0, 0);
  const e = game.addEnemy(enemyKind, 0, at);
  c.player.setTarget(e.unit);
  return { game, events, c, e };
}

test('a warrior kills a Scrapling: its damage adds up to its health, one death, the XP and coins go to the killer', () => {
  const { game, events, c, e } = duel('warrior');
  const hp = e.unit.maxHp;
  H.stepUntil(game, () => !e.unit.alive, 30, DT);
  assert.equal(e.unit.alive, false);
  const dealt = of(events, 'damage', (x) => x.dst === e.unit);
  assert.ok(dealt.length >= 2);
  assert.ok(dealt.every((x) => x.src === c.unit));
  // The last blow is capped by what was left; Combat rounds each hit.
  assert.equal(dealt.reduce((n, x) => n + x.amount, 0) >= hp, true);
  assert.deepEqual(of(events, 'death').map((x) => [x.unit, x.killer]), [[e.unit, c.unit]]);
  assert.deepEqual(of(events, 'xp').map((x) => [x.unit, x.amount]), [[c.unit, H.ENEMY_STATS.scrapling.xp]]);
  assert.equal(c.player.coins, Math.max(5, Math.round(H.ENEMY_STATS.scrapling.xp / 4)));
  assert.deepEqual(game.touched, []);
});

test('an ability on cooldown is refused with an error event and does nothing', () => {
  const { game, events, c, e } = duel('warrior');
  e.unit.maxHp = e.unit.hp = 1e6;
  c.player.nextSwing = Infinity;
  c.player.resource = 100;
  const strike = H.CLASSES.warrior.abilities[0];
  c.player.useAbility(strike.slot);
  H.stepUntil(game, () => false, 1.2, DT); // past the global cooldown, inside the 3 s recovery
  const hits = of(events, 'damage', (x) => x.src === c.unit).length;
  const cooldown = { ...c.player.cooldowns.get(strike.id) };
  c.player.useAbility(strike.slot);
  H.stepUntil(game, () => false, 0.6, DT);
  assert.deepEqual(of(events, 'error').map((x) => x.reason), ['Ability is not ready yet.']);
  assert.equal(of(events, 'damage', (x) => x.src === c.unit).length, hits);
  assert.deepEqual(c.player.cooldowns.get(strike.id), cooldown);
  assert.equal(of(events, 'press').length, 2);
  assert.deepEqual(game.touched, []);
});

test('a Bubble Bolt flies in the simulation: cast, launch, flight at 17 m/s, then the hit lands its damage', () => {
  const { game, events, c, e } = duel('mage', 'scrapling', 12);
  e.unit.maxHp = e.unit.hp = 1e6;
  c.player.nextSwing = Infinity;
  const bolt = H.CLASSES.mage.abilities[0];
  c.player.useAbility(bolt.slot);
  H.stepUntil(game, () => of(events, 'projectile', (x) => x.stage === 'hit').length > 0, 5, 1 / 120);
  const [start] = of(events, 'castStart');
  const [end] = of(events, 'castEnd');
  const [spawn] = of(events, 'projectile', (x) => x.stage === 'spawn');
  const [hit] = of(events, 'projectile', (x) => x.stage === 'hit');
  assert.equal(start.ability.id, 'bubble-bolt');
  assert.equal(end.result, 'done');
  assert.ok(Math.abs(end.at - start.at - bolt.castTime) < 0.01);
  assert.equal(spawn.at, end.at);
  assert.equal(spawn.style, 'bubble');
  assert.equal(spawn.speed, 17);
  assert.equal(hit.id, spawn.id);
  assert.equal(hit.landed, true);
  // From the claw to the target's centre at 17 m/s.
  const dist = Math.hypot(spawn.from.x - e.unit.pos.x, spawn.from.y - (e.unit.pos.y + e.unit.height / 2), spawn.from.z - e.unit.pos.z);
  assert.ok(Math.abs(hit.at - spawn.at - dist / 17) < 2 / 120, `flight ${hit.at - spawn.at}s for ${dist} m`);
  const [dmg] = of(events, 'damage', (x) => x.src === c.unit);
  assert.equal(dmg.at, hit.at);
  assert.ok(events.indexOf(dmg) > events.indexOf(hit), 'the splash comes before the number');
  assert.deepEqual(game.touched, []);
});

test('a projectile whose target dies in flight lands without damage', () => {
  // The priest's auto-attack: a holy bolt at 22 m/s.
  const { game, events, c, e } = duel('priest', 'scrapling', 15);
  H.stepUntil(game, () => of(events, 'projectile', (x) => x.stage === 'spawn').length > 0, 3, DT);
  e.unit.hp = 1;
  game.combat.damage(null, e.unit, 5);
  assert.equal(e.unit.alive, false);
  H.stepUntil(game, () => of(events, 'projectile', (x) => x.stage === 'hit').length > 0, 3, DT);
  const [hit] = of(events, 'projectile', (x) => x.stage === 'hit');
  assert.equal(hit.style, 'holy');
  assert.equal(hit.landed, false);
  assert.equal(of(events, 'damage', (x) => x.src === c.unit).length, 0);
});

test('a hit reaches the controller of the unit it hit: pushback and wards belong to that player, rage to its attacker', () => {
  const { game, events } = H.recordingGame();
  const warrior = game.addPlayer('warrior', 5);
  const mage = game.addPlayer('mage', 5);
  const priest = game.addPlayer('priest', 5);
  H.place(warrior.unit, game.world, 0, 0);
  H.place(mage.unit, game.world, 6, 0);
  H.place(priest.unit, game.world, -6, 0);
  const e = game.addEnemy('scrapling', 0, 15);
  e.unit.maxHp = e.unit.hp = 1e6;
  // The mage casts; a hit on the mage pushes back the mage's cast only.
  mage.player.setTarget(e.unit);
  mage.player.useAbility(1);
  const end = mage.player.cast.end;
  game.combat.damage(e.unit, mage.unit, 3);
  assert.equal(mage.player.cast.end, end + 0.25);
  // The warrior earns rage for its own hit, and from being hit.
  warrior.player.resource = 0;
  game.combat.damage(warrior.unit, e.unit, 10, { rage: 9 });
  assert.equal(warrior.player.resource, 9);
  game.combat.damage(e.unit, warrior.unit, 4);
  assert.equal(warrior.player.resource, 11);
  // The priest's ward soaks for the priest and breaks on the priest.
  priest.player.useAbility(3);
  assert.equal(priest.player.warded, true);
  const absorb = priest.unit.absorb;
  game.combat.damage(e.unit, priest.unit, 5);
  game.combat.damage(e.unit, priest.unit, absorb);
  assert.equal(priest.player.warded, false);
  assert.deepEqual(of(events, 'ward').map((x) => [x.unit, x.stage]), [[priest.unit, 'up'], [priest.unit, 'hit'], [priest.unit, 'down']]);
  assert.deepEqual(of(events, 'blocked').map((x) => x.reason), ['absorbed']);
  assert.deepEqual(game.touched, []);
});

test('enemies hunt the nearest player and look from that player; a dead one comes back when no player is near', () => {
  const { game, events } = H.recordingGame();
  const near = game.addPlayer('warrior', 5);
  const far = game.addPlayer('priest', 5);
  H.place(near.unit, game.world, 0, 0);
  H.place(far.unit, game.world, 60, 0);
  const e = game.addEnemy('scrapling', 0, 6);
  H.stepUntil(game, () => of(events, 'damage', (x) => x.src === e.unit).length > 0, 10, DT);
  assert.ok(of(events, 'aggro', (x) => x.unit === e.unit).length > 0);
  assert.ok(of(events, 'damage', (x) => x.src === e.unit).every((x) => x.dst === near.unit));
  game.combat.damage(near.unit, e.unit, 1e6);
  assert.equal(e.state, 'dead');
  // Respawn waits for its timer and for the players to be 22 m away: no camera decides it.
  H.stepUntil(game, () => false, H.ENEMY_STATS.scrapling.respawn + 1, 0.25);
  assert.equal(e.unit.alive, false);
  H.place(near.unit, game.world, 0, 40);
  H.stepUntil(game, () => e.unit.alive, 2, 0.25);
  assert.equal(e.unit.alive, true);
  assert.equal(of(events, 'spawn', (x) => x.unit === e.unit).length, 1);
  assert.deepEqual(game.touched, []);
});

test('game timers fire on the game clock, in order, and wait while it stands still', () => {
  const { game } = H.recordingGame();
  const fired = [];
  game.timers.at(game.time + 0.45, () => fired.push('cog'));
  game.timers.at(game.time + 0.2, () => fired.push('first'));
  game.timers.at(game.time + 2.6, () => fired.push('wake'));
  H.stepUntil(game, () => false, 0.5, 0.05);
  assert.deepEqual(fired, ['first', 'cog']);
  assert.equal(game.timers.size, 1);
  H.stepUntil(game, () => false, 2.2, 0.05);
  assert.deepEqual(fired, ['first', 'cog', 'wake']);
});

test('World I with bots, all three classes, on the real terrain: kills and XP, and nothing but events leave the simulation', () => {
  const { world } = H.createHeadlessWorld();
  const game = new H.SimGame(world, 'normal');
  const events = [];
  game.onEvent = (e) => events.push(e.type);
  game.setup(6, 1, 3);
  for (let i = 0; i < 40 * 20; i++) game.tick(1 / 20);
  const count = (t) => events.filter((x) => x === t).length;
  assert.ok(game.stats.kills > 0, 'the bots killed something');
  assert.ok(count('xp') > 0 && count('death') > 0 && count('damage') > 10);
  assert.ok(count('projectile') > 0, 'mages and priests shot');
  assert.ok(count('ability') > 0 && count('castStart') > 0);
  assert.deepEqual(game.touched, []);
});

test('the traps do record a touch (so an empty list means none)', () => {
  const { game } = H.recordingGame();
  game.vfx.ring();
  game.hud.floats.spawn();
  game.player.unit = null;
  assert.deepEqual(game.touched, ['vfx.ring', 'vfx.ring()', 'hud.floats', 'hud.floats.spawn', 'hud.floats.spawn()', 'player.unit=']);
});
