import { useState } from "react";
import type { ListPage, NotificationTarget, NotifierKindsResponse, TestNotificationResult } from "../../../shared/admin-api";
import { useAdminI18n } from "../messages";
import { Link } from "../../lib/router";
import { api, enc, isEditConflict } from "../api";
import { ErrorAlert, errorText } from "../forms";
import { Loading, ViewHeader } from "../layout";
import { kindName } from "./TargetFormView";
import { useLoad } from "../useLoad";

/** Notification targets: where notifications go, for which monitors and events. */
export function TargetsView() {
	const { t, locale } = useAdminI18n();
	const targets = useLoad("targets", (signal) => api.get<ListPage<NotificationTarget>>("/notifications/targets", signal));
	const kinds = useLoad("kinds", (signal) => api.get<NotifierKindsResponse>("/notifications/kinds", signal));
	const nameOf = (type: string) => {
		const kind = kinds.data?.kinds.find((candidate) => candidate.type === type);
		return kind === undefined ? type : kindName(kind, locale);
	};
	return (
		<>
			<ViewHeader
				title={t("admin.targets.title")}
				actions={
					<Link className="button button--primary" href="/admin/notifications/new">
						{t("admin.targets.new")}
					</Link>
				}
			>
				<p className="field__hint">{t("admin.targets.intro")}</p>
			</ViewHeader>
			{kinds.data !== undefined && !kinds.data.encryption.configured && (
				<div className="alert alert--warning" role="status">
					<p>{t("admin.targets.noKey", { error: kinds.data.encryption.error ?? "" })}</p>
				</div>
			)}
			<ErrorAlert
				error={targets.error ?? kinds.error}
				onRetry={() => {
					targets.reload();
					kinds.reload();
				}}
			/>
			{targets.data === undefined ? (
				targets.error === null && <Loading />
			) : targets.data.items.length === 0 ? (
				<p className="empty">{t("admin.targets.none")}</p>
			) : (
				<ul className="list">
					{targets.data.items.map((target) => (
						<TargetItem
							key={target.id}
							target={target}
							kindName={nameOf(target.kind)}
							onChanged={(changed) =>
								targets.setData({
									items: (targets.data?.items ?? []).map((item) => (item.id === changed.id ? changed : item)),
									nextCursor: null,
								})
							}
						/>
					))}
				</ul>
			)}
		</>
	);
}

function TargetItem({
	target,
	kindName,
	onChanged,
}: {
	readonly target: NotificationTarget;
	readonly kindName: string;
	readonly onChanged: (target: NotificationTarget) => void;
}) {
	const { t, f } = useAdminI18n();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

	async function toggle() {
		setBusy(true);
		setMessage(null);
		try {
			onChanged(await api.patch<NotificationTarget>(`/notifications/targets/${enc(target.id)}`, { version: target.version, enabled: !target.enabled }));
		} catch (error) {
			if (isEditConflict<NotificationTarget>(error)) {
				// Someone else changed it: show theirs, and let the admin decide again.
				onChanged(error.body.current);
				setMessage({ ok: false, text: t("admin.targets.toggleConflict", { who: error.body.current.updatedBy ?? "—" }) });
			} else {
				setMessage({ ok: false, text: errorText(error, t) });
			}
		} finally {
			setBusy(false);
		}
	}

	async function test() {
		setBusy(true);
		setMessage(null);
		try {
			const result = await api.post<TestNotificationResult>(`/notifications/targets/${enc(target.id)}/test`, {});
			setMessage(result.ok ? { ok: true, text: t("admin.targets.testOk") } : { ok: false, text: t("admin.targets.testFailed", { error: result.error ?? "" }) });
		} catch (error) {
			setMessage({ ok: false, text: errorText(error, t) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<li className="list-item">
			<div className="list-item__main">
				<p className="list-item__title">
					<Link href={`/admin/notifications/${enc(target.id)}`}>{target.name}</Link>
				</p>
				<p className="list-item__meta">
					<span className="badge badge--stage">{kindName}</span>
					{target.admin && <span className="badge badge--maintenance">{t("admin.targets.adminBadge")}</span>}
					<span className={`badge ${target.enabled ? "badge--up" : "badge--unknown"}`}>
						{target.enabled ? t("admin.targets.enabled") : t("admin.targets.disabled")}
					</span>
				</p>
				<p className="muted">
					{t("admin.targets.events", { events: f.list(target.events.map((event) => t(`admin.event.${event}`))) })}
				</p>
				<p className="muted">
					{target.allMonitors
						? t("admin.targets.allMonitors")
						: t("admin.targets.someMonitors", { monitors: target.monitors.length, components: target.components.length })}
				</p>
				{message !== null && (
					<p role="status" className={message.ok ? "success-text" : "error-text"}>
						{message.text}
					</p>
				)}
			</div>
			<div className="list-item__actions">
				<button type="button" className="button button--small" onClick={() => void test()} disabled={busy}>
					{t("admin.targets.test")}
				</button>
				<button type="button" className="button button--small" onClick={() => void toggle()} disabled={busy}>
					{target.enabled ? t("admin.targets.disable") : t("admin.targets.enable")}
				</button>
			</div>
		</li>
	);
}
