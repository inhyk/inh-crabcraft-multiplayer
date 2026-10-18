import {MathUtils} from 'three';
import {STAR_OBJECTIVES} from './world2Settlement';
import {STAR_GRID,starSurfaceHeight} from '../sim/world/ground';

const {nx:NX,nz:NZ,step:STEP,minX:MIN_X,minZ:MIN_Z}=STAR_GRID;

function naturalHeight(x:number,z:number){
  const r=Math.hypot(x/115,(z-10)/140),coast=MathUtils.smoothstep(r,.83,1.04);
  return 7*(1-MathUtils.smoothstep(Math.hypot(x-27,z+19),5,28))+3+Math.sin(x*.08)*Math.cos(z*.06)*1.8+Math.max(0,r-.65)*12-coast*21;
}

function shapedHeight(x:number,z:number){
  let y=naturalHeight(x,z);
  for(const kind of ['explore-west','explore-east'] as const){
    const p=STAR_OBJECTIVES[kind]!,d=Math.hypot(x-p[0],z-p[1]);
    if(d<13)y=MathUtils.lerp(naturalHeight(...p),y,MathUtils.smoothstep(d,8,13));
  }
  const rect=(ax:number,bx:number,az:number,bz:number)=>Math.hypot(Math.max(ax-x,0,x-bx),Math.max(az-z,0,z-bz));
  // Keep the existing town, avenue and boss floor level; blend their outer edges into hills.
  const distance=Math.min(Math.max(0,Math.hypot(x,z+75)-24),rect(-9,9,-100,105),rect(-54,54,3,100));
  return MathUtils.lerp(3,y,MathUtils.smoothstep(distance,0,6));
}

export function buildStarHeights(){
  const heights=new Float32Array(NX*NZ);
  for(let z=0;z<NZ;z++)for(let x=0;x<NX;x++)heights[z*NX+x]=shapedHeight(MIN_X+x*STEP,MIN_Z+z*STEP);
  return heights;
}

export {starSurfaceHeight};
