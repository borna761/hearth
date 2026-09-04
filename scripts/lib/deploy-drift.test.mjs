import { describe, it, expect } from 'vitest';
import { parseEnvKeys, diffKeys, buildInstallUnitsCommand } from './deploy-drift.mjs';

describe('parseEnvKeys', () => {
	it('extracts keys from active (uncommented) KEY=value lines', () => {
		const text = ['DATABASE_URL=/var/lib/hearth/hearth.db', 'HOST=0.0.0.0', 'PORT=8080'].join('\n');
		expect(parseEnvKeys(text)).toEqual(['DATABASE_URL', 'HOST', 'PORT']);
	});

	it('ignores commented-out lines — those are documented-optional, not required', () => {
		const text = ['SECRETS_KEY=REPLACE_ME', '# HEARTH_ANYLIST_CREDENTIALS_FILE=...'].join('\n');
		expect(parseEnvKeys(text)).toEqual(['SECRETS_KEY']);
	});

	it('ignores blank lines and comment-only lines', () => {
		const text = ['', '# a comment', 'HOST=0.0.0.0', ''].join('\n');
		expect(parseEnvKeys(text)).toEqual(['HOST']);
	});

	it('returns an empty array for empty input', () => {
		expect(parseEnvKeys('')).toEqual([]);
	});
});

describe('diffKeys', () => {
	it('reports a key present in the example but missing live as missing', () => {
		expect(diffKeys(['A', 'B'], ['A'])).toEqual({ missing: ['B'] });
	});

	it('reports nothing missing when live has every example key', () => {
		expect(diffKeys(['A', 'B'], ['A', 'B', 'C'])).toEqual({ missing: [] });
	});

	it('does not flag a key that only exists live, not in the example', () => {
		expect(diffKeys(['A'], ['A', 'EXTRA_LIVE_ONLY_VAR'])).toEqual({ missing: [] });
	});

	it('handles no expected keys at all', () => {
		expect(diffKeys([], ['A'])).toEqual({ missing: [] });
	});

	it('reports every expected key missing when live has none of them', () => {
		expect(diffKeys(['A', 'B'], [])).toEqual({ missing: ['A', 'B'] });
	});
});

describe('buildInstallUnitsCommand', () => {
	// Deliberately never executed automatically (deploy/sudoers-hearth-deploy only
	// whitelists two commands, on purpose — see hearth.service's least-privilege comment).
	// This only saves you from re-deriving deploy/README.md §8's install steps by hand —
	// you still run it yourself, with your own sudo password.
	it('builds a copy-pasteable install command for the missing units', () => {
		const command = buildInstallUnitsCommand(
			['hearth-music-scan.service', 'hearth-music-scan.timer'],
			'/opt/hearth'
		);
		expect(command).toBe(
			[
				'cd /opt/hearth/current',
				'sudo cp deploy/hearth-music-scan.service deploy/hearth-music-scan.timer /etc/systemd/system/',
				'sudo systemctl daemon-reload',
				'sudo systemctl enable --now hearth-music-scan.service hearth-music-scan.timer'
			].join('\n')
		);
	});

	it('defaults hearthPath to /opt/hearth', () => {
		expect(buildInstallUnitsCommand(['hearth.service'])).toContain('cd /opt/hearth/current');
	});
});
