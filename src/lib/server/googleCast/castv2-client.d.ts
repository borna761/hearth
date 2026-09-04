// Ambient types for the `castv2-client` npm package (1.2.0) — it ships no types of its
// own and none exist on DefinitelyTyped. Declares only the surface client.ts actually
// calls, checked against node_modules/castv2-client/{index.js,lib/senders/platform.js,
// lib/controllers/{media,receiver}.js} directly, not the library's full API (session
// joining, custom Application subclasses — none of which this app uses).

declare module 'castv2-client' {
	interface MediaItem {
		media: {
			contentId: string;
			contentType: string;
			streamType: string;
			metadata?: { metadataType: number; title: string };
		};
		autoplay: boolean;
	}

	interface MediaStatus {
		playerState: 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';
		currentTime?: number;
		media?: { metadata?: { title?: string }; duration?: number };
	}

	interface MediaPlayer {
		queueLoad(
			items: MediaItem[],
			options: Record<string, unknown>,
			callback: (err: Error | null, status?: unknown) => void
		): void;
		play(callback: (err: Error | null) => void): void;
		pause(callback: (err: Error | null) => void): void;
		stop(callback: (err: Error | null) => void): void;
		// `jump: 1`/`jump: -1` skips to the next/previous queued item — checked against
		// node_modules/castv2-client/lib/controllers/media.js's queueUpdate, which is the
		// only "skip" mechanism this library exposes (no dedicated next()/previous()).
		queueUpdate(
			items: unknown[],
			options: { jump?: number },
			callback: (err: Error | null) => void
		): void;
		getStatus(callback: (err: Error | null, status?: MediaStatus) => void): void;
		on(event: 'status', listener: (status: MediaStatus) => void): void;
	}

	interface VolumeStatus {
		level: number;
		muted: boolean;
	}

	class Client {
		connect(options: { host: string; port: number } | string, callback: () => void): void;
		launch(application: unknown, callback: (err: Error | null, player: MediaPlayer) => void): void;
		close(): void;
		on(event: 'error', listener: (err: Error) => void): this;
		on(event: 'status', listener: (status: unknown) => void): this;
		// PlatformSender's own getVolume/setVolume (node_modules/castv2-client/lib/senders/
		// platform.js) — `Client` and `PlatformSender` are the same export
		// (`module.exports.Client = module.exports.PlatformSender`), so these are directly
		// callable on the Client instance this app already holds, not on the media player.
		getVolume(callback: (err: Error | null, volume?: VolumeStatus) => void): void;
		setVolume(
			options: { level?: number; muted?: boolean },
			callback: (err: Error | null, volume?: VolumeStatus) => void
		): void;
	}

	// An opaque application descriptor passed straight through to Client#launch — this app
	// never constructs or inspects it, just forwards the same reference castv2-client itself
	// exports.
	const DefaultMediaReceiver: unknown;

	export { Client, DefaultMediaReceiver };
}
