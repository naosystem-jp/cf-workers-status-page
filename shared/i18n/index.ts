/**
 * Translations, shared by the Worker (notifications and automatic incidents,
 * in the `locale` of status.config.ts) and the React app (the browser's language).
 *
 * ## Adding a language
 *
 * Copy `locales/en.ts` to `locales/<tag>.ts` (notifications and the status page) and
 * `admin/en.ts` to `admin/<tag>.ts` (the admin UI), where `<tag>` is a BCP 47 language tag such
 * as `fr` or `pt-BR`, and translate the messages; type them `satisfies Translation` and
 * `satisfies AdminTranslation`. Nothing else needs to change: the files are found when the app
 * is built (Vite's `import.meta.glob`). Messages left out show in English, so a partial
 * translation works, but the tests ask for every message (and every `{name}` placeholder of the
 * English message) in the bundled languages.
 *
 * This module loads every language of `locales/` at once, for the Worker (the admin UI's
 * messages are not part of it). The status page loads only the language it shows, the admin UI
 * that language's two files (src/i18n/catalog.ts, src/admin/messages.ts); all use `core.ts`.
 */
import { durationText, localeOfFile, makeTranslator, matchLocale, type Translate, type Translation } from "./core";
import en from "./locales/en";

export {
	DEFAULT_LOCALE,
	interpolate,
	type MessageKey,
	type MessageParams,
	type Messages,
	placeholders,
	type Translate,
	type Translation,
} from "./core";

const files = import.meta.glob<Translation>("./locales/*.ts", { eager: true, import: "default" });

/** Every bundled language, by its canonical tag (from the file name). */
export const TRANSLATIONS: ReadonlyMap<string, Translation> = new Map(
	Object.entries(files).flatMap(([path, messages]) => {
		const tag = localeOfFile(path);
		if (tag === undefined) {
			console.warn(`Ignoring translation file ${path}: its name is not a language tag`);
			return [];
		}
		return [[tag, messages] as const];
	}),
);

/** Canonical tags of the bundled languages, sorted. */
export const LOCALES: readonly string[] = [...TRANSLATIONS.keys()].sort();

/**
 * The bundled language that best matches `requested` (a tag, or a list in order of
 * preference such as `navigator.languages`): an exact match, else the same language without
 * region or script (`ja-JP` → `ja`), else a regional variant of it (`pt` → `pt-BR`), else
 * English.
 */
export function resolveLocale(requested: string | readonly string[] | null | undefined): string {
	return matchLocale(requested, LOCALES);
}

/** Messages in `locale` (resolved with {@link resolveLocale}), falling back to English message by message. */
export function translator(locale: string): Translate {
	return makeTranslator(TRANSLATIONS.get(resolveLocale(locale)) ?? {}, en);
}

/** A moment as people read it in `locale`, in `timeZone`, with the zone: "Jan 1, 2100, 9:00:00 AM GMT+9". */
export function formatTime(at: number, locale: string, timeZone: string): string {
	return new Intl.DateTimeFormat(resolveLocale(locale), { dateStyle: "medium", timeStyle: "long", timeZone }).format(at);
}

/** A duration in at most two units, such as "1 hour, 5 minutes" or "45 seconds". */
export function formatDuration(ms: number, locale: string): string {
	return durationText(ms, resolveLocale(locale));
}
