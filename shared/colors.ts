/**
 * Colours an administrator sets for a page: contrast (WCAG 2), the
 * templates' own colours, and the CSS custom properties the status page sets from them.
 *
 * The status page sets `--brand-<scheme>-<role>` on `<html>` (through the CSSOM, which the
 * page's Content-Security-Policy allows, unlike a `style` attribute), and the templates' tokens
 * fall back to their own colours where one is not set: `--bg: var(--brand-light-background,
 * #ffffff)` (src/index.css, src/public/modern/modern.css). The header's text is chosen here,
 * dark or light, whichever reads better on the header's colour, so that no colour an
 * administrator picks leaves the title unreadable.
 */
import type { PageTemplate } from "./public-api";
import { type AppearanceColors, COLOR_ROLES, COLOR_SCHEMES, type ColorRole, type ColorScheme, HEX_COLOR, type ThemeColors } from "./vocabulary";

/** WCAG 2's minimum for normal text (AA). */
export const MIN_TEXT_CONTRAST = 4.5;

/** Relative luminance of `#rrggbb` (WCAG 2), from 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
	if (!HEX_COLOR.test(hex.toLowerCase())) throw new Error(`Not a colour: ${hex}`);
	const channel = (offset: number) => {
		const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contrast ratio of two colours, from 1 (the same) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
	return (light + 0.05) / (dark + 0.05);
}

/** Text on a dark header (the templates' own). */
export const LIGHT_TEXT = "#ffffff";
/** Text on a light header: the modern template's darkest colour. */
export const DARK_TEXT = "#0b1020";

/** The text colour that reads better on `background`: {@link LIGHT_TEXT} or {@link DARK_TEXT}. */
export function readableTextOn(background: string): string {
	return contrastRatio(LIGHT_TEXT, background) >= contrastRatio(DARK_TEXT, background) ? LIGHT_TEXT : DARK_TEXT;
}

/**
 * The custom properties for `colors`, to set on `<html>`: one per colour set, and, for a header
 * colour, the header's text (title, description, links and mark) in a colour that reads on it.
 * Colours not set have no property, so the template's own apply.
 */
export function brandProperties(colors: AppearanceColors): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const scheme of COLOR_SCHEMES) {
		for (const role of COLOR_ROLES) {
			const value = colors[scheme][role];
			if (value === null || !HEX_COLOR.test(value)) continue;
			properties[`--brand-${scheme}-${role}`] = value;
			if (role === "header") properties[`--brand-${scheme}-header-text`] = readableTextOn(value);
		}
	}
	return properties;
}

export interface TemplateColors {
	/** Behind the page. */
	readonly background: string;
	/** The header bar; `null` where the template has none. */
	readonly header: string | null;
	/** Links and focus outlines. */
	readonly accent: string;
	/** Text set directly on the background (the modern template's footer, the default template's everything). */
	readonly textOnBackground: string;
	/** What content and its links sit on: `null` for the background itself; the modern template's cards. */
	readonly surface: string | null;
	/** Text on {@link surface}. */
	readonly text: string;
}

/** The templates' own colours (src/index.css, src/public/modern/modern.css), for the admin UI's checks and preview. */
export const TEMPLATE_COLORS: Readonly<Record<PageTemplate, Readonly<Record<ColorScheme, TemplateColors>>>> = {
	default: {
		light: { background: "#ffffff", header: null, accent: "#0969da", textOnBackground: "#1f2328", surface: null, text: "#1f2328" },
		dark: { background: "#0d1117", header: null, accent: "#4493f8", textOnBackground: "#e6edf3", surface: null, text: "#e6edf3" },
	},
	modern: {
		light: { background: "#f7f8fa", header: "#0b1020", accent: "#2453b8", textOnBackground: "#5b6370", surface: "#ffffff", text: "#14171c" },
		dark: { background: "#0b0e14", header: "#070a12", accent: "#8eb1ff", textOnBackground: "#9aa3b2", surface: "#12161f", text: "#e6e9ef" },
	},
};

/** The colours a page shows in `scheme`: the administrator's where set, else the template's. `header` is `null` where the template has none. */
export function effectiveColors(
	template: PageTemplate,
	scheme: ColorScheme,
	colors: ThemeColors,
): { readonly background: string; readonly header: string | null; readonly accent: string } {
	const own = TEMPLATE_COLORS[template][scheme];
	return {
		background: colors.background ?? own.background,
		header: own.header === null ? null : (colors.header ?? own.header),
		accent: colors.accent ?? own.accent,
	};
}

export interface ContrastWarning {
	/** The colour to change. */
	readonly role: Exclude<ColorRole, "header">;
	/** The contrast found, below {@link MIN_TEXT_CONTRAST}. */
	readonly ratio: number;
}

/**
 * Where text would fall below {@link MIN_TEXT_CONTRAST} in `scheme` with these colours: the
 * template's text on the background, and links on what they sit on. Only where an
 * administrator's colour is involved (the templates' own pass); the header needs no check, as
 * its text follows its colour.
 */
export function contrastWarnings(template: PageTemplate, scheme: ColorScheme, colors: ThemeColors): ContrastWarning[] {
	const own = TEMPLATE_COLORS[template][scheme];
	const shown = effectiveColors(template, scheme, colors);
	const warnings: ContrastWarning[] = [];
	if (colors.background !== null) {
		const ratio = contrastRatio(own.textOnBackground, shown.background);
		if (ratio < MIN_TEXT_CONTRAST) warnings.push({ role: "background", ratio });
	}
	const linksOnBackground = own.surface === null;
	if (colors.accent !== null || (colors.background !== null && linksOnBackground)) {
		const ratio = contrastRatio(shown.accent, own.surface ?? shown.background);
		if (ratio < MIN_TEXT_CONTRAST) warnings.push({ role: "accent", ratio });
	}
	return warnings;
}
