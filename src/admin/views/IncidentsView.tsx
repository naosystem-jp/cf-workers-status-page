import type { Incident, ListPage } from "../../../shared/admin-api";
import { useAdminI18n } from "../messages";
import { Link, navigate, useLocation, withQuery } from "../../lib/router";
import { ImpactBadge, StageBadge } from "../../components/StateLabel";
import { api, query } from "../api";
import { useSelectedPage } from "../context";
import { ErrorAlert } from "../forms";
import { Loading, PagePicker, pageLink, ViewHeader } from "../layout";
import { usePagedList } from "../usePagedList";
import { highestImpact } from "./incident-form";

const STATUSES = ["", "open", "resolved"] as const;

/** A page's incidents, latest start first, optionally only open or resolved ones. */
export function IncidentsView() {
	const { t, f } = useAdminI18n();
	const { pageId, page } = useSelectedPage();
	const location = useLocation();
	const status = STATUSES.find((value) => value === location.search.get("status")) ?? "";
	const list = usePagedList(`${pageId}\n${status}`, (cursor, signal) =>
		api.get<ListPage<Incident>>(query("/incidents", { page: pageId, status, cursor }), signal),
	);
	const names = new Map(page?.components.map((component) => [component.id, component.name]));

	return (
		<>
			<ViewHeader
				title={t("admin.incidents.title")}
				actions={
					<Link className="button button--primary" href={pageLink("/admin/incidents/new", pageId)}>
						{t("admin.incidents.new")}
					</Link>
				}
			>
				<div className="filters">
					<PagePicker />
					<label className="inline-field">
						<span>{t("admin.incidents.filter")}</span>
						<select
							value={status}
							onChange={(event) =>
								navigate(withQuery(location.pathname, { page: location.search.get("page"), status: event.target.value }), {
									replace: true,
									keepScroll: true,
								})
							}
						>
							{STATUSES.map((value) => (
								<option key={value} value={value}>
									{t(`admin.incidents.status.${value || "all"}`)}
								</option>
							))}
						</select>
					</label>
				</div>
			</ViewHeader>
			<ErrorAlert error={list.error} onRetry={list.reload} />
			{list.items.length === 0 && list.loading ? (
				<Loading />
			) : list.items.length === 0 && list.error === null ? (
				<p className="empty">{t("admin.incidents.none")}</p>
			) : (
				<ul className="list">
					{list.items.map((incident) => (
						<li key={incident.id} className="list-item">
							<div className="list-item__main">
								<p className="list-item__title">
									<Link href={`/admin/incidents/${encodeURIComponent(incident.id)}`}>{incident.title}</Link>
								</p>
								<p className="list-item__meta">
									<StageBadge stage={incident.stage} />
									<ImpactBadge impact={highestImpact(incident.components)} />
									{incident.autoCreated && <span className="badge badge--unknown">{t("admin.incidents.auto")}</span>}
								</p>
								{incident.components.length > 0 && (
									<p className="muted">
										{f.list(
											incident.components.map(
												(component) => `${names.get(component.id) ?? component.id} (${t(`impact.${component.impact}`)})`,
											),
										)}
									</p>
								)}
							</div>
							<dl className="list-item__facts">
								<div>
									<dt>{t("admin.incidents.started")}</dt>
									<dd>{f.dateTime(incident.startedAt)}</dd>
								</div>
								<div>
									<dt>{incident.resolvedAt === null ? t("admin.incidents.updated") : t("admin.incidents.resolved")}</dt>
									<dd>{f.dateTime(incident.resolvedAt ?? incident.updatedAt)}</dd>
								</div>
							</dl>
						</li>
					))}
				</ul>
			)}
			{list.more && (
				<p>
					<button type="button" className="button" onClick={list.loadMore} disabled={list.loading}>
						{list.loading ? t("ui.loading") : t("admin.list.more")}
					</button>
				</p>
			)}
		</>
	);
}
