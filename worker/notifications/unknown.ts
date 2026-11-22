/**
 * `unknown` notifications from the every-minute Cron: when to notify
 * administrators, and when a monitor needs to be read again.
 */
import type { UnknownReason } from "./events";
import {
	type DisplayState,
	type DisplayStateResult,
	displayState,
	type MonitorReading,
	type RecordedState,
	staleAfterMs,
} from "@naosystem/cf-workers-status-page-core";

/** A {@link MonitorReading} whose state record has its start, as a Monitor DO's snapshot does. */
export interface UnknownReading extends MonitorReading {
	readonly current: { readonly state: RecordedState; readonly since: number } | null;
	/**
	 * How far back the snapshot looked for `lastResultAt` (`MonitorSnapshot.recentSince`): a
	 * `null` `lastResultAt` means only that no result came after this.
	 */
	readonly recentSince?: number | null;
}

/** What administrators are told about. */
export interface UnknownAlert {
	/**
	 * `late`: results stopped arriving; `unconfirmed`: results arrive but confirm no state;
	 * `unreachable`: the monitor's Durable Object does not answer.
	 */
	readonly reason: UnknownReason;
	/** When the monitor became unknown for this reason: the notification's time, and part of its ID. */
	readonly since: number;
	/** The latest result (or the start of the schedule) it is late from; for `unconfirmed`, when the unconfirmed run began. */
	readonly lastAt: number;
}

export interface UnknownEvaluation extends DisplayStateResult {
	/** Whether administrators should know: `null` while the monitor is fine, stopped, or only briefly unconfirmed. */
	readonly alert: UnknownAlert | null;
	/**
	 * The earliest time this monitor's evaluation can turn into an alert without a new result:
	 * until then, reading the monitor again cannot find it unknown, so the Cron skips it.
	 * `now` while it is unknown (to notice when it recovers).
	 */
	readonly checkAgainAt: number;
}

/** A stopped monitor (or one not started yet) is looked at again after this; a sweep refreshes it sooner. */
export const STOPPED_RECHECK_MS = 10 * 60_000;

/**
 * Evaluates a monitor's snapshot with {@link displayState}, the rule the status page uses.
 *
 * - `late` (no result for longer than `staleAfterMs`): alert at once.
 * - `unconfirmed`: alert only once it has lasted `staleAfterMs` too. Every monitor is
 *   unconfirmed for a check or two after it starts or resumes, which is not worth a
 *   notification; a monitor whose results never confirm a state (checks that alternate
 *   between success and failure) is.
 * - `stopped` (not configured, not started): never; the monitor is not supposed to run.
 */
export function evaluateUnknown(reading: UnknownReading, timeoutMs: number, now: number): UnknownEvaluation {
	const result = displayState(reading, timeoutMs, now);
	const { period } = reading;
	if (result.unknownReason === "stopped" || period === null || period.intervalMs === null) {
		return { ...result, alert: null, checkAgainAt: now + STOPPED_RECHECK_MS };
	}
	const staleAfter = staleAfterMs(period.intervalMs, timeoutMs);
	const anchor = Math.max(reading.lastResultAt ?? Number.NEGATIVE_INFINITY, period.from);
	const lateAt = anchor + staleAfter;
	if (result.unknownReason === "late") {
		// Without a recent result, all that is known is that none came after the snapshot's window
		// (a Monitor DO reads a few intervals back only).
		const known = reading.lastResultAt ?? Math.max(period.from, reading.recentSince ?? period.from);
		return { ...result, alert: { reason: "late", since: known + staleAfter, lastAt: known }, checkAgainAt: now };
	}
	if (result.unknownReason === "unconfirmed") {
		const unconfirmedSince = reading.current?.state === "unconfirmed" ? Math.max(reading.current.since, period.from) : period.from;
		const alertAt = unconfirmedSince + staleAfter;
		if (now >= alertAt) {
			return { ...result, alert: { reason: "unconfirmed", since: alertAt, lastAt: unconfirmedSince }, checkAgainAt: now };
		}
		return { ...result, alert: null, checkAgainAt: Math.min(lateAt, alertAt) };
	}
	return { ...result, alert: null, checkAgainAt: lateAt };
}

/** What the Cron does about a monitor, given whether administrators were already told it is unknown. */
export function unknownAction(
	evaluation: Pick<UnknownEvaluation, "alert" | "state" | "unknownReason">,
	notified: boolean,
): "notify" | "clear" | "none" {
	if (!notified) return evaluation.alert === null ? "none" : "notify";
	// Notified once per stretch of `unknown`: the record goes when the monitor leaves it.
	const left: boolean = evaluation.state !== ("unknown" satisfies DisplayState) || evaluation.unknownReason === "stopped";
	return left ? "clear" : "none";
}

/** The ID of the `unknown` event of `monitorId` that began at `since`. */
export function unknownEventId(monitorId: string, since: number): string {
	return `unknown:${monitorId}:${since}`;
}

/**
 * Whether the Cron run for `scheduledTime` looks for `unknown` monitors: every run with the
 * default 1-minute interval, otherwise the runs on multiples of the interval.
 */
export function unknownCheckDue(scheduledTime: number, intervalMs: number): boolean {
	const minute = Math.floor(scheduledTime / 60_000);
	return minute % Math.max(1, Math.round(intervalMs / 60_000)) === 0;
}
