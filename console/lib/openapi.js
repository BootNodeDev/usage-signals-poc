// The OpenAPI description of the metrics API, served at /api/v1/openapi.json. A test checks the
// real answers against it, so a change to the answer needs a change here.
import { cached } from './web-read.js';

const SMALL = {
  type: 'object',
  description: 'More than zero and fewer than `below`; the exact number is not sent.',
  properties: { small: { type: 'boolean', enum: [true] }, below: { type: 'integer', minimum: 1 } },
  required: ['small', 'below'],
  additionalProperties: false,
};

const error = (description) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
});

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (name) => ({ oneOf: [ref(name), { type: 'null' }] });

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Pulse metrics API',
    version: '1',
    description:
      'Aggregate web and API figures of the projects an operator API key may read. Counts from 1 ' +
      'to 9 are sent as `Small`; rates and percentiles over fewer than 10 visits or requests too.',
  },
  paths: {
    '/api/v1/projects': {
      get: {
        summary: 'Figures of every project the key may read',
        security: [{ operatorKey: [] }],
        parameters: [
          {
            name: 'days',
            in: 'query',
            required: true,
            description: 'Whole UTC days ending now, today included.',
            schema: { type: 'integer', enum: [7, 30, 90] },
          },
        ],
        responses: {
          200: {
            description: 'Figures, not cached: the answer depends on the key.',
            content: { 'application/json': { schema: ref('Projects') } },
          },
          400: error('`days` is not 7, 30 or 90.'),
          401: error('No key, or a key that is unknown or revoked (`WWW-Authenticate: Bearer`).'),
          405: error('A method other than GET.'),
          429: error('The key used its requests of the minute; `Retry-After` gives the seconds.'),
          503: error('The figures could not be read; retry later.'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      operatorKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'An operator API key (`pls_…`), issued with `npm run api-key -- create`.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
        additionalProperties: false,
      },
      Small: SMALL,
      Count: { oneOf: [{ type: 'integer', minimum: 0 }, ref('Small')] },
      Rate: {
        description: 'A number, `Small` when it rests on fewer than 10, null when there is none.',
        oneOf: [{ type: 'number' }, ref('Small'), { type: 'null' }],
      },
      Labelled: {
        type: 'object',
        properties: { label: { type: 'string' }, value: ref('Count') },
        required: ['label', 'value'],
        additionalProperties: false,
      },
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          slug: { type: 'string' },
          name: { type: 'string' },
          domain: { type: 'string' },
          state: { type: 'string' },
        },
        required: ['id', 'slug', 'name', 'domain', 'state'],
        additionalProperties: false,
      },
      WebTotals: {
        type: 'object',
        properties: {
          pageviews: ref('Count'),
          visitors: ref('Count'),
          visits: ref('Count'),
          bounces: ref('Count'),
          bounce_rate: ref('Rate'),
          avg_visit_seconds: ref('Rate'),
          flagged: ref('Count'),
        },
        required: [
          'pageviews', 'visitors', 'visits', 'bounces',
          'bounce_rate', 'avg_visit_seconds', 'flagged',
        ],
        additionalProperties: false,
      },
      Api: {
        type: 'object',
        description: 'API figures of the project; percentiles are estimates from histograms.',
        properties: {
          requests: ref('Count'),
          error_rate: ref('Rate'),
          p50_ms: ref('Rate'),
          p95_ms: ref('Rate'),
          routes: { type: 'array', items: ref('Labelled') },
        },
        required: ['requests', 'error_rate', 'p50_ms', 'p95_ms', 'routes'],
        additionalProperties: false,
      },
      ProjectRow: {
        type: 'object',
        properties: {
          project: ref('Project'),
          totals: nullable('WebTotals'),
          flagged_by_rule: { type: 'object', additionalProperties: ref('Count') },
          daily: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                day: { type: 'string' },
                pageviews: ref('Count'),
                flagged: ref('Count'),
              },
              required: ['day', 'pageviews', 'flagged'],
              additionalProperties: false,
            },
          },
          breakdowns: {
            type: 'object',
            additionalProperties: { type: 'array', items: ref('Labelled') },
          },
          api: {
            description:
              'Null when the figures could not be read, and on all but the first site of a '
              + 'project.',
            ...nullable('Api'),
          },
        },
        required: ['project', 'totals', 'flagged_by_rule', 'daily', 'breakdowns', 'api'],
        additionalProperties: false,
      },
      Projects: {
        type: 'object',
        properties: {
          days: { type: 'integer', enum: [7, 30, 90] },
          through: { type: 'string', description: 'ISO 8601 time the figures were read.' },
          small_counts: {
            type: 'object',
            properties: { below: { type: 'integer', minimum: 1 } },
            required: ['below'],
            additionalProperties: false,
          },
          projects: { type: 'array', items: ref('ProjectRow') },
        },
        required: ['days', 'through', 'small_counts', 'projects'],
        additionalProperties: false,
      },
    },
  },
};

/** GET /api/v1/openapi.json, readable without a key. */
export function handleOpenApi(request) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Use GET.' }, { status: 405, headers: { allow: 'GET' } });
  }
  return cached(OPENAPI);
}
