import type { ListPage, Maintenance } from "../../../shared/admin-api";
import { useAdminI18n } from "../messages";
import { Link } from "../../lib/router";
import { api, query } from "../api";
import { useSelectedPage } from "../context";
import { ErrorAlert } from "../forms";
import { Loading, PagePicker, pageLink, ViewHeader } from "../layout";
import { usePagedList } from "../usePagedList";

export type MaintenancePhase = "upcoming" | "active" | "ended";

export function maintenancePhase(maintenance: Pick<Maintenance, "startsAt" | "endsAt">, now: number): MaintenancePhase {
	if (now < maintenance.startsAt) return "upcoming";
	return now < maintenance.endsAt ? "active" : "ended";
}

const PHASE_BADGE: Readonly<Record<MaintenancePhase, string>> = { upcoming: "badge--unknown", active: "badge--maintenance", ended: "badge--stage" };

/** A page's maintenance, latest start first. */
export function MaintenanceView() {
	const { t, f } = useAdminI18n();
	const { pageId, page } = useSelectedPage();
	const list = usePagedList(pageId, (cursor, signal) =>
		api.get<ListPage<Maintenance>>(query("/maintenance", { page: pageId, cursor }), signal),
	);
	const names = new Map(page?.components.map((component) => [component.id, component.name]));
	const now = Date.now();
	return (
		<>
			<ViewHeader
				title={t("admin.maintenance.title")}
				actions={
					<Link className="button button--primary" href={pageLink("/admin/maintenance/new", pageId)}>
						{t("admin.maintenance.new")}
					</Link>
				}
			>
				<div className="filters">
					<PagePicker />
				</div>
				<p className="field__hint">{t("admin.maintenance.intro")}</p>
			</ViewHeader>
			<ErrorAlert error={list.error} onRetry={list.reload} />
			{list.items.length === 0 && list.loading ? (
				<Loading />
			) : list.items.length === 0 && list.error === null ? (
				<p className="empty">{t("admin.maintenance.none")}</p>
			) : (
				<ul className="list">
					{list.items.map((maintenance) => {
						const phase = maintenancePhase(maintenance, now);
						return (
							<li key={maintenance.id} className="list-item">
								<div className="list-item__main">
									<p className="list-item__title">
										<Link href={`/admin/maintenance/${encodeURIComponent(maintenance.id)}`}>{maintenance.title}</Link>
									</p>
									<p className="list-item__meta">
										<span className={`badge ${PHASE_BADGE[phase]}`}>{t(`admin.maintenance.phase.${phase}`)}</span>
									</p>
									<p className="muted">{f.list(maintenance.components.map((id) => names.get(id) ?? id))}</p>
								</div>
								<dl className="list-item__facts">
									<div>
										<dt>{t("admin.maintenance.startsAt")}</dt>
										<dd>{f.dateTime(maintenance.startsAt)}</dd>
									</div>
									<div>
										<dt>{t("admin.maintenance.endsAt")}</dt>
										<dd>{f.dateTime(maintenance.endsAt)}</dd>
									</div>
								</dl>
							</li>
						);
					})}
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
