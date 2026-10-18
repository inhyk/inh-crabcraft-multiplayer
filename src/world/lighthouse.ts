// Saltmere Lighthouse: a striped tower on a sea stack, joined to the headland by a stair bridge
// that lands on the lantern gallery. When lit, twin beams sweep the bay.
import * as THREE from 'three';
import { annulusSurface, type Collision, rectSurface } from './collision';
import { mergeAll } from './fountain';
import { lathe, worldBox } from './geom';
import { type Kit, trs } from './kit';
import { HEADLAND_H, LIGHTHOUSE as L } from './layout';
import { addPatch } from './materials';
import { GLSL_NOISE } from './noise';

export interface Lighthouse {
  group: THREE.Group;
  /** Lens centre in world space. */
  lens: THREE.Vector3;
  /** Current beam heading on the ground plane (unit). */
  beamDir: THREE.Vector2;
  /** 0..1 eased lit amount. */
  lit: number;
  /** Extra beam angle (radians), for cinematics and screenshots. */
  phase: number;
  setLit(lit: boolean): void;
  update(dt: number, elapsed: number, camera: THREE.Camera, lamps: number): void;
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.15, 'rgba(255,240,200,0.75)');
  grd.addColorStop(0.4, 'rgba(255,200,120,0.18)');
  grd.addColorStop(1, 'rgba(255,160,80,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The stair bridge and the gallery rail, shared by the meshes and the colliders. */
function lighthouseFrame() {
  const bridgeDir = new THREE.Vector2(L.bridgeFrom[0] - L.x, L.bridgeFrom[1] - L.z).normalize();
  const gapAng = Math.atan2(bridgeDir.y, bridgeDir.x);
  const gapHalf = 0.36;
  const railR = 4.8;
  const arc = Math.PI * 2 - gapHalf * 2;
  const p0 = new THREE.Vector3(L.bridgeFrom[0], HEADLAND_H, L.bridgeFrom[1]);
  const p1 = new THREE.Vector3(L.x + bridgeDir.x * (L.galleryOuter + 0.1), L.galleryY, L.z + bridgeDir.y * (L.galleryOuter + 0.1));
  const d = new THREE.Vector2(p1.x - p0.x, p1.z - p0.z);
  const len = d.length();
  d.normalize();
  const yaw = Math.atan2(-d.y, d.x);
  const rise = p1.y - p0.y;
  const W = 3.2;
  const mid = p0.clone().lerp(p1, 0.5);
  const nx = -d.y;
  const nz = d.x;
  return { gapAng, gapHalf, railR, arc, p0, p1, d, len, yaw, rise, W, mid, nx, nz };
}

/** Bridge deck, parapets, gallery ring, lantern drum and outer rail. */
export function registerLighthouse(col: Collision): void {
  const { gapAng, gapHalf, railR, arc, p0, p1, d, len, yaw, rise, W, mid, nx, nz } = lighthouseFrame();
  col.addSurface(rectSurface(mid.x, mid.z, len / 2 + 0.6, W / 2 - 0.2, yaw, mid.y, rise / len, 0));
  for (const side of [-1, 1]) {
    const ox = nx * side * (W / 2 - 0.1);
    const oz = nz * side * (W / 2 - 0.1);
    col.addWall(p0.x + ox - d.x * 0.6, p0.z + oz - d.y * 0.6, p1.x + ox - d.x * 0.2, p1.z + oz - d.y * 0.2, 0.3);
  }
  col.addSurface(annulusSurface(L.x, L.z, L.lanternRadius - 0.1, L.galleryOuter + 0.15, L.galleryY));
  col.addCircle(L.x, L.z, L.lanternRadius + 0.15, L.galleryY - 1, L.galleryY + 8);
  const segs = 28;
  for (let i = 0; i < segs; i++) {
    const a0 = gapAng + gapHalf + (i / segs) * arc;
    const a1 = gapAng + gapHalf + ((i + 1) / segs) * arc;
    col.addWall(L.x + Math.cos(a0) * railR, L.z + Math.sin(a0) * railR, L.x + Math.cos(a1) * railR, L.z + Math.sin(a1) * railR, 0.25, L.galleryY - 0.5, L.galleryY + 1.2);
  }
  // The tower blocks line of sight below the gallery.
  col.addCircle(L.x, L.z, 3.8, L.stackTop - 3, L.galleryY - 0.6, true);
}

export function buildLighthouse(kit: Kit, glass: THREE.Material): Lighthouse {
  const frame = lighthouseFrame();
  const group = new THREE.Group();
  group.name = 'lighthouse';
  const base = new THREE.Vector3(L.x, L.stackTop, L.z);
  const G = L.galleryY - L.stackTop; // gallery height above the stack
  const plaster = (kit.material('MI_Plaster') as THREE.MeshStandardMaterial).clone();
  const stone = kit.material('MI_UnevenBrick') as THREE.MeshStandardMaterial;
  const brick = kit.material('MI_Brick') as THREE.MeshStandardMaterial;

  // Striped shaft: white plaster with two red bands.
  addPatch(plaster, 'lh-stripes', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLY;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvLY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLY;').replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        float y = vLY - ${L.stackTop.toFixed(2)};
        float band = step(5.5, y) * step(y, 9.0) + step(12.5, y) * step(y, 16.0) + step(19.5, y) * step(y, 23.0);
        vec3 white = vec3(1.08, 1.04, 0.98);
        vec3 red = vec3(0.78, 0.13, 0.10);
        diffuseColor.rgb *= mix(white, red, band);
      }`,
    );
  });
  const shaftGeo = lathe(
    [
      [3.95, 1.6],
      [3.75, 6],
      [3.5, 12],
      [3.25, 18],
      [3.05, G - 1.4],
    ],
    40,
    0.4,
  );
  const shaft = new THREE.Mesh(shaftGeo, plaster);
  const stoneGeo = mergeAll([
    lathe(
      [
        [5.0, -2.5],
        [5.0, 1.2],
        [4.65, 1.45],
        [3.95, 1.6],
      ],
      40,
      0.4,
    ),
    lathe(
      [
        [3.05, G - 1.4],
        [3.5, G - 1.1],
        [4.3, G - 0.7],
        [4.98, G - 0.55],
        [4.98, G],
        [2.2, G],
      ],
      48,
      0.4,
    ),
    lathe(
      [
        [2.2, G],
        [2.28, G + 0.05],
        [2.28, G + 0.85],
        [2.05, G + 0.9],
      ],
      32,
      0.4,
    ),
  ]);
  const stoneMesh = new THREE.Mesh(stoneGeo, stone);
  const copper = new THREE.MeshStandardMaterial({ color: '#b8452a', roughness: 0.45, metalness: 0.35 });
  const domeGeo = mergeAll([
    lathe(
      [
        [2.05, G + 3.75],
        [2.4, G + 3.8],
        [2.4, G + 4.05],
        [2.62, G + 4.05],
        [2.5, G + 4.3],
        [2.1, G + 5.0],
        [1.45, G + 5.65],
        [0.75, G + 6.05],
        [0.28, G + 6.25],
        [0.0, G + 6.3],
      ],
      32,
      0.5,
    ),
    new THREE.SphereGeometry(0.3, 12, 8).translate(0, G + 6.55, 0),
    new THREE.ConeGeometry(0.1, 1.4, 6).translate(0, G + 7.4, 0),
  ]);
  const dome = new THREE.Mesh(domeGeo, copper);
  const iron = new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 0.55, metalness: 0.7 });

  // Lantern glazing with mullions, and the rail around the gallery.
  const ironParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ironParts.push(new THREE.BoxGeometry(0.12, 2.9, 0.12).translate(Math.cos(a) * 2.02, G + 2.3, Math.sin(a) * 2.02));
  }
  ironParts.push(new THREE.TorusGeometry(2.03, 0.07, 6, 40).rotateX(Math.PI / 2).translate(0, G + 0.9, 0));
  ironParts.push(new THREE.TorusGeometry(2.03, 0.07, 6, 40).rotateX(Math.PI / 2).translate(0, G + 3.72, 0));
  const { gapAng, gapHalf, railR, arc } = frame;
  for (const h of [0.55, 1.05]) {
    const t = new THREE.TorusGeometry(railR, h > 1 ? 0.06 : 0.04, 6, 64, arc).rotateX(Math.PI / 2);
    // Torus starts at +x and runs toward -z after rotateX(+pi/2); rotate to start after the gap.
    t.rotateY(-(gapAng + gapHalf));
    ironParts.push(t.translate(0, G + h, 0));
  }
  for (let i = 0; i <= 40; i++) {
    const a = gapAng + gapHalf + (i / 40) * arc;
    ironParts.push(new THREE.CylinderGeometry(0.045, 0.045, 1.05, 5).translate(Math.cos(a) * railR, G + 0.53, Math.sin(a) * railR));
  }
  const ironMesh = new THREE.Mesh(mergeAll(ironParts), iron);
  const lanternGlass = new THREE.MeshStandardMaterial({
    color: '#1b2a30',
    roughness: 0.06,
    metalness: 0.2,
    transparent: true,
    opacity: 0.42,
    emissive: '#ffd27a',
    emissiveIntensity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const glassMesh = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 2.85, 30, 1, true).translate(0, G + 2.3, 0), lanternGlass);
  glassMesh.renderOrder = 4;

  // The lens: a faceted beehive that glows when lit.
  const lensMat = new THREE.MeshStandardMaterial({ color: '#3a3020', emissive: '#ffe2a0', emissiveIntensity: 0, roughness: 0.1, metalness: 0.5, flatShading: true });
  const lensGeo = mergeAll([
    new THREE.CylinderGeometry(0.85, 0.85, 1.5, 8).translate(0, 0, 0),
    new THREE.ConeGeometry(0.85, 0.6, 8).translate(0, 1.05, 0),
    new THREE.ConeGeometry(0.85, 0.6, 8).rotateX(Math.PI).translate(0, -1.05, 0),
  ]);
  const lensMesh = new THREE.Mesh(lensGeo, lensMat);
  lensMesh.position.y = G + 2.2;

  const tower = new THREE.Group();
  tower.position.copy(base);
  for (const m of [shaft, stoneMesh, dome, ironMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    tower.add(m);
  }
  tower.add(glassMesh, lensMesh);
  group.add(tower);

  // Small windows up the shaft (lit at night).
  const wb = new THREE.Group();
  const glassOverride = { MI_WindowGlass: glass };
  const wins: [number, number][] = [
    [3.6, 0.6],
    [10.4, 2.4],
    [17.2, 4.3],
    [10.4, 5.6],
    [17.2, 1.3],
  ];
  const winMats = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const [yy, ang] of wins) {
    const r = 3.95 - (yy / G) * 0.9;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const m = trs(L.x + dx * (r - 0.05), L.stackTop + yy - 1.0, L.z + dz * (r - 0.05), Math.atan2(dx, dz), 0.8);
    for (const part of kit.get('Window_Thin_Round1').parts) {
      const mat = glassOverride[part.material.name as 'MI_WindowGlass'] ?? part.material;
      let l = winMats.get(mat);
      if (!l) winMats.set(mat, (l = []));
      l.push(part.geometry.clone().applyMatrix4(m));
    }
  }
  for (const [mat, geos] of winMats) wb.add(new THREE.Mesh(mergeAll(geos), mat));
  group.add(wb);

  // Stair bridge from the headland to the gallery.
  const { p0, p1, len, yaw, rise, W, mid, nx, nz } = frame;
  const steps = Math.round(rise / 0.22);
  const bridgeParts: THREE.BufferGeometry[] = [];
  const slope = Math.atan2(rise, len);
  // Sloped soffit slab.
  bridgeParts.push(
    worldBox(len + 1.2, 0.9, W, 0.5)
      .rotateZ(slope)
      .rotateY(yaw)
      .translate(mid.x, mid.y - 0.75, mid.z),
  );
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const sx = p0.x + (p1.x - p0.x) * (t0 + 0.5 / steps);
    const sz = p0.z + (p1.z - p0.z) * (t0 + 0.5 / steps);
    const top = p0.y + rise * ((i + 1) / steps);
    const h = 0.9;
    bridgeParts.push(worldBox(len / steps + 0.02, h, W - 0.5, 0.5).rotateY(yaw).translate(sx, top - h / 2, sz));
  }
  // Parapets.
  for (const side of [-1, 1]) {
    bridgeParts.push(
      worldBox(len + 0.4, 1.0, 0.3, 0.5)
        .rotateZ(slope)
        .rotateY(yaw)
        .translate(mid.x + nx * side * (W / 2 - 0.15), mid.y + 0.35, mid.z + nz * side * (W / 2 - 0.15)),
    );
  }
  // Pier in the channel.
  const pier = p0.clone().lerp(p1, 0.45);
  bridgeParts.push(worldBox(2.4, pier.y + 8, 2.4, 0.5).rotateY(yaw).translate(pier.x, (pier.y - 8) / 2 - 0.9, pier.z));
  const bridge = new THREE.Mesh(mergeAll(bridgeParts), brick);
  bridge.castShadow = bridge.receiveShadow = true;
  group.add(bridge);

  // Beams: two additive cones that sweep the bay.
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uLit: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color('#ffe0a0') } },
    vertexShader: /* glsl */ `
      varying float vT;
      varying vec3 vN;
      varying vec3 vVP;
      varying vec3 vLP;
      void main() {
        vT = 1.0 - uv.y;
        vLP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vVP = mv.xyz;
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${GLSL_NOISE}
      uniform float uLit;
      uniform float uTime;
      uniform vec3 uColor;
      varying float vT;
      varying vec3 vN;
      varying vec3 vVP;
      varying vec3 vLP;
      void main() {
        vec3 v = normalize(-vVP);
        float facing = abs(dot(normalize(vN), v));
        float core = pow(facing, 2.2);
        float along = pow(1.0 - vT, 1.8) * smoothstep(0.0, 0.04, vT);
        float dust = 0.7 + 0.3 * cc_fbm(vec2(vLP.y * 0.05 - uTime * 0.4, atan(vLP.x, vLP.z) * 2.0));
        float nearFade = smoothstep(2.0, 14.0, -vVP.z);
        float a = core * along * dust * nearFade * uLit;
        gl_FragColor = vec4(uColor * a * 1.35, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const coneGeo = new THREE.CylinderGeometry(0.75, 15, 170, 40, 1, true).translate(0, -85, 0).rotateZ(Math.PI / 2);
  const beamPivot = new THREE.Group();
  beamPivot.position.set(L.x, L.stackTop + G + 2.2, L.z);
  const beamA = new THREE.Mesh(coneGeo, beamMat);
  const beamB = new THREE.Mesh(coneGeo, beamMat);
  beamA.rotation.z = -0.035;
  beamB.rotation.set(0, Math.PI, -0.035);
  for (const b of [beamA, beamB]) {
    b.frustumCulled = false;
    b.renderOrder = 6;
    b.visible = false;
    beamPivot.add(b);
  }
  group.add(beamPivot);

  // Lens glow sprite, local light and a sweeping spot.
  const glowMat = new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffd9a0', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  const glow = new THREE.Sprite(glowMat);
  glow.position.copy(beamPivot.position);
  glow.scale.setScalar(9);
  glow.renderOrder = 7;
  glow.visible = false;
  group.add(glow);
  const spot = new THREE.SpotLight('#ffe2a8', 0, 320, 0.11, 0.55, 0.6);
  spot.position.copy(beamPivot.position);
  group.add(spot, spot.target);

  const lens = beamPivot.position.clone();
  let target = 0;
  const camDir = new THREE.Vector3();
  const lh: Lighthouse = {
    group,
    lens,
    beamDir: new THREE.Vector2(1, 0),
    lit: 0,
    phase: 0,
    setLit(on) {
      target = on ? 1 : 0;
    },
    update(dt, elapsed, camera, lamps) {
      // Flicker on, fade off.
      const k = target > lh.lit ? dt * 0.55 : dt * 1.2;
      lh.lit = THREE.MathUtils.clamp(lh.lit + Math.sign(target - lh.lit) * k, 0, 1);
      const flicker = lh.lit < 1 && target === 1 ? 0.75 + 0.25 * Math.sin(elapsed * 37) * Math.sin(elapsed * 11) : 1;
      const lit = lh.lit * flicker;
      const ang = elapsed * 0.42 + lh.phase;
      beamPivot.rotation.y = ang;
      lensMesh.rotation.y = ang;
      lh.beamDir.set(Math.cos(ang), -Math.sin(ang));
      beamMat.uniforms.uLit.value = lit;
      beamMat.uniforms.uTime.value = elapsed;
      beamA.visible = beamB.visible = lit > 0.01;
      lensMat.emissiveIntensity = lit * 9;
      lanternGlass.emissiveIntensity = lit * 1.6;
      spot.intensity = lit * 60;
      spot.target.position.set(lens.x + lh.beamDir.x * 120, 0, lens.z + lh.beamDir.y * 120);
      spot.target.updateMatrixWorld();
      // The glow flares when a beam points at the camera.
      camera.getWorldPosition(camDir).sub(lens);
      const dist = camDir.length();
      camDir.normalize();
      const face = Math.max(Math.abs(camDir.x * lh.beamDir.x + camDir.z * lh.beamDir.y), 0);
      const flare = Math.pow(face, 24);
      glow.visible = lit > 0.01;
      glow.scale.setScalar((7 + 22 * flare) * (0.6 + Math.min(dist, 300) / 300));
      glowMat.opacity = Math.min(1, lit * (0.55 + 0.9 * flare));
      void lamps;
    },
  };
  return lh;
}
