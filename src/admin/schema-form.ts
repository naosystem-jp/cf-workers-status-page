/**
 * Notification target forms generated from each notifier kind's options, as JSON Schema
 * (`GET /api/admin/notifications/kinds`, made from the kind's Zod schema).
 *
 * Supported, as Zod's `toJSONSchema()` writes them: an object with `properties` and
 * `required`; properties that are strings (`format` uri/url/email, `minLength`, `maxLength`,
 * `pattern`), numbers and integers (`minimum`, `maximum`), booleans, enumerations (`enum`,
 * `const`, `anyOf`/`oneOf` of constants), maps of strings (`additionalProperties` of type
 * string, such as a webhook's headers), and nullable versions of these (`type: [x, "null"]`,
 * `anyOf: [x, {type: "null"}]`); `title`, `description` and `default`. Anything else is edited
 * as JSON text. The Worker validates the result against the kind's Zod schema in any case.
 *
 * Secret options (`writeOnly`, also listed in `secretOptions`) are never returned by the API:
 * a saved target says only whether each one is set. Their inputs are never filled in: the
 * admin keeps the stored value, replaces it, or removes an optional one.
 */

import { DEFAULT_LOCALE, matchLocale } from "../../shared/i18n/core";

export interface FieldBase {
	readonly key: string;
	/** The schema's `title`, else the option's name in words (see {@link humanize}). */
	readonly label: string;
	readonly description: string | null;
	readonly required: boolean;
	/** Write-only: encrypted, never shown again. */
	readonly secret: boolean;
}

export type SchemaField =
	| (FieldBase & {
			readonly kind: "text";
			readonly inputType: "text" | "url" | "email";
			readonly minLength: number | null;
			readonly maxLength: number | null;
			readonly pattern: string | null;
			readonly defaultValue: string | null;
	  })
	| (FieldBase & {
			readonly kind: "number";
			readonly integer: boolean;
			readonly minimum: number | null;
			readonly maximum: number | null;
			readonly defaultValue: number | null;
	  })
	| (FieldBase & { readonly kind: "boolean"; readonly defaultValue: boolean | null })
	| (FieldBase & { readonly kind: "choice"; readonly options: readonly JsonScalar[]; readonly defaultValue: JsonScalar | null })
	| (FieldBase & { readonly kind: "map"; readonly valueMaxLength: number | null })
	| (FieldBase & { readonly kind: "json" });

export type JsonScalar = string | number | boolean;

type Schema = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const isScalar = (value: unknown): value is JsonScalar => ["string", "number", "boolean"].includes(typeof value);

/** The schema without its `null` alternative: `{ type: ["string", "null"] }` → `{ type: "string" }`. */
function withoutNull(schema: Schema): { schema: Schema; nullable: boolean } {
	const type = schema["type"];
	if (Array.isArray(type) && type.includes("null")) {
		const rest = type.filter((entry) => entry !== "null");
		return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
	}
	for (const keyword of ["anyOf", "oneOf"] as const) {
		const options = schema[keyword];
		if (!Array.isArray(options)) continue;
		const nonNull = options.filter((option) => !(isObject(option) && option["type"] === "null"));
		if (nonNull.length === options.length - 1 && nonNull.length === 1 && isObject(nonNull[0])) {
			const { [keyword]: _removed, ...outer } = schema;
			return { schema: { ...outer, ...nonNull[0] }, nullable: true };
		}
	}
	return { schema, nullable: false };
}

/** The constants of an enumeration, or `null` when the schema is not one. */
function enumeration(schema: Schema): JsonScalar[] | null {
	const values = schema["enum"];
	if (Array.isArray(values) && values.length > 0 && values.every(isScalar)) return [...values];
	if (isScalar(schema["const"])) return [schema["const"]];
	for (const keyword of ["anyOf", "oneOf"] as const) {
		const options = schema[keyword];
		if (!Array.isArray(options) || options.length === 0) continue;
		const constants = options.map((option) => (isObject(option) ? enumeration(option) : null));
		if (constants.every((value) => value !== null)) return constants.flat();
	}
	return null;
}

function field(key: string, raw: Schema, required: boolean, secret: boolean): SchemaField {
	const { schema, nullable } = withoutNull(raw);
	const base: FieldBase = {
		key,
		label: str(schema["title"]) ?? humanize(key),
		description: str(schema["description"]),
		required: required && !nullable,
		secret: secret || schema["writeOnly"] === true || raw["writeOnly"] === true,
	};
	const defaultValue = schema["default"];
	const choices = enumeration(schema);
	if (choices !== null) return { ...base, kind: "choice", options: choices, defaultValue: isScalar(defaultValue) ? defaultValue : null };
	switch (schema["type"]) {
		case "string": {
			const format = str(schema["format"]);
			return {
				...base,
				kind: "text",
				inputType: format === "uri" || format === "url" ? "url" : format === "email" ? "email" : "text",
				minLength: num(schema["minLength"]),
				maxLength: num(schema["maxLength"]),
				pattern: str(schema["pattern"]),
				defaultValue: str(defaultValue),
			};
		}
		case "number":
		case "integer":
			return {
				...base,
				kind: "number",
				integer: schema["type"] === "integer",
				minimum: num(schema["minimum"]) ?? num(schema["exclusiveMinimum"]),
				maximum: num(schema["maximum"]) ?? num(schema["exclusiveMaximum"]),
				defaultValue: num(defaultValue),
			};
		case "boolean":
			return { ...base, kind: "boolean", defaultValue: typeof defaultValue === "boolean" ? defaultValue : null };
		case "object": {
			const values = schema["additionalProperties"];
			const hasProperties = isObject(schema["properties"]) && Object.keys(schema["properties"]).length > 0;
			if (!hasProperties && isObject(values) && values["type"] === "string") {
				return { ...base, kind: "map", valueMaxLength: num(values["maxLength"]) };
			}
			return { ...base, kind: "json" };
		}
		default:
			return { ...base, kind: "json" };
	}
}

/** An option's name in words, for want of a title: `signingSecret` → "Signing secret", `threadId` → "Thread ID". */
export function humanize(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.split(/\s+/)
		.map((word) => (/^(id|url|uri|api)$/i.test(word) ? word.toUpperCase() : word.toLowerCase()));
	const text = words.join(" ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Texts of a notifier kind by language (`NotifierKindInfo.messages`). */
export type KindMessages = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * A notifier kind's text for `key` (`"$kind"`, `"<option>.title"`, `"<option>.description"`) in
 * the language best matching `locale`, else in English; `undefined` when it has none.
 */
export function kindText(messages: KindMessages, locale: string, key: string): string | undefined {
	const tag = matchLocale(locale, Object.keys(messages));
	return messages[tag]?.[key] ?? messages[DEFAULT_LOCALE]?.[key];
}

/** The form's fields, in the schema's order. `secretOptions` marks secrets the schema might not. */
export function fieldsFromSchema(schema: unknown, secretOptions: readonly string[] = []): SchemaField[] {
	if (!isObject(schema) || !isObject(schema["properties"])) return [];
	const required = new Set(Array.isArray(schema["required"]) ? schema["required"].filter((key) => typeof key === "string") : []);
	return Object.entries(schema["properties"]).map(([key, property]) =>
		field(key, isObject(property) ? property : {}, required.has(key), secretOptions.includes(key)),
	);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export interface MapEntry {
	readonly key: string;
	readonly value: string;
}

/** What a field's input holds: text for text, numbers, choices and JSON; a checkbox; rows of a map. */
export type FieldValue = string | boolean | readonly MapEntry[];

/** For a secret option of a saved target: keep what is stored, replace it with the input, or remove it. */
export type SecretMode = "keep" | "replace" | "remove";

export interface OptionsDraft {
	readonly values: Readonly<Record<string, FieldValue>>;
	/** Secret options only. A new target has nothing to keep: every secret is `replace`. */
	readonly secrets: Readonly<Record<string, SecretMode>>;
}

/** A saved target's options as the API returns them: plain options, and whether each secret is set. */
export interface SavedOptions {
	readonly options: Readonly<Record<string, unknown>>;
	readonly secrets: Readonly<Record<string, boolean>>;
}

function emptyValue(field: SchemaField): FieldValue {
	if (field.kind === "boolean") return field.defaultValue ?? false;
	if (field.kind === "map") return [];
	return "";
}

function toFieldValue(field: SchemaField, value: unknown): FieldValue {
	if (value === undefined || value === null) return emptyValue(field);
	switch (field.kind) {
		case "boolean":
			return value === true;
		case "map":
			return isObject(value) ? Object.entries(value).map(([key, entry]) => ({ key, value: String(entry) })) : [];
		case "choice": {
			const index = field.options.findIndex((option) => option === value);
			return index === -1 ? "" : String(index);
		}
		case "json":
			return JSON.stringify(value, null, 2);
		default:
			return String(value);
	}
}

/**
 * The form's starting values: a saved target's plain options (secrets left empty, to keep),
 * or the schema's defaults for a new one.
 */
export function initialOptionsDraft(fields: readonly SchemaField[], saved: SavedOptions | null): OptionsDraft {
	const values: Record<string, FieldValue> = {};
	const secrets: Record<string, SecretMode> = {};
	for (const field of fields) {
		if (field.secret) {
			values[field.key] = emptyValue(field);
			secrets[field.key] = saved === null ? "replace" : "keep";
		} else if (saved !== null) {
			values[field.key] = toFieldValue(field, saved.options[field.key]);
		} else {
			values[field.key] = "defaultValue" in field ? toFieldValue(field, field.defaultValue) : emptyValue(field);
		}
	}
	return { values, secrets };
}

export type FieldError = "number" | "json" | "pattern" | "secretMissing";

export type ParsedValue = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: FieldError };

/**
 * Whether `text` matches a JSON Schema `pattern`: an ECMAScript regular expression that may
 * match anywhere (not the whole value, unlike HTML's `pattern` attribute, which is therefore not
 * used). A pattern this browser cannot read is not checked here (the Worker checks anyway).
 */
export function matchesPattern(pattern: string, text: string): boolean {
	try {
		return new RegExp(pattern, "u").test(text);
	} catch {
		return true;
	}
}

/** A field's input as the option's value; `undefined` when empty. */
export function parseFieldValue(field: SchemaField, input: FieldValue | undefined): ParsedValue {
	if (input === undefined) return { ok: true, value: undefined };
	switch (field.kind) {
		case "boolean":
			return { ok: true, value: input === true };
		case "map": {
			const rows = Array.isArray(input) ? (input as readonly MapEntry[]).filter((row) => row.key.trim() !== "") : [];
			return { ok: true, value: rows.length === 0 ? undefined : Object.fromEntries(rows.map((row) => [row.key.trim(), row.value])) };
		}
		default: {
			const text = typeof input === "string" ? input : "";
			if (text.trim() === "") return { ok: true, value: undefined };
			if (field.kind === "number") {
				const value = Number(text);
				return Number.isFinite(value) ? { ok: true, value } : { ok: false, error: "number" };
			}
			if (field.kind === "choice") return { ok: true, value: field.options[Number(text)] };
			if (field.kind === "text" && field.pattern !== null && !matchesPattern(field.pattern, text)) return { ok: false, error: "pattern" };
			if (field.kind === "json") {
				try {
					return { ok: true, value: JSON.parse(text) as unknown };
				} catch {
					return { ok: false, error: "json" };
				}
			}
			return { ok: true, value: text };
		}
	}
}

export type OptionsResult =
	| { readonly ok: true; readonly options: Record<string, unknown> }
	/** Inputs that cannot be read as their type, by option. */
	| { readonly ok: false; readonly errors: Readonly<Record<string, FieldError>> };

/**
 * The `options` to send. For a new target (`saved` null): every option with a value. For a
 * saved one, only what changed (the API keeps the rest, secrets included): plain options that
 * differ from what is saved (`null` removes one that was emptied), secrets being replaced, and
 * `null` for secrets being removed. Secrets being kept are left out, never sent back.
 */
export function optionsFromDraft(fields: readonly SchemaField[], draft: OptionsDraft, saved: SavedOptions | null): OptionsResult {
	const options: Record<string, unknown> = {};
	const errors: Record<string, FieldError> = {};
	for (const field of fields) {
		const mode = field.secret ? (draft.secrets[field.key] ?? "replace") : null;
		if (mode === "keep") continue;
		if (mode === "remove") {
			if (saved?.secrets[field.key] === true) options[field.key] = null;
			continue;
		}
		const parsed = parseFieldValue(field, draft.values[field.key]);
		if (!parsed.ok) {
			errors[field.key] = parsed.error;
			continue;
		}
		if (saved === null) {
			if (parsed.value !== undefined) options[field.key] = parsed.value;
		} else if (field.secret) {
			// Replacing: a value is needed (to remove an optional one, choose "remove").
			if (parsed.value === undefined) errors[field.key] = "secretMissing";
			else options[field.key] = parsed.value;
		} else {
			const before = saved.options[field.key];
			const after = parsed.value;
			if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) options[field.key] = after ?? null;
		}
	}
	return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, options };
}
