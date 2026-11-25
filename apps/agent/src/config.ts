import { readFileSync } from 'node:fs';

export interface AgentConfig {
  appUrl: string;
  sharedSecret: string;
  adapter: 'simulated' | 'anthropic';
  model: string;
  anthropicBaseUrl: string | undefined;
  anthropicApiKey: string | undefined;
  port: number;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const adapter = env.MODEL_ADAPTER ?? 'simulated';
  if (adapter !== 'simulated' && adapter !== 'anthropic')
    throw new Error(`MODEL_ADAPTER must be "simulated" or "anthropic", got "${adapter}"`);
  const sharedSecret = readSharedSecret(env);
  return {
    appUrl: env.APP_URL ?? 'http://localhost:8080',
    sharedSecret,
    adapter,
    model: env.MODEL ?? 'claude-sonnet-5-5',
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    port: Number(env.PORT ?? 8081),
  };
}

/**
 * `AGENT_SHARED_SECRET`, or the trimmed contents of the file named by
 * `AGENT_SHARED_SECRET_FILE` (how the Sprite stores it). Setting both is an error.
 */
function readSharedSecret(env: NodeJS.ProcessEnv): string {
  if (env.AGENT_SHARED_SECRET && env.AGENT_SHARED_SECRET_FILE)
    throw new Error('Set AGENT_SHARED_SECRET or AGENT_SHARED_SECRET_FILE, not both');
  const secret = env.AGENT_SHARED_SECRET_FILE
    ? readFileSync(env.AGENT_SHARED_SECRET_FILE, 'utf8').trim()
    : env.AGENT_SHARED_SECRET;
  if (!secret) throw new Error('AGENT_SHARED_SECRET or AGENT_SHARED_SECRET_FILE is required');
  return secret;
}
