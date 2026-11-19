// One ingest location running the gateway exactly as it is today: console/lib/gateway.js,
// imported and not copied. Needs DATABASE_URL, UMAMI_URL and GATEWAY_PORT.
import { handleEvent } from '../../console/lib/gateway.js';
import { serve } from './serve.mjs';

const port = Number(process.env.GATEWAY_PORT);
if (!port) throw new Error('GATEWAY_PORT is not set.');

serve(`gateway-today:${port}`, port, handleEvent);
