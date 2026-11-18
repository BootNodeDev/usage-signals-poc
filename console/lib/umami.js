import { requireEnv } from './config.js';

const FORWARD_TIMEOUT_MS = 5_000;

/** Posts one event to Umami's collection endpoint and returns the HTTP status. */
export async function forwardToUmami(payload) {
  const response = await fetch(`${requireEnv('UMAMI_URL')}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'event', payload }),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.status;
}
