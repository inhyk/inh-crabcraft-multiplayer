// Clawhaven and the Brine Shore: the playable zone. Implements the World contract (./types).
import * as THREE from 'three';
import { initAssets } from '../core/assets';
import type { CreateWorld, Poi, PoiId, SpawnArea, World } from './types';
import { TownBuilder } from './buildings';
import { layoutClawhaven } from './colliders';
import { buildDressing } from './dressing';
import { buildFoliage } from './foliage';
import { buildFx } from './fx';
import { buildFountain } from './fountain';
import { loadKit, StaticBatch, trs } from './kit';
import { GRID, GROVE, LIGHTHOUSE, LOTS, POI_DEFS, SPAWN_POINTS } from './layout';
import { buildLighthouse } from './lighthouse';
import { stylise, WORLD_UNIFORMS } from './materials';
import { blendMood, cloneMood, MOODS, type Mood } from './moods';
import { createSky, createSkyUniforms } from './sky';
import { createTerrainMaterial, noiseTexture, Terrain } from './terrain';
import { createWater } from './water';
import { buildWreck } from './wreck';

export const createWorld: CreateWorld = async ({ renderer, scene, quality, onProgress }) => {
  const progress = (f: number, label: string) => onProgress?.(f, label);
  initAssets(renderer);
  const root = new THREE.Group();
  root.name = 'clawhaven';
  const uTime = WORLD_UNIFORMS.uTime;

  progress(0.02, 'Shaping the Tidelands');
  const terrain = new Terrain();
  // Colliders first, without meshes: the same registration the server bakes.
  const { col, fountainY, wreck: wreckLayout, foliage: scattered } = layoutClawhaven(terrain, quality);
  await tick();

  progress(0.1, 'Unpacking the village');
  const [village, nature, props] = await Promise.all([
    loadKit('models/world/village.glb'),
    loadKit('models/world/nature.glb'),
    loadKit('models/world/props.glb'),
  ]);
  // Kit materials: non-metallic stone/wood/plaster, a little more saturated and warm.
  for (const [name, m] of [...village.materials, ...props.materials]) {
    const sm = m as THREE.MeshStandardMaterial;
    if (!/Metal/.test(name)) {
      sm.metalness = 0;
      sm.metalnessMap = null;
    }
    stylise(sm, name === 'MI_RoundTiles' ? 1.2 : 1.15);
  }

  progress(0.35, 'Painting the ground');
  const terrainMat = createTerrainMaterial(
    terrain,
    {
      cobble: village.material('MI_UnevenBrick')?.map ?? null,
      cobbleNormal: village.material('MI_UnevenBrick')?.normalMap ?? null,
      rock: nature.material('Rocks')?.map ?? null,
    },
    { uTime },
  );
  const terrainMesh = terrain.buildMesh(terrainMat);
  terrainMesh.castShadow = false;
  root.add(terrainMesh);

  // Sky and water share the sky uniforms so reflections match the dome.
  const skyU = createSkyUniforms(uTime, noiseTexture());
  const sky = createSky(skyU);
  root.add(sky);

  progress(0.45, 'Raising Clawhaven');
  const windowGlass = new THREE.MeshStandardMaterial({
    name: 'cc-window',
    color: 0x2a1a0c,
    emissive: 0xffa040,
    emissiveIntensity: 1.4,
    roughness: 0.25,
    side: THREE.DoubleSide,
  });
  const townBatch = new StaticBatch(village, 'town');
  const town = new TownBuilder(village, townBatch, null, { MI_WindowGlass: windowGlass });
  for (const lot of LOTS) town.build(lot);
  root.add(townBatch.build());

  progress(0.55, 'Casting the Pincer Fountain');
  const fountain = buildFountain(0, fountainY, 0, village.material('MI_Brick')!, skyU);
  root.add(fountain.group);

  progress(0.6, 'Building Saltmere Lighthouse');
  const lighthouse = buildLighthouse(village, windowGlass);
  root.add(lighthouse.group);

  progress(0.65, 'Sinking the Iron Wreck');
  const propBatch = new StaticBatch(props, 'props');
  const dressBatch = new StaticBatch(village, 'village-dressing');
  const wreck = buildWreck(wreckLayout, townBatch, propBatch);
  root.add(wreck.group);

  progress(0.7, 'Setting out the market');
  const dressing = buildDressing(village, props, terrain, propBatch, dressBatch, skyU);
  root.add(dressing.group);
  const doorGlows = town.doorLamps.map((d) => {
    propBatch.add('Lantern_Wall', trs(d.pos.x, d.pos.y, d.pos.z, d.yaw, 0.75));
    return {
      pos: d.pos.clone().add(new THREE.Vector3(Math.sin(d.yaw) * 0.8, 0.45, Math.cos(d.yaw) * 0.8)),
      color: new THREE.Color('#ffb35a'),
      size: 1.2,
      kind: 'lamp' as const,
    };
  });
  root.add(propBatch.build());
  root.add(dressBatch.build());

  progress(0.72, 'Growing the pine woods');
  const foliage = buildFoliage(nature, scattered, quality);
  root.add(foliage.group);

  const water = createWater(
    skyU,
    terrain.heightTexture(),
    new THREE.Vector2(GRID.minX, GRID.minZ),
    new THREE.Vector2(GRID.maxX - GRID.minX, GRID.maxZ - GRID.minZ),
    quality,
  );
  (water.mesh.material as THREE.ShaderMaterial).uniforms.uTime = uTime;
  root.add(water.mesh);

  // Ambient particles.
  const fountainCentre = new THREE.Vector3(0, fountain.waterY, 0);
  const lhR = LIGHTHOUSE.stackRadius;
  const fx = buildFx(
    {
      glows: [
        ...dressing.glows,
        ...doorGlows,
        ...wreck.fires.map((p) => ({ pos: p, color: new THREE.Color('#ff7a2a'), size: 2.4, kind: 'fire' as const })),
        ...[0, 2.1, 4.2].map((a) => ({ pos: new THREE.Vector3(Math.cos(a) * 2.6, fountain.waterY - 0.15, Math.sin(a) * 2.6), color: new THREE.Color('#40d8ff'), size: 1.6, kind: 'lamp' as const })),
      ],
      forgeSparks: dressing.forgeSparks,
      chimneys: dressing.chimneys,
      fountainSpouts: fountain.spouts,
      fountainWaterY: fountain.waterY,
      fountainCentre,
      spray: [
        ...[0.4, 1.6, 2.8, 4.0, 5.2].map((a) => new THREE.Vector3(LIGHTHOUSE.x + Math.cos(a) * (lhR + 0.5), 0, LIGHTHOUSE.z + Math.sin(a) * (lhR + 0.5))),
        wreck.toWorld(0, 14, 0).setY(0),
        wreck.toWorld(-12, 14.5, 0).setY(0),
        wreck.toWorld(8, 13.8, 0).setY(0),
      ],
      embers: wreck.embers,
      fireflyZones: [
        { centre: new THREE.Vector3(GROVE.x, GROVE.h + 0.3, GROVE.z), extent: new THREE.Vector3(13, 3.5, 13), count: 140, color: new THREE.Color('#7affd9') },
        { centre: new THREE.Vector3(-48, 5, 18), extent: new THREE.Vector3(18, 3, 22), count: 50, color: new THREE.Color('#d8ff6a') },
        { centre: new THREE.Vector3(0, 4.5, 0), extent: new THREE.Vector3(20, 3, 20), count: 40, color: new THREE.Color('#ffe58a') },
      ],
      dustCentre: new THREE.Vector3(0, 4, 0),
      fireworksCentre: new THREE.Vector3(122, 50, 8),
    },
    quality,
    uTime,
  );
  root.add(fx.group);

  // Real lights: a fixed pool (no shader recompiles) re-assigned each frame to the light spots
  // nearest the camera's focus: forge, tavern door, square lamps, chapel, gate, grove, braziers,
  // the lit beacon and firework flashes.
  interface Spot {
    pos: THREE.Vector3;
    color: THREE.Color;
    intensity: number;
    distance: number;
    kind: string;
    seed: number;
    live?: () => number;
  }
  const spots: Spot[] = [
    ...wreck.fires.map((p) => ({ pos: p.clone().add(new THREE.Vector3(0, 0.6, 0)), color: new THREE.Color('#ff8a3a'), intensity: 26, distance: 24, kind: 'fire', seed: Math.random() * 10 })),
    ...dressing.lights.map((l) => ({ pos: l.pos, color: new THREE.Color(l.color), intensity: l.intensity, distance: l.distance, kind: l.kind, seed: Math.random() * 10 })),
  ];
  const beaconSpot: Spot = { pos: lighthouse.lens.clone(), color: new THREE.Color('#ffcf80'), intensity: 0, distance: 70, kind: 'beacon', seed: 0 };
  const flashSpot: Spot = { pos: new THREE.Vector3(122, 55, 8), color: new THREE.Color('#fff2e0'), intensity: 0, distance: 280, kind: 'flash', seed: 0 };
  spots.push(beaconSpot, flashSpot);
  const pool = Array.from({ length: quality === 'high' ? 4 : 2 }, () => {
    const pl = new THREE.PointLight('#ffffff', 0, 20, 1.6);
    root.add(pl);
    return pl;
  });
  let moodLamp = 1;
  let moodMagic = 0.6;
  const order: Spot[] = [];
  const lightFocus = new THREE.Vector3();
  const updateLights = (elapsed: number, cam: THREE.Vector3) => {
    const scored = spots
      .map((sp) => {
        const live = sp.kind === 'beacon' || sp.kind === 'flash' ? sp.intensity : 1;
        const d = sp.pos.distanceTo(cam) - (sp.kind === 'flash' && live > 0 ? 400 : 0) - (sp.kind === 'beacon' && live > 0 ? 40 : 0);
        return { sp, d: live > 0 ? d : Infinity };
      })
      .sort((a, b) => a.d - b.d);
    order.length = 0;
    for (const s of scored) order.push(s.sp);
    pool.forEach((pl, i) => {
      const sp = order[i];
      const d = sp ? sp.pos.distanceTo(cam) : Infinity;
      if (!sp || !Number.isFinite(d)) {
        pl.intensity = 0;
        return;
      }
      const k = sp.kind;
      const f = k === 'fire' ? 0.8 + 0.2 * Math.sin(elapsed * 13 + sp.seed) * Math.sin(elapsed * 7.1) : k === 'candle' ? 0.9 + 0.1 * Math.sin(elapsed * 17 + sp.seed) : 1;
      const m = k === 'magic' ? moodMagic : k === 'beacon' || k === 'flash' ? 1 : moodLamp;
      const fade = k === 'flash' || k === 'beacon' ? 1 : 1 - THREE.MathUtils.smoothstep(d, 70, 110);
      pl.position.copy(sp.pos);
      pl.color.copy(sp.color);
      pl.distance = sp.distance;
      pl.decay = k === 'flash' ? 1.0 : 1.6;
      pl.intensity = sp.intensity * f * m * fade;
    });
  };
  const flickers: THREE.Mesh[] = [];
  const bobbers: THREE.Mesh[] = [];
  const runes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o.userData.flicker) flickers.push(o as THREE.Mesh);
    if (o.userData.bob !== undefined) bobbers.push(o as THREE.Mesh);
    if (o.userData.rune) runes.push(o as THREE.Mesh);
  });
  const groveU = (dressing.groveWater.material as THREE.ShaderMaterial).uniforms;

  // Lights.
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  const shadowSize = quality === 'high' ? 4096 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  const SHADOW_EXTENT = quality === 'high' ? 70 : 55;
  Object.assign(sun.shadow.camera, { left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT, bottom: -SHADOW_EXTENT, near: 1, far: 460 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.05;
  root.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  root.add(hemi);
  const fog = new THREE.FogExp2(0xffffff, 0.003);
  scene.fog = fog;
  scene.background = null;

  // POIs and spawn areas.
  const pois = {} as Record<PoiId, Poi>;
  for (const [id, d] of Object.entries(POI_DEFS) as [PoiId, (typeof POI_DEFS)[PoiId]][]) {
    pois[id] = { id, position: new THREE.Vector3(d.x, d.y ?? col.heightAt(d.x, d.z), d.z), yaw: d.yaw, radius: d.radius };
  }
  const toV3 = ([x, z]: readonly [number, number]) => new THREE.Vector3(x, col.heightAt(x, z), z);
  const spawns: SpawnArea[] = [
    { id: 'scraplings', points: SPAWN_POINTS.scraplings.map(toV3), radius: 6 },
    { id: 'scavengers', points: SPAWN_POINTS.scavengers.map(toV3), radius: 3 },
    { id: 'townsfolk', points: SPAWN_POINTS.townsfolk.map(toV3), radius: 5 },
  ];

  // Moods.
  const mood: Mood = cloneMood(MOODS[0]);
  let target: Mood = MOODS[0];
  let blending = 1;
  let moodId: 0 | 1 | 2 | 3 = 0;
  let beaconOn = false;
  let envDirty = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(createSky(skyU));
  let envRT: THREE.WebGLRenderTarget | null = null;
  const applyMood = () => {
    sun.color.copy(mood.keyColor);
    sun.intensity = mood.keyIntensity;
    hemi.color.copy(mood.hemiSky);
    hemi.groundColor.copy(mood.hemiGround);
    hemi.intensity = mood.hemiIntensity;
    skyU.uSunDir.value.copy(moodId===3?mood.keyDir:MOODS[0].keyDir);
    skyU.uMoonDir.value.copy(MOODS[1].keyDir);
    skyU.uZenith.value.copy(mood.zenith);
    skyU.uMid.value.copy(mood.mid);
    skyU.uHorizon.value.copy(mood.horizon);
    skyU.uGround.value.copy(mood.ground);
    skyU.uSunColor.value.copy(mood.sunColor);
    skyU.uGlow.value.copy(mood.glow);
    skyU.uCloudLit.value.copy(mood.cloudLit);
    skyU.uCloudShade.value.copy(mood.cloudShade);
    skyU.uStars.value = mood.stars;
    skyU.uMoon.value = mood.moon;
    skyU.uSunVis.value = mood.sunVis;
    skyU.uCloudCover.value = mood.cloudCover;
    fog.color.copy(mood.fogColor);
    fog.density = mood.fogDensity;
    water.uniforms.uDeep.value.copy(mood.waterDeep);
    water.uniforms.uShallow.value.copy(mood.waterShallow);
    water.uniforms.uSunLight.value.copy(mood.waterLight);
    scene.environmentIntensity = mood.envIntensity;
    windowGlass.emissiveIntensity = 1.2 * mood.lamps;
    fx.uniforms.uLamps.value = 0.6 + 0.4 * mood.lamps;
    fx.uniforms.uFireflies.value = mood.fireflies;
    fx.uniforms.uDust.value = mood.sunVis;
    fx.uniforms.uNight.value = 1 - mood.sunVis;
    groveU.uPoolGlow.value = 0.7 + 0.5 * (1 - mood.sunVis);
    dressing.moonbeam.uniforms.uStrength.value = 0.06 + 0.16 * (1 - mood.sunVis);
    moodMagic = 0.6 + 0.6 * (1 - mood.sunVis);
    moodLamp = 0.55 + 0.45 * mood.lamps;
  };
  applyMood();

  const focus = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  scene.add(root);
  progress(1, 'Ready');

  const world: World = {
    root,
    pois,
    spawns,
    heightAt: (x, z) => col.heightAt(x, z),
    resolveCollision: (x, z, r, out) => col.resolve(x, z, r, out),
    raycastSolid: (from, to) => col.raycast(from, to),
    update(dt, elapsed, camera) {
      uTime.value = elapsed;
      if (blending < 1) {
        const k = 1 - Math.exp(-dt * 1.6);
        blendMood(mood, target, k);
        blending = Math.min(1, blending + dt / 2.5);
        if (blending >= 1) {
          blendMood(mood, target, 1);
          envDirty = true;
        }
        applyMood();
      }
      if (envDirty) {
        envDirty = false;
        envRT?.dispose();
        envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
        scene.environment = envRT.texture;
      }
      lighthouse.update(dt, elapsed, camera, mood.lamps);
      foliage.update(camera);
      // Particles: pixel scale for point sizes; fireworks only in the celebration mood.
      const pcam = camera as THREE.PerspectiveCamera;
      const hpx = renderer.domElement.height;
      fx.uniforms.uPixel.value = hpx / (2 * Math.tan(THREE.MathUtils.degToRad((pcam.fov ?? 50) / 2)));
      fx.uniforms.uFireworks.value += ((target === MOODS[2] ? 1 : 0) - fx.uniforms.uFireworks.value) * Math.min(1, dt * 0.8);
      for (const m of flickers) (m.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.6 + 0.8 * Math.sin(elapsed * 9) * Math.sin(elapsed * 5.3);
      for (const b of bobbers) {
        b.position.y = 0.15 + Math.sin(elapsed * 1.1 + b.userData.bob) * 0.08;
        b.rotation.z = Math.sin(elapsed * 0.9 + b.userData.bob) * 0.05;
      }
      for (const r of runes) (r.material as THREE.MeshBasicMaterial).color.setRGB(0.4, 2.2, 2.4).multiplyScalar(0.75 + 0.25 * Math.sin(elapsed * 1.4));
      // Firework flashes light the bay; the lit beacon lights its gallery.
      const fw = fx.uniforms.uFireworks.value;
      flashSpot.intensity = fw > 0.01 ? fw * 900 * Math.pow(Math.max(0, Math.sin(elapsed * 2.1) * Math.sin(elapsed * 0.77 + 1)), 6) + 0.001 * fw : 0;
      beaconSpot.intensity = lighthouse.lit * 30;
      camera.getWorldDirection(fwd);
      lightFocus.copy(camera.position).addScaledVector(fwd, 14);
      updateLights(elapsed, lightFocus);
      water.uniforms.uBeam.value = lighthouse.lit;
      water.uniforms.uBeamDir.value.copy(lighthouse.beamDir);
      water.uniforms.uBeamPos.value.copy(lighthouse.lens);
      // Sky follows the camera; the shadow frustum follows a focus point ahead of it.
      sky.position.copy(camera.position);
      camera.getWorldDirection(fwd);
      const ahead = THREE.MathUtils.clamp(camera.position.y * 1.2, 12, 45);
      focus.copy(camera.position).addScaledVector(fwd.setY(0).normalize(), ahead);
      focus.y = col.heightAt(focus.x, focus.z);
      const texel = (2 * SHADOW_EXTENT) / shadowSize;
      focus.x = Math.round(focus.x / texel) * texel;
      focus.z = Math.round(focus.z / texel) * texel;
      sun.position.copy(focus).addScaledVector(mood.keyDir, 220);
      sun.target.position.copy(focus);
      sun.target.updateMatrixWorld();
    },
    setBeaconLit(lit) {
      beaconOn = lit;
      lighthouse.setLit(lit);
    },
    setMood(m, instant = false) {
      moodId = m; target = MOODS[m]; blending = instant ? 1 : 0;
      if (instant) { blendMood(mood, target, 1); applyMood(); envDirty = true; }
    },
    getEnvironment() { return { mood: moodId, beacon: beaconOn }; },
    dispose() {
      scene.remove(root);
      if (scene.fog === fog) scene.fog = null;
      if (envRT && scene.environment === envRT.texture) scene.environment = null;
      envRT?.dispose();
      pmrem.dispose();
      sun.shadow.dispose();
      water.uniforms.uHeight.value.dispose();
      const mats = new Set<THREE.Material>();
      for(const owner of [root,envScene])owner.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const m = mesh.material;
        if (m) for (const mm of Array.isArray(m) ? m : [m]) mats.add(mm);
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      for (const m of mats) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
        m.dispose();
      }
    },
  };
  void wreck;
  pois.wreck.position.copy(wreck.gangwayFoot);
  pois.bossArena.position.copy(wreck.arena);
  // Debug info for the dev harness (not part of the World contract).
  (world as World & { debug?: unknown }).debug = { foliage: foliage.counts, collision: col, lighthouse, setBeamPhase: (p: number) => (lighthouse.phase = p) };
  return world;
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
