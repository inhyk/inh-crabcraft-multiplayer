import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import type {Collision} from '../world/collision';

const SITES=[{kind:'forge',x:-29,z:37,yaw:Math.PI/2},{kind:'tavern',x:-23,z:61,yaw:Math.PI/2},{kind:'chapel',x:23,z:38,yaw:-Math.PI/2}] as const;
/** The sign posts are thin solids beside the shop doors. */
export function registerStarSigns(height:(x:number,z:number)=>number,collision:Collision){
  for(const site of SITES){const y=height(site.x,site.z);collision.addCircle(site.x,site.z,.26,y,y+4.8);}
}
const merge=(parts:THREE.BufferGeometry[])=>{
  const triangles=parts.map(g=>g.index?g.toNonIndexed():g);
  for(const g of triangles)g.deleteAttribute('uv');
  const geometry=mergeGeometries(triangles)!;
  for(const g of new Set([...parts,...triangles]))g.dispose();
  geometry.computeBoundingSphere();return geometry;
};
const relief=(shape:THREE.Shape)=>new THREE.ExtrudeGeometry(shape,{depth:.065,bevelEnabled:true,bevelThickness:.012,bevelSize:.012,bevelSegments:1,steps:1,curveSegments:16});
const twoSided=(parts:THREE.BufferGeometry[])=>{
  const front=merge(parts);const back=front.clone().rotateY(Math.PI).translate(0,0,-.14);front.translate(0,0,.14);return merge([front,back]);
};

/** Three language-independent shop emblems, with shared frames and a gentle shared-clock sway. */
export class StarVillageSigns {
  readonly root=new THREE.Group();
  private boards:THREE.InstancedMesh;
  private frames:THREE.InstancedMesh;
  private emblems:THREE.Mesh[]=[];
  private anchors:THREE.Matrix4[]=[];
  private matrix=new THREE.Matrix4();
  private pivot=new THREE.Matrix4().makeTranslation(1.25,4.3,0);
  private drop=new THREE.Matrix4().makeTranslation(0,-1.05,0);
  private rotation=new THREE.Matrix4();
  constructor(height:(x:number,z:number)=>number){
    this.root.name='star-village-signs';
    const wood=new THREE.MeshStandardMaterial({color:'#392c2b',roughness:.82});
    const brass=new THREE.MeshStandardMaterial({color:'#bc9859',metalness:.68,roughness:.38});
    const support=merge([
      new THREE.BoxGeometry(.21,4.45,.21).translate(0,2.225,0),
      new THREE.BoxGeometry(2.4,.18,.2).translate(1.1,4.35,0),
      new THREE.BoxGeometry(.14,1.18,.14).rotateZ(-Math.PI/4).translate(.42,3.85,0),
      new THREE.ConeGeometry(.21,.28,4).rotateY(Math.PI/4).translate(0,4.65,0),
    ]);
    const fittings=merge([
      new THREE.CylinderGeometry(.25,.26,.2,8).translate(0,.1,0),
      ...[.45,3.95,4.45].map(y=>new THREE.BoxGeometry(.25,.12,.25).translate(0,y,0)),
      new THREE.OctahedronGeometry(.09).translate(2.3,4.35,0),
    ]);
    const shape=new THREE.Shape(),w=1.05,h=.775,r=.12;
    shape.moveTo(-w+r,-h);shape.lineTo(w-r,-h);shape.quadraticCurveTo(w,-h,w,-h+r);shape.lineTo(w,h-r);shape.quadraticCurveTo(w,h,w-r,h);shape.lineTo(-w+r,h);shape.quadraticCurveTo(-w,h,-w,h-r);shape.lineTo(-w,-h+r);shape.quadraticCurveTo(-w,-h,-w+r,-h);
    const board=new THREE.ExtrudeGeometry(shape,{depth:.16,bevelEnabled:true,bevelThickness:.025,bevelSize:.025,bevelSegments:1,steps:1,curveSegments:5}).translate(0,0,-.08);
    const trim:THREE.BufferGeometry[]=[];
    for(const z of [-.11,.11]){
      for(const y of [-.69,.69])trim.push(new THREE.BoxGeometry(1.88,.035,.035).translate(0,y,z));
      for(const x of [-.95,.95]){trim.push(new THREE.BoxGeometry(.035,1.35,.035).translate(x,0,z));for(const y of [-.62,.62])trim.push(new THREE.OctahedronGeometry(.045).translate(x,y,z));}
    }
    for(const x of [-.63,.63])for(let i=0;i<3;i++)trim.push(new THREE.TorusGeometry(.052,.012,4,10).translate(x,.85+i*.1,0));
    const supports=new THREE.InstancedMesh(support,wood,3),metal=new THREE.InstancedMesh(fittings,brass,3);
    this.boards=new THREE.InstancedMesh(board,wood,3);this.frames=new THREE.InstancedMesh(merge(trim),brass,3);
    for(const [mesh,name] of [[supports,'posts'],[metal,'fittings'],[this.boards,'boards'],[this.frames,'frames']] as const){mesh.name=`star-sign-${name}`;mesh.castShadow=mesh.receiveShadow=true;this.root.add(mesh);}
    for(const mesh of [this.boards,this.frames]){mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;}
    const anvil=new THREE.Shape();anvil.moveTo(-.65,.34);for(const [x,y] of [[.62,.34],[.35,.1],[.16,.05],[.16,-.24],[.4,-.35],[.4,-.46],[-.4,-.46],[-.4,-.35],[-.16,-.24],[-.16,.05],[-.52,.1],[-.65,.23]])anvil.lineTo(x,y);anvil.closePath();
    const forge=twoSided([relief(anvil),new THREE.BoxGeometry(.38,.15,.065).rotateZ(-.28).translate(-.08,.55,0),new THREE.BoxGeometry(.055,.29,.065).rotateZ(-.28).translate(-.14,.4,0)]);
    const bowl=new THREE.Shape();bowl.moveTo(-.58,.03);bowl.lineTo(.58,.03);bowl.quadraticCurveTo(.49,-.45,0,-.48);bowl.quadraticCurveTo(-.49,-.45,-.58,.03);
    const soup:THREE.BufferGeometry[]=[relief(bowl),new THREE.BoxGeometry(1.25,.07,.075).translate(0,.07,0)];
    for(const x of [-.32,0,.32])soup.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(x,.23,0),new THREE.Vector3(x-.05,.38,0),new THREE.Vector3(x+.04,.51,0),new THREE.Vector3(x,.65,0)]),12,.025,5,false));
    const tavern=twoSided(soup);
    const moon=new THREE.Shape();moon.moveTo(.15,.6);moon.bezierCurveTo(-.78,.62,-.78,-.62,.15,-.6);moon.bezierCurveTo(-.2,-.35,-.2,.35,.15,.6);
    const chapel=twoSided([relief(moon),new THREE.OctahedronGeometry(.2).scale(.8,1.3,.22).translate(.48,.28,0)]);
    for(const [i,site] of SITES.entries()){
      const y=height(site.x,site.z),anchor=new THREE.Matrix4().makeRotationY(site.yaw);anchor.setPosition(site.x,y,site.z);this.anchors.push(anchor);supports.setMatrixAt(i,anchor);metal.setMatrixAt(i,anchor);
      const colour=['#ffc681','#f1c6a0','#a8f0f3'][i];const material=new THREE.MeshStandardMaterial({color:colour,emissive:colour,emissiveIntensity:.22,metalness:.55,roughness:.38});
      const emblem=new THREE.Mesh([forge,tavern,chapel][i],material);emblem.name=`star-sign-${site.kind}`;emblem.matrixAutoUpdate=false;this.emblems.push(emblem);this.root.add(emblem);
    }
    this.update(0);
  }
  update(time:number){
    for(let i=0;i<this.anchors.length;i++){
      this.rotation.makeRotationZ(Math.sin(time*.85+i*1.7)*.035);
      this.matrix.copy(this.anchors[i]).multiply(this.pivot).multiply(this.rotation).multiply(this.drop);
      this.boards.setMatrixAt(i,this.matrix);this.frames.setMatrixAt(i,this.matrix);this.emblems[i].matrix.copy(this.matrix);this.emblems[i].matrixWorldNeedsUpdate=true;
    }
    this.boards.instanceMatrix.needsUpdate=this.frames.instanceMatrix.needsUpdate=true;
  }
}
