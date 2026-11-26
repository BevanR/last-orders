import { Agent, type Dispatcher } from 'undici';

/**
 * A connection pool with a short keep-alive, for the agent's outbound calls (the app's internal
 * API, the Sprites model gateway). The agent runs on a Sprite that is suspended when idle: a
 * pooled socket kept across a suspend/resume (or a redeploy of the other side) still looks
 * ESTABLISHED locally but is dead, and a request written to it hangs until its timeout. Short
 * keep-alive means idle sockets are closed long before that can happen; callers additionally
 * replace the pool and retry once when a request times out or fails at the network level.
 */
export function createShortKeepAliveDispatcher(): Dispatcher {
  return new Agent({ keepAliveTimeout: 2_000, keepAliveMaxTimeout: 4_000, connect: { timeout: 5_000 } });
}
