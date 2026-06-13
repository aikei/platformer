// Client transport on top of the relay (server/relay.ts).
//
// Net knows nothing about the game — it only connects, creates/joins a room and
// forwards arbitrary data. The game protocol (level, input, snapshots) is built
// on top of send()/onMessage in the game code.

// Relay URL: in production set via VITE_RELAY_URL (e.g. wss://game.example.com),
// otherwise defaults to the same host, port 8080 (for local development).
const RELAY_URL =
  (import.meta.env.VITE_RELAY_URL as string | undefined) ?? `ws://${location.hostname}:8080`;

export type PeerId = string;
export type SendTarget = 'host' | 'all' | PeerId;

export class Net {
  private socket: WebSocket | null = null;
  id: PeerId = '';
  room = '';
  isHost = false;
  peers = new Set<PeerId>();

  // callbacks set by the game code
  onPeerJoined: (id: PeerId) => void = () => {};
  onPeerLeft: (id: PeerId) => void = () => {};
  onMessage: (from: PeerId, data: any) => void = () => {};
  onHostLeft: () => void = () => {};
  onClose: () => void = () => {};

  /** Create a room. Returns the code to give to guests. */
  async host(): Promise<string> {
    await this.connect();
    const created = await this.request('create', {}, 'created');
    this.id = created.id;
    this.room = created.room;
    this.isHost = true;
    return created.room;
  }

  /** Join a room by code. */
  async join(code: string): Promise<void> {
    await this.connect();
    const joined = await this.request('join', { room: code.trim().toUpperCase() }, 'joined');
    this.id = joined.id;
    this.room = joined.room;
    this.isHost = false;
    this.peers = new Set(joined.peers);
  }

  /** Send data to the host, to everyone, or to a specific peer. */
  send(target: SendTarget, data: unknown): void {
    this.socket?.send(JSON.stringify({ type: 'to', target, data }));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  // ---------- internal ----------

  private connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(RELAY_URL);
      this.socket = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not connect to ${RELAY_URL}`));
      ws.onclose = () => {
        this.socket = null;
        this.onClose();
      };
      ws.onmessage = (ev) => this.dispatch(JSON.parse(ev.data));
    });
  }

  /** Send a message and wait for a reply of the expected type (or error). */
  private request(type: string, payload: object, expect: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = this.socket!;
      const onMsg = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === expect) {
          ws.removeEventListener('message', onMsg);
          resolve(msg);
        } else if (msg.type === 'error') {
          ws.removeEventListener('message', onMsg);
          reject(new Error(msg.message));
        }
        // other messages are ignored here — dispatch picks them up
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ type, ...payload }));
    });
  }

  private dispatch(msg: any): void {
    switch (msg.type) {
      case 'peer-joined':
        this.peers.add(msg.id);
        this.onPeerJoined(msg.id);
        break;
      case 'peer-left':
        this.peers.delete(msg.id);
        this.onPeerLeft(msg.id);
        break;
      case 'host-left':
        this.onHostLeft();
        break;
      case 'from':
        this.onMessage(msg.from, msg.data);
        break;
      // created/joined/error are handled in request()
    }
  }
}
