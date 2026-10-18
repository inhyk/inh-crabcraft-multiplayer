import * as THREE from 'three';
import {facetedStarCrystal} from './starCrystal';

/** The twelve column footprints around the final arena: solid to movement and to sight. */
export function throneSolids():{x:number;z:number;r:number}[]{
  return Array.from({length:12},(_,i)=>{const a=i/12*Math.PI*2;return {x:Math.sin(a)*21,z:-75+Math.cos(a)*21,r:1.7};});
}

/** The final arena's perimeter architecture; its original twelve footprints stay unchanged. */
export class StarThrone {
  readonly root=new THREE.Group();
  readonly solids=throneSolids();
  private gems:THREE.InstancedMesh[]=[];
  private anchors:{x:number;y:number;z:number;side:number;index:number;angle:number}[]=[];
  private matrix=new THREE.Matrix4();
  private quaternion=new THREE.Quaternion();
  private scale=new THREE.Vector3(.55,1.2,.55);
  private position=new THREE.Vector3();
  constructor(height:(x:number,z:number)=>number,stone:THREE.MeshStandardMaterial,teal:THREE.MeshStandardMaterial,violet:THREE.MeshStandardMaterial){
    this.root.name='star-throne-colonnade';
    const pale=stone.clone();pale.color.set('#89819b');pale.roughness=.6;
    const gold=new THREE.MeshStandardMaterial({color:'#c2ac78',metalness:.7,roughness:.35});
    const shafts=new THREE.InstancedMesh(new THREE.CylinderGeometry(1.2,1.7,1,8),stone,12);
    const caps=new THREE.InstancedMesh(new THREE.CylinderGeometry(1.4,1.65,.45,8),pale,24);
    const bands=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,.16,8),gold,24);
    const glyphs=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.16),teal,36);
    for(const [mesh,name] of [[shafts,'shafts'],[caps,'capitals'],[bands,'bands'],[glyphs,'glyphs']] as const){mesh.name=`star-throne-${name}`;mesh.receiveShadow=true;this.root.add(mesh);}
    shafts.castShadow=caps.castShadow=true;
    const geometry=facetedStarCrystal();
    for(const [i,material] of [teal,violet].entries()){
      const glow=material.clone();glow.vertexColors=true;glow.flatShading=true;glow.emissiveIntensity=.8;glow.roughness=.3;
      const mesh=new THREE.InstancedMesh(geometry,glow,6);mesh.name=`star-throne-crystals-${i}`;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;this.gems.push(mesh);this.root.add(mesh);
    }
    for(let i=0;i<12;i++){
      const a=i/12*Math.PI*2,{x,z}=this.solids[i],h=5+(i%3)*2,y=height(x,z);
      this.matrix.compose(this.position.set(x,y+h/2,z),this.quaternion.identity(),this.scale.set(1,h,1));shafts.setMatrixAt(i,this.matrix);
      for(let j=0;j<2;j++){
        // Invert around X at the top so both capitals flare away from the shaft.
        this.quaternion.setFromAxisAngle(new THREE.Vector3(1,0,0),j*Math.PI);
        this.matrix.compose(this.position.set(x,y+(j?h-.225:.225),z),this.quaternion,this.scale.setScalar(1));caps.setMatrixAt(i*2+j,this.matrix);
        const bandY=j?h-.6:.65,radius=1.7-.5*bandY/h+.035;
        this.matrix.compose(this.position.set(x,y+bandY,z),this.quaternion.identity(),this.scale.set(radius,1,radius));bands.setMatrixAt(i*2+j,this.matrix);
      }
      for(let j=0;j<3;j++){
        this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP,a);this.matrix.compose(this.position.set(x-Math.sin(a)*1.62,y+2+j*.6,z-Math.cos(a)*1.62),this.quaternion,this.scale.set(j===1?1:.65,1.35,.4));glyphs.setMatrixAt(i*3+j,this.matrix);
      }
      this.anchors.push({x,y:y+h+1.05,z,side:i%2,index:Math.floor(i/2),angle:a});
    }
    this.scale.set(.55,1.2,.55);this.update(0);
  }
  update(time:number){
    for(const p of this.anchors){
      this.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP,p.angle+time*.25);
      this.matrix.compose(this.position.set(p.x,p.y+Math.sin(time*.7+p.angle)*.12,p.z),this.quaternion,this.scale);
      this.gems[p.side].setMatrixAt(p.index,this.matrix);
    }
    for(const mesh of this.gems)mesh.instanceMatrix.needsUpdate=true;
  }
}
