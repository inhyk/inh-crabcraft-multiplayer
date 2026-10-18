// Esc game menu: Resume, Settings (music and effects volume, graphics quality, chat bubbles, public chat),
// Controls, Videos, Robot Mode, Return to Title.
import { h } from '../dom';
import {language,setLanguage,t,type Language} from '../../i18n';
import {setQuestLanguage} from '../../game/quests';
import { localStorageSet } from '../../app';
import { openVideos } from '../videos';
import { publicChatOn, setPublicChat } from '../../multiplayer/chatSafety';
import type { Game } from '../../game/game';
import type { QualitySetting } from '../../core/engine';

const CONTROLS: [string, string][] = [
  ['W / S', 'Walk forward / back'],
  ['A / D', 'Scuttle left / right (crabs walk sideways)'],
  ['Q / E', 'Turn'],
  ['Right mouse drag', 'Look and steer'],
  ['Left mouse drag', 'Look around'],
  ['Both mouse buttons', 'Walk forward'],
  ['Mouse wheel', 'Zoom'],
  ['Space', 'Jump'],
  ['B', 'Breakdance: six trained moves in a row (move to stop)'],
  ['Tab / Click', 'Target an enemy'],
  ['1 2 3 4', 'Abilities'],
  ['F', 'Talk, continue a conversation, hold at the beacon'],
  ['L', 'Quest log'],
  ['M', 'Music on / off'],
  ['Enter', 'Chat bubbles on / off'],
  ['R', 'Robot Mode'],
  ['Esc', 'Clear target, close windows, menu'],
];

export class GameMenu {
  readonly el: HTMLElement;
  private panel: HTMLElement;
  /** Under the quality buttons: what 'auto' is rendering at right now. */
  private resNote = h('div', { class: 'res-note' });
  open = false;

  constructor(private readonly game: Game) {
    this.panel = h('div', { class: 'menu cc-panel hud-i' });
    this.el = h('div', { class: 'game-menu-root hidden', style: 'position:absolute;inset:0;pointer-events:auto' }, h('div', { class: 'menu-back', onclick: () => this.close() }), this.panel);
  }

  private btn(label: string, fn: () => void, ghost = false): HTMLElement {
    const b = h('button', { class: `cc-btn${ghost ? ' ghost' : ''}` }, label);
    b.addEventListener('click', () => {
      this.game.audio.sfx('sfx-click', { volume: 0.6 });
      fn();
    });
    b.addEventListener('mouseenter', () => this.game.audio.sfx('sfx-hover', { volume: 0.3 }));
    return b;
  }

  show(): void {
    this.open = true;
    this.el.classList.remove('hidden');
    this.main();
  }

  close(): void {
    this.open = false;
    this.el.classList.add('hidden');
  }

  main(): void {
    const g = this.game;
    this.panel.className = 'menu cc-panel hud-i';
    this.panel.replaceChildren(
      h('h2', { class: 'cc-title' }, t('게임 메뉴','Game Menu')),
      this.btn(t('계속하기','Resume'), () => this.close()),
      this.btn(g.app.account.label,()=>g.app.account.show(),true),
      this.btn(t('👥 친구와 방 만들기','👥 Room with friends'),()=>{this.close();g.multiplayer?.showFriends();},true),
      this.btn(t('🏆 업적 · J','🏆 Achievements · J'),()=>this.achievements(),true),
      this.btn(t('🙈 마을 놀이','🙈 Village games'),()=>this.villageGames(),true),
      this.btn(t('설정','Settings'), () => this.settings(), true),
      this.btn(t('조작 방법','Controls'), () => this.controls(), true),
      this.btn(t('영상','Videos'), () => openVideos(g.audio), true),
      this.btn(t('로봇 모드','Robot Mode'), () => void g.app.go('robot'), true),
      this.btn(t('처음 화면','Return to Title'), () => void g.app.go('title'), true),
    );
  }

  villageGames():void {
    const g=this.game,start=(mode:'hide'|'tag')=>{if(g.world2.chapter!==1){g.hud.messages.info(t('월드 1 마을에서 시작할 수 있어요.','Start in the World I village.'));return;}g.villageGames?.command(mode);this.close();};
    this.panel.className='menu cc-panel hud-i';
    this.panel.replaceChildren(h('h2',{class:'cc-title'},t('마을 놀이','Village games')),
      h('p',{class:'village-games-guide'},t('혼자라면 마을 주민이 술래! 친구와 함께라면 시작한 사람이 술래예요. 모두 광장으로 모여요. 숨바꼭질은 15초 동안 숨고 2분 동안 찾아요. 술래잡기는 5초 준비 후 90초 동안 도망가요. 가까이 닿으면 잡히고 광장에서 60m를 벗어나면 탈락해요. 놀이 중에는 전투 피해를 받지 않아요.','Solo: a villager seeks. With friends: whoever starts is the seeker. Everyone gathers at the square. Hide & Seek: hide for 15 seconds, then search for 2 minutes. Tag: 5 seconds to prepare, then run for 90 seconds. Contact catches a runner; leaving the 60m town area counts as caught. Combat damage is disabled during the round.')),
      this.btn(t('🙈 숨바꼭질 시작','🙈 Start Hide & Seek'),()=>start('hide')),
      this.btn(t('🏃 술래잡기 시작','🏃 Start Tag'),()=>start('tag')),
      this.btn(t('놀이 끝내기','End round'),()=>{g.villageGames?.command('stop');this.close();},true),
      this.btn(t('뒤로','Back'),()=>this.main(),true));
  }

  achievements():void {this.panel.className='menu cc-panel hud-i achievement-menu';this.panel.replaceChildren(h('h2',{class:'cc-title'},t('항해와 모험의 업적','Voyage & Adventure Achievements')),this.game.achievements?.panel()??h('div'),this.btn(t('뒤로','Back'),()=>this.main(),true));}

  settings(): void {
    const g = this.game;
    const audio = g.audio;
    const slider = (value: number, onInput: (v: number) => void) => {
      const s = h('input', { type: 'range', min: 0, max: 100, value: Math.round(value * 100) }) as HTMLInputElement;
      s.addEventListener('input', () => onInput(Number(s.value) / 100));
      return s;
    };
    const seg = (options: [string, string][], current: string, onPick: (v: string) => void) => {
      const wrap = h('div', { class: 'seg' });
      for (const [v, label] of options) {
        const b = h('button', { class: `cc-btn small ghost${v === current ? ' on' : ''}` }, label);
        b.addEventListener('click', () => {
          onPick(v);
          wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        });
        wrap.append(b);
      }
      return wrap;
    };
    this.panel.className = 'menu wide cc-panel hud-i';
    this.panel.replaceChildren(
      h('h2', { class: 'cc-title' }, t('설정','Settings')),
      h('div',{class:'row'},t('언어','Language'),seg([['ko','한국어'],['en','English']],language(),v=>{
        setLanguage(v as Language);setQuestLanguage(v as Language);for(const n of g.npcs){n.unit.name=n.def.name;n.unit.title=n.def.title;}g.hud.refreshLanguage();g.world2.refreshLanguage();g.multiplayer?.refreshLanguage();g.debug?.refreshLanguage();g.hud.dialogue.close();g.hud.tracker.update(g.quests);g.hud.questLog.render();this.settings();
      })),
      ...(g.world2.chapter===1?[h('div',{class:'row'},t('월드 1 등대','World I lighthouse'),
        h('button',{class:'cc-btn small ghost',disabled:!g.beaconLit,onclick:()=>{g.setLighthouse(false);this.settings();}},t('끄기 · 아침','Off · morning')))]:[]),
      h('div',{class:'res-note'},t('등대를 켜려면 월드 1의 등대에 직접 가서 F를 길게 누르세요.','To light the lighthouse, visit it in World I and hold F.')),
      h('div', { class: 'row' }, t('음악 음량','Music volume'), slider(audio.musicVolume, (v) => {
        audio.setMusicVolume(v);
        g.musicOn = v > 0;
        localStorageSet('cc.musicVol', String(v));
      })),
      h('div', { class: 'row' }, t('효과음 음량','Effects volume'), slider(audio.sfxVolume, (v) => {
        audio.setSfxVolume(v);
        localStorageSet('cc.sfxVol', String(v));
        audio.sfx('sfx-click', { volume: 0.6 });
      })),
      h('div', { class: 'row' }, t('그래픽 품질','Graphics quality'), seg([['auto', t('자동','Auto')], ['high', t('높음','High')], ['low', t('낮음','Low')]], g.engine.setting, (q) => {
        g.setQuality(q as QualitySetting);
        this.updateResNote();
      })),
      this.resNote,
      h('div', { class: 'row' }, t('말풍선','Chat bubbles'), seg([['on', t('켜기','On')], ['off', t('끄기','Off')]], g.hud.bubbles.enabled ? 'on' : 'off', (v) => {
        g.hud.bubbles.enabled = v === 'on';
      })),
      h('div', { class: 'row' }, t('공개 채팅 보기','Show public chat'), seg([['on', t('켜기','On')], ['off', t('끄기','Off')]], publicChatOn() ? 'on' : 'off', (v) => {
        setPublicChat(v === 'on');
        g.multiplayer?.setPublicChat(v === 'on');
      })),
      h('div', { class: 'res-note' }, t('끄면 모르는 모험가의 채팅과 말풍선이 보이지 않아요. 친구와 만든 방의 채팅은 그대로 보여요.','Off hides chat and bubbles from strangers in the public world. Rooms with friends still show chat.')),
      this.btn(t('뒤로','Back'), () => this.main()),
    );
    this.updateResNote();
  }

  /** Called by the game when dynamic resolution moves, and when the settings page opens. */
  updateResNote(): void {
    const e = this.game.engine;
    const pct = Math.round(e.resolutionFraction * 100);
    this.resNote.textContent =
      e.setting === 'auto'
        ? t(`해상도를 자동 조절해 움직임을 부드럽게 유지합니다. 현재 ${pct}%로 표시 중입니다.`,`Auto keeps the frame rate smooth by adjusting resolution. Rendering at ${pct}% now.`)
        : e.setting === 'high'
          ? t(`모든 효과를 사용합니다. 현재 해상도 ${pct}%.`,`Full resolution${pct < 100 ? ` (capped at ${pct}% of this screen)` : ''}, every effect on.`)
          : t('식물과 입자를 줄여 오래된 노트북에서도 부드럽게 플레이합니다.','Fewer plants and particles, standard resolution. For older laptops.');
  }

  controls(): void {
    const table = h('table');
    const ko=['앞 / 뒤로 걷기','왼쪽 / 오른쪽으로 옆걸음','방향 돌리기','시점과 방향 조절','주변 둘러보기','앞으로 걷기','확대 / 축소','점프','브레이크댄스: 학습된 동작 여섯 개를 이어서 춰요 (움직이면 멈춰요)','적 선택','기술 사용','대화, 채집, 등대 켜기 / 끄기','퀘스트 기록','음악 켜기 / 끄기','말풍선 켜기 / 끄기','로봇 모드','대상 해제, 창 닫기, 메뉴'];
    const mouseKeys:Record<string,string>={'Right mouse drag':'우클릭 드래그','Left mouse drag':'좌클릭 드래그','Both mouse buttons':'마우스 양쪽 버튼','Mouse wheel':'마우스 휠','Click':'클릭'};
    for (const [i,[k, what]] of CONTROLS.entries()) {
      const keys = h('td');
      for (const part of k.split(' / ')) keys.append(h('kbd', null, t(mouseKeys[part]??part,part)));
      const description=k==='Shift'?t('누르고 이동하면 빠르게 달리기','Hold while moving to sprint'):k==='G'?t('큰 지도 열기 / 닫기','Open / close the expanded map'):k==='F'&&this.game.world2.chapter===2?t('대화·수정 채집·포탈 이용, 등불 앞에서 길게 누르기','Talk, gather crystals, use portals; hold at waystones'):k==='R'?t('두 번 눌러 로봇 모드 열기','Press twice to open Robot Mode'):t(ko[i],what);
      table.append(h('tr', null, keys, h('td', null, description)));
    }
    for(const [key,ko,en] of [['Shift','누르고 이동하면 빠르게 달리기','Hold while moving to sprint'],['G','큰 지도 열기 / 닫기','Open / close expanded map'],['T','2초 동안 꾹 눌러 현재 섬의 광장으로 돌아가기','Hold for 2 seconds to return to this island’s square']])table.append(h('tr',null,h('td',null,h('kbd',null,key)),h('td',null,t(ko,en))));
    this.panel.className = 'menu wide cc-panel hud-i';
    const guide=this.game.world2.chapter===2?h('section',{class:'controls-guide'},
      h('h3',null,t('별빛 항구 안내','Starhaven guide')),
      h('p',null,t('주민 가까이에서 F로 퀘스트를 받고 보상을 받으세요. 퀘스트 기록(L)에서 목표를 선택하면 지도에 표시돼요.','Press F near villagers to accept quests and collect rewards. Select a quest in the journal (L) to show its objective on the map.')),
      h('p',null,t('수정은 F로 채집하고, 별빛 등불은 F를 1.5초 동안 누르세요. 포탈 중앙으로 걷거나 가까이서 F를 누르면 월드 1로 돌아가요. 도착하면 포탈 밖으로 나온 뒤 다시 이용하세요.','Press F to gather crystals; hold F for 1.5 seconds at waystones. Walk into the portal or press F nearby to return to World I. Step away after arrival before using it again.')),
      h('p',null,t('친구와의 퀘스트는 각자 진행해요. 온라인 패널에서 춤출 수 있고, 친구와 방에서는 파티를 고를 수 있어요. 싸우기 모드는 방장이 선택하며, 같은 파티는 서로 공격하지 않아요. 친구는 미니맵의 마름모, 멀리 있는 파티원은 화살표로 표시돼요.','Quest progress is personal. Dance from the online panel; in a room with friends you can also choose a party. The host selects PvP; teammates cannot hurt each other. Diamonds mark friends on the minimap; arrows point to distant teammates.')),
    ):null;
    this.panel.replaceChildren(h('h2', { class: 'cc-title' }, t('조작 방법','Controls')), table, ...(guide?[guide]:[]), this.btn(t('뒤로','Back'), () => this.main()));
  }
}
