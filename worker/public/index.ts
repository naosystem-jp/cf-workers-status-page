/**
 * The public API: what status pages show, for anyone, read-only. Routes are documented
 * in the README; response types are in shared/public-api.ts.
 *
 * ## Caching
 *
 * Each page's StatusPage DO computes its status, history and stoppages at most once per time
 * to live (30 seconds for the status; 5 minutes for the history and stoppages) for all data
 * centres, reads each monitor once for all of them, and drops them when an administrator
 * changes the page. The list of pages and incidents are read from D1 by the Worker
 * (incidents.ts), so that no client-chosen ID or cursor reaches a Durable Object. In front:
 *
 * - **Each isolate of the Worker** keeps responses ({@link ResponseMemo}) for what is left of
 *   their time to live, at most 30 seconds, so that repeated requests (a visitor polling, or
 *   hammering) do not reach the Durable Object: each one is a billed request, and on the
 *   Free plan they share a daily limit with the monitors' alarms. The isolate that handles
 *   an administrator's change forgets the page at once; others within 30 seconds.
 * - **`publicApi.cache`** in status.config.ts chooses the rest:
 *   - `"durable-object"` (default): nothing more. Browsers are told `private, no-cache`: they
 *     ask again on every poll, and see an administrator's change on their next request.
 *   - `"workers-cache"`: [Workers Cache](https://developers.cloudflare.com/workers/cache/).
 *     The default entrypoint stays an uncached gateway that calls the `PublicApi` entrypoint
 *     through `ctx.exports` with the canonical URL; caching is enabled for `PublicApi` only
 *     (`exports` in wrangler.jsonc), so admin routes never touch it, and in the default mode
 *     `PublicApi` is never invoked. The edge and browsers keep a response for what is left of
 *     its time to live, at most 30 seconds, with `stale-if-error=0`: without it, Workers
 *     Cache serves a stale response indefinitely when the Worker fails, and a page would show
 *     its last "all up" through an outage. A `Cache-Tag` per page lets
 *     `ctx.cache.purge()` remove a page's entries everywhere (see public-cache.ts).
 *
 * Responses never depend on the request's headers (language included: see
 * shared/public-api.ts), so one entry per URL is correct. CORS headers
 * (`publicApi.allowedOrigins`) are added by the gateway per request, after every cache, so a
 * cached response never carries another origin's. A response whose computation spanned an
 * administrator's change is served with `no-store` and kept nowhere.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { PublicApiCache, ResolvedPublicApi } from "@naosystem/cf-workers-status-page-core";
import type { PageListResponse, PublicApiError } from "../../shared/public-api";
import { config, findPage } from "../config";
import { listAppearanceTitles } from "../db/appearance";
import { ensureSchema } from "../db/schema";
import { statusPageStub, type ViewResult } from "../status-page";
import { incidentView, incidentsView } from "./incidents";
import { serveImage } from "../uploads";
import { canonicalPath, PAGES_TAG, type PublicRoute, pageTag, parsePublicRoute, type ViewRoute } from "./routes";

export { isPublicApiPath } from "./routes";

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff" } as const;
/** Longest time a response is kept by an isolate's memo, and by browsers: the staleness accepted after a change. */
export const SHORT_CACHE_MS = 30_000;
/** Time to live of the list of pages. */
const PAGES_TTL_MS = 30_000;

function errorResponse(status: number, error: string, message: string, headers: Record<string, string> = {}): Response {
	const body: PublicApiError = { error, message };
	return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers } });
}

/** Seconds left of `ttlMs` for data read at `generatedAt`. */
export function maxAgeSeconds(generatedAt: number, ttlMs: number, now = Date.now()): number {
	return Math.max(0, Math.floor((generatedAt + ttlMs - now) / 1000));
}

/**
 * Response headers for caching, per mode (see the module documentation). With Workers Cache,
 * the edge and browsers keep a response for what is left of its time to live but at most
 * {@link SHORT_CACHE_MS}, whatever the view (the page's object recomputes its history every
 * 5 minutes, but that is internal and an administrator's change clears it directly), so that
 * a purge that is refused or lost leaves an old response for 30 seconds at most.
 */
export function cacheHeaders(mode: PublicApiCache, result: ViewResult, tags: readonly string[]): Record<string, string> {
	if (!result.cacheable) return { "Cache-Control": "no-store" };
	if (mode === "durable-object") return { "Cache-Control": "private, no-cache" };
	const maxAge = Math.min(maxAgeSeconds(result.generatedAt, result.ttlMs), SHORT_CACHE_MS / 1000);
	if (maxAge <= 0) return { "Cache-Control": "no-store" };
	return { "Cache-Control": `public, max-age=${maxAge}, stale-if-error=0`, "Cache-Tag": tags.join(",") };
}

function viewResponse(result: ViewResult, mode: PublicApiCache, tags: readonly string[]): Response {
	return new Response(result.json, {
		status: result.status,
		headers: { "Content-Type": "application/json", ...cacheHeaders(mode, result, tags), ...SECURITY_HEADERS },
	});
}

/** The list of pages and their titles (D1; not one page's, so not a StatusPage DO's). */
async function pagesView(env: Env): Promise<ViewResult> {
	await ensureSchema(env.DB);
	const titles = await listAppearanceTitles(env.DB);
	const body: PageListResponse = {
		pages: config.pages.map((page) => ({ id: page.id, title: titles.get(page.id) ?? null })),
	};
	return { status: 200, json: JSON.stringify(body), generatedAt: Date.now(), ttlMs: PAGES_TTL_MS, cacheable: true };
}

/**
 * A route's response from its source: the page's StatusPage DO for its status, history and
 * stoppages; D1 for the list of pages and for incidents (see incidents.ts).
 */
async function source(env: Env, route: ViewRoute): Promise<{ readonly result: ViewResult; readonly tags: string[] }> {
	switch (route.kind) {
		case "pages":
			return { result: await pagesView(env), tags: [PAGES_TAG] };
		case "incidents":
		case "incident": {
			const page = findPage(route.pageId);
			if (page === undefined) throw new Error(`No page "${route.pageId}"`);
			const result =
				route.kind === "incident"
					? await incidentView(env, page, route.incidentId, route.before)
					: await incidentsView(env, page, route.limit, route.cursor);
			return { result, tags: [pageTag(route.pageId)] };
		}
		default:
			return { result: await statusPageStub(env, route.pageId).getView(route), tags: [pageTag(route.pageId)] };
	}
}

async function respond(env: Env, route: ViewRoute, mode: PublicApiCache): Promise<Response> {
	const { result, tags } = await source(env, route);
	return viewResponse(result, mode, tags);
}

export interface PurgeRequest {
	readonly tags: readonly string[];
}

export type PurgeOutcome =
	| { readonly status: "purged" }
	/** No Workers Cache here (local development and tests, or caching turned off): nothing to purge. */
	| { readonly status: "unavailable" }
	/** Refused, for example by the purge rate limit; entries expire on their own. */
	| { readonly status: "failed"; readonly errors: readonly string[] };

/** Purges by tag with `cache` (an entrypoint's `ctx.cache`, when Workers Cache is on for it). */
export async function purgeTags(cache: CacheContext | undefined, tags: readonly string[]): Promise<PurgeOutcome> {
	if (cache === undefined) return { status: "unavailable" };
	const result = await cache.purge({ tags: [...tags] });
	if (result.success) return { status: "purged" };
	return { status: "failed", errors: result.errors.map((error) => `${error.code}: ${error.message}`) };
}

/**
 * The cached entrypoint of the `workers-cache` mode (see the module documentation). Reached
 * only through the gateway: named entrypoints have no route from the internet.
 */
export class PublicApi extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const parsed = parsePublicRoute(new URL(request.url));
		if (!parsed.ok) return errorResponse(parsed.status, parsed.error, parsed.message);
		try {
			// Not reached through the gateway, which serves images itself; answered alike all the same.
			if (parsed.route.kind === "image") return await serveImage(this.env, parsed.route.pageId, parsed.route.imageId, request);
			return await respond(this.env, parsed.route, "workers-cache");
		} catch (error) {
			console.error(`Public API ${new URL(request.url).pathname} failed`, error);
			return errorResponse(500, "internal_error", "Something went wrong");
		}
	}

	/**
	 * Purges cached responses by tag. Purges apply to the entrypoint that calls them, so the
	 * admin API asks this one (after every change to what a page shows).
	 */
	async purge(request: PurgeRequest): Promise<PurgeOutcome> {
		return purgeTags(this.ctx.cache, request.tags);
	}
}

interface MemoEntry {
	readonly expiresAt: number;
	readonly status: number;
	readonly body: string;
	readonly headers: readonly (readonly [string, string])[];
}

/**
 * Where a response is kept. `main`: successful responses, whose number the page's data bounds
 * (a page's status, history and stoppages; its incident list at each valid cursor and page
 * size; its incidents at each page of their timelines: routes.ts and incidents.ts accept only
 * cursors that name existing rows, and three page sizes). `side`: errors, whose keys a client
 * chooses freely (unknown incidents, made-up cursors), in a small set of their own, so that
 * asking for many of them cannot push the others out.
 */
export type MemoBucket = "main" | "side";

/** Least recently used out beyond `limit`. */
class LruMap<K, V> {
	readonly entries = new Map<K, V>();
	readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	set(key: K, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		for (const old of this.entries.keys()) {
			if (this.entries.size <= this.limit) break;
			this.entries.delete(old);
		}
	}
}

/**
 * Responses kept by one isolate, keyed by mode and canonical URL (one entry per page, view
 * and query), in two bounded buckets ({@link MemoBucket}). Only cacheable responses are
 * kept, for what is left of their time to live and at most {@link SHORT_CACHE_MS}. A kept
 * response is sent with its freshness recomputed: `max-age` is what is left of the entry, and
 * `Age` is dropped, so that a browser does not keep it longer than the isolate would.
 */
export class ResponseMemo {
	private readonly buckets: Readonly<Record<MemoBucket, LruMap<string, MemoEntry>>>;

	constructor(mainEntries = 256, sideEntries = 32) {
		this.buckets = { main: new LruMap(mainEntries), side: new LruMap(sideEntries) };
	}

	get(key: string, now = Date.now()): Response | null {
		for (const bucket of Object.values(this.buckets)) {
			const entry = bucket.get(key);
			if (entry === undefined) continue;
			if (now >= entry.expiresAt) {
				bucket.entries.delete(key);
				return null;
			}
			const response = new Response(entry.body, { status: entry.status, headers: [...entry.headers] });
			const cacheControl = response.headers.get("Cache-Control");
			if (cacheControl !== null && /max-age=\d+/.test(cacheControl)) {
				const left = Math.max(0, Math.floor((entry.expiresAt - now) / 1000));
				response.headers.set("Cache-Control", cacheControl.replace(/max-age=\d+/, `max-age=${left}`));
			}
			response.headers.delete("Age");
			return response;
		}
		return null;
	}

	/** Keeps `response` (read into memory) until `expiresAt`; returns a copy to send. */
	async put(key: string, response: Response, expiresAt: number, bucket: MemoBucket = "main", now = Date.now()): Promise<Response> {
		const body = await response.text();
		const copy = new Response(body, response);
		if (expiresAt > now) {
			for (const other of Object.values(this.buckets)) other.entries.delete(key);
			this.buckets[bucket].set(key, { expiresAt, status: response.status, body, headers: [...response.headers] });
		}
		return copy;
	}

	/** Forgets a page's responses and the list of pages (after an administrator's change, in this isolate). */
	forgetPage(pageId: string): void {
		const prefix = `/api/pages/${encodeURIComponent(pageId)}/`;
		for (const bucket of Object.values(this.buckets)) {
			for (const key of bucket.entries.keys()) {
				const path = key.slice(key.indexOf(" ") + 1);
				if (path.startsWith(prefix) || path === "/api/pages") bucket.entries.delete(key);
			}
		}
	}

	clear(): void {
		for (const bucket of Object.values(this.buckets)) bucket.entries.clear();
	}

	/** Entries kept, per bucket. */
	sizes(): Record<MemoBucket, number> {
		return { main: this.buckets.main.entries.size, side: this.buckets.side.entries.size };
	}

	get size(): number {
		return this.buckets.main.entries.size + this.buckets.side.entries.size;
	}
}

/** The bucket for a route's response (see {@link MemoBucket}). */
export function memoBucket(_route: PublicRoute, status: number): MemoBucket {
	return status === 200 ? "main" : "side";
}

/** This isolate's memo of public responses. */
export const responseMemo = new ResponseMemo();

/** When a view may be kept until by an isolate: what is left of its time to live, at most {@link SHORT_CACHE_MS}. */
function viewKeepUntil(result: ViewResult, now: number): number {
	if (!result.cacheable) return now;
	return Math.min(result.generatedAt + result.ttlMs, now + SHORT_CACHE_MS);
}

/** When a response of the cached entrypoint may be kept until, from its caching headers. */
function keepUntil(response: Response, now: number): number {
	if (response.status !== 200 && response.status !== 404) return now;
	const cacheControl = response.headers.get("Cache-Control") ?? "";
	if (/no-store/.test(cacheControl)) return now;
	const maxAge = /max-age=(\d+)/.exec(cacheControl);
	const age = Number(response.headers.get("Age") ?? "0");
	const seconds = maxAge === null ? 0 : Math.max(0, Number(maxAge[1]) - age);
	return now + Math.min(seconds * 1000, SHORT_CACHE_MS);
}

/** The `Access-Control-Allow-Origin` value for a request from `origin`, or `null` when it is not allowed. */
export function allowedOrigin(allowed: ResolvedPublicApi["allowedOrigins"], origin: string | null): string | null {
	if (allowed === "*") return "*";
	return origin !== null && allowed.includes(origin) ? origin : null;
}

/**
 * CORS headers for a response to `request` (`publicApi.allowedOrigins`). With a list of
 * origins the answer depends on `Origin`, so it says `Vary: Origin`; with `"*"` it does not.
 * Never credentials: the public API has none.
 */
function corsHeaders(allowed: ResolvedPublicApi["allowedOrigins"], request: Request): Headers {
	const headers = new Headers();
	const origin = allowedOrigin(allowed, request.headers.get("Origin"));
	if (origin !== null) headers.set("Access-Control-Allow-Origin", origin);
	if (Array.isArray(allowed) && allowed.length > 0) headers.set("Vary", "Origin");
	return headers;
}

function withHeaders(response: Response, extra: Headers, head: boolean): Response {
	const result = new Response(head ? null : response.body, response);
	for (const [name, value] of extra) {
		if (name === "vary") result.headers.append(name, value);
		else result.headers.set(name, value);
	}
	return result;
}

/** A CORS preflight. Only reached when CORS is on: the API takes simple GETs, so browsers rarely send one. */
function preflight(request: Request, allowed: ResolvedPublicApi["allowedOrigins"]): Response {
	const headers = corsHeaders(allowed, request);
	headers.set("Allow", "GET, HEAD, OPTIONS");
	headers.set("Cache-Control", "no-store");
	if (headers.has("Access-Control-Allow-Origin")) {
		headers.set("Access-Control-Allow-Methods", "GET, HEAD");
		// The API ignores request headers, so whatever a client sends is harmless.
		const requested = request.headers.get("Access-Control-Request-Headers");
		if (requested !== null) {
			headers.set("Access-Control-Allow-Headers", requested);
			headers.append("Vary", "Access-Control-Request-Headers");
		}
		headers.set("Access-Control-Max-Age", "86400");
	}
	return new Response(null, { status: 204, headers });
}

/**
 * An uploaded image, straight from R2: its URL names its bytes, so browsers keep it for a year
 * and none of the caches above is needed (see worker/uploads.ts).
 */
async function image(env: Env, route: Extract<PublicRoute, { readonly kind: "image" }>, request: Request): Promise<Response> {
	try {
		return await serveImage(env, route.pageId, route.imageId, request);
	} catch (error) {
		console.error(`Public API image ${route.pageId}/${route.imageId} failed`, error);
		return errorResponse(500, "internal_error", "Something went wrong");
	}
}

/** How the public API is served: `publicApi` in status.config.ts. */
export const PUBLIC_API: ResolvedPublicApi = config.publicApi;

/**
 * The public API for `/api/status` and `/api/pages/*`, in the uncached default entrypoint:
 * rejects what does not exist (uncached), answers from this isolate's memo, or else from the
 * page's Durable Object or, with `workers-cache`, from the cached `PublicApi` entrypoint
 * with the canonical URL. Adds CORS headers last, per request.
 */
export async function handlePublicApi(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	options: ResolvedPublicApi = PUBLIC_API,
	memo: ResponseMemo = responseMemo,
): Promise<Response> {
	const cors = corsHeaders(options.allowedOrigins, request);
	const corsOn = options.allowedOrigins === "*" || options.allowedOrigins.length > 0;
	if (request.method === "OPTIONS" && corsOn) return preflight(request, options.allowedOrigins);
	const head = request.method === "HEAD";
	if (request.method !== "GET" && !head) {
		const allow = corsOn ? "GET, HEAD, OPTIONS" : "GET, HEAD";
		return withHeaders(errorResponse(405, "method_not_allowed", "Use GET or HEAD", { Allow: allow }), cors, false);
	}
	const url = new URL(request.url);
	const parsed = parsePublicRoute(url);
	if (!parsed.ok) return withHeaders(errorResponse(parsed.status, parsed.error, parsed.message), cors, head);
	if (parsed.route.kind === "image") return withHeaders(await image(env, parsed.route, request), cors, head);

	const path = canonicalPath(parsed.route);
	const key = `${options.cache} ${path}`;
	let response = memo.get(key);
	if (response === null) {
		let fresh: Response;
		let expiresAt = 0;
		try {
			if (options.cache === "workers-cache") {
				// A fresh request: none of the visitor's headers reach the cached entrypoint.
				fresh = await ctx.exports.PublicApi.fetch(new Request(new URL(path, url.origin)));
				expiresAt = keepUntil(fresh, Date.now());
			} else {
				const { result, tags } = await source(env, parsed.route);
				fresh = viewResponse(result, "durable-object", tags);
				expiresAt = viewKeepUntil(result, Date.now());
			}
		} catch (error) {
			console.error(`Public API ${url.pathname} failed`, error);
			fresh = errorResponse(500, "internal_error", "Something went wrong");
		}
		response = await memo.put(key, fresh, expiresAt, memoBucket(parsed.route, fresh.status));
	}
	const result = withHeaders(response, cors, head);
	// Internal to the edge: Cloudflare strips it; other callers do not need it either.
	result.headers.delete("Cache-Tag");
	return result;
}
