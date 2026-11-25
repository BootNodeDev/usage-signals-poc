// A minimal model of the gateway's web path, enough to have a spool to inspect: it sees the
// visitor's address and User-Agent in memory, and writes to disk only the record the design
// stores. It is not the product gateway; enrollment, tokens and the bot list are left out.
import { createHmac } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { mutated } from './mutation.mjs';

const SALT_SECRET = 'check-01-r2-daily-salt';

// One salt per UTC day, as in the design: the same visitor has another value the next day.
function dailySalt(timestamp) {
  const day = new Date(timestamp * 1000).toISOString().slice(0, 10);
  return createHmac('sha256', SALT_SECRET).update(day).digest('hex');
}

// Stands in for the gateway's country database, keyed by truncated address as in the design.
const COUNTRY_BY_PREFIX = {
  '151.101.65.0': 'US',
  '200.45.191.0': 'AR',
  '194.25.134.0': 'DE',
  '2a00:1450:4001::': 'DE',
  '139.130.4.0': 'AU',
  '200.160.2.0': 'BR',
  '133.242.187.0': 'JP',
  '163.172.141.0': 'FR',
};
const HOSTING_PREFIXES = new Set(['151.101.65.0']);

// IPv4 to /24, IPv6 to /48. Expects the first three IPv6 groups written out.
export function truncateAddress(address) {
  if (address.includes(':')) return `${address.split(':').slice(0, 3).join(':')}::`;
  return `${address.split('.').slice(0, 3).join('.')}.0`;
}

// Reduces a User-Agent to the labels Umami itself would store. Covers the browsers of this
// experiment only; the contract probe compares it with Umami's own detection.
export function reduceUserAgent(userAgent) {
  const has = (text) => userAgent.includes(text);
  const apple = has('iPhone') || has('iPad');
  let browser = 'safari';
  if (has('Edg/')) browser = 'edge-chromium';
  else if (has('Firefox/')) browser = 'firefox';
  else if (apple) browser = 'ios';
  else if (has('Chrome/')) browser = 'chrome';
  let os = 'Linux';
  if (has('Windows NT 10.0')) os = 'Windows 10';
  else if (apple) os = 'iOS';
  else if (has('Android')) os = 'Android OS';
  else if (has('Mac OS X')) os = 'Mac OS';
  let device = 'desktop';
  if (has('iPad')) device = 'tablet';
  else if (has('Mobile')) device = 'mobile';
  return { browser, os, device };
}

function visitorValue(request) {
  const input = `${request.address}|${request.userAgent}|${request.site}`;
  const salt = dailySalt(request.receivedAt);
  return createHmac('sha256', salt).update(input).digest('hex').slice(0, 32);
}

// `request.pageElapsed` is the one thing the tracker adds for visit continuity: the seconds
// since the first event of the same page load, kept in a variable of the page.
function buildRecord(request, reduce) {
  const prefix = truncateAddress(request.address);
  const record = {
    site: request.site,
    timestamp: request.receivedAt,
    url: request.url,
    referrer: request.referrer,
    country: COUNTRY_BY_PREFIX[prefix],
    ...reduce(request.userAgent),
    quality: HOSTING_PREFIXES.has(prefix) ? 'hosting' : 'ok',
    visitor: visitorValue(request),
    pageStart: request.receivedAt - request.pageElapsed,
  };
  if (mutated('gateway-spools-prefix')) record.prefix = prefix;
  return record;
}

export function createGateway({ spoolDir, logFile, reduce = reduceUserAgent }) {
  mkdirSync(spoolDir, { recursive: true });
  const segment = openSync(path.join(spoolDir, 'segment-000001.jsonl'), 'a');
  return {
    accept(request) {
      const record = buildRecord(request, reduce);
      writeSync(segment, `${JSON.stringify(record)}\n`);
      fsyncSync(segment);
      const who = mutated('gateway-logs-address') ? ` from ${request.address}` : '';
      appendFileSync(logFile, `202 site=${record.site} country=${record.country}${who}\n`);
    },
    close() {
      closeSync(segment);
    },
  };
}
