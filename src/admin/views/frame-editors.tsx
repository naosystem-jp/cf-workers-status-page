/**
 * Editors of a page's frame in the appearance form: texts written once for every language
 * or per language, a field's "use status.config.ts's" switch, and the lists of links of the
 * header and footer (add, remove, reorder, a menu's links).
 *
 * Drafts are shaped for editing, and convert to the API's values on save (`…Value`): `null`
 * keeps status.config.ts's, `""` or an empty list clears it (shared/admin-api.ts). Lists are
 * sent as they are, blank rows included, so that the API's issues (located by index) point at
 * the rows the admin sees.
 */
import type { ReactNode } from "react";
import type { ApiIssue, LocalizedText, ResolvedFooter, ResolvedHeader, ResolvedNavLink } from "../../../shared/admin-api";
import { pickText } from "../../../shared/i18n/core";
import { FRAME_LIMITS } from "../../../shared/vocabulary";
import { UI_LOCALES } from "../../i18n/catalog";
import { type AdminTranslate, useAdminI18n } from "../messages";
import { FieldErrors, type IssuePath, issuesAt } from "../forms";

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** A text being edited: one for every language, or one per language (blank: that language left out). */
export interface LocalizedDraft {
	readonly byLanguage: boolean;
	readonly text: string;
	readonly texts: Readonly<Record<string, string>>;
}

export const EMPTY_TEXT: LocalizedDraft = { byLanguage: false, text: "", texts: {} };

export function localizedDraft(value: LocalizedText | null): LocalizedDraft {
	if (value === null) return EMPTY_TEXT;
	return typeof value === "string" ? { byLanguage: false, text: value, texts: {} } : { byLanguage: true, text: "", texts: value };
}

/** The text to send: trimmed, languages left blank left out (none at all: `{}`, which the API refuses). */
export function localizedValue(draft: LocalizedDraft): LocalizedText {
	if (!draft.byLanguage) return draft.text.trim();
	return Object.fromEntries(
		Object.entries(draft.texts)
			.map(([tag, text]) => [tag, text.trim()] as const)
			.filter(([, text]) => text !== ""),
	);
}

/** A field that status.config.ts can also set: its value is the admin's only when `own`. */
export interface Own<T> {
	readonly own: boolean;
	readonly value: T;
}

export interface LinkDraft {
	readonly label: LocalizedDraft;
	readonly url: string;
}

export interface NavItemDraft {
	readonly kind: "link" | "menu";
	readonly label: LocalizedDraft;
	/** A link's. */
	readonly url: string;
	/** A menu's. */
	readonly items: readonly LinkDraft[];
}

export interface ColumnDraft {
	readonly title: LocalizedDraft;
	readonly links: readonly LinkDraft[];
}

export interface FooterDraft {
	readonly columns: readonly ColumnDraft[];
	readonly links: readonly LinkDraft[];
	readonly text: LocalizedDraft;
}

const EMPTY_LINK: LinkDraft = { label: EMPTY_TEXT, url: "" };

function linkDraft(link: ResolvedNavLink): LinkDraft {
	return { label: localizedDraft(link.label), url: link.url };
}

function linkValue(link: LinkDraft): { label: LocalizedText; url: string } {
	return { label: localizedValue(link.label), url: link.url.trim() };
}

export function headerDraft(header: ResolvedHeader): readonly NavItemDraft[] {
	return header.nav.map((item) =>
		"items" in item
			? { kind: "menu", label: localizedDraft(item.label), url: "", items: item.items.map(linkDraft) }
			: { kind: "link", label: localizedDraft(item.label), url: item.url, items: [] },
	);
}

export function headerValue(nav: readonly NavItemDraft[]) {
	return {
		nav: nav.map((item) =>
			item.kind === "menu" ? { label: localizedValue(item.label), items: item.items.map(linkValue) } : { label: localizedValue(item.label), url: item.url.trim() },
		),
	};
}

export function footerDraft(footer: ResolvedFooter): FooterDraft {
	return {
		columns: footer.columns.map((column) => ({ title: localizedDraft(column.title), links: column.links.map(linkDraft) })),
		links: footer.links.map(linkDraft),
		text: localizedDraft(footer.text),
	};
}

export function footerValue(footer: FooterDraft) {
	const text = localizedValue(footer.text);
	const empty = typeof text === "string" ? text === "" : Object.keys(text).length === 0;
	return {
		columns: footer.columns.map((column) => ({ title: localizedValue(column.title), links: column.links.map(linkValue) })),
		links: footer.links.map(linkValue),
		...(empty ? {} : { text }),
	};
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

/** The languages to write a text in: the status page's, then any other the text has. */
function languagesOf(draft: LocalizedDraft): string[] {
	return [...UI_LOCALES, ...Object.keys(draft.texts).filter((tag) => !UI_LOCALES.includes(tag))];
}

function languageName(tag: string, locale: string): string {
	try {
		return new Intl.DisplayNames([locale], { type: "language" }).of(tag) ?? tag;
	} catch {
		return tag;
	}
}

/** A text of the config, or an admin's, as one line for a hint or a summary. */
export function describeText(value: LocalizedText | null, locale: string): string | null {
	if (value === null || typeof value === "string") return value;
	return Object.entries(value)
		.map(([tag, text]) => `${languageName(tag, locale)}: ${text}`)
		.join(" / ");
}

export interface LocalizedInputProps {
	/** The text's name, for the inputs' labels. */
	readonly label: string;
	readonly value: LocalizedDraft;
	readonly onChange: (value: LocalizedDraft) => void;
	/** Where the API locates this text's issues. */
	readonly path: IssuePath;
	readonly issues: readonly ApiIssue[];
	readonly maxLength: number;
	readonly multiline?: boolean;
	/** For the one-language input: its `id`, which a visible label names. */
	readonly id?: string;
	readonly describedBy?: string | undefined;
}

/**
 * A text for every language, or per language (a switch). Switching to per language starts every
 * language from the text; switching back keeps the text of the admin's language.
 */
export function LocalizedInput({ label, value, onChange, path, issues, maxLength, multiline = false, id, describedBy }: LocalizedInputProps) {
	const { t, locale } = useAdminI18n();
	const errors = issuesAt(issues, path);
	const invalid = errors.length > 0 || undefined;
	const input = (props: { id?: string | undefined; ariaLabel?: string; text: string; set: (text: string) => void }) =>
		multiline ? (
			<textarea
				id={props.id}
				aria-label={props.ariaLabel}
				aria-describedby={describedBy}
				aria-invalid={invalid}
				rows={2}
				maxLength={maxLength}
				value={props.text}
				onChange={(event) => props.set(event.target.value)}
			/>
		) : (
			<input
				id={props.id}
				aria-label={props.ariaLabel}
				aria-describedby={describedBy}
				aria-invalid={invalid}
				maxLength={maxLength}
				value={props.text}
				onChange={(event) => props.set(event.target.value)}
			/>
		);
	return (
		<div className="localized">
			{value.byLanguage ? (
				<div className="localized__languages">
					{languagesOf(value).map((tag) => (
						<label key={tag} className="localized__language">
							<span className="localized__tag" title={languageName(tag, locale)}>
								{tag}
							</span>
							{input({
								ariaLabel: t("admin.frame.inLanguage", { field: label, language: languageName(tag, locale) }),
								text: value.texts[tag] ?? "",
								set: (text) => onChange({ ...value, texts: { ...value.texts, [tag]: text } }),
							})}
						</label>
					))}
				</div>
			) : (
				input({ id, ...(id === undefined ? { ariaLabel: label } : {}), text: value.text, set: (text) => onChange({ ...value, text }) })
			)}
			<label className="check localized__switch">
				<input
					type="checkbox"
					checked={value.byLanguage}
					onChange={(event) =>
						onChange(
							event.target.checked
								? { byLanguage: true, text: "", texts: Object.fromEntries(UI_LOCALES.map((tag) => [tag, value.text])) }
								: { byLanguage: false, text: pickText(localizedValue(value), locale) ?? "", texts: {} },
						)
					}
				/>
				{t("admin.frame.byLanguage")}
			</label>
			<FieldErrors errors={errors} />
		</div>
	);
}

/** The "use status.config.ts's" switch of a field, with what status.config.ts sets. */
export function UseConfig({ own, configured, onChange }: { readonly own: boolean; readonly configured: string | null; readonly onChange: (own: boolean) => void }) {
	const { t } = useAdminI18n();
	return (
		<div className="use-config">
			<label className="check">
				<input type="checkbox" checked={!own} onChange={(event) => onChange(!event.target.checked)} />
				{t("admin.frame.useConfig")}
			</label>
			<p className="field__hint">{configured === null ? t("admin.frame.configNone") : t("admin.frame.configValue", { value: configured })}</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Lists of links
// ---------------------------------------------------------------------------

/** Moves the entry at `index` by `by` (−1: up, +1: down). */
function moved<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
	const result = [...list];
	const [entry] = result.splice(index, 1);
	if (entry !== undefined) result.splice(index + by, 0, entry);
	return result;
}

function replaced<T>(list: readonly T[], index: number, entry: T): T[] {
	return list.map((current, at) => (at === index ? entry : current));
}

/** Up, down and remove for the entry `index` of a list of `length`, named `name` for screen readers. */
function RowActions({ name, index, length, onMove, onRemove }: { readonly name: string; readonly index: number; readonly length: number; onMove(by: -1 | 1): void; onRemove(): void }) {
	const { t } = useAdminI18n();
	return (
		<div className="row-actions">
			<button type="button" className="button button--small" disabled={index === 0} aria-label={t("admin.frame.moveUpOf", { name })} onClick={() => onMove(-1)}>
				↑
			</button>
			<button type="button" className="button button--small" disabled={index === length - 1} aria-label={t("admin.frame.moveDownOf", { name })} onClick={() => onMove(1)}>
				↓
			</button>
			<button type="button" className="button button--small" aria-label={t("admin.frame.removeOf", { name })} onClick={onRemove}>
				{t("admin.frame.remove")}
			</button>
		</div>
	);
}

function UrlInput({ name, value, onChange, path, issues }: { readonly name: string; readonly value: string; onChange(url: string): void; readonly path: IssuePath; readonly issues: readonly ApiIssue[] }) {
	const { t } = useAdminI18n();
	const errors = issuesAt(issues, path);
	return (
		<div className="link-row__url">
			<input
				type="text"
				inputMode="url"
				aria-label={t("admin.frame.urlOf", { name })}
				aria-invalid={errors.length > 0 || undefined}
				maxLength={FRAME_LIMITS.url}
				placeholder="https://"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<FieldErrors errors={errors} />
		</div>
	);
}

/** A list of links: label and URL each, reorderable, at most `max`. */
function LinkList({
	links,
	onChange,
	max,
	path,
	issues,
	name,
	listName,
}: {
	readonly links: readonly LinkDraft[];
	onChange(links: LinkDraft[]): void;
	readonly max: number;
	readonly path: IssuePath;
	readonly issues: readonly ApiIssue[];
	/** A link's name for screen readers, by its number. */
	name(number: number): string;
	/** The list's name, for its "Add a link" button. */
	readonly listName: string;
}) {
	const { t } = useAdminI18n();
	return (
		<div className="link-list">
			{links.length > 0 && (
				<ol className="link-list__rows">
					{links.map((link, index) => (
						<li key={index} className="link-row">
							<LocalizedInput
								label={t("admin.frame.labelOf", { name: name(index + 1) })}
								value={link.label}
								onChange={(label) => onChange(replaced(links, index, { ...link, label }))}
								path={[...path, index, "label"]}
								issues={issues}
								maxLength={FRAME_LIMITS.label}
							/>
							<UrlInput name={name(index + 1)} value={link.url} onChange={(url) => onChange(replaced(links, index, { ...link, url }))} path={[...path, index, "url"]} issues={issues} />
							<RowActions
								name={name(index + 1)}
								index={index}
								length={links.length}
								onMove={(by) => onChange(moved(links, index, by))}
								onRemove={() => onChange(links.filter((_, at) => at !== index))}
							/>
						</li>
					))}
				</ol>
			)}
			<FieldErrors errors={issuesExactlyAt(issues, path)} />
			<p>
				<button
					type="button"
					className="button button--small"
					disabled={links.length >= max}
					aria-label={t("admin.frame.addLinkTo", { name: listName })}
					onClick={() => onChange([...links, EMPTY_LINK])}
				>
					{t("admin.frame.addLink")}
				</button>
			</p>
		</div>
	);
}

/** Issues located exactly at `path` (not below it): those of a list as a whole, say. */
function issuesExactlyAt(issues: readonly ApiIssue[], path: IssuePath): string[] {
	return issues.filter((issue) => issue.path.length === path.length && issue.path.every((segment, index) => String(segment) === String(path[index]))).map((issue) => issue.message);
}

/** The header's navigation: links and menus of links. */
export function NavEditor({ nav, onChange, issues }: { readonly nav: readonly NavItemDraft[]; onChange(nav: NavItemDraft[]): void; readonly issues: readonly ApiIssue[] }) {
	const { t } = useAdminI18n();
	const base: IssuePath = ["header", "nav"];
	const add = (kind: NavItemDraft["kind"]) => onChange([...nav, { kind, label: EMPTY_TEXT, url: "", items: kind === "menu" ? [EMPTY_LINK] : [] }]);
	return (
		<div className="link-list">
			{nav.length === 0 && <p className="muted">{t("admin.frame.noLinks")}</p>}
			{nav.length > 0 && (
				<ol className="link-list__rows">
					{nav.map((item, index) => {
						const name = t(item.kind === "menu" ? "admin.frame.menuNumber" : "admin.frame.linkNumber", { number: index + 1 });
						const set = (entry: NavItemDraft) => onChange(replaced(nav, index, entry));
						return (
							<li key={index} className={`link-row${item.kind === "menu" ? " link-row--menu" : ""}`}>
								<p className="link-row__kind">{name}</p>
								<LocalizedInput
									label={t("admin.frame.labelOf", { name })}
									value={item.label}
									onChange={(label) => set({ ...item, label })}
									path={[...base, index, "label"]}
									issues={issues}
									maxLength={FRAME_LIMITS.label}
								/>
								{item.kind === "link" ? (
									<UrlInput name={name} value={item.url} onChange={(url) => set({ ...item, url })} path={[...base, index, "url"]} issues={issues} />
								) : (
									<div className="link-row__menu">
										<p className="field__hint">{t("admin.frame.menuItems", { max: FRAME_LIMITS.menuItems })}</p>
										<LinkList
											links={item.items}
											onChange={(items) => set({ ...item, items })}
											max={FRAME_LIMITS.menuItems}
											path={[...base, index, "items"]}
											issues={issues}
											name={(number) => t("admin.frame.menuLinkNumber", { menu: name, number })}
											listName={name}
										/>
									</div>
								)}
								<FieldErrors errors={issuesExactlyAt(issues, [...base, index])} />
								<RowActions
									name={name}
									index={index}
									length={nav.length}
									onMove={(by) => onChange(moved(nav, index, by))}
									onRemove={() => onChange(nav.filter((_, at) => at !== index))}
								/>
							</li>
						);
					})}
				</ol>
			)}
			<FieldErrors errors={issuesExactlyAt(issues, base)} />
			<p className="actions">
				<button type="button" className="button button--small" disabled={nav.length >= FRAME_LIMITS.navItems} onClick={() => add("link")}>
					{t("admin.frame.addLink")}
				</button>
				<button type="button" className="button button--small" disabled={nav.length >= FRAME_LIMITS.navItems} onClick={() => add("menu")}>
					{t("admin.frame.addMenu")}
				</button>
			</p>
		</div>
	);
}

/** The footer: columns of links, a line of links and a line of text. */
export function FooterEditor({ footer, onChange, issues }: { readonly footer: FooterDraft; onChange(footer: FooterDraft): void; readonly issues: readonly ApiIssue[] }) {
	const { t } = useAdminI18n();
	return (
		<div className="footer-editor">
			<Section title={t("admin.frame.columns", { max: FRAME_LIMITS.footerColumns })}>
				{footer.columns.length > 0 && (
					<ol className="link-list__rows">
						{footer.columns.map((column, index) => {
							const name = t("admin.frame.columnNumber", { number: index + 1 });
							const set = (entry: ColumnDraft) => onChange({ ...footer, columns: replaced(footer.columns, index, entry) });
							return (
								<li key={index} className="link-row link-row--menu">
									<p className="link-row__kind">{name}</p>
									<LocalizedInput
										label={t("admin.frame.titleOf", { name })}
										value={column.title}
										onChange={(title) => set({ ...column, title })}
										path={["footer", "columns", index, "title"]}
										issues={issues}
										maxLength={FRAME_LIMITS.label}
									/>
									<div className="link-row__menu">
										<LinkList
											links={column.links}
											onChange={(links) => set({ ...column, links })}
											max={FRAME_LIMITS.columnLinks}
											path={["footer", "columns", index, "links"]}
											issues={issues}
											name={(number) => t("admin.frame.menuLinkNumber", { menu: name, number })}
											listName={name}
										/>
									</div>
									<RowActions
										name={name}
										index={index}
										length={footer.columns.length}
										onMove={(by) => onChange({ ...footer, columns: moved(footer.columns, index, by) })}
										onRemove={() => onChange({ ...footer, columns: footer.columns.filter((_, at) => at !== index) })}
									/>
								</li>
							);
						})}
					</ol>
				)}
				<FieldErrors errors={issuesExactlyAt(issues, ["footer", "columns"])} />
				<p>
					<button
						type="button"
						className="button button--small"
						disabled={footer.columns.length >= FRAME_LIMITS.footerColumns}
						onClick={() => onChange({ ...footer, columns: [...footer.columns, { title: EMPTY_TEXT, links: [EMPTY_LINK] }] })}
					>
						{t("admin.frame.addColumn")}
					</button>
				</p>
			</Section>
			<Section title={t("admin.frame.footerLinks", { max: FRAME_LIMITS.footerLinks })}>
				<LinkList
					links={footer.links}
					onChange={(links) => onChange({ ...footer, links })}
					max={FRAME_LIMITS.footerLinks}
					path={["footer", "links"]}
					issues={issues}
					name={(number) => t("admin.frame.menuLinkNumber", { menu: t("admin.frame.footerLinksName"), number })}
					listName={t("admin.frame.footerLinksName")}
				/>
			</Section>
			<Section title={t("admin.frame.footerText")}>
				<p className="field__hint">{t("admin.frame.footerTextHint")}</p>
				<LocalizedInput
					label={t("admin.frame.footerText")}
					value={footer.text}
					onChange={(text) => onChange({ ...footer, text })}
					path={["footer", "text"]}
					issues={issues}
					maxLength={FRAME_LIMITS.footerText}
					multiline
				/>
			</Section>
		</div>
	);
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
	return (
		<section className="footer-editor__section">
			<h3 className="footer-editor__title">{title}</h3>
			{children}
		</section>
	);
}

/** A header or footer as one line, for a hint or a conflict: how many links. */
export function describeLinks(count: number, t: AdminTranslate): string {
	return count === 0 ? t("admin.frame.noLinks") : t("admin.frame.linkCount", { count });
}

export function headerLinkCount(header: ResolvedHeader): number {
	return header.nav.reduce((count, item) => count + ("items" in item ? item.items.length : 1), 0);
}

export function footerLinkCount(footer: ResolvedFooter): number {
	return footer.columns.reduce((count, column) => count + column.links.length, 0) + footer.links.length;
}
