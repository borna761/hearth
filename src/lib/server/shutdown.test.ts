import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// registerShutdownHandler guards itself with module-scope state (same reasoning as
// sync/runtime.ts's own `started` guard) so hooks.server.ts can call it unconditionally
// without double-registering under dev HMR — reset via resetModules so each test gets its
// own copy of that state instead of leaking across cases.
async function freshHandler() {
	vi.resetModules();
	const { registerShutdownHandler } = await import('./shutdown');
	return registerShutdownHandler;
}

describe('registerShutdownHandler', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('exits the process once adapter-node emits its shutdown event', async () => {
		const registerShutdownHandler = await freshHandler();
		const proc = new EventEmitter();
		const exit = vi.fn();
		registerShutdownHandler({ on: proc.on.bind(proc), exit });

		proc.emit('sveltekit:shutdown', 'SIGTERM');

		expect(exit).toHaveBeenCalledWith(0);
	});

	it('does not exit before the shutdown event fires', async () => {
		const registerShutdownHandler = await freshHandler();
		const proc = new EventEmitter();
		const exit = vi.fn();
		registerShutdownHandler({ on: proc.on.bind(proc), exit });

		expect(exit).not.toHaveBeenCalled();
	});

	it('only registers one listener even if called more than once', async () => {
		const registerShutdownHandler = await freshHandler();
		const proc = new EventEmitter();
		const exit = vi.fn();
		registerShutdownHandler({ on: proc.on.bind(proc), exit });
		registerShutdownHandler({ on: proc.on.bind(proc), exit });

		proc.emit('sveltekit:shutdown', 'SIGTERM');

		expect(exit).toHaveBeenCalledTimes(1);
	});
});
