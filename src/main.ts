import { AudioSys } from './audio';
import { Bindings, Input } from './input';
import { runLobby } from './lobby';
import { runGuest, runHost, runLocal } from './session';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const input = new Input();
const audio = new AudioSys();

// the browser allows audio only after a user gesture
const unlock = () => audio.unlock();
addEventListener('keydown', unlock, { once: true });
addEventListener('pointerdown', unlock, { once: true });

// key layouts. In network and solo modes one player is at the keyboard — all the
// usual keys at once. In "two on one PC" mode the keyboard is split in half.
const SOLO: Bindings = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  jump: ['Space', 'ArrowUp', 'KeyW'],
  fire: ['KeyX', 'KeyJ'],
};
const PLAYER_1: Bindings = { left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['ArrowUp'], fire: ['Slash'] };
const PLAYER_2: Bindings = { left: ['KeyA'], right: ['KeyD'], jump: ['KeyW'], fire: ['KeyF'] };

async function main(): Promise<void> {
  const result = await runLobby();
  switch (result.mode) {
    case 'host':
      runHost(ctx, input, audio, result.net, SOLO);
      break;
    case 'guest':
      runGuest(ctx, input, audio, result.net, SOLO);
      break;
    case 'local2':
      runLocal(ctx, input, audio, [PLAYER_1, PLAYER_2]);
      break;
    default:
      runLocal(ctx, input, audio, [SOLO]);
  }
}

main();
