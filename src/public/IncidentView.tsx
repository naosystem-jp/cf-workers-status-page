import { useEffect, useRef, useState } from "react";
import type { PublicIncidentPage, PublicIncidentUpdate } from "../../shared/public-api";
import { Icon } from "../components/Icon";
import { ImpactBadge, StageBadge } from "../components/StateLabel";
import { useI18n } from "../i18n/I18nProvider";
import { type Fetched, isNotFound } from "../lib/http";
import { Link } from "../lib/router";
import { useNow, usePoller } from "../lib/usePoller";
import { getIncident, HISTORY_INTERVAL_MS, incidentUrl, pagePath, STATUS_INTERVAL_MS, STATUS_MAX_BACKOFF_MS } from "./api";
import { describeError } from "./FreshnessNotice";
import { Timeline } from "./Incidents";
import { useDocumentTitle, ViewLoading, ViewNotFound, ViewUnavailable } from "./Layout";
import { ModernIncidentContent, ModernViewLoading, ModernViewNotFound, ModernViewUnavailable } from "./modern/lazy";

export interface IncidentViewProps {
	/** The page's ID. */
	readonly pageId: string;
	readonly incidentId: string;
	/** The page's title, for the tab. */
	readonly title: string;
	readonly modern: boolean;
}

/**
 * One incident with its timeline (the status page shows only the latest updates), in its
 * page's frame (Page.tsx): the latest 50 updates, read every 30 seconds while unresolved and
 * every 5 minutes after, and earlier ones on request, 50 at a time, kept.
 */
export function IncidentView({ pageId, incidentId, title, modern }: IncidentViewProps) {
	const { t, f } = useI18n();
	const now = useNow(30_000);
	const url = incidentUrl(pageId, incidentId);
	const incident = usePoller(url, {
		load: (signal) => getIncident(url, signal),
		intervalMs: STATUS_INTERVAL_MS,
		intervalAfter: (data: Fetched<PublicIncidentPage>) =>
			data.body.resolvedAt === null ? STATUS_INTERVAL_MS : HISTORY_INTERVAL_MS,
		maxBackoffMs: STATUS_MAX_BACKOFF_MS,
		isFatal: isNotFound,
	});
	// Earlier updates read on request: older than the first page's, so polling does not change them.
	const [earlier, setEarlier] = useState<{ readonly updates: readonly PublicIncidentUpdate[]; readonly cursor: string | null } | null>(null);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const [earlierError, setEarlierError] = useState<unknown>(null);
	const body = incident.data?.body;
	const missing = incident.fatal && isNotFound(incident.error);
	useDocumentTitle(missing ? t("public.notFound.title") : body === undefined ? title : `${body.title} · ${title}`);

	const earlierCursor = earlier === null ? (body?.olderUpdatesCursor ?? null) : earlier.cursor;

	// Updates that new ones pushed out of the latest 50 while earlier ones are shown fall between
	// the two: keep them with the earlier ones.
	const latest = body?.updates;
	const previousLatest = useRef<readonly PublicIncidentUpdate[] | null>(null);
	useEffect(() => {
		if (latest === undefined) return;
		const previous = previousLatest.current;
		previousLatest.current = latest;
		if (previous === null) return;
		const key = (update: PublicIncidentUpdate) => `${update.createdAt}:${update.stage}:${update.body}`;
		const shown = new Set(latest.map(key));
		const pushedOut = previous.filter((update) => !shown.has(key(update)) && update.createdAt <= (latest[0]?.createdAt ?? Infinity));
		if (pushedOut.length === 0) return;
		setEarlier((current) => {
			if (current === null) return current;
			const kept = new Set(current.updates.map(key));
			return { ...current, updates: [...current.updates, ...pushedOut.filter((update) => !kept.has(key(update)))] };
		});
	}, [latest]);
	async function loadEarlier() {
		if (earlierCursor === null) return;
		setLoadingEarlier(true);
		setEarlierError(null);
		try {
			const { body: older } = await getIncident(incidentUrl(pageId, incidentId, earlierCursor));
			setEarlier((current) => ({ updates: [...older.updates, ...(current?.updates ?? [])], cursor: older.olderUpdatesCursor }));
		} catch (error) {
			setEarlierError(error);
		} finally {
			setLoadingEarlier(false);
		}
	}

	if (missing) {
		const message = t("public.notFound.incident");
		return modern ? <ModernViewNotFound message={message} back={pagePath(pageId)} /> : <ViewNotFound message={message} back={pagePath(pageId)} />;
	}
	if (body === undefined) {
		if (incident.error === null) return modern ? <ModernViewLoading /> : <ViewLoading />;
		const reason = describeError(incident.error, t);
		return modern ? <ModernViewUnavailable reason={reason} onRetry={incident.refresh} /> : <ViewUnavailable reason={reason} onRetry={incident.refresh} />;
	}
	if (modern) {
		return (
			<ModernIncidentContent
				pageId={pageId}
				incident={body}
				earlier={earlier?.updates ?? []}
				canLoadEarlier={earlierCursor !== null}
				loadingEarlier={loadingEarlier}
				earlierError={earlierError}
				onLoadEarlier={() => void loadEarlier()}
				error={incident.error}
				receivedAt={incident.receivedAt}
				now={now}
			/>
		);
	}
	return (
		<>
			<p className="back-link">
				<Link href={pagePath(pageId)}>← {t("public.incident.back")}</Link>
			</p>
			<article className={`incident incident--${body.impact} incident--page`} aria-labelledby="incident-title">
				<header className="incident__head">
					<h2 id="incident-title" className="incident__title">
						{body.title}
					</h2>
					<ImpactBadge impact={body.impact} />
					<StageBadge stage={body.stage} />
				</header>
				{body.components.length > 0 && (
					<p className="incident__components">
						{t("public.incident.affects", {
							components: f.list(body.components.map((component) => `${component.name} (${t(`impact.${component.impact}`)})`)),
						})}
					</p>
				)}
				<p className="muted">
					{body.resolvedAt === null
						? t("public.incident.ongoingSince", { time: f.dateTimeWithZone(body.startedAt) })
						: t("public.incident.lasted", {
								from: f.dateTimeWithZone(body.startedAt),
								duration: f.duration(body.resolvedAt - body.startedAt),
							})}
				</p>
				<Timeline updates={[...(earlier?.updates ?? []), ...body.updates]} />
				{earlierCursor !== null && (
					<p>
						<button type="button" className="button" onClick={() => void loadEarlier()} disabled={loadingEarlier}>
							{loadingEarlier ? t("ui.loading") : t("public.incident.earlierUpdates")}
						</button>
					</p>
				)}
				{earlierError !== null && (
					<p role="alert" className="error-text">
						{t("public.incident.earlierFailed", { reason: describeError(earlierError, t) })}
					</p>
				)}
			</article>
			{incident.error !== null && (
				<p role="status" className="freshness__error">
					<Icon name="warning" />
					{t("public.freshness.failed", { reason: describeError(incident.error, t) })}{" "}
					{t("public.freshness.updated", { time: f.time(incident.receivedAt ?? now) })}
				</p>
			)}
		</>
	);
}
