// Authenticated Umami API access for the seed script and the tests. The deployed functions
// never import this file.
import { requireEnv } from './config.js';

export async function umamiLogin() {
  const baseUrl = requireEnv('UMAMI_URL');
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: requireEnv('UMAMI_ADMIN_USER'),
      password: requireEnv('UMAMI_ADMIN_PASSWORD'),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Umami login at ${baseUrl} failed with HTTP ${response.status}. ` +
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
