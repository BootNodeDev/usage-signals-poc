// A slug is the first path segment of a tenant console address (/<slug>/web). It uses only
// RFC 3986 unreserved characters, and of those only lower-case letters, digits and the hyphen,
// so it never needs percent-encoding and has one spelling.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 63

// First path segments the console already uses; a site with one of these could not be reached.
export const RESERVED_SLUGS = ['api', 'demo', 'operator', 'public', 's', 'tenant']

export function isSlug(value) {
  return typeof value === 'string' && value.length <= MAX_SLUG_LENGTH && SLUG.test(value)
}
