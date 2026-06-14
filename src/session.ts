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
import { GuestMsg, Held, HostMsg, PlayerSnap, Snapshot } from './protocol';

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

  // Per-slot queue of inputs to replay in order, exactly as the guest produced
  // them — same press-edges (derived on arrival) and same dt — so the host's copy
  // of each guest follows the identical trajectory the guest predicted.
  const queues = new Map<number, { inp: InputState; dt: number; seq: number }[]>();
  const prevHeld = new Map<number, Held>(); // previous held per slot — for press-edges
  const ackSeq = new Map<number, number>(); // last input seq applied per slot — echoed to guests

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
      if (slot == null) return;
      const inp = deriveInput(data.h, prevHeld.get(slot) ?? EMPTY_HELD);
      prevHeld.set(slot, data.h);
      const q = queues.get(slot) ?? [];
      q.push({ inp, dt: data.dt, seq: data.seq });
      queues.set(slot, q);
    }
  };
  net.onPeerLeft = (id) => {
    const slot = slotOf.get(id);
    if (slot != null) game.roster[slot].out = true; // a guest who left is eliminated
  };

  let lastEpoch = game.epoch;
  loop((dt) => {
    if (game.beginFrame(dt)) {
      game.stepPlayer(0, input.snapshot(bindings), dt); // local player, host frame time
      // replay each guest's queued inputs in order — one physics sub-step apiece
      for (const [slot, q] of queues) {
        for (const e of q) {
          game.stepPlayer(slot, e.inp, e.dt);
          ackSeq.set(slot, e.seq); // now baked into the upcoming snapshot
        }
        q.length = 0;
      }
      game.updateWorld(dt);
    } else {
      for (const q of queues.values()) q.length = 0; // game over — don't pile up inputs
    }

    // a restart generated a new level — hand it out to guests again (before the snapshot)
    if (game.epoch !== lastEpoch) {
      lastEpoch = game.epoch;
      for (const peer of slotOf.keys()) sendInit(peer);
    }

    game.render();
    const s = game.snapshot();
    s.acks = new Array(count).fill(-1);
    for (const [slot, seq] of ackSeq) s.acks[slot] = seq;
    net.send('all', { k: 'snap', s } satisfies HostMsg);
    input.endFrame();
  });
}

// ---------- guest ----------

// How hard the displayed position is pulled toward the freshly predicted one
// each frame. The displayed position is also carried by the player's velocity
// (projective velocity blending), so steady motion has no lag — only the
// unexpected part of a correction is smoothed away over a few frames.
const SMOOTH_CORRECT = 0.25;
// Corrections larger than this (respawn, teleport) snap instead of sliding.
const SNAP_DIST = 48;

export function runGuest(
  ctx: CanvasRenderingContext2D,
  input: Input,
  audio: AudioSys,
  net: Net,
  bindings: Bindings,
): void {
  let game: Game | null = null;
  let slot = 0;
  let lostHost = false;

  let latest: Snapshot | null = null;
  let applied: Snapshot | null = null;

  // client-side prediction state
  let seq = 0;
  const pending: { seq: number; h: Held; dt: number }[] = []; // inputs not yet acked by the host
  let ackHeld: Held = EMPTY_HELD; // host's last-applied held — the press-edge base for replay
  let auth: PlayerSnap | null = null; // authoritative own-player state from the latest snapshot
  // displayed (smoothed) own-player position
  let dispX = 0;
  let dispY = 0;
  let haveDisp = false;

  net.onMessage = (_from, data: HostMsg) => {
    if (data.k === 'init') {
      game = new Game(ctx, input, audio, data.count);
      game.loadLevel(Level.deserialize(data.level));
      game.setCameraFocus(data.slot); // the guest follows its own player
      slot = data.slot;
      // reset prediction state (also covers a host restart re-sending init)
      pending.length = 0;
      ackHeld = EMPTY_HELD;
      auth = null;
      applied = null;
      haveDisp = false;
    } else if (data.k === 'snap') {
      latest = data.s;
    }
  };
  net.onHostLeft = () => (lostHost = true);

  // ask the host for the level, retrying in case of a startup race
  const ready = () => net.send('host', { k: 'ready' } satisfies GuestMsg);
  ready();
  const retry = setInterval(() => (game ? clearInterval(retry) : ready()), 500);

  // Turn the held-key history into per-step InputState, deriving press-edges
  // from transitions exactly as the host does (deriveInput) so replay matches.
  const toSteps = (): { input: InputState; dt: number }[] => {
    const steps: { input: InputState; dt: number }[] = [];
    let prev = ackHeld;
    for (const e of pending) {
      steps.push({ input: deriveInput(e.h, prev), dt: e.dt });
      prev = e.h;
    }
    return steps;
  };

  loop((dt) => {
    if (lostHost) {
      drawMessage(ctx, 'The host closed the game');
      input.endFrame();
      return;
    }
    const g = game;
    if (!g) {
      drawMessage(ctx, 'Waiting for level…');
      input.endFrame();
      return;
    }

    // 1. sample our input, send it (with dt, so the host replays it identically)
    const h = heldOf(input, bindings);
    seq++;
    net.send('host', { k: 'input', h, seq, dt } satisfies GuestMsg);
    pending.push({ seq, h, dt });
    if (pending.length > 600) pending.shift(); // safety cap if snapshots stall

    // 2. fold in a new snapshot (if any): set the authoritative base and drop acked inputs
    if (latest && latest !== applied) {
      applied = latest;
      g.applySnapshot(latest); // puppets, enemies, coins, tiles → authoritative
      const ack = latest.acks?.[slot] ?? -1;
      while (pending.length && pending[0].seq <= ack) ackHeld = pending.shift()!.h;
      auth = latest.players[slot] ?? null;
    }

    // 3. predict our own player + its interactions forward from the authoritative base
    if (auth) {
      g.guestPredict(slot, auth, toSteps());
      const p = g.roster[slot];
      const rawX = p.x;
      const rawY = p.y;
      if (!haveDisp) {
        dispX = rawX;
        dispY = rawY;
        haveDisp = true;
      } else {
        // carry by velocity (no lag during steady motion), then ease out the error
        dispX += p.vx * dt + (rawX - dispX) * SMOOTH_CORRECT;
        dispY += p.vy * dt + (rawY - dispY) * SMOOTH_CORRECT;
        const ex = rawX - dispX;
        const ey = rawY - dispY;
        if (ex * ex + ey * ey > SNAP_DIST * SNAP_DIST) {
          dispX = rawX; // big jump (respawn) — snap
          dispY = rawY;
        }
      }
      p.x = dispX;
      p.y = dispY;
    }

    g.renderFrame(dt);
    input.endFrame();
  });
}
