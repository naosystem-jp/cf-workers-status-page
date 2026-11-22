import type { NotifierMessages } from "@naosystem/cf-workers-status-page-core";

/** Texts of the admin UI's form for Discord targets (English is also the schema's `title`/`description`). */
export const messages = {
	en: {
		$kind: "Discord",
		"url.title": "Webhook URL",
		"url.description": "The channel's webhook URL, https://discord.com/api/webhooks/… (channel settings → Integrations → Webhooks).",
		"username.title": "Sender name",
		"username.description": "Shown as the sender of the messages instead of the webhook's name.",
		"threadId.title": "Thread ID",
		"threadId.description": "For a forum or media channel: the ID of the thread (post) to write in.",
	},
	ja: {
		$kind: "Discord",
		"url.title": "Webhook の URL",
		"url.description": "チャンネルの Webhook の URL（https://discord.com/api/webhooks/…）。チャンネルの設定 → 連携サービス → ウェブフックで発行します。",
		"username.title": "送信者名",
		"username.description": "Webhook の名前の代わりに、メッセージの送信者として表示します。",
		"threadId.title": "スレッド ID",
		"threadId.description": "フォーラムまたはメディアチャンネルの場合: 書き込むスレッド（投稿）の ID。",
	},
} as const satisfies NotifierMessages;
