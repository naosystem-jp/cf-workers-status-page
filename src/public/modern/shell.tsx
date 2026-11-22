/**
 * The modern template's frame (pages[].template "modern"): a dark header with the page's
 * logo or title, its links and the report link, one card for the content, and a footer
 * with the page's links and text, the time zone, the language and a light/dark switch. Its styles (modern.css) and fonts are loaded
 * with this module only, so that the default template never downloads them.
 */
import { type ReactNode, useLayoutEffect, useState } from "react";
import type { PublicAppearance, State } from "../../../shared/public-api";
import { LanguageSelect, useI18n } from "../../i18n/I18nProvider";
import { Link } from "../../lib/router";
import { useBrandAppearance } from "../brand";
import { FooterLinks, frameTexts, SiteNav } from "../Navigation";
import { useMediaQuery } from "../UptimeBars";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-jp/wght.css";
import "./modern.css";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type Theme = "light" | "dark";

/** Where a theme chosen with the switch is remembered, in this browser only. */
export const THEME_STORAGE_KEY = "cf-workers-status-page:theme";

function savedTheme(): Theme | null {
	try {
		const saved = localStorage.getItem(THEME_STORAGE_KEY);
		return saved === "light" || saved === "dark" ? saved : null;
	} catch {
		return null;
	}
}

function saveTheme(theme: Theme): void {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		// Storage can be blocked: the choice lasts this visit only.
	}
}

/**
 * The theme shown: the one chosen with the switch, else the system's. The template and theme
 * are set on `<html>`, so that the whole page (its background included) follows them, and
 * removed when the page leaves (another page of the site may use the default template).
 */
export function useTheme(): { readonly theme: Theme; choose(theme: Theme): void } {
	const [chosen, setChosen] = useState<Theme | null>(savedTheme);
	const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
	// Before the first paint, so that the page never shows without its colours.
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.dataset["template"] = "modern";
		if (chosen === null) delete root.dataset["theme"];
		else root.dataset["theme"] = chosen;
		return () => {
			delete root.dataset["template"];
			delete root.dataset["theme"];
		};
	}, [chosen]);
	return {
		theme: chosen ?? (systemDark ? "dark" : "light"),
		choose: (theme) => {
			saveTheme(theme);
			setChosen(theme);
		},
	};
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/** What a glyph shows: a state, maintenance, or "this may be out of date". */
export type Tone = State | "maintenance" | "stale";

/**
 * A filled circle with a mark: a check (up), a bar (degraded), a cross (down), a question mark
 * (unknown), clock hands (maintenance) or an exclamation mark (stale). Marks differ in shape,
 * not only in colour. Decorative: the text next to it says what it means.
 */
export function Glyph({ tone, size = 18 }: { readonly tone: Tone; readonly size?: number }) {
	return (
		<svg className={`m-glyph m-glyph--${tone}`} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
			<circle cx="10" cy="10" r="9" className="m-glyph__disc" />
			{tone === "up" && <polyline points="6 10.5 8.8 13 14 7.5" className="m-glyph__mark" />}
			{tone === "degraded" && <line x1="6" y1="10" x2="14" y2="10" className="m-glyph__mark" />}
			{tone === "down" && (
				<>
					<line x1="7" y1="7" x2="13" y2="13" className="m-glyph__mark" />
					<line x1="13" y1="7" x2="7" y2="13" className="m-glyph__mark" />
				</>
			)}
			{tone === "unknown" && (
				<>
					<path d="M7.6 7.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.4v.3" className="m-glyph__mark" />
					<circle cx="10" cy="14.4" r="1.1" className="m-glyph__dot" />
				</>
			)}
			{tone === "maintenance" && <polyline points="10 5.5 10 10 13 12" className="m-glyph__mark" />}
			{tone === "stale" && (
				<>
					<line x1="10" y1="5.5" x2="10" y2="11" className="m-glyph__mark" />
					<circle cx="10" cy="14.2" r="1.1" className="m-glyph__dot" />
				</>
			)}
		</svg>
	);
}

/** A stroke icon for buttons and links, in the text's colour. */
export function StrokeIcon({ name, size = 16 }: { readonly name: "chevron-down" | "chevron-right" | "calendar" | "sun" | "moon"; readonly size?: number }) {
	return (
		<svg className="m-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			{name === "chevron-down" && <polyline points="6 9 12 15 18 9" />}
			{name === "chevron-right" && <polyline points="9 6 15 12 9 18" />}
			{name === "calendar" && (
				<>
					<rect x="3" y="4" width="18" height="18" rx="2" />
					<line x1="16" y1="2" x2="16" y2="6" />
					<line x1="8" y1="2" x2="8" y2="6" />
					<line x1="3" y1="10" x2="21" y2="10" />
				</>
			)}
			{name === "sun" && (
				<>
					<circle cx="12" cy="12" r="4" />
					<line x1="12" y1="2" x2="12" y2="4" />
					<line x1="12" y1="20" x2="12" y2="22" />
					<line x1="2" y1="12" x2="4" y2="12" />
					<line x1="20" y1="12" x2="22" y2="12" />
					<line x1="4.9" y1="4.9" x2="6.3" y2="6.3" />
					<line x1="17.7" y1="17.7" x2="19.1" y2="19.1" />
					<line x1="4.9" y1="19.1" x2="6.3" y2="17.7" />
					<line x1="17.7" y1="6.3" x2="19.1" y2="4.9" />
				</>
			)}
			{name === "moon" && <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />}
		</svg>
	);
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

export interface ShellProps {
	readonly appearance: PublicAppearance | undefined;
	/** `null` before the page's status arrived: the header keeps its place, without a title. */
	readonly title: string | null;
	/** The status page's own address, where the title links without a website. */
	readonly home: string;
	readonly reportUrl: string | null;
	readonly children: ReactNode;
	/** Under the card, before the footer's own lines. */
	readonly after?: ReactNode;
}

/** The page: header, the card holding `children`, and footer. Applies the page's colours and favicon (../brand.ts). */
export function Shell({ appearance, title, home, reportUrl, children, after }: ShellProps) {
	const { t } = useI18n();
	const { theme, choose } = useTheme();
	useBrandAppearance(appearance);
	return (
		<div className="modern" data-theme={theme}>
			<a className="m-skip" href="#main">
				{t("ui.skipToContent")}
			</a>
			<Header appearance={appearance} title={title} home={home} reportUrl={reportUrl} />
			<main id="main" tabIndex={-1} className="m-main">
				<div className="m-card">{children}</div>
				{after}
			</main>
			<Footer appearance={appearance} title={title} theme={theme} onTheme={choose} />
		</div>
	);
}

function Header({ appearance, title, home, reportUrl }: Omit<ShellProps, "children" | "after">) {
	const { t, locale } = useI18n();
	if (title === null) {
		// The logo or title is not known yet: an invisible mark and line keep the header's height.
		return (
			<header className="m-header">
				<div className="m-header__inner">
					<div className="m-brand m-brand--pending" aria-hidden="true">
						<span className="m-brand__link">
							<svg className="m-brand__mark" width="30" height="30" viewBox="0 0 28 28" focusable="false" />
							<span className="m-brand__title">&nbsp;</span>
						</span>
					</div>
				</div>
			</header>
		);
	}
	const { description, nav } = frameTexts(appearance, locale);
	const brand = (
		<>
			{appearance?.logoUrl ? (
				<img className="m-brand__logo" src={appearance.logoUrl} alt="" referrerPolicy="no-referrer" />
			) : (
				<svg className="m-brand__mark" width="30" height="30" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
					<rect width="28" height="28" rx="8" />
					<polyline points="5 15 10 15 12.5 9 16 20 18.5 13 23 13" />
				</svg>
			)}
			<span className="m-brand__title">{title}</span>
		</>
	);
	return (
		<header className="m-header">
			<div className="m-header__inner">
				<div className="m-brand">
					{appearance?.websiteUrl ? (
						<a className="m-brand__link" href={appearance.websiteUrl} rel="noopener noreferrer">
							{brand}
							<span className="m-visually-hidden"> ({t("public.header.website")})</span>
						</a>
					) : (
						<Link href={home} className="m-brand__link">
							{brand}
						</Link>
					)}
					{description && <p className="m-brand__description">{description}</p>}
				</div>
				<SiteNav
					nav={nav}
					after={
						reportUrl === null ? undefined : (
							// The report link keeps its own place, after the page's links.
							<a className="m-header__link" href={reportUrl} rel="noopener noreferrer">
								{t("public.modern.report")}
							</a>
						)
					}
				/>
			</div>
		</header>
	);
}

function Footer({
	appearance,
	title,
	theme,
	onTheme,
}: {
	readonly appearance: PublicAppearance | undefined;
	readonly title: string | null;
	readonly theme: Theme;
	onTheme(theme: Theme): void;
}) {
	const { t, f, locale } = useI18n();
	const website = appearance?.websiteUrl ? hostOf(appearance.websiteUrl) : null;
	return (
		<footer className="m-footer">
			<FooterLinks footer={frameTexts(appearance, locale).footer} />
			<div className="m-footer__lines">
				<p>{t("public.footer.timeZone", { timeZone: f.timeZone })}</p>
				{website !== null && appearance?.websiteUrl && (
					<p>
						{title} · <a href={appearance.websiteUrl}>{website}</a>
					</p>
				)}
			</div>
			<div className="m-footer__controls">
				<LanguageSelect className="m-language" />
				<div className="m-segmented" role="group" aria-label={t("public.modern.theme")}>
					{(["light", "dark"] as const).map((option) => (
						<button
							key={option}
							type="button"
							className="m-segmented__option m-segmented__option--icon"
							aria-pressed={theme === option}
							aria-label={t(`public.modern.theme.${option}`)}
							title={t(`public.modern.theme.${option}`)}
							onClick={() => onTheme(option)}
						>
							<StrokeIcon name={option === "light" ? "sun" : "moon"} size={14} />
						</button>
					))}
				</div>
			</div>
		</footer>
	);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
