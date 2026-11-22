/**
 * What surrounds a status page's content, its "frame": the heading's texts (title,
 * description), the logo and the website it links to, the header's navigation and the footer.
 * Written in status.config.ts (`pages[]`), and replaceable per field in the admin UI, which
 * validates with the same schemas (shared/admin-api.ts).
 *
 * Data only, never HTML or components, so that the page keeps its Content-Security-Policy
 * (`script-src 'self'`, `style-src 'self'`) and the prebuilt client of the npm package can
 * show it.
 */
import * as z from "zod";

/**
 * A text an operator writes: one for every language (`"Docs"`), or one per language, by BCP 47
 * tag (`{ en: "Docs", ja: "ドキュメント" }`). A page shows the visitor's language, else English,
 * else the first one written.
 */
export type LocalizedText = string | { readonly [languageTag: string]: string };

/** Limits of a frame's texts and links. Lengths are in characters (UTF-16 code units). */
export const FRAME_LIMITS = {
	title: 100,
	description: 1_000,
	/** Entries of the header's navigation: links and menus. */
	navItems: 6,
	/** Links in a menu of the header's navigation. */
	menuItems: 10,
	footerColumns: 4,
	/** Links in a column of the footer. */
	columnLinks: 10,
	/** Links in the footer's line of links. */
	footerLinks: 10,
	/** A link's label, a menu's label, a column's title. */
	label: 50,
	url: 500,
	footerText: 500,
	/** Languages of a text written per language. */
	languages: 10,
	/**
	 * Largest admin API request that sets a page's appearance (`PUT
	 * /api/admin/pages/:pageId/appearance`), in bytes: above the largest frame these limits allow
	 * (FRAME_LIMITS tests check it), which other requests' 64 KiB is not.
	 */
	appearanceRequestBytes: 512 * 1024,
} as const;

export interface NavLink {
	label: LocalizedText;
	/**
	 * An `https:`, `http:` or `mailto:` URL, or a path on this site starting with `/` (another
	 * status page, say).
	 */
	url: string;
}

/** A button in the header's navigation that opens a list of links. Menus do not nest. */
export interface NavMenu {
	label: LocalizedText;
	/** At least one. */
	items: readonly NavLink[];
}

export type NavItem = NavLink | NavMenu;

export interface HeaderConfig {
	/** Links and menus, in order, at most 6. */
	nav?: readonly NavItem[];
}

export interface FooterColumn {
	title: LocalizedText;
	/** At least one, at most 10. */
	links: readonly NavLink[];
}

export interface FooterConfig {
	/** Columns of links under a title, at most 4. */
	columns?: readonly FooterColumn[];
	/** A line of links, at most 10. */
	links?: readonly NavLink[];
	/** A line of text, such as a copyright notice, at most 500 characters. */
	text?: LocalizedText;
}

export interface ResolvedNavLink {
	readonly label: LocalizedText;
	readonly url: string;
}

export interface ResolvedNavMenu {
	readonly label: LocalizedText;
	readonly items: readonly ResolvedNavLink[];
}

export type ResolvedNavItem = ResolvedNavLink | ResolvedNavMenu;

export interface ResolvedHeader {
	readonly nav: readonly ResolvedNavItem[];
}

export interface ResolvedFooterColumn {
	readonly title: LocalizedText;
	readonly links: readonly ResolvedNavLink[];
}

export interface ResolvedFooter {
	readonly columns: readonly ResolvedFooterColumn[];
	readonly links: readonly ResolvedNavLink[];
	readonly text: LocalizedText | null;
}

/**
 * A page's frame as status.config.ts sets it, before the administrators' changes. `null`:
 * not set (the default: the page's ID for the title, nothing for the others).
 */
export interface ResolvedFrame {
	readonly title: LocalizedText | null;
	readonly description: LocalizedText | null;
	/** https only. */
	readonly logoUrl: string | null;
	readonly websiteUrl: string | null;
	readonly header: ResolvedHeader;
	readonly footer: ResolvedFooter;
}

/** Whether a navigation entry is a menu (has `items`) rather than a link. */
export function isNavMenu(item: ResolvedNavItem): item is ResolvedNavMenu {
	return "items" in item;
}

/** A header without navigation. */
export const EMPTY_HEADER: ResolvedHeader = { nav: [] };

/** A footer with nothing but the page's own lines (time zone, language). */
export const EMPTY_FOOTER: ResolvedFooter = { columns: [], links: [], text: null };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A refinement's issue, with a code the admin UI translates (shared/admin-api.ts `ApiIssue`). */
function issue(message: string, code: string, path: PropertyKey[] = []) {
	return { code: "custom" as const, message, path, params: { code } };
}

/**
 * Control characters but tabs and line breaks: nothing a text needs, and JSON writes each as six
 * bytes (`\u0001`), which would let a text grow six times its length in the status response.
 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * A {@link LocalizedText} of at most `maxLength` characters per language, trimmed. Language
 * tags are written in their canonical form (`pt-br` → `pt-BR`). With `allowEmpty`, `""` is
 * accepted (an administrator clearing a text that status.config.ts sets); never an empty
 * text in one language: leave that language out instead.
 */
export function localizedTextSchema(maxLength: number, { allowEmpty = false }: { readonly allowEmpty?: boolean } = {}) {
	const text = z.string().trim().max(maxLength).refine((value) => !CONTROL_CHARACTER.test(value), {
		message: "must not contain control characters (other than tabs and line breaks)",
		params: { code: "control_character" },
	});
	// No transform in the options: a union reports the issues of the one option whose issues do
	// not abort, where they are, and a transform (a pipe) aborts. Otherwise it says "Invalid input".
	const byLanguage = z
		.record(z.string(), text.min(1))
		.superRefine((texts, ctx) => {
			const tags = Object.keys(texts);
			if (tags.length === 0) ctx.addIssue(issue("must have a text in at least one language", "no_language"));
			if (tags.length > FRAME_LIMITS.languages) {
				ctx.addIssue(issue(`must have at most ${FRAME_LIMITS.languages} languages`, "too_many_languages"));
			}
			const seen = new Set<string>();
			for (const tag of tags) {
				const name = canonicalTag(tag);
				if (name === undefined) {
					ctx.addIssue(issue(`"${tag}" is not a language tag; use one such as "en" or "ja"`, "language_tag", [tag]));
				} else if (seen.has(name)) {
					ctx.addIssue(issue(`language "${name}" is written twice`, "duplicate_language", [tag]));
				}
				if (name !== undefined) seen.add(name);
			}
		});
	return z
		.union([allowEmpty ? text : text.min(1), byLanguage])
		.transform((value): LocalizedText =>
			typeof value === "string" ? value : Object.fromEntries(Object.entries(value).map(([tag, item]) => [canonicalTag(tag) ?? tag, item])),
		);
}

/** The canonical form of a BCP 47 tag (`pt-br` → `pt-BR`), or `undefined` when it is not one. */
function canonicalTag(tag: string): string | undefined {
	try {
		return Intl.getCanonicalLocales(tag)[0];
	} catch {
		return undefined;
	}
}

const SITE = "https://site.invalid";

function parseUrl(value: string, base?: string): URL | null {
	try {
		return new URL(value, base);
	} catch {
		return null;
	}
}

/**
 * A link's URL: `https:`, `http:` or `mailto:` (never `javascript:` and the like), without
 * credentials, or a path on this site (`/`, `/pages/other`, but not `//host`, which is another
 * site). Written back as the URL parser normalises it, and limited in that form: encoding can
 * make a URL several times longer ("あ" is "%E3%81%82"), and the encoded URL is what is stored
 * and served.
 */
export const navUrlSchema = z
	.string()
	.trim()
	.min(1)
	.max(FRAME_LIMITS.url)
	.transform((value, ctx) => {
		if (value.startsWith("/")) {
			// Resolved against a placeholder: a path that leaves this site ("//host", "/\host") changes the origin.
			const url = parseUrl(value, SITE);
			const path = url?.href.slice(SITE.length);
			// The path as normalised must stay on this site too: removing dot segments can leave
			// one that starts with "//" ("/a/..//host", "/.//host"), another site. Resolving it
			// again must give the same URL, which is also what reading it back from D1 does.
			if (url === null || url.origin !== SITE || path === undefined || parseUrl(path, SITE)?.href !== url.href || path.startsWith("//")) {
				ctx.addIssue(issue('must be a path on this site, such as "/pages/other", or a full URL', "nav_url"));
				return z.NEVER;
			}
			return encodedLength(path, ctx);
		}
		const url = parseUrl(value);
		if (url === null || (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "mailto:")) {
			ctx.addIssue(issue('must be an https, http or mailto URL, or a path on this site starting with "/"', "nav_url"));
			return z.NEVER;
		}
		if (url.username !== "" || url.password !== "") {
			ctx.addIssue(issue("must not contain credentials", "url_credentials"));
			return z.NEVER;
		}
		return encodedLength(url.href, ctx);
	});

/** `url` when it is at most `FRAME_LIMITS.url` characters once encoded; else an issue. */
function encodedLength(url: string, ctx: z.core.$RefinementCtx): string {
	if (url.length <= FRAME_LIMITS.url) return url;
	ctx.addIssue({
		...issue(`must be at most ${FRAME_LIMITS.url} characters once encoded (it is ${url.length}; a character other than ASCII counts as its encoding, such as "%E3%81%82")`, "url_too_long"),
		params: { code: "url_too_long", maximum: FRAME_LIMITS.url },
	});
	return z.NEVER;
}

const labelSchema = localizedTextSchema(FRAME_LIMITS.label);

export const navLinkSchema = z.strictObject({ label: labelSchema, url: navUrlSchema });

/**
 * A link (`url`) or a menu (`items`). One object schema with both, rather than a union, so that
 * a problem in either is reported where it is (a union reports only that neither matched).
 */
const navItemSchema = z
	.strictObject({
		label: labelSchema,
		url: navUrlSchema.optional(),
		items: z.array(navLinkSchema).min(1).max(FRAME_LIMITS.menuItems).optional(),
	})
	.superRefine((item, ctx) => {
		if ((item.url === undefined) === (item.items === undefined)) {
			ctx.addIssue(issue('needs either "url" (a link) or "items" (a menu), not both', "link_or_menu"));
		}
	})
	.transform((item): ResolvedNavItem => (item.items === undefined ? { label: item.label, url: item.url ?? "" } : { label: item.label, items: item.items }));

export const headerSchema = z.strictObject({
	nav: z.array(navItemSchema).max(FRAME_LIMITS.navItems).default([]),
});

const footerColumnSchema = z.strictObject({
	title: labelSchema,
	links: z.array(navLinkSchema).min(1).max(FRAME_LIMITS.columnLinks),
});

export const footerSchema = z
	.strictObject({
		columns: z.array(footerColumnSchema).max(FRAME_LIMITS.footerColumns).default([]),
		links: z.array(navLinkSchema).max(FRAME_LIMITS.footerLinks).default([]),
		// `null` as the resolved footer has it: worker/db/appearance.ts stores that, and reads it
		// back with this schema.
		text: localizedTextSchema(FRAME_LIMITS.footerText).nullish(),
	})
	.transform((footer): ResolvedFooter => ({ columns: footer.columns, links: footer.links, text: footer.text ?? null }));
