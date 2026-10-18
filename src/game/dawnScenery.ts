import * as THREE from 'three';
import type {Collision} from '../world/collision';

const LIGHT={x:67,z:72};
const TOWER_Z=[-48,-103];
const backWallX=(i:number)=>-35+i*5;

/** The lighthouse, citadel towers, gatehouses and walls are solid; the avenue and arena stay open. */
export function registerDawnScenery(height:(x:number,z:number)=>number,collision:Collision){
  const ly=height(LIGHT.x,LIGHT.z);collision.addCircle(LIGHT.x,LIGHT.z,3.2,ly,ly+17);
  for(const side of [-1,1]){
   for(const z of TOWER_Z){const x=side*35,y=height(x,z);collision.addCircle(x,z,5.4,y,y+20);}
   const y=height(side*13,-44);collision.addCircle(side*13,-44,2,y,y+8);
   // Collision matches the long wall footprint. Center avenue and arena stay open.
   for(let z=-56;z>=-96;z-=4)collision.addCircle(side*35,z,2,height(side*35,z),height(side*35,z)+10);
  }
  for(let i=0;i<15;i++){const x=backWallX(i);collision.addCircle(x,-105,2.8,height(x,-105),height(x,-105)+12);}
}

/** Deterministic landmarks, pooled static props and a small animated skyline. */
export class DawnScenery {
 readonly root=new THREE.Group();private flags:THREE.Object3D[]=[];private birds:THREE.Group[]=[];
 private beacon=new THREE.Group();private foam:THREE.MeshBasicMaterial;
 constructor(height:(x:number,z:number)=>number){
  this.root.name='dawnreach-landmarks';
  const mat=(color:string,glow=0)=>new THREE.MeshStandardMaterial({color,roughness:.83,emissive:color,emissiveIntensity:glow});
  const stone=mat('#666b76'),trim=mat('#baad88'),wood=mat('#855e43'),teal=mat('#397f82'),ivory=mat('#e7d6ae'),gold=mat('#f5c46c',.35),leaf=mat('#547654'),pink=mat('#e9a299'),dark=mat('#323946');
  const box=new THREE.BoxGeometry(1,1,1),cyl=new THREE.CylinderGeometry(1,1,1,10),cone=new THREE.ConeGeometry(1,1,8),ball=new THREE.SphereGeometry(1,8,6);
  // Static dressing is instanced by material and geometry, including wall blocks and flower beds.
  const pools=new Map<string,{geo:THREE.BufferGeometry;mat:THREE.Material;transforms:THREE.Matrix4[]}>();
  const place=(geo:THREE.BufferGeometry,m:THREE.Material,x:number,y:number,z:number,sx:number,sy:number,sz:number,ry=0)=>{const key=geo.uuid+m.uuid;let pool=pools.get(key);if(!pool){pool={geo,mat:m,transforms:[]};pools.set(key,pool);}const matrix=new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),ry),new THREE.Vector3(sx,sy,sz));pool.transforms.push(matrix);};
  const ground=(geo:THREE.BufferGeometry,m:THREE.Material,x:number,z:number,sx:number,sy:number,sz:number,dy=0,ry=0)=>place(geo,m,x,height(x,z)+sy/2+dy,z,sx,sy,sz,ry);
  const flag=(x:number,z:number,color:string)=>{const y=height(x,z);place(cyl,wood,x,y+3,z,.09,6,.09);const cloth=new THREE.Mesh(new THREE.PlaneGeometry(1.4,2.4,4,1),new THREE.MeshStandardMaterial({color,side:THREE.DoubleSide,roughness:1}));cloth.position.set(x+.75,y+4.5,z);this.root.add(cloth);this.flags.push(cloth);place(ball,gold,x,y+6.1,z,.18,.18,.18);};
  // Harbor frontage: low deck follows the playable ground; the moored ship is scenery offshore.
  for(let i=0;i<18;i++)ground(box,wood,-10,91+i*1.5,5,.12,1.38,.02);
  for(const side of [-1,1])for(let i=0;i<7;i++)ground(cyl,wood,-10+side*2.8,92+i*4.1,.2,1.5,.2);
  const ship=new THREE.Group();ship.name='dawn-harbor-ship';ship.position.set(17,.7,142);ship.rotation.y=-.25;this.root.add(ship);
  const hull=new THREE.Mesh(ball,wood);hull.scale.set(3,1.7,8);ship.add(hull);
  for(const x of [-2.1,2.1]){const rail=new THREE.Mesh(box,wood);rail.position.set(x,1,0);rail.scale.set(.22,.7,12);ship.add(rail);}
  const mast=new THREE.Mesh(cyl,wood);mast.position.y=5.5;mast.scale.set(.16,12,.16);ship.add(mast);
  const sail=new THREE.Mesh(new THREE.PlaneGeometry(5,6),new THREE.MeshStandardMaterial({color:'#dfcfaa',side:THREE.DoubleSide}));sail.position.set(2,7,0);ship.add(sail);
  for(const x of [-24,12])flag(x,104,'#398b91');
  for(const [x,z] of [[-19,84],[-21,86],[8,99],[11,101]]){ground(cyl,wood,x,z,.55,1.2,.55);ground(cyl,dark,x,z,.57,.1,.57,.25);}
  // A pearl-colored lighthouse and lookout garden on the eastern headland.
  const lx=LIGHT.x,lz=LIGHT.z,ly=height(lx,lz);
  place(cyl,stone,lx,ly+.3,lz,4,.6,4);place(cyl,ivory,lx,ly+6,lz,2.4,12,2.4);place(cyl,teal,lx,ly+7,lz,2.46,1,2.46);place(cyl,stone,lx,ly+12,lz,3,.4,3);place(cyl,gold,lx,ly+13.2,lz,1.3,2,1.3);place(cone,teal,lx,ly+15,lz,3.2,2,3.2);
  this.beacon.position.set(lx,ly+13.3,lz);const beamMat=new THREE.MeshBasicMaterial({color:'#ffdc96',transparent:true,opacity:.14,depthWrite:false,side:THREE.DoubleSide});const beam=new THREE.Mesh(new THREE.ConeGeometry(7,32,20,1,true),beamMat);beam.rotation.z=-Math.PI/2;beam.position.x=16;this.beacon.add(beam);this.root.add(this.beacon);
  for(let i=0;i<13;i++){const a=i/12*Math.PI*1.5;ground(box,ivory,lx+Math.cos(a)*6,lz+Math.sin(a)*6,.45,1.1,.45);}
  // Terraced seaside orchard and rose beds, kept clear of the existing town doors.
  for(const side of [-1,1])for(const z of [16,0,-18]){const x=side*17,y=height(x,z);place(box,stone,x,y+.2,z,9,.4,4);for(let i=0;i<7;i++){const px=x-3+i,py=height(px,z);place(ball,leaf,px,py+.55,z,.65,.5,1.4);place(ball,i%2?pink:gold,px,py+1,z+.2,.19,.19,.19);}}
  for(const [x,z] of [[-57,68],[-72,40],[59,62]]){ground(box,wood,x,z,3,.3,.75,.6);for(const side of [-1,1])ground(box,stone,x+side,z,.3,.6,.7);}
  // A fortress silhouette around, rather than inside, the boss's 20 m arena.
  for(const side of [-1,1]){for(let i=0;i<12;i++){const z=-47-i*5;ground(box,stone,side*35,z,2.6,9,5.1);ground(box,trim,side*35,z,3,1.3,2.2,9);}
   for(const z of TOWER_Z){const x=side*35,y=height(x,z);place(cyl,stone,x,y+7,z,5,14,5);place(cyl,trim,x,y+14,z,5.4,.6,5.4);place(cone,teal,x,y+17,z,6,6,6);}
   const y=height(side*13,-44);place(box,stone,side*13,y+4,-44,3,8,4);flag(side*17,-44,'#b46b4b');
  }
  for(let i=0;i<15;i++){const x=backWallX(i);ground(box,stone,x,-105,5.1,10,2.6);ground(box,trim,x,-105,2.3,1.2,3,10);}
  const gateY=height(0,-44);place(box,trim,0,gateY+9,-44,29,1.4,4.2);place(cone,gold,0,gateY+11,-44,1.5,2,1.5);
  // Clouds, gulls and foam add motion without adding real-time lights or shadow maps.
  const cloudMat=new THREE.MeshBasicMaterial({color:'#f0d6bb',transparent:true,opacity:.45,depthWrite:false});for(let i=0;i<12;i++){const c=new THREE.Mesh(ball,cloudMat);c.position.set(-170+i*31,75+i%3*9,-150-i%4*16);c.scale.set(17+i%4*4,3,7);this.root.add(c);}
  const sun=new THREE.Mesh(new THREE.SphereGeometry(15,20,12),new THREE.MeshBasicMaterial({color:'#ffe1a1'}));sun.position.set(-160,83,-360);this.root.add(sun);
  for(let i=0;i<6;i++){const bird=new THREE.Group();for(const side of [-1,1]){const wing=new THREE.Mesh(new THREE.ConeGeometry(.32,2,3),ivory);wing.rotation.z=side*1.25;wing.position.x=side*.7;bird.add(wing);}bird.name='dawn-gull';this.root.add(bird);this.birds.push(bird);}
  this.foam=new THREE.MeshBasicMaterial({color:'#e5e9d0',transparent:true,opacity:.32,depthWrite:false,side:THREE.DoubleSide});
  for(const r of [.889,.914]){const positions=[];for(let i=0;i<128;i++){for(const [a,d] of [[i,r],[(i+1),r],[(i+1),r+.004],[i,r],[(i+1),r+.004],[i,r+.004]]){const angle=a/128*Math.PI*2;positions.push(Math.sin(angle)*122*d,.29,3+Math.cos(angle)*149*d);}}const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));this.root.add(new THREE.Mesh(geo,this.foam));}
  for(const pool of pools.values()){const m=new THREE.InstancedMesh(pool.geo,pool.mat,pool.transforms.length);pool.transforms.forEach((matrix,i)=>m.setMatrixAt(i,matrix));m.castShadow=m.receiveShadow=true;m.computeBoundingSphere();this.root.add(m);}
 }
 update(time:number){this.beacon.rotation.y=time*.18;this.foam.opacity=.27+Math.sin(time*.65)*.07;this.flags.forEach((f,i)=>{f.rotation.y=Math.sin(time*1.4+i)*.18;f.rotation.z=Math.sin(time*1.8+i)*.035;});this.birds.forEach((b,i)=>{const a=time*.07+i*1.1;b.position.set(Math.cos(a)*(45+i*5),25+Math.sin(time*.8+i)*1.5,65+Math.sin(a)*35);b.rotation.y=-a;b.rotation.z=Math.sin(time*2+i)*.1;});}
}
