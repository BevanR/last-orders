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
  if (!env.AGENT_SHARED_SECRET) throw new Error('AGENT_SHARED_SECRET is required');
  return {
    appUrl: env.APP_URL ?? 'http://localhost:8080',
    sharedSecret: env.AGENT_SHARED_SECRET,
    adapter,
    model: env.MODEL ?? 'claude-sonnet-5-5',
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    port: Number(env.PORT ?? 8081),
  };
}
