import type { AdminIdentity, ResolvedPage } from "@naosystem/cf-workers-status-page-core";
import type { ApiIssue } from "../../shared/admin-api";
import { findPage } from "../config";
import type { Actor } from "../db/common";
import { announcePublicPageChange, purgePublicPage } from "../public-cache";

/** What an admin API handler gets. */
export interface AdminContext {
	readonly request: Request;
	readonly url: URL;
	readonly env: Env;
	readonly ctx: ExecutionContext;
	/** Path parameters, such as `id` in `incidents/:id`. */
	readonly params: Readonly<Record<string, string>>;
	readonly identity: AdminIdentity;
	/** The identity as the author of changes. */
	readonly actor: Actor;
}

export { findPage };

/**
 * Issues for component IDs that `page` does not have (incidents and maintenance refer
 * to components by ID). `path(index)` locates each one in the request body.
 */
export function unknownComponents(
	page: ResolvedPage,
	ids: readonly string[],
	path: (index: number) => (string | number)[],
): ApiIssue[] {
	const known = new Set(page.components.map((component) => component.id));
	return ids.flatMap((id, index) =>
		known.has(id)
			? []
			: [
					{
						path: path(index),
						message: `Page "${page.id}" has no component "${id}"`,
						code: "unknown_component",
						params: { page: page.id, component: id },
					},
				],
	);
}

/**
 * Call before a write that changes what a public page shows, and {@link publicPageChanged}
 * after it (nothing computed in between is cached). Never fails the request.
 */
export async function publicPageChanging(admin: AdminContext, pageId: string): Promise<void> {
	await announcePublicPageChange({ env: admin.env, ctx: admin.ctx, pageId });
}

/**
 * Call after a write that changes what a public page shows: clears the page's cached public
 * responses. Never fails the request: the write happened, and what could not
 * be cleared expires within 30 seconds (`purgePublicPage` logs it).
 */
export async function publicPageChanged(
	admin: AdminContext,
	pageId: string,
	options: { readonly incidentsDeleted?: boolean } = {},
): Promise<void> {
	try {
		await purgePublicPage({ env: admin.env, ctx: admin.ctx, pageId, incidentsDeleted: options.incidentsDeleted === true });
	} catch (error) {
		console.warn(`Could not purge the cached public responses of page "${pageId}"`, error);
	}
}
