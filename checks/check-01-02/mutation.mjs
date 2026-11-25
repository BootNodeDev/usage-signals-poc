// Negative controls. `node round2.mjs --mutate=<name>` breaks one thing on purpose; the run
// must then end with the fact named here as BROKEN and exit 1. `node controls.mjs` runs all.
export const MUTATIONS = {
  'forwarder-no-token': 'A: forwarded visits are the same visits as direct ingestion',
  'forwarder-ignores-30-minutes': 'A: forwarded visits are the same visits as direct ingestion',
  'forwarder-forgets-on-restart': 'A: forwarded visits are the same visits as direct ingestion',
  'probe-trusts-response': 'B: the probe catches a forwarder User-Agent that Umami drops',
  'probe-ignores-country': 'B: the probe catches a private placeholder address',
  'forwarder-resends-whole-batch': 'C: resending only the failed items stores every event once',
  'reconcile-reads-ledger': 'C: the reconciliation count finds the duplicated batch',
  'read-back-skipped': 'C: reading back before resending avoids the duplicate',
  'repair-skips-delete': 'C: deleting the affected sessions and replaying them removes the duplicate',
  'gateway-spools-prefix': 'D: no address or prefix is in the spool',
  'gateway-logs-address': 'D: no address or prefix is in the gateway log',
  'forwarder-sends-ip': 'D: no address or prefix leaves the forwarder',
  'file-scan-misses-new-files': 'D: the scanner finds a planted string in every place it searches',
  'scanner-blind': 'D: the scanner finds a planted string in every place it searches',
};

const requested = process.argv.find((argument) => argument.startsWith('--mutate='))?.slice(9);
if (requested && !(requested in MUTATIONS)) {
  throw new Error(`Unknown mutation "${requested}". Known: ${Object.keys(MUTATIONS).join(', ')}.`);
}

export const MUTATION = requested;
export const mutated = (name) => requested === name;
