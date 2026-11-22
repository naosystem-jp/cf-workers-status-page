import type { NotifierMessages } from "@naosystem/cf-workers-status-page-core";

/** Texts of the admin UI's form for Slack targets (English is also the schema's `title`/`description`). */
export const messages = {
	en: {
		$kind: "Slack",
		"url.title": "Webhook URL",
		"url.description": "The incoming webhook's URL, https://hooks.slack.com/services/… (from the Slack app's Incoming Webhooks).",
	},
	ja: {
		$kind: "Slack",
		"url.title": "Webhook の URL",
		"url.description": "Incoming Webhook の URL（https://hooks.slack.com/services/…）。Slack アプリの Incoming Webhooks で発行します。",
	},
} as const satisfies NotifierMessages;
