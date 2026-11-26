import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { readableAudienceKeys } from '@last-orders/engine';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { checkBearer, requireHost, requireMember, setSessionCookie } from './auth.js';
import { CaseStore } from './cases.js';
import type { Config } from './config.js';
import { createPool, migrate, type Db } from './db.js';
import { Dispatcher } from './dispatcher.js';
import { HttpError, parseBody, toHttpError } from './errors.js';
import { NotifyHub } from './events.js';
import { GameService } from './game.js';
import { registerHealth } from './health.js';
import { CompleteBodySchema, FailBodySchema, JobQueue } from './jobs.js';
import { RateLimiter } from './ratelimit.js';

export interface AppContext {
  app: FastifyInstance;
  db: Db;
  jobs: JobQueue;
  dispatcher: Dispatcher;
  games: GameService;
  hub: NotifyHub;
  cases: CaseStore;
}

const NameSchema = z.object({ displayName: z.string().trim().min(1).max(40) });
const TextSchema = z.object({ text: z.string().trim().min(1).max(500) });
const IdParam = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const InspectBody = z.object({ locationId: IdParam, actionId: IdParam });
const AccuseBody = z.object({
  suspectId: IdParam,
  evidenceIds: z.array(IdParam).max(10),
  reasoning: z.string().trim().max(1_000).default(''),
});
const EvidenceBody = z.object({ evidenceId: IdParam });
const HostClaimBody = z.object({ hostToken: z.string().min(16).max(128) });

interface RoomParams {
  code: string;
}
interface SuspectParams extends RoomParams {
  suspectId: string;
}

export async function buildApp(
  config: Config,
  opts: { logger?: boolean; startDispatcher?: boolean; fetch?: typeof fetch } = {},
): Promise<AppContext> {
  const db = createPool(config.databaseUrl);
  await migrate(db);
  const cases = new CaseStore(db);
  await cases.loadCurrent(config.caseFile);

  const app = Fastify({
    logger: opts.logger ? { level: config.logLevel } : false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  const log = (msg: string) => app.log.info(msg);

  const hub = new NotifyHub(config.databaseUrl, (m) => app.log.warn(m));
  await hub.start();
  const jobs = new JobQueue(db, cases, { leaseSeconds: config.leaseSeconds, maxAttempts: config.maxJobAttempts });
  // The dispatcher and the game service refer to each other: upkeep runs on dispatcher ticks,
  // and player actions kick the dispatcher.
  let games: GameService | null = null;
  const dispatcher = new Dispatcher(jobs, {
    wakeUrl: config.agentWakeUrl,
    intervalMs: config.dispatcherIntervalMs,
    fetch: opts.fetch,
    log,
    periodic: () => games!.periodic(),
  });
  games = new GameService(db, cases, jobs, () => dispatcher.kick(), {
    gmTickMs: config.gmTickSeconds * 1000,
    idleMs: config.gmIdleMinutes * 60_000,
  });

  await app.register(fastifyCookie);

  app.setErrorHandler((rawErr, req, reply) => {
    const err = toHttpError(rawErr);
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong.' });
  });

  // Rate limits (per process).
  const roomsPerIp = new RateLimiter(10, 60_000);
  const joinsPerIp = new RateLimiter(20, 60_000);
  const turnsPerPlayer = new RateLimiter(20, 60_000);
  const actionsPerPlayer = new RateLimiter(60, 60_000);
  const limit = (limiter: RateLimiter, key: string) => {
    if (!limiter.take(key)) throw new HttpError(429, 'rate_limited', 'Slow down a little.');
  };

  const member = (req: FastifyRequest<{ Params: RoomParams }>) => requireMember(db, req, req.params.code);

  // ---- Public API ----

  registerHealth(app, db);

  app.post('/api/rooms', async (req, reply) => {
    limit(roomsPerIp, req.ip);
    const { displayName } = parseBody(NameSchema, req.body);
    const r = await games!.createRoom(displayName);
    // A sleeping agent can take minutes to wake. Wake it now, before the first job exists.
    dispatcher.prewarm();
    setSessionCookie(reply, r.sessionToken, config.cookieSecure);
    return { roomCode: r.roomCode, hostUrl: `/h/${r.hostToken}`, inviteUrl: `/r/${r.roomCode}` };
  });

  app.post<{ Params: RoomParams }>('/api/rooms/:code/join', async (req, reply) => {
    limit(joinsPerIp, req.ip);
    const { displayName } = parseBody(NameSchema, req.body);
    const r = await games!.join(req.params.code, displayName);
    setSessionCookie(reply, r.sessionToken, config.cookieSecure);
    return { roomCode: req.params.code.toUpperCase() };
  });

  app.post('/api/host/claim', async (req, reply) => {
    limit(joinsPerIp, req.ip);
    const { hostToken } = parseBody(HostClaimBody, req.body);
    const r = await games!.claimHost(hostToken);
    setSessionCookie(reply, r.sessionToken, config.cookieSecure);
    return { roomCode: r.roomCode };
  });

  app.get<{ Params: RoomParams }>('/api/rooms/:code/state', async (req) => games!.view(await member(req)));

  app.post<{ Params: RoomParams }>('/api/rooms/:code/start', async (req) => {
    const s = await member(req);
    requireHost(s);
    await games!.start(s);
    // The lobby can last long enough for the agent to fall asleep again.
    dispatcher.prewarm();
    return { ok: true };
  });

  app.post<{ Params: RoomParams }>('/api/rooms/:code/advance', async (req) => {
    const s = await member(req);
    requireHost(s);
    await games!.advance(s);
    return { ok: true };
  });

  app.post<{ Params: RoomParams }>('/api/rooms/:code/inspect', async (req) => {
    const s = await member(req);
    limit(actionsPerPlayer, s.playerId);
    const { locationId, actionId } = parseBody(InspectBody, req.body);
    return games!.inspect(s, locationId, actionId);
  });

  app.post<{ Params: RoomParams }>('/api/rooms/:code/accuse', async (req) => {
    const s = await member(req);
    limit(actionsPerPlayer, s.playerId);
    const { suspectId, evidenceIds, reasoning } = parseBody(AccuseBody, req.body);
    return games!.accuse(s, suspectId, evidenceIds, reasoning);
  });

  app.post<{ Params: RoomParams }>('/api/rooms/:code/end', async (req) => {
    const s = await member(req);
    requireHost(s);
    await games!.end(s);
    return { ok: true };
  });

  app.post<{ Params: RoomParams }>('/api/rooms/:code/hint', async (req) => {
    const s = await member(req);
    requireHost(s);
    return games!.giveHint(s);
  });

  app.post<{ Params: RoomParams }>('/api/rooms/:code/share', async (req) => {
    const s = await member(req);
    limit(actionsPerPlayer, s.playerId);
    const { evidenceId } = parseBody(EvidenceBody, req.body);
    return games!.share(s, evidenceId);
  });

  app.get<{ Params: SuspectParams }>('/api/rooms/:code/interviews/:suspectId', async (req) => {
    const s = await member(req);
    return games!.interview(s, parseBody(IdParam, req.params.suspectId));
  });

  app.post<{ Params: SuspectParams }>('/api/rooms/:code/interviews/:suspectId/messages', async (req) => {
    const s = await member(req);
    limit(turnsPerPlayer, s.playerId);
    const { text } = parseBody(TextSchema, req.body);
    return { message: await games!.sendMessage(s, parseBody(IdParam, req.params.suspectId), text) };
  });

  app.post<{ Params: SuspectParams }>('/api/rooms/:code/interviews/:suspectId/present', async (req) => {
    const s = await member(req);
    limit(turnsPerPlayer, s.playerId);
    const { evidenceId } = parseBody(EvidenceBody, req.body);
    return { message: await games!.present(s, parseBody(IdParam, req.params.suspectId), evidenceId) };
  });

  // ---- Server-sent events ----

  const streams = new Set<ServerResponse>();

  app.get<{ Params: RoomParams; Querystring: { lastEventId?: string } }>(
    '/api/rooms/:code/events',
    async (req, reply) => {
      const s = await member(req);
      const header = req.headers['last-event-id'];
      let cursor = Number((Array.isArray(header) ? header[0] : header) ?? req.query.lastEventId ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
      const audiences = readableAudienceKeys({ playerId: s.playerId, isHost: s.isHost });

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      streams.add(res);

      let pumping = false;
      let again = false;
      let closed = false;
      const pump = async () => {
        if (pumping) {
          again = true;
          return;
        }
        pumping = true;
        try {
          do {
            again = false;
            const { rows } = await db.query<{ seq: string; type: string; payload: unknown }>(
              `SELECT seq, type, payload FROM game_events
                WHERE game_id = $1 AND seq > $2 AND audience = ANY($3)
                ORDER BY seq LIMIT 200`,
              [s.gameId, cursor, audiences],
            );
            for (const row of rows) {
              if (closed) return;
              res.write(`id: ${row.seq}\ndata: ${JSON.stringify({ type: row.type, payload: row.payload })}\n\n`);
              cursor = Number(row.seq);
            }
            if (rows.length === 200) again = true;
          } while (again && !closed);
        } catch (err) {
          req.log.warn(err, 'sse pump failed');
        } finally {
          pumping = false;
        }
      };

      const unsubscribe = hub.subscribe(s.gameId, () => void pump());
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(res);
      };
      req.raw.on('close', close);
      res.on('close', close);
      await pump();
    },
  );

  // ---- Internal agent API ----

  app.register(async (internal) => {
    internal.addHook('onRequest', async (req) => {
      if (!config.agentSharedSecret) throw new HttpError(503, 'agent_api_disabled', 'AGENT_SHARED_SECRET is not set.');
      if (!checkBearer(req.headers.authorization, config.agentSharedSecret)) throw new HttpError(401, 'unauthorized');
    });

    internal.post('/internal/agent/jobs/claim', async (_req, reply) => {
      const job = await jobs.claim();
      if (!job) return reply.status(204).send();
      return job;
    });

    internal.post<{ Params: { id: string } }>('/internal/agent/jobs/:id/complete', async (req) => {
      const id = parseBody(z.string().regex(/^\d{1,18}$/), req.params.id);
      const result = await jobs.complete(id, parseBody(CompleteBodySchema, req.body));
      if (result.status === 'requeued') dispatcher.kick();
      return result;
    });

    internal.post<{ Params: { id: string } }>('/internal/agent/jobs/:id/fail', async (req) => {
      const id = parseBody(z.string().regex(/^\d{1,18}$/), req.params.id);
      const body = parseBody(FailBodySchema, req.body);
      const result = await jobs.fail(id, body.leaseToken, body.error);
      if (result.status === 'pending') dispatcher.kick();
      return result;
    });
  });

  // ---- Web client ----

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      if (req.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/internal/'))
        return reply.type('text/html').sendFile('index.html');
      return reply.status(404).send({ error: 'not_found', message: 'Not found.' });
    });
  }

  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
    streams.clear();
  });
  app.addHook('onClose', async () => {
    dispatcher.stop();
    await hub.close();
    await db.end();
  });

  if (opts.startDispatcher !== false) dispatcher.start();
  return { app, db, jobs, dispatcher, games: games!, hub, cases };
}
