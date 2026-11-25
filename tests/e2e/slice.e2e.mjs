// End-to-end run of the vertical slice in two browser contexts, against the built server and a
// simulated agent. Run `npm run build` first. Needs local Postgres (see README) and Playwright's
// Chromium. Usage: npm run test:e2e
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return require(join(execSync('npm root -g').toString().trim(), 'playwright'));
  }
}
const { chromium } = loadPlaywright();

const root = fileURLToPath(new URL('../..', import.meta.url));
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 8090);
const AGENT_PORT = Number(process.env.E2E_AGENT_PORT ?? 8091);
const BASE = `http://localhost:${APP_PORT}`;
const SHOTS = process.env.E2E_SCREENSHOTS ?? '';
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/last_orders',
  AGENT_SHARED_SECRET: 'e2e-secret',
  COOKIE_INSECURE: '1',
  LOG_LEVEL: 'warn',
};

const procs = [];
function run(name, script, extra) {
  const p = spawn(process.execPath, [script], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}
async function waitHealthy(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not become healthy`);
}

function check(cond, message) {
  if (!cond) throw new Error(`FAILED: ${message}`);
  console.log(`ok - ${message}`);
}

run('server', 'apps/server/dist/main.js', { PORT: String(APP_PORT), AGENT_WAKE_URL: `http://localhost:${AGENT_PORT}/wake` });
run('agent', 'apps/agent/dist/main.js', { PORT: String(AGENT_PORT), APP_URL: BASE, MODEL_ADAPTER: 'simulated' });

const browser = await chromium.launch();
try {
  await waitHealthy(`${BASE}/healthz`);
  await waitHealthy(`http://localhost:${AGENT_PORT}/healthz`);

  const a = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const b = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

  // Host creates a room; a second player joins through the invite link.
  await a.goto(BASE);
  await a.fill('input[name=displayName]', 'Alice');
  await a.click('text=Create room');
  await a.waitForURL(/\/g\/[A-Z0-9]+$/);
  const code = a.url().split('/').pop();
  check(/^[A-Z0-9]{6}$/.test(code), `room ${code} created`);

  await b.goto(`${BASE}/r/${code}`);
  await b.fill('input[name=displayName]', 'Bob');
  await b.click('button:has-text("Join")');
  await b.waitForURL(new RegExp(`/g/${code}$`));
  await a.waitForSelector('li:has-text("Bob")');
  check(true, 'Bob joined and appears in the host lobby live');

  await a.click('text=Start the game');
  await b.waitForSelector('role=tab[name="The Lodge"]');
  check(true, 'game started for both players');

  // Alice interviews Ada privately.
  await a.click('role=tab[name="Suspects"]');
  await a.click('[data-suspect="ada"] button');
  await a.fill('input[name=message]', 'Where were you at ten, Ada?');
  await a.click('button:has-text("Ask")');
  await a.waitForSelector('.bubble[data-role=suspect]:has-text("[simulated] Ada Price")');
  check(true, 'Alice got a simulated reply from Ada');

  await b.click('role=tab[name="Suspects"]');
  await b.click('[data-suspect="ada"] button');
  await b.waitForSelector('text=Ask Ada Price anything.');
  check(!(await b.content()).includes('Where were you at ten'), "Bob cannot see Alice's interview");

  // Alice inspects the bar and finds the receipt, then shares it.
  await a.click('role=tab[name="The Lodge"]');
  await a.click('[data-location="bar"] button');
  await a.waitForSelector('text=Found: Torn stockroom receipt.');
  check(true, 'Alice found the torn receipt in the bar');
  await a.click('role=tab[name^="Board"]');
  await a.click('[data-notebook="torn-receipt"] button');
  await a.waitForSelector('[data-evidence="torn-receipt"]');

  // Bob sees the card live, without reloading.
  await b.waitForSelector('.notice:has-text("Alice pinned")');
  check(true, 'Bob was notified of the shared card live');
  await b.click('role=tab[name^="Board"]');
  await b.waitForSelector('[data-evidence="torn-receipt"]');
  check(true, 'the card is on Bob\'s board');

  // Bob presents the card to Ada: her testimony changes.
  await b.click('role=tab[name="Suspects"]');
  await b.click('[data-suspect="ada"] button');
  await b.selectOption('select[name=evidence]', 'torn-receipt');
  await b.click('button:has-text("Present")');
  await b.waitForSelector('.bubble[data-role=suspect]:has-text("folds the towel")');
  check(true, 'presenting the receipt changed Ada\'s testimony');

  await b.selectOption('select[name=evidence]', 'torn-receipt');
  await b.click('button:has-text("Present")');
  await b.waitForSelector('.bubble[data-role=suspect]:has-text("means nothing")');
  check((await b.locator('.bubble[data-role=suspect]:has-text("folds the towel")').count()) === 1, 'presenting again does not fire it twice');

  // The new testimony persists in Alice's later interview.
  await a.click('role=tab[name="Suspects"]');
  await a.click('[data-suspect="ada"] button');
  await a.fill('input[name=message]', 'Tell me again where you were.');
  await a.click('button:has-text("Ask")');
  await a.waitForFunction(() => document.querySelectorAll('.bubble[data-role=suspect]').length >= 2);
  const last = await a.locator('.bubble[data-role=suspect]').last().innerText();
  check(/stockroom just after ten|two men arguing/.test(last), `Ada keeps her new account for Alice: ${last}`);

  const html = (await a.content()) + (await b.content());
  check(!html.includes('owed the landlord') && !html.includes('shaken'), 'no hidden state in either page');

  if (SHOTS) {
    await a.screenshot({ path: join(SHOTS, 'alice.png'), fullPage: true });
    await b.screenshot({ path: join(SHOTS, 'bob.png'), fullPage: true });
  }
  console.log('e2e passed');
} finally {
  await browser.close();
  for (const p of procs) p.kill('SIGTERM');
}
