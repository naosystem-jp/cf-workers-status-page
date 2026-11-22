/** Per-page appearance in D1 (one language). One row per page that has been customised. */
import { type AppearanceColors, appearanceColorsSchema, NO_COLORS, type PageAppearance } from "../../shared/admin-api";
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
	updated_at: number;
	updated_by: string | null;
	version: number;
};

const COLUMNS =
	"page_id, title, description, logo_url, website_url, logo_image, favicon_image, colors, updated_at, updated_by, version";

/** The fields an edit replaces. The optional ones keep their current values when `undefined`. */
export type AppearanceFields = Pick<PageAppearance, "title" | "description" | "logoUrl" | "websiteUrl"> & {
	readonly logoImage?: string | null | undefined;
	readonly faviconImage?: string | null | undefined;
	/** `null`: the template's colours throughout. */
	readonly colors?: AppearanceColors | null | undefined;
};

/** Whether no colour is set. */
function noColorSet(colors: AppearanceColors): boolean {
	return Object.values(colors).every((scheme) => Object.values(scheme).every((color) => color === null));
}

/** The column's value: NULL when every colour is the template's. */
function colorsColumn(colors: AppearanceColors | null): string | null {
	return colors === null || noColorSet(colors) ? null : JSON.stringify(colors);
}

/** The colours of a row; the template's when the column is empty or not valid (written by a newer version, say). */
function parseColors(text: string | null): AppearanceColors {
	if (text === null) return NO_COLORS;
	try {
		const parsed = appearanceColorsSchema.safeParse(JSON.parse(text));
		if (parsed.success) return parsed.data;
	} catch {
		// Not JSON: fall through.
	}
	console.warn("A page's colours could not be read; showing the template's");
	return NO_COLORS;
}

function toAppearance(row: AppearanceRow): PageAppearance {
	return {
		pageId: row.page_id,
		title: row.title,
		description: row.description,
		logoUrl: row.logo_url,
		websiteUrl: row.website_url,
		logoImage: row.logo_image,
		faviconImage: row.favicon_image,
		colors: parseColors(row.colors),
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
	const columns: [string, string | null][] = [
		["title", fields.title],
		["description", fields.description],
		["logo_url", fields.logoUrl],
		["website_url", fields.websiteUrl],
	];
	const optional: [string, string | null | undefined][] = [
		["logo_image", fields.logoImage],
		["favicon_image", fields.faviconImage],
		["colors", fields.colors === undefined ? undefined : colorsColumn(fields.colors)],
	];
	let statement: D1PreparedStatement;
	if (version === 0) {
		const values = [...columns, ...optional].map(([, value]) => value ?? null);
		statement = db
			.prepare(
				`INSERT INTO page_appearance (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
				ON CONFLICT (page_id) DO NOTHING
				RETURNING ${COLUMNS}`,
			)
			.bind(pageId, ...values, now, actorName(actor));
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

/** The title of every page that has one, for the public list of pages. Reads one row per customised page. */
export async function listAppearanceTitles(db: D1Database): Promise<Map<string, string>> {
	const { results } = await db
		.prepare("SELECT page_id, title FROM page_appearance WHERE title IS NOT NULL")
		.all<{ page_id: string; title: string }>();
	return new Map(results.map((row) => [row.page_id, row.title]));
}
