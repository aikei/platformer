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

/** Перемещает тело по сетке тайлов, ось X и Y отдельно. */
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
      // ищем блок ближе всего к центру головы — для удара по «?»
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

// ---------- враги ----------

export type EnemyKind = 'walker' | 'turtle' | 'spiky' | 'flyer' | 'hopper' | 'giant';

export const ENEMY_INFO: Record<
  EnemyKind,
  { w: number; h: number; speed: number; score: number; hp: number }
> = {
  walker: { w: 26, h: 24, speed: 60, score: 200, hp: 1 },
  turtle: { w: 28, h: 26, speed: 110, score: 300, hp: 1 }, // быстрая, не боится обрывов
  spiky: { w: 28, h: 22, speed: 50, score: 400, hp: 1 }, // нельзя прыгать сверху
  flyer: { w: 28, h: 20, speed: 70, score: 300, hp: 1 }, // летает синусоидой
  hopper: { w: 24, h: 26, speed: 90, score: 300, hp: 1 }, // прыгает в сторону игрока
  giant: { w: 42, h: 38, speed: 40, score: 500, hp: 2 }, // нужно два прыжка сверху
};

export class Enemy {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy = 0;
  alive = true;
  squashTimer = 0; // время показа «раздавленного» врага
  hp: number;
  phase = Math.random() * Math.PI * 2; // фаза анимации/полёта
  baseY = 0; // ось полёта летуна
  jumpTimer = 1; // пауза между прыжками прыгуна
  hurtFlash = 0; // подсветка гиганта после первого удара

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

// ---------- бонусы ----------

export type PowerUpKind = 'mushroom' | 'sunflower';

export class PowerUp {
  x: number;
  y: number;
  w = 24;
  h = 24;
  vx = 0;
  vy = 0;
  emerging = true; // вылезает из блока
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

// ---------- игрок ----------

export class Player {
  x = 0;
  y = 0;
  w = 22;
  h = 26;
  vx = 0;
  vy = 0;
  onGround = false;
  facing: 1 | -1 = 1;
  coyote = 0; // время после схода с земли, когда ещё можно прыгнуть
  jumpBuffer = 0; // время после нажатия прыжка, когда он ещё сработает
  invuln = 0; // неуязвимость после урона
  runTime = 0; // для анимации ног
  power: 0 | 1 | 2 = 0; // 0 — маленький, 1 — гриб, 2 — подсолнух
  fireCooldown = 0;

  setPower(n: 0 | 1 | 2): void {
    const oldH = this.h;
    this.power = n;
    this.w = n > 0 ? 26 : 22;
    this.h = n > 0 ? 40 : 26;
    this.y -= this.h - oldH; // ноги остаются на месте
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
