/**
 * The modern template's pages: its frame (header, card and footer), which stays while visitors
 * move between a page's views (src/public/Page.tsx), and each view's content in the card. They
 * get the data the default template's views poll (and poll what only they show: response times
 * and recent incidents), so both templates read the same public API at the same pace.
 */
import type { ReactNode } from "react";
import type { PageHistoryResponse, PageStatusResponse, PublicIncidentPage, PublicIncidentUpdate, StoppagesResponse } from "../../../shared/public-api";
import { useI18n } from "../../i18n/I18nProvider";
import type { Freshness } from "../../lib/freshness";
import type { Fetched } from "../../lib/http";
import { Link } from "../../lib/router";
import { type Polled, usePoller } from "../../lib/usePoller";
import { getLatency, HISTORY_INTERVAL_MS, HISTORY_MAX_BACKOFF_MS, historyPath, latencyUrl, PENDING_HISTORY_INTERVAL_MS, pagePath } from "../api";
import { describeError } from "../FreshnessNotice";
import { useIncidentHistory } from "../IncidentHistory";
import type { PageFrame } from "../Layout";
import { StoppageList } from "../StoppageList";
import { ComponentList } from "./components";
import {
	IncidentCard,
	MaintenanceCard,
	OutdatedNotice,
	Overall,
	PastIncident,
	RecentIncidents,
	RefreshProblem,
	Timeline,
	UpcomingMaintenance,
	when,
} from "./notices";
import { Shell, StrokeIcon } from "./shell";

// ---------------------------------------------------------------------------
// The frame, and views that wait or fail
// ---------------------------------------------------------------------------

export interface ModernFrameProps {
	readonly frame: PageFrame;
	/** The view's content, in the card. */
	readonly children: ReactNode;
}

/** A page's frame, around one of its views. */
export function ModernFrame({ frame, children }: ModernFrameProps) {
	return (
		<Shell appearance={frame.appearance} title={frame.title} home={frame.home} reportUrl={frame.reportUrl}>
			{children}
		</Shell>
	);
}

/** A view before what it shows arrived. */
export function ModernViewLoading() {
	const { t } = useI18n();
	return (
		<div className="m-card__body m-card__body--waiting" aria-busy="true">
			<p className="m-muted">{t("ui.loading")}</p>
		</div>
	);
}

export interface ModernUnavailableProps {
	readonly reason: string;
	onRetry(): void;
}

/** A view whose first request failed: nothing to show, and nothing old to show either. */
export function ModernViewUnavailable({ reason, onRetry }: ModernUnavailableProps) {
	const { t } = useI18n();
	return (
		<div className="m-card__body m-card__body--waiting">
			<h1 className="m-overall__title">{t("public.unavailable.title")}</h1>
			<p role="alert" className="m-alert">
				{t("public.unavailable.detail", { reason })}
			</p>
			<p>
				<button type="button" className="m-button" onClick={onRetry}>
					{t("public.freshness.retryNow")}
				</button>
			</p>
		</div>
	);
}

export interface ModernNotFoundProps {
	readonly message: string;
	/** Where the back link goes: the page's status. */
	readonly back: string;
}

/** A view showing something that does not exist, such as an incident. */
export function ModernViewNotFound({ message, back }: ModernNotFoundProps) {
	const { t } = useI18n();
	return (
		<div className="m-card__body">
			<p className="m-back">
				<Link href={back}>← {t("public.incident.back")}</Link>
			</p>
			<h1 className="m-overall__title">{t("public.notFound.title")}</h1>
			<p className="m-muted">{message}</p>
		</div>
	);
}

/**
 * Before the page's status arrived, for a page whose HTML says it uses this template
 * (src/public/templates.ts): the frame, without the page's title (not known yet).
 */
export function ModernLoadingView() {
	return (
		<Shell appearance={undefined} title={null} home="/" reportUrl={null}>
			<ModernViewLoading />
		</Shell>
	);
}

/** The page's status could not be read at all: the frame, without the page's title. */
export function ModernUnavailableView(props: ModernUnavailableProps) {
	return (
		<Shell appearance={undefined} title={null} home="/" reportUrl={null}>
			<ModernViewUnavailable {...props} />
		</Shell>
	);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface ModernStatusProps {
	/** The page's ID. */
	readonly pageId: string;
	readonly body: PageStatusResponse;
	readonly status: Polled<Fetched<PageStatusResponse>>;
	readonly history: Polled<Fetched<PageHistoryResponse>>;
	readonly stoppages: Polled<Fetched<StoppagesResponse>>;
	readonly freshness: Freshness;
	readonly now: number;
}

/** The page's status, in the card. */
export function ModernStatusContent({ pageId, body, status, history, stoppages, freshness, now }: ModernStatusProps) {
	const { t } = useI18n();
	const publishes = body.components.some((component) => component.latency);
	const latencyUrlOf = latencyUrl(pageId);
	const latency = usePoller(publishes ? latencyUrlOf : null, {
		load: (signal) => getLatency(latencyUrlOf, signal),
		intervalMs: HISTORY_INTERVAL_MS,
		intervalAfter: (data) => (data.body.complete ? HISTORY_INTERVAL_MS : PENDING_HISTORY_INTERVAL_MS),
		maxBackoffMs: HISTORY_MAX_BACKOFF_MS,
	});
	const outdated = body.incidentsOutdated || history.data?.body.incidentsOutdated === true;
	return (
		<>
			<div className="m-card__body">
				<Overall body={body} freshness={freshness} now={now} />
				<RefreshProblem freshness={freshness} dueAt={status.dueAt} loading={status.loading} now={now} onRetry={status.refresh} />
				{outdated && <OutdatedNotice />}
				{body.incidents.map((incident) => (
					<IncidentCard key={incident.id} incident={incident} pageId={pageId} now={now} />
				))}
				{body.maintenance.active.map((maintenance) => (
					<MaintenanceCard key={maintenance.id} maintenance={maintenance} now={now} />
				))}
				{body.maintenance.upcoming.map((maintenance) => (
					<UpcomingMaintenance key={maintenance.id} maintenance={maintenance} now={now} />
				))}
				<ComponentList
					components={body.components}
					groups={body.groups}
					history={history.data?.body}
					historyFailed={history.error !== null}
					historyError={history.error === null ? undefined : describeError(history.error, t)}
					stoppages={stoppages.data?.body.stoppages ?? []}
					latency={{ data: latency.data?.body, error: latency.error }}
					stale={freshness.kind === "stale"}
					now={now}
				/>
				<RecentIncidents pageId={pageId} refreshKey={body.incidents.map((incident) => incident.id).join(",")} now={now} />
			</div>
			<div className="m-card__foot">
				<Link href={historyPath(pageId)} className="m-foot-link">
					{t("public.modern.notices.all")}
					<StrokeIcon name="chevron-right" size={16} />
				</Link>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// One incident
// ---------------------------------------------------------------------------

export interface ModernIncidentProps {
	readonly pageId: string;
	readonly incident: PublicIncidentPage;
	/** Updates read before the latest ones, oldest first. */
	readonly earlier: readonly PublicIncidentUpdate[];
	readonly canLoadEarlier: boolean;
	readonly loadingEarlier: boolean;
	readonly earlierError: unknown;
	onLoadEarlier(): void;
	/** The latest refresh's error, if it failed. */
	readonly error: unknown;
	readonly receivedAt: number | null;
	readonly now: number;
}

const IMPACT_TONE = { none: "up", degraded: "degraded", down: "down" } as const;

/** One incident with its timeline, in the card. */
export function ModernIncidentContent(props: ModernIncidentProps) {
	const { t, f } = useI18n();
	const { incident, pageId, now } = props;
	const tone = IMPACT_TONE[incident.impact];
	return (
		<div className="m-card__body">
			<p className="m-back">
				<Link href={pagePath(pageId)}>← {t("public.incident.back")}</Link>
			</p>
			<article className={`m-notice m-notice--${tone} m-notice--page`} aria-labelledby="m-incident-title">
				<div className="m-notice__meta">
					<span className={`m-pill m-pill--${tone}`}>{t(`impact.${incident.impact}`)}</span>
					<span className={`m-pill m-pill--stage`}>{t(`stage.${incident.stage}`)}</span>
				</div>
				<h1 id="m-incident-title" className="m-notice__title m-notice__title--page">
					{incident.title}
				</h1>
				{incident.components.length > 0 && (
					<p className="m-muted m-small">
						{t("public.incident.affects", {
							components: f.list(incident.components.map((component) => `${component.name} (${t(`impact.${component.impact}`)})`)),
						})}
					</p>
				)}
				<p className="m-muted m-small m-num">
					{incident.resolvedAt === null
						? t("public.incident.ongoingSince", { time: f.dateTimeWithZone(incident.startedAt) })
						: t("public.incident.lasted", {
								from: f.dateTimeWithZone(incident.startedAt),
								duration: f.duration(incident.resolvedAt - incident.startedAt),
							})}
				</p>
				<Timeline updates={[...props.earlier, ...incident.updates]} now={now} />
				{props.canLoadEarlier && (
					<p>
						<button type="button" className="m-button" onClick={props.onLoadEarlier} disabled={props.loadingEarlier}>
							{props.loadingEarlier ? t("ui.loading") : t("public.incident.earlierUpdates")}
						</button>
					</p>
				)}
				{props.earlierError !== null && (
					<p role="alert" className="m-alert">
						{t("public.incident.earlierFailed", { reason: describeError(props.earlierError, t) })}
					</p>
				)}
			</article>
			{props.error !== null && (
				<p role="status" className="m-alert">
					{t("public.freshness.failed", { reason: describeError(props.error, t) })}{" "}
					{t("public.freshness.updated", { time: when(props.receivedAt ?? now, now, f) })}
				</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface ModernHistoryProps {
	readonly pageId: string;
	readonly stoppages: StoppagesResponse | undefined;
	readonly stoppagesFailed: boolean;
	/** Component names by ID. */
	readonly names: ReadonlyMap<string, string>;
	readonly refreshKey: string;
	readonly now: number;
}

/** Every past incident (paged), and the outages monitoring detected, in the card. */
export function ModernHistoryContent({ pageId, stoppages, stoppagesFailed, names, refreshKey, now }: ModernHistoryProps) {
	const { t } = useI18n();
	const history = useIncidentHistory(pageId, refreshKey);
	return (
		<div className="m-card__body">
			<p className="m-back">
				<Link href={pagePath(pageId)}>← {t("public.incident.back")}</Link>
			</p>
			<section aria-labelledby="m-history-title" className="m-history">
				<h1 id="m-history-title" className="m-overall__title">
					{t("public.modern.history.title")}
				</h1>
				{!history.loaded ? (
					<p className="m-muted m-small">
						{history.error === null ? t("ui.loading") : t("public.history.failed", { reason: describeError(history.error, t) })}
					</p>
				) : history.items.length === 0 ? (
					<p className="m-muted m-small">{t("public.history.none")}</p>
				) : (
					<ul className="m-past-list">
						{history.items.map((incident) => (
							<PastIncident key={incident.id} incident={incident} pageId={pageId} now={now} />
						))}
					</ul>
				)}
				{history.hasMore && (
					<p>
						<button type="button" className="m-button" onClick={() => void history.loadMore()} disabled={history.loadingMore}>
							{history.loadingMore ? t("ui.loading") : t("public.history.more")}
						</button>
					</p>
				)}
				{history.moreError !== null && (
					<p role="alert" className="m-alert">
						{t("public.history.failed", { reason: describeError(history.moreError, t) })}
					</p>
				)}
			</section>
			<div className="m-stoppages">
				<StoppageList stoppages={stoppages} names={names} failed={stoppagesFailed} now={now} />
			</div>
		</div>
	);
}
