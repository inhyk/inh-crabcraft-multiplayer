// The browser's sink for the simulation's events (src/game/events.ts): each event becomes the HUD,
// effects, audio and camera calls the combat code used to make itself. It also draws, frame by
// frame, the effects that follow simulation state rather than a moment: the motes at a casting
// claw, the beacon channel's stream, a waking boss's dust, an enraged boss's heat and the foam
// behind the crab it set free.
import * as THREE from 'three';
import { t } from '../i18n';
import { abilityName } from './abilityLocale';
import type { Boss } from './boss';
import { bossPhaseBanner, bossWarning } from './bossLocale';
import type { MechKind, SimEvent, Vec3 } from './events';
import type { Game } from './game';
import { JUMP_CLIP } from './player';
import type { Unit } from './unit';
import { rand } from './util';
import { Sprite } from './vfx/atlas';
import type { Fx } from './vfx/effects';
import { C, N, type ProjectileFx, type WardHandle } from './vfx/vfx';

const v = new THREE.Vector3();
const vec = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
const color = (c: string | undefined) => (c === undefined ? undefined : new THREE.Color(c));

/** The camera's kick when a boss mechanic goes off: amount and seconds. */
const MECH_SHAKE: Record<MechKind, [number, number] | null> = {
  slam: [0.5, 0.5],
  eclipse: [0.5, 0.7],
  nova: [0.4, 0.5],
  cross: [0.3, 0.4],
  barrage: [0.3, 0.4],
  undertow: [0.55, 0.6],
  spray: null,
};

const ERRORS_KO: Record<string, string> = {
  'You are stunned.': '기절한 동안에는 움직일 수 없어요.',
  'Another action is in progress.': '다른 행동을 마친 뒤 사용하세요.',
  'Ability is not ready yet.': '아직 기술을 다시 사용할 수 없어요.',
  'Not enough rage.': '분노가 부족해요.',
  'Not enough mana.': '마나가 부족해요.',
  'You have no target.': '먼저 대상을 선택하세요.',
  'Invalid target.': '이 대상에게는 사용할 수 없어요.',
  'Out of range.': '조금 더 가까이 다가가세요.',
  'Target too close.': '대상과 조금 더 거리를 두세요.',
  'Target not in line of sight.': '대상이 장애물에 가려져 있어요.',
  "You can't dance while in combat.": '전투 중에는 춤출 수 없어요.',
  'Stand still to dance.': '멈춰 선 다음에 춤출 수 있어요.',
};
const CAST_FAIL_KO: Record<string, string> = { Interrupted: '중단됨', Cancelled: '취소됨', 'Invalid target': '대상을 다시 선택하세요' };

interface Telegraph {
  fx: Fx[];
  warning: HTMLElement | null;
  mech: MechKind;
  level: number;
}

export class BrowserSink {
  private readonly telegraphs = new Map<Unit, Telegraph>();
  private readonly wards = new Map<Unit, WardHandle>();
  private readonly projectiles = new Map<number, ProjectileFx>();

  constructor(private readonly g: Game) {}

  private get sandy(): boolean {
    return this.g.zone === 'The Brine Shore' || this.g.zone === 'The Iron Wreck';
  }

  private footstep(volume: number, pitch: number): void {
    this.g.audio.sfx(this.sandy ? 'sfx-footstep-sand' : 'sfx-footstep-stone', { volume, pitch });
  }

  readonly handle = (e: SimEvent): void => {
    const g = this.g;
    const { hud, vfx, audio, follow } = g;
    switch (e.type) {
      case 'damage': {
        const { dst, amount, crit } = e;
        if (dst.kind === 'player') {
          hud.floats.spawn(dst, `-${amount}`, 'taken');
          dst.flash('#ff2a1a', 0.18);
          hud.damageFlash(amount / dst.maxHp);
        } else {
          hud.floats.spawn(dst, crit ? `${amount}!` : `${amount}`, crit ? 'crit' : 'dmg');
          dst.flash('#ffffff', 0.1);
        }
        if (crit) {
          follow.shake(dst.kind === 'boss' ? 0.18 : 0.12, 0.25);
          audio.sfx('sfx-crit', { volume: 0.8 });
        } else {
          audio.sfx('sfx-hit', { volume: 0.55 });
        }
        return;
      }
      case 'blocked':
        hud.floats.spawn(e.unit, e.reason === 'evade' ? 'Evade' : 'Absorbed', 'info');
        return;
      case 'heal': {
        const n = Math.round(e.amount);
        if (e.amount > 0) hud.floats.spawn(e.dst, e.crit ? `+${n}!` : `+${n}`, 'heal');
        audio.sfx('sfx-heal', { volume: 0.6 });
        return;
      }
      case 'death': {
        const dst = e.unit;
        dst.motion.stop(undefined, 0.1);
        // The power-down: the legs give way and the shell settles on the floor, where it stays.
        dst.act('death', {
          fade: 0.1,
          onEvent: (name) => {
            if (name !== 'settled' || dst.hidden || dst.culled) return;
            vfx.smoke(v.set(dst.pos.x, dst.pos.y + 0.05, dst.pos.z), C.dust, 6, 0.7 * dst.radius, 0.4, 0.35 * dst.height, 0.7);
          },
        });
        dst.express('dead', 999);
        dst.rig.face.setTint(null);
        vfx.deathPoof(dst);
        return;
      }
      case 'buff':
        hud.floats.spawn(e.unit, t(`녹 ${e.stacks}중첩`, `Rust x${e.stacks}`), 'info');
        return;
      case 'ward': {
        const old = this.wards.get(e.unit);
        if (e.stage === 'hit') {
          old?.hit();
          return;
        }
        old?.pop();
        this.wards.delete(e.unit);
        if (e.stage === 'up') this.wards.set(e.unit, vfx.ward(e.unit, e.seconds ?? 10));
        return;
      }
      case 'castStart': {
        const local = e.unit === g.player.unit;
        if (e.channel) {
          if (local) hud.castBar.start(e.channel.label, e.seconds, true);
          audio.sfx('sfx-cast', { volume: 0.5 });
        } else {
          audio.sfx('sfx-cast', { volume: 0.5 });
          const ab = e.ability!;
          if (local) hud.castBar.start(() => abilityName(ab), e.seconds);
        }
        return;
      }
      case 'castEnd': {
        if (e.unit !== g.player.unit) return;
        if (e.result === 'done') hud.castBar.finish();
        else {
          const reason = e.reason ?? 'Interrupted';
          hud.castBar.fail(() => t(CAST_FAIL_KO[reason] ?? reason, reason));
        }
        return;
      }
      case 'ability':
        this.ability(e);
        return;
      case 'projectile':
        if (e.stage === 'spawn') this.projectiles.set(e.id, vfx.projectile(vec(e.from), e.target, e.style, e.speed));
        else {
          this.projectiles.get(e.id)?.land();
          this.projectiles.delete(e.id);
        }
        return;
      case 'press':
        if (e.unit === g.player.unit) hud.actionBar.press(e.slot);
        return;
      case 'error':
        if (e.unit !== g.player.unit) return;
        hud.messages.error(t(ERRORS_KO[e.reason] ?? e.reason, e.reason));
        audio.sfx('sfx-error', { volume: 0.6 });
        return;
      case 'target': {
        if (e.unit !== g.player.unit) return;
        const tg = e.target;
        hud.targetFrame.setUnit(tg, tg?.kind === 'npc' ? `art/npc/${tg.npcId}.webp` : null);
        if (tg) audio.sfx('sfx-click', { volume: 0.35 });
        return;
      }
      case 'jump':
        e.unit.act('jump', {
          fade: 0.06,
          from: JUMP_CLIP.from,
          to: JUMP_CLIP.to,
          speed: JUMP_CLIP.speed,
          onEvent: (name) => {
            if (name === 'land') this.footstep(0.45, 0.08);
          },
        });
        audio.sfx('sfx-servo-whir', { volume: 0.35 });
        return;
      case 'footstep':
        this.footstep(0.22, 0.12);
        return;
      case 'recall':
        follow.yaw = e.unit.yaw + Math.PI;
        follow.cut();
        vfx.mendGlow(e.unit);
        return;
      case 'dance':
        if (e.stage === 'start') {
          hud.messages.info(t('브레이크댄스: 탑록, 식스스텝, 스핀, 720, 백플립, 한 집게 프리즈. 움직이면 멈춰요.', 'Breakdance: toprock, six-step, spin, 720, back flip, one-claw freeze. Move to stop.'));
          return;
        }
        // The routine's moments: a whir on every take-off, a thud on every landing and freeze.
        if (e.moment === 'takeoff' || (e.moment === 'spin_from' && e.move === 'break_spin')) audio.sfx('sfx-servo-whir', { volume: 0.4 });
        else if (e.moment === 'land' || (e.moment === 'hit' && e.move === 'break_oneclaw')) {
          this.footstep(0.55, 0.08);
          e.unit.express('love', 1.2);
        }
        return;
      case 'xp':
        hud.floats.spawn(e.unit, `+${e.amount} XP`, 'xp');
        hud.chat.system(t(`경험치 ${e.amount}을 얻었습니다.`, `You gain ${e.amount} experience.`));
        return;
      case 'levelUp': {
        const u = e.unit;
        vfx.levelUp(u);
        audio.sfx('sfx-levelup');
        if (e.jump) {
          hud.messages.banner(() => t(`레벨 ${u.level}`, `Level ${u.level}`), () => t('계속해서 성장하세요!', 'Keep growing!'), 'level');
          return;
        }
        const oldMax = e.oldMaxHp;
        hud.messages.banner(() => t(`레벨 ${u.level}`, `Level ${u.level}`), () => t(`껍질이 더 단단해졌어요. 체력 ${oldMax} → ${u.maxHp}`, `Your shell hardens. Health ${oldMax} to ${u.maxHp}.`), 'level');
        hud.chat.system(t(`레벨 ${u.level}이 되었습니다!`, `Congratulations, you have reached level ${u.level}!`));
        return;
      }
      case 'aggro':
        audio.sfx('sfx-servo-whir', { volume: 0.25, pitch: 0.2 });
        return;
      case 'spawn':
        vfx.burrow(e.unit.pos);
        return;
      case 'leash':
        hud.floats.spawn(e.unit, 'Evade', 'info');
        return;
      case 'attack':
        this.attack(e);
        return;
      case 'telegraph': {
        const fx: Fx[] = [];
        for (const s of e.shapes) {
          if (s.shape === 'lane') fx.push(vfx.telegraphLane(vec(s.at), s.yaw, s.halfLength, s.halfWidth, e.seconds, new THREE.Color(s.color)));
          else if (s.shape === 'circle') fx.push(vfx.telegraphCircle(vec(s.at), s.radius, e.seconds, color(s.color), vec(s.ground)));
          else if (s.shape === 'cone') fx.push(vfx.telegraphCone(vec(s.at), s.yaw, s.range, s.half, e.seconds, color(s.color), vec(s.ground)));
          else vfx.undertow(vec(s.at), s.radius, e.seconds);
        }
        const warning = hud.messages.warn(bossWarning(e.mech, e.level), { persistent: true });
        this.telegraphs.set(e.src, { fx, warning, mech: e.mech, level: e.level });
        return;
      }
      case 'telegraphEnd': {
        const tg = this.telegraphs.get(e.src);
        if (!tg) return;
        this.telegraphs.delete(e.src);
        if (tg.warning) hud.messages.clearWarning(tg.warning);
        if (e.cancelled) for (const f of tg.fx) vfx.fx.release(f);
        return;
      }
      case 'impact': {
        for (const s of e.shapes) {
          if (s.fx === 'lane') vfx.telegraphLane(vec(s.at), s.yaw, s.halfLength, s.halfWidth, s.seconds, new THREE.Color(s.color));
          else if (s.fx === 'slam') vfx.slamImpact(vec(s.at), s.radius);
          else if (s.fx === 'ring') vfx.ring(vec(s.at), new THREE.Color(s.color), s.r0, s.r1, s.seconds, s.inner);
          else vfx.rustSpray(vec(s.at), s.yaw, s.range, s.half);
        }
        const shake = MECH_SHAKE[e.mech];
        if (e.loud && shake) {
          follow.shake(shake[0], shake[1]);
          audio.sfx('sfx-crit');
        }
        return;
      }
      case 'boss':
        this.boss(e);
        return;
      case 'freed':
        vfx.steamPuff(e.unit.pos);
        vfx.lootSparkle(e.unit.pos);
        audio.sfx('sfx-servo-whir');
        return;
      case 'say':
        g.say(e.unit, e.text, e.yell);
        return;
      case 'loot':
        vfx.lootSparkle(e.unit.pos);
        hud.floats.spawn(e.unit, '+1 Rusted Cog', 'info');
        hud.chat.loot('You receive loot: [Rusted Cog].');
        audio.sfx('sfx-click', { volume: 0.6 });
        return;
      case 'victory': {
        const boss = e.boss.ctrl as Boss;
        if (e.stage === 'banner') {
          hud.messages.banner(() => t('승리 · 왕관 획득', 'VICTORY · Crown reclaimed'), () => boss.profile.name, 'boss');
          vfx.levelUp(g.player.unit);
        } else hud.bossFrame.hide();
        return;
      }
    }
  };

  private ability(e: Extract<SimEvent, { type: 'ability' }>): void {
    const { vfx, audio, follow, hud } = this.g;
    const u = e.caster;
    const tg = e.target ?? null;
    const range = e.range ?? 0;
    switch (`${e.ability}:${e.stage}`) {
      case 'pincer-strike:hit':
        vfx.slash(u, tg!, C.gold, 1.25);
        follow.shake(0.06, 0.15);
        return;
      case 'shell-bash:hit':
        vfx.impact(tg!.centre(v), C.white, 1.3);
        vfx.ring(tg!.pos, N.gold, 0.3, 2.4, 0.4, 0.75);
        vfx.stunStars(tg!, e.stun ?? 0);
        follow.shake(0.14, 0.22);
        hud.floats.spawn(tg!, 'Stunned', 'info');
        return;
      case 'sideways-charge:start':
        vfx.dashTrail(u, 0.5);
        audio.sfx('sfx-servo-whir', { volume: 0.7 });
        hud.floats.spawn(u, '+15 Rage', 'info');
        return;
      case 'sideways-charge:hit':
        vfx.impact(tg!.centre(v), C.steel, 1.2);
        vfx.ring(tg!.pos, N.gold, 0.3, 2.2, 0.35, 0.8);
        follow.shake(0.12, 0.2);
        audio.sfx('sfx-hit', { volume: 0.8 });
        return;
      case 'whirlpool:start':
        vfx.whirlpool(u, range);
        audio.sfx('sfx-hit', { volume: 0.7 });
        follow.shake(0.1, 0.3);
        return;
      case 'frost-spray:start':
        vfx.frostSpray(u.pos, u.yaw, range, e.half ?? 0.55);
        audio.sfx('sfx-cast', { volume: 0.5 });
        return;
      case 'steam-blink:start':
        if (e.from) vfx.steamPuff(vec(e.from));
        vfx.steamPuff(u.pos);
        audio.sfx('sfx-servo-whir', { volume: 0.6 });
        return;
      case 'tidal-nova:start':
        vfx.tidalNova(u.pos, range);
        follow.shake(0.15, 0.3);
        audio.sfx('sfx-crit', { volume: 0.5 });
        return;
      case 'smite:start':
        vfx.smite(tg!);
        audio.sfx('sfx-cast', { volume: 0.4 });
        return;
      case 'smite:hit':
        if ((e.amount ?? 0) > 32) follow.shake(0.08, 0.15);
        return;
      case 'mend-shell:start':
        vfx.mendGlow(u);
        return;
      case 'barnacle-ward:start':
        audio.sfx('sfx-heal', { volume: 0.4 });
        hud.floats.spawn(u, 'Barnacle Ward', 'info');
        return;
      case 'holy-tide:hit':
        vfx.holyTide(u.pos, range);
        follow.shake(0.1, 0.25);
        return;
    }
  }

  private attack(e: Extract<SimEvent, { type: 'attack' }>): void {
    const { vfx, audio, follow, hud } = this.g;
    const u = e.src;
    switch (`${e.attack}:${e.stage}`) {
      case 'auto:hit':
        vfx.slash(u, e.target!, C.steel, 0.8);
        return;
      case 'claw:hit':
        vfx.sparks(e.target!.centre(v), C.ember, 6, 4);
        return;
      case 'seaCast:start':
        vfx.ring(vec(e.at!), C.water, 1.7, 1.7, 0.9, 0.85, 0);
        return;
      case 'seaCast:hit':
        vfx.sparks(vec(e.at!), C.water, 14, 4);
        return;
      case 'leap:start':
        audio.sfx('sfx-servo-whir', { volume: 0.5 });
        hud.floats.spawn(u, 'Leap!', 'info');
        return;
      case 'leap:hit':
        vfx.slamImpact(u.pos, 1.6);
        follow.shake(0.1, 0.2);
        return;
      case 'bossClaw:hit':
        vfx.slash(u, e.target!, C.ember, 1.3);
        follow.shake(0.08, 0.15);
        return;
    }
  }

  private boss(e: Extract<SimEvent, { type: 'boss' }>): void {
    const g = this.g;
    const { vfx, audio, follow, hud } = g;
    const u = e.boss;
    const boss = u.ctrl as Boss;
    switch (e.stage) {
      case 'engage':
        audio.sfx('sfx-boss-roar');
        hud.bossFrame.show(u);
        follow.shake(0.25, 0.6);
        return;
      case 'awake':
        audio.sfx('sfx-boss-roar');
        return;
      case 'phase': {
        const phase = e.phase ?? 2;
        if (e.remote) {
          hud.messages.banner(() => t(`${phase}단계`, `PHASE ${phase}`), () => boss.profile.name, 'boss');
          return;
        }
        audio.sfx('sfx-boss-roar');
        if (phase === 2) follow.shake(0.3, 0.6);
        else follow.shake(0.35, 0.8);
        const [title, sub] = bossPhaseBanner(boss.profile.level, phase === 2 ? 2 : 3);
        hud.messages.banner(title, sub, 'boss');
        return;
      }
      case 'reset':
        hud.bossFrame.hide();
        return;
      case 'death':
        if (boss.profile.level >= 10) vfx.tidalNova(u.pos, 8);
        else vfx.rustPeel(u, 4.5);
        follow.shake(0.35, 1.2);
        audio.sfx('sfx-boss-roar', { volume: 0.7, pitch: 0 });
        return;
      case 'frame':
        if (e.show) hud.bossFrame.show(u);
        else if (g.encounter === boss) hud.bossFrame.hide();
        return;
    }
  }

  /**
   * Effects that follow simulation state, once a frame after the simulation stepped. `authority`
   * is whether this browser ran the bosses this frame (a room's followers only mirror them).
   */
  drawState(bosses: readonly Boss[], authority: boolean): void {
    const g = this.g;
    const vfx = g.vfx;
    const p = g.player;
    const u = p.unit;
    if (p.cast) {
      const id = p.cast.ability.id;
      const col = id === 'smite' || id === 'mend-shell' ? (id === 'smite' ? C.holy : C.heal) : C.water;
      vfx.castMotes(u.socketPos('clawR', v), col, id === 'mend-shell' ? Sprite.Star : Sprite.Glow);
    }
    const ch = p.channel;
    if (ch) vfx.beaconStream(u.socketPos('clawR', v), ch.to, (g.time - ch.start) / (ch.end - ch.start));
    if (!authority) return;
    for (const b of bosses) {
      const bu = b.unit;
      if (b.state === 'waking' && b.stateTime < 2.4 && Math.random() < 0.5) vfx.burrow(v.set(bu.pos.x + rand(-2, 2), bu.pos.y - bu.lift, bu.pos.z + rand(-2, 2)));
      if (b.state === 'fight' && b.enraged) {
        vfx.heatVent(bu);
        if (Math.random() < 0.3) vfx.heatVent(bu);
      }
      const ft = b.freedTime;
      if (ft >= 4.6 && ft < 12 && Math.random() < 0.3) vfx.smoke(b.freed.pos, C.foam, 1, 0.5, 0.6, 0.3, 0.6);
    }
  }

  /** The language changed: raise the open warnings again in the new language. */
  refreshLanguage(): void {
    for (const tg of this.telegraphs.values()) tg.warning = this.g.hud.messages.warn(bossWarning(tg.mech, tg.level), { persistent: true });
  }
}
