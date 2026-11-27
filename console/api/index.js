// Each audience has its own endpoints so each can get its own access check.
import { handleDemoSite } from '../lib/demo-site.js';
import { handleEvent } from '../lib/gateway.js';
import { handleIngest } from '../lib/ingest.js';
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
    if (pathname === '/v1/metrics') return handleIngest(request);
    if (pathname === '/api/operator/projects') return handleOperatorProjects(request);
    if (pathname === '/api/public/projects') return handlePublicProjects(request);
    if (pathname === '/api/cron/sample-traffic') return handleSampleTraffic(request);
    // Loaded on first use: the OpenTelemetry SDK would slow every other route's cold start.
    if (pathname.startsWith('/demo/api/')) {
      return import('../lib/demo-api.js').then((demo) => demo.handleDemoApi(request));
    }
    if (pathname === '/demo' || pathname.startsWith('/demo/')) return handleDemoSite(request);
    const tenant = pathname.match(TENANT_ROUTE);
    if (tenant) return TENANT_HANDLERS[tenant[2]](request, tenant[1]);
    return Response.json({ error: 'Not found.' }, { status: 404 });
  },
};
