import { describe, it, expect } from 'vitest';
import { diffPhotos } from './photo-diff.mjs';

describe('diffPhotos', () => {
	it('flags a file with no existing row as needing processing', () => {
		const walked = [{ path: '/pictures/a.jpg', mtime: 100, size: 500 }];
		const { toProcess } = diffPhotos(walked, []);
		expect(toProcess).toEqual(['/pictures/a.jpg']);
	});

	it('skips a file whose mtime and size both match the existing row', () => {
		const walked = [{ path: '/pictures/a.jpg', mtime: 100, size: 500 }];
		const existing = [{ sourcePath: '/pictures/a.jpg', mtime: 100, size: 500 }];
		const { toProcess } = diffPhotos(walked, existing);
		expect(toProcess).toEqual([]);
	});

	it('reprocesses a file whose mtime changed', () => {
		const walked = [{ path: '/pictures/a.jpg', mtime: 200, size: 500 }];
		const existing = [{ sourcePath: '/pictures/a.jpg', mtime: 100, size: 500 }];
		const { toProcess } = diffPhotos(walked, existing);
		expect(toProcess).toEqual(['/pictures/a.jpg']);
	});

	it('reprocesses a file whose size changed, even if mtime did not', () => {
		// A real case: an edited file with its mtime preserved by some sync tools.
		const walked = [{ path: '/pictures/a.jpg', mtime: 100, size: 999 }];
		const existing = [{ sourcePath: '/pictures/a.jpg', mtime: 100, size: 500 }];
		const { toProcess } = diffPhotos(walked, existing);
		expect(toProcess).toEqual(['/pictures/a.jpg']);
	});

	it('flags a row with no matching file on disk for pruning', () => {
		const existing = [{ sourcePath: '/pictures/deleted.jpg', mtime: 100, size: 500 }];
		const { toPrune } = diffPhotos([], existing);
		expect(toPrune).toEqual(['/pictures/deleted.jpg']);
	});

	it('neither processes nor prunes a row that matches exactly', () => {
		const walked = [{ path: '/pictures/a.jpg', mtime: 100, size: 500 }];
		const existing = [{ sourcePath: '/pictures/a.jpg', mtime: 100, size: 500 }];
		const result = diffPhotos(walked, existing);
		expect(result).toEqual({ toProcess: [], toPrune: [] });
	});

	it('returns empty results for empty input', () => {
		expect(diffPhotos([], [])).toEqual({ toProcess: [], toPrune: [] });
	});

	it('handles a mix of new, unchanged, changed, and removed files together', () => {
		const walked = [
			{ path: '/pictures/new.jpg', mtime: 1, size: 1 },
			{ path: '/pictures/unchanged.jpg', mtime: 2, size: 2 },
			{ path: '/pictures/changed.jpg', mtime: 30, size: 3 }
		];
		const existing = [
			{ sourcePath: '/pictures/unchanged.jpg', mtime: 2, size: 2 },
			{ sourcePath: '/pictures/changed.jpg', mtime: 3, size: 3 },
			{ sourcePath: '/pictures/removed.jpg', mtime: 4, size: 4 }
		];
		expect(diffPhotos(walked, existing)).toEqual({
			toProcess: ['/pictures/new.jpg', '/pictures/changed.jpg'],
			toPrune: ['/pictures/removed.jpg']
		});
	});
});
