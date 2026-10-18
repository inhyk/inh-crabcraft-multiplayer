import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Boss } from '../tmp/test-modules/boss.js';
import { bossWarning } from '../tmp/test-modules/bossLocale.js';
import {conformTelegraph} from '../src/game/vfx/telegraphGround.ts';
import {worldOf} from '../server/combatProtocol.ts';
import { LEVEL_XP, xpForLevel, levelForXp, BOSS_PROFILES, canChallenge, canEnterWorld2, patrolReward } from '../src/game/progression.ts';

function setup(profile=BOSS_PROFILES.rust, level=profile.level) {
 const damage=[], warnings=[], actions=[], telegraphs=[], impacts=[];
 // The boss's warnings and impacts arrive as sim events; the warning text is the HUD's.
 const events={emit(e){if(e.type==='telegraph'){telegraphs.push(e);warnings.push(bossWarning(e.mech,e.level));}if(e.type==='impact')impacts.push(e);}};
 function unit(){return {pos:new THREE.Vector3(),rig:{root:new THREE.Group(),face:{setTint(){}}},level:1,hp:1,maxHp:1,alive:true,hidden:false,height:3,radius:1,yaw:0,lift:0,stunUntil:0,slowUntil:0,motion:{stop(){}},setBaseTint(){},express(){},act(a){actions.push(a)},cancelPendingHit(){},setYaw(y){this.yaw=y},teleport(w,x,z,yaw=0){this.pos.set(x,0,z);this.yaw=yaw},moveTo(w,x,z){this.pos.set(x,0,z)},feedLocomotion(){},stunned(){return false},speedMul(){return 1},distTo(other){return this.pos.distanceTo(other.pos)},gapTo(other){return this.distTo(other)-this.radius-other.radius}};}
 const player=unit();player.level=level;player.hp=player.maxHp=300;player.pos.set(100,0,100);
 const game={time:0,world:{heightAt(){return 0}},player:{unit:player,level},controlsLocked:false,say(){},audio:{sfx(){}},hud:{bossFrame:{show(){},hide(){}},messages:{warn(x){warnings.push(x)},banner(){}},floats:{spawn(){}}},follow:{shake(){}},vfx:new Proxy({fx:{release(){}}},{get(target,key){return key in target?target[key]:()=>({})}}),combat:{damage(a,b,n){damage.push(n);b.hp-=n},kill(u){u.alive=false}},spawnAdd(){return null},seaDirection(){return new THREE.Vector3(1,0,0)},
  events,combatPlayers(){return [player]},combatTarget(){return player},_party:undefined,get partyLevel(){return this._party??player.level},set partyLevel(v){this._party=v}};
 const boss=new Boss(game,unit(),{position:new THREE.Vector3(),radius:15,yaw:0},unit(),profile);
 return {game,boss,player,damage,warnings,actions,telegraphs,impacts};
}

test('levels 3 and 10 are reachable with ordered thresholds and genuine progression gates',()=>{
 assert.equal(levelForXp(899),2);assert.equal(levelForXp(900),3);assert.equal(levelForXp(6499),9);assert.equal(levelForXp(6500),10);
 assert.equal(canChallenge(2,3,false),false);assert.equal(canChallenge(3,3,false),true);
 assert.equal(canChallenge(9,10,true),false);assert.equal(canChallenge(10,10,false),false);assert.equal(canChallenge(10,10,true),true);
 // A first victory plus ordinary kills and five-kill patrols reaches the final boss without debug XP.
 let xp=1400,kills=0;
 while(xp<LEVEL_XP[9]&&kills<200){const level=levelForXp(xp);xp+=50+12*(level-2);if(++kills%5===0)xp+=patrolReward(level);}
 assert.ok(kills<60,`Progression too slow: ${kills} kills`);
});

test('boss cannot start below its required level, then unlocks on level-up',()=>{
 const {game,boss,player}=setup(BOSS_PROFILES.rust,2);
 boss.wake();boss.update(2.5);player.pos.set(0,0,8);boss.update(.1);
 assert.equal(boss.state,'idle');assert.equal(boss.unit.invulnerable,true);assert.equal(boss.unit.targetable,false);
 game.player.level=player.level=3;boss.update(.1);
 assert.equal(boss.state,'fight');assert.equal(boss.unit.invulnerable,false);
});

test('both boss encounters transition phases and reset cleanly after player death',()=>{
 for(const profile of Object.values(BOSS_PROFILES)){
  const {boss,player}=setup(profile);boss.wake();boss.update(2.5);player.pos.set(0,0,8);boss.update(.1);
  boss.unit.hp=profile.hp*.55;boss.update(.1);assert.equal(boss.phase,2);
  boss.unit.hp=profile.hp*.2;boss.update(.1);assert.equal(boss.phase,3);assert.equal(boss.enraged,true);
  player.alive=false;boss.update(.1);assert.equal(boss.state,'idle');assert.equal(boss.phase,1);assert.equal(boss.enraged,false);assert.equal(boss.unit.hp,profile.hp);assert.equal(boss.telegraphActive,false);
 }
});

test('level 10 nova is telegraphed and avoidable, but hits a player who stays inside',()=>{
 for(const dodge of [true,false]){
  const {game,boss,player,damage,warnings}=setup(BOSS_PROFILES.abyss);
  boss.wake();boss.update(2.5);player.pos.set(0,0,8);boss.update(.1);
  game.time=10;boss.update(.1);boss.update(2); // first slam
  game.time=20;boss.update(.1);assert.equal(boss.mechName,'nova');assert.ok(warnings.some(x=>x.includes('푸른 원')));
  const before=damage.length;if(dodge)player.pos.set(12,0,8);boss.update(2.5);
  assert.equal(damage.length-before,dodge?0:1);
 }
});

test('boss area attacks damage every party member inside the shared telegraph and spare those outside',()=>{
 const {game,boss,player,damage}=setup(BOSS_PROFILES.abyss);
 const friend={...player,pos:new THREE.Vector3(1,0,8),kind:'remote'},dodger={...player,pos:new THREE.Vector3(20,0,8),kind:'remote'};
 game.combatPlayers=()=>[player,friend,dodger];game.combatTarget=()=>player;
 boss.wake();boss.update(2.5);player.pos.set(0,0,8);boss.update(.1);
 game.time=10;boss.update(.1);boss.update(2);
 game.time=20;boss.update(.1);assert.equal(boss.mechName,'nova');
 const before=damage.length;boss.update(2.5);assert.equal(damage.length-before,2);assert.equal(dodger.hp,300);
});

test('direct chapter travel preserves story checkpoints and unlimited levels',()=>{
 assert.equal(LEVEL_XP.length,20);assert.equal(levelForXp(21999),19);assert.equal(levelForXp(22000),20);
 assert.equal(canEnterWorld2(false,true),false);assert.equal(canEnterWorld2(true,false),true);assert.equal(canEnterWorld2(true,true),true);
 assert.equal(canChallenge(20,20,true,false,2),false);assert.equal(canChallenge(20,20,true,true,1),false);
 assert.equal(canChallenge(99,100,true,true,3),false);assert.equal(canChallenge(100,100,true,true,2),false);assert.equal(canChallenge(100,100,true,true,3),true);assert.equal(canChallenge(100,100,true,false,3),false);
 assert.equal(canChallenge(19,20,true,true,2),false);assert.equal(canChallenge(20,20,true,true,2),true);
 let xp=6500,kills=0;while(xp<22000 && kills<200){const level=levelForXp(xp);xp+=140+12*(level-2);if(++kills%5===0)xp+=patrolReward(level);}
 assert.ok(kills<80,`World II needs too many kills: ${kills}`);
});
test('the eclipse attack protects the inner sanctuary and hits the surrounding danger ring for every player',()=>{
 const {game,boss,player,damage,warnings}=setup(BOSS_PROFILES.eclipse);
 boss.wake();boss.update(2.5);player.pos.set(0,0,8);boss.update(.1);
 game.time=10;boss.update(.1);boss.update(2);
 game.time=20;boss.update(.1);assert.equal(boss.mechName,'eclipse');
 const at=boss.networkState('b20').mech.at;
 player.pos.set(at[0]+4,0,at[2]);
 const friend={...player,pos:new THREE.Vector3(at[0]+8,0,at[2]),kind:'remote'};
 const far={...player,pos:new THREE.Vector3(at[0]+15,0,at[2]),kind:'remote'};
 game.combatPlayers=()=>[player,friend,far];
 const before=damage.length;boss.update(3);assert.equal(damage.length-before,1);
 assert.equal(friend.hp,player.hp-114);assert.equal(far.hp,player.hp);
 assert.ok(warnings.some(x=>x.includes('초록 원')));
});


test('unlimited thresholds remain ordered and invert exactly above 20',()=>{
 for(const level of [21,22,50,100,1000,100000]) {
   const xp=xpForLevel(level);assert.equal(levelForXp(xp),level);assert.equal(levelForXp(xp-1),level-1);
   assert.ok(xpForLevel(level+1)>xp);
 }
 assert.equal(xpForLevel(21),24200);assert.equal(xpForLevel(22),26600);
});
test('turning the lighthouse off prevents waking and suspends an existing encounter',()=>{
 const {game,boss}=setup();game.world.getEnvironment=()=>({mood:3,beacon:false});boss.wake();assert.equal(boss.state,'dormant');
 game.world.getEnvironment=()=>({mood:1,beacon:true});boss.wake();boss.update(2.5);assert.equal(boss.state,'idle');
 boss.sleep();assert.equal(boss.state,'dormant');assert.equal(boss.unit.hidden,true);assert.equal(boss.unit.invulnerable,true);assert.equal(boss.unit.targetable,false);
});

test('World II boss combat leaves the World I lighthouse and morning unchanged',()=>{
 const {game,boss,player}=setup(BOSS_PROFILES.eclipse);
 let mood=3;game.world.getEnvironment=()=>({mood,beacon:false});game.world.setMood=value=>{mood=value};
 boss.wake();boss.update(2.5);player.pos.set(0,0,8);boss.update(.1);
 assert.equal(boss.state,'fight');assert.equal(mood,3);assert.equal(game.world.getEnvironment().beacon,false);
});

test('host and network follower use matching attack colours and impact effects for every mechanic',()=>{
 for(const [profile,phase,index] of [[BOSS_PROFILES.rust,1,0],[BOSS_PROFILES.rust,1,1],[BOSS_PROFILES.rust,2,0],[BOSS_PROFILES.abyss,2,0],[BOSS_PROFILES.eclipse,2,0],[BOSS_PROFILES.eclipse,2,1],[BOSS_PROFILES.eclipse,2,3],[BOSS_PROFILES.eclipse,2,4]]){
  const host=setup(profile),guest=setup(profile);
  host.boss.state='fight';host.boss.phase=phase;host.boss.mechIndex=index;host.boss.startMech();
  const checkpoint=host.boss.networkState(profile.level===20?'b20':profile.level===10?'b10':'b3');guest.boss.applyNetwork(checkpoint);
  assert.deepEqual(guest.telegraphs.map(e=>e.shapes),host.telegraphs.map(e=>e.shapes),checkpoint.mech.kind+' warning marks and colours');
  host.boss.updateMech(host.boss.mech.dur);guest.boss.applyNetwork({...checkpoint,mech:null});
  assert.ok(host.impacts.length>0,checkpoint.mech.kind+' resolves with effects');
  assert.deepEqual(guest.impacts.map(e=>e.shapes),host.impacts.map(e=>e.shapes),checkpoint.mech.kind+' resolved effects');
 }
});


test('a new host continues each latest attack checkpoint without recreating warnings or delaying damage',()=>{
 for(const [profile,phase,index] of [[BOSS_PROFILES.rust,1,0],[BOSS_PROFILES.rust,1,1],[BOSS_PROFILES.rust,2,0],[BOSS_PROFILES.abyss,2,0],[BOSS_PROFILES.eclipse,2,0],[BOSS_PROFILES.eclipse,2,3],[BOSS_PROFILES.eclipse,2,4]]){
 const host=setup(profile),guest=setup(profile);guest.game.enemies=[];
 host.boss.state='fight';host.boss.phase=phase;host.boss.mechIndex=index;host.boss.startMech();
 const id=profile.level===20?'b20':profile.level===10?'b10':'b3';
 guest.boss.applyNetwork(host.boss.networkState(id));
 const pose=guest.boss.mech,marks=guest.telegraphs.length,warnings=guest.warnings.length;
 host.boss.updateMech(host.boss.mech.dur*.75);
 const checkpoint=host.boss.networkState(id);guest.boss.applyNetwork(checkpoint);
 assert.equal(guest.boss.mech,pose);assert.equal(guest.telegraphs.length,marks);assert.equal(guest.warnings.length,warnings);
 assert.ok(Math.abs(guest.boss.mech.dur-guest.boss.mech.t-checkpoint.mech.left)<1e-9);
 guest.player.pos.copy(pose.at);
 if(pose.kind==='eclipse')guest.player.pos.x+=8;
 if(pose.kind==='spray'){guest.player.pos.x+=Math.sin(pose.yaw)*3;guest.player.pos.z+=Math.cos(pose.yaw)*3;}
 guest.boss.resumeAuthority();
 guest.boss.updateMech(checkpoint.mech.left-.01);assert.equal(guest.damage.length,0,pose.kind);
 guest.boss.updateMech(.02);assert.equal(guest.damage.length,1,pose.kind);assert.equal(guest.boss.mech,null);
 }
});


test('host election preserves boss reveal and already released crab death timelines',()=>{
 const host=setup(BOSS_PROFILES.eclipse),guest=setup(BOSS_PROFILES.eclipse);
 host.boss.wake();host.boss.update(1.7);
 guest.boss.applyNetwork(host.boss.networkState('b20'));guest.boss.resumeAuthority();guest.boss.update(.1);
 assert.ok(Math.abs(guest.boss.stateT-1.8)<1e-9);assert.ok(guest.boss.unit.lift>-.3);
 host.boss.state='dying';host.boss.stateT=7.5;host.boss.freedT=5.3;host.boss.freedStarted=true;host.boss.freedYaw=1.2;
 guest.boss.applyNetwork(host.boss.networkState('b20'));guest.boss.resumeAuthority();
 assert.equal(guest.boss.stateT,7.5);assert.equal(guest.boss.freedT,5.3);assert.equal(guest.boss.freedStarted,true);assert.equal(guest.boss.freed.npcId,'bowed');
 guest.boss.updateDeath(0);assert.equal(guest.boss.stateT,7.5);assert.equal(guest.boss.freedT,5.3);
 const early={...host.boss.networkState('b20'),timeline:{state:2.8,freed:.6,freedYaw:1.2,released:true}};
 guest.boss.applyNetwork(early);assert.ok(Math.abs(guest.boss.freed.rig.root.scale.x-.65)<1e-9);
});

test('World II nova leaves a stationary walker time to react and clear its damage radius in every phase',()=>{
 for(const phase of [1,2,3]){
  const {boss,player}=setup(BOSS_PROFILES.eclipse);boss.phase=phase;boss.enraged=phase===3;boss.mechIndex=phase===1?2:1;boss.startMech();
  const m=boss.networkState('b20').mech;assert.equal(m.kind,'nova');
  // 300ms reaction + ordinary 5m/s travel + acceleration allowance; no dash or invulnerability.
  const needed=.3+(6+player.radius*.5)/5+.1;
  assert.ok(m.left>=needed,`phase ${phase}: ${m.left}s warning is below ${needed}s walking budget`);
 }
});


function newPattern(kind,profile=BOSS_PROFILES.eclipse){
 const s=setup(profile);s.boss.phase=3;s.boss.enraged=true;s.boss.state='fight';s.player.pos.set(0,0,8);
 for(let index=0;index<8;index++){s.boss.mechIndex=index;s.boss.startMech();if(s.boss.mechName===kind)return s;s.boss.clearMech();}
 throw Error('Pattern absent from rotation: '+kind);
}

test('new attacks have generous fixed warnings in every boss rotation, even during enrage',()=>{
 for(const profile of Object.values(BOSS_PROFILES))for(const kind of ['cross','barrage']){
  const {boss,warnings}=newPattern(kind,profile);assert.ok(boss.mech.dur>=2.6);assert.ok(warnings.at(-1).length>10);
 }
});

test('cross lanes hit once at their intersection and spare the four diagonal safe areas',()=>{
 const {game,boss,player,damage}=newPattern('cross');
 const copy=(x,z)=>({...player,pos:new THREE.Vector3(x,0,z)});
 const players=[copy(0,0),copy(0,8),copy(8,0),copy(4,4),copy(-4,4),copy(-4,-4),copy(4,-4),copy(0,14)];
 game.combatPlayers=()=>players;boss.updateMech(boss.mech.dur-.01);assert.equal(damage.length,0);
 boss.updateMech(.02);assert.equal(damage.length,3);assert.deepEqual(players.map(p=>p.hp),[216,216,216,300,300,300,300,300]);
});

test('barrage damages each marked location once and spares players outside the circles',()=>{
 const {game,boss,player,damage}=newPattern('barrage');const points=boss.barragePoints(boss.mech.at,boss.mech.yaw);
 const players=points.map(pos=>({...player,pos:pos.clone()}));players.push({...player,pos:points[1].clone().add(new THREE.Vector3(0,0,6))});
 game.combatPlayers=()=>players;boss.updateMech(boss.mech.dur);assert.equal(damage.length,3);assert.deepEqual(players.map(p=>p.hp),[228,228,228,300]);
});

test('terrain warnings retain their 0.28m clearance when pooled geometry is rotated and reused',()=>{
 const geometry=new THREE.PlaneGeometry(2,2,32,32).rotateX(Math.PI/2),at=new THREE.Vector3(4,7,-12);
 const height=(x,z)=>Math.sin(x*.8)*2+Math.cos(z*.6)*1.5+x*.1;
 for(const [yaw,width,length] of [[0,6,6],[1.2,1.8,12],[-2,11,11]]){
  conformTelegraph(geometry,at,yaw,width,length,height);const positions=geometry.getAttribute('position');
  for(let i=0;i<positions.count;i++){
   const x=positions.getX(i)*width,z=positions.getZ(i)*length;
   const expected=height(at.x+x*Math.cos(yaw)+z*Math.sin(yaw),at.z-x*Math.sin(yaw)+z*Math.cos(yaw))+.28;
   assert.ok(Math.abs(at.y+positions.getY(i)-expected)<1e-6);
  }
 }
 geometry.dispose();
});

test('room snapshots accept the new patterns and still reject unknown pattern kinds',()=>{
 const boss=(id,kind)=>({id,state:'fight',phase:2,enraged:false,mech:{id:1,kind,at:[0,0,0],yaw:0,left:2.6}});
 const world={entities:[],bosses:[boss('b3','cross'),boss('b10','barrage'),boss('b20','cross')],rust:true,abyss:true,chapter:2,firstEnding:true,trueCleared:false,weather:{mood:3,beacon:true,clock:0}};
 assert.equal(worldOf(world),world);world.bosses[0].mech.kind='unknown';assert.equal(worldOf(world),null);
});

test('Solarkan is locked at 99 and unlocks at 100, without changing XP or earlier bosses',()=>{
 const {game,boss,player}=setup(BOSS_PROFILES.dawn,99);
 boss.wake();assert.equal(boss.state,'dormant');
 game.partyLevel=100;boss.wake();boss.update(2.5);player.pos.set(0,0,8);boss.update(.1);
 assert.equal(boss.state,'idle');assert.equal(boss.unit.invulnerable,true);
 game.player.level=player.level=100;boss.update(.1);assert.equal(boss.state,'fight');
 assert.equal(boss.unit.level,100);assert.equal(boss.unit.maxHp,180000);
 assert.deepEqual([BOSS_PROFILES.rust.level,BOSS_PROFILES.abyss.level,BOSS_PROFILES.eclipse.level],[3,10,20]);
 assert.equal(levelForXp(xpForLevel(100)),100);assert.equal(canChallenge(99,100,true,true,3),false);
});

test('Solarkan eight fire rays leave visible safe wedges and hit an overlap only once',()=>{
 const s=newPattern('cross',BOSS_PROFILES.dawn),{boss,game,player,damage,telegraphs}=s;
 boss.clearMech();boss.mechIndex=0;boss.startMech();
 const lanes=telegraphs.at(-1).shapes;assert.equal(lanes.length,4);assert.ok(lanes.every(l=>l.shape==='lane'));assert.equal(lanes[0].halfLength,15);
 const at=boss.mech.at,yaw=boss.mech.yaw;
 const pos=a=>new THREE.Vector3(at.x+Math.sin(a)*9,0,at.z+Math.cos(a)*9);
 const center={...player,pos:at.clone()},diagonal={...player,pos:pos(yaw+Math.PI/4)},safe={...player,pos:pos(yaw+Math.PI/8)};
 game.combatPlayers=()=>[center,diagonal,safe];boss.updateMech(boss.mech.dur-.01);assert.equal(damage.length,0);
 boss.updateMech(.02);assert.equal(damage.length,2);assert.equal(safe.hp,300);assert.equal(center.hp,156);
});

test('Solarkan five simultaneous bombs spare gaps and ineligible characters',()=>{
 const {boss,game,player,damage}=newPattern('barrage',BOSS_PROFILES.dawn);
 const points=boss.barragePoints(boss.mech.at,boss.mech.yaw);assert.equal(points.length,5);
 const players=points.map(pos=>({...player,pos:pos.clone()})),low={...player,level:99,pos:points[0].clone()};
 game.combatPlayers=()=>[...players,low];boss.updateMech(boss.mech.dur);
 assert.equal(damage.length,5);assert.ok(players.every(p=>p.hp===174));assert.equal(low.hp,300);
});

test('Solarkan has early pressure phases, faster recovery, and cannot be stun locked',()=>{
 const {boss,game,player}=setup(BOSS_PROFILES.dawn);boss.wake();boss.update(2.5);player.pos.set(0,0,8);boss.update(.1);
 boss.unit.hp=boss.unit.maxHp*.74;boss.update(.1);assert.equal(boss.phase,2);
 boss.unit.hp=boss.unit.maxHp*.39;boss.update(.1);assert.equal(boss.phase,3);
 game.time=100;boss.unit.stunned=()=>true;boss.update(.1);assert.equal(boss.mechName,'cross');
 assert.ok(Math.abs(boss.nextMech-game.time-boss.mech.dur-.9)<1e-8);
 for(const kind of ['nova','slam','eclipse','undertow']){
  const {boss,player}=newPattern(kind,BOSS_PROFILES.dawn);
  const escape=kind==='eclipse'?11:boss.radius(kind)+player.radius*.5;
  assert.ok(boss.mech.dur>=.3+escape/5+.1,`${kind} must allow a walking dodge`);
 }
});

test('all Solarkan patterns match the follower layout and continue after host migration',()=>{
 for(const phase of [1,2,3])for(let index=0;index<(phase===1?5:phase===2?6:8);index++){
  const host=setup(BOSS_PROFILES.dawn),guest=setup(BOSS_PROFILES.dawn);
  host.boss.phase=phase;host.boss.enraged=phase===3;host.boss.state='fight';host.boss.mechIndex=index;host.boss.startMech();
  const snapshot=host.boss.networkState('b30');guest.boss.applyNetwork(snapshot);
  assert.equal(host.telegraphs.length,1);assert.deepEqual(guest.telegraphs.map(e=>[e.mech,e.shapes]),host.telegraphs.map(e=>[e.mech,e.shapes]));
  guest.boss.applyNetwork({...snapshot,mech:{...snapshot.mech,left:.1}});guest.boss.resumeAuthority();
  guest.boss.updateMech(.09);assert.ok(guest.boss.mech);guest.boss.updateMech(.02);assert.equal(guest.boss.mech,null);
 }
});
