/** Helpers shared by the D1 data modules. */

/**
 * Who makes a change: an administrator (recorded by name), or automation such as
 * `incidents.auto`, recorded as `NULL`.
 */
export type Actor = { readonly kind: "admin"; readonly name: string } | { readonly kind: "automation" };

/** The name stored for `actor`: `NULL` for automation. */
export function actorName(actor: Actor): string | null {
	return actor.kind === "admin" ? actor.name : null;
}

/** The outcome of an edit made from a `version` (optimistic concurrency). */
export type EditResult<T> =
	| { readonly status: "updated"; readonly value: T }
	| { readonly status: "not-found" }
	/** Someone else changed it since that version: nothing was written. */
	| { readonly status: "conflict"; readonly current: T };

/** A position in a list ordered by (time, id), latest first. */
export interface Cursor {
	readonly at: number;
	readonly id: string;
}

const CURSOR = /^(\d{1,16}):([A-Za-z0-9-]{1,64})$/;

export function encodeCursor(cursor: Cursor): string {
	return `${cursor.at}:${cursor.id}`;
}

/** `undefined` when `value` is not a cursor this module made. */
export function decodeCursor(value: string): Cursor | undefined {
	const match = CURSOR.exec(value);
	if (match === null) return undefined;
	return { at: Number(match[1]), id: match[2] as string };
}

/**
 * Splits `limit + 1` rows into a page and the cursor for the next one (the caller asks for
 * one row more than it shows, to know whether there is a next page).
 */
export function toPage<Row, Item>(
	rows: readonly Row[],
	limit: number,
	toItem: (row: Row) => Item,
	cursorOf: (row: Row) => Cursor,
): { items: Item[]; nextCursor: string | null } {
	const shown = rows.slice(0, limit);
	const last = shown.at(-1);
	return {
		items: shown.map(toItem),
		nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null,
	};
}

/** Parses a JSON column written by this code; logs and falls back if it is damaged. */
export function parseJsonColumn<T>(value: string, fallback: T, where: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		console.warn(`Damaged JSON in ${where}; using ${JSON.stringify(fallback)}`);
		return fallback;
	}
}
