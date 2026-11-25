// A minimal forwarder: reads spool records, posts them to Umami's batch route, one batch per
// country, carries Umami's visit token where direct ingestion would, resends only what Umami
// reports as failed, and keeps the count that the reconciliation compares with Umami's.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mutated } from './mutation.mjs';

export const FORWARDER_DEFAULTS = {
  // A plain product token, or "(compatible; Name/1.0)", is classed as a bot by Umami.
  userAgent: 'Mozilla/5.0 UsageSignalsForwarder/1.0',
  // TEST-NET-1, RFC 5737: valid, not private, never a real visitor.
  placeholder: '192.0.2.1',
  // What to do when no usable answer came back: 'resend' or 'readBack'.
  onLostResponse: 'resend',
};

const HOUR = 3600;
// Umami starts a new visit when an event arrives more than this long after the visit began.
const VISIT_LIFETIME = 1800;
const BATCH_LIMIT = 500;
const MAX_ATTEMPTS = 3;

export function readSpool(spoolDir) {
  const records = [];
  for (const name of readdirSync(spoolDir).sort()) {
    const lines = readFileSync(path.join(spoolDir, name), 'utf8').split('\n').filter(Boolean);
    records.push(...lines.map((line) => JSON.parse(line)));
  }
  return records;
}

export const dayOf = (record) => new Date(record.timestamp * 1000).toISOString().slice(0, 10);
const ledgerKey = (record) => `${record.site}|${dayOf(record)}`;
const hourOf = (timestamp) => Math.floor(timestamp / HOUR);

// Posts JSON and appends every outgoing request to `wireLog`, so that it can be inspected.
export function httpTransport(wireLog) {
  return async (url, headers, body) => {
    const text = JSON.stringify(body);
    if (wireLog) appendFileSync(wireLog, `${url} ${JSON.stringify(headers)} ${text}\n`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: text,
    });
    return { status: response.status, body: await response.json() };
  };
}

function toItem(record, type = 'event') {
  const payload = {
    website: record.site,
    hostname: 'check.test',
    timestamp: record.timestamp,
    salt: record.visitor,
    browser: record.browser,
    os: record.os,
    device: record.device,
  };
  if (type === 'event') Object.assign(payload, { url: record.url, referrer: record.referrer });
  if (type === 'event') payload.tag = record.quality;
  if (mutated('forwarder-sends-ip')) payload.ip = '200.45.191.35';
  return { type, payload };
}

// Follows each page load the way Umami follows a tracker's token: a visit starts with the
// first event and ends 30 minutes after it started. Returns where the visit of `record` began.
function visitStart(record, pageLoads) {
  const key = `${record.site}|${record.visitor}|${record.pageStart}`;
  const known = pageLoads.get(key);
  const expired = !known || record.timestamp - known > VISIT_LIFETIME;
  if (expired && !(known && mutated('forwarder-ignores-30-minutes'))) {
    pageLoads.set(key, record.timestamp);
  }
  return { key, startedAt: pageLoads.get(key) };
}

// A page load whose visit began more than 30 minutes before the newest record cannot
// continue that visit, so nothing about it needs to be remembered.
function forgetEndedVisits(pageLoads, newest) {
  if (mutated('forwarder-ignores-30-minutes')) return;
  for (const [key, startedAt] of pageLoads) {
    if (newest - startedAt > VISIT_LIFETIME) pageLoads.delete(key);
  }
}

// One batch per country. An event in a later clock hour than the start of its visit needs
// Umami's token for that visit; the token is a request header, so it gets a batch of its own.
export function planBatches(records, pageLoads = new Map()) {
  const groups = new Map();
  const add = (key, batch, record) => {
    if (!groups.has(key)) groups.set(key, { ...batch, records: [] });
    groups.get(key).records.push(record);
  };
  const ordered = [...records].sort((a, b) => a.timestamp - b.timestamp);
  for (const record of ordered) {
    const { key, startedAt } = visitStart(record, pageLoads);
    const crossesTheHour = hourOf(record.timestamp) !== hourOf(startedAt);
    if (crossesTheHour && !mutated('forwarder-no-token')) {
      add(`${key}|${startedAt}`, { country: record.country, visitStartedAt: startedAt }, record);
    } else {
      add(record.country, { country: record.country }, record);
    }
  }
  if (ordered.length > 0) forgetEndedVisits(pageLoads, ordered.at(-1).timestamp);
  const batches = [];
  for (const group of groups.values()) {
    for (let from = 0; from < group.records.length; from += BATCH_LIMIT) {
      batches.push({ ...group, records: group.records.slice(from, from + BATCH_LIMIT) });
    }
  }
  return batches;
}

const decodeToken = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const visitorKey = (record) => `${record.site}|${record.visitor}`;

// What has to survive a restart: when each running visit began, and the acknowledged counts.
function loadState(stateFile) {
  if (!stateFile || !existsSync(stateFile) || mutated('forwarder-forgets-on-restart')) {
    return { pageLoads: new Map(), ledger: new Map() };
  }
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  return { pageLoads: new Map(saved.pageLoads), ledger: new Map(saved.ledger) };
}

export function createForwarder(options) {
  const config = { ...FORWARDER_DEFAULTS, plan: planBatches, ...options };
  const transport = config.transport ?? httpTransport(config.wireLog);
  const { pageLoads, ledger } = loadState(config.stateFile);
  // `peakPageLoads` is the most page loads remembered from one flush to the next.
  // `suspects` are the records of batches resent without knowing whether Umami had them.
  const report = {
    requests: 0,
    itemsSent: 0,
    tokenBatches: 0,
    deadLetters: [],
    peakPageLoads: 0,
    suspects: [],
  };
  const saveState = () => {
    if (!config.stateFile) return;
    const state = { pageLoads: [...pageLoads], ledger: [...ledger] };
    writeFileSync(config.stateFile, JSON.stringify(state));
  };

  const acknowledge = (records) => {
    for (const record of records) {
      ledger.set(ledgerKey(record), (ledger.get(ledgerKey(record)) ?? 0) + 1);
    }
  };

  async function send(items, headers) {
    report.requests += 1;
    try {
      return await transport(`${config.umamiUrl}/api/batch`, headers, items);
    } catch (error) {
      return { status: 0, body: { message: error.message } };
    }
  }

  // Asks Umami for the token of the visit of `record`'s visitor that began at `startedAt`.
  // An identify item without data stores no event; Umami answers with the token of that
  // session and clock hour, and creates the session row if it does not exist yet.
  async function visitToken(record, startedAt, headers) {
    const anchor = { ...record, timestamp: startedAt };
    const { status, body } = await send([toItem(anchor, 'identify')], headers);
    if (status !== 200 || !body.cache) {
      throw new Error(`Umami gave no visit token (HTTP ${status}); the batch stays in the spool.`);
    }
    return body.cache;
  }

  const headersFor = (country) => ({
    'x-forwarded-for': config.placeholder,
    'cf-ipcountry': country,
    'user-agent': config.userAgent,
  });

  // After a lost response: Umami works through a batch in order, so what it holds beyond the
  // ledger is the head of the batch. Only valid while nothing else writes that site and day.
  async function withoutStored(pending) {
    const surplus = new Map();
    const remaining = [];
    for (const record of pending) {
      const key = ledgerKey(record);
      if (!surplus.has(key)) {
        const held = mutated('read-back-skipped') ? 0 : await config.held(record.site, dayOf(record));
        surplus.set(key, Math.max(0, held - (ledger.get(key) ?? 0)));
      }
      if (surplus.get(key) > 0) {
        surplus.set(key, surplus.get(key) - 1);
        acknowledge([record]);
      } else {
        remaining.push(record);
      }
    }
    return remaining;
  }

  async function deliver(batch) {
    const headers = headersFor(batch.country);
    if (batch.visitStartedAt) {
      const token = await visitToken(batch.records[0], batch.visitStartedAt, headers);
      headers['x-umami-cache'] = token;
      report.tokenBatches += 1;
    }
    let pending = batch.records;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length > 0; attempt += 1) {
      report.itemsSent += pending.length;
      const { status, body } = await send(pending.map((record) => toItem(record)), headers);
      if (status >= 400 && status < 500) break;
      if (status !== 200) {
        if (config.onLostResponse === 'readBack') pending = await withoutStored(pending);
        else report.suspects.push(...pending);
        continue;
      }
      const failed = new Set(body.details.map((detail) => detail.index));
      acknowledge(pending.filter((_, index) => !failed.has(index)));
      if (failed.size === 0) return;
      await config.beforeRetry?.();
      if (!mutated('forwarder-resends-whole-batch')) {
        pending = pending.filter((_, index) => failed.has(index));
      }
    }
    report.deadLetters.push(...pending);
  }

  async function flush(records) {
    const batches = config.plan(records, pageLoads);
    report.peakPageLoads = Math.max(report.peakPageLoads, pageLoads.size);
    for (const batch of batches) await deliver(batch);
    saveState();
  }

  // Removes what a resent batch may have stored twice. Umami cannot delete one event, but it
  // can delete a session: every visitor of a suspect batch loses its session and is sent
  // again from the spool. `spooled` must still hold all records of those visitors.
  async function repair(spooled, deleteSession) {
    const affected = new Map(report.suspects.map((record) => [visitorKey(record), record]));
    for (const record of affected.values()) {
      const token = await visitToken(record, record.timestamp, headersFor(record.country));
      if (!mutated('repair-skips-delete')) {
        await deleteSession(record.site, decodeToken(token).sessionId);
      }
    }
    const replay = spooled.filter((record) => affected.has(visitorKey(record)));
    for (const record of replay) {
      ledger.set(ledgerKey(record), ledger.get(ledgerKey(record)) - 1);
      pageLoads.delete(`${record.site}|${record.visitor}|${record.pageStart}`);
    }
    report.suspects = [];
    await flush(replay);
    return { sessions: affected.size, replayed: replay.length };
  }

  return { ledger, report, flush, repair };
}

// Events per site and UTC day: written to the spool, acknowledged by Umami, held by Umami.
export async function reconcile(records, ledger, held) {
  const spooled = new Map();
  for (const record of records) {
    spooled.set(ledgerKey(record), (spooled.get(ledgerKey(record)) ?? 0) + 1);
  }
  const rows = [];
  for (const [key, count] of spooled) {
    const [site, day] = key.split('|');
    const inUmami = mutated('reconcile-reads-ledger') ? ledger.get(key) ?? 0 : await held(site, day);
    rows.push({ site, day, spooled: count, acknowledged: ledger.get(key) ?? 0, held: inUmami });
  }
  return rows;
}
