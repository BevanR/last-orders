import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { registerHealth } from '../src/health.js';
import { startServer } from './helpers.js';

describe('GET /healthz', () => {
  it('reports the database up when it answers', async () => {
    const srv = await startServer();
    try {
      const res = await fetch(`${srv.baseUrl}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, db: 'up' });
    } finally {
      await srv.close();
    }
  });

  it('returns 503 when the database query fails', async () => {
    const app = Fastify();
    registerHealth(app, { query: () => Promise.reject(new Error('connection refused')) } as unknown as Db);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: 'down' });
    await app.close();
  });

  it('returns 503 when the database does not answer in time', async () => {
    const app = Fastify();
    registerHealth(app, { query: () => new Promise(() => {}) } as unknown as Db, 50);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
