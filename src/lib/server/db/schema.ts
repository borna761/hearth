import {
	sqliteTable,
	text,
	integer,
	blob,
	index,
	unique,
	primaryKey
} from 'drizzle-orm/sqlite-core';

// Household members. Three rows in practice — Alex, Dana, Sam — but nothing here
// hardcodes that; DESIGN.md §8.
export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	color: text('color').notNull(),
	avatarPath: text('avatar_path'),
	pinHash: text('pin_hash').notNull(), // argon2id
	viewMode: text('view_mode', { enum: ['standard', 'simple'] })
		.notNull()
		.default('standard'),
	// Which layout the week view renders in for this person — agenda list or hour grid.
	// Per-user rather than per-device: several people share the one tablet, and each can
	// prefer a different way to read their own week.
	weekView: text('week_view', { enum: ['agenda', 'grid'] })
		.notNull()
		.default('agenda'),
	// Which Todoist tasks this person sees, relative to the single admin-designated project
	// in settings.ts's restrictedTaskProjectId (tasks.ts's buildTasksSnapshot). Default
	// 'all-but-one' reproduces every existing user's prior (hardcoded) behavior with no
	// migration needed — only the one simple-view user needs switching to 'only-one' by
	// hand after this ships.
	taskAccess: text('task_access', { enum: ['all-but-one', 'only-one', 'none'] })
		.notNull()
		.default('all-but-one'),
	sortOrder: integer('sort_order').notNull().default(0),
	// Phase 3 additions — DESIGN.md §8 had no equivalent; see the "Changes from v0.12" note.
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	// PIN lockout (§5: "Five wrong PINs triggers a 60-second lockout") — per-user, so it
	// must survive individual requests rather than living in any client-side state.
	failedPinAttempts: integer('failed_pin_attempts').notNull().default(0),
	lockedUntil: integer('locked_until', { mode: 'timestamp_ms' })
});

// A logged-in tablet session (§5: avatar + PIN -> session). No equivalent in DESIGN.md
// §8 — added so idle-timeout and lockout state survive individual page loads. The token
// is stored raw, not hashed: a local DB reader on this Pi already has access exceeding
// what a stolen ~2-minute-lived session token grants (the same "casual visitors, not
// adversaries" threat model DESIGN.md §5.3 already states for PINs).
export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
	// Hard cap independent of idle-timeout, in case something keeps touching a session
	// (e.g. a heartbeat bug) — not something DESIGN.md specifies, a defensive addition.
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull()
});

// One row per external account (Google, Todoist, AnyList). Secrets are AES-256-GCM
// encrypted before being stored — see src/lib/server/crypto/secrets.ts. No 'unsplash':
// guest mode uses Picsum instead (phase 4 milestone 3), which needs no key at all.
export const connections = sqliteTable('connections', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	provider: text('provider', { enum: ['google', 'todoist', 'anylist'] }).notNull(),
	label: text('label').notNull(),
	secrets: blob('secrets', { mode: 'buffer' }).notNull(),
	status: text('status').notNull().default('ok'),
	lastSuccess: integer('last_success', { mode: 'timestamp_ms' }),
	lastError: text('last_error')
});

// A syncable feed within a connection: a Google calendar, a Todoist project, the
// AnyList grocery list. `sync_token` carries each provider's delta-sync cursor.
export const sources = sqliteTable(
	'sources',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		connectionId: integer('connection_id')
			.notNull()
			.references(() => connections.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['calendar', 'tasks', 'groceries'] }).notNull(),
		externalId: text('external_id').notNull(),
		displayName: text('display_name').notNull(),
		color: text('color'), // from calendarList.backgroundColor
		groupLabel: text('group_label'), // e.g. 'Football' collapses four feeds
		syncToken: text('sync_token'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true)
	},
	(table) => [unique().on(table.connectionId, table.externalId)]
);

// Per-user, per-source visibility — the matrix Alex edits in Settings (DESIGN.md §4, §7.5).
export const visibility = sqliteTable(
	'visibility',
	{
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		sourceId: integer('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		visible: integer('visible', { mode: 'boolean' }).notNull().default(true)
	},
	(table) => [primaryKey({ columns: [table.userId, table.sourceId] })]
);

// Recurring events are expanded server-side into a rolling window (one month back,
// twelve forward) so the tablet never evaluates an RRULE — DESIGN.md §8.
export const events = sqliteTable(
	'events',
	{
		id: text('id').primaryKey(),
		sourceId: integer('source_id')
			.notNull()
			.references(() => sources.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		startsAt: integer('starts_at', { mode: 'timestamp_ms' }), // NULL for all-day
		endsAt: integer('ends_at', { mode: 'timestamp_ms' }),
		localDate: text('local_date'), // 'YYYY-MM-DD' for all-day; NULL otherwise
		// Inclusive last day of an all-day event, so a multi-day span (a vacation, a
		// festival period) is not collapsed onto its first day. Google's own end.date is
		// exclusive; the conversion happens once, in normalizeEvent.
		localEndDate: text('local_end_date'),
		allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
		location: text('location'),
		status: text('status'),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('events_window').on(table.startsAt, table.endsAt),
		// Overlap queries for a week are `local_date <= weekEnd AND local_end_date >=
		// weekStart`, so both columns belong in the index.
		index('events_allday').on(table.localDate, table.localEndDate)
	]
);

// Groceries (and, later, Todoist tasks) — one row per checkable item.
export const listItems = sqliteTable('list_items', {
	id: text('id').primaryKey(),
	sourceId: integer('source_id')
		.notNull()
		.references(() => sources.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	quantity: text('quantity'),
	category: text('category'),
	checked: integer('checked', { mode: 'boolean' }).notNull().default(false),
	// 'YYYY-MM-DD', not a timestamp — a Todoist due date carries no time component, and
	// datetime.ts's own header comment documents exactly why that must never become an
	// epoch: "the classic failure is to treat an all-day event as midnight-UTC," which in
	// America/Toronto lands on the previous day. This was originally a timestamp_ms column
	// (unused by groceries, pre-provisioned for tasks); corrected to text before anything
	// ever wrote to it, per the same reasoning already applied to events.localDate.
	dueDate: text('due_date'),
	// Todoist's own project id, tasks-only (groceries leaves this null). Deliberately
	// separate from `category` (the resolved, human-readable project *name* — display
	// only, refreshed every reconcile the same way AnyList category names are): the
	// per-user task access filter (tasks.ts's buildTasksSnapshot) filters on this stable
	// id, never on the name, since a Todoist project rename would otherwise silently break
	// who sees what.
	projectId: text('project_id'),
	position: integer('position').notNull().default(0),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

// Grocery writes are queued, never applied straight through — DESIGN.md §6.1. A
// worker drains this against the AnyList adapter with exponential backoff.
export const pendingWrites = sqliteTable('pending_writes', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	sourceId: integer('source_id')
		.notNull()
		.references(() => sources.id, { onDelete: 'cascade' }),
	action: text('action', { enum: ['add', 'check', 'uncheck', 'remove'] }).notNull(),
	payload: text('payload').notNull(), // json
	attempts: integer('attempts').notNull().default(0),
	lastError: text('last_error'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	// docs/phase-5-plan.md §4: without this, backoff state lives only in memory, and since
	// the Pi restarts on every deploy, a failing queue would re-hammer AnyList immediately
	// on every boot. Nullable rather than NOT NULL — not because a row is ever meant to
	// have one unset (the queue always sets it explicitly, 'now' on enqueue, pushed
	// forward on each failed attempt), but because SQLite's ALTER TABLE ADD COLUMN
	// rejects NOT NULL without a DEFAULT the moment the table holds any row, and this
	// table's whole point is to hold rows. NULL is queried as "eligible now", same as an
	// explicit past timestamp would be.
	nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' })
});

// Screensaver source. `cached_path` points at the resized derivative on the NAS
// (DESIGN.md §6); `source_path` is the original under pictures/, never written to.
export const photos = sqliteTable(
	'photos',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		sourcePath: text('source_path').notNull().unique(),
		mtime: integer('mtime', { mode: 'timestamp_ms' }).notNull(),
		size: integer('size').notNull(),
		cachedPath: text('cached_path').notNull(),
		// Of the derivative, after the EXIF orientation has been applied — measuring before
		// the rotation reports a phone portrait as landscape. See DESIGN.md §6.
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		orientation: text('orientation', { enum: ['landscape', 'portrait'] }).notNull(),
		blurHash: text('blur_hash'),
		takenAt: integer('taken_at', { mode: 'timestamp_ms' }),
		shownCount: integer('shown_count').notNull().default(0),
		lastShown: integer('last_shown', { mode: 'timestamp_ms' }),
		// Which NAS source directory this came from (HEARTH_PHOTOS_DIR vs
		// HEARTH_GUEST_PHOTOS_DIR, scripts/resize-photos.mjs) and therefore which
		// screensaver mode may ever show it — DESIGN.md §5/§6. Defaults to 'family' so
		// every row scanned before this column existed backfills correctly.
		kind: text('kind', { enum: ['family', 'guest'] })
			.notNull()
			.default('family')
	},
	(table) => [index('photos_rotation').on(table.kind, table.orientation, table.lastShown)]
);

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

// docs/phase-7-music-plan.md — one folder on the NAS's HEARTH_MUSIC_DIR is one playlist.
// Populated entirely by scripts/scan-music.mjs (mirrors resize-photos.mjs's walk-and-diff
// shape); the app itself never touches the NAS filesystem, same separation as photos.
export const musicFolders = sqliteTable('music_folders', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	displayName: text('display_name').notNull(),
	folderPath: text('folder_path').notNull().unique() // relative to HEARTH_MUSIC_DIR
});

// One row per audio file. `sourcePath` is the original NAS path and doubles as the
// servable path — unlike photos, there's no resize/derivative step, so there is no
// separate `cachedPath`. `(sourcePath, mtime, size)` is the same change-detection key
// photos uses to avoid re-processing unchanged files on every scan.
export const musicTracks = sqliteTable('music_tracks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	folderId: integer('folder_id')
		.notNull()
		.references(() => musicFolders.id, { onDelete: 'cascade' }),
	sourcePath: text('source_path').notNull().unique(),
	mtime: integer('mtime', { mode: 'timestamp_ms' }).notNull(),
	size: integer('size').notNull(),
	title: text('title').notNull(), // filename minus extension — no ID3 parsing (see plan)
	// The one piece of ID3 metadata this app does read: an embedded APIC cover image,
	// extracted to its own cached file by scripts/lib/music-cover.mjs (same
	// extract-once-at-scan-time shape as photos' resized derivatives) — null when the file
	// has no embedded picture.
	coverPath: text('cover_path')
});

// The household's fixed, hand-configured list of Cast targets — individual speakers and
// speaker groups alike. Stores the Cast *friendly name*, not a network address: a speaker
// group's connectable host can shift (its identity is anchored to whichever member is
// currently the group's leader), so the address is always re-resolved via mDNS at play
// time (src/lib/server/googleCast/discovery.ts) rather than cached here.
export const musicSpeakers = sqliteTable('music_speakers', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	castName: text('cast_name').notNull().unique()
});
