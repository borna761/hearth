import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlaybackStatusSnapshot } from '$lib/server/googleCast/playbackSession';

/** Lets the panel show correct play/pause/next controls when it's (re)opened, without
 * the client having to remember whether it was the one that started playback. Reads the
 * in-memory session directly — no network round-trip to the speaker itself. Unlike
 * groceries, music is intentionally open to guest mode too (Alex's call). */
export const GET: RequestHandler = async () => {
	const session = getPlaybackStatusSnapshot();
	return json(
		session
			? {
					active: true,
					playerState: session.playerState,
					speakerId: session.speakerId,
					folderId: session.folderId,
					trackId: session.trackId,
					trackTitle: session.trackTitle,
					currentTime: session.currentTime,
					duration: session.duration,
					volume: session.volume,
					muted: session.muted
				}
			: { active: false }
	);
};
