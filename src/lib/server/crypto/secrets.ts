import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
	const hex = process.env.SECRETS_KEY;
	if (!hex) {
		throw new Error('SECRETS_KEY is not set (need 64 hex chars / 32 bytes)');
	}
	const key = Buffer.from(hex, 'hex');
	if (key.length !== 32) {
		throw new Error('SECRETS_KEY must be 32 bytes of hex (64 hex characters)');
	}
	return key;
}

/**
 * Encrypts a secret (an OAuth token, an AnyList password, ...) for storage in
 * connections.secrets. Layout: iv (12 bytes) | authTag (16 bytes) | ciphertext.
 */
export function encryptSecret(plaintext: string): Buffer {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, getKey(), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(blob: Buffer): string {
	if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
		throw new Error('secrets blob is truncated');
	}
	const iv = blob.subarray(0, IV_LENGTH);
	const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
	const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

	const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
