import type { NotifierMessages } from "@naosystem/cf-workers-status-page-core";

/** Texts of the admin UI's form for webhook targets (English is also the schema's `title`/`description`). */
export const messages = {
	en: {
		$kind: "Webhook",
		"url.title": "URL",
		"url.description": "Where to POST each notification as JSON (https).",
		"signingSecret.title": "Signing secret",
		"signingSecret.description":
			"At least 16 characters. Each request is then signed (X-CF-Workers-Status-Page-Signature), so that the receiver can check that it comes from here.",
		"headers.title": "Headers",
		"headers.description": "Extra request headers, such as Authorization.",
	},
	ja: {
		$kind: "Webhook",
		"url.title": "URL",
		"url.description": "通知を JSON で POST する送り先（https）。",
		"signingSecret.title": "署名用のシークレット",
		"signingSecret.description": "16文字以上。各リクエストに署名（X-CF-Workers-Status-Page-Signature）を付け、受信側で送信元を確かめられるようにします。",
		"headers.title": "ヘッダー",
		"headers.description": "Authorization など、追加するリクエストヘッダー。",
	},
} as const satisfies NotifierMessages;
