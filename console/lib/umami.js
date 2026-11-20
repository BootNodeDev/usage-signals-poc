import { requireEnv, umamiAccessHeaders } from './config.js';

const FORWARD_TIMEOUT_MS = 5_000;
// Headers Umami reads before any other source: the first for the client address, the second
// for the country. Sending the address as a header, not as payload.ip, keeps Umami on its
// location headers, so it never needs a geo database.
const ADDRESS_HEADER = 'cf-connecting-ip';
const COUNTRY_HEADER = 'cf-ipcountry';

/**
 * Posts one event to Umami's collection endpoint and returns the HTTP status.
 * `visitor` is `{ address, country }`: the truncated address and, when the platform knows it,
 * the two-letter country.
 */
export async function forwardToUmami(payload, visitor) {
  const headers = {
    'content-type': 'application/json',
    [ADDRESS_HEADER]: visitor.address,
    ...umamiAccessHeaders(),
  };
  if (visitor.country) headers[COUNTRY_HEADER] = visitor.country;
  const response = await fetch(`${requireEnv('UMAMI_URL')}/api/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'event', payload }),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.status;
}
