import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {BattleSync} from '../tmp/test-modules/battle.js';
import {Combat} from '../tmp/test-modules/combat.js';
import {QuestLog} from '../tmp/test-modules/quests.js';

function unit(kind='scrapling') {
 const u={kind,name:kind,reaction:kind==='scrapling'||kind==='boss'?'hostile':'friendly',pos:new THREE.Vector3(),hp:100,maxHp:100,level:3,alive:true,hidden:false,invulnerable:false,targetable:true,
  yaw:0,stunUntil:0,slowUntil:0,slowPct:0,rust:0,rustUntil:0,pushX:0,pushZ:0,pushTime:0,absorb:0,lastCombat:0,radius:1,
  rig:{root:new THREE.Group(),face:{setTint(){}}},motion:{action:null,stop(){}},ctrl:null,
  act(action){this.onAction?.(action)},express(){},flash(){},cancelPendingHit(){},feedLocomotion(){},setYaw(y){this.yaw=y},setBaseTint(){},centre(v){return v.copy(this.pos)},distTo(o){return this.pos.distanceTo(o.pos)}};
 Object.defineProperty(u,'hostile',{get:()=>u.reaction==='hostile'});return u;
}
function game() {
 const p=unit('player'),enemy=unit();enemy.ctrl={state:'idle',stats:{xp:20},onDamaged(){this.state='chase'},onDeath(){this.state='dead'},resumeAuthority(){}};
 const boss=id=>{const b={unit:unit('boss'),freed:unit('freed'),state:'dormant',phase:1,enraged:false,
  networkState(){return {id,state:this.state,phase:this.phase,enraged:this.enraged,mech:null}},applyNetwork(s){Object.assign(this,s)},resumeAuthority(){},wake(){this.state='waking'}};return b};
 const noop=()=>{};
 let mood=0,beacon=false;
 const g={quests:new QuestLog(),world:{setMood(m){mood=m},setBeaconLit(b){beacon=b},getEnvironment(){return {mood,beacon}}},time:10,god:false,rewards:0,units:[p,enemy],enemies:[{unit:enemy,resumeAuthority(){}}],boss:boss('b3'),finalBoss:boss('b10'),worldBoss:boss('b20'),dawnBoss:boss('b30'),encounter:{engaged:false},world2:{chapter:1,canTravel(ch){return ch===1||!!g.journey.abyssCleared&&(ch===2||!!g.journey.trueCleared)},go(ch){if(!this.canTravel(ch))return false;this.chapter=ch;return true;},enter(){this.chapter=2},returnToShore(){this.chapter=1}},journey:{rustCleared:false,abyssCleared:false},
  player:{unit:p,setTarget:noop,gainRage:noop,onDamaged:noop,onWardHit:noop},hud:{floats:{spawn:noop},damageFlash:noop,messages:{info:noop}},
  follow:{shake:noop},audio:{sfx:noop},vfx:{deathPoof:noop,smoke:noop,stunStars:noop},events:{emit:noop},onUnitDied(u){if(u.kind==='scrapling')this.rewards++}};
 g.combat=new Combat(g);return g;
}
function pair() {
 const a=game(),b=game(),queue=[],ar=unit('remote'),br=unit('remote');
 const ap=new Map([['b',{unit:ar}]]),bp=new Map([['a',{unit:br}]]);
 const relay=(id,packet)=>queue.push({id,packet});
 const aa=new BattleSync(a,p=>relay('a',p),()=>ap),bb=new BattleSync(b,p=>relay('b',p),()=>bp);
 a.multiplayer={battle:aa};b.multiplayer={battle:bb};aa.join('a','a',null);bb.join('b','a',null);
 const flush=()=>{let guard=0;while(queue.length){assert.ok(++guard<100);const {id,packet:p}=queue.shift(),dst=id==='a'?bb:aa;
  if(p.type==='world')dst.apply(p.world);if(p.type==='combat')dst.receive(id,p.event);}};
 aa.update(.1);flush();return {a,b,aa,bb,ar,flush};
}

test('guest and host damage reduce the same enemy HP; death grants exactly one reward per player',()=>{
 const {a,b,aa,flush}=pair(),enemy=a.enemies[0].unit,mirror=b.enemies[0].unit;
 b.combat.damage(b.player.unit,mirror,23);assert.equal(mirror.hp,100);flush();assert.equal(enemy.hp,77);assert.equal(mirror.hp,77);
 a.combat.damage(a.player.unit,enemy,31);aa.update(.1);flush();assert.equal(enemy.hp,46);assert.equal(mirror.hp,46);
 b.combat.damage(b.player.unit,mirror,46);flush();assert.equal(enemy.alive,false);assert.equal(mirror.alive,false);
 assert.equal(a.rewards,1);assert.equal(b.rewards,1);
 b.combat.damage(b.player.unit,mirror,46);flush();assert.equal(a.rewards,1);assert.equal(b.rewards,1);
});
test('enemy hits damage the remote owner, not the host; guest stun and knockback reach the authoritative enemy',()=>{
 const {a,b,bb,ar,flush}=pair(),enemy=a.enemies[0].unit,mirror=b.enemies[0].unit;
 a.combat.damage(enemy,ar,19);flush();assert.equal(b.player.unit.hp,81);assert.equal(a.player.unit.hp,100);
 mirror.stunUntil=b.time+2;mirror.slowUntil=b.time+4;mirror.slowPct=.5;mirror.pushX=12;mirror.pushTime=.35;
 bb.condition(mirror);flush();assert.equal(enemy.stunUntil,a.time+2);assert.equal(enemy.slowPct,.5);assert.equal(enemy.pushX,12);
});
test('late joins and host migration preserve combat state without granting old kill rewards',()=>{
 const {a,b,aa,bb,flush}=pair();
 a.combat.damage(a.player.unit,a.enemies[0].unit,100);flush();assert.equal(b.rewards,1);
 const c=game(),cc=new BattleSync(c,()=>{},()=>new Map());c.multiplayer={battle:cc};
 cc.join('c','a',aa.snapshot());assert.equal(c.enemies[0].unit.alive,false);assert.equal(c.rewards,0);
 bb.elect('b');assert.equal(bb.authority,true);assert.equal(b.enemies[0].unit.alive,false);assert.equal(b.rewards,1);
});

test('boss death still grants one reward when an add-death checkpoint arrived first',()=>{
 const {b,bb}=pair();b.enemies[0].unit.alive=false;
 bb.receive('a',{kind:'death',target:'e0',serial:99});assert.equal(b.rewards,1);
 bb.receive('a',{kind:'death',target:'e0',serial:99});assert.equal(b.rewards,1);
});
test('boss night, celebration, beacon and world clock synchronize including late join and host transfer',()=>{
 const {a,b,aa,bb,flush}=pair();
 a.world.setMood(1);a.world.setBeaconLit(true);aa.worldTime(100,.1);aa.update(.1);flush();
 assert.deepEqual(b.world.getEnvironment(),{mood:1,beacon:true});assert.equal(bb.worldTime(999,0),aa.worldTime(999,0));
 // A guest completing the beacon/night step asks the host; it never changes only its own sky.
 a.world.setMood(0);aa.update(.1);flush();b.world.setMood(1);assert.equal(b.world.getEnvironment().mood,0);flush();assert.equal(a.world.getEnvironment().mood,1);assert.equal(b.world.getEnvironment().mood,1);
 a.journey.abyssCleared=true;a.world.setMood(2);aa.update(.1);flush();
 const c=game(),cc=new BattleSync(c,()=>{},()=>new Map());c.multiplayer={battle:cc};cc.join('c','a',aa.snapshot());assert.deepEqual(c.world.getEnvironment(),{mood:2,beacon:true});
 const clock=bb.worldTime(12345,0);bb.elect('b');assert.equal(bb.worldTime(12345,0),clock);assert.equal(b.world.getEnvironment().mood,2);
});

test('World II entry and the final crown survive late join and authority transfer',()=>{
 const {a,b,aa,bb,flush}=pair();
 // A guest can use direct travel, but cannot teleport the room during combat.
 a.encounter.engaged=true;bb.enterWorld2();flush();assert.equal(a.world2.chapter,1);a.encounter.engaged=false;
 a.journey.rustCleared=true;a.journey.abyssCleared=true;a.journey.firstEndingSeen=true;
 aa.update(.1);flush();bb.enterWorld2();flush();
 assert.equal(a.world2.chapter,2);assert.equal(b.world2.chapter,2);
 a.journey.trueCleared=true;a.worldBoss.state='dead';a.worldBoss.unit.level=20;
 aa.update(.1);flush();assert.equal(b.journey.trueCleared,true);assert.equal(b.worldBoss.state,'dead');
 const c=game(),cc=new BattleSync(c,()=>{},()=>new Map());cc.join('c','a',aa.snapshot());
 assert.equal(c.world2.chapter,2);assert.equal(c.worldBoss.unit.level,20);assert.equal(c.journey.trueCleared,true);
 bb.elect('b');assert.equal(bb.authority,true);assert.equal(b.world2.chapter,2);
});


test('two-way portals synchronize both chapters without losing story crowns',()=>{
 const {a,b,aa,bb,flush}=pair();a.journey.rustCleared=true;a.journey.abyssCleared=true;
 bb.travel(2);flush();assert.equal(a.world2.chapter,2);assert.equal(b.world2.chapter,2);
 bb.travel(1);flush();assert.equal(a.world2.chapter,1);assert.equal(b.world2.chapter,1);assert.equal(b.journey.abyssCleared,true);
});
test('a guest can turn off the shared beacon and request morning',()=>{
 const {a,b,aa,bb,flush}=pair();a.world.setBeaconLit(true);aa.update(.1);flush();
 bb.requestLighthouse(false);flush();assert.equal(a.world.getEnvironment().beacon,false);assert.equal(b.beaconLit,false);
});


test('room PvP is off by default; parties prevent friendly fire and rivals receive one hit',()=>{
 const {a,b,aa,bb,ar,flush}=pair();ar.invulnerable=false;
 a.combat.damage(a.player.unit,ar,15);flush();assert.equal(b.player.unit.hp,100);
 aa.setMode('pvp');flush();assert.equal(bb.mode,'pvp');
 a.combat.damage(a.player.unit,ar,15);flush();assert.equal(b.player.unit.hp,85);
 aa.setParty(2);bb.setParty(2);flush();a.time+=1;
 a.combat.damage(a.player.unit,ar,15);flush();assert.equal(b.player.unit.hp,85);
 bb.setParty(3);flush();a.time+=1;a.combat.damage(a.player.unit,ar,15);flush();assert.equal(b.player.unit.hp,70);
});
test('guests cannot enable PvP and out-of-range attacks do no damage',()=>{
 const {a,b,aa,bb,ar,flush}=pair();bb.setMode('pvp');flush();assert.equal(aa.mode,'coop');
 aa.setMode('pvp');flush();ar.pos.set(100,0,100);a.combat.damage(a.player.unit,ar,20);flush();assert.equal(b.player.unit.hp,100);
});

test('a stale guest night request cannot override an extinguished beacon or change shore weather from World II',()=>{
 const {a,b,aa,flush}=pair();
 a.world.setMood(3);a.world.setBeaconLit(false);aa.update(.1);flush();b.world.setMood(1);flush();
 assert.deepEqual(a.world.getEnvironment(),{mood:3,beacon:false});assert.deepEqual(b.world.getEnvironment(),{mood:3,beacon:false});
 a.world.setBeaconLit(true);a.world.setMood(0);a.world2.enter();aa.update(.1);flush();b.world.setMood(1);flush();
 assert.deepEqual(a.world.getEnvironment(),{mood:0,beacon:true});assert.deepEqual(b.world.getEnvironment(),{mood:0,beacon:true});
});


test('shared lit beacon completes the guest quest once and never credits it in World II',()=>{
 const {a,b,aa,flush}=pair();let completed=0;
 b.quests.events.on('completed',id=>{if(id==='q3')completed++});
 b.quests.accept('q3');b.quests.bump('kill-scavenger',3);
 a.world.setBeaconLit(true);aa.publish();flush();
 assert.equal(b.quests.status.q3,'done');assert.equal(completed,1);
 aa.publish();flush();assert.equal(completed,1);
 b.quests=new QuestLog();b.quests.accept('q3');b.quests.bump('kill-scavenger',3);
 a.journey.abyssCleared=true;a.world2.chapter=2;aa.publish();flush();
 assert.equal(b.quests.status.q3,'active');assert.equal(b.quests.progress.get('q3-beacon')??0,0);
});

test('a finite remote push is transmitted once, then expires without stale repeats',()=>{
 const g=game(),peer=unit('remote'),packets=[];
 const sync=new BattleSync(g,p=>packets.push(p),()=>new Map([['b',{unit:peer}]]));sync.join('a','a',null);
 peer.pushX=3.2;peer.pushTime=.05;
 for(let i=0;i<120;i++){g.time+=1/60;sync.update(1/60);}
 const effects=packets.filter(p=>p.type==='combat'&&p.event.kind==='effect'&&p.event.effect.pushTime>0).map(p=>p.event.effect);
 assert.equal(effects.length,1);assert.ok(Math.abs(effects.reduce((x,f)=>x+f.pushX*f.pushTime,0)-.16)<1e-9);assert.equal(peer.pushTime,0);
});

test('continuous remote pull preserves its displacement across 30/60/144Hz and the 5Hz relay cadence',()=>{
 for(const hz of [30,60,144]){
  const g=game(),peer=unit('remote'),packets=[],sync=new BattleSync(g,p=>packets.push(p),()=>new Map([['b',{unit:peer}]]));sync.join('a','a',null);
  for(let i=0;i<hz*2;i++){if(i<hz){peer.pushX=3.2;peer.pushZ=-1.6;peer.pushTime=1/hz;}g.time+=1/hz;sync.update(1/hz);}
  const effects=packets.filter(p=>p.type==='combat'&&p.event.kind==='effect').map(p=>p.event.effect);
  assert.ok(Math.abs(effects.reduce((x,f)=>x+f.pushX*f.pushTime,0)-3.2)<1e-9,`x at ${hz}Hz`);
  assert.ok(Math.abs(effects.reduce((x,f)=>x+f.pushZ*f.pushTime,0)+1.6)<1e-9,`z at ${hz}Hz`);
  assert.ok(effects.length<=6,`bounded 5Hz traffic at ${hz}Hz`);assert.equal(peer.pushTime,0);
 }
});

test('a new remote effect preserves the unconsumed displacement of an overlapping packet',()=>{
 const {b,bb}=pair(),u=b.player.unit;u.pushX=4;u.pushZ=-2;u.pushTime=.05;
 bb.receive('a',{kind:'effect',target:'b',effect:{stun:0,rust:0,rustFor:0,pushX:2,pushZ:3,pushTime:.1}});
 assert.ok(Math.abs(u.pushX*u.pushTime-.4)<1e-9);assert.ok(Math.abs(u.pushZ*u.pushTime-.2)<1e-9);assert.ok(Math.abs(u.pushTime-.15)<1e-9);
});

test('an unsent force cannot carry into a fresh peer after leaving a room',()=>{
 const g=game(),peer=unit('remote'),packets=[],peers=new Map([['b',{unit:peer}]]),sync=new BattleSync(g,p=>packets.push(p),()=>peers);sync.join('a','a',null);
 peer.pushX=3;peer.pushTime=.05;sync.update(.05);sync.leave();peers.set('b',{unit:unit('remote')});sync.join('a','a',null);sync.update(.3);
 assert.equal(packets.filter(p=>p.type==='combat'&&p.event.kind==='effect').length,0);
});

test('guest portal requests cannot skip the level10 or level20 crown; World III restores all four bosses',()=>{
 const {a,b,aa,bb,flush}=pair();
 a.player.unit.level=100;bb.travel(2);flush();assert.equal(a.world2.chapter,1);assert.equal(b.world2.chapter,1);
 a.journey.rustCleared=a.journey.abyssCleared=true;aa.publish();flush();bb.travel(3);flush();assert.equal(a.world2.chapter,1);
 bb.travel(2);flush();assert.equal(a.world2.chapter,2);
 a.journey.trueCleared=true;a.worldBoss.state='dead';aa.publish();flush();bb.travel(3);flush();assert.equal(a.world2.chapter,3);assert.equal(b.world2.chapter,3);
 a.dawnBoss.state='fight';a.dawnBoss.unit.level=30;aa.publish();flush();assert.equal(b.dawnBoss.state,'fight');assert.equal(b.dawnBoss.unit.level,30);
 a.journey.finalCleared=true;a.dawnBoss.state='dead';aa.publish();flush();
 const c=game(),cc=new BattleSync(c,()=>{},()=>new Map());c.multiplayer={battle:cc};cc.join('c','a',aa.snapshot());
 assert.equal(c.world2.chapter,3);assert.equal(c.journey.finalCleared,true);assert.equal(c.dawnBoss.state,'dead');assert.equal(cc.snapshot().bosses.length,4);
 bb.elect('b');assert.equal(b.journey.finalCleared,true);assert.equal(b.world2.chapter,3);
});

test('sea drone warning and XP checkpoint reach friends once, including a late join',()=>{
 const {a,b,aa,bb,flush}=pair(),u=a.enemies[0].unit,v=b.enemies[0].unit;
 u.kind=v.kind='jellyfish';u.stunned=()=>false;u.ctrl.kind='jellyfish';u.ctrl.stats.xp=45;
 u.ctrl.seaCast={id:1,x:12,y:.2,z:18,until:a.time+.9};
 const rings=[];b.vfx.ring=(at,_color,_a,_b,left)=>rings.push({at:at.toArray(),left});
 aa.update(.1);flush();assert.equal(rings.length,1);assert.deepEqual(rings[0].at,[12,.2,18]);assert.equal(v.ctrl.stats.xp,45);
 aa.update(.1);flush();assert.equal(rings.length,1);
 const c=game(),cc=new BattleSync(c,()=>{},()=>new Map());c.enemies[0].unit.kind='jellyfish';let late=0;c.vfx.ring=()=>late++;cc.join('c','a',aa.snapshot());assert.equal(late,1);
 const invalid=aa.snapshot();invalid.entities[0].seaCast={id:2,x:Infinity,y:.2,z:18,left:.9};bb.apply(invalid);assert.equal(rings.length,1);
 a.time+=1;aa.update(.1);flush();assert.equal(rings.length,1);
});

test('guest village start uses the authenticated ID, synchronizes state and cancels on disconnect',()=>{
 const {a,b,aa,bb,flush}=pair();let requester='';
 a.villageGames={state:null,request(id,mode){requester=id;this.state={id:'round-1',mode,phase:'ready',left:15,starter:id,seeker:id,members:['a','b'],caught:[],result:''}},reset(){this.state=null},get playing(){return !!this.state}};
 b.villageGames={state:null,apply(s){this.state=s},reset(){this.state=null}};
 bb.village('hide');flush();assert.equal(requester,'b');assert.equal(a.villageGames.state.seeker,'b');assert.deepEqual(b.villageGames.state,a.villageGames.state);
 // Starting a room game cannot be used as a way to route PvP damage.
 aa.mode='pvp';aa.setParty(0);bb.setParty(0);flush();const hp=b.player.unit.hp;b.villageGames.playing=true;bb.receive('a',{kind:'hit',target:'b',amount:50});assert.equal(b.player.unit.hp,hp);
 // Local combat protection lives in Combat, independently of host/guest packet routing.
 b.villageGames.playing=true;assert.equal(b.combat.damage(a.player.unit,b.player.unit,50),0);assert.equal(b.player.unit.hp,hp);
 bb.leave();assert.equal(b.villageGames.state,null);
});

test('Solarkan gate rejects low-level damage and remote commands even with a level 100 friend',()=>{
 const {a,b,aa,bb,ar,flush}=pair();
 a.dawnBoss.profile=b.dawnBoss.profile={level:100};a.dawnBoss.unit.invulnerable=b.dawnBoss.unit.invulnerable=false;
 a.player.unit.level=b.player.unit.level=ar.level=99;
 assert.equal(a.combat.damage(a.player.unit,a.dawnBoss.unit,10),0);
 b.combat.damage(b.player.unit,b.dawnBoss.unit,10);flush();assert.equal(a.dawnBoss.unit.hp,100);
 aa.receive('b',{kind:'attack',target:'b30',amount:40});assert.equal(a.dawnBoss.unit.hp,100);
 aa.receive('b',{kind:'condition',target:'b30',condition:{stun:2,slow:4,slowPct:.5,pushX:0,pushZ:0,pushTime:0}});assert.equal(a.dawnBoss.unit.stunUntil,0);
 aa.receive('b',{kind:'challenge',target:'b30'});assert.equal(a.dawnBoss.state,'dormant');
 a.player.unit.level=100;a.combat.damage(a.player.unit,a.dawnBoss.unit,10);assert.equal(a.dawnBoss.unit.hp,90);
 ar.level=100;aa.receive('b',{kind:'attack',target:'b30',amount:10});assert.equal(a.dawnBoss.unit.hp,80);
});
