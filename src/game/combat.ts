// Damage, healing, absorbs, crits and deaths. Every hit in the game goes through here so combat
// text, hit reactions, rage and aggro stay consistent. What players see and hear of it leaves as
// events (src/game/events.ts); reactions belong to the controller of the unit involved.
import type { Game } from './game';
import type { Unit } from './unit';

export type School = 'physical' | 'frost' | 'water' | 'holy' | 'rust';

export interface HitOptions {
  crit?: boolean;
  school?: School;
  /** Skip the hit-react clip (DoTs, big AoE ticks). */
  noReact?: boolean;
  /** Rage the attacker (if a warrior player) gains. */
  rage?: number;
}

/** What a unit's controller (Player, Enemy, Boss) does when combat touches its unit. */
export interface CombatController {
  /** Hit for dmg by src, unless the hit killed it: enemies and bosses wake. */
  onDamaged?(src: Unit | null, dmg: number): void;
  /** A player's own reaction to a hit that landed: pushback, rage taken, the dance ends. */
  onHurt?(dmg: number): void;
  /** Rage earned by landing a hit (warriors). */
  gainRage?(n: number): void;
  /** The unit's absorb shield took a hit; `broken` when nothing is left of it. */
  onWardHit?(broken: boolean): void;
  onDeath?(killer: Unit | null): void;
}

const ctrlOf = (u: Unit | null): CombatController | null => (u?.ctrl as CombatController | null) ?? null;

export const CRIT_CHANCE = 0.12;
export const CRIT_MULT = 1.75;

export function rollCrit(chance = CRIT_CHANCE): boolean {
  return Math.random() < chance;
}

export class Combat {
  constructor(private readonly game: Game) {}

  damage(src: Unit | null, dst: Unit, amount: number, o: HitOptions = {}): number {
    const g = this.game;
    if(g.villageGames?.playing&&(dst.kind==='player'||dst.kind==='remote'||src?.kind==='player'||src?.kind==='remote'))return 0;
    // The World III lock applies per character, even beside an eligible friend.
    if(dst===g.dawnBoss?.unit&&(src?.kind==='player'||src?.kind==='remote')&&src.level<100)return 0;
    if(src===g.dawnBoss?.unit&&(dst.kind==='player'||dst.kind==='remote')&&dst.level<100)return 0;
    const routed = g.multiplayer?.battle.routeDamage(src, dst, amount, o);
    if (routed !== undefined && routed !== null) return routed;
    if (!dst.alive || dst.hidden) return 0;
    const now = g.time;
    if (src) src.lastCombat = now;
    dst.lastCombat = now;
    if (dst.invulnerable) {
      g.events.emit({ type: 'blocked', unit: dst, reason: 'evade' });
      return 0;
    }
    let dmg = Math.max(1, Math.round(amount));
    const ctrl = ctrlOf(dst);
    if (dst.kind === 'player' && g.god) {
      ctrl?.onHurt?.(dmg);
      return 0;
    }
    // Absorb shields soak first.
    if (dst.absorb > 0 && now < dst.absorbUntil) {
      const soaked = Math.min(dst.absorb, dmg);
      dst.absorb -= soaked;
      dmg -= soaked;
      ctrl?.onWardHit?.(dst.absorb <= 0);
      if (dmg <= 0) {
        g.events.emit({ type: 'blocked', unit: dst, reason: 'absorbed' });
        return 0;
      }
    }
    dst.hp = Math.max(0, dst.hp - dmg);
    g.multiplayer?.battle.onDamage(src, dst, dmg, o);
    const crit = !!o.crit;
    g.events.emit({ type: 'damage', src, dst, amount: dmg, crit, school: o.school });
    if (dst.kind === 'player') ctrl?.onHurt?.(dmg);
    if (src?.kind === 'player' && o.rage) ctrlOf(src)?.gainRage?.(o.rage);
    if (dst.hp <= 0) {
      this.kill(dst, src);
      return dmg;
    }
    if (!o.noReact && dst.kind !== 'boss') {
      // Keep attack animations readable: only react when not mid-swing.
      const act = dst.motion.action;
      if (!act || act === 'hit_react' || act.startsWith('walk')) dst.act('hit_react', { upper: dst.kind === 'player' });
      dst.express('hurt', 0.4);
    }
    // Wake the victim.
    ctrl?.onDamaged?.(src, dmg);
    return dmg;
  }

  heal(src: Unit | null, dst: Unit, amount: number, crit = false): number {
    if (!dst.alive) return 0;
    const before = dst.hp;
    dst.hp = Math.min(dst.maxHp, dst.hp + Math.round(amount));
    const healed = dst.hp - before;
    this.game.events.emit({ type: 'heal', src, dst, amount, crit });
    if (src) src.lastCombat = Math.max(src.lastCombat, this.game.time - 4);
    return healed;
  }

  kill(dst: Unit, src: Unit | null): void {
    const g = this.game;
    dst.alive = false;
    dst.hp = 0;
    dst.cancelPendingHit();
    // The power-down clip, the smoke as the shell settles and the poof are the sink's.
    g.events.emit({ type: 'death', unit: dst, killer: src });
    ctrlOf(dst)?.onDeath?.(src);
    g.onUnitDied(dst, src);
    g.multiplayer?.battle.onDeath(dst);
  }
}
