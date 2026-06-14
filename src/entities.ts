import { EMPTY_INPUT, InputState } from './input';
import { Level, TILE } from './level';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Moves a body across the tile grid, X and Y axes separately. */
export function moveBody(
  body: Rect & { vx: number; vy: number },
  level: Level,
  dt: number,
): { onGround: boolean; hitHead: { tx: number; ty: number } | null; hitWall: boolean } {
  let onGround = false;
  let hitHead: { tx: number; ty: number } | null = null;
  let hitWall = false;

  // X
  body.x += body.vx * dt;
  {
    const top = Math.floor(body.y / TILE);
    const bottom = Math.floor((body.y + body.h - 1) / TILE);
    if (body.vx > 0) {
      const tx = Math.floor((body.x + body.w) / TILE);
      for (let ty = top; ty <= bottom; ty++) {
        if (level.isSolid(tx, ty)) {
          body.x = tx * TILE - body.w;
          body.vx = 0;
          hitWall = true;
          break;
        }
      }
    } else if (body.vx < 0) {
      const tx = Math.floor(body.x / TILE);
      for (let ty = top; ty <= bottom; ty++) {
        if (level.isSolid(tx, ty)) {
          body.x = (tx + 1) * TILE;
          body.vx = 0;
          hitWall = true;
          break;
        }
      }
    }
  }

  // Y
  body.y += body.vy * dt;
  {
    const left = Math.floor(body.x / TILE);
    const right = Math.floor((body.x + body.w - 1) / TILE);
    if (body.vy > 0) {
      const ty = Math.floor((body.y + body.h) / TILE);
      for (let tx = left; tx <= right; tx++) {
        if (level.isSolid(tx, ty)) {
          body.y = ty * TILE - body.h;
          body.vy = 0;
          onGround = true;
          break;
        }
      }
    } else if (body.vy < 0) {
      const ty = Math.floor(body.y / TILE);
      // find the block nearest to the head's centre — for hitting a '?'
      let best: { tx: number; ty: number } | null = null;
      let bestDist = Infinity;
      const cx = body.x + body.w / 2;
      for (let tx = left; tx <= right; tx++) {
        if (level.isSolid(tx, ty)) {
          const dist = Math.abs((tx + 0.5) * TILE - cx);
          if (dist < bestDist) {
            bestDist = dist;
            best = { tx, ty };
          }
        }
      }
      if (best) {
        body.y = (best.ty + 1) * TILE;
        body.vy = 0;
        hitHead = best;
      }
    }
  }

  return { onGround, hitHead, hitWall };
}

// ---------- enemies ----------

export type EnemyKind = 'walker' | 'turtle' | 'spiky' | 'flyer' | 'hopper' | 'giant';

export const ENEMY_INFO: Record<
  EnemyKind,
  { w: number; h: number; speed: number; score: number; hp: number }
> = {
  walker: { w: 26, h: 24, speed: 60, score: 200, hp: 1 },
  turtle: { w: 28, h: 26, speed: 110, score: 300, hp: 1 }, // fast, not afraid of ledges
  spiky: { w: 28, h: 22, speed: 50, score: 400, hp: 1 }, // can't be jumped on from above
  flyer: { w: 28, h: 20, speed: 70, score: 300, hp: 1 }, // flies in a sine wave
  hopper: { w: 24, h: 26, speed: 90, score: 300, hp: 1 }, // jumps toward the player
  giant: { w: 42, h: 38, speed: 40, score: 500, hp: 2 }, // needs two stomps from above
};

export class Enemy {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy = 0;
  alive = true;
  squashTimer = 0; // how long to show the 'squashed' enemy
  hp: number;
  phase = Math.random() * Math.PI * 2; // animation/flight phase
  baseY = 0; // flight axis of the flyer
  jumpTimer = 1; // pause between the hopper's jumps
  hurtFlash = 0; // giant's highlight after the first hit
  hidden = false; // guest-only: locally predicted dead (a stomp not yet confirmed by the host)

  constructor(
    x: number,
    y: number,
    public kind: EnemyKind,
  ) {
    const info = ENEMY_INFO[kind];
    this.w = info.w;
    this.h = info.h;
    this.hp = info.hp;
    this.x = x + (TILE - this.w) / 2;
    if (kind === 'flyer') {
      this.y = y + (TILE - this.h) / 2;
      this.baseY = this.y;
      this.vx = -info.speed;
    } else {
      this.y = y + TILE - this.h;
      this.vx = kind === 'hopper' ? 0 : -info.speed;
    }
  }

  get rect(): Rect {
    return this;
  }
}

// ---------- power-ups ----------

export type PowerUpKind = 'mushroom' | 'sunflower';

export class PowerUp {
  x: number;
  y: number;
  w = 24;
  h = 24;
  vx = 0;
  vy = 0;
  emerging = true; // rising out of the block
  dead = false;
  readonly targetY: number;

  constructor(
    tx: number,
    ty: number,
    public kind: PowerUpKind,
  ) {
    this.x = tx * TILE + (TILE - this.w) / 2;
    this.y = ty * TILE - 6;
    this.targetY = ty * TILE - this.h;
  }

  get rect(): Rect {
    return this;
  }
}

export class Fireball {
  w = 10;
  h = 10;
  vy = 0;
  dead = false;
  life = 2.5;

  constructor(
    public x: number,
    public y: number,
    public vx: number,
  ) {}

  get rect(): Rect {
    return this;
  }
}

// ---------- player ----------

export class Player {
  x = 0;
  y = 0;
  w = 22;
  h = 26;
  vx = 0;
  vy = 0;
  onGround = false;
  facing: 1 | -1 = 1;
  coyote = 0; // time after leaving the ground during which a jump is still allowed
  jumpBuffer = 0; // time after pressing jump during which it still fires
  invuln = 0; // invulnerability after taking damage
  runTime = 0; // for the leg animation
  power: 0 | 1 | 2 = 0; // 0 — small, 1 — mushroom, 2 — sunflower
  fireCooldown = 0;

  // the player's intent this frame (set by the driver: keyboard or network)
  input: InputState = { ...EMPTY_INPUT };
  dead = false; // died, respawn countdown is running
  out = false; // out of lives — eliminated for good
  respawnTimer = 0;

  constructor(public readonly id = 0) {}

  setPower(n: 0 | 1 | 2): void {
    const oldH = this.h;
    this.power = n;
    this.w = n > 0 ? 26 : 22;
    this.h = n > 0 ? 40 : 26;
    this.y -= this.h - oldH; // keep the feet in place
  }

  get rect(): Rect {
    return this;
  }
}

export class Coin {
  taken = false;
  constructor(
    public x: number,
    public y: number,
  ) {}

  get rect(): Rect {
    return { x: this.x - 10, y: this.y - 10, w: 20, h: 20 };
  }
}

export class Particle {
  life = 0.5;
  constructor(
    public x: number,
    public y: number,
    public vx: number,
    public vy: number,
    public color: string,
  ) {}
}
