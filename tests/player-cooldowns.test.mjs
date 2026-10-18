import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Player} from '../tmp/test-modules/player.js';
import {CLASSES} from '../src/data/classes.ts';

// Real Player/useAbility/commit/executeAbility; only rendering, world and animation are stubbed.
function setup(cls,ab){
 const unit={pos:new THREE.Vector3(),radius:1,height:2,yaw:0,level:1,alive:true,lastCombat:100,stunUntil:0,slowUntil:0,rustUntil:0,absorb:0,
  stunned(){return false;},distTo(t){return this.pos.distanceTo(t.pos);},gapTo(t){return this.distTo(t)-this.radius-t.radius;},
  act(_name,opts){opts?.onHit?.();},socketPos(_name,out){return out.copy(this.pos);},centre(out){return out.copy(this.pos);},
  teleport(_world,x,z){this.pos.set(x,0,z);},express(){},motion:{stop(){}},rig:{face:{setTint(){}}}};
 const target={...unit,pos:new THREE.Vector3(0,0,ab.id==='sideways-charge'?5:2),hostile:true,kind:'enemy',cancelPendingHit(){}};
 const effects=[],errors=[];
 const game={time:100,controlsLocked:false,world:{raycastSolid(){return null;},heightAt(){return 0;},resolveCollision(x,z,_radius,out){return out.set(x,z);}},
  units:[target],input:{isDown(){return false;}},
  combat:{damage(_a,_b,n){effects.push('damage');return n;},heal(){effects.push('heal');}},
  events:{emit(e){if(e.type==='error')errors.push(e.reason);}},projectiles:{spawn(_src,_from,_to,_style,_speed,hit){hit();}}};
 const player=new Player(game,unit,cls);game.player=player;player.target=target;player.resource=player.maxResource=10000;player.nextSwing=Infinity;
 return {game,player,effects,errors};
}
function release(s,ab){if(s.player.cast){s.game.time=s.player.cast.end;s.player.updateCombat();}assert.equal(s.player.cast,null);assert.ok(s.player.cooldownLeft(ab)>0);}

for(const cls of Object.values(CLASSES))for(const ab of cls.abilities){
 test(`${cls.id}/${ab.id}: repeated input and queued input cannot bypass personal recovery`,()=>{
  const s=setup(cls,ab),{game,player}=s;
  assert.ok(Number.isFinite(ab.cooldown)&&ab.cooldown>=3,'every active skill needs real recovery');
  player.useAbility(ab.slot);release(s,ab);
  const first={...player.cooldowns.get(ab.id)},resource=player.resource,effects=s.effects.length;
  assert.equal(first.end-first.start,ab.cooldown);
  // Keep ample resources: rejection must come from the cooldown, not exhaustion or GCD.
  for(game.time=first.start+1.1;game.time<first.end-.4;game.time+=.05){player.useAbility(ab.slot);player.updateCombat();}
  assert.equal(player.resource,resource);assert.equal(s.effects.length,effects);assert.deepEqual(player.cooldowns.get(ab.id),first);
  game.time=first.end-.2;player.useAbility(ab.slot);player.updateCombat();assert.equal(player.cast,null);assert.equal(player.resource,resource);
  game.time=first.end;player.updateCombat();release(s,ab);
  assert.ok(player.cooldowns.get(ab.id).start>=first.end,'queued cast releases only after recovery');
  assert.equal(player.resource,Math.min(player.maxResource,resource-ab.cost+(ab.generates??0)));
 });
}

test('level restoration and respawn refill resources without clearing recovery',()=>{
 const ab=CLASSES.priest.abilities[1],s=setup(CLASSES.priest,ab);s.player.useAbility(2);release(s,ab);
 const cd={...s.player.cooldowns.get(ab.id)};
 s.player.restoreXp(Number.MAX_SAFE_INTEGER);assert.deepEqual(s.player.cooldowns.get(ab.id),cd);
 s.player.target=null;s.player.respawn();assert.deepEqual(s.player.cooldowns.get(ab.id),cd);
 s.game.time=cd.start+2;s.player.useAbility(2);assert.equal(s.player.cast,null);assert.deepEqual(s.player.cooldowns.get(ab.id),cd);
});

test('cancelling a heal releases no effect, does not spend mana, and retains the GCD',()=>{
 const ab=CLASSES.priest.abilities[1],s=setup(CLASSES.priest,ab),resource=s.player.resource;
 s.player.useAbility(2);assert.ok(s.player.cast);s.game.time+=.1;s.player.interruptCast();
 assert.equal(s.effects.length,0);assert.equal(s.player.resource,resource);assert.equal(s.player.cooldownLeft(ab),0);
 s.player.useAbility(2);assert.equal(s.player.cast,null);
 s.game.time=s.player.gcdEnd;s.player.useAbility(2);release(s,ab);assert.equal(s.effects.length,1);
});

test('expiry does not bypass insufficient mana or allow two different instant skills in one GCD',()=>{
 const ab=CLASSES.mage.abilities[1],s=setup(CLASSES.mage,ab);
 s.player.useAbility(2);const paid=s.player.resource;s.player.useAbility(4);
 assert.equal(s.player.resource,paid);assert.equal(s.player.cooldowns.has('tidal-nova'),false);
 s.game.time=s.player.cooldowns.get(ab.id).end;s.player.resource=ab.cost-1;s.player.useAbility(2);
 assert.equal(s.player.cooldownLeft(ab),0);assert.equal(s.player.resource,ab.cost-1);
});
