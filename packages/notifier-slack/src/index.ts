/**
 * Slack notifications through an incoming webhook.
 *
 * Create an incoming webhook for a Slack app (Slack: "Sending messages using incoming
 * webhooks") and enter its URL, `https://hooks.slack.com/services/T…/B…/…`, as the target's
 * `url`. The URL is the credential, so it is a secret option: encrypted at rest and never shown
 * again.
 *
 * Each notification is one POST of `{ "text": … }` as JSON, formatted with Slack's `mrkdwn`:
 * the title in bold after an emoji for its severity, the text (which says when it happened)
 * and the links. `&`, `<` and `>` in the hub's text are escaped, as Slack requires, so that
 * names cannot turn into mentions or links. The message is kept under {@link MAX_TEXT_CHARS}
 * characters (Slack truncates long messages).
 *
 * Slack answers `200 ok`, or an error status with a short code in the body (such as
 * `400 invalid_payload`, `404 no_service`, `410 channel_is_archived`); 429 (rate limited)
 * and 5xx are retried by the hub, other errors are recorded as failed at once.
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

/** Slack recommends keeping a message's text under 4,000 characters. */
export const MAX_TEXT_CHARS = 3_500;

const SLACK_HOSTS: ReadonlySet<string> = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const WEBHOOK_PATH = /^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

export const slackOptions = z.strictObject({
	/** The incoming webhook's URL. Secret. */
	url: z
		.url({ protocol: /^https$/, error: "must be an https URL" })
		.refine((value) => {
			const url = new URL(value);
			return SLACK_HOSTS.has(url.hostname) && WEBHOOK_PATH.test(url.pathname) && url.search === "";
		}, "must be a Slack incoming webhook URL, https://hooks.slack.com/services/…")
		.meta({ title: messages.en["url.title"], description: messages.en["url.description"] }),
});
export type SlackOptions = z.infer<typeof slackOptions>;

const EMOJI: Readonly<Record<NotificationSeverity, string>> = {
	critical: ":red_circle:",
	warning: ":large_yellow_circle:",
	ok: ":large_green_circle:",
	info: ":information_source:",
};

/** Escapes the three characters Slack's `mrkdwn` reserves for mentions and links. */
export function escapeSlack(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The JSON body sent to Slack for `notification`. */
export function slackPayload(notification: Notification): { text: string } {
	const links = notification.links.map((link) => {
		// In <url|label>, `|` and `>` would end the URL early; they are percent-encoded in a valid URL anyway.
		const url = link.url.replaceAll("|", "%7C").replaceAll(">", "%3E");
		return `<${url}|${escapeSlack(link.label)}>`;
	});
	const head = `${EMOJI[notification.severity]} *${escapeSlack(truncate(notification.title, 200))}*`;
	const tail = links.length === 0 ? "" : `\n${links.join("  ")}`;
	const room = MAX_TEXT_CHARS - head.length - tail.length - 1;
	return { text: `${head}\n${truncate(escapeSlack(notification.text), Math.max(0, room))}${tail}` };
}

const kind = defineNotifier({
	type: "slack",
	name: "Slack",
	options: slackOptions,
	secretOptions: ["url"],
	messages,
	async send(notification, options, ctx) {
		const response = await ctx.fetch(options.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(slackPayload(notification)),
			redirect: "manual",
			signal: ctx.signal,
		});
		await expectSuccess(response, "Slack");
	},
});

/** The Slack notifier kind, for `notifiers` in status.config.ts. */
export function slack() {
	return kind;
}
