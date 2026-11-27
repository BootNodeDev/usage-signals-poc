import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { umamiAccessHeaders } from '../lib/config.js'

afterEach(() => {
  delete process.env.UMAMI_BYPASS_SECRET
})

test('no access header is sent to Umami when no bypass secret is set', () => {
  assert.deepEqual(umamiAccessHeaders(), {})
})

test('the bypass secret is sent to Umami in the protection bypass header', () => {
  process.env.UMAMI_BYPASS_SECRET = 'example'
  assert.deepEqual(umamiAccessHeaders(), { 'x-vercel-protection-bypass': 'example' })
})
