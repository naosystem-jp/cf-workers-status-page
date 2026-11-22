/**
 * Modules that the published Worker code imports and the user's build provides (see vite.ts):
 * the user's status.config.ts, and the admin UI's HTML from the package's client build.
 */
export const CONFIG_MODULE = "virtual:cf-workers-status-page/config";
export const ADMIN_HTML_MODULE = "virtual:cf-workers-status-page/admin-html";
