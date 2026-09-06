import { describe, it, expect } from 'vitest';
import { applyScrubRules } from './scrub-rules.mjs';

describe('applyScrubRules', () => {
	it('replaces a literal substring', () => {
		expect(applyScrubRules('hello world', [{ from: 'world', to: 'there' }])).toBe('hello there');
	});

	it('replaces every occurrence, not just the first', () => {
		expect(applyScrubRules('a a a', [{ from: 'a', to: 'b' }])).toBe('b b b');
	});

	it("applies rules in order, each seeing the previous rule's output", () => {
		const rules = [
			{ from: 'foo', to: 'bar' },
			{ from: 'bar', to: 'baz' }
		];
		expect(applyScrubRules('foo', rules)).toBe('baz');
	});

	it('wordBoundary rules only replace whole-word matches, not substrings inside a longer word', () => {
		const rules = [{ from: 'sam', to: 'alex', wordBoundary: true }];
		expect(applyScrubRules('sam and samwise', rules)).toBe('alex and samwise');
	});

	it('non-wordBoundary rules replace inside longer words too', () => {
		const rules = [{ from: 'sam', to: 'alex' }];
		expect(applyScrubRules('samwise', rules)).toBe('alexwise');
	});

	it('a wordBoundary rule with regex-special characters in "from" is treated literally', () => {
		const rules = [{ from: '45.5', to: '45.5', wordBoundary: true }];
		// Without escaping, "." would match any character, e.g. "4514698" would wrongly match.
		expect(applyScrubRules('4514698 and 45.5', rules)).toBe('4514698 and 45.5');
	});

	it('leaves text untouched when no rule matches', () => {
		expect(applyScrubRules('nothing to see here', [{ from: 'xyz', to: 'abc' }])).toBe(
			'nothing to see here'
		);
	});

	it('returns the original text unchanged for an empty rule list', () => {
		expect(applyScrubRules('hello', [])).toBe('hello');
	});
});
