/**
 * Form pieces: labelled fields with the API's validation messages next to them (`issues`,
 * located by path in the request body), a summary of the messages no field shows, and
 * errors in words.
 */
import { type ReactNode, useEffect, useId, useRef } from "react";
import type { ApiIssue } from "../../shared/admin-api";
import { Icon } from "../components/Icon";
import { addBlocker } from "../lib/router";
import { type AdminKey, type AdminTranslate, useAdminI18n } from "./messages";
import { AdminApiError } from "./api";

export type IssuePath = readonly (string | number)[];

function startsWith(path: readonly (string | number)[], prefix: IssuePath): boolean {
	return prefix.every((segment, index) => String(path[index]) === String(segment));
}

/** Messages of the issues at `prefix` or below it. */
export function issuesAt(issues: readonly ApiIssue[], prefix: IssuePath): string[] {
	return issues.filter((issue) => startsWith(issue.path, prefix)).map((issue) => issue.message);
}

/** Issues that none of `shown` (the fields' paths) displays. */
export function otherIssues(issues: readonly ApiIssue[], shown: readonly IssuePath[]): ApiIssue[] {
	return issues.filter((issue) => !shown.some((prefix) => startsWith(issue.path, prefix)));
}

type Params = Readonly<Record<string, string | number>>;

/** Messages for the API's issue codes (see `ApiIssue` in shared/admin-api.ts). */
const ISSUE_MESSAGES: Readonly<Record<string, (params: Params) => AdminKey | null>> = {
	too_small: ({ origin, minimum }) =>
		origin === "string" ? (minimum === 1 ? "admin.issue.required" : "admin.issue.tooShort") : origin === "array" ? "admin.issue.tooFew" : "admin.issue.tooSmall",
	too_big: ({ origin }) => (origin === "string" ? "admin.issue.tooLong" : origin === "array" ? "admin.issue.tooMany" : "admin.issue.tooBig"),
	invalid_format: ({ format }) => (format === "url" ? "admin.issue.url" : format === "email" ? "admin.issue.email" : "admin.issue.format"),
	invalid_value: () => "admin.issue.oneOf",
	invalid_type: () => "admin.issue.type",
	unrecognized_keys: () => "admin.issue.unknownKeys",
	duplicate: () => "admin.issue.duplicate",
	nothing_to_change: () => "admin.issue.nothingToChange",
	ends_before_start: () => "admin.issue.endsBeforeStart",
	start_in_future: () => "admin.issue.startInFuture",
	unknown_needs_admin: () => "admin.issue.unknownNeedsAdmin",
	unknown_page: () => "admin.issue.unknownPage",
	page_removed: () => "admin.issue.pageRemoved",
	unknown_component: () => "admin.issue.unknownComponent",
	unknown_monitor: () => "admin.issue.unknownMonitor",
	unknown_kind: () => "admin.issue.unknownKind",
	kind_removed: () => "admin.issue.kindRemoved",
	secret_reentry_required: () => "admin.issue.secretReentryRequired",
	destination_not_public: () => "admin.issue.destinationNotPublic",
	https_required: () => "admin.issue.httpsRequired",
	hex_color: () => "admin.issue.hexColor",
	unknown_image: () => "admin.issue.unknownImage",
	uploads_unavailable: () => "admin.issue.uploadsUnavailable",
	nav_url: () => "admin.issue.navUrl",
	url_credentials: () => "admin.issue.urlCredentials",
	link_or_menu: () => "admin.issue.linkOrMenu",
	no_language: () => "admin.issue.noLanguage",
	too_many_languages: () => "admin.issue.tooManyLanguages",
	language_tag: () => "admin.issue.languageTag",
	duplicate_language: () => "admin.issue.duplicateLanguage",
	url_too_long: () => "admin.issue.urlTooLong",
	control_character: () => "admin.issue.controlCharacter",
};

/** An issue in the admin's language when its code is known, else the API's (English) message. */
export function issueText(issue: ApiIssue, t: AdminTranslate): string {
	const params = issue.params ?? {};
	const key = issue.code === undefined ? null : (ISSUE_MESSAGES[issue.code]?.(params) ?? null);
	return key === null ? issue.message : t(key, params);
}

/** The validation issues of an error (a 400 with issues), in the admin's language. */
export function issuesOf(error: unknown, t: AdminTranslate): readonly ApiIssue[] {
	return error instanceof AdminApiError ? error.issues.map((issue) => ({ ...issue, message: issueText(issue, t) })) : [];
}

/** An error in words, for a banner or an alert. */
export function errorText(error: unknown, t: AdminTranslate): string {
	if (error instanceof AdminApiError) {
		switch (error.code) {
			case "already_resolved":
				return t("admin.error.alreadyResolved");
			case "kind_not_registered":
				return t("admin.error.kindNotRegistered");
			case "payload_too_large":
				return t("admin.error.tooLarge");
			case "internal_error":
				return t("admin.error.internal");
			case "network":
				return t("admin.error.network");
			case "signed_out":
				return t("admin.error.signedOut");
			case "forbidden":
				return t("admin.error.forbidden");
			case "not_found":
				return t("admin.error.notFound");
			case "validation_failed":
				return t("admin.error.validation");
			case "encryption_key_missing":
				return t("admin.error.encryptionKey", { message: error.message });
			default:
				return t("admin.error.server", { message: error.message, status: error.status });
		}
	}
	return t("admin.error.unexpected", { message: error instanceof Error ? error.message : String(error) });
}

export function ErrorAlert({ error, onRetry }: { readonly error: unknown; readonly onRetry?: () => void }) {
	const { t } = useAdminI18n();
	if (error === null || error === undefined) return null;
	const signedOut = error instanceof AdminApiError && (error.code === "signed_out" || error.code === "forbidden");
	return (
		<div className="alert alert--error" role="alert">
			<Icon name="warning" />
			<div>
				<p>{errorText(error, t)}</p>
				{signedOut ? (
					<p>
						<button type="button" className="button button--small" onClick={() => window.location.reload()}>
							{t("admin.action.reloadPage")}
						</button>
					</p>
				) : (
					onRetry !== undefined && (
						<p>
							<button type="button" className="button button--small" onClick={onRetry}>
								{t("admin.action.retry")}
							</button>
						</p>
					)
				)}
			</div>
		</div>
	);
}

/** Issues no field shows, under the form's error. */
export function IssueSummary({ issues }: { readonly issues: readonly ApiIssue[] }) {
	if (issues.length === 0) return null;
	return (
		<ul className="issue-summary">
			{issues.map((issue) => (
				<li key={`${issue.path.join(".")}:${issue.message}`}>
					{issue.path.length > 0 && <code>{issue.path.join(".")}</code>} {issue.message}
				</li>
			))}
		</ul>
	);
}

export interface FieldProps {
	readonly label: ReactNode;
	readonly hint?: ReactNode;
	readonly errors?: readonly string[];
	/** Renders the control with the IDs it needs for its label, hint and errors. */
	readonly children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** A labelled control with a hint and its validation messages. */
export function Field({ label, hint, errors = [], children }: FieldProps) {
	const id = useId();
	const hintId = hint === undefined ? undefined : `${id}-hint`;
	const errorId = errors.length === 0 ? undefined : `${id}-error`;
	const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(" ") || undefined;
	return (
		<div className={`field${errors.length > 0 ? " field--invalid" : ""}`}>
			<label className="field__label" htmlFor={id}>
				{label}
			</label>
			{children({ id, describedBy, invalid: errors.length > 0 })}
			{hint !== undefined && (
				<p id={hintId} className="field__hint">
					{hint}
				</p>
			)}
			<FieldErrors id={errorId} errors={errors} />
		</div>
	);
}

export function FieldErrors({ id, errors }: { readonly id?: string; readonly errors: readonly string[] }) {
	if (errors.length === 0) return null;
	return (
		<ul id={id} className="field__errors">
			{errors.map((message) => (
				<li key={message}>{message}</li>
			))}
		</ul>
	);
}

/** A group of checkboxes or radio buttons. */
export function Fieldset({
	legend,
	hint,
	errors = [],
	children,
}: {
	readonly legend: ReactNode;
	readonly hint?: ReactNode;
	readonly errors?: readonly string[];
	readonly children: ReactNode;
}) {
	return (
		<fieldset className={`fieldset${errors.length > 0 ? " field--invalid" : ""}`}>
			<legend className="field__label">{legend}</legend>
			{hint !== undefined && <p className="field__hint">{hint}</p>}
			{children}
			<FieldErrors errors={errors} />
		</fieldset>
	);
}

/** "Saved" and similar confirmations, announced politely. */
export function Notice({ children }: { readonly children: ReactNode }) {
	return (
		<p className="alert alert--success" role="status">
			<Icon name="up" />
			<span>{children}</span>
		</p>
	);
}

/**
 * While `dirty`, asks before leaving the view: links and back/forward in the admin UI, and
 * closing or reloading the tab (warn before losing unsaved changes).
 */
export function useUnsavedChanges(dirty: boolean): void {
	const { t } = useAdminI18n();
	const latest = useRef({ dirty, question: "" });
	latest.current = { dirty, question: t("admin.form.leaveQuestion") };
	useEffect(() => addBlocker(() => (latest.current.dirty ? latest.current.question : null)), []);
}
