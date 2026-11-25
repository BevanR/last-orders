// Bundles the agent and its dependencies (engine, Anthropic SDK, zod) into one ESM file,
// dist/agent.mjs, that runs with `node dist/agent.mjs` and no node_modules. This is what
// infra/sprite/deploy-agent.sh uploads to the Sprite. Usage: npm run bundle -w @last-orders/agent
import { build } from 'esbuild';

const result = await build({
  entryPoints: [new URL('./src/main.ts', import.meta.url).pathname],
  outfile: new URL('./dist/agent.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Resolve workspace packages to their TypeScript sources, so no prior tsc build is needed.
  conditions: ['source'],
  // Some CommonJS dependencies call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`agent bundle: ${Object.keys(result.metafile.outputs).join(', ')} (${bytes} bytes)`);
