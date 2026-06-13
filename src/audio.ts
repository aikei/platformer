import type { Biome } from './level';

// All music and sounds are synthesized via WebAudio — no audio files.
// The context is created lazily: browsers allow audio only after a user gesture.

type Wave = OscillatorType;

// Sound effects AudioSys can play (no arguments). The host records them by name
// and sends them to the guest so it plays the same thing.
export type SoundName =
  | 'jump'
  | 'coin'
  | 'stomp'
  | 'bump'
  | 'brick'
  | 'powerupAppear'
  | 'powerup'
  | 'fire'
  | 'hurt'
  | 'die'
  | 'win';

// melody and bass in semitones from C4 (null — rest), eighth notes
const MELODY: (number | null)[] = [
  12, null, 16, null, 19, null, 16, null,
  14, null, 17, null, 21, 19, 17, 14,
  16, null, 19, null, 24, null, 19, 16,
  14, 12, 9, 7, 12, null, null, null,
];
const BASS: (number | null)[] = [
  -12, null, -5, null, -12, null, -5, null,
  -7, null, 0, null, -7, null, 0, null,
  -15, null, -8, null, -15, null, -8, null,
  -17, null, -10, null, -17, null, -10, null,
];
const STEP_DUR = 0.21; // ~143 BPM

// key tuned to each biome's mood
const TRANSPOSE: Record<Biome, number> = { grass: 0, desert: 3, snow: 5, cave: -5 };

function freq(semitone: number): number {
  return 261.63 * Math.pow(2, semitone / 12); // from C4
}

export class AudioSys {
  private ctx: AudioContext | null = null;
  private sfxGain!: GainNode;
  private musicGain!: GainNode;
  private musicOn = true;
  private transpose = 0;
  private nextNote = 0;
  private step = 0;

  /** Called on the first key press/click — creates the context. */
  unlock(): void {
    this.ensure();
  }

  setBiome(b: Biome): void {
    this.transpose = TRANSPOSE[b];
  }

  toggleMusic(): boolean {
    this.musicOn = !this.musicOn;
    if (this.musicGain) {
      this.musicGain.gain.value = this.musicOn ? 1 : 0;
    }
    return this.musicOn;
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.5;
      this.sfxGain.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicOn ? 1 : 0;
      this.musicGain.connect(this.ctx.destination);
      this.nextNote = this.ctx.currentTime + 0.1;
      setInterval(() => this.scheduleMusic(), 60);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // schedule notes a little ahead of time
    const ahead = ctx.currentTime + 0.18;
    while (this.nextNote < ahead) {
      if (this.musicOn) {
        const m = MELODY[this.step % MELODY.length];
        if (m !== null) this.note(this.nextNote, m + this.transpose, STEP_DUR * 0.9, 'square', 0.05);
        const b = BASS[this.step % BASS.length];
        if (b !== null) this.note(this.nextNote, b + this.transpose, STEP_DUR, 'triangle', 0.1);
      }
      this.nextNote += STEP_DUR;
      this.step++;
    }
  }

  private note(time: number, semi: number, dur: number, type: Wave, vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq(semi);
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    o.connect(g);
    g.connect(this.musicGain);
    o.start(time);
    o.stop(time + dur);
  }

  /** Short sound with a frequency glide. */
  private beep(f0: number, f1: number, dur: number, type: Wave, vol = 0.3, delay = 0): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.sfxGain);
    o.start(t);
    o.stop(t + dur);
  }

  private noise(dur: number, vol = 0.3): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
  }

  jump(): void {
    this.beep(250, 600, 0.18, 'square', 0.18);
  }

  coin(): void {
    this.beep(988, 988, 0.07, 'square', 0.2);
    this.beep(1319, 1319, 0.25, 'square', 0.2, 0.07);
  }

  stomp(): void {
    this.beep(350, 90, 0.14, 'square', 0.25);
  }

  bump(): void {
    this.beep(140, 90, 0.09, 'triangle', 0.3);
  }

  brick(): void {
    this.noise(0.18, 0.25);
    this.beep(220, 110, 0.12, 'triangle', 0.2);
  }

  powerupAppear(): void {
    for (let i = 0; i < 6; i++) this.beep(300 + i * 90, 300 + i * 90, 0.07, 'sine', 0.15, i * 0.045);
  }

  powerup(): void {
    const semis = [0, 4, 7, 12, 16];
    semis.forEach((s, i) => this.beep(freq(s + 12), freq(s + 12), 0.09, 'square', 0.18, i * 0.07));
  }

  fire(): void {
    this.beep(700, 200, 0.12, 'sawtooth', 0.15);
  }

  hurt(): void {
    this.beep(400, 150, 0.25, 'sawtooth', 0.2);
  }

  die(): void {
    const semis = [12, 7, 4, 0, -5];
    semis.forEach((s, i) => this.beep(freq(s), freq(s), 0.14, 'square', 0.2, i * 0.12));
  }

  win(): void {
    const semis = [0, 4, 7, 12, 16, 19, 24];
    semis.forEach((s, i) => this.beep(freq(s + 12), freq(s + 12), 0.12, 'square', 0.18, i * 0.09));
  }
}
