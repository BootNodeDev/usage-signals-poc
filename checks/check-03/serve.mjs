// Local stand-in for the platform in front of a gateway, as console/dev.mjs is: it sets
// x-vercel-forwarded-for from the caller's x-forwarded-for, which is how the check
// simulates visitors with different addresses.
import { createServer } from 'node:http';

async function readBody(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function platformHeaders(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const callerSupplied = headers.get('x-forwarded-for')?.split(',')[0].trim();
  headers.set('x-vercel-forwarded-for', callerSupplied || incoming.socket.remoteAddress);
  return headers;
}

async function answer(incoming, outgoing, handler) {
  const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
    method: incoming.method,
    headers: platformHeaders(incoming),
    body: incoming.method === 'POST' ? await readBody(incoming) : undefined,
  });
  const response = await handler(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

/** Serves `handler(Request) => Response` on 127.0.0.1:`port`. */
export function serve(name, port, handler) {
  const server = createServer((incoming, outgoing) => {
    answer(incoming, outgoing, handler).catch((error) => {
      console.error(`${name}: ${incoming.method} ${incoming.url} failed: ${error.stack}`);
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    });
  });
  server.listen(port, '127.0.0.1', () => console.log(`${name}: http://127.0.0.1:${port}`));
}
