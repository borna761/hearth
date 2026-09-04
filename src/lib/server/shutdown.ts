// adapter-node's own SIGTERM/SIGINT handler (node_modules/@sveltejs/adapter-node/files/
// index.js) already closes the HTTP server gracefully — stops accepting new connections,
// waits (up to SHUTDOWN_TIMEOUT) for in-flight requests to finish — then emits
// 'sveltekit:shutdown' on `process` for exactly this purpose, but never calls
// process.exit() itself. Without a listener here, the process never exits on its own: the
// sync scheduler's several setIntervals (sync/runtime.ts) keep the event loop alive
// forever, so systemd has to wait out its full TimeoutStopSec (~90s) and SIGKILL every
// deploy. By the time this event fires, adapter-node has already closed every connection
// cleanly, so a plain exit is safe — no need to individually track and clearInterval each
// timer.
export interface ShutdownDeps {
	on(event: 'sveltekit:shutdown', listener: (reason: string) => void): void;
	exit(code: number): void;
}

let registered = false;

export function registerShutdownHandler(
	deps: ShutdownDeps = { on: process.on.bind(process), exit: process.exit.bind(process) }
): void {
	// Guards against duplicate listeners — hooks.server.ts's module scope can re-run under
	// dev HMR the same way sync/runtime.ts's own `started` guard already accounts for.
	if (registered) return;
	registered = true;
	deps.on('sveltekit:shutdown', () => {
		deps.exit(0);
	});
}
