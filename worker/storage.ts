/**
 * Helpers for a Durable Object's SQLite storage: versioned schema migrations, and counters
 * of the rows each operation reads and writes (the unit Durable Objects bill by).
 */

/** One schema change. Versions start at 1 and never change once released. */
export interface Migration {
	readonly version: number;
	readonly description: string;
	/** Runs in the migration's transaction; `storage` also gives the key-value API. */
	readonly up: (sql: SqlStorage, storage: DurableObjectStorage) => void;
}

/** Where the schema version is kept (key-value storage). */
export const SCHEMA_VERSION_KEY = "schema.version";

/**
 * Applies the migrations newer than the stored schema version, each in its own
 * transaction together with the new version number. Run it in the constructor inside
 * `blockConcurrencyWhile`, so that no request sees a half-migrated schema.
 *
 * Migrations must be additive, so that a rollback to older code keeps working on the newer
 * schema: add tables and nullable (or defaulted) columns; never rename, drop or change the
 * meaning of what older code reads or writes; always name columns in INSERT and SELECT.
 * When the stored version is newer than the code knows, this logs a warning and leaves the
 * schema as it is.
 *
 * The version is kept in the synchronous KV API, because Durable Objects do not allow
 * `PRAGMA user_version`. Returns the number of migrations applied.
 *
 * @throws Error if `migrations` is not numbered 1, 2, 3, …
 */
export function migrate(storage: DurableObjectStorage, migrations: readonly Migration[]): number {
	migrations.forEach((migration, index) => {
		if (migration.version !== index + 1) {
			throw new Error(`Migration ${index} has version ${migration.version}; expected ${index + 1}`);
		}
	});
	const current = schemaVersion(storage) ?? 0;
	if (current > migrations.length) {
		console.warn(
			`Storage schema version ${current} is newer than this code knows (${migrations.length}), ` +
				"probably after a rollback. Continuing: migrations are additive.",
		);
		return 0;
	}
	const pending = migrations.slice(current);
	for (const migration of pending) {
		storage.transactionSync(() => {
			migration.up(storage.sql, storage);
			storage.kv.put(SCHEMA_VERSION_KEY, migration.version);
		});
	}
	return pending.length;
}

/**
 * The stored schema version, or `undefined` when the object has never been migrated. Reading
 * it does not create storage, so an object can check whether it has data without bringing
 * an empty database into existence.
 */
export function schemaVersion(storage: DurableObjectStorage): number | undefined {
	return storage.kv.get<number>(SCHEMA_VERSION_KEY);
}

/** Rows read and written, as reported by SQL cursors, plus key-value and alarm writes. */
export interface StorageUsage {
	rowsRead: number;
	rowsWritten: number;
}

/**
 * Key under which a Durable Object exposes its {@link StorageUsage} to tests. A symbol, so
 * that it is not reachable over RPC.
 */
export const STORAGE_USAGE: unique symbol = Symbol("storageUsage");

/**
 * Thin wrapper around `ctx.storage` that counts rows. SQL counts come from each cursor's
 * `rowsRead`/`rowsWritten` (which include index updates). Each `setAlarm()`,
 * `deleteAlarm()` and key-value `put()` is counted as one written row.
 */
export class MeteredStorage {
	readonly usage: StorageUsage = { rowsRead: 0, rowsWritten: 0 };
	readonly storage: DurableObjectStorage;

	constructor(storage: DurableObjectStorage) {
		this.storage = storage;
	}

	/** Runs a statement and returns all rows. */
	all<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
		const cursor = this.storage.sql.exec<T>(query, ...bindings);
		const rows = cursor.toArray();
		this.usage.rowsRead += cursor.rowsRead;
		this.usage.rowsWritten += cursor.rowsWritten;
		return rows;
	}

	/** Runs a statement and returns its first row, if any. */
	first<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T | undefined {
		return this.all<T>(query, ...bindings)[0];
	}

	/** Runs a statement that returns no rows, and returns the rows it wrote. */
	run(query: string, ...bindings: unknown[]): number {
		const before = this.usage.rowsWritten;
		this.all(query, ...bindings);
		return this.usage.rowsWritten - before;
	}

	kvGet<T>(key: string): T | undefined {
		this.usage.rowsRead += 1;
		return this.storage.kv.get<T>(key);
	}

	kvPut(key: string, value: unknown): void {
		this.usage.rowsWritten += 1;
		this.storage.kv.put(key, value);
	}

	transaction<T>(closure: () => T): T {
		return this.storage.transactionSync(closure);
	}

	getAlarm(): Promise<number | null> {
		return this.storage.getAlarm();
	}

	async setAlarm(at: number): Promise<void> {
		this.usage.rowsWritten += 1;
		await this.storage.setAlarm(at);
	}

	async deleteAlarm(): Promise<void> {
		this.usage.rowsWritten += 1;
		await this.storage.deleteAlarm();
	}
}
