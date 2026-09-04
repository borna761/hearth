// Detects two specific kinds of drift that have silently broken things live before
// (CLAUDE.md, scripts/deploy.sh): the Pi's /etc/hearth/hearth.env falling behind
// deploy/hearth.env.example after a phase adds a var, and a new systemd unit shipped in
// deploy/ never actually getting installed/enabled on the Pi (confirmed live:
// hearth-music-scan.service/.timer existed in the repo but nowhere on the Pi). Both
// checks reduce to the same shape — "keys we expect" vs "keys actually present" — so one
// generic diff covers both.

/**
 * @param {string} text
 * @returns {string[]}
 */
export function parseEnvKeys(text) {
	return text
		.split('\n')
		.map((line) => line.match(/^([A-Z_][A-Z0-9_]*)=/))
		.filter((match) => match !== null)
		.map((match) => match[1]);
}

/**
 * @param {string[]} expected
 * @param {string[]} actual
 * @returns {{ missing: string[] }}
 */
export function diffKeys(expected, actual) {
	const actualSet = new Set(actual);
	return { missing: expected.filter((key) => !actualSet.has(key)) };
}

/**
 * The deploy/README.md §8 install steps for a set of missing units, with the real unit
 * names filled in — copy-pasteable, not executed. Deliberately not automated:
 * deploy/sudoers-hearth-deploy grants the deploy account exactly two commands on purpose
 * (hearth.service's least-privilege comment), and installing a unit needs real root sudo,
 * which stays a human running this with their own password.
 *
 * @param {string[]} missingUnits
 * @param {string} hearthPath
 * @returns {string}
 */
export function buildInstallUnitsCommand(missingUnits, hearthPath = '/opt/hearth') {
	const unitPaths = missingUnits.map((unit) => `deploy/${unit}`).join(' ');
	return [
		`cd ${hearthPath}/current`,
		`sudo cp ${unitPaths} /etc/systemd/system/`,
		'sudo systemctl daemon-reload',
		`sudo systemctl enable --now ${missingUnits.join(' ')}`
	].join('\n');
}
