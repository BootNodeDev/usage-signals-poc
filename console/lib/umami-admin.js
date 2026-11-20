// Authenticated Umami API access: the seed script, the tests and the read endpoint.
import { requireEnv, umamiAccessHeaders } from './config.js';

const READ_TIMEOUT_MS = 8_000;
// Kept for the life of the instance: Fluid compute reuses module state across invocations.
// Umami's login token carries no expiry, so it is replaced only when Umami answers 401.
let sharedSession = null;

export async function umamiLogin() {
  const baseUrl = requireEnv('UMAMI_URL');
  const username = process.env.UMAMI_ADMIN_USER || 'admin';
  let response;
  try {
    response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...umamiAccessHeaders() },
      body: JSON.stringify({ username, password: requireEnv('UMAMI_ADMIN_PASSWORD') }),
    });
  } catch (error) {
    const reason = error.cause?.code ?? error.name;
    throw new Error(`cannot reach Umami (${reason}). Check UMAMI_URL.`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(
      `Umami refused the login for user "${username}" (HTTP ${response.status}). ` +
        'Check UMAMI_ADMIN_USER and UMAMI_ADMIN_PASSWORD.',
    );
  }
  const { token } = await response.json();
  return { baseUrl, token };
}

export async function umamiRequest(session, path, init = {}) {
  const response = await fetch(`${session.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
      ...umamiAccessHeaders(),
      ...init.headers,
    },
  });
  return response;
}

async function getOnce(path) {
  sharedSession ??= umamiLogin();
  const session = await sharedSession;
  return umamiRequest(session, path, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
}

/** GET on the Umami API with the shared admin session; logs in again once after a 401. */
export async function umamiGet(path) {
  let response;
  try {
    response = await getOnce(path);
    if (response.status === 401) {
      sharedSession = null;
      response = await getOnce(path);
    }
  } catch (error) {
    sharedSession = null;
    throw error;
  }
  if (!response.ok) throw new Error(`Umami answered HTTP ${response.status} to a read`);
  return response.json();
}
