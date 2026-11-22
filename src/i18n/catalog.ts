/**
 * The status page's and admin UI's languages: the translation files of
 * shared/i18n, found when the app is built. English, the reference and fallback, is part of the
 * bundle; every other language is a chunk of its own, loaded only when it is shown, so that
 * adding languages does not grow what visitors download. The admin UI's messages
 * (shared/i18n/admin/) are a catalog of their own, in the admin UI's bundle only.
 */
import { DEFAULT_LOCALE, localeOfFile, type MessageKey, matchLocale, type Translation } from "../../shared/i18n/core";
import en from "../../shared/i18n/locales/en";

/** A set of messages: English, and how to load another language's. */
export interface Catalog<K extends string> {
	readonly reference: Readonly<Record<K, string>>;
	/** A bundled language's messages; English (empty) when the file cannot be loaded. */
	load(tag: string): Promise<Partial<Record<K, string>>>;
}

export type Loaders<T> = ReadonlyMap<string, () => Promise<T>>;

/** The loaders of `import.meta.glob(…, { import: "default" })`, by language. */
export function loadersByLocale<T>(files: Record<string, () => Promise<T>>): Loaders<T> {
	return new Map(
		Object.entries(files).flatMap(([path, load]) => {
			const tag = localeOfFile(path);
			return tag === undefined || tag === DEFAULT_LOCALE ? [] : [[tag, load] as const];
		}),
	);
}

/** Loads `tag` with `loaders`; English (`{}`) for English, an unknown language or a failed load. */
export async function loadWith<T extends object>(loaders: Loaders<T>, tag: string): Promise<Partial<T>> {
	const load = tag === DEFAULT_LOCALE ? undefined : loaders.get(tag);
	if (load === undefined) return {};
	try {
		return await load();
	} catch (error) {
		console.warn(`Could not load the translation "${tag}"; showing English`, error);
		return {};
	}
}

const LOADERS = loadersByLocale(
	import.meta.glob<Translation>(["../../shared/i18n/locales/*.ts", "!../../shared/i18n/locales/en.ts"], { import: "default" }),
);

/** English: every message, and the fallback for messages a translation leaves out. */
export const REFERENCE_MESSAGES = en;

/** The status page's messages (also notifications'): states, stages, impacts, the public page. */
export const STATUS_CATALOG: Catalog<MessageKey> = {
	reference: en,
	load: (tag) => loadWith(LOADERS, tag),
};

/** Canonical tags of the bundled languages (those with a status page file), sorted. */
export const UI_LOCALES: readonly string[] = [DEFAULT_LOCALE, ...LOADERS.keys()].sort();

/** The bundled language that best matches `requested` (such as `navigator.languages`), else English. */
export function pickLocale(requested: string | readonly string[] | null | undefined): string {
	return matchLocale(requested, UI_LOCALES);
}

/** The status page's messages in a bundled language (English: `en`). */
export async function loadTranslation(tag: string): Promise<Translation> {
	return tag === DEFAULT_LOCALE ? en : STATUS_CATALOG.load(tag);
}

/** Where a language chosen with the language menu is remembered, in this browser only. */
export const LOCALE_STORAGE_KEY = "cf-workers-status-page:locale";

/** The language chosen with the language menu, if it is still bundled. */
export function savedLocale(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string | null {
	try {
		const saved = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
		return saved !== null && UI_LOCALES.includes(saved) ? saved : null;
	} catch {
		return null;
	}
}

/** Remembers the language chosen with the language menu (`null` forgets it). Best effort. */
export function saveLocale(tag: string | null, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage()): void {
	try {
		if (tag === null) storage?.removeItem(LOCALE_STORAGE_KEY);
		else storage?.setItem(LOCALE_STORAGE_KEY, tag);
	} catch {
		// Storage can be blocked (private windows, site settings): the choice lasts this visit only.
	}
}

/** The language to show: the one chosen in this browser, else the best match for the browser's languages. */
export function preferredLocale(
	languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
	storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): string {
	return savedLocale(storage) ?? pickLocale(languages);
}

function safeStorage(): Storage | undefined {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
}
