// Template for scripts/scrub-rules.data.mjs (gitignored — never commit the real one).
// Copy this file to scrub-rules.data.mjs and fill in your household's actual values.
// scrub-for-public.mjs loads whichever one exists; this example file is never read by it.
//
// Order matters: rules apply sequentially, each seeing the previous rule's output. Put
// full email addresses / longer phrases before the bare names they contain, so e.g. an
// email doesn't get partially mangled by a name rule that runs first.
//
// wordBoundary: true for short tokens (names) that could otherwise match inside an
// unrelated longer word. Leave it off for phrases, coordinates, and other strings where
// exact substring matching is what you want.

export default [
	// Emails first, before the bare names they contain.
	{ from: 'realname.realsurname@gmail.com', to: 'alex@example.com' },

	// Names — both cases, word-boundary so "Sam" doesn't clobber "Samantha".
	{ from: 'RealFirstName', to: 'Alex', wordBoundary: true },
	{ from: 'realfirstname', to: 'alex', wordBoundary: true },

	// Anything else personal: GPS coordinates, a real LAN IP, a Tailscale tailnet id, a
	// real Mac username in a file path, hardware model names, city names, etc. — same
	// {from, to} shape, wordBoundary as appropriate.
	{ from: '12.3456', to: '45.5' }
];
