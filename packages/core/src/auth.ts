/** An administrator who passed authentication. */
export interface AdminIdentity {
	/**
	 * Stable identifier from the identity provider, such as the Access `sub` claim (or a
	 * service token's client ID).
	 */
	readonly id: string;
	readonly email?: string;
}

/**
 * What the hub hands to an auth provider for one request. Typed without runtime-specific
 * types so that auth providers can live in packages. Later versions may add members;
 * providers must not rely on the object having only these.
 */
export interface AuthContext {
	/**
	 * Bindings, variables and secrets of the hosting Worker (`env`). Values are `unknown`
	 * here; an implementation checks the shape of what it uses.
	 */
	readonly env: Readonly<Record<string, unknown>>;
	/**
	 * For outbound requests, such as fetching signing keys. Use this, not the global `fetch`
	 * (the hub may wrap it, and tests replace it).
	 */
	readonly fetch: typeof fetch;
	/** Keeps the request alive for background work, such as refreshing cached signing keys. */
	waitUntil(promise: Promise<unknown>): void;
}

/**
 * Pluggable authentication for the admin UI and the admin API.
 *
 * Only the contract is defined here. Implementations (Cloudflare Access, other providers
 * later) live in their own packages, such as `@naosystem/cf-workers-status-page-auth-cloudflare-access`.
 * Without an auth provider in the configuration, the hub rejects every admin request.
 *
 * The hub calls `authenticate` for every admin request, before it looks at the path, so a
 * provider must verify the request itself (signatures, audience, expiry) and never trust a
 * header just because it is present.
 */
export interface AuthProvider {
	/** Identifier such as `"cloudflare-access"`. */
	readonly type: string;
	/**
	 * Returns the administrator making `request`, or `null` to reject the request. Throwing
	 * also rejects it (the hub logs the error).
	 */
	authenticate(request: Request, ctx: AuthContext): Promise<AdminIdentity | null>;
}
