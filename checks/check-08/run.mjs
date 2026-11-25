// Check 08: "The passive Wallets Kit capture works in a browser with a real wallet."
// Builds the test pages, drives them in Chromium, prints the events the collector received for
// every case and the verdict, and exits non-zero when any case differs from what is expected.
// Usage: node run.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { buildPages, isWalletFunnel, startServer } from './serve.mjs';

// The wallet extension, from the release page of its own repository (github.com/stellar/freighter).
const WALLET = {
  version: '5.53.0',
  url: 'https://github.com/stellar/freighter/releases/download/5.53.0/build-5.53.0.zip',
  sha256: '44e8aab2e68ca4b2c4f4af56a81e1e37632b06e2ee115962dc61f931e71bb71a',
};

// Not a real account: letters only, no valid checksum, never used on any network.
const STAND_IN_ADDRESS = 'GCHECKEIGHTSTANDINWALLETNOTAREALACCOUNT'.padEnd(56, 'A');
const STAND_IN_REJECTION = 'Stand-in wallet says no: declined by the user.';
const CUSTOM_WALLET_NAME = 'GCUSTOMWALLETNAMESHAPEDLIKEANADDRESSAAAAAAAAAAAAAAAAAAAAAA';
const CUSTOM_WALLET_ERROR = `tx ${'ab12'.repeat(16)} failed`;
const USER_CLOSED = 'The user closed the modal.';
const REAL_WALLET_REJECTION = 'The user rejected this request.';

// Placed in the page's path, query and fragment, and in its title, in every case.
const URL_ADDRESS = 'GURLADDRESSINPATHQUERYANDFRAGMENT'.padEnd(56, 'B');
const URL_HASH = 'cd34'.repeat(16);
const TITLE_ADDRESS = 'GTITLEADDRESSSETBYTHETENANTPAGE'.padEnd(56, 'C');
const ACCOUNT_PATH = `account/${URL_ADDRESS}/?account=${URL_ADDRESS}&tx=${URL_HASH}#${URL_ADDRESS}`;
const SCRUBBED_PATH = 'account/[strkey]/';

const SENSITIVE_SHAPES = [/[GMCSTPX][A-Z2-7]{55}/, /[0-9a-fA-F]{64}/];
const SENSITIVE_TEXT = [
  STAND_IN_ADDRESS.slice(0, 6),
  STAND_IN_ADDRESS.slice(-6),
  URL_ADDRESS.slice(0, 6),
  TITLE_ADDRESS.slice(0, 6),
  STAND_IN_REJECTION,
  CUSTOM_WALLET_ERROR,
  USER_CLOSED,
  REAL_WALLET_REJECTION,
  'error',
  'reject',
  'Account',
  'Tenant page',
  'account=',
  'tx=',
];
// What a wallet funnel request may hold besides the event name and its data.
const PAYLOAD_KEYS = ['data', 'hostname', 'language', 'name', 'screen', 'url', 'website'];

const OPENED = { step: 'modal_opened' };
const CLOSED = { step: 'modal_closed' };
const clicked = (wallet) => ({ step: 'wallet_option_clicked', wallet });

const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-08-'));
const results = [];
let server;

/** Answers the page the way the wallet's extension does, over the same window messages. */
function walletStandIn({ grant, address, rejection }) {
  window.addEventListener('message', (event) => {
    const request = event.data;
    if (event.source !== window || request?.source !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return;
    const refused = { publicKey: '', apiError: { code: -4, message: rejection } };
    const answers = {
      REQUEST_CONNECTION_STATUS: { isConnected: true },
      REQUEST_ACCESS: grant ? { publicKey: address } : refused,
      REQUEST_PUBLIC_KEY: { publicKey: address },
    };
    const answer = answers[request.type];
    if (!answer) return;
    const source = 'FREIGHTER_EXTERNAL_MSG_RESPONSE';
    const reply = { source, messagedId: request.messageId, ...answer };
    window.postMessage(reply, window.location.origin);
  });
}

/** Looks for sensitive text in everything a request carried: its body and its headers. */
function sensitiveFindings(requests) {
  const findings = [];
  for (const { body, headers } of requests) {
    const sent = `${body} ${Object.values(headers).join(' ')}`;
    for (const shape of SENSITIVE_SHAPES) {
      if (shape.test(sent)) findings.push(`${shape}`);
    }
    for (const text of SENSITIVE_TEXT) {
      if (sent.includes(text)) findings.push(`"${text}"`);
    }
  }
  return [...new Set(findings)];
}

/** Compares the bodies the collector received with the steps expected, field by field. */
function differences(requests, expected, pagePath) {
  const found = [];
  if (requests.length !== expected.length) {
    found.push(`${requests.length} requests, expected ${expected.length}`);
  }
  requests.forEach(({ body }, index) => {
    const { type, payload = {} } = JSON.parse(body);
    const keys = Object.keys(payload).sort().join(',');
    const data = JSON.stringify(payload.data);
    const wanted = JSON.stringify(expected[index]);
    if (type !== 'event') found.push(`request ${index + 1}: type ${type}`);
    if (keys !== PAYLOAD_KEYS.join(',')) found.push(`request ${index + 1}: fields ${keys}`);
    if (data !== wanted) found.push(`request ${index + 1}: data ${data}, expected ${wanted}`);
    if (payload.url !== `/${pagePath}/${SCRUBBED_PATH}`) {
      found.push(`request ${index + 1}: url ${payload.url}`);
    }
  });
  return found;
}

/** Waits for the tracker to deliver, then takes the wallet funnel requests received. */
async function takeEvents(expectedCount) {
  const count = () => server.received.filter(isWalletFunnel).length;
  const deadline = Date.now() + 5_000;
  while (count() < expectedCount && Date.now() < deadline) await sleep(50);
  await sleep(500);
  return server.received.splice(0).filter(isWalletFunnel);
}

function record({ id, title, page, expected, leakExpected, events, pageErrors, proof }) {
  const findings = sensitiveFindings(events);
  // A leak control passes only when the search above finds what the page was made to send.
  const wrong = leakExpected ? [] : differences(events, expected, page);
  const leakAsExpected = leakExpected ? findings.length > 0 : findings.length === 0;
  const pass = wrong.length === 0 && leakAsExpected && pageErrors.length === 0;
  results.push({ id, pass });
  console.log(`\n${id}  ${title}`);
  console.log(`  page showed: ${proof}`);
  console.log(`  wallet funnel request bodies received (${events.length}):`);
  for (const { body } of events) console.log(`    ${body}`);
  for (const difference of wrong) console.log(`  DIFFERENT: ${difference}`);
  console.log(`  address, hash, title or error text sent: ${findings.join(', ') || 'none'}`);
  console.log(`  page exceptions: ${pageErrors.join('; ') || 'none'}`);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}`);
}

/** Opens a page at an address that holds an account in its path, query and fragment. */
async function openPage(page, pagePath) {
  await page.goto(`${server.url}/${pagePath}/${ACCOUNT_PATH}`);
  await page.evaluate((title) => (document.title = title), `Account ${TITLE_ADDRESS}`);
}

/** Runs one case in a fresh browser context that can reach only the local server. */
async function runCase(browser, testCase) {
  const { page: pagePath, wallet, expected, steps } = testCase;
  const context = await browser.newContext();
  const local = [server.url, server.collectorUrl];
  await context.route('**/*', (route) =>
    local.some((url) => route.request().url().startsWith(url)) ? route.continue() : route.abort(),
  );
  if (wallet) await context.addInitScript(walletStandIn, wallet);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let proof;
  let events;
  try {
    await openPage(page, pagePath);
    proof = await steps(page);
    events = await takeEvents(expected.length);
  } finally {
    await context.close();
  }
  record({ ...testCase, events, pageErrors, proof });
}

const granting = { grant: true, address: STAND_IN_ADDRESS, rejection: STAND_IN_REJECTION };
const refusing = { ...granting, grant: false };
const KIT_OPTION = '.stellar-wallets-kit li';
const option = (page, name, root = KIT_OPTION) => page.locator(root, { hasText: name });
const text = (page, selector) => page.locator(selector).innerText();

async function untilText(page, selector, expected) {
  await page.locator(selector, { hasText: expected }).waitFor();
  return `${selector} = "${await text(page, selector)}"`;
}

async function untilModalGone(page) {
  await page.locator('.stellar-wallets-kit').waitFor({ state: 'detached' });
}

const cases = [
  {
    id: 'A1',
    title:
      'kit button, Varial chosen, wallet returns an address; ' +
      'then the profile modal is opened and closed',
    page: 'kit',
    wallet: granting,
    expected: [OPENED, clicked('varial'), CLOSED],
    steps: async (page) => {
      await page.locator('#kit-button button').click();
      await option(page, 'Varial').click();
      const proof = await untilText(page, '#account', STAND_IN_ADDRESS);
      await untilModalGone(page);
      await page.locator('#kit-button button').click();
      const profile = await text(page, '.stellar-wallets-kit h1 >> nth=-1');
      await page.locator('.stellar-wallets-kit header button').last().click();
      await untilModalGone(page);
      return `${proof}; profile modal showed "${profile}"`;
    },
  },
  {
    id: 'A2',
    title: 'tenant button, Varial chosen, wallet answers with an error (user declined)',
    page: 'kit',
    wallet: refusing,
    expected: [OPENED, clicked('varial'), CLOSED],
    steps: async (page) => {
      await page.locator('#connect').click();
      await option(page, 'Varial').click();
      const proof = await untilText(page, '#error', STAND_IN_REJECTION);
      await untilModalGone(page);
      return proof;
    },
  },
  {
    id: 'A3',
    title: 'modal opened and closed with its close button, no option clicked',
    page: 'kit',
    expected: [OPENED, CLOSED],
    steps: async (page) => {
      await page.locator('#connect').click();
      await option(page, 'Albedo').waitFor();
      await page.locator('.stellar-wallets-kit header button').last().click();
      return untilText(page, '#error', USER_CLOSED);
    },
  },
  {
    id: 'A4',
    title:
      'a wallet that is not installed is clicked (the kit opens its site), ' +
      'then the backdrop is clicked',
    page: 'kit',
    expected: [OPENED, clicked('lobstr'), CLOSED],
    steps: async (page) => {
      await page.locator('#connect').click();
      const installPage = page.context().waitForEvent('page');
      await option(page, 'LOBSTR').click();
      await (await installPage).close();
      await page.locator('.stellar-wallets-kit > div').click({ position: { x: 5, y: 5 } });
      return untilText(page, '#error', USER_CLOSED);
    },
  },
  {
    id: 'A5',
    title:
      'a tenant wallet module outside the fixed list, named like an address, ' +
      'failing with a hash in its error',
    page: 'custom-module',
    expected: [OPENED, clicked('other'), CLOSED],
    steps: async (page) => {
      await page.locator('#connect').click();
      await option(page, CUSTOM_WALLET_NAME).click();
      const proof = await untilText(page, '#error', CUSTOM_WALLET_ERROR);
      await untilModalGone(page);
      return proof;
    },
  },
  {
    id: 'D1',
    title: 'authModal() called twice before the user acts (two stacked modals), Varial chosen',
    page: 'kit',
    wallet: granting,
    expected: [OPENED, clicked('varial'), CLOSED],
    steps: async (page) => {
      await page.evaluate(() => {
        document.querySelector('#connect').click();
        document.querySelector('#connect').click();
      });
      await option(page, 'Varial').last().waitFor();
      const modals = await page.locator('.stellar-wallets-kit').count();
      await option(page, 'Varial').last().click();
      const proof = await untilText(page, '#account', STAND_IN_ADDRESS);
      await page.locator('.stellar-wallets-kit').first().waitFor({ state: 'detached' });
      return `${modals} kit modals in the page at once; ${proof}`;
    },
  },
  {
    id: 'S1',
    title: 'capture.js loads after the modal is already open, then Varial is chosen',
    page: 'late-capture',
    wallet: granting,
    expected: [OPENED, clicked('varial'), CLOSED],
    steps: async (page) => {
      await page.locator('#connect').click();
      await option(page, 'Varial').waitFor();
      await page.addScriptTag({ url: '/capture.js' });
      await option(page, 'Varial').click();
      const proof = await untilText(page, '#account', STAND_IN_ADDRESS);
      await untilModalGone(page);
      return `capture.js added while the modal was open; ${proof}`;
    },
  },
  {
    id: 'L1',
    title:
      "leak control: the capture's beforeSend hook is left off the tracker tag, " +
      'so the tracker adds title and full URL; the search must find them',
    page: 'no-hook',
    wallet: granting,
    expected: [OPENED, clicked('varial'), CLOSED],
    leakExpected: true,
    steps: async (page) => {
      await page.locator('#connect').click();
      await option(page, 'Varial').click();
      const proof = await untilText(page, '#account', STAND_IN_ADDRESS);
      await untilModalGone(page);
      return proof;
    },
  },
  {
    id: 'N1',
    title: 'negative control: kit update renames the root class; the wallet still connects',
    page: 'changed-class',
    wallet: granting,
    expected: [],
    steps: async (page) => {
      await page.locator('#connect').click();
      await option(page, 'Varial', '.swk-app li').click();
      return untilText(page, '#account', STAND_IN_ADDRESS);
    },
  },
  {
    id: 'N2',
    title: 'negative control: kit update replaces the ul/li wallet list; the wallet still connects',
    page: 'changed-list',
    wallet: granting,
    expected: [],
    steps: async (page) => {
      await page.locator('#connect').click();
      await option(page, 'Varial', '.stellar-wallets-kit [role=option]').click();
      return untilText(page, '#account', STAND_IN_ADDRESS);
    },
  },
  {
    id: 'N3',
    title:
      'negative control: kit update moves the modal into a closed shadow root; ' +
      'the wallet still connects',
    page: 'closed-shadow',
    wallet: granting,
    expected: [],
    steps: async (page) => {
      await page.locator('#connect').click();
      // Nothing outside the kit can look into a closed root; the test build exposes it so
      // that the test can find where to click.
      const inRoot = (find) => page.waitForFunction(find, null, { timeout: 10_000 });
      const box = await inRoot(() => {
        const items = [...(globalThis.__check08ShadowRoot?.querySelectorAll('li') ?? [])];
        const item = items.find((li) => li.textContent.trim() === 'Varial');
        if (!item) return null;
        item.scrollIntoView({ block: 'center' });
        const { x, y, width, height } = item.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      });
      const { x, y } = await box.jsonValue();
      await page.mouse.click(x, y);
      return untilText(page, '#account', STAND_IN_ADDRESS);
    },
  },
  {
    id: 'N4',
    title: 'negative control: a page without the kit, with its own look-alike chooser',
    page: 'no-kit',
    expected: [],
    steps: async (page) => {
      await page.locator('#connect').click();
      await page.locator('.wallet-chooser li').click();
      return untilText(page, '#account', 'Varial');
    },
  },
];

function fetchWalletExtension() {
  const zip = path.join(scratch, 'wallet', `build-${WALLET.version}.zip`);
  const unpacked = path.join(scratch, 'wallet', 'unpacked');
  mkdirSync(unpacked, { recursive: true });
  const download = spawnSync('curl', ['-sSfL', '-o', zip, WALLET.url], { encoding: 'utf8' });
  if (download.status !== 0) {
    throw new Error(`could not download ${WALLET.url}: ${download.stderr}`);
  }
  const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
  if (digest !== WALLET.sha256) {
    throw new Error(`${zip} has SHA-256 ${digest}, expected ${WALLET.sha256}`);
  }
  const unzip = spawnSync('unzip', ['-q', '-o', zip, '-d', unpacked], { encoding: 'utf8' });
  if (unzip.status !== 0) throw new Error(`could not unpack ${zip}: ${unzip.stderr}`);
  return unpacked;
}

/** Resolves once the extension answers the page; on a new profile that takes seconds. */
async function untilExtensionAnswers(page) {
  const ask = () =>
    new Promise((resolve) => {
      const messageId = Math.random();
      const onMessage = (event) => {
        const answer = event.data;
        if (answer?.source !== 'FREIGHTER_EXTERNAL_MSG_RESPONSE') return;
        if (answer.messagedId !== messageId) return;
        window.removeEventListener('message', onMessage);
        resolve(answer.isConnected === true);
      };
      window.addEventListener('message', onMessage);
      const source = 'FREIGHTER_EXTERNAL_MSG_REQUEST';
      const request = { source, messageId, type: 'REQUEST_CONNECTION_STATUS' };
      window.postMessage(request, window.location.origin);
      setTimeout(() => resolve(false), 900);
    });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) if (await page.evaluate(ask)) return;
  throw new Error('the wallet extension did not answer the page within 60 seconds');
}

async function walletWindow(context) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => /^chrome-extension:.*\?/.test(page.url()));
    if (found) return found;
    await sleep(100);
  }
  throw new Error('the wallet extension did not open its window within 30 seconds');
}

/** Opens the modal, chooses Varial and closes the window the real extension opens. */
async function declineInRealWallet(context, page) {
  await openPage(page, 'kit');
  await untilExtensionAnswers(page);
  await page.locator('#connect').click();
  const varial = option(page, 'Varial');
  await varial.waitFor();
  const optionText = (await varial.innerText()).replace(/\s+/g, ' ');
  if (optionText !== 'Varial') {
    throw new Error(`the kit did not list the wallet as installed: "${optionText}"`);
  }
  await varial.click();
  const walletPage = await walletWindow(context);
  const walletRoute = new URL(walletPage.url()).hash.split('?')[0];
  await walletPage.close();
  const shown = await untilText(page, '#error', REAL_WALLET_REJECTION);
  await untilModalGone(page);
  return `kit listed "${optionText}" as installed; the wallet opened ${walletRoute}; ${shown}`;
}

/** The same page and capture with the real extension loaded in a new browser profile. */
async function runRealWalletCase() {
  const extension = fetchWalletExtension();
  const manifest = JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  const context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const pageErrors = [];
  let proof;
  let events;
  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    proof = await declineInRealWallet(context, page);
    events = await takeEvents(3);
  } finally {
    await context.close();
  }
  record({
    id: 'R1',
    title:
      `real wallet: ${manifest.name} ${manifest.version} extension loaded, Varial chosen, ` +
      "the wallet's window closed",
    page: 'kit',
    expected: [OPENED, clicked('varial'), CLOSED],
    events,
    pageErrors,
    proof,
  });
}

/** A case that cannot be run to its end counts as failed and the run goes on. */
async function attempt(id, run) {
  try {
    await run();
  } catch (error) {
    results.push({ id, pass: false });
    console.log(`\n${id}  NOT RUN TO THE END\n  ${error.message}\n  FAIL`);
  }
}

async function main() {
  console.log(`scratch directory: ${scratch}`);
  const bundleDir = path.join(scratch, 'bundles');
  await buildPages(bundleDir);
  server = await startServer({ bundleDir });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  console.log(`browser: Chromium ${browser.version()} (Playwright build), headless`);
  console.log(`pages: ${server.url}`);
  for (const testCase of cases) await attempt(testCase.id, () => runCase(browser, testCase));
  await browser.close();
  await attempt('R1', runRealWalletCase);
  await server.close();

  const failed = results.filter((result) => !result.pass).map((result) => result.id);
  writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length} of ${results.length} cases passed.`);
  if (failed.length > 0) {
    console.log(`VERDICT: not yet. Failed: ${failed.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    'VERDICT: yes, with one stated condition. The capture records the three steps from outside ' +
      'the tenant code on kit 2.8.0, with the real Varial (formerly Freighter) extension up to a ' +
      'declined request. Approval by a real account was run only against the stand-in; see the ' +
      'README for the two-minute manual run.',
  );
}

await main();
