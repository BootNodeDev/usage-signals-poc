// Drives one Chromium over the DevTools protocol. Each repetition is its own tab, which
// loads the page from page.test; the product's tracker file on that page sends the page
// view to the repetition's ingest host. With `close`, the tab is closed as soon as Chromium
// reports that the request has been issued.
// Usage: node browser.mjs '<case as JSON>'   Prints one line: RESULT <json>.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { Cdp } from './cdp.mjs';

const { hosts, port, windowMs, staggerMs, close, chromium } = JSON.parse(process.argv[2]);

/** Records what Chromium reports about the tracker's request to `base`. */
function watch(rep, base, onIssued, onSettled) {
  const methods = new Map();
  return (event, params) => {
    if (event === 'Network.requestWillBeSent' && params.request.url.startsWith(base)) {
      methods.set(params.requestId, params.request.method);
      if (rep.t0 === undefined) {
        rep.t0 = Math.round(params.wallTime * 1000);
        onIssued();
      }
      return;
    }
    const method = methods.get(params?.requestId);
    if (!method) return;
    if (event === 'Network.loadingFailed') rep.errors.push(`${method} ${params.errorText}`);
    if (method !== 'POST') return;
    if (event === 'Network.responseReceived') rep.remote = params.response.remoteIPAddress;
    if (event === 'Network.loadingFinished' || event === 'Network.loadingFailed') {
      rep.outcome = event === 'Network.loadingFinished' ? 'ok' : 'error';
      rep.elapsedMs = Date.now() - rep.t0;
      onSettled();
    }
  };
}

async function runRepetition(cdp, host, deadline) {
  const base = `http://${host}:${port}`;
  const rep = { host, outcome: 'pending', errors: [] };
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const issued = Promise.withResolvers();
  const settled = Promise.withResolvers();
  cdp.listen(sessionId, watch(rep, base, issued.resolve, settled.resolve));
  await cdp.send('Network.enable', {}, sessionId);
  const page = `http://page.test:8080/?host=${encodeURIComponent(base)}`;
  await cdp.send('Page.navigate', { url: page }, sessionId);
  const timeout = sleep(Math.max(0, deadline - Date.now()));
  await Promise.race([close ? issued.promise : settled.promise, timeout]);
  if (close && rep.t0 !== undefined) rep.outcome = 'closed';
  if (rep.t0 === undefined) rep.outcome = 'not sent';
  cdp.listen(sessionId, () => {});
  await cdp.send('Target.closeTarget', { targetId });
  rep.error = rep.errors.join('; ') || undefined;
  delete rep.errors;
  return rep;
}

/** After the tabs are closed only the endpoints can tell whether a request arrived. */
async function waitForArrivals(deadline) {
  const wanted = new Set(hosts.map((host) => `${host}:${port}`));
  while (Date.now() < deadline) {
    for (const name of ['a', 'b']) {
      for (const line of readFileSync(`/scratch/endpoint-${name}.jsonl`, 'utf8').split('\n')) {
        if (line.includes('"req"')) wanted.delete(JSON.parse(line).host);
      }
    }
    if (wanted.size === 0) return;
    await sleep(1000);
  }
}

const { cdp, product } = await Cdp.connect(chromium);
// Tabs are opened one at a time, so that one page load does not slow the next.
const deadline = Date.now() + hosts.length * staggerMs + windowMs;
const running = [];
for (const host of hosts) {
  running.push(runRepetition(cdp, host, deadline));
  await sleep(staggerMs);
}
const reps = await Promise.all(running);
if (close) await waitForArrivals(deadline);
console.log(`RESULT ${JSON.stringify({ reps, product })}`);
process.exit(0);
