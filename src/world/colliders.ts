// World I's colliders, registered without meshes. createWorld() builds them first and then adds the
// meshes; tools/bake-collision.mjs bakes the same registration for the server.
import { TownBuilder } from './buildings';
import { Collision } from './collision';
import { registerDressing } from './dressing';
import { scatterFoliage } from './foliage';
import { registerFountain } from './fountain';
import { LOTS, POI_DEFS } from './layout';
import { registerLighthouse } from './lighthouse';
import type { Terrain } from './terrain';
import { layoutWreck } from './wreck';

export function layoutClawhaven(terrain: Terrain, quality: 'low' | 'high') {
  const col = new Collision(terrain);
  const town = new TownBuilder(null, null, col, {});
  for (const lot of LOTS) town.build(lot);
  const fountainY = POI_DEFS.spawn ? terrain.heightAt(0, 0) : 4;
  registerFountain(col, 0, fountainY, 0);
  registerLighthouse(col);
  const wreck = layoutWreck(col);
  registerDressing(terrain, col);
  const foliage = scatterFoliage(terrain, col, quality);
  col.buildBlocked();
  return { col, fountainY, wreck, foliage };
}
