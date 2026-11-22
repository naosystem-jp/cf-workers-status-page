// Compile-time values from vite.admin.ts.

/**
 * Whether the local-development bypass of admin authentication is compiled in: `true` only
 * under Vite's dev server with `ADMIN_DEV_BYPASS=1`, `false` in every build. Undeclared when
 * the Worker is bundled without Vite (check with `typeof`).
 */
declare const __ADMIN_DEV_BYPASS__: boolean | undefined;

declare module "virtual:cf-workers-status-page/admin-html" {
	/** The admin UI's built HTML; `null` under the dev server and in tests, where it comes from Vite. */
	const html: string | null;
	export default html;
}
