import type { PublicIncident, PublicIncidentUpdate, PublicIncidentWithUpdates } from "../../shared/public-api";
import { useI18n } from "../i18n/I18nProvider";
import { Link } from "../lib/router";
import { incidentPath } from "./api";
import { ImpactBadge, StageBadge } from "../components/StateLabel";

/** Affected components and their impact: "API (outage), Website (degraded performance)". */
function AffectedComponents({ incident }: { readonly incident: PublicIncident }) {
	const { t, f } = useI18n();
	if (incident.components.length === 0) return null;
	return (
		<p className="incident__components">
			{t("public.incident.affects", {
				components: f.list(incident.components.map((component) => `${component.name} (${t(`impact.${component.impact}`)})`)),
			})}
		</p>
	);
}

/** The timeline, latest update first. */
export function Timeline({ updates }: { readonly updates: readonly PublicIncidentUpdate[] }) {
	const { f } = useI18n();
	return (
		<ol className="timeline">
			{[...updates].reverse().map((update) => (
				<li key={`${update.createdAt}:${update.stage}`} className="timeline__item">
					<p className="timeline__meta">
						<StageBadge stage={update.stage} />
						<time dateTime={new Date(update.createdAt).toISOString()}>{f.dateTimeWithZone(update.createdAt)}</time>
					</p>
					<p className="timeline__body">{update.body}</p>
				</li>
			))}
		</ol>
	);
}

/** An unresolved incident on the status page, with its latest updates. */
export function ActiveIncident({ incident, pageId }: { readonly incident: PublicIncidentWithUpdates; readonly pageId: string }) {
	const { t, f } = useI18n();
	return (
		<article className={`incident incident--${incident.impact}`} aria-labelledby={`incident-${incident.id}`}>
			<header className="incident__head">
				<h3 id={`incident-${incident.id}`} className="incident__title">
					<Link href={incidentPath(pageId, incident.id)}>{incident.title}</Link>
				</h3>
				<ImpactBadge impact={incident.impact} />
			</header>
			<AffectedComponents incident={incident} />
			<p className="muted">{t("public.incident.started", { time: f.dateTimeWithZone(incident.startedAt) })}</p>
			<Timeline updates={incident.updates} />
			{incident.olderUpdates && (
				<p>
					<Link href={incidentPath(pageId, incident.id)}>{t("public.incident.olderUpdates")}</Link>
				</p>
			)}
		</article>
	);
}

/** A resolved (or any) incident as a line of the history. */
export function IncidentSummary({ incident, pageId }: { readonly incident: PublicIncident; readonly pageId: string }) {
	const { t, f } = useI18n();
	return (
		<li className="history-item">
			<p className="history-item__title">
				<Link href={incidentPath(pageId, incident.id)}>{incident.title}</Link> <ImpactBadge impact={incident.impact} />
			</p>
			<p className="muted">
				{incident.resolvedAt === null
					? t("public.incident.ongoingSince", { time: f.dateTimeWithZone(incident.startedAt) })
					: t("public.incident.lasted", {
							from: f.dateTimeWithZone(incident.startedAt),
							duration: f.duration(incident.resolvedAt - incident.startedAt),
						})}
			</p>
			<AffectedComponents incident={incident} />
		</li>
	);
}
