import { AnthropicAdapter } from './adapters/anthropic.js';
import { SimulatedAdapter } from './adapters/simulated.js';
import type { ModelAdapter } from './adapters/types.js';
import { loadAgentConfig } from './config.js';
import { createWakeServer } from './wake.js';
import { AppClient, Worker } from './worker.js';

const config = loadAgentConfig();
const log = (msg: string) => console.log(`[agent] ${new Date().toISOString()} ${msg}`);

const simulated = new SimulatedAdapter();
const adapter: ModelAdapter =
  config.adapter === 'anthropic'
    ? new AnthropicAdapter({
        model: config.model,
        baseURL: config.anthropicBaseUrl,
        apiKey: config.anthropicApiKey,
        log,
      })
    : simulated;

const worker = new Worker({
  client: new AppClient(config.appUrl, config.sharedSecret, undefined, { log }),
  adapter,
  fallback: simulated,
  log,
});

const server = createWakeServer(worker, log);
server.listen(config.port, () => {
  log(
    `listening on :${config.port}, adapter ${adapter.name}${config.adapter === 'anthropic' ? ` (${config.model})` : ''}, app ${config.appUrl}`,
  );
  // Work may have been queued while the agent was down.
  void worker.wake();
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
