import { type FormEvent, useRef, useState } from "react";
import type { ApiIssue, AppearanceColors, PageAppearance, PageAppearanceInput, ResolvedFrame, ThemeColors, UploadedImage } from "../../../shared/admin-api";
import { contrastWarnings, effectiveColors, readableTextOn, TEMPLATE_COLORS } from "../../../shared/colors";
import { pickText } from "../../../shared/i18n/core";
import type { PageTemplate } from "../../../shared/public-api";
import {
	COLOR_ROLES,
	COLOR_SCHEMES,
	type ColorRole,
	type ColorScheme,
	FRAME_LIMITS,
	IMAGE_TYPES,
	imagePath,
	LIMITS,
	NO_COLORS,
} from "../../../shared/vocabulary";
import { type AdminTranslate, useAdminI18n } from "../messages";
import { AdminApiError, api, enc } from "../api";
import { ConflictNotice, useVersionedDraft } from "../conflict";
import { useAdmin, useSelectedPage } from "../context";
import { ErrorAlert, errorText, Field, FieldErrors, Fieldset, IssueSummary, issuesAt, issuesOf, Notice, otherIssues, useUnsavedChanges } from "../forms";
import { Loading, PagePicker, ViewHeader } from "../layout";
import { useLoad } from "../useLoad";
import {
	describeLinks,
	describeText,
	EMPTY_TEXT,
	FooterEditor,
	type FooterDraft,
	footerDraft,
	footerLinkCount,
	footerValue,
	headerDraft,
	headerLinkCount,
	headerValue,
	type LocalizedDraft,
	LocalizedInput,
	localizedDraft,
	localizedValue,
	NavEditor,
	type NavItemDraft,
	type Own,
	UseConfig,
} from "./frame-editors";

interface AppearanceDraft {
	readonly title: Own<LocalizedDraft>;
	readonly description: Own<LocalizedDraft>;
	readonly logoUrl: Own<string>;
	readonly websiteUrl: Own<string>;
	readonly logoImage: string | null;
	readonly faviconImage: string | null;
	readonly colors: AppearanceColors;
	readonly header: Own<readonly NavItemDraft[]>;
	readonly footer: Own<FooterDraft>;
}

const KEYS = ["title", "description", "logoUrl", "websiteUrl", "logoImage", "faviconImage", "colors", "header", "footer"] as const;

/** The fields status.config.ts can also set: `null` keeps its value. */
type FrameKey = "title" | "description" | "logoUrl" | "websiteUrl" | "header" | "footer";

const EMPTY_FOOTER_DRAFT: FooterDraft = { columns: [], links: [], text: EMPTY_TEXT };

/** Each frame field's draft: from the admin's value, or from status.config.ts's (to start editing it from). */
const FRAME_DRAFTS = {
	title: (frame: AdminFrameValues) => localizedDraft(frame.title),
	description: (frame: AdminFrameValues) => localizedDraft(frame.description),
	logoUrl: (frame: AdminFrameValues) => frame.logoUrl ?? "",
	websiteUrl: (frame: AdminFrameValues) => frame.websiteUrl ?? "",
	header: (frame: AdminFrameValues) => (frame.header === null ? [] : headerDraft(frame.header)),
	footer: (frame: AdminFrameValues) => (frame.footer === null ? EMPTY_FOOTER_DRAFT : footerDraft(frame.footer)),
} satisfies { readonly [K in FrameKey]: (frame: AdminFrameValues) => AppearanceDraft[K]["value"] };

/** What a field holds while it keeps status.config.ts's: always the same, so that it never counts as a change. */
const INHERITED: { readonly [K in FrameKey]: AppearanceDraft[K] } = {
	title: { own: false, value: EMPTY_TEXT },
	description: { own: false, value: EMPTY_TEXT },
	logoUrl: { own: false, value: "" },
	websiteUrl: { own: false, value: "" },
	header: { own: false, value: [] },
	footer: { own: false, value: EMPTY_FOOTER_DRAFT },
};

type AdminFrameValues = Pick<PageAppearance, FrameKey>;

function ownDraft<K extends FrameKey>(key: K, appearance: AdminFrameValues): AppearanceDraft[K] {
	if (appearance[key] === null) return INHERITED[key] as AppearanceDraft[K];
	return { own: true, value: FRAME_DRAFTS[key](appearance) } as AppearanceDraft[K];
}

function toDraft(appearance: PageAppearance): AppearanceDraft {
	return {
		title: ownDraft("title", appearance),
		description: ownDraft("description", appearance),
		logoUrl: ownDraft("logoUrl", appearance),
		websiteUrl: ownDraft("websiteUrl", appearance),
		logoImage: appearance.logoImage,
		faviconImage: appearance.faviconImage,
		colors: appearance.colors,
		header: ownDraft("header", appearance),
		footer: ownDraft("footer", appearance),
	};
}

/** status.config.ts's frame as the admin's values would be, to start editing a field from. */
function configValues(frame: ResolvedFrame): AdminFrameValues {
	return frame;
}

const EMPTY_FRAME: ResolvedFrame = {
	title: null,
	description: null,
	logoUrl: null,
	websiteUrl: null,
	header: { nav: [] },
	footer: { columns: [], links: [], text: null },
};

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

/** A page's title, description, logo, favicon, website, header and footer links and colours. */
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
					frame={page.frame}
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
	/** What status.config.ts sets, which a field keeps while the admin sets nothing. */
	readonly frame?: ResolvedFrame;
}

export function AppearanceForm({ appearance, onReload, template = "default", uploads = false, frame = EMPTY_FRAME }: AppearanceFormProps) {
	const { t, f, locale } = useAdminI18n();
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
		header: t("admin.frame.header"),
		footer: t("admin.frame.footer"),
	};

	async function submit(event: FormEvent) {
		event.preventDefault();
		const { draft } = edit;
		// `null` keeps status.config.ts's; an own field is sent as written, `""` clearing it.
		const input: PageAppearanceInput = {
			version: edit.base.version,
			title: draft.title.own ? localizedValue(draft.title.value) : null,
			description: draft.description.own ? localizedValue(draft.description.value) : null,
			logoUrl: draft.logoUrl.own ? draft.logoUrl.value.trim() : null,
			websiteUrl: draft.websiteUrl.own ? draft.websiteUrl.value.trim() : null,
			logoImage: draft.logoImage,
			faviconImage: draft.faviconImage,
			colors: draft.colors,
			header: draft.header.own ? headerValue(draft.header.value) : null,
			footer: draft.footer.own ? footerValue(draft.footer.value) : null,
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
	/**
	 * Keeps status.config.ts's value, or starts the admin's: from the value saved, if the admin
	 * had one, else from status.config.ts's, so that changing one link does not mean typing all.
	 */
	const setOwn = <K extends FrameKey>(key: K, own: boolean) =>
		edit.setDraft((draft) => {
			const saved = toDraft(edit.base)[key];
			const started = own ? (saved.own ? saved : { own: true, value: FRAME_DRAFTS[key](configValues(frame)) }) : INHERITED[key];
			return { ...draft, [key]: started };
		});
	const setValue = <K extends FrameKey>(key: K, value: AppearanceDraft[K]["value"]) => edit.setDraft((draft) => ({ ...draft, [key]: { own: true, value } }));
	/** A frame field's value in someone else's save, as text. */
	const conflictValue = (field: string, current: PageAppearance): string => {
		switch (field) {
			case "title":
			case "description":
				return current[field] === "" ? t("admin.frame.cleared") : (describeText(current[field], locale) ?? t("admin.frame.fromConfig"));
			case "logoUrl":
			case "websiteUrl":
				return current[field] === null ? t("admin.frame.fromConfig") : current[field] === "" ? t("admin.frame.cleared") : current[field];
			case "header":
				return current.header === null ? t("admin.frame.fromConfig") : describeLinks(headerLinkCount(current.header), t);
			case "footer":
				return current.footer === null ? t("admin.frame.fromConfig") : describeLinks(footerLinkCount(current.footer), t);
			case "colors":
				return describeColors(current.colors, t) ?? t("admin.appearance.default");
			default: {
				const value = current[field as (typeof KEYS)[number]];
				return typeof value === "string" ? value : t("admin.appearance.default");
			}
		}
	};
	const previewTitle = (edit.draft.title.own ? pickText(localizedValue(edit.draft.title.value), locale) : pickText(frame.title, locale)) || appearance.pageId;
	/** A URL field of the frame: status.config.ts's, or the admin's (empty: none). */
	const urlField = (key: "logoUrl" | "websiteUrl", hint: string) => (
		<Fieldset legend={labels[key]} hint={hint}>
			<UseConfig own={edit.draft[key].own} configured={frame[key]} onChange={(own) => setOwn(key, own)} />
			{edit.draft[key].own && (
				<div>
					<input
						type="url"
						aria-label={labels[key]}
						aria-invalid={issuesAt(issues, [key]).length > 0 || undefined}
						maxLength={LIMITS.url}
						placeholder="https://"
						value={edit.draft[key].value}
						onChange={(event) => setValue(key, event.target.value)}
					/>
					<FieldErrors errors={issuesAt(issues, [key])} />
				</div>
			)}
		</Fieldset>
	);
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
					value={(field) => conflictValue(field, conflict.current)}
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
				<Fieldset legend={labels["title"]} hint={t("admin.appearance.titleHint", { page: appearance.pageId })}>
					<UseConfig own={edit.draft.title.own} configured={describeText(frame.title, locale)} onChange={(own) => setOwn("title", own)} />
					{edit.draft.title.own && (
						<LocalizedInput
							label={labels["title"] ?? "title"}
							value={edit.draft.title.value}
							onChange={(value) => setValue("title", value)}
							path={["title"]}
							issues={issues}
							maxLength={LIMITS.appearanceTitle}
						/>
					)}
				</Fieldset>
				<Fieldset legend={labels["description"]} hint={t("admin.appearance.descriptionHint")}>
					<UseConfig own={edit.draft.description.own} configured={describeText(frame.description, locale)} onChange={(own) => setOwn("description", own)} />
					{edit.draft.description.own && (
						<LocalizedInput
							label={labels["description"] ?? "description"}
							value={edit.draft.description.value}
							onChange={(value) => setValue("description", value)}
							path={["description"]}
							issues={issues}
							maxLength={LIMITS.appearanceDescription}
							multiline
						/>
					)}
				</Fieldset>
				{!uploads && <p className="field__hint">{t("admin.appearance.uploadsUnavailable")}</p>}
				{imageField("logoImage", t("admin.appearance.logoImageHint", { size: LIMITS.imageBytes / 1024 }))}
				{urlField("logoUrl", t("admin.appearance.logoHint"))}
				{imageField("faviconImage", t("admin.appearance.faviconHint", { size: LIMITS.imageBytes / 1024 }))}
				{urlField("websiteUrl", t("admin.appearance.websiteHint"))}
				<Fieldset legend={labels["header"]} hint={t("admin.frame.headerHint", { max: FRAME_LIMITS.navItems })}>
					<UseConfig own={edit.draft.header.own} configured={describeLinks(headerLinkCount(frame.header), t)} onChange={(own) => setOwn("header", own)} />
					{edit.draft.header.own && (
						<>
							<p className="field__hint">{t("admin.frame.urlHint")}</p>
							<NavEditor nav={edit.draft.header.value} onChange={(nav) => setValue("header", nav)} issues={issues} />
						</>
					)}
				</Fieldset>
				<Fieldset legend={labels["footer"]} hint={t("admin.frame.footerHint")}>
					<UseConfig
						own={edit.draft.footer.own}
						configured={[describeLinks(footerLinkCount(frame.footer), t), describeText(frame.footer.text, locale)].filter((part) => part !== null).join(" · ")}
						onChange={(own) => setOwn("footer", own)}
					/>
					{edit.draft.footer.own && (
						<>
							<p className="field__hint">{t("admin.frame.urlHint")}</p>
							<FooterEditor footer={edit.draft.footer.value} onChange={(footer) => setValue("footer", footer)} issues={issues} />
						</>
					)}
				</Fieldset>
				<ColorsFieldset
					template={template}
					colors={edit.draft.colors}
					title={previewTitle}
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
