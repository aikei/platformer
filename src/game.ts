import { AudioSys, SoundName } from './audio';
import {
  Coin,
  Enemy,
  ENEMY_INFO,
  EnemyKind,
  Fireball,
  moveBody,
  overlaps,
  Particle,
  Player,
  PowerUp,
} from './entities';
import { Input } from './input';
import { Biome, Level, LevelData, TILE } from './level';
import { Snapshot, TileChange } from './protocol';

const GRAVITY = 2000;
const MAX_FALL = 900;
const MOVE_ACCEL = 2400;
const MOVE_DECEL = 2800;
const MAX_SPEED = 300;
const JUMP_SPEED = 840;
const COYOTE_TIME = 0.1;
const JUMP_BUFFER = 0.12;
const STOMP_BOUNCE = 600;

type GameState = 'playing' | 'gameover' | 'won';

type Palette = {
  name: string;
  skyTop: string;
  skyBot: string;
  ground: string;
  groundDark: string;
  top: string;
  topLight: string;
  hill: string;
  cloud: string;
};

const PALETTES: Record<Biome, Palette> = {
  grass: {
    name: 'MEADOWS',
    skyTop: '#4fa4e8',
    skyBot: '#a8d8f0',
    ground: '#8b5a2b',
    groundDark: 'rgba(0,0,0,0.12)',
    top: '#3fa34d',
    topLight: '#57c267',
    hill: '#7ec87e',
    cloud: 'rgba(255,255,255,0.9)',
  },
  desert: {
    name: 'DESERT',
    skyTop: '#f5a623',
    skyBot: '#ffe3a3',
    ground: '#c8964e',
    groundDark: 'rgba(120,70,10,0.18)',
    top: '#e8c478',
    topLight: '#f4dba0',
    hill: '#d8ab63',
    cloud: 'rgba(255,255,255,0.5)',
  },
  snow: {
    name: 'SNOW',
    skyTop: '#7d97c0',
    skyBot: '#dfe9f5',
    ground: '#7a7263',
    groundDark: 'rgba(0,0,30,0.15)',
    top: '#f5f9ff',
    topLight: '#ffffff',
    hill: '#b8c8de',
    cloud: 'rgba(255,255,255,0.95)',
  },
  cave: {
    name: 'CAVES',
    skyTop: '#170f23',
    skyBot: '#392252',
    ground: '#56566c',
    groundDark: 'rgba(0,0,0,0.25)',
    top: '#7b7b94',
    topLight: '#9090aa',
    hill: '#241a38',
    cloud: 'rgba(160,120,230,0.16)',
  },
};

// player outfits — to tell them apart on one screen (cap/overalls)
const PLAYER_SKINS = [
  { overalls: '#2962ff', cap: '#e63946', arm: '#e63946' }, // P1 — blue/red (classic)
  { overalls: '#2e7d32', cap: '#1b5e20', arm: '#2e7d32' }, // P2 — green
  { overalls: '#6a1b9a', cap: '#ad1457', arm: '#6a1b9a' }, // P3 — purple
  { overalls: '#00838f', cap: '#ff6f00', arm: '#00838f' }, // P4 — teal
];

// base colours of the exclusive species: turtle (meadows), cactus-spike (desert),
// ice hopper (snow), giant (caves)
const ENEMY_BODY: Record<EnemyKind, string> = {
  walker: '#8b4513',
  turtle: '#2e7d32',
  spiky: '#388e3c',
  flyer: '#42a5f5',
  hopper: '#4fc3f7',
  giant: '#512da8',
};

// shared species (walker and flyer) are coloured differently in each biome
const BIOME_SKINS: Record<Biome, Partial<Record<EnemyKind, string>>> = {
  grass: { walker: '#8b4513', flyer: '#42a5f5' },
  desert: { walker: '#c98f3d', flyer: '#bf360c' },
  snow: { walker: '#90a4ae', flyer: '#cfe8f7' },
  cave: { walker: '#6a4fb3', flyer: '#7e57c2' },
};

export class Game {
  private level = new Level();
  private players: Player[];
  private enemies: Enemy[] = [];
  private coins: Coin[] = [];
  private powerups: PowerUp[] = [];
  private fireballs: Fireball[] = [];
  private particles: Particle[] = [];
  private camX = 0;
  private camY = 0;
  private score = 0;
  private coinCount = 0;
  private lives = 3;
  private state: GameState = 'playing';
  private spawnPoint = { x: 64, y: 0 };
  private time = 0;
  private cameraFocus: number | 'all' = 'all'; // player id for the camera; 'all' — midpoint between everyone
  private pendingTiles: TileChange[] = []; // tile changes not yet sent to guests
  private pendingSounds: SoundName[] = []; // sounds from this frame not yet sent to guests
  private _epoch = 0; // increments on each new level generation (to re-init guests)

  constructor(
    private ctx: CanvasRenderingContext2D,
    private input: Input,
    private audio: AudioSys,
    playerCount = 1,
  ) {
    this.players = Array.from({ length: Math.max(1, playerCount) }, (_, i) => new Player(i));
    this.resetLevel();
  }

  /** Access to players for the input driver (main loop / network). */
  get roster(): readonly Player[] {
    return this.players;
  }

  private resetLevel(): void {
    this._epoch++;
    this.level = new Level();
    this.coins = [];
    this.pendingTiles = [];
    this.pendingSounds = [];
    this.audio.setBiome(this.level.biome);
    this.enemies = [];
    this.powerups = [];
    this.fireballs = [];
    this.particles = [];
    for (const s of this.level.spawns) {
      if (s.type === 'player') this.spawnPoint = { x: s.x + 4, y: s.y };
      else if (s.type === 'enemy') this.enemies.push(new Enemy(s.x, s.y, s.kind));
      else if (s.type === 'coin') this.coins.push(new Coin(s.x, s.y));
    }
    for (const p of this.players) {
      p.out = false;
      this.placePlayer(p);
    }
    this.state = 'playing';
  }

  /** Places a player at the spawn point (offset so they don't overlap). */
  private placePlayer(p: Player): void {
    p.setPower(0);
    p.x = this.spawnPoint.x + p.id * 24;
    p.y = this.spawnPoint.y;
    p.vx = 0;
    p.vy = 0;
    p.onGround = false;
    p.invuln = 1.5;
    p.dead = false;
    p.respawnTimer = 0;
  }

  restart(): void {
    this.score = 0;
    this.coinCount = 0;
    this.lives = 3;
    this.resetLevel();
  }

  // ---------- network interface ----------

  /** What the camera follows: own player id (network) or 'all' (shared screen). */
  setCameraFocus(focus: number | 'all'): void {
    this.cameraFocus = focus;
  }

  /** Increments on each new level generation — how the host knows to re-init guests. */
  get epoch(): number {
    return this._epoch;
  }

  /** Serialized level to send to a guest. */
  levelData(): LevelData {
    return this.level.serialize();
  }

  /** Guest: accept the level from the host (no local generation). */
  loadLevel(level: Level): void {
    this.level = level;
    this.audio.setBiome(level.biome);
    this.coins = [];
    this.enemies = [];
    this.powerups = [];
    this.fireballs = [];
    this.particles = [];
    for (const s of level.spawns) {
      if (s.type === 'player') this.spawnPoint = { x: s.x + 4, y: s.y };
      else if (s.type === 'coin') this.coins.push(new Coin(s.x, s.y));
    }
    this.state = 'playing';
  }

  /** Host: state snapshot for guests. */
  snapshot(): Snapshot {
    const s: Snapshot = {
      players: this.players.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        vx: p.vx,
        facing: p.facing,
        power: p.power,
        invuln: p.invuln,
        onGround: p.onGround,
        runTime: p.runTime,
        dead: p.dead,
        out: p.out,
      })),
      enemies: this.enemies.map((e) => ({
        x: e.x,
        y: e.y,
        vx: e.vx,
        vy: e.vy,
        kind: e.kind,
        alive: e.alive,
        squashTimer: e.squashTimer,
        hp: e.hp,
        hurtFlash: e.hurtFlash,
        phase: e.phase,
        jumpTimer: e.jumpTimer,
      })),
      powerups: this.powerups.map((u) => ({ x: u.x, y: u.y, kind: u.kind, emerging: u.emerging })),
      fireballs: this.fireballs.map((f) => ({ x: f.x, y: f.y })),
      coinsTaken: this.coins.map((c) => c.taken),
      tiles: this.pendingTiles,
      sounds: this.pendingSounds,
      score: this.score,
      coinCount: this.coinCount,
      lives: this.lives,
      state: this.state,
    };
    return s;
  }

  /** Guest: apply the host snapshot onto local entities (rendering only). */
  applySnapshot(s: Snapshot): void {
    this.score = s.score;
    this.coinCount = s.coinCount;
    this.lives = s.lives;
    this.state = s.state;
    for (const t of s.tiles) this.level.setTile(t.x, t.y, t.c);
    for (const name of s.sounds) this.audio[name](); // replay the host's sounds
    s.coinsTaken.forEach((taken, i) => {
      if (this.coins[i]) this.coins[i].taken = taken;
    });
    this.players = s.players.map((ps) => {
      const p = new Player(ps.id);
      Object.assign(p, ps);
      return p;
    });
    this.enemies = s.enemies.map((es) => {
      const e = new Enemy(0, 0, es.kind);
      Object.assign(e, es);
      return e;
    });
    this.powerups = s.powerups.map((us) => {
      const u = new PowerUp(0, 0, us.kind);
      u.x = us.x;
      u.y = us.y;
      u.emerging = us.emerging;
      return u;
    });
    this.fireballs = s.fireballs.map((fs) => new Fireball(fs.x, fs.y, 0));
  }

  /** Guest: advance cosmetic time and camera, then draw (no simulation). */
  renderFrame(dt: number): void {
    this.time += dt;
    this.updateCamera();
    this.render();
  }

  private alivePlayers(): Player[] {
    return this.players.filter((p) => !p.dead && !p.out);
  }

  /** Nearest living player to point x (for enemy AI). */
  private nearestPlayer(x: number): Player {
    const alive = this.alivePlayers();
    const pool = alive.length ? alive : this.players;
    return pool.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
  }

  update(dt: number): void {
    this.time += dt;
    // guest buffers live one frame: filled during update, read by the host in snapshot()
    this.pendingTiles = [];
    this.pendingSounds = [];
    if (this.input.wasPressed('KeyM')) this.audio.toggleMusic();

    if (this.state === 'won' || this.state === 'gameover') {
      if (this.input.wasPressed('KeyR', 'Enter')) this.restart();
      return;
    }

    this.updatePlayers(dt);
    this.updateEnemies(dt);
    this.updatePowerUps(dt);
    this.updateFireballs(dt);
    this.updateCoins();
    this.updateParticles(dt);
    this.updateCamera();
  }

  private updatePlayers(dt: number): void {
    for (const p of this.players) {
      if (p.out) continue;
      if (p.dead) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) this.placePlayer(p); // respawns at the start
        continue;
      }
      this.updatePlayer(p, dt);
    }
  }

  private updatePlayer(p: Player, dt: number): void {
    const inp = p.input;

    // slippery on snow
    const slippery = this.level.biome === 'snow' && p.onGround;
    const accel = slippery ? MOVE_ACCEL * 0.55 : MOVE_ACCEL;
    const decelRate = slippery ? MOVE_DECEL * 0.22 : MOVE_DECEL;

    // horizontal movement
    const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    if (dir !== 0) {
      p.vx += dir * accel * dt;
      p.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, p.vx));
      p.facing = dir as 1 | -1;
      if (p.onGround) p.runTime += dt;
    } else {
      const decel = decelRate * dt;
      if (Math.abs(p.vx) <= decel) p.vx = 0;
      else p.vx -= Math.sign(p.vx) * decel;
      p.runTime = 0;
    }

    // jump: buffer + coyote time
    p.jumpBuffer -= dt;
    p.coyote -= dt;
    if (inp.jumpPressed) p.jumpBuffer = JUMP_BUFFER;
    if (p.jumpBuffer > 0 && p.coyote > 0) {
      p.vy = -JUMP_SPEED;
      p.jumpBuffer = 0;
      p.coyote = 0;
      this.sfx('jump');
    }
    // released jump — shorter hop
    if (p.vy < -200 && !inp.jump) {
      p.vy = -200;
    }

    // fireballs from the sunflower
    p.fireCooldown = Math.max(0, p.fireCooldown - dt);
    if (p.power === 2 && p.fireCooldown === 0 && inp.fire) {
      this.fireballs.push(new Fireball(p.x + p.w / 2 + p.facing * 12, p.y + 10, p.facing * 420));
      p.fireCooldown = 0.35;
      this.sfx('fire');
    }

    p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);

    const res = moveBody(p, this.level, dt);
    p.onGround = res.onGround;
    if (res.onGround) p.coyote = COYOTE_TIME;
    if (res.hitHead) this.bumpBlock(p, res.hitHead.tx, res.hitHead.ty);

    p.x = Math.max(0, Math.min(p.x, this.level.pixelWidth - p.w));
    p.invuln = Math.max(0, p.invuln - dt);

    // fell into a pit
    if (p.y > this.level.pixelHeight + 100) this.killPlayer(p);

    // finish flag
    const tx = Math.floor((p.x + p.w / 2) / TILE);
    const ty = Math.floor((p.y + p.h / 2) / TILE);
    if (this.level.tileAt(tx, ty) === 'F' && this.state === 'playing') {
      this.state = 'won';
      this.score += 1000;
      this.sfx('win');
    }
  }

  private bumpBlock(p: Player, tx: number, ty: number): void {
    const t = this.level.tileAt(tx, ty);
    if (t === '?') {
      this.changeTile(tx, ty, 'X');
      this.score += 100;
      this.coinCount++;
      this.sfx('coin');
      this.burst((tx + 0.5) * TILE, ty * TILE, '#ffd23f', 8);
    } else if (t === 'M') {
      this.changeTile(tx, ty, 'X');
      const kind = p.power === 0 ? 'mushroom' : 'sunflower';
      this.powerups.push(new PowerUp(tx, ty, kind));
      this.sfx('powerupAppear');
    } else if (t === 'B') {
      if (p.power > 0) {
        // a big player breaks bricks
        this.changeTile(tx, ty, ' ');
        this.score += 10;
        this.sfx('brick');
        this.burst((tx + 0.5) * TILE, (ty + 0.5) * TILE, '#b5651d', 10);
      } else {
        this.sfx('bump');
      }
    }
  }

  /** Changes a tile and records the change to broadcast to guests. */
  private changeTile(tx: number, ty: number, c: string): void {
    this.level.setTile(tx, ty, c);
    this.pendingTiles.push({ x: tx, y: ty, c });
  }

  /** Plays a sound locally and records it to broadcast to guests. */
  private sfx(name: SoundName): void {
    this.audio[name]();
    this.pendingSounds.push(name);
  }

  private updateEnemies(dt: number): void {
    for (const e of this.enemies) {
      if (!e.alive) {
        e.squashTimer -= dt;
        continue;
      }
      const near = this.nearestPlayer(e.x);
      // don't move enemies that are far from all players
      if (Math.abs(e.x - near.x) > 800) continue;

      const info = ENEMY_INFO[e.kind];
      e.hurtFlash = Math.max(0, e.hurtFlash - dt);

      if (e.kind === 'flyer') {
        // flies in a sine wave, turns around at walls
        e.phase += dt;
        const before = Math.sign(e.vx) || -1;
        e.vy = 0;
        const res = moveBody(e, this.level, dt);
        if (res.hitWall) e.vx = -before * info.speed;
        if (e.x <= 0) e.vx = info.speed;
        e.y = e.baseY + Math.sin(e.phase * 2.2) * 40;
      } else {
        e.vy = Math.min(e.vy + GRAVITY * dt, MAX_FALL);
        const before = Math.sign(e.vx) || -1;
        const res = moveBody(e, this.level, dt);
        if (res.hitWall) e.vx = -before * info.speed;

        if (e.kind === 'hopper') {
          // sits, then jumps toward the player
          if (res.onGround) {
            e.vx = 0;
            e.jumpTimer -= dt;
            if (e.jumpTimer <= 0) {
              e.jumpTimer = 1 + Math.random() * 0.8;
              e.vy = -640;
              e.vx = (Math.sign(near.x - e.x) || -1) * info.speed;
            }
          }
        } else {
          // the turtle walks off ledges and falls, others turn around
          if (res.onGround && e.kind !== 'turtle') {
            const aheadX = e.vx > 0 ? e.x + e.w + 2 : e.x - 2;
            const footTx = Math.floor(aheadX / TILE);
            const footTy = Math.floor((e.y + e.h + 2) / TILE);
            if (!this.level.isSolid(footTx, footTy)) e.vx = -e.vx;
          }
          if (e.vx === 0) e.vx = -info.speed;
        }
      }

      // fell into a pit
      if (e.y > this.level.pixelHeight + 60) {
        e.alive = false;
        e.squashTimer = 0;
        continue;
      }

      // collision with players
      if (this.state === 'playing') {
        for (const p of this.alivePlayers()) {
          if (!overlaps(p.rect, e.rect)) continue;
          const stomp = p.vy > 0 && p.y + p.h - e.y < Math.max(16, e.h * 0.6);
          if (stomp && e.kind !== 'spiky') {
            // place the player on the enemy's head and bounce — no residual
            // overlap, so a surviving enemy (the giant) can't hit them on the way up
            p.y = e.y - p.h;
            p.vy = -STOMP_BOUNCE;
            e.hp--;
            if (e.hp <= 0) {
              e.alive = false;
              e.squashTimer = 0.4;
              this.score += info.score;
              this.sfx('stomp');
              this.burst(e.x + e.w / 2, e.y, this.enemyColor(e.kind), 6);
            } else {
              e.hurtFlash = 0.3;
              this.score += 100;
              this.sfx('bump');
            }
            break; // the enemy has already reacted this frame
          } else if (p.invuln <= 0) {
            this.hurtPlayer(p);
          }
        }
      }
    }
    this.enemies = this.enemies.filter((e) => e.alive || e.squashTimer > 0);
  }

  private updatePowerUps(dt: number): void {
    for (const u of this.powerups) {
      if (u.emerging) {
        u.y -= 30 * dt;
        if (u.y <= u.targetY) {
          u.y = u.targetY;
          u.emerging = false;
          if (u.kind === 'mushroom') u.vx = 80; // the mushroom runs away, the sunflower stays put
        }
        continue;
      }
      if (u.kind === 'mushroom') {
        u.vy = Math.min(u.vy + GRAVITY * dt, MAX_FALL);
        const before = Math.sign(u.vx) || 1;
        const res = moveBody(u, this.level, dt);
        if (res.hitWall) u.vx = -before * 80;
      }
      if (u.y > this.level.pixelHeight + 60) {
        u.dead = true;
        continue;
      }
      for (const p of this.alivePlayers()) {
        if (!overlaps(p.rect, u.rect)) continue;
        u.dead = true;
        this.score += 500;
        this.sfx('powerup');
        this.burst(u.x + u.w / 2, u.y + u.h / 2, u.kind === 'mushroom' ? '#e63946' : '#ffd23f', 10);
        if (u.kind === 'mushroom' && p.power < 1) p.setPower(1);
        else if (u.kind === 'sunflower' && p.power < 2) p.setPower(2);
        break; // the power-up goes to a single player
      }
    }
    this.powerups = this.powerups.filter((u) => !u.dead);
  }

  private updateFireballs(dt: number): void {
    for (const f of this.fireballs) {
      f.life -= dt;
      f.vy = Math.min(f.vy + GRAVITY * dt, 800);
      const res = moveBody(f, this.level, dt);
      if (res.onGround) f.vy = -380; // bounces along the ground
      if (res.hitWall || res.hitHead || f.life <= 0) f.dead = true;

      for (const e of this.enemies) {
        if (e.alive && overlaps(f.rect, e.rect)) {
          e.alive = false;
          e.squashTimer = 0.4;
          this.score += ENEMY_INFO[e.kind].score;
          this.sfx('stomp');
          this.burst(e.x + e.w / 2, e.y + e.h / 2, '#ff7043', 8);
          f.dead = true;
          break;
        }
      }
      if (f.dead) this.burst(f.x, f.y, '#ff9800', 4);
    }
    this.fireballs = this.fireballs.filter((f) => !f.dead);
  }

  private updateCoins(): void {
    for (const c of this.coins) {
      if (c.taken) continue;
      if (this.alivePlayers().some((p) => overlaps(p.rect, c.rect))) {
        c.taken = true;
        this.coinCount++;
        this.score += 100;
        this.sfx('coin');
        this.burst(c.x, c.y, '#ffd23f', 6);
      }
    }
  }

  private updateParticles(dt: number): void {
    for (const pt of this.particles) {
      pt.life -= dt;
      pt.vy += GRAVITY * 0.5 * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
    }
    this.particles = this.particles.filter((pt) => pt.life > 0);
  }

  private burst(x: number, y: number, color: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const sp = 120 + Math.random() * 120;
      this.particles.push(new Particle(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 150, color));
    }
  }

  private hurtPlayer(p: Player): void {
    if (p.invuln > 0 || p.dead || this.state !== 'playing') return;
    if (p.power > 0) {
      p.setPower((p.power - 1) as 0 | 1);
      p.invuln = 2;
      this.sfx('hurt');
      this.burst(p.x + p.w / 2, p.y + p.h / 2, '#e63946', 6);
    } else {
      this.killPlayer(p);
    }
  }

  private killPlayer(p: Player): void {
    if (p.dead || this.state !== 'playing') return;
    p.dead = true;
    this.sfx('die');
    this.burst(p.x + p.w / 2, p.y + p.h / 2, '#e63946', 12);

    // shared life pool: while any remain the player respawns, otherwise they're out
    if (this.lives > 0) {
      this.lives--;
      p.respawnTimer = 1.2;
    } else {
      p.out = true;
      if (this.players.every((pl) => pl.out)) this.state = 'gameover';
    }
  }

  private updateCamera(): void {
    const cw = this.ctx.canvas.width;
    const ch = this.ctx.canvas.height;
    // camera: either the midpoint between living players (local split) or own player (network)
    let focus = this.alivePlayers();
    if (this.cameraFocus !== 'all') {
      const own = this.players.find((p) => p.id === this.cameraFocus && !p.dead && !p.out);
      if (own) focus = [own];
    }
    if (focus.length === 0) return; // everyone is respawning — leave the frame where it is
    let mx = 0;
    let my = 0;
    for (const p of focus) {
      mx += p.x + p.w / 2;
      my += p.y + p.h / 2;
    }
    mx /= focus.length;
    my /= focus.length;
    const targetX = mx - cw / 2;
    const targetY = my - ch / 2;
    this.camX += (targetX - this.camX) * 0.15;
    this.camY += (targetY - this.camY) * 0.15;
    this.camX = Math.max(0, Math.min(this.camX, this.level.pixelWidth - cw));
    this.camY = Math.max(-TILE * 2, Math.min(this.camY, this.level.pixelHeight - ch));
  }

  // ---------- rendering ----------

  render(): void {
    const ctx = this.ctx;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const pal = PALETTES[this.level.biome];

    const sky = ctx.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, pal.skyTop);
    sky.addColorStop(1, pal.skyBot);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cw, ch);

    this.drawBackground(pal);

    ctx.save();
    ctx.translate(-Math.round(this.camX), -Math.round(this.camY));

    // power-ups emerging from a block are drawn behind the tiles
    for (const u of this.powerups) if (u.emerging) this.drawPowerUp(u);
    this.drawTiles(pal);
    for (const u of this.powerups) if (!u.emerging) this.drawPowerUp(u);
    for (const c of this.coins) if (!c.taken) this.drawCoin(c);
    for (const e of this.enemies) this.drawEnemy(e);
    for (const f of this.fireballs) this.drawFireball(f);
    for (const p of this.players) if (!p.dead && !p.out) this.drawPlayer(p);
    for (const pt of this.particles) {
      ctx.globalAlpha = Math.max(0, pt.life * 2);
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - 3, pt.y - 3, 6, 6);
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    this.drawHud(pal);
    if (this.state === 'won') this.drawOverlay('LEVEL COMPLETE!', `Score: ${this.score} — press R`);
    if (this.state === 'gameover') this.drawOverlay('GAME OVER', 'Press R to start over');
  }

  private drawBackground(pal: Palette): void {
    const ctx = this.ctx;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const biome = this.level.biome;

    if (biome === 'desert') {
      // sun
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath();
      ctx.arc(cw - 130, 90, 45, 0, Math.PI * 2);
      ctx.fill();
    }

    if (biome === 'cave') {
      // stalactites instead of clouds
      ctx.fillStyle = pal.hill;
      for (let i = 0; i < 14; i++) {
        const sx = ((i * 173 - this.camX * 0.3) % (cw + 200) + cw + 200) % (cw + 200) - 100;
        const sh = 60 + ((i * 37) % 80);
        ctx.beginPath();
        ctx.moveTo(sx - 26, 0);
        ctx.lineTo(sx + 26, 0);
        ctx.lineTo(sx, sh);
        ctx.closePath();
        ctx.fill();
      }
      // glowing sparks
      ctx.fillStyle = pal.cloud;
      for (let i = 0; i < 24; i++) {
        const px = (i * 211 + Math.sin(this.time * 0.4 + i) * 40 - this.camX * 0.2) % cw;
        const py = ((i * 97 - this.time * 12) % ch + ch) % ch;
        ctx.fillRect(((px % cw) + cw) % cw, py, 3, 3);
      }
    } else {
      // hills (slow parallax)
      ctx.fillStyle = pal.hill;
      for (let i = 0; i < 12; i++) {
        const hx = i * 500 - (this.camX * 0.3) % 500 - 250 + i * 130;
        ctx.beginPath();
        ctx.arc(hx % (cw + 500), ch - 30, 140 + (i % 3) * 50, Math.PI, 0);
        ctx.fill();
      }
      // clouds
      ctx.fillStyle = pal.cloud;
      for (let i = 0; i < 8; i++) {
        const cx = ((i * 420 + 100 - this.camX * 0.15) % (cw + 300)) - 150;
        const cy = 50 + (i % 3) * 45;
        ctx.beginPath();
        ctx.arc(cx, cy, 22, 0, Math.PI * 2);
        ctx.arc(cx + 25, cy - 8, 26, 0, Math.PI * 2);
        ctx.arc(cx + 52, cy, 20, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (biome === 'snow') {
      // falling snow
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 40; i++) {
        const sx = (i * 137 + Math.sin(this.time * 1.5 + i) * 30 - this.camX * 0.4) % cw;
        const sy = (i * 71 + this.time * (50 + (i % 4) * 25)) % ch;
        ctx.fillRect(((sx % cw) + cw) % cw, sy, 3, 3);
      }
    }
  }

  private drawTiles(pal: Palette): void {
    const ctx = this.ctx;
    const x0 = Math.floor(this.camX / TILE);
    const x1 = Math.ceil((this.camX + ctx.canvas.width) / TILE);
    const y0 = Math.floor(this.camY / TILE);
    const y1 = Math.ceil((this.camY + ctx.canvas.height) / TILE);

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = this.level.tileAt(tx, ty);
        if (t === ' ') continue;
        const x = tx * TILE;
        const y = ty * TILE;
        switch (t) {
          case '#': {
            const grassOnTop = this.level.tileAt(tx, ty - 1) !== '#';
            ctx.fillStyle = pal.ground;
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = pal.groundDark;
            ctx.fillRect(x + 4, y + 10, 8, 6);
            ctx.fillRect(x + 18, y + 20, 9, 6);
            if (grassOnTop) {
              ctx.fillStyle = pal.top;
              ctx.fillRect(x, y, TILE, 10);
              ctx.fillStyle = pal.topLight;
              ctx.fillRect(x, y, TILE, 4);
            }
            break;
          }
          case 'B':
            ctx.fillStyle = '#b5651d';
            ctx.fillRect(x, y, TILE, TILE);
            ctx.strokeStyle = '#7d4512';
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
            ctx.beginPath();
            ctx.moveTo(x, y + TILE / 2);
            ctx.lineTo(x + TILE, y + TILE / 2);
            ctx.moveTo(x + TILE / 2, y);
            ctx.lineTo(x + TILE / 2, y + TILE / 2);
            ctx.moveTo(x + TILE / 4, y + TILE / 2);
            ctx.lineTo(x + TILE / 4, y + TILE);
            ctx.stroke();
            break;
          case '?':
          case 'M': {
            // a power-up block looks like a normal '?'
            const bob = Math.sin(this.time * 4 + tx) * 1.5;
            ctx.fillStyle = '#ffb703';
            ctx.fillRect(x, y, TILE, TILE);
            ctx.strokeStyle = '#c77f00';
            ctx.lineWidth = 3;
            ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
            ctx.fillStyle = '#7d4512';
            ctx.font = 'bold 20px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('?', x + TILE / 2, y + TILE / 2 + 7 + bob);
            break;
          }
          case 'X':
            ctx.fillStyle = '#9c6b30';
            ctx.fillRect(x, y, TILE, TILE);
            ctx.strokeStyle = '#6e4a1f';
            ctx.lineWidth = 3;
            ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
            break;
          case '=':
            ctx.fillStyle = '#c9a227';
            ctx.fillRect(x, y, TILE, 14);
            ctx.fillStyle = '#e8c547';
            ctx.fillRect(x, y, TILE, 5);
            break;
          case 'F': {
            // draw the flagpole only in the top cell of the column
            if (this.level.tileAt(tx, ty - 1) === 'F') break;
            let yy = ty;
            while (this.level.tileAt(tx, yy + 1) === 'F') yy++;
            const poleBottom = (yy + 1) * TILE;
            ctx.fillStyle = '#cfd8dc';
            ctx.fillRect(x + TILE / 2 - 3, y, 6, poleBottom - y);
            ctx.fillStyle = '#2e7d32';
            ctx.beginPath();
            ctx.arc(x + TILE / 2, y, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#e63946';
            ctx.beginPath();
            ctx.moveTo(x + TILE / 2 + 3, y + 10);
            ctx.lineTo(x + TILE / 2 + 34, y + 22);
            ctx.lineTo(x + TILE / 2 + 3, y + 34);
            ctx.closePath();
            ctx.fill();
            break;
          }
        }
      }
    }
  }

  private drawPlayer(p: Player): void {
    const ctx = this.ctx;
    if (p.invuln > 0 && Math.floor(p.invuln * 12) % 2 === 0) return; // blinking

    const skin = PLAYER_SKINS[p.id % PLAYER_SKINS.length];
    // sunflower — yellow-orange outfit, otherwise the player's colour
    const capColor = p.power === 2 ? '#ffb300' : skin.cap;
    const shirtColor = p.power === 2 ? '#ff8f00' : skin.arm;

    ctx.save();
    ctx.translate(p.x + p.w / 2, p.y);
    ctx.scale(p.facing, 1);

    const legPhase = p.onGround && Math.abs(p.vx) > 20 ? Math.sin(p.runTime * 18) * 4 : 0;
    const hw = p.w / 2;
    // legs
    ctx.fillStyle = '#1d3557';
    ctx.fillRect(-hw + 2 + legPhase, p.h - 8, 7, 8);
    ctx.fillRect(hw - 9 - legPhase, p.h - 8, 7, 8);
    // overalls
    ctx.fillStyle = skin.overalls;
    ctx.fillRect(-hw + 1, 14, p.w - 2, p.h - 22);
    // arms
    ctx.fillStyle = shirtColor;
    ctx.fillRect(-hw - 2, 13, 4, 9);
    ctx.fillRect(hw - 2, 13, 4, 9);
    // head
    ctx.fillStyle = '#ffcc9c';
    ctx.fillRect(-8, 2, 16, 12);
    // cap
    ctx.fillStyle = capColor;
    ctx.fillRect(-9, 0, 18, 5);
    ctx.fillRect(2, 3, 11, 3);
    // eye
    ctx.fillStyle = '#222';
    ctx.fillRect(3, 6, 3, 4);
    // moustache
    ctx.fillStyle = '#5d4037';
    ctx.fillRect(1, 11, 8, 3);

    ctx.restore();
  }

  private enemyColor(kind: EnemyKind): string {
    return BIOME_SKINS[this.level.biome][kind] ?? ENEMY_BODY[kind];
  }

  private drawEnemy(e: Enemy): void {
    const ctx = this.ctx;
    const body = this.enemyColor(e.kind);
    if (!e.alive) {
      ctx.fillStyle = body;
      ctx.fillRect(e.x, e.y + e.h - 8, e.w, 8);
      return;
    }
    const cx = e.x + e.w / 2;
    const cy = e.y + e.h / 2;
    const dir = Math.sign(e.vx) || -1;
    const wob = Math.sin(this.time * 10 + e.phase) * 1.5;
    // in caves the shared species have glowing eyes
    const pupil = this.level.biome === 'cave' ? '#ffe93b' : '#222';

    switch (e.kind) {
      case 'walker': {
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx, cy + 2, e.w / 2, e.h / 2 - 1, 0, 0, Math.PI * 2);
        ctx.fill();
        if (this.level.biome === 'snow') {
          // snow cap
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(cx, e.y + 4, e.w / 2 - 3, 4, 0, Math.PI, 0);
          ctx.fill();
        }
        ctx.fillStyle = '#3e2723';
        ctx.fillRect(e.x + 2, e.y + e.h - 5 + wob, 8, 5);
        ctx.fillRect(e.x + e.w - 10, e.y + e.h - 5 - wob, 8, 5);
        this.enemyEyes(e, dir, pupil);
        break;
      }
      case 'turtle': {
        // shell
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx - dir * 3, cy + 2, e.w / 2 - 3, e.h / 2 - 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#1b5e20';
        ctx.lineWidth = 2;
        ctx.stroke();
        // head
        ctx.fillStyle = '#9ccc65';
        ctx.fillRect(cx + dir * (e.w / 2 - 6), e.y + 4, 8, 9);
        ctx.fillStyle = '#222';
        ctx.fillRect(cx + dir * (e.w / 2 - 3), e.y + 6, 2, 3);
        // feet
        ctx.fillStyle = '#9ccc65';
        ctx.fillRect(e.x + 3, e.y + e.h - 5 + wob, 7, 5);
        ctx.fillRect(e.x + e.w - 10, e.y + e.h - 5 - wob, 7, 5);
        break;
      }
      case 'spiky': {
        // cactus spines
        ctx.fillStyle = '#ffe082';
        for (let i = 0; i < 4; i++) {
          const sx = e.x + 3 + i * ((e.w - 6) / 3);
          ctx.beginPath();
          ctx.moveTo(sx - 4, e.y + 8);
          ctx.lineTo(sx, e.y - 6);
          ctx.lineTo(sx + 4, e.y + 8);
          ctx.closePath();
          ctx.fill();
        }
        // body
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx, cy + 3, e.w / 2, e.h / 2 - 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1b5e20';
        ctx.fillRect(e.x + 2, e.y + e.h - 5 + wob, 8, 5);
        ctx.fillRect(e.x + e.w - 10, e.y + e.h - 5 - wob, 8, 5);
        this.enemyEyes(e, dir);
        break;
      }
      case 'flyer': {
        // wings
        const flap = Math.sin(this.time * 14 + e.phase) * 7;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.ellipse(cx - 10, e.y + 3 - flap, 9, 5, -0.5, 0, Math.PI * 2);
        ctx.ellipse(cx + 10, e.y + 3 - flap, 9, 5, 0.5, 0, Math.PI * 2);
        ctx.fill();
        // body
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx, cy + 2, e.w / 2 - 2, e.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        this.enemyEyes(e, dir, pupil);
        break;
      }
      case 'hopper': {
        // crouches before jumping
        const squat = e.vy === 0 && e.jumpTimer < 0.3 ? 4 : 0;
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx, cy + 2 + squat / 2, e.w / 2, e.h / 2 - squat / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        // powerful hind legs
        ctx.fillStyle = '#0277bd';
        ctx.fillRect(e.x - 2, e.y + e.h - 8, 8, 8);
        ctx.fillRect(e.x + e.w - 6, e.y + e.h - 8, 8, 8);
        // eyes on top
        ctx.fillStyle = '#fff';
        ctx.fillRect(cx - 8, e.y - 2, 6, 7);
        ctx.fillRect(cx + 2, e.y - 2, 6, 7);
        ctx.fillStyle = '#222';
        ctx.fillRect(cx - 6 + dir, e.y + 1, 3, 3);
        ctx.fillRect(cx + 4 + dir, e.y + 1, 3, 3);
        break;
      }
      case 'giant': {
        ctx.fillStyle = e.hurtFlash > 0 ? '#9575cd' : body;
        ctx.beginPath();
        ctx.ellipse(cx, cy + 2, e.w / 2, e.h / 2 - 1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#311b92';
        ctx.fillRect(e.x + 4, e.y + e.h - 6 + wob, 12, 6);
        ctx.fillRect(e.x + e.w - 16, e.y + e.h - 6 - wob, 12, 6);
        // angry eyebrows
        ctx.strokeStyle = '#212121';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx - 12, e.y + 8);
        ctx.lineTo(cx - 3, e.y + 12);
        ctx.moveTo(cx + 12, e.y + 8);
        ctx.lineTo(cx + 3, e.y + 12);
        ctx.stroke();
        // eyes (turn red after the first hit)
        ctx.fillStyle = '#fff';
        ctx.fillRect(cx - 11, e.y + 13, 8, 9);
        ctx.fillRect(cx + 3, e.y + 13, 8, 9);
        ctx.fillStyle = e.hp === 1 ? '#d32f2f' : '#222';
        ctx.fillRect(cx - 9 + dir * 2, e.y + 16, 4, 5);
        ctx.fillRect(cx + 5 + dir * 2, e.y + 16, 4, 5);
        break;
      }
    }
  }

  private enemyEyes(e: Enemy, dir: number, pupil = '#222'): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#fff';
    ctx.fillRect(e.x + 5, e.y + 5, 6, 7);
    ctx.fillRect(e.x + e.w - 11, e.y + 5, 6, 7);
    ctx.fillStyle = pupil;
    ctx.fillRect(e.x + 7 + dir * 2, e.y + 8, 3, 4);
    ctx.fillRect(e.x + e.w - 9 + dir * 2, e.y + 8, 3, 4);
  }

  private drawPowerUp(u: PowerUp): void {
    const ctx = this.ctx;
    const cx = u.x + u.w / 2;
    if (u.kind === 'mushroom') {
      // stem
      ctx.fillStyle = '#ffe8cc';
      ctx.fillRect(cx - 6, u.y + 12, 12, 12);
      // cap
      ctx.fillStyle = '#e63946';
      ctx.beginPath();
      ctx.ellipse(cx, u.y + 10, 12, 10, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(cx - 12, u.y + 8, 24, 4);
      // spots
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx - 6, u.y + 6, 3, 0, Math.PI * 2);
      ctx.arc(cx + 5, u.y + 5, 3, 0, Math.PI * 2);
      ctx.fill();
      // eyes
      ctx.fillStyle = '#222';
      ctx.fillRect(cx - 4, u.y + 15, 2, 4);
      ctx.fillRect(cx + 2, u.y + 15, 2, 4);
    } else {
      // stem and leaves
      ctx.fillStyle = '#2e7d32';
      ctx.fillRect(cx - 2, u.y + 12, 4, 12);
      ctx.beginPath();
      ctx.ellipse(cx - 6, u.y + 19, 6, 3, -0.5, 0, Math.PI * 2);
      ctx.ellipse(cx + 6, u.y + 19, 6, 3, 0.5, 0, Math.PI * 2);
      ctx.fill();
      // petals
      ctx.fillStyle = '#ffd23f';
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8 + this.time * 1.5;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * 8, u.y + 9 + Math.sin(a) * 8, 5, 3, a, 0, Math.PI * 2);
        ctx.fill();
      }
      // centre
      ctx.fillStyle = '#6d4c41';
      ctx.beginPath();
      ctx.arc(cx, u.y + 9, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawFireball(f: Fireball): void {
    const ctx = this.ctx;
    const flicker = 1 + Math.sin(this.time * 30) * 0.25;
    ctx.fillStyle = 'rgba(255,152,0,0.4)';
    ctx.beginPath();
    ctx.arc(f.x + 5, f.y + 5, 9 * flicker, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff7043';
    ctx.beginPath();
    ctx.arc(f.x + 5, f.y + 5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffe082';
    ctx.beginPath();
    ctx.arc(f.x + 5, f.y + 5, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawCoin(c: Coin): void {
    const ctx = this.ctx;
    const squeeze = Math.abs(Math.sin(this.time * 4 + c.x * 0.05));
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + Math.sin(this.time * 3 + c.x * 0.03) * 3, 9 * squeeze + 1, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c79100';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private drawHud(pal: Palette): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, ctx.canvas.width, 36);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`SCORE ${this.score}`, 16, 25);
    ctx.fillText(`🪙 ${this.coinCount}`, 200, 25);
    ctx.fillText(`❤ ${this.lives}`, 310, 25);
    // each player's state: ✖ out, 🌻/🍄/· — current power
    const power = this.players
      .map((pl) => (pl.out ? '✖' : pl.power === 2 ? '🌻' : pl.power === 1 ? '🍄' : '·'))
      .join(' ');
    ctx.fillText(power, 390, 25);
    ctx.fillText(pal.name, 450, 25);
    ctx.textAlign = 'right';
    const hint = this.players.some((pl) => pl.power === 2) ? 'fire · M — music' : 'M — music';
    ctx.fillText(hint, ctx.canvas.width - 16, 25);
  }

  private drawOverlay(title: string, subtitle: string): void {
    const ctx = this.ctx;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 48px monospace';
    ctx.fillText(title, cw / 2, ch / 2 - 20);
    ctx.font = '22px monospace';
    ctx.fillText(subtitle, cw / 2, ch / 2 + 30);
  }
}
