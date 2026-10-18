// How gameplay plays the six skill clips: attack_swipe, attack_slam, cast, hit_react, death and
// sit, each a rollout of a jumper.skill_* policy recorded through the crabcraft bundle. A recorded
// clip runs from the button press to the robot standing again (the controller's ramp, the move,
// the hand-back), so every caller plays a window of it with the motion controller's from/to: the
// move as the task's docs cut it (src/motion/skillClips.ts, generated from the rollouts), less a
// lead-in where combat wants the blow sooner, at a rate chosen here. Gameplay that waits for a
// moment (the hit, the release, the shell settling) reads it from the same clip.
import { SKILL_CLIPS } from './skillClips';
import type { MotionId, MotionPlayOptions } from './types';

export type SkillId = keyof typeof SKILL_CLIPS;

/**
 * Playback rate when the caller names none. The policies move at the robot's own pace, which
 * balance sets (docs/CRABCRAFT_SKILLS.md in the jumper repository): the swipe's hit comes 0.60 s
 * into its move and the slam's impact 0.72 s into its window, against 0.31 s and 0.60 s for the
 * keyframes they replace. A caller's own `speed` replaces this one, not multiplies it.
 */
export const SKILL_RATE: Record<SkillId, number> = {
  attack_swipe: 1.25,
  attack_slam: 1.2,
  cast: 1.25,
  hit_react: 1,
  death: 1.2,
  sit: 1,
};

/**
 * Seconds of the move's own start the game skips, so the blow lands about when the keyframe's did:
 * the swipe starts with its claw already rising toward the wind-up (0.25 s into a 0.94 s move),
 * the slam with the body rocked back and the claws on their way up (0.25 s into 1.10 s). With the
 * rates above the swipe's hit lands 0.28 s after the swing starts and the slam's impact 0.38 s.
 */
const LEAD_IN: Partial<Record<SkillId, number>> = {
  attack_swipe: 0.25,
  attack_slam: 0.25,
};

/** Clip seconds before the cast's release where its release segment starts (the fling's run-up). */
const RELEASE_RUN_UP = 0.05;

/**
 * Which part of a skill clip to play:
 * - 'move': the whole move, as gameplay plays it (the default);
 * - 'channel': the cast's gather, then its channel looped (casting and channelling);
 * - 'release': the cast's fling and recovery, from just before the release.
 */
export type SkillPart = 'move' | 'channel' | 'release';

export interface SkillWindow {
  from: number;
  to: number;
  loopFrom?: number;
  speed: number;
}

export function isSkill(id: MotionId): id is SkillId {
  return id in SKILL_CLIPS;
}

function events(id: SkillId): Record<string, number> {
  return SKILL_CLIPS[id].events as Record<string, number>;
}

/** The clip window and rate a skill plays with. */
export function skillWindow(id: SkillId, part: SkillPart = 'move', speed?: number): SkillWindow {
  const c = SKILL_CLIPS[id];
  const ev = events(id);
  const rate = speed ?? SKILL_RATE[id];
  if (id === 'cast' && part === 'channel') return { from: c.from, loopFrom: ev.channel_from, to: ev.channel_to, speed: rate };
  if (id === 'cast' && part === 'release') return { from: ev.release - RELEASE_RUN_UP, to: c.to, speed: rate };
  return { from: c.from + (LEAD_IN[id] ?? 0), to: c.to, speed: rate };
}

/** Seconds of play from the start of `w` until the clip's `event` (null when the clip has none). */
export function skillDelay(id: SkillId, event: string, w: SkillWindow = skillWindow(id)): number | null {
  const t = events(id)[event];
  if (t === undefined) return null;
  return Math.max(0, (t - w.from) / w.speed);
}

/**
 * Seconds from the start of an action until a skill clip's 'hit' moment, for the window and rate
 * Unit.act plays it at (the same arguments). Null for other clips and for windows the caller cut
 * itself (`from`). Gameplay lands a blow at this time; the clip only shows it.
 */
export function actionHitDelay(id: MotionId, o: { speed?: number; part?: SkillPart; loop?: boolean; from?: number } = {}): number | null {
  if (!isSkill(id) || o.from !== undefined) return null;
  return skillDelay(id, 'hit', skillWindow(id, o.part ?? (o.loop ? 'channel' : 'move'), o.speed));
}

/** MotionPlayOptions for a skill clip: its window and rate, merged under the caller's options. */
export function skillPlayOptions(id: MotionId, opts: MotionPlayOptions = {}, part: SkillPart = opts.loop ? 'channel' : 'move'): MotionPlayOptions {
  if (!isSkill(id)) return opts;
  const w = skillWindow(id, part, opts.speed);
  return {
    ...opts,
    from: opts.from ?? w.from,
    to: opts.to ?? w.to,
    loopFrom: opts.loopFrom ?? w.loopFrom,
    speed: w.speed,
  };
}
