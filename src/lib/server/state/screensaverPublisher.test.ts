import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema';
import { photos, connections, sources, musicFolders } from '../db/schema';
import {
	publishScreensaverState,
	screensaverBus,
	getActiveScreensaverMode,
	setActiveScreensaverMode,
	resetScreensaverSlideCache
} from './screensaverPublisher';
import { resetWeatherCache, refreshWeather } from '../weather';
import { resetPhotoRotation } from '../photos';
import { addMusicSpeaker } from '../musicLibrary';
import { setSetting, SETTING_KEYS } from '../settings';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;
const originalKey = process.env.SECRETS_KEY;

beforeEach(() => {
	process.env.SECRETS_KEY = randomBytes(32).toString('hex');
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
	resetWeatherCache();
	resetPhotoRotation();
	resetScreensaverSlideCache();
	// No setActiveScreensaverMode('family') reset needed here — unlike stateBus/
	// screensaverBus (genuine module-scope singletons), the mode is now settings-table-
	// backed (see below), so a fresh :memory: db each test already starts unset, which
	// getActiveScreensaverMode treats as 'family'.
});

afterEach(() => {
	resetWeatherCache();
	resetPhotoRotation();
	resetScreensaverSlideCache();
	sqlite.close();
	process.env.SECRETS_KEY = originalKey;
});

// Same shape as groceries.test.ts's seedSource — a connected AnyList source is what makes
// buildGroceriesSnapshot return a snapshot instead of null.
async function seedGroceriesSource() {
	const [connection] = await db
		.insert(connections)
		.values({ provider: 'anylist', label: 'a@b.com', secrets: Buffer.from('x') })
		.returning();
	await db.insert(sources).values({
		connectionId: connection.id,
		kind: 'groceries',
		externalId: 'anylist-list-1',
		displayName: 'My Grocery List'
	});
}

async function seedMusicFolder(displayName = 'Road Trip') {
	const [folder] = await db
		.insert(musicFolders)
		.values({ displayName, folderPath: displayName })
		.returning();
	return folder;
}

function currentBroadcast(): unknown {
	let received: unknown;
	const unsubscribe = screensaverBus.subscribe((payload) => {
		received = JSON.parse(payload);
	});
	unsubscribe?.();
	return received;
}

async function seedPhoto(kind: 'family' | 'guest' = 'family') {
	const [row] = await db
		.insert(photos)
		.values({
			sourcePath: `/pictures/${Math.random().toString(36).slice(2)}.jpg`,
			mtime: DAYTIME,
			size: 1000,
			cachedPath: '/cache/x.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape',
			kind
		})
		.returning();
	return row;
}

// Well outside the default 22:00–07:00 Toronto quiet-hours window.
const DAYTIME = new Date('2026-08-23T18:00:00Z'); // 14:00 Toronto
const NIGHTTIME = new Date('2026-08-23T04:00:00Z'); // 00:00 Toronto

describe('publishScreensaverState', () => {
	it('falls back to Picsum in family mode when the photos table is empty', async () => {
		const outcome = await publishScreensaverState(db, DAYTIME, () => 0.42);
		expect(outcome).toBe('published');
		const broadcast = currentBroadcast() as { slide: { kind: string; photo: { url: string } } };
		expect(broadcast.slide.kind).toBe('single');
		expect(broadcast.slide.photo.url).toMatch(
			/^https:\/\/picsum\.photos\/seed\/[a-z0-9]+\/1280\/800$/
		);
	});

	it('sources from real photos in family mode once the photos table has rows', async () => {
		const photo = await seedPhoto();
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as {
			slide: { kind: string; photo: { url: string; blurHash: null } };
		};
		expect(broadcast.slide.kind).toBe('single');
		expect(broadcast.slide.photo.url).toBe(`/api/photos/${photo.id}?v=${photo.mtime.getTime()}`);
	});

	it('falls back to Picsum in guest mode when only family-kind photos exist', async () => {
		await seedPhoto('family');
		await setActiveScreensaverMode(db, 'guest');
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { slide: { photo: { url: string } } };
		expect(broadcast.slide.photo.url).toMatch(/^https:\/\/picsum\.photos\//);
	});

	// DESIGN.md §5/§6: guest-appropriate photos live on the NAS too, HEARTH_GUEST_PHOTOS_DIR
	// scanned into the same `photos` table with kind: 'guest' — Picsum is only the fallback
	// for an empty/not-yet-scanned folder, the same role it already plays for family mode.
	it('sources from real guest-kind photos in guest mode once some exist', async () => {
		const guestPhoto = await seedPhoto('guest');
		await setActiveScreensaverMode(db, 'guest');
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as {
			slide: { kind: string; photo: { url: string; blurHash: null } };
		};
		expect(broadcast.slide.kind).toBe('single');
		expect(broadcast.slide.photo.url).toBe(
			`/api/photos/${guestPhoto.id}?v=${guestPhoto.mtime.getTime()}`
		);
	});

	it('never shows a family-kind photo in guest mode, even mixed with guest-kind ones', async () => {
		await seedPhoto('family');
		const guestPhoto = await seedPhoto('guest');
		await setActiveScreensaverMode(db, 'guest');
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { slide: { photo: { url: string } } };
		expect(broadcast.slide.photo.url).toBe(
			`/api/photos/${guestPhoto.id}?v=${guestPhoto.mtime.getTime()}`
		);
	});

	it('includes the cached weather once one has been fetched', async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				current: { temperature_2m: 21, weather_code: 0 },
				hourly: { time: [], temperature_2m: [], weather_code: [] }
			})
		}) as unknown as typeof fetch;
		await refreshWeather(DAYTIME, fetchImpl, db);

		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { weather: { temperatureC: number } };
		expect(broadcast.weather).toMatchObject({ temperatureC: 21, condition: 'Clear' });
	});

	it('includes the computed theme, following the sun by default', async () => {
		// DESIGN.md §5.3's own worked example — dark through dinner on the winter solstice,
		// still outside the default 22:00–07:00 quiet-hours window.
		const winterDinner = new Date('2026-12-21T23:30:00Z'); // 18:30 Toronto (EST)
		await publishScreensaverState(db, winterDinner, () => 0.42);
		expect((currentBroadcast() as { theme: string }).theme).toBe('dark');
	});

	it('publishes a bare night-clock state on entering quiet hours (DESIGN.md §9.2)', async () => {
		// Not a total suppression like the calendar stream: there's no device-side
		// screen-off schedule at all (§9.1/§9.2), so this publish is what actually makes
		// the tablet look dark — it tells connected clients to drop down to a bare clock
		// rather than freezing on whatever was last shown.
		await seedPhoto();
		const outcome = await publishScreensaverState(db, NIGHTTIME, () => 0.42);
		expect(outcome).toBe('quiet-hours');
		const broadcast = currentBroadcast() as { weather: unknown; slide: unknown };
		expect(broadcast.weather).toBeNull();
		expect(broadcast.slide).toBeNull();
	});

	it('dedupes repeated quiet-hours ticks the same as any other unchanged payload', async () => {
		await publishScreensaverState(db, NIGHTTIME, () => 0.42);
		const outcome = await publishScreensaverState(db, NIGHTTIME, () => 0.42);
		expect(outcome).toBe('unchanged');
	});

	it('dedupes an identical payload rather than re-publishing', async () => {
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const outcome = await publishScreensaverState(db, DAYTIME, () => 0.42);
		expect(outcome).toBe('unchanged');
	});

	it('publishes again once the composed slide actually changes', async () => {
		await publishScreensaverState(db, DAYTIME, () => 0.1);
		const outcome = await publishScreensaverState(db, DAYTIME, () => 0.9);
		expect(outcome).toBe('published');
	});

	// publishAll (state/publisher.ts) and pushGroceriesState (sync/runtime.ts) both call
	// this eagerly on a grocery write, purely so the groceries count/list itself updates
	// without waiting on the next 30s tick (DESIGN.md §5.1). Composing a genuinely fresh
	// slide on every one of those calls — the same code path the periodic tick uses to
	// actually advance the rotation — meant every grocery tap also cycled the background
	// photo, which is not what a grocery edit should ever do to a resting screensaver.
	it('does not advance the photo slide when advanceSlide is false — a grocery edit must not also skip the current photo', async () => {
		await publishScreensaverState(db, DAYTIME, () => 0.1);
		const first = (currentBroadcast() as { slide: { photo: { url: string } } }).slide.photo.url;

		const outcome = await publishScreensaverState(db, DAYTIME, () => 0.9, { advanceSlide: false });
		const second = (currentBroadcast() as { slide: { photo: { url: string } } }).slide.photo.url;
		expect(second).toBe(first);
		// The rest of the envelope can still differ and publish — only the slide is pinned.
		expect(outcome).not.toBe('quiet-hours');
	});

	it('still advances the photo slide by default — the periodic screensaver tick', async () => {
		await publishScreensaverState(db, DAYTIME, () => 0.1);
		const first = (currentBroadcast() as { slide: { photo: { url: string } } }).slide.photo.url;

		await publishScreensaverState(db, DAYTIME, () => 0.9);
		const second = (currentBroadcast() as { slide: { photo: { url: string } } }).slide.photo.url;
		expect(second).not.toBe(first);
	});

	// DESIGN.md §5.1: groceries are PIN-free from the screensaver's own button in 'family'
	// mode — the one deliberate exception to this bus never carrying household data.
	it('includes the groceries snapshot in family mode once AnyList is connected', async () => {
		await seedGroceriesSource();
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { groceries: { count: number } | null };
		expect(broadcast.groceries).not.toBeNull();
		expect(broadcast.groceries).toMatchObject({ count: 0 });
	});

	it('omits groceries when AnyList has never been connected', async () => {
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { groceries: unknown };
		expect(broadcast.groceries).toBeNull();
	});

	it('omits groceries in guest mode even though AnyList is connected', async () => {
		await seedGroceriesSource();
		await setActiveScreensaverMode(db, 'guest');
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { groceries: unknown };
		expect(broadcast.groceries).toBeNull();
	});

	it('omits groceries on the bare night-clock state too', async () => {
		await seedGroceriesSource();
		await publishScreensaverState(db, NIGHTTIME, () => 0.42);
		const broadcast = currentBroadcast() as { groceries: unknown };
		expect(broadcast.groceries).toBeNull();
	});

	// docs/phase-7-music-plan.md: same PIN-free-in-family-mode exception as groceries.
	it('includes music folders and speakers in family mode', async () => {
		const folder = await seedMusicFolder('Road Trip');
		const speaker = await addMusicSpeaker(db, 'Kitchen');
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { musicFolders: unknown; musicSpeakers: unknown };
		expect(broadcast.musicFolders).toEqual([{ id: folder.id, displayName: 'Road Trip' }]);
		expect(broadcast.musicSpeakers).toEqual([{ id: speaker.id, castName: 'Kitchen' }]);
	});

	it('reports empty lists when nothing is configured yet', async () => {
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { musicFolders: unknown; musicSpeakers: unknown };
		expect(broadcast.musicFolders).toEqual([]);
		expect(broadcast.musicSpeakers).toEqual([]);
	});

	// Unlike groceries, music is intentionally available in guest mode too (Alex's call:
	// full control for a guest, not just visibility — the household's shared music, not
	// household data a visitor shouldn't see).
	it('includes music folders/speakers in guest mode too, unlike groceries', async () => {
		const folder = await seedMusicFolder('Road Trip');
		const speaker = await addMusicSpeaker(db, 'Kitchen');
		await setActiveScreensaverMode(db, 'guest');
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { musicFolders: unknown; musicSpeakers: unknown };
		expect(broadcast.musicFolders).toEqual([{ id: folder.id, displayName: 'Road Trip' }]);
		expect(broadcast.musicSpeakers).toEqual([{ id: speaker.id, castName: 'Kitchen' }]);
	});

	it('omits music folders/speakers on the bare night-clock state too', async () => {
		await seedMusicFolder();
		await addMusicSpeaker(db, 'Kitchen');
		await publishScreensaverState(db, NIGHTTIME, () => 0.42);
		const broadcast = currentBroadcast() as { musicFolders: unknown; musicSpeakers: unknown };
		expect(broadcast.musicFolders).toBeNull();
		expect(broadcast.musicSpeakers).toBeNull();
	});

	it('includes music folders/speakers inside a configured music-hours window', async () => {
		await seedMusicFolder();
		await addMusicSpeaker(db, 'Kitchen');
		await setSetting(db, SETTING_KEYS.musicHours, '09:00-21:30');
		// DAYTIME is 14:00 Toronto — inside the window.
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as { musicFolders: unknown; musicSpeakers: unknown };
		expect(broadcast.musicFolders).not.toBeNull();
		expect(broadcast.musicSpeakers).not.toBeNull();
	});

	it('omits music folders/speakers outside a configured music-hours window, even in family mode during the day', async () => {
		await seedMusicFolder();
		await addMusicSpeaker(db, 'Kitchen');
		await setSetting(db, SETTING_KEYS.musicHours, '09:00-10:00');
		// DAYTIME is 14:00 Toronto — outside the window, but not quiet hours, so groceries
		// still shows while music alone is hidden.
		await publishScreensaverState(db, DAYTIME, () => 0.42);
		const broadcast = currentBroadcast() as {
			musicFolders: unknown;
			musicSpeakers: unknown;
			groceries: unknown;
		};
		expect(broadcast.musicFolders).toBeNull();
		expect(broadcast.musicSpeakers).toBeNull();
	});
});

describe('getActiveScreensaverMode / setActiveScreensaverMode', () => {
	// Settings-table-backed (not a module-scope `let`) specifically so a mode someone
	// deliberately chose survives a service restart — a guest staying the week shouldn't
	// need Guest mode re-selected every time a deploy or a crash restarts the process.
	it('defaults to family when nothing has ever been set', async () => {
		expect(await getActiveScreensaverMode(db)).toBe('family');
	});

	it('round-trips a chosen mode', async () => {
		await setActiveScreensaverMode(db, 'guest');
		expect(await getActiveScreensaverMode(db)).toBe('guest');

		await setActiveScreensaverMode(db, 'family');
		expect(await getActiveScreensaverMode(db)).toBe('family');
	});

	it('survives being read by a completely separate connection to the same database file — proof it is not process memory', async () => {
		const dbPath = path.join(
			tmpdir(),
			`screensaver-mode-${Math.random().toString(36).slice(2)}.db`
		);
		try {
			const fileSqlite = new Database(dbPath);
			fileSqlite.pragma('foreign_keys = ON');
			const fileDb = drizzle(fileSqlite, { schema });
			migrate(fileDb, { migrationsFolder: './drizzle' });

			await setActiveScreensaverMode(fileDb, 'guest');
			fileSqlite.close();

			const reopened = new Database(dbPath);
			const reopenedDb = drizzle(reopened, { schema });
			expect(await getActiveScreensaverMode(reopenedDb)).toBe('guest');
			reopened.close();
		} finally {
			unlinkSync(dbPath);
		}
	});
});
