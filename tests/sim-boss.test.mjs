// Corrodius headless (S1): the fight's beats, warnings, impacts and damage read from its events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../tmp/test-modules/sim-harness.js';

const DT = 1 / 30;
const of = (events, type, pred = () => true) => events.filter((e) => e.type === type && pred(e));

function arena() {
  const { game, events } = H.recordingGame();
  const tank = game.addPlayer('warrior', 5);
  const caster = game.addPlayer('mage', 5);
  const boss = game.addBoss(H.BOSS_PROFILES.rust, 0, 0, 12);
  H.place(tank.unit, game.world, 0, 3.4, Math.PI);
  H.place(caster.unit, game.world, 9, 0, -Math.PI / 2);
  return { game, events, tank, caster, boss };
}

test('Corrodius wakes, engages and runs his phases through events only', () => {
  const { game, events, boss } = arena();
  boss.wake();
  H.stepUntil(game, () => boss.state === 'fight', 6, DT);
  assert.equal(boss.state, 'fight');
  assert.deepEqual(of(events, 'boss').map((e) => e.stage), ['awake', 'engage']);
  assert.ok(of(events, 'say', (e) => e.unit === boss.unit && e.yell).length >= 2);
  boss.unit.hp = boss.unit.maxHp * 0.5;
  game.tick(DT, false);
  boss.unit.hp = boss.unit.maxHp * 0.2;
  game.tick(DT, false);
  assert.deepEqual(of(events, 'boss', (e) => e.stage === 'phase').map((e) => [e.phase, !!e.remote]), [[2, false], [3, false]]);
  assert.equal(boss.enraged, true);
  assert.deepEqual(game.touched, []);
});

test('the Anchor Slam is warned, fires on time, hits the player inside and misses the one outside', () => {
  const { game, events, tank, caster, boss } = arena();
  boss.wake();
  H.stepUntil(game, () => boss.state === 'fight', 6, DT);
  H.stepUntil(game, () => of(events, 'telegraph').length > 0, 8, DT);
  const [warn] = of(events, 'telegraph');
  assert.equal(warn.mech, 'slam');
  assert.equal(warn.src, boss.unit);
  assert.equal(warn.level, 3);
  const [circle] = warn.shapes;
  assert.equal(circle.shape, 'circle');
  assert.ok(Math.hypot(circle.at.x - tank.unit.pos.x, circle.at.z - tank.unit.pos.z) < 0.5, 'aimed at the nearest player');
  const hpTank = tank.unit.hp;
  const hpCaster = caster.unit.hp;
  H.stepUntil(game, () => of(events, 'impact').length > 0, warn.seconds + 0.5, DT);
  const [impact] = of(events, 'impact');
  assert.ok(Math.abs(impact.at - warn.at - warn.seconds) <= DT + 1e-9, `fired ${impact.at - warn.at}s after the warning of ${warn.seconds}s`);
  assert.equal(impact.loud, true);
  assert.equal(impact.mech, 'slam');
  const slamHits = of(events, 'damage', (e) => e.src === boss.unit && e.at === impact.at);
  assert.deepEqual(slamHits.map((e) => e.dst), [tank.unit]);
  assert.equal(slamHits[0].amount, Math.round(tank.unit.maxHp * 0.26));
  assert.ok(tank.unit.hp < hpTank);
  assert.equal(caster.unit.hp, hpCaster, 'nine metres away is outside the 3.4 m circle');
  assert.deepEqual(of(events, 'telegraphEnd').map((e) => e.cancelled), [false]);
  assert.deepEqual(game.touched, []);
});

test('the Rust Spray swings its effect early, then stacks rust on whoever stands in the cone', () => {
  const { game, events, tank, boss } = arena();
  boss.wake();
  H.stepUntil(game, () => boss.state === 'fight', 6, DT);
  H.stepUntil(game, () => of(events, 'telegraph', (e) => e.mech === 'spray').length > 0, 20, DT);
  const warn = of(events, 'telegraph', (e) => e.mech === 'spray')[0];
  assert.equal(warn.shapes[0].shape, 'cone');
  H.stepUntil(game, () => of(events, 'telegraphEnd').length >= 2, warn.seconds + 0.5, DT);
  const spray = of(events, 'impact', (e) => e.mech === 'spray');
  assert.equal(spray.length, 1);
  assert.equal(spray[0].loud, false);
  assert.ok(spray[0].at < warn.at + warn.seconds, 'the spray is seen as the claw swings, before it lands');
  assert.deepEqual(of(events, 'buff').map((e) => [e.unit, e.buff, e.stacks]), [[tank.unit, 'rust', 1]]);
  assert.equal(tank.unit.rust, 1);
  assert.deepEqual(game.touched, []);
});

test('a follower shows the same warning, then the impact quietly when its checkpoint drops the mechanic', () => {
  const host = arena();
  const guest = arena();
  host.boss.state = guest.boss.state = 'fight';
  host.boss.startMech();
  const id = 'b3';
  guest.boss.applyNetwork(host.boss.networkState(id));
  const [hw] = of(host.events, 'telegraph');
  const [gw] = of(guest.events, 'telegraph');
  assert.deepEqual(gw.shapes, hw.shapes);
  assert.equal(gw.mech, hw.mech);
  guest.boss.applyNetwork({ ...host.boss.networkState(id), mech: null });
  const [gi] = of(guest.events, 'impact');
  assert.equal(gi.loud, false);
  // A follower clears before taking a new mark, and clears the mark when the checkpoint drops it.
  const ends = of(guest.events, 'telegraphEnd');
  assert.deepEqual(ends.map((e) => e.cancelled), [true, true]);
  assert.ok(guest.events.indexOf(ends[0]) < guest.events.indexOf(gw) && guest.events.indexOf(ends[1]) > guest.events.indexOf(gw));
  assert.ok(of(guest.events, 'boss', (e) => e.stage === 'frame' && e.show).length > 0);
});

test('Corrodius dies: his adds go with him, the freed crab walks out, and the death is credited', () => {
  const { game, events, tank, boss } = arena();
  boss.wake();
  H.stepUntil(game, () => boss.state === 'fight', 6, DT);
  game.combat.damage(tank.unit, boss.unit, boss.unit.hp + 10, { crit: true });
  assert.equal(boss.state, 'dying');
  assert.deepEqual(of(events, 'death').map((e) => [e.unit, e.killer]), [[boss.unit, tank.unit]]);
  assert.ok(of(events, 'boss', (e) => e.stage === 'death').length === 1);
  H.stepUntil(game, () => of(events, 'freed').length > 0, 4, DT);
  assert.equal(of(events, 'freed')[0].unit, boss.freed);
  H.stepUntil(game, () => boss.state === 'dead', 12, DT);
  assert.equal(boss.state, 'dead');
  assert.deepEqual(game.touched, []);
});
