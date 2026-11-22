import type { CheckResult, CheckState } from "@naosystem/cf-workers-status-page-core";

/**
 * What a runner sends back to the Monitor DO for one check. Plain data, so that it
 * crosses RPC (and, later, the network from external runners) unchanged.
 */
export type CheckOutcome =
	| { readonly ok: true; readonly result: StoredResult }
	| { readonly ok: false; readonly error: CheckError };

/** A check that produced a state, normalised for storage. */
export interface StoredResult {
	readonly state: CheckState;
	readonly latencyMs: number | null;
	readonly message: string | null;
	/** The provider's `details` as JSON text, or `null`. */
	readonly details: string | null;
}

/**
 * A check that produced no result: a missing secret, a provider exception, a runner that
 * gave up. Recorded without a state, so it neither confirms a state nor breaks a run,
 * and does not count as a result for coverage.
 */
export interface CheckError {
	/** Error class, such as `"MissingSecretError"`. */
	readonly name: string;
	readonly message: string;
}

export const MAX_MESSAGE_LENGTH = 1_000;
export const MAX_DETAILS_LENGTH = 4_000;

const STATES: ReadonlySet<string> = new Set<CheckState>(["up", "degraded", "down"]);

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function checkError(error: unknown, fallbackName = "Error"): CheckError {
	if (error instanceof Error) {
		return { name: error.name || fallbackName, message: truncate(error.message, MAX_MESSAGE_LENGTH) };
	}
	return { name: fallbackName, message: truncate(String(error), MAX_MESSAGE_LENGTH) };
}

/**
 * Validates what a provider returned and bounds its size before it is stored. Providers
 * are third-party code: a result with an invalid state becomes an error rather than a
 * state, and oversized messages or details are cut down.
 */
export function normalizeResult(result: CheckResult): CheckOutcome {
	if (typeof result !== "object" || result === null || !STATES.has(result.state)) {
		return {
			ok: false,
			error: {
				name: "InvalidResultError",
				message: `The provider returned an invalid state: ${JSON.stringify((result as { state?: unknown } | null)?.state)}`,
			},
		};
	}
	const latency = result.latencyMs;
	let details: string | null = null;
	if (result.details !== undefined) {
		try {
			const json = JSON.stringify(result.details);
			details = json.length <= MAX_DETAILS_LENGTH ? json : JSON.stringify({ truncated: true });
		} catch {
			details = JSON.stringify({ unserializable: true });
		}
	}
	return {
		ok: true,
		result: {
			state: result.state,
			latencyMs: typeof latency === "number" && Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
			message: typeof result.message === "string" ? truncate(result.message, MAX_MESSAGE_LENGTH) : null,
			details,
		},
	};
}
