import { DurableObject } from "cloudflare:workers";
import {
	type CalendarDay,
	combineTimelines,
	componentState,
	concatSegments,
	coverageRatio,
	type DisplayState,
	type DownPeriod,
	displayState,
	downPeriods,
	excludeWindows,
	mergeDownPeriods,
	type ResolvedMonitor,
	type ResolvedPage,
	recentDays,
	type Segment,
	type StateRecord,
	staleAfterMs,
	summarize,
	type TimeRange,
	uptimeRatio,
	worstState,
} from "@naosystem/cf-workers-status-page-core";
import type {
	ComponentHistory,
	ComponentLatency,
	ComponentStatus,
	HistoryDay,
	HistoryMarker,
	PageHistoryResponse,
	PageLatencyResponse,
	PageStatusResponse,
	Stoppage,
	StoppagesResponse,
} from "../shared/public-api";
import { config, findPage, pageMonitors } from "./config";
import { defaultAppearance, getAppearance } from "./db/appearance";
import type { Incident, Maintenance, PageAppearance } from "../shared/admin-api";
import {
	type IncidentWithLatestUpdates,
	listIncidentsChangedSince,
	listIncidentsSince,
	listOpenIncidentsWithUpdates,
	MAX_HISTORY_INCIDENTS,
} from "./db/incidents";
import { listMaintenanceBetween, listMaintenanceOverlapping } from "./db/maintenance";
import { ensureSchema } from "./db/schema";
import {
	concatLatency,
	decodeLatency,
	encodeLatency,
	LATENCY_RANGES,
	latencySeries,
	latencySince,
	mergeLatency,
	NO_LATENCY,
	type PackedLatency,
	packLatency,
	unpackLatency,
} from "./latency";
import {
	type MonitorSnapshot,
	monitorStub,
	type PageReadResponse,
	settledAfterMs,
	type TimelineSlice,
} from "./monitor";
import type { PageViewRoute } from "./public/routes";
import { publicAppearance, publicIncidentWithUpdates, publicMaintenance } from "./public/views";
import { forEachLimited } from "./reconciler";
import { MeteredStorage, type Migration, migrate, STORAGE_USAGE, type StorageUsage } from "./storage";
import { uploadsBucket } from "./uploads";

/** Days of history a page shows, today included. */
export const HISTORY_DAYS = 90;
/**
 * Monitor DOs read at once. Durable Object calls are not among the connections limited to
 * six per invocation (fetch, KV, Cache, R2, Queues, sockets:
 * https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections);
 * this only bounds the results held at once.
 */
const MONITOR_CONCURRENCY = 32;
/**
 * Result rows one read may take from each Monitor DO (about 7 days of a monitor checked every
 * minute; `maxRows` of its `getTimeline`). The newest stretches come first, and at least one
 * is read, so a history missing many days (after the time zone changed, say) fills in over a
 * few reads; its days are `pending` meanwhile, and the history is computed again after
 * {@link PENDING_TTL_MS}.
 */
export const FILL_ROWS_PER_MONITOR = 10_000;
/** A day's cached data grows in steps of this, so that the cache is written at most hourly per monitor. */
const CACHE_STEP_MS = 3_600_000;
/** Most stoppages listed. */
export const STOPPAGE_LIMIT = 100;
/**
 * How long a computed status is used (about 30 seconds): the current state is
 * what visitors come for. Monitors whose state cannot have changed since they were last read
 * (no check has ended since) are not read again, so this costs about one Durable Object
 * request per monitor per check, at most two per minute.
 */
export const STATUS_TTL_MS = 30_000;
/**
 * How long a computed history and stoppage list are used. They describe past days and past
 * outages: today's bar and a new stoppage may lag by up to 5 minutes, while the current
 * state is in the status (30 seconds). Reading today's stretch of every monitor costs about
 * an hour of results each; doing it every 5 minutes instead of every 30 seconds reads ten
 * times fewer rows. An administrator's change still shows at once.
 */
export const HISTORY_TTL_MS = 5 * 60_000;
export const STOPPAGES_TTL_MS = 5 * 60_000;
/** For a history whose missing days are being filled in (bounded by {@link FILL_ROWS_PER_MONITOR} per read). */
export const PENDING_TTL_MS = 5_000;
/**
 * The history's incidents are read in full at most this often (and after an incident is
 * deleted); in between, only those changed since the last read (`incidents_by_page_updated`),
 * so that a page with thousands of incidents in its window does not read them all every 5
 * minutes (D1's rows read are limited per day on the Free plan, notifications included).
 */
export const INCIDENTS_FULL_READ_MS = 6 * 3_600_000;
/** Changes are read from this long before the last read, for writers' clocks and transactions that commit late. */
export const INCIDENTS_OVERLAP_MS = 5 * 60_000;
/**
 * How long a status or history is used when D1 could not be read (its incidents, maintenance
 * and appearance are then as last read): short, so that the page recovers soon after D1 does,
 * and the edge never keeps it longer than this.
 */
export const OUTDATED_TTL_MS = 10_000;
/** Updates of each unresolved incident in a page's status; an incident's own URL has its whole timeline. */
export const STATUS_UPDATES_PER_INCIDENT = 10;
/**
 * How long an announced change (see {@link StatusPage.beginChange}) keeps responses from
 * being cached when its end is never reported (the write was refused or failed, say). A D1
 * write takes well under this.
 */
export const CHANGE_WINDOW_MS = 15_000;
/**
 * What cached days were computed with. A different value discards them all (they are
 * recomputed from the monitors' data): the format and the code's rules (this number), the
 * time zone, and the lateness and settling rules, by their values at a few points.
 */
const DAYS_FORMAT = 3;
const DAYS_BASIS_KEY = "days.basis";

/**
 * With `latency`, the page has components that publish response times, and its cached days
 * carry them (for every monitor of the page, so that turning them on for one more component
 * needs no new reads); days cached without them are discarded when it changes.
 */
export function daysBasis(timezone: string, latency = false): string {
	const settle = (intervalMs: number, timeoutMs: number) =>
		settledAfterMs({ intervalMs, timeoutMs, confirmation: { failureThreshold: 1, successThreshold: 1, recheckIntervalMs: 1 } });
	return [
		DAYS_FORMAT,
		timezone,
		staleAfterMs(0, 0),
		staleAfterMs(1, 0),
		staleAfterMs(0, 1),
		settle(0, 0),
		settle(1, 0),
		settle(0, 1),
		...(latency ? ["latency"] : []),
	].join(" ");
}

/** Whether the page publishes response times (`components[].latency`). */
function hasLatency(page: ResolvedPage): boolean {
	return page.components.some((component) => component.latency);
}

/**
 * Schema. As in the Monitor DO, tables are `WITHOUT ROWID` and have no secondary index, so
 * each insert or update writes one row.
 *
 * - `monitor_days`: the daily values cache. Per monitor and local day, its display
 *   timeline (segments as JSON) and coverage counts for `[day_from, covered_to)`. Past days
 *   are complete; today's grows hourly, behind what the monitor may still change (see
 *   `settledAfterMs`). Monitor-level, not component-level, so maintenance and component
 *   membership apply when a response is built and never invalidate it. Loaded into memory
 *   once per instance.
 * - `monitor_sources`: per monitor, the `startedAt` its cached days came from (`NULL`: it had
 *   no data). A different `startedAt` means the monitor was purged and started again, so its
 *   cached days are discarded.
 * - `monitor_days.latency` (version 2): the day's response times in 15-minute buckets (see
 *   latency.ts), for days within the last 30, on pages that publish them; `[]` otherwise.
 *
 * The first scaffold's `monitors` table is dropped: nothing reads it any more, and the scaffold's
 * code, after a rollback, would create it again.
 */
const STATUS_PAGE_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		description: "daily values cache",
		up(sql) {
			sql.exec("DROP TABLE IF EXISTS monitors");
			sql.exec(`
				CREATE TABLE monitor_days (
					monitor_id TEXT NOT NULL,
					day TEXT NOT NULL,
					day_from INTEGER NOT NULL,
					day_to INTEGER NOT NULL,
					covered_to INTEGER NOT NULL,
					expected INTEGER NOT NULL,
					obtained INTEGER NOT NULL,
					segments TEXT NOT NULL,
					PRIMARY KEY (monitor_id, day)
				) WITHOUT ROWID
			`);
			sql.exec(`
				CREATE TABLE monitor_sources (
					monitor_id TEXT PRIMARY KEY,
					started_at INTEGER
				) WITHOUT ROWID
			`);
		},
	},
	{
		version: 2,
		description: "response times in the daily values cache",
		up(sql) {
			// Days cached before have none: the new days basis discards them.
			sql.exec("ALTER TABLE monitor_days ADD COLUMN latency TEXT NOT NULL DEFAULT '[]'");
		},
	},
];

/**
 * Segments packed as `[from, to, state code]` triples in one typed array: 24 bytes each
 * instead of an object, so that the days kept in memory stay small even for a monitor that
 * flaps all day. Unpacked only while a response is computed.
 */
type PackedSegments = Float64Array;

const STATE_CODES: readonly DisplayState[] = ["up", "unknown", "degraded", "down"];
const CODE_OF: Readonly<Record<DisplayState, number>> = { up: 0, unknown: 1, degraded: 2, down: 3 };

function pack(segments: readonly Segment[]): PackedSegments {
	const packed = new Float64Array(segments.length * 3);
	segments.forEach((segment, index) => {
		packed[index * 3] = segment.from;
		packed[index * 3 + 1] = segment.to;
		packed[index * 3 + 2] = CODE_OF[segment.state];
	});
	return packed;
}

function unpack(packed: PackedSegments): Segment[] {
	const segments: Segment[] = [];
	for (let index = 0; index + 2 < packed.length; index += 3) {
		segments.push({
			from: packed[index] as number,
			to: packed[index + 1] as number,
			state: STATE_CODES[packed[index + 2] as number] ?? "unknown",
		});
	}
	return segments;
}

/** A monitor's data for (part of) a local day. */
interface DayData extends TimeRange {
	/** The data covers `[from, coveredTo)`. */
	readonly coveredTo: number;
	readonly expected: number;
	readonly obtained: number;
	readonly segments: PackedSegments;
	/** Response times; empty for days older than the published series, and on pages without them. */
	readonly latency: PackedLatency;
}

/** A monitor's day: its data, or `pending` when it is not computed yet. Days without data are absent. */
type MonitorDay = DayData | "pending";

type DayRow = {
	monitor_id: string;
	day: string;
	day_from: number;
	day_to: number;
	covered_to: number;
	expected: number;
	obtained: number;
	segments: string;
	latency: string;
};

type StoredSegment = [from: number, to: number, state: DisplayState];

function encodeSegments(segments: PackedSegments): string {
	return JSON.stringify(unpack(segments).map((segment): StoredSegment => [segment.from, segment.to, segment.state]));
}

function decodeSegments(text: string): PackedSegments {
	try {
		return pack((JSON.parse(text) as StoredSegment[]).map(([from, to, state]) => ({ from, to, state })));
	} catch {
		return new Float64Array();
	}
}

/**
 * Where a day's data may be cached up to: whole steps from the day's start, behind what the
 * monitor may still change (`settleMs` before now).
 */
export function storableEnd(day: TimeRange, now: number, settleMs: number): number {
	const settled = now - settleMs;
	if (settled >= day.to) return day.to;
	if (settled <= day.from) return day.from;
	return day.from + Math.floor((settled - day.from) / CACHE_STEP_MS) * CACHE_STEP_MS;
}

/**
 * Until when a monitor's snapshot read at `readAt` still holds: its state, results and state
 * records change only when a check ends. So it holds until the next slot of its schedule,
 * or the re-check that may follow a result that was not `up`, or one configured interval
 * (in case a deploy shortened it), whichever comes first;
 * and not at all while the current slot's check has not been recorded yet, or while the
 * monitor is not running. Lateness, which grows without any check, is derived at display
 * time and needs no read.
 */
export function snapshotValidUntil(
	snapshot: MonitorSnapshot,
	monitor: { readonly intervalMs: number; readonly confirmation: { readonly recheckIntervalMs: number } },
	readAt: number,
): number {
	const recheckIntervalMs = monitor.confirmation.recheckIntervalMs;
	// Views asked for together (a visitor's page loads all three) share a read in any case.
	const floor = readAt + REREAD_AFTER_MS;
	const { period, lastCheck } = snapshot;
	if (period === null || period.status !== "active" || period.intervalMs === null) return floor;
	const slot = period.from + Math.floor((readAt - period.from) / period.intervalMs) * period.intervalMs;
	if (lastCheck === null || lastCheck.at < slot) return floor;
	// After a deploy that shortened the interval, the monitor checks at the new one as soon as
	// it runs the new version, before its recorded period says so.
	let until = Math.min(slot + period.intervalMs, readAt + monitor.intervalMs);
	if (lastCheck.state !== "up") until = Math.min(until, lastCheck.at + recheckIntervalMs);
	return Math.max(floor, until);
}

/** A monitor read this recently is not read again, whatever may have changed. */
const REREAD_AFTER_MS = 10_000;

function emptyDay(day: TimeRange): DayData {
	return { from: day.from, to: day.to, coveredTo: day.from, expected: 0, obtained: 0, segments: new Float64Array(), latency: NO_LATENCY };
}

/** `data` extended by `slice`, which must start where `data` ends. */
function extend(data: DayData, slice: TimelineSlice): DayData {
	return {
		from: data.from,
		to: data.to,
		coveredTo: slice.to,
		expected: data.expected + slice.expected,
		obtained: data.obtained + slice.obtained,
		segments: pack(concatSegments(unpack(data.segments), slice.segments)),
		latency: concatLatency(data.latency, packLatency(slice.latency ?? [])),
	};
}

function overlaps(day: TimeRange, from: number, to: number | null): boolean {
	return from < day.to && (to === null || to > day.from);
}

/** A computed response of the page, serialized once. */
export interface ViewResult {
	readonly status: 200 | 400 | 404;
	/** The response body, as JSON text. */
	readonly json: string;
	readonly generatedAt: number;
	/** Fresh until `generatedAt + ttlMs`. */
	readonly ttlMs: number;
	/**
	 * `false` when an administrator changed the page while it was computed: serve it to the
	 * request that asked, but cache it nowhere, so that it cannot outlive the change.
	 */
	readonly cacheable: boolean;
}

type Computed = Omit<ViewResult, "cacheable">;

function view(body: unknown, generatedAt: number, ttlMs: number, status: 200 | 404 = 200): Computed {
	return { status, json: JSON.stringify(body), generatedAt, ttlMs };
}

/**
 * Computed responses, reused while fresh and dropped when an administrator changes the page.
 * A response being computed is shared, so concurrent requests compute it once.
 *
 * A response is cacheable only if no change of the page overlapped its computation: the
 * generation did not move meanwhile ({@link Views.invalidate} after a change, and
 * {@link Views.beginChange} before it, both move it), and no announced change is still in
 * progress when it ends (its data may predate the write that is about to commit). Such a
 * response is served to the request that asked, and kept nowhere.
 */
class Views {
	private generation = 0;
	/** Ends of the announced changes in progress, oldest first; each expires on its own. */
	private changes: number[] = [];
	private readonly entries = new Map<string, { readonly at: number; readonly value: Promise<ViewResult>; ttl?: number }>();

	get(key: string, compute: () => Promise<Computed>): Promise<ViewResult> {
		const now = Date.now();
		const entry = this.entries.get(key);
		if (entry !== undefined && now >= entry.at && (entry.ttl === undefined || now - entry.at < entry.ttl)) {
			return entry.value;
		}
		const generation = this.generation;
		const fresh: { readonly at: number; readonly value: Promise<ViewResult>; ttl?: number } = {
			at: now,
			value: compute().then((computed) => ({
				...computed,
				cacheable: generation === this.generation && !this.changing(Date.now()),
			})),
		};
		this.entries.set(key, fresh);
		fresh.value.then(
			(value) => {
				fresh.ttl = value.cacheable ? value.ttlMs : 0;
			},
			() => {
				if (this.entries.get(key) === fresh) this.entries.delete(key);
			},
		);
		return fresh.value;
	}

	/** A change is about to be written: nothing computed until it is reported done is cached. */
	beginChange(now = Date.now()): void {
		this.changes.push(now + CHANGE_WINDOW_MS);
		this.generation++;
		this.entries.clear();
	}

	/** A change was written (it ends the oldest announced one, if any). */
	invalidate(now = Date.now()): void {
		this.changing(now);
		this.changes.shift();
		this.generation++;
		this.entries.clear();
	}

	private changing(now: number): boolean {
		this.changes = this.changes.filter((end) => end > now);
		return this.changes.length > 0;
	}
}

/** What the page last read from a monitor. */
interface SnapshotEntry {
	readonly value: MonitorSnapshot;
	readonly validUntil: number;
}

interface TransitionsEntry {
	readonly atStart: StateRecord | null;
	/** Oldest first; at most `2 × STOPPAGE_LIMIT`. */
	readonly records: readonly StateRecord[];
	readonly truncated: boolean;
}

interface HistoryEntry {
	readonly readAt: number;
	/** The local date that was today when it was read. */
	readonly today: string;
	readonly days: ReadonlyMap<string, MonitorDay>;
	/** Some stretches were left for later (`maxRows`): the history is still being filled in. */
	readonly filling: boolean;
}

interface Want {
	readonly snapshot: boolean;
	readonly history: boolean;
}

/** Counters for tests and measurements. A symbol, so that it is not reachable over RPC. */
export const PAGE_METRICS: unique symbol = Symbol("pageMetrics");

export interface PageMetrics {
	/** Views asked for (each a billed Durable Object request to this object). */
	viewRequests: number;
	/** Monitor DO calls made (each a billed Durable Object request). */
	monitorReads: number;
}

/**
 * One instance per status page (`pages[].id`), answering its public API. It pulls
 * from the Monitor DOs of its components when a response is built, never the other
 * way round, and reads incidents, maintenance and appearance from D1. Monitors that are in
 * none of its components are never read, and responses carry component-level data only.
 *
 * Costs per page, whatever the number of visitors (each Durable Object call is a billed
 * request, and on the Free plan they share a daily limit with the monitors' own alarms):
 *
 * - One `readForPage` call per monitor serves all views: its current state, new state records
 *   and, when the history is due, today's stretch. A monitor whose state cannot have changed
 *   since its last read ({@link snapshotValidUntil}) is not read.
 * - Computed responses are reused ({@link STATUS_TTL_MS}, {@link HISTORY_TTL_MS},
 *   {@link STOPPAGES_TTL_MS}) and dropped by {@link invalidate} when
 *   an administrator changes the page; in front of them, the Worker keeps them too.
 * - Past days of the history are cached in SQLite and, decoded, in memory.
 *
 * The configuration is the one of the version this object runs, like the Monitor DOs'.
 */
export class StatusPage extends DurableObject<Env> {
	private readonly store: MeteredStorage;
	private readonly views = new Views();
	private readonly metrics: PageMetrics = { viewRequests: 0, monitorReads: 0 };
	private readonly snapshots = new Map<string, SnapshotEntry>();
	private readonly transitions = new Map<string, TransitionsEntry>();
	private readonly histories = new Map<string, HistoryEntry>();
	/** The daily values cache, decoded: per monitor, its settled days. Loaded once. */
	private days: Map<string, Map<string, DayData>> | null = null;
	/** Per monitor, the `startedAt` of the cached days (`null`: no data). */
	private readonly sources = new Map<string, number | null>();
	/** When the history was last asked for: today's stretches are then read with the states. */
	private historyAskedAt = Number.NEGATIVE_INFINITY;
	private reading: Promise<void> | null = null;
	/** The history window's incidents as last read, by ID (see {@link INCIDENTS_FULL_READ_MS}). */
	private incidents: { readonly byId: ReadonlyMap<string, Incident>; readonly from: number; readonly syncedAt: number; readonly loadedAt: number } | null =
		null;
	/** Moved when incidents are deleted: a read that spans it is not kept. */
	private incidentGeneration = 0;
	/**
	 * What the status and the history last read from D1, used when D1 cannot be read (the Free
	 * plan's daily limit, an outage): the monitors' states are still worth showing.
	 */
	private lastStatusData: {
		readonly incidents: readonly IncidentWithLatestUpdates[];
		readonly maintenance: readonly Maintenance[];
		readonly appearance: PageAppearance;
	} | null = null;
	private lastHistoryData: { readonly incidents: readonly Incident[]; readonly maintenance: readonly Maintenance[] } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new MeteredStorage(ctx.storage);
		ctx.blockConcurrencyWhile(async () => {
			migrate(ctx.storage, STATUS_PAGE_MIGRATIONS);
		});
	}

	/** Rows read and written by this instance; for tests. */
	get [STORAGE_USAGE](): StorageUsage {
		return this.store.usage;
	}

	get [PAGE_METRICS](): PageMetrics {
		return this.metrics;
	}

	// -------------------------------------------------------------------------
	// RPC
	// -------------------------------------------------------------------------

	/** The status, history or stoppages, serialized. Incidents are read from D1 by the Worker. */
	getView(route: PageViewRoute): Promise<ViewResult> {
		this.metrics.viewRequests++;
		const page = this.page();
		switch (route.kind) {
			case "status":
				return this.views.get("status", () => this.buildStatus(page));
			case "history":
				return this.views.get("history", () => this.buildHistory(page));
			case "stoppages":
				return this.views.get("stoppages", () => this.buildStoppages(page));
			case "latency":
				return this.views.get("latency", () => this.buildLatency(page));
		}
	}

	/** The current status, parsed (for tests and tools; the public API uses {@link getView}). */
	async getStatus(): Promise<PageStatusResponse> {
		return JSON.parse((await this.getView({ kind: "status", pageId: this.page().id })).json) as PageStatusResponse;
	}

	async getHistory(): Promise<PageHistoryResponse> {
		return JSON.parse((await this.getView({ kind: "history", pageId: this.page().id })).json) as PageHistoryResponse;
	}

	async getStoppages(): Promise<StoppagesResponse> {
		return JSON.parse((await this.getView({ kind: "stoppages", pageId: this.page().id })).json) as StoppagesResponse;
	}

	async getLatency(): Promise<PageLatencyResponse> {
		return JSON.parse((await this.getView({ kind: "latency", pageId: this.page().id })).json) as PageLatencyResponse;
	}

	/**
	 * An administrator (or automation) is about to change what the page shows: until
	 * {@link invalidate} reports the change written (or {@link CHANGE_WINDOW_MS} passes), no
	 * response computed here is cacheable, since it may have read the data before the write.
	 */
	beginChange(): void {
		this.views.beginChange();
	}

	/**
	 * Drops the computed responses, after an administrator changed what the page shows.
	 * Responses being computed meanwhile are marked not cacheable. With `incidentsDeleted`, the
	 * history's incidents are read in full next time (reading changes cannot see a deletion).
	 */
	invalidate(options: { readonly incidentsDeleted?: boolean } = {}): void {
		if (options.incidentsDeleted === true) {
			this.incidentGeneration++;
			this.incidents = null;
		}
		this.views.invalidate();
	}

	/** Reads of D1 for the history's incidents so far: full and incremental (for tests). */
	readonly incidentReads = { full: 0, changes: 0 };

	/**
	 * The page's incidents that were unresolved at some time since `from`, for the history:
	 * read in full at most every {@link INCIDENTS_FULL_READ_MS}, else only those changed since
	 * the last read (with {@link INCIDENTS_OVERLAP_MS} of overlap), merged into what was read.
	 */
	private async historyIncidents(pageId: string, from: number): Promise<Incident[]> {
		const generation = this.incidentGeneration;
		const startedAt = Date.now();
		const cached = this.incidents;
		let byId: Map<string, Incident> | null = null;
		let loadedAt = startedAt;
		if (cached !== null && startedAt - cached.loadedAt < INCIDENTS_FULL_READ_MS && from >= cached.from) {
			this.incidentReads.changes++;
			const changed = await listIncidentsChangedSince(this.env.DB, pageId, cached.syncedAt - INCIDENTS_OVERLAP_MS);
			if (changed !== null) {
				byId = new Map(cached.byId);
				for (const incident of changed) byId.set(incident.id, incident);
				loadedAt = cached.loadedAt;
			}
		}
		if (byId === null) {
			this.incidentReads.full++;
			byId = new Map((await listIncidentsSince(this.env.DB, pageId, from)).map((incident) => [incident.id, incident]));
		}
		for (const [id, incident] of byId) {
			if (incident.resolvedAt !== null && incident.resolvedAt < from) byId.delete(id);
		}
		// Kept unless incidents were deleted meanwhile, or there are more than a full read keeps.
		if (generation === this.incidentGeneration) {
			this.incidents = byId.size <= MAX_HISTORY_INCIDENTS ? { byId, from, syncedAt: startedAt, loadedAt } : null;
		}
		return [...byId.values()];
	}

	private page(): ResolvedPage {
		const name = this.ctx.id.name;
		const page = name === undefined ? undefined : findPage(name);
		if (page === undefined) throw new Error(`No page "${name}" in the configuration of this version`);
		return page;
	}

	// -------------------------------------------------------------------------
	// Reading monitors
	// -------------------------------------------------------------------------

	private snapshotStale(monitor: ResolvedMonitor, now: number): boolean {
		const entry = this.snapshots.get(monitor.id);
		return entry === undefined || entry.validUntil <= now || !this.transitions.has(monitor.id);
	}

	/** Whether the monitor's history entry is older than `maxAge`, of another day, or being filled in. */
	private historyStale(monitor: ResolvedMonitor, now: number, today: string, maxAge: number): boolean {
		const entry = this.histories.get(monitor.id);
		if (entry === undefined || entry.today !== today) return true;
		return now - entry.readAt >= (entry.filling ? Math.min(maxAge, PENDING_TTL_MS) : maxAge);
	}

	/**
	 * Reads what `want` says each monitor needs, one call per monitor. A read in progress is
	 * awaited first and what it brought is taken into account, so views asked for together
	 * share one read.
	 */
	private async ensureMonitors(page: ResolvedPage, want: (monitor: ResolvedMonitor, now: number) => Want): Promise<void> {
		while (this.reading !== null) await this.reading.catch(() => {});
		const now = Date.now();
		const wanted = pageMonitors(page).flatMap((monitor) => {
			const needs = want(monitor, now);
			return needs.snapshot || needs.history ? [{ monitor, needs }] : [];
		});
		if (wanted.length === 0) return;
		this.reading = this.readMonitors(page, now, wanted).finally(() => {
			this.reading = null;
		});
		await this.reading;
	}

	private visibleDays(now: number): CalendarDay[] {
		const cutoff = config.retentionMs === null ? Number.NEGATIVE_INFINITY : now - config.retentionMs;
		return recentDays(now, config.timezone, HISTORY_DAYS).filter((day) => day.from >= cutoff);
	}

	/** The daily values cache, loaded (once) and pruned of what the page no longer needs. */
	private dayCache(page: ResolvedPage, days: readonly CalendarDay[]): Map<string, Map<string, DayData>> {
		const since = latencySince(Date.now());
		if (this.days === null) {
			const basis = daysBasis(config.timezone, hasLatency(page));
			if (this.store.kvGet<string>(DAYS_BASIS_KEY) !== basis) {
				this.store.transaction(() => {
					this.store.run("DELETE FROM monitor_days");
					this.store.run("DELETE FROM monitor_sources");
					this.store.kvPut(DAYS_BASIS_KEY, basis);
				});
			}
			for (const row of this.store.all<{ monitor_id: string; started_at: number | null }>(
				"SELECT monitor_id, started_at FROM monitor_sources",
			)) {
				this.sources.set(row.monitor_id, row.started_at);
			}
			this.days = new Map();
			for (const row of this.store.all<DayRow>(
				"SELECT monitor_id, day, day_from, day_to, covered_to, expected, obtained, segments, latency FROM monitor_days",
			)) {
				const byDay = this.days.get(row.monitor_id) ?? new Map<string, DayData>();
				byDay.set(row.day, {
					from: row.day_from,
					to: row.day_to,
					coveredTo: row.covered_to,
					expected: row.expected,
					obtained: row.obtained,
					segments: decodeSegments(row.segments),
					latency: row.day_to > since ? decodeLatency(row.latency) : NO_LATENCY,
				});
				this.days.set(row.monitor_id, byDay);
			}
		}
		// Days out of the window or past retention, monitors no longer on the page, days of
		// monitors without a source, and (defensively) days whose bounds no longer match.
		const wanted = new Map(days.map((day) => [day.date, day]));
		const onPage = new Set(pageMonitors(page).map((monitor) => monitor.id));
		const obsolete: [string, string | null][] = [];
		for (const [id, byDay] of this.days) {
			if (!onPage.has(id) || !this.sources.has(id)) {
				obsolete.push([id, null]);
				this.days.delete(id);
				continue;
			}
			for (const [date, data] of byDay) {
				const day = wanted.get(date);
				if (day === undefined || day.from !== data.from || day.to !== data.to) {
					obsolete.push([id, date]);
					byDay.delete(date);
				} else if (data.latency.length > 0 && data.to <= since) {
					// Older than the published series: not needed in memory any more.
					byDay.set(date, { ...data, latency: NO_LATENCY });
				}
			}
		}
		const gone = [...this.sources.keys()].filter((id) => !onPage.has(id));
		if (obsolete.length > 0 || gone.length > 0) {
			this.store.transaction(() => {
				for (const [id, date] of obsolete) {
					if (date === null) this.store.run("DELETE FROM monitor_days WHERE monitor_id = ?", id);
					else this.store.run("DELETE FROM monitor_days WHERE monitor_id = ? AND day = ?", id, date);
				}
				for (const id of gone) {
					this.store.run("DELETE FROM monitor_sources WHERE monitor_id = ?", id);
					this.sources.delete(id);
				}
			});
		}
		return this.days;
	}

	/**
	 * The history stretches to read from a monitor, newest day first: per day, what is not
	 * cached yet, split into what has settled (cached once read) and the rest (read each time).
	 */
	private planHistory(
		monitor: ResolvedMonitor,
		days: readonly CalendarDay[],
		cache: ReadonlyMap<string, ReadonlyMap<string, DayData>>,
		now: number,
	): { readonly date: string; readonly kind: "stored" | "live"; readonly range: TimeRange }[] {
		const startedAt = this.sources.get(monitor.id);
		const entries: { date: string; kind: "stored" | "live"; range: TimeRange }[] = [];
		for (const day of [...days].reverse()) {
			// A monitor without data: only today is asked for, to notice when it starts.
			if (startedAt === null && day.to <= now) continue;
			if (typeof startedAt === "number" && day.to <= startedAt) continue;
			const end = Math.min(day.to, now);
			const have = cache.get(monitor.id)?.get(day.date)?.coveredTo ?? day.from;
			if (have >= end) continue;
			const storeEnd = Math.max(have, storableEnd(day, now, settledAfterMs(monitor)));
			if (storeEnd > have) entries.push({ date: day.date, kind: "stored", range: { from: have, to: storeEnd } });
			if (end > storeEnd) entries.push({ date: day.date, kind: "live", range: { from: storeEnd, to: end } });
		}
		return entries;
	}

	private async readMonitors(
		page: ResolvedPage,
		now: number,
		wanted: readonly { readonly monitor: ResolvedMonitor; readonly needs: Want }[],
	): Promise<void> {
		const days = this.visibleDays(now);
		const today = days.at(-1)?.date ?? "";
		const windowFrom = days[0]?.from ?? now;
		const cache = this.dayCache(page, days);
		const latency = hasLatency(page);
		const requests = wanted.map(({ monitor, needs }) => {
			const plan = needs.history ? this.planHistory(monitor, days, cache, now) : [];
			const known = this.transitions.get(monitor.id);
			const after = known === undefined ? null : (known.records.at(-1)?.since ?? known.atStart?.since ?? null);
			return {
				monitor,
				needs,
				plan,
				after,
				request: {
					timeoutMs: monitor.timeoutMs,
					snapshot: needs.snapshot,
					ranges: plan.map((entry) => entry.range),
					maxRows: FILL_ROWS_PER_MONITOR,
					latencySince: latency ? latencySince(now) : null,
					transitions: needs.snapshot
						? { from: windowFrom, to: now + 1, limit: 2 * STOPPAGE_LIMIT, after: after !== null && after >= windowFrom ? after : null }
						: null,
				},
			};
		});
		this.metrics.monitorReads += requests.length;
		const outcomes = await forEachLimited(
			requests,
			MONITOR_CONCURRENCY,
			({ monitor, request }) => monitorStub(this.env, monitor).readForPage(request) as Promise<PageReadResponse>,
		);

		const writes: DayRow[] = [];
		const sourceWrites: { readonly id: string; readonly startedAt: number | null }[] = [];
		const dropped = new Set<string>();
		requests.forEach(({ monitor, needs, plan, request }, index) => {
			const outcome = outcomes[index];
			let response: PageReadResponse | null = null;
			if (outcome?.status === "fulfilled") {
				response = outcome.value;
			} else {
				// Cached days still show; the days it had to read stay pending.
				console.warn(`Page "${page.id}": could not read monitor "${monitor.id}"`, outcome?.reason);
			}

			let startedAt = this.sources.get(monitor.id);
			const incremental = request.transitions !== null && request.transitions.after != null;
			// The plan relied on cached days of another history: read again soon, as when filling.
			let replanned = false;
			if (response !== null && (!this.sources.has(monitor.id) || startedAt !== response.startedAt)) {
				replanned = cache.has(monitor.id);
				// First seen, started, purged, or purged and started again: cached days (if any)
				// describe another history, and so do state records read as new ones.
				if (cache.has(monitor.id)) dropped.add(monitor.id);
				cache.delete(monitor.id);
				if (incremental) this.transitions.delete(monitor.id);
				startedAt = response.startedAt;
				this.sources.set(monitor.id, startedAt);
				sourceWrites.push({ id: monitor.id, startedAt });
			}
			if (response?.transitions && !(incremental && !this.transitions.has(monitor.id))) {
				const fresh = response.transitions;
				const known = this.transitions.get(monitor.id);
				if (!incremental || known === undefined || fresh.truncated) {
					this.transitions.set(monitor.id, fresh.truncated ? { atStart: null, records: fresh.changes, truncated: true } : {
						atStart: fresh.atStart,
						records: fresh.changes,
						truncated: false,
					});
				} else {
					const records = [...known.records, ...fresh.changes];
					const kept = records.slice(-2 * STOPPAGE_LIMIT);
					this.transitions.set(monitor.id, {
						atStart: kept.length < records.length ? null : known.atStart,
						records: kept,
						truncated: known.truncated || kept.length < records.length,
					});
				}
			}
			if (response?.snapshot) {
				this.snapshots.set(monitor.id, {
					value: response.snapshot,
					validUntil: snapshotValidUntil(response.snapshot, monitor, now),
				});
			}
			if (!needs.history) return;

			// The history: cached days, extended by the slices just read.
			const slices = new Map<string, { stored?: TimelineSlice; live?: TimelineSlice }>();
			const plannedByDay = new Map<string, { stored?: TimeRange; live?: TimeRange }>();
			let filling = replanned;
			plan.forEach((entry, position) => {
				const forPlan = plannedByDay.get(entry.date) ?? {};
				forPlan[entry.kind] = entry.range;
				plannedByDay.set(entry.date, forPlan);
				if (response === null) return;
				const slice = response.slices[position];
				// Skipped for maxRows (null): the day stays pending, and is read again soon.
				if (slice === null) filling = true;
				if (slice === undefined || slice === null) return;
				const forDay = slices.get(entry.date) ?? {};
				forDay[entry.kind] = slice;
				slices.set(entry.date, forDay);
			});
			const byDay = new Map<string, MonitorDay>();
			if (startedAt !== null) {
				for (const day of days) {
					if (typeof startedAt === "number" && day.to <= startedAt) continue;
					let data = cache.get(monitor.id)?.get(day.date) ?? emptyDay(day);
					const planned = plannedByDay.get(day.date);
					const read = slices.get(day.date);
					let complete = data.coveredTo >= Math.min(day.to, now);
					for (const kind of ["stored", "live"] as const) {
						const wantedRange = planned?.[kind];
						if (wantedRange === undefined) continue;
						const slice = read?.[kind];
						complete = slice !== undefined && slice.from === data.coveredTo;
						if (!complete || slice === undefined) break;
						data = extend(data, slice);
						// Cache what has settled, unless the Monitor DO's clock cut the slice short.
						if (kind === "stored" && slice.to === wantedRange.to) {
							const settled = cache.get(monitor.id) ?? new Map<string, DayData>();
							settled.set(day.date, data);
							cache.set(monitor.id, settled);
							writes.push({
								monitor_id: monitor.id,
								day: day.date,
								day_from: day.from,
								day_to: day.to,
								covered_to: data.coveredTo,
								expected: data.expected,
								obtained: data.obtained,
								segments: encodeSegments(data.segments),
								latency: encodeLatency(data.latency),
							});
						}
					}
					byDay.set(day.date, complete ? data : "pending");
				}
			}
			this.histories.set(monitor.id, { readAt: now, today, days: byDay, filling });
		});

		if (writes.length > 0 || sourceWrites.length > 0 || dropped.size > 0) {
			this.store.transaction(() => {
				for (const id of dropped) this.store.run("DELETE FROM monitor_days WHERE monitor_id = ?", id);
				for (const source of sourceWrites) {
					this.store.run(
						`INSERT INTO monitor_sources (monitor_id, started_at) VALUES (?, ?)
						ON CONFLICT (monitor_id) DO UPDATE SET started_at = excluded.started_at`,
						source.id,
						source.startedAt,
					);
				}
				for (const row of writes) {
					this.store.run(
						`INSERT INTO monitor_days (monitor_id, day, day_from, day_to, covered_to, expected, obtained, segments, latency)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (monitor_id, day) DO UPDATE SET day_from = excluded.day_from, day_to = excluded.day_to,
							covered_to = excluded.covered_to, expected = excluded.expected, obtained = excluded.obtained,
							segments = excluded.segments, latency = excluded.latency`,
						row.monitor_id,
						row.day,
						row.day_from,
						row.day_to,
						row.covered_to,
						row.expected,
						row.obtained,
						row.segments,
						row.latency,
					);
				}
			});
		}
	}

	// -------------------------------------------------------------------------
	// Status
	// -------------------------------------------------------------------------

	private async buildStatus(page: ResolvedPage): Promise<Computed> {
		const historyWanted = Date.now() - this.historyAskedAt < 2 * HISTORY_TTL_MS;
		await this.ensureMonitors(page, (monitor, now) => {
			const snapshot = this.snapshotStale(monitor, now);
			// Monitors read anyway also bring today's stretch when the history will want it soon.
			const today = this.visibleDays(now).at(-1)?.date ?? "";
			const history = snapshot && historyWanted && this.historyStale(monitor, now, today, HISTORY_TTL_MS - STATUS_TTL_MS);
			return { snapshot, history };
		});
		const now = Date.now();
		let outdated = false;
		let data = this.lastStatusData;
		try {
			await ensureSchema(this.env.DB);
			const [incidents, maintenance, appearance] = await Promise.all([
				listOpenIncidentsWithUpdates(this.env.DB, page.id, STATUS_UPDATES_PER_INCIDENT),
				listMaintenanceBetween(this.env.DB, page.id, now, Number.MAX_SAFE_INTEGER),
				getAppearance(this.env.DB, page.id),
			]);
			data = { incidents, maintenance, appearance };
			this.lastStatusData = data;
		} catch (error) {
			console.warn(`Page "${page.id}": could not read incidents, maintenance and appearance; showing them as last read`, error);
			outdated = true;
		}
		const incidents = data?.incidents ?? [];
		// As last read, some windows may have ended since.
		const maintenance = (data?.maintenance ?? []).filter((window) => window.endsAt > now);
		const appearance = data?.appearance ?? defaultAppearance(page.id);

		const active = maintenance.filter((window) => window.startsAt <= now);
		const monitors = new Map(pageMonitors(page).map((monitor) => [monitor.id, monitor]));
		const components = page.components.map((component): ComponentStatus => {
			const impacts = incidents.flatMap((incident) =>
				incident.components.filter((affected) => affected.id === component.id).map((affected) => affected.impact),
			);
			const states = component.monitors.map((id): DisplayState => {
				const monitor = monitors.get(id);
				const snapshot = this.snapshots.get(id)?.value;
				return monitor === undefined || snapshot === undefined ? "unknown" : displayState(snapshot, monitor.timeoutMs, now).state;
			});
			return {
				id: component.id,
				name: component.name,
				state: componentState(states, impacts),
				monitored: component.monitors.length > 0,
				maintenance: active.some((window) => window.components.includes(component.id)),
				latency: component.latency,
			};
		});
		const body: PageStatusResponse = {
			pageId: page.id,
			appearance: publicAppearance(appearance, uploadsBucket(this.env) !== undefined),
			template: page.template,
			reportUrl: page.reportUrl,
			overall: worstState(
				components.map((component) => component.state),
				"unknown",
			),
			components,
			groups: page.groups.map((group) => ({ id: group.id, name: group.name, components: [...group.components] })),
			incidents: incidents.map((incident) => publicIncidentWithUpdates(incident, page)),
			maintenance: {
				active: active.map((window) => publicMaintenance(window, page)),
				upcoming: maintenance.filter((window) => window.startsAt > now).map((window) => publicMaintenance(window, page)),
			},
			incidentsOutdated: outdated,
			generatedAt: now,
		};
		return view(body, now, outdated ? OUTDATED_TTL_MS : STATUS_TTL_MS);
	}

	// -------------------------------------------------------------------------
	// History
	// -------------------------------------------------------------------------

	private async buildHistory(page: ResolvedPage): Promise<Computed> {
		this.historyAskedAt = Date.now();
		await this.ensureMonitors(page, (monitor, now) => {
			const today = this.visibleDays(now).at(-1)?.date ?? "";
			const history = this.historyStale(monitor, now, today, HISTORY_TTL_MS);
			return { history, snapshot: history && this.snapshotStale(monitor, now) };
		});
		const now = Date.now();
		const days = recentDays(now, config.timezone, HISTORY_DAYS);
		const first = days[0] as CalendarDay;
		const last = days.at(-1) as CalendarDay;
		const visible = new Set(this.visibleDays(now).map((day) => day.date));
		let outdated = false;
		let data = this.lastHistoryData;
		try {
			await ensureSchema(this.env.DB);
			const [read, windows] = await Promise.all([
				this.historyIncidents(page.id, first.from),
				listMaintenanceOverlapping(this.env.DB, page.id, first.from, last.to),
			]);
			data = { incidents: read, maintenance: windows };
			this.lastHistoryData = data;
		} catch (error) {
			console.warn(`Page "${page.id}": could not read the history's incidents and maintenance; using them as last read`, error);
			outdated = true;
		}
		const incidents = data?.incidents ?? [];
		const maintenance = data?.maintenance ?? [];

		const referencedIncidents = new Set<string>();
		const referencedMaintenance = new Set<string>();
		let complete = true;
		const components = page.components.map((component): ComponentHistory => {
			const monitored = component.monitors.length > 0;
			const affecting = incidents.filter((incident) => incident.components.some((affected) => affected.id === component.id));
			const windows = maintenance.filter((window) => window.components.includes(component.id));
			const cuts = windows.map((window) => ({ from: window.startsAt, to: window.endsAt }));
			const totals = { upMs: 0, downMs: 0, expected: 0, obtained: 0 };
			const starts = component.monitors.map((id) => this.sources.get(id)).filter((start): start is number => typeof start === "number");

			const history = days.map((day): HistoryDay => {
				const incidentIds = affecting
					.filter((incident) => overlaps(day, incident.startedAt, incident.resolvedAt))
					.map((incident) => incident.id);
				const maintenanceIds = windows
					.filter((window) => overlaps(day, window.startsAt, window.endsAt))
					.map((window) => window.id);
				for (const id of incidentIds) referencedIncidents.add(id);
				for (const id of maintenanceIds) referencedMaintenance.add(id);
				const base = { date: day.date, from: day.from, to: day.to, incidents: incidentIds, maintenance: maintenanceIds };
				const none = {
					...base,
					uptime: null,
					coverage: null,
					downtimeMs: null,
					degradedMs: null,
					observedMs: null,
					checks: null,
					worst: null,
					pending: false,
				};
				if (!monitored || !visible.has(day.date)) return none;

				const parts = component.monitors.map((id) => {
					const entry = this.histories.get(id);
					// Not read yet (its read failed): pending.
					return entry === undefined ? "pending" : entry.days.get(day.date);
				});
				if (parts.includes("pending")) {
					complete = false;
					return { ...none, pending: true };
				}
				const data = parts.filter((part): part is DayData => part !== undefined && part !== "pending");
				const segments = excludeWindows(
					combineTimelines(data.map((part) => unpack(part.segments))),
					cuts,
				);
				const summary = summarize(segments);
				const expected = data.reduce((sum, part) => sum + part.expected, 0);
				const obtained = data.reduce((sum, part) => sum + part.obtained, 0);
				totals.upMs += summary.upMs;
				totals.downMs += summary.downMs;
				totals.expected += expected;
				totals.obtained += obtained;
				const uptime = uptimeRatio(summary.upMs, summary.downMs);
				return {
					...base,
					uptime,
					coverage: coverageRatio(obtained, expected),
					downtimeMs: uptime === null ? null : summary.downMs,
					degradedMs: uptime === null ? null : summary.degradedMs,
					observedMs: summary.upMs + summary.downMs,
					checks: { expected, obtained },
					worst: summary.worst,
					pending: false,
				};
			});
			return {
				id: component.id,
				name: component.name,
				monitored,
				uptime: monitored ? uptimeRatio(totals.upMs, totals.downMs) : null,
				coverage: monitored ? coverageRatio(totals.obtained, totals.expected) : null,
				observedMs: monitored ? totals.upMs + totals.downMs : null,
				observedFrom: starts.length === 0 ? null : Math.min(...starts),
				days: history,
			};
		});

		const marker = (id: string, title: string, from: number, to: number | null): HistoryMarker => ({ id, title, from, to });
		const body: PageHistoryResponse = {
			timezone: config.timezone,
			from: first.from,
			components,
			incidents: incidents
				.filter((incident) => referencedIncidents.has(incident.id))
				.sort((a, b) => a.startedAt - b.startedAt)
				.map((incident) => marker(incident.id, incident.title, incident.startedAt, incident.resolvedAt)),
			maintenance: maintenance
				.filter((window) => referencedMaintenance.has(window.id))
				.sort((a, b) => a.startsAt - b.startsAt)
				.map((window) => marker(window.id, window.title, window.startsAt, window.endsAt)),
			complete,
			incidentsOutdated: outdated,
			generatedAt: now,
		};
		// Short while missing days are being filled in, or D1 could not be read; a monitor that
		// failed to answer is asked again with the rest, not more often (it may be failing for load).
		const filling = pageMonitors(page).some((monitor) => this.histories.get(monitor.id)?.filling === true);
		return view(body, now, filling ? PENDING_TTL_MS : outdated ? OUTDATED_TTL_MS : HISTORY_TTL_MS);
	}

	// -------------------------------------------------------------------------
	// Response times (latency.ts)
	// -------------------------------------------------------------------------

	/**
	 * Response times of the components that publish them, from the days the history reads (one
	 * read serves both, at the history's pace): today's latest stretch is read with the history,
	 * the rest comes from the cached days.
	 */
	private async buildLatency(page: ResolvedPage): Promise<Computed> {
		const shown = page.components.filter((component) => component.latency);
		if (shown.length > 0) {
			this.historyAskedAt = Date.now();
			await this.ensureMonitors(page, (monitor, now) => {
				const today = this.visibleDays(now).at(-1)?.date ?? "";
				const history = this.historyStale(monitor, now, today, HISTORY_TTL_MS);
				return { history, snapshot: history && this.snapshotStale(monitor, now) };
			});
		}
		const now = Date.now();
		const since = latencySince(now);
		const days = this.visibleDays(now).filter((day) => day.to > since);
		let complete = true;
		const components = shown.map((component): ComponentLatency => {
			const lists: ReturnType<typeof unpackLatency>[] = [];
			const latest: { at: number; ms: number }[] = [];
			for (const id of component.monitors) {
				const entry = this.histories.get(id);
				if (entry === undefined) complete = false;
				for (const day of entry === undefined ? [] : days) {
					const data = entry?.days.get(day.date);
					if (data === "pending") complete = false;
					else if (data !== undefined && data.latency.length > 0) lists.push(unpackLatency(data.latency));
				}
				const check = this.snapshots.get(id)?.value.lastCheck ?? null;
				if (check !== null && check.latencyMs !== null) latest.push({ at: check.at, ms: check.latencyMs });
			}
			const buckets = mergeLatency(lists);
			const series = (range: { readonly bucketMs: number; readonly count: number }) =>
				latencySeries(buckets, now, range.bucketMs, range.count);
			return {
				id: component.id,
				name: component.name,
				latest:
					latest.length === 0
						? null
						: {
								at: Math.max(...latest.map((entry) => entry.at)),
								ms: Math.round(latest.reduce((sum, entry) => sum + entry.ms, 0) / latest.length),
							},
				day: series(LATENCY_RANGES.day),
				week: series(LATENCY_RANGES.week),
				month: series(LATENCY_RANGES.month),
			};
		});
		const body: PageLatencyResponse = { components, complete, generatedAt: now };
		const filling = pageMonitors(page).some((monitor) => this.histories.get(monitor.id)?.filling === true);
		return view(body, now, filling || !complete ? PENDING_TTL_MS : HISTORY_TTL_MS);
	}

	// -------------------------------------------------------------------------
	// Stoppage history
	// -------------------------------------------------------------------------

	private async buildStoppages(page: ResolvedPage): Promise<Computed> {
		await this.ensureMonitors(page, (monitor, now) => ({ snapshot: this.snapshotStale(monitor, now), history: false }));
		const now = Date.now();
		const from = this.visibleDays(now)[0]?.from ?? now;
		let truncated = false;
		const periods = new Map<string, DownPeriod[]>();
		for (const monitor of pageMonitors(page)) {
			const entry = this.transitions.get(monitor.id);
			if (entry === undefined) continue;
			truncated ||= entry.truncated;
			const records: StateRecord[] = entry.atStart === null ? [...entry.records] : [entry.atStart, ...entry.records];
			periods.set(
				monitor.id,
				downPeriods(records).filter((period) => period.to === null || period.to > from),
			);
		}
		const stoppages: Stoppage[] = page.components
			.flatMap((component) =>
				mergeDownPeriods(component.monitors.flatMap((id) => periods.get(id) ?? [])).map((period) => ({
					componentId: component.id,
					from: period.from,
					to: period.to,
				})),
			)
			.sort((a, b) => b.from - a.from || a.componentId.localeCompare(b.componentId));
		const body: StoppagesResponse = {
			from,
			stoppages: stoppages.slice(0, STOPPAGE_LIMIT),
			truncated: truncated || stoppages.length > STOPPAGE_LIMIT,
			generatedAt: now,
		};
		return view(body, now, STOPPAGES_TTL_MS);
	}
}

/** The page's Durable Object. Only for pages in the configuration: any other name would create an object. */
export function statusPageStub(env: Env, pageId: string) {
	return env.STATUS_PAGE.getByName(pageId);
}
