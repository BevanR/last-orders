// Plays a short game against the built server and a simulated agent, and saves screenshots of
// every main view at phone (375x812) and desktop (1440x900) sizes, at deviceScaleFactor 2.
// Run `npm run build` first. Needs local Postgres (see README) and Playwright's Chromium.
// Usage: npm run screenshots [-- <out dir>]   (default docs/screenshots)
import { execSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
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
const OUT = resolve(process.argv[2] ?? join(root, 'docs/screenshots'));
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 8090);
const AGENT_PORT = Number(process.env.E2E_AGENT_PORT ?? 8091);
const BASE = `http://localhost:${APP_PORT}`;
const SIZES = [
  ['phone', { width: 375, height: 812 }],
  ['desktop', { width: 1440, height: 900 }],
];
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/last_orders',
  AGENT_SHARED_SECRET: 'shots-secret',
  COOKIE_INSECURE: '1',
  LOG_LEVEL: 'warn',
  DISPATCHER_INTERVAL_MS: '500',
  GM_TICK_SECONDS: '4',
};

const procs = [];
function run(script, extra) {
  const p = spawn(process.execPath, [script], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => process.stderr.write(d));
  procs.push(p);
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

// Live toasts come and go; hide them so each shot shows the view itself.
const HIDE_TOASTS = '.toast { display: none !important; }';

async function shot(page, name, prepare) {
  for (const [size, viewport] of SIZES) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    if (prepare) await prepare(page, size);
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.warn(`WARNING: ${name} at ${size} scrolls sideways by ${overflow}px`);
    const path = join(OUT, `${name}-${size}.png`);
    await page.screenshot({ path });
    console.log(`saved ${path}`);
  }
  await page.setViewportSize(SIZES[0][1]);
}

const tab = (page, name) => page.click(`role=tab[name^="${name}"]`);
const top = (page) => page.evaluate(() => window.scrollTo(0, 0));
const scrollTo = (selector) => (page) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    const head = document.querySelector('.masthead')?.offsetHeight ?? 0;
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - head - 20);
  }, selector);

async function inspect(page, locationId, actionId, cardName) {
  await tab(page, 'The Lodge');
  await page.click(`[data-location="${locationId}"] [data-action="${actionId}"]`);
  await page.waitForSelector(`text=Found: ${cardName}.`);
}
async function interview(page, suspectId) {
  await tab(page, 'Suspects');
  const back = page.locator('button.link:has-text("Suspects")');
  if (await back.count()) await back.click();
  await page.click(`[data-suspect="${suspectId}"] button`);
}
async function replies(page, n) {
  await page.waitForFunction((k) => document.querySelectorAll('.bubble[data-role=suspect]').length >= k, n);
}

mkdirSync(OUT, { recursive: true });
run('apps/server/dist/main.js', { PORT: String(APP_PORT), AGENT_WAKE_URL: `http://localhost:${AGENT_PORT}/wake` });
run('apps/agent/dist/main.js', { PORT: String(AGENT_PORT), APP_URL: BASE, MODEL_ADAPTER: 'simulated' });

const browser = await chromium.launch();
try {
  await waitHealthy(`${BASE}/healthz`);
  await waitHealthy(`http://localhost:${AGENT_PORT}/healthz`);
  const context = (opts) => browser.newContext({ viewport: SIZES[0][1], deviceScaleFactor: 2, ...opts });
  const host = await (await context()).newPage();
  const guest = await (await context()).newPage();
  for (const p of [host, guest]) await p.addInitScript((css) => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = css;
      document.head.append(s);
    });
  }, HIDE_TOASTS);

  // Lobby.
  await host.goto(BASE);
  await host.waitForLoadState('networkidle');
  await shot(host, '01-lobby');

  await host.fill('input[name=displayName]', 'Hana');
  await host.click('text=Create room');
  await host.waitForURL(/\/g\/[A-Z0-9]+$/);
  const code = host.url().split('/').pop();
  await guest.goto(`${BASE}/r/${code}`);
  await guest.fill('input[name=displayName]', 'Rawiri');
  await guest.click('button:has-text("Join")');
  await guest.waitForURL(new RegExp(`/g/${code}$`));
  await host.waitForSelector('li:has-text("Rawiri")');
  await shot(host, '02-waiting-room', top);
  await host.click('text=Start the game');
  await guest.waitForSelector('text=Act 1 of 3');

  // First accounts, then the Act I finds that move the game on.
  await interview(guest, 'dougal');
  await guest.click('button:has-text("Ask for their account")');
  await replies(guest, 1);
  await interview(guest, 'tessa');
  await guest.click('button:has-text("Ask for their account")');
  await replies(guest, 1);
  await interview(host, 'lionel');
  await host.click('button:has-text("Ask for their account")');
  await replies(host, 1);
  await inspect(host, 'dining-room', 'camera', 'The Time-lapse');
  await inspect(host, 'wine-cellar', 'foot-of-stairs', 'The Wrong Bottle');
  await host.waitForSelector('text=Act 2 of 3');
  await inspect(host, 'wine-cellar', 'storm-hatch', 'The Storm Hatch');
  await inspect(guest, 'boot-room', 'shoe-rack', 'The Sandy Brogues');
  await inspect(host, 'woodshed', 'woodpile', 'The Magnum in the Scarf');
  await tab(host, 'Host');
  await host.click('button:has-text("Give the next hint")');
  await tab(host, 'The Lodge');
  await host.waitForSelector('[data-notice="hint"]');
  await inspect(host, 'kitchen', 'chiller', 'The Whitebait Cartons');
  await shot(host, '03-lodge', (page, size) => (size === 'phone' ? top(page) : scrollTo('.rooms')(page)));

  await tab(host, 'Suspects');
  await shot(host, '04-suspects', top);

  // The presented-evidence moment: the magnum, then the hatch.
  await interview(host, 'lionel');
  await host.fill('input[name=message]', 'Where exactly did you go when you left the table?');
  await host.click('button:has-text("Ask")');
  await replies(host, 2);
  await host.selectOption('select[name=evidence]', 'e8');
  await host.click('button:has-text("Present")');
  await replies(host, 3);
  // Scroll the transcript so the presented card and the changed story are both in view.
  await shot(host, '05-interview', async (page) => {
    await top(page);
    await page.evaluate(() => {
      const chat = document.querySelector('.chat');
      const slip = [...document.querySelectorAll('.exhibit-shown')].pop();
      if (chat && slip) chat.scrollTop = slip.offsetTop - 12;
    });
  });

  // The board: two cards from the host, one from the guest.
  for (const id of ['e8', 'e2', 'e3']) {
    await tab(host, 'Board');
    await host.click(`[data-notebook="${id}"] button`);
  }
  await tab(guest, 'Board');
  await guest.click('[data-notebook="e7"] button');
  await host.waitForSelector('[data-evidence="e7"]');
  await shot(host, '06-board', top);

  // The host panel, once the game master suggests the next act.
  await tab(host, 'Host');
  await host.waitForSelector('[data-notice="suggest_advance"]', { timeout: 60_000 });
  // The behind-the-scenes panel is open in the desktop shot only; on a phone it fills the screen.
  const bts = async (page, on) => {
    const button = page.locator('button[aria-label="Behind the scenes"]');
    if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
  };
  await shot(host, '07-host', async (page, size) => {
    await bts(page, size === 'desktop');
    await top(page);
  });
  await bts(host, false);

  // The accusation, filled in and waiting for confirmation.
  await host.click('button:has-text("Advance to: Accusation")');
  await guest.waitForSelector('text=Act 3 of 3');
  await tab(guest, 'Accuse');
  await guest.check('input[name=suspect][value=lionel]');
  for (const id of ['e8', 'e7', 'e2']) await guest.check(`input[name=evidence][value=${id}]`);
  await guest.fill('textarea[name=reasoning]', 'His scarf round the magnum, his sandy brogues, and the hatch bolt.');
  await guest.click('button:has-text("Submit the accusation")');
  await shot(guest, '08-accusation', (page, size) =>
    size === 'phone' ? scrollTo('.suspect-choices')(page) : scrollTo('.accuse legend')(page),
  );
  await guest.click('button:has-text("Confirm: accuse Lionel Fitch")');
  await guest.waitForSelector('[data-accusation="submitted"]');

  // The reveal.
  await tab(host, 'Host');
  await host.click('button:has-text("End the investigation")');
  await host.click('button:has-text("Confirm: end and reveal")');
  await guest.waitForSelector('[data-commentary="ready"]', { timeout: 15_000 });
  await shot(guest, '09-reveal', top);
} finally {
  await browser.close();
  for (const p of procs) p.kill('SIGTERM');
}
