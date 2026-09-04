import { describe, it, expect, vi } from 'vitest';
import { runOnlineBackup } from './backup-online.mjs';

describe('runOnlineBackup', () => {
	it('backs up to the given destination via the Online Backup API', async () => {
		const backup = vi.fn().mockResolvedValue({ totalPages: 10, remainingPages: 0 });
		const db = { backup };

		await runOnlineBackup(db, '/backups/hearth-1.db');

		expect(backup).toHaveBeenCalledTimes(1);
		expect(backup).toHaveBeenCalledWith('/backups/hearth-1.db');
	});

	it('propagates a genuine failure instead of swallowing it', async () => {
		const err = new Error('ENOSPC: no space left on device');
		const backup = vi.fn().mockRejectedValue(err);
		const db = { backup };

		await expect(runOnlineBackup(db, '/backups/hearth-1.db')).rejects.toBe(err);
	});
});
