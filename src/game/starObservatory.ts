import * as THREE from 'three';
import type {Collision} from '../world/collision';
import {starTrailDistance} from './world2Settlement';

const COLUMN_HEIGHTS=[5,4.5,3.8,5,4.6,3.2,4.8,5,3.6,4.5];
const column=(i:number)=>{const a=i/10*Math.PI*2;return {a,x:80+Math.cos(a)*9,z:-40+Math.sin(a)*9,h:COLUMN_HEIGHTS[i]};};

/** The ten columns are solid up to their capitals. */
export function registerStarObservatory(height:(x:number,z:number)=>number,collision:Collision){
  for(let i=0;i<10;i++){const {x,z,h}=column(i),y=height(x,z);collision.addCircle(x,z,.9,y,y+h);}
}

/** Weathered observatory masonry. Existing column footprints keep the approach and quest clear. */
export class StarObservatory {
  readonly root=new THREE.Group();
  private ripples:THREE.Mesh[]=[];
  constructor(height:(x:number,z:number)=>number){
    this.root.name='fallen-star-observatory';
    const stone=new THREE.MeshStandardMaterial({color:'#9690a5',roughness:.87,metalness:.12,flatShading:true});
    const trim=new THREE.MeshStandardMaterial({color:'#baa885',roughness:.63,metalness:.35});
    const glow=new THREE.MeshStandardMaterial({color:'#b9e9ed',emissive:'#3f8c9a',emissiveIntensity:.7,roughness:.4});
    const shafts=new THREE.InstancedMesh(new THREE.CylinderGeometry(.6,.72,1,12),stone,10);shafts.name='observatory-column-shafts';
    const bases=new THREE.InstancedMesh(new THREE.CylinderGeometry(.76,.9,.32,8),stone,10);bases.name='observatory-column-bases';
    const capitals=new THREE.InstancedMesh(new THREE.CylinderGeometry(.86,.67,.32,8),trim,10);capitals.name='observatory-column-capitals';
    const bands=new THREE.InstancedMesh(new THREE.CylinderGeometry(.66,.69,.11,12),trim,20);bands.name='observatory-column-bands';
    const runes=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.12),glow,20);runes.name='observatory-column-runes';
    const matrix=new THREE.Matrix4(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3(1,1,1);
    for(let i=0;i<10;i++){
      const {a,x,z,h}=column(i),y=height(x,z);
      rotation.setFromAxisAngle(new THREE.Vector3(0,1,0),a);
      matrix.compose(new THREE.Vector3(x,y+.16,z),rotation,scale);bases.setMatrixAt(i,matrix);
      matrix.compose(new THREE.Vector3(x,y+h/2,z),rotation,new THREE.Vector3(1,h-.64,1));shafts.setMatrixAt(i,matrix);
      matrix.compose(new THREE.Vector3(x,y+h-.16,z),rotation,scale);capitals.setMatrixAt(i,matrix);
      for(let j=0;j<2;j++){
        matrix.compose(new THREE.Vector3(x,y+.5+j*(h-1),z),rotation,scale);bands.setMatrixAt(i*2+j,matrix);
        matrix.compose(new THREE.Vector3(x-Math.cos(a)*.73,y+h-.75-j*.4,z-Math.sin(a)*.73),rotation,new THREE.Vector3(.65,1.3,.65));runes.setMatrixAt(i*2+j,matrix);
      }
    }
    for(const mesh of [shafts,bases,capitals,bands,runes]){mesh.castShadow=true;mesh.receiveShadow=true;this.root.add(mesh);}
    // Reuse the deterministic rubble field, keeping stones off the marked walking trails.
    const rubble=new THREE.InstancedMesh(new THREE.DodecahedronGeometry(.7,0),stone,64);rubble.name='observatory-rubble';
    for(let i=0;i<64;i++){
      const a=i*2.39996,r=10+(i*11%80)/10,x=80+Math.cos(a)*r,z=-40+Math.sin(a)*r;
      if(starTrailDistance(x,z)<2.2){matrix.makeScale(0,0,0);rubble.setMatrixAt(i,matrix);continue;}
      rotation.setFromEuler(new THREE.Euler(i*.3,i,.4));matrix.compose(new THREE.Vector3(x,height(x,z)+.3,z),rotation,new THREE.Vector3(.5+i%3*.2,.4+i%2*.2,.7));rubble.setMatrixAt(i,matrix);
    }
    rubble.castShadow=true;this.root.add(rubble);
    const y=height(80,-40);
    const well=new THREE.Mesh(new THREE.TorusGeometry(3,.35,6,48),stone);well.rotation.x=Math.PI/2;well.position.set(80,y+.2,-40);this.root.add(well);
    const pool=new THREE.Mesh(new THREE.CircleGeometry(2.75,48),new THREE.MeshPhysicalMaterial({color:'#4c7091',emissive:'#2b426e',emissiveIntensity:.35,roughness:.15,metalness:.35,clearcoat:.8}));pool.name='observatory-reflecting-water';pool.rotation.x=-Math.PI/2;pool.position.set(80,y+.1,-40);this.root.add(pool);
    // A worn celestial dial surrounds the water; short gold ticks never obstruct the walking route.
    const ticks=new THREE.InstancedMesh(new THREE.BoxGeometry(.07,.025,.35),trim,24);ticks.name='observatory-celestial-dial';
    for(let i=0;i<24;i++){
      const a=i/24*Math.PI*2;rotation.setFromAxisAngle(new THREE.Vector3(0,1,0),a);
      matrix.compose(new THREE.Vector3(80+Math.sin(a)*3.85,y+.065,-40+Math.cos(a)*3.85),rotation,new THREE.Vector3(i%6===0?2:1,1,i%6===0?1.5:1));ticks.setMatrixAt(i,matrix);
    }
    this.root.add(ticks);
    for(let i=0;i<3;i++){
      const wave=new THREE.Mesh(new THREE.TorusGeometry(1,.012,4,48),new THREE.MeshBasicMaterial({color:'#a7cee8',transparent:true,opacity:.2,depthWrite:false}));
      wave.name='observatory-water-ripple';wave.rotation.x=-Math.PI/2;wave.position.set(80,y+.12,-40);this.ripples.push(wave);this.root.add(wave);
    }
  }
  update(time:number){
    for(const [i,wave] of this.ripples.entries()){
      const p=(time*.16+i/3)%1;wave.scale.setScalar(.25+p*2.4);(wave.material as THREE.MeshBasicMaterial).opacity=(1-p)*.22;
    }
  }
}
