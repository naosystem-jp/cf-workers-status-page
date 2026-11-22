/**
 * Routes of the public API, and their canonical form. The gateway (the Worker's
 * default entrypoint) parses a request, rejects what does not exist, and passes the
 * canonical URL to the cached `PublicApi` entrypoint, so that a cache entry exists per
 * resource and per page only: unknown query parameters, their order and the host never make
 * a new one (they would otherwise let anyone bypass the cache and reach the Durable Objects).
 */
import * as z from "zod";
import { config, findPage } from "../config";
import { IMAGE_ID } from "../../shared/admin-api";
import { type Cursor, decodeCursor, encodeCursor } from "../db/common";

export type PublicRoute =
	| { readonly kind: "pages" }
	| { readonly kind: "status"; readonly pageId: string }
	| { readonly kind: "history"; readonly pageId: string }
	| { readonly kind: "stoppages"; readonly pageId: string }
	| { readonly kind: "latency"; readonly pageId: string }
	| { readonly kind: "incidents"; readonly pageId: string; readonly limit: IncidentPageSize; readonly cursor: Cursor | null }
	| { readonly kind: "incident"; readonly pageId: string; readonly incidentId: string; readonly before: Cursor | null }
	/** An uploaded image (a logo or favicon), from R2: served by the gateway itself, never memoized or cached as a view. */
	| { readonly kind: "image"; readonly pageId: string; readonly imageId: string };

/** A route of one page. */
export type PageRoute = Exclude<PublicRoute, { readonly kind: "pages" }>;

/** A route whose response is JSON (every route but images). */
export type ViewRoute = Exclude<PublicRoute, { readonly kind: "image" }>;

/** A route answered by the page's StatusPage DO (incidents are read from D1 by the Worker). */
export type PageViewRoute = Extract<PublicRoute, { readonly kind: "status" | "history" | "stoppages" | "latency" }>;

export type ParsedRoute =
	| { readonly ok: true; readonly route: PublicRoute }
	| { readonly ok: false; readonly status: 400 | 404; readonly error: string; readonly message: string };

/**
 * The page sizes of the incident list. Any other `limit` from 1 to 50 is served as the next
 * size up, so that a client cannot make up many sizes, each a separate response to compute.
 */
export const INCIDENT_PAGE_SIZES = [10, 20, 50] as const;
export type IncidentPageSize = (typeof INCIDENT_PAGE_SIZES)[number];
export const DEFAULT_INCIDENT_PAGE_SIZE: IncidentPageSize = 20;
export const MAX_INCIDENT_PAGE_SIZE: IncidentPageSize = 50;

/** The page size served for a requested `limit` from 1 to {@link MAX_INCIDENT_PAGE_SIZE}. */
export function incidentPageSize(limit: number): IncidentPageSize {
	return INCIDENT_PAGE_SIZES.find((size) => size >= limit) ?? MAX_INCIDENT_PAGE_SIZE;
}

/** The paths the public API answers: `/api/pages…` and the compatibility alias `/api/status`. */
export function isPublicApiPath(pathname: string): boolean {
	return pathname === "/api/status" || pathname === "/api/pages" || pathname.startsWith("/api/pages/");
}

/** Incident IDs are UUIDs (`crypto.randomUUID()`): anything else cannot exist, and costs nothing to reject. */
const INCIDENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const incidentQuery = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_INCIDENT_PAGE_SIZE).default(DEFAULT_INCIDENT_PAGE_SIZE),
	cursor: z.string().max(100).optional(),
});

const cursorQuery = z.string().max(100).optional();

const notFound = (what: string): ParsedRoute => ({ ok: false, status: 404, error: "not_found", message: `No such ${what}` });

/** Parses a public API URL. Only pages in this version's configuration exist. */
export function parsePublicRoute(url: URL): ParsedRoute {
	if (url.pathname === "/api/status") {
		// Before multiple pages, `/api/status` was the status page: it stays the first page's status.
		const first = config.pages[0];
		return first === undefined ? notFound("page") : { ok: true, route: { kind: "status", pageId: first.id } };
	}
	let segments: string[];
	try {
		segments = url.pathname
			.split("/")
			.filter((segment) => segment !== "")
			.map(decodeURIComponent);
	} catch {
		return notFound("resource");
	}
	const [api, pages, pageId, resource, id, ...rest] = segments;
	if (api !== "api" || pages !== "pages" || rest.length > 0) return notFound("resource");
	if (pageId === undefined) return resource === undefined ? { ok: true, route: { kind: "pages" } } : notFound("resource");
	if (findPage(pageId) === undefined) return notFound("page");

	switch (resource) {
		case "status":
		case "history":
		case "stoppages":
		case "latency":
			return id === undefined ? { ok: true, route: { kind: resource, pageId } } : notFound("resource");
		case "incidents": {
			if (id !== undefined) {
				if (!INCIDENT_ID.test(id)) return notFound("incident");
				// `before`: an update's position from `olderUpdatesCursor`, for the previous page of the timeline.
				const before = cursorQuery.safeParse(url.searchParams.get("before") ?? undefined);
				const position = !before.success ? undefined : before.data === undefined ? null : decodeCursor(before.data);
				if (position === undefined) {
					return { ok: false, status: 400, error: "invalid_query", message: "`before` is not from a previous page" };
				}
				return { ok: true, route: { kind: "incident", pageId, incidentId: id, before: position } };
			}
			const query = incidentQuery.safeParse({
				limit: url.searchParams.get("limit") ?? undefined,
				cursor: url.searchParams.get("cursor") ?? undefined,
			});
			if (!query.success) return { ok: false, status: 400, error: "invalid_query", message: "Invalid `limit` or `cursor`" };
			const cursor = query.data.cursor === undefined ? null : decodeCursor(query.data.cursor);
			if (cursor === undefined) {
				return { ok: false, status: 400, error: "invalid_query", message: "`cursor` is not from a previous page" };
			}
			return { ok: true, route: { kind: "incidents", pageId, limit: incidentPageSize(query.data.limit), cursor } };
		}
		case "images":
			// Content-addressed IDs only: anything else cannot exist, and costs nothing to reject.
			return id !== undefined && IMAGE_ID.test(id) ? { ok: true, route: { kind: "image", pageId, imageId: id } } : notFound("image");
		default:
			return notFound("resource");
	}
}

/** The one URL path (and query) of a route: what the cache keys and what `PublicApi` parses again. */
export function canonicalPath(route: PublicRoute): string {
	const page = (pageId: string) => `/api/pages/${encodeURIComponent(pageId)}`;
	switch (route.kind) {
		case "pages":
			return "/api/pages";
		case "status":
		case "history":
		case "stoppages":
		case "latency":
			return `${page(route.pageId)}/${route.kind}`;
		case "incidents": {
			const query = new URLSearchParams();
			if (route.limit !== DEFAULT_INCIDENT_PAGE_SIZE) query.set("limit", String(route.limit));
			if (route.cursor !== null) query.set("cursor", encodeCursor(route.cursor));
			const search = query.toString();
			return `${page(route.pageId)}/incidents${search === "" ? "" : `?${search}`}`;
		}
		case "incident": {
			const path = `${page(route.pageId)}/incidents/${encodeURIComponent(route.incidentId)}`;
			return route.before === null ? path : `${path}?${new URLSearchParams({ before: encodeCursor(route.before) })}`;
		}
		case "image":
			return `${page(route.pageId)}/images/${route.imageId}`;
	}
}

/** Cache tags of a page's responses, for purging them together. Tags are case-insensitive ASCII. */
export function pageTag(pageId: string): string {
	return `page:${pageId}`;
}

/** Tag of the list of pages, which shows every page's title. */
export const PAGES_TAG = "pages";
