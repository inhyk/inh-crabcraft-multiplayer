// What the combat simulation (Combat, abilities.ts, Player, Enemy, Boss) tells the world outside it.
// The simulation never calls the HUD, effects, audio or the camera: it emits these events and the
// host installs a sink. The browser's sink (src/game/browserSink.ts) turns each event into the
// calls the game made before; a server area will install one that sends them to clients. Units are
// passed by reference for now (the browser runs the simulation itself); positions that the
// simulation computed are copied, so a recorded event keeps the value it had.
import type { BossState } from '../../server/combatProtocol';
import type { AbilityDef } from '../data/classes';
import type { School } from './combat';
import type { Unit } from './unit';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });

export type MechKind = NonNullable<BossState['mech']>['kind'];
export type ProjectileStyle = 'bubble' | 'spark' | 'holy' | 'rust';
/** A cast bar label: text, or a function so it follows a language switch. */
export type Label = string | (() => string);

/** One warning mark of a boss mechanic, as drawn on the ground until it fires. */
export type TelegraphShape =
  | { shape: 'circle'; at: Vec3; radius: number; color?: string; ground: Vec3 }
  | { shape: 'cone'; at: Vec3; yaw: number; range: number; half: number; color?: string; ground: Vec3 }
  | { shape: 'lane'; at: Vec3; yaw: number; halfLength: number; halfWidth: number; color: string }
  | { shape: 'undertow'; at: Vec3; radius: number };

/** One effect of a boss mechanic going off. */
export type ImpactShape =
  | { fx: 'slam'; at: Vec3; radius: number }
  | { fx: 'ring'; at: Vec3; color: string; r0: number; r1: number; seconds: number; inner: number }
  | { fx: 'lane'; at: Vec3; yaw: number; halfLength: number; halfWidth: number; seconds: number; color: string }
  | { fx: 'spray'; at: Vec3; yaw: number; range: number; half: number };

/** Why an ability or emote was refused (the English text doubles as the id). */
export type ErrorReason =
  | 'You are stunned.'
  | 'Another action is in progress.'
  | 'Ability is not ready yet.'
  | 'Not enough rage.'
  | 'Not enough mana.'
  | 'You have no target.'
  | 'Invalid target.'
  | 'Out of range.'
  | 'Target too close.'
  | 'Target not in line of sight.'
  | "You can't dance while in combat."
  | 'Stand still to dance.';

export type SimEvent =
  // ------------------------------------------------------------ combat
  /** dmg landed on dst (after absorbs). */
  | { type: 'damage'; src: Unit | null; dst: Unit; amount: number; crit: boolean; school?: School }
  /** A hit that did nothing: the target evaded (leashing, invulnerable) or a shield took all of it. */
  | { type: 'blocked'; unit: Unit; reason: 'evade' | 'absorbed' }
  /** `amount` is what was asked for (the number shown); dst.hp is capped at maxHp. */
  | { type: 'heal'; src: Unit | null; dst: Unit; amount: number; crit: boolean }
  | { type: 'death'; unit: Unit; killer: Unit | null }
  /** A stacking debuff changed (the boss's rust spray). */
  | { type: 'buff'; unit: Unit; buff: 'rust'; stacks: number }
  /** Barnacle Ward: raised, struck, or gone (broken, expired, cleared). */
  | { type: 'ward'; unit: Unit; stage: 'up' | 'hit' | 'down'; seconds?: number }
  // ------------------------------------------------------------ player actions
  | { type: 'castStart'; unit: Unit; seconds: number; ability?: AbilityDef; channel?: { label: Label; to: Vec3; start: number; end: number } }
  | { type: 'castEnd'; unit: Unit; channel: boolean; result: 'done' | 'interrupted'; reason?: string }
  /** An ability's own effects; `stage` 'hit' is the moment it lands (a swing's hit, a dash's arrival). */
  | { type: 'ability'; caster: Unit; ability: string; stage: 'start' | 'hit'; target?: Unit | null; from?: Vec3; yaw?: number; range?: number; half?: number; amount?: number; stun?: number }
  /** A homing projectile: spawned, then it lands (or its target died, or it flew six seconds). */
  | { type: 'projectile'; stage: 'spawn'; id: number; src: Unit; target: Unit; from: Vec3; style: ProjectileStyle; speed: number }
  | { type: 'projectile'; stage: 'hit'; id: number; src: Unit; target: Unit; style: ProjectileStyle; landed: boolean }
  /** An ability key was pressed (the action bar flashes even when the press is refused). */
  | { type: 'press'; unit: Unit; slot: number }
  | { type: 'error'; unit: Unit; reason: ErrorReason }
  | { type: 'target'; unit: Unit; target: Unit | null }
  | { type: 'jump'; unit: Unit }
  | { type: 'footstep'; unit: Unit }
  /** Recall (T) has put the unit back on its chapter's square. */
  | { type: 'recall'; unit: Unit }
  /** The breakdance: started, or one of its moves reached a named moment (take-off, landing). */
  | { type: 'dance'; unit: Unit; stage: 'start' | 'moment'; moment?: string; move?: string }
  | { type: 'xp'; unit: Unit; amount: number }
  /** `jump`: a restore that skipped more than ten levels at once (no health line). */
  | { type: 'levelUp'; unit: Unit; level: number; oldMaxHp: number; maxHp: number; jump: boolean }
  // ------------------------------------------------------------ enemies and bosses
  | { type: 'aggro'; unit: Unit }
  /** The unit rose out of the ground (respawn). */
  | { type: 'spawn'; unit: Unit }
  /** The unit gave up the chase and runs home, untouchable. */
  | { type: 'leash'; unit: Unit }
  /** A plain attack (a warrior's auto-attack, an enemy's or boss's own): started (warning, leap), or landed. */
  | { type: 'attack'; src: Unit; attack: 'auto' | 'claw' | 'seaCast' | 'leap' | 'bossClaw'; stage: 'start' | 'hit'; target?: Unit; at?: Vec3 }
  /** A boss mechanic's warning goes up; it fires `seconds` later. */
  | { type: 'telegraph'; src: Unit; mech: MechKind; level: number; seconds: number; shapes: TelegraphShape[] }
  /** The warning comes down: fired (its marks fade out on their own) or cancelled (marks removed). */
  | { type: 'telegraphEnd'; src: Unit; cancelled: boolean }
  /** A mechanic's effects; `loud` adds the camera shake and the crash (the authority's own). */
  | { type: 'impact'; src: Unit; mech: MechKind; shapes: ImpactShape[]; loud: boolean }
  /**
   * A boss's story beats. 'frame' shows or hides its health frame (a follower's checkpoint);
   * 'phase' with `remote` is a follower seeing the phase change (banner only).
   */
  | { type: 'boss'; boss: Unit; stage: 'engage' | 'awake' | 'phase' | 'reset' | 'death' | 'frame'; phase?: number; show?: boolean; remote?: boolean }
  /** The crab freed from a boss's armour steps out. */
  | { type: 'freed'; unit: Unit }
  | { type: 'say'; unit: Unit; text: string; yell: boolean }
  // ------------------------------------------------------------ outcomes (Game.onUnitDied)
  | { type: 'loot'; unit: Unit; item: 'cog' }
  | { type: 'victory'; boss: Unit; stage: 'banner' | 'end' };

export type SimSink = (e: SimEvent) => void;

/** Where the simulation sends its events. One sink; the host replaces it. */
export class SimEvents {
  sink: SimSink = () => {};
  emit(e: SimEvent): void {
    this.sink(e);
  }
}

/**
 * Timers on the simulation's clock (game seconds), instead of setTimeout: they wait while the game
 * is paused, and a server area runs them on its own tick.
 */
export class SimTimers {
  private list: { at: number; fn: () => void }[] = [];

  /** Run fn at game time `at`. */
  at(at: number, fn: () => void): void {
    this.list.push({ at, fn });
  }

  /** Fire every timer due by `now`, in the order they were set. */
  update(now: number): void {
    if (!this.list.length) return;
    const due = this.list.filter((t) => t.at <= now);
    if (!due.length) return;
    this.list = this.list.filter((t) => t.at > now);
    for (const t of due) t.fn();
  }

  clear(): void {
    this.list.length = 0;
  }

  get size(): number {
    return this.list.length;
  }
}
