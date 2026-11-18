import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { truncateAddress, truncatedClientAddress } from '../lib/client-address.js';

describe('truncateAddress', () => {
  const cases = [
    ['203.0.113.57', '203.0.113.0'],
    ['::ffff:203.0.113.57', '203.0.113.0'],
    ['2001:db8:4f2a:1c07:9e3b:51ff:fe20:8a11', '2001:db8:4f2a::'],
    ['2001:0DB8:4F2A::1', '2001:db8:4f2a::'],
    ['2001:db8::1', '2001:db8:0::'],
    ['::1', '0:0:0::'],
    ['fe80::1%en0', 'fe80:0:0::'],
    ['64:ff9b::203.0.113.57', '64:ff9b:0::'],
  ];
  for (const [address, expected] of cases) {
    it(`${address} becomes ${expected}`, () => assert.equal(truncateAddress(address), expected));
  }

  it('returns null for anything that is not an address', () => {
    for (const value of ['', 'localhost', '203.0.113', '203.0.113.57:8080', 'unknown']) {
      assert.equal(truncateAddress(value), null, value);
    }
  });
});

describe('truncatedClientAddress', () => {
  it('reads only the header the platform sets', () => {
    const fromPlatform = new Headers({ 'x-vercel-forwarded-for': '203.0.113.57, 10.0.0.1' });
    assert.equal(truncatedClientAddress(fromPlatform), '203.0.113.0');
    const fromCaller = new Headers({ 'x-forwarded-for': '203.0.113.57', 'x-real-ip': '203.0.113.57' });
    assert.equal(truncatedClientAddress(fromCaller), null);
  });
});
