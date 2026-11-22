/** URLs of the public API (README "Public API") and how often the status page reads them. */
import type {
	IncidentListResponse,
	PageHistoryResponse,
	PageLatencyResponse,
	PageStatusResponse,
	PublicIncidentPage,
	StoppagesResponse,
} from "../../shared/public-api";
import { type Fetched, getJson } from "../lib/http";

/** As often as the server recomputes it (30 seconds). */
export const STATUS_INTERVAL_MS = 30_000;
/** The history, stoppages and incident list: the server recomputes them every 5 minutes. */
export const HISTORY_INTERVAL_MS = 5 * 60_000;
/** While the history is still being filled in (`complete: false`), ask again soon. */
export const PENDING_HISTORY_INTERVAL_MS = 10_000;
/** Longest wait between failed attempts. */
export const STATUS_MAX_BACKOFF_MS = 5 * 60_000;
export const HISTORY_MAX_BACKOFF_MS = 20 * 60_000;

const page = (pageId: string) => `/api/pages/${encodeURIComponent(pageId)}`;

/** A page's status; `null`: the first page's (`/api/status`), for the site's root. */
export function statusUrl(pageId: string | null): string {
	return pageId === null ? "/api/status" : `${page(pageId)}/status`;
}
export const historyUrl = (pageId: string) => `${page(pageId)}/history`;
export const stoppagesUrl = (pageId: string) => `${page(pageId)}/stoppages`;
/** Response times of the components that publish them (the modern template). */
export const latencyUrl = (pageId: string) => `${page(pageId)}/latency`;
export function incidentsUrl(pageId: string, cursor: string | null = null): string {
	return cursor === null ? `${page(pageId)}/incidents` : `${page(pageId)}/incidents?cursor=${encodeURIComponent(cursor)}`;
}
/** An incident with its latest updates; with `before` (an `olderUpdatesCursor`), the page of updates before it. */
export function incidentUrl(pageId: string, incidentId: string, before: string | null = null): string {
	const url = `${page(pageId)}/incidents/${encodeURIComponent(incidentId)}`;
	return before === null ? url : `${url}?before=${encodeURIComponent(before)}`;
}

export const getStatus = (url: string, signal?: AbortSignal) => getJson<PageStatusResponse>(url, signal);
export const getHistory = (url: string, signal?: AbortSignal) => getJson<PageHistoryResponse>(url, signal);
export const getStoppages = (url: string, signal?: AbortSignal) => getJson<StoppagesResponse>(url, signal);
export const getLatency = (url: string, signal?: AbortSignal) => getJson<PageLatencyResponse>(url, signal);
export const getIncidents = (url: string, signal?: AbortSignal) => getJson<IncidentListResponse>(url, signal);
export const getIncident = (url: string, signal?: AbortSignal) => getJson<PublicIncidentPage>(url, signal);

export type { Fetched };

/** Paths of the status page itself (not the API). The first page is also at `/`. */
export const pagePath = (pageId: string) => `/pages/${encodeURIComponent(pageId)}`;
export const incidentPath = (pageId: string, incidentId: string) => `${pagePath(pageId)}/incidents/${encodeURIComponent(incidentId)}`;
/** Every past incident and outage of a page. */
export const historyPath = (pageId: string) => `${pagePath(pageId)}/history`;
