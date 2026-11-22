/**
 * The translation mechanism without the translations: matching a requested
 * language to the bundled ones, interpolation, and formatting. `index.ts` loads every
 * translation at once, for the Worker; the React app loads only the visitor's language
 * (src/i18n/catalog.ts). Both find the files with Vite's `import.meta.glob`.
 */
import type adminEn from "./admin/en";
import type en from "./locales/en";

/** The messages, keyed by identifier, in the reference language (English). */
export type Messages = typeof en;
export type MessageKey = keyof Messages;
/** A language's messages: any of them; missing ones fall back to English. */
export type Translation = Partial<Record<MessageKey, string>>;

/**
 * The admin UI's own messages (`admin/<tag>.ts`), apart from the status page's so that visitors
 * never download them. The admin UI uses both sets.
 */
export type AdminMessages = typeof adminEn;
export type AdminMessageKey = keyof AdminMessages;
export type AdminTranslation = Partial<Record<AdminMessageKey, string>>;

export const DEFAULT_LOCALE = "en";

/** The canonical form of a BCP 47 tag (`pt-br` → `pt-BR`), or `undefined` when it is not one. */
export function canonicalLocale(tag: string): string | undefined {
	try {
		return Intl.getCanonicalLocales(tag)[0];
	} catch {
		return undefined;
	}
}

/** The language of a translation file, from its name (`./locales/pt-BR.ts` → `pt-BR`). */
export function localeOfFile(path: string): string | undefined {
	const tag = /\/([^/]+)\.ts$/.exec(path)?.[1];
	return tag === undefined ? undefined : canonicalLocale(tag);
}

/**
 * The language of `available` that best matches `requested` (a tag, or a list in order of
 * preference such as `navigator.languages`): an exact match, else the same language without
 * region or script (`ja-JP` → `ja`), else a regional variant of it (`pt` → `pt-BR`), else
 * English.
 */
export function matchLocale(requested: string | readonly string[] | null | undefined, available: readonly string[]): string {
	const tags = requested === null || requested === undefined ? [] : typeof requested === "string" ? [requested] : requested;
	const sorted = [...available].sort();
	const byLowerCase = new Map(sorted.map((tag) => [tag.toLowerCase(), tag]));
	for (const tag of tags) {
		const wanted = canonicalLocale(tag)?.toLowerCase();
		if (wanted === undefined) continue;
		const exact = byLowerCase.get(wanted);
		if (exact !== undefined) return exact;
		const language = wanted.split("-")[0] as string;
		const base = byLowerCase.get(language);
		if (base !== undefined) return base;
		const variant = sorted.find((candidate) => candidate.toLowerCase().startsWith(`${language}-`));
		if (variant !== undefined) return variant;
	}
	return DEFAULT_LOCALE;
}

export type MessageParams = Readonly<Record<string, string | number>>;

/** Replaces each `{name}` with `params[name]`; placeholders without a value are left as they are. */
export function interpolate(template: string, params: MessageParams = {}): string {
	return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : placeholder,
	);
}

/** Placeholder names in a message, in order of appearance, without duplicates. */
export function placeholders(template: string): string[] {
	return [...new Set([...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string))];
}

export type Translate<K extends string = MessageKey> = (key: K, params?: MessageParams) => string;

const reported = new Set<string>();

/**
 * Messages from `messages`, falling back to `reference` (English) message by message. A key that
 * no message has (a state or stage newer than this code, sent by a newer API) shows as the key
 * itself, and is logged once, rather than failing the page.
 */
export function makeTranslator<K extends string>(
	messages: Partial<Record<K, string>>,
	reference: Readonly<Record<K, string>>,
): Translate<K> {
	return (key, params) => {
		const template = messages[key] ?? reference[key];
		if (typeof template === "string") return interpolate(template, params);
		if (!reported.has(key)) {
			reported.add(key);
			console.warn(`No message "${key}"`);
		}
		return key;
	};
}

/** A duration in at most two units, such as "1 hour, 5 minutes" or "45 seconds", in the language `tag`. */
export function durationText(ms: number, tag: string): string {
	const seconds = Math.max(0, Math.round(ms / 1_000));
	const units: [Intl.NumberFormatOptions["unit"] & string, number][] = [
		["day", Math.floor(seconds / 86_400)],
		["hour", Math.floor((seconds % 86_400) / 3_600)],
		["minute", Math.floor((seconds % 3_600) / 60)],
		["second", seconds % 60],
	];
	const first = units.findIndex(([, value]) => value > 0);
	if (first === -1) return new Intl.NumberFormat(tag, { style: "unit", unit: "second", unitDisplay: "long" }).format(0);
	const parts = units
		.slice(first, first + 2)
		.filter(([, value]) => value > 0)
		.map(([unit, value]) => new Intl.NumberFormat(tag, { style: "unit", unit, unitDisplay: "long" }).format(value));
	return new Intl.ListFormat(tag, { style: "long", type: "unit" }).format(parts);
}
