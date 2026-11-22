import type { DeliveryStatus, ListPage, NotificationDelivery } from "../../../shared/admin-api";
import { useAdminI18n } from "../messages";
import { Link, navigate, useLocation, withQuery } from "../../lib/router";
import { api, enc, query } from "../api";
import { ErrorAlert } from "../forms";
import { Loading, ViewHeader } from "../layout";
import { usePagedList } from "../usePagedList";

const STATUSES: readonly DeliveryStatus[] = ["failed", "retrying", "sending", "sent"];
const STATUS_BADGE: Readonly<Record<DeliveryStatus, string>> = {
	failed: "badge--down",
	retrying: "badge--degraded",
	sending: "badge--unknown",
	sent: "badge--up",
};

/** Notifications that could not be delivered (given up, or moved to the dead letter queue), and others by status. */
export function DeliveriesView() {
	const { t, f } = useAdminI18n();
	const location = useLocation();
	const status = STATUSES.find((value) => value === location.search.get("status")) ?? "failed";
	const list = usePagedList(status, (cursor, signal) =>
		api.get<ListPage<NotificationDelivery>>(query("/notifications/deliveries", { status, cursor }), signal),
	);
	return (
		<>
			<ViewHeader
				title={t("admin.deliveries.title")}
				actions={
					<button type="button" className="button" onClick={list.reload} disabled={list.loading}>
						{t("admin.action.refresh")}
					</button>
				}
			>
				<div className="filters">
					<label className="inline-field">
						<span>{t("admin.deliveries.status")}</span>
						<select
							value={status}
							onChange={(event) => navigate(withQuery(location.pathname, { status: event.target.value }), { replace: true, keepScroll: true })}
						>
							{STATUSES.map((value) => (
								<option key={value} value={value}>
									{t(`admin.deliveries.statusName.${value}`)}
								</option>
							))}
						</select>
					</label>
				</div>
				<p className="field__hint">{t("admin.deliveries.intro")}</p>
			</ViewHeader>
			<ErrorAlert error={list.error} onRetry={list.reload} />
			{list.items.length === 0 && list.loading ? (
				<Loading />
			) : list.items.length === 0 && list.error === null ? (
				<p className="empty">{t("admin.deliveries.none")}</p>
			) : (
				<ul className="list">
					{list.items.map((delivery) => (
						<li key={`${delivery.notificationId}:${delivery.targetId}`} className="list-item">
							<div className="list-item__main">
								<p className="list-item__title">
									{delivery.targetName === null ? (
										<span>{t("admin.deliveries.deletedTarget")}</span>
									) : (
										<Link href={`/admin/notifications/${enc(delivery.targetId)}`}>{delivery.targetName}</Link>
									)}
								</p>
								<p className="list-item__meta">
									<span className={`badge ${STATUS_BADGE[delivery.status]}`}>{t(`admin.deliveries.statusName.${delivery.status}`)}</span>
									<span className="badge badge--stage">{t(`admin.event.${delivery.event}`)}</span>
									{delivery.monitorId !== null && <code className="muted">{delivery.monitorId}</code>}
								</p>
								{delivery.lastError !== null && <p className="mono error-text">{delivery.lastError}</p>}
							</div>
							<dl className="list-item__facts">
								<div>
									<dt>{t("admin.deliveries.occurred")}</dt>
									<dd>{f.dateTime(delivery.occurredAt)}</dd>
								</div>
								<div>
									<dt>{t("admin.deliveries.updated")}</dt>
									<dd>{f.dateTime(delivery.updatedAt)}</dd>
								</div>
								<div>
									<dt>{t("admin.deliveries.attempts")}</dt>
									<dd>{delivery.attempts}</dd>
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
