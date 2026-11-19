// The single Vercel function. vercel.json rewrites /api/* and /demo/* here; routes are matched
// by path. Tenant and operator endpoints are separate so each can get its own access check.
import { handleDemoSite } from '../lib/demo-site.js';
import { handleEvent } from '../lib/gateway.js';
import { handleOperatorProjects } from '../lib/operator-api.js';
import { handleTenantProject, handleTenantWeb } from '../lib/tenant-api.js';

const TENANT_ROUTE = /^\/api\/tenant\/([^/]+)\/(web|project)$/;
const TENANT_HANDLERS = { web: handleTenantWeb, project: handleTenantProject };

export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/e') return handleEvent(request);
    if (pathname === '/api/operator/projects') return handleOperatorProjects(request);
    if (pathname === '/demo' || pathname.startsWith('/demo/')) return handleDemoSite(request);
    const tenant = pathname.match(TENANT_ROUTE);
    if (tenant) return TENANT_HANDLERS[tenant[2]](request, tenant[1]);
    return Response.json({ error: 'Not found.' }, { status: 404 });
  },
};
