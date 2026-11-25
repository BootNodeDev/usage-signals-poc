import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_AGENTS_PER_ADDRESS, RULES, flagTag, rulesOf } from '../lib/flags.js';

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FETCH_METADATA = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

function headersWithout(name) {
  const headers = new Headers(FETCH_METADATA);
  headers.delete(name);
  return headers;
}

describe('flag rules', () => {
  it('leaves a browser request with its fetch headers unflagged', () => {
    assert.equal(flagTag(new Headers(FETCH_METADATA), BROWSER, 1), undefined);
  });

  it('flags a known bot, a script and a headless browser by their User-Agent', () => {
    for (const userAgent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'python-requests/2.32.3',
      BROWSER.replace('Chrome/', 'HeadlessChrome/'),
    ]) {
      assert.equal(flagTag(new Headers(FETCH_METADATA), userAgent, 1), 'bot', userAgent);
    }
  });

  it('flags a request that lacks any one of the three fetch headers', () => {
    for (const name of Object.keys(FETCH_METADATA)) {
      assert.equal(flagTag(headersWithout(name), BROWSER, 1), 'no-sec-fetch', name);
    }
  });

  it(`flags an address from its ${MAX_AGENTS_PER_ADDRESS + 1}th User-Agent of the day on`, () => {
    assert.equal(flagTag(new Headers(FETCH_METADATA), BROWSER, MAX_AGENTS_PER_ADDRESS), undefined);
    assert.equal(flagTag(new Headers(FETCH_METADATA), BROWSER, MAX_AGENTS_PER_ADDRESS + 1), 'many-agents');
  });

  it('names every rule that matched, in a tag that fits the 50 characters Umami stores', () => {
    const tag = flagTag(new Headers(), 'curl/8.7.1', MAX_AGENTS_PER_ADDRESS + 1);
    assert.equal(tag, 'bot+no-sec-fetch+many-agents');
    assert.deepEqual(rulesOf(tag), RULES);
    assert.ok(tag.length <= 50);
  });

  it('is described on the tenant page with the threshold the gateway uses', async () => {
    const page = await readFile(path.join(import.meta.dirname, '..', 'public', 'tenant', 'web.html'), 'utf8');
    assert.ok(page.includes(`more than ${MAX_AGENTS_PER_ADDRESS} User-Agents`));
    assert.ok(page.includes(`limit of ${MAX_AGENTS_PER_ADDRESS} User-Agents`));
  });
});
