import { describe, it, expect } from 'vitest';
import { resolveStreamBaseUrl } from './musicStreamUrl';

describe('resolveStreamBaseUrl', () => {
	it('uses the request origin when no override is set', () => {
		expect(resolveStreamBaseUrl('http://hearth.local:8080', undefined)).toBe(
			'http://hearth.local:8080'
		);
	});

	it("prefers the override when set — for local dev, where the browser origin is a loopback address the Chromecast device can't reach", () => {
		expect(resolveStreamBaseUrl('http://localhost:5173', 'http://192.168.1.50:5173')).toBe(
			'http://192.168.1.50:5173'
		);
	});

	it('treats an empty-string override as unset', () => {
		expect(resolveStreamBaseUrl('http://localhost:5173', '')).toBe('http://localhost:5173');
	});
});
