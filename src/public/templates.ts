/**
 * The template a page uses, before its status has arrived: from the list the page's HTML carries
 * (written by the build: vite.pages.ts, or the package's Vite plugin), so that its loading screen
 * is in its own template. `null` when the HTML does not say (a page that is not configured, or
 * HTML built without the list): the default template's screens then, as the page cannot know.
 * Once the status has arrived, the page shows in the template the status names.
 */
import { PAGE_TEMPLATES_META, parsePageTemplates } from "@naosystem/cf-workers-status-page-core";
import type { PageTemplate } from "../../shared/public-api";

/** The template of the page `pageId`, or of the site's root page for `null`. */
export function expectedTemplate(pageId: string | null): PageTemplate | null {
	const content = document.querySelector<HTMLMetaElement>(`meta[name="${PAGE_TEMPLATES_META}"]`)?.content;
	const pages = content === undefined ? [] : parsePageTemplates(content);
	const page = pageId === null ? pages[0] : pages.find((candidate) => candidate.id === pageId);
	return page?.template ?? null;
}

/** The template of the page at `pathname`, by the status page's routes (src/App.tsx). */
export function expectedTemplateAt(pathname: string): PageTemplate | null {
	if (pathname === "/") return expectedTemplate(null);
	const [first, pageId] = pathname.split("/").filter((segment) => segment !== "");
	if (first !== "pages" || pageId === undefined) return null;
	try {
		return expectedTemplate(decodeURIComponent(pageId));
	} catch {
		return null;
	}
}
