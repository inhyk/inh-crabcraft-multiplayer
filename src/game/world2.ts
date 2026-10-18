import * as THREE from 'three';
import {DawnIsland} from './world3';
import {t} from '../i18n';
import type { Game } from './game';
import type { Poi } from '../world/types';
import { snapshotMap } from './snapshots';
import { buildStarSettlement, STAR_TOWN, STAR_WALKS, STAR_OBJECTIVES, STAR_TRAILS } from './world2Settlement';
import { QUESTS, type ObjectiveKind, type ObjectiveDef } from './quests';
import type { Collision } from '../world/collision';
import { StarPortal } from './portal';
import { StarVillageLife } from './world2Life';
import {starGroundColor} from './world2Ground';
import {facetedStarCrystal} from './starCrystal';
import {collectibleShadow} from './collectibleShadow';
import {StarSky} from './starSky';
import {StarSea} from './starSea';
import {StarWind} from './starWind';
import {NavHints} from './nav';
import {StarAmbience} from './starAmbience';
import {StarWaystoneKit} from './starWaystone';
import {StarMemorySealKit} from './starMemorySeal';
import {StarOreKit} from './starOre';
import {StarSun} from './starSun';
import {StarEnemyArmour} from './starEnemyArmour';
import {StarThrone} from './starThrone';
import {buildStarHeights,starSurfaceHeight} from './world2Height';
import {layoutStarhaven,starCrystalGarden} from './world2Colliders';
import {DAWN_BOUNDS,resolveOnIsland,STAR_BOUNDS} from '../sim/world/queries';

/** A separate, deterministic realm; all clients build the same island and collision surface. */
export class HiddenWorld {
  readonly root = new THREE.Group();
  private readonly sun=new StarSun();
  readonly trails=STAR_TRAILS;
  chapter: 1 | 2 | 3 = 1;
  readonly third=new DawnIsland();
  private thirdGate:StarPortal;
  private echoAt=0;
  readonly spawn = new THREE.Vector3(0, 3, 86);
  readonly arena: Poi = { id:'bossArena',position:new THREE.Vector3(0,3,-75),yaw:0,radius:17 };
  private baseRoot: THREE.Group;
  private originalHeight: Game['world']['heightAt'];
  private originalCollision: Game['world']['resolveCollision'];
  private originalRay: Game['world']['raycastSolid'];
  private groundTexture:THREE.DataTexture;
  private groundHeights=buildStarHeights();
  private rotations: THREE.Object3D[] = [];
  private sky: StarSky;
  private sea: StarSea;
  private obstacles: { x:number; z:number; r:number }[] = [];
  private crystalSolids: {x:number;z:number;r:number;y0:number;y1:number}[] = [];
  private portal: StarPortal;
  private shorePortal: StarPortal;
  private travelArmed=false;
  private travelAt=0;
  /** Arrival (including respawn) must not immediately trigger the return gateway. */
  resetPortalArrival(){this.travelArmed=false;this.travelAt=this.game.time+3;}
  private baseNames:string[]=[];
  get portalPosition(){if(this.chapter===3)return this.third.spawn;if(this.chapter===2&&this.game.player.unit.pos.distanceTo(this.thirdGate.root.position)<6)return this.thirdGate.root.position;return this.chapter===2?this.spawn:this.shorePortal.root.position;}
  portalLabel(){return this.chapter===3?t('월드 2로 돌아가기','Return to World II'):this.chapter===2&&this.portalPosition===this.thirdGate.root.position?t('월드 3 · 새벽의 섬으로','World III · Sail to Dawnreach'):this.chapter===2?t('월드 1로 돌아가기','Return to World I'):t('월드 2로 이동','Travel to World II');}
  canTravel(chapter:1|2|3){return chapter===1||this.game.creatorTravel||this.game.multiplayer?.battle.applying||(chapter===2?!!this.game.journey?.abyssCleared:!!this.game.journey?.abyssCleared&&!!this.game.journey?.trueCleared);}
  go(chapter:1|2|3,authority=true){if(!this.canTravel(chapter)){this.game.hud.messages.info(chapter===2?t('10레벨 심해의 군주를 이겨야 월드2가 열려요.','Defeat the level 10 Lord of the Deep to unlock World II.'):t('월드2의 20레벨 일식 여왕을 이겨야 월드3가 열려요.','Defeat the level 20 Eclipse Queen to unlock World III.'));return false;}if(chapter===1)this.returnToShore();else if(chapter===3)this.enterThird(authority);else this.enter(authority);return true;}
  travel(){
    const g=this.game;if(g.controlsLocked||g.player.inCombat||g.encounter.engaged){g.hud.messages.info(t('전투가 끝나면 포탈을 이용할 수 있어요.','You can travel through the portal after combat.'));return;}
    const chapter=this.chapter===3?2:this.chapter===2&&this.portalPosition===this.thirdGate.root.position?3:this.chapter===2?1:2;
    if(!this.canTravel(chapter)){this.go(chapter);return;}
    if(!g.multiplayer?.battle.travel(chapter))this.go(chapter);
  }
  private rendered = false;
  private baseHomes: THREE.Vector3[] = [];
  private collision: Collision | null = null;
  private life:StarVillageLife|null=null;
  private armour:StarEnemyArmour|null=null;
  private throne:StarThrone;
  private wind:StarWind|null=null;
  private nav:NavHints|null=null;
  private ambience:StarAmbience;
  waypoint(from:THREE.Vector3,goal:THREE.Vector3,now:number){return this.nav?.waypoint(from,goal,now)??goal;}
  private basePois = new Map<string, {position:THREE.Vector3;yaw:number}>();
  private basePeople: THREE.Vector3[] = [];
  private memories:{kind:ObjectiveKind;ring:THREE.Mesh;star:THREE.Mesh}[]=[];
  private nodes: {kind:ObjectiveKind;objective:ObjectiveDef;position:THREE.Vector3;mesh:THREE.Mesh;shadowOpacity:THREE.IUniform<number>;halo?:THREE.Mesh<THREE.TorusGeometry,THREE.MeshBasicMaterial>}[] = [];
  private sightAim=new THREE.Vector3();
  private sightRay=new THREE.Vector3();
  private sightOffset=new THREE.Vector3();

  async buildSettlement() {
    await this.third.buildSettlement();
    const settlement=await buildStarSettlement((x,z)=>this.height(x,z));
    // Every World II collider, without meshes: the same registration the server bakes.
    this.collision=layoutStarhaven((x,z)=>this.height(x,z),settlement.natureNames).col;this.root.add(settlement.root);
    this.wind=new StarWind(settlement.root.getObjectByName('star-island-forests')!);
    this.life=new StarVillageLife((x,z)=>this.height(x,z));this.root.add(this.life.root);
    const waystones=new StarWaystoneKit(),memorySeals=new StarMemorySealKit(),ore=new StarOreKit();
    for(const [kind,point] of Object.entries(STAR_OBJECTIVES)) {
      if(kind.startsWith('explore-')){
        const x=point[0],z=point[1],y=this.height(x,z);
        const material=new THREE.MeshBasicMaterial({color:'#c0a0ff',transparent:true,opacity:.5,depthWrite:false});
        const ring=new THREE.Mesh(new THREE.TorusGeometry(4.3,.055,5,64),material);ring.rotation.x=-Math.PI/2;ring.position.set(x,y+.13,z);this.root.add(ring);
        const star=new THREE.Mesh(new THREE.OctahedronGeometry(.45),new THREE.MeshStandardMaterial({color:'#d6beff',emissive:'#7854ba',emissiveIntensity:1.7,metalness:.5,roughness:.25}));star.position.set(x,y+2.7,z);this.root.add(star);
        star.add(memorySeals.create());this.memories.push({kind:kind as ObjectiveKind,ring,star});continue;
      }
      if(!kind.startsWith('crystal-')&&!kind.startsWith('lamp-'))continue;
      const position=new THREE.Vector3(point[0],this.height(...point),point[1]);
      const material=new THREE.MeshStandardMaterial({color:kind.startsWith('lamp')?'#ffdb95':'#9afff3',emissive:kind.startsWith('lamp')?'#a95d23':'#23cbbb',emissiveIntensity:1.8,metalness:.3,roughness:.25,transparent:true,depthWrite:false});
      const waystone=kind.startsWith('lamp')?waystones.create(position,material):null;
      const mineral=waystone?null:ore.create(position,material);
      const mesh=waystone?.core??mineral!.core;
      // Core stays in world coordinates for the existing channel/VFX and camera-fade paths.
      if(waystone){
        waystone.root.remove(mesh);this.root.add(waystone.root);
      }else if(mineral){
        this.root.add(mineral.root);
      }
      mesh.position.copy(position).y+=waystone?1.46:1.3;mesh.castShadow=true;
      const shadowOpacity={value:1};mesh.customDepthMaterial=collectibleShadow(shadowOpacity);this.root.add(mesh);
      const objective=Object.values(QUESTS).flatMap(q=>q.objectives).find(o=>o.kind===kind)!;
      this.nodes.push({kind:kind as ObjectiveKind,objective,position,mesh,shadowOpacity,halo:waystone?.halo});
    }
  }
  objectivePoint(kind:ObjectiveKind) {
    const p=STAR_OBJECTIVES[kind];return p?new THREE.Vector3(p[0],this.height(...p),p[1]):null;
  }
  interactable() {
    if(this.chapter!==2)return null;
    const active=this.game.quests.active();
    return this.nodes.find(n=>this.game.player.unit.pos.distanceTo(n.position)<3.5&&active.some(id=>QUESTS[id].objectives.some(o=>o.kind===n.kind&&!this.game.quests.objectiveDone(o))))??null;
  }
  collect(kind:ObjectiveKind) {
    this.game.quests.bump(kind);this.game.audio.sfx('sfx-quest-accept');this.game.vfx.mendGlow(this.game.player.unit);this.game.journey?.save();
  }


  constructor(private game: Game) {
    this.ambience=new StarAmbience(game.audio);
    const w=game.world;
    this.baseRoot=w.root;
    this.originalHeight=w.heightAt.bind(w);this.originalCollision=w.resolveCollision.bind(w);this.originalRay=w.raycastSolid.bind(w);
    this.root.visible=false;game.scene.add(this.root,this.third.root);
    this.sky=new StarSky();this.root.add(this.sky.root);
    const land=new THREE.PlaneGeometry(280,320,140,160);land.rotateX(-Math.PI/2);
    const pos=land.attributes.position,colors=[];
    const groundColor=new THREE.Color();
    for(let i=0;i<pos.count;i++){const x=pos.getX(i),z=pos.getZ(i),y=this.height(x,z);pos.setY(i,y);starGroundColor(x,z,y,groundColor);colors.push(groundColor.r,groundColor.g,groundColor.b);}
    land.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));land.computeVertexNormals();
    const pixels=new Uint8Array(128*128*4);
    for(let z=0;z<128;z++)for(let x=0;x<128;x++){
      const hash=Math.sin(x*127.1+z*311.7)*43758.5453,grain=(hash-Math.floor(hash))*.18;
      const vein=Math.pow(Math.abs(Math.sin(x*.12+Math.sin(z*.09)*2)),20)*.12;
      const shade=Math.round((.68+grain-vein)*255),i=(z*128+x)*4;
      pixels.set([shade,shade,shade,255],i);
    }
    const texture=this.groundTexture=new THREE.DataTexture(pixels,128,128);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(18,18);texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.generateMipmaps=true;texture.anisotropy=Math.min(8,game.engine.renderer.capabilities.getMaxAnisotropy());texture.needsUpdate=true;
    const ground=new THREE.Mesh(land,new THREE.MeshStandardMaterial({map:texture,vertexColors:true,roughness:.94,metalness:.08}));ground.name='star-island-ground';ground.receiveShadow=true;this.root.add(ground);
    this.sea=new StarSea();this.root.add(this.sea.root);
    const stone=new THREE.MeshStandardMaterial({color:'#3c3b57',roughness:.78,metalness:.3});
    const crystal=new THREE.MeshStandardMaterial({color:'#a57bff',emissive:'#6524c9',emissiveIntensity:1.5,metalness:.5,roughness:.2});
    const teal=new THREE.MeshStandardMaterial({color:'#b0fff1',emissive:'#26afba',emissiveIntensity:1.3,metalness:.6,roughness:.25});
    // Jagged crystal gardens frame the open combat paths. One geometry/material per family.
    const crystalFaces=crystal.clone();crystalFaces.vertexColors=true;crystalFaces.flatShading=true;crystalFaces.emissiveIntensity=.45;crystalFaces.metalness=.35;crystalFaces.roughness=.3;
    const crystals=new THREE.InstancedMesh(facetedStarCrystal(),crystalFaces,90);crystals.name='star-island-crystal-gardens';const matrix=new THREE.Matrix4();
    starCrystalGarden((x,z)=>this.height(x,z)).forEach((c,i)=>{
      if(c.clear)matrix.makeScale(0,0,0);
      else{
        matrix.compose(new THREE.Vector3(c.x,c.y+c.h*.5,c.z),c.q,c.scale);
        this.crystalSolids.push(c.solid);
      }
      crystals.setMatrixAt(i,matrix);
    });
    crystals.castShadow=true;this.root.add(crystals);
    this.throne=new StarThrone((x,z)=>this.height(x,z),stone,teal,crystal);
    this.root.add(this.throne.root);this.obstacles.push(...this.throne.solids);
    const disk=new THREE.Mesh(new THREE.CylinderGeometry(17,18,.3,64),stone);disk.position.copy(this.arena.position);disk.position.y=2.93;disk.receiveShadow=true;this.root.add(disk);
    for(const r of [3,9,16]){const ring=new THREE.Mesh(new THREE.TorusGeometry(r,.045,5,96),teal);ring.rotation.x=Math.PI/2;ring.position.set(0,3.12,-75);this.root.add(ring);}
    // The settlement owns the stone trails; keep only the luminous wayfinders here.
    for(let i=0;i<14;i++){const z=5-i*5,x=(i%2?1:-1)*6.5;const gem=new THREE.Mesh(new THREE.OctahedronGeometry(.4),teal);gem.position.set(x,this.height(x,z)+1,z);this.root.add(gem);this.rotations.push(gem);}
    this.portal=new StarPortal(this.spawn,'별빛 항구 → 클로헤이븐');this.root.add(this.portal.root);
    // The eastern street is open; the old spawn-relative site overlapped the tavern porch.
    const ship=w.pois.wreck.position;
    const shorePosition=new THREE.Vector3(ship.x-7,0,ship.z+7);shorePosition.y=w.heightAt(shorePosition.x,shorePosition.z);
    this.shorePortal=new StarPortal(shorePosition,'클로헤이븐 → 별빛 항구');w.root.add(this.shorePortal.root);
    this.thirdGate=new StarPortal(new THREE.Vector3(0,this.height(0,-41),-41),'별빛 항구 → 새벽의 섬');this.root.add(this.thirdGate.root);
    this.root.add(this.sun.light,this.sun.light.target,new THREE.HemisphereLight('#869cff','#1a1028',1.0));
    for(const p of [new THREE.Vector3(0,8,86),new THREE.Vector3(0,10,-75)]){const light=new THREE.PointLight('#8e5dff',28,35,1.5);light.position.copy(p);this.root.add(light);}
  }
  refreshLanguage(){
    if(this.chapter===3){this.game.dawnBoss.freed.name=t('미라 · 사라진 친구','Mira · The Missing Friend');const names=[['새벽 항구의 로안 선장','Captain Roan'],['새벽의 사제 셀레네','Selene of Dawn'],['의무관 산호','Medic Coral'],['성문 수비대장 바론','Gatewarden Baron'],['여관주인 메리','Innkeeper Merry'],['항해사 루멘','Navigator Lumen'],['대장장이 플린','Smith Flynn']];this.game.npcs.forEach((n,i)=>{n.unit.name=t(names[i][0],names[i][1]);n.unit.title=t('새벽 항구의 주민','Dawnharbor Resident');});for(const e of this.game.enemies)if(!e.isAdd)e.unit.name=e.kind==='scrapling'?t('잿빛 해안 약탈자','Ash Coast Raider'):t('황혼 성채 파수병','Twilight Sentinel');return;}
    if(this.chapter!==2)return;
    for(const e of this.game.enemies)if(!e.isAdd)e.unit.name=e.kind==='scrapling'?t('수정 껍질 파수꾼','Crystal-shell Sentry'):t('별빛 유적 수호자','Star-ruin Guardian');
  }
  regionAt(x:number,z:number){
    if(this.chapter===3)return z<-45?'Twilight Citadel':z<12?'The Dawn Ascent':x>52&&z>52?'Dawnwatch Lighthouse':x< -45&&z>25?'Seabreeze Gardens':Math.abs(x)>45?'Ashen Palm Coast':'Dawnharbor';
    if(Math.hypot(x,z+75)<24)return 'The Star Throne';
    if(Math.abs(x)<54&&z>3&&z<100)return 'Starhaven';
    if(x<-40)return 'Moonshade Crystalwood';
    if(x>40)return 'The Fallen Star Ruins';
    if(z<-25)return 'The Pilgrim’s Starroad';
    return 'The Forgotten Star';
  }
  height(x:number,z:number) {
    return starSurfaceHeight(this.groundHeights,x,z);
  }

  enter(authority=true) {
    if(!this.canTravel(2)){this.go(2);return;}
    if(this.chapter===2)return;
    if(this.chapter===3)this.returnToShore();
    const g=this.game,w=g.world;
    g.ending.cancel();
    g.hud.dialogue.close();
    g.hud.messages.closeDiscovery();
    if(!this.baseHomes.length)this.baseHomes=g.enemies.map(e=>e.home.clone());
    this.chapter=2;g.hud.hints.setChapter(2);this.rendered=true;this.resetPortalArrival();
    if(!this.armour){this.armour=new StarEnemyArmour(g.enemies);this.root.add(this.armour.root);}
    this.ambience.start(g.time);
    if(!this.baseNames.length)this.baseNames=g.enemies.map(e=>e.unit.name);
    g.cinematic=false;g.journey?.closeChapterEnding();
    this.baseRoot.visible=false;this.root.visible=true;
    w.heightAt=(x,z)=>this.height(x,z);
    w.resolveCollision=(x,z,r,out)=>resolveOnIsland(this.collision,STAR_BOUNDS,this.obstacles,x,z,r,out);
    w.raycastSolid=(from,to)=>this.collision?.raycast(from,to)??null;
    if(!this.basePois.size)for(const [id,poi] of Object.entries(w.pois))this.basePois.set(id,{position:poi.position.clone(),yaw:poi.yaw});
    if(!this.basePeople.length)this.basePeople=[...g.npcs.map(n=>n.poi.position.clone()),...g.townsfolk.map(t=>t.unit.pos.clone())];
    w.pois.spawn.position.copy(this.spawn);w.pois.spawn.yaw=Math.PI;
    for(const npc of g.npcs){const [x,z]=STAR_TOWN[npc.def.id];npc.poi.position.set(x,this.height(x,z),z);npc.poi.yaw=Math.PI;npc.unit.hidden=false;npc.unit.teleport(w,x,z,Math.PI);}
    for(const [id,x,z] of [['shore',-70,5],['wreck',70,-15],['grove',25,55],['forge',-25,36],['tavern',-20,58],['chapel',20,35],['lighthouse',0,-48],['beacon',0,-45],['bossArena',0,-75]] as const)w.pois[id].position.set(x,this.height(x,z),z);
    const walks=STAR_WALKS.map(([x,z])=>new THREE.Vector3(x,this.height(x,z),z));
    const residentPoints=[...walks,...[[-6,49],[-6,61],[6,49],[6,61]].map(([x,z])=>new THREE.Vector3(x,this.height(x,z),z))];
    g.townsfolk.forEach((t,i)=>{
      const p=walks[i%walks.length];t.unit.hidden=false;t.unit.teleport(w,p.x+(i%3-1)*2,p.z,i*.8);
      // Each resident owns the mutable route cursor; neither other residents nor the
      // player's quest guidance can overwrite their destination or cached path.
      t.relocate(walks,2.5,new NavHints(w,{points:residentPoints,includeWorldPoints:false,radius:t.unit.radius+.15,step:.5}));
    });
    // The shore graph describes different streets. Build the island graph only after
    // its collision surface and relocated POIs are active, including the pilgrim trails.
    const routePoints=[...Object.values(STAR_TOWN),...STAR_WALKS,...STAR_TRAILS.flat(),[0,86],[0,-75],[-3,-55],[3,-55],[-14,-60],[14,-60],[-6,49],[-6,61],[6,49],[6,61]];
    this.nav=new NavHints(w,{
      points:routePoints.map(([x,z])=>new THREE.Vector3(x,this.height(x,z),z)),
      includeWorldPoints:false, radius:g.player.unit.radius+.15, step:.5,
    });
    g.boss.unit.hidden=g.finalBoss.unit.hidden=true;
    g.dawnBoss.unit.hidden=g.dawnBoss.freed.hidden=true;
    g.worldBoss.unit.hidden=g.worldBoss.state==='dormant'||g.worldBoss.state==='dead';
    g.quests.setChapter(2);
    g.hud.tracker.update(g.quests);
    if(g.hud.questLog.open)g.hud.questLog.render();
    {
      const mobs=g.enemies.filter(e=>!e.isAdd);
      mobs.forEach((e,i)=>{if(e.kind==='jellyfish'){e.despawn();return;}const side=e.kind==='scrapling'?-1:1;const x=i<3?[19,30,20][i]:side*(60+(i%4)*7),z=i<3?[-8,-22,-34][i]:28-Math.floor(i/4)*16-(i%3)*3;e.home.set(x,this.height(x,z),z);if(authority&&!e.isEcho)e.respawnAt(x,z);if(e.isEcho)e.despawn();e.unit.name=e.kind==='scrapling'?t('수정 껍질 파수꾼','Crystal-shell Sentry'):t('별빛 유적 수호자','Star-ruin Guardian');e.refreshAppearance();});
      for(const e of g.enemies.filter(e=>e.isAdd))e.despawn();
    }
    this.echoAt=g.time+45;
    g.player.respawn();g.player.unit.teleport(w,this.spawn.x,this.spawn.z,Math.PI);g.follow.cut();g.follow.yaw=0;
    g.player.setTarget(null);g.zone='';g.hud.messages.banner(() => (t('WORLD II · 잊힌 별의 섬','WORLD II · Isle of Forgotten Stars')),() => (t('별빛 항구 · 주민 퀘스트 7개 · 성장에는 끝이 없습니다','Starhaven · Seven villager quests · Keep growing beyond level 20')),'zone');
    try{g.hud.minimap.setSnapshot(snapshotMap(g.engine.renderer,g.scene,{minX:-140,maxX:140,minZ:-150,maxZ:170,topY:90},[g.vfx.group,g.objective.group,...g.units.map(u=>u.rig.root)]));}catch{ /* The island still plays if map capture is unavailable. */ }
    g.journey?.save();
  }
  private enterThird(authority=true){
    if(this.chapter===3)return;
    const g=this.game;
    if(this.chapter===2)this.returnToShore();
    // Capture the original homes/POIs once using the same restoration path as World II.
    if(!this.baseHomes.length){this.enter(authority);this.returnToShore();}
    g.ending.cancel();g.hud.dialogue.close();g.hud.messages.closeDiscovery();
    this.chapter=3;this.rendered=true;this.baseRoot.visible=false;this.root.visible=false;this.third.root.visible=true;this.resetPortalArrival();
    const w=g.world,third=this.third;w.heightAt=(x,z)=>third.height(x,z);
    w.resolveCollision=(x,z,r,out)=>resolveOnIsland(third.collision,DAWN_BOUNDS,[],x,z,r,out);w.raycastSolid=(a,b)=>third.collision.raycast(a,b);
    w.pois.spawn.position.copy(third.spawn);w.pois.spawn.yaw=Math.PI;
    for(const [id,x,z] of [['forge',20,64],['chapel',16,48],['tavern',-20,64],['grove',-55,36],['shore',55,36],['wreck',55,-25],['lighthouse',0,-40],['beacon',0,-44],['bossArena',0,-72]] as const)w.pois[id].position.set(x,third.height(x,z),z);
    g.npcs.forEach((n,i)=>{const [x,z]=third.town[i];n.poi.position.set(x,third.height(x,z),z);n.unit.hidden=false;n.unit.teleport(w,x,z,Math.PI);});
    const walks=third.town.map(([x,z])=>new THREE.Vector3(x,third.height(x,z),z));g.townsfolk.forEach((f,i)=>{const p=walks[i%walks.length];f.unit.hidden=false;f.unit.teleport(w,p.x,p.z+3);f.relocate(walks,1.8);});
    this.nav=new NavHints(w,{points:[...walks,new THREE.Vector3(0,4,26),new THREE.Vector3(0,9,-22),third.arena.position],includeWorldPoints:false,radius:g.player.unit.radius+.15,step:.5});
    for(const b of [g.boss,g.finalBoss,g.worldBoss]){b.unit.hidden=true;b.freed.hidden=true;}g.dawnBoss.unit.hidden=['dormant','dead'].includes(g.dawnBoss.state);
    {const f=g.dawnBoss.freed;f.hidden=false;f.targetable=false;if(g.journey?.finalCleared)f.teleport(w,14,60);else f.teleport(w,13,-57);}
    g.enemies.filter(e=>!e.isAdd).forEach((e,i)=>{if(e.isEcho||e.kind==='jellyfish'){e.despawn();return;}const x=(i%2?1:-1)*(43+i%4*8),z=16-Math.floor(i/2)*10;e.home.set(x,third.height(x,z),z);if(authority)e.respawnAt(x,z);});
    g.quests.setChapter(3);g.hud.hints.setChapter(3);this.refreshLanguage();g.hud.tracker.update(g.quests);if(g.hud.questLog.open)g.hud.questLog.render();
    g.player.respawn();g.player.unit.teleport(w,0,82,Math.PI);g.follow.cut();g.follow.yaw=0;g.zone='';
    g.hud.messages.banner(()=>t('WORLD III · 새벽을 잃은 섬','WORLD III · Isle of the Stolen Dawn'),()=>t('친구 미라를 구하고 100레벨 황혼의 왕에게 도전하세요','Rescue Mira and challenge the Twilight King at level 100'),'zone');
    g.hud.chat.system(t('친구 미라는 황혼 성채에 갇혀 있어요. 항구의 선장에게 구조 의뢰를 받으세요.','Mira is imprisoned in the Twilight Citadel. Speak to the captain in Dawnharbor.'));
    g.hud.minimap.setSnapshot(snapshotMap(g.engine.renderer,g.scene,{minX:-150,maxX:150,minZ:-175,maxZ:175,topY:110},[g.vfx.group,g.objective.group,...g.units.map(u=>u.rig.root)]));g.journey?.save();
  }

  returnToShore() {
    if(this.chapter===1)return;
    this.game.ending.cancel();
    this.game.hud.dialogue.close();
    this.game.hud.messages.closeDiscovery();
    this.showEpilogue();this.third.root.visible=false;this.chapter=1;this.game.hud.hints.setChapter(1);this.game.quests.setChapter(1);
    // World II has its own lighting. Restore the untouched shore atmosphere and fog.
    this.game.world.setMood(this.game.world.getEnvironment().mood,true);
    const g=this.game;
    g.enemies.forEach((e,i)=>{if(this.baseHomes[i])e.home.copy(this.baseHomes[i]);if(this.baseNames[i])e.unit.name=this.baseNames[i];if(!e.isAdd&&!e.isEcho&&g.multiplayer?.battle.authority!==false)e.respawnAt(e.home.x,e.home.z);e.refreshAppearance();if(e.isEcho)e.despawn();});
    for(const n of g.npcs){n.unit.name=n.def.name;n.unit.title=n.def.title;}
    this.resetPortalArrival();
    g.worldBoss.unit.hidden=true;g.dawnBoss.unit.hidden=g.dawnBoss.freed.hidden=true;
    for(const b of [g.boss,g.finalBoss])b.unit.hidden=b.state==='dormant'||b.state==='dead';
    for(const u of [...g.npcs.map(n=>n.unit),...g.townsfolk.map(t=>t.unit)])u.hidden=false;
    g.player.respawn();g.player.unit.teleport(g.world,this.shorePortal.root.position.x,this.shorePortal.root.position.z+5,Math.PI);g.follow.cut();
    g.hud.tracker.update(g.quests);
    if(g.hud.questLog.open)g.hud.questLog.render();
    g.hud.minimap.setSnapshot(g.takeMapSnapshot());g.journey?.save();
  }
  showEpilogue() {
    this.ambience.stop();this.third.root.visible=false;
    if(!this.rendered)return;this.rendered=false;this.root.visible=false;this.baseRoot.visible=true;
    const w=this.game.world;w.heightAt=this.originalHeight;w.resolveCollision=this.originalCollision;w.raycastSolid=this.originalRay;
    for(const [id,old] of this.basePois){const poi=w.pois[id as keyof typeof w.pois];poi.position.copy(old.position);poi.yaw=old.yaw;}
    [...this.game.npcs.map(n=>n.unit),...this.game.townsfolk.map(t=>t.unit)].forEach((u,i)=>{const p=this.basePeople[i];if(p){u.hidden=false;u.teleport(w,p.x,p.z,u.yaw);}});
    const town=w.spawns.find(s=>s.id==='townsfolk');if(town)for(const t of this.game.townsfolk)t.relocate(town.points,town.radius);
  }
  update(dt:number,time:number) {
    this.shorePortal.update(time);this.portal.update(time);this.thirdGate.update(time);
    this.thirdGate.root.visible=!!this.game.journey?.trueCleared||this.game.creatorTravel;
    if(this.chapter===3)this.third.update(time,!!this.game.journey?.finalCleared,this.game.player.unit.pos.x,this.game.player.unit.pos.z);
    if(!this.game.ending.active&&!this.game.controlsLocked){
      const distance=Math.hypot(this.game.player.unit.pos.x-this.portalPosition.x,this.game.player.unit.pos.z-this.portalPosition.z);
      if(distance>4.5)this.travelArmed=true;
      if(this.travelArmed&&distance<1.7&&this.game.time>this.travelAt){this.travelArmed=false;this.travelAt=this.game.time+3;this.travel();}
    }
    if(!this.rendered)return;
    if(this.chapter===3){const fog=this.game.scene.fog;if(fog instanceof THREE.FogExp2){fog.color.set('#a4b5c4');fog.density=.0025;}return;}
    const echo=this.game.enemies.find(e=>e.isEcho);
    if(echo&&this.game.multiplayer?.battle.authority!==false&&echo.state==='gone'&&time>this.echoAt&&!this.game.encounter.engaged){echo.home.set(0,this.height(0,-22),-22);echo.respawnAt(0,-22);this.echoAt=time+120;this.game.hud.messages.info(t('녹의 폭군의 잔영이 별길에 나타났어요!','An echo of the Rust Tyrant has appeared on the Starroad!'));}
    const position=this.game.player.unit.pos,right=this.game.camera.matrixWorld.elements;
    this.sun.update(position.x,position.z);
    this.ambience.update(time,this.regionAt(position.x,position.z),position.x,position.z,right[0],right[2],this.game.player.inCombat||this.game.encounter.engaged||this.game.ending.active||!this.game.player.unit.alive);
    const fog=this.game.scene.fog;if(fog instanceof THREE.FogExp2){fog.color.set('#17152e');fog.density=.007;}
    this.sky.update(time,this.game.camera,this.game.engine.renderer.getPixelRatio());this.life?.update(time);
    this.sea.update(time);
    this.armour?.update(time);this.throne.update(time);
    this.wind?.update(time);
    for(const [kind,point] of Object.entries(STAR_OBJECTIVES))if(kind.startsWith('explore-')&&Math.hypot(this.game.player.unit.pos.x-point[0],this.game.player.unit.pos.z-point[1])<5)this.game.quests.bump(kind as ObjectiveKind);
    for(const memory of this.memories){
      const objective=QUESTS.w5.objectives.find(o=>o.kind===memory.kind)!;
      const done=this.game.quests.objectiveDone(objective),active=this.game.quests.status.w5==='active';
      (memory.ring.material as THREE.MeshBasicMaterial).color.set(done?'#9de4b8':'#c0a0ff');
      (memory.ring.material as THREE.MeshBasicMaterial).opacity=done?.18:active?.5+Math.sin(time*2)*.15:.18;
      const core=memory.star.material as THREE.MeshStandardMaterial;
      core.color.set(done?'#9de4b8':'#d6beff');core.emissive.set(done?'#257e61':'#7854ba');core.emissiveIntensity=done?1.25:1.7;
      memory.star.rotation.y=time*.5;memory.star.position.y=this.height(memory.star.position.x,memory.star.position.z)+2.7+Math.sin(time*1.5)*.12;
    }
    this.sightAim.copy(this.game.player.unit.pos).y+=this.game.player.unit.height*.55;
    this.sightRay.subVectors(this.sightAim,this.game.camera.position);
    const sightLengthSq=Math.max(.00001,this.sightRay.lengthSq());
    for(const node of this.nodes){
      const done=this.game.quests.objectiveDone(node.objective);
      node.mesh.visible=!done||node.kind.startsWith('lamp');
      if(node.kind.startsWith('lamp')){
        (node.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity=done?2.3+Math.sin(time*1.6+node.position.z)*.25:.16;
        node.mesh.rotation.y=time*.25+node.position.z;
        if(node.halo)node.halo.material.opacity=done?.56+Math.sin(time*1.6+node.position.z)*.1:.06;
      }
      else {node.mesh.rotation.y=time*.5;node.mesh.position.y=node.position.y+1.3+Math.sin(time*2+node.position.x)*.15;}
      // Protect the shell's sightline as well as the lens. Targets ahead of the player remain
      // visible; a passed collectible fades smoothly as it moves between the player and camera.
      this.sightOffset.subVectors(node.mesh.position,this.game.camera.position);
      const along=this.sightOffset.dot(this.sightRay)/sightLengthSq;
      const interior=THREE.MathUtils.smoothstep(along,0,.12)*(1-THREE.MathUtils.smoothstep(along,.88,1));
      const separation=this.sightOffset.addScaledVector(this.sightRay,-along).length();
      const radius=node.kind.startsWith('lamp')?1.4:.95;
      const sightFade=1-interior*(1-THREE.MathUtils.smoothstep(separation,radius,radius+.9));
      const opacity=sightFade*THREE.MathUtils.smoothstep(node.mesh.position.distanceTo(this.game.camera.position),3.5,8);
      (node.mesh.material as THREE.MeshStandardMaterial).opacity=opacity;node.shadowOpacity.value=opacity;node.mesh.castShadow=opacity>.001;
    }
    for(const o of this.rotations){o.rotation.y+=dt*.6;o.rotation.z=Math.sin(time*.7+o.position.x)*.12;}

  }
  dispose(){
    this.ambience.dispose();
    this.showEpilogue();this.game.scene.remove(this.root,this.third.root);this.baseRoot.remove(this.shorePortal.root);
    const mats=new Set<THREE.Material>(),geos=new Set<THREE.BufferGeometry>();
    for(const root of [this.root,this.shorePortal.root,this.third.root])root.traverse(o=>{
      if(o instanceof THREE.DirectionalLight||o instanceof THREE.PointLight||o instanceof THREE.SpotLight)o.shadow.dispose();
      if(o instanceof THREE.Mesh||o instanceof THREE.Points){
        // BatchedMesh owns matrix/indirection textures as well as its private geometry.
        if(o instanceof THREE.BatchedMesh)o.dispose();
        else {
          geos.add(o.geometry);
          if(o instanceof THREE.InstancedMesh)o.dispose();
        }
        for(const m of Array.isArray(o.material)?o.material:[o.material])mats.add(m);
        if(o.customDepthMaterial)mats.add(o.customDepthMaterial);
      }
    });
    const ownedTextures=new Set<THREE.Texture>();for(const m of mats){const map=(m as THREE.MeshStandardMaterial).map;if(map?.userData.islandPaving)ownedTextures.add(map);}for(const texture of ownedTextures)texture.dispose();
    this.groundTexture.dispose();for(const g of geos)g.dispose();for(const m of mats)m.dispose();
  }
}
