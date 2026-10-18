import {islandPaths} from './islandPaths';
import * as THREE from 'three';
import { loadKit, StaticBatch, Scatter, trs } from '../world/kit';
import { TownBuilder } from '../world/buildings';
import type { Collision } from '../world/collision';
import type { Lot } from '../world/layout';
import type { NpcId, ObjectiveKind } from './quests';

export const STAR_TOWN: Record<NpcId, [number,number]> = {
  brinebeard:[0,67], hoofclaw:[-20,58], pip:[-25,36], coralline:[20,35],
  silvermoon:[25,55], grukk:[0,20], rattlebolt:[18,76],
};
export const STAR_OBJECTIVES: Partial<Record<ObjectiveKind,[number,number]>> = {
  // Solid quest props sit beside the trails so their beds and frames leave the road open.
  'crystal-a':[-65,26], 'crystal-b':[-84,-10], 'crystal-c':[65,16], 'crystal-d':[84,-20],
  'lamp-a':[-7.4,15], 'lamp-b':[29,-15], 'lamp-c':[-7.4,-41],
  'explore-west':[-75,-35], 'explore-east':[80,-40], 'explore-north':[0,-48],
};
// Road centerlines stay independent of the nearby quest alcoves.
// Forking pilgrim trails connect the village to each exploration destination.
export const STAR_TRAILS: [number,number][][] = [
  [[0,24],[-16,24],[-38,8],[-65,22],[-80,-10],[-75,-35]],
  [[0,24],[18,20],[40,6],[65,12],[80,-20],[80,-40]],
  [[0,15],[0,0],[25,-15],[14,-31],[0,-45],[0,-48]],
];
export function starTrailDistance(x:number,z:number){
  let best=Infinity;
  for(const trail of STAR_TRAILS)for(let i=1;i<trail.length;i++){
    const [ax,az]=trail[i-1],[bx,bz]=trail[i],dx=bx-ax,dz=bz-az;
    const u=THREE.MathUtils.clamp(((x-ax)*dx+(z-az)*dz)/(dx*dx+dz*dz),0,1);
    best=Math.min(best,Math.hypot(x-ax-u*dx,z-az-u*dz));
  }
  return best;
}
export function nearStarObjective(x:number,z:number,padding=0){
  return Object.entries(STAR_OBJECTIVES).some(([kind,p])=>Math.hypot(x-p[0],z-p[1])<(kind.startsWith('explore-')?13:4)+padding);
}
export const STAR_WALKS = [[-15,62],[0,61],[15,62],[-15,44],[0,36],[15,44],[0,72],[0,24]];
/** The nature kit's leafy trees: the forest uses them, and their trunks are solid. */
export const STAR_TREE_NAME=/^CommonTree_[1-5]$/;

/** The forge, chapel, tavern and eight homes of Starhaven. */
export function starLots():Lot[]{
  const lots:Lot[]=[
    {id:'star-forge',kind:'forge',x:-34,z:29,yaw:0,sx:4,sz:3,floors:1,style:0,h:3},
    {id:'star-chapel',kind:'chapel',x:29,z:24,yaw:0,sx:4,sz:6,floors:2,style:0,h:3},
    {id:'star-tavern',kind:'tavern',x:-30,z:63,yaw:Math.PI/2,sx:4,sz:5,floors:2,style:0,h:3},
  ];
  for(const [i,x,z] of [[0,-28,82],[1,30,84],[2,-43,47],[3,44,48],[4,-20,14],[5,19,9],[6,-43,73],[7,44,70]]) {
    lots.push({id:`star-home-${i}`,kind:'house',x,z,yaw:Math.atan2(-x,55-z),sx:3,sz:3,floors:i%3?2:1,style:i%4,h:3});
  }
  return lots;
}

const forestRand=(i:number)=>{const a=Math.sin(i*127.1+23.7)*43758.5453;return a-Math.floor(a);};
/** Island forest: every fifth spot a rock, the rest trees. Positions only; names come from the kit. */
function starForest(){
  const spots:{i:number;x:number;z:number;rock:boolean;scale:number;yaw:number}[]=[];
  for(let i=0;i<340;i++) {
    const x=(forestRand(i+100)-.5)*215,z=(forestRand(i+900)-.5)*255+10;
    if(Math.hypot(x/110,(z-10)/130)>.88 || Math.abs(x)<11 || Math.hypot(x,z+75)<27)continue;
    if(Math.abs(x)<53&&z>3&&z<98)continue;
    if(starTrailDistance(x,z)<3)continue;
    if(nearStarObjective(x,z))continue;
    const rock=i%5===0;
    spots.push({i,x,z,rock,scale:rock?1.2+forestRand(i+88):.6+forestRand(i+55)*.65,yaw:forestRand(i+40)*6.28});
  }
  return spots;
}
// Leafy garden trees bring the forest into view from the village streets.
const GARDEN_TREES=[[-15,33],[14,34],[-15,81],[15,81],[-55,28],[55,30],[-56,58],[57,60],[-54,87],[55,88]];
const gardenScale=(x:number)=>Math.abs(x)<20?.68:.95;

/** Homes, tree trunks and garden trees of the settlement, without meshes. */
export function registerStarSettlement(height:(x:number,z:number)=>number,collision:Collision,natureNames:readonly string[]){
  const builder=new TownBuilder(null,null,collision,{});
  for(const lot of starLots())builder.build(lot);
  if(!natureNames.some(n=>STAR_TREE_NAME.test(n)))return;
  for(const p of starForest())if(!p.rock)collision.addCircle(p.x,p.z,.5*p.scale,height(p.x,p.z),height(p.x,p.z)+8);
  for(const [x,z] of GARDEN_TREES)collision.addCircle(x,z,.5*gardenScale(x),height(x,z),height(x,z)+9);
}

/** Deterministic, batched geometry; shared asset textures remain owned by the base world. */
export async function buildStarSettlement(height:(x:number,z:number)=>number) {
  const root=new THREE.Group();root.name='starhaven-settlement';
  const village=await loadKit('models/world/village.glb');
  const nature=await loadKit('models/world/nature.glb');
  const props=await loadKit('models/world/props.glb');
  // Clone materials so lighting the new village never recolours the old one.
  for(const kit of [village,nature,props]) {
    const copies=new Map<THREE.Material,THREE.Material>();
    for(const [name,m] of kit.materials){
      const c=m.clone();
      // Light the actual glass panes, including their original lattice and shutter occlusion.
      if(name==='MI_WindowGlass'&&c instanceof THREE.MeshStandardMaterial){c.color.set('#4d301c');c.emissive.set('#ffb65e');c.emissiveIntensity=1.15;c.roughness=.25;c.transparent=false;c.opacity=1;c.depthWrite=true;}
      if(name.startsWith('Leaves')&&c instanceof THREE.MeshStandardMaterial){c.color.set('#d9eed7');c.emissive.set('#163025');c.emissiveIntensity=.12;c.side=THREE.DoubleSide;}
      copies.set(m,c);kit.materials.set(name,c);
    }
    for(const piece of kit.pieces.values())for(const part of piece.parts)part.material=copies.get(part.material)!;
  }
  const batch=new StaticBatch(village,'starhaven-homes');
  const builder=new TownBuilder(village,batch,null,{});
  const lots=starLots();
  for(const lot of lots)builder.build(lot);
  root.add(batch.build());
  const dressing=new StaticBatch(props,'starhaven-market');
  const villageProps=new StaticBatch(village,'starhaven-gardens');
  const residents=Object.values(STAR_TOWN);
  const residentClearance=(x:number,z:number)=>Math.min(...residents.map(([px,pz])=>Math.hypot(x-px,z-pz)-1.8));
  const put=(name:string,x:number,z:number,yaw=0,scale=1,dy=0)=>{if(props.has(name))dressing.add(name,trs(x,height(x,z)+dy,z,yaw,scale));};
  for(const [i,x,z] of [[0,-12,48],[1,12,48],[2,-12,70],[3,12,70]]) {
    put('Stall_Empty',x,z,i%2?Math.PI:0);put('Barrel_Apples',x+2,z+1);put('FarmCrate_Apple',x-.5,z,0,1,.82);put('FarmCrate_Carrot',x+.5,z,0,1,.82);put('Crate_Wooden',x-2,z+1);
  }
  // Asset names vary between kit versions: select actual named pieces, not invisible placeholders.
  const names=[...props.pieces.keys()];
  const barrel=names.find(n=>/barrel/i.test(n)),crate=names.find(n=>/crate/i.test(n)),bench=names.find(n=>/bench/i.test(n));
  for(let i=0;i<18;i++){
    const x=(i%2?1:-1)*(19+i%3*3),z=30+Math.floor(i/2)*6;
    if(barrel&&residentClearance(x,z)>1.2)put(barrel,x,z,i*.7,.85);
    if(crate&&i%3===0&&residentClearance(x+1.4,z+.7)>1.1)put(crate,x+1.4,z+.7,0,.8);
  }
  if(bench)for(const [x,z] of [[-8,55],[8,55],[-8,61],[8,61]])put(bench,x,z,x<0?Math.PI/2:-Math.PI/2);
  if(village.has('Prop_Wagon'))for(const x of [-15,15])villageProps.add('Prop_Wagon',trs(x,3,88,x>0?.4:-.4));
  for(const lot of lots)for(let j=-2;j<=2;j++)if(village.has('Prop_WoodenFence_Single'))villageProps.add('Prop_WoodenFence_Single',trs(lot.x+j*2,3,lot.z-7,0));
  const lampMat=new THREE.MeshStandardMaterial({color:'#ffd295',emissive:'#ffae4d',emissiveIntensity:2.8,roughness:.4});
  const poleMat=new THREE.MeshStandardMaterial({color:'#343442',metalness:.7,roughness:.45});
  const poles=new THREE.InstancedMesh(new THREE.CylinderGeometry(.09,.18,3.4,6),poleMat,26);
  const bulbs=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.26),lampMat,26);
  for(let i=0;i<26;i++) {
    const side=i%2?1:-1, z=86-Math.floor(i/2)*6, x=side*(z>20?8:6);
    poles.setMatrixAt(i,trs(x,height(x,z)+1.7,z));bulbs.setMatrixAt(i,trs(x,height(x,z)+3.5,z));
    if(props.has('Lantern_Wall'))put('Lantern_Wall',x,z,side>0?-Math.PI/2:Math.PI/2,.8,2.5);
  }
  root.add(poles,bulbs);
  for(const [x,z] of [[0,57],[-25,36],[20,35],[0,76]]){const light=new THREE.PointLight('#ffc78b',18,30,1.5);light.position.set(x,7,z);root.add(light);}
  root.add(dressing.build(),villageProps.build());
  const scatter=new Scatter(nature,'star-island-forests');
  const rand=forestRand;
  const natureNames=[...nature.pieces.keys()];
  const treeNames=natureNames.filter(n=>STAR_TREE_NAME.test(n));
  const rockNames=[...nature.pieces.keys()].filter(n=>/^Rock_Medium_/.test(n));
  const flowerNames=[...nature.pieces.keys()].filter(n=>/Flower_[34]_Group|Bush_Common_Flowers/.test(n));
  // A plant's leaves extend beyond its origin. Keep its full footprint and wind off the paving.
  const plantRadius=new Map<string,number>();
  const clearPaving=(name:string,x:number,z:number,scale:number)=>{
    let radius=plantRadius.get(name);
    if(radius===undefined){
      const box=nature.get(name).box;
      radius=Math.hypot(Math.max(Math.abs(box.min.x),Math.abs(box.max.x)),Math.max(Math.abs(box.min.z),Math.abs(box.max.z)))+.2;
      plantRadius.set(name,radius);
    }
    const rect=(ax:number,bx:number,az:number,bz:number)=>Math.hypot(Math.max(ax-x,0,x-bx),Math.max(az-z,0,z-bz));
    return Math.min(rect(-4.9,4.9,-72.9,92.9),rect(-26.9,26.9,51.1,58.9),rect(-26,-4.7,34.8,37.2),rect(4.7,21,33.8,36.2),rect(-23,-4.7,80.8,83.2),rect(4.7,25,82.8,85.2),Math.max(0,starTrailDistance(x,z)-1.15),residentClearance(x,z))>radius*scale;
  };
  for(const p of starForest()) {
    const list=p.rock?rockNames:treeNames;if(!list.length)continue;
    scatter.add(list[p.i%list.length],trs(p.x,height(p.x,p.z),p.z,p.yaw,p.scale));
  }
  let gardenTrees=0;
  for(const [x,z] of GARDEN_TREES){
    if(!treeNames.length)break;
    const name=treeNames[gardenTrees%treeNames.length];
    scatter.add(name,trs(x,height(x,z),z,gardenTrees*2.39996,gardenScale(x)));gardenTrees++;
  }
  root.userData.gardenTrees=gardenTrees;
  for(let i=0;i<240;i++) {
    const x=(rand(i+1800)-.5)*105,z=10+rand(i+2500)*86;
    if(Math.abs(x)<12||lots.some(l=>Math.abs(x-l.x)<l.sx+3&&Math.abs(z-l.z)<l.sz+4))continue;
    if(flowerNames.length){
      const name=flowerNames[i%flowerNames.length];
      if(clearPaving(name,x,z,.7))scatter.add(name,trs(x,height(x,z),z,rand(i+3000)*6.28,.7));
    }
  }
  // Low meadows soften the cleared exploration sites without hiding markers or attack circles.
  // All plants use the original licensed kit and stay batched with the island's foliage.
  const meadowFlowers=flowerNames.filter(n=>/^Flower_[34]_Group$/.test(n));
  const grassNames=['Grass_Common_Short','Grass_Wispy_Short'].filter(n=>nature.has(n));
  let meadowCount=0;
  for(const [site,kind] of (['explore-west','explore-east','explore-north'] as const).entries()){
    const [cx,cz]=STAR_OBJECTIVES[kind]!;
    for(let i=0;i<72;i++){
      const a=i*2.39996+site*.8,r=6.1+rand(i+site*100+4200)*7.2,x=cx+Math.cos(a)*r,z=cz+Math.sin(a)*r;
      if(starTrailDistance(x,z)<2.4||Math.hypot(x,z+75)<27)continue;
      const names=i%3?grassNames:meadowFlowers;if(!names.length)continue;
      const name=names[i%names.length],scale=.5+rand(i+4500)*.3;
      if(!clearPaving(name,x,z,scale))continue;
      scatter.add(name,trs(x,height(x,z),z,a,scale));meadowCount++;
    }
  }
  root.userData.meadowPlants=meadowCount;
  root.add(scatter.build({boundsPadding:.2}));
  root.add(islandPaths(height,[
    {points:[[0,92],[0,-54]],width:9.5,trim:true},
    {points:[[-26,55],[26,55]],width:7,trim:true},
    {points:[[-4.7,36],[-25,36]],width:2.4},
    {points:[[4.7,35],[20,35]],width:2.4},
    {points:[[-4.7,82],[-22,82]],width:2.4},
    {points:[[4.7,84],[24,84]],width:2.4},
    ...STAR_TRAILS.map(points=>({points,width:2.4,trim:false})),
  ],2));
  for(const kit of [village,nature,props])for(const piece of kit.pieces.values())for(const part of piece.parts)part.geometry.dispose();
  return {root,lots,natureNames};
}
