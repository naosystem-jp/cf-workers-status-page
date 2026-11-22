import type { CheckContext, CheckProvider, CheckResult, TcpConnect } from "./provider";
import { redactSecrets, resolveSecrets, type SecretLookup } from "./secret";

/** What `runCheck` needs from a resolved monitor. */
export interface CheckTarget {
	readonly provider: CheckProvider;
	/** Validated provider options, possibly containing `secret()` references. */
	readonly options: unknown;
	readonly timeoutMs: number;
}

/** What the runner supplies. Runtime-specific parts are passed in, so this stays runtime-agnostic. */
export interface RunnerContext {
	/** The runner's fetch, with its User-Agent applied. */
	readonly fetch: typeof fetch;
	/** Only when the runner provides the `tcp` capability. */
	readonly connect?: TcpConnect;
	/** Aborted when the runner gives up on the check (for example, shutting down). */
	readonly signal?: AbortSignal;
	/** Looks up secrets referenced with `secret()`; on Cloudflare, Worker secrets in `env`. */
	readonly secret: SecretLookup;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Redirects followed at most, as browsers and the Fetch standard do. */
export const MAX_REDIRECTS = 20;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Headers that describe a request body, dropped when a redirect turns the request into a GET (Fetch standard). */
const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type"] as const;

/** A request would have carried a `secret()` value over plain http. Nothing was sent. */
export class InsecureSecretError extends Error {
	override readonly name = "InsecureSecretError";
	constructor() {
		super("Refusing to send secret() values over plain http: use an https URL");
	}
}

/** Why a redirect of a request carrying secrets was not followed (see {@link withheldRedirect}). */
export interface WithheldRedirect {
	/** Where the response pointed, resolved against the request's URL. */
	readonly location: string;
	/**
	 * - `cross-origin`: to another origin, which must never receive the secrets;
	 * - `insecure`: to plain http;
	 * - `body`: the request body cannot be sent again (a stream).
	 */
	readonly reason: "cross-origin" | "insecure" | "body";
}

const withheld = new WeakMap<Response, WithheldRedirect>();

/**
 * Whether `response` is a redirect that `ctx.fetch` did not follow, although the request asked
 * to follow redirects, because the request carried `secret()` values (and why). Providers use
 * it to report the redirect itself as the result, with a clear message.
 */
export function withheldRedirect(response: Response): WithheldRedirect | undefined {
	return withheld.get(response);
}

/** Whether the request made from `input` and `init` contains one of `secrets` (URL, headers, or a text body). */
function carriesSecret(input: RequestInfo | URL, init: RequestInit | undefined, secrets: readonly string[]): boolean {
	if (secrets.length === 0) return false;
	const request = input instanceof Request ? input : undefined;
	const headers = new Headers(init?.headers ?? request?.headers);
	const texts = [request?.url ?? String(input), ...[...headers].map(([, value]) => value)];
	if (typeof init?.body === "string") texts.push(init.body);
	const values = secrets.flatMap((value) => [value, value.trim()]).filter((value) => value !== "");
	return texts.some((text) => values.some((value) => text.includes(value)));
}

/**
 * `fetch` for a request that carries secrets: never over plain http, and redirects
 * followed by hand, at most {@link MAX_REDIRECTS}, only to the same origin over https. A
 * redirect anywhere else is returned as the response, unfollowed, and marked for
 * {@link withheldRedirect}. (`fetch` itself would forward every header except `Authorization`
 * to another origin, `Cookie` and API-key headers included.)
 */
async function fetchWithSecrets(
	send: typeof fetch,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): Promise<Response> {
	const first = new URL(input instanceof Request ? input.url : String(input));
	if (first.protocol !== "https:") throw new InsecureSecretError();
	const mode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
	// "manual" and "error" never send the request anywhere else.
	if (mode !== "follow") return send(input, init);

	let url = first;
	let method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	let headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	let body = init?.body ?? (input instanceof Request ? input.body : undefined);
	let next: [RequestInfo | URL, RequestInit] = [input, { ...init, redirect: "manual" }];
	for (let hop = 0; ; hop++) {
		const response = await send(...next);
		const location = response.headers.get("Location");
		if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
		if (hop === MAX_REDIRECTS) {
			await response.body?.cancel().catch(() => {});
			throw new TypeError(`More than ${MAX_REDIRECTS} redirects`);
		}
		const target = new URL(location, url);
		const changesToGet = response.status === 303 ? method !== "HEAD" : (response.status === 301 || response.status === 302) && method === "POST";
		const reason: WithheldRedirect["reason"] | undefined =
			target.host !== first.host
				? "cross-origin"
				: target.protocol !== "https:"
					? "insecure"
					: target.origin !== first.origin
						? "cross-origin"
						: !changesToGet && body !== undefined && body !== null && typeof body !== "string"
							? "body"
							: undefined;
		if (reason !== undefined) {
			withheld.set(response, { location: target.href, reason });
			return response;
		}
		await response.body?.cancel().catch(() => {});
		if (changesToGet) {
			method = "GET";
			body = undefined;
			headers = new Headers(headers);
			for (const name of BODY_HEADERS) headers.delete(name);
		}
		url = target;
		next = [target.href, { ...init, method, headers, body: body ?? null, redirect: "manual" }];
	}
}

/**
 * Runs one check the way every runner must:
 *
 * 1. Resolves `secret()` references. If one is missing, throws `MissingSecretError`
 *    (naming the secret, not its value) without calling the provider, so nothing is sent
 *    with an empty credential. The runner records this as a failed check without a
 *    state, so the monitor becomes `unknown` rather than `down`.
 * 2. Calls the provider with a context whose `signal` aborts at the monitor's timeout
 *    and whose `fetch` follows that signal. A check still running at the timeout is `down`.
 *    A request that carries a secret value is never sent over plain http
 *    ({@link InsecureSecretError}), and its redirects are followed only to the same origin
 *    over https; others are returned unfollowed ({@link withheldRedirect}).
 * 3. Redacts secret values from the result, and from the message of anything thrown.
 *
 * If the runner aborts `runner.signal`, its reason is rethrown and no result is recorded.
 */
export async function runCheck(target: CheckTarget, runner: RunnerContext): Promise<CheckResult> {
	const { value: options, secrets } = await resolveSecrets(target.options, runner.secret);

	const runnerSignal = runner.signal ?? new AbortController().signal;
	const timeout = AbortSignal.timeout(target.timeoutMs);
	const signal = AbortSignal.any([runnerSignal, timeout]);
	const send = ((input: RequestInfo | URL, init?: RequestInit) =>
		runner.fetch(input, {
			...init,
			signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
		})) as typeof fetch;
	const ctx: CheckContext = {
		// Requests that carry secrets never go over http or to another origin (see fetchWithSecrets).
		fetch: (input, init) => (carriesSecret(input, init, secrets) ? fetchWithSecrets(send, input, init) : send(input, init)),
		signal,
	};
	if (runner.connect) ctx.connect = runner.connect;

	// Settles when `signal` aborts, in case the provider ignores it.
	const aborted = new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});

	try {
		const result = await Promise.race([target.provider.check(options, ctx), aborted]);
		return redactSecrets(result, secrets);
	} catch (error) {
		if (runnerSignal.aborted) throw runnerSignal.reason;
		if (timeout.aborted) {
			return {
				state: "down",
				message: `No response within ${target.timeoutMs} ms`,
				details: { error: "timeout" },
			};
		}
		const redacted = new Error(redactSecrets(errorMessage(error), secrets));
		if (error instanceof Error) redacted.name = error.name;
		throw redacted;
	}
}
