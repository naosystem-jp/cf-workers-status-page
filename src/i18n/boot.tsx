import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary, type ErrorBoundaryProps } from "../components/ErrorBoundary";
import { type Catalog, preferredLocale } from "./catalog";
import { I18nProvider } from "./I18nProvider";

export interface BootOptions<K extends string> {
	readonly catalog: Catalog<K>;
	/** Shown when the app fails to render (inside the translations, so it is translated). */
	readonly fallback: ErrorBoundaryProps["fallback"];
	/** What else to load before the first render, alongside the language (it should not fail). */
	readonly prepare?: () => Promise<unknown>;
}

/**
 * Renders an app into `#rootId` once the viewer's language is loaded (English is in the
 * bundle; another language is one small request), so that nothing shows in the wrong language,
 * and what `prepare` loads.
 */
export async function boot<K extends string>(rootId: string, app: ReactNode, options: BootOptions<K>): Promise<void> {
	const element = document.getElementById(rootId);
	if (element === null) throw new Error(`#${rootId} element not found`);
	const locale = preferredLocale();
	const [messages] = await Promise.all([options.catalog.load(locale), options.prepare?.()]);
	document.documentElement.lang = locale;
	createRoot(element).render(
		<StrictMode>
			<I18nProvider catalog={options.catalog} locale={locale} messages={messages}>
				<ErrorBoundary fallback={options.fallback}>{app}</ErrorBoundary>
			</I18nProvider>
		</StrictMode>,
	);
}
