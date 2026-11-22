/** Parts of the incident forms: affected components with their impact, and the stage. */
import type { AdminPage, AffectedComponent, ApiIssue } from "../../../shared/admin-api";
import { IMPACTS, type Impact, INCIDENT_STAGES, type IncidentStage } from "../../../shared/vocabulary";
import { useAdminI18n } from "../messages";
import { Field, Fieldset, issuesAt } from "../forms";

const IMPACT_RANK: Readonly<Record<Impact, number>> = { none: 0, degraded: 1, down: 2 };

/** The highest impact on any component, as the public page shows an incident. */
export function highestImpact(components: readonly { readonly impact: Impact }[]): Impact {
	return components.reduce<Impact>((highest, { impact }) => (IMPACT_RANK[impact] > IMPACT_RANK[highest] ? impact : highest), "none");
}

/** Each component's impact; `""`: not affected. Keyed by component ID. */
export type ImpactDraft = Readonly<Record<string, Impact | "">>;

export function impactDraft(page: AdminPage | undefined, components: readonly AffectedComponent[]): ImpactDraft {
	const draft: Record<string, Impact | ""> = {};
	for (const component of page?.components ?? []) draft[component.id] = "";
	for (const component of components) if (component.id in draft) draft[component.id] = component.impact;
	return draft;
}

/** The affected components to send, in the page's order. */
export function affectedComponents(page: AdminPage | undefined, draft: ImpactDraft): AffectedComponent[] {
	return (page?.components ?? []).flatMap((component) => {
		const impact = draft[component.id];
		return impact === undefined || impact === "" ? [] : [{ id: component.id, impact }];
	});
}

export interface ImpactPickerProps {
	readonly page: AdminPage | undefined;
	readonly value: ImpactDraft;
	readonly onChange: (value: ImpactDraft) => void;
	/** Validation issues; `components[i]` refers to the i-th of `sent`. */
	readonly issues: readonly ApiIssue[];
	/** The components as last sent, to place issues. */
	readonly sent: readonly AffectedComponent[];
	/** IDs the incident lists that the page no longer has (they are dropped when components are saved). */
	readonly unknown?: readonly string[];
	readonly legend?: string;
}

/** For each component of the page: not affected, or its impact. */
export function ImpactPicker({ page, value, onChange, issues, sent, unknown = [], legend }: ImpactPickerProps) {
	const { t } = useAdminI18n();
	// Issues about the list as a whole (those about one entry show next to it).
	const own = issues
		.filter((issue) => issue.path[0] === "components" && typeof issue.path[1] !== "number")
		.map((issue) => issue.message);
	return (
		<Fieldset legend={legend ?? t("admin.incident.components")} hint={t("admin.incident.componentsHint")} errors={own}>
			{(page?.components.length ?? 0) === 0 ? (
				<p className="muted">{t("admin.incident.noComponents")}</p>
			) : (
				<div className="impact-grid">
					{page?.components.map((component) => {
						const index = sent.findIndex((entry) => entry.id === component.id);
						const errors = index === -1 ? [] : issuesAt(issues, ["components", index]);
						return (
							<Field key={component.id} label={component.name} errors={errors}>
								{({ id, describedBy, invalid }) => (
									<select
										id={id}
										aria-describedby={describedBy}
										aria-invalid={invalid || undefined}
										value={value[component.id] ?? ""}
										onChange={(event) => onChange({ ...value, [component.id]: event.target.value as Impact | "" })}
									>
										<option value="">{t("admin.impact.unaffected")}</option>
										{IMPACTS.map((impact) => (
											<option key={impact} value={impact}>
												{t(`impact.${impact}`)}
											</option>
										))}
									</select>
								)}
							</Field>
						);
					})}
				</div>
			)}
			{unknown.length > 0 && <p className="field__hint">{t("admin.incident.unknownComponents", { ids: unknown.join(", ") })}</p>}
		</Fieldset>
	);
}

export function StageSelect({
	value,
	onChange,
	errors,
	stages = INCIDENT_STAGES,
}: {
	readonly value: IncidentStage;
	readonly onChange: (stage: IncidentStage) => void;
	readonly errors: readonly string[];
	readonly stages?: readonly IncidentStage[];
}) {
	const { t } = useAdminI18n();
	return (
		<Field label={t("admin.incident.stage")} hint={t("admin.incident.stageHint")} errors={errors}>
			{({ id, describedBy, invalid }) => (
				<select
					id={id}
					aria-describedby={describedBy}
					aria-invalid={invalid || undefined}
					value={value}
					onChange={(event) => onChange(event.target.value as IncidentStage)}
				>
					{stages.map((stage) => (
						<option key={stage} value={stage}>
							{t(`stage.${stage}`)}
						</option>
					))}
				</select>
			)}
		</Field>
	);
}
