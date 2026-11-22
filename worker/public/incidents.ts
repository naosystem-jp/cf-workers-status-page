/**
 * The incident list and incident pages of the public API, read from D1 by the Worker,
 * not by the page's Durable Object: a visitor, or a script, asking for many incident IDs or
 * cursors then costs D1 reads and Worker requests, never the Durable Object requests that
 * monitoring depends on (the Free plan's daily limit is shared with them).
 *
 * D1's rows read are limited too (on the Free plan, for the whole account: past the limit,
 * every D1 query fails until 00:00 UTC, notifications included), so what a client makes up
 * costs one primary-key read: a cursor must name an incident (or update) of the page at the
 * position it claims, or it is refused before any list is read. Valid cursors are as many as
 * the page's incidents (or the incident's updates), like incident pages themselves, so their
 * responses are kept like those (`main` in index.ts). A list page reads its own rows only, and
 * an incident page at most {@link UPDATES_PER_PAGE} updates, however long its timeline.
 */
import type { ResolvedPage } from "@naosystem/cf-workers-status-page-core";
import type { IncidentListResponse, PublicApiError, PublicIncidentPage } from "../../shared/public-api";
import { type Cursor, encodeCursor } from "../db/common";
import { getIncidentWithUpdatePage, incidentPosition, listIncidents, MAX_OPEN_INCIDENTS, updatePosition } from "../db/incidents";
import { ensureSchema } from "../db/schema";
import type { ViewResult } from "../status-page";
import { publicIncident, publicIncidentWithUpdates } from "./views";

/** How long incident lists and pages are kept. */
export const INCIDENTS_TTL_MS = 30_000;
/** Updates on one incident page; `olderUpdatesCursor` reads the previous ones. */
export const UPDATES_PER_PAGE = 50;

function result(body: unknown, status: 200 | 400 | 404, now: number): ViewResult {
	return { status, json: JSON.stringify(body), generatedAt: now, ttlMs: INCIDENTS_TTL_MS, cacheable: true };
}

function badCursor(name: "cursor" | "before", now: number): ViewResult {
	const body: PublicApiError = { error: "invalid_query", message: `\`${name}\` is not from a previous page` };
	return result(body, 400, now);
}

/**
 * Unresolved incidents (first page only, at most {@link MAX_OPEN_INCIDENTS}), then resolved
 * ones by page: at most `MAX_OPEN_INCIDENTS + limit + 1` rows, whatever the cursor says.
 */
export async function incidentsView(env: Env, page: ResolvedPage, limit: number, cursor: Cursor | null): Promise<ViewResult> {
	const now = Date.now();
	await ensureSchema(env.DB);
	if (cursor !== null) {
		// One primary-key read: a resolved incident of this page, where the cursor says it is.
		const position = await incidentPosition(env.DB, cursor.id);
		if (position === null || position.pageId !== page.id || !position.resolved || position.startedAt !== cursor.at) {
			return badCursor("cursor", now);
		}
	}
	const [unresolved, resolved] = await Promise.all([
		cursor === null
			? listIncidents(env.DB, { pageId: page.id, status: "open", limit: MAX_OPEN_INCIDENTS })
			: Promise.resolve({ items: [], nextCursor: null }),
		listIncidents(env.DB, { pageId: page.id, status: "resolved", limit, after: cursor ?? undefined }),
	]);
	const body: IncidentListResponse = {
		unresolved: unresolved.items.map((incident) => publicIncident(incident, page)),
		resolved: resolved.items.map((incident) => publicIncident(incident, page)),
		nextCursor: resolved.nextCursor,
	};
	return result(body, 200, now);
}

/**
 * An incident with its latest {@link UPDATES_PER_PAGE} updates before `before` (an update's
 * position from `olderUpdatesCursor`; `null` for the latest). An unknown ID costs one
 * primary-key lookup, and so does a made-up `before`.
 */
export async function incidentView(env: Env, page: ResolvedPage, incidentId: string, before: Cursor | null = null): Promise<ViewResult> {
	const now = Date.now();
	await ensureSchema(env.DB);
	let position: { readonly createdAt: number; readonly rowid: number } | null = null;
	if (before !== null) {
		const update = await updatePosition(env.DB, before.id);
		if (update === null || update.incidentId !== incidentId || update.createdAt !== before.at) return badCursor("before", now);
		position = update;
	}
	const incident = await getIncidentWithUpdatePage(env.DB, incidentId, UPDATES_PER_PAGE, position);
	// Another page's incident does not exist here.
	if (incident === null || incident.pageId !== page.id) {
		const body: PublicApiError = { error: "not_found", message: "No such incident" };
		return result(body, 404, now);
	}
	const body: PublicIncidentPage = {
		...publicIncidentWithUpdates(incident, page),
		olderUpdatesCursor: incident.olderCursor === null ? null : encodeCursor(incident.olderCursor),
	};
	return result(body, 200, now);
}
