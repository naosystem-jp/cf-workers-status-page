import { type FormEvent, useRef, useState } from "react";
import type { ApiIssue, AppearanceColors, PageAppearance, PageAppearanceInput, ThemeColors, UploadedImage } from "../../../shared/admin-api";
import { contrastWarnings, effectiveColors, readableTextOn, TEMPLATE_COLORS } from "../../../shared/colors";
import type { PageTemplate } from "../../../shared/public-api";
import {
	COLOR_ROLES,
	COLOR_SCHEMES,
	type ColorRole,
	type ColorScheme,
	IMAGE_TYPES,
	imagePath,
	LIMITS,
	NO_COLORS,
} from "../../../shared/vocabulary";
import { type AdminTranslate, useAdminI18n } from "../messages";
import { AdminApiError, api, enc } from "../api";
import { ConflictNotice, useVersionedDraft } from "../conflict";
import { useAdmin, useSelectedPage } from "../context";
import { ErrorAlert, errorText, Field, Fieldset, IssueSummary, issuesAt, issuesOf, Notice, otherIssues, useUnsavedChanges } from "../forms";
import { Loading, PagePicker, ViewHeader } from "../layout";
import { useLoad } from "../useLoad";

interface AppearanceDraft {
	readonly title: string;
	readonly description: string;
	readonly logoUrl: string;
	readonly websiteUrl: string;
	readonly logoImage: string | null;
	readonly faviconImage: string | null;
	readonly colors: AppearanceColors;
}

const KEYS = ["title", "description", "logoUrl", "websiteUrl", "logoImage", "faviconImage", "colors"] as const;

function toDraft(appearance: PageAppearance): AppearanceDraft {
	return {
		title: appearance.title ?? "",
		description: appearance.description ?? "",
		logoUrl: appearance.logoUrl ?? "",
		websiteUrl: appearance.websiteUrl ?? "",
		logoImage: appearance.logoImage,
		faviconImage: appearance.faviconImage,
		colors: appearance.colors,
	};
}

/** The colours set, as text ("Light: Background #ffffff, …"), or `null` for none. */
function describeColors(colors: AppearanceColors, t: AdminTranslate): string | null {
	const parts = COLOR_SCHEMES.flatMap((scheme) =>
		COLOR_ROLES.flatMap((role) => {
			const value = colors[scheme][role];
			return value === null ? [] : [`${t(`admin.appearance.scheme.${scheme}`)} ${t(`admin.appearance.role.${role}`)} ${value}`];
		}),
	);
	return parts.length === 0 ? null : parts.join(", ");
}

/** A page's title, description, logo, favicon, website and colours (one language). */
export function AppearanceView() {
	const { t } = useAdminI18n();
	const { uploads } = useAdmin();
	const { pageId, page } = useSelectedPage();
	const appearance = useLoad(pageId, (signal) => api.get<PageAppearance>(`/pages/${enc(pageId)}/appearance`, signal));
	return (
		<>
			<ViewHeader
				title={t("admin.appearance.title")}
				actions={
					<a className="button" href={`/pages/${enc(pageId)}`} target="_blank" rel="noopener">
						{t("admin.viewStatusPage")}
					</a>
				}
			>
				<div className="filters">
					<PagePicker />
				</div>
				<p className="field__hint">{t("admin.appearance.intro")}</p>
			</ViewHeader>
			{page === undefined ? (
				<p className="empty">{t("admin.page.notConfigured", { page: pageId })}</p>
			) : appearance.data === undefined || appearance.data.pageId !== pageId ? (
				// Never another page's appearance: saving it would overwrite this page's.
				appearance.error === null ? <Loading /> : <ErrorAlert error={appearance.error} onRetry={appearance.reload} />
			) : (
				<AppearanceForm
					key={appearance.data.pageId}
					appearance={appearance.data}
					onReload={appearance.reload}
					template={page.template}
					uploads={uploads}
				/>
			)}
		</>
	);
}

export interface AppearanceFormProps {
	readonly appearance: PageAppearance;
	readonly onReload: () => void;
	/** The page's template, which the colours are previewed and checked in. */
	readonly template?: PageTemplate;
	/** Whether images can be uploaded (the Worker has its R2 bucket). */
	readonly uploads?: boolean;
}

export function AppearanceForm({ appearance, onReload, template = "default", uploads = false }: AppearanceFormProps) {
	const { t, f } = useAdminI18n();
	const edit = useVersionedDraft(appearance, toDraft);
	if (appearance.version > edit.base.version && edit.conflict === null) edit.refresh(appearance);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [uploading, setUploading] = useState(0);
	const [saved, setSaved] = useState(false);
	const issues = issuesOf(error, t);
	useUnsavedChanges(edit.changed.length > 0);
	const labels: Readonly<Record<string, string>> = {
		title: t("admin.appearance.fieldTitle"),
		description: t("admin.appearance.description"),
		logoUrl: t("admin.appearance.logoUrl"),
		websiteUrl: t("admin.appearance.websiteUrl"),
		logoImage: t("admin.appearance.logoImage"),
		faviconImage: t("admin.appearance.favicon"),
		colors: t("admin.appearance.colors"),
	};

	async function submit(event: FormEvent) {
		event.preventDefault();
		const value = (text: string) => (text.trim() === "" ? null : text.trim());
		const input: PageAppearanceInput = {
			version: edit.base.version,
			title: value(edit.draft.title),
			description: value(edit.draft.description),
			logoUrl: value(edit.draft.logoUrl),
			websiteUrl: value(edit.draft.websiteUrl),
			logoImage: edit.draft.logoImage,
			faviconImage: edit.draft.faviconImage,
			colors: edit.draft.colors,
		};
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			edit.saved(await api.put<PageAppearance>(`/pages/${enc(appearance.pageId)}/appearance`, input));
			setSaved(true);
		} catch (caught) {
			if (!edit.handleError(caught)) setError(caught);
		} finally {
			setBusy(false);
		}
	}

	const conflict = edit.conflict;
	const setColors = (colors: AppearanceColors) => edit.setDraft((draft) => ({ ...draft, colors }));
	const imageField = (field: "logoImage" | "faviconImage", hint: string) => (
		<ImageField
			label={labels[field] ?? field}
			hint={hint}
			pageId={appearance.pageId}
			imageId={edit.draft[field]}
			uploads={uploads}
			errors={issuesAt(issues, [field])}
			onUploading={(delta) => setUploading((count) => count + delta)}
			onChange={(id) => edit.setDraft((draft) => ({ ...draft, [field]: id }))}
		/>
	);
	return (
		<>
			{conflict !== null && (
				<ConflictNotice
					conflict={conflict}
					label={(field) => labels[field] ?? field}
					value={(field) => {
						const current = conflict.current[field as (typeof KEYS)[number]];
						if (field === "colors") return describeColors(current as AppearanceColors, t) ?? t("admin.appearance.default");
						return typeof current === "string" ? current : t("admin.appearance.default");
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
				<IssueSummary issues={otherIssues(issues, KEYS.map((key) => [key]))} />
				{saved && edit.changed.length === 0 && <Notice>{t("admin.form.saved")}</Notice>}
				{edit.base.updatedAt !== null && (
					<p className="field__hint">
						{t("admin.common.lastChange", {
							who: edit.base.updatedBy ?? t("admin.common.automation"),
							time: f.dateTimeWithZone(edit.base.updatedAt),
						})}
					</p>
				)}
				<Field label={labels["title"]} hint={t("admin.appearance.titleHint", { page: appearance.pageId })} errors={issuesAt(issues, ["title"])}>
					{({ id, describedBy, invalid }) => (
						<input
							id={id}
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							maxLength={LIMITS.appearanceTitle}
							value={edit.draft.title}
							onChange={(event) => {
								const title = event.target.value;
								edit.setDraft((draft) => ({ ...draft, title }));
							}}
						/>
					)}
				</Field>
				<Field label={labels["description"]} hint={t("admin.appearance.descriptionHint")} errors={issuesAt(issues, ["description"])}>
					{({ id, describedBy, invalid }) => (
						<textarea
							id={id}
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							rows={3}
							maxLength={LIMITS.appearanceDescription}
							value={edit.draft.description}
							onChange={(event) => {
								const description = event.target.value;
								edit.setDraft((draft) => ({ ...draft, description }));
							}}
						/>
					)}
				</Field>
				{!uploads && <p className="field__hint">{t("admin.appearance.uploadsUnavailable")}</p>}
				{imageField("logoImage", t("admin.appearance.logoImageHint", { size: LIMITS.imageBytes / 1024 }))}
				<Field label={labels["logoUrl"]} hint={t("admin.appearance.logoHint")} errors={issuesAt(issues, ["logoUrl"])}>
					{({ id, describedBy, invalid }) => (
						<input
							id={id}
							type="url"
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							maxLength={LIMITS.url}
							placeholder="https://"
							value={edit.draft.logoUrl}
							onChange={(event) => {
								const logoUrl = event.target.value;
								edit.setDraft((draft) => ({ ...draft, logoUrl }));
							}}
						/>
					)}
				</Field>
				{imageField("faviconImage", t("admin.appearance.faviconHint", { size: LIMITS.imageBytes / 1024 }))}
				<Field label={labels["websiteUrl"]} hint={t("admin.appearance.websiteHint")} errors={issuesAt(issues, ["websiteUrl"])}>
					{({ id, describedBy, invalid }) => (
						<input
							id={id}
							type="url"
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							maxLength={LIMITS.url}
							placeholder="https://"
							value={edit.draft.websiteUrl}
							onChange={(event) => {
								const websiteUrl = event.target.value;
								edit.setDraft((draft) => ({ ...draft, websiteUrl }));
							}}
						/>
					)}
				</Field>
				<ColorsFieldset
					template={template}
					colors={edit.draft.colors}
					title={edit.draft.title.trim() || appearance.pageId}
					issues={issues}
					onChange={setColors}
				/>
				<div className="actions">
					<button
						type="submit"
						className="button button--primary"
						disabled={busy || uploading > 0 || edit.changed.length === 0 || conflict !== null}
					>
						{t("admin.form.save")}
					</button>
					{edit.changed.length > 0 && <span className="muted">{t("admin.form.unsaved")}</span>}
				</div>
			</form>
		</>
	);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Media types by file extension, for files the browser gives no type (often icons). */
const TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
};

/** The media type to upload `file` as, or `null` when it is not an accepted image. */
export function uploadTypeOf(file: File): string | null {
	const type = file.type.toLowerCase();
	if (Object.hasOwn(IMAGE_TYPES, type)) return type;
	if (type !== "") return null;
	const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
	return TYPES_BY_EXTENSION[extension] ?? null;
}

const ACCEPT = [...Object.keys(IMAGE_TYPES), ".ico"].join(",");

/** An upload's error in words. */
function uploadErrorText(error: unknown, t: AdminTranslate): string {
	if (error instanceof AdminApiError) {
		switch (error.code) {
			case "invalid_image":
				return t("admin.appearance.imageInvalid");
			case "unsupported_media_type":
				return t("admin.appearance.imageType");
			case "payload_too_large":
				return t("admin.appearance.imageTooLarge", { size: LIMITS.imageBytes / 1024 });
			case "uploads_unavailable":
				return t("admin.appearance.uploadsUnavailable");
		}
	}
	return errorText(error, t);
}

interface ImageFieldProps {
	readonly label: string;
	readonly hint: string;
	readonly pageId: string;
	readonly imageId: string | null;
	readonly uploads: boolean;
	readonly errors: readonly string[];
	/** +1 when an upload starts, −1 when it ends: the form is not saved meanwhile. */
	readonly onUploading: (delta: 1 | -1) => void;
	readonly onChange: (imageId: string | null) => void;
}

/**
 * An uploaded image of the appearance: the file is uploaded as soon as it is chosen, and the
 * form then names it (saved with the form, see worker/uploads.ts).
 */
function ImageField({ label, hint, pageId, imageId, uploads, errors, onUploading, onChange }: ImageFieldProps) {
	const { t } = useAdminI18n();
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	async function choose(file: File) {
		setProblem(null);
		const type = uploadTypeOf(file);
		if (type === null) return setProblem(t("admin.appearance.imageType"));
		if (file.size > LIMITS.imageBytes) return setProblem(t("admin.appearance.imageTooLarge", { size: LIMITS.imageBytes / 1024 }));
		setBusy(true);
		onUploading(1);
		try {
			const image = await api.upload<UploadedImage>(`/pages/${enc(pageId)}/images`, file, type);
			onChange(image.id);
		} catch (caught) {
			setProblem(uploadErrorText(caught, t));
		} finally {
			setBusy(false);
			onUploading(-1);
			// The same file can be chosen again.
			if (input.current !== null) input.current.value = "";
		}
	}

	return (
		<Field label={label} hint={hint} errors={problem === null ? errors : [...errors, problem]}>
			{({ id, describedBy, invalid }) => (
				<div className="image-field">
					{imageId !== null && uploads && (
						<img className="image-field__preview" src={imagePath(pageId, imageId)} alt={t("admin.appearance.currentImage", { label })} />
					)}
					<div className="input-row">
						<input
							ref={input}
							id={id}
							type="file"
							accept={ACCEPT}
							aria-describedby={describedBy}
							aria-invalid={invalid || undefined}
							disabled={!uploads || busy}
							onChange={(event) => {
								const file = event.target.files?.[0];
								if (file !== undefined) void choose(file);
							}}
						/>
						{imageId !== null && (
							<button type="button" className="button button--small" disabled={busy} onClick={() => onChange(null)}>
								{t("admin.appearance.removeImage")}
							</button>
						)}
					</div>
					{busy && (
						<p className="muted" role="status">
							{t("admin.appearance.uploading")}
						</p>
					)}
				</div>
			)}
		</Field>
	);
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

interface ColorsFieldsetProps {
	readonly template: PageTemplate;
	readonly colors: AppearanceColors;
	/** Shown in the preview. */
	readonly title: string;
	readonly issues: readonly ApiIssue[];
	readonly onChange: (colors: AppearanceColors) => void;
}

/** Background, header and accent, for light and dark, with a preview and contrast warnings. */
function ColorsFieldset({ template, colors, title, issues, onChange }: ColorsFieldsetProps) {
	const { t } = useAdminI18n();
	const set = (scheme: ColorScheme, role: ColorRole, value: string | null) =>
		onChange({ ...colors, [scheme]: { ...colors[scheme], [role]: value } });
	const warnings = COLOR_SCHEMES.flatMap((scheme) =>
		contrastWarnings(template, scheme, colors[scheme]).map((warning) =>
			t(warning.role === "background" ? "admin.appearance.contrastBackground" : "admin.appearance.contrastAccent", {
				scheme: t(`admin.appearance.scheme.${scheme}`),
				ratio: warning.ratio.toFixed(1),
			}),
		),
	);
	const anySet = describeColors(colors, t) !== null;
	return (
		<Fieldset legend={t("admin.appearance.colors")} hint={t("admin.appearance.colorsHint")} errors={issuesAt(issues, ["colors"])}>
			<table className="color-table">
				<thead>
					<tr>
						<td />
						{COLOR_SCHEMES.map((scheme) => (
							<th key={scheme} scope="col">
								{t(`admin.appearance.scheme.${scheme}`)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{COLOR_ROLES.map((role) => (
						<tr key={role}>
							<th scope="row">
								{t(`admin.appearance.role.${role}`)}
								<span className="field__hint color-table__hint">{t(`admin.appearance.roleHint.${role}`)}</span>
							</th>
							{COLOR_SCHEMES.map((scheme) => (
								<td key={scheme}>
									<ColorInput
										scheme={t(`admin.appearance.scheme.${scheme}`)}
										label={`${t(`admin.appearance.role.${role}`)} (${t(`admin.appearance.scheme.${scheme}`)})`}
										value={colors[scheme][role]}
										fallback={TEMPLATE_COLORS[template][scheme][role] ?? TEMPLATE_COLORS.modern[scheme][role] ?? "#000000"}
										onChange={(value) => set(scheme, role, value)}
									/>
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{template !== "modern" && <p className="field__hint">{t("admin.appearance.headerModernOnly")}</p>}
			<div className="color-previews">
				{COLOR_SCHEMES.map((scheme) => (
					<ColorPreview key={scheme} template={template} scheme={scheme} colors={colors[scheme]} title={title} />
				))}
			</div>
			{warnings.length > 0 && (
				<ul className="field__warnings">
					{warnings.map((warning) => (
						<li key={warning}>{warning}</li>
					))}
				</ul>
			)}
			{anySet && (
				<p>
					<button type="button" className="button button--small" onClick={() => onChange(NO_COLORS)}>
						{t("admin.appearance.resetColors")}
					</button>
				</p>
			)}
		</Fieldset>
	);
}

interface ColorInputProps {
	/** The colour scheme's name, shown where the table's head is not (narrow screens). */
	readonly scheme: string;
	readonly label: string;
	/** `null`: the template's colour. */
	readonly value: string | null;
	/** What the picker starts from while `value` is `null`: the template's colour. */
	readonly fallback: string;
	readonly onChange: (value: string | null) => void;
}

function ColorInput({ scheme, label, value, fallback, onChange }: ColorInputProps) {
	const { t } = useAdminI18n();
	return (
		<div className="color-input">
			<span className="color-input__scheme" aria-hidden="true">
				{scheme}
			</span>
			<input type="color" aria-label={label} value={value ?? fallback} onChange={(event) => onChange(event.target.value.toLowerCase())} />
			<code className={value === null ? "muted" : undefined}>{value ?? t("admin.appearance.colorDefault")}</code>
			{value !== null && (
				<button
					type="button"
					className="button button--small"
					aria-label={t("admin.appearance.resetColorOf", { color: label })}
					onClick={() => onChange(null)}
				>
					{t("admin.appearance.resetColor")}
				</button>
			)}
		</div>
	);
}

/**
 * The page's top in one colour scheme, as the template shows it with these colours: background,
 * header (the modern template), text and a link. Styles are set through the CSSOM (React's
 * `style`), which the admin UI's Content-Security-Policy allows.
 */
function ColorPreview({ template, scheme, colors, title }: { readonly template: PageTemplate; readonly scheme: ColorScheme; readonly colors: ThemeColors; readonly title: string }) {
	const { t } = useAdminI18n();
	const own = TEMPLATE_COLORS[template][scheme];
	const shown = effectiveColors(template, scheme, colors);
	return (
		<figure className="color-preview">
			<figcaption className="field__hint">{t("admin.appearance.preview", { scheme: t(`admin.appearance.scheme.${scheme}`) })}</figcaption>
			<div className="color-preview__page" style={{ background: shown.background, color: own.textOnBackground }} aria-hidden="true">
				{shown.header === null ? (
					<p className="color-preview__title" style={{ color: own.text }}>
						{title}
					</p>
				) : (
					<p className="color-preview__header" style={{ background: shown.header, color: readableTextOn(shown.header) }}>
						{title}
					</p>
				)}
				<div className="color-preview__surface" style={{ background: own.surface ?? shown.background, color: own.text }}>
					{t("admin.appearance.previewText")}{" "}
					<span className="color-preview__link" style={{ color: shown.accent }}>
						{t("admin.appearance.previewLink")}
					</span>
				</div>
			</div>
		</figure>
	);
}
