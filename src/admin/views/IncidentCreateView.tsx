import { type FormEvent, useState } from "react";
import type { AffectedComponent, ApiIssue, CreateIncident, IncidentWithUpdates } from "../../../shared/admin-api";
import { type IncidentStage, LIMITS } from "../../../shared/vocabulary";
import { useAdminI18n } from "../messages";
import { navigate, useLocation } from "../../lib/router";
import { api } from "../api";
import { useAdmin } from "../context";
import { fromLocalInput, localTimeExists, toLocalInput } from "../datetime";
import { ErrorAlert, Field, IssueSummary, issuesAt, issuesOf, otherIssues, useUnsavedChanges } from "../forms";
import { BackLink, pageLink, ViewHeader } from "../layout";
import { affectedComponents, type ImpactDraft, ImpactPicker, impactDraft, StageSelect } from "./incident-form";

/**
 * A new incident. `?page=<id>&components=<id>,<id>` pre-fills it: the link in administrators'
 * notifications of a `down` names the page and the components that show the monitor,
 * which are pre-set to "outage".
 */
export function IncidentCreateView() {
	const { t, f } = useAdminI18n();
	const { pages } = useAdmin();
	const location = useLocation();
	const [initial] = useState(() => {
		const requested = location.search.get("page");
		const page = pages.find((candidate) => candidate.id === requested) ?? pages[0];
		const listed = new Set((location.search.get("components") ?? "").split(",").filter((id) => id !== ""));
		const components = (page?.components ?? []).filter((component) => listed.has(component.id)).map((component) => ({ id: component.id, impact: "down" as const }));
		return { pageId: page?.id ?? "", impacts: impactDraft(page, components), prefilled: components.length > 0 };
	});
	const [pageId, setPageId] = useState(initial.pageId);
	const [title, setTitle] = useState("");
	const [impacts, setImpacts] = useState<ImpactDraft>(initial.impacts);
	const [startedAt, setStartedAt] = useState("");
	const [stage, setStage] = useState<IncidentStage>("investigating");
	const [body, setBody] = useState("");
	const [sent, setSent] = useState<readonly AffectedComponent[]>([]);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const page = pages.find((candidate) => candidate.id === pageId);
	const issues: readonly ApiIssue[] = issuesOf(error, t);
	const now = Date.now();
	const started = fromLocalInput(startedAt);
	useUnsavedChanges(
		!busy && (title !== "" || body !== "" || startedAt !== "" || JSON.stringify(impacts) !== JSON.stringify(initial.impacts)),
	);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!localTimeExists(startedAt)) return;
		const components = affectedComponents(page, impacts);
		const input: CreateIncident = {
			pageId,
			title,
			stage,
			body,
			components,
			...(started === null ? {} : { startedAt: started }),
		};
		setSent(components);
		setBusy(true);
		setError(null);
		try {
			const incident = await api.post<IncidentWithUpdates>("/incidents", input);
			navigate(`/admin/incidents/${encodeURIComponent(incident.id)}?created=1`, { force: true });
		} catch (caught) {
			setError(caught);
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<BackLink href={pageLink("/admin/incidents", pageId)}>{t("admin.incidents.title")}</BackLink>
			<ViewHeader title={t("admin.incidents.new")} />
			{initial.prefilled && <p className="alert alert--info">{t("admin.incident.prefilled")}</p>}
			<form className="form" onSubmit={(event) => void submit(event)}>
				<ErrorAlert error={error} />
				<IssueSummary issues={otherIssues(issues, [["pageId"], ["title"], ["startedAt"], ["stage"], ["body"], ["components"]])} />
				{pages.length > 1 && (
					<Field label={t("admin.page.label")} errors={issuesAt(issues, ["pageId"])}>
						{({ id, describedBy }) => (
							<select
								id={id}
								aria-describedby={describedBy}
								value={pageId}
								onChange={(event) => {
									const next = pages.find((candidate) => candidate.id === event.target.value);
									setPageId(event.target.value);
									setImpacts(impactDraft(next, []));
								}}
							>
								{pages.map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.id}
									</option>
								))}
							</select>
						)}
					</Field>
				)}
				<Field label={t("admin.incident.title")} errors={issuesAt(issues, ["title"])}>
					{({ id, describedBy, invalid }) => (
						<input
							id={id}
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							required
							maxLength={LIMITS.title}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
						/>
					)}
				</Field>
				<ImpactPicker page={page} value={impacts} onChange={setImpacts} issues={issues} sent={sent} />
				<Field
					label={t("admin.incident.startedAt")}
					hint={t("admin.incident.startedAtHint", { timeZone: f.timeZone, offset: f.offset(started ?? now) })}
					errors={[...(localTimeExists(startedAt) ? [] : [t("admin.issue.localTimeGap")]), ...issuesAt(issues, ["startedAt"])]}
				>
					{({ id, describedBy, invalid }) => (
						<input
							id={id}
							type="datetime-local"
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							max={toLocalInput(now)}
							value={startedAt}
							onChange={(event) => setStartedAt(event.target.value)}
						/>
					)}
				</Field>
				<StageSelect value={stage} onChange={setStage} errors={issuesAt(issues, ["stage"])} />
				<Field label={t("admin.incident.firstUpdate")} hint={t("admin.incident.bodyHint")} errors={issuesAt(issues, ["body"])}>
					{({ id, describedBy, invalid }) => (
						<textarea
							id={id}
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							required
							rows={5}
							maxLength={LIMITS.body}
							value={body}
							onChange={(event) => setBody(event.target.value)}
						/>
					)}
				</Field>
				<div className="actions">
					<button type="submit" className="button button--primary" disabled={busy}>
						{t("admin.incident.publish")}
					</button>
				</div>
			</form>
		</>
	);
}
