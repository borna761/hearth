import { describe, it, expect } from 'vitest';
import { computeRange } from './httpRange';

const TOTAL = 1000;

describe('computeRange', () => {
	it('returns a full 200 response with Accept-Ranges when there is no Range header', () => {
		const result = computeRange(null, TOTAL);
		expect(result).toMatchObject({ status: 200, start: 0, end: 999 });
		expect(result.headers['accept-ranges']).toBe('bytes');
		expect(result.headers['content-length']).toBe('1000');
		expect(result.headers['content-range']).toBeUndefined();
	});

	it('returns 206 for a mid-file range with the correct Content-Range/Content-Length', () => {
		const result = computeRange('bytes=100-199', TOTAL);
		expect(result).toMatchObject({ status: 206, start: 100, end: 199 });
		expect(result.headers['content-range']).toBe('bytes 100-199/1000');
		expect(result.headers['content-length']).toBe('100');
		expect(result.headers['accept-ranges']).toBe('bytes');
	});

	it('treats an open-ended range (bytes=500-) as through the end of the file', () => {
		const result = computeRange('bytes=500-', TOTAL);
		expect(result).toMatchObject({ status: 206, start: 500, end: 999 });
		expect(result.headers['content-range']).toBe('bytes 500-999/1000');
		expect(result.headers['content-length']).toBe('500');
	});

	it('treats a suffix range (bytes=-100) as the last N bytes', () => {
		const result = computeRange('bytes=-100', TOTAL);
		expect(result).toMatchObject({ status: 206, start: 900, end: 999 });
		expect(result.headers['content-length']).toBe('100');
	});

	it('returns 416 with Content-Range: bytes */total for a start beyond the file size', () => {
		const result = computeRange('bytes=5000-6000', TOTAL);
		expect(result.status).toBe(416);
		expect(result.headers['content-range']).toBe('bytes */1000');
	});

	it('returns 416 for a malformed Range header', () => {
		const result = computeRange('not-a-range', TOTAL);
		expect(result.status).toBe(416);
	});

	it('returns 416 when start is after end', () => {
		const result = computeRange('bytes=500-100', TOTAL);
		expect(result.status).toBe(416);
	});

	it('clamps an end beyond the file size down to the last byte', () => {
		const result = computeRange('bytes=900-9999', TOTAL);
		expect(result).toMatchObject({ status: 206, start: 900, end: 999 });
	});
});
