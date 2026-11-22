import { type FormEvent, useMemo, useState } from "react";
import type {
	AdminMonitorsResponse,
	ApiIssue,
	ComponentRef,
	CreateNotificationTarget,
	NotificationTarget,
	NotifierKindInfo,
	NotifierKindsResponse,
	PatchNotificationTarget,
	TestNotificationResult,
} from "../../../shared/admin-api";
import { DEFAULT_TARGET_EVENTS, LIMITS, NOTIFICATION_EVENTS, type NotificationEvent } from "../../../shared/vocabulary";
import { useAdminI18n } from "../messages";
import { navigate } from "../../lib/router";
import { api, enc } from "../api";
import { ConfirmAction } from "../ConfirmAction";
import { ConflictNotice, sameValue, useVersionedDraft } from "../conflict";
import { useAdmin } from "../context";
import { ErrorAlert, Field, Fieldset, IssueSummary, errorText, issuesAt, issuesOf, Notice, otherIssues, useUnsavedChanges } from "../forms";
import { BackLink, Loading, ViewHeader } from "../layout";
import { SchemaFields } from "../SchemaFields";
import { fieldsFromSchema, initialOptionsDraft, kindText, type OptionsDraft, optionsFromDraft, type SchemaField } from "../schema-form";
import { useLoad } from "../useLoad";

/** What the form holds; `options` as the generated form's inputs (see schema-form.ts). */
interface TargetDraft {
	readonly name: string;
	readonly admin: boolean;
	readonly enabled: boolean;
	readonly events: readonly NotificationEvent[];
	readonly allMonitors: boolean;
	readonly monitors: readonly string[];
	readonly components: readonly ComponentRef[];
	readonly options: OptionsDraft;
}

const TOP_FIELDS = [["name"], ["kind"], ["admin"], ["enabled"], ["events"], ["allMonitors"], ["monitors"], ["components"], ["options"]] as const;

const CLIENT_ERRORS = {
	number: "admin.targets.invalidNumber",
	json: "admin.targets.invalidJson",
	pattern: "admin.issue.format",
	secretMissing: "admin.targets.secretMissing",
} as const;

/** A kind's name in the admin's language. */
export function kindName(kind: Pick<NotifierKindInfo, "name" | "messages">, locale: string): string {
	return kindText(kind.messages, locale, "$kind") ?? kind.name;
}

function useKinds() {
	return useLoad("kinds", (signal) => api.get<NotifierKindsResponse>("/notifications/kinds", signal));
}

function useMonitors() {
	return useLoad("monitors", (signal) => api.get<AdminMonitorsResponse>("/monitors", signal));
}

export function TargetCreateView() {
	const { t, locale } = useAdminI18n();
	const kinds = useKinds();
	const monitors = useMonitors();
	const [kindType, setKindType] = useState<string | null>(null);
	const kind = kinds.data?.kinds.find((candidate) => candidate.type === (kindType ?? kinds.data?.kinds[0]?.type));
	return (
		<>
			<BackLink href="/admin/notifications">{t("admin.targets.title")}</BackLink>
			<ViewHeader title={t("admin.targets.new")} />
			{kinds.data === undefined ? (
				kinds.error === null ? <Loading /> : <ErrorAlert error={kinds.error} onRetry={kinds.reload} />
			) : kinds.data.kinds.length === 0 || kind === undefined ? (
				<p className="empty">{t("admin.targets.noKinds")}</p>
			) : (
				<>
					<div className="form form--lead">
						<Field label={t("admin.targets.kind")} hint={t("admin.targets.kindHint")}>
						{({ id, describedBy }) => (
							<select id={id} aria-describedby={describedBy} value={kind.type} onChange={(event) => setKindType(event.target.value)}>
								{kinds.data?.kinds.map((candidate) => (
									<option key={candidate.type} value={candidate.type}>
										{kindName(candidate, locale)}
									</option>
								))}
							</select>
						)}
						</Field>
					</div>
					<TargetForm
						key={kind.type}
						kind={kind}
						target={null}
						monitorIds={monitors.data?.monitors.filter((monitor) => monitor.configured).map((monitor) => monitor.id) ?? []}
						encryption={kinds.data.encryption.configured}
					/>
				</>
			)}
		</>
	);
}

export function TargetEditView({ id }: { readonly id: string }) {
	const { t, locale } = useAdminI18n();
	const kinds = useKinds();
	const monitors = useMonitors();
	const target = useLoad(id, (signal) => api.get<NotificationTarget>(`/notifications/targets/${enc(id)}`, signal));
	const error = target.error ?? kinds.error;
	if (target.data === undefined || kinds.data === undefined) {
		return (
			<>
				<BackLink href="/admin/notifications">{t("admin.targets.title")}</BackLink>
				{error === null ? <Loading /> : <ErrorAlert error={error} onRetry={() => { target.reload(); kinds.reload(); }} />}
			</>
		);
	}
	const data = target.data;
	const kind = kinds.data.kinds.find((candidate) => candidate.type === data.kind);
	return (
		<>
			<BackLink href="/admin/notifications">{t("admin.targets.title")}</BackLink>
			<ViewHeader title={data.name}>
				<p className="field__hint">{t("admin.targets.kindIs", { kind: kind === undefined ? data.kind : kindName(kind, locale) })}</p>
			</ViewHeader>
			{kind === undefined ? (
				<p className="alert alert--warning">{t("admin.targets.kindGone", { kind: data.kind })}</p>
			) : (
				<TargetForm
					key={data.id}
					kind={kind}
					target={data}
					monitorIds={monitors.data?.monitors.filter((monitor) => monitor.configured).map((monitor) => monitor.id) ?? []}
					encryption={kinds.data.encryption.configured}
					onReload={target.reload}
				/>
			)}
			<TestSend target={data} />
			<section className="panel panel--danger" aria-labelledby="delete-heading">
				<h2 id="delete-heading" className="panel__title">
					{t("admin.targets.deleteTitle")}
				</h2>
				<DeleteTarget target={data} />
			</section>
		</>
	);
}

function toDraft(fields: readonly SchemaField[]) {
	return (target: NotificationTarget): TargetDraft => ({
		name: target.name,
		admin: target.admin,
		enabled: target.enabled,
		events: target.events,
		allMonitors: target.allMonitors,
		monitors: target.monitors,
		components: target.components,
		options: initialOptionsDraft(fields, target),
	});
}

interface TargetFormProps {
	readonly kind: NotifierKindInfo;
	/** `null` for a new target. */
	readonly target: NotificationTarget | null;
	/** Configured monitors, for choosing some. */
	readonly monitorIds: readonly string[];
	/** Whether secret options can be saved (the encryption key is set). */
	readonly encryption: boolean;
	readonly onReload?: () => void;
}

/** The form of a new target (`target` null) or an existing one. */
function TargetForm(props: TargetFormProps) {
	const fields = useMemo(() => fieldsFromSchema(props.kind.optionsSchema, props.kind.secretOptions), [props.kind]);
	return props.target === null ? <NewTarget {...props} fields={fields} /> : <ExistingTarget {...props} target={props.target} fields={fields} />;
}

function NewTarget({ kind, fields, monitorIds, encryption }: TargetFormProps & { readonly fields: readonly SchemaField[] }) {
	const { t } = useAdminI18n();
	const [initial] = useState<TargetDraft>(() => ({
		name: "",
		admin: false,
		enabled: true,
		events: DEFAULT_TARGET_EVENTS,
		allMonitors: true,
		monitors: [],
		components: [],
		options: initialOptionsDraft(fields, null),
	}));
	const [draft, setDraft] = useState<TargetDraft>(initial);
	const [error, setError] = useState<unknown>(null);
	const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
	const [busy, setBusy] = useState(false);
	useUnsavedChanges(!busy && !sameValue(draft, initial));

	async function submit(event: FormEvent) {
		event.preventDefault();
		const options = optionsFromDraft(fields, draft.options, null);
		if (!options.ok) {
			setClientErrors(Object.fromEntries(Object.entries(options.errors).map(([key, code]) => [key, t(CLIENT_ERRORS[code])])));
			return;
		}
		setClientErrors({});
		const input: CreateNotificationTarget = {
			name: draft.name,
			kind: kind.type,
			options: options.options,
			admin: draft.admin,
			enabled: draft.enabled,
			events: [...draft.events],
			allMonitors: draft.allMonitors,
			monitors: draft.allMonitors ? [] : [...draft.monitors],
			components: draft.allMonitors ? [] : [...draft.components],
		};
		setBusy(true);
		setError(null);
		try {
			const created = await api.post<NotificationTarget>("/notifications/targets", input);
			navigate(`/admin/notifications/${enc(created.id)}?created=1`, { force: true });
		} catch (caught) {
			setError(caught);
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="form" onSubmit={(event) => void submit(event)}>
			{!encryption && kind.secretOptions.length > 0 && <p className="alert alert--warning">{t("admin.targets.noKeyForm")}</p>}
			<ErrorAlert error={error} />
			<IssueSummary issues={otherIssues(issuesOf(error, t), TOP_FIELDS)} />
			<TargetFields
				kind={kind}
				fields={fields}
				draft={draft}
				onChange={(update) => setDraft(update)}
				issues={issuesOf(error, t)}
				clientErrors={clientErrors}
				target={null}
				monitorIds={monitorIds}
			/>
			<div className="actions">
				<button type="submit" className="button button--primary" disabled={busy}>
					{t("admin.targets.create")}
				</button>
			</div>
		</form>
	);
}

function ExistingTarget({
	kind,
	target,
	fields,
	monitorIds,
	encryption,
	onReload,
}: TargetFormProps & { readonly target: NotificationTarget; readonly fields: readonly SchemaField[] }) {
	const { t, f } = useAdminI18n();
	const convert = useMemo(() => toDraft(fields), [fields]);
	const edit = useVersionedDraft(target, convert);
	if (target.version > edit.base.version && edit.conflict === null) edit.refresh(target);
	const [error, setError] = useState<unknown>(null);
	const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(() => new URLSearchParams(window.location.search).get("created") === "1");
	useUnsavedChanges(edit.changed.length > 0);

	async function submit(event: FormEvent) {
		event.preventDefault();
		const options = optionsFromDraft(fields, edit.draft.options, edit.base);
		if (!options.ok) {
			setClientErrors(Object.fromEntries(Object.entries(options.errors).map(([key, code]) => [key, t(CLIENT_ERRORS[code])])));
			return;
		}
		setClientErrors({});
		const changes: { -readonly [K in keyof PatchNotificationTarget]: PatchNotificationTarget[K] } = { version: edit.base.version };
		const draft = edit.draft;
		for (const key of edit.changed) {
			if (key === "name") changes.name = draft.name;
			else if (key === "admin") changes.admin = draft.admin;
			else if (key === "enabled") changes.enabled = draft.enabled;
			else if (key === "events") changes.events = [...draft.events];
			else if (key === "allMonitors") changes.allMonitors = draft.allMonitors;
			else if (key === "monitors") changes.monitors = [...draft.monitors];
			else if (key === "components") changes.components = [...draft.components];
		}
		if (Object.keys(options.options).length > 0) changes.options = options.options;
		if (Object.keys(changes).length === 1) return;
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			edit.saved(await api.patch<NotificationTarget>(`/notifications/targets/${enc(target.id)}`, changes));
			setSaved(true);
		} catch (caught) {
			if (!edit.handleError(caught)) setError(caught);
		} finally {
			setBusy(false);
		}
	}

	const conflict = edit.conflict;
	const yesNo = (value: boolean) => (value ? t("admin.common.yes") : t("admin.common.no"));
	return (
		<>
			{conflict !== null && (
				<ConflictNotice
					conflict={conflict}
					label={(field) => t(`admin.targets.field.${field as keyof TargetDraft}`)}
					value={(field) => {
						const current = conflict.current;
						switch (field) {
							case "name":
								return current.name;
							case "admin":
								return yesNo(current.admin);
							case "enabled":
								return yesNo(current.enabled);
							case "events":
								return f.list(current.events.map((event) => t(`admin.event.${event}`)));
							case "allMonitors":
								return yesNo(current.allMonitors);
							case "monitors":
								return f.list(current.monitors);
							case "components":
								return f.list(current.components.map((ref) => `${ref.pageId}/${ref.componentId}`));
							default:
								return t("admin.targets.optionsChanged");
						}
					}}
					onTakeCurrent={() => {
						edit.takeCurrent();
						onReload?.();
					}}
					onReapply={() => {
						edit.reapply();
						onReload?.();
					}}
				/>
			)}
			<form className="form" onSubmit={(event) => void submit(event)}>
				{!encryption && kind.secretOptions.length > 0 && <p className="alert alert--warning">{t("admin.targets.noKeyForm")}</p>}
				<ErrorAlert error={error} />
				<IssueSummary issues={otherIssues(issuesOf(error, t), TOP_FIELDS)} />
				{saved && edit.changed.length === 0 && <Notice>{t("admin.form.saved")}</Notice>}
				<p className="field__hint">
					{t("admin.common.lastChange", {
						who: edit.base.updatedBy ?? t("admin.common.automation"),
						time: f.dateTimeWithZone(edit.base.updatedAt),
					})}
				</p>
				<TargetFields
					kind={kind}
					fields={fields}
					draft={edit.draft}
					onChange={edit.setDraft}
					issues={issuesOf(error, t)}
					clientErrors={clientErrors}
					target={edit.base}
					monitorIds={monitorIds}
				/>
				<div className="actions">
					<button type="submit" className="button button--primary" disabled={busy || edit.changed.length === 0 || conflict !== null}>
						{t("admin.form.save")}
					</button>
					{edit.changed.length > 0 && <span className="muted">{t("admin.form.unsaved")}</span>}
				</div>
			</form>
		</>
	);
}

interface TargetFieldsProps {
	readonly kind: NotifierKindInfo;
	readonly fields: readonly SchemaField[];
	readonly draft: TargetDraft;
	readonly onChange: (update: (draft: TargetDraft) => TargetDraft) => void;
	readonly issues: readonly ApiIssue[];
	readonly clientErrors: Readonly<Record<string, string>>;
	readonly target: NotificationTarget | null;
	readonly monitorIds: readonly string[];
}

function TargetFields({ kind, fields, draft, onChange, issues, clientErrors, target, monitorIds }: TargetFieldsProps) {
	const { t, locale } = useAdminI18n();
	const { pages } = useAdmin();
	const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) => onChange((current) => ({ ...current, [key]: value }));
	const toggle = <T,>(list: readonly T[], item: T, on: boolean, same: (a: T, b: T) => boolean = Object.is): T[] =>
		on ? [...list.filter((entry) => !same(entry, item)), item] : list.filter((entry) => !same(entry, item));
	const sameRef = (a: ComponentRef, b: ComponentRef) => a.pageId === b.pageId && a.componentId === b.componentId;
	const listedMonitors = [...new Set([...monitorIds, ...draft.monitors])];
	return (
		<>
			<Field label={t("admin.targets.name")} errors={issuesAt(issues, ["name"])}>
				{({ id, describedBy, invalid }) => (
					<input
						id={id}
						aria-describedby={describedBy}
						aria-invalid={invalid || undefined}
						required
						maxLength={LIMITS.targetName}
						value={draft.name}
						onChange={(event) => set("name", event.target.value)}
					/>
				)}
			</Field>
			<Fieldset legend={t("admin.targets.options")} hint={t("admin.targets.optionsHint")}>
				<SchemaFields
					fields={fields}
					draft={draft.options}
					onChange={(options) => set("options", options)}
					saved={target}
					issues={issues}
					clientErrors={clientErrors}
					texts={(key) => kindText(kind.messages, locale, key)}
				/>
			</Fieldset>
			<div className="checks">
				<label className="check">
					<input type="checkbox" checked={draft.enabled} onChange={(event) => set("enabled", event.target.checked)} />
					{t("admin.targets.field.enabled")}
				</label>
				<label className="check">
					<input
						type="checkbox"
						checked={draft.admin}
						onChange={(event) => {
							const admin = event.target.checked;
							onChange((current) => ({
								...current,
								admin,
								// `unknown` goes to administrators' targets only: on by default for them.
								events: admin
									? current.events.includes("unknown") || target !== null
										? current.events
										: [...current.events, "unknown"]
									: current.events.filter((name) => name !== "unknown"),
							}));
						}}
					/>
					{t("admin.targets.field.admin")}
				</label>
				<p className="field__hint">{t("admin.targets.adminHint")}</p>
			</div>
			<Fieldset legend={t("admin.targets.field.events")} errors={issuesAt(issues, ["events"])}>
				<div className="checks">
					{NOTIFICATION_EVENTS.map((name) => (
						<label key={name} className="check">
							<input
								type="checkbox"
								checked={draft.events.includes(name)}
								disabled={name === "unknown" && !draft.admin}
								onChange={(event) => set("events", toggle(draft.events, name, event.target.checked))}
							/>
							{t(`admin.event.${name}`)}
						</label>
					))}
				</div>
				{!draft.admin && <p className="field__hint">{t("admin.targets.unknownHint")}</p>}
			</Fieldset>
			<Fieldset
				legend={t("admin.targets.coverage")}
				errors={[...issuesAt(issues, ["allMonitors"]), ...issuesAt(issues, ["monitors"]), ...issuesAt(issues, ["components"])]}
			>
				<label className="check">
					<input type="radio" name="coverage" checked={draft.allMonitors} onChange={() => set("allMonitors", true)} />
					{t("admin.targets.allMonitors")}
				</label>
				<label className="check">
					<input type="radio" name="coverage" checked={!draft.allMonitors} onChange={() => set("allMonitors", false)} />
					{t("admin.targets.chosenMonitors")}
				</label>
				{!draft.allMonitors && (
					<div className="nested">
						<p className="field__label">{t("admin.targets.field.monitors")}</p>
						<div className="checks">
							{listedMonitors.length === 0 && <p className="muted">{t("admin.monitors.none")}</p>}
							{listedMonitors.map((id) => (
								<label key={id} className="check">
									<input type="checkbox" checked={draft.monitors.includes(id)} onChange={(event) => set("monitors", toggle(draft.monitors, id, event.target.checked))} />
									<code>{id}</code>
								</label>
							))}
						</div>
						<p className="field__label">{t("admin.targets.field.components")}</p>
						<p className="field__hint">{t("admin.targets.componentsHint")}</p>
						{pages.map((page) => (
							<div key={page.id} className="checks">
								{page.components.map((component) => {
									const ref = { pageId: page.id, componentId: component.id };
									return (
										<label key={component.id} className="check">
											<input
												type="checkbox"
												checked={draft.components.some((entry) => sameRef(entry, ref))}
												onChange={(event) => set("components", toggle(draft.components, ref, event.target.checked, sameRef))}
											/>
											{pages.length > 1 ? `${page.id} / ${component.name}` : component.name}
										</label>
									);
								})}
							</div>
						))}
					</div>
				)}
			</Fieldset>
		</>
	);
}

/** Sends a test notification with the saved settings. */
function TestSend({ target }: { readonly target: NotificationTarget }) {
	const { t } = useAdminI18n();
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
	return (
		<section className="panel" aria-labelledby="test-heading">
			<h2 id="test-heading" className="panel__title">
				{t("admin.targets.testTitle")}
			</h2>
			<p className="field__hint">{t("admin.targets.testHint")}</p>
			<p className="actions">
				<button
					type="button"
					className="button"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setResult(null);
						try {
							const outcome = await api.post<TestNotificationResult>(`/notifications/targets/${enc(target.id)}/test`, {});
							setResult(outcome.ok ? { ok: true, text: t("admin.targets.testOk") } : { ok: false, text: t("admin.targets.testFailed", { error: outcome.error ?? "" }) });
						} catch (error) {
							setResult({ ok: false, text: errorText(error, t) });
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy ? t("admin.targets.testing") : t("admin.targets.test")}
				</button>
			</p>
			{result !== null && (
				<p role="status" className={result.ok ? "success-text" : "error-text"}>
					{result.text}
				</p>
			)}
		</section>
	);
}

function DeleteTarget({ target }: { readonly target: NotificationTarget }) {
	const { t } = useAdminI18n();
	const [error, setError] = useState<unknown>(null);
	return (
		<>
			<ErrorAlert error={error} />
			<ConfirmAction
				label={t("admin.action.delete")}
				question={t("admin.targets.deleteQuestion", { name: target.name })}
				confirmLabel={t("admin.action.deleteConfirm")}
				onConfirm={async () => {
					try {
						await api.delete(`/notifications/targets/${enc(target.id)}`);
						navigate("/admin/notifications", { force: true });
					} catch (caught) {
						setError(caught);
					}
				}}
			/>
		</>
	);
}
