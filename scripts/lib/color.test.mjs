import { describe, it, expect } from 'vitest';
import { normalizeHexColor } from './color.mjs';

describe('normalizeHexColor', () => {
	it('adds a leading # when missing', () => {
		expect(normalizeHexColor('5484ED')).toBe('#5484ED');
	});

	it('leaves an already-prefixed color as-is', () => {
		expect(normalizeHexColor('#5484ED')).toBe('#5484ED');
	});

	it('accepts lowercase hex digits', () => {
		expect(normalizeHexColor('5484ed')).toBe('#5484ed');
	});

	it('rejects the wrong number of digits', () => {
		expect(normalizeHexColor('#548')).toBeNull();
		expect(normalizeHexColor('5484EDD')).toBeNull();
	});

	it('rejects non-hex characters', () => {
		expect(normalizeHexColor('54G4ED')).toBeNull();
	});

	it('rejects empty input', () => {
		expect(normalizeHexColor('')).toBeNull();
	});
});
