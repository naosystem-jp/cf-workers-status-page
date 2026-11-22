/**
 * Scheduling for the Monitor DO's single alarm, and the arithmetic of its schedule
 * periods. Pure functions, so they are tested without a Durable Object.
 */

import type { SchedulePeriod, TimeRange } from "@naosystem/cf-workers-status-page-core";

// Defined in core, which the status pages' history computation shares.
export type { SchedulePeriod, TimeRange };

/**
 * How early a check may start and still count for its slot. Alarms fire at or after the
 * time they were set for; this only absorbs clock adjustments when a Durable Object moves.
 */
const SLOT_TOLERANCE_MS = 1_000;

/**
 * Scheduled checks run on a fixed grid, `anchor + k × interval`, where `anchor` is the start
 * of the current schedule period. Anchoring to the grid rather than to the end of the
 * previous check keeps the schedule from drifting by the length of each check and of each
 * alarm delay.
 *
 * Returns the slot after the one that the last scheduled check (`lastScheduledAt`) belongs
 * to. That can be in the past after downtime: the check then runs once, now, and belongs to
 * the current slot, so missed slots are not made up one by one.
 *
 * With no scheduled check recorded in this period, it returns `anchor` while the period is
 * younger than one interval (its first check), and otherwise the grid's next slot from
 * `now`: the period's results may have been deleted, and the grid, not the missing rows,
 * decides when to check.
 */
export function nextScheduledCheck(
	anchor: number,
	intervalMs: number,
	lastScheduledAt: number | null,
	now: number,
): number {
	if (lastScheduledAt === null || lastScheduledAt < anchor - SLOT_TOLERANCE_MS) {
		if (now - anchor < intervalMs) return anchor;
		return anchor + Math.ceil((now - anchor) / intervalMs) * intervalMs;
	}
	const tolerance = Math.min(SLOT_TOLERANCE_MS, intervalMs / 10);
	const slot = Math.floor((lastScheduledAt - anchor + tolerance) / intervalMs);
	return anchor + (slot + 1) * intervalMs;
}

/** Number of slots of the grid `anchor + k × interval` in `[from, to)`, counting none before `anchor`. */
export function slotsBetween(anchor: number, intervalMs: number, from: number, to: number): number {
	const start = Math.max(from, anchor);
	if (to <= start) return 0;
	const first = Math.ceil((start - anchor) / intervalMs);
	const last = Math.ceil((to - anchor) / intervalMs);
	return last - first;
}

/** The part of each active period inside `range`, oldest first. */
export function activeParts(periods: readonly SchedulePeriod[], range: TimeRange): TimeRange[] {
	const parts: TimeRange[] = [];
	for (const period of periods) {
		if (period.status !== "active") continue;
		const from = Math.max(range.from, period.from);
		const to = Math.min(range.to, period.to ?? Number.POSITIVE_INFINITY);
		if (from < to) parts.push({ from, to });
	}
	return parts;
}

/**
 * Scheduled checks expected in `range`: the slots of each active period's
 * grid that fall inside the range. Stopped periods expect none.
 */
export function expectedChecks(periods: readonly SchedulePeriod[], range: TimeRange): number {
	let count = 0;
	for (const period of periods) {
		if (period.status !== "active" || period.intervalMs === null) continue;
		const to = Math.min(range.to, period.to ?? Number.POSITIVE_INFINITY);
		count += slotsBetween(period.from, period.intervalMs, Math.max(range.from, period.from), to);
	}
	return count;
}

/** `ranges` intersected with `within` (both sorted and non-overlapping). */
export function intersect(ranges: readonly TimeRange[], within: readonly TimeRange[]): TimeRange[] {
	const result: TimeRange[] = [];
	for (const range of ranges) {
		for (const part of within) {
			const from = Math.max(range.from, part.from);
			const to = Math.min(range.to, part.to);
			if (from < to) result.push({ from, to });
		}
	}
	return result;
}
