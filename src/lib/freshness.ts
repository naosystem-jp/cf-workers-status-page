/**
 * Whether what the page shows is still current: a page that cannot refresh must
 * never keep showing an old "all systems operational" as if it were current.
 *
 * Normally the status is at most about a minute old: the server computes it at most every
 * 30 seconds (its caches keep it no longer), and the page asks every 30 seconds. Past
 * {@link STATUS_STALE_AFTER_MS} (one missed refresh, and some slack), it is stale.
 */
import type { PollState } from "./poller";

export const STATUS_STALE_AFTER_MS = 90_000;

/** How old a response already was when it arrived: its server's clock minus when it was computed (both server clocks). */
export function serverAgeMs(generatedAt: number, serverDate: number | null): number {
	return serverDate === null ? 0 : Math.max(0, serverDate - generatedAt);
}

export type Freshness =
	/** Nothing shown yet. */
	| { readonly kind: "loading" }
	/** Nothing to show: the first request failed. */
	| { readonly kind: "unavailable"; readonly error: unknown }
	/** Current. `error`: the latest refresh failed, but the data is still recent enough. */
	| { readonly kind: "fresh"; readonly error: unknown }
	/** Older than it should be: say so wherever a state is shown. */
	| { readonly kind: "stale"; readonly error: unknown; readonly ageMs: number };

/** The freshness of polled data whose age at arrival was `ageAtArrivalMs` (see {@link serverAgeMs}). */
export function freshness(
	poll: Pick<PollState<unknown>, "data" | "receivedAt" | "error">,
	ageAtArrivalMs: number,
	now: number,
	staleAfterMs: number = STATUS_STALE_AFTER_MS,
): Freshness {
	if (poll.data === undefined || poll.receivedAt === null) {
		return poll.error === null ? { kind: "loading" } : { kind: "unavailable", error: poll.error };
	}
	const ageMs = Math.max(0, now - poll.receivedAt) + ageAtArrivalMs;
	return ageMs > staleAfterMs ? { kind: "stale", error: poll.error, ageMs } : { kind: "fresh", error: poll.error };
}
