import { useEffect, useRef, useState } from "react";
import type { PublicIncident } from "../../shared/public-api";
import { useI18n } from "../i18n/I18nProvider";
import { usePoller } from "../lib/usePoller";
import { getIncidents, HISTORY_INTERVAL_MS, HISTORY_MAX_BACKOFF_MS, incidentsUrl } from "./api";
import { describeError } from "./FreshnessNotice";
import { IncidentSummary } from "./Incidents";

export interface IncidentHistoryProps {
	readonly pageId: string;
	/**
	 * Changes when the unresolved incidents change (one was resolved, or published): the list
	 * is read again then, instead of up to 5 minutes later.
	 */
	readonly refreshKey: string;
}

/** Whether `a` comes after `b` in the list: latest start first, then by ID (as the API pages them). */
export function listedAfter(a: PublicIncident, b: PublicIncident): boolean {
	return a.startedAt < b.startedAt || (a.startedAt === b.startedAt && a.id < b.id);
}

export interface IncidentHistoryData {
	/** Resolved incidents read so far, latest first, each once. */
	readonly items: readonly PublicIncident[];
	/** Whether the first page has been read. */
	readonly loaded: boolean;
	/** Why the first page could not be read, while it could not. */
	readonly error: unknown;
	/** Whether older incidents can be read. */
	readonly hasMore: boolean;
	readonly loadingMore: boolean;
	readonly moreError: unknown;
	loadMore(): Promise<void>;
}

/**
 * Resolved incidents, latest first: the first page read with the history (every 5 minutes, and
 * when the unresolved incidents change), older pages on request, kept.
 */
export function useIncidentHistory(pageId: string, refreshKey: string): IncidentHistoryData {
	const url = incidentsUrl(pageId);
	const first = usePoller(url, {
		load: (signal) => getIncidents(url, signal),
		intervalMs: HISTORY_INTERVAL_MS,
		maxBackoffMs: HISTORY_MAX_BACKOFF_MS,
	});
	const [older, setOlder] = useState<{ items: PublicIncident[]; nextCursor: string | null } | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreError, setMoreError] = useState<unknown>(null);

	// Read the list again when an incident was resolved or published (not on the first render).
	const refresh = useRef(first.refresh);
	refresh.current = first.refresh;
	const seenKey = useRef(refreshKey);
	useEffect(() => {
		if (seenKey.current === refreshKey) return;
		seenKey.current = refreshKey;
		refresh.current();
	}, [refreshKey]);

	const firstPage = first.data?.body;
	const firstItems = firstPage?.resolved;

	// When the first page changes while older pages are shown (an incident was just resolved),
	// its last incidents move to the second page, which was read before: keep them, or they
	// would fall between the pages. Those that left the range of the first page (reopened or
	// deleted) are dropped.
	const previousFirst = useRef<readonly PublicIncident[] | null>(null);
	useEffect(() => {
		if (firstItems === undefined) return;
		const previous = previousFirst.current;
		previousFirst.current = firstItems;
		const last = firstItems.at(-1);
		if (previous === null || last === undefined) return;
		const onFirst = new Set(firstItems.map((incident) => incident.id));
		const pushedOut = previous.filter((incident) => !onFirst.has(incident.id) && listedAfter(incident, last));
		if (pushedOut.length === 0) return;
		setOlder((current) => {
			if (current === null) return current;
			const kept = new Set(current.items.map((incident) => incident.id));
			return { ...current, items: [...pushedOut.filter((incident) => !kept.has(incident.id)), ...current.items] };
		});
	}, [firstItems]);

	const seen = new Set<string>();
	const items = [...(firstPage?.resolved ?? []), ...(older?.items ?? [])].filter((incident) => {
		if (seen.has(incident.id)) return false;
		seen.add(incident.id);
		return true;
	});
	const nextCursor = older === null ? (firstPage?.nextCursor ?? null) : older.nextCursor;

	async function loadMore() {
		if (nextCursor === null) return;
		setLoadingMore(true);
		setMoreError(null);
		try {
			const { body } = await getIncidents(incidentsUrl(pageId, nextCursor));
			setOlder((previous) => ({ items: [...(previous?.items ?? []), ...body.resolved], nextCursor: body.nextCursor }));
		} catch (error) {
			setMoreError(error);
		} finally {
			setLoadingMore(false);
		}
	}

	return { items, loaded: firstPage !== undefined, error: first.error, hasMore: nextCursor !== null, loadingMore, moreError, loadMore };
}

/** Past incidents, latest first, as the default template lists them. */
export function IncidentHistory({ pageId, refreshKey }: IncidentHistoryProps) {
	const { t } = useI18n();
	const { items, loaded, error, hasMore, loadingMore, moreError, loadMore } = useIncidentHistory(pageId, refreshKey);

	return (
		<section className="section" aria-labelledby="history-heading">
			<h2 id="history-heading" className="section__title">
				{t("public.history.heading")}
			</h2>
			{!loaded ? (
				<p className="muted">{error === null ? t("ui.loading") : t("public.history.failed", { reason: describeError(error, t) })}</p>
			) : items.length === 0 ? (
				<p className="muted">{t("public.history.none")}</p>
			) : (
				<ul className="history-list">
					{items.map((incident) => (
						<IncidentSummary key={incident.id} incident={incident} pageId={pageId} />
					))}
				</ul>
			)}
			{hasMore && (
				<p>
					<button type="button" className="button" onClick={() => void loadMore()} disabled={loadingMore}>
						{loadingMore ? t("ui.loading") : t("public.history.more")}
					</button>
				</p>
			)}
			{moreError !== null && (
				<p role="alert" className="error-text">
					{t("public.history.failed", { reason: describeError(moreError, t) })}
				</p>
			)}
		</section>
	);
}
