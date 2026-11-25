// Chromium with a tab that stays open. The page view the tracker sends on load opens the
// connection; later sends call the tracker's own `umami.track()` on the same page, at the
// given offsets. Usage: node browser-open.mjs '<case as JSON>'   Prints: RESULT <json>.
import { setTimeout as sleep } from 'node:timers/promises';

import { Cdp } from './cdp.mjs';

const { hosts, port, staggerMs, offsetsMs, tailMs, chromium } = JSON.parse(process.argv[2]);

/** Fills `sends` in the order Chromium issues the POSTs to `base`. */
function watch(sends, base) {
  const byRequest = new Map();
  return (event, params) => {
    const isPost = params?.request?.method === 'POST' && params.request.url.startsWith(base);
    if (event === 'Network.requestWillBeSent' && isPost) {
      const send = { t0: Math.round(params.wallTime * 1000), outcome: 'pending' };
      byRequest.set(params.requestId, send);
      sends.push(send);
      return;
    }
    const send = byRequest.get(params?.requestId);
    if (!send) return;
    if (event === 'Network.responseReceived') send.remote = params.response.remoteIPAddress;
    if (event === 'Network.loadingFinished' || event === 'Network.loadingFailed') {
      send.outcome = event === 'Network.loadingFinished' ? 'ok' : 'error';
      send.elapsedMs = Date.now() - send.t0;
      if (params.errorText) send.error = params.errorText;
    }
  };
}

async function runRepetition(cdp, host) {
  const base = `http://${host}:${port}`;
  const sends = [];
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.listen(sessionId, watch(sends, base));
  await cdp.send('Network.enable', {}, sessionId);
  const start = Date.now();
  const page = `http://page.test:8080/?host=${encodeURIComponent(base)}`;
  await cdp.send('Page.navigate', { url: page }, sessionId);
  for (const offset of offsetsMs.slice(1)) {
    await sleep(Math.max(0, start + offset - Date.now()));
    await cdp.send('Runtime.evaluate', { expression: "umami.track('check07')" }, sessionId);
  }
  // A request that is still pending when the tail ends is reported as pending.
  const end = Date.now() + tailMs;
  while (Date.now() < end && sends.some((send) => send.outcome === 'pending')) await sleep(500);
  cdp.listen(sessionId, () => {});
  await cdp.send('Target.closeTarget', { targetId });
  while (sends.length < offsetsMs.length) sends.push({ outcome: 'not sent' });
  return { host, sends };
}

const { cdp, product } = await Cdp.connect(chromium);
const running = [];
for (const host of hosts) {
  running.push(runRepetition(cdp, host));
  await sleep(staggerMs);
}
const reps = await Promise.all(running);
console.log(`RESULT ${JSON.stringify({ reps, product })}`);
process.exit(0);
