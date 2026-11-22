/**
 * Built-in HTTP check.
 *
 * Sends one request through the runner's `ctx.fetch` and reports `up` when the response
 * status is expected, `down` otherwise (including network errors). The monitor's `timeout`
 * setting bounds the request; `runCheck` reports a timeout as `down`. It never reports
 * `degraded`: a latency threshold for that is still undecided.
 *
 * Options and defaults:
 * - `url` (required): http or https URL, without credentials (`https://user:pass@…` is rejected).
 * - `method`: `"GET"`.
 * - `headers`: none. A value may be `secret("NAME")`, which the runner fills in at check time.
 *   `Authorization`, `Proxy-Authorization` and `Cookie` must use `secret()`: literal values are
 *   rejected because `status.config.ts` is deployed with the Worker and may be public.
 *   With any `secret()` header, `url` must be https, and redirects are followed only within its
 *   origin over https: a redirect elsewhere is not followed and is judged as the response (its
 *   status against `expectedStatus`), so that the secret never reaches another host.
 * - `body`: none. Not allowed with GET or HEAD.
 * - `expectedStatus`: `"2xx"`. Exact codes (`204`), classes (`"3xx"`) or a list of them.
 * - `followRedirects`: `true`. When `false`, a redirect response is judged as is.
 *
 * `latencyMs` is the time until the response headers arrive, including any redirects
 * followed. The response body is not read.
 */
import {
	type CheckContext,
	type CheckResult,
	defineProvider,
	isSecretRef,
	withheldRedirect,
	type SecretsResolved,
	secretOr,
} from "@naosystem/cf-workers-status-page-core";
import * as z from "zod";

const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;

/** An exact status code such as `204`, or a class such as `"2xx"`. */
export type StatusMatcher = number | (typeof STATUS_CLASSES)[number];

const statusMatcher = z.union([z.int().min(100).max(599), z.enum(STATUS_CLASSES)]);

/** Headers whose values are credentials: only `secret()` references are accepted for them. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
]);

export const httpOptions = z
	.strictObject({
		url: z.url({ protocol: /^https?$/, error: "must be an http or https URL" }),
		method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
		headers: z.record(z.string(), secretOr(z.string())).default({}),
		body: z.string().optional(),
		expectedStatus: z
			.union([statusMatcher, z.array(statusMatcher).min(1)])
			.transform((value): StatusMatcher[] => (Array.isArray(value) ? value : [value]))
			.prefault("2xx"),
		followRedirects: z.boolean().default(true),
	})
	.superRefine((options, ctx) => {
		// Never include the URL itself in the message: it holds the credentials.
		const url = new URL(options.url);
		if (url.protocol !== "https:" && Object.values(options.headers).some(isSecretRef)) {
			ctx.addIssue({
				code: "custom",
				path: ["url"],
				message: 'must be https when a header uses secret(): secrets are never sent over plain http',
				input: undefined,
			});
		}
		if (url.username !== "" || url.password !== "") {
			ctx.addIssue({
				code: "custom",
				path: ["url"],
				message: 'must not contain credentials; send them in a header with secret("NAME")',
				input: undefined,
			});
		}
		if (options.body !== undefined && (options.method === "GET" || options.method === "HEAD")) {
			ctx.addIssue({
				code: "custom",
				path: ["body"],
				message: `a ${options.method} request cannot have a body`,
				input: undefined,
			});
		}
		for (const [name, value] of Object.entries(options.headers)) {
			if (isSecretRef(value)) {
				try {
					new Headers([[name, "x"]]);
				} catch {
					ctx.addIssue({
						code: "custom",
						path: ["headers", name],
						message: "is not a valid HTTP header name",
						input: undefined,
					});
				}
				continue;
			}
			if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
				ctx.addIssue({
					code: "custom",
					path: ["headers", name],
					message: 'must be secret("NAME"), not a literal value: status.config.ts may be public',
					input: undefined,
				});
				continue;
			}
			try {
				new Headers([[name, value]]);
			} catch {
				ctx.addIssue({
					code: "custom",
					path: ["headers", name],
					message: "is not a valid HTTP header",
					input: undefined,
				});
			}
		}
	});

/** Options as passed to `check`: defaults applied and secrets resolved. */
export type HttpOptions = SecretsResolved<z.output<typeof httpOptions>>;
/** Options as written in `status.config.ts`. */
export type HttpOptionsInput = z.input<typeof httpOptions>;

function matchesStatus(status: number, matcher: StatusMatcher): boolean {
	return typeof matcher === "number"
		? status === matcher
		: Math.floor(status / 100) === Number(matcher[0]);
}

async function checkHttp(options: HttpOptions, ctx: CheckContext): Promise<CheckResult> {
	const started = performance.now();
	let response: Response;
	try {
		response = await ctx.fetch(options.url, {
			method: options.method,
			headers: options.headers,
			body: options.body,
			redirect: options.followRedirects ? "follow" : "manual",
			signal: ctx.signal,
		});
	} catch (error) {
		// Timed out or cancelled by the runner: runCheck decides what to record.
		if (ctx.signal.aborted) throw ctx.signal.reason;
		return {
			state: "down",
			message: error instanceof Error ? error.message : String(error),
			details: { error: "network" },
		};
	}
	const latencyMs = Math.round(performance.now() - started);
	// Only the status matters. Release the body without downloading it.
	response.body?.cancel().catch(() => {});

	const { status } = response;
	const up = options.expectedStatus.some((matcher) => matchesStatus(status, matcher));
	const expectation = up ? "" : `, expected ${options.expectedStatus.join(" or ")}`;
	const redirect = withheldRedirect(response);
	if (redirect !== undefined) {
		// Not followed because the request has secret() headers (see the module documentation).
		const where = new URL(redirect.location);
		const why =
			redirect.reason === "cross-origin"
				? `another origin (${where.origin}) must not receive this monitor's secret() headers`
				: redirect.reason === "insecure"
					? `secret() headers are never sent over plain http (${where.origin})`
					: "the request body cannot be sent again";
		return {
			state: up ? "up" : "down",
			latencyMs,
			message: `HTTP ${status}${expectation}; redirect not followed: ${why}`,
			details: { status, redirect: redirect.reason, redirectOrigin: where.origin },
		};
	}
	return {
		state: up ? "up" : "down",
		latencyMs,
		message: `HTTP ${status}${expectation}`,
		details: { status },
	};
}

/**
 * Creates an HTTP monitor:
 * `http({ id: "api", interval: "1m", url: "https://api.example.com/health" })`.
 * The provider itself is `http.provider`.
 */
export const http = defineProvider({
	type: "http",
	options: httpOptions,
	requires: ["fetch"],
	check: checkHttp,
});
