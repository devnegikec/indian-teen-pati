/**
 * Local demo helper: creates a room with bots that play automatically so a
 * single human can try the table.
 *
 * Usage:
 *   node scripts/demo-bots.mjs <humanToken> [botCount]
 *
 * It prints a room code. Open the app, join with that code, press "I am ready"
 * and the bot administrator starts the round. Bots call the current chaal (or
 * fold when they cannot afford it) and ready up again after every settlement.
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const [humanToken, botArg] = process.argv.slice(2);
const botCount = Number(botArg ?? 2);

if (!humanToken) {
  console.error('Usage: node scripts/demo-bots.mjs <humanToken> [botCount]');
  process.exit(1);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path}: ${data?.error ?? response.status}`);
  return data;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}
function act(socket, roomId, type, payload = {}) {
  socket.emit('room:action', { roomId, actionId: crypto.randomUUID(), type, payload });
}

const names = ['Ana', 'Ben', 'Chitra', 'Dev'];
const bots = [];
for (let i = 0; i < botCount; i++) {
  const user = await api('/api/auth/guest', { method: 'POST', body: { name: `Bot ${names[i % names.length]}` } });
  bots.push(user);
}

const host = bots[0];
const created = await api('/api/rooms', {
  token: host.token,
  method: 'POST',
  body: {
    name: 'Demo table (bots)',
    rules: {
      boot: 20,
      minBoot: 10,
      startingChips: 5000,
      disputeWindowSeconds: 8,
      dealingMode: process.env.MODE ?? 'THREE_CARD',
      maxBetsPerRound: Number(process.env.BET_CAP ?? 24),
    },
  },
});
const roomId = created.roomId;

await api(`/api/rooms/${created.code}/join`, { token: humanToken, method: 'POST' });
for (const bot of bots.slice(1)) {
  await api(`/api/rooms/${created.code}/join`, { token: bot.token, method: 'POST' });
}

const sockets = new Map();
for (const bot of bots) {
  const socket = await connect(bot.token);
  socket.on('connect', () => socket.emit('room:join', { roomId }));
  socket.emit('room:join', { roomId });
  sockets.set(bot.userId, socket);
}

const humanSocket = await connect(humanToken);
humanSocket.on('connect', () => humanSocket.emit('room:join', { roomId }));
humanSocket.emit('room:join', { roomId });

const hostSocket = sockets.get(host.userId);
let lastRoundId = null;
let waiting = false;
let latestView = null;
const blindCounts = new Map();

function readyAndStart() {
  for (const bot of bots) act(sockets.get(bot.userId), roomId, 'READY', { ready: true });
  // only start once everyone in the room is ready, so a human can join in
  setTimeout(() => {
    const everyoneReady = !latestView || latestView.players.every((p) => p.ready);
    if (everyoneReady) act(hostSocket, roomId, 'START_ROUND');
  }, 800);
}

for (const bot of bots) {
  const socket = sockets.get(bot.userId);
  socket.on('room:view', (view) => {
    latestView = view;
    const round = view.round;
    if (!round || round.state === 'SETTLED' || round.state === 'VOID') {
      if (waiting) return;
      waiting = true;
      setTimeout(() => {
        waiting = false;
        readyAndStart();
      }, 2000);
      return;
    }
    if (round.id !== lastRoundId) {
      lastRoundId = round.id;
      console.log(`Round ${round.seq} dealt. Pot ${round.pot}.`);
    }
    const me = view.players.find((p) => p.userId === bot.userId);
    if (round.state === 'BETTING' && me?.isTurn && me.legal) {
      setTimeout(() => {
        if (!me.legal) return;
        const blind = me.blind;
        const sees = (blindCounts.get(bot.userId) ?? 0) >= 2;
        if (blind && sees) {
          blindCounts.set(bot.userId, 0);
          act(socket, roomId, 'SEE_CARDS');
          return;
        }
        if (blind) blindCounts.set(bot.userId, (blindCounts.get(bot.userId) ?? 0) + 1);
        if (Math.random() < 0.18 && me.legal.raise.allowed) {
          act(socket, roomId, 'RAISE', { amount: me.legal.chaal.amount * 2 });
        } else if (me.chips >= me.legal.chaal.amount) {
          act(socket, roomId, 'CHAAL');
        } else {
          act(socket, roomId, 'FOLD');
        }
      }, 600 + Math.random() * 800);
    }
  });
  socket.on('room:error', (error) => console.log(`[${bot.name}] ${error.message}`));
}

humanSocket.on('room:error', (error) => console.log(`[you] ${error.message}`));

console.log(`Demo room created: ${created.code} (id ${roomId})`);
console.log(`Join at http://localhost:5173/#/join/${created.code} then press "I am ready".`);
console.log('Press Ctrl+C to stop.');
readyAndStart();
