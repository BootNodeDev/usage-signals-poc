import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { requireEnv } from '../lib/config.js'
import { TENANTS } from '../scripts/fixtures.mjs'

const POC_ROOT = path.resolve(import.meta.dirname, '..')
if (!process.env.GATEWAY_URL) process.loadEnvFile(path.join(POC_ROOT, 'local.env'))

const [{ site }] = TENANTS
const GATEWAY_CHECKS = /^## Try the gateway checks\n([\s\S]*?)^## /m
const COMMAND_AND_OUTPUT = /```sh\n(\s*curl [\s\S]*?)\n\s*```\n\n\s*`([^`]+)`/g

function gatewayChecks() {
  const [, section] = readFileSync(path.join(POC_ROOT, 'README.md'), 'utf8').match(GATEWAY_CHECKS)
  return [...section.matchAll(COMMAND_AND_OUTPUT)].map(([, command, output]) => ({
    command,
    output,
  }))
}

describe('console README', () => {
  it('prints the documented answer for each gateway check', () => {
    const env = {
      ...process.env,
      GATEWAY: requireEnv('GATEWAY_URL'),
      ORIGIN: `http://${site.domain}`,
      WEBSITE: site.umamiWebsiteId,
    }
    const checks = gatewayChecks()
    assert.equal(checks.length, 3)
    for (const { command, output } of checks) {
      assert.equal(execFileSync('sh', ['-c', command], { env, encoding: 'utf8' }).trim(), output)
    }
  })
})
