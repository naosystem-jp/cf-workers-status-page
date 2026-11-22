import { type FormEvent, useState } from "react";
import type { AdminPage, AffectedComponent, Incident, IncidentWithUpdates, PatchIncident } from "../../../shared/admin-api";
import { type IncidentStage, LIMITS } from "../../../shared/vocabulary";
import { useAdminI18n } from "../messages";
import { navigate, useLocation } from "../../lib/router";
import { ImpactBadge, StageBadge } from "../../components/StateLabel";
import { api, enc, isEditConflict } from "../api";
import { ConfirmAction } from "../ConfirmAction";
import { ConflictNotice, useVersionedDraft } from "../conflict";
import { useAdmin } from "../context";
import { ErrorAlert, Field, IssueSummary, issuesAt, issuesOf, Notice, otherIssues, useUnsavedChanges } from "../forms";
import { BackLink, Loading, pageLink, ViewHeader } from "../layout";
import { useLoad } from "../useLoad";
import { affectedComponents, highestImpact, type ImpactDraft, ImpactPicker, impactDraft, StageSelect } from "./incident-form";

/** An incident: its timeline, editing its title and components, posting updates, resolving, deleting. */
export function IncidentDetailView({ id }: { readonly id: string }) {
	const { t } = useAdminI18n();
	const location = useLocation();
	const incident = useLoad(id, (signal) => api.get<IncidentWithUpdates>(`/incidents/${enc(id)}`, signal));
	const [deleteError, setDeleteError] = useState<unknown>(null);
	const { pages } = useAdmin();

	if (incident.data === undefined) {
		return (
			<>
				<BackLink href="/admin/incidents">{t("admin.incidents.title")}</BackLink>
				{incident.error === null ? <Loading /> : <ErrorAlert error={incident.error} onRetry={incident.reload} />}
			</>
		);
	}
	const data = incident.data;
	const page = pages.find((candidate) => candidate.id === data.pageId);

	return (
		<>
			<BackLink href={pageLink("/admin/incidents", data.pageId)}>{t("admin.incidents.title")}</BackLink>
			<ViewHeader
				title={data.title}
				actions={
					<a className="button" href={`/pages/${enc(data.pageId)}/incidents/${enc(data.id)}`} target="_blank" rel="noopener">
						{t("admin.incident.viewPublic")}
					</a>
				}
			>
				<p className="list-item__meta">
					<StageBadge stage={data.stage} />
					<ImpactBadge impact={highestImpact(data.components)} />
					{data.autoCreated && <span className="badge badge--unknown">{t("admin.incidents.auto")}</span>}
				</p>
				<IncidentFacts incident={data} />
			</ViewHeader>
			{location.search.get("created") === "1" && <Notice>{t("admin.incident.created")}</Notice>}
			<div className="columns">
				<div>
					<UpdateForm incident={data} page={page} onPosted={(updated) => incident.setData(updated)} onReload={incident.reload} />
					<section className="panel" aria-labelledby="timeline-heading">
						<h2 id="timeline-heading" className="panel__title">
							{t("admin.incident.timeline")}
						</h2>
						<Timeline incident={data} />
					</section>
				</div>
				<div>
					<EditForm
						key={data.id}
						incident={data}
						page={page}
						onSaved={(saved) => incident.setData({ ...saved, updates: data.updates })}
						onReload={incident.reload}
					/>
					<section className="panel panel--danger" aria-labelledby="delete-heading">
						<h2 id="delete-heading" className="panel__title">
							{t("admin.incident.deleteTitle")}
						</h2>
						<p className="field__hint">{t("admin.incident.deleteHint")}</p>
						<ErrorAlert error={deleteError} />
						<ConfirmAction
							label={t("admin.action.delete")}
							question={t("admin.incident.deleteQuestion", { title: data.title })}
							confirmLabel={t("admin.action.deleteConfirm")}
							onConfirm={async () => {
								try {
									await api.delete(`/incidents/${enc(data.id)}`);
									navigate(pageLink("/admin/incidents", data.pageId), { force: true });
								} catch (error) {
									setDeleteError(error);
								}
							}}
						/>
					</section>
				</div>
			</div>
		</>
	);
}

function IncidentFacts({ incident }: { readonly incident: Incident }) {
	const { t, f } = useAdminI18n();
	return (
		<dl className="facts">
			<div>
				<dt>{t("admin.page.label")}</dt>
				<dd>{incident.pageId}</dd>
			</div>
			<div>
				<dt>{t("admin.incidents.started")}</dt>
				<dd>{f.dateTimeWithZone(incident.startedAt)}</dd>
			</div>
			<div>
				<dt>{t("admin.incident.createdBy")}</dt>
				<dd>
					{t("admin.common.byAt", {
						who: incident.createdBy ?? t("admin.common.automation"),
						time: f.dateTimeWithZone(incident.createdAt),
					})}
				</dd>
			</div>
			{incident.resolvedAt !== null && (
				<div>
					<dt>{t("admin.incidents.resolved")}</dt>
					<dd>
						{f.dateTimeWithZone(incident.resolvedAt)} ({f.duration(incident.resolvedAt - incident.startedAt)})
					</dd>
				</div>
			)}
		</dl>
	);
}

function Timeline({ incident }: { readonly incident: IncidentWithUpdates }) {
	const { t, f } = useAdminI18n();
	return (
		<ol className="timeline">
			{[...incident.updates].reverse().map((update) => (
				<li key={update.id} className="timeline__item">
					<p className="timeline__meta">
						<StageBadge stage={update.stage} />
						<span>
							{t("admin.common.byAt", {
								who: update.author ?? t("admin.common.automation"),
								time: f.dateTimeWithZone(update.createdAt),
							})}
						</span>
					</p>
					<p className="timeline__body">{update.body}</p>
				</li>
			))}
		</ol>
	);
}

interface EditDraft {
	readonly title: string;
	readonly components: ImpactDraft;
}

/** The incident's title and affected components: a versioned edit (409 on concurrent edits). */
interface EditFormProps {
	readonly incident: Incident;
	readonly page: AdminPage | undefined;
	readonly onSaved: (incident: Incident) => void;
	/** Loads the incident again (after a conflict: someone else's version, with their updates). */
	readonly onReload: () => void;
}

function EditForm({ incident, page, onSaved, onReload }: EditFormProps) {
	const { t, f } = useAdminI18n();
	const toDraft = (entity: Incident): EditDraft => ({ title: entity.title, components: impactDraft(page, entity.components) });
	const edit = useVersionedDraft(incident, toDraft);
	const [error, setError] = useState<unknown>(null);
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState<readonly AffectedComponent[]>([]);
	useUnsavedChanges(edit.changed.length > 0);
	// A timeline update with components bumps the version: follow it, keeping edits.
	if (incident.version > edit.base.version && edit.conflict === null) edit.refresh(incident);
	const known = new Set(page?.components.map((component) => component.id));
	const unknown = incident.components.filter((component) => !known.has(component.id)).map((component) => component.id);
	const issues = issuesOf(error, t);

	async function submit(event: FormEvent) {
		event.preventDefault();
		const changes: PatchIncident = { version: edit.base.version };
		if (edit.changed.includes("title")) changes.title = edit.draft.title;
		const components = affectedComponents(page, edit.draft.components);
		if (edit.changed.includes("components")) changes.components = components;
		if (changes.title === undefined && changes.components === undefined) return;
		setSent(components);
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			const result = await api.patch<Incident>(`/incidents/${enc(incident.id)}`, changes);
			edit.saved(result);
			onSaved(result);
			setSaved(true);
		} catch (caught) {
			if (!edit.handleError(caught)) setError(caught);
		} finally {
			setBusy(false);
		}
	}

	const conflict = edit.conflict;
	return (
		<section className="panel" aria-labelledby="edit-heading">
			<h2 id="edit-heading" className="panel__title">
				{t("admin.incident.editTitle")}
			</h2>
			{conflict !== null && (
				<ConflictNotice
					conflict={conflict}
					label={(field) => (field === "title" ? t("admin.incident.title") : t("admin.incident.components"))}
					value={(field) => {
						const current = conflict.current;
						if (field === "title") return current.title;
						return current.components.length === 0
							? t("admin.incident.noneAffected")
							: f.list(current.components.map((component) => `${page?.components.find((c) => c.id === component.id)?.name ?? component.id} (${t(`impact.${component.impact}`)})`));
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
				<IssueSummary issues={otherIssues(issues, [["title"], ["components"]])} />
				{saved && edit.changed.length === 0 && <Notice>{t("admin.form.saved")}</Notice>}
				<Field label={t("admin.incident.title")} errors={issuesAt(issues, ["title"])}>
					{({ id, describedBy, invalid }) => (
						<input
							id={id}
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							required
							maxLength={LIMITS.title}
							value={edit.draft.title}
							onChange={(event) => {
								const title = event.target.value;
								edit.setDraft((draft) => ({ ...draft, title }));
							}}
						/>
					)}
				</Field>
				<ImpactPicker
					page={page}
					value={edit.draft.components}
					onChange={(components) => edit.setDraft((draft) => ({ ...draft, components }))}
					issues={issues}
					sent={sent}
					unknown={unknown}
				/>
				<div className="actions">
					<button type="submit" className="button button--primary" disabled={busy || edit.changed.length === 0 || conflict !== null}>
						{t("admin.form.save")}
					</button>
					{edit.changed.length > 0 && <span className="muted">{t("admin.form.unsaved")}</span>}
				</div>
			</form>
		</section>
	);
}

/** Posts a timeline update (never conflicts); with stage "resolved", resolves the incident. */
export function UpdateForm({
	incident,
	page,
	onPosted,
	onReload,
}: {
	readonly incident: IncidentWithUpdates;
	readonly page: AdminPage | undefined;
	readonly onPosted: (incident: IncidentWithUpdates) => void;
	/** Loads the incident again (it changed meanwhile). */
	readonly onReload: () => void;
}) {
	const { t } = useAdminI18n();
	const [stage, setStage] = useState<IncidentStage>(incident.stage === "resolved" ? "monitoring" : incident.stage);
	const [body, setBody] = useState("");
	const [withComponents, setWithComponents] = useState(false);
	// The components to post, and the incident's version they were filled from: posted with
	// them, so that the API refuses them (409) if the incident changed meanwhile.
	const [components, setComponents] = useState<{ readonly draft: ImpactDraft; readonly version: number }>(() => ({
		draft: impactDraft(page, incident.components),
		version: incident.version,
	}));
	const [sent, setSent] = useState<readonly AffectedComponent[]>([]);
	const [error, setError] = useState<unknown>(null);
	const [changedMeanwhile, setChangedMeanwhile] = useState(false);
	const [busy, setBusy] = useState(false);
	const [posted, setPosted] = useState(false);
	const issues = issuesOf(error, t);
	const resolving = stage === "resolved" && incident.resolvedAt === null;
	useUnsavedChanges(!busy && (body.trim() !== "" || withComponents));

	/** Fills the components from the incident as it is now. */
	const refill = (from: Incident) => setComponents({ draft: impactDraft(page, from.components), version: from.version });

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		setPosted(false);
		setChangedMeanwhile(false);
		try {
			let updated: IncidentWithUpdates;
			if (resolving && !withComponents) {
				updated = await api.post<IncidentWithUpdates>(`/incidents/${enc(incident.id)}/resolve`, { body });
			} else {
				const affected = affectedComponents(page, components.draft);
				setSent(affected);
				updated = await api.post<IncidentWithUpdates>(`/incidents/${enc(incident.id)}/updates`, {
					stage,
					body,
					...(withComponents ? { components: affected, version: components.version } : {}),
				});
			}
			onPosted(updated);
			setBody("");
			setPosted(true);
			setWithComponents(false);
			refill(updated);
			if (updated.stage === "resolved") setStage("monitoring");
		} catch (caught) {
			if (isEditConflict<Incident>(caught)) {
				// The components changed since they were filled: show them as they are now.
				refill(caught.body.current);
				setChangedMeanwhile(true);
				onReload();
			} else {
				setError(caught);
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="panel" aria-labelledby="update-heading">
			<h2 id="update-heading" className="panel__title">
				{t("admin.incident.postTitle")}
			</h2>
			{incident.resolvedAt !== null && <p className="field__hint">{t("admin.incident.reopenHint")}</p>}
			<form className="form" onSubmit={(event) => void submit(event)}>
				<ErrorAlert error={error} />
				<IssueSummary issues={otherIssues(issues, [["stage"], ["body"], ["components"]])} />
				{posted && <Notice>{t("admin.incident.posted")}</Notice>}
				<StageSelect value={stage} onChange={setStage} errors={issuesAt(issues, ["stage"])} />
				<Field label={t("admin.incident.message")} hint={t("admin.incident.bodyHint")} errors={issuesAt(issues, ["body"])}>
					{({ id, describedBy, invalid }) => (
						<textarea
							id={id}
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							required
							rows={4}
							maxLength={LIMITS.body}
							value={body}
							onChange={(event) => setBody(event.target.value)}
						/>
					)}
				</Field>
				<label className="check">
					<input
						type="checkbox"
						checked={withComponents}
						onChange={(event) => {
							// Start from the components as they are now, never from an older version.
							if (event.target.checked) refill(incident);
							setWithComponents(event.target.checked);
						}}
					/>
					{t("admin.incident.alsoComponents")}
				</label>
				{changedMeanwhile && (
					<p className="alert alert--warning" role="alert">
						{t("admin.incident.componentsChanged")}
					</p>
				)}
				{withComponents && (
					<ImpactPicker
						page={page}
						value={components.draft}
						onChange={(draft) => setComponents((previous) => ({ ...previous, draft }))}
						issues={issues}
						sent={sent}
					/>
				)}
				<div className="actions">
					<button type="submit" className="button button--primary" disabled={busy}>
						{resolving ? t("admin.incident.resolve") : t("admin.incident.post")}
					</button>
				</div>
			</form>
		</section>
	);
}
