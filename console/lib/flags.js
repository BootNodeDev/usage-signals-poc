// The rules that flag an event. A flagged event is stored like any other, with the codes of the
// rules it matched in Umami's tag field, and is counted apart from the rest.
import { isbot } from 'isbot';

/** Rule codes, in the order the consoles list them. */
export const RULES = ['bot', 'no-sec-fetch', 'many-agents'];

// Placeholder threshold, to be agreed with the program.
export const MAX_AGENTS_PER_ADDRESS = 10;

// Browsers send all three on the tracker's fetch(), to HTTPS and localhost addresses only.
const FETCH_METADATA_HEADERS = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];

// Joined with "+", because Umami splits an equality filter value on commas.
const SEPARATOR = '+';

/**
 * Returns the tag for an event: the codes of the rules it matched, or undefined when none did.
 * `agentsToday` is how many distinct User-Agents its truncated address has shown today.
 * @example
 *   flagTag(new Headers(), 'curl/8.7.1', 1) // 'bot+no-sec-fetch'
 */
export function flagTag(headers, userAgent, agentsToday) {
  const matched = [
    isbot(userAgent) && 'bot',
    FETCH_METADATA_HEADERS.some((name) => !headers.has(name)) && 'no-sec-fetch',
    agentsToday > MAX_AGENTS_PER_ADDRESS && 'many-agents',
  ].filter(Boolean);
  return matched.length > 0 ? matched.join(SEPARATOR) : undefined;
}

/**
 * Splits a stored tag back into rule codes.
 * @example
 *   rulesOf('bot+no-sec-fetch') // ['bot', 'no-sec-fetch']
 */
export function rulesOf(tag) {
  return tag.split(SEPARATOR);
}
