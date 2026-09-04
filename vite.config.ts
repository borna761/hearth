import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

// Mirror .env into process.env so dev matches production.
//
// On the Pi, systemd's EnvironmentFile puts these in the real process environment, so
// server code reads process.env directly — which also keeps modules like
// crypto/secrets.ts usable from plain-node systemd units (the §6 resize job) rather than
// coupling them to SvelteKit's $env. Vite loads .env for $env/* but never into
// process.env, so without this, dev is the only environment where that breaks.
//
// A real environment variable always wins; the file only fills gaps. On the Pi there is
// no .env at all, so this is a no-op there.
for (const [key, value] of Object.entries(loadEnv('development', process.cwd(), ''))) {
	if (!(key in process.env)) process.env[key] = value;
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			typescript: {
				config: (config) => {
					config.include.push('../drizzle.config.ts');
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		// sharp.concurrency(1) (photo-resize.mjs, music-cover-resize.mjs — deliberately
		// serialized so the real nightly jobs stay within their Pi memory caps) restricts
		// libvips to one native thread process-wide, shared by every sharp-based test file
		// vitest runs concurrently. The default 5s timeout is fine for any one of them
		// alone but flakes under the full suite's parallel worker contention.
		testTimeout: 15_000,
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/**/*.{test,spec}.{js,mjs}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
