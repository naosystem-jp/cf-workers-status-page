/**
 * Clearing a page's cached public responses when an administrator
 * publishes or changes something it shows. The admin API calls {@link purgePublicPage} after
 * every such write (incidents, their updates, maintenance, appearance), before it responds.
 * See worker/public/index.ts for the caching modes.
 */
import type { PublicApiCache } from "@naosystem/cf-workers-status-page-core";
import { config, findPage } from "./config";
import { type ResponseMemo, responseMemo } from "./public";
import { PAGES_TAG, pageTag } from "./public/routes";
import { statusPageStub } from "./status-page";

export interface PurgeTarget {
	readonly env: Env;
	readonly ctx: ExecutionContext;
	/** The page whose public responses changed. */
	readonly pageId: string;
	/** Incidents were deleted: the page's history reads its incidents in full again. */
	readonly incidentsDeleted?: boolean;
}

/**
 * Call before a write that changes what a public page shows (the admin API does; so must
 * automation such as `incidents.auto`), and {@link purgePublicPage} after it. Until then (or
 * for `CHANGE_WINDOW_MS` if it never comes), the page's Durable Object marks every response
 * it computes as not cacheable: one that read the data before the write commits must not be
 * kept by the Worker's or Cloudflare's cache after the purge. Never throws: if it fails, the
 * change still shows, at worst after 30 seconds.
 */
export async function announcePublicPageChange(target: PurgeTarget): Promise<void> {
	const { env, pageId } = target;
	// A page no longer configured has no object (and naming one would create it).
	if (findPage(pageId) === undefined) return;
	try {
		await statusPageStub(env, pageId).beginChange();
	} catch (error) {
		console.warn(`Could not announce a change of page "${pageId}" to its Durable Object`, error);
	}
}

/**
 * A token bucket for Workers Cache purges. Cloudflare limits them per account like zone
 * purges on the Free plan, whatever the plan: 5 per minute, in bursts of up to 25
 * ([Workers Cache: purge rate limits](https://developers.cloudflare.com/workers/cache/limitations/#purge-rate-limits),
 * [purge limits](https://developers.cloudflare.com/cache/how-to/purge-cache/#availability-and-limits)).
 * This one counts the purges of one isolate, so that a burst of administrator writes does
 * not send purges that Cloudflare would refuse; Cloudflare's own limit, shared with other
 * isolates and Workers of the account, still decides, and its refusals are handled the same.
 */
export class PurgeLimiter {
	private tokens: number;
	private updatedAt: number;
	private readonly burst: number;
	private readonly perMinute: number;

	constructor(burst = 25, perMinute = 5, now = Date.now()) {
		this.burst = burst;
		this.perMinute = perMinute;
		this.tokens = burst;
		this.updatedAt = now;
	}

	/** Takes a token if one is left. */
	take(now = Date.now()): boolean {
		const elapsed = Math.max(0, now - this.updatedAt);
		this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.perMinute) / 60_000);
		this.updatedAt = Math.max(this.updatedAt, now);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}

const isolateLimiter = new PurgeLimiter();

/** What {@link purgePublicPage} did. */
export interface PurgeReport {
	/** The page's Durable Object: its computed responses were dropped (`skipped`: the page is not configured). */
	readonly page: "cleared" | "skipped" | "failed";
	/**
	 * Workers Cache: `not-used` in the `durable-object` mode; `rate-limited` when no purge was
	 * left (not sent; entries expire within 30 seconds); `failed` when Cloudflare refused it
	 * (its rate limit, say) or it threw; `unavailable` without Workers Cache (local development).
	 */
	readonly cache: "not-used" | "purged" | "rate-limited" | "failed" | "unavailable";
}

export interface PurgeOptions {
	readonly cache: PublicApiCache;
	readonly limiter: PurgeLimiter;
	readonly memo: ResponseMemo;
}

/**
 * Drops the page's computed responses in its StatusPage DO (immediately, for every data
 * centre), then forgets them in this isolate's memo and, in the `workers-cache` mode, purges
 * its entries and the list of pages from Workers Cache. In that order: a response computed
 * before the change is then either dropped by the purge or marked not cacheable by the
 * object (its computation spanned the change), so it cannot be cached after the purge. Never
 * throws: the administrator's write has happened, and whatever could not be cleared expires
 * within 30 seconds. Problems are logged.
 */
export async function purgePublicPage(
	target: PurgeTarget,
	options: PurgeOptions = { cache: config.publicApi.cache, limiter: isolateLimiter, memo: responseMemo },
): Promise<PurgeReport> {
	const { env, ctx, pageId } = target;
	const clearPage = async (): Promise<PurgeReport["page"]> => {
		// A page no longer configured has no object to clear (and naming one would create it).
		if (findPage(pageId) === undefined) return "skipped";
		try {
			await statusPageStub(env, pageId).invalidate({ incidentsDeleted: target.incidentsDeleted === true });
			return "cleared";
		} catch (error) {
			console.warn(`Could not clear the computed responses of page "${pageId}"`, error);
			return "failed";
		}
	};
	const purgeCache = async (): Promise<PurgeReport["cache"]> => {
		if (options.cache !== "workers-cache") return "not-used";
		if (!options.limiter.take()) {
			console.warn(`Workers Cache purge for page "${pageId}" skipped: purge rate limit reached; entries expire within 30 seconds`);
			return "rate-limited";
		}
		try {
			const outcome = await ctx.exports.PublicApi.purge({ tags: [pageTag(pageId), PAGES_TAG] });
			if (outcome.status === "failed") {
				console.warn(`Workers Cache purge for page "${pageId}" refused: ${outcome.errors.join("; ")}; entries expire within 30 seconds`);
			}
			return outcome.status;
		} catch (error) {
			console.warn(`Workers Cache purge for page "${pageId}" failed; entries expire within 30 seconds`, error);
			return "failed";
		}
	};
	const page = await clearPage();
	options.memo.forgetPage(pageId);
	const cache = await purgeCache();
	return { page, cache };
}
