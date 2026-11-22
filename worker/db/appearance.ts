/**
 * Per-page appearance in D1. One row per page that has been customised.
 *
 * Every field that status.config.ts can also set is NULL to keep status.config.ts's, and
 * `""` (a text or URL) or an empty list (header, footer) to clear it: the two never collapse
 * into one another. Titles and descriptions written per language keep the English (else first)
 * text in their own column and the languages in `translations` (worker/db/schema.ts, version 5).
 */
import { footerSchema, headerSchema, type LocalizedText, type ResolvedFooter, type ResolvedHeader } from "@naosystem/cf-workers-status-page-core";
import type * as z from "zod";
import { type AppearanceColors, appearanceColorsSchema, NO_COLORS, type PageAppearance } from "../../shared/admin-api";
import { pickText } from "../../shared/i18n/core";
import { type Actor, actorName, type EditResult } from "./common";

type AppearanceRow = {
	page_id: string;
	title: string | null;
	description: string | null;
	logo_url: string | null;
	website_url: string | null;
	logo_image: string | null;
	favicon_image: string | null;
	colors: string | null;
	translations: string | null;
	header: string | null;
	footer: string | null;
	updated_at: number;
	updated_by: string | null;
	version: number;
};

const COLUMNS =
	"page_id, title, description, logo_url, website_url, logo_image, favicon_image, colors, translations, header, footer, updated_at, updated_by, version";

/** The fields an edit replaces. The optional ones keep their current values when `undefined`. */
export type AppearanceFields = Pick<PageAppearance, "title" | "description" | "logoUrl" | "websiteUrl"> & {
	readonly logoImage?: string | null | undefined;
	readonly faviconImage?: string | null | undefined;
	/** `null`: the template's colours throughout. */
	readonly colors?: AppearanceColors | null | undefined;
	/** `null`: status.config.ts's. */
	readonly header?: ResolvedHeader | null | undefined;
	readonly footer?: ResolvedFooter | null | undefined;
};

/** Whether no colour is set. */
function noColorSet(colors: AppearanceColors): boolean {
	return Object.values(colors).every((scheme) => Object.values(scheme).every((color) => color === null));
}

/** The column's value: NULL when every colour is the template's. */
function colorsColumn(colors: AppearanceColors | null): string | null {
	return colors === null || noColorSet(colors) ? null : JSON.stringify(colors);
}

/** JSON of a column, or `undefined` when it is not JSON. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The colours of a row; the template's when the column is empty or not valid (written by a newer version, say). */
function parseColors(text: string | null): AppearanceColors {
	if (text === null) return NO_COLORS;
	const parsed = appearanceColorsSchema.safeParse(parseJson(text));
	if (parsed.success) return parsed.data;
	console.warn("A page's colours could not be read; showing the template's");
	return NO_COLORS;
}

/**
 * The header or footer of a row: `null` (status.config.ts's) when the column is NULL, or when it
 * is not valid (written by a newer version, say), as the fields an administrator never set.
 */
function parseFrameColumn<T>(text: string | null, schema: z.ZodType<T>, what: string): T | null {
	if (text === null) return null;
	const parsed = schema.safeParse(parseJson(text));
	if (parsed.success) return parsed.data;
	console.warn(`A page's ${what} could not be read; showing status.config.ts's`);
	return null;
}

type Translations = { readonly title?: Readonly<Record<string, string>>; readonly description?: Readonly<Record<string, string>> };

/** Texts by language of a row; none when the column is NULL or not valid (its columns' texts then show). */
function parseTranslations(text: string | null): Translations {
	if (text === null) return {};
	const value = parseJson(text);
	const isTexts = (texts: unknown): texts is Record<string, string> =>
		typeof texts === "object" && texts !== null && !Array.isArray(texts) && Object.keys(texts).length > 0 && Object.values(texts).every((item) => typeof item === "string");
	if (typeof value !== "object" || value === null) {
		console.warn("A page's texts by language could not be read; showing them in one language");
		return {};
	}
	const { title, description } = value as Record<string, unknown>;
	return { ...(isTexts(title) ? { title } : {}), ...(isTexts(description) ? { description } : {}) };
}

/** The columns of a text: itself, or its English (else first) text and its languages. */
function textColumn(text: LocalizedText | null): { readonly column: string | null; readonly languages: Readonly<Record<string, string>> | undefined } {
	return typeof text === "object" && text !== null ? { column: pickText(text, "en"), languages: text } : { column: text, languages: undefined };
}

function toAppearance(row: AppearanceRow): PageAppearance {
	const translations = parseTranslations(row.translations);
	return {
		pageId: row.page_id,
		title: translations.title ?? row.title,
		description: translations.description ?? row.description,
		logoUrl: row.logo_url,
		websiteUrl: row.website_url,
		logoImage: row.logo_image,
		faviconImage: row.favicon_image,
		colors: parseColors(row.colors),
		header: parseFrameColumn(row.header, headerSchema, "header"),
		footer: parseFrameColumn(row.footer, footerSchema, "footer"),
		updatedAt: row.updated_at,
		updatedBy: row.updated_by,
		version: row.version,
	};
}

/** A page's appearance before it was ever customised: every field the default, version 0. */
export function defaultAppearance(pageId: string): PageAppearance {
	return {
		pageId,
		title: null,
		description: null,
		logoUrl: null,
		websiteUrl: null,
		logoImage: null,
		faviconImage: null,
		colors: NO_COLORS,
		header: null,
		footer: null,
		updatedAt: null,
		updatedBy: null,
		version: 0,
	};
}

/** The page's appearance; every field `null` (the defaults) and version 0 when it was never customised. */
export async function getAppearance(db: D1Database, pageId: string): Promise<PageAppearance> {
	const row = await db.prepare(`SELECT ${COLUMNS} FROM page_appearance WHERE page_id = ?`).bind(pageId).first<AppearanceRow>();
	return row === null ? defaultAppearance(pageId) : toAppearance(row);
}

/** `undefined` stays `undefined` (keep the column); `null` is NULL; anything else JSON. */
function jsonColumn(value: object | null | undefined): string | null | undefined {
	return value === undefined || value === null ? value : JSON.stringify(value);
}

/**
 * Replaces the page's appearance, if it is still at `version` (0: never customised),
 * checked in the same statement as the write. Optional fields left `undefined` keep their
 * values (on a first save: the defaults).
 */
export async function putAppearance(
	db: D1Database,
	pageId: string,
	version: number,
	fields: AppearanceFields,
	actor: Actor,
	now = Date.now(),
): Promise<EditResult<PageAppearance>> {
	const title = textColumn(fields.title);
	const description = textColumn(fields.description);
	const languages = { title: title.languages, description: description.languages };
	const columns: [string, string | null][] = [
		["title", title.column],
		["description", description.column],
		["logo_url", fields.logoUrl],
		["website_url", fields.websiteUrl],
		["translations", languages.title === undefined && languages.description === undefined ? null : JSON.stringify(languages)],
	];
	const optional: [string, string | null | undefined][] = [
		["logo_image", fields.logoImage],
		["favicon_image", fields.faviconImage],
		["colors", fields.colors === undefined ? undefined : colorsColumn(fields.colors)],
		["header", jsonColumn(fields.header)],
		["footer", jsonColumn(fields.footer)],
	];
	let statement: D1PreparedStatement;
	if (version === 0) {
		const all = [...columns, ...optional];
		statement = db
			.prepare(
				`INSERT INTO page_appearance (page_id, ${all.map(([column]) => column).join(", ")}, updated_at, updated_by, version)
				VALUES (?, ${all.map(() => "?").join(", ")}, ?, ?, 1)
				ON CONFLICT (page_id) DO NOTHING
				RETURNING ${COLUMNS}`,
			)
			.bind(pageId, ...all.map(([, value]) => value ?? null), now, actorName(actor));
	} else {
		const set = [...columns, ...optional.filter(([, value]) => value !== undefined)] as [string, string | null][];
		statement = db
			.prepare(
				`UPDATE page_appearance SET ${set.map(([column]) => `${column} = ?`).join(", ")},
					updated_at = ?, updated_by = ?, version = version + 1
				WHERE page_id = ? AND version = ?
				RETURNING ${COLUMNS}`,
			)
			.bind(...set.map(([, value]) => value), now, actorName(actor), pageId, version);
	}
	const row = await statement.first<AppearanceRow>();
	if (row !== null) return { status: "updated", value: toAppearance(row) };
	// A page always has an appearance (the defaults at version 0), so a mismatch is a conflict.
	return { status: "conflict", current: await getAppearance(db, pageId) };
}

/**
 * The title an administrator set, in one language (English, else the first), of every page that
 * has one, for the public list of pages. Reads one row per customised page.
 */
export async function listAppearanceTitles(db: D1Database): Promise<Map<string, string>> {
	const { results } = await db
		.prepare("SELECT page_id, title FROM page_appearance WHERE title IS NOT NULL")
		.all<{ page_id: string; title: string }>();
	return new Map(results.map((row) => [row.page_id, row.title]));
}
