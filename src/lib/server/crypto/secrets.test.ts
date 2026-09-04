import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

const originalKey = process.env.SECRETS_KEY;

beforeEach(() => {
	process.env.SECRETS_KEY = randomBytes(32).toString('hex');
});

afterEach(() => {
	process.env.SECRETS_KEY = originalKey;
});

describe('encryptSecret / decryptSecret', () => {
	it('round-trips a plaintext string', async () => {
		const { encryptSecret, decryptSecret } = await import('./secrets');
		const blob = encryptSecret('refresh-token-abc123');
		expect(decryptSecret(blob)).toBe('refresh-token-abc123');
	});

	it('round-trips an empty string', async () => {
		const { encryptSecret, decryptSecret } = await import('./secrets');
		expect(decryptSecret(encryptSecret(''))).toBe('');
	});

	it('produces a different ciphertext each time for the same plaintext', async () => {
		const { encryptSecret } = await import('./secrets');
		const a = encryptSecret('same-plaintext');
		const b = encryptSecret('same-plaintext');
		expect(a.equals(b)).toBe(false);
	});

	it('returns a Buffer suitable for the connections.secrets blob column', async () => {
		const { encryptSecret } = await import('./secrets');
		expect(Buffer.isBuffer(encryptSecret('x'))).toBe(true);
	});

	it('throws on decrypt if the ciphertext has been tampered with', async () => {
		const { encryptSecret, decryptSecret } = await import('./secrets');
		const blob = encryptSecret('refresh-token-abc123');
		blob[blob.length - 1] ^= 0xff; // flip a bit inside the auth-tagged region
		expect(() => decryptSecret(blob)).toThrow();
	});

	it('throws on decrypt if the blob is truncated', async () => {
		const { encryptSecret, decryptSecret } = await import('./secrets');
		const blob = encryptSecret('refresh-token-abc123');
		expect(() => decryptSecret(blob.subarray(0, 10))).toThrow();
	});

	it('fails closed when SECRETS_KEY is missing', async () => {
		delete process.env.SECRETS_KEY;
		const { encryptSecret } = await import('./secrets');
		expect(() => encryptSecret('x')).toThrow(/SECRETS_KEY/);
	});

	it('fails closed when SECRETS_KEY is not 32 bytes of hex', async () => {
		process.env.SECRETS_KEY = 'too-short';
		const { encryptSecret } = await import('./secrets');
		expect(() => encryptSecret('x')).toThrow(/SECRETS_KEY/);
	});
});
