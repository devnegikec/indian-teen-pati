import express from 'express';
import { createServer } from 'node:http';
import { Server as IOServer, Socket } from 'socket.io';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from './db';
import { AppError, GameService } from './game';
import { RankingError } from '../rules/ranking';

const PORT = Number(process.env.PORT ?? 3000);
const DB_FILE = process.env.DATABASE_FILE ?? join(process.cwd(), 'data', 'teenpatti.db');

const db = openDatabase(DB_FILE);

const app = express();
app.use(express.json({ limit: '1mb' }));

const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: true, credentials: true },
});

let game: GameService;

function broadcastRoom(roomId: string): void {
  for (const socket of io.sockets.sockets.values()) {
    const s = socket as Socket;
    if (s.data?.roomId !== roomId || !s.data?.userId) continue;
    try {
      s.emit('room:view', game.roomView(roomId, s.data.userId as string));
    } catch (error) {
      s.emit('room:error', { message: (error as Error).message });
    }
  }
}

game = new GameService(db, broadcastRoom);

function userIdFromRequest(req: express.Request): string | null {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-guest-token'] as string | undefined);
  return game.userForToken(token)?.userId ?? null;
}

function requireUser(req: express.Request, res: express.Response): string | null {
  const userId = userIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ error: 'Not signed in.' });
    return null;
  }
  return userId;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/api/auth/guest', (req, res) => {
  const name = String(req.body?.name ?? '');
  const user = game.createGuest(name);
  res.json(user);
});

app.get('/api/me', (req, res) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-guest-token'] as string | undefined);
  const user = game.userForToken(token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  res.json(user);
});

app.get('/api/profiles', (_req, res) => {
  res.json(game.listProfiles());
});

app.post('/api/profiles', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const saved = game.saveProfile(req.body, userId);
    res.json(saved);
  } catch (error) {
    if (error instanceof RankingError) return res.status(400).json({ error: error.message, code: error.code });
    throw error;
  }
});

app.delete('/api/profiles/:id', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  game.deleteProfile(req.params.id);
  res.json({ ok: true });
});

app.post('/api/rooms', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const room = game.createRoom(userId, String(req.body?.name ?? ''), req.body?.rules ?? {}, req.body?.rankingProfileId);
  res.json({ roomId: room.id, code: room.code });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = db
    .prepare('SELECT id, code, name, rules_json FROM rooms WHERE UPPER(code) = UPPER(?)')
    .get(req.params.code) as { id: string; code: string; name: string; rules_json: string } | undefined;
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json({ id: room.id, code: room.code, name: room.name, rules: JSON.parse(room.rules_json) });
});

app.post('/api/rooms/:code/join', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const room = game.joinRoom(req.params.code, userId);
    res.json({ roomId: room.id, code: room.code });
  } catch (error) {
    if (error instanceof AppError) return res.status(400).json({ error: error.message, code: error.code });
    throw error;
  }
});

app.get('/api/rooms/:roomId/view', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    res.json(game.roomView(req.params.roomId, userId));
  } catch (error) {
    if (error instanceof AppError) return res.status(400).json({ error: error.message, code: error.code });
    throw error;
  }
});

app.get('/api/rooms/:roomId/audit', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const roomId = req.params.roomId;
  res.json({
    actions: db.prepare('SELECT id, round_id, user_id, type, payload_json, created_at FROM actions WHERE room_id = ? ORDER BY created_at DESC LIMIT 200').all(roomId),
    transactions: db
      .prepare('SELECT id, round_id, user_id, delta, reason, created_at FROM chip_transactions WHERE room_id = ? ORDER BY created_at DESC LIMIT 200')
      .all(roomId),
    disputes: db.prepare('SELECT * FROM disputes WHERE room_id = ? ORDER BY created_at DESC').all(roomId),
  });
});

/* ------------------------------ sockets ------------------------------ */

io.use((socket, next) => {
  const token = (socket.handshake.auth?.token as string | undefined) ?? (socket.handshake.query?.token as string | undefined);
  const user = game.userForToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.userId;
  socket.data.name = user.name;
  next();
});

io.on('connection', (socket: Socket) => {
  socket.on('room:join', ({ roomId, code }: { roomId?: string; code?: string }) => {
    try {
      const room = game.joinRoom(roomId ?? code ?? '', socket.data.userId);
      socket.data.roomId = room.id;
      socket.join(`room:${room.id}`);
      game.setConnected(room.id, socket.data.userId, true);
      socket.emit('room:view', game.roomView(room.id, socket.data.userId));
    } catch (error) {
      socket.emit('room:error', { message: (error as Error).message, code: (error as AppError).code });
    }
  });

  socket.on('room:leave', () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    game.setConnected(roomId, socket.data.userId, false);
    socket.leave(`room:${roomId}`);
    socket.data.roomId = undefined;
  });

  socket.on('room:action', ({ roomId, actionId, type, payload }: { roomId: string; actionId?: string; type: string; payload?: Record<string, unknown> }) => {
    try {
      game.handleAction(roomId, socket.data.userId, type, payload, actionId);
    } catch (error) {
      socket.emit('room:error', {
        message: (error as Error).message,
        code: (error as AppError).code ?? 'ERROR',
        actionId,
      });
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId as string | undefined;
    if (roomId) {
      try {
        game.setConnected(roomId, socket.data.userId, false);
      } catch {
        /* room may be gone */
      }
    }
  });
});

/* ------------------------------ static ------------------------------ */

const clientDir = join(process.cwd(), 'dist', 'client');
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(clientDir, 'index.html'));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof AppError) return res.status(400).json({ error: error.message, code: error.code });
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

httpServer.listen(PORT, () => {
  console.log(`Teen Patti server listening on http://localhost:${PORT} (db: ${DB_FILE})`);
});

export { app, httpServer, game };
