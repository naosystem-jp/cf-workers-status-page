import type { ReactNode } from "react";
import type { ApiIssue } from "../../shared/admin-api";
import { useAdminI18n } from "./messages";
import { Field, FieldErrors, issuesAt } from "./forms";
import type { FieldValue, MapEntry, OptionsDraft, SavedOptions, SchemaField, SecretMode } from "./schema-form";

export interface SchemaFieldsProps {
	readonly fields: readonly SchemaField[];
	readonly draft: OptionsDraft;
	readonly onChange: (draft: OptionsDraft) => void;
	/** `null` for a new target. */
	readonly saved: SavedOptions | null;
	/** The API's validation issues (paths under `options`). */
	readonly issues: readonly ApiIssue[];
	/** Inputs that could not be read, by option. */
	readonly clientErrors: Readonly<Record<string, string>>;
	/** The kind's texts (`"<option>.title"`, `"<option>.description"`) in the admin's language. */
	readonly texts?: (key: string) => string | undefined;
}

/** The options of a notifier kind, generated from its JSON Schema (see schema-form.ts). */
export function SchemaFields({ fields, draft, onChange, saved, issues, clientErrors, texts = () => undefined }: SchemaFieldsProps) {
	const setValue = (key: string, value: FieldValue) => onChange({ ...draft, values: { ...draft.values, [key]: value } });
	const setMode = (key: string, mode: SecretMode) =>
		onChange({
			values: { ...draft.values, [key]: mode === "replace" ? draft.values[key] ?? "" : emptyFor(fields, key) },
			secrets: { ...draft.secrets, [key]: mode },
		});
	return (
		<>
			{fields.map((field) => (
				<SchemaFieldInput
					key={field.key}
					field={{
						...field,
						label: texts(`${field.key}.title`) ?? field.label,
						description: texts(`${field.key}.description`) ?? field.description,
					}}
					value={draft.values[field.key]}
					mode={field.secret ? (draft.secrets[field.key] ?? "replace") : null}
					isSet={saved?.secrets[field.key] ?? null}
					errors={[...issuesAt(issues, ["options", field.key]), ...(clientErrors[field.key] ? [clientErrors[field.key] as string] : [])]}
					onValue={(value) => setValue(field.key, value)}
					onMode={(mode) => setMode(field.key, mode)}
					creating={saved === null}
				/>
			))}
		</>
	);
}

function emptyFor(fields: readonly SchemaField[], key: string): FieldValue {
	const field = fields.find((candidate) => candidate.key === key);
	return field?.kind === "map" ? [] : field?.kind === "boolean" ? false : "";
}

interface InputProps {
	readonly field: SchemaField;
	readonly value: FieldValue | undefined;
	/** Secret options only. */
	readonly mode: SecretMode | null;
	/** Whether a saved target has a value for this secret; `null` for a new target or a plain option. */
	readonly isSet: boolean | null;
	readonly errors: readonly string[];
	readonly creating: boolean;
	onValue(value: FieldValue): void;
	onMode(mode: SecretMode): void;
}

function SchemaFieldInput({ field, value, mode, isSet, errors, creating, onValue, onMode }: InputProps) {
	const { t } = useAdminI18n();
	const label = (
		<>
			{field.label}
			{field.required ? null : <span className="field__optional"> {t("admin.form.optional")}</span>}
			{field.secret && <span className="badge badge--unknown">{t("admin.targets.secret")}</span>}
		</>
	);
	const hint = [field.description, field.secret ? t("admin.targets.secretHint") : null].filter(Boolean).join(" ") || undefined;

	// A saved target's secret: its value is never shown, only whether it is set.
	if (field.secret && !creating && mode !== "replace") {
		return (
			<div className={`field${errors.length > 0 ? " field--invalid" : ""}`}>
				<p className="field__label">{label}</p>
				<p className="secret-state">
					{mode === "remove" ? (
						<span>{t("admin.targets.secretWillBeRemoved")}</span>
					) : isSet ? (
						<span className="badge badge--up">{t("admin.targets.secretSet")}</span>
					) : (
						<span className="badge badge--unknown">{t("admin.targets.secretNotSet")}</span>
					)}
					{mode === "remove" ? (
						<button type="button" className="button button--small" onClick={() => onMode("keep")}>
							{t("admin.targets.secretUndo")}
						</button>
					) : (
						<>
							<button type="button" className="button button--small" onClick={() => onMode("replace")}>
								{isSet ? t("admin.targets.secretReplace") : t("admin.targets.secretEnter")}
							</button>
							{isSet && !field.required && (
								<button type="button" className="button button--small" onClick={() => onMode("remove")}>
									{t("admin.targets.secretRemove")}
								</button>
							)}
						</>
					)}
				</p>
				{hint !== undefined && <p className="field__hint">{hint}</p>}
				<FieldErrors errors={errors} />
			</div>
		);
	}

	const cancelReplace =
		field.secret && !creating ? (
			<button type="button" className="button button--small" onClick={() => onMode("keep")}>
				{t("admin.targets.secretKeep")}
			</button>
		) : null;

	if (field.kind === "map") {
		const rows = Array.isArray(value) ? (value as readonly MapEntry[]) : [];
		return (
			<fieldset className={`fieldset${errors.length > 0 ? " field--invalid" : ""}`}>
				<legend className="field__label">{label}</legend>
				{hint !== undefined && <p className="field__hint">{hint}</p>}
				{rows.map((row, index) => (
					// Rows have no identity but their position.
					<div key={index} className="map-row">
						<input
							aria-label={t("admin.targets.mapKey", { index: index + 1 })}
							value={row.key}
							autoComplete="off"
							onChange={(event) => onValue(rows.map((entry, at) => (at === index ? { ...entry, key: event.target.value } : entry)))}
						/>
						<input
							aria-label={t("admin.targets.mapValue", { index: index + 1 })}
							value={row.value}
							type={field.secret ? "password" : "text"}
							autoComplete="off"
							maxLength={field.valueMaxLength ?? undefined}
							onChange={(event) => onValue(rows.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)))}
						/>
						<button type="button" className="button button--small" onClick={() => onValue(rows.filter((_, at) => at !== index))}>
							{t("admin.targets.mapRemove")}
						</button>
					</div>
				))}
				<p className="actions">
					<button type="button" className="button button--small" onClick={() => onValue([...rows, { key: "", value: "" }])}>
						{t("admin.targets.mapAdd")}
					</button>
					{cancelReplace}
				</p>
				<FieldErrors errors={errors} />
			</fieldset>
		);
	}

	if (field.kind === "boolean") {
		return (
			<div className={`field field--check${errors.length > 0 ? " field--invalid" : ""}`}>
				<label className="check">
					<input type="checkbox" checked={value === true} onChange={(event) => onValue(event.target.checked)} />
					{label}
				</label>
				{hint !== undefined && <p className="field__hint">{hint}</p>}
				<FieldErrors errors={errors} />
			</div>
		);
	}

	const text = typeof value === "string" ? value : "";
	return (
		<Field label={label} hint={hint} errors={errors}>
			{({ id, describedBy, invalid }) => {
				const common = {
					id,
					"aria-describedby": describedBy,
					"aria-invalid": invalid || undefined,
					required: field.required,
				};
				let input: ReactNode;
				if (field.kind === "choice") {
					input = (
						<select {...common} value={text} onChange={(event) => onValue(event.target.value)}>
							{!field.required && <option value="">{t("admin.form.none")}</option>}
							{field.options.map((option, index) => (
								<option key={String(option)} value={String(index)}>
									{String(option)}
								</option>
							))}
						</select>
					);
				} else if (field.kind === "json") {
					input = <textarea {...common} rows={4} className="mono" value={text} onChange={(event) => onValue(event.target.value)} />;
				} else if (field.kind === "number") {
					input = (
						<input
							{...common}
							type="number"
							step={field.integer ? 1 : "any"}
							min={field.minimum ?? undefined}
							max={field.maximum ?? undefined}
							value={text}
							onChange={(event) => onValue(event.target.value)}
						/>
					);
				} else {
					input = (
						<input
							{...common}
							type={field.secret ? "password" : field.inputType}
							autoComplete={field.secret ? "new-password" : "off"}
							spellCheck={false}
							minLength={field.minLength ?? undefined}
							maxLength={field.maxLength ?? undefined}
							value={text}
							onChange={(event) => onValue(event.target.value)}
						/>
					);
				}
				return cancelReplace === null ? (
					input
				) : (
					<div className="input-row">
						{input}
						{cancelReplace}
					</div>
				);
			}}
		</Field>
	);
}
