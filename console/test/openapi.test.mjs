// The metrics API's OpenAPI description is served, and the real answers match it, so the
// contract machine consumers read cannot drift from the code.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKey } from '../lib/api-keys.js';
import { requireEnv } from '../lib/config.js';

const GATEWAY = requireEnv('GATEWAY_URL');

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return Number.isInteger(value) ? 'integer' : typeof value;
}

/**
 * Checks `value` against the subset of JSON Schema the description uses: $ref, type, enum,
 * minimum, properties, required, additionalProperties, items and oneOf. Returns the problems
 * found, an empty list when the value matches.
 */
function validate(schema, value, spec, where = '$') {
  if (schema.$ref) {
    const named = spec.components.schemas[schema.$ref.split('/').at(-1)];
    return validate(named, value, spec, where);
  }
  if (schema.oneOf) {
    const fits = schema.oneOf.filter((option) => validate(option, value, spec, where).length === 0);
    return fits.length === 1 ? [] : [`${where}: matches ${fits.length} of oneOf`];
  }
  const actual = typeOf(value);
  const types = [schema.type].flat().filter(Boolean);
  const numberOk = actual === 'integer' && types.includes('number');
  if (types.length && !types.includes(actual) && !numberOk) {
    return [`${where}: ${actual} is not ${types.join('|')}`];
  }
  const problems = [];
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${where}: ${value} not in enum`);
  if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${where}: too small`);
  if (actual === 'object') problems.push(...validateObject(schema, value, spec, where));
  if (actual === 'array' && schema.items) {
    value.forEach((item, index) => {
      problems.push(...validate(schema.items, item, spec, `${where}[${index}]`));
    });
  }
  return problems;
}

function validateObject(schema, value, spec, where) {
  const problems = [];
  for (const name of schema.required ?? []) {
    if (!(name in value)) problems.push(`${where}: missing ${name}`);
  }
  for (const [name, child] of Object.entries(value)) {
    const known = schema.properties?.[name] ?? schema.additionalProperties;
    if (known === false) problems.push(`${where}: unexpected ${name}`);
    else if (known && typeof known === 'object') {
      problems.push(...validate(known, child, spec, `${where}.${name}`));
    }
  }
  return problems;
}

describe('the metrics API description', () => {
  it('is served and describes /api/v1/projects behind a Bearer key', async () => {
    const response = await fetch(`${GATEWAY}/api/v1/openapi.json`);
    assert.equal(response.status, 200);
    const spec = await response.json();
    assert.match(spec.openapi, /^3\.1\./);
    const operation = spec.paths['/api/v1/projects'].get;
    assert.deepEqual(operation.security, [{ operatorKey: [] }]);
    assert.equal(spec.components.securitySchemes.operatorKey.scheme, 'bearer');
    const codes = Object.keys(operation.responses).sort();
    assert.deepEqual(codes, ['200', '400', '401', '405', '429', '503']);
  });

  it('matches the real answer of /api/v1/projects and of a refused request', async () => {
    const spec = await (await fetch(`${GATEWAY}/api/v1/openapi.json`)).json();
    const { key } = await createKey({ label: `openapi-${Date.now()}`, actor: 'tester' });
    for (const days of [7, 30]) {
      const body = await (await fetch(`${GATEWAY}/api/v1/projects?days=${days}`, {
        headers: { authorization: `Bearer ${key}` },
      })).json();
      assert.ok(body.projects.length > 0);
      const problems = validate({ $ref: '#/components/schemas/Projects' }, body, spec);
      assert.deepEqual(problems, [], `days=${days}`);
    }
    const refused = await (await fetch(`${GATEWAY}/api/v1/projects?days=7`)).json();
    assert.deepEqual(validate({ $ref: '#/components/schemas/Error' }, refused, spec), []);
  });

  it('would catch an answer that drifts from the description', async () => {
    const spec = await (await fetch(`${GATEWAY}/api/v1/openapi.json`)).json();
    const drifted = {
      days: 7, through: 'x', small_counts: { below: 10 }, projects: [{ project: {} }],
    };
    assert.ok(validate({ $ref: '#/components/schemas/Projects' }, drifted, spec).length > 0);
  });
});
