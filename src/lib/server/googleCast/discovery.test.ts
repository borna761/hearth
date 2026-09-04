import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolveSpeakerHost, discoverAllSpeakerNames } from './discovery';

interface FakeService {
	txt?: Record<string, string>;
	addresses?: string[];
	port: number;
}

function fakeBrowser() {
	const emitter = new EventEmitter();
	const stop = vi.fn();
	return {
		browser: { on: emitter.on.bind(emitter), stop },
		emitUp: (service: FakeService) => emitter.emit('up', service),
		stop
	};
}

describe('resolveSpeakerHost', () => {
	it('resolves the host/port of the device whose friendly name matches', async () => {
		const { browser, emitUp } = fakeBrowser();
		const promise = resolveSpeakerHost('Kitchen', { createBrowser: () => browser });
		emitUp({ txt: { fn: 'Kitchen' }, addresses: ['192.168.1.50'], port: 8009 });
		await expect(promise).resolves.toEqual({ host: '192.168.1.50', port: 8009 });
	});

	it('ignores devices whose friendly name does not match', async () => {
		const { browser, emitUp } = fakeBrowser();
		const promise = resolveSpeakerHost('Kitchen', { createBrowser: () => browser, timeoutMs: 50 });
		emitUp({ txt: { fn: 'Bedroom' }, addresses: ['192.168.1.51'], port: 8009 });
		await expect(promise).resolves.toBeNull();
	});

	it('resolves null if nothing matches within the timeout', async () => {
		const { browser } = fakeBrowser();
		const promise = resolveSpeakerHost('Kitchen', { createBrowser: () => browser, timeoutMs: 50 });
		await expect(promise).resolves.toBeNull();
	});

	it('stops the browser once resolved, so it does not keep listening', async () => {
		const { browser, emitUp, stop } = fakeBrowser();
		const promise = resolveSpeakerHost('Kitchen', { createBrowser: () => browser });
		emitUp({ txt: { fn: 'Kitchen' }, addresses: ['192.168.1.50'], port: 8009 });
		await promise;
		expect(stop).toHaveBeenCalledOnce();
	});

	it('prefers an IPv4 address over IPv6 when a device advertises both', async () => {
		const { browser, emitUp } = fakeBrowser();
		const promise = resolveSpeakerHost('Kitchen', { createBrowser: () => browser });
		emitUp({ txt: { fn: 'Kitchen' }, addresses: ['fe80::1', '192.168.1.50'], port: 8009 });
		await expect(promise).resolves.toEqual({ host: '192.168.1.50', port: 8009 });
	});

	it('ignores a matching device with no addresses at all', async () => {
		const { browser, emitUp } = fakeBrowser();
		const promise = resolveSpeakerHost('Kitchen', { createBrowser: () => browser, timeoutMs: 50 });
		emitUp({ txt: { fn: 'Kitchen' }, addresses: [], port: 8009 });
		await expect(promise).resolves.toBeNull();
	});
});

describe('discoverAllSpeakerNames', () => {
	it('collects every distinct friendly name seen for the full duration, not just the first', async () => {
		const { browser, emitUp } = fakeBrowser();
		const promise = discoverAllSpeakerNames({ createBrowser: () => browser, timeoutMs: 50 });
		emitUp({ txt: { fn: 'Kitchen' }, addresses: ['192.168.1.50'], port: 8009 });
		emitUp({ txt: { fn: 'Bedroom' }, addresses: ['192.168.1.51'], port: 8009 });
		await expect(promise).resolves.toEqual(['Bedroom', 'Kitchen']);
	});

	it('de-duplicates repeated announcements of the same device', async () => {
		const { browser, emitUp } = fakeBrowser();
		const promise = discoverAllSpeakerNames({ createBrowser: () => browser, timeoutMs: 50 });
		emitUp({ txt: { fn: 'Kitchen' }, addresses: ['192.168.1.50'], port: 8009 });
		emitUp({ txt: { fn: 'Kitchen' }, addresses: ['192.168.1.50'], port: 8009 });
		await expect(promise).resolves.toEqual(['Kitchen']);
	});

	it('ignores devices with no advertised friendly name', async () => {
		const { browser, emitUp } = fakeBrowser();
		const promise = discoverAllSpeakerNames({ createBrowser: () => browser, timeoutMs: 50 });
		emitUp({ addresses: ['192.168.1.52'], port: 8009 });
		await expect(promise).resolves.toEqual([]);
	});

	it('stops the browser once the scan window ends', async () => {
		const { browser, stop } = fakeBrowser();
		await discoverAllSpeakerNames({ createBrowser: () => browser, timeoutMs: 20 });
		expect(stop).toHaveBeenCalledOnce();
	});

	it('resolves an empty list when nothing is found', async () => {
		const { browser } = fakeBrowser();
		await expect(
			discoverAllSpeakerNames({ createBrowser: () => browser, timeoutMs: 20 })
		).resolves.toEqual([]);
	});
});
