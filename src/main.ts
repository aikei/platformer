import { AudioSys } from './audio';
import { Game } from './game';
import { Input } from './input';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const input = new Input();
const audio = new AudioSys();
const game = new Game(ctx, input, audio);

// браузер разрешает звук только после жеста пользователя
const unlock = () => audio.unlock();
addEventListener('keydown', unlock, { once: true });
addEventListener('pointerdown', unlock, { once: true });

let last = performance.now();
function frame(now: number): void {
  // ограничиваем dt, чтобы при сворачивании вкладки не было гигантского шага
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;

  game.update(dt);
  game.render();
  input.endFrame();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
