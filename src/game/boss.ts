// Corrodius, the Rust Tyrant (docs/design.md "Boss fight"). Three phases, telegraphed Anchor Slam,
// Rust Spray cone with a stacking slow, Scrapling adds and Undertow in phase 2, enrage in phase 3,
// and the death sequence where a small red crab steps out of the armour and walks into the sea.
// Warnings, impacts, yells and the boss frame leave as events (src/game/events.ts); the marks'
// shapes are computed here, so the authority and its followers draw the same thing.
import type { BossState } from '../../server/combatProtocol';
import {t} from '../i18n';
import * as THREE from 'three';
import type { Poi } from '../world/types';
import type { Game } from './game';
import type { Unit } from './unit';
import type { Enemy } from './enemies';
import { v3, type ImpactShape, type TelegraphShape } from './events';
import { skillDelay, skillWindow } from '../motion/skills';
import { BOSS_YELLS } from './quests';
import { BOSS_PROFILES, type BossProfile } from './progression';
import { angleDiff, rand, turnToward, yawTo } from './util';

export const BOSS_HP = 1300;
/** How far past the arena edge the player may kite before Corrodius gives up (after a grace period). */
const ARENA_LEASH = 30;
// The slam and spray mechanics land at a fixed moment (the telegraph's end); the swing starts as
// long before it as the clip takes to reach its own hit, so the claws meet the deck on the impact.
const SLAM_RATE = 1.2;
const SLAM_LEAD = skillDelay('attack_slam', 'hit', skillWindow('attack_slam', 'move', SLAM_RATE)) ?? 0.55;
const SPRAY_LEAD = skillDelay('attack_swipe', 'hit') ?? 0.4;

type Mech = NonNullable<BossState['mech']>['kind'];
type State = 'dormant' | 'waking' | 'idle' | 'fight' | 'dying' | 'dead';

const g1 = new THREE.Vector3();
const g2 = new THREE.Vector3();
const g3 = new THREE.Vector3();
const gn = new THREE.Vector3();

interface ActiveMech {
  kind: Mech;
  t: number;
  dur: number;
  at: THREE.Vector3;
  yaw: number;
  fired: boolean;
  swung: boolean;
}

export class Boss {
  state: State = 'dormant';
  phase = 1;
  enraged = false;
  readonly adds: Enemy[] = [];
  private nextSwing = 0;
  private nextMech = 0;
  private mechIndex = 0;
  private mech: ActiveMech | null = null;
  private stateT = 0;
  private freedStarted = false;
  private outside = 0;
  private get isDawn(){return this.profile.level===100;}
  private participants(){return this.game.combatPlayers().filter(p=>!this.isDawn||p.level>=this.profile.level);}
  private target(){return this.isDawn?this.participants().filter(p=>p.alive).sort((a,b)=>this.unit.distTo(a)-this.unit.distTo(b))[0]??this.game.combatTarget(this.unit):this.game.combatTarget(this.unit);}
  private radius(kind:Mech){return kind==='eclipse'?(this.isDawn?14:11):kind==='slam'?(this.isDawn?4.8:3.4):kind==='nova'?(this.isDawn?8:6):this.isDawn?6.5:5.5;}
  private crossAngles(yaw:number){return this.isDawn?[yaw,yaw+Math.PI/4,yaw+Math.PI/2,yaw+3*Math.PI/4]:[yaw,yaw+Math.PI/2];}
  private get laneLength(){return this.isDawn?15:12;}
  private get laneWidth(){return this.isDawn?1.4:1.8;}
  private get barrageRadius(){return this.isDawn?3:2.6;}
  private get innerRadius(){return this.isDawn?3:4.5;}
  private fraction(kind:Mech){return this.isDawn?({slam:.5,nova:.58,eclipse:.62,cross:.48,barrage:.42,undertow:.45,spray:.4})[kind]:({slam:.26,nova:.32,eclipse:.38,cross:.28,barrage:.24,undertow:.24,spray:.2})[kind];}

  constructor(private readonly game: Game, readonly unit: Unit, readonly arena: Poi, readonly freed: Unit, readonly profile: BossProfile = BOSS_PROFILES.rust) {
    unit.ctrl = this;
    unit.level = profile.level;
    unit.name = profile.name;
    unit.title = profile.title;
    unit.maxHp = unit.hp = profile.hp;
    unit.invulnerable = true;
    unit.hidden = true;
    unit.targetable = false;
    unit.rig.root.visible = false;
    unit.setBaseTint(profile.color);
    freed.hidden = true;
    freed.targetable = false;
    freed.rig.root.visible = false;
    this.freedBaseScale = freed.rig.root.scale.x;
  }

  get engaged(): boolean {
    return this.state === 'fight';
  }

  get telegraphActive(): boolean {
    return !!this.mech && !this.mech.fired;
  }

  get mechName(): string | null {
    return this.mech?.kind ?? null;
  }

  /** Seconds in the current state (waking, dying): what the effects of those states follow. */
  get stateTime(): number {
    return this.stateT;
  }

  /** Seconds since the freed crab stepped out, or -1. */
  get freedTime(): number {
    return this.freedT;
  }

  private remoteMechId = -1;
  networkState(id: BossState['id']): BossState {
    const m = this.mech;
    return { id, state:this.state,phase:this.phase,enraged:this.enraged,
      timeline:this.state==='waking'||this.state==='dying'||this.freedT>=0 ? {state:Math.min(60,this.stateT),freed:this.freedT,freedYaw:this.freedYaw,released:this.freedStarted} : undefined,
      mech:m ? {
      id:this.mechIndex,kind:m.kind,at:[m.at.x,m.at.y,m.at.z],yaw:m.yaw,left:Math.max(0,m.dur-m.t),
    } : null };
  }
  applyNetwork(s: BossState): void {
    const g=this.game;
    if (s.phase > this.phase && s.state === 'fight') g.events.emit({type:'boss',boss:this.unit,stage:'phase',phase:s.phase,remote:true});
    this.state=s.state; this.phase=s.phase; this.enraged=s.enraged;
    const timeline=s.timeline;
    if(timeline&&Number.isFinite(timeline.state)&&Number.isFinite(timeline.freed)&&Number.isFinite(timeline.freedYaw)&&typeof timeline.released==='boolean'){
      this.stateT=THREE.MathUtils.clamp(timeline.state,0,60);
      this.freedT=THREE.MathUtils.clamp(timeline.freed,-1,13);
      this.freedYaw=THREE.MathUtils.clamp(timeline.freedYaw,-10000,10000);
      this.freedStarted=timeline.released;
      if(this.freedStarted&&this.freedT>=1.6)this.freed.npcId='bowed';
      const growth=this.freedT>=0&&this.freedT<1.2 ? .3+.7*this.freedT/1.2 : 1;
      this.freed.rig.root.scale.setScalar(this.freedBaseScale*growth);
      this.freed.lift=this.freedT>10.5 ? -(this.freedT-10.5)*.8 : 0;
    } else this.stateT=0; // Legacy checkpoints retain their previous restart behavior.

    this.unit.setBaseTint(this.enraged ? '#fff4d9' : this.profile.color);
    g.events.emit({type:'boss',boss:this.unit,stage:'frame',show:this.state==='fight'});
    const m=s.mech;
    if (!m) {
      const old=this.mech;
      if (old && s.state === 'fight') {
        g.events.emit({type:'impact',src:this.unit,mech:old.kind,shapes:this.impactShapes(old.kind,old.at,old.yaw),loud:false});
      }
      this.clearMech(); this.remoteMechId=-1; return;
    }
    if (m.id === this.remoteMechId && this.mech) {
      // Followers do not simulate attacks. Keep the latest checkpoint time for host election
      // without recreating the visible warning/telegraphs on every room snapshot.
      this.mech.t=Math.max(0,this.mech.dur-m.left);
      return;
    }
    this.clearMech(); this.remoteMechId=m.id;
    const at=new THREE.Vector3(...m.at);
    const duration=Math.max(0.05,m.left);
    const shapes=this.telegraphShapes(m.kind,at,m.yaw);
    this.mech={kind:m.kind,t:0,dur:duration,at,yaw:m.yaw,fired:false,swung:false};
    this.mechIndex=m.id;
    g.events.emit({type:'telegraph',src:this.unit,mech:m.kind,level:this.profile.level,seconds:duration,shapes});
  }
  resumeAuthority(): void {
    // Preserve replicated attack and cinematic timelines; restart only local scheduling timers.
    this.nextSwing=this.game.time+1; this.nextMech=this.game.time+3;
    this.outside=0; this.unit.cancelPendingHit();
    if (this.profile.level===3) { this.adds.length=0; this.adds.push(...this.game.enemies.filter(e=>e.isAdd && e.unit.alive && !e.unit.hidden)); }
  }

  /** The beacon is lit: Corrodius heaves himself up on the deck. */
  wake(): void {
    if(this.isDawn&&this.game.partyLevel<this.profile.level)return;
    if (this.game.multiplayer?.battle.challenge(this.profile.level === 100 ? 'b30' : this.profile.level === 20 ? 'b20' : this.profile.level === 10 ? 'b10' : 'b3')) return;
    if (this.state !== 'dormant') return;
    if(this.profile.level<20 && this.game.world.getEnvironment?.().beacon===false)return;
    const g = this.game;
    const u = this.unit;
    this.state = 'waking';
    this.stateT = 0;
    u.hidden = false;
    u.rig.root.visible = true;
    u.teleport(g.world, this.arena.position.x, this.arena.position.z, this.arena.yaw);
    u.lift = -u.height;
  }

  onDamaged(src: Unit | null): void {
    if (this.state === 'idle' && src && this.game.partyLevel >= this.profile.level) this.engage();
  }

  private yell(u: Unit, text: string): void {
    this.game.events.emit({ type: 'say', unit: u, text, yell: true });
  }

  private engage(): void {
    const g = this.game;
    if(this.profile.level<20&&g.world.getEnvironment?.().beacon===false)return;
    if (g.partyLevel < this.profile.level) return;
    this.state = 'fight';
    if(this.profile.level<20)g.world.setMood?.(1);
    // Moonwater mends every fighter while the boss stands (consumed by the victory).
    for (const p of g.combatPlayers()) p.blessingUntil = Infinity;
    this.nextSwing = g.time + 1.2;
    this.nextMech = g.time + 4;
    this.unit.express('angry', 3);
    this.yell(this.unit, this.profile.level === 100 ? t('너희의 새벽도, 친구도 내 것이다!','Your dawn and your friend belong to me!') : this.profile.level === 20 ? t('별의 문을 연 자여, 일식의 시험을 받아라!','You who opened the star gate, face the trial of the eclipse!') : this.profile.level >= 10 ? t('심해의 빛을 피할 수 있겠느냐!','Can you escape the light of the deep?') : BOSS_YELLS.engage);
    g.events.emit({ type: 'boss', boss: this.unit, stage: 'engage' });
  }

  sleep():void {
    if(this.state==='dead'||this.state==='dying')return;
    this.reset();this.state='dormant';this.unit.hidden=true;this.unit.invulnerable=true;this.unit.targetable=false;
    this.unit.cancelPendingHit();this.unit.motion.stop(undefined,.2);
  }

  reset(): void {
    const g = this.game;
    const u = this.unit;
    if (this.state === 'dormant' || this.state === 'dead' || this.state === 'dying') return;
    this.clearMech();
    for (const a of this.adds) a.despawn();
    this.adds.length = 0;
    u.hp = u.maxHp;
    u.alive = true;
    u.stunUntil = u.slowUntil = 0;
    this.phase = 1;
    this.enraged = false;
    u.setBaseTint(this.profile.color);
    u.motion.stop(undefined, 0.2);
    u.teleport(g.world, this.arena.position.x, this.arena.position.z, this.arena.yaw);
    this.state = 'idle';
    this.outside = 0;
    this.mechIndex = 0;
    u.cancelPendingHit();
    g.events.emit({ type: 'boss', boss: u, stage: 'reset' });
  }

  onDeath(): void {
    const g = this.game;
    this.state = 'dying';
    this.stateT = 0;
    this.clearMech();
    for (const a of this.adds) if (a.unit.alive) g.combat.kill(a.unit, null);
    this.yell(this.unit, this.profile.level === 100 ? t('새벽의 빛을… 가둘 수는 없었구나.','The dawn… could never be imprisoned.') : this.profile.level === 20 ? t('일식이 걷히는구나… 두 세계를 부탁한다.','The eclipse fades… Take care of both worlds.') : this.profile.level >= 10 ? t('심해가 다시 잠잠해지는구나…','The deep grows quiet once more…') : BOSS_YELLS.death);
    g.events.emit({ type: 'boss', boss: this.unit, stage: 'death' });
    this.unit.targetable = false;
  }

  update(dt: number): void {
    const g = this.game;
    const u = this.unit;
    const now = g.time;
    const p = this.target();
    this.stateT += dt;
    const unlocked = this.isDawn?p.level>=this.profile.level:(g.partyLevel ?? p.level) >= this.profile.level;
    u.invulnerable = !unlocked;
    if (this.state === 'idle') u.targetable = unlocked;
    switch (this.state) {
      case 'dormant':
      case 'dead':
        this.updateFreed(dt);
        return;
      case 'waking': {
        // The deck's dust while he heaves himself up is drawn from stateTime (src/game/browserSink.ts).
        const k = Math.min(1, this.stateT / 2.4);
        u.lift = -u.height * (1 - k) * (1 - k);
        u.pos.y = g.world.heightAt(u.pos.x, u.pos.z) + u.lift;
        if (k >= 1) {
          u.lift = 0;
          this.state = 'idle';
          u.targetable = unlocked;
          u.act('attack_slam');
          this.yell(u, this.profile.level === 100 ? t('솔라칸이 황혼 성채에서 깨어났다.','Solarkan awakens in the Twilight Citadel.') : this.profile.level === 20 ? t('아스트라가 별의 왕좌에서 깨어났다.','Astra awakens upon the Star Throne.') : this.profile.level >= 10 ? t('네레이드가 심해에서 깨어났다.','Nereid awakens from the deep.') : BOSS_YELLS.wake);
          g.events.emit({ type: 'boss', boss: u, stage: 'awake' });
        }
        u.feedLocomotion(dt);
        return;
      }
      case 'idle': {
        // Wait on the deck; anyone stepping onto it is noticed.
        if (unlocked && p.alive && !(p.kind === 'player' && g.controlsLocked) && Math.hypot(p.pos.x - this.arena.position.x, p.pos.z - this.arena.position.z) < this.arena.radius * 0.9) this.engage();
        u.setYaw(turnToward(u.yaw, p.alive ? yawTo(u.pos.x, u.pos.z, p.pos.x, p.pos.z) : this.arena.yaw, 0.8, dt));
        u.feedLocomotion(dt);
        return;
      }
      case 'dying': {
        this.updateDeath(dt);
        return;
      }
      case 'fight':
        break;
    }

    // Leash: the player died, or left the wreck and stayed away.
    const fromArena = Math.hypot(p.pos.x - this.arena.position.x, p.pos.z - this.arena.position.z);
    this.outside = fromArena > this.arena.radius + ARENA_LEASH ? this.outside + dt : 0;
    if (!p.alive || this.isDawn&&p.level<this.profile.level || this.outside > 4) {
      if (p.alive) this.yell(u, t('달아나라, 작은 껍질아. 녹은 기억한다.','Run, little shell. The rust remembers.'));
      this.reset();
      return;
    }

    // Phase changes (an enraged boss vents heat; the sink draws it from `enraged`)
    const frac = u.hp / u.maxHp;
    if (this.phase === 1 && frac < (this.isDawn?.75:.6)) this.enterPhase2();
    if (this.phase === 2 && frac < (this.isDawn?.4:.25)) this.enterPhase3();

    const stunned = !this.isDawn&&u.stunned(now);
    if (this.mech) {
      this.updateMech(dt);
    } else if (!stunned) {
      // Chase and claw.
      const gap = u.gapTo(p);
      const want = yawTo(u.pos.x, u.pos.z, p.pos.x, p.pos.z);
      u.setYaw(turnToward(u.yaw, want, this.enraged ? 3 : 2.2, dt));
      if (gap > 1.0) {
        const sp = this.isDawn?(this.enraged?4.2:3.4):(this.enraged ? 2.8 : 2.0) * u.speedMul(now);
        const d = u.distTo(p) || 1;
        u.moveTo(g.world, u.pos.x + ((p.pos.x - u.pos.x) / d) * sp * dt, u.pos.z + ((p.pos.z - u.pos.z) / d) * sp * dt, dt);
      }
      if (gap <= 1.6 && now >= this.nextSwing && Math.abs(angleDiff(want, u.yaw)) < 0.8) {
        this.nextSwing = now + (this.isDawn?(this.enraged?1.3:1.8):(this.enraged ? 1.8 : 2.6));
        u.act('attack_swipe', {
          upper: true,
          speed: this.enraged ? 1.4 : 1,
          onHit: () => {
            if (!u.alive || !p.alive || u.gapTo(p) > 2.4) return;
            g.combat.damage(u, p, rand(7, 10) * this.profile.damage * (this.enraged ? 1.25 : 1));
            g.events.emit({ type: 'attack', src: u, attack: 'bossClaw', stage: 'hit', target: p });
          },
        });
      }
      if (now >= this.nextMech) this.startMech();
    }
    u.feedLocomotion(dt);
  }

  private enterPhase2(): void {
    const g = this.game;
    this.phase = 2;
    this.yell(this.unit, this.profile.level === 100 ? t('황혼의 불길 속으로 들어오라!','Step into the flames of twilight!') : this.profile.level === 20 ? t('별의 그림자 속으로 들어오라!','Step into the shadow of the stars!') : this.profile.level >= 10 ? t('깊은 바다의 힘이 깨어난다!','The power of the deep awakens!') : BOSS_YELLS.phase2);
    g.events.emit({ type: 'boss', boss: this.unit, stage: 'phase', phase: 2 });
    const u = this.unit;
    for (let i = 0; i < (this.profile.level >= 10 ? 0 : 3); i++) {
      const a = u.yaw + Math.PI + (i - 1) * 0.9;
      const r = u.radius + 3.5;
      const add = g.spawnAdd(u.pos.x + Math.sin(a) * r, u.pos.z + Math.cos(a) * r);
      if (add) this.adds.push(add);
    }
    this.mechIndex = 0;
    this.nextMech = g.time + 3;
  }

  private enterPhase3(): void {
    const g = this.game;
    this.phase = 3;
    this.enraged = true;
    this.unit.setBaseTint('#fff1d6');
    this.unit.express('angry', 999);
    this.yell(this.unit, this.profile.level >= 10 ? t('왕관의 빛이여, 모든 것을 삼켜라!','Light of the crown, consume everything!') : BOSS_YELLS.phase3);
    g.events.emit({ type: 'boss', boss: this.unit, stage: 'phase', phase: 3 });
    this.nextMech = g.time + 2.5;
  }

  private startMech(): void {
    const g = this.game;
    const u = this.unit;
    const p = this.target();
    const order: Mech[] = this.isDawn ? (this.phase===1?['cross','barrage','slam','nova','spray']:this.phase===2?['barrage','eclipse','cross','nova','undertow','slam']:['cross','barrage','eclipse','nova','cross','undertow','barrage','slam']) : this.profile.level === 20 ? (this.phase === 1 ? ['slam','eclipse','nova','cross','barrage'] : ['eclipse','nova','undertow','cross','barrage','eclipse']) : this.profile.level >= 10 ?
      (this.phase === 1 ? ['slam', 'nova', 'spray', 'cross', 'barrage'] : ['nova', 'undertow', 'slam', 'cross', 'barrage', 'nova']) :
      this.phase === 1 ? ['slam', 'spray'] : this.phase === 2 ? ['undertow', 'slam', 'spray', 'cross', 'slam'] : ['slam', 'spray', 'undertow', 'cross', 'barrage'];
    const kind = order[this.mechIndex++ % order.length];
    const m: ActiveMech = { kind, t: 0, dur: 1.5, at: new THREE.Vector3(), yaw: u.yaw, fired: false, swung: false };
    const speedUp = (this.enraged ? 0.8 : 1) * this.profile.tempo;
    if (kind === 'slam') { m.dur=1.5*speedUp; m.at.copy(p.pos); }
    else if (kind === 'spray') {
      m.dur=1.1*speedUp; m.at.copy(u.pos);
      m.yaw=yawTo(u.pos.x,u.pos.z,p.pos.x,p.pos.z); u.setYaw(m.yaw);
    } else if (kind === 'eclipse') { m.dur=2.8*speedUp; m.at.copy(u.pos); }
    else if (kind === 'nova') {
      m.dur=2.2*speedUp;
      if (this.profile.level >= 20) m.dur=Math.max(m.dur,1.9);
      m.at.copy(p.pos);
    } else if (kind === 'cross') {
      m.dur=Math.max(2.6,3.1*speedUp); m.at.copy(u.pos);
      m.yaw=yawTo(u.pos.x,u.pos.z,p.pos.x,p.pos.z);
    } else if (kind === 'barrage') {
      m.dur=Math.max(2.6,3*speedUp); m.at.copy(p.pos);
      m.yaw=yawTo(u.pos.x,u.pos.z,p.pos.x,p.pos.z);
    } else {
      m.dur=2.6; m.at.copy(u.pos); this.yell(u,BOSS_YELLS.undertow);
    }
    if(this.isDawn){
      // Larger warnings retain time to walk out; difficulty comes from pressure and mistakes.
      m.dur=Math.max(m.dur,kind==='nova'?2.4:kind==='eclipse'?2.8:kind==='undertow'?3:kind==='slam'?1.6:1.3);
    }
    const shapes = this.telegraphShapes(kind,m.at,m.yaw);
    this.mech = m;
    g.events.emit({ type: 'telegraph', src: u, mech: kind, level: this.profile.level, seconds: m.dur, shapes });
    this.nextMech = g.time + m.dur + (this.isDawn?(this.phase===3?.9:this.phase===2?1.2:1.8):(this.phase === 3 ? 4.2 : this.phase === 2 ? 5.5 : 6));
  }

  private barragePoints(at: THREE.Vector3, yaw: number): THREE.Vector3[] {
    if(this.isDawn)return [[0,0],[6,0],[-6,0],[0,6],[0,-6]].map(([x,z])=>new THREE.Vector3(at.x+x*Math.cos(yaw)+z*Math.sin(yaw),at.y,at.z-x*Math.sin(yaw)+z*Math.cos(yaw)));
    return [-6,0,6].map(offset => new THREE.Vector3(at.x+Math.cos(yaw)*offset,at.y,at.z-Math.sin(yaw)*offset));
  }

  /**
   * One layout for host and followers; shape dimensions also match damage tests below. Each mark
   * is laid on the deck under it, which moves `at` onto the deck (the circle's centre height).
   */
  private telegraphShapes(kind: Mech, at: THREE.Vector3, yaw: number): TelegraphShape[] {
    if (kind==='cross') return this.crossAngles(yaw).map(a=>({shape:'lane',at:v3(at),yaw:a,halfLength:this.laneLength,halfWidth:this.laneWidth,color:'#ffb64d'}));
    if (kind==='barrage') return this.barragePoints(at,yaw).map(p=>{const ground=v3(this.deckUnder(p,this.barrageRadius,0,Math.PI));return {shape:'circle',at:v3(p),radius:this.barrageRadius,color:'#cf8aff',ground};});
    if (kind==='spray') {const ground=v3(this.deckUnder(at,11,yaw,.55));return [{shape:'cone',at:v3(at),yaw,range:11,half:.55,ground}];}
    const radius=this.radius(kind);
    const color=kind==='eclipse'?'#a050ff':kind==='nova'?this.profile.color:undefined;
    const ground=v3(this.deckUnder(at,radius,0,Math.PI));
    const shapes:TelegraphShape[]=[{shape:'circle',at:v3(at),radius,color,ground}];
    if(kind==='eclipse'){const inner=v3(this.deckUnder(at,this.innerRadius,0,Math.PI));shapes.push({shape:'circle',at:v3(at),radius:this.innerRadius,color:'#71ffca',ground:inner});}
    if(kind==='undertow')shapes.push({shape:'undertow',at:v3(at),radius:this.radius(kind)});
    return shapes;
  }

  /**
   * The plane of the deck under a telegraph (the wreck's deck tilts by up to half a unit across a
   * cone, enough to bury a flat mark): fitted through three points inside the mark, the mark's origin
   * moved onto it. Returns the plane's normal.
   */
  private deckUnder(at: THREE.Vector3, reach: number, yaw: number, half: number): THREE.Vector3 {
    const w = this.game.world;
    const cone = half < 3;
    const r = reach * (cone ? 0.85 : 0.7);
    const put = (out: THREE.Vector3, a: number, d: number) => {
      out.set(at.x + Math.sin(a) * d, 0, at.z + Math.cos(a) * d);
      out.y = w.heightAt(out.x, out.z);
      return out;
    };
    if (cone) {
      put(g1, yaw, 0);
      put(g2, yaw - half * 0.8, r);
      put(g3, yaw + half * 0.8, r);
    } else {
      put(g1, 0, r);
      put(g2, (Math.PI * 2) / 3, r);
      put(g3, (Math.PI * 4) / 3, r);
    }
    // Height of the plane at the origin: the apex of a cone, the centroid of a circle's samples.
    const gy = w.heightAt(at.x, at.z);
    at.y = cone ? gy : (g1.y + g2.y + g3.y) / 3;
    if (Math.abs(at.y - gy) > 0.5) at.y = gy;
    const n = gn.crossVectors(g2.sub(g1), g3.sub(g1)).normalize();
    if (!Number.isFinite(n.y)) n.set(0, 1, 0);
    if (n.y < 0) n.negate();
    // Never more than ~10 degrees: a sample off the deck edge must not stand the mark up.
    if (!(n.y >= 0.985)) n.set(n.x, 0, n.z).setLength(Math.sqrt(1 - 0.985 * 0.985)).setY(0.985);
    return n;
  }

  private updateMech(dt: number): void {
    const g = this.game;
    const u = this.unit;
    const m = this.mech!;
    m.t += dt;
    if (m.kind === 'slam') {
      u.setYaw(turnToward(u.yaw, yawTo(u.pos.x, u.pos.z, m.at.x, m.at.z), 3, dt));
      if (!m.swung && m.t > m.dur - SLAM_LEAD) {
        m.swung = true;
        u.act('attack_slam', { speed: SLAM_RATE });
      }
      if (m.t >= m.dur) {
        m.fired = true;
        this.impact('slam',m.at);
        for (const p of this.participants()) if (p.alive && Math.hypot(p.pos.x - m.at.x, p.pos.z - m.at.z) < this.radius('slam') + p.radius * 0.5) {
          g.combat.damage(u, p, p.maxHp * this.fraction('slam'));
          p.stunUntil = Math.max(p.stunUntil, g.time + 0.5);
        }
        this.finishMech();
      }
    } else if (m.kind === 'spray') {
      if (!m.swung && m.t > m.dur - SPRAY_LEAD) {
        m.swung = true;
        u.act('attack_swipe', { upper: true });
        g.events.emit({ type: 'impact', src: u, mech: 'spray', shapes: this.impactShapes('spray', m.at, m.yaw), loud: false });
      }
      if (m.t >= m.dur) {
        m.fired = true;
        for (const p of this.participants()) {
        const d = Math.hypot(p.pos.x - m.at.x, p.pos.z - m.at.z);
        const a = yawTo(m.at.x, m.at.z, p.pos.x, p.pos.z);
        if (p.alive && d < 11 + p.radius && Math.abs(angleDiff(a, m.yaw)) < 0.55 + Math.atan2(p.radius, Math.max(1, d))) {
          g.combat.damage(u, p, rand(6, 9) * this.profile.damage);
          p.rust = Math.min(5, (g.time < p.rustUntil ? p.rust : 0) + 1);
          p.rustUntil = g.time + 10;
          g.events.emit({ type: 'buff', unit: p, buff: 'rust', stacks: p.rust });
        }
        }
        this.finishMech();
      }
    } else if (m.kind === 'eclipse') {
      if (!m.swung && m.t > m.dur - SLAM_LEAD) { m.swung=true; u.act('attack_slam', {speed:SLAM_RATE}); }
      if (m.t >= m.dur) {
        m.fired=true; this.impact('eclipse',m.at);
        for (const p of this.participants()) {
          const d=Math.hypot(p.pos.x-m.at.x,p.pos.z-m.at.z);
          if(p.alive && d>this.innerRadius && d<this.radius('eclipse')+p.radius*0.5) g.combat.damage(u,p,p.maxHp*this.fraction('eclipse'));
        }
        this.finishMech();
      }
    } else if (m.kind === 'nova') {
      if (!m.swung && m.t > m.dur - SLAM_LEAD) { m.swung = true; u.act('attack_slam', { speed: SLAM_RATE }); }
      if (m.t >= m.dur) {
        m.fired = true;
        this.impact('nova',m.at);
        for (const p of this.participants()) if (p.alive && Math.hypot(p.pos.x - m.at.x, p.pos.z - m.at.z) < this.radius('nova') + p.radius * 0.5) g.combat.damage(u, p, p.maxHp * this.fraction('nova'));
        this.finishMech();
      }
    } else if (m.kind==='cross' || m.kind==='barrage') {
      if (!m.swung && m.t>m.dur-SLAM_LEAD) { m.swung=true; u.act('attack_slam',{speed:SLAM_RATE}); }
      if (m.t>=m.dur) {
        m.fired=true; this.impact(m.kind,m.at,m.yaw);
        const points=m.kind==='barrage'?this.barragePoints(m.at,m.yaw):[];
        for(const p of this.participants()) {
          if(!p.alive)continue;
          const dx=p.pos.x-m.at.x,dz=p.pos.z-m.at.z;
          const hit=m.kind==='cross'
            ? this.crossAngles(m.yaw).some(a=>{const x=dx*Math.cos(a)-dz*Math.sin(a),z=dx*Math.sin(a)+dz*Math.cos(a);return Math.abs(x)<this.laneWidth+p.radius*.5&&Math.abs(z)<this.laneLength;})
            : points.some(at=>Math.hypot(p.pos.x-at.x,p.pos.z-at.z)<this.barrageRadius+p.radius*.5);
          if(hit)g.combat.damage(u,p,p.maxHp*this.fraction(m.kind));
        }
        this.finishMech();
      }
    } else {
      // Undertow: drag the player toward the hull, then slam everything around it.
      for (const p of this.participants()) if (p.alive && m.t < m.dur - 0.3) {
        const d = u.distTo(p);
        if (d < 18 && d > u.radius + p.radius + 0.3) {
          const pull = 3.2;
          p.pushX = ((u.pos.x - p.pos.x) / d) * pull;
          p.pushZ = ((u.pos.z - p.pos.z) / d) * pull;
          p.pushTime = 0.05;
        }
      }
      if (!m.swung && m.t > m.dur - SLAM_LEAD) {
        m.swung = true;
        u.act('attack_slam', { speed: SLAM_RATE });
      }
      if (m.t >= m.dur) {
        m.fired = true;
        this.impact('undertow',m.at);
        for (const p of this.participants()) if (p.alive && u.distTo(p) < this.radius('undertow') + p.radius * 0.5) g.combat.damage(u, p, p.maxHp * this.fraction('undertow'));
        this.finishMech();
      }
    }
  }

  /** The authority's own impact: its effects with the shake and the crash. */
  private impact(kind:Mech,at:THREE.Vector3,yaw=0):void {
    this.game.events.emit({ type: 'impact', src: this.unit, mech: kind, shapes: this.impactShapes(kind, at, yaw), loud: true });
  }

  /** What a mechanic going off looks like: the same for the authority and its followers. */
  private impactShapes(kind:Mech,at:THREE.Vector3,yaw=0):ImpactShape[] {
    if(kind==='cross')return this.crossAngles(yaw).map(a=>({fx:'lane',at:v3(at),yaw:a,halfLength:this.laneLength,halfWidth:this.laneWidth,seconds:.4,color:'#ffd390'}));
    if(kind==='barrage')return this.barragePoints(at,yaw).map(p=>({fx:'slam',at:{x:p.x,y:this.game.world.heightAt(p.x,p.z),z:p.z},radius:this.barrageRadius}));
    if(kind==='spray')return [{fx:'spray',at:v3(at),yaw,range:11,half:.55}];
    if(kind==='eclipse')return [{fx:'ring',at:v3(at),color:'#b577ff',r0:this.radius(kind),r1:this.innerRadius,seconds:.8,inner:.9}];
    const shapes:ImpactShape[]=[];
    if(kind==='nova'){
      const color=this.profile.color;
      shapes.push({fx:'ring',at:v3(at),color,r0:.5,r1:this.radius(kind)+1,seconds:.6,inner:.85},{fx:'ring',at:v3(at),color,r0:1,r1:this.radius(kind),seconds:.8,inner:.7});
    }
    shapes.push({fx:'slam',at:v3(at),radius:this.radius(kind)});
    return shapes;
  }

  refreshLanguage():void {
    this.unit.name=this.profile.name;this.unit.title=this.profile.title;
  }

  /** The mechanic fired: its warning comes down, its marks fade out on their own. */
  private finishMech():void {
    this.mech=null;
    this.game.events.emit({ type: 'telegraphEnd', src: this.unit, cancelled: false });
  }

  /** The mechanic is called off (reset, death, a follower's newer checkpoint): marks and warning go. */
  private clearMech(): void {
    this.mech = null;
    this.game.events.emit({ type: 'telegraphEnd', src: this.unit, cancelled: true });
  }

  /** Debug F9: drop to the next phase threshold, then to zero. */
  debugAdvance(src: Unit): void {
    const g = this.game;
    const u = this.unit;
    if (this.state === 'idle') this.engage();
    if (this.state !== 'fight') return;
    const target = this.phase === 1 ? 0.58 : this.phase === 2 ? 0.23 : 0;
    const dmg = u.hp - u.maxHp * target;
    if (target === 0) g.combat.damage(src, u, u.hp + 10, { crit: true });
    else if (dmg > 0) g.combat.damage(src, u, dmg, { crit: true });
  }

  // ---------------------------------------------------------------- death sequence

  private updateDeath(dt: number): void {
    const g = this.game;
    const u = this.unit;
    const t = this.stateT;
    if (t > 2.2 && !this.freedStarted) {
      this.freedStarted = true;
      this.releaseFreed();
    }
    if (t > 6) {
      // The empty hull settles into the deck.
      u.lift = -Math.min(1, (t - 6) / 4) * u.height * 0.7;
      u.pos.y = g.world.heightAt(u.pos.x, u.pos.z) + u.lift;
    }
    if (t > 10.5) {
      u.hidden = true;
      u.rig.root.visible = false;
      this.state = 'dead';
      this.stateT = 0;
    }
    this.updateFreed(dt);
  }

  private freedT = -1;
  private freedYaw = 0;

  private releaseFreed(): void {
    const g = this.game;
    const f = this.freed;
    const u = this.unit;
    f.hidden = false;
    f.rig.root.visible = true;
    f.alive = true;
    const p = g.combatTarget(u);
    const toward = yawTo(u.pos.x, u.pos.z, p.pos.x, p.pos.z);
    f.teleport(g.world, u.pos.x, u.pos.z, toward);
    f.rig.root.scale.setScalar(this.freedBaseScale * 0.3);
    this.freedT = 0;
    this.freedYaw = toward;
    g.events.emit({ type: 'freed', unit: f });
  }

  private freedBaseScale = 0;

  private updateFreed(dt: number): void {
    if (this.freedT < 0) return;
    const g = this.game;
    const f = this.freed;
    const u = this.unit;
    const p = g.combatTarget(u);
    this.freedT += dt;
    const freedTime = this.freedT;
    // 0..1.2 grow and step out of the hull
    if (freedTime < 1.2) {
      const k = freedTime / 1.2;
      f.rig.root.scale.setScalar(this.freedBaseScale * (0.3 + 0.7 * k));
      const out = u.radius + 1.6;
      f.moveTo(g.world, u.pos.x + Math.sin(this.freedYaw) * out * k, u.pos.z + Math.cos(this.freedYaw) * out * k, dt);
    } else if (freedTime < 1.6) {
      f.rig.root.scale.setScalar(this.freedBaseScale);
      f.setYaw(turnToward(f.yaw, yawTo(f.pos.x, f.pos.z, p.pos.x, p.pos.z), 6, dt));
    } else if (freedTime < 4.6) {
      if (!f.npcId) {
        f.npcId = 'bowed';
        f.act('gesture_bow');
        f.express('love', 3);
        g.events.emit({ type: 'say', unit: f, text: t('고마워. 그 안은 정말 어두웠어.','Thank you. It was very dark in there.'), yell: false });
      }
    } else if (freedTime < 12) {
      // Scuttle sideways into the sea (the sink draws the foam from freedTime).
      const sea = g.seaDirection();
      const yaw = Math.atan2(sea.x, sea.z) + Math.PI / 2;
      f.setYaw(turnToward(f.yaw, yaw, 4, dt));
      f.moveTo(g.world, f.pos.x + sea.x * 3.4 * dt, f.pos.z + sea.z * 3.4 * dt, dt);
      if (freedTime > 10.5) f.lift = -(freedTime - 10.5) * 0.8;
    } else {
      f.hidden = true;
      f.alive = false;
      f.rig.root.visible = false;
      this.freedT = -1;
    }
    f.feedLocomotion(dt);
  }
}
