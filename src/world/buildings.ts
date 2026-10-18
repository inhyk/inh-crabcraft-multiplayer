// Clawhaven's buildings, assembled from the Medieval Village MegaKit modules (2 x 3 unit walls,
// gable roofs) and merged per material. Each building also registers its collision box.
import * as THREE from 'three';
import type { Collision } from './collision';
import { type Kit, type StaticBatch, trs } from './kit';
import type { Lot } from './layout';
import { rng } from './noise';

const H = 3; // storey height

export interface LightSpot {
  pos: THREE.Vector3;
  color: number;
  kind: 'window' | 'lamp' | 'fire' | 'candle' | 'glass';
}

export type WallSet = 'plaster' | 'plasterBase' | 'stone' | 'timber';

interface HouseOpts {
  sx: number;
  sz: number;
  floors: number;
  ground: WallSet;
  upper: WallSet;
  /** Ridge direction in local space. */
  ridge: 'x' | 'z';
  doors: { side: Side; index: number; round?: boolean; big?: boolean }[];
  wide: boolean;
  round: boolean;
  shutters: boolean;
  chimney: boolean;
  dormer: boolean;
  /** Leave the front wall of the ground floor open (forge). */
  openFront?: boolean;
  /** Skip the roof (towers get their own). */
  noRoof?: boolean;
  seed: number;
}

type Side = 'front' | 'back' | 'left' | 'right';

const ROOF_LENGTHS: Record<number, number[]> = { 4: [4, 6, 8], 6: [6, 8, 10, 12, 14], 8: [8, 10, 12, 14] };

/**
 * Builds lots twice over the same code: with a batch it places the kit pieces, with a collision it
 * registers each footprint. Either may be null, so colliders can be built without the kit.
 */
export class TownBuilder {
  readonly lights: LightSpot[] = [];
  /** Wall anchors (world) and facing yaw for lanterns beside doors. */
  readonly doorLamps: { pos: THREE.Vector3; yaw: number }[] = [];
  private m = new THREE.Matrix4();
  constructor(
    readonly kit: Kit | null,
    readonly batch: StaticBatch | null,
    readonly col: Collision | null,
    readonly glassOverride: Record<string, THREE.Material>,
  ) {}

  /** Place a piece in building-local coordinates. */
  private put(base: THREE.Matrix4, piece: string, x: number, y: number, z: number, yaw = 0, scale: number | THREE.Vector3 = 1, override?: Record<string, THREE.Material>): void {
    if (!this.batch) return;
    this.m.multiplyMatrices(base, trs(x, y, z, yaw, scale));
    this.batch.add(piece, this.m, { override: override ?? this.glassOverride });
  }

  private sideFrame(side: Side, W: number, D: number): { yaw: number; count: number; at: (i: number) => [number, number] } {
    switch (side) {
      case 'front':
        return { yaw: 0, count: W / 2, at: (i) => [-W / 2 + 1 + 2 * i, D / 2] };
      case 'back':
        return { yaw: Math.PI, count: W / 2, at: (i) => [W / 2 - 1 - 2 * i, -D / 2] };
      case 'left':
        return { yaw: -Math.PI / 2, count: D / 2, at: (i) => [-W / 2, D / 2 - 1 - 2 * i] };
      case 'right':
        return { yaw: Math.PI / 2, count: D / 2, at: (i) => [W / 2, -D / 2 + 1 + 2 * i] };
    }
  }

  house(base: THREE.Matrix4, o: HouseOpts, lotPos: THREE.Vector3): void {
    const r = rng(o.seed);
    const W = o.sx * 2;
    const D = o.sz * 2;
    const sides: Side[] = ['front', 'back', 'left', 'right'];
    for (let f = 0; f < o.floors; f++) {
      const set = f === 0 ? o.ground : o.upper;
      const y = f * H;
      for (const side of sides) {
        const sf = this.sideFrame(side, W, D);
        for (let i = 0; i < sf.count; i++) {
          const [x, z] = sf.at(i);
          const door = f === 0 ? o.doors.find((d) => d.side === side && d.index === i) : undefined;
          if (f === 0 && o.openFront && side === 'front') continue;
          const isGable = (o.ridge === 'z' && (side === 'left' || side === 'right')) || (o.ridge === 'x' && (side === 'front' || side === 'back'));
          let kind: 'door' | 'window' | 'plain' = door ? 'door' : r() < (isGable ? 0.55 : 0.7) ? 'window' : 'plain';
          if (set === 'timber' && kind === 'plain') kind = r() < 0.5 ? 'plain' : 'window';
          this.wall(base, set, kind, x, y, z, sf.yaw, o, r, door);
        }
      }
      // Corner posts.
      for (const [cx, cz, cy] of [
        [-W / 2, D / 2, 0],
        [W / 2, D / 2, Math.PI / 2],
        [W / 2, -D / 2, Math.PI],
        [-W / 2, -D / 2, -Math.PI / 2],
      ]) {
        // Stone corners use the light wooden post scaled up (the brick corner piece is 3k triangles).
        if (set === 'stone') this.put(base, 'Corner_ExteriorWide_Wood', cx, y, cz, cy, new THREE.Vector3(1.5, 1, 1.5));
        else this.put(base, 'Corner_Exterior_Wood', cx, y, cz, cy);
      }
      // Beam trim between storeys.
      if (f > 0) {
        for (const side of sides) {
          const sf = this.sideFrame(side, W, D);
          for (let i = 0; i < sf.count; i++) {
            const [x, z] = sf.at(i);
            this.put(base, 'Wall_BottomCover', x, y, z, sf.yaw);
          }
        }
      }
    }
    const top = o.floors * H;
    if (!o.noRoof) this.roof(base, W, D, top, o, r);
    // Collision: the whole footprint.
    const yaw = new THREE.Euler().setFromRotationMatrix(base).y;
    this.col?.addBox(lotPos.x, lotPos.z, W / 2 + 0.15, D / 2 + 0.15, yaw, lotPos.y - 2, lotPos.y + top + 6);
  }

  private wall(
    base: THREE.Matrix4,
    set: WallSet,
    kind: 'door' | 'window' | 'plain',
    x: number,
    y: number,
    z: number,
    yaw: number,
    o: HouseOpts,
    r: () => number,
    door?: { round?: boolean; big?: boolean },
  ): void {
    const stone = set === 'stone';
    const prefix = stone ? 'Wall_UnevenBrick' : 'Wall_Plaster';
    if (kind === 'door') {
      const round = door?.round ?? o.round;
      this.put(base, `${prefix}_Door_${round ? 'Round' : 'Flat'}`, x, y, z, yaw);
      const doorPiece = door?.big ? `Door_8_${round ? 'Round' : 'Flat'}` : r() < 0.5 ? `Door_1_${round ? 'Round' : 'Flat'}` : `Door_4_${round ? 'Round' : 'Flat'}`;
      // Doors hinge at their local x = 0; centre them in the opening.
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const ox = -0.55;
      const oz = -0.12;
      this.put(base, doorPiece, x + c * ox + s * oz, y, z - s * ox + c * oz, yaw);
      this.put(base, `DoorFrame_${round ? 'Round' : 'Flat'}_${stone ? 'Brick' : 'WoodDark'}`, x, y, z, yaw);
      // Wall lantern beside the door.
      const anchor = new THREE.Vector3(x + c * 1.0 + s * 0.1, y + 1.55, z - s * 1.0 + c * 0.1).applyMatrix4(base);
      const wyaw = yaw + new THREE.Euler().setFromRotationMatrix(base).y;
      this.doorLamps.push({ pos: anchor, yaw: wyaw });
      return;
    }
    if (kind === 'plain') {
      const piece = stone ? 'Wall_UnevenBrick_Straight' : set === 'timber' ? 'Wall_Plaster_WoodGrid' : set === 'plasterBase' && y === 0 ? 'Wall_Plaster_Straight_Base' : 'Wall_Plaster_Straight';
      this.put(base, piece, x, y, z, yaw);
      return;
    }
    const wide = o.wide ? r() < 0.75 : r() < 0.3;
    const round = o.round ? r() < 0.8 : r() < 0.2;
    let wallPiece: string;
    let win: string;
    let shut: string;
    if (wide) {
      wallPiece = `${prefix}_Window_Wide_${round ? 'Round' : 'Flat'}`;
      win = `Window_Wide_${round ? 'Round' : 'Flat'}1`;
      shut = `WindowShutters_Wide_${round ? 'Round' : 'Flat'}_${r() < 0.6 ? 'Open' : 'Closed'}`;
    } else {
      wallPiece = `${prefix}_Window_Thin_Round`;
      win = 'Window_Thin_Round1';
      shut = `WindowShutters_Thin_Round_${r() < 0.6 ? 'Open' : 'Closed'}`;
    }
    this.put(base, wallPiece, x, y, z, yaw);
    this.put(base, win, x, y, z, yaw);
    if (o.shutters && r() < 0.6) this.put(base, shut, x, y, z, yaw);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const p = new THREE.Vector3(x + s * 0.4, y + 1.8, z + c * 0.4).applyMatrix4(base);
    this.lights.push({ pos: p, color: 0xffa040, kind: 'window' });
  }

  private roof(base: THREE.Matrix4, W: number, D: number, top: number, o: HouseOpts, r: () => number): void {
    const span = o.ridge === 'z' ? W : D;
    const len = o.ridge === 'z' ? D : W;
    const lens = ROOF_LENGTHS[span];
    if (!lens) return;
    const L = lens.reduce((a, b) => (Math.abs(b - len) < Math.abs(a - len) ? b : a));
    const rotY = o.ridge === 'z' ? 0 : Math.PI / 2;
    const scaleLen = len / L;
    const scale = o.ridge === 'z' ? new THREE.Vector3(1, 1, scaleLen) : new THREE.Vector3(1, 1, scaleLen);
    this.put(base, `Roof_RoundTiles_${span}x${L}`, 0, top, 0, rotY, scale);
    // Gable walls at both ridge ends.
    const gable = `Roof_Front_Brick${span}`;
    if (o.ridge === 'z') {
      this.put(base, gable, 0, top, D / 2, 0);
      this.put(base, gable, 0, top, -D / 2, Math.PI);
    } else {
      this.put(base, gable, W / 2, top, 0, Math.PI / 2);
      this.put(base, gable, -W / 2, top, 0, -Math.PI / 2);
    }
    if (o.chimney) {
      const along = (r() - 0.5) * (len - 2.5);
      const cx = o.ridge === 'z' ? span / 2 - 1.1 : along;
      const cz = o.ridge === 'z' ? along : span / 2 - 1.1;
      this.put(base, r() < 0.5 ? 'Prop_Chimney' : 'Prop_Chimney2', cx, top + 0.6, cz, 0, new THREE.Vector3(1, 1.25 + span * 0.08, 1));
    }
    if (o.dormer && len >= 6) {
      const dz = (r() - 0.5) * (len - 4);
      if (o.ridge === 'z') this.put(base, 'Roof_Dormer_RoundTile', span / 2 - 1.95, top + 0.95, dz, 0);
      else this.put(base, 'Roof_Dormer_RoundTile', dz, top + 0.95, span / 2 - 1.95, -Math.PI / 2);
    }
  }

  /** Lot-level dispatch. */
  build(lot: Lot): void {
    const base = trs(lot.x, lot.h, lot.z, lot.yaw);
    const pos = new THREE.Vector3(lot.x, lot.h, lot.z);
    const styles: [WallSet, WallSet][] = [
      ['stone', 'timber'],
      ['plasterBase', 'timber'],
      ['stone', 'plaster'],
      ['plasterBase', 'plaster'],
    ];
    const [g, u] = styles[lot.style % styles.length];
    const seed = Math.abs(Math.round(lot.x * 31 + lot.z * 17)) + 3;
    switch (lot.kind) {
      case 'house':
      case 'cottage':
      case 'hut': {
        const ridge = lot.sx >= lot.sz ? 'x' : 'z';
        this.house(
          base,
          {
            sx: lot.sx,
            sz: lot.sz,
            floors: lot.floors,
            ground: lot.kind === 'hut' ? 'plaster' : g,
            upper: u,
            ridge: lot.sx === lot.sz ? (seed % 2 ? 'x' : 'z') : ridge,
            doors: [{ side: 'front', index: Math.floor((lot.sx - 1) / 2) }],
            wide: seed % 3 !== 0,
            round: seed % 2 === 0,
            shutters: true,
            chimney: lot.kind !== 'hut',
            dormer: lot.floors > 1 && seed % 2 === 1,
            seed,
          },
          pos,
        );
        break;
      }
      case 'tavern':
        this.house(
          base,
          {
            sx: lot.sx,
            sz: lot.sz,
            floors: 2,
            ground: 'stone',
            upper: 'timber',
            ridge: 'z',
            doors: [{ side: 'front', index: 1, round: true, big: true }],
            wide: true,
            round: true,
            shutters: true,
            chimney: true,
            dormer: true,
            seed: 11,
          },
          pos,
        );
        // Balcony across the upper front.
        for (let i = 0; i < lot.sx; i++) {
          const x = -lot.sx + 1 + 2 * i;
          this.put(base, 'Balcony_Cross_Straight', x, H, lot.sz, 0);
          this.put(base, 'Floor_WoodDark', x, H - 0.02, lot.sz + 1, 0);
        }
        for (const x of [-lot.sx + 0.15, lot.sx - 0.15]) this.put(base, 'Prop_Support', x, 0, lot.sz - 0.05, 0);
        break;
      case 'chapel':
        this.chapel(base, lot, pos);
        break;
      case 'forge':
        this.forge(base, lot, pos);
        break;
      case 'gatetower':
        this.house(
          base,
          {
            sx: 2,
            sz: 2,
            floors: 2,
            ground: 'stone',
            upper: 'stone',
            ridge: 'z',
            doors: [],
            wide: false,
            round: true,
            shutters: false,
            chimney: false,
            dormer: false,
            noRoof: true,
            seed: 5,
          },
          pos,
        );
        this.put(base, 'Roof_Tower_RoundTiles', 0, 2 * H, 0, 0, 0.82);
        break;
    }
  }

  private chapel(base: THREE.Matrix4, lot: Lot, pos: THREE.Vector3): void {
    // Nave: stone walls with tall arched windows (stained glass), big round door at the front.
    this.house(
      base,
      {
        sx: lot.sx,
        sz: lot.sz,
        floors: 2,
        ground: 'stone',
        upper: 'stone',
        ridge: 'z',
        doors: [{ side: 'front', index: 1, round: true, big: true }],
        wide: false,
        round: true,
        shutters: false,
        chimney: false,
        dormer: false,
        seed: 21,
      },
      pos,
    );
    // Bell tower at the back-right corner.
    const tx = lot.sx + 2;
    const tz = lot.sz - 2;
    const tb = new THREE.Matrix4().multiplyMatrices(base, trs(tx, 0, tz, 0));
    const tp = new THREE.Vector3(tx, 0, tz).applyMatrix4(base);
    this.house(
      tb,
      {
        sx: 2,
        sz: 2,
        floors: 4,
        ground: 'stone',
        upper: 'stone',
        ridge: 'z',
        doors: [],
        wide: false,
        round: true,
        shutters: false,
        chimney: false,
        dormer: false,
        noRoof: true,
        seed: 23,
      },
      tp,
    );
    this.put(tb, 'Roof_Tower_RoundTiles', 0, 4 * H, 0, 0, 0.85);
    // Steps up to the door.
    for (let i = 0; i < 2; i++) this.put(base, 'Stairs_Exterior_Straight', -1 + 2 * i, -0.65, lot.sz * 2 + 1.05, 0, new THREE.Vector3(1, 0.65, 1));
  }

  private forge(base: THREE.Matrix4, lot: Lot, pos: THREE.Vector3): void {
    // Stone smithy, open at the front under a deep roof on posts.
    this.house(
      base,
      {
        sx: lot.sx,
        sz: lot.sz,
        floors: 1,
        ground: 'stone',
        upper: 'stone',
        ridge: 'x',
        doors: [],
        wide: true,
        round: false,
        shutters: false,
        chimney: false,
        dormer: false,
        openFront: true,
        seed: 31,
      },
      pos,
    );
    for (let i = 1; i < lot.sx; i++) this.put(base, 'Corner_Exterior_Wood', -lot.sx + i * 2, 0, lot.sz, 0, new THREE.Vector3(1.6, 1, 1.6));
    // Big forge chimney on the back wall.
    this.put(base, 'Prop_Chimney', lot.sx - 2.5, 0, -lot.sz + 0.2, 0, new THREE.Vector3(2.1, 3.0, 1.8));
  }
}
