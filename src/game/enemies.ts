// Scraplings and Rustclaw Scavengers: wander near their spawn, aggro (with their pack), chase,
// claw, leash back home, die, drop cogs and respawn when no player is near. Effects and sounds
// leave as events (src/game/events.ts).
import * as THREE from 'three';
import type { Game } from './game';
import { lineOfSight, type Unit } from './unit';
import { v3 } from './events';
import { damp, rand, TAU, turnToward, yawTo } from './util';
import {t} from '../i18n';

export type EnemyKind = 'scrapling' | 'scavenger' | 'jellyfish';

interface Stats {
  name: string;
  level: number;
  hp: number;
  speed: number;
  aggro: number;
  dmg: [number, number];
  swing: number;
  xp: number;
  leash: number;
  respawn: number;
}

export const ENEMY_STATS: Record<EnemyKind, Stats> = {
  jellyfish: {name:'Tide Jelly Drone',level:2,hp:85,speed:2.6,aggro:9,dmg:[6,9],swing:3.8,xp:45,leash:20,respawn:40},
  scrapling: { name: 'Scrapling', level: 1, hp: 42, speed: 4.0, aggro: 8.5, dmg: [4, 6], swing: 2.0, xp: 20, leash: 30, respawn: 30 },
  scavenger: { name: 'Rustclaw Scavenger', level: 2, hp: 105, speed: 4.3, aggro: 11, dmg: [7, 10], swing: 2.2, xp: 50, leash: 32, respawn: 45 },
};

/** LED eye colours (design: Scraplings have one red eye; Scavengers glow amber). */
const LED: Record<EnemyKind, string> = { scrapling: '#ff2a1a', scavenger: '#ffb020',jellyfish:'#68f0df' };

/** A dead enemy comes back only when no player is this close to its home. */
const RESPAWN_CLEAR = 22;

type State = 'idle' | 'chase' | 'leash' | 'dead' | 'gone';

export class Enemy {
  state: State = 'idle';
  readonly stats: Stats;
  pack: Enemy[] = [];
  /** Boss adds never respawn. */
  isAdd = false;
  isEcho = false;
  seaCast: { id:number; x:number; y:number; z:number; until:number } | null = null;
  private nextSwing = 0;
  private wanderAt = 0;
  private wander: THREE.Vector3 | null = null;
  private wanderSideways = false;
  private leapCd = 0;
  private leap: { fromX: number; fromZ: number; toX: number; toZ: number; t: number } | null = null;
  private deadAt = 0;
  private rise = 0;
  private velX = 0;
  private velZ = 0;

  constructor(
    private readonly game: Game,
    readonly unit: Unit,
    readonly kind: EnemyKind,
    readonly home: THREE.Vector3,
    readonly wanderRadius: number,
  ) {
    this.stats = { ...ENEMY_STATS[kind], dmg: [...ENEMY_STATS[kind].dmg] };
    unit.ctrl = this;
    unit.level = this.stats.level;
    unit.maxHp = unit.hp = this.stats.hp;
    unit.setBaseTint(LED[kind]);
    this.wanderAt = game.time + rand(1, 6);
    this.leapCd = game.time + 2;
  }

  get alive(): boolean {
    return this.unit.alive;
  }

  onDamaged(src: Unit | null): void {
    if (this.state === 'idle' && src) this.aggro(true);
  }

  aggro(withPack: boolean): void {
    if (this.state !== 'idle' || !this.unit.alive) return;
    this.state = 'chase';
    this.unit.express('angry', 2);
    this.nextSwing = Math.max(this.nextSwing, this.game.time + 0.6);
    this.game.events.emit({ type: 'aggro', unit: this.unit });
    if (withPack) for (const m of this.pack) if (m !== this) m.aggro(false);
  }

  onDeath(): void {
    this.state = 'dead';
    this.deadAt = this.game.time;
    this.leap = null;
    this.unit.lift = 0;
  }

  resumeAuthority(): void {
    this.unit.cancelPendingHit(); this.leap=null;
    // Followers mirror HP and level, but do not run the host's spawn logic. Rebuild the combat
    // coefficients from that exact level without healing or rescaling an encounter in progress.
    this.applyStats(this.unit.level);
    this.refreshAppearance();
    this.nextSwing=this.game.time+0.8;
    if (this.state === 'dead') this.deadAt=this.game.time;
  }

  /** Back to spawn instantly (player died, boss reset). */
  evade(): void {
    if (this.state === 'chase') {
      this.state = 'leash';
      this.unit.invulnerable = true;
    }
  }

  /** Remove from the world (boss adds when the fight ends). */
  despawn(): void {
    this.state = 'gone';
    this.unit.alive = false;
    this.unit.hidden = true;
    this.unit.rig.root.visible = false;
  }

  respawnAt(x: number, z: number): void {
    this.scaleForJourney();
    const u = this.unit;
    u.alive = true;
    u.hidden = false;
    u.hp = u.maxHp;
    u.invulnerable = false;
    u.stunUntil = u.slowUntil = 0;
    u.lift = 0;
    u.rig.root.visible = true;
    u.motion.stop(undefined, 0);
    u.express('neutral', 0.1);
    u.teleport(this.game.world, x, z, rand(0, TAU));
    this.refreshAppearance();
    this.state = 'idle';
    this.rise = 0.6;
    this.game.events.emit({ type: 'spawn', unit: u });
  }

  update(dt: number): void {
    const g = this.game;
    const u = this.unit;
    if(this.isEcho&&(g.world2?.chapter!==2||this.state==='gone'))return;
    const now = g.time;
    const p = g.combatTarget(u);
    if (this.state === 'gone') return;
    if(this.kind==='jellyfish')u.name=t('심해 해파리 드론','Tide Jelly Drone');
    if (this.state === 'idle' && u.hp >= u.maxHp && u.distTo(p) > 20) this.scaleForJourney();

    if (this.state === 'dead') {
      const t = now - this.deadAt;
      if (t > 8 && !u.hidden) {
        u.lift = -Math.min(1.4, (t - 8) * 0.9) * u.height;
        u.pos.y = g.world.heightAt(u.pos.x, u.pos.z) + u.lift;
        if (t > 9.6) {
          u.hidden = true;
          u.rig.root.visible = false;
        }
      }
      if (!this.isAdd && t > this.stats.respawn && this.canRespawnUnseen()) {
        const a = rand(0, TAU);
        const r = this.kind==='jellyfish'?0:rand(0, this.wanderRadius * 0.7);
        this.respawnAt(this.home.x + Math.cos(a) * r, this.home.z + Math.sin(a) * r);
      }
      return;
    }

    if (this.rise > 0) {
      this.rise = Math.max(0, this.rise - dt);
      u.lift = -this.rise * 1.3 * u.height;
    }

    const stunned = u.stunned(now);
    let tx = 0;
    let tz = 0;
    let speed = 0;
    let faceYaw: number | null = null;

    if (this.leap) {
      this.updateLeap(dt);
      u.feedLocomotion(dt);
      return;
    }

    if (this.state === 'idle') {
      if (p.alive && !(p.kind === 'player' && g.controlsLocked) && u.distTo(p) < this.stats.aggro && Math.abs(p.pos.y - u.pos.y) < 3) this.aggro(true);
      if (now > this.wanderAt) {
        this.wanderAt = now + rand(4, 9);
        const a = rand(0, TAU);
        const r = rand(0, this.wanderRadius);
        this.wander = new THREE.Vector3(this.home.x + Math.cos(a) * r, 0, this.home.z + Math.sin(a) * r);
        this.wanderSideways = Math.random() < 0.6;
      }
      if (this.wander) {
        const dx = this.wander.x - u.pos.x;
        const dz = this.wander.z - u.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.4) this.wander = null;
        else {
          tx = dx / d;
          tz = dz / d;
          speed = 1.3;
          const travel = Math.atan2(tx, tz);
          faceYaw = this.wanderSideways ? travel + Math.PI / 2 : travel;
        }
      }
    } else if (this.state === 'chase') {
      const fromHome = Math.hypot(u.pos.x - this.home.x, u.pos.z - this.home.z);
      if (!p.alive || (p.kind === 'player' && g.controlsLocked) || (!this.isAdd && fromHome > this.stats.leash)) {
        this.state = 'leash';
        u.invulnerable = true;
        g.events.emit({ type: 'leash', unit: u });
      } else {
        const gap = u.gapTo(p);
        faceYaw = yawTo(u.pos.x, u.pos.z, p.pos.x, p.pos.z);
        if (gap > (this.kind==='jellyfish'?3.5:.9)) {
          const d = u.distTo(p) || 1;
          tx = (p.pos.x - u.pos.x) / d;
          tz = (p.pos.z - u.pos.z) / d;
          speed = this.stats.speed;
        }
        if(this.kind==='jellyfish'&&!stunned&&gap<5&&now>=this.nextSwing&&lineOfSight(g.world,p,u)){
          this.nextSwing=now+this.stats.swing;
          const at=p.pos.clone();at.y=Math.max(.2,g.world.heightAt(at.x,at.z)+.28);
          this.seaCast={id:(this.seaCast?.id??0)+1,x:at.x,y:at.y,z:at.z,until:now+.9};
          g.events.emit({type:'attack',src:u,attack:'seaCast',stage:'start',target:p,at:v3(at)});
          // The zap lands on the swipe's own hit (0.28 s), inside the ring's 0.9 s, as it did on screen.
          u.act('attack_swipe',{upper:true,onHit:()=>{
            if(!u.alive||!p.alive||u.stunned(g.time)||g.world2.chapter!==1||u.distTo(p)>9)return;
            g.events.emit({type:'attack',src:u,attack:'seaCast',stage:'hit',target:p,at:v3(at)});
            if(Math.hypot(p.pos.x-at.x,p.pos.z-at.z)<1.7)g.combat.damage(u,p,rand(this.stats.dmg[0],this.stats.dmg[1]));
          }});
        } else if (this.kind === 'scavenger' && !stunned && now > this.leapCd && gap > 3.5 && gap < 10 && lineOfSight(g.world, p, u)) {
          this.startLeap();
        } else if (this.kind!=='jellyfish' && !stunned && gap <= 1.15 && now >= this.nextSwing) {
          this.nextSwing = now + this.stats.swing * rand(0.9, 1.1);
          u.act('attack_swipe', {
            upper: true,
            onHit: () => {
              if (!u.alive || !p.alive || u.gapTo(p) > 2) return;
              g.combat.damage(u, p, rand(this.stats.dmg[0], this.stats.dmg[1]));
              g.events.emit({ type: 'attack', src: u, attack: 'claw', stage: 'hit', target: p });
            },
          });
        }
      }
    } else if (this.state === 'leash') {
      const dx = this.home.x - u.pos.x;
      const dz = this.home.z - u.pos.z;
      const d = Math.hypot(dx, dz);
      u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.5 * dt);
      if (d < 1) {
        this.state = 'idle';
        u.invulnerable = false;
        u.hp = u.maxHp;
        u.express('neutral', 0.1);
      } else {
        tx = dx / d;
        tz = dz / d;
        speed = 7;
        faceYaw = Math.atan2(tx, tz);
      }
    }

    if (stunned) speed = 0;
    speed *= u.speedMul(now);
    this.velX = damp(this.velX, tx * speed, 10, dt);
    this.velZ = damp(this.velZ, tz * speed, 10, dt);
    let nx = u.pos.x + this.velX * dt;
    let nz = u.pos.z + this.velZ * dt;
    if (u.pushTime > 0) {
      u.pushTime -= dt;
      nx += u.pushX * dt;
      nz += u.pushZ * dt;
    }
    // Sea drones stay in reachable water and never pursue a player onto dry land.
    if(this.kind==='jellyfish'&&g.world2.chapter===1){
      const resolved=new THREE.Vector2();g.world.resolveCollision(nx,nz,u.radius,resolved);
      const depth=g.world.heightAt(resolved.x,resolved.y);
      if(depth>-.08||depth<-.95||Math.hypot(resolved.x-this.home.x,resolved.y-this.home.z)>this.stats.leash){nx=u.pos.x;nz=u.pos.z;if(this.state==='chase'){this.state='leash';u.invulnerable=true;}else if(this.state==='leash'){nx=this.home.x;nz=this.home.z;this.state='idle';u.invulnerable=false;u.hp=u.maxHp;this.velX=this.velZ=0;}this.wander=null;}
    }
    u.moveTo(g.world, nx, nz, dt);
    if (faceYaw !== null && !stunned) u.setYaw(turnToward(u.yaw, faceYaw, 7, dt));
    u.feedLocomotion(dt);
  }

  private startLeap(): void {
    const g = this.game;
    const u = this.unit;
    if(this.isEcho&&(g.world2?.chapter!==2||this.state==='gone'))return;
    const p = g.combatTarget(u);
    const d = u.distTo(p) || 1;
    const back = (u.radius + p.radius + 0.2) / d;
    this.leap = {
      fromX: u.pos.x,
      fromZ: u.pos.z,
      toX: p.pos.x + (u.pos.x - p.pos.x) * back,
      toZ: p.pos.z + (u.pos.z - p.pos.z) * back,
      t: 0,
    };
    this.leapCd = g.time + rand(7, 9);
    u.setYaw(yawTo(u.pos.x, u.pos.z, p.pos.x, p.pos.z));
    // Crouch to landing of the recorded jump, stretched over the 0.75 s leap.
    u.act('jump', { fade: 0.06, from: 0.95, to: 1.6, speed: 0.87 });
    g.events.emit({ type: 'attack', src: u, attack: 'leap', stage: 'start', target: p });
  }

  private updateLeap(dt: number): void {
    const g = this.game;
    const u = this.unit;
    if(this.isEcho&&(g.world2?.chapter!==2||this.state==='gone'))return;
    const l = this.leap!;
    const dur = 0.75;
    l.t += dt;
    const k = Math.min(1, l.t / dur);
    const x = l.fromX + (l.toX - l.fromX) * k;
    const z = l.fromZ + (l.toZ - l.fromZ) * k;
    u.lift = Math.sin(k * Math.PI) * 2.2;
    u.moveTo(g.world, x, z, dt);
    u.pos.y = g.world.heightAt(u.pos.x, u.pos.z) + u.lift;
    if (k >= 1) {
      this.leap = null;
      u.lift = 0;
      const p = g.combatTarget(u);
      g.events.emit({ type: 'attack', src: u, attack: 'leap', stage: 'hit', target: p, at: v3(u.pos) });
      if (p.alive && u.gapTo(p) < 1.6) g.combat.damage(u, p, rand(8, 11));
      this.nextSwing = g.time + 0.8;
    }
  }

  private scaleForJourney(): void {
    const base = ENEMY_STATS[this.kind];
    if(this.isEcho){this.applyStats(Math.max(10,this.game.partyLevel));this.unit.level=this.stats.level;this.unit.maxHp=this.unit.hp=this.stats.hp;return;}
    const inWorld2=(this.game.world2?.chapter??1)>=2&&!this.isAdd;
    const scaling=!this.isAdd&&(inWorld2||this.game.journey?.rustCleared);
    const level = scaling ? Math.max(inWorld2 ? (this.game.world2.chapter===3?20:10) : base.level, this.game.partyLevel - (this.kind === 'scrapling' ? 1 : 0)) : base.level;
    if (this.stats.level === level && this.stats.respawn === (inWorld2 ? 12 : base.respawn)) return;
    this.applyStats(level);
    this.unit.level=level;
    this.unit.maxHp = this.unit.hp = this.stats.hp;
  }

  private applyStats(level:number): void {
    const base=ENEMY_STATS[this.kind],inWorld2=(this.game.world2?.chapter??1)>=2&&!this.isAdd;
    const scale=1+.12*(level-base.level);
    if(this.isEcho){Object.assign(this.stats,{level,hp:Math.round(500*scale),xp:350+level*10,respawn:120,speed:2.8,aggro:10,leash:24,dmg:[14+level,18+level]});return;}
    Object.assign(this.stats,{level,hp:Math.round(base.hp*scale),xp:base.xp+12*(level-base.level)+(inWorld2?90:0),respawn:inWorld2?12:base.respawn,dmg:[base.dmg[0]*scale,base.dmg[1]*scale]});
  }

  refreshAppearance(): void {
    this.unit.setBaseTint((this.game.world2?.chapter??1)>=2 ? '#b08cff' : LED[this.kind]);
  }

  /** No player near the home: the same rule for every player (there is no one camera to hide from). */
  private canRespawnUnseen(): boolean {
    return !this.game.combatPlayers().some(p => Math.hypot(p.pos.x-this.home.x,p.pos.z-this.home.z)<RESPAWN_CLEAR);
  }
}
