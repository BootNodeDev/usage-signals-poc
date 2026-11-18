// Authenticated Umami API access for the seed script and the tests. The deployed functions
// never import this file.
import { requireEnv } from './config.js';

export async function umamiLogin() {
  const baseUrl = requireEnv('UMAMI_URL');
  const username = process.env.UMAMI_ADMIN_USER || 'admin';
  let response;
  try {
    response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      ...init.headers,
    },
  });
  return response;
}
