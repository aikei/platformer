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

  const latestHeld = new Map<number, { h: Held; seq: number }>(); // last 'held' per slot
  const prevHeld = new Map<number, Held>(); // previous — for computing press-edges
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
      if (slot != null) latestHeld.set(slot, { h: data.h, seq: data.seq });
    }
  };
  net.onPeerLeft = (id) => {
    const slot = slotOf.get(id);
    if (slot != null) game.roster[slot].out = true; // a guest who left is eliminated
  };

  let lastEpoch = game.epoch;
  loop((dt) => {
    game.roster[0].input = input.snapshot(bindings); // local player
    for (const [slot, entry] of latestHeld) {
      game.roster[slot].input = deriveInput(entry.h, prevHeld.get(slot) ?? EMPTY_HELD);
      prevHeld.set(slot, entry.h);
      ackSeq.set(slot, entry.seq); // this input is now baked into the upcoming snapshot
    }

    game.update(dt);

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

// How quickly a misprediction is visually absorbed: the position error captured
// when a snapshot corrects us decays by this factor each frame (~halves in ~4).
const SMOOTH_DECAY = 0.85;
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
  let offX = 0; // visual error offset, decayed each frame to hide corrections
  let offY = 0;

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
      offX = offY = 0;
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

    // 1. sample our input, send it, and remember it for replay
    const h = heldOf(input, bindings);
    seq++;
    net.send('host', { k: 'input', h, seq } satisfies GuestMsg);
    pending.push({ seq, h, dt });
    if (pending.length > 600) pending.shift(); // safety cap if snapshots stall

    // 2. fold in a new snapshot (if any) and re-predict our own player
    if (latest && latest !== applied) {
      const snap = latest;
      applied = snap;

      // where we predicted we'd be, just before the correction (for smoothing)
      let preX = 0;
      let preY = 0;
      let havePre = false;
      if (auth) {
        g.predictOwn(slot, auth, toSteps());
        preX = g.roster[slot].x;
        preY = g.roster[slot].y;
        havePre = true;
      }

      g.applySnapshot(snap); // puppets + own player set to authoritative
      const ack = snap.acks?.[slot] ?? -1;
      while (pending.length && pending[0].seq <= ack) ackHeld = pending.shift()!.h;
      auth = snap.players[slot] ?? null;

      if (auth) {
        g.predictOwn(slot, auth, toSteps());
        if (havePre) {
          const dx = preX - g.roster[slot].x;
          const dy = preY - g.roster[slot].y;
          if (dx * dx + dy * dy < SNAP_DIST * SNAP_DIST) {
            offX += dx; // absorb the correction into the offset so the sprite doesn't jump
            offY += dy;
          } else {
            offX = offY = 0; // big jump (respawn) — let it snap
          }
        }
      }
    } else if (auth) {
      g.predictOwn(slot, auth, toSteps()); // no new snapshot — advance prediction one frame
    }

    // 3. decay the smoothing offset and apply it to the rendered/camera position
    offX *= SMOOTH_DECAY;
    offY *= SMOOTH_DECAY;
    if (Math.abs(offX) < 0.3) offX = 0;
    if (Math.abs(offY) < 0.3) offY = 0;
    if (auth) {
      const p = g.roster[slot];
      p.x += offX;
      p.y += offY;
    }

    g.renderFrame(dt);
    input.endFrame();
  });
}
