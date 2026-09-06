import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchIdle, sendHeartbeat, type ActivityTarget } from './idleTimer';

/** A minimal stand-in for `window` — tracks listeners per event type and lets a test fire
 *  one directly, without needing a real DOM. */
function fakeTarget(): ActivityTarget & { fire: (type: string) => void } {
	const listeners = new Map<string, Set<() => void>>();
	return {
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(listener);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		fire(type) {
			for (const listener of listeners.get(type) ?? []) listener();
		}
	};
}

describe('watchIdle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls onIdle after timeoutMs with no activity', () => {
		const onIdle = vi.fn();
		watchIdle(1000, onIdle, undefined, fakeTarget());

		vi.advanceTimersByTime(999);
		expect(onIdle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onIdle).toHaveBeenCalledOnce();
	});

	it('resets the timer on activity, delaying onIdle', () => {
		const onIdle = vi.fn();
		const target = fakeTarget();
		watchIdle(1000, onIdle, undefined, target);

		vi.advanceTimersByTime(700);
		target.fire('click');
		vi.advanceTimersByTime(700);
		// 1400ms of wall time have passed, but only 700ms since the last reset.
		expect(onIdle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(300);
		expect(onIdle).toHaveBeenCalledOnce();
	});

	// touchstart/click/keydown all count as activity — DESIGN.md's idle timer shouldn't
	// require one specific input method on a touchscreen kiosk.
	it.each(['touchstart', 'click', 'keydown'])('treats %s as activity', (eventType) => {
		const onIdle = vi.fn();
		const target = fakeTarget();
		watchIdle(1000, onIdle, undefined, target);

		vi.advanceTimersByTime(999);
		target.fire(eventType);
		vi.advanceTimersByTime(999);
		expect(onIdle).not.toHaveBeenCalled();
	});

	it('calls onActivity on every activity tick, not just once', () => {
		const onActivity = vi.fn();
		const target = fakeTarget();
		watchIdle(1000, vi.fn(), onActivity, target);

		expect(onActivity).toHaveBeenCalledTimes(1); // the initial resetIdle() call
		target.fire('click');
		target.fire('keydown');
		expect(onActivity).toHaveBeenCalledTimes(3);
	});

	it('stops firing onIdle and removes its listeners once cleaned up', () => {
		const onIdle = vi.fn();
		const onActivity = vi.fn();
		const target = fakeTarget();
		const cleanup = watchIdle(1000, onIdle, onActivity, target);

		cleanup();
		onActivity.mockClear();

		target.fire('click');
		vi.advanceTimersByTime(2000);
		expect(onActivity).not.toHaveBeenCalled();
		expect(onIdle).not.toHaveBeenCalled();
	});
});

describe('sendHeartbeat', () => {
	it('calls onExpired when the server reports the session expired', async () => {
		const onExpired = vi.fn();
		const fetchFn = vi.fn().mockResolvedValue({ json: async () => ({ expired: true }) });

		sendHeartbeat(onExpired, fetchFn as unknown as typeof fetch);
		await vi.waitFor(() => expect(onExpired).toHaveBeenCalledOnce());

		expect(fetchFn).toHaveBeenCalledWith('/api/auth/heartbeat', { method: 'POST' });
	});

	it('does not call onExpired when the session is still alive', async () => {
		const onExpired = vi.fn();
		const fetchFn = vi.fn().mockResolvedValue({ json: async () => ({ expired: false }) });

		sendHeartbeat(onExpired, fetchFn as unknown as typeof fetch);
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());

		expect(onExpired).not.toHaveBeenCalled();
	});

	it('swallows a network failure without calling onExpired or throwing', async () => {
		const onExpired = vi.fn();
		const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));

		expect(() => sendHeartbeat(onExpired, fetchFn as unknown as typeof fetch)).not.toThrow();
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());

		expect(onExpired).not.toHaveBeenCalled();
	});
});
