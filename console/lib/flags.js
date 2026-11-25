// The rules that flag an event; a flagged event is stored with their codes in Umami's tag field.
import { isbot } from 'isbot';

/** Rule codes, in the order the consoles list them. */
export const RULES = ['bot', 'no-sec-fetch', 'many-agents'];

/** More distinct User-Agents than this from one address in a UTC day flags its events. A placeholder. */
export const MAX_AGENTS_PER_ADDRESS = 10;

// Browsers send all three on the tracker's fetch(), to HTTPS and localhost addresses only.
const FETCH_METADATA_HEADERS = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];

// Joined with "+", because Umami splits an equality filter value on commas.
const SEPARATOR = '+';
const ANY_RULE = `(${RULES.join('|')})`;

/**
 * A regular expression, as text for Umami's tag filter, that matches a tag made only of rule
 * codes. Any other tag, such as the demo sites' `sample`, is not a flag.
 * @example
 *   FLAG_TAG_PATTERN // '^(bot|no-sec-fetch|many-agents)(\\+(bot|no-sec-fetch|many-agents))*$'
 */
export const FLAG_TAG_PATTERN = `^${ANY_RULE}(\\${SEPARATOR}${ANY_RULE})*$`;

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
