// One text form per IP address, so that the per-visitor value does not depend on how a
// proxy or a socket happened to write the address.
import { isIPv4, isIPv6 } from 'node:net';

const MAPPED_IPV4 = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;
const BRACKETED = /^\[([^\]]*)\](?::\d{1,5})?$/;
const IPV4_WITH_PORT = /^([\d.]+):\d{1,5}$/;

/** `[address]`, `[address]:port` and `a.b.c.d:port` without the brackets and the port. */
function withoutBracketsAndPort(text) {
  const match = BRACKETED.exec(text) ?? IPV4_WITH_PORT.exec(text);
  return match ? match[1] : text;
}

/**
 * Returns the canonical text of an IP address.
 *
 * IPv6 becomes the lower-case compressed form of RFC 5952. Brackets, a port after brackets
 * or after an IPv4 address, and a zone ("%eth0") are dropped. An IPv4-mapped IPv6 address
 * becomes the dotted IPv4 address it stands for, which is what a dual-stack socket and an
 * IPv4 socket report for the same client.
 *
 * Throws when the text is not an IP address. An IPv4 address with a leading zero in a part
 * is refused, because "010" is 8 to some parsers and 10 to others, and either reading could
 * merge two visitors. The message never contains the text.
 */
export function canonicalAddress(text) {
  const [address] = withoutBracketsAndPort(String(text).trim()).split('%');
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) throw new Error('the client address is not an IP address');
  // The URL parser serialises an IPv6 host in the RFC 5952 form, embedded IPv4 included.
  const { hostname } = new URL(`http://[${address}]`);
  const mapped = MAPPED_IPV4.exec(hostname);
  if (!mapped) return hostname.slice(1, -1);
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
