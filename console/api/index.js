// The single Vercel function. vercel.json rewrites /api/* here; routes are matched by path.
import { handleEvent } from '../lib/gateway.js';
import { handleSites, handleWebRead } from '../lib/web-read.js';

const ROUTES = new Map([
  ['/api/e', handleEvent],
  ['/api/sites', handleSites],
  ['/api/web', handleWebRead],
]);

export default {
  fetch(request) {
    const route = ROUTES.get(new URL(request.url).pathname);
    return route ? route(request) : Response.json({ error: 'Not found.' }, { status: 404 });
  },
};
