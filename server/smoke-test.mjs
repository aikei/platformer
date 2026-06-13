// Quick smoke test of the relay: host creates a room, guest joins, guest sends a
// message to the host, host replies to the guest. Run: node server/smoke-test.mjs
import { WebSocket } from 'ws';

const URL = process.env.RELAY_URL ?? 'ws://127.0.0.1:8080';
const log = (who, m) => console.log(`  ${who}: ${JSON.stringify(m)}`);
const next = (ws) => new Promise((res) => ws.once('message', (r) => res(JSON.parse(r.toString()))));
const open = (ws) => new Promise((res) => ws.once('open', res));

let failed = false;
function check(cond, label) {
  console.log(`${cond ? 'OK ' : 'FAIL'}  ${label}`);
  if (!cond) failed = true;
}

const host = new WebSocket(URL);
await open(host);
host.send(JSON.stringify({ type: 'create' }));
const created = await next(host);
log('host', created);
check(created.type === 'created' && /^[A-Z2-9]{4}$/.test(created.room), 'host gets room code');

const guest = new WebSocket(URL);
await open(guest);
guest.send(JSON.stringify({ type: 'join', room: created.room }));
const [joined, peerJoined] = await Promise.all([next(guest), next(host)]);
log('guest', joined);
log('host', peerJoined);
check(joined.type === 'joined' && joined.hostId === created.id, 'guest joins, sees host id');
check(peerJoined.type === 'peer-joined' && peerJoined.id === joined.id, 'host notified of guest');

guest.send(JSON.stringify({ type: 'to', target: 'host', data: { hello: 'from guest' } }));
const atHost = await next(host);
log('host', atHost);
check(atHost.type === 'from' && atHost.from === joined.id && atHost.data.hello === 'from guest', 'guest→host relay');

host.send(JSON.stringify({ type: 'to', target: 'all', data: { snapshot: 42 } }));
const atGuest = await next(guest);
log('guest', atGuest);
check(atGuest.type === 'from' && atGuest.data.snapshot === 42, 'host→all relay');

// the guest leaves — the host should get peer-left
guest.close();
const left = await next(host);
log('host', left);
check(left.type === 'peer-left' && left.id === joined.id, 'host notified of guest leaving');

host.close();
console.log(failed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
process.exit(failed ? 1 : 0);
