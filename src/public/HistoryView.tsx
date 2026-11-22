import type { PageStatusResponse } from "../../shared/public-api";
import { useI18n } from "../i18n/I18nProvider";
import { isNotFound } from "../lib/http";
import { Link } from "../lib/router";
import { useNow, usePoller } from "../lib/usePoller";
import { getStoppages, HISTORY_INTERVAL_MS, HISTORY_MAX_BACKOFF_MS, pagePath, stoppagesUrl } from "./api";
import { IncidentHistory } from "./IncidentHistory";
import { useDocumentTitle } from "./Layout";
import { ModernHistoryContent } from "./modern/lazy";
import { StoppageList } from "./StoppageList";

export interface HistoryViewProps {
	/** The page's ID. */
	readonly pageId: string;
	/** The page's title, for the tab. */
	readonly title: string;
	readonly modern: boolean;
	/** The page's status, which the page reads (Page.tsx): its components' names and unresolved incidents. */
	readonly body: PageStatusResponse;
}

/**
 * A page's past incidents and the outages monitoring detected, apart from its current status
 * (`/pages/:pageId/history`), in its frame (Page.tsx): the modern template links here; the
 * default template's status lists both itself. It reads only these two lists.
 */
export function HistoryView({ pageId, title, modern, body }: HistoryViewProps) {
	const { t } = useI18n();
	const now = useNow(30_000);
	const stoppages = usePoller(stoppagesUrl(pageId), {
		load: (signal) => getStoppages(stoppagesUrl(pageId), signal),
		intervalMs: HISTORY_INTERVAL_MS,
		maxBackoffMs: HISTORY_MAX_BACKOFF_MS,
		isFatal: isNotFound,
	});
	useDocumentTitle(`${t("public.history.heading")} · ${title}`);

	const names = new Map(body.components.map((component) => [component.id, component.name]));
	const refreshKey = body.incidents.map((incident) => incident.id).join(",");
	if (modern) {
		return (
			<ModernHistoryContent
				pageId={pageId}
				stoppages={stoppages.data?.body}
				stoppagesFailed={stoppages.error !== null}
				names={names}
				refreshKey={refreshKey}
				now={now}
			/>
		);
	}
	return (
		<>
			<p className="back-link">
				<Link href={pagePath(pageId)}>← {t("public.incident.back")}</Link>
			</p>
			<IncidentHistory pageId={pageId} refreshKey={refreshKey} />
			<StoppageList stoppages={stoppages.data?.body} names={names} failed={stoppages.error !== null} now={now} />
		</>
	);
}
