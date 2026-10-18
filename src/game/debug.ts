// 13570 or ?debug=1: F8 god mode, F9 complete the current objective, F10 teleport to the next
// objective, an fps / draw-call readout, and window.cc for the playtest script.
import * as THREE from 'three';
import type { BreakRoutine } from './breakdance';
import type { Game } from './game';
import { QUESTS } from './quests';
import { C } from './vfx/vfx';
import { xpForLevel } from './progression';
import { h } from '../ui/dom';
import { t } from '../i18n';
import { capture } from '../capture/clock';

function routineState(r: BreakRoutine) {
  const p = r.progress;
  return {
    active: r.active, step: r.step?.id ?? null, index: r.stepIndex, t: +p.t.toFixed(3),
    length: +p.length.toFixed(3), lastCompleted: r.lastCompleted,
  };
}

export class DebugTools {
  private acc = 0;
  private enabled = new URLSearchParams(location.search).get('debug')==='1';
  private code = '';
  private lastKey = 0;
  private panel:HTMLElement;


  constructor(private readonly game: Game) {
    window.addEventListener('keydown', this.onKey, true);
    game.hud.debugEl.classList.toggle('hidden',!this.enabled);
    this.panel=h('details',{class:'boss-journey creator-tools',hidden:!this.enabled,open:true});
    this.refreshLanguage();
    game.hud.sidePanels.append(this.panel);
    (window as unknown as { cc: unknown }).cc = {
      game,
      state: () => this.state(),
      C,
      THREE,
    };
    if (import.meta.env.DEV && this.enabled) {
      const w = window as unknown as { render_game_to_text?: () => string; advanceTime?: (ms: number) => Promise<void> };
      w.render_game_to_text = () => JSON.stringify({
        ...this.state(),
        coordinates: 'x right, y up, z south, metres',
        player: { x: game.player.unit.pos.x, y: game.player.unit.pos.y, z: game.player.unit.pos.z, yaw: game.player.unit.yaw },
      });
      const clock = capture;
      if (clock) w.advanceTime = async (ms) => { await clock.begin(); await clock.step(Math.max(1, Math.round(ms / (1000 / 60)))); };
    }
  }

  refreshLanguage(): void {
    const button=(ko:string,en:string,fn:()=>void)=>h('button',{type:'button',class:'cc-btn small',onclick:fn},t(ko,en));
    this.panel.replaceChildren(h('summary',null,t('🛠 제작자 모드 · 13570','🛠 Creator mode · 13570')),
      h('p',null,t('13570으로 열기 · F8 무적 · F9 목표 완료 · F10 목표 이동','Enter 13570 · F8 god mode · F9 complete objective · F10 teleport')),
      button('무적 켜기 / 끄기','Toggle god mode',()=>this.toggleGod()),
      button('레벨 +1','Level +1',()=>this.addLevels(1)),button('레벨 +10','Level +10',()=>this.addLevels(10)),
      button('월드 2로 이동','Travel to World II',()=>{this.game.creatorTravel=true;if(!this.game.multiplayer?.battle.enterWorld2())this.game.world2.go(2);}),
      button('월드 3로 이동','Travel to World III',()=>{this.game.creatorTravel=true;if(!this.game.multiplayer?.battle.travel(3))this.game.world2.go(3);}),
      button('현재 목표 완료','Complete current objective',()=>this.completeObjective()),button('목표로 이동','Teleport to objective',()=>this.teleport()),
      button('제작자 화면 닫기','Close creator tools',()=>{this.panel.hidden=true;}));
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    const target=e.target as HTMLElement;
    if(e.repeat||e.ctrlKey||e.metaKey||e.altKey||target.matches('input,textarea,select')||target.isContentEditable)return;
    if(performance.now()-this.lastKey>5000)this.code='';
    this.lastKey=performance.now();
    if(/^\d$/.test(e.key)){
      this.code+=e.key;if(!'13570'.startsWith(this.code))this.code=e.key==='1'?'1':'';
      if(this.code==='13570'){this.code='';this.enabled=true;this.panel.hidden=false;(this.panel as HTMLDetailsElement).open=true;this.game.hud.debugEl.classList.remove('hidden');this.game.hud.messages.banner(t('제작자 모드','Creator mode'), t('월드 이동 · 레벨 조절 · 테스트 도구','World travel · Level controls · Testing tools'), 'level');}
    }else this.code='';
    if(!this.enabled)return;
    if (e.code === 'F8' || e.code === 'F9' || e.code === 'F10') {
      e.preventDefault();
      if (e.code === 'F8') this.toggleGod();
      if (e.code === 'F9') this.completeObjective();
      if (e.code === 'F10') this.teleport();
    }
  };

  private addLevels(count:number) {const p=this.game.player;this.game.player.gainXp(Math.max(0,xpForLevel(p.level+count)-p.xp));this.game.journey?.save();}

  toggleGod(): void {
    const g = this.game;
    g.god = !g.god;
    g.hud.messages.info(g.god ? t('무적 모드 켜짐','God mode ON') : t('무적 모드 꺼짐','God mode OFF'));
  }

  completeObjective(): void {
    const g = this.game;
    const cur = g.quests.current();
    if (!cur) return;
    if (cur.step === 'accept') {
      g.acceptQuest(cur.quest);
      return;
    }
    if (cur.step === 'turnin') {
      g.turnIn(cur.quest);
      return;
    }
    const o = cur.objective!;
    switch (o.kind) {
      case 'kill-scrapling':
      case 'kill-scavenger':
      case 'collect-cog':
      case 'deliver':
        g.quests.completeObjective(o);
        break;
      case 'beacon':
        g.lightBeacon();
        break;
      case 'eclipse-boss':
        if(g.multiplayer?.battle.authority===false){g.hud.messages.info(t('보스 테스트는 방장이 진행해요.','Only the host can advance boss tests.'));return;}
        if(g.worldBoss.state==='dormant')g.worldBoss.wake();else g.worldBoss.debugAdvance(g.player.unit);
        break;
      case 'boss':
        if(g.multiplayer?.battle.authority===false){g.hud.messages.info(t('보스 테스트는 방장이 진행해요.','Only the host can advance boss tests.'));return;}
        if (g.boss.state === 'dormant') g.boss.wake();
        else g.boss.debugAdvance(g.player.unit);
        break;
      default:g.quests.completeObjective(o);g.journey?.save();break;
    }
  }

  teleport(): void {
    const g = this.game;
    let target = g.objectivePos();
    if (!target) return;
    const p = g.player.unit;
    const cur = g.quests.current();
    // Hunting from far away: drop in next to the pack nearest the middle of the hunting ground.
    const hunt = cur?.objective?.kind;
    if (hunt === 'kill-scrapling' || hunt === 'kill-scavenger' || hunt === 'collect-cog') {
      const area = g.world.pois[cur!.objective!.poi].position;
      const kind = hunt === 'kill-scavenger' ? 'scavenger' : 'scrapling';
      let best: THREE.Vector3 | null = null;
      let bestD = Infinity;
      for (const e of g.enemies) {
        if (e.kind !== kind || e.isAdd || !e.unit.alive || e.unit.hidden) continue;
        const d = Math.hypot(e.unit.pos.x - area.x, e.unit.pos.z - area.z);
        if (d < bestD) {
          bestD = d;
          best = e.unit.pos;
        }
      }
      if (best && target.distanceTo(area) < 0.01) target = best;
    }
    let back = 3.2;
    if (cur?.objective?.kind === 'boss') back = Math.min(4.5, g.world.pois.bossArena.radius * 0.6);
    // The beacon spot is the walkable gallery tile itself; stepping back could drop us off the tower.
    if (cur?.objective?.kind === 'beacon') back = 0;
    if (cur?.objective?.kind === 'kill-scrapling' || cur?.objective?.kind === 'kill-scavenger' || cur?.objective?.kind === 'collect-cog') back = 9;
    let dx = p.pos.x - target.x;
    let dz = p.pos.z - target.z;
    // For hunting objectives come in from the open middle of the area, not from behind a hut.
    const k = cur?.objective?.kind;
    if (k === 'kill-scrapling' || k === 'kill-scavenger' || k === 'collect-cog') {
      const area = g.world.pois[cur!.objective!.poi].position;
      if (Math.hypot(area.x - target.x, area.z - target.z) > 2) {
        dx = area.x - target.x;
        dz = area.z - target.z;
      }
    }
    const len = Math.hypot(dx, dz);
    if (len < 0.01) {
      dx = 1;
      dz = 0;
    } else {
      dx /= len;
      dz /= len;
    }
    const x = target.x + dx * back;
    const z = target.z + dz * back;
    p.teleport(g.world, x, z, Math.atan2(-dx, -dz));
    g.follow.yaw = p.yaw + Math.PI;
    g.player.cancelChannel();
    g.player.interruptCast();
  }

  state(): Record<string, unknown> {
    const g = this.game;
    const cur = g.quests.current();
    return {
      loaded: g.loaded,
      time: g.time,
      fps: g.engine.fps,
      pixelRatio: g.engine.pixelRatio,
      gpuMs: g.engine.gpuMs,
      drawCalls: g.engine.drawCalls,
      quests: { ...g.quests.status },
      current: cur ? { quest: cur.quest, step: cur.step, label: cur.label, title: QUESTS[cur.quest].title } : null,
      playerHp: g.player.unit.hp,
      playerAlive: g.player.unit.alive,
      level: g.player.unit.level,
      target: g.player.target?.name ?? null,
      dialogueOpen: g.hud.dialogue.isOpen,
      boss: { state: g.boss.state, phase: g.boss.phase, hp: g.boss.unit.hp, telegraph: g.boss.telegraphActive, mech: g.boss.mechName, adds: g.boss.adds.filter((a) => a.unit.alive).length },
      ending: g.ending.active,
      // The B emote and the hero's routine at the ending: which move is playing, how far in.
      breakdance: routineState(g.player.breakdance),
      endingBreakdance: g.ending.routine ? routineState(g.ending.routine) : null,
      zone: g.zone,
      crabs: g.units.filter((u) => !u.hidden && !u.culled).length,
      particles: g.vfx.add.count + g.vfx.alpha.count,
    };
  }

  update(dt: number): void {
    if(!this.enabled)return;
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    const g = this.game;
    const s = this.state();
    g.hud.debugEl.classList.toggle('god', g.god);
    const e = g.engine;
    const gpu = e.gpuMs >= 0 ? `  gpu ${e.gpuMs.toFixed(1)} ms` : '';
    g.hud.debugEl.textContent = `${e.fps.toFixed(0)} fps  ${e.drawCalls} calls\nres ${e.pixelRatio}x ${e.setting}${gpu}\ncrabs ${s.crabs}  particles ${s.particles}${g.god ? '\nGOD MODE' : ''}\nF8 god  F9 objective  F10 teleport`;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.panel.remove();
    delete (window as unknown as { cc?: unknown }).cc;
    if (import.meta.env.DEV && this.enabled) {
      const w = window as unknown as { render_game_to_text?: unknown; advanceTime?: unknown };
      delete w.render_game_to_text;
      if (capture) delete w.advanceTime;
    }
  }
}
