// Checks the co-op network exchange over the relay: ready → init (addressed to a
// specific peer), snap (to everyone), input (to the host). Run: node server/coop-relay-test.mjs
import { WebSocket } from 'ws';

const URL = process.env.RELAY_URL ?? 'ws://127.0.0.1:8080';
const next = (ws) => new Promise((res) => ws.once('message', (r) => res(JSON.parse(r.toString()))));
const open = (ws) => new Promise((res) => ws.once('open', res));

let failed = false;
const check = (cond, label) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}`);
  if (!cond) failed = true;
};

const host = new WebSocket(URL);
await open(host);
host.send(JSON.stringify({ type: 'create' }));
const created = await next(host);

const guest = new WebSocket(URL);
await open(guest);
guest.send(JSON.stringify({ type: 'join', room: created.room }));
const [joined, peerJoined] = await Promise.all([next(guest), next(host)]);
const guestId = joined.id;
check(peerJoined.id === guestId, 'host knows the guest id');

// guest asks for initialization
guest.send(JSON.stringify({ type: 'to', target: 'host', data: { k: 'ready' } }));
const ready = await next(host);
check(ready.type === 'from' && ready.data.k === 'ready' && ready.from === guestId, 'ready reached the host');

// host replies with init addressed to this guest (target = peerId)
const level = { biome: 'grass', rows: ['###', '   '], spawns: [{ type: 'player', x: 8, y: 0 }] };
host.send(JSON.stringify({ type: 'to', target: guestId, data: { k: 'init', level, slot: 1, count: 2 } }));
const init = await next(guest);
check(init.type === 'from' && init.data.k === 'init', 'init reached the guest (targeted send)');
check(init.data.slot === 1 && init.data.count === 2, 'init carries slot/count');
check(JSON.stringify(init.data.level) === JSON.stringify(level), 'init carries the whole level');

// host sends a snapshot to everyone
host.send(JSON.stringify({ type: 'to', target: 'all', data: { k: 'snap', s: { score: 42 } } }));
const snap = await next(guest);
check(snap.type === 'from' && snap.data.k === 'snap' && snap.data.s.score === 42, 'snap reached the guest');

// guest sends input to the host
guest.send(JSON.stringify({ type: 'to', target: 'host', data: { k: 'input', h: { left: true } } }));
const inp = await next(host);
check(inp.type === 'from' && inp.data.k === 'input' && inp.data.h.left === true, 'input reached the host');

host.close();
guest.close();
console.log(failed ? '\nCOOP RELAY TEST FAILED' : '\nCOOP RELAY TEST PASSED');
process.exit(failed ? 1 : 0);
