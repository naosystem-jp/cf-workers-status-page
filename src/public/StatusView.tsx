import type { PageHistoryResponse, PageStatusResponse } from "../../shared/public-api";
import { useI18n } from "../i18n/I18nProvider";
import { freshness, serverAgeMs } from "../lib/freshness";
import { type Fetched, isNotFound } from "../lib/http";
import { type Polled, useNow, usePoller } from "../lib/usePoller";
import {
	getHistory,
	getStoppages,
	HISTORY_INTERVAL_MS,
	HISTORY_MAX_BACKOFF_MS,
	historyUrl,
	PENDING_HISTORY_INTERVAL_MS,
	STATUS_INTERVAL_MS,
	stoppagesUrl,
} from "./api";
import { ComponentList } from "./ComponentList";
import { describeError, FreshnessNotice, OutdatedIncidentsNotice } from "./FreshnessNotice";
import { IncidentHistory } from "./IncidentHistory";
import { ActiveIncident } from "./Incidents";
import { useDocumentTitle, ViewLoading } from "./Layout";
import { MaintenanceSection } from "./Maintenance";
import { ModernStatusContent, ModernViewLoading } from "./modern/lazy";
import { OverallBanner } from "./OverallBanner";
import { StoppageList } from "./StoppageList";

export interface StatusViewProps {
	/** The page's ID. */
	readonly pageId: string;
	/** The page's title, for the tab. */
	readonly title: string;
	readonly modern: boolean;
	/** The page's status, which the page reads (Page.tsx). */
	readonly status: Polled<Fetched<PageStatusResponse>>;
	readonly body: PageStatusResponse;
	/**
	 * When the status in hand arrived, if this view was entered from another of the page's views
	 * (`null` otherwise): an incident's view reads it only every 5 minutes.
	 */
	readonly enteredWith: number | null;
}

/**
 * A page's status, in its frame (Page.tsx): the overall state, incidents, maintenance,
 * components with their history, past incidents and outages, in the default template or the
 * modern one (modern/views.tsx, loaded when first needed).
 *
 * Besides the status, which the page reads every 30 seconds, it reads the history, stoppages
 * and incident history every 5 minutes, each paused while the tab is hidden and backing
 * off on errors (usePoller).
 */
export function StatusView({ pageId, title, modern, status, body, enteredWith }: StatusViewProps) {
	const { t } = useI18n();
	const now = useNow(5_000);
	const history = usePoller(historyUrl(pageId), {
		load: (signal) => getHistory(historyUrl(pageId), signal),
		intervalMs: HISTORY_INTERVAL_MS,
		intervalAfter: (data: Fetched<PageHistoryResponse>) => (data.body.complete ? HISTORY_INTERVAL_MS : PENDING_HISTORY_INTERVAL_MS),
		maxBackoffMs: HISTORY_MAX_BACKOFF_MS,
		isFatal: isNotFound,
	});
	const stoppages = usePoller(stoppagesUrl(pageId), {
		load: (signal) => getStoppages(stoppagesUrl(pageId), signal),
		intervalMs: HISTORY_INTERVAL_MS,
		maxBackoffMs: HISTORY_MAX_BACKOFF_MS,
		isFatal: isNotFound,
	});
	useDocumentTitle(title);

	const fresh = freshness(status, serverAgeMs(body.generatedAt, status.data?.serverDate ?? null), now);
	// Entered with a status that grew old while another view had no need of it every 30 seconds
	// (an incident's): the page is reading it again. Wait for that, rather than show the old one,
	// even marked as old, for a moment. A status that was old when it arrived shows as such.
	const catchingUp = enteredWith !== null && status.receivedAt === enteredWith && status.error === null && fresh.kind === "stale" && now - enteredWith >= STATUS_INTERVAL_MS;
	if (catchingUp) return modern ? <ModernViewLoading /> : <ViewLoading />;

	if (modern) {
		return <ModernStatusContent pageId={pageId} body={body} status={status} history={history} stoppages={stoppages} freshness={fresh} now={now} />;
	}
	const stale = fresh.kind === "stale";
	const names = new Map(body.components.map((component) => [component.id, component.name]));
	return (
		<>
			<OverallBanner
				overall={body.overall}
				hasComponents={body.components.length > 0}
				maintenance={body.maintenance.active.length > 0}
				freshness={fresh}
				generatedAt={body.generatedAt}
				now={now}
			/>
			<FreshnessNotice freshness={fresh} generatedAt={body.generatedAt} dueAt={status.dueAt} loading={status.loading} now={now} onRetry={status.refresh} />
			{(body.incidentsOutdated || history.data?.body.incidentsOutdated === true) && <OutdatedIncidentsNotice />}
			{body.incidents.length > 0 && (
				<section className="section" aria-labelledby="incidents-heading">
					<h2 id="incidents-heading" className="section__title">
						{t("public.incidents.heading")}
					</h2>
					{body.incidents.map((incident) => (
						<ActiveIncident key={incident.id} incident={incident} pageId={pageId} />
					))}
				</section>
			)}
			<MaintenanceSection items={body.maintenance.active} active />
			<ComponentList
				components={body.components}
				history={history.data?.body}
				historyFailed={history.error !== null}
				historyError={history.error === null ? undefined : describeError(history.error, t)}
				stale={stale}
			/>
			<MaintenanceSection items={body.maintenance.upcoming} active={false} />
			<IncidentHistory pageId={pageId} refreshKey={body.incidents.map((incident) => incident.id).join(",")} />
			<StoppageList stoppages={stoppages.data?.body} names={names} failed={stoppages.error !== null} now={now} />
		</>
	);
}
