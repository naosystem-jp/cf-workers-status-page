/**
 * The admin API (`/api/admin/*`) and the gate in front of the admin UI (`/admin`,
 * `/admin/*`). Routes are listed in {@link ROUTES} and documented in the README.
 *
 * Every request is authenticated first, whatever its method and path, and a failure gets
 * the same 403 everywhere, so unauthenticated callers learn nothing about what exists. Then cross-site requests are rejected (see csrf.ts), and the schema of
 * the D1 database is brought up to date before the first query.
 */
import adminHtml from "virtual:cf-workers-status-page/admin-html";
import { ensureSchema } from "../db/schema";
import { ADMIN_AUTH, type AdminAuthOptions, authenticateAdmin, authorName } from "./auth";
import type { AdminContext } from "./context";
import { crossSiteReason } from "./csrf";
import { apiError, forbidden, notFound } from "./http";
import * as incidents from "./incidents";
import * as maintenance from "./maintenance";
import * as monitors from "./monitors";
import * as notifications from "./notifications";
import * as pages from "./pages";

type Handler = (admin: AdminContext) => Promise<Response>;

interface Route {
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Path segments after `/api/admin/`; `:name` matches one segment as a parameter. */
	readonly path: string;
	readonly handler: Handler;
	/** Whether the handler uses D1. */
	readonly db: boolean;
}

export const ROUTES: readonly Route[] = [
	{ method: "GET", path: "me", handler: pages.me, db: false },
	{ method: "GET", path: "pages", handler: pages.pages, db: false },
	{ method: "GET", path: "pages/:pageId/appearance", handler: pages.getPageAppearance, db: true },
	{ method: "PUT", path: "pages/:pageId/appearance", handler: pages.putPageAppearance, db: true },
	{ method: "POST", path: "pages/:pageId/images", handler: pages.uploadImage, db: false },
	{ method: "GET", path: "incidents", handler: incidents.list, db: true },
	{ method: "POST", path: "incidents", handler: incidents.create, db: true },
	{ method: "GET", path: "incidents/:id", handler: incidents.get, db: true },
	{ method: "PATCH", path: "incidents/:id", handler: incidents.patch, db: true },
	{ method: "DELETE", path: "incidents/:id", handler: incidents.remove, db: true },
	{ method: "POST", path: "incidents/:id/updates", handler: incidents.postUpdate, db: true },
	{ method: "POST", path: "incidents/:id/resolve", handler: incidents.resolve, db: true },
	{ method: "GET", path: "maintenance", handler: maintenance.list, db: true },
	{ method: "POST", path: "maintenance", handler: maintenance.create, db: true },
	{ method: "GET", path: "maintenance/:id", handler: maintenance.get, db: true },
	{ method: "PATCH", path: "maintenance/:id", handler: maintenance.patch, db: true },
	{ method: "DELETE", path: "maintenance/:id", handler: maintenance.remove, db: true },
	{ method: "GET", path: "monitors", handler: monitors.list, db: false },
	{ method: "DELETE", path: "monitors/:id", handler: monitors.purge, db: false },
	{ method: "GET", path: "notifications/kinds", handler: notifications.kinds, db: false },
	{ method: "GET", path: "notifications/targets", handler: notifications.list, db: true },
	{ method: "POST", path: "notifications/targets", handler: notifications.create, db: true },
	{ method: "GET", path: "notifications/targets/:id", handler: notifications.get, db: true },
	{ method: "PATCH", path: "notifications/targets/:id", handler: notifications.patch, db: true },
	{ method: "DELETE", path: "notifications/targets/:id", handler: notifications.remove, db: true },
	{ method: "POST", path: "notifications/targets/:id/test", handler: notifications.test, db: true },
	{ method: "GET", path: "notifications/deliveries", handler: notifications.deliveries, db: true },
	{ method: "POST", path: "notifications/re-encrypt", handler: notifications.reEncrypt, db: true },
];

const API_PREFIX = "/api/admin";

export function isAdminApiPath(pathname: string): boolean {
	return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/** The admin UI's paths: they go through the Worker (`run_worker_first` in wrangler.jsonc). */
export function isAdminUiPath(pathname: string): boolean {
	return pathname === "/admin" || pathname.startsWith("/admin/");
}

function match(pattern: string, segments: readonly string[]): Record<string, string> | undefined {
	const parts = pattern.split("/");
	if (parts.length !== segments.length) return undefined;
	const params: Record<string, string> = {};
	for (const [index, part] of parts.entries()) {
		const segment = segments[index] as string;
		if (part.startsWith(":")) params[part.slice(1)] = segment;
		else if (part !== segment) return undefined;
	}
	return params;
}

/** Path segments after the prefix, decoded; `undefined` when one cannot be decoded. */
function segmentsOf(pathname: string): string[] | undefined {
	try {
		return pathname
			.slice(API_PREFIX.length)
			.split("/")
			.filter((segment) => segment !== "")
			.map(decodeURIComponent);
	} catch {
		return undefined;
	}
}

/** Handles a request under `/api/admin`. */
export async function handleAdminApi(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	options: AdminAuthOptions = ADMIN_AUTH,
): Promise<Response> {
	const identity = await authenticateAdmin(request, env, ctx, options);
	if (identity === null) return forbidden();
	if (crossSiteReason(request) !== null) {
		return apiError(403, "cross_site_request", "Requests from other sites are not accepted");
	}

	const url = new URL(request.url);
	const segments = segmentsOf(url.pathname);
	if (segments === undefined) return notFound();
	const matching = ROUTES.flatMap((route) => {
		const params = match(route.path, segments);
		return params === undefined ? [] : [{ route, params }];
	});
	if (matching.length === 0) return notFound();
	// HEAD is GET without the body.
	const head = request.method === "HEAD";
	const method = head ? "GET" : request.method;
	const found = matching.find(({ route }) => route.method === method);
	if (found === undefined) {
		const methods = matching.map(({ route }) => route.method);
		const allow = (methods.includes("GET") ? [...methods, "HEAD"] : methods).join(", ");
		return apiError(405, "method_not_allowed", `Use ${allow}`, { headers: { Allow: allow } });
	}

	let response: Response;
	try {
		if (found.route.db) await ensureSchema(env.DB);
		response = await found.route.handler({
			request,
			url,
			env,
			ctx,
			params: found.params,
			identity,
			actor: { kind: "admin", name: authorName(identity) },
		});
	} catch (error) {
		console.error(`Admin API ${request.method} ${url.pathname} failed`, error);
		response = apiError(500, "internal_error", "Something went wrong; see the Worker's logs");
	}
	return head ? new Response(null, response) : response;
}

/**
 * The directory of the admin UI's HTML entry under the dev server (`ADMIN_HTML` in
 * vite.admin.ts); the asset handling redirects `…/index.html` to it.
 */
const ADMIN_HTML_DEV_PATH = "/src/admin/";

/** On the admin UI's responses: not cached, not framed (clickjacking), not indexed. */
const ADMIN_UI_HEADERS = {
	"Cache-Control": "no-store",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "frame-ancestors 'none'",
	"X-Robots-Tag": "noindex",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "same-origin",
} as const;

/**
 * The admin UI's Content-Security-Policy in a build: its own scripts, styles and API only, so
 * that an injected script (from text an administrator or a notified service wrote) cannot run.
 * Not under the dev server, whose HTML has inline scripts (Vite's client, React refresh); there
 * only `frame-ancestors` applies.
 */
export const ADMIN_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * Serves the admin UI to administrators only. It is its own entry, separate from the public
 * SPA, and in a build its HTML is part of the Worker, not a static asset (see vite.admin.ts),
 * so this is the only way to get it. Its scripts and styles under `/assets/` are public
 * static files, like the public SPA's: they are the open-source code of the UI and hold no
 * data; everything the admin UI shows comes from the admin API.
 */
export async function serveAdminUi(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	options: AdminAuthOptions = ADMIN_AUTH,
	html: string | null = adminHtml,
): Promise<Response> {
	const identity = await authenticateAdmin(request, env, ctx, options);
	if (identity === null) {
		return new Response("Forbidden: sign in as an administrator to open the admin UI.\n", {
			status: 403,
			headers: { "Content-Type": "text/plain; charset=utf-8", ...ADMIN_UI_HEADERS },
		});
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method Not Allowed\n", {
			status: 405,
			headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8", ...ADMIN_UI_HEADERS },
		});
	}
	// Every path under /admin gets the same page; the admin UI routes on the client.
	let response: Response;
	if (html !== null) {
		response = new Response(request.method === "HEAD" ? null : html, {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	} else {
		// Under the dev server: Vite serves the entry with its dev transforms.
		const asset = await env.ASSETS.fetch(new Request(new URL(ADMIN_HTML_DEV_PATH, request.url), request));
		response = new Response(asset.body, asset);
	}
	for (const [name, value] of Object.entries(ADMIN_UI_HEADERS)) response.headers.set(name, value);
	if (html !== null) response.headers.set("Content-Security-Policy", ADMIN_CSP);
	return response;
}
