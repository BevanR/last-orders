import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = await buildApp(config, { logger: true });

if (!config.agentSharedSecret) app.log.warn('AGENT_SHARED_SECRET is not set; the agent API is disabled.');
if (!config.agentWakeUrl) app.log.warn('AGENT_WAKE_URL is not set; the agent will not be woken.');

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
