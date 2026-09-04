import { describe, it, expect } from 'vitest';
import { nextGuestPhotoUrl } from './guestPhotos';

describe('nextGuestPhotoUrl', () => {
	it('builds a Picsum URL at the panel’s physical resolution (DESIGN.md §6)', () => {
		const url = nextGuestPhotoUrl(() => 0.5);
		expect(url).toMatch(/^https:\/\/picsum\.photos\/seed\/[a-z0-9]+\/1280\/800$/);
	});

	it('is deterministic for a given random source, so the same slide stays stable', () => {
		const first = nextGuestPhotoUrl(() => 0.123456);
		const second = nextGuestPhotoUrl(() => 0.123456);
		expect(first).toBe(second);
	});

	it('picks a different seed for a different random source', () => {
		const first = nextGuestPhotoUrl(() => 0.1);
		const second = nextGuestPhotoUrl(() => 0.9);
		expect(first).not.toBe(second);
	});

	it('never includes an API key or attribution token — Picsum needs neither', () => {
		const url = nextGuestPhotoUrl(() => 0.42);
		expect(url).not.toContain('key');
		expect(url).not.toContain('client_id');
	});
});
