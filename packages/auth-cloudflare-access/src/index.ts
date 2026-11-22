/**
 * Cloudflare Access authentication for the admin UI and admin API.
 *
 * Put a Cloudflare Access application in front of `/admin` and `/api/admin` (path-scoped,
 * so the public status page stays open), then configure it here:
 *
 * ```ts
 * auth: cloudflareAccess({
 *   teamDomain: "myteam.cloudflareaccess.com",
 *   aud: "<Application Audience (AUD) tag>",
 *   allowedDomains: ["example.com"],   // optional second check, see below
 * })
 * ```
 *
 * None of these values is secret. Access passes the signed-in user's token to the Worker in
 * the `Cf-Access-Jwt-Assertion` header, and this provider verifies it itself, because a
 * Worker that serves static assets does not get `ctx.access`, and so that a mistake in the
 * Access configuration cannot open the admin API:
 *
 * - the signature, with RS256 only (the token's `alg` is not trusted to choose), against
 *   the team's public keys from `https://<teamDomain>/cdn-cgi/access/certs`, matched by `kid`;
 * - `iss` is `https://<teamDomain>`, `aud` contains one of the configured tags;
 * - `exp` has not passed and `nbf` has, with {@link CLOCK_TOLERANCE_MS} of tolerance;
 * - with any of `allowedEmails`, `allowedDomains` or `allowedServiceTokens` set, the identity
 *   must be on one of them: a user by email address or its domain, an Access service token
 *   by its client ID. This guards against an Access policy that admits too many people.
 *   Without them, everyone the Access application admits is an administrator, service
 *   tokens included.
 *
 * The identity is the token's `sub` and `email`; for an Access service token, which has
 * neither, its `common_name` (the client ID).
 *
 * Signing keys are cached in memory. Access publishes the current and the previous key and
 * rotates every 6 weeks, keeping the previous key valid for 7 days, so the cache is
 * refreshed in the background every {@link KEYS_FRESH_MS}; a token with a key ID the cache
 * does not have triggers a refresh at most every {@link UNKNOWN_KEY_REFETCH_MS}. Requests
 * that need keys while a fetch is in progress wait for it rather than start another, and
 * after a failed fetch there is no new attempt for {@link KEY_FETCH_BACKOFF_MS}, so tokens
 * crafted to pass the claim checks cannot make every request fetch. When keys cannot be
 * fetched, cached keys are used for at most {@link KEYS_MAX_AGE_MS}, then every request is
 * rejected until the keys can be fetched again (fail closed).
 */
import type { AdminIdentity, AuthContext, AuthProvider } from "@naosystem/cf-workers-status-page-core";
import { ALGORITHM, type DecodedToken, decodeToken, importKeySet, type KeyMap, TokenError, verifySignature } from "./jwt";

/** The header Access adds to requests it lets through. Validated instead of the `CF_Authorization` cookie, as Cloudflare recommends. */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** Clock skew tolerated when checking `exp` and `nbf`. */
export const CLOCK_TOLERANCE_MS = 30_000;
/** Cached keys older than this are refreshed in the background. */
export const KEYS_FRESH_MS = 5 * 60_000;
/** Cached keys older than this are not used: a request waits for fresh keys, or is rejected. */
export const KEYS_MAX_AGE_MS = 60 * 60_000;
/** A token whose key ID is not cached refetches the keys at most this often. */
export const UNKNOWN_KEY_REFETCH_MS = 30_000;
/** After a failed fetch of the keys, no new attempt for this long. */
export const KEY_FETCH_BACKOFF_MS = 30_000;
/** How long fetching the keys may take. */
const FETCH_TIMEOUT_MS = 5_000;

export interface CloudflareAccessOptions {
	/**
	 * Your Zero Trust team domain, such as `"myteam.cloudflareaccess.com"` (Zero Trust →
	 * Settings → Team name and domain). A leading `https://` is accepted.
	 */
	readonly teamDomain: string;
	/**
	 * The Application Audience (AUD) tag of the Access application that protects `/admin`
	 * and `/api/admin` (Access → Applications → the application → Additional settings).
	 * A list when several applications protect them.
	 */
	readonly aud: string | readonly string[];
	/** Users allowed in, by email address (case-insensitive). See the module documentation. */
	readonly allowedEmails?: readonly string[];
	/** Users allowed in, by the domain of their email address, such as `"example.com"` (exact, not subdomains). */
	readonly allowedDomains?: readonly string[];
	/** Access service tokens allowed in, by client ID (`"<id>.access"`, the token's `CF-Access-Client-Id`). */
	readonly allowedServiceTokens?: readonly string[];
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeTeamDomain(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("cloudflareAccess(): `teamDomain` must be a string");
	const host = value
		.trim()
		.toLowerCase()
		.replace(/^https:\/\//, "")
		.replace(/\/$/, "");
	if (!HOSTNAME.test(host)) {
		throw new TypeError(
			`cloudflareAccess(): \`teamDomain\` must be a host name such as "myteam.cloudflareaccess.com", not ${JSON.stringify(value)}`,
		);
	}
	return host;
}

/** A list option as a set of trimmed values, after checking each with `valid`. */
function normalizeList(
	name: string,
	value: unknown,
	valid: (item: string) => boolean,
	normalize: (item: string) => string = (item) => item,
): ReadonlySet<string> {
	const list: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	if (list.length === 0) throw new TypeError(`cloudflareAccess(): \`${name}\` must not be empty`);
	for (const item of list) {
		if (typeof item !== "string" || item.trim() !== item || !valid(item)) {
			throw new TypeError(`cloudflareAccess(): invalid \`${name}\` entry ${JSON.stringify(item)}`);
		}
	}
	return new Set((list as string[]).map(normalize));
}

interface AllowList {
	readonly emails: ReadonlySet<string>;
	readonly domains: ReadonlySet<string>;
	readonly serviceTokens: ReadonlySet<string>;
}

function normalizeAllowList(options: CloudflareAccessOptions): AllowList | undefined {
	const { allowedEmails, allowedDomains, allowedServiceTokens } = options;
	if (allowedEmails === undefined && allowedDomains === undefined && allowedServiceTokens === undefined) {
		return undefined;
	}
	const lower = (item: string) => item.toLowerCase();
	return {
		emails:
			allowedEmails === undefined
				? new Set()
				: normalizeList("allowedEmails", allowedEmails, (item) => /^[^@\s]+@[^@\s]+$/.test(item), lower),
		domains:
			allowedDomains === undefined
				? new Set()
				: normalizeList("allowedDomains", allowedDomains, (item) => HOSTNAME.test(item.toLowerCase()), lower),
		serviceTokens:
			allowedServiceTokens === undefined
				? new Set()
				: normalizeList("allowedServiceTokens", allowedServiceTokens, (item) => item !== ""),
	};
}

/** The signing keys could not be fetched (or a failed fetch is too recent to try again). */
export class KeyFetchError extends Error {
	override readonly name = "KeyFetchError";
}

interface CachedKeys {
	readonly keys: KeyMap;
	readonly fetchedAt: number;
}

/** Waits for `promise` at most `ms`, with a timer of the caller's own. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new KeyFetchError("timed out waiting for the signing keys")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/** The team's signing keys, cached per isolate. */
class KeyCache {
	private cached: CachedKeys | undefined;
	/** The fetch in progress, which other requests join. */
	private inFlight: Promise<CachedKeys> | undefined;
	private lastAttemptAt = Number.NEGATIVE_INFINITY;
	private failedAt = Number.NEGATIVE_INFINITY;
	private readonly url: string;

	constructor(url: string) {
		this.url = url;
	}

	/** The key with ID `kid`, or `undefined` when the team does not publish it. @throws KeyFetchError */
	async get(kid: string, ctx: AuthContext): Promise<CryptoKey | undefined> {
		const now = Date.now();
		let cached = this.cached;
		if (cached === undefined || now - cached.fetchedAt >= KEYS_MAX_AGE_MS) {
			cached = await this.refresh(ctx);
		} else if (now - cached.fetchedAt >= KEYS_FRESH_MS && this.inFlight === undefined) {
			// In the background: this request uses the cached keys. Failures are logged by `refresh`.
			this.refresh(ctx).catch(() => {});
		}
		const key = cached.keys.get(kid);
		if (key !== undefined || Date.now() - this.lastAttemptAt < UNKNOWN_KEY_REFETCH_MS) return key;
		// Perhaps the keys were rotated since they were cached.
		return (await this.refresh(ctx)).keys.get(kid);
	}

	/**
	 * Fetches the keys, or joins the fetch in progress. Within {@link KEY_FETCH_BACKOFF_MS} of a
	 * failed fetch, rejects without fetching.
	 */
	private refresh(ctx: AuthContext): Promise<CachedKeys> {
		if (this.inFlight !== undefined) return withTimeout(this.inFlight, FETCH_TIMEOUT_MS + 1_000);
		if (Date.now() - this.failedAt < KEY_FETCH_BACKOFF_MS) {
			return Promise.reject(new KeyFetchError("the last attempt to fetch the signing keys failed; retrying later"));
		}
		const startedAt = Date.now();
		this.lastAttemptAt = startedAt;
		const run = this.fetchKeys(ctx)
			.then(
				(keys) => {
					this.failedAt = Number.NEGATIVE_INFINITY;
					const fresh = { keys, fetchedAt: startedAt };
					// A fetch that started earlier but finished later does not replace a newer one.
					if (this.cached === undefined || this.cached.fetchedAt <= startedAt) this.cached = fresh;
					return fresh;
				},
				(error: unknown) => {
					this.failedAt = Date.now();
					const message = `could not fetch the signing keys from ${this.url}: ${String(error)}`;
					console.error(`Cloudflare Access: ${message}`);
					throw new KeyFetchError(message);
				},
			)
			.finally(() => {
				this.inFlight = undefined;
			});
		this.inFlight = run;
		// Let it finish even if this request ends first: other requests may be waiting for it.
		ctx.waitUntil(run.catch(() => {}));
		return run;
	}

	private async fetchKeys(ctx: AuthContext): Promise<KeyMap> {
		const response = await ctx.fetch(this.url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return importKeySet(await response.json());
	}
}

type Verdict = { readonly identity: AdminIdentity } | { readonly rejected: string };

/** The Access JWT verifier behind {@link cloudflareAccess}. Exported for tests and other hosts. */
export class AccessVerifier {
	readonly issuer: string;
	readonly audiences: ReadonlySet<string>;
	private readonly allowList: AllowList | undefined;
	private readonly keys: KeyCache;

	constructor(options: CloudflareAccessOptions) {
		const teamDomain = normalizeTeamDomain(options.teamDomain);
		this.issuer = `https://${teamDomain}`;
		this.audiences = normalizeList("aud", options.aud, (tag) => tag !== "");
		this.allowList = normalizeAllowList(options);
		this.keys = new KeyCache(`${this.issuer}/cdn-cgi/access/certs`);
	}

	/**
	 * Verifies an Access application token and returns who it identifies, or why it was
	 * rejected. @throws KeyFetchError when the signing keys cannot be fetched.
	 */
	async verify(token: string, ctx: AuthContext): Promise<Verdict> {
		let decoded: DecodedToken;
		try {
			decoded = decodeToken(token);
		} catch (error) {
			if (error instanceof TokenError) return { rejected: error.message };
			throw error;
		}
		const { header, payload } = decoded;
		if (header["alg"] !== ALGORITHM) return { rejected: `algorithm ${JSON.stringify(header["alg"])} is not ${ALGORITHM}` };
		if (header["crit"] !== undefined) return { rejected: "unsupported critical header parameters" };
		const kid = header["kid"];
		if (typeof kid !== "string" || kid === "") return { rejected: "no key ID" };

		// Claims first: an expired, foreign or unlisted token does not cost a key fetch.
		const claims = this.checkClaims(payload, Date.now());
		if ("rejected" in claims) return claims;

		const key = await this.keys.get(kid, ctx);
		if (key === undefined) return { rejected: `unknown key ID ${JSON.stringify(kid)}` };
		if (!(await verifySignature(decoded, key))) return { rejected: "invalid signature" };
		return claims;
	}

	private checkClaims(payload: Readonly<Record<string, unknown>>, now: number): Verdict {
		if (payload["iss"] !== this.issuer) return { rejected: `issuer ${JSON.stringify(payload["iss"])} is not ${this.issuer}` };

		const aud = payload["aud"];
		const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
		if (!audiences.some((tag) => typeof tag === "string" && this.audiences.has(tag))) {
			return { rejected: "audience does not match" };
		}

		const exp = payload["exp"];
		if (typeof exp !== "number" || !Number.isFinite(exp)) return { rejected: "no expiry" };
		if (now >= exp * 1000 + CLOCK_TOLERANCE_MS) return { rejected: "expired" };
		const nbf = payload["nbf"];
		if (nbf !== undefined) {
			if (typeof nbf !== "number" || !Number.isFinite(nbf)) return { rejected: "invalid nbf" };
			if (now < nbf * 1000 - CLOCK_TOLERANCE_MS) return { rejected: "not valid yet" };
		}

		const sub = payload["sub"];
		const commonName = payload["common_name"];
		const email = typeof payload["email"] === "string" && payload["email"] !== "" ? payload["email"] : undefined;
		if (typeof sub === "string" && sub !== "") {
			if (this.allowList !== undefined && !this.allowsUser(email)) return { rejected: "user is not on the allow list" };
			return { identity: email === undefined ? { id: sub } : { id: sub, email } };
		}
		// An Access service token: no user, its client ID instead.
		if (typeof commonName === "string" && commonName !== "") {
			if (this.allowList !== undefined && !this.allowList.serviceTokens.has(commonName)) {
				return { rejected: "service token is not on the allow list" };
			}
			return { identity: { id: commonName } };
		}
		return { rejected: "no subject" };
	}

	private allowsUser(email: string | undefined): boolean {
		if (email === undefined || this.allowList === undefined) return false;
		const address = email.toLowerCase();
		const domain = address.slice(address.lastIndexOf("@") + 1);
		return this.allowList.emails.has(address) || this.allowList.domains.has(domain);
	}
}

/**
 * Authenticates administrators with Cloudflare Access. See the module documentation
 * for what is verified.
 * @throws TypeError when the options are invalid, so that a typo fails the deployment.
 */
export function cloudflareAccess(options: CloudflareAccessOptions): AuthProvider {
	const verifier = new AccessVerifier(options);
	let warnedMissingHeader = false;
	return {
		type: "cloudflare-access",
		async authenticate(request, ctx) {
			const token = request.headers.get(ACCESS_JWT_HEADER);
			if (token === null || token === "") {
				if (!warnedMissingHeader) {
					warnedMissingHeader = true;
					console.warn(
						`Cloudflare Access: an admin request has no ${ACCESS_JWT_HEADER} header. ` +
							"Check that an Access application protects /admin and /api/admin on this host name.",
					);
				}
				return null;
			}
			let verdict: Verdict;
			try {
				verdict = await verifier.verify(token, ctx);
			} catch (error) {
				// Fetch failures are logged where they happen, once per attempt.
				if (!(error instanceof KeyFetchError)) console.error("Cloudflare Access: could not verify a token", error);
				return null;
			}
			if ("rejected" in verdict) {
				console.warn(`Cloudflare Access: rejected a token (${verdict.rejected})`);
				return null;
			}
			return verdict.identity;
		},
	};
}
