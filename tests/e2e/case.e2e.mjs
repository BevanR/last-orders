// End-to-end run of the full case in two browser contexts, against the built server and a
// simulated agent: first accounts, every Act II discovery, the demo testimony changes, a hint,
// the game master's suggestion to the host, the group accusation and the reveal. Run
// `npm run build` first. Needs local Postgres (see README) and Playwright's Chromium.
// Usage: npm run test:e2e
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  // A fast game master and dispatcher, so the suggestion to the host arrives within the test.
  DISPATCHER_INTERVAL_MS: '500',
  GM_TICK_SECONDS: '1',
};

// Strings that identify the killer or the verdict. None may appear in a page before the reveal.
const theCase = JSON.parse(readFileSync(join(root, 'case/last-orders.case.json'), 'utf8'));
const SOLUTION = [
  theCase.solution.summary,
  theCase.solution.narration,
  theCase.solution.motive,
  ...theCase.solution.clues.map((k) => k.text),
  ...theCase.accusation.outcomes.map((o) => o.text),
  'Lionel Fitch killed',
];

const procs = [];
function run(name, script, extra) {
  const p = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

let shot = 0;
async function snap(page, name) {
  if (SHOTS)
    await page.screenshot({ path: join(SHOTS, `${String(++shot).padStart(2, '0')}-${name}.png`), fullPage: true });
}

async function tab(page, name) {
  await page.click(`role=tab[name^="${name}"]`);
}

async function interview(page, suspectId) {
  await tab(page, 'Suspects');
  const back = page.locator('button.link:has-text("Suspects")');
  if (await back.count()) await back.click();
  await page.click(`[data-suspect="${suspectId}"] button`);
}

async function lastReply(page, count) {
  await page.waitForFunction((n) => document.querySelectorAll('.bubble[data-role=suspect]').length >= n, count);
  return page.locator('.bubble[data-role=suspect]').last().innerText();
}

async function act(page, locationId, actionId, cardName) {
  await tab(page, 'The Lodge');
  await page.click(`[data-location="${locationId}"] [data-action="${actionId}"]`);
  await page.waitForSelector(`text=Found: ${cardName}.`);
}

async function present(page, evidenceId, nth) {
  await page.selectOption('select[name=evidence]', evidenceId);
  await page.click('button:has-text("Present")');
  return lastReply(page, nth);
}

async function noSolutionIn(pages) {
  const html = (await Promise.all(pages.map((p) => p.content()))).join('\n');
  const index = await (await fetch(BASE)).text();
  const scripts = [...index.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  const js = (await Promise.all(scripts.map(async (s) => (await fetch(BASE + s)).text()))).join('\n');
  return SOLUTION.every((s) => !html.includes(s) && !index.includes(s) && !js.includes(s));
}

run('server', 'apps/server/dist/main.js', {
  PORT: String(APP_PORT),
  AGENT_WAKE_URL: `http://localhost:${AGENT_PORT}/wake`,
});
run('agent', 'apps/agent/dist/main.js', { PORT: String(AGENT_PORT), APP_URL: BASE, MODEL_ADAPTER: 'simulated' });

const browser = await chromium.launch();
try {
  await waitHealthy(`${BASE}/healthz`);
  await waitHealthy(`http://localhost:${AGENT_PORT}/healthz`);

  const host = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

  // The host creates a room; the guest joins through the invite link.
  await host.goto(BASE);
  await host.fill('input[name=displayName]', 'Hana');
  await host.click('text=Create room');
  await host.waitForURL(/\/g\/[A-Z0-9]+$/);
  const code = host.url().split('/').pop();
  check(/^[A-Z0-9]{6}$/.test(code), `room ${code} created`);
  await guest.goto(`${BASE}/r/${code}`);
  await guest.fill('input[name=displayName]', 'Rawiri');
  await guest.click('button:has-text("Join")');
  await guest.waitForURL(new RegExp(`/g/${code}$`));
  await host.waitForSelector('li:has-text("Rawiri")');
  await host.click('text=Start the game');
  await guest.waitForSelector('text=Act 1 of 3: First Accounts');
  check(true, 'two players joined and the game started in Act I');
  await snap(host, 'act1-lodge');

  // Act I: first accounts from three suspects.
  await interview(host, 'lionel');
  await host.click('button:has-text("Ask for their account")');
  check((await lastReply(host, 1)).includes('blood-pressure pills'), 'Lionel gives his first account (the car story)');
  await snap(host, 'lionel-account');
  await interview(guest, 'dougal');
  await guest.fill('input[name=message]', 'Where were you when Helen went down?');
  await guest.click('button:has-text("Ask")');
  check((await lastReply(guest, 1)).includes('whisky into the lounge'), 'Dougal gives his first account');
  await interview(guest, 'tessa');
  await guest.click('button:has-text("Ask for their account")');
  check((await lastReply(guest, 1)).includes('downstairs loo'), 'Tessa gives her first account');
  await interview(guest, 'lionel');
  await guest.waitForSelector('text=Ask Lionel Fitch anything');
  check(!(await guest.content()).includes('blood-pressure pills'), "the guest cannot see the host's interview");

  // The camera and the foot of the stairs move the game to Act II on its own.
  await act(host, 'dining-room', 'camera', 'The Time-lapse');
  await act(host, 'wine-cellar', 'foot-of-stairs', 'The Wrong Bottle');
  await guest.waitForSelector('text=Act 2 of 3: Contradictions');
  check(true, 'Act II started automatically for both players');

  // Act II: the hatch opens the Woodshed; the guest finds the brogues; the host finds the magnum.
  await act(host, 'wine-cellar', 'storm-hatch', 'The Storm Hatch');
  await host.waitForSelector('[data-location="woodshed"]');
  check(true, 'the storm hatch unlocked the Woodshed');
  await act(guest, 'boot-room', 'shoe-rack', 'The Sandy Brogues');
  await act(host, 'woodshed', 'woodpile', 'The Magnum in the Scarf');
  await snap(host, 'act2-lodge');

  // The demo: E8 to Lionel in his first state, then E2.
  await interview(host, 'lionel');
  check(
    (await present(host, 'e8', 2)).includes("That's my scarf."),
    'presenting the magnum changes Lionel’s story (TL2)',
  );
  check(
    (await present(host, 'e2', 3)).includes('I went in by the hatch'),
    'presenting the hatch gives his last account (TL3)',
  );
  check(!(await present(host, 'e2', 4)).includes('I went in by the hatch'), 'the hatch card does not fire twice');
  await snap(host, 'lionel-demo');

  // The host gives a hint; it reaches the guest live.
  await tab(host, 'Host');
  await host.click('button:has-text("Give the next hint")');
  await tab(guest, 'The Lodge');
  await guest.waitForSelector('[data-notice="hint"]');
  check(true, 'a hint from the host reached the guest');

  // The game master notices the key cards are found and tells the host only.
  await host.waitForSelector('[data-notice="suggest_advance"]', { timeout: 15_000 });
  check(
    (await guest.locator('[data-notice="suggest_advance"]').count()) === 0,
    'the game master suggested Act III to the host only',
  );
  await snap(host, 'host-panel');

  // Before the accusation opens, nothing names the killer.
  check(await noSolutionIn([host, guest]), 'no page, HTML or script holds the solution before the reveal');

  // Act III: share the cards, and the guest submits the group's accusation.
  await host.click('button:has-text("Advance to: Accusation")');
  await guest.waitForSelector('text=Act 3 of 3: Accusation');
  for (const id of ['e8', 'e2']) {
    await tab(host, 'Board');
    await host.click(`[data-notebook="${id}"] button`);
  }
  await tab(guest, 'Board');
  await guest.click('[data-notebook="e7"] button');
  await guest.waitForSelector('[data-evidence="e8"]');
  await tab(guest, 'Accuse');
  await guest.check('input[name=suspect][value=lionel]');
  for (const id of ['e8', 'e7', 'e2']) await guest.check(`input[name=evidence][value=${id}]`);
  await guest.fill('textarea[name=reasoning]', 'His scarf round the magnum, his sandy brogues, and the hatch.');
  await snap(guest, 'accusation-form');
  await guest.click('button:has-text("Submit the accusation")');
  await guest.click('button:has-text("Confirm: accuse Lionel Fitch")');
  await guest.waitForSelector('[data-accusation="submitted"]');
  await tab(host, 'Accuse');
  await host.waitForSelector('[data-accusation="submitted"]:has-text("Rawiri named Lionel Fitch")');
  check(true, "the group's accusation is visible to both players");
  check(await noSolutionIn([host, guest]), 'still no solution or verdict in any page after the accusation');

  // The host ends the investigation: both see the reveal and the verdict.
  await tab(host, 'Host');
  await host.click('button:has-text("End the investigation")');
  await host.click('button:has-text("Confirm: end and reveal")');
  await guest.waitForSelector('[data-verdict="solved-cleanly"]');
  await host.waitForSelector('[data-verdict="solved-cleanly"]');
  check(true, 'both players see the reveal: "Solved cleanly"');
  check((await guest.content()).includes(theCase.solution.narration), 'the reveal reads the narration');
  await guest.waitForSelector('[data-commentary="ready"]', { timeout: 10_000 });
  check((await guest.locator('.commentary').innerText()).includes('simulated'), 'the commentary arrives, labelled');
  await snap(guest, 'reveal');
  await snap(host, 'reveal-host');
  console.log('e2e passed');
} finally {
  await browser.close();
  for (const p of procs) p.kill('SIGTERM');
}
