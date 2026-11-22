/**
 * States as the status page shows them: `unknown` derived at display time,
 * the precedence between states, and a component's state from its monitors and incidents.
 */
import type { CheckState } from "./provider";
import type { RecordedState } from "./timeline";

/** A state as displayed: a confirmed state, or `unknown` when results are missing or late. */
export type DisplayState = CheckState | "unknown";

/**
 * Severity for "the worst state": `down` > `degraded` > `unknown` > `up`. `unknown`
 * means results are missing, which is not necessarily an outage, so a known problem
 * (`degraded`) outranks it.
 */
const RANK: Readonly<Record<DisplayState, number>> = { up: 0, unknown: 1, degraded: 2, down: 3 };

export function isCheckState(state: string): state is CheckState {
	return state === "up" || state === "degraded" || state === "down";
}

/** The worse of two states. */
export function worseOf(a: DisplayState, b: DisplayState): DisplayState {
	return RANK[b] > RANK[a] ? b : a;
}

/** The worst of `states`, or `empty` when there are none. */
export function worstState(states: Iterable<DisplayState>, empty: DisplayState): DisplayState {
	let worst: DisplayState | undefined;
	for (const state of states) worst = worst === undefined ? state : worseOf(worst, state);
	return worst ?? empty;
}

/**
 * Slack on top of the schedule before a monitor counts as late: the runner's and the Monitor
 * DO's grace periods after a check's timeout (10 seconds), alarms that fire late, and clock
 * differences between Durable Objects.
 */
export const LATE_GRACE_MS = 60_000;

/**
 * How long a monitor may go without a check that produced a state before it is `unknown`: two intervals, plus the check's timeout and {@link LATE_GRACE_MS}.
 *
 * A check's result is recorded when the check ends, up to its timeout (plus grace) after the
 * slot it ran for. Two intervals tolerate one missed result (a transient runner error, a
 * check that produced no result) without flapping to `unknown`; the second missed result in
 * a row makes the monitor `unknown`, before the third slot is due. With a 1-minute interval
 * and a 10-second timeout that is 3 minutes 10 seconds.
 *
 * The status page uses this for the live state and for every past moment of the history,
 * and the every-minute Cron uses it to notify `unknown`, so the three agree.
 */
export function staleAfterMs(intervalMs: number, timeoutMs: number): number {
	return 2 * intervalMs + timeoutMs + LATE_GRACE_MS;
}

/** What {@link displayState} needs from a monitor. A Monitor DO's snapshot has this shape. */
export interface MonitorReading {
	/** The latest record of the state history; `null` before any. */
	readonly current: { readonly state: RecordedState } | null;
	/** The current schedule period; `null` before the monitor first started. */
	readonly period: { readonly from: number; readonly status: "active" | "stopped"; readonly intervalMs: number | null } | null;
	/** Start of the latest recent check that produced a state; `null` when none did. */
	readonly lastResultAt: number | null;
}

export interface DisplayStateResult {
	readonly state: DisplayState;
	/**
	 * Why the state is `unknown`, `null` otherwise:
	 * - `stopped`: the monitor is not running (it left the configuration, or has not started);
	 * - `late`: no result for longer than {@link staleAfterMs}, whether or not a state was
	 *   confirmed (a new monitor whose checks never produce a result is late too);
	 * - `unconfirmed`: results arrive, but no state is confirmed yet (new, or resumed after a stop).
	 *
	 * The every-minute Cron notifies administrators of `late`.
	 */
	readonly unknownReason: "unconfirmed" | "stopped" | "late" | null;
}

/**
 * A monitor's state at display time: its confirmed state, unless its latest result
 * is late for its schedule or it has no confirmed state (including `unconfirmed` after
 * resuming). Lateness counts from the later of the latest result and the start of the
 * current schedule period, so a new interval gets a fresh allowance, and it is checked
 * before the confirmed state, so that a monitor that never produces a result is `late`.
 */
export function displayState(reading: MonitorReading, timeoutMs: number, now: number): DisplayStateResult {
	const { current, period } = reading;
	if (period === null || period.status !== "active" || period.intervalMs === null || current?.state === "stopped") {
		return { state: "unknown", unknownReason: "stopped" };
	}
	const anchor = Math.max(reading.lastResultAt ?? Number.NEGATIVE_INFINITY, period.from);
	if (now - anchor > staleAfterMs(period.intervalMs, timeoutMs)) return { state: "unknown", unknownReason: "late" };
	if (current === null || !isCheckState(current.state)) return { state: "unknown", unknownReason: "unconfirmed" };
	return { state: current.state, unknownReason: null };
}

/** Impact of an open incident on a component. `none` lists it without changing its state. */
export type IncidentImpact = "none" | "degraded" | "down";

/**
 * A component's current state: the worst of its monitors' display states and the
 * impacts of the unresolved incidents that affect it, so that a person's judgement can
 * override the automatic one. A component without monitors takes its state from incidents
 * alone, and is `up` without any. Maintenance is not a state: it is shown next to it.
 */
export function componentState(
	monitorStates: Iterable<DisplayState>,
	openIncidentImpacts: Iterable<IncidentImpact>,
): DisplayState {
	const states: DisplayState[] = [...monitorStates];
	for (const impact of openIncidentImpacts) {
		if (impact !== "none") states.push(impact);
	}
	return worstState(states, "up");
}
