import { createServer, type Server } from 'node:http';
import type { Worker } from './worker.js';

/**
 * The agent's only public surface. `POST /wake` carries no data: it means "work exists" and
 * starts a drain. `GET /healthz` reports liveness.
 */
export function createWakeServer(worker: Worker, log: (msg: string) => void = () => {}): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'POST' && path === '/wake') {
      req.resume();
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}');
      void worker.wake().catch((err: Error) => log(`drain failed: ${err.message}`));
      return;
    }
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, busy: worker.busy }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
  });
}
