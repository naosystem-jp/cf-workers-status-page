/**
 * Writes of what a public page shows, made by automation (automatic incidents), go
 * through {@link writePublicPageContent}: one place that runs what must happen before the write
 * and clears the page's cached public responses after it.
 */
import { announcePublicPageChange, type PurgeTarget, purgePublicPage } from "./public-cache";

/**
 * Announces the change to the page (so nothing computed across it is cached), runs `write`,
 * then clears `target.pageId`'s cached public responses. Neither step ever fails the write:
 * what could not be cleared expires within 30 seconds (both functions log their failures).
 * Returns what `write` returns.
 */
export async function writePublicPageContent<T>(target: PurgeTarget, write: () => Promise<T>): Promise<T> {
	await announcePublicPageChange(target);
	const result = await write();
	try {
		await purgePublicPage(target);
	} catch (error) {
		console.warn(`Could not purge the cached public responses of page "${target.pageId}"`, error);
	}
	return result;
}
