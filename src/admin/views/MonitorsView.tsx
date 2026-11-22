import { displayState } from "@naosystem/cf-workers-status-page-core";
import { useState } from "react";
import type { AdminMonitor, AdminMonitorsResponse } from "../../../shared/admin-api";
import { type AdminKey, type AdminTranslate, useAdminI18n } from "../messages";
import { StateLabel } from "../../components/StateLabel";
import { AdminApiError, api, enc } from "../api";
import { ConfirmAction } from "../ConfirmAction";
import { ErrorAlert, errorText, Notice } from "../forms";
import { Loading, ViewHeader } from "../layout";
import { useLoad } from "../useLoad";

/**
 * Monitors are defined in status.config.ts: this lists them with their current state, and
 * the monitors that left the configuration but whose data is kept, which can be deleted.
 */
export function MonitorsView() {
	const { t } = useAdminI18n();
	const monitors = useLoad("monitors", (signal) => api.get<AdminMonitorsResponse>("/monitors", signal));
	const [purged, setPurged] = useState<string | null>(null);
	const list = monitors.data?.monitors ?? [];
	const configured = list.filter((monitor) => monitor.configured);
	const removed = list.filter((monitor) => !monitor.configured);
	return (
		<>
			<ViewHeader
				title={t("admin.monitors.title")}
				actions={
					<button type="button" className="button" onClick={monitors.reload} disabled={monitors.loading}>
						{t("admin.action.refresh")}
					</button>
				}
			>
				<p className="field__hint">{t("admin.monitors.intro")}</p>
			</ViewHeader>
			<ErrorAlert error={monitors.error} onRetry={monitors.reload} />
			{purged !== null && <Notice>{t("admin.monitors.purged", { id: purged })}</Notice>}
			{monitors.data === undefined ? (
				monitors.error === null && <Loading />
			) : (
				<>
					{configured.length === 0 ? (
						<p className="empty">{t("admin.monitors.none")}</p>
					) : (
						<ul className="list">
							{configured.map((monitor) => (
								<MonitorItem key={monitor.id} monitor={monitor} />
							))}
						</ul>
					)}
					<section className="section-block" aria-labelledby="removed-heading">
						<h2 id="removed-heading" className="panel__title">
							{t("admin.monitors.removedTitle")}
						</h2>
						<p className="field__hint">{t("admin.monitors.removedIntro")}</p>
						{removed.length === 0 ? (
							<p className="empty">{t("admin.monitors.removedNone")}</p>
						) : (
							<ul className="list">
								{removed.map((monitor) => (
									<MonitorItem
										key={monitor.id}
										monitor={monitor}
										onPurged={() => {
											setPurged(monitor.id);
											monitors.reload();
										}}
									/>
								))}
							</ul>
						)}
					</section>
				</>
			)}
		</>
	);
}

const REFUSALS: Readonly<Record<string, AdminKey>> = {
	configured: "admin.monitors.purgeRefused.configured",
	running: "admin.monitors.purgeRefused.running",
	deploying: "admin.monitors.purgeRefused.deploying",
};

/** Why a purge failed: a refusal by its reason code (else as the API said it), or the error. */
function purgeError(error: unknown, t: AdminTranslate): string {
	if (!(error instanceof AdminApiError) || error.code !== "purge_refused") return errorText(error, t);
	const reason = (error.body as { reason?: unknown } | null)?.reason;
	const key = typeof reason === "string" ? REFUSALS[reason] : undefined;
	return key === undefined ? t("admin.monitors.purgeRefused", { reason: error.message }) : t(key);
}

function MonitorItem({ monitor, onPurged }: { readonly monitor: AdminMonitor; readonly onPurged?: () => void }) {
	const { t, f } = useAdminI18n();
	const [error, setError] = useState<unknown>(null);
	const snapshot = monitor.snapshot;
	const now = Date.now();
	const shown =
		snapshot === null ? null : displayState(snapshot, monitor.config?.timeoutMs ?? 0, now);
	const check = snapshot?.lastCheck ?? null;
	return (
		<li className="list-item">
			<div className="list-item__main">
				<p className="list-item__title">
					{monitor.config?.name ?? monitor.id} <code className="muted">{monitor.id}</code>
				</p>
				<p className="list-item__meta">
					{shown === null ? (
						<span className="muted">{t("admin.monitors.noSnapshot")}</span>
					) : (
						<>
							<StateLabel state={shown.state} />
							{shown.unknownReason !== null && <span className="muted">{t(`admin.monitors.unknown.${shown.unknownReason}`)}</span>}
							{snapshot?.current !== null && snapshot?.current !== undefined && shown.unknownReason === null && (
								<span className="muted">{t("admin.monitors.since", { time: f.dateTime(snapshot.current.since) })}</span>
							)}
						</>
					)}
				</p>
				{check !== null && (
					<p className="muted">
						{t("admin.monitors.lastCheck", {
							time: f.relative(check.at, now),
							result: check.state === null ? t("admin.monitors.noResult") : t(`public.state.${check.state}`),
						})}
						{check.latencyMs !== null && ` · ${t("admin.monitors.latency", { ms: check.latencyMs })}`}
						{check.message !== null && check.message !== "" && <> · <span className="mono">{check.message}</span></>}
					</p>
				)}
				{monitor.snapshotError !== null && <p className="error-text">{t("admin.monitors.snapshotError", { error: monitor.snapshotError })}</p>}
				{monitor.components.length > 0 && (
					<p className="muted">
						{t("admin.monitors.components", { components: f.list(monitor.components.map((ref) => `${ref.pageId}/${ref.componentId}`)) })}
					</p>
				)}
			</div>
			<dl className="list-item__facts">
				{monitor.config !== null && (
					<>
						<div>
							<dt>{t("admin.monitors.type")}</dt>
							<dd>{monitor.config.type}</dd>
						</div>
						<div>
							<dt>{t("admin.monitors.interval")}</dt>
							<dd>{f.duration(monitor.config.intervalMs)}</dd>
						</div>
						<div>
							<dt>{t("admin.monitors.location")}</dt>
							<dd>{monitor.config.location ?? monitor.registry?.location ?? t("admin.monitors.locationAuto")}</dd>
						</div>
					</>
				)}
				{monitor.registry?.status === "removed" && (
					<div>
						<dt>{t("admin.monitors.removedAt")}</dt>
						<dd>{f.dateTime(monitor.registry.statusChangedAt)}</dd>
					</div>
				)}
			</dl>
			{onPurged !== undefined && (
				<div className="list-item__actions">
					{error !== null && (
						<p role="alert" className="error-text">
							{purgeError(error, t)}
						</p>
					)}
					<ConfirmAction
						label={t("admin.monitors.purge")}
						question={t("admin.monitors.purgeQuestion", { id: monitor.id })}
						confirmLabel={t("admin.monitors.purgeConfirm")}
						onConfirm={async () => {
							setError(null);
							try {
								await api.delete(`/monitors/${enc(monitor.id)}`);
								onPurged();
							} catch (caught) {
								setError(caught);
							}
						}}
					/>
				</div>
			)}
		</li>
	);
}
