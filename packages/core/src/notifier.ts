import type { ZodType } from "zod";
import { optionKeys, type SchemaLike } from "./monitor";

/**
 * What a notification is about. Targets choose which of these they receive:
 * - `down`: `down` was confirmed (on by default);
 * - `recovered`: the monitor left `down` (on by default);
 * - `degraded`: `degraded` was confirmed, from `up` or before any state (off by default);
 * - `degraded_recovered`: the monitor went from `degraded` back to `up` (off by default);
 * - `unknown`: results stopped arriving; only targets marked as administrators' get it.
 */
export const NOTIFICATION_EVENTS = ["down", "recovered", "degraded", "degraded_recovered", "unknown"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** For colours and icons: `critical` for `down`, `warning` for `degraded` and `unknown`, `ok` for recoveries, `info` for tests. */
export type NotificationSeverity = "critical" | "warning" | "ok" | "info";

/** A state as notifications name it. */
export type NotificationState = "up" | "degraded" | "down" | "unknown";

export interface NotificationLink {
	readonly label: string;
	readonly url: string;
}

/**
 * One notification, already written in the hub's language (`locale` in status.config.ts).
 * A notifier kind only lays it out for its service: it never translates or decides anything.
 */
export interface Notification {
	/**
	 * Stable identifier: the same for every retry and duplicate delivery of this notification,
	 * so that a receiver can drop duplicates. Queues deliver at least once.
	 */
	readonly id: string;
	/** `test` for a test notification sent from the admin UI. */
	readonly event: NotificationEvent | "test";
	readonly severity: NotificationSeverity;
	/** One line of plain text. */
	readonly title: string;
	/** Plain text, possibly several lines. Always says when it happened (deliveries may arrive late or out of order). */
	readonly text: string;
	/** When it happened, epoch milliseconds. */
	readonly occurredAt: number;
	/** `null` for a test notification. */
	readonly monitor: { readonly id: string; readonly name: string } | null;
	/** The monitor's state after the event; `null` for a test notification. */
	readonly state: NotificationState | null;
	/** The state before it, when known. */
	readonly previousState: NotificationState | null;
	/** Links to show with the notification, such as "Create an incident". */
	readonly links: readonly NotificationLink[];
	/** BCP 47 language tag of `title`, `text` and link labels. */
	readonly locale: string;
}

/** What the hub hands a notifier kind for one delivery. */
export interface NotifierContext {
	/** For the request to the service. Use this, never the global `fetch` (enforced by lint). */
	readonly fetch: typeof fetch;
	/** Aborted when the delivery takes too long. Pass it to `fetch`. */
	readonly signal: AbortSignal;
}

/**
 * A delivery failed. `retryable` says whether trying again later may help (a timeout, a rate
 * limit, a server error) or not (the webhook was deleted, the payload was refused): the hub
 * then retries with backoff or records the failure at once.
 *
 * Messages must never contain secret options (a webhook URL, a signing secret); the hub also
 * redacts them before it logs or stores a message.
 */
export class NotifierError extends Error {
	override readonly name = "NotifierError";
	readonly retryable: boolean;
	/** How long the service asked to wait (`Retry-After`), if it did. */
	readonly retryAfterMs: number | undefined;
	/** The HTTP status, when the service answered. */
	readonly status: number | undefined;

	constructor(
		message: string,
		options: { readonly retryable: boolean; readonly retryAfterMs?: number | undefined; readonly status?: number | undefined },
	) {
		super(message);
		this.retryable = options.retryable;
		this.retryAfterMs = options.retryAfterMs;
		this.status = options.status;
	}
}

/** Longest part of a service's error response kept in a {@link NotifierError} message. */
const ERROR_BODY_CHARS = 200;
/** Bytes of an error response read at most (a little more than the characters kept, for multi-byte text). */
const ERROR_BODY_BYTES = 1_024;

/** The start of `response`'s body as text, reading at most {@link ERROR_BODY_BYTES} bytes, then cancelling the rest. */
async function bodyStart(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < ERROR_BODY_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(Math.min(size, ERROR_BODY_BYTES));
	let offset = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, bytes.length - offset);
		bytes.set(part, offset);
		offset += part.length;
		if (offset >= bytes.length) break;
	}
	// A character cut at the end decodes as a replacement character, which is dropped.
	return new TextDecoder().decode(bytes).replace(/\uFFFD+$/, "");
}

/** Milliseconds from a `Retry-After` header (seconds or an HTTP date), if it has one. */
export function retryAfterMs(response: Response, now = Date.now()): number | undefined {
	const value = response.headers.get("Retry-After");
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Throws a {@link NotifierError} unless `response` is successful (2xx). 408, 429 and 5xx are
 * retryable; other statuses are not (the request itself is wrong, or the webhook is gone).
 * The message names `service`, the status and the start of the response body (services such
 * as Slack explain the error there); it never includes the request URL.
 */
export async function expectSuccess(response: Response, service: string): Promise<void> {
	if (response.ok) {
		// Release the connection.
		await response.body?.cancel();
		return;
	}
	let body = "";
	try {
		body = (await bodyStart(response)).trim().slice(0, ERROR_BODY_CHARS);
	} catch {
		// The status is enough.
	}
	const { status } = response;
	throw new NotifierError(`${service} answered HTTP ${status}${body === "" ? "" : `: ${body}`}`, {
		retryable: status === 408 || status === 429 || status >= 500,
		retryAfterMs: retryAfterMs(response),
		status,
	});
}

/**
 * A kind of notification channel, such as Slack, Discord or a generic webhook.
 *
 * Only kinds are registered in code (`notifiers` in status.config.ts). Targets, such as "the
 * #ops channel", are created in the admin UI and stored in D1 with their options, which the
 * hub validates with `options`; the admin UI builds its form from the same schema (as JSON
 * Schema). Options named in `secretOptions` are encrypted at rest and never shown again.
 *
 * `Options` is the validated option type; `Input` is what an administrator enters.
 */
export interface NotifierKind<Options = unknown, Input = Options> {
	/** Identifier such as `"slack"`: lowercase letters, digits and `-`. Unique within a configuration. Stored with targets: never change it. */
	readonly type: string;
	/** Display name, such as `"Slack"`. */
	readonly name: string;
	/** Defines and validates the options. Must be an object schema. */
	readonly options: ZodType<Options, Input>;
	/**
	 * Top-level option keys whose values are secret (a webhook URL with its token, a signing
	 * secret): encrypted in D1, write-only through the admin API, never logged.
	 */
	readonly secretOptions: readonly string[];
	/**
	 * The option that holds the URL notifications are sent to, for a kind that sends wherever an
	 * administrator says (a webhook). The hub binds the other secret options to that URL's origin: an edit that moves the target to another origin must enter them again or clear
	 * them, and stored values do not decrypt for another origin, so that a secret can never be
	 * redirected to a host an administrator chose to read it back. The URL must also name a
	 * public host (see {@link isPublicHostname}). Default: `"url"` when the kind has a `url`
	 * option; kinds that send to a fixed service can leave it out.
	 */
	readonly destinationOption?: string;
	/**
	 * Texts for the admin UI's form, by language (BCP 47 tag): `"$kind"` the kind's name,
	 * `"<option>.title"` and `"<option>.description"` an option's label and help. What a
	 * language leaves out falls back to `en`, then to the options' schema (Zod's
	 * `.meta({ title, description })`), then to the option's name. Optional.
	 */
	readonly messages?: NotifierMessages;
	/**
	 * Delivers one notification. Throw a {@link NotifierError} on failure (any other error
	 * counts as retryable). Use `ctx.fetch` and `ctx.signal`.
	 */
	send(notification: Notification, options: Options, ctx: NotifierContext): Promise<void>;
}

/** A notifier kind's texts for the admin UI, by language (see {@link NotifierKind.messages}). */
export type NotifierMessages = Readonly<Record<string, Readonly<Record<string, string>>>>;

const NOTIFIER_TYPE = /^[a-z][a-z0-9-]{0,31}$/;
const MESSAGE_KEY = /^(?:\$kind|(.+)\.(?:title|description))$/;

/**
 * Declares a notifier kind, checking that its options are an object schema and that every
 * key in `secretOptions` is one of its options.
 * @throws TypeError otherwise.
 */
export function defineNotifier<Options, Input extends object>(
	kind: NotifierKind<Options, Input>,
): NotifierKind<Options, Input> {
	if (!NOTIFIER_TYPE.test(kind.type)) {
		throw new TypeError(`Notifier "${kind.type}": type must be lowercase letters, digits and "-", starting with a letter`);
	}
	const keys = optionKeys(kind.options as SchemaLike);
	if (keys === undefined) throw new TypeError(`Notifier "${kind.type}": options must be an object schema`);
	if (kind.destinationOption !== undefined && !keys.includes(kind.destinationOption)) {
		throw new TypeError(`Notifier "${kind.type}": destinationOption "${kind.destinationOption}" is not an option`);
	}
	const unknown = kind.secretOptions.filter((key) => !keys.includes(key));
	if (unknown.length > 0) {
		throw new TypeError(
			`Notifier "${kind.type}": secretOptions ${unknown.map((key) => `"${key}"`).join(", ")} are not options`,
		);
	}
	for (const [language, messages] of Object.entries(kind.messages ?? {})) {
		for (const key of Object.keys(messages)) {
			const match = MESSAGE_KEY.exec(key);
			if (match === null || (match[1] !== undefined && !keys.includes(match[1]))) {
				throw new TypeError(`Notifier "${kind.type}": message "${key}" (${language}) is not "$kind" or "<option>.title|description"`);
			}
		}
	}
	return kind;
}

/** The option of `kind` that holds where it sends notifications (see {@link NotifierKind.destinationOption}), if any. */
export function destinationOptionOf(kind: Pick<NotifierKind, "destinationOption" | "options">): string | undefined {
	if (kind.destinationOption !== undefined) return kind.destinationOption;
	return optionKeys(kind.options as SchemaLike)?.includes("url") ? "url" : undefined;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Suffixes of names that only resolve inside a network (RFC 6761, 6762, 8375 and common practice). */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".private", ".home.arpa", ".localdomain", ".test", ".invalid", ".example", ".onion"];

/**
 * Whether `hostname` (as `URL.hostname` gives it) names a host on the public internet: not an
 * IP address literal (which the WHATWG URL parser also makes of forms such as `0x7f.1`), not a
 * single label such as `localhost` or `intranet`, and not under a suffix that only resolves
 * inside a network (`.local`, `.internal`, `.home.arpa`, …). Notification targets must name one,
 * so that an administrator cannot point the hub at addresses it should not reach.
 */
export function isPublicHostname(hostname: string): boolean {
	const name = hostname.toLowerCase().replace(/\.$/, "");
	if (name === "" || name.startsWith("[") || IPV4.test(name) || !name.includes(".")) return false;
	return !INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
