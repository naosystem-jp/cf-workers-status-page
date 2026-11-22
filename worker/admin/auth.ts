/**
 * Who may use the admin UI and the admin API.
 *
 * Every admin request is authenticated here, before its path is looked at, by the `auth`
 * provider of status.config.ts. Without one, every admin request is rejected: a
 * missing setting must not leave the admin API open.
 *
 * ## Local-development bypass
 *
 * For working on the admin UI without Cloudflare Access, `npm run dev` can let requests
 * through as the administrator `local-dev`. It applies only when both hold:
 *
 * 1. It was compiled in: `__ADMIN_DEV_BYPASS__` is `true` only under Vite's dev server, and
 *    only when the developer opted in with `ADMIN_DEV_BYPASS=1` (in `.env.development.local`
 *    or the shell). vite.admin.ts decides it from Vite's command, so every build (`vite
 *    build`, which every deploy runs) compiles the constant `false`, whatever the mode,
 *    `NODE_ENV` or variables. A Worker bundled without Vite has no such constant: `false`.
 * 2. The request's host name is a loopback name (`localhost`, `127.x.x.x`, `[::1]`), taken
 *    from the URL the runtime received, not from a header. Under the dev server, Vite also
 *    rejects host names it does not allow.
 *
 * No request header can switch it on. Caveat: started with `vite --host`, the dev server is
 * reachable from the network, and a client there can send `Host: localhost`; do not opt in
 * while exposing the dev server.
 *
 * ## Host names
 *
 * With `adminHosts` in status.config.ts, a request for any other host name (from the URL the
 * runtime received) is rejected like a failed sign-in, before the provider sees it. That keeps
 * the admin out of reach on a `*.workers.dev` URL that Cloudflare Access does not protect,
 * where a leaked or revoked Access token would otherwise still be accepted until it expires.
 */
import type { AdminIdentity, AuthProvider } from "@naosystem/cf-workers-status-page-core";
import { config } from "../config";

/** Whether the bypass is compiled in (see the module documentation). Always `false` in a build. */
export const DEV_BYPASS_ENABLED: boolean = typeof __ADMIN_DEV_BYPASS__ === "boolean" && __ADMIN_DEV_BYPASS__;

/** The administrator the bypass signs in as. */
export const DEV_IDENTITY: AdminIdentity = { id: "local-dev" };

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Whether the local-development bypass lets `request` through, when it is `enabled`. */
export function devBypassApplies(request: Request, enabled: boolean): boolean {
	// The URL the runtime received the request for, not a Host or Forwarded header.
	return enabled && isLoopback(new URL(request.url).hostname);
}

export interface AdminAuthOptions {
	/** The configured provider; `undefined` rejects every request. */
	readonly auth: AuthProvider | undefined;
	/** Whether the local-development bypass is compiled in. */
	readonly devBypass: boolean;
	/** Hosts (`URL.host`, lowercase) the admin answers on; `null` or omitted for any (`adminHosts`). */
	readonly hosts?: readonly string[] | null;
}

export const ADMIN_AUTH: AdminAuthOptions = { auth: config.auth, devBypass: DEV_BYPASS_ENABLED, hosts: config.adminHosts };

/** Whether `request` is for a host the admin answers on (see the module documentation). */
export function adminHostAllowed(request: Request, hosts: readonly string[] | null | undefined): boolean {
	return hosts === null || hosts === undefined || hosts.includes(new URL(request.url).host.toLowerCase());
}

let warnedNoAuth = false;
let warnedBypass = false;
let warnedHost = false;

/**
 * The administrator making `request`, or `null` to reject it. Never throws: a provider that
 * throws rejects the request.
 */
export async function authenticateAdmin(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	options: AdminAuthOptions = ADMIN_AUTH,
): Promise<AdminIdentity | null> {
	if (devBypassApplies(request, options.devBypass)) {
		if (!warnedBypass) {
			warnedBypass = true;
			console.warn("Admin authentication is bypassed for local development (ADMIN_DEV_BYPASS=1).");
		}
		return DEV_IDENTITY;
	}
	if (!adminHostAllowed(request, options.hosts)) {
		if (!warnedHost) {
			warnedHost = true;
			console.warn("Admin request rejected: its host name is not in `adminHosts` of status.config.ts.");
		}
		return null;
	}
	if (options.auth === undefined) {
		if (!warnedNoAuth) {
			warnedNoAuth = true;
			console.warn("Admin request rejected: status.config.ts has no `auth`, so the admin UI and admin API are closed.");
		}
		return null;
	}
	try {
		return await options.auth.authenticate(request, {
			env: env as unknown as Readonly<Record<string, unknown>>,
			// Called as a method of the context, the global fetch would lose its `this`.
			fetch: (input, init) => fetch(input, init),
			waitUntil: (promise) => ctx.waitUntil(promise),
		});
	} catch (error) {
		console.error(`Admin authentication failed (${options.auth.type})`, error);
		return null;
	}
}

/** How an administrator is recorded as author: the email address, else the identity's ID. */
export function authorName(identity: AdminIdentity): string {
	return identity.email ?? identity.id;
}
