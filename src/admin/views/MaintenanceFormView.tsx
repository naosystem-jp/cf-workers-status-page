import { type FormEvent, useState } from "react";
import type { AdminPage, ApiIssue, CreateMaintenance, Maintenance, PatchMaintenance } from "../../../shared/admin-api";
import { LIMITS } from "../../../shared/vocabulary";
import { useAdminI18n } from "../messages";
import { navigate } from "../../lib/router";
import { api, enc } from "../api";
import { ConfirmAction } from "../ConfirmAction";
import { ConflictNotice, sameValue, useVersionedDraft } from "../conflict";
import { useAdmin, useSelectedPage } from "../context";
import { fromLocalInput, localTimeExists, toLocalInput } from "../datetime";
import { ErrorAlert, Field, Fieldset, IssueSummary, issuesAt, issuesOf, Notice, otherIssues, useUnsavedChanges } from "../forms";
import { BackLink, Loading, pageLink, ViewHeader } from "../layout";
import { useLoad } from "../useLoad";

/** What the form holds: times as the admin's local `datetime-local` values. */
interface MaintenanceDraft {
	readonly title: string;
	readonly body: string;
	readonly startsAt: string;
	readonly endsAt: string;
	readonly components: readonly string[];
}

const FIELDS = [["title"], ["body"], ["startsAt"], ["endsAt"], ["components"], ["pageId"]] as const;

function toDraft(maintenance: Maintenance): MaintenanceDraft {
	return {
		title: maintenance.title,
		body: maintenance.body,
		startsAt: toLocalInput(maintenance.startsAt),
		endsAt: toLocalInput(maintenance.endsAt),
		components: maintenance.components,
	};
}

/**
 * A local time as epoch milliseconds. One that cannot be read (the input's own validation
 * normally prevents it) is sent as `-1`, which the API rejects next to the field.
 */
function timeOf(value: string): number {
	return fromLocalInput(value) ?? -1;
}

function MaintenanceFields({
	page,
	draft,
	onChange,
	issues,
}: {
	readonly page: AdminPage | undefined;
	readonly draft: MaintenanceDraft;
	readonly onChange: (update: (draft: MaintenanceDraft) => MaintenanceDraft) => void;
	readonly issues: readonly ApiIssue[];
}) {
	const { t, f } = useAdminI18n();
	// Each time's own offset: the start and the end can fall on either side of a daylight saving change.
	const zone = (value: string) => t("admin.time.zone", { timeZone: f.timeZone, offset: f.offset(fromLocalInput(value) ?? Date.now()) });
	const gap = (value: string) => (localTimeExists(value) ? [] : [t("admin.issue.localTimeGap")]);
	const set = <K extends keyof MaintenanceDraft>(key: K, value: MaintenanceDraft[K]) => onChange((draft) => ({ ...draft, [key]: value }));
	return (
		<>
			<Field label={t("admin.maintenance.fieldTitle")} errors={issuesAt(issues, ["title"])}>
				{({ id, describedBy, invalid }) => (
					<input
						id={id}
						aria-describedby={describedBy}
						aria-invalid={invalid || undefined}
						required
						maxLength={LIMITS.title}
						value={draft.title}
						onChange={(event) => set("title", event.target.value)}
					/>
				)}
			</Field>
			<div className="field-row">
				<Field label={t("admin.maintenance.startsAt")} hint={zone(draft.startsAt)} errors={[...gap(draft.startsAt), ...issuesAt(issues, ["startsAt"])]}>
					{({ id, describedBy, invalid }) => (
						<input
							id={id}
							type="datetime-local"
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							required
							value={draft.startsAt}
							onChange={(event) => set("startsAt", event.target.value)}
						/>
					)}
				</Field>
				<Field label={t("admin.maintenance.endsAt")} hint={zone(draft.endsAt)} errors={[...gap(draft.endsAt), ...issuesAt(issues, ["endsAt"])]}>
					{({ id, describedBy, invalid }) => (
						<input
							id={id}
							type="datetime-local"
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							required
							min={draft.startsAt || undefined}
							value={draft.endsAt}
							onChange={(event) => set("endsAt", event.target.value)}
						/>
					)}
				</Field>
			</div>
			<Fieldset legend={t("admin.maintenance.components")} hint={t("admin.maintenance.componentsHint")} errors={issuesAt(issues, ["components"])}>
				<div className="checks">
					{page?.components.map((component) => (
						<label key={component.id} className="check">
							<input
								type="checkbox"
								checked={draft.components.includes(component.id)}
								onChange={(event) =>
									set(
										"components",
										event.target.checked
											? page.components.map((c) => c.id).filter((id) => id === component.id || draft.components.includes(id))
											: draft.components.filter((id) => id !== component.id),
									)
								}
							/>
							{component.name}
						</label>
					))}
				</div>
			</Fieldset>
			<Field label={t("admin.maintenance.body")} hint={t("admin.maintenance.bodyHint")} errors={issuesAt(issues, ["body"])}>
				{({ id, describedBy, invalid }) => (
					<textarea
						id={id}
						aria-describedby={describedBy}
						aria-invalid={invalid || undefined}
						rows={4}
						maxLength={LIMITS.body}
						value={draft.body}
						onChange={(event) => set("body", event.target.value)}
					/>
				)}
			</Field>
		</>
	);
}

export function MaintenanceCreateView() {
	const { t } = useAdminI18n();
	const { pageId, page } = useSelectedPage();
	const [initial] = useState<MaintenanceDraft>(() => {
		// The next full hour, for an hour: a starting point to adjust.
		const start = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
		return { title: "", body: "", startsAt: toLocalInput(start), endsAt: toLocalInput(start + 3_600_000), components: [] };
	});
	const [draft, setDraft] = useState<MaintenanceDraft>(initial);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const issues = issuesOf(error, t);
	useUnsavedChanges(!busy && !sameValue(draft, initial));

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!localTimeExists(draft.startsAt) || !localTimeExists(draft.endsAt)) return;
		const input: CreateMaintenance = {
			pageId,
			title: draft.title,
			body: draft.body,
			startsAt: timeOf(draft.startsAt),
			endsAt: timeOf(draft.endsAt),
			components: [...draft.components],
		};
		setBusy(true);
		setError(null);
		try {
			const created = await api.post<Maintenance>("/maintenance", input);
			navigate(`/admin/maintenance/${enc(created.id)}?created=1`, { force: true });
		} catch (caught) {
			setError(caught);
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<BackLink href={pageLink("/admin/maintenance", pageId)}>{t("admin.maintenance.title")}</BackLink>
			<ViewHeader title={t("admin.maintenance.new")}>
				<p className="field__hint">{t("admin.maintenance.forPage", { page: pageId })}</p>
			</ViewHeader>
			<form className="form" onSubmit={(event) => void submit(event)}>
				<ErrorAlert error={error} />
				<IssueSummary issues={otherIssues(issues, FIELDS)} />
				<MaintenanceFields page={page} draft={draft} onChange={(update) => setDraft(update)} issues={issues} />
				<div className="actions">
					<button type="submit" className="button button--primary" disabled={busy}>
						{t("admin.maintenance.create")}
					</button>
				</div>
			</form>
		</>
	);
}

export function MaintenanceEditView({ id }: { readonly id: string }) {
	const { t } = useAdminI18n();
	const maintenance = useLoad(id, (signal) => api.get<Maintenance>(`/maintenance/${enc(id)}`, signal));
	if (maintenance.data === undefined) {
		return (
			<>
				<BackLink href="/admin/maintenance">{t("admin.maintenance.title")}</BackLink>
				{maintenance.error === null ? <Loading /> : <ErrorAlert error={maintenance.error} onRetry={maintenance.reload} />}
			</>
		);
	}
	return <MaintenanceEditor key={maintenance.data.id} maintenance={maintenance.data} onReload={maintenance.reload} />;
}

function MaintenanceEditor({ maintenance, onReload }: { readonly maintenance: Maintenance; readonly onReload: () => void }) {
	const { t, f } = useAdminI18n();
	const { pages } = useAdmin();
	const page = pages.find((candidate) => candidate.id === maintenance.pageId);
	const edit = useVersionedDraft(maintenance, toDraft);
	if (maintenance.version > edit.base.version && edit.conflict === null) edit.refresh(maintenance);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(() => new URLSearchParams(window.location.search).get("created") === "1");
	const issues = issuesOf(error, t);
	useUnsavedChanges(edit.changed.length > 0);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!localTimeExists(edit.draft.startsAt) || !localTimeExists(edit.draft.endsAt)) return;
		const changes: { -readonly [K in keyof PatchMaintenance]: PatchMaintenance[K] } = { version: edit.base.version };
		for (const key of edit.changed) {
			if (key === "startsAt" || key === "endsAt") changes[key] = timeOf(edit.draft[key]);
			else if (key === "components") changes.components = [...edit.draft.components];
			else changes[key] = edit.draft[key];
		}
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			edit.saved(await api.patch<Maintenance>(`/maintenance/${enc(maintenance.id)}`, changes));
			setSaved(true);
		} catch (caught) {
			if (!edit.handleError(caught)) setError(caught);
		} finally {
			setBusy(false);
		}
	}

	const conflict = edit.conflict;
	const labels: Record<string, string> = {
		title: t("admin.maintenance.fieldTitle"),
		body: t("admin.maintenance.body"),
		startsAt: t("admin.maintenance.startsAt"),
		endsAt: t("admin.maintenance.endsAt"),
		components: t("admin.maintenance.components"),
	};
	return (
		<>
			<BackLink href={pageLink("/admin/maintenance", maintenance.pageId)}>{t("admin.maintenance.title")}</BackLink>
			<ViewHeader title={edit.base.title}>
				<p className="field__hint">
					{t("admin.maintenance.forPage", { page: maintenance.pageId })}{" "}
					{t("admin.common.lastChange", {
						who: edit.base.updatedBy ?? t("admin.common.automation"),
						time: f.dateTimeWithZone(edit.base.updatedAt),
					})}
				</p>
			</ViewHeader>
			{conflict !== null && (
				<ConflictNotice
					conflict={conflict}
					label={(field) => labels[field] ?? field}
					value={(field) => {
						const current = conflict.current;
						switch (field) {
							case "startsAt":
							case "endsAt":
								return f.dateTimeWithZone(current[field]);
							case "components":
								return f.list(current.components.map((id) => page?.components.find((c) => c.id === id)?.name ?? id));
							case "title":
								return current.title;
							default:
								return current.body;
						}
					}}
					onTakeCurrent={() => {
						edit.takeCurrent();
						onReload();
					}}
					onReapply={() => {
						edit.reapply();
						onReload();
					}}
				/>
			)}
			<form className="form" onSubmit={(event) => void submit(event)}>
				<ErrorAlert error={error} />
				<IssueSummary issues={otherIssues(issues, FIELDS)} />
				{saved && edit.changed.length === 0 && <Notice>{t("admin.form.saved")}</Notice>}
				<MaintenanceFields page={page} draft={edit.draft} onChange={edit.setDraft} issues={issues} />
				<div className="actions">
					<button type="submit" className="button button--primary" disabled={busy || edit.changed.length === 0 || conflict !== null}>
						{t("admin.form.save")}
					</button>
					{edit.changed.length > 0 && <span className="muted">{t("admin.form.unsaved")}</span>}
				</div>
			</form>
			<section className="panel panel--danger" aria-labelledby="delete-heading">
				<h2 id="delete-heading" className="panel__title">
					{t("admin.maintenance.deleteTitle")}
				</h2>
				<DeleteMaintenance maintenance={maintenance} />
			</section>
		</>
	);
}

function DeleteMaintenance({ maintenance }: { readonly maintenance: Maintenance }) {
	const { t } = useAdminI18n();
	const [error, setError] = useState<unknown>(null);
	return (
		<>
			<ErrorAlert error={error} />
			<ConfirmAction
				label={t("admin.action.delete")}
				question={t("admin.maintenance.deleteQuestion", { title: maintenance.title })}
				confirmLabel={t("admin.action.deleteConfirm")}
				onConfirm={async () => {
					try {
						await api.delete(`/maintenance/${enc(maintenance.id)}`);
						navigate(pageLink("/admin/maintenance", maintenance.pageId), { force: true });
					} catch (caught) {
						setError(caught);
					}
				}}
			/>
		</>
	);
}
