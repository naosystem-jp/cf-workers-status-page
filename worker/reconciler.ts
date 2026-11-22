import { DurableObject } from "cloudflare:workers";
import type { LocationHint } from "@naosystem/cf-workers-status-page-core";
import { config } from "./config";
import { ensureSchema } from "./db/schema";
import { type MonitorSnapshot, monitorStub, type PurgeRefusal, type SyncResult } from "./monitor";
import { evaluateUnknown } from "./notifications/unknown";
import { type Migration, migrate } from "./storage";

/**
 * Starting and stopping Monitor DOs after a deploy, and the registry of
 * every monitor the hub has run.
 *
 * Workers have no hook that runs once per deploy, so the hub compares the running version
 * (`CF_VERSION_METADATA.id`) with the versions it has reconciled. For a new version it asks
 * every Monitor DO to `sync()` with its configuration: configured monitors start (or resume,
 * or pick up a new interval), and monitors that left the configuration stop, keeping their
 * data. This runs from the every-minute Cron and, in the background, on requests.
 *
 * State lives in this small singleton Durable Object:
 * - it survives isolate restarts, unlike a module variable; D1 belongs to the admin API's
 *   schema, and KV is eventually consistent;
 * - work for one version is serialised and shared, so the many isolates that see a new
 *   version at once after a deploy trigger a single sweep;
 * - the registry of monitors (including removed ones, whose data stays until an
 *   administrator purges it) is the list the admin API shows.
 *
 * The Reconciler does not use its own configuration: callers send the monitor list of the
 * version they run, and each Monitor DO decides by the version *it* runs. So during a
 * gradual deployment both versions reconcile at once, each with its own list, and nothing
 * waits for the rollout to finish. Cloudflare keeps each Durable Object on one version for
 * the length of a deployment, so a monitor's object does not flip between configurations;
 * an object that runs the other version answers for that version, and the sweep retries it
 * with backoff until it runs the caller's.
 *
 * The every-minute Cron calls {@link Reconciler.cron}, which also reads the monitors the
 * `unknown` check needs: only those that could have become late since they were
 * last read (see `cron`), so that the check does not cost a Durable Object request per
 * monitor per minute.
 */

/** Name of the single Reconciler object. */
const RECONCILER_NAME = "hub";
/**
 * After a complete sweep, the Cron sweeps every monitor again this often. `sync()` writes
 * nothing when a monitor is running, so this is cheap, and it restarts a monitor whose alarm
 * chain broke (for example, when storage writes failed for longer than the alarm's retries,
 * such as at the Free plan's daily write limit).
 */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Monitors that failed are retried after 1, 2, 4 … minutes, at most `SWEEP_INTERVAL_MS` apart. */
const RETRY_BASE_MS = 60_000;
/** Monitor DOs called at once during a sweep. */
const SWEEP_CONCURRENCY = 8;
/** Sweep records kept, newest first: the current version and the ones before it. */
const SWEEPS_KEPT = 3;

export interface MonitorEntry {
	readonly id: string;
	/** The monitor's location hint in the caller's configuration. */
	readonly location: LocationHint | null;
	/** The monitor's `timeout` in the caller's configuration, for the lateness threshold. */
	readonly timeoutMs: number;
}

export interface ReconcileRequest {
	/** The version the caller runs. */
	readonly versionId: string;
	/** The monitors in that version's configuration. */
	readonly monitors: readonly MonitorEntry[];
	/** From the Cron: also sweep every monitor when the last sweep is older than {@link SWEEP_INTERVAL_MS}. */
	readonly periodic: boolean;
}

export interface SweepFailure {
	readonly monitorId: string;
	readonly reason: string;
}

export interface CronRequest extends Omit<ReconcileRequest, "periodic"> {
	/** Whether this run looks for `unknown` monitors (`notifications.unknownCheckInterval`). */
	readonly unknownCheck: boolean;
	/**
	 * Monitors to read whatever their deadline: those administrators were told are unknown (to
	 * see them recover), and those with a `down` held back by maintenance.
	 */
	readonly alwaysRead: readonly string[];
}

export interface CronReport {
	readonly reconcile: ReconcileReport;
	/**
	 * Snapshots of the configured monitors read during this call, by the sweep or for the
	 * `unknown` check. A configured monitor without one could not have become late since it
	 * was last read.
	 */
	readonly snapshots: readonly MonitorSnapshot[];
	/** Monitor DOs called for snapshots (not counting the sweep's syncs). */
	readonly reads: number;
	readonly readFailures: readonly SweepFailure[];
	/**
	 * Monitors whose Durable Object could not be read although it could have become `unknown`
	 * by now (its deadline has passed, or, with none known, reads failed {@link UNREACHABLE_AFTER}
	 * times in a row): `unknown` too, since it cannot be checked. `since` is the deadline,
	 * or the first failure; it stays the same while reads keep failing.
	 */
	readonly unreachable: readonly { readonly monitorId: string; readonly since: number }[];
}

/** Failed reads in a row after which a monitor whose deadline is not known counts as unreachable. */
export const UNREACHABLE_AFTER = 3;

export type ReconcileReport =
	/** This version is reconciled, and no sweep is due. */
	| { readonly status: "up-to-date" }
	/** Some monitors failed earlier; they are retried at `nextAttemptAt`, not before. */
	| { readonly status: "waiting"; readonly nextAttemptAt: number }
	| {
			/** `incomplete`: some monitors failed and are retried at `nextAttemptAt`. */
			readonly status: "reconciled" | "incomplete";
			readonly versionId: string;
			/** Monitors synced by this sweep. */
			readonly synced: number;
			readonly started: string[];
			readonly stopped: string[];
			readonly failures: SweepFailure[];
			readonly nextAttemptAt: number | null;
	  };

/** A monitor the hub has run. Removed monitors stay listed until purged. */
export interface RegisteredMonitor {
	readonly id: string;
	/** `active`: its object runs checks. `removed`: it left the configuration; its data is kept. */
	readonly status: "active" | "removed";
	/** The location hint its object was created with. */
	readonly location: LocationHint | null;
	readonly firstSeenAt: number;
	readonly statusChangedAt: number;
}

export interface PurgeMonitorRequest {
	readonly id: string;
	/** The version the caller (the admin API) runs. */
	readonly versionId: string;
	/** The monitor IDs in that version's configuration. */
	readonly configuredIds: readonly string[];
}

export type PurgeMonitorResult =
	| { readonly status: "purged" }
	| { readonly status: "not-found" }
	| { readonly status: "refused"; readonly reason: string; readonly code?: PurgeRefusal };

const RECONCILER_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		description: "monitor registry and sweep progress",
		up(sql) {
			// WITHOUT ROWID: a TEXT primary key would otherwise add an index, and a row per write.
			sql.exec(`
				CREATE TABLE monitors (
					id TEXT PRIMARY KEY,
					status TEXT NOT NULL,
					location TEXT,
					first_seen_at INTEGER NOT NULL,
					status_changed_at INTEGER NOT NULL
				) WITHOUT ROWID
			`);
			// One row per version: monitors still to sync and when to try them again, and when
			// every monitor was last swept.
			sql.exec(`
				CREATE TABLE sweeps (
					version_id TEXT PRIMARY KEY,
					pending TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					next_attempt_at INTEGER NOT NULL,
					full_sweep_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				) WITHOUT ROWID
			`);
		},
	},
];

type RegistryRow = {
	id: string;
	status: RegisteredMonitor["status"];
	location: LocationHint | null;
	first_seen_at: number;
	status_changed_at: number;
};
type SweepRow = {
	version_id: string;
	pending: string;
	attempts: number;
	next_attempt_at: number;
	full_sweep_at: number;
};

/** Runs `task` for each item, at most `limit` at a time. */
export async function forEachLimited<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = [];
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			try {
				results[index] = { status: "fulfilled", value: await task(items[index] as T) };
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** Keeps the registry of monitors and reconciles Monitor DOs with each deployed version. */
export class Reconciler extends DurableObject<Env> {
	/** Sweeps in progress, per version. */
	private readonly sweeps = new Map<string, Promise<ReconcileReport>>();
	/** Per monitor ID: the tail of the operations (a sync and its registry update, or a purge) queued for it. */
	private readonly locks = new Map<string, Promise<void>>();
	/**
	 * Per monitor ID: the earliest time it can become `unknown` without a new result, from its
	 * latest snapshot (`evaluateUnknown`). In memory only: after a restart every monitor is
	 * read once. Writing it would cost rows on every read.
	 */
	private readonly checkAgainAt = new Map<string, number>();
	/** Per monitor ID: failed reads in a row, and when the first of them happened. */
	private readonly readFailureRuns = new Map<string, { readonly count: number; readonly since: number }>();
	/** Snapshots the sweeps got from `sync()`, with when, for the `cron` call that triggered them. */
	private readonly swept = new Map<string, { readonly snapshot: MonitorSnapshot; readonly at: number }>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			migrate(ctx.storage, RECONCILER_MIGRATIONS);
		});
	}

	/**
	 * Syncs the Monitor DOs that this version has not synced yet: every monitor the first
	 * time the version calls, then only those that failed, with backoff. Independently of
	 * that, the Cron sweeps every monitor every {@link SWEEP_INTERVAL_MS}, even while some
	 * stay pending, so that a monitor whose alarm chain broke is restarted. Concurrent calls
	 * for a version share the sweep in progress, so the number of callers does not multiply
	 * the work.
	 */
	async reconcile(request: ReconcileRequest): Promise<ReconcileReport> {
		const inProgress = this.sweeps.get(request.versionId);
		if (inProgress !== undefined) return inProgress;

		const now = Date.now();
		const sweep = this.sql
			.exec<SweepRow>(
				"SELECT version_id, pending, attempts, next_attempt_at, full_sweep_at FROM sweeps WHERE version_id = ?",
				request.versionId,
			)
			.toArray()[0];
		let targets: string[];
		let full: boolean;
		if (sweep === undefined || (request.periodic && now - sweep.full_sweep_at >= SWEEP_INTERVAL_MS)) {
			targets = this.everyMonitor(request);
			full = true;
		} else {
			const pending = JSON.parse(sweep.pending) as string[];
			if (pending.length === 0) return { status: "up-to-date" };
			if (now < sweep.next_attempt_at) return { status: "waiting", nextAttemptAt: sweep.next_attempt_at };
			targets = pending;
			full = false;
		}

		const run = this.sweep(request, targets, full, sweep).finally(() => {
			this.sweeps.delete(request.versionId);
		});
		this.sweeps.set(request.versionId, run);
		return run;
	}

	/**
	 * The every-minute Cron: reconciles (as `reconcile` with `periodic`), then reads the
	 * snapshots the `unknown` check needs: the monitors in `alwaysRead`, and, when
	 * `unknownCheck`, every configured monitor whose deadline has passed. A monitor's deadline is
	 * the earliest time it could become late or stay unconfirmed too long, from its latest
	 * snapshot, so a monitor that is not read cannot have become unknown meanwhile; a healthy
	 * monitor checked every minute is read about every three minutes, and the sweep's syncs
	 * (every 10 minutes) refresh deadlines at no extra cost.
	 */
	async cron(request: CronRequest): Promise<CronReport> {
		const startedAt = Date.now();
		const report = await this.reconcile({ ...request, periodic: true });
		const configured = new Map(request.monitors.map((monitor) => [monitor.id, monitor]));
		for (const id of this.checkAgainAt.keys()) if (!configured.has(id)) this.checkAgainAt.delete(id);

		const snapshots = new Map<string, MonitorSnapshot>();
		for (const [id, entry] of this.swept) {
			if (entry.at >= startedAt && configured.has(id)) snapshots.set(id, entry.snapshot);
		}
		this.swept.clear();

		const now = Date.now();
		const always = new Set(request.alwaysRead);
		const due = request.monitors.filter(
			(monitor) =>
				!snapshots.has(monitor.id) &&
				(always.has(monitor.id) ||
					(request.unknownCheck && (this.checkAgainAt.get(monitor.id) ?? Number.NEGATIVE_INFINITY) <= now)),
		);
		const settled = await forEachLimited(due, SWEEP_CONCURRENCY, async (monitor) => {
			const snapshot = (await monitorStub(this.env, monitor).getSnapshot()) as MonitorSnapshot;
			this.remember(monitor, snapshot);
			return snapshot;
		});
		const readFailures: SweepFailure[] = [];
		const unreachable: { monitorId: string; since: number }[] = [];
		settled.forEach((outcome, index) => {
			const monitorId = (due[index] as MonitorEntry).id;
			if (outcome.status === "fulfilled") {
				snapshots.set(monitorId, outcome.value);
				this.readFailureRuns.delete(monitorId);
				return;
			}
			readFailures.push({ monitorId, reason: String(outcome.reason) });
			const previous = this.readFailureRuns.get(monitorId);
			const run = { count: (previous?.count ?? 0) + 1, since: previous?.since ?? now };
			this.readFailureRuns.set(monitorId, run);
			const deadline = this.checkAgainAt.get(monitorId);
			if (deadline !== undefined ? deadline <= now : run.count >= UNREACHABLE_AFTER) {
				unreachable.push({ monitorId, since: deadline ?? run.since });
			}
		});
		for (const id of snapshots.keys()) this.readFailureRuns.delete(id);
		for (const id of this.readFailureRuns.keys()) if (!configured.has(id)) this.readFailureRuns.delete(id);
		return { reconcile: report, snapshots: [...snapshots.values()], reads: due.length, readFailures, unreachable };
	}

	/** Keeps when `monitor` next needs reading, from a snapshot just read. */
	private remember(monitor: MonitorEntry, snapshot: MonitorSnapshot): void {
		this.checkAgainAt.set(monitor.id, evaluateUnknown(snapshot, monitor.timeoutMs, Date.now()).checkAgainAt);
	}

	/** Every monitor the hub knows of, removed ones included, for the admin API. */
	listMonitors(): RegisteredMonitor[] {
		return this.sql
			.exec<RegistryRow>("SELECT id, status, location, first_seen_at, status_changed_at FROM monitors ORDER BY id")
			.toArray()
			.map((row) => ({
				id: row.id,
				status: row.status,
				location: row.location,
				firstSeenAt: row.first_seen_at,
				statusChangedAt: row.status_changed_at,
			}));
	}

	/**
	 * Deletes a removed monitor's data and its registry entry, on an administrator's request. Refused when the caller's configuration has the monitor, when the registry lists
	 * it as active, and by the Monitor DO when it runs another version than the caller (a
	 * deploy in progress) or has the monitor in its configuration. Runs one at a time with
	 * the syncs of the same monitor, so that a sweep cannot change its entry meanwhile.
	 */
	purgeMonitor(request: PurgeMonitorRequest): Promise<PurgeMonitorResult> {
		const { id } = request;
		return this.exclusive(id, async (): Promise<PurgeMonitorResult> => {
			if (request.configuredIds.includes(id)) {
				return { status: "refused", reason: "The monitor is in status.config.ts; remove it and deploy first", code: "configured" };
			}
			const row = this.registryRow(id);
			if (row === undefined) return { status: "not-found" };
			if (row.status !== "removed") {
				return { status: "refused", reason: "The monitor is still running; wait for the deploy to finish", code: "running" };
			}
			const result = await monitorStub(this.env, { id, location: row.location }).purge({
				versionId: request.versionId,
			});
			if (result.status === "refused") return result;
			this.sql.exec("DELETE FROM monitors WHERE id = ?", id);
			await forgetMonitorInD1(this.env, id);
			return { status: "purged" };
		});
	}

	/** Runs `task` after the operations already queued for monitor `id`, and before later ones. */
	private async exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(id) ?? Promise.resolve();
		let release = () => {};
		const done = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => done);
		this.locks.set(id, tail);
		try {
			await previous;
			return await task();
		} finally {
			release();
			if (this.locks.get(id) === tail) this.locks.delete(id);
		}
	}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	/** The caller's monitors, plus those the registry has as active that the caller lacks (to stop them). */
	private everyMonitor(request: ReconcileRequest): string[] {
		const listed = new Set(request.monitors.map((monitor) => monitor.id));
		const active = this.sql
			.exec<{ id: string }>("SELECT id FROM monitors WHERE status = 'active'")
			.toArray()
			.map((row) => row.id)
			.filter((id) => !listed.has(id));
		return [...listed, ...active];
	}

	private registryRow(id: string): RegistryRow | undefined {
		return this.sql
			.exec<RegistryRow>("SELECT id, status, location, first_seen_at, status_changed_at FROM monitors WHERE id = ?", id)
			.toArray()[0];
	}

	private setStatus(row: RegistryRow, status: RegistryRow["status"], now: number): void {
		if (row.status === status) return;
		this.sql.exec("UPDATE monitors SET status = ?, status_changed_at = ? WHERE id = ?", status, now, row.id);
	}

	/** Updates the registry from a Monitor DO's own answer: it, not the caller, knows its configuration. Writes only on change. */
	private record(id: string, result: SyncResult, now: number): void {
		const row = this.registryRow(id);
		const status = result.configured ? "active" : "removed";
		if (row === undefined) {
			if (result.status === "absent") return;
			this.sql.exec(
				"INSERT INTO monitors (id, status, location, first_seen_at, status_changed_at) VALUES (?, ?, ?, ?, ?)",
				id,
				status,
				result.location,
				now,
				now,
			);
		} else {
			this.setStatus(row, status, now);
		}
	}

	private async sweep(
		request: ReconcileRequest,
		targets: readonly string[],
		full: boolean,
		previous: SweepRow | undefined,
	) {
		const listed = new Map(request.monitors.map((monitor) => [monitor.id, monitor.location]));
		// Each sync and the registry update from its answer run together, apart from a purge.
		const settled = await forEachLimited(targets, SWEEP_CONCURRENCY, (id) =>
			this.exclusive(id, async () => {
				const location = listed.has(id) ? (listed.get(id) ?? null) : (this.registryRow(id)?.location ?? null);
				const result = await monitorStub(this.env, { id, location }).sync({ location });
				const wasActive = this.registryRow(id)?.status === "active";
				this.record(id, result, Date.now());
				const entry = request.monitors.find((monitor) => monitor.id === id);
				if (result.snapshot !== null && entry !== undefined && result.versionId === request.versionId) {
					// A sync is as good as a read for the `unknown` check (see `cron`).
					this.remember(entry, result.snapshot);
					this.swept.set(id, { snapshot: result.snapshot, at: Date.now() });
				}
				return { result, wasActive };
			}),
		);

		const now = Date.now();
		const started: string[] = [];
		const stopped: string[] = [];
		const failures: SweepFailure[] = [];
		settled.forEach((outcome, index) => {
			const monitorId = targets[index] as string;
			if (outcome.status === "rejected") {
				failures.push({ monitorId, reason: String(outcome.reason) });
				return;
			}
			const { result, wasActive } = outcome.value;
			if (result.versionId !== request.versionId) {
				// The object runs another version (a rollout in progress, or an active object that
				// has not adopted new code yet); it answered for that version. Try again later.
				failures.push({ monitorId, reason: `its Durable Object runs version ${result.versionId}` });
			} else if (result.configured !== listed.has(monitorId)) {
				failures.push({ monitorId, reason: "its Durable Object disagrees about whether it is configured" });
			} else if (result.status === "started" || result.status === "resumed") {
				started.push(monitorId);
			} else if (result.status === "stopped" && wasActive) {
				stopped.push(monitorId);
			}
		});

		const attempts = failures.length === 0 ? 0 : (previous?.attempts ?? 0) + 1;
		const nextAttemptAt =
			failures.length === 0 ? null : now + Math.min(SWEEP_INTERVAL_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
		this.sql.exec(
			`INSERT INTO sweeps (version_id, pending, attempts, next_attempt_at, full_sweep_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (version_id) DO UPDATE SET pending = excluded.pending, attempts = excluded.attempts,
				next_attempt_at = excluded.next_attempt_at, full_sweep_at = excluded.full_sweep_at,
				updated_at = excluded.updated_at`,
			request.versionId,
			JSON.stringify(failures.map((failure) => failure.monitorId)),
			attempts,
			nextAttemptAt ?? now,
			full ? now : (previous?.full_sweep_at ?? now),
			now,
		);
		this.sql.exec(
			`DELETE FROM sweeps WHERE version_id NOT IN (
				SELECT version_id FROM sweeps ORDER BY updated_at DESC LIMIT ?
			)`,
			SWEEPS_KEPT,
		);

		if (started.length > 0) console.log(`Started monitors: ${started.join(", ")}`);
		if (stopped.length > 0) console.log(`Stopped monitors no longer in status.config.ts: ${stopped.join(", ")}`);
		for (const failure of failures) {
			console.warn(`Could not sync monitor "${failure.monitorId}": ${failure.reason}`);
		}
		return {
			status: failures.length === 0 ? "reconciled" : "incomplete",
			versionId: request.versionId,
			synced: targets.length,
			started,
			stopped,
			failures,
			nextAttemptAt,
		} satisfies ReconcileReport;
	}
}

/**
 * Deletes what notifications and automatic incidents keep in D1 about a purged monitor:
 * its automatic incident state, `unknown` alert and held-back `down`. Its incidents and
 * delivery records stay (they are the history; deliveries expire). A failure is logged: the
 * monitor's data is gone anyway, and the rows only matter if a monitor with the same ID returns.
 */
async function forgetMonitorInD1(env: Env, monitorId: string): Promise<void> {
	try {
		await ensureSchema(env.DB);
		await env.DB.batch(
			["auto_incident_monitors", "unknown_alerts", "suppressed_downs"].map((table) =>
				env.DB.prepare(`DELETE FROM ${table} WHERE monitor_id = ?`).bind(monitorId),
			),
		);
	} catch (error) {
		console.warn(`Monitor "${monitorId}" was purged, but its rows in D1 could not be deleted`, error);
	}
}

/** The Reconciler, for the Worker and the admin API (`listMonitors`, `purgeMonitor`). */
export function reconcilerStub(env: Env) {
	return env.RECONCILER.getByName(RECONCILER_NAME);
}

/**
 * Asks the Reconciler to delete a removed monitor's data, on behalf of the version the
 * caller runs. For the admin API (`DELETE /api/admin/monitors/:id`).
 */
export function purgeMonitor(env: Env, id: string): Promise<PurgeMonitorResult> {
	return reconcilerStub(env).purgeMonitor({
		id,
		versionId: env.CF_VERSION_METADATA.id,
		configuredIds: config.monitors.map((monitor) => monitor.id),
	});
}

/** The monitors of the version the caller runs, as the Reconciler takes them. */
export function configuredMonitors(): MonitorEntry[] {
	return config.monitors.map((monitor) => ({
		id: monitor.id,
		location: monitor.location ?? null,
		timeoutMs: monitor.timeoutMs,
	}));
}

/** Asks the Reconciler to reconcile the version the caller runs, with that version's monitors. */
export function reconcile(env: Env, trigger: "cron" | "request"): Promise<ReconcileReport> {
	return reconcilerStub(env).reconcile({
		versionId: env.CF_VERSION_METADATA.id,
		monitors: configuredMonitors(),
		periodic: trigger === "cron",
	});
}

/** After a failed attempt, requests wait this long before asking again. */
const REQUEST_RETRY_MS = 60_000;

/**
 * Reconciles on incoming requests without adding latency: the call runs in
 * `waitUntil`, and once the running version is reconciled, this isolate stops asking (the
 * version cannot change within an isolate). While a sweep is incomplete it asks again only
 * when the Reconciler's next attempt is due; the Reconciler itself limits the work.
 */
export class RequestReconciler {
	private doneVersion: string | undefined;
	private inFlight = false;
	private retryAt = 0;
	private readonly run: typeof reconcile;

	constructor(run: typeof reconcile = reconcile) {
		this.run = run;
	}

	trigger(env: Env, ctx: ExecutionContext): void {
		const versionId = env.CF_VERSION_METADATA.id;
		if (this.doneVersion === versionId || this.inFlight || Date.now() < this.retryAt) return;
		this.inFlight = true;
		ctx.waitUntil(
			this.run(env, "request")
				.then((report) => {
					if (report.status === "up-to-date" || report.status === "reconciled") {
						this.doneVersion = versionId;
					} else {
						this.retryAt = report.nextAttemptAt ?? Date.now() + REQUEST_RETRY_MS;
					}
				})
				.catch((error: unknown) => {
					this.retryAt = Date.now() + REQUEST_RETRY_MS;
					console.error("Reconciliation failed", error);
				})
				.finally(() => {
					this.inFlight = false;
				}),
		);
	}
}
