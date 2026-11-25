import { fileURLToPath } from 'node:url';

export interface Config {
  databaseUrl: string;
  /** Bearer secret for the internal agent API. Empty disables that API. */
  agentSharedSecret: string;
  /** The agent's wake endpoint. Empty disables wake pings. */
  agentWakeUrl: string;
  caseFile: string;
  port: number;
  host: string;
  /** Built web client. Served when it exists. */
  webDist: string;
  cookieSecure: boolean;
  leaseSeconds: number;
  maxJobAttempts: number;
  dispatcherIntervalMs: number;
  logLevel: string;
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/last_orders',
    agentSharedSecret: env.AGENT_SHARED_SECRET ?? '',
    agentWakeUrl: env.AGENT_WAKE_URL ?? '',
    caseFile: env.CASE_FILE ?? here('../../../packages/engine/test/fixtures/fixture.case.json'),
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    webDist: env.WEB_DIST ?? here('../../web/dist'),
    cookieSecure: env.COOKIE_INSECURE !== '1',
    leaseSeconds: Number(env.JOB_LEASE_SECONDS ?? 60),
    maxJobAttempts: Number(env.JOB_MAX_ATTEMPTS ?? 3),
    dispatcherIntervalMs: Number(env.DISPATCHER_INTERVAL_MS ?? 10_000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
