// Calls the function the way the platform does, with a streamed body, to see how much it reads.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import api from '../api/index.js';

const CHUNK_BYTES = 8 * 1024;
const TOTAL_BYTES = 5 * 1024 * 1024;

it('stops reading the body once it exceeds the cap and answers 413', async () => {
  let bytesPulled = 0;
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (bytesPulled >= TOTAL_BYTES) return controller.close();
        bytesPulled += CHUNK_BYTES;
        controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request('http://localhost/api/e', {
    method: 'POST',
    headers: { origin: 'http://localhost:4301', 'content-type': 'application/json' },
    body,
    duplex: 'half',
  });

  const response = await api.fetch(request);

  assert.equal(response.status, 413);
  assert.ok(cancelled, 'the rest of the body was not discarded');
  assert.ok(bytesPulled <= 64 * 1024, `read ${bytesPulled} bytes of a ${TOTAL_BYTES} byte body`);
});

it('answers 413 from the declared length without reading the body', async () => {
  const request = new Request('http://localhost/api/e', {
    method: 'POST',
    headers: { 'content-length': String(TOTAL_BYTES) },
    body: '{}',
  });
  assert.equal((await api.fetch(request)).status, 413);
});
