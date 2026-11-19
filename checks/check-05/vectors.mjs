// Path-rule test vectors for check 05. Written for this experiment: the 91-vector reference set
// the architecture document mentions was not available. Vectors 72 onwards come from the
// independent review of this check. The expected route is stated here by hand and never
// computed from the rules.
// kind: "rewrite" an identifier must be replaced, "keep" the path must stay as it is,
// "limit" a case the rules get wrong or cannot express, with the behaviour they have today;
// a limit whose expected route still holds the identifier is a raw identifier that survives.
import { signedPayloadStrkey, strkey } from './lib.mjs';

const G = strkey('G', 1);
const G2 = strkey('G', 2);
const C = strkey('C', 3);
const M = strkey('M', 4);
const S = strkey('S', 5);
const P = signedPayloadStrkey(6);
const UUID = '3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b';
const SHA256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const SHA512 = SHA256 + SHA256;
const MIXED_CASE_HASH = [...SHA256].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
// Not a working token: three base64url parts in the shape of a JWT. gitleaks:allow applies below.
const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTQyIn0.c2lnbmF0dXJlLWJ5dGVz'; // gitleaks:allow

// Look-alikes built from a real account address.
const notBase32 = `${G.slice(0, 20)}1${G.slice(21)}`; // "1" is not in the base-32 alphabet
const badSecondChar = `GZ${G.slice(2)}`; // an account's second character is A to D
const unknownType = `Q${G.slice(1)}`; // 56 capital letters, but no strkey starts with Q
const badChecksum = `${G.slice(0, 55)}${G.endsWith('A') ? 'B' : 'A'}`;
const manyIds = `/${'seg/123/'.repeat(100)}`;

const ROWS = [
  ['rewrite', '/users/123', '/users/{id}', 'numeric ID'],
  ['rewrite', '/users/123/orders/456', '/users/{id}/orders/{id}', 'two numeric IDs'],
  ['rewrite', '/1/2/3/4', '/{id}/{id}/{id}/{id}', 'adjacent numeric segments'],
  ['rewrite', '/ledgers/0', '/ledgers/{id}', 'zero'],
  ['rewrite', '/ledgers/00051234567890123456', '/ledgers/{id}', 'long number'],
  ['rewrite', '/42', '/{id}', 'number as the only segment'],
  ['keep', '/v2/users', '/v2/users', 'version segment'],
  ['keep', '/api/v1/items', '/api/v1/items', 'version segment'],
  ['keep', '/oauth2/token', '/oauth2/token', 'digits inside a word'],
  ['keep', '/reports/2026-11-19', '/reports/2026-11-19', 'a date is not a numeric ID'],
  ['keep', '/items/12a', '/items/12a', 'digits followed by a letter'],
  ['rewrite', `/orders/${UUID}`, '/orders/{uuid}', 'UUID'],
  ['rewrite', `/orders/${UUID.toUpperCase()}/items`, '/orders/{uuid}/items', 'upper-case UUID'],
  ['rewrite', `/a/${UUID}/${UUID}`, '/a/{uuid}/{uuid}', 'adjacent UUIDs'],
  [
    'keep',
    `/orders/${UUID.slice(0, 35)}`,
    `/orders/${UUID.slice(0, 35)}`,
    'UUID one character short',
  ],
  [
    'keep',
    `/orders/${UUID.replace('3f2b', 'zzzz')}`,
    `/orders/${UUID.replace('3f2b', 'zzzz')}`,
    'UUID shape with non-hex letters',
  ],
  ['rewrite', `/tx/${SHA256}`, '/tx/{hash}', 'transaction hash, 64 hex digits'],
  ['rewrite', `/tx/${SHA256.toUpperCase()}/effects`, '/tx/{hash}/effects', 'upper-case hash'],
  ['rewrite', `/tx/0x${SHA256}`, '/tx/{hash}', 'hash with 0x'],
  ['rewrite', `/blobs/${SHA1}`, '/blobs/{hash}', '40 hex digits'],
  ['rewrite', `/blobs/${MD5}`, '/blobs/{hash}', '32 hex digits'],
  ['rewrite', `/blobs/${SHA512}`, '/blobs/{hash}', '128 hex digits'],
  ['keep', '/assets/cafe', '/assets/cafe', 'short hex word'],
  ['keep', '/assets/deadbeef', '/assets/deadbeef', 'short hex word'],
  ['keep', '/assets/facade', '/assets/facade', 'English word made of hex letters'],
  [
    'rewrite',
    `/blobs/${SHA256.slice(0, 63)}`,
    '/blobs/{hash}',
    '63 hex digits: any hex run of 24 or more is taken as a hash',
  ],
  [
    'keep',
    `/blobs/${SHA256.slice(0, 63)}g`,
    `/blobs/${SHA256.slice(0, 63)}g`,
    '64 characters, one not hex',
  ],
  ['rewrite', `/accounts/${G}`, '/accounts/{account}', 'G-address'],
  ['rewrite', `/accounts/${G}/payments`, '/accounts/{account}/payments', 'G-address inside a path'],
  ['rewrite', `/paths/${G}/${G2}`, '/paths/{account}/{account}', 'adjacent G-addresses'],
  [
    'rewrite',
    `/accounts/GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ`,
    '/accounts/{account}',
    'the G-address of SEP-23 test vector 1',
  ],
  ['rewrite', `/contracts/${C}`, '/contracts/{contract}', 'C-address'],
  [
    'rewrite',
    `/contracts/${C}/events/7`,
    '/contracts/{contract}/events/{id}',
    'C-address then numeric ID',
  ],
  ['rewrite', `/accounts/${M}`, '/accounts/{muxed_account}', 'M-address, 69 characters'],
  [
    'rewrite',
    `/accounts/MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ`,
    '/accounts/{muxed_account}',
    'the M-address of SEP-23 test vector 2',
  ],
  ['rewrite', `/keys/${S}`, '/keys/{redacted}', 'secret seed'],
  ['rewrite', `/x/${strkey('T', 6)}`, '/x/{strkey}', 'pre-authorized transaction strkey'],
  ['rewrite', `/x/${strkey('X', 7)}`, '/x/{strkey}', 'hash-x strkey'],
  ['rewrite', `/pools/${strkey('L', 8)}`, '/pools/{strkey}', 'liquidity pool strkey'],
  [
    'rewrite',
    `/balances/${strkey('B', 9)}`,
    '/balances/{strkey}',
    'claimable balance strkey, 58 characters',
  ],
  ['rewrite', `/x/${strkey('W', 10)}`, '/x/{strkey}', 'muxed contract strkey, 69 characters'],
  [
    'keep',
    `/accounts/${unknownType}`,
    `/accounts/${unknownType}`,
    '56 capital letters and digits starting with Q: no such strkey type',
  ],
  [
    'keep',
    `/accounts/${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(3).slice(0, 56)}`,
    `/accounts/${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(3).slice(0, 56)}`,
    'a word of 56 capital letters',
  ],
  [
    'keep',
    `/accounts/${notBase32}`,
    `/accounts/${notBase32}`,
    'G-shape with a character outside the base-32 alphabet',
  ],
  [
    'keep',
    `/accounts/${badSecondChar}`,
    `/accounts/${badSecondChar}`,
    'G-shape with an impossible second character',
  ],
  [
    'keep',
    `/accounts/${G.slice(0, 55)}`,
    `/accounts/${G.slice(0, 55)}`,
    'G-address one character short',
  ],
  [
    'limit',
    `/accounts/${G}A`,
    '/accounts/{redacted}',
    '57 characters: no strkey, but it holds a seed-like run and is redacted (the result depends on the letters)',
  ],
  [
    'keep',
    `/accounts/${G.toLowerCase()}`,
    `/accounts/${G.toLowerCase()}`,
    'lower-case G-shape: strkeys are upper case',
  ],
  [
    'keep',
    `/accounts/${M.slice(0, 68)}`,
    `/accounts/${M.slice(0, 68)}`,
    'M-address one character short',
  ],
  ['keep', '/GET/CONFIG', '/GET/CONFIG', 'short capital words starting with G and C'],
  ['rewrite', '/users/', '/users', 'trailing slash'],
  ['rewrite', '/users/123/', '/users/{id}', 'numeric ID and trailing slash'],
  ['rewrite', `/accounts/${G}/`, '/accounts/{account}', 'G-address and trailing slash'],
  ['rewrite', '/users///', '/users', 'several trailing slashes'],
  ['rewrite', '/users//123', '/users/{id}', 'doubled slash inside a path'],
  ['keep', '/', '/', 'the root stays'],
  ['rewrite', '/users/123?cursor=456&limit=10', '/users/{id}', 'query string removed'],
  ['rewrite', `/accounts/${G}?cursor=now`, '/accounts/{account}', 'query string after an address'],
  ['rewrite', '/search?q=/users/123', '/search', 'query string holding a path'],
  ['rewrite', '/docs/page#section-2', '/docs/page', 'fragment removed'],
  ['keep', '/users/{id}', '/users/{id}', 'route template'],
  ['keep', '/users/:id/orders/:orderId', '/users/:id/orders/:orderId', 'colon-style template'],
  ['keep', '/rpc/getTransaction', '/rpc/getTransaction', 'JSON-RPC method as route'],
  ['rewrite', 'users/list', '/users/list', 'no leading slash: one is added'],
  ['rewrite', 'users/123', '/users/{id}', 'no leading slash, numeric ID'],
  [
    'limit',
    `/accounts/${badChecksum}`,
    '/accounts/{account}',
    'wrong checksum is still rewritten: a regular expression cannot compute CRC-16',
  ],
  [
    'limit',
    '/users/123.json',
    '/users/123.json',
    'identifier with a file extension is not rewritten',
  ],
  [
    'rewrite',
    `/accounts/${G}:payments`,
    '/accounts/{account}:payments',
    'address followed by other text in the same segment',
  ],
  ['rewrite', '/users/alice@example.org', '/users/{email}', 'e-mail address'],
  [
    'limit',
    '/users/jane-doe',
    '/users/jane-doe',
    'free-text identifiers need the token heuristic, which is not a regular expression',
  ],
  [
    'limit',
    `/blobs/${'1'.repeat(64)}`,
    '/blobs/{id}',
    'a hash made only of digits is reported as a numeric ID',
  ],
  // ---- From the independent review.
  ['rewrite', '/v2/accounts/123', '/v2/accounts/{id}', 'version segment then numeric ID'],
  ['rewrite', '/a/123/456/789', '/a/{id}/{id}/{id}', 'three adjacent numeric IDs'],
  ['rewrite', '/123/users', '/{id}/users', 'numeric ID first'],
  ['rewrite', '123', '/{id}', 'a bare number'],
  ['rewrite', '/2026/11/19/post', '/{id}/{id}/{id}/post', 'date as three segments'],
  ['keep', '/1.0/users', '/1.0/users', 'dotted version'],
  ['rewrite', '/v10/x/7', '/v10/x/{id}', 'version then numeric ID'],
  ['limit', '/users/-123', '/users/-123', 'negative number survives'],
  ['limit', '/users/1.5', '/users/1.5', 'decimal number survives'],
  ['limit', '/users/123,456', '/users/123,456', 'list of numbers survives'],
  ['limit', '/users/123;v=2', '/users/123;v=2', 'matrix parameter survives'],
  ['limit', '/users/1e5', '/users/1e5', 'exponent notation survives'],
  ['limit', '/users/%31%32%33', '/users/%31%32%33', 'percent-encoded number survives'],
  ['limit', '/users/123%20', '/users/123%20', 'number with a percent-encoded space survives'],
  ['limit', '/users/\u0661\u0662\u0663', '/users/\u0661\u0662\u0663', 'non-ASCII digits survive'],
  ['rewrite', `/orders/${UUID.replaceAll('-', '')}`, '/orders/{hash}', 'UUID without dashes'],
  ['limit', `/orders/{${UUID}}`, `/orders/{${UUID}}`, 'UUID in braces survives'],
  ['limit', `/orders/urn:uuid:${UUID}`, `/orders/urn:uuid:${UUID}`, 'UUID as a URN survives'],
  ['limit', `/orders/${UUID}.pdf`, `/orders/${UUID}.pdf`, 'UUID with an extension survives'],
  ['rewrite', `/tx/${MIXED_CASE_HASH}`, '/tx/{hash}', 'mixed-case hash'],
  ['rewrite', `/tx/0X${SHA256}`, '/tx/{hash}', 'hash with 0X'],
  ['rewrite', `/tx/${SHA256.slice(0, 56)}`, '/tx/{hash}', '56 hex digits'],
  ['rewrite', `/tx/${SHA256}${SHA256.slice(0, 32)}`, '/tx/{hash}', '96 hex digits'],
  ['rewrite', `/obj/${SHA256.slice(0, 24)}`, '/obj/{hash}', '24 hex digits'],
  ['limit', `/obj/${SHA256.slice(0, 16)}`, `/obj/${SHA256.slice(0, 16)}`, '16 hex digits survive'],
  [
    'rewrite',
    `/claimable_balances/00000000${SHA256}`,
    '/claimable_balances/{hash}',
    'claimable balance ID, 72 hex digits',
  ],
  ['rewrite', '/effects/0000000012884905985-0000000001', '/effects/{paging_token}', 'paging token'],
  [
    'rewrite',
    `/accounts/${G}/offers/123`,
    '/accounts/{account}/offers/{id}',
    'G-address then numeric ID',
  ],
  ['rewrite', `/k/${S}/`, '/k/{redacted}', 'secret seed and trailing slash'],
  ['rewrite', `/k/${S.toLowerCase()}`, '/k/{redacted}', 'lower-case secret seed'],
  ['rewrite', `/k/${S.slice(0, 55)}`, '/k/{redacted}', 'secret seed one character short'],
  ['rewrite', `/k/seed=${S}`, '/k/{redacted}', 'secret seed after other text in the segment'],
  ['rewrite', `/k/${S}.txt`, '/k/{redacted}', 'secret seed with an extension'],
  ['rewrite', `/k?seed=${S}`, '/k', 'secret seed in the query string'],
  [
    'limit',
    `/k/${S.slice(0, 40)}`,
    `/k/${S.slice(0, 40)}`,
    'the first 40 characters of a secret seed survive',
  ],
  ['rewrite', `/x/${P}`, '/x/{strkey}', `signed-payload strkey, ${P.length} characters`],
  ['rewrite', `/assets/USDC:${G}`, '/assets/USDC:{account}', 'asset code and issuer'],
  ['rewrite', `/assets/USDC-${G}`, '/assets/USDC-{account}', 'asset code and issuer with a dash'],
  ['rewrite', `/accounts/${G}.json`, '/accounts/{account}.json', 'G-address with an extension'],
  [
    'rewrite',
    `/contracts/${C}:events`,
    '/contracts/{contract}:events',
    'C-address followed by other text',
  ],
  ['rewrite', `/accounts/id=${M}`, '/accounts/id={muxed_account}', 'M-address after other text'],
  [
    'limit',
    `/accounts/%47${G.slice(1)}`,
    `/accounts/%47${G.slice(1)}`,
    'G-address with a percent-encoded first letter survives',
  ],
  [
    'limit',
    `/accounts/${G}${G}`,
    '/accounts/{redacted}',
    'two G-addresses joined: redacted because they hold a seed-like run (the result depends on the letters)',
  ],
  [
    'rewrite',
    `/pay/${G}/${C}/${M}`,
    '/pay/{account}/{contract}/{muxed_account}',
    'three strkeys in a row',
  ],
  ['rewrite', `${G}`, '/{account}', 'a bare G-address'],
  ['rewrite', `/${G}`, '/{account}', 'G-address as the only segment'],
  ['keep', '/users/<id>', '/users/<id>', 'angle-bracket template'],
  ['keep', '/users/*', '/users/*', 'wildcard template'],
  ['rewrite', '/users/{id}/', '/users/{id}', 'template with a trailing slash'],
  ['rewrite', '', '/', 'empty route'],
  ['rewrite', '//', '/', 'two slashes'],
  ['rewrite', '?a=1', '/', 'query string only'],
  ['rewrite', '/a?token=secret', '/a', 'secret in the query string'],
  ['rewrite', '/a?q=x\ny=secretline', '/a', 'query string with a newline'],
  ['rewrite', '/a\n/users/123', '/a', 'newline in the path: everything after it is removed'],
  ['rewrite', '/a\u0000/users/123', '/a', 'NUL in the path'],
  ['rewrite', '/a b/123', '/a b/{id}', 'space in a segment'],
  ['rewrite', '/a/../123', '/a/../{id}', 'dot segments are not resolved'],
  [
    'rewrite',
    'http://api.example.org/users/123',
    '/users/{id}',
    'absolute URL: scheme and host removed',
  ],
  ['rewrite', 'https://api.example.org:8443', '/', 'absolute URL without a path'],
  ['rewrite', `/auth/${JWT}`, '/auth/{jwt}', 'JWT'],
  ['limit', '/phone/+5491155551234', '/phone/+5491155551234', 'phone number survives'],
  ['limit', '/ip/192.168.1.10', '/ip/192.168.1.10', 'IP address survives'],
  ['rewrite', `/${'a/'.repeat(3000)}123`, '/(too_long)', 'route of 6,004 characters'],
  ['rewrite', `/users/${'9'.repeat(5000)}`, '/(too_long)', 'numeric ID of 5,000 digits'],
  [
    'rewrite',
    manyIds,
    `/${Array.from({ length: 100 }, () => 'seg/{id}').join('/')}`,
    '100 numeric IDs in one route',
  ],
  [
    'rewrite',
    `/tx/${SHA256}/operations/${'1'.repeat(19)}`,
    '/tx/{hash}/operations/{id}',
    'hash then numeric ID',
  ],
  ['rewrite', '/files/a//b', '/files/a/b', 'doubled slash inside a path'],
  ['keep', '/GATEWAY/CONFIG', '/GATEWAY/CONFIG', 'capital words'],
  ['rewrite', '/api/v1/', '/api/v1', 'version and trailing slash'],
];

export const VECTORS = ROWS.map(([kind, raw, expected, why]) => ({ kind, raw, expected, why }));
