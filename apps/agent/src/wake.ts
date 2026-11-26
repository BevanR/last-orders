import { createServer, type Server } from 'node:http';
import type { Worker } from './worker.js';

/** How often a held `/wake` response gets a heartbeat line, so no proxy treats it as idle. */
const WAKE_HEARTBEAT_MS = 10_000;

/**
 * The agent's only public surface. `POST /wake` carries no data: it means "work exists" and
 * starts a drain. `GET /healthz` reports liveness.
 *
 * `/wake` answers 202 at once but keeps the response open until the drain is done (heartbeat
 * lines meanwhile, then a final line). The Sprite is suspended when no request to it is open,
 * even while the agent waits on the app or the model; the open wake request keeps it awake for
 * the whole drain (infra/sprite/FINDINGS.md).
 */
export function createWakeServer(
  worker: Worker,
  log: (msg: string) => void = () => {},
  opts: { heartbeatMs?: number } = {},
): Server {
  const heartbeatMs = opts.heartbeatMs ?? WAKE_HEARTBEAT_MS;
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'POST' && path === '/wake') {
      req.resume();
      res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.write('accepted\n');
      const beat = setInterval(() => res.write('working\n'), heartbeatMs);
      res.on('close', () => clearInterval(beat));
      void worker
        .wake()
        .then(
          (n) => `done ${n}\n`,
          (err: Error) => {
            log(`drain failed: ${err.message}`);
            return 'failed\n';
          },
        )
        .then((line) => {
          clearInterval(beat);
          if (!res.writableEnded) res.end(line);
        });
      return;
    }
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, busy: worker.busy }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
  });
}
