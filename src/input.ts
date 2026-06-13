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

  /** true только в кадре нажатия */
  wasPressed(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
