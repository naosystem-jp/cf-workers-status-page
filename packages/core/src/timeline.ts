/**
 * Timelines of states for history and uptime: what a monitor's confirmed states,
 * schedule and results say about each moment, combined per component. Pure functions, so
 * that the Worker, the status pages and tests share one definition.
 */
import { type DisplayState, isCheckState, worseOf } from "./display";
import type { CheckState } from "./provider";

/** A half-open time range `[from, to)` in milliseconds since the epoch. */
export interface TimeRange {
	readonly from: number;
	readonly to: number;
}

/**
 * A stretch of time with one schedule. A monitor's periods are contiguous: each one ends
 * where the next begins. A new period starts only when something changes (the monitor
 * starts, its interval changes, it leaves or returns to the configuration).
 */
export interface SchedulePeriod {
	/** Start, inclusive. */
	readonly from: number;
	/** End, exclusive; `null` for the current period. */
	readonly to: number | null;
	/**
	 * `active`: scheduled checks every `intervalMs`, from `from` (the grid's anchor).
	 * `stopped`: the monitor was not in the configuration. A stopped period is neither
	 * uptime nor downtime, and its slots are not missed checks.
	 */
	readonly status: "active" | "stopped";
	/** `null` when stopped. */
	readonly intervalMs: number | null;
}

/**
 * A state in a monitor's history: a confirmed state; `stopped` while the monitor was not in
 * the configuration; `unconfirmed` from when it resumed until a state is confirmed again. At
 * display time, `unconfirmed` (like no record at all) is `unknown`; neither `stopped` nor
 * `unconfirmed` counts as uptime or downtime.
 */
export type RecordedState = CheckState | "stopped" | "unconfirmed";

/** One record of the state history. Each record lasts until the next one's `since`. */
export interface StateRecord {
	readonly state: RecordedState;
	/** When it began. For a confirmed state, when the run of results that confirmed it began. */
	readonly since: number;
	/** When it was recorded: for a confirmed state, the time of the result that confirmed it. */
	readonly confirmedAt: number;
}

/** A stretch of time in one display state. Lists of segments are sorted and never overlap. */
export interface Segment extends TimeRange {
	readonly state: DisplayState;
}

/** What a monitor's storage says about a time range. */
export interface TimelineSource {
	/** Schedule periods that overlap the range, oldest first. */
	readonly periods: readonly SchedulePeriod[];
	/** The state record in effect at the start of the range. */
	readonly atStart: StateRecord | null;
	/** State records that begin inside the range, oldest first. */
	readonly changes: readonly StateRecord[];
	/**
	 * Start times of the checks that produced a state, ascending: at least those from
	 * `staleAfter(interval)` before the range up to its end, so that lateness at the start of
	 * the range is judged from the results before it.
	 */
	readonly resultTimes: readonly number[];
}

/** Index of the first value `>= target` in a sorted array. */
function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] as number) < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** Appends a segment, merging it into the previous one when they touch and have the same state. */
function append(segments: Segment[], from: number, to: number, state: DisplayState): void {
	if (to <= from) return;
	const last = segments.at(-1);
	if (last !== undefined && last.to === from && last.state === state) {
		segments[segments.length - 1] = { from: last.from, to, state };
	} else {
		segments.push({ from, to, state });
	}
}

/** `a` followed by `b` (which starts where `a` ends, or later), merging at the seam. */
export function concatSegments(a: readonly Segment[], b: readonly Segment[]): Segment[] {
	const result = [...a];
	for (const segment of b) append(result, segment.from, segment.to, segment.state);
	return result;
}

/**
 * Where a monitor is late inside one active schedule period and `range`: from
 * `staleAfterMs` after the latest anchor until the next one, where an anchor is the start of
 * the period or a check that produced a state. This is the display-time rule (see
 * `displayState`) applied to every past moment, so the history shows `unknown` exactly when
 * the live page did.
 *
 * Results from before the range are needed to judge its start: with none in the
 * `staleAfterMs` before it, the monitor is late from the range's start on.
 */
export function lateSpans(
	period: Pick<SchedulePeriod, "from" | "to">,
	range: TimeRange,
	resultTimes: readonly number[],
	staleAfterMs: number,
): TimeRange[] {
	const low = Math.max(period.from, range.from);
	const high = Math.min(period.to ?? Number.POSITIVE_INFINITY, range.to);
	if (low >= high) return [];
	const spans: TimeRange[] = [];
	const push = (from: number, to: number) => {
		const clippedFrom = Math.max(from, low);
		const clippedTo = Math.min(to, high);
		if (clippedFrom < clippedTo) spans.push({ from: clippedFrom, to: clippedTo });
	};
	// The latest anchor at or before `range.from - staleAfterMs` is at least that early, so
	// starting from there judges the range's start correctly whatever came before.
	let anchor = Math.max(period.from, range.from - staleAfterMs);
	for (let index = lowerBound(resultTimes, anchor); index < resultTimes.length; index++) {
		const at = resultTimes[index] as number;
		if (at >= high) break;
		if (at - anchor > staleAfterMs) push(anchor + staleAfterMs, at);
		anchor = at;
	}
	if (high - anchor > staleAfterMs) push(anchor + staleAfterMs, high);
	return spans;
}

/**
 * The display state of a monitor at every moment of `range`:
 *
 * - outside active schedule periods (before it started, or `stopped`): no segment, which is
 *   neither uptime nor downtime;
 * - while late (see {@link lateSpans}): `unknown`;
 * - otherwise the confirmed state in effect, or `unknown` before any is confirmed and while
 *   `unconfirmed` after resuming.
 *
 * `staleAfter` gives the lateness threshold for a period's interval (see `staleAfterMs`).
 */
export function monitorTimeline(
	range: TimeRange,
	source: TimelineSource,
	staleAfter: (intervalMs: number) => number,
): Segment[] {
	const active: TimeRange[] = [];
	const late: TimeRange[] = [];
	for (const period of source.periods) {
		if (period.status !== "active" || period.intervalMs === null) continue;
		const from = Math.max(range.from, period.from);
		const to = Math.min(range.to, period.to ?? Number.POSITIVE_INFINITY);
		if (from >= to) continue;
		active.push({ from, to });
		late.push(...lateSpans(period, range, source.resultTimes, staleAfter(period.intervalMs)));
	}
	if (active.length === 0) return [];

	const records = [...(source.atStart === null ? [] : [source.atStart]), ...source.changes];
	const points = new Set<number>();
	for (const list of [active, late]) {
		for (const part of list) {
			points.add(part.from);
			points.add(part.to);
		}
	}
	for (const record of records) {
		if (record.since > range.from && record.since < range.to) points.add(record.since);
	}
	const sorted = [...points].sort((a, b) => a - b);

	const segments: Segment[] = [];
	let activeIndex = 0;
	let lateIndex = 0;
	let recordIndex = -1;
	for (let index = 0; index + 1 < sorted.length; index++) {
		const from = sorted[index] as number;
		const to = sorted[index + 1] as number;
		while (activeIndex < active.length && (active[activeIndex] as TimeRange).to <= from) activeIndex++;
		const part = active[activeIndex];
		if (part === undefined || part.from > from) continue;
		while (lateIndex < late.length && (late[lateIndex] as TimeRange).to <= from) lateIndex++;
		const span = late[lateIndex];
		if (span !== undefined && span.from <= from) {
			append(segments, from, to, "unknown");
			continue;
		}
		while (recordIndex + 1 < records.length && (records[recordIndex + 1] as StateRecord).since <= from) recordIndex++;
		const state = records[recordIndex]?.state;
		append(segments, from, to, state !== undefined && isCheckState(state) ? state : "unknown");
	}
	return segments;
}

/**
 * A component's timeline from its monitors': at each moment, the worst state of
 * the monitors that have data then (`down` > `degraded` > `unknown` > `up`). Moments where
 * none of them has data have no segment.
 */
export function combineTimelines(timelines: readonly (readonly Segment[])[]): Segment[] {
	if (timelines.length === 1) return [...(timelines[0] as readonly Segment[])];
	const points = new Set<number>();
	for (const timeline of timelines) {
		for (const segment of timeline) {
			points.add(segment.from);
			points.add(segment.to);
		}
	}
	const sorted = [...points].sort((a, b) => a - b);
	const cursors = timelines.map(() => 0);
	const result: Segment[] = [];
	for (let index = 0; index + 1 < sorted.length; index++) {
		const from = sorted[index] as number;
		const to = sorted[index + 1] as number;
		let worst: DisplayState | undefined;
		timelines.forEach((timeline, which) => {
			let cursor = cursors[which] as number;
			while (cursor < timeline.length && (timeline[cursor] as Segment).to <= from) cursor++;
			cursors[which] = cursor;
			const segment = timeline[cursor];
			if (segment !== undefined && segment.from <= from) {
				worst = worst === undefined ? segment.state : worseOf(worst, segment.state);
			}
		});
		if (worst !== undefined) append(result, from, to, worst);
	}
	return result;
}

/** Sorted, non-overlapping ranges covering the same time as `ranges`. */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
	const sorted = ranges.filter((range) => range.from < range.to).sort((a, b) => a.from - b.from);
	const merged: TimeRange[] = [];
	for (const range of sorted) {
		const last = merged.at(-1);
		if (last !== undefined && range.from <= last.to) {
			merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, range.to) };
		} else {
			merged.push(range);
		}
	}
	return merged;
}

/** `segments` without the time inside `windows` (maintenance: excluded from uptime). */
export function excludeWindows(segments: readonly Segment[], windows: readonly TimeRange[]): Segment[] {
	const cuts = mergeRanges(windows);
	if (cuts.length === 0) return [...segments];
	const result: Segment[] = [];
	for (const segment of segments) {
		let from = segment.from;
		for (const cut of cuts) {
			if (cut.to <= from) continue;
			if (cut.from >= segment.to) break;
			if (cut.from > from) result.push({ from, to: cut.from, state: segment.state });
			from = Math.max(from, cut.to);
			if (from >= segment.to) break;
		}
		if (from < segment.to) result.push({ from, to: segment.to, state: segment.state });
	}
	return result;
}

export interface TimelineSummary {
	/** Time in `up` or `degraded`: `degraded` counts as uptime. */
	readonly upMs: number;
	/** Time in `down`, the only state that counts as an outage. */
	readonly downMs: number;
	/** Time in `degraded`, part of `upMs`. */
	readonly degradedMs: number;
	/** Time in `unknown`, excluded from uptime. */
	readonly unknownMs: number;
	/** The worst confirmed state (`down` > `degraded` > `up`), or `null` when there is none. */
	readonly worst: CheckState | null;
}

const CONFIRMED_RANK: Readonly<Record<CheckState, number>> = { up: 0, degraded: 1, down: 2 };

export function summarize(segments: readonly Segment[]): TimelineSummary {
	let upMs = 0;
	let downMs = 0;
	let degradedMs = 0;
	let unknownMs = 0;
	let worst: CheckState | null = null;
	for (const segment of segments) {
		const length = segment.to - segment.from;
		if (segment.state === "unknown") {
			unknownMs += length;
			continue;
		}
		if (segment.state === "down") downMs += length;
		else upMs += length;
		if (segment.state === "degraded") degradedMs += length;
		if (worst === null || CONFIRMED_RANK[segment.state] > CONFIRMED_RANK[worst]) worst = segment.state;
	}
	return { upMs, downMs, degradedMs, unknownMs, worst };
}

/**
 * Uptime as a ratio: time `up` or `degraded` over time with a confirmed state. `null`
 * when no time had a confirmed state (everything unknown, stopped or under maintenance).
 */
export function uptimeRatio(upMs: number, downMs: number): number | null {
	const known = upMs + downMs;
	return known > 0 ? upMs / known : null;
}

/**
 * Coverage: scheduled checks that produced a state over the checks the schedule
 * expected. At most 1 (a check near a range boundary can land in the next range). `null`
 * when nothing was expected.
 */
export function coverageRatio(obtained: number, expected: number): number | null {
	return expected > 0 ? Math.min(1, obtained / expected) : null;
}

/** A stretch of confirmed `down`. `to` is `null` while it lasts. */
export interface DownPeriod {
	readonly from: number;
	readonly to: number | null;
}

/**
 * The confirmed `down` periods in a state history (records oldest first): each lasts from its
 * record's `since` until the next record, whatever that is (recovery, `degraded`, a stop).
 */
export function downPeriods(records: readonly StateRecord[]): DownPeriod[] {
	const periods: DownPeriod[] = [];
	records.forEach((record, index) => {
		if (record.state !== "down") return;
		const next = records[index + 1];
		const last = periods.at(-1);
		// Two `down` records in a row (not written today, but harmless) make one period.
		if (last !== undefined && last.to === record.since) {
			periods[periods.length - 1] = { from: last.from, to: next?.since ?? null };
		} else {
			periods.push({ from: record.since, to: next?.since ?? null });
		}
	});
	return periods;
}

/** The union of `periods` (from several monitors), oldest first; an open period absorbs what follows it. */
export function mergeDownPeriods(periods: readonly DownPeriod[]): DownPeriod[] {
	const sorted = [...periods].sort((a, b) => a.from - b.from);
	const merged: DownPeriod[] = [];
	for (const period of sorted) {
		const last = merged.at(-1);
		if (last !== undefined && (last.to === null || period.from <= last.to)) {
			const to = last.to === null || period.to === null ? null : Math.max(last.to, period.to);
			merged[merged.length - 1] = { from: last.from, to };
		} else {
			merged.push(period);
		}
	}
	return merged;
}
