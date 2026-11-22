/**
 * The modern template's announcements: the overall state, what could not be refreshed,
 * unresolved incidents, maintenance in progress and planned, and recent incidents.
 */
import { useState } from "react";
import type {
	Impact,
	PageStatusResponse,
	PublicIncident,
	PublicIncidentUpdate,
	PublicIncidentWithUpdates,
	PublicMaintenance,
} from "../../../shared/public-api";
import type { Formatters } from "../../i18n/format";
import { useI18n } from "../../i18n/I18nProvider";
import type { Freshness } from "../../lib/freshness";
import { isNotFound } from "../../lib/http";
import { Link } from "../../lib/router";
import { usePoller } from "../../lib/usePoller";
import { getIncident, HISTORY_INTERVAL_MS, HISTORY_MAX_BACKOFF_MS, historyPath, incidentPath, incidentUrl } from "../api";
import { describeError } from "../FreshnessNotice";
import { useIncidentHistory } from "../IncidentHistory";
import { Glyph, StrokeIcon, type Tone } from "./shell";

const DAY_MS = 86_400_000;
/** How far back "recent incidents" go. */
export const RECENT_MS = 7 * DAY_MS;

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

const clocks = new Map<string, Intl.DateTimeFormat>();

/** Hours and minutes with the zone, as "14:25 JST" (in the viewer's time zone). */
function clockWithZone(f: Formatters): Intl.DateTimeFormat {
	const key = `${f.locale} ${f.timeZone}`;
	let clock = clocks.get(key);
	if (clock === undefined) {
		clock = new Intl.DateTimeFormat(f.locale, { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: f.timeZone });
		clocks.set(key, clock);
	}
	return clock;
}

/** `at` as briefly as it stays clear: the time alone today, else the date as well; always with the zone. */
export function when(at: number, now: number, f: Formatters): string {
	return f.date(at) === f.date(now) ? clockWithZone(f).format(at) : f.dateTimeWithZone(at);
}

// ---------------------------------------------------------------------------
// Overall state
// ---------------------------------------------------------------------------

export interface OverallProps {
	readonly body: PageStatusResponse;
	readonly freshness: Freshness;
	readonly now: number;
}

/**
 * The page's overall state and when it was computed. When the status could not be refreshed for
 * a while, it says that the state is the last known one, in a neutral colour: an old "all
 * systems operational" must never look current. Maintenance is said next to the state,
 * never instead of it.
 */
export function Overall({ body, freshness, now }: OverallProps) {
	const { t, f } = useI18n();
	const stale = freshness.kind === "stale";
	const hasComponents = body.components.length > 0;
	const headline = hasComponents ? t(`public.overall.${body.overall}`) : t("public.overall.empty");
	const tone: Tone = stale ? "stale" : hasComponents ? body.overall : "unknown";
	const maintenance = body.maintenance.active.length > 0;
	return (
		<section className="m-overall" aria-labelledby="m-overall-title">
			<div className="m-overall__row">
				<span className={`m-overall__glyph m-soft--${tone}`}>
					<Glyph tone={tone} size={22} />
				</span>
				<h1 id="m-overall-title" className="m-overall__title">
					{stale ? t("public.overall.stale") : headline}
				</h1>
			</div>
			{stale ? (
				<p className="m-overall__detail">{t("public.overall.staleDetail", { state: headline, time: f.relative(body.generatedAt, now) })}</p>
			) : body.overall === "unknown" && hasComponents ? (
				<p className="m-overall__detail">{t("public.overall.unknownDetail")}</p>
			) : null}
			{maintenance && !stale && <p className="m-overall__detail">{t("public.overall.maintenance")}</p>}
			<p className="m-overall__updated">{t("public.modern.updated", { time: f.dateTimeWithZone(body.generatedAt) })}</p>
		</section>
	);
}

export interface RefreshProblemProps {
	readonly freshness: Freshness;
	readonly dueAt: number | null;
	readonly loading: boolean;
	readonly now: number;
	readonly onRetry: () => void;
}

/** When refreshing fails: why, when it is tried again, and a button to try now. */
export function RefreshProblem({ freshness, dueAt, loading, now, onRetry }: RefreshProblemProps) {
	const { t, f } = useI18n();
	const error = freshness.kind === "fresh" || freshness.kind === "stale" ? freshness.error : null;
	if (error === null) return null;
	return (
		<div className="m-alert">
			<span role="status">{t("public.freshness.failed", { reason: describeError(error, t) })}</span>
			<span>
				{loading
					? t("public.freshness.retrying")
					: dueAt !== null && t("public.freshness.retryAt", { time: f.relative(Math.max(dueAt, now + 1000), now) })}
			</span>
			<button type="button" className="m-button m-button--small" onClick={onRetry} disabled={loading}>
				{t("public.freshness.retryNow")}
			</button>
		</div>
	);
}

/** Incidents and maintenance could not be read just now (the database was unavailable). */
export function OutdatedNotice() {
	const { t } = useI18n();
	return (
		<div className="m-alert" role="status">
			{t("public.freshness.incidentsOutdated")}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

const IMPACT_TONE: Readonly<Record<Impact, Tone>> = { none: "up", degraded: "degraded", down: "down" };

/** Affected components, with an impact only where it differs from the incident's own. */
function affected(incident: PublicIncident, t: ReturnType<typeof useI18n>["t"], f: Formatters): string {
	return f.list(
		incident.components.map((component) =>
			component.impact === incident.impact ? component.name : `${component.name} (${t(`impact.${component.impact}`)})`,
		),
	);
}

/** An incident's updates, latest first, each with its stage and time. */
export function Timeline({ updates, now }: { readonly updates: readonly PublicIncidentUpdate[]; readonly now: number }) {
	const { t, f } = useI18n();
	return (
		<ol className="m-timeline">
			{[...updates].reverse().map((update) => (
				<li key={`${update.createdAt}:${update.stage}`} className="m-timeline__item">
					<div className="m-timeline__when">
						<strong>{t(`stage.${update.stage}`)}</strong>
						<time dateTime={new Date(update.createdAt).toISOString()}>{when(update.createdAt, now, f)}</time>
					</div>
					<p className="m-timeline__body">{update.body}</p>
				</li>
			))}
		</ol>
	);
}

/** An unresolved incident, with its latest updates. */
export function IncidentCard({ incident, pageId, now }: { readonly incident: PublicIncidentWithUpdates; readonly pageId: string; readonly now: number }) {
	const { t, f } = useI18n();
	const tone = IMPACT_TONE[incident.impact];
	const started = when(incident.startedAt, now, f);
	return (
		<article className={`m-notice m-notice--${tone}`} aria-labelledby={`m-incident-${incident.id}`}>
			<div className="m-notice__meta">
				<span className={`m-pill m-pill--${tone}`}>{t(`impact.${incident.impact}`)}</span>
				<span className="m-muted m-num">
					{incident.components.length > 0
						? t("public.modern.incident.meta", { time: started, components: affected(incident, t, f) })
						: t("public.modern.incident.started", { time: started })}
				</span>
			</div>
			<h2 id={`m-incident-${incident.id}`} className="m-notice__title">
				<Link href={incidentPath(pageId, incident.id)}>{incident.title}</Link>
			</h2>
			<Timeline updates={incident.updates} now={now} />
			{incident.olderUpdates && (
				<p>
					<Link href={incidentPath(pageId, incident.id)}>{t("public.incident.olderUpdates")}</Link>
				</p>
			)}
		</article>
	);
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

function windowText(maintenance: PublicMaintenance, now: number, f: Formatters): { from: string; to: string } {
	const sameDay = f.date(maintenance.startsAt) === f.date(maintenance.endsAt);
	return {
		from: when(maintenance.startsAt, now, f),
		to: sameDay ? clockWithZone(f).format(maintenance.endsAt) : f.dateTimeWithZone(maintenance.endsAt),
	};
}

/** Maintenance in progress, with how far along its window it is. */
export function MaintenanceCard({ maintenance, now }: { readonly maintenance: PublicMaintenance; readonly now: number }) {
	const { t, f } = useI18n();
	const total = Math.max(1, maintenance.endsAt - maintenance.startsAt);
	// In whole minutes: seconds ticking by add nothing here.
	const elapsed = Math.floor(Math.min(total, Math.max(0, now - maintenance.startsAt)) / 60_000) * 60_000;
	const names = f.list(maintenance.components.map((component) => component.name));
	return (
		<article className="m-notice m-notice--maintenance" aria-labelledby={`m-maintenance-${maintenance.id}`}>
			<div className="m-notice__meta">
				<span className="m-pill m-pill--maintenance">{t("public.modern.maintenance.badge")}</span>
				<span className="m-muted m-num">
					{t("public.modern.maintenance.window", windowText(maintenance, now, f))}
					{maintenance.components.length > 0 && <> · {t("public.maintenance.components", { components: names })}</>}
				</span>
			</div>
			<h2 id={`m-maintenance-${maintenance.id}`} className="m-notice__title">
				{maintenance.title}
			</h2>
			<div className="m-progress">
				<div
					className="m-progress__track"
					role="progressbar"
					aria-label={maintenance.title}
					aria-valuemin={0}
					aria-valuemax={Math.round(total / 60_000)}
					aria-valuenow={Math.round(elapsed / 60_000)}
					aria-valuetext={t("public.modern.maintenance.progress", { elapsed: f.duration(elapsed), total: f.duration(total) })}
				>
					<div className="m-progress__fill" style={{ width: `${(elapsed / total) * 100}%` }} />
				</div>
				<span className="m-muted m-small m-num">
					{t("public.modern.maintenance.progress", { elapsed: f.duration(elapsed), total: f.duration(total) })}
				</span>
			</div>
			{maintenance.body !== "" && <p className="m-notice__body">{maintenance.body}</p>}
		</article>
	);
}

/** Planned maintenance. */
export function UpcomingMaintenance({ maintenance, now }: { readonly maintenance: PublicMaintenance; readonly now: number }) {
	const { t, f } = useI18n();
	const names = f.list(maintenance.components.map((component) => component.name));
	return (
		<section className="m-upcoming" aria-labelledby={`m-upcoming-${maintenance.id}`}>
			<span className="m-upcoming__icon">
				<StrokeIcon name="calendar" size={18} />
			</span>
			<div className="m-upcoming__text">
				<p className="m-eyebrow">{t("public.modern.maintenance.scheduled")}</p>
				<h2 id={`m-upcoming-${maintenance.id}`} className="m-upcoming__title">
					{maintenance.title}
				</h2>
				<p className="m-muted m-small m-num">
					{t("public.maintenance.window", { from: f.dateTimeWithZone(maintenance.startsAt), to: windowText(maintenance, now, f).to })}
					{maintenance.components.length > 0 && <> · {t("public.maintenance.components", { components: names })}</>}
				</p>
				{maintenance.body !== "" && <p className="m-small m-upcoming__body">{maintenance.body}</p>}
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Recent and past incidents
// ---------------------------------------------------------------------------

/** A resolved incident, with its updates on request. */
export function PastIncident({ incident, pageId, now }: { readonly incident: PublicIncident; readonly pageId: string; readonly now: number }) {
	const { t, f } = useI18n();
	const [open, setOpen] = useState(false);
	const url = incidentUrl(pageId, incident.id);
	const detail = usePoller(open ? url : null, {
		load: (signal) => getIncident(url, signal),
		intervalMs: HISTORY_INTERVAL_MS,
		maxBackoffMs: HISTORY_MAX_BACKOFF_MS,
		isFatal: isNotFound,
	});
	const tone = IMPACT_TONE[incident.impact];
	const period =
		incident.resolvedAt === null
			? t("public.incident.ongoingSince", { time: f.dateTimeWithZone(incident.startedAt) })
			: t("public.modern.notices.period", {
					from: f.dateTimeWithZone(incident.startedAt),
					to: f.date(incident.startedAt) === f.date(incident.resolvedAt) ? clockWithZone(f).format(incident.resolvedAt) : f.dateTimeWithZone(incident.resolvedAt),
				});
	const panel = `m-past-${incident.id}`;
	const body = detail.data?.body;
	return (
		<li className="m-past">
			<span className={`m-past__glyph m-soft--${tone}`}>
				<Glyph tone={tone} size={20} />
			</span>
			<div className="m-past__text">
				<h3 className="m-past__title">
					<Link href={incidentPath(pageId, incident.id)}>{incident.title}</Link>
				</h3>
				<p className="m-muted m-small m-num">
					{incident.resolvedAt !== null && <strong className="m-text--up">{t("public.modern.notices.resolved")}</strong>}
					{incident.resolvedAt !== null && " · "}
					{period}
					{incident.components.length > 0 && <> · {affected(incident, t, f)}</>}
				</p>
				<button type="button" className="m-link-button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
					{open ? t("public.modern.notices.hide") : t("public.modern.notices.show")}
					<span className={`m-chevron${open ? " is-open" : ""}`}>
						<StrokeIcon name="chevron-down" size={16} />
					</span>
				</button>
				{open && (
					<div id={panel} className="m-past__updates">
						{body !== undefined ? (
							<Timeline updates={body.updates} now={now} />
						) : detail.error !== null ? (
							<p className="m-muted m-small">{t("public.incident.earlierFailed", { reason: describeError(detail.error, t) })}</p>
						) : (
							<p className="m-muted m-small">{t("ui.loading")}</p>
						)}
					</div>
				)}
			</div>
		</li>
	);
}

/** Incidents resolved in the past 7 days, with a link to the whole history. */
export function RecentIncidents({ pageId, refreshKey, now }: { readonly pageId: string; readonly refreshKey: string; readonly now: number }) {
	const { t } = useI18n();
	const history = useIncidentHistory(pageId, refreshKey);
	const recent = history.items.filter((incident) => (incident.resolvedAt ?? now) >= now - RECENT_MS);
	return (
		<section className="m-recent" aria-labelledby="m-recent-title">
			<div className="m-recent__head">
				<h2 id="m-recent-title" className="m-eyebrow">
					{t("public.modern.notices.heading")}
				</h2>
				<Link href={historyPath(pageId)} className="m-eyebrow-link">
					{t("public.modern.notices.history")}
					<StrokeIcon name="chevron-right" size={14} />
				</Link>
			</div>
			{!history.loaded ? (
				<p className="m-muted m-small">
					{history.error === null ? t("ui.loading") : t("public.history.failed", { reason: describeError(history.error, t) })}
				</p>
			) : recent.length === 0 ? (
				<p className="m-muted m-small">{t("public.modern.notices.none")}</p>
			) : (
				<ul className="m-past-list">
					{recent.map((incident) => (
						<PastIncident key={incident.id} incident={incident} pageId={pageId} now={now} />
					))}
				</ul>
			)}
		</section>
	);
}
