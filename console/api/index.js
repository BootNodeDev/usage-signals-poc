// Each audience has its own endpoints so each can get its own access check.
import { handleDemoSite } from '../lib/demo-site.js';
import { handleEvent } from '../lib/gateway.js';
import { handleMetricsProjects } from '../lib/metrics-api.js';
import { handleOpenApi } from '../lib/openapi.js';
import { handleOperatorProjects } from '../lib/operator-api.js';
import { handlePublicProjects } from '../lib/public-api.js';
import { handleSampleTraffic } from '../lib/sample-traffic.js';
import { handleTenantApi, handleTenantProject, handleTenantWeb } from '../lib/tenant-api.js';

const TENANT_ROUTE = /^\/api\/tenant\/([^/]+)\/(web|project|api)$/;
const TENANT_HANDLERS = {
  web: handleTenantWeb,
  project: handleTenantProject,
  api: handleTenantApi,
};

export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/e') return handleEvent(request);
    if (pathname === '/api/operator/projects') return handleOperatorProjects(request);
    if (pathname === '/api/v1/projects') return handleMetricsProjects(request);
    if (pathname === '/api/v1/openapi.json') return handleOpenApi(request);
    if (pathname === '/api/public/projects') return handlePublicProjects(request);
    if (pathname === '/api/cron/sample-traffic') return handleSampleTraffic(request);
    if (pathname === '/demo' || pathname.startsWith('/demo/')) return handleDemoSite(request);
    const tenant = pathname.match(TENANT_ROUTE);
    if (tenant) return TENANT_HANDLERS[tenant[2]](request, tenant[1]);
    return Response.json({ error: 'Not found.' }, { status: 404 });
  },
};
