/**
 * The templates of status pages, and which one each page uses, as the status page's HTML
 * carries it: a build writes it into the page's <head> (vite.pages.ts, and the package's Vite
 * plugin), so that a page shows its loading screen in its own template before the public API
 * answers (src/public/templates.ts). Once the API has answered, the page is shown in the
 * template the API names.
 *
 * `<meta name="cf-workers-status-page:templates" content="default:modern,internal:default">`:
 * the pages in the order of status.config.ts (the first one is the site's root), each as
 * `id:template`. Every page's ID is public already (`GET /api/pages`).
 *
 * Without Zod, so that the status page's bundle can read it.
 */
import type { StatusConfig } from "./config";

/** How a status page looks. */
export const PAGE_TEMPLATES = ["default", "modern"] as const;
export type PageTemplate = (typeof PAGE_TEMPLATES)[number];
/** The template of a page that names none. */
export const DEFAULT_PAGE_TEMPLATE: PageTemplate = "default";

/** The `name` of the meta element that lists the pages' templates. */
export const PAGE_TEMPLATES_META = "cf-workers-status-page:templates";

export interface PageTemplateEntry {
	readonly id: string;
	readonly template: PageTemplate;
}

function isPageTemplate(value: unknown): value is PageTemplate {
	return (PAGE_TEMPLATES as readonly unknown[]).includes(value);
}

/**
 * A page ID (the rule of config.ts): lowercase letters, digits, `-` and `_`, which never need
 * escaping, in the list or in an HTML attribute.
 */
const PAGE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Each page's ID and template, in order, as the Worker will read them (a page that names no
 * template has the default one); `null` when a page is not valid, which the Worker reports
 * itself when it loads the configuration.
 */
export function pageTemplatesOf(config: StatusConfig): PageTemplateEntry[] | null {
	const pages: unknown = config.pages ?? [];
	if (!Array.isArray(pages)) return null;
	const entries: PageTemplateEntry[] = [];
	for (const page of pages) {
		if (typeof page !== "object" || page === null) return null;
		const { id, template = DEFAULT_PAGE_TEMPLATE } = page as { readonly id?: unknown; readonly template?: unknown };
		if (typeof id !== "string" || !PAGE_ID.test(id) || !isPageTemplate(template)) return null;
		entries.push({ id, template });
	}
	return entries;
}

/** The meta element's `content`. Throws on what cannot be a page's ID and template (a bug). */
export function formatPageTemplates(entries: readonly PageTemplateEntry[]): string {
	return entries
		.map(({ id, template }) => {
			if (!PAGE_ID.test(id) || !isPageTemplate(template)) throw new Error(`Not a page ID and template: ${JSON.stringify([id, template])}`);
			return `${id}:${template}`;
		})
		.join(",");
}

/** The pages in a meta element's `content`; none if any part is not a page (the site's root could not be told then). */
export function parsePageTemplates(content: string): PageTemplateEntry[] {
	if (content === "") return [];
	const entries: PageTemplateEntry[] = [];
	for (const part of content.split(",")) {
		const [id, template, ...rest] = part.split(":");
		if (id === undefined || !PAGE_ID.test(id) || !isPageTemplate(template) || rest.length > 0) return [];
		entries.push({ id, template });
	}
	return entries;
}

/**
 * `html` with the meta element listing `entries`, in its <head> (replacing one that is there
 * already). Throws if `html` has no `</head>`.
 */
export function withPageTemplates(html: string, entries: readonly PageTemplateEntry[]): string {
	const element = `<meta name="${PAGE_TEMPLATES_META}" content="${formatPageTemplates(entries)}">`;
	const without = html.replace(new RegExp(`[ \\t]*<meta name="${PAGE_TEMPLATES_META}" content="[^"]*">\\r?\\n?`, "g"), "");
	const head = /([ \t]*)<\/head>/i.exec(without);
	if (head === null) throw new Error("The HTML has no </head>");
	const indent = head[1] ?? "";
	return `${without.slice(0, head.index)}${indent}\t${element}\n${without.slice(head.index)}`;
}
