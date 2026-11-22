/**
 * Cross-site request forgery protection for the admin API.
 *
 * Cloudflare Access keeps the session in the `CF_Authorization` cookie, whose SameSite
 * attribute is the Access administrator's choice and defaults to `None`, so browsers send it
 * with requests from other sites, and Access lets them through. The Worker therefore rejects
 * cross-site requests itself:
 *
 * - `Sec-Fetch-Site` (sent by current browsers) must be `same-origin`, or `none` (typed in
 *   the address bar) for reads;
 * - `Origin`, when present, must be the Worker's own origin;
 * - requests with a body must be `Content-Type: application/json`, which an HTML form cannot
 *   send and a cross-origin `fetch` cannot send without a CORS preflight, which this API
 *   never approves (it sends no CORS headers). See {@link isJsonRequest}.
 *
 * Requests with neither header come from outside a browser (curl, an Access service token)
 * and are allowed: browsers send at least one of them on every cross-site request that
 * could change something.
 */

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** Why `request` looks cross-site, or `null` when it does not. */
export function crossSiteReason(request: Request): string | null {
	const safe = SAFE_METHODS.has(request.method);
	const site = request.headers.get("Sec-Fetch-Site");
	if (site !== null && site !== "same-origin" && !(safe && site === "none")) return `Sec-Fetch-Site is ${site}`;
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== new URL(request.url).origin) return "Origin is another site";
	return null;
}

/** Whether the request declares a JSON body (`application/json`, with or without parameters). */
export function isJsonRequest(request: Request): boolean {
	const type = request.headers.get("Content-Type");
	return type !== null && type.split(";")[0]?.trim().toLowerCase() === "application/json";
}
