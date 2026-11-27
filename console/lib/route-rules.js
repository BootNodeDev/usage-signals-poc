// Route rules for API metrics: identifiers in a route become placeholders, so a route names an
// endpoint and never a user, an account or a secret. This is the path rule set of the check 5
// collector (`checks/check-05/collector.yaml`, `transform/path_rules`) in JavaScript, in the same
// order, and a test holds it to the same 165 vectors.
//
// Each rule matches one whole segment, written /<pattern>/. To let two neighbouring segments
// both match, every slash is doubled and the route wrapped in slashes first, so each segment
// sits between slashes of its own; the last two rules undo that.

const MAX_ROUTE_LENGTH = 1024;
const STRKEY = '[A-D][A-Z2-7]';

// [pattern, replacement], applied to every match in turn.
const RULES = [
  // Everything from the first "?", "#" or control character on, newlines included.
  [/[?#\u0000-\u001f\u007f][\s\S]*$/, ''],
  // The scheme and host of an absolute URL.
  [/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, ''],
  [/\//g, '//'],
  [/^([\s\S]*)$/, '/$1/'],
  // Numeric IDs, then Horizon paging tokens.
  [/\/[0-9]+\//g, '/{id}/'],
  [/\/[0-9]{10,}-[0-9]+\//g, '/{paging_token}/'],
  [/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\//g, '/{uuid}/'],
  // Hex runs of 24 digits or more, with or without 0x.
  [/\/(?:0[xX])?[0-9a-fA-F]{24,}\//g, '/{hash}/'],
  [/\/[^/@]+@[^/@]+[.][^/@]+\//g, '/{email}/'],
  [/\/eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]*\//g, '/{jwt}/'],
  // SEP-23 strkeys as whole segments, the secret seed first. The second character is A to D
  // because the low three bits of the version byte are zero.
  [new RegExp(`/S${STRKEY}{54}/`, 'g'), '/{redacted}/'],
  [new RegExp(`/G${STRKEY}{54}/`, 'g'), '/{account}/'],
  [new RegExp(`/C${STRKEY}{54}/`, 'g'), '/{contract}/'],
  [new RegExp(`/M${STRKEY}{67}/`, 'g'), '/{muxed_account}/'],
  [
    new RegExp(`/(?:[TXL]${STRKEY}{54}|B${STRKEY}{56}|W${STRKEY}{67}|P${STRKEY}{67,163})/`, 'g'),
    '/{strkey}/',
  ],
  // An account, contract or muxed address next to other text in its segment, as in USDC:G...
  // Only the address is replaced.
  [new RegExp(`/([^/]*[^A-Z2-7/])?G${STRKEY}{54}([^A-Z2-7/][^/]*)?/`, 'g'), '/$1{account}$2/'],
  [new RegExp(`/([^/]*[^A-Z2-7/])?C${STRKEY}{54}([^A-Z2-7/][^/]*)?/`, 'g'), '/$1{contract}$2/'],
  [
    new RegExp(`/([^/]*[^A-Z2-7/])?M${STRKEY}{67}([^A-Z2-7/][^/]*)?/`, 'g'),
    '/$1{muxed_account}$2/',
  ],
  // Anything that still looks like a secret seed, in either case, anywhere in a segment.
  [/\/[^/]*[sS][a-dA-D][a-zA-Z2-7]{50,}[^/]*\//g, '/{redacted}/'],
  // Two rules that know no identifier shape, last so they also bound what the rules above
  // wrote: after them every segment is at most 36 printable ASCII characters.
  [/\/[^/]*[^ -~][^/]*\//g, '/{non_ascii}/'],
  [/\/[^/]{37,}\//g, '/{long}/'],
  // Undo the doubling, then drop a trailing slash except on the root.
  [/\/{2,}/g, '/'],
  [/(.)\/$/, '$1'],
];

/** The route as stored: identifiers replaced, every segment bounded; `(unmatched)` if none. */
export function normalizeRoute(route) {
  if (route === undefined || route === null) return '(unmatched)';
  // As in the collector, an over-long route is replaced and still goes through the rules.
  let result = route.length > MAX_ROUTE_LENGTH ? '(too_long)' : route;
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement);
  return result;
}
