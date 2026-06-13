// Game loops for the three modes. main.ts just picks the right one.
//
//  runLocal — solo / two on one PC: ordinary simulation + rendering.
//  runHost  — host: simulates the world, accepts guest input, sends snapshots.
//  runGuest — guest: doesn't simulate; sends its input, draws the host's snapshots.

import { AudioSys } from './audio';
import { Game } from './game';
import { Bindings, Input, InputState } from './input';
import { Level } from './level';
import { Net, PeerId } from './net';
import { GuestMsg, Held, HostMsg, Snapshot } from './protocol';

const FRAME_CAP = 1 / 30; // cap dt when the tab is minimized

const EMPTY_HELD: Held = { left: false, right: false, jump: false, fire: false };

function heldOf(input: Input, b: Bindings): Held {
  return {
    left: input.isDown(...b.left),
    right: input.isDown(...b.right),
    jump: input.isDown(...b.jump),
    fire: input.isDown(...b.fire),
  };
}

// Press-edges (pressed right now) are derived from held-state transitions: was false → became true.
function deriveInput(h: Held, prev: Held): InputState {
  return {
    left: h.left,
    right: h.right,
    jump: h.jump,
    jumpPressed: h.jump && !prev.jump,
    fire: h.fire && !prev.fire,
  };
}

function loop(step: (dt: number) => void): void {
  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, FRAME_CAP);
    last = now;
    step(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function drawMessage(ctx: CanvasRenderingContext2D, text: string): void {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.font = '24px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, width / 2, height / 2);
}

// ---------- local modes (solo / two players on one PC) ----------

export function runLocal(
  ctx: CanvasRenderingContext2D,
  input: Input,
  audio: AudioSys,
  bindings: Bindings[],
): void {
  const game = new Game(ctx, input, audio, bindings.length);
  loop((dt) => {
    const roster = game.roster;
    for (let i = 0; i < roster.length && i < bindings.length; i++) {
      roster[i].input = input.snapshot(bindings[i]);
    }
    game.update(dt);
    game.render();
    input.endFrame();
  });
}

// ---------- host ----------

export function runHost(
  ctx: CanvasRenderingContext2D,
  input: Input,
  audio: AudioSys,
  net: Net,
  bindings: Bindings,
): void {
  // freeze the room roster at start: slots 1..n go to guests in order
  const peerIds = [...net.peers].sort();
  const count = 1 + peerIds.length;
  const slotOf = new Map<PeerId, number>();
  peerIds.forEach((id, i) => slotOf.set(id, i + 1));

  const game = new Game(ctx, input, audio, count);
  game.setCameraFocus(0); // the host follows its own player (slot 0)

  const latestHeld = new Map<number, Held>(); // last 'held' per slot
  const prevHeld = new Map<number, Held>(); // previous — for computing press-edges

  const sendInit = (peer: PeerId): void => {
    const slot = slotOf.get(peer);
    if (slot != null) {
      net.send(peer, { k: 'init', level: game.levelData(), slot, count } satisfies HostMsg);
    }
  };

  net.onMessage = (from, data: GuestMsg) => {
    if (data.k === 'ready') sendInit(from);
    else if (data.k === 'input') {
      const slot = slotOf.get(from);
      if (slot != null) latestHeld.set(slot, data.h);
    }
  };
  net.onPeerLeft = (id) => {
    const slot = slotOf.get(id);
    if (slot != null) game.roster[slot].out = true; // a guest who left is eliminated
  };

  let lastEpoch = game.epoch;
  loop((dt) => {
    game.roster[0].input = input.snapshot(bindings); // local player
    for (const [slot, held] of latestHeld) {
      game.roster[slot].input = deriveInput(held, prevHeld.get(slot) ?? EMPTY_HELD);
      prevHeld.set(slot, held);
    }

    game.update(dt);

    // a restart generated a new level — hand it out to guests again (before the snapshot)
    if (game.epoch !== lastEpoch) {
      lastEpoch = game.epoch;
      for (const peer of slotOf.keys()) sendInit(peer);
    }

    game.render();
    net.send('all', { k: 'snap', s: game.snapshot() } satisfies HostMsg);
    input.endFrame();
  });
}

// ---------- guest ----------

export function runGuest(
  ctx: CanvasRenderingContext2D,
  input: Input,
  audio: AudioSys,
  net: Net,
  bindings: Bindings,
): void {
  let game: Game | null = null;
  let latest: Snapshot | null = null;
  let lostHost = false;

  net.onMessage = (_from, data: HostMsg) => {
    if (data.k === 'init') {
      game = new Game(ctx, input, audio, data.count);
      game.loadLevel(Level.deserialize(data.level));
      game.setCameraFocus(data.slot); // the guest follows its own player
    } else if (data.k === 'snap') {
      latest = data.s;
    }
  };
  net.onHostLeft = () => (lostHost = true);

  // ask the host for the level, retrying in case of a startup race
  const ready = () => net.send('host', { k: 'ready' } satisfies GuestMsg);
  ready();
  const retry = setInterval(() => (game ? clearInterval(retry) : ready()), 500);

  loop((dt) => {
    if (lostHost) {
      drawMessage(ctx, 'The host closed the game');
    } else if (game) {
      net.send('host', { k: 'input', h: heldOf(input, bindings) } satisfies GuestMsg);
      if (latest) game.applySnapshot(latest);
      game.renderFrame(dt);
    } else {
      drawMessage(ctx, 'Waiting for level…');
    }
    input.endFrame();
  });
}
