/**
 * Notifications as JSON POSTed to any URL, optionally signed.
 *
 * ## Request
 *
 * `POST <url>` (https only) with `Content-Type: application/json` and the body {@link WebhookPayload}:
 *
 * ```json
 * {
 *   "type": "cf-workers-status-page.notification",
 *   "version": 1,
 *   "id": "api:4102444800000",
 *   "event": "down",
 *   "severity": "critical",
 *   "title": "API is down",
 *   "text": "API has been down since Jan 1, 2100, 12:00:00 AM UTC.\nLast check: HTTP 503",
 *   "occurredAt": "2100-01-01T00:00:00.000Z",
 *   "monitor": { "id": "api", "name": "API" },
 *   "state": "down",
 *   "previousState": "up",
 *   "links": [{ "label": "Create an incident", "url": "https://status.example.com/admin/…" }],
 *   "locale": "en"
 * }
 * ```
 *
 * `event` is `down`, `recovered`, `degraded`, `degraded_recovered`, `unknown` or `test`. `id`
 * is the same for every retry and duplicate delivery of a notification: deliveries are at
 * least once, so drop an `id` you have already handled. Deliveries may also arrive out of
 * order; `occurredAt` says when it happened. Fields may be added in later versions of the
 * same `version`.
 *
 * The receiver must answer 2xx within the hub's timeout. 408, 429 (with `Retry-After`) and 5xx
 * are retried with backoff; other answers, including redirects (they are not followed), are
 * recorded as failed at once.
 *
 * ## Signature
 *
 * With `signingSecret`, every request also has
 *
 * - `X-CF-Workers-Status-Page-Timestamp`: the time of sending, in Unix seconds;
 * - `X-CF-Workers-Status-Page-Signature`: `v1=` and the hex HMAC-SHA256 of
 *   `<timestamp>.<raw body>` with the secret as the key.
 *
 * To verify, compute the same HMAC over the raw body as received, compare it in constant time
 * ({@link verifySignature} does this), and reject timestamps older than a few minutes, so that
 * a captured request cannot be replayed later. Each retry is signed afresh.
 *
 * `url`, `signingSecret` and `headers` (for example `Authorization` for the receiver) are
 * secret options: encrypted at rest and never shown again. `url` must name a public host (no IP
 * address or internal name). `signingSecret` and `headers` are bound to the origin of `url`:
 * moving the target to another origin requires entering them again (or clearing them).
 */
import {
	defineNotifier,
	expectSuccess,
	isPublicHostname,
	type Notification,
} from "@naosystem/cf-workers-status-page-core";
import * as z from "zod";
import { messages } from "./messages";

export { messages };

export const TIMESTAMP_HEADER = "X-CF-Workers-Status-Page-Timestamp";
export const SIGNATURE_HEADER = "X-CF-Workers-Status-Page-Signature";
/** The notification's `id`, also as a header, for receivers that deduplicate before parsing. */
export const ID_HEADER = "X-CF-Workers-Status-Page-Notification-Id";
const SIGNATURE_VERSION = "v1";

/** Headers the hub sets itself, which `headers` cannot override. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(
	["content-type", "content-length", "host", TIMESTAMP_HEADER, SIGNATURE_HEADER, ID_HEADER].map((name) =>
		name.toLowerCase(),
	),
);

function isHeaderName(name: string): boolean {
	try {
		new Headers([[name, "x"]]);
		return true;
	} catch {
		return false;
	}
}

export const webhookOptions = z.strictObject({
	/** Where to POST: https only, since the body and headers may matter. Secret, since URLs often carry a token. */
	url: z
		.url({ protocol: /^https$/, error: "must be an https URL" })
		.refine((value) => {
			const url = new URL(value);
			return url.username === "" && url.password === "";
		}, "must not contain credentials; send them in headers")
		.refine(
			(value) => isPublicHostname(new URL(value).hostname),
			"must name a public host: IP addresses and internal names such as localhost or *.internal are not allowed",
		)
		.meta({ title: messages.en["url.title"], description: messages.en["url.description"] }),
	/** Signs every request (see the module documentation). At least 16 characters; 32 random bytes are best. Secret. */
	signingSecret: z
		.string()
		.min(16, "must be at least 16 characters")
		.max(256)
		.meta({ title: messages.en["signingSecret.title"], description: messages.en["signingSecret.description"] })
		.optional(),
	/** Extra request headers, such as `Authorization`. Secret. */
	headers: z
		.record(z.string(), z.string().max(4_096).refine((value) => !/[\r\n\0]/.test(value), "must not contain line breaks"))
		.superRefine((headers, ctx) => {
			for (const name of Object.keys(headers)) {
				if (!isHeaderName(name)) ctx.addIssue({ code: "custom", message: `"${name}" is not a header name`, path: [name] });
				else if (RESERVED_HEADERS.has(name.toLowerCase())) {
					ctx.addIssue({ code: "custom", message: `"${name}" is set by the hub`, path: [name] });
				}
			}
		})
		.meta({ title: messages.en["headers.title"], description: messages.en["headers.description"] })
		.optional(),
});
export type WebhookOptions = z.infer<typeof webhookOptions>;

/** The JSON body of every request (see the module documentation). */
export interface WebhookPayload {
	readonly type: "cf-workers-status-page.notification";
	readonly version: 1;
	readonly id: string;
	readonly event: Notification["event"];
	readonly severity: Notification["severity"];
	readonly title: string;
	readonly text: string;
	/** ISO 8601, UTC. */
	readonly occurredAt: string;
	readonly monitor: Notification["monitor"];
	readonly state: Notification["state"];
	readonly previousState: Notification["previousState"];
	readonly links: Notification["links"];
	readonly locale: string;
}

export function webhookPayload(notification: Notification): WebhookPayload {
	return {
		type: "cf-workers-status-page.notification",
		version: 1,
		id: notification.id,
		event: notification.event,
		severity: notification.severity,
		title: notification.title,
		text: notification.text,
		occurredAt: new Date(notification.occurredAt).toISOString(),
		monitor: notification.monitor,
		state: notification.state,
		previousState: notification.previousState,
		links: notification.links,
		locale: notification.locale,
	};
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** The `X-CF-Workers-Status-Page-Signature` value for `body` sent at `timestamp` (Unix seconds). */
export async function sign(secret: string, timestamp: number, body: string): Promise<string> {
	const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(`${timestamp}.${body}`));
	return `${SIGNATURE_VERSION}=${hex(mac)}`;
}

/**
 * For receivers: whether `signature` is valid for `body` and `timestamp`, and the timestamp
 * is within `toleranceSeconds` of `now`. Compares in constant time (`crypto.subtle.verify`).
 */
export async function verifySignature(
	secret: string,
	request: { readonly timestamp: string; readonly signature: string; readonly body: string },
	now = Date.now(),
	toleranceSeconds = 300,
): Promise<boolean> {
	const timestamp = Number(request.timestamp);
	if (!Number.isInteger(timestamp) || Math.abs(now / 1_000 - timestamp) > toleranceSeconds) return false;
	const prefix = `${SIGNATURE_VERSION}=`;
	if (!request.signature.startsWith(prefix)) return false;
	const digits = request.signature.slice(prefix.length);
	if (!/^[0-9a-f]{64}$/.test(digits)) return false;
	const mac = new Uint8Array(digits.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
	return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), mac, encoder.encode(`${timestamp}.${request.body}`));
}

const kind = defineNotifier({
	type: "webhook",
	name: "Webhook",
	options: webhookOptions,
	secretOptions: ["url", "signingSecret", "headers"],
	messages,
	async send(notification, options, ctx) {
		const body = JSON.stringify(webhookPayload(notification));
		const headers = new Headers(options.headers ?? {});
		headers.set("Content-Type", "application/json");
		headers.set(ID_HEADER, notification.id);
		if (options.signingSecret !== undefined) {
			const timestamp = Math.floor(Date.now() / 1_000);
			headers.set(TIMESTAMP_HEADER, String(timestamp));
			headers.set(SIGNATURE_HEADER, await sign(options.signingSecret, timestamp, body));
		}
		const response = await ctx.fetch(options.url, {
			method: "POST",
			headers,
			body,
			redirect: "manual",
			signal: ctx.signal,
		});
		await expectSuccess(response, "The webhook");
	},
});

/** The generic webhook notifier kind, for `notifiers` in status.config.ts. */
export function webhook() {
	return kind;
}
