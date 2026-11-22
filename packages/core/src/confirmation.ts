import type { CheckState } from "./provider";

/**
 * A state confirmed by the confirmation rule. Confirmed states, not individual
 * results, drive uptime, notifications and the stoppage history.
 */
export interface ConfirmedState {
	readonly state: CheckState;
	/**
	 * When the run of results that confirmed this state began (ms since the epoch). Uptime
	 * counts the state from here. Strictly greater than the previous confirmed state's `since`.
	 */
	readonly since: number;
	/** When the result that completed the run was taken. Notifications report this time. */
	readonly confirmedAt: number;
}

/**
 * One check that produced a state. Checks that produced no result (a missing secret, a
 * provider exception, a runner that gave up) are not observations: leave them out, so they
 * neither confirm a state nor break a run.
 */
export interface Observation {
	readonly state: CheckState;
	/** When the check was taken (ms since the epoch). */
	readonly at: number;
}

export interface ConfirmationThresholds {
	/** Consecutive non-`up` results needed to confirm a non-`up` state. At least 1. */
	readonly failureThreshold: number;
	/** Consecutive `up` results needed to confirm `up`. At least 1. */
	readonly successThreshold: number;
}

export interface Confirmation {
	/** The confirmed state after the latest observation; `null` until a state has been confirmed. */
	readonly current: ConfirmedState | null;
	/** Whether the latest observation confirmed a new state, which `current` then is. */
	readonly changed: boolean;
	/**
	 * The state the latest results point to while it is not confirmed yet, or `null` when
	 * they agree with `current`. A non-`up` pending state is what calls for a re-check.
	 */
	readonly pending: CheckState | null;
}

/** Lower is less severe. */
const SEVERITY: Readonly<Record<CheckState, number>> = { up: 0, degraded: 1, down: 2 };

/**
 * How many of the latest observations {@link confirmState} needs to see: enough for the
 * longer threshold, plus one to see where the run started.
 */
export function observationsNeeded(thresholds: ConfirmationThresholds): number {
	return Math.max(thresholds.failureThreshold, thresholds.successThreshold) + 1;
}

/** The trailing observations that satisfy `matches`, oldest first. */
function trailingRun(recent: readonly Observation[], matches: (state: CheckState) => boolean): Observation[] {
	let start = recent.length;
	while (start > 0 && matches((recent[start - 1] as Observation).state)) start--;
	return recent.slice(start);
}

function leastSevere(run: readonly Observation[]): CheckState {
	return run.reduce<CheckState>(
		(least, { state }) => (SEVERITY[state] < SEVERITY[least] ? state : least),
		"down",
	);
}

/**
 * The confirmation rule, as a pure function of the confirmed state before the
 * latest observation and the latest observations.
 *
 * - `successThreshold` consecutive `up` results confirm `up`.
 * - From `up` (or before anything is confirmed), `failureThreshold` consecutive non-`up`
 *   results confirm a non-`up` state: the least severe state in that run, so
 *   `[down, degraded]` confirms `degraded`.
 * - While a non-`up` state is confirmed, moving between `degraded` and `down` needs
 *   `failureThreshold` consecutive results of the new state.
 *
 * `since` is the start of the run that confirmed the state, as far back as `recent` reaches,
 * and is kept strictly after the previous state's `since`.
 *
 * @param previous The confirmed state before the latest observation, or `null`.
 * @param recent The latest observations, oldest first, ending with the newest one. Pass at
 *   least {@link observationsNeeded} of them when that many exist.
 */
export function confirmState(
	previous: ConfirmedState | null,
	recent: readonly Observation[],
	thresholds: ConfirmationThresholds,
): Confirmation {
	const latest = recent.at(-1);
	const unchanged = (pending: CheckState | null): Confirmation => ({ current: previous, changed: false, pending });
	if (latest === undefined) return unchanged(null);

	let target: CheckState;
	let run: Observation[];
	let threshold: number;
	if (latest.state === "up") {
		if (previous?.state === "up") return unchanged(null);
		run = trailingRun(recent, (state) => state === "up");
		target = "up";
		threshold = thresholds.successThreshold;
	} else if (previous === null || previous.state === "up") {
		run = trailingRun(recent, (state) => state !== "up");
		target = leastSevere(run);
		threshold = thresholds.failureThreshold;
	} else {
		if (latest.state === previous.state) return unchanged(null);
		run = trailingRun(recent, (state) => state === latest.state);
		target = latest.state;
		threshold = thresholds.failureThreshold;
	}

	if (run.length < threshold) return unchanged(target);
	const runStart = (run[0] as Observation).at;
	const since = previous === null ? runStart : Math.max(runStart, previous.since + 1);
	return {
		current: { state: target, since, confirmedAt: latest.at },
		changed: true,
		// [degraded, down] confirms degraded, and the latest down already points to down.
		pending: latest.state === target ? null : latest.state,
	};
}
