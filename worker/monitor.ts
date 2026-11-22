import { DurableObject } from "cloudflare:workers";
import {
	type CheckState,
	type Confirmation,
	isCheckState,
	type ConfirmedState,
	confirmState,
	type LocationHint,
	monitorTimeline,
	type Observation,
	observationsNeeded,
	type RecordedState,
	type ResolvedMonitor,
	LATE_GRACE_MS,
	type Segment,
	type StateRecord,
	staleAfterMs,
} from "@naosystem/cf-workers-status-page-core";
import { type CheckOutcome, checkError } from "./check-result";
import { aggregateLatency, type LatencyBucket } from "./latency";
import { config, findMonitor } from "./config";
import { enqueue } from "./notifications/queue";
import { eventsFromTransitions } from "./notifications/events";
import { RUNNER_GRACE_MS } from "./runners";
import {
	activeParts,
	expectedChecks,
	intersect,
	nextScheduledCheck,
	type SchedulePeriod,
	type TimeRange,
} from "./schedule";
import { MeteredStorage, type Migration, migrate, STORAGE_USAGE, type StorageUsage, schemaVersion } from "./storage";

export type { SchedulePeriod, TimeRange } from "./schedule";

// ---------------------------------------------------------------------------
// RPC types, for the Reconciler, the admin API, status pages and notifications
// ---------------------------------------------------------------------------

// The state history's types are defined in core, which computes timelines from them.
export type { RecordedState, StateRecord } from "@naosystem/cf-workers-status-page-core";

export interface SyncRequest {
	/** The location hint the caller passed to `getByName()` (see {@link monitorStub}). */
	readonly location: LocationHint | null;
}

export interface SyncResult {
	/**
	 * What the object did to match the configuration of the version it runs:
	 * - `started`: started for the first time; `resumed`: was stopped, is back in the configuration;
	 * - `running`: was already running (an interval change was applied, if any);
	 * - `stopped`: not in the configuration, so its checks are stopped (its data is kept);
	 * - `absent`: not in the configuration and has no data, so nothing was stored.
	 */
	readonly status: "started" | "resumed" | "running" | "stopped" | "absent";
	/** Whether the monitor is in the configuration of the version this object runs. */
	readonly configured: boolean;
	/** Version of the Worker this object runs (`CF_VERSION_METADATA.id`). */
	readonly versionId: string;
	/** When the alarm is set for; `null` while the alarm is running or when stopped. */
	readonly nextAlarmAt: number | null;
	/** The location hint the object was created with, once it has started. */
	readonly location: LocationHint | null;
	/** Present when the configured location differs from the one the object was created with. */
	readonly locationMismatch?: { readonly created: LocationHint | null; readonly configured: LocationHint | null };
	/**
	 * The current state, as `getSnapshot()` returns it, for a configured monitor; `null`
	 * otherwise. The Reconciler uses it to know when the monitor could next become `unknown`, so that its sweeps save it reading the monitor again.
	 */
	readonly snapshot: MonitorSnapshot | null;
}

export interface PurgeRequest {
	/** The version the caller runs: the purge is refused while this object runs another one. */
	readonly versionId: string;
}

/** Why a purge was refused, for clients to say in their language (`reason` is English). */
export type PurgeRefusal = "configured" | "running" | "deploying";

export type PurgeResult =
	| { readonly status: "purged" }
	| { readonly status: "refused"; readonly reason: string; readonly code?: PurgeRefusal };

/** The latest check of any outcome. */
export interface LastCheck {
	readonly at: number;
	readonly runner: string;
	/** `null` when the check produced no result (see `CheckError`). */
	readonly state: CheckState | null;
	readonly latencyMs: number | null;
	readonly message: string | null;
}

export interface MonitorSnapshot {
	readonly monitorId: string;
	/** Whether the monitor is in the configuration of the version this object runs. */
	readonly configured: boolean;
	/** When the monitor first started, or `null` if it never has (and nothing is stored). */
	readonly startedAt: number | null;
	/** The current schedule period: `active` with its interval, or `stopped`. */
	readonly period: SchedulePeriod | null;
	/** The latest state record: the confirmed state, or `stopped`. */
	readonly current: StateRecord | null;
	/**
	 * `lastCheck` and `lastResultAt` look back to here only: a few intervals, and never before
	 * the monitor last resumed. So reading them costs a few rows however long a monitor has
	 * failed to produce results. `null` with no data.
	 */
	readonly recentSince: number | null;
	/** The latest check since `recentSince`, of any outcome. */
	readonly lastCheck: LastCheck | null;
	/**
	 * Start of the latest check since `recentSince` that produced a state; `null` when none
	 * did. `unknown` is derived from this and the period's interval at display time;
	 * checks that keep failing to produce a result (a missing secret) make a monitor
	 * `unknown`, not `down`.
	 */
	readonly lastResultAt: number | null;
}

export interface TransitionHistory {
	/** The record in effect at `range.from` (its `since` is at or before `from`). */
	readonly atStart: StateRecord | null;
	/** Records with `since` inside `(from, to)`, oldest first. */
	readonly changes: StateRecord[];
}

export interface ResultCounts extends TimeRange {
	/** Scheduled checks the schedule periods expected in the range: the denominator of coverage. */
	readonly expected: number;
	/** Scheduled checks that produced a state: the numerator of coverage. */
	readonly scheduled: number;
	/** Scheduled checks that produced no result. */
	readonly scheduledErrors: number;
	/** Re-checks after a failure, of any outcome. Not part of coverage. */
	readonly rechecks: number;
}

export interface TimelineRequest {
	/**
	 * Ranges to describe, not overlapping, most wanted first. Each is cut at the object's
	 * current time.
	 */
	readonly ranges: readonly TimeRange[];
	/** The monitor's `timeout`, for the lateness threshold (`staleAfterMs`). */
	readonly timeoutMs: number;
	/**
	 * Once this many rows have been read, the remaining ranges are skipped (`null`). The first
	 * range is always described, so a call reads at most this plus one range's rows.
	 */
	readonly maxRows: number;
	/**
	 * Response times of the results from this time on are summed into each slice's `latency`
	 * (see latency.ts), from the rows read anyway. `null` or absent: none.
	 */
	readonly latencySince?: number | null;
}

/** What one range of {@link TimelineRequest} looks like: the input of a status page's history. */
export interface TimelineSlice extends TimeRange {
	/** Scheduled checks the schedule expected in the range: the denominator of coverage. */
	readonly expected: number;
	/** Scheduled checks in the range that produced a state: the numerator of coverage. */
	readonly obtained: number;
	/** The display state over the range (see `monitorTimeline` in core); no segment where the monitor did not run. */
	readonly segments: readonly Segment[];
	/** Response times of the range's scheduled checks since `latencySince`, in 15-minute buckets; empty without it. */
	readonly latency: readonly LatencyBucket[];
}

export interface TimelineResponse {
	/**
	 * When the monitor first started; `null` when it has no data (never started, or purged).
	 * Status pages key their cached days by it: a purged monitor that starts again is a new
	 * history.
	 */
	readonly startedAt: number | null;
	/**
	 * One per requested range, in order; `null` for those skipped for `maxRows`. `to` is where
	 * the description ends (at most now).
	 */
	readonly slices: readonly (TimelineSlice | null)[];
}

export interface RecentTransitionsRequest extends TimeRange {
	/** Records to return at most, newest first. */
	readonly limit: number;
	/**
	 * Only records with `since` after this (the newest one the caller has), instead of all
	 * of the range: a status page keeps the list and asks for what is new.
	 */
	readonly after?: number | null;
}

/** What a status page reads from a monitor in one call (one billed request) for all its views. */
export interface PageReadRequest {
	/** The monitor's `timeout`, for the lateness threshold. */
	readonly timeoutMs: number;
	/** Whether to return the current state (as `getSnapshot`). */
	readonly snapshot: boolean;
	/** History stretches, as `getTimeline`; empty for none. */
	readonly ranges: readonly TimeRange[];
	readonly maxRows: number;
	/** As `getTimeline`'s. */
	readonly latencySince?: number | null;
	/** State records for the stoppage history, as `getRecentTransitions`; `null` for none. */
	readonly transitions: RecentTransitionsRequest | null;
}

export interface PageReadResponse extends TimelineResponse {
	readonly snapshot: MonitorSnapshot | null;
	readonly transitions: RecentTransitions | null;
}

export interface RecentTransitions {
	/** The record in effect at `from`; `null` when there is none or when `truncated`. */
	readonly atStart: StateRecord | null;
	/** Records with `since` inside `(from, to)`, oldest first: the newest `limit` of them. */
	readonly changes: readonly StateRecord[];
	/** Whether older records inside the range were left out. */
	readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Schema. Every write counts towards the Durable Object's written rows, and each index
 * adds a row per insert and delete, so there are no secondary indexes. There are no
 * CHECK constraints either: SQLite cannot change one without rebuilding the table, and
 * later phases may add states or kinds. Values are validated in code.
 *
 * - `results`: every check, re-checks included, keyed by start time × runner. A `WITHOUT
 *   ROWID` table is stored in its primary key, so an insert writes exactly one row and time
 *   ranges are read in key order. `state` is NULL for a check that produced no result.
 * - `transitions`: the state history, keyed by when each state began: confirmed states, and
 *   `stopped` while the monitor was not configured. The latest row is the current state, so
 *   no row is rewritten per check.
 * - `schedule_periods`: one row per change of schedule (start, interval change, stop,
 *   resume). Each period lasts until the next one starts.
 *
 * Migrations are additive (see `migrate`): later phases add tables and never change these.
 *
 * Notifications add no table: a state record newer than the `notify.sent`
 * watermark (key-value storage) is the "unsent" marker. It is written in the same
 * transaction as the state change, by the state record itself, and cleared by moving the
 * watermark once the event is in the queue (see `flushNotifications`).
 */
export const MONITOR_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		description: "results, state history and schedule periods",
		up(sql) {
			sql.exec(`
				CREATE TABLE results (
					checked_at INTEGER NOT NULL,
					runner TEXT NOT NULL,
					kind TEXT NOT NULL,
					state TEXT,
					latency_ms INTEGER,
					message TEXT,
					details TEXT,
					PRIMARY KEY (checked_at, runner)
				) WITHOUT ROWID
			`);
			sql.exec(`
				CREATE TABLE transitions (
					since INTEGER PRIMARY KEY,
					state TEXT NOT NULL,
					confirmed_at INTEGER NOT NULL
				)
			`);
			sql.exec(`
				CREATE TABLE schedule_periods (
					start INTEGER PRIMARY KEY,
					status TEXT NOT NULL,
					interval_ms INTEGER
				)
			`);
		},
	},
	{
		version: 2,
		description: "notification watermark",
		up(sql, storage) {
			// State changes recorded before notifications existed count as notified: an upgraded
			// monitor must not replay its history (and open or resolve old automatic incidents).
			const latest = sql.exec<{ since: number | null }>("SELECT max(since) AS since FROM transitions").one();
			storage.kv.put(NOTIFIED_KEY, latest.since ?? 0);
		},
	},
];

/** `kind` of a result row. */
type CheckKind = "scheduled" | "recheck";

/** Written once, when the monitor first starts. */
interface StartRecord {
	readonly startedAt: number;
	/** The location hint the object was created with. A Durable Object never moves. */
	readonly location: LocationHint | null;
}

/** Progress of deleting old results, within the current day's budget. */
interface RetentionState {
	/** Start of the current budget day. */
	readonly dayStart: number;
	/** Rows deleted since `dayStart`. */
	readonly deleted: number;
	/** Whether old results may remain (the last run stopped at its batch or the budget). */
	readonly backlog: boolean;
	readonly ranAt: number;
}

const START_KEY = "monitor.start";
const RETENTION_KEY = "retention.state";
/** `since` of the latest state record whose events are in the queue: newer records are unsent. */
export const NOTIFIED_KEY = "notify.sent";
/** State records turned into events per flush; a longer backlog takes several. */
const NOTIFY_BATCH = 50;
/** Retrying notifications that could not be queued: 30 seconds, then twice as long each time, up to 10 minutes. */
const NOTIFY_RETRY = { kind: "notify", failureBackoffMs: 30_000, maxFailureBackoffMs: 10 * 60_000 } as const;

const DAY_MS = 24 * 3_600_000;
/**
 * Reads behind "the latest check" look back this many intervals (plus the confirmation
 * rule's needs), so that their cost does not grow with a monitor's history.
 */
const LOOKBACK_CHECKS = 10;
/** A re-check that produced no result is retried up to this many times. */
const MAX_RECHECK_RETRIES = 2;
/**
 * Old results deleted per day, per scheduled check of the day. Once retention is in
 * steady state, each check's result is deleted once, one row per check. A backlog (after
 * retention was shortened) is drained with at most half a row per check more, so the account's
 * daily write limit sized for the steady state is not exceeded by much; the backlog shrinks by
 * half a row per check, so it clears in about twice the time it took to build up.
 */
const RETENTION_DELETES_PER_CHECK = 1.5;
/** Rows deleted per alarm; more batches follow `RETENTION_CONTINUE_MS` apart, within the day's budget. */
const RETENTION_BATCH = 1_000;
const RETENTION_CONTINUE_MS = 1_000;
/** Minimum delay of the next alarm after one ran. */
const MIN_ALARM_DELAY_MS = 1_000;
/** An alarm overdue by more than this has stopped firing; `sync()` sets it again. */
const OVERDUE_ALARM_MS = 60_000;

type ResultRow = {
	checked_at: number;
	runner: string;
	state: CheckState | null;
	latency_ms: number | null;
	message: string | null;
};
type TransitionRow = { since: number; state: RecordedState; confirmed_at: number };
type PeriodRow = { start: number; status: SchedulePeriod["status"]; interval_ms: number | null };

function toRecord(row: TransitionRow): StateRecord {
	return { state: row.state, since: row.since, confirmedAt: row.confirmed_at };
}

/** Periods from rows ordered by start; each ends where the next begins. */
function toPeriods(rows: readonly PeriodRow[]): SchedulePeriod[] {
	return rows.map((row, index) => ({
		from: row.start,
		to: rows[index + 1]?.start ?? null,
		status: row.status,
		intervalMs: row.interval_ms,
	}));
}

/**
 * Something the single alarm wakes up for. The alarm is set to the earliest `next()`
 * of all of them. Each derives its deadline from durable state, so nothing is rewritten to
 * remember a deadline, and a restart, eviction or retried alarm recomputes the same plan.
 *
 * `notify` re-sends notifications that could not be queued. Later phases add
 * deadlines for results from external runners here.
 */
interface Work {
	readonly kind: "check" | "retention" | "notify";
	/** When this work is next due, or `null` when it has nothing to do. */
	next(now: number): number | null;
	run(now: number): Promise<void>;
	/**
	 * After `run` fails, the work waits at least this long, so that a persistent failure cannot
	 * spin; with `maxFailureBackoffMs`, twice as long after each further failure, up to that.
	 */
	readonly failureBackoffMs: number;
	readonly maxFailureBackoffMs?: number;
}

/** When the next check is due: the next slot on the schedule, or sooner to re-check a failure. */
interface CheckPlan {
	readonly scheduledAt: number;
	readonly recheckAt: number | null;
}

/**
 * Stub for a monitor's Durable Object. Always use this, never `getByName()` directly: only
 * the first `get()` of an object applies the location hint, so every caller must pass it.
 */
export function monitorStub(env: Env, monitor: { readonly id: string; readonly location?: LocationHint | null }) {
	return env.MONITOR.getByName(monitor.id, monitor.location ? { locationHint: monitor.location } : {});
}

/**
 * How far back a snapshot looks for the latest result: `LOOKBACK_CHECKS` intervals, and at
 * least the lateness threshold (`staleAfterMs`, which is under 3 intervals plus
 * `LATE_GRACE_MS` since a timeout is shorter than the interval), so that a result recent
 * enough to keep a monitor from being late is always found, however short the interval.
 */
export function recentLookbackMs(intervalMs: number): number {
	return Math.max(LOOKBACK_CHECKS * intervalMs, 3 * intervalMs + LATE_GRACE_MS);
}

/** Margin on top of {@link settledAfterMs}, for alarm delays and clocks of different objects. */
const SETTLE_MARGIN_MS = 60_000;

/**
 * How long after a moment a monitor's data about it can still change, so that a status page
 * may cache what it read about older moments. Results are recorded when a check ends
 * (its timeout plus the runners' grace after its start), and a confirmed state's `since`
 * reaches back to the start of the run that confirmed it: at most the confirmation rule's
 * observations plus `LOOKBACK_CHECKS` intervals (see `evaluate`). With the defaults, a
 * 1-minute interval and a 10-second timeout, 14 minutes 20 seconds.
 */
export function settledAfterMs(monitor: Pick<ResolvedMonitor, "intervalMs" | "timeoutMs" | "confirmation">): number {
	return (
		(observationsNeeded(monitor.confirmation) + LOOKBACK_CHECKS) * monitor.intervalMs +
		monitor.timeoutMs +
		2 * RUNNER_GRACE_MS +
		SETTLE_MARGIN_MS
	);
}

/**
 * One instance per monitor, named by the monitor ID and created with the monitor's location
 * as its `locationHint`. It schedules checks with its alarm, calls the runner, stores
 * every result per monitor × runner, applies the confirmation rule and keeps the state
 * history and schedule periods.
 *
 * The configuration comes from the version of the Worker the object runs. When the monitor
 * leaves it, the object stops checking but keeps its data; when it returns, the
 * object resumes with its history. Only `purge()` deletes the data.
 *
 * The read methods use stored data only, so they also answer for a removed monitor.
 */
export class Monitor extends DurableObject<Env> {
	private readonly store: MeteredStorage;
	private schemaReady = false;
	private alarmRunning = false;
	/** Per kind of work, after a failure. In memory only: an eviction just ends the backoff early. */
	private readonly backoffUntil = new Map<Work["kind"], number>();
	/** Consecutive failures per kind of work, for growing backoffs. */
	private readonly failures = new Map<Work["kind"], number>();
	/** Whether state records newer than the watermark exist; `undefined` until read. */
	private notifyPending: boolean | undefined;
	/** The flush in progress, so that flushes run one at a time. */
	private flushing: Promise<void> = Promise.resolve();
	private retentionResumeAt = 0;
	private locationWarned = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new MeteredStorage(ctx.storage);
		ctx.blockConcurrencyWhile(async () => {
			this.open();
		});
	}

	/** Rows read and written by this instance; for tests. */
	get [STORAGE_USAGE](): StorageUsage {
		return this.store.usage;
	}

	// -------------------------------------------------------------------------
	// RPC: lifecycle
	// -------------------------------------------------------------------------

	/**
	 * Brings the object in line with the configuration of the version it runs: starts or
	 * resumes a configured monitor, applies an interval change, and makes sure its alarm is
	 * set; stops a monitor that is no longer configured, keeping its data. Idempotent: when
	 * nothing changed it writes nothing.
	 */
	async sync(request: SyncRequest): Promise<SyncResult> {
		const versionId = this.env.CF_VERSION_METADATA.id;
		const now = Date.now();
		const monitor = this.configuredMonitor();
		if (monitor === undefined) {
			if (!this.open()) {
				return { status: "absent", configured: false, versionId, nextAlarmAt: null, location: null, snapshot: null };
			}
			await this.stop(now);
			return {
				status: "stopped",
				configured: false,
				versionId,
				nextAlarmAt: null,
				location: this.startRecord()?.location ?? null,
				snapshot: null,
			};
		}
		this.open();

		let start = this.startRecord();
		let status: SyncResult["status"] = "running";
		if (start === undefined) {
			const record: StartRecord = { startedAt: now, location: request.location };
			this.store.transaction(() => {
				this.store.kvPut(START_KEY, record);
				this.insertPeriod(now, "active", monitor.intervalMs);
			});
			start = record;
			status = "started";
		} else if (this.syncSchedule(monitor, now) === "resumed") {
			status = "resumed";
		}

		const configured = monitor.location ?? null;
		const locationMismatch = start.location === configured ? undefined : { created: start.location, configured };
		if (locationMismatch !== undefined && !this.locationWarned) {
			this.locationWarned = true;
			console.warn(
				`Monitor "${monitor.id}" is configured for location ${JSON.stringify(configured)}, but its Durable ` +
					`Object was created with ${JSON.stringify(start.location)} and cannot move. It keeps running where ` +
					"it is. To check from the new location, give the monitor a new ID (its history starts over).",
			);
		}

		// While the alarm runs, it sets the next alarm itself when it finishes.
		const nextAlarmAt = this.alarmRunning ? null : await this.schedule(monitor, now, "if-earlier");
		return {
			status,
			configured: true,
			versionId,
			nextAlarmAt,
			location: start.location,
			...(locationMismatch ? { locationMismatch } : {}),
			snapshot: this.getSnapshot(),
		};
	}

	/**
	 * Deletes all of a removed monitor's data (only on an administrator's request).
	 * Refuses while the monitor is in the configuration of the version this object runs, and
	 * while this object runs another version than the caller: during a deploy it may still
	 * run code from before the monitor was added back.
	 */
	async purge(request: PurgeRequest): Promise<PurgeResult> {
		const versionId = this.env.CF_VERSION_METADATA.id;
		if (request.versionId !== versionId) {
			return {
				status: "refused",
				reason: `The monitor's Durable Object runs another version (${versionId}); try again once the deploy has finished`,
				code: "deploying",
			};
		}
		if (this.configuredMonitor() !== undefined) {
			return { status: "refused", reason: "The monitor is in the configuration; remove it from status.config.ts first", code: "configured" };
		}
		// Also deletes the alarm (compatibility date 2026-02-24 and later).
		await this.ctx.storage.deleteAll();
		this.schemaReady = false;
		this.notifyPending = undefined;
		console.log(`Monitor "${this.monitorId()}": deleted all its data`);
		return { status: "purged" };
	}

	// -------------------------------------------------------------------------
	// RPC: reads. They use stored data only, never the configuration.
	// -------------------------------------------------------------------------

	/** The current state, for status pages and `unknown` detection. Reads a few rows. */
	getSnapshot(): MonitorSnapshot {
		const monitorId = this.monitorId();
		const configured = this.configuredMonitor() !== undefined;
		const empty: MonitorSnapshot = {
			monitorId,
			configured,
			startedAt: null,
			period: null,
			current: null,
			recentSince: null,
			lastCheck: null,
			lastResultAt: null,
		};
		if (!this.open()) return empty;
		const period = this.currentPeriod();
		if (period === null) return empty;

		const recentSince = this.recentFloor(period, Date.now());
		const last = this.store.first<ResultRow>(
			`SELECT checked_at, runner, state, latency_ms, message FROM results
			WHERE checked_at >= ? ORDER BY checked_at DESC LIMIT 1`,
			recentSince,
		);
		const lastResultAt =
			last === undefined
				? null
				: last.state !== null
					? last.checked_at
					: (this.store.first<{ checked_at: number }>(
							`SELECT checked_at FROM results WHERE checked_at >= ? AND state IS NOT NULL
							ORDER BY checked_at DESC LIMIT 1`,
							recentSince,
						)?.checked_at ?? null);
		return {
			monitorId,
			configured,
			startedAt: this.startRecord()?.startedAt ?? null,
			period,
			current: this.currentState(),
			recentSince,
			lastCheck: last
				? {
						at: last.checked_at,
						runner: last.runner,
						state: last.state,
						latencyMs: last.latency_ms,
						message: last.message,
					}
				: null,
			lastResultAt,
		};
	}

	/**
	 * The state history over a time range, for uptime and the stoppage history and
	 * notifications. `stopped` records mark where the monitor was not configured: that
	 * time is neither uptime nor downtime. Reads one row per record, plus one.
	 */
	getTransitions(range: TimeRange): TransitionHistory {
		if (!this.open()) return { atStart: null, changes: [] };
		const atStart = this.store.first<TransitionRow>(
			"SELECT since, state, confirmed_at FROM transitions WHERE since <= ? ORDER BY since DESC LIMIT 1",
			range.from,
		);
		const changes = this.store.all<TransitionRow>(
			"SELECT since, state, confirmed_at FROM transitions WHERE since > ? AND since < ? ORDER BY since",
			range.from,
			range.to,
		);
		return { atStart: atStart ? toRecord(atStart) : null, changes: changes.map(toRecord) };
	}

	/** The schedule periods that overlap `range`, oldest first. */
	getSchedule(range: TimeRange): SchedulePeriod[] {
		if (!this.open()) return [];
		return this.periodsOverlapping(range);
	}

	/**
	 * Result counts per time range for coverage, with the number of checks the schedule
	 * expected. Reads every result in the ranges, so callers should count past days once and
	 * cache them.
	 */
	countResults(ranges: readonly TimeRange[]): ResultCounts[] {
		const available = this.open();
		return ranges.map((range) => {
			const counts = { ...range, expected: 0, scheduled: 0, scheduledErrors: 0, rechecks: 0 };
			if (!available) return counts;
			counts.expected = expectedChecks(this.periodsOverlapping(range), range);
			const rows = this.store.all<{ kind: string; has_state: number; n: number }>(
				`SELECT kind, state IS NOT NULL AS has_state, count(*) AS n FROM results
				WHERE checked_at >= ? AND checked_at < ?
				GROUP BY kind, has_state`,
				range.from,
				range.to,
			);
			for (const row of rows) {
				if (row.kind === "scheduled") {
					if (row.has_state) counts.scheduled += row.n;
					else counts.scheduledErrors += row.n;
				} else {
					counts.rechecks += row.n;
				}
			}
			return counts;
		});
	}

	/**
	 * Where results are missing, for excluding `unknown` time from uptime: the stretches
	 * inside `range` (up to now) and inside active schedule periods with no check that
	 * produced a state for more than `minGapMs`. Each gap runs from the result before it (or
	 * the start of the active time) to the result after it (or the end of the range). Reads
	 * every result in the range.
	 */
	getResultGaps(range: TimeRange, minGapMs: number): TimeRange[] {
		if (!this.open()) return [];
		const end = Math.min(range.to, Date.now());
		if (end <= range.from) return [];
		const active = activeParts(this.periodsOverlapping(range), { from: range.from, to: end });
		const gaps: TimeRange[] = [];
		for (const part of active) {
			const bounds = this.store.first<{ first: number | null; last: number | null }>(
				`SELECT min(checked_at) AS first, max(checked_at) AS last FROM results
				WHERE checked_at >= ? AND checked_at < ? AND state IS NOT NULL`,
				part.from,
				part.to,
			);
			if (bounds === undefined || bounds.first === null || bounds.last === null) {
				if (part.to - part.from > minGapMs) gaps.push(part);
				continue;
			}
			if (bounds.first - part.from > minGapMs) gaps.push({ from: part.from, to: bounds.first });
			const inner = this.store.all<{ previous: number; checked_at: number }>(
				`SELECT previous, checked_at FROM (
					SELECT checked_at, lag(checked_at) OVER (ORDER BY checked_at) AS previous FROM results
					WHERE checked_at >= ? AND checked_at < ? AND state IS NOT NULL
				) WHERE checked_at - previous > ?`,
				part.from,
				part.to,
				minGapMs,
			);
			gaps.push(...inner.map((gap) => ({ from: gap.previous, to: gap.checked_at })));
			if (part.to - bounds.last > minGapMs) gaps.push({ from: bounds.last, to: part.to });
		}
		return intersect(gaps, active);
	}

	/**
	 * The display state over each range, with coverage counts, for a status page's history. Reads the schedule periods and state records of each range, and every result from
	 * a little before it (the lateness threshold, to judge its start) to its end: a status
	 * page asks for the stretches it has not cached yet, which keeps that small, and
	 * `maxRows` bounds a call that fills many missing days.
	 */
	getTimeline(request: TimelineRequest): TimelineResponse {
		if (!this.open()) return { startedAt: null, slices: [] };
		const startedAt = this.startRecord()?.startedAt ?? null;
		if (startedAt === null) return { startedAt: null, slices: [] };
		const now = Date.now();
		const staleAfter = (intervalMs: number) => staleAfterMs(intervalMs, request.timeoutMs);
		const readBefore = this.store.usage.rowsRead;
		const slices = request.ranges.map((requested, index): TimelineSlice | null => {
			if (index > 0 && this.store.usage.rowsRead - readBefore >= request.maxRows) return null;
			const range = { from: requested.from, to: Math.max(requested.from, Math.min(requested.to, now)) };
			const empty: TimelineSlice = { ...range, expected: 0, obtained: 0, segments: [], latency: [] };
			if (range.to <= range.from || range.to <= startedAt) return empty;
			const periods = this.periodsOverlapping(range);
			const intervals = periods.flatMap((period) => (period.status === "active" && period.intervalMs !== null ? [period.intervalMs] : []));
			if (intervals.length === 0) return empty;

			const lookback = staleAfter(Math.max(...intervals));
			const rows = this.store.all<{ checked_at: number; kind: string; has_state: number; latency_ms: number | null }>(
				`SELECT checked_at, kind, state IS NOT NULL AS has_state, latency_ms FROM results
				WHERE checked_at >= ? AND checked_at < ? ORDER BY checked_at`,
				range.from - lookback,
				range.to,
			);
			// Checks of the last few seconds may still be running: coverage counts the slots
			// whose results can be in, so that today's coverage does not dip while a check runs.
			const countTo = Math.max(range.from, Math.min(range.to, now - request.timeoutMs - 2 * RUNNER_GRACE_MS));
			const latencyFrom = request.latencySince == null ? Number.POSITIVE_INFINITY : Math.max(range.from, request.latencySince);
			let obtained = 0;
			const resultTimes: number[] = [];
			const latencies: [number, number][] = [];
			for (const row of rows) {
				if (!row.has_state) continue;
				resultTimes.push(row.checked_at);
				if (row.kind !== "scheduled") continue;
				if (row.checked_at >= range.from && row.checked_at < countTo) obtained++;
				if (row.latency_ms !== null && row.checked_at >= latencyFrom) latencies.push([row.checked_at, row.latency_ms]);
			}
			const { atStart, changes } = this.getTransitions(range);
			return {
				...range,
				expected: expectedChecks(periods, { from: range.from, to: countTo }),
				obtained,
				segments: monitorTimeline(range, { periods, atStart, changes, resultTimes }, staleAfter),
				latency: aggregateLatency(latencies),
			};
		});
		return { startedAt, slices };
	}

	/**
	 * The newest state records in a range, for the stoppage history. Reads at most
	 * `limit + 2` rows, however long the history.
	 */
	getRecentTransitions(request: RecentTransitionsRequest): RecentTransitions {
		if (!this.open()) return { atStart: null, changes: [], truncated: false };
		const after = request.after ?? null;
		const rows = this.store.all<TransitionRow>(
			"SELECT since, state, confirmed_at FROM transitions WHERE since > ? AND since < ? ORDER BY since DESC LIMIT ?",
			Math.max(request.from, after ?? request.from),
			request.to,
			request.limit + 1,
		);
		const truncated = rows.length > request.limit;
		const changes = rows.slice(0, request.limit).reverse().map(toRecord);
		if (truncated || after !== null) return { atStart: null, changes, truncated };
		const atStart = this.store.first<TransitionRow>(
			"SELECT since, state, confirmed_at FROM transitions WHERE since <= ? ORDER BY since DESC LIMIT 1",
			request.from,
		);
		return { atStart: atStart ? toRecord(atStart) : null, changes, truncated };
	}

	/**
	 * Everything a status page needs from this monitor, in one call: each Durable Object call
	 * is a billed request (and counts towards the Free plan's daily limit), so a page reads
	 * its current state, history stretches and new state records together.
	 */
	readForPage(request: PageReadRequest): PageReadResponse {
		const timeline =
			request.ranges.length > 0
				? this.getTimeline({
						ranges: request.ranges,
						timeoutMs: request.timeoutMs,
						maxRows: request.maxRows,
						latencySince: request.latencySince ?? null,
					})
				: { startedAt: this.open() ? (this.startRecord()?.startedAt ?? null) : null, slices: [] };
		return {
			...timeline,
			snapshot: request.snapshot ? this.getSnapshot() : null,
			transitions: request.transitions === null ? null : this.getRecentTransitions(request.transitions),
		};
	}

	// -------------------------------------------------------------------------
	// Alarm
	// -------------------------------------------------------------------------

	/**
	 * Runs whatever is due (a check or re-check, deleting old results), then sets the alarm
	 * to the earliest next deadline. Work is derived from stored results, so a retried or
	 * duplicate alarm finds the check it already recorded and does not run it again.
	 */
	override async alarm(): Promise<void> {
		const monitor = this.configuredMonitor();
		if (monitor === undefined) {
			if (this.open()) await this.stop(Date.now());
			return;
		}
		this.open();
		// An alarm before sync() cannot happen; if it does, the next sweep starts the monitor.
		if (this.startRecord() === undefined) return;

		const now = Date.now();
		this.syncSchedule(monitor, now);
		this.alarmRunning = true;
		try {
			for (const work of this.works(monitor)) {
				const due = this.nextOf(work, now);
				if (due === null || due > now) continue;
				try {
					await work.run(now);
					this.failures.delete(work.kind);
				} catch (error) {
					this.backOff(work);
					console.error(`Monitor "${monitor.id}": ${work.kind} failed`, error);
				}
			}
		} finally {
			this.alarmRunning = false;
		}
		// If storage itself fails here, the alarm throws and the runtime retries it.
		await this.schedule(monitor, Date.now(), "after-alarm");
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	private monitorId(): string {
		const id = this.ctx.id.name;
		// Every caller uses monitorStub(); an object reached by `idFromString()` has no name.
		if (id === undefined) throw new Error("Monitor Durable Objects must be addressed by monitor ID");
		return id;
	}

	private configuredMonitor(): ResolvedMonitor | undefined {
		return findMonitor(this.monitorId());
	}

	/**
	 * Prepares the schema when the monitor is configured or the object already has data, and
	 * returns whether storage is available. An object with no data whose monitor is not
	 * configured stays empty: reading it must not create a database.
	 */
	private open(): boolean {
		if (!this.schemaReady && (this.configuredMonitor() !== undefined || schemaVersion(this.ctx.storage) !== undefined)) {
			migrate(this.ctx.storage, MONITOR_MIGRATIONS);
			this.schemaReady = true;
		}
		return this.schemaReady;
	}

	private startRecord(): StartRecord | undefined {
		return this.store.kvGet<StartRecord>(START_KEY);
	}

	/** Results are stored per monitor × runner. Monitors have a single runner for now. */
	private runnerOf(monitor: ResolvedMonitor): string {
		const runner = monitor.runners[0];
		if (runner === undefined) throw new Error(`Monitor "${monitor.id}" has no runner`);
		return runner;
	}

	// ---- Schedule periods

	private currentPeriod(): SchedulePeriod | null {
		const row = this.store.first<PeriodRow>(
			"SELECT start, status, interval_ms FROM schedule_periods ORDER BY start DESC LIMIT 1",
		);
		return row ? { from: row.start, to: null, status: row.status, intervalMs: row.interval_ms } : null;
	}

	/** Periods that overlap `range`: the one in effect at `range.from` and those starting inside. */
	private periodsOverlapping(range: TimeRange): SchedulePeriod[] {
		const first = this.store.first<{ start: number }>(
			"SELECT start FROM schedule_periods WHERE start <= ? ORDER BY start DESC LIMIT 1",
			range.from,
		);
		const rows = this.store.all<PeriodRow>(
			"SELECT start, status, interval_ms FROM schedule_periods WHERE start >= ? ORDER BY start",
			first?.start ?? range.from,
		);
		return toPeriods(rows).filter((period) => period.from < range.to);
	}

	/**
	 * Start of the current run of active periods: results from before the monitor was last
	 * stopped do not count towards its state after it resumed.
	 */
	private activeSince(): number {
		const stopped = this.store.first<{ start: number }>(
			"SELECT start FROM schedule_periods WHERE status = 'stopped' ORDER BY start DESC LIMIT 1",
		);
		if (stopped === undefined) return Number.NEGATIVE_INFINITY;
		const resumed = this.store.first<{ start: number }>(
			"SELECT start FROM schedule_periods WHERE start > ? ORDER BY start LIMIT 1",
			stopped.start,
		);
		return resumed?.start ?? Number.POSITIVE_INFINITY;
	}

	/** The interval of the latest active period, for bounding reads of a stopped monitor. */
	private lastInterval(period: SchedulePeriod): number {
		if (period.intervalMs !== null) return period.intervalMs;
		return (
			this.store.first<{ interval_ms: number }>(
				"SELECT interval_ms FROM schedule_periods WHERE status = 'active' ORDER BY start DESC LIMIT 1",
			)?.interval_ms ?? DAY_MS
		);
	}

	/**
	 * How far back "recent" reads go (see {@link recentLookbackMs}) before now (or before the
	 * stop), and for a running monitor never before it last resumed.
	 */
	private recentFloor(period: SchedulePeriod, now: number): number {
		const lookback = recentLookbackMs(this.lastInterval(period));
		if (period.status !== "active") return period.from - lookback;
		return Math.max(this.activeSince(), now - lookback);
	}

	private insertPeriod(start: number, status: SchedulePeriod["status"], intervalMs: number | null): void {
		this.store.run("INSERT INTO schedule_periods (start, status, interval_ms) VALUES (?, ?, ?)", start, status, intervalMs);
	}

	/**
	 * Starts a new active period when the monitor resumes or its interval changed. Writes one
	 * row then (two on resuming, which also ends the `stopped` state), and nothing otherwise.
	 * The new period's grid starts now, so the first check of a resumed monitor or of a new
	 * interval runs right away.
	 */
	private syncSchedule(monitor: ResolvedMonitor, now: number): "unchanged" | "resumed" | "changed" {
		const period = this.currentPeriod();
		if (period === null) {
			this.insertPeriod(now, "active", monitor.intervalMs);
			return "changed";
		}
		if (period.status === "active" && period.intervalMs === monitor.intervalMs) return "unchanged";
		const start = Math.max(now, period.from + 1);
		if (period.status === "stopped") {
			this.store.transaction(() => {
				this.insertPeriod(start, "active", monitor.intervalMs);
				// Results from before the stop do not count; no state is confirmed yet.
				this.insertState({ state: "unconfirmed", since: start, confirmedAt: start });
			});
			console.log(`Monitor "${monitor.id}" is back in status.config.ts: resuming with its history`);
			return "resumed";
		}
		this.insertPeriod(start, "active", monitor.intervalMs);
		return "changed";
	}

	/**
	 * Stops a monitor that left the configuration: records a stopped period and a
	 * `stopped` state, and deletes the alarm once its notifications are queued. Keeps every
	 * result. Idempotent.
	 */
	private async stop(now: number): Promise<void> {
		const period = this.currentPeriod();
		if (period?.status === "active") {
			const at = Math.max(now, period.from + 1);
			this.store.transaction(() => {
				this.insertPeriod(at, "stopped", null);
				this.insertState({ state: "stopped", since: at, confirmedAt: at });
			});
			console.log(
				`Monitor "${this.monitorId()}" is no longer in status.config.ts: stopped its checks. ` +
					"Its data is kept until an administrator deletes it.",
			);
		}
		// Events not queued yet, such as the `stopped` that resolves the monitor's automatic
		// incidents: while the queue refuses them, the alarm stays, for them only (no checks:
		// `alarm()` comes back here for a monitor that is not configured).
		if (this.hasUnsentNotifications()) {
			try {
				await this.flushNotifications(this.monitorId());
				this.failures.delete("notify");
			} catch (error) {
				this.backOff(NOTIFY_RETRY);
				const retryAt = this.backoffUntil.get("notify") as number;
				console.error(`Monitor "${this.monitorId()}": could not queue notifications after stopping; retrying`, error);
				if ((await this.store.getAlarm()) !== retryAt) await this.store.setAlarm(retryAt);
				return;
			}
		}
		// While the alarm runs, getAlarm() is null and the alarm simply does not set another.
		if ((await this.store.getAlarm()) !== null) await this.store.deleteAlarm();
	}

	// ---- Alarm

	private works(monitor: ResolvedMonitor): Work[] {
		return [
			{
				kind: "check",
				next: (now) => {
					const plan = this.planCheck(monitor, now);
					if (plan === null) return null;
					return plan.recheckAt === null ? plan.scheduledAt : Math.min(plan.scheduledAt, plan.recheckAt);
				},
				run: (now) => this.check(monitor, now),
				failureBackoffMs: 30_000,
			},
			{
				kind: "retention",
				next: (now) => this.retentionDue(now),
				run: (now) => this.deleteOldResults(monitor, now),
				failureBackoffMs: 3_600_000,
			},
			{
				// Notifications whose queue send failed: due as soon as any are unsent.
				...NOTIFY_RETRY,
				next: (now) => (this.hasUnsentNotifications() ? now : null),
				run: () => this.flushNotifications(monitor.id),
			},
		];
	}

	/** Records a failure of `work` and when it may run again. */
	private backOff(work: Pick<Work, "kind" | "failureBackoffMs" | "maxFailureBackoffMs">): void {
		const failures = (this.failures.get(work.kind) ?? 0) + 1;
		this.failures.set(work.kind, failures);
		const delay = Math.min(work.failureBackoffMs * 2 ** (failures - 1), work.maxFailureBackoffMs ?? work.failureBackoffMs);
		this.backoffUntil.set(work.kind, Date.now() + delay);
	}

	private nextOf(work: Work, now: number): number | null {
		const at = work.next(now);
		return at === null ? null : Math.max(at, this.backoffUntil.get(work.kind) ?? 0);
	}

	/**
	 * Sets the alarm to the earliest deadline. Skips the write when nothing would change; in
	 * `if-earlier` mode it also keeps a later alarm, unless that one is overdue (it stopped
	 * firing).
	 */
	private async schedule(
		monitor: ResolvedMonitor,
		now: number,
		mode: "after-alarm" | "if-earlier",
	): Promise<number | null> {
		let next: number | null = null;
		for (const work of this.works(monitor)) {
			const at = this.nextOf(work, now);
			if (at !== null && (next === null || at < next)) next = at;
		}
		if (next === null) return null;
		if (mode === "after-alarm") next = Math.max(next, now + MIN_ALARM_DELAY_MS);

		const current = await this.store.getAlarm();
		const overdue = current !== null && current < now - OVERDUE_ALARM_MS;
		if (current !== null && !overdue && (current === next || (mode === "if-earlier" && current <= next))) {
			return current;
		}
		await this.store.setAlarm(next);
		return next;
	}

	// ---- Checks

	private planCheck(monitor: ResolvedMonitor, now: number): CheckPlan | null {
		const period = this.currentPeriod();
		if (period === null || period.status !== "active" || period.intervalMs === null) return null;
		const runner = this.runnerOf(monitor);
		// Stops at the latest scheduled check: past it, only the few re-checks after it are read.
		const lastScheduled = this.store.first<{ checked_at: number }>(
			`SELECT checked_at FROM results WHERE checked_at >= ? AND runner = ? AND kind = 'scheduled'
			ORDER BY checked_at DESC LIMIT 1`,
			period.from,
			runner,
		);
		const scheduledAt = nextScheduledCheck(period.from, period.intervalMs, lastScheduled?.checked_at ?? null, now);
		const floor = Math.max(period.from, now - LOOKBACK_CHECKS * period.intervalMs);

		// Re-check soon while the latest result failed and its state is not confirmed yet. Once it is confirmed, checks return to the schedule. When the re-check itself
		// produces no result, it is retried up to MAX_RECHECK_RETRIES times.
		const latest = this.store.all<{ checked_at: number; state: CheckState | null }>(
			`SELECT checked_at, state FROM results WHERE checked_at >= ? AND runner = ?
			ORDER BY checked_at DESC LIMIT ?`,
			floor,
			runner,
			MAX_RECHECK_RETRIES + 2,
		);
		const errors = latest.findIndex((row) => row.state !== null);
		const lastWithState = errors === -1 ? undefined : latest[errors];
		let recheckAt: number | null = null;
		if (lastWithState !== undefined && lastWithState.state !== "up" && errors <= MAX_RECHECK_RETRIES) {
			const { pending } = this.evaluate(monitor, runner, now);
			if (pending !== null && pending !== "up") {
				recheckAt = (latest[0] as { checked_at: number }).checked_at + monitor.confirmation.recheckIntervalMs;
			}
		}
		return { scheduledAt, recheckAt };
	}

	private async check(monitor: ResolvedMonitor, now: number): Promise<void> {
		const plan = this.planCheck(monitor, now);
		if (plan === null) return;
		// A due scheduled check also serves as the re-check.
		const kind: CheckKind = plan.scheduledAt <= now ? "scheduled" : "recheck";
		const runner = this.runnerOf(monitor);
		const startedAt = Date.now();
		const outcome = await this.callRunner(monitor);
		if (this.record(monitor, runner, startedAt, kind, outcome)) {
			// Queue the notification now; if that fails, the `notify` work retries it.
			try {
				await this.flushNotifications(monitor.id);
				this.failures.delete("notify");
			} catch (error) {
				this.backOff(NOTIFY_RETRY);
				console.error(`Monitor "${monitor.id}": could not queue notifications; retrying`, error);
			}
		}
	}

	/** Runs the check on the built-in runner, giving up after the timeouts in `RUNNER_GRACE_MS`. */
	private async callRunner(monitor: ResolvedMonitor): Promise<CheckOutcome> {
		const limitMs = monitor.timeoutMs + 2 * RUNNER_GRACE_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<CheckOutcome>((resolve) => {
			timer = setTimeout(
				() =>
					resolve({
						ok: false,
						error: { name: "RunnerTimeoutError", message: `The runner did not answer within ${limitMs} ms` },
					}),
				limitMs,
			);
		});
		try {
			const call = this.ctx.exports.CloudflareRunner.run({ monitorId: monitor.id }) as Promise<CheckOutcome>;
			return await Promise.race([call, timeout]);
		} catch (error) {
			return { ok: false, error: checkError(error, "RunnerError") };
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/**
	 * Stores one check and applies the confirmation rule, in one transaction. A routine check
	 * writes one row here; a check that confirms a new state writes two. The new state record
	 * is also the "unsent notification" marker. Returns whether a state was confirmed.
	 */
	private record(
		monitor: ResolvedMonitor,
		runner: string,
		startedAt: number,
		kind: CheckKind,
		outcome: CheckOutcome,
	): boolean {
		if (!outcome.ok) {
			console.warn(`Monitor "${monitor.id}": the check produced no result. ${outcome.error.name}: ${outcome.error.message}`);
		}
		return this.store.transaction(() => {
			// Keep start times strictly increasing per runner, even if the clock goes back.
			// Reads one row (or one per runner, once there are several).
			const previous = this.store.first<{ checked_at: number }>(
				"SELECT checked_at FROM results WHERE runner = ? ORDER BY checked_at DESC LIMIT 1",
				runner,
			);
			const at = previous === undefined ? startedAt : Math.max(startedAt, previous.checked_at + 1);
			const result = outcome.ok ? outcome.result : null;
			this.store.run(
				`INSERT INTO results (checked_at, runner, kind, state, latency_ms, message, details)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				at,
				runner,
				kind,
				result?.state ?? null,
				result?.latencyMs ?? null,
				result ? result.message : outcome.ok ? null : outcome.error.message,
				result ? result.details : outcome.ok ? null : JSON.stringify({ error: outcome.error.name }),
			);
			if (result === null) return false;

			const confirmation = this.evaluate(monitor, runner, at);
			if (!confirmation.changed || confirmation.current === null) return false;
			this.insertState(confirmation.current);
			return true;
		});
	}

	/**
	 * The confirmation rule applied to the stored results. Checks without a state are
	 * skipped, and so are results from before the monitor was last stopped. Reads at most the
	 * results of the last few intervals.
	 */
	private evaluate(monitor: ResolvedMonitor, runner: string, now: number): Confirmation {
		const needed = observationsNeeded(monitor.confirmation);
		const floor = Math.max(this.activeSince(), now - (needed + LOOKBACK_CHECKS) * monitor.intervalMs);
		const recent = this.store
			.all<{ checked_at: number; state: CheckState }>(
				`SELECT checked_at, state FROM results WHERE checked_at >= ? AND runner = ? AND state IS NOT NULL
				ORDER BY checked_at DESC LIMIT ?`,
				floor,
				runner,
				needed,
			)
			.reverse()
			.map((row): Observation => ({ state: row.state, at: row.checked_at }));
		const current = this.currentState();
		// After a stop, the state is confirmed afresh.
		const previous: ConfirmedState | null =
			current === null || current.state === "stopped" || current.state === "unconfirmed"
				? null
				: { ...current, state: current.state };
		return confirmState(previous, recent, monitor.confirmation);
	}

	private currentState(): StateRecord | null {
		const row = this.store.first<TransitionRow>("SELECT since, state, confirmed_at FROM transitions ORDER BY since DESC LIMIT 1");
		return row ? toRecord(row) : null;
	}

	/** Appends to the state history, keeping `since` strictly increasing (it is the key). */
	private insertState(record: StateRecord): void {
		const latest = this.currentState();
		const since = latest === null ? record.since : Math.max(record.since, latest.since + 1);
		this.store.run(
			"INSERT INTO transitions (since, state, confirmed_at) VALUES (?, ?, ?)",
			since,
			record.state,
			record.confirmedAt,
		);
		this.notifyPending = true;
	}

	// ---- Notifications

	/** Whether state records exist that are newer than the watermark. Reads two rows once per instance. */
	private hasUnsentNotifications(): boolean {
		if (this.notifyPending === undefined) {
			this.notifyPending = (this.currentState()?.since ?? Number.NEGATIVE_INFINITY) > this.notifiedThrough();
		}
		return this.notifyPending;
	}

	/**
	 * The watermark. Migration 2 sets it; should it be missing anyway, the history so far
	 * counts as notified (never replayed), and the watermark is written.
	 */
	private notifiedThrough(): number {
		const sent = this.store.kvGet<number>(NOTIFIED_KEY);
		if (sent !== undefined) return sent;
		const latest = this.currentState()?.since ?? 0;
		console.warn(`Monitor "${this.monitorId()}": notification watermark missing; not replaying earlier state changes`);
		this.store.kvPut(NOTIFIED_KEY, latest);
		return latest;
	}

	/**
	 * Queues the events of the state records newer than the watermark, then moves the watermark
	 * past them (one written row). Throws when the queue refuses them: the watermark stays, and
	 * the alarm's `notify` work tries again. One flush at a time; a duplicate send (after a
	 * crash between sending and moving the watermark) is dropped downstream by event ID.
	 */
	private flushNotifications(monitorId: string): Promise<void> {
		const run = this.flushing.then(() => this.flushOnce(monitorId));
		this.flushing = run.catch(() => {});
		return run;
	}

	private async flushOnce(monitorId: string): Promise<void> {
		const sent = this.notifiedThrough();
		const pending = this.store
			.all<TransitionRow>(
				"SELECT since, state, confirmed_at FROM transitions WHERE since > ? ORDER BY since LIMIT ?",
				sent,
				NOTIFY_BATCH,
			)
			.map(toRecord);
		const last = pending.at(-1);
		if (last === undefined) {
			this.notifyPending = false;
			return;
		}
		const before = this.store.first<TransitionRow>(
			"SELECT since, state, confirmed_at FROM transitions WHERE since <= ? ORDER BY since DESC LIMIT 1",
			sent,
		);
		// The latest confirmed state before them, past a stop and a resume, so that a recovery
		// after the monitor resumed answers the `down` notified before it stopped.
		const confirmed =
			before === undefined || isCheckState(before.state)
				? before
				: this.store.first<TransitionRow>(
						"SELECT since, state, confirmed_at FROM transitions WHERE since <= ? AND state IN ('up', 'degraded', 'down') ORDER BY since DESC LIMIT 1",
						sent,
					);
		const events = eventsFromTransitions(
			monitorId,
			before ? toRecord(before) : null,
			pending,
			(record) => this.messageAt(record.confirmedAt),
			confirmed ? toRecord(confirmed) : null,
		);
		if (events.length > 0) await enqueue(this.env, events.map((event) => ({ type: "event", v: 1, event })));
		this.store.kvPut(NOTIFIED_KEY, last.since);
		this.notifyPending = pending.length === NOTIFY_BATCH;
	}

	/** The message of the latest check with a state at or before `at`, such as "HTTP 503". */
	private messageAt(at: number): string | null {
		return (
			this.store.first<{ message: string | null }>(
				"SELECT message FROM results WHERE checked_at <= ? AND state IS NOT NULL ORDER BY checked_at DESC LIMIT 1",
				at,
			)?.message ?? null
		);
	}

	// ---- Retention

	private retentionDue(now: number): number | null {
		if (config.retentionMs === null) return null;
		const state = this.store.kvGet<RetentionState>(RETENTION_KEY);
		if (state === undefined) return now;
		const resume = Math.max(state.ranAt + RETENTION_CONTINUE_MS, this.retentionResumeAt);
		return state.backlog && state.deleted < this.dailyDeleteBudget() ? resume : state.dayStart + DAY_MS;
	}

	/** Rows of old results this monitor may delete per day, tied to its own write rate. */
	private dailyDeleteBudget(): number {
		const period = this.currentPeriod();
		const interval = period === null ? DAY_MS : this.lastInterval(period);
		return Math.max(1, Math.ceil(RETENTION_DELETES_PER_CHECK * Math.ceil(DAY_MS / interval)));
	}

	/**
	 * Deletes the oldest results beyond the retention period, at most `RETENTION_BATCH` rows
	 * per run and the daily budget per day, because deletes count as written rows and a
	 * shortened retention can leave a large backlog. What remains carries over to the next
	 * day. Once the backlog is gone, older state records and schedule periods are trimmed
	 * too, keeping the ones in effect at the cutoff.
	 */
	private async deleteOldResults(monitor: ResolvedMonitor, now: number): Promise<void> {
		const { retentionMs } = config;
		if (retentionMs === null) return;
		const cutoff = now - retentionMs;
		const budget = this.dailyDeleteBudget();
		let state = this.store.kvGet<RetentionState>(RETENTION_KEY);
		if (state === undefined || now >= state.dayStart + DAY_MS) {
			state = { dayStart: now, deleted: 0, backlog: true, ranAt: now };
		}
		const limit = Math.min(RETENTION_BATCH, budget - state.deleted);
		if (limit <= 0) return;

		const deleted = this.store.run(
			`DELETE FROM results WHERE (checked_at, runner) IN (
				SELECT checked_at, runner FROM results WHERE checked_at < ? ORDER BY checked_at LIMIT ?
			)`,
			cutoff,
			limit,
		);
		const backlog = deleted >= limit;
		this.store.transaction(() => {
			if (!backlog) {
				for (const table of [
					{ name: "transitions", key: "since" },
					{ name: "schedule_periods", key: "start" },
				]) {
					const inEffect = this.store.first<{ key: number }>(
						`SELECT ${table.key} AS key FROM ${table.name} WHERE ${table.key} <= ? ORDER BY ${table.key} DESC LIMIT 1`,
						cutoff,
					);
					if (inEffect !== undefined) this.store.run(`DELETE FROM ${table.name} WHERE ${table.key} < ?`, inEffect.key);
				}
			}
			this.store.kvPut(RETENTION_KEY, {
				dayStart: state.dayStart,
				deleted: state.deleted + deleted,
				backlog,
				ranAt: now,
			} satisfies RetentionState);
		});
		this.retentionResumeAt = backlog ? now + RETENTION_CONTINUE_MS : 0;
		if (backlog && state.deleted + deleted >= budget) {
			console.log(`Monitor "${monitor.id}": deleted ${budget} old results today; continuing tomorrow`);
		}
	}
}
