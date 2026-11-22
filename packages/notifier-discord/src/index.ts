/**
 * Discord notifications through a channel webhook.
 *
 * Create a webhook in the channel's settings (Integrations → Webhooks) and enter its URL,
 * `https://discord.com/api/webhooks/<id>/<token>`, as the target's `url`. The URL contains
 * the token, so it is a secret option: encrypted at rest and never shown again.
 *
 * Each notification is one "Execute Webhook" POST with a JSON body holding one embed: the
 * title (at most {@link LIMITS}`.title` characters), a description with the text and the
 * links, a colour for the severity and the time it happened as the embed's timestamp.
 * `allowed_mentions` is empty, so no text can ping anyone, and Markdown in the hub's text is
 * escaped. The request asks to `wait` for the message to be created, so that Discord reports
 * a message it could not save (without `wait` it answers 204 whatever happens): it answers 200
 * with the message. 429 (rate limited, with `Retry-After`) and 5xx are retried by the hub, other
 * errors (such as 404 for a deleted webhook) are recorded as failed at once.
 *
 * For a webhook of a forum or media channel, set `threadId` to the thread (post) to write in.
 */
import {
	defineNotifier,
	expectSuccess,
	type Notification,
	type NotificationSeverity,
} from "@naosystem/cf-workers-status-page-core";
import * as z from "zod";
import { messages } from "./messages";

export { messages };

/** Discord's limits for an embed and for the webhook's display name. */
export const LIMITS = { title: 256, description: 4_096, username: 80 } as const;

const DISCORD_HOSTS: ReadonlySet<string> = new Set([
	"discord.com",
	"discordapp.com",
	"ptb.discord.com",
	"canary.discord.com",
]);
const WEBHOOK_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

/**
 * Discord's rules for a webhook's name: no `@`, `#`, `:` or ```` ``` ````, not containing
 * "discord" or "clyde", and not "everyone" or "here".
 */
function usernameIssue(name: string): string | null {
	const lower = name.toLowerCase();
	if (/[@#:]/.test(name) || name.includes("```")) return 'must not contain "@", "#", ":" or "```"';
	if (lower.includes("discord") || lower.includes("clyde")) return 'must not contain "discord" or "clyde"';
	if (lower === "everyone" || lower === "here") return 'must not be "everyone" or "here"';
	return null;
}

export const discordOptions = z.strictObject({
	/** The webhook's URL. Secret. */
	url: z
		.url({ protocol: /^https$/, error: "must be an https URL" })
		.refine((value) => {
			const url = new URL(value);
			return DISCORD_HOSTS.has(url.hostname) && WEBHOOK_PATH.test(url.pathname);
		}, "must be a Discord webhook URL, https://discord.com/api/webhooks/…")
		.refine(
			(value) => new URL(value).search === "",
			"must not have a query: for a forum channel's thread, set threadId instead of ?thread_id=",
		)
		.meta({ title: messages.en["url.title"], description: messages.en["url.description"] }),
	/** Overrides the webhook's name for these messages. */
	username: z
		.string()
		.trim()
		.min(1)
		.max(LIMITS.username)
		.superRefine((name, ctx) => {
			const issue = usernameIssue(name);
			if (issue !== null) ctx.addIssue(issue);
		})
		.meta({ title: messages.en["username.title"], description: messages.en["username.description"] })
		.optional(),
	/** For a webhook of a forum or media channel: the ID of the thread to post in. */
	threadId: z
		.string()
		.regex(/^\d{1,20}$/, "must be a thread ID (digits)")
		.meta({ title: messages.en["threadId.title"], description: messages.en["threadId.description"] })
		.optional(),
});
export type DiscordOptions = z.infer<typeof discordOptions>;

const COLORS: Readonly<Record<NotificationSeverity, number>> = {
	critical: 0xe5484d,
	warning: 0xf5a524,
	ok: 0x30a46c,
	info: 0x0090ff,
};

/** Escapes Discord Markdown, so that names and messages show as written. */
export function escapeDiscord(text: string): string {
	return text
		.replace(/[\\*_~`|<>[\]]/g, (character) => `\\${character}`)
		.replace(/^([#-])/gm, "\\$1");
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface DiscordPayload {
	username?: string;
	embeds: {
		title: string;
		description: string;
		color: number;
		timestamp: string;
	}[];
	allowed_mentions: { parse: never[] };
}

/** The JSON body sent to Discord for `notification`. */
export function discordPayload(notification: Notification, options: Pick<DiscordOptions, "username">): DiscordPayload {
	// Masked links: the label is escaped, and `)` cannot end the URL early once percent-encoded.
	const links = notification.links.map(
		(link) => `[${escapeDiscord(link.label)}](${link.url.replaceAll(")", "%29").replaceAll(" ", "%20")})`,
	);
	const tail = links.length === 0 ? "" : `\n\n${links.join("\n")}`;
	const room = LIMITS.description - tail.length;
	return {
		...(options.username === undefined ? {} : { username: options.username }),
		embeds: [
			{
				// Titles are not Markdown in embeds.
				title: truncate(notification.title, LIMITS.title),
				description: `${truncate(escapeDiscord(notification.text), Math.max(0, room))}${tail}`,
				color: COLORS[notification.severity],
				timestamp: new Date(notification.occurredAt).toISOString(),
			},
		],
		allowed_mentions: { parse: [] },
	};
}

/** The URL to POST to: the webhook's, asking to wait for the message, in the thread if any. */
export function executeUrl(options: Pick<DiscordOptions, "url" | "threadId">): string {
	const url = new URL(options.url);
	url.searchParams.set("wait", "true");
	if (options.threadId !== undefined) url.searchParams.set("thread_id", options.threadId);
	return url.toString();
}

const kind = defineNotifier({
	type: "discord",
	name: "Discord",
	options: discordOptions,
	secretOptions: ["url"],
	messages,
	async send(notification, options, ctx) {
		const response = await ctx.fetch(executeUrl(options), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(discordPayload(notification, options)),
			redirect: "manual",
			signal: ctx.signal,
		});
		await expectSuccess(response, "Discord");
	},
});

/** The Discord notifier kind, for `notifiers` in status.config.ts. */
export function discord() {
	return kind;
}
