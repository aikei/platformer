// Relay server for co-op mode.
//
// The server knows nothing about the game: it only handles rooms, a host and
// peers, and forwards opaque payloads between them. The whole game protocol
// (level, input, state snapshots) lives inside the `data` field and never
// touches the server.
//
// Run: npm start   (PORT defaults to 8080)

import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);

// ---------- protocol ----------
//
// client → server:
//   { type: 'create' }                       — create a room, become host
//   { type: 'join', room: 'ABCD' }           — join as a guest
//   { type: 'to', target: 'host' | 'all' | <peerId>, data: any }
//
// server → client:
//   { type: 'created', room, id }
//   { type: 'joined', room, id, hostId, peers: [...] }
//   { type: 'peer-joined', id }              — to the host when a guest joins
//   { type: 'peer-left', id }                — to the host when a guest leaves
//   { type: 'host-left' }                    — to guests, the room is closing
//   { type: 'from', from, data }             — a forwarded message
//   { type: 'error', message }

interface Client {
  id: string;
  socket: WebSocket;
  room: string | null;
  isHost: boolean;
  alive: boolean;
}

interface Room {
  code: string;
  host: Client;
  guests: Map<string, Client>;
}

const rooms = new Map<string, Room>();

function makeRoomCode(): string {
  // no look-alike characters (0/O, 1/I) so the code is easy to read aloud
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code: string;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(client: Client, msg: unknown): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(msg));
  }
}

function leaveRoom(client: Client): void {
  if (!client.room) return;
  const room = rooms.get(client.room);
  client.room = null;
  if (!room) return;

  if (client.isHost) {
    // the host left — close the room, kick out the guests
    for (const guest of room.guests.values()) {
      send(guest, { type: 'host-left' });
      guest.room = null;
    }
    rooms.delete(room.code);
    console.log(`[room ${room.code}] closed (host left)`);
  } else {
    room.guests.delete(client.id);
    send(room.host, { type: 'peer-left', id: client.id });
    console.log(`[room ${room.code}] guest ${client.id} left (${room.guests.size} guests)`);
  }
}

function handleMessage(client: Client, msg: any): void {
  switch (msg.type) {
    case 'create': {
      leaveRoom(client);
      const code = makeRoomCode();
      client.room = code;
      client.isHost = true;
      rooms.set(code, { code, host: client, guests: new Map() });
      send(client, { type: 'created', room: code, id: client.id });
      console.log(`[room ${code}] created by host ${client.id}`);
      break;
    }

    case 'join': {
      const room = rooms.get(String(msg.room ?? '').toUpperCase());
      if (!room) {
        send(client, { type: 'error', message: 'room not found' });
        return;
      }
      leaveRoom(client);
      client.room = room.code;
      client.isHost = false;
      room.guests.set(client.id, client);
      send(client, {
        type: 'joined',
        room: room.code,
        id: client.id,
        hostId: room.host.id,
        peers: [room.host.id, ...room.guests.keys()].filter((id) => id !== client.id),
      });
      send(room.host, { type: 'peer-joined', id: client.id });
      console.log(`[room ${room.code}] guest ${client.id} joined (${room.guests.size} guests)`);
      break;
    }

    case 'to': {
      if (!client.room) {
        send(client, { type: 'error', message: 'not in a room' });
        return;
      }
      const room = rooms.get(client.room);
      if (!room) return;
      const wrapped = { type: 'from', from: client.id, data: msg.data };

      if (msg.target === 'host') {
        send(room.host, wrapped);
      } else if (msg.target === 'all') {
        // everyone in the room except the sender
        if (room.host !== client) send(room.host, wrapped);
        for (const guest of room.guests.values()) {
          if (guest !== client) send(guest, wrapped);
        }
      } else {
        // a specific peer by id
        const target = room.host.id === msg.target ? room.host : room.guests.get(String(msg.target));
        if (target) send(target, wrapped);
      }
      break;
    }

    default:
      send(client, { type: 'error', message: `unknown type: ${msg.type}` });
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — close the other process or set PORT`);
    process.exit(1);
  }
  throw err;
});

wss.on('connection', (socket) => {
  const client: Client = { id: randomUUID(), socket, room: null, isHost: false, alive: true };

  socket.on('pong', () => (client.alive = true));

  socket.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(client, { type: 'error', message: 'malformed JSON' });
      return;
    }
    handleMessage(client, msg);
  });

  socket.on('close', () => leaveRoom(client));
  socket.on('error', () => leaveRoom(client));

  // ping every 30s — drop dead connections
  const ping = setInterval(() => {
    if (!client.alive) {
      socket.terminate();
      return;
    }
    client.alive = false;
    socket.ping();
  }, 30000);
  socket.on('close', () => clearInterval(ping));
});

console.log(`relay listening on ws://0.0.0.0:${PORT}`);
