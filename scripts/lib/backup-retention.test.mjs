import { describe, it, expect } from 'vitest';
import { selectBackupsToPrune } from './backup-retention.mjs';

function files(...mtimes) {
	return mtimes.map((mtimeMs, i) => ({ name: `hearth-${i}.db`, mtimeMs }));
}

describe('selectBackupsToPrune', () => {
	it('prunes nothing when there are fewer backups than the keep count', () => {
		expect(selectBackupsToPrune(files(1, 2, 3), 14)).toEqual([]);
	});

	it('prunes nothing when the count exactly matches keep', () => {
		expect(selectBackupsToPrune(files(1, 2), 2)).toEqual([]);
	});

	it('prunes the oldest files, keeping the newest `keep` by mtime', () => {
		const entries = [
			{ name: 'day1.db', mtimeMs: 1 },
			{ name: 'day2.db', mtimeMs: 2 },
			{ name: 'day3.db', mtimeMs: 3 }
		];
		expect(selectBackupsToPrune(entries, 2)).toEqual(['day1.db']);
	});

	it('does not mutate the input array', () => {
		const entries = [
			{ name: 'day1.db', mtimeMs: 2 },
			{ name: 'day2.db', mtimeMs: 1 }
		];
		const copy = [...entries];
		selectBackupsToPrune(entries, 1);
		expect(entries).toEqual(copy);
	});

	it('prunes everything when keep is 0', () => {
		expect(selectBackupsToPrune(files(1, 2, 3), 0)).toEqual([
			'hearth-0.db',
			'hearth-1.db',
			'hearth-2.db'
		]);
	});

	it('keeps 14 by default per DESIGN.md §3.5', () => {
		const entries = Array.from({ length: 20 }, (_, i) => ({ name: `d${i}.db`, mtimeMs: i }));
		const pruned = selectBackupsToPrune(entries);
		expect(pruned).toHaveLength(6);
		expect(pruned).toEqual(['d0.db', 'd1.db', 'd2.db', 'd3.db', 'd4.db', 'd5.db']);
	});
});
