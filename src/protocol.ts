// Co-op network protocol (on top of the relay's opaque `data`).
// Types only — shared by host, guest and game code, with no import cycles.

import type { SoundName } from './audio';
import type { EnemyKind, PowerUpKind } from './entities';
import type { LevelData } from './level';

// What the guest sends to the host: 'held' keys. The host computes press-edges
// (pressed right now) itself from changes to this state — so jumps/shots aren't
// lost or duplicated when frame rates diverge.
export interface Held {
  left: boolean;
  right: boolean;
  jump: boolean;
  fire: boolean;
}

export interface PlayerSnap {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number; // needed so the guest can roll its own player forward from this state
  facing: 1 | -1;
  power: 0 | 1 | 2;
  invuln: number;
  onGround: boolean;
  coyote: number; // jump-grace timers — carried so reconciliation reproduces jumps exactly
  jumpBuffer: number;
  runTime: number;
  dead: boolean;
  out: boolean;
}

export interface EnemySnap {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: EnemyKind;
  alive: boolean;
  squashTimer: number;
  hp: number;
  hurtFlash: number;
  phase: number;
  jumpTimer: number;
}

export interface PowerSnap {
  x: number;
  y: number;
  kind: PowerUpKind;
  emerging: boolean;
}

export interface FireSnap {
  x: number;
  y: number;
}

export interface TileChange {
  x: number;
  y: number;
  c: string;
}

export interface Snapshot {
  players: PlayerSnap[];
  enemies: EnemySnap[];
  powerups: PowerSnap[];
  fireballs: FireSnap[];
  coinsTaken: boolean[];
  tiles: TileChange[]; // tile changes since the previous snapshot (reliable WS — never lost)
  sounds: SoundName[]; // sounds played on the host this frame — the guest replays them
  score: number;
  coinCount: number;
  lives: number;
  state: 'playing' | 'gameover' | 'won';
  acks: number[]; // last guest input seq the host has applied, indexed by slot (for reconciliation)
}

// host → guest
export type HostMsg =
  | { k: 'init'; level: LevelData; slot: number; count: number }
  | { k: 'snap'; s: Snapshot };

// guest → host. `seq` is a monotonic counter so the host can tell the guest
// (via Snapshot.acks) which of its inputs are already baked into the snapshot.
export type GuestMsg = { k: 'ready' } | { k: 'input'; h: Held; seq: number };
