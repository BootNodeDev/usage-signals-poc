import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FLAG_TAG_PATTERN, MAX_AGENTS_PER_ADDRESS, RULES, flagTag, rulesOf } from '../lib/flags.js';
import { FETCH_METADATA } from '../scripts/fixtures.mjs';

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

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

  it('reads as flagged only a tag made of rule codes', () => {
    const flagged = new RegExp(FLAG_TAG_PATTERN, 'i');
    for (const tag of ['bot', 'many-agents', 'no-sec-fetch+many-agents', 'bot+no-sec-fetch+many-agents']) {
      assert.ok(flagged.test(tag), tag);
    }
    for (const tag of ['', 'sample', 'bot+sample', 'sample+bot', 'bot+', 'botnet', 'bot,no-sec-fetch']) {
      assert.ok(!flagged.test(tag), tag);
    }
  });
});
