import { isIP } from 'node:net'

// Vercel sets this header itself, so a caller cannot choose the value.
const PLATFORM_ADDRESS_HEADER = 'x-vercel-forwarded-for'
const IPV4_MAPPED_PREFIX = '::ffff:'

function expandIpv6(address) {
  const [head, tail] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const rightWidth = right.length + (right.at(-1)?.includes('.') ? 1 : 0)
  const fill = tail === undefined ? 0 : 8 - left.length - rightWidth
  return [...left, ...Array(fill).fill('0'), ...right]
}

/** Zeroes the host part: the last octet of IPv4 (/24), the last 80 bits of IPv6 (/48). */
export function truncateAddress(address) {
  const bare = address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? address.slice(IPV4_MAPPED_PREFIX.length)
    : address.split('%')[0]
  if (isIP(bare) === 4) return bare.replace(/\d+$/, '0')
  if (isIP(bare) === 6) {
    const network = expandIpv6(bare).slice(0, 3)
    return `${network.map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::`
  }
  return null
}

/** Returns the truncated client address, or null when the platform did not supply a valid one. */
export function truncatedClientAddress(headers) {
  const first = headers.get(PLATFORM_ADDRESS_HEADER)?.split(',')[0].trim()
  return first ? truncateAddress(first) : null
}
