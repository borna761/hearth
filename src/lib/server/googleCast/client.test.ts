import { describe, it, expect, vi } from 'vitest';
import { playFolderOnSpeaker } from './client';

function fakeClient({
	connectFails = false,
	launchFails = false,
	queueLoadFails = false
}: { connectFails?: boolean; launchFails?: boolean; queueLoadFails?: boolean } = {}) {
	const close = vi.fn();
	const queueLoad = vi.fn((items, options, callback) => {
		if (queueLoadFails) callback(new Error('queueLoad failed'));
		else callback(null);
	});
	const launch = vi.fn((app, callback) => {
		if (launchFails) callback(new Error('launch failed'));
		else callback(null, { queueLoad });
	});
	const errorListeners: Array<(err: Error) => void> = [];
	const client = {
		connect: vi.fn((options, callback) => {
			if (!connectFails) callback();
		}),
		launch,
		close,
		on: vi.fn((event: string, listener: (err: Error) => void) => {
			if (event === 'error') errorListeners.push(listener);
		}),
		getVolume: vi.fn(),
		setVolume: vi.fn(),
		emitError(err: Error) {
			errorListeners.forEach((l) => l(err));
		}
	};
	return { client, close, launch, queueLoad };
}

describe('playFolderOnSpeaker', () => {
	it('connects, launches DefaultMediaReceiver, and queues every track in order with its title as metadata', async () => {
		const { client, queueLoad, close } = fakeClient();
		const session = await playFolderOnSpeaker(
			'192.168.1.50',
			8009,
			[
				{ id: 1, url: 'http://a/1.mp3', title: 'Song One' },
				{ id: 2, url: 'http://a/2.mp3', title: 'Song Two' }
			],
			{ createClient: () => client }
		);

		expect(client.connect).toHaveBeenCalledWith(
			{ host: '192.168.1.50', port: 8009 },
			expect.any(Function)
		);
		const [items] = queueLoad.mock.calls[0];
		expect(items).toEqual([
			{
				media: {
					contentId: 'http://a/1.mp3',
					contentType: 'audio/mpeg',
					streamType: 'BUFFERED',
					metadata: { metadataType: 0, title: 'Song One' }
				},
				autoplay: true
			},
			{
				media: {
					contentId: 'http://a/2.mp3',
					contentType: 'audio/mpeg',
					streamType: 'BUFFERED',
					metadata: { metadataType: 0, title: 'Song Two' }
				},
				autoplay: true
			}
		]);
		// Stays connected on success — transport controls (play/pause/next) need a live
		// session to send later commands to, unlike the old fire-and-forget behavior.
		expect(close).not.toHaveBeenCalled();
		expect(session.client).toBe(client);
		expect(session.player).toBeDefined();

		// Loops the whole folder rather than stopping after the last track — Alex's ask.
		const [, options] = queueLoad.mock.calls[0];
		expect(options).toEqual({ repeatMode: 'REPEAT_ALL' });
	});

	it('rejects and closes the client if launching the receiver fails', async () => {
		const { client, close } = fakeClient({ launchFails: true });
		await expect(
			playFolderOnSpeaker('192.168.1.50', 8009, [{ id: 1, url: 'http://a/1.mp3', title: 'Song' }], {
				createClient: () => client
			})
		).rejects.toThrow('launch failed');
		expect(close).toHaveBeenCalledOnce();
	});

	it('rejects and closes the client if queueing the tracks fails', async () => {
		const { client, close } = fakeClient({ queueLoadFails: true });
		await expect(
			playFolderOnSpeaker('192.168.1.50', 8009, [{ id: 1, url: 'http://a/1.mp3', title: 'Song' }], {
				createClient: () => client
			})
		).rejects.toThrow('queueLoad failed');
		expect(close).toHaveBeenCalledOnce();
	});

	it('rejects if the underlying client emits a connection error', async () => {
		const { client, close } = fakeClient({ connectFails: true });
		const promise = playFolderOnSpeaker(
			'192.168.1.50',
			8009,
			[{ id: 1, url: 'http://a/1.mp3', title: 'Song' }],
			{ createClient: () => client }
		);
		client.emitError(new Error('connection refused'));
		await expect(promise).rejects.toThrow('connection refused');
		expect(close).toHaveBeenCalledOnce();
	});

	it('still rejects with the original error even if closing the already-dead client also throws — castv2 does socket.destroy() with no null check', async () => {
		const { client, close } = fakeClient({ launchFails: true });
		close.mockImplementation(() => {
			throw new TypeError("Cannot read properties of null (reading 'destroy')");
		});
		await expect(
			playFolderOnSpeaker('192.168.1.50', 8009, [{ id: 1, url: 'http://a/1.mp3', title: 'Song' }], {
				createClient: () => client
			})
		).rejects.toThrow('launch failed');
	});
});
