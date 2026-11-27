// The route rules of the ingestion endpoint are the check 5 collector's path rules in
// JavaScript, held to the same 165 vectors, whose expected routes are written by hand.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VECTORS } from '../../checks/check-05/vectors.mjs';
import { normalizeRoute } from '../lib/route-rules.js';

describe('route rules', () => {
  it('give every check 5 vector its expected route', () => {
    assert.equal(VECTORS.length, 165);
    const wrong = VECTORS.filter((vector) => normalizeRoute(vector.raw) !== vector.expected).map(
      (vector) => `${vector.why}: gave ${normalizeRoute(vector.raw)}, expected ${vector.expected}`,
    );
    assert.deepEqual(wrong, []);
  });

  it('name a missing route (unmatched)', () => {
    assert.equal(normalizeRoute(undefined), '(unmatched)');
    assert.equal(normalizeRoute(null), '(unmatched)');
  });

  it('leave every segment at most 36 printable ASCII characters, whatever is sent', () => {
    const odd = ['/a'.repeat(600), `/${'x'.repeat(40)}/ok`, '/café/menu', '/\u0000/x', '//'];
    for (const raw of odd) {
      for (const segment of normalizeRoute(raw).split('/')) {
        assert.match(segment, /^[ -~]{0,36}$/, JSON.stringify(raw));
      }
    }
  });
});
