/**
 * Responses of the public API (`/api/pages/*`), shared by the Worker and the status page.
 *
 * A page's status is computed at most every 30 seconds, its history and stoppages every 5
 * minutes (sooner after an administrator's change). Poll them at those rates.
 *
 * Conventions:
 * - Times are epoch milliseconds, as in the admin API.
 * - Only what a visitor sees: components, not monitors. No monitor IDs, URLs, check messages
 *   or errors, and no administrator names.
 * - Language-neutral: states, stages and impacts are codes for the page to translate. Texts
 *   are the ones administrators wrote: incidents in the page's one language, the page's
 *   title, description and links in one language or in several, all of them sent. So a
 *   response never depends on the visitor's language and can be cached once per URL.
 * - Responses are cached for up to 30 seconds and refreshed when an administrator changes
 *   what a page shows.
 */
import type { AppearanceColors, Impact, IncidentStage, LocalizedText, ThemeColors } from "./admin-api";

export type { AppearanceColors, Impact, IncidentStage, LocalizedText, ThemeColors };

/** A state as shown: `unknown` when results are missing or late. */
export type State = "up" | "degraded" | "down" | "unknown";

/** A state confirmed from check results. */
export type ConfirmedState = "up" | "degraded" | "down";

/** `GET /api/pages` */
export interface PageListResponse {
	readonly pages: readonly PageSummary[];
}

export interface PageSummary {
	readonly id: string;
	/**
	 * The page's title in one language (as `PublicAppearance.title`: status.config.ts's, or an
	 * administrator's); `null` for the default (show the ID).
	 */
	readonly title: string | null;
}

/**
 * A link of the page's header or footer: an https, http or mailto URL, or a path on this
 * site (starting with `/`, such as another status page).
 */
export interface PublicNavLink {
	readonly label: LocalizedText;
	readonly url: string;
}

/** A button of the header's navigation that opens a list of links. */
export interface PublicNavMenu {
	readonly label: LocalizedText;
	readonly items: readonly PublicNavLink[];
}

/** A menu has `items`, a link a `url`. */
export type PublicNavItem = PublicNavLink | PublicNavMenu;

export interface PublicHeader {
	/** Links and menus, in order; empty for none. */
	readonly nav: readonly PublicNavItem[];
}

export interface PublicFooterColumn {
	readonly title: LocalizedText;
	readonly links: readonly PublicNavLink[];
}

export interface PublicFooter {
	readonly columns: readonly PublicFooterColumn[];
	/** A line of links. */
	readonly links: readonly PublicNavLink[];
	/** A line of text, such as a copyright notice, or `null`. */
	readonly text: LocalizedText | null;
}

/**
 * What identifies a page to visitors: status.config.ts's settings with the
 * administrators' changes over them. `null` fields use the defaults.
 *
 * Texts (`LocalizedText`) are one for every language, or texts by BCP 47 tag: show the
 * visitor's language, else English, else the first one.
 */
export interface PublicAppearance {
	/**
	 * The title in one language (English if written, else the first); `null` for the default
	 * (show the page's ID). A page in several languages shows `localized.title` instead.
	 */
	readonly title: string | null;
	/** As `title`; `null` for none. */
	readonly description: string | null;
	/** `title` and `description` as written, in every language. */
	readonly localized: {
		readonly title: LocalizedText | null;
		readonly description: LocalizedText | null;
	};
	/**
	 * The logo: an uploaded image, as a path on this site (`/api/pages/:pageId/images/:id`), or
	 * else an https URL. Resolve a path against the API's origin.
	 */
	readonly logoUrl: string | null;
	readonly websiteUrl: string | null;
	/** The favicon (an uploaded image, a path on this site as for `logoUrl`), or `null`. */
	readonly faviconUrl: string | null;
	/**
	 * Colours an administrator chose, per colour scheme (`#rrggbb`); `null` where the template's
	 * own apply. `header` is the modern template's header bar.
	 */
	readonly colors: AppearanceColors;
	/** The header's navigation. */
	readonly header: PublicHeader;
	/** The footer's links and text, shown above the time zone and the language. */
	readonly footer: PublicFooter;
}

export interface ComponentRef {
	readonly id: string;
	readonly name: string;
}

export interface ComponentStatus extends ComponentRef {
	/**
	 * The worst of its monitors' states and the impacts of unresolved incidents that affect it
	 * (`down` > `degraded` > `unknown` > `up`).
	 */
	readonly state: State;
	/** Whether monitors watch it. Without monitors, only incidents set its state. */
	readonly monitored: boolean;
	/** Whether a maintenance is in progress for it. Shown next to the state, never instead of it. */
	readonly maintenance: boolean;
	/** Whether its response times are public (`GET /api/pages/:pageId/latency`). */
	readonly latency: boolean;
}

/** How a status page looks (`pages[].template` in status.config.ts). */
export type PageTemplate = "default" | "modern";

/**
 * Components shown together under one name (`pages[].components` in status.config.ts). Display
 * only: incidents, maintenance and history are per component, and a group shows the worst of
 * its components.
 */
export interface ComponentGroup {
	readonly id: string;
	readonly name: string;
	/** IDs of its components, in order. They are next to each other in `components`. */
	readonly components: readonly string[];
}

export interface PublicIncidentUpdate {
	readonly stage: IncidentStage;
	readonly body: string;
	readonly createdAt: number;
}

export interface AffectedComponent extends ComponentRef {
	readonly impact: Impact;
}

export interface PublicIncident {
	readonly id: string;
	readonly title: string;
	/** Stage of the latest update. */
	readonly stage: IncidentStage;
	/** The highest impact on any affected component. */
	readonly impact: Impact;
	/** Affected components that are on the page. */
	readonly components: readonly AffectedComponent[];
	/** When it began (may be before it was published). */
	readonly startedAt: number;
	readonly updatedAt: number;
	/** `null` while unresolved. */
	readonly resolvedAt: number | null;
}

export interface PublicIncidentWithUpdates extends PublicIncident {
	/** The timeline, oldest first: only the latest updates (see `olderUpdates`). */
	readonly updates: readonly PublicIncidentUpdate[];
	/** Whether older updates were left out: read them from the incident's own URL. */
	readonly olderUpdates: boolean;
}

/** `GET /api/pages/:pageId/incidents/:incidentId[?before=]`: an incident and a page of its timeline. */
export interface PublicIncidentPage extends PublicIncidentWithUpdates {
	/** With older updates, pass as `before` to read the page before these (latest 50 first); else `null`. */
	readonly olderUpdatesCursor: string | null;
}

export interface PublicMaintenance {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly startsAt: number;
	readonly endsAt: number;
	readonly components: readonly ComponentRef[];
}

/** `GET /api/pages/:pageId/status` (and `GET /api/status`, for the first page). */
export interface PageStatusResponse {
	readonly pageId: string;
	readonly appearance: PublicAppearance;
	/** How the page is shown (status.config.ts). */
	readonly template: PageTemplate;
	/** Where visitors report a problem (an https, http or mailto URL), or `null`. */
	readonly reportUrl: string | null;
	/** The worst component state; `unknown` for a page without components. */
	readonly overall: State;
	/** Every component, those of groups included, in the page's order. */
	readonly components: readonly ComponentStatus[];
	/** Groups of components; components in none stand alone. */
	readonly groups: readonly ComponentGroup[];
	/** Unresolved incidents with their latest updates, latest start first. */
	readonly incidents: readonly PublicIncidentWithUpdates[];
	readonly maintenance: {
		/** In progress, earliest start first. */
		readonly active: readonly PublicMaintenance[];
		/** Not started yet, earliest start first. */
		readonly upcoming: readonly PublicMaintenance[];
	};
	/**
	 * `true` when incidents, maintenance and the appearance could not be read just now (the
	 * database is unavailable): they are as last read, or missing. Component states from
	 * monitors are current all the same. Fetched again sooner.
	 */
	readonly incidentsOutdated: boolean;
	readonly generatedAt: number;
}

/** One local day of a component's history. */
export interface HistoryDay {
	/** `YYYY-MM-DD` in the page's time zone. */
	readonly date: string;
	/** The day's first instant, and the next day's (23 or 25 hours apart across daylight saving time changes). */
	readonly from: number;
	readonly to: number;
	/**
	 * Time `up` or `degraded` over time with a confirmed state, outside maintenance.
	 * `null` without monitors, or when no time qualified (all unknown, stopped or maintenance).
	 */
	readonly uptime: number | null;
	/** Scheduled checks that produced a state over the checks scheduled. `null` without monitors or schedule. */
	readonly coverage: number | null;
	/** Time confirmed `down` outside maintenance; `null` when `uptime` is. */
	readonly downtimeMs: number | null;
	/** Time confirmed `degraded` outside maintenance (it counts as uptime); `null` when `uptime` is. */
	readonly degradedMs: number | null;
	/**
	 * Time with a confirmed state outside maintenance (what `uptime` is a share of), so that a
	 * client can work out the uptime of fewer days: `1 - Σ downtimeMs / Σ observedMs`. `null`
	 * without monitors or data.
	 */
	readonly observedMs: number | null;
	/** Scheduled checks, and those that produced a state (what `coverage` is a share of). `null` without monitors or data. */
	readonly checks: { readonly expected: number; readonly obtained: number } | null;
	/** The worst confirmed state outside maintenance, for the bar's colour; `null` without one. */
	readonly worst: ConfirmedState | null;
	/** Not computed yet (the history is still being filled in): show it as loading, not as no data. */
	readonly pending: boolean;
	/** IDs of incidents that affected the component that day (see `PageHistoryResponse.incidents`). */
	readonly incidents: readonly string[];
	/** IDs of maintenance for the component that day (see `PageHistoryResponse.maintenance`). */
	readonly maintenance: readonly string[];
}

export interface ComponentHistory extends ComponentRef {
	readonly monitored: boolean;
	/** Over the whole window, weighted by time (not an average of days). `null` as for a day. */
	readonly uptime: number | null;
	readonly coverage: number | null;
	/** Time with a confirmed state over the whole window (see `HistoryDay.observedMs`). */
	readonly observedMs: number | null;
	/**
	 * When monitoring of the component began: the first start of the earliest of its monitors
	 * (also before the window); `null` without monitors, or before any started. Days before it
	 * are "not monitored yet", not missing data.
	 */
	readonly observedFrom: number | null;
	/** Oldest first; the last one is today, so far. */
	readonly days: readonly HistoryDay[];
}

/** An incident or maintenance that a history day refers to. */
export interface HistoryMarker {
	readonly id: string;
	readonly title: string;
	readonly from: number;
	/** `null` for an unresolved incident. */
	readonly to: number | null;
}

/** `GET /api/pages/:pageId/history` */
export interface PageHistoryResponse {
	/** The IANA time zone that decides where days start. */
	readonly timezone: string;
	/** Start of the oldest day. */
	readonly from: number;
	readonly components: readonly ComponentHistory[];
	readonly incidents: readonly HistoryMarker[];
	readonly maintenance: readonly HistoryMarker[];
	/**
	 * `false` while some days are `pending`: being filled in (fetch again in a few seconds), or
	 * a monitor could not be read (fetched again with the rest of the history).
	 */
	readonly complete: boolean;
	/**
	 * `true` when incidents and maintenance could not be read just now: markers, and the
	 * maintenance left out of uptime, are as last read, or missing. Fetched again sooner.
	 */
	readonly incidentsOutdated: boolean;
	readonly generatedAt: number;
}

/**
 * Response times over a period, in buckets of equal length ending with the one that contains
 * `generatedAt`. Only scheduled checks that got a response count (not re-checks, not checks that
 * timed out or failed to connect), so each bucket is an even sample of its time.
 */
export interface LatencySeries {
	/** Start of the first bucket. */
	readonly from: number;
	readonly bucketMs: number;
	/** The average response time of each bucket in whole milliseconds, oldest first; `null` without data. */
	readonly values: readonly (number | null)[];
	/** Over the whole period; `null` without data. */
	readonly averageMs: number | null;
	/** The 95th percentile over the whole period, estimated from a histogram (within about 5%); `null` without data. */
	readonly p95Ms: number | null;
}

export interface ComponentLatency extends ComponentRef {
	/** The latest response time: of its latest check, averaged over its monitors; `null` without one. */
	readonly latest: { readonly at: number; readonly ms: number } | null;
	/** The last 24 hours in 15-minute buckets. */
	readonly day: LatencySeries;
	/** The last 7 days in 2-hour buckets. */
	readonly week: LatencySeries;
	/** The last 30 days in 6-hour buckets. */
	readonly month: LatencySeries;
}

/** `GET /api/pages/:pageId/latency`: response times of the components that publish them (`latency: true`). */
export interface PageLatencyResponse {
	readonly components: readonly ComponentLatency[];
	/** `false` while some of the period is still being read: fetch again in a few seconds. */
	readonly complete: boolean;
	readonly generatedAt: number;
}

/** A stretch of confirmed `down`, detected from the data, listed apart from incidents. */
export interface Stoppage {
	readonly componentId: string;
	readonly from: number;
	/** `null` while it lasts. */
	readonly to: number | null;
}

/** `GET /api/pages/:pageId/stoppages` */
export interface StoppagesResponse {
	/** Stoppages that ended before this are not listed. */
	readonly from: number;
	/** Latest start first. */
	readonly stoppages: readonly Stoppage[];
	/** Whether older stoppages in the window were left out. */
	readonly truncated: boolean;
	readonly generatedAt: number;
}

/** `GET /api/pages/:pageId/incidents`: unresolved incidents, then resolved ones by page. */
export interface IncidentListResponse {
	/** Every unresolved incident, latest start first; only on the first page (without `cursor`). */
	readonly unresolved: readonly PublicIncident[];
	/** Resolved incidents, latest start first. */
	readonly resolved: readonly PublicIncident[];
	/** Pass as `cursor` for older resolved incidents; `null` at the end. */
	readonly nextCursor: string | null;
}

/** The body of every error response. */
export interface PublicApiError {
	readonly error: string;
	readonly message: string;
}
