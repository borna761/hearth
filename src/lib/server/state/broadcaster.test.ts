import { describe, it, expect, vi } from 'vitest';
import { createBroadcaster, MAX_CLIENTS } from './broadcaster';

describe('createBroadcaster', () => {
	it('delivers a published payload to every subscriber', () => {
		const bus = createBroadcaster();
		const a = vi.fn();
		const b = vi.fn();
		bus.subscribe(a);
		bus.subscribe(b);

		bus.publish('{"n":1}');

		expect(a).toHaveBeenCalledWith('{"n":1}');
		expect(b).toHaveBeenCalledWith('{"n":1}');
	});

	it('gives a new subscriber the latest payload immediately', () => {
		// A tablet reconnecting after the 04:00 reload (§9.1) must not wait up to five
		// minutes for the next sync to learn what to display.
		const bus = createBroadcaster();
		bus.publish('{"n":1}');

		const late = vi.fn();
		bus.subscribe(late);

		expect(late).toHaveBeenCalledWith('{"n":1}');
	});

	it('sends nothing to a new subscriber when there is no state yet', () => {
		const bus = createBroadcaster();
		const first = vi.fn();
		bus.subscribe(first);
		expect(first).not.toHaveBeenCalled();
	});

	it('skips a republish of an identical payload', () => {
		// Sync runs every five minutes and usually changes nothing. Pushing an identical
		// week to a display already showing it is pure waste.
		const bus = createBroadcaster();
		const client = vi.fn();
		bus.subscribe(client);

		bus.publish('{"n":1}');
		bus.publish('{"n":1}');
		bus.publish('{"n":2}');

		expect(client).toHaveBeenCalledTimes(2);
		expect(client).toHaveBeenLastCalledWith('{"n":2}');
	});

	it('stops delivering after unsubscribe', () => {
		const bus = createBroadcaster();
		const client = vi.fn();
		const unsubscribe = bus.subscribe(client);

		unsubscribe!();
		bus.publish('{"n":1}');

		expect(client).not.toHaveBeenCalled();
		expect(bus.clientCount).toBe(0);
	});

	it('tolerates unsubscribing twice', () => {
		const bus = createBroadcaster();
		const unsubscribe = bus.subscribe(vi.fn());
		unsubscribe!();
		unsubscribe!();
		expect(bus.clientCount).toBe(0);
	});

	it('drops a client whose send throws, rather than retrying it forever', () => {
		// A wedged or half-closed socket must not keep costing work on every publish.
		const bus = createBroadcaster();
		const dead = vi.fn(() => {
			throw new Error('socket closed');
		});
		const alive = vi.fn();
		bus.subscribe(dead);
		bus.subscribe(alive);

		bus.publish('{"n":1}');

		expect(bus.clientCount).toBe(1);
		expect(alive).toHaveBeenCalledOnce();

		bus.publish('{"n":2}');
		expect(dead).toHaveBeenCalledTimes(1); // never called again
	});

	it('refuses connections past the cap', () => {
		// DESIGN.md §2.1: a Hearth bug must not exhaust memory and take the household's
		// DNS with it. A kiosk-app crash-loop reconnecting endlessly is the realistic
		// way that happens here.
		const bus = createBroadcaster();
		for (let i = 0; i < MAX_CLIENTS; i += 1) {
			expect(bus.subscribe(vi.fn())).not.toBeNull();
		}

		expect(bus.subscribe(vi.fn())).toBeNull();
		expect(bus.clientCount).toBe(MAX_CLIENTS);
	});

	it('accepts a new connection once one below the cap disconnects', () => {
		const bus = createBroadcaster();
		const unsubscribes = [];
		for (let i = 0; i < MAX_CLIENTS; i += 1) {
			unsubscribes.push(bus.subscribe(vi.fn()));
		}
		expect(bus.subscribe(vi.fn())).toBeNull();

		unsubscribes[0]!();
		expect(bus.subscribe(vi.fn())).not.toBeNull();
	});

	it('reports whether a publish was sent or deduped', () => {
		const bus = createBroadcaster();
		bus.subscribe(vi.fn());
		expect(bus.publish('{"n":1}')).toBe(true);
		expect(bus.publish('{"n":1}')).toBe(false);
		expect(bus.publish('{"n":2}')).toBe(true);
	});

	it('reports how many clients are attached', () => {
		const bus = createBroadcaster();
		expect(bus.clientCount).toBe(0);
		bus.subscribe(vi.fn());
		bus.subscribe(vi.fn());
		expect(bus.clientCount).toBe(2);
	});
});
