import * as THREE from 'three';
import type { Collision } from '../world/collision';
import {facetedStarCrystal,starCrystalRadius} from './starCrystal';

/** Moonshade's six crystal leaves around the glade. */
function moonshadeLeaves(){
  return Array.from({length:6},(_,i)=>{
    const a=i/6*Math.PI*2,x=-75+Math.cos(a)*7.7,z=-35+Math.sin(a)*7.7,h=3.5+(i%3)*1.1;
    return {x,z,h,rotation:new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a)*.12,a,Math.cos(a)*.12)),scale:new THREE.Vector3(1.1,h,.85)};
  });
}
const SANCTUARY_PILLARS=[[0,-4.8,-55],[1,4.8,-55],[2,-8,-47],[3,8,-47]] as const;

/** Crystal leaves and sanctuary pillars block movement; the glade and the arch stay open. */
export function registerStarLandmarks(height:(x:number,z:number)=>number,collision:Collision){
  const geometry=facetedStarCrystal();
  for(const {x,z,h,rotation,scale} of moonshadeLeaves())collision.addCircle(x,z,Math.max(1.2,starCrystalRadius(geometry,scale,rotation)),height(x,z),height(x,z)+h*1.7);
  geometry.dispose();
  for(const [,x,z] of SANCTUARY_PILLARS){const y=height(x,z);collision.addCircle(x,z,1,y,y+6.4);}
}

/** Distinct silhouettes at the three memories; the middle stays open for players and quest markers. */
export class StarLandmarks {
  readonly root=new THREE.Group();
  private astrolabe:THREE.Group;
  private mist:THREE.Points;
  private northernStar:THREE.Mesh;

  constructor(height:(x:number,z:number)=>number){
    this.root.name='star-island-landmarks';
    const stone=new THREE.MeshStandardMaterial({color:'#686c83',roughness:.85,metalness:.15});
    const paleStone=new THREE.MeshStandardMaterial({color:'#b2b1bd',roughness:.7,metalness:.2});
    const gold=new THREE.MeshStandardMaterial({color:'#d5b574',roughness:.4,metalness:.7});
    const cyan=new THREE.MeshStandardMaterial({color:'#92e3e2',emissive:'#238c9a',emissiveIntensity:1.3,metalness:.4,roughness:.3});
    const violet=new THREE.MeshStandardMaterial({color:'#b29bea',emissive:'#6644a6',emissiveIntensity:1.5,metalness:.5,roughness:.3});
    const matrix=new THREE.Matrix4(),rotation=new THREE.Quaternion();
    const place=(mesh:THREE.Mesh,x:number,y:number,z:number)=>{mesh.position.set(x,y,z);this.root.add(mesh);return mesh;};
    // A low medallion at each landmark anchors its floating memory above the ground.
    for(const [x,z] of [[-75,-35],[80,-40],[0,-48]]){
      const y=height(x,z);
      const floor=place(new THREE.Mesh(new THREE.CylinderGeometry(5.2,5.4,.18,48),stone),x,y-.06,z);floor.receiveShadow=true;
      const border=place(new THREE.Mesh(new THREE.TorusGeometry(5,.05,5,64),gold),x,y+.055,z);border.rotation.x=-Math.PI/2;
    }
    // Moonshade: six enormous blue crystal leaves frame a quiet, walkable glade.
    const crystalFaces=cyan.clone();crystalFaces.vertexColors=true;crystalFaces.flatShading=true;crystalFaces.emissiveIntensity=.45;crystalFaces.metalness=.35;crystalFaces.roughness=.3;
    const crystals=new THREE.InstancedMesh(facetedStarCrystal(),crystalFaces,6);crystals.name='moonshade-crystal-leaves';
    moonshadeLeaves().forEach(({x,z,h,rotation,scale},i)=>{
      matrix.compose(new THREE.Vector3(x,height(x,z)+h*.55,z),rotation,scale);crystals.setMatrixAt(i,matrix);
    });
    crystals.castShadow=true;this.root.add(crystals);
    // Memory Sanctuary: a carved arch sits beyond the discovery circle, leaving the road open.
    const pillars=new THREE.InstancedMesh(new THREE.CylinderGeometry(.58,.7,5.7,12),paleStone,4);
    pillars.name='sanctuary-column-shafts';
    const capitals=new THREE.InstancedMesh(new THREE.CylinderGeometry(.74,.95,.35,8),paleStone,8);
    capitals.name='sanctuary-column-capitals';
    const bands=new THREE.InstancedMesh(new THREE.CylinderGeometry(.73,.73,.14,12),gold,8);
    bands.name='sanctuary-column-bands';
    const glyphs=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.14),violet,12);
    glyphs.name='sanctuary-column-glyphs';
    for(const [i,x,z] of SANCTUARY_PILLARS){
      const y=height(x,z);pillars.setMatrixAt(i,new THREE.Matrix4().makeTranslation(x,y+3.2,z));
      for(let j=0;j<2;j++){
        rotation.setFromAxisAngle(new THREE.Vector3(1,0,0),j*Math.PI);
        matrix.compose(new THREE.Vector3(x,y+(j?6.225:.175),z),rotation,new THREE.Vector3(1,1,1));capitals.setMatrixAt(i*2+j,matrix);
        bands.setMatrixAt(i*2+j,new THREE.Matrix4().makeTranslation(x,y+(j?5.7:.8),z));
      }
      for(let j=0;j<3;j++){
        matrix.compose(new THREE.Vector3(x,y+3.7+j*.43,z+.66),new THREE.Quaternion(),new THREE.Vector3(j===1?1:.65,1.2,.5));glyphs.setMatrixAt(i*3+j,matrix);
      }
    }
    for(const mesh of [pillars,capitals,bands,glyphs]){mesh.castShadow=true;mesh.receiveShadow=true;this.root.add(mesh);}
    const arch=new THREE.InstancedMesh(new THREE.BoxGeometry(1.25,1.1,1.45),paleStone,11);
    const runes=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.16),violet,11);
    for(let i=0;i<11;i++){
      const a=i/10*Math.PI,x=Math.cos(a)*4.8,y=height(0,-55)+5.7+Math.sin(a)*3.4;
      rotation.setFromEuler(new THREE.Euler(0,0,a-Math.PI/2));matrix.compose(new THREE.Vector3(x,y,-55),rotation,new THREE.Vector3(1,1,1));arch.setMatrixAt(i,matrix);
      runes.setMatrixAt(i,new THREE.Matrix4().makeTranslation(x,y,-54.2));
    }
    arch.castShadow=true;this.root.add(arch,runes);
    this.northernStar=place(new THREE.Mesh(new THREE.OctahedronGeometry(.8),gold),0,height(0,-55)+8,-55);
    // Fallen Star Observatory: an antique celestial instrument above the ruined reflecting pool.
    this.astrolabe=new THREE.Group();this.astrolabe.position.set(80,height(80,-40)+6.5,-40);this.root.add(this.astrolabe);
    for(const [i,r] of [4.2,3.5,2.6].entries()){
      const ring=new THREE.Mesh(new THREE.TorusGeometry(r,.075,6,72),i===1?cyan:gold);ring.rotation.set(i*.7,.4+i*.9,i*.55);this.astrolabe.add(ring);
    }
    const globe=new THREE.Mesh(new THREE.IcosahedronGeometry(.85,1),violet);this.astrolabe.add(globe);
    const stars=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.14),violet,12);
    for(let i=0;i<12;i++){const a=i/12*Math.PI*2;stars.setMatrixAt(i,new THREE.Matrix4().makeTranslation(Math.cos(a)*4.2,Math.sin(a)*4.2,0));}this.astrolabe.add(stars);
    // Sparse luminous spores give the western clearing motion without hiding the ground.
    const points=new Float32Array(72*3);
    for(let i=0;i<72;i++){const a=i*2.39996,r=2+(i*17%60)/10,x=-75+Math.cos(a)*r,z=-35+Math.sin(a)*r;points.set([x,height(x,z)+.6+(i*13%40)/10,z],i*3);}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(points,3));
    this.mist=new THREE.Points(geometry,new THREE.PointsMaterial({color:'#a6ffea',size:.07,transparent:true,opacity:.65,depthWrite:false}));this.root.add(this.mist);
  }

  update(time:number){
    this.astrolabe.rotation.y=time*.045;this.astrolabe.rotation.z=Math.sin(time*.15)*.08;
    this.northernStar.rotation.y=time*.3;this.mist.position.y=Math.sin(time*.4)*.18;
  }
}
