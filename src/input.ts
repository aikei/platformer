// One player's intent for a frame. Serializable — this is exactly the field that
// will travel over the network from guest to host (Phase 1+). Game logic reads
// only InputState and doesn't know where it came from: keyboard or network.
export interface InputState {
  left: boolean;
  right: boolean;
  jump: boolean; // held — for variable jump height
  jumpPressed: boolean; // pressed in this very frame
  fire: boolean; // pressed in this very frame
}

export const EMPTY_INPUT: InputState = {
  left: false,
  right: false,
  jump: false,
  jumpPressed: false,
  fire: false,
};

// Key layout of one local player.
export interface Bindings {
  left: string[];
  right: string[];
  jump: string[];
  fire: string[];
}

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();

  constructor() {
    addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }

  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** true only on the frame of the press */
  wasPressed(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  /** Snapshot of a player's intent for their key layout. */
  snapshot(b: Bindings): InputState {
    return {
      left: this.isDown(...b.left),
      right: this.isDown(...b.right),
      jump: this.isDown(...b.jump),
      jumpPressed: this.wasPressed(...b.jump),
      fire: this.wasPressed(...b.fire),
    };
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
