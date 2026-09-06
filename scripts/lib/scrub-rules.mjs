// Generic literal find/replace engine for scripts/scrub-for-public.mjs. Deliberately
// contains no actual personal data — the real substitutions (names, emails, coordinates,
// etc.) live in a gitignored rules file (see scrub-for-public.mjs's header) so this
// engine, unlike the data it runs, is safe to publish.

function escapeRegExp(literal) {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text
 * @param {Array<{ from: string, to: string, wordBoundary?: boolean }>} rules
 * @returns {string}
 */
export function applyScrubRules(text, rules) {
	let result = text;
	for (const { from, to, wordBoundary } of rules) {
		if (wordBoundary) {
			result = result.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'), to);
		} else {
			result = result.split(from).join(to);
		}
	}
	return result;
}
