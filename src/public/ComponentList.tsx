import type { ComponentStatus, PageHistoryResponse } from "../../shared/public-api";
import { useI18n } from "../i18n/I18nProvider";
import { MaintenanceBadge, StateLabel } from "../components/StateLabel";
import { type Markers, UptimeBars } from "./UptimeBars";

export interface ComponentListProps {
	readonly components: readonly ComponentStatus[];
	/** `undefined` until the history is loaded. */
	readonly history: PageHistoryResponse | undefined;
	/** Whether the latest attempt to load the history failed (it is retried). */
	readonly historyFailed: boolean;
	/** Why, in words, when it failed. */
	readonly historyError?: string;
	/** Whether the states shown are the last known ones (see OverallBanner). */
	readonly stale: boolean;
}

export function ComponentList({ components, history, historyFailed, historyError, stale }: ComponentListProps) {
	const { t, f } = useI18n();
	if (components.length === 0) return null;
	const byId = new Map(history?.components.map((component) => [component.id, component]));
	const markers: Markers = {
		incidents: new Map(history?.incidents.map((marker) => [marker.id, marker])),
		maintenance: new Map(history?.maintenance.map((marker) => [marker.id, marker])),
	};
	return (
		<section className="section" aria-labelledby="components-heading">
			<h2 id="components-heading" className="section__title">
				{t("public.components.heading")}
			</h2>
			{stale && <p className="muted">{t("public.components.stale")}</p>}
			{historyFailed && history !== undefined && (
				<p className="muted">
					{t("public.components.historyStale", { reason: historyError ?? "", time: f.time(history.generatedAt) })}
				</p>
			)}
			<ul className={`components${stale ? " is-stale" : ""}`}>
				{components.map((component) => {
					const componentHistory = byId.get(component.id);
					return (
						<li key={component.id} className="component">
							<div className="component__head">
								<h3 className="component__name">{component.name}</h3>
								{component.maintenance && <MaintenanceBadge />}
								<StateLabel state={component.state} />
							</div>
							{componentHistory !== undefined ? (
								<UptimeBars component={componentHistory} markers={markers} />
							) : history === undefined && !historyFailed ? (
								<div className="bars bars--placeholder" aria-hidden="true" />
							) : historyFailed && history === undefined ? (
								<p className="muted">{t("public.components.historyFailed")}</p>
							) : null}
						</li>
					);
				})}
			</ul>
			{history !== undefined && <Legend />}
		</section>
	);
}

function Legend() {
	const { t } = useI18n();
	const swatches = [
		["up", t("public.legend.up")],
		["degraded", t("public.legend.degraded")],
		["down", t("public.legend.down")],
		["nodata", t("public.legend.noData")],
		["notyet", t("public.legend.notMonitored")],
	] as const;
	return (
		<div className="legend">
			<ul className="legend__items">
				{swatches.map(([kind, label]) => (
					<li key={kind}>
						<span className={`legend__swatch bar bar--${kind}`} aria-hidden="true">
							<span className="bar__fill" />
						</span>
						{label}
					</li>
				))}
				<li>
					<span className="legend__marker legend__marker--incident" aria-hidden="true" />
					{t("public.legend.incident")}
				</li>
				<li>
					<span className="legend__marker legend__marker--maintenance" aria-hidden="true" />
					{t("public.legend.maintenance")}
				</li>
			</ul>
			<p className="muted">{t("public.legend.uptime")}</p>
		</div>
	);
}
