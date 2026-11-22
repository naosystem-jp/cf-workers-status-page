import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { makeTranslator, type MessageKey, type Translate } from "../../shared/i18n/core";
import { type Catalog, STATUS_CATALOG, saveLocale, UI_LOCALES } from "./catalog";
import { type Formatters, formatters } from "./format";

export interface I18n<K extends string = MessageKey> {
	/** The language shown (a bundled language's tag). */
	readonly locale: string;
	readonly t: Translate<K>;
	readonly f: Formatters;
	/** Switches the language and remembers the choice in this browser. */
	setLocale(tag: string): void;
}

interface Context {
	readonly catalog: Catalog<string>;
	readonly i18n: I18n<string>;
}

const I18nContext = createContext<Context | null>(null);

export interface I18nProviderProps<K extends string> {
	/** Which messages: the status page's (default) or the admin UI's. */
	readonly catalog?: Catalog<K>;
	readonly locale: string;
	readonly messages: Partial<Record<K, string>>;
	/** The time zone times are shown in; default: the viewer's. Tests pin it. */
	readonly timeZone?: string;
	readonly children: ReactNode;
}

/** Provides translations and formatters; the language can change at run time (see {@link LanguageSelect}). */
export function I18nProvider<K extends string>({ catalog, locale: initialLocale, messages: initialMessages, timeZone, children }: I18nProviderProps<K>) {
	const source = (catalog ?? STATUS_CATALOG) as Catalog<string>;
	const [current, setCurrent] = useState<{ locale: string; messages: Partial<Record<string, string>> }>({
		locale: initialLocale,
		messages: initialMessages,
	});
	// Only the latest choice applies, however the loads finish.
	const latest = useRef(0);
	const setLocale = useCallback(
		(tag: string) => {
			saveLocale(tag);
			const request = ++latest.current;
			void source.load(tag).then((messages) => {
				if (request !== latest.current) return;
				setCurrent({ locale: tag, messages });
				document.documentElement.lang = tag;
			});
		},
		[source],
	);
	const value = useMemo<Context>(
		() => ({
			catalog: source,
			i18n: {
				locale: current.locale,
				t: makeTranslator(current.messages, source.reference),
				f: formatters(current.locale, timeZone),
				setLocale,
			},
		}),
		[current, timeZone, setLocale, source],
	);
	return <I18nContext value={value}>{children}</I18nContext>;
}

/** Translations of the status page's messages (available everywhere). */
export function useI18n(): I18n {
	const value = useContext(I18nContext);
	if (value === null) throw new Error("useI18n() outside <I18nProvider>");
	return value.i18n as I18n;
}

/** Translations of `catalog`'s messages; the provider must have been given that catalog. */
export function useCatalog<K extends string>(catalog: Catalog<K>): I18n<K> {
	const value = useContext(I18nContext);
	if (value === null) throw new Error("useCatalog() outside <I18nProvider>");
	if (value.catalog !== (catalog as Catalog<string>)) throw new Error("The <I18nProvider> above has another catalog");
	return value.i18n as I18n<K>;
}

/** Each language's name in that language, for the language menu. */
function nativeName(tag: string): string {
	try {
		return new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
	} catch {
		return tag;
	}
}

/** The language menu; nothing when only one language is bundled. */
export function LanguageSelect({ className }: { readonly className?: string }) {
	const { locale, t, setLocale } = useI18n();
	if (UI_LOCALES.length < 2) return null;
	return (
		<label className={className}>
			<span>{t("ui.language")}</span>{" "}
			<select value={locale} onChange={(event) => setLocale(event.target.value)}>
				{UI_LOCALES.map((tag) => (
					<option key={tag} value={tag} lang={tag}>
						{nativeName(tag)}
					</option>
				))}
			</select>
		</label>
	);
}
