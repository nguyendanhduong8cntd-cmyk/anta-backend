import 'reflect-metadata';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { loadConfig } from '../../packages/config';
import { Database } from '../../packages/database';
import { RedisService } from '../../packages/redis';
import { verifyAccess, Principal } from '../../packages/auth/tokens';
import { digest } from '../../packages/auth/crypto';
import { requestContext } from '../../packages/observability/http';
import { ChatService } from '../../modules/chat/service';
import { Idempotency } from '../../packages/idempotency';
export function parseCursor(value: unknown) {
  if (value === undefined || value === '') return '0';
  if (typeof value !== 'string' || !/^\d{1,18}$/.test(value)) throw new Error('Invalid cursor');
  return value;
}
export async function createRealtime(port = loadConfig().realtimePort) {
  const config = loadConfig(), db = new Database(), redis = new RedisService();
  const chat = new ChatService(db, new Idempotency(db));
  const api = express(), server = createServer(api);
  const io = new Server(server, { cors: { origin: config.corsOrigins }, maxHttpBufferSize: 4096 });
  const authenticate = async (jwt: string): Promise<Principal> => {
    const principal = await verifyAccess(jwt, config.jwtSecret);
    const session = await db.query(`SELECT 1 FROM identity.refresh_sessions s JOIN identity.users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='ACTIVE'`, [principal.sessionId, principal.userId]);
    if (!session.rowCount) throw new Error('Session revoked');
    return principal;
  };
  const events = async (user: Principal, cursor: string) => (await db.query('SELECT id,type,payload,created_at,request_id FROM platform.outbox_events WHERE user_id=$1 AND id>$2 ORDER BY id LIMIT 100', [user.userId, cursor])).rows;
  api.disable('x-powered-by'); api.use(helmet()); api.use(requestContext);
  api.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  api.get('/api/v1/events', async (req: Request, res: Response) => {
    const jwt = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    let cursor: string;
    try { cursor = parseCursor(req.headers['last-event-id'] || req.query.after); }
    catch { res.status(400).json({ error: { code: 'INVALID_CURSOR' } }); return; }
    let user: Principal;
    try { await redis.rateLimit(`sse:ip:${digest(req.ip || 'unknown')}`, 20, 60000); user = await authenticate(jwt); }
    catch { res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); return; }
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    let running = false, closed = false;
    const poll = async () => {
      if (running || closed) return;
      running = true;
      try {
        await authenticate(jwt);
        for (const event of await events(user, cursor)) {
          if (!res.write(`id: ${event.id}\nevent: domain.event\ndata: ${JSON.stringify(event)}\n\n`)) { res.end(); break; }
          cursor = event.id;
        }
        if (!closed && !res.writableEnded) res.write(': heartbeat\n\n');
      } catch { res.end(); }
      finally { running = false; }
    };
    const timer = setInterval(poll, 2000);
    res.on('close', () => { closed = true; clearInterval(timer); });
    await poll();
  });
  io.use(async (socket, next) => {
    try {
      await redis.rateLimit(`socket:ip:${digest(socket.handshake.address)}`, 30, 60000);
      if (typeof socket.handshake.auth.token !== 'string') throw new Error();
      socket.data.user = await authenticate(socket.handshake.auth.token);
      socket.data.cursor = parseCursor(socket.handshake.auth.after);
      next();
    } catch { next(new Error('UNAUTHORIZED')); }
  });
  io.on('connection', socket => {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return; running = true;
      try {
        await authenticate(socket.handshake.auth.token);
        for (const event of await events(socket.data.user, socket.data.cursor)) {
          socket.emit('domain.event', event); socket.data.cursor = event.id;
          if (event.type === 'chat.message') socket.emit('message.new', event.payload);
        }
      } catch { socket.disconnect(true); } finally { running = false; }
    }, 2000);
    socket.on('message.send', async (data: unknown, ack: (result: unknown) => void) => {
      if (typeof ack !== 'function') return;
      try {
        const payload = data as Record<string, unknown>;
        if (!payload || typeof payload.conversationId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(payload.conversationId)
          || typeof payload.body !== 'string' || typeof payload.key !== 'string') throw new Error('INVALID_MESSAGE');
        await redis.rateLimit(`socket:send:${socket.data.user.userId}`, 60, 60000);
        const user = await authenticate(socket.handshake.auth.token);
        const message = await chat.send(user.userId, payload.conversationId, payload.body, payload.key);
        ack({ ok: true, data: message });
      } catch { ack({ ok: false, error: 'MESSAGE_REJECTED' }); }
    });
    socket.on('disconnect', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(port, config.bindHost, resolve));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; server.closeAllConnections(); await new Promise<void>(resolve => io.close(() => resolve()));
    await db.onModuleDestroy(); await redis.onModuleDestroy(); };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  console.log(JSON.stringify({ event: 'realtime.started', port: (server.address() as { port: number }).port }));
  return { server, stop };
}
if (require.main === module) createRealtime().catch(() => { console.error(JSON.stringify({ event: 'realtime.start_failed' })); process.exitCode = 1; });
