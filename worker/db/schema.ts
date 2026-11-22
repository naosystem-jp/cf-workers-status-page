/**
 * The D1 database: operational data written from the admin UI, and its schema.
 *
 * ## How the schema is applied
 *
 * The Worker applies migrations itself, the first time an isolate uses the database
 * ({@link ensureSchema}). Neither `wrangler deploy` nor the Deploy to Cloudflare button
 * applies D1 migrations, and the documented alternative, running
 * `wrangler d1 migrations apply DB --remote` in the `deploy` script, cannot run before the
 * first deploy: the database is created by that deploy (automatic provisioning). Applying
 * them at run time also covers `npm run dev` and the tests with no extra step.
 *
 * Each migration runs as one `batch()`, which D1 executes as a transaction: the row that
 * records the migration is inserted first, so when two isolates apply the same migration at
 * once, the second one's insert fails on the primary key and its whole batch rolls back. So
 * applying is idempotent and safe to run concurrently.
 *
 * ## Rules for migrations (as for Durable Object storage)
 *
 * Append only, never edit a released one. Additive only, so that the previous version keeps
 * working during a gradual deployment or after a rollback: add tables, indexes and nullable
 * (or defaulted) columns; never rename, drop or change the meaning of what older code reads
 * or writes; always name columns in INSERT and SELECT. No CHECK constraints (SQLite cannot
 * change one without rebuilding the table); values are validated in code.
 *
 * Times are epoch milliseconds (INTEGER), as in the Durable Objects.
 */

export interface D1Migration {
	/** 1, 2, 3, … in order. Never reused. */
	readonly version: number;
	readonly name: string;
	/** Statements run together in one transaction, without bindings. */
	readonly statements: readonly string[];
}

export const MIGRATIONS_TABLE = "schema_migrations";

export const D1_MIGRATIONS: readonly D1Migration[] = [
	{
		version: 1,
		name: "incidents, maintenance and page appearance",
		statements: [
			// One row per incident. `started_at` is when the incident began, which an
			// administrator may set in the past (never in the future): history and uptime
			// use it, while `created_at` is when it was written. `stage` is the stage of the
			// latest update, kept here so that lists need no join. `components` is a JSON array of
			// { id, impact }: the affected components of the page and their impact, read and
			// written as a whole. `resolved_at` is NULL while the incident is open.
			// `created_by`/`updated_by` are the administrators (NULL for automation);
			// `auto_created` marks incidents published by `incidents.auto`, and `human_edited_at`
			// the last change by an administrator (set at creation by one), which automation must
			// respect (never auto-resolve those). `version` counts changes to what an editor
			// edits (title, components) for optimistic concurrency.
			`CREATE TABLE incidents (
				id TEXT PRIMARY KEY,
				page_id TEXT NOT NULL,
				title TEXT NOT NULL,
				stage TEXT NOT NULL,
				components TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				resolved_at INTEGER,
				created_by TEXT,
				updated_by TEXT,
				auto_created INTEGER NOT NULL DEFAULT 0,
				human_edited_at INTEGER,
				version INTEGER NOT NULL DEFAULT 1
			)`,
			// A page's incidents by start, newest first: the admin list and the public history.
			"CREATE INDEX incidents_by_page_start ON incidents (page_id, started_at, id)",
			// A page's open incidents (resolved_at IS NULL): what the public page shows.
			"CREATE INDEX incidents_by_page_resolved ON incidents (page_id, resolved_at)",
			// The timeline: each update has a message and the stage it moved the incident to.
			// `author` is NULL and `automated` 1 for updates posted by automation.
			`CREATE TABLE incident_updates (
				id TEXT PRIMARY KEY,
				incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
				stage TEXT NOT NULL,
				body TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				author TEXT,
				automated INTEGER NOT NULL DEFAULT 0
			)`,
			"CREATE INDEX incident_updates_by_incident ON incident_updates (incident_id, created_at)",
			// Scheduled maintenance (shown on top of the state, never a state itself; suppresses notifications). `components` is a JSON array of component IDs.
			`CREATE TABLE maintenances (
				id TEXT PRIMARY KEY,
				page_id TEXT NOT NULL,
				title TEXT NOT NULL,
				body TEXT NOT NULL,
				components TEXT NOT NULL,
				starts_at INTEGER NOT NULL,
				ends_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				created_by TEXT,
				updated_by TEXT,
				version INTEGER NOT NULL DEFAULT 1
			)`,
			// A page's maintenance by start, latest first: the admin list.
			"CREATE INDEX maintenances_by_page_start ON maintenances (page_id, starts_at, id)",
			// A page's current and upcoming maintenance (ends_at > now): the public page.
			"CREATE INDEX maintenances_by_page_end ON maintenances (page_id, ends_at)",
			// Per page, what identifies it to visitors, in one language. Every field is
			// optional; a page without a row uses defaults (version 0). New fields are added as
			// nullable columns.
			`CREATE TABLE page_appearance (
				page_id TEXT PRIMARY KEY,
				title TEXT,
				description TEXT,
				logo_url TEXT,
				website_url TEXT,
				updated_at INTEGER NOT NULL,
				updated_by TEXT,
				version INTEGER NOT NULL DEFAULT 1
			)`,
		],
	},
	{
		version: 2,
		name: "notification targets, deliveries and automation state",
		statements: [
			// Where notifications go, managed in the admin UI. `options` is a JSON object of
			// the kind's options that are not secret, as entered; `secrets` a JSON object of the
			// secret ones, each encrypted (worker/notifications/crypto.ts). `events` is a JSON
			// array of the events it receives; `monitors` (IDs) and `components` ({ pageId,
			// componentId }) are JSON arrays that select monitors unless `all_monitors`. `admin`
			// marks administrators' targets, which also receive `unknown`.
			`CREATE TABLE notification_targets (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				kind TEXT NOT NULL,
				options TEXT NOT NULL,
				secrets TEXT NOT NULL,
				admin INTEGER NOT NULL DEFAULT 0,
				enabled INTEGER NOT NULL DEFAULT 1,
				events TEXT NOT NULL,
				all_monitors INTEGER NOT NULL DEFAULT 1,
				monitors TEXT NOT NULL,
				components TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				created_by TEXT,
				updated_by TEXT,
				version INTEGER NOT NULL DEFAULT 1
			)`,
			// One row per notification × target: checked before sending so that a
			// duplicate queue message is dropped, and listed by the admin UI when `failed`.
			// `status`: sending (claimed until `lease_until`), sent, retrying or failed.
			// WITHOUT ROWID: stored in its primary key, so a write is one row, not two.
			`CREATE TABLE notification_deliveries (
				notification_id TEXT NOT NULL,
				target_id TEXT NOT NULL,
				status TEXT NOT NULL,
				event TEXT NOT NULL,
				monitor_id TEXT,
				occurred_at INTEGER NOT NULL,
				attempts INTEGER NOT NULL,
				lease_until INTEGER,
				last_error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (notification_id, target_id)
			) WITHOUT ROWID`,
			// Failed deliveries, latest first, for the admin UI; old rows by age, for clean-up.
			"CREATE INDEX notification_deliveries_by_status ON notification_deliveries (status, updated_at)",
			// Monitors whose `unknown` administrators were notified of: one row while the
			// monitor stays unknown, so that the every-minute Cron notifies once. Kept in D1 so that
			// it works while Durable Objects cannot write.
			`CREATE TABLE unknown_alerts (
				monitor_id TEXT PRIMARY KEY,
				since INTEGER NOT NULL,
				reason TEXT NOT NULL,
				notified_at INTEGER NOT NULL
			) WITHOUT ROWID`,
			// A monitor's latest confirmed `down` whose notifications maintenance suppressed: the Cron notifies it when the maintenance ends and the monitor is still down.
			// `event` is the event as JSON.
			`CREATE TABLE suppressed_downs (
				monitor_id TEXT PRIMARY KEY,
				since INTEGER NOT NULL,
				event TEXT NOT NULL,
				suppressed_at INTEGER NOT NULL
			) WITHOUT ROWID`,
			// Automatic incidents (`incidents.auto`), per page × monitor: the start of the
			// latest state applied (`last_since`, so that duplicate and older events are ignored),
			// that state, and the incident its `down` was announced in. `claim` is the token of the
			// event that last changed the row: the incident writes of an event take effect only
			// together with its claim (see worker/notifications/auto-incidents.ts).
			`CREATE TABLE auto_incident_monitors (
				page_id TEXT NOT NULL,
				monitor_id TEXT NOT NULL,
				last_since INTEGER NOT NULL,
				last_state TEXT NOT NULL,
				incident_id TEXT,
				claim TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (page_id, monitor_id)
			) WITHOUT ROWID`,
			"CREATE INDEX auto_incident_monitors_by_incident ON auto_incident_monitors (incident_id)",
		],
	},
	{
		version: 3,
		name: "indexes that bound public reads",
		statements: [
			// A page's resolved incidents by start: the public incident list reads exactly one page
			// of rows, however many unresolved incidents sit between them in incidents_by_page_start.
			"CREATE INDEX incidents_resolved_by_page_start ON incidents (page_id, started_at, id) WHERE resolved_at IS NOT NULL",
			// A page's incidents by last change: the history reads only what changed since its last
			// read (worker/status-page.ts), not every incident of its 90 days, every 5 minutes.
			"CREATE INDEX incidents_by_page_updated ON incidents (page_id, updated_at)",
		],
	},
	{
		version: 4,
		name: "uploaded images and colours of a page",
		statements: [
			// The IDs of the page's uploaded logo and favicon (random, with the extension), whose bytes are
			// in R2 (`UPLOADS`, worker/uploads.ts). NULL: none.
			"ALTER TABLE page_appearance ADD COLUMN logo_image TEXT",
			"ALTER TABLE page_appearance ADD COLUMN favicon_image TEXT",
			// The page's colours as JSON ({ light, dark }, each { background, header, accent } of
			// "#rrggbb" or null; shared/admin-api.ts). NULL: the template's throughout.
			"ALTER TABLE page_appearance ADD COLUMN colors TEXT",
		],
	},
];

async function appliedVersion(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT max(version) AS version FROM ${MIGRATIONS_TABLE}`).first<{ version: number | null }>();
	return row?.version ?? 0;
}

/**
 * Applies the migrations that `db` lacks, in order. Idempotent and safe to run from several
 * isolates at once (see the module documentation). When the database is newer than this code
 * (after a rollback), logs a warning and changes nothing. Returns the versions it applied.
 * @throws Error if `migrations` is not numbered 1, 2, 3, …, or a migration fails.
 */
export async function migrateD1(db: D1Database, migrations: readonly D1Migration[] = D1_MIGRATIONS): Promise<number[]> {
	migrations.forEach((migration, index) => {
		if (migration.version !== index + 1) {
			throw new Error(`D1 migration ${index} has version ${migration.version}; expected ${index + 1}`);
		}
	});
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at INTEGER NOT NULL
			)`,
		)
		.run();
	const current = await appliedVersion(db);
	if (current > migrations.length) {
		console.warn(
			`D1 schema version ${current} is newer than this code knows (${migrations.length}), ` +
				"probably after a rollback. Continuing: migrations are additive.",
		);
		return [];
	}
	const applied: number[] = [];
	for (const migration of migrations.slice(current)) {
		try {
			await db.batch([
				db
					.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`)
					.bind(migration.version, migration.name, Date.now()),
				...migration.statements.map((statement) => db.prepare(statement)),
			]);
			applied.push(migration.version);
			console.log(`Applied D1 migration ${migration.version}: ${migration.name}`);
		} catch (error) {
			// Another isolate applied it first: our batch was rolled back as a whole.
			if ((await appliedVersion(db)) >= migration.version) continue;
			throw error;
		}
	}
	return applied;
}

let schemaReady = false;

/**
 * Resolves once the database has this code's schema. Runs {@link migrateD1} until it has
 * succeeded once in this isolate (two statements and a row or two read when there is
 * nothing to apply). Requests that arrive together each run it, rather than await one
 * in-flight promise: Workers tie I/O to the request that started it. That is safe (see
 * above). Call it
 * before any query, from every place that uses D1 (the admin API now, the public API and
 * notifications later).
 */
export async function ensureSchema(db: D1Database): Promise<void> {
	if (schemaReady) return;
	await migrateD1(db);
	schemaReady = true;
}

/** Forgets that the schema was applied; for tests that wipe the database. */
export function forgetSchema(): void {
	schemaReady = false;
}
