import type { EnemyKind } from './entities';

export const TILE = 32;

// Tile legend:
// # — ground, B — brick, ? — coin block, M — power-up block (looks like ?),
// X — used block, = — platform, o — coin,
// E — ground enemy (kind depends on biome), V — flying enemy,
// P — player start, F — finish flag

const HEIGHT = 20;
const START_GY = 16; // ground height at the start
const MIN_GY = 11; // highest ground
const MAX_GY = 17; // lowest ground

// Jump limits (JUMP_SPEED=840, GRAVITY=2000): height ~5.5 tiles,
// horizontal reach ~7 tiles. The generator must not exceed them.
const MAX_PIT = 4;

export type Biome = 'grass' | 'desert' | 'snow' | 'cave';

const BIOMES: Biome[] = ['grass', 'desert', 'snow', 'cave'];

// Ground enemies per biome. Each biome has an exclusive kind that appears
// nowhere else: turtle — meadows, spike — desert, hopper — snow, giant — caves.
// Walker and flyer are shared, but coloured differently.
const GROUND_KINDS: Record<Biome, EnemyKind[]> = {
  grass: ['walker', 'walker', 'turtle', 'turtle'],
  desert: ['walker', 'spiky', 'spiky', 'walker'],
  snow: ['walker', 'hopper', 'hopper', 'walker'],
  cave: ['walker', 'giant', 'walker', 'giant'],
};

function rint(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function chance(p: number): boolean {
  return Math.random() < p;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generate(): string[][] {
  const width = rint(150, 200);
  const g: string[][] = Array.from({ length: HEIGHT }, () => Array<string>(width).fill(' '));
  const set = (x: number, y: number, c: string) => {
    if (x >= 0 && x < width && y >= 0 && y < HEIGHT) g[y][x] = c;
  };

  let gy = START_GY; // current ground height (changes along the level)
  const ground = (x: number) => {
    for (let y = gy; y < HEIGHT; y++) set(x, y, '#');
  };

  // starting platform without enemies
  for (let x = 0; x < 8; x++) ground(x);
  set(2, gy - 1, 'P');

  let x = 8;
  const endZone = width - 12;
  let prevPit = false;

  while (x < endZone) {
    // terrain change: rise no more than 2 tiles (1 after a pit), descent any amount
    if (chance(0.35)) {
      const maxRise = prevPit ? 1 : 2;
      const dy = pick([-2, -1, -1, 1, 1, 2]);
      gy = Math.min(MAX_GY, Math.max(MIN_GY, gy - Math.min(dy, maxRise)));
    }
    prevPit = false;

    // flat stretch between features
    const flatLen = rint(2, 5);
    for (let i = 0; i < flatLen && x < endZone; i++, x++) {
      ground(x);
      if (chance(0.1)) set(x, gy - 1, 'E');
    }
    if (x >= endZone) break;

    const r = Math.random();
    if (r < 0.15) {
      // pit
      const w = rint(2, MAX_PIT);
      if (w >= 3 && chance(0.4)) {
        // over a wide pit — coins as a hint for the trajectory
        for (let i = 0; i < w; i++) set(x + i, gy - 3, 'o');
      }
      if (chance(0.2)) set(x + 1, gy - 5, 'V');
      x += w;
      prevPit = true;
    } else if (r < 0.35) {
      // row of bricks and blocks at head-bump height
      const len = rint(3, 5);
      const y = gy - 4;
      for (let i = 0; i < len; i++) {
        ground(x + i);
        const roll = Math.random();
        set(x + i, y, roll < 0.12 ? 'M' : roll < 0.45 ? '?' : 'B');
        if (chance(0.3)) set(x + i, y - 2, 'o');
      }
      if (chance(0.5)) set(x + rint(0, len - 1), gy - 1, 'E');
      x += len;
    } else if (r < 0.5) {
      // floating platforms in a staircase with coins
      const steps = rint(2, 3);
      let py = gy - rint(3, 4);
      if (chance(0.25)) set(x, Math.max(2, py - 3), 'V');
      for (let s = 0; s < steps; s++) {
        const len = rint(3, 4);
        for (let i = 0; i < len; i++) {
          ground(x);
          set(x, py, '=');
          if (chance(0.6)) set(x, py - 2, 'o');
          x++;
        }
        x += 1;
        ground(x - 1);
        py = Math.max(3, py - rint(2, 3)); // next one higher, but within jump range
      }
    } else if (r < 0.67) {
      // fork: lower path on the ground with enemies, upper path on platforms with coins
      const len = rint(12, 18);
      const upY = Math.max(3, gy - rint(5, 6));
      ground(x);
      set(x, gy - 3, '='); // step up to the top
      x++;
      let i = 0;
      while (i < len && x < endZone) {
        const run = rint(3, 5);
        for (let k = 0; k < run && i < len; k++, i++, x++) {
          ground(x);
          set(x, upY, '=');
          if (chance(0.5)) set(x, upY - 2, 'o');
          if (k === 1 && chance(0.35)) set(x, gy - 1, 'E');
        }
        // gap in both routes: above — a jump between platforms,
        // below — sometimes a small pit
        const gap = rint(1, 2);
        const pitBelow = chance(0.4);
        for (let k = 0; k < gap && i < len; k++, i++, x++) {
          if (!pitBelow) ground(x);
        }
      }
      // descent from the upper path
      ground(x);
      set(x, gy - 3, '=');
      x++;
    } else if (r < 0.84) {
      // little brick pyramid
      const h = rint(2, 3);
      for (let s = 1; s <= h; s++) {
        ground(x);
        for (let k = 0; k < s; k++) set(x, gy - 1 - k, 'B');
        x++;
      }
      if (chance(0.5)) set(x - 1, gy - 1 - h - 1, 'o');
      for (let s = h; s >= 1; s--) {
        ground(x);
        for (let k = 0; k < s; k++) set(x, gy - 1 - k, 'B');
        x++;
      }
    } else {
      // a trail of coins above the ground
      const len = rint(3, 5);
      const y = gy - rint(2, 3);
      if (chance(0.3)) set(x + 1, gy - 6, 'V');
      for (let i = 0; i < len; i++) {
        ground(x);
        set(x, y, 'o');
        x++;
      }
    }
  }

  // finish zone: flat ground and a flag
  for (; x < width; x++) ground(x);
  const fx = width - 4;
  for (let y = Math.max(1, gy - 8); y < gy; y++) set(fx, y, 'F');

  // guarantee at least one power-up block on the level
  if (!g.some((row) => row.includes('M'))) {
    let converted = false;
    for (const row of g) {
      const i = row.indexOf('?');
      if (i >= 0) {
        row[i] = 'M';
        converted = true;
        break;
      }
    }
    if (!converted) set(5, START_GY - 4, 'M');
  }

  return g;
}

export type Spawn =
  | { type: 'player' | 'coin'; x: number; y: number }
  | { type: 'enemy'; x: number; y: number; kind: EnemyKind };

// Serializable snapshot of a level — the host sends it to a guest at start.
export interface LevelData {
  biome: Biome;
  rows: string[]; // tiles by row (after spawn extraction)
  spawns: Spawn[];
}

export class Level {
  readonly width: number;
  readonly height = HEIGHT;
  readonly biome: Biome;
  readonly spawns: Spawn[] = [];
  private tiles: string[][];

  constructor(data?: LevelData) {
    // restore-from-network branch: the level was already generated by the host
    if (data) {
      this.biome = data.biome;
      this.tiles = data.rows.map((r) => [...r]);
      this.width = this.tiles[0].length;
      this.spawns = data.spawns;
      return;
    }

    this.biome = pick(BIOMES);
    this.tiles = generate();
    this.width = this.tiles[0].length;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.tiles[y][x];
        const px = x * TILE;
        const py = y * TILE;
        if (c === 'P') {
          this.spawns.push({ type: 'player', x: px, y: py });
          this.tiles[y][x] = ' ';
        } else if (c === 'E') {
          this.spawns.push({ type: 'enemy', x: px, y: py, kind: pick(GROUND_KINDS[this.biome]) });
          this.tiles[y][x] = ' ';
        } else if (c === 'V') {
          this.spawns.push({ type: 'enemy', x: px, y: py, kind: 'flyer' });
          this.tiles[y][x] = ' ';
        } else if (c === 'o') {
          this.spawns.push({ type: 'coin', x: px + TILE / 2, y: py + TILE / 2 });
          this.tiles[y][x] = ' ';
        }
      }
    }
  }

  get pixelWidth(): number {
    return this.width * TILE;
  }

  get pixelHeight(): number {
    return this.height * TILE;
  }

  tileAt(tx: number, ty: number): string {
    if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) return ' ';
    return this.tiles[ty][tx];
  }

  isSolid(tx: number, ty: number): boolean {
    return '#B?MX='.includes(this.tileAt(tx, ty)) && this.tileAt(tx, ty) !== ' ';
  }

  setTile(tx: number, ty: number, c: string): void {
    if (tx >= 0 && tx < this.width && ty >= 0 && ty < this.height) {
      this.tiles[ty][tx] = c;
    }
  }

  serialize(): LevelData {
    return {
      biome: this.biome,
      rows: this.tiles.map((r) => r.join('')),
      spawns: this.spawns,
    };
  }

  static deserialize(data: LevelData): Level {
    return new Level(data);
  }
}
