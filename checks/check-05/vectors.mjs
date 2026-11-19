// Path-rule test vectors for check 05. Written for this experiment: the 91-vector reference set
// the architecture document mentions was not available. `expected` is what the stored route
// must be; it is stated here by hand and never computed from the rules.
// kind: "rewrite" an identifier must be replaced, "keep" the path must stay as it is,
// "limit" a case the rules get wrong or cannot express, with the behaviour they have today.
import { strkey } from './lib.mjs';

const G = strkey('G', 1);
const G2 = strkey('G', 2);
const C = strkey('C', 3);
const M = strkey('M', 4);
const S = strkey('S', 5);
const UUID = '3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b';
const SHA256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const SHA512 = SHA256 + SHA256;

// Look-alikes built from a real account address.
const notBase32 = `${G.slice(0, 20)}1${G.slice(21)}`; // "1" is not in the base-32 alphabet
const badSecondChar = `GZ${G.slice(2)}`; // an account's second character is A to D
const unknownType = `Q${G.slice(1)}`; // 56 capital letters, but no strkey starts with Q
const badChecksum = `${G.slice(0, 55)}${G.endsWith('A') ? 'B' : 'A'}`;

export const VECTORS = [
  // Numeric IDs.
  { kind: 'rewrite', raw: '/users/123', expected: '/users/{id}', why: 'numeric ID' },
  {
    kind: 'rewrite',
    raw: '/users/123/orders/456',
    expected: '/users/{id}/orders/{id}',
    why: 'two numeric IDs',
  },
  {
    kind: 'rewrite',
    raw: '/1/2/3/4',
    expected: '/{id}/{id}/{id}/{id}',
    why: 'adjacent numeric segments',
  },
  { kind: 'rewrite', raw: '/ledgers/0', expected: '/ledgers/{id}', why: 'zero' },
  {
    kind: 'rewrite',
    raw: '/ledgers/00051234567890123456',
    expected: '/ledgers/{id}',
    why: 'long number',
  },
  { kind: 'rewrite', raw: '/42', expected: '/{id}', why: 'number as the only segment' },
  { kind: 'keep', raw: '/v2/users', expected: '/v2/users', why: 'version segment' },
  { kind: 'keep', raw: '/api/v1/items', expected: '/api/v1/items', why: 'version segment' },
  { kind: 'keep', raw: '/oauth2/token', expected: '/oauth2/token', why: 'digits inside a word' },
  {
    kind: 'keep',
    raw: '/reports/2026-11-19',
    expected: '/reports/2026-11-19',
    why: 'a date is not a numeric ID',
  },
  { kind: 'keep', raw: '/items/12a', expected: '/items/12a', why: 'digits followed by a letter' },
  // UUIDs.
  { kind: 'rewrite', raw: `/orders/${UUID}`, expected: '/orders/{uuid}', why: 'UUID' },
  {
    kind: 'rewrite',
    raw: `/orders/${UUID.toUpperCase()}/items`,
    expected: '/orders/{uuid}/items',
    why: 'upper-case UUID',
  },
  {
    kind: 'rewrite',
    raw: `/a/${UUID}/${UUID}`,
    expected: '/a/{uuid}/{uuid}',
    why: 'adjacent UUIDs',
  },
  {
    kind: 'keep',
    raw: `/orders/${UUID.slice(0, 35)}`,
    expected: `/orders/${UUID.slice(0, 35)}`,
    why: 'UUID one character short',
  },
  {
    kind: 'keep',
    raw: `/orders/${UUID.replace('3f2b', 'zzzz')}`,
    expected: `/orders/${UUID.replace('3f2b', 'zzzz')}`,
    why: 'UUID shape with non-hex letters',
  },
  // Hex and crypto hashes.
  {
    kind: 'rewrite',
    raw: `/tx/${SHA256}`,
    expected: '/tx/{hash}',
    why: 'transaction hash, 64 hex digits',
  },
  {
    kind: 'rewrite',
    raw: `/tx/${SHA256.toUpperCase()}/effects`,
    expected: '/tx/{hash}/effects',
    why: 'upper-case hash',
  },
  { kind: 'rewrite', raw: `/tx/0x${SHA256}`, expected: '/tx/{hash}', why: 'hash with 0x' },
  { kind: 'rewrite', raw: `/blobs/${SHA1}`, expected: '/blobs/{hash}', why: '40 hex digits' },
  { kind: 'rewrite', raw: `/blobs/${MD5}`, expected: '/blobs/{hash}', why: '32 hex digits' },
  { kind: 'rewrite', raw: `/blobs/${SHA512}`, expected: '/blobs/{hash}', why: '128 hex digits' },
  { kind: 'keep', raw: '/assets/cafe', expected: '/assets/cafe', why: 'short hex word' },
  { kind: 'keep', raw: '/assets/deadbeef', expected: '/assets/deadbeef', why: 'short hex word' },
  {
    kind: 'keep',
    raw: '/assets/facade',
    expected: '/assets/facade',
    why: 'English word made of hex letters',
  },
  {
    kind: 'keep',
    raw: `/blobs/${SHA256.slice(0, 63)}`,
    expected: `/blobs/${SHA256.slice(0, 63)}`,
    why: '63 hex digits is no known hash length',
  },
  {
    kind: 'keep',
    raw: `/blobs/${SHA256.slice(0, 63)}g`,
    expected: `/blobs/${SHA256.slice(0, 63)}g`,
    why: '64 characters, one not hex',
  },
  // Stellar addresses.
  { kind: 'rewrite', raw: `/accounts/${G}`, expected: '/accounts/{account}', why: 'G-address' },
  {
    kind: 'rewrite',
    raw: `/accounts/${G}/payments`,
    expected: '/accounts/{account}/payments',
    why: 'G-address inside a path',
  },
  {
    kind: 'rewrite',
    raw: `/paths/${G}/${G2}`,
    expected: '/paths/{account}/{account}',
    why: 'adjacent G-addresses',
  },
  {
    kind: 'rewrite',
    raw: `/accounts/GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ`,
    expected: '/accounts/{account}',
    why: 'the G-address of SEP-23 test vector 1',
  },
  { kind: 'rewrite', raw: `/contracts/${C}`, expected: '/contracts/{contract}', why: 'C-address' },
  {
    kind: 'rewrite',
    raw: `/contracts/${C}/events/7`,
    expected: '/contracts/{contract}/events/{id}',
    why: 'C-address then numeric ID',
  },
  {
    kind: 'rewrite',
    raw: `/accounts/${M}`,
    expected: '/accounts/{muxed_account}',
    why: 'M-address, 69 characters',
  },
  {
    kind: 'rewrite',
    raw: `/accounts/MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ`,
    expected: '/accounts/{muxed_account}',
    why: 'the M-address of SEP-23 test vector 2',
  },
  { kind: 'rewrite', raw: `/keys/${S}`, expected: '/keys/{redacted}', why: 'secret seed' },
  {
    kind: 'rewrite',
    raw: `/x/${strkey('T', 6)}`,
    expected: '/x/{strkey}',
    why: 'pre-authorized transaction strkey',
  },
  { kind: 'rewrite', raw: `/x/${strkey('X', 7)}`, expected: '/x/{strkey}', why: 'hash-x strkey' },
  {
    kind: 'rewrite',
    raw: `/pools/${strkey('L', 8)}`,
    expected: '/pools/{strkey}',
    why: 'liquidity pool strkey',
  },
  {
    kind: 'rewrite',
    raw: `/balances/${strkey('B', 9)}`,
    expected: '/balances/{strkey}',
    why: 'claimable balance strkey, 58 characters',
  },
  {
    kind: 'rewrite',
    raw: `/x/${strkey('W', 10)}`,
    expected: '/x/{strkey}',
    why: 'muxed contract strkey, 69 characters',
  },
  {
    kind: 'keep',
    raw: `/accounts/${unknownType}`,
    expected: `/accounts/${unknownType}`,
    why: '56 capital letters and digits starting with Q: no such strkey type',
  },
  {
    kind: 'keep',
    raw: `/accounts/${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(3).slice(0, 56)}`,
    expected: `/accounts/${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(3).slice(0, 56)}`,
    why: 'a word of 56 capital letters',
  },
  {
    kind: 'keep',
    raw: `/accounts/${notBase32}`,
    expected: `/accounts/${notBase32}`,
    why: 'G-shape with a character outside the base-32 alphabet',
  },
  {
    kind: 'keep',
    raw: `/accounts/${badSecondChar}`,
    expected: `/accounts/${badSecondChar}`,
    why: 'G-shape with an impossible second character',
  },
  {
    kind: 'keep',
    raw: `/accounts/${G.slice(0, 55)}`,
    expected: `/accounts/${G.slice(0, 55)}`,
    why: 'G-address one character short',
  },
  {
    kind: 'keep',
    raw: `/accounts/${G}A`,
    expected: `/accounts/${G}A`,
    why: 'G-address one character long',
  },
  {
    kind: 'keep',
    raw: `/accounts/${G.toLowerCase()}`,
    expected: `/accounts/${G.toLowerCase()}`,
    why: 'lower-case G-shape: strkeys are upper case',
  },
  {
    kind: 'keep',
    raw: `/accounts/${M.slice(0, 68)}`,
    expected: `/accounts/${M.slice(0, 68)}`,
    why: 'M-address one character short',
  },
  {
    kind: 'keep',
    raw: '/GET/CONFIG',
    expected: '/GET/CONFIG',
    why: 'short capital words starting with G and C',
  },
  // Trailing slashes, query strings and the root.
  { kind: 'rewrite', raw: '/users/', expected: '/users', why: 'trailing slash' },
  {
    kind: 'rewrite',
    raw: '/users/123/',
    expected: '/users/{id}',
    why: 'numeric ID and trailing slash',
  },
  {
    kind: 'rewrite',
    raw: `/accounts/${G}/`,
    expected: '/accounts/{account}',
    why: 'G-address and trailing slash',
  },
  { kind: 'rewrite', raw: '/users///', expected: '/users', why: 'several trailing slashes' },
  {
    kind: 'rewrite',
    raw: '/users//123',
    expected: '/users/{id}',
    why: 'doubled slash inside a path',
  },
  { kind: 'keep', raw: '/', expected: '/', why: 'the root stays' },
  {
    kind: 'rewrite',
    raw: '/users/123?cursor=456&limit=10',
    expected: '/users/{id}',
    why: 'query string removed',
  },
  {
    kind: 'rewrite',
    raw: `/accounts/${G}?cursor=now`,
    expected: '/accounts/{account}',
    why: 'query string after an address',
  },
  {
    kind: 'rewrite',
    raw: '/search?q=/users/123',
    expected: '/search',
    why: 'query string holding a path',
  },
  { kind: 'rewrite', raw: '/docs/page#section-2', expected: '/docs/page', why: 'fragment removed' },
  // Routes that are already templates.
  { kind: 'keep', raw: '/users/{id}', expected: '/users/{id}', why: 'route template' },
  {
    kind: 'keep',
    raw: '/users/:id/orders/:orderId',
    expected: '/users/:id/orders/:orderId',
    why: 'colon-style template',
  },
  {
    kind: 'keep',
    raw: '/rpc/getTransaction',
    expected: '/rpc/getTransaction',
    why: 'JSON-RPC method as route',
  },
  { kind: 'keep', raw: 'users/list', expected: 'users/list', why: 'no leading slash' },
  {
    kind: 'rewrite',
    raw: 'users/123',
    expected: 'users/{id}',
    why: 'no leading slash, numeric ID',
  },
  // What the rules get wrong or cannot express.
  {
    kind: 'limit',
    raw: `/accounts/${badChecksum}`,
    expected: '/accounts/{account}',
    why: 'wrong checksum is still rewritten: a regular expression cannot compute CRC-16',
  },
  {
    kind: 'limit',
    raw: '/users/123.json',
    expected: '/users/123.json',
    why: 'identifier with a file extension is not rewritten',
  },
  {
    kind: 'limit',
    raw: `/accounts/${G}:payments`,
    expected: `/accounts/${G}:payments`,
    why: 'address that is only part of a segment is not rewritten and stays raw',
  },
  {
    kind: 'limit',
    raw: '/users/alice@example.org',
    expected: '/users/alice@example.org',
    why: 'e-mail addresses have no rule here',
  },
  {
    kind: 'limit',
    raw: '/users/jane-doe',
    expected: '/users/jane-doe',
    why: 'free-text identifiers need the token heuristic, which is not a regular expression',
  },
  {
    kind: 'limit',
    raw: `/blobs/${'1'.repeat(64)}`,
    expected: '/blobs/{id}',
    why: 'a hash made only of digits is reported as a numeric ID',
  },
];
