import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';

/** How long the database probe may take before the check reports it down. */
const DB_PROBE_TIMEOUT_MS = 2_000;

/**
 * `GET /healthz`: 200 `{ ok: true, db: "up" }` when a `SELECT 1` answers in time, otherwise
 * 503 `{ ok: false, db: "down" }`. Fly's health check and deploys use it.
 */
export function registerHealth(app: FastifyInstance, db: Db, timeoutMs = DB_PROBE_TIMEOUT_MS) {
  // Fly probes this every few seconds; logging each request at info would bury the real logs.
  app.get('/healthz', { logLevel: 'warn' }, async (req, reply) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.query('SELECT 1'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`database probe timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return { ok: true, db: 'up' };
    } catch (err) {
      req.log.warn({ err }, 'health check: database unreachable');
      return reply.status(503).send({ ok: false, db: 'down' });
    } finally {
      clearTimeout(timer);
    }
  });
}
