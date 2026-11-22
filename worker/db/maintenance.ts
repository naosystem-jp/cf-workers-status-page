/**
 * Scheduled maintenance in D1: written from the admin API, read by the public
 * API and by notifications, which it suppresses. Validation, including that
 * a maintenance ends after it starts and that its components exist, is the caller's job.
 */
import type { ListPage, Maintenance } from "../../shared/admin-api";
import { type Actor, actorName, type Cursor, type EditResult, parseJsonColumn, toPage } from "./common";

type MaintenanceRow = {
	id: string;
	page_id: string;
	title: string;
	body: string;
	components: string;
	starts_at: number;
	ends_at: number;
	created_at: number;
	updated_at: number;
	created_by: string | null;
	updated_by: string | null;
	version: number;
};

const COLUMNS =
	"id, page_id, title, body, components, starts_at, ends_at, created_at, updated_at, created_by, updated_by, version";

function toMaintenance(row: MaintenanceRow): Maintenance {
	return {
		id: row.id,
		pageId: row.page_id,
		title: row.title,
		body: row.body,
		components: parseJsonColumn<string[]>(row.components, [], `maintenance ${row.id}`),
		startsAt: row.starts_at,
		endsAt: row.ends_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		version: row.version,
	};
}

/** The editable fields of a maintenance. */
export interface MaintenanceFields {
	readonly title: string;
	readonly body: string;
	readonly startsAt: number;
	readonly endsAt: number;
	readonly components: readonly string[];
}

export async function createMaintenance(
	db: D1Database,
	pageId: string,
	fields: MaintenanceFields,
	actor: Actor,
	now = Date.now(),
): Promise<Maintenance> {
	const name = actorName(actor);
	const maintenance: Maintenance = {
		id: crypto.randomUUID(),
		pageId,
		...fields,
		createdAt: now,
		updatedAt: now,
		createdBy: name,
		updatedBy: name,
		version: 1,
	};
	await db
		.prepare(`INSERT INTO maintenances (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.bind(
			maintenance.id,
			pageId,
			fields.title,
			fields.body,
			JSON.stringify(fields.components),
			fields.startsAt,
			fields.endsAt,
			now,
			now,
			name,
			name,
			maintenance.version,
		)
		.run();
	return maintenance;
}

export async function getMaintenance(db: D1Database, id: string): Promise<Maintenance | null> {
	const row = await db.prepare(`SELECT ${COLUMNS} FROM maintenances WHERE id = ?`).bind(id).first<MaintenanceRow>();
	return row === null ? null : toMaintenance(row);
}

export interface MaintenanceQuery {
	readonly pageId: string;
	readonly limit: number;
	/** Continue after this position (exclusive). */
	readonly after?: Cursor | undefined;
}

/** A page's maintenance, latest start first. */
export async function listMaintenance(db: D1Database, query: MaintenanceQuery): Promise<ListPage<Maintenance>> {
	const conditions = ["page_id = ?"];
	const bindings: unknown[] = [query.pageId];
	if (query.after !== undefined) {
		conditions.push("(starts_at < ? OR (starts_at = ? AND id < ?))");
		bindings.push(query.after.at, query.after.at, query.after.id);
	}
	// Walks maintenances_by_page_start (page_id, starts_at, id).
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM maintenances WHERE ${conditions.join(" AND ")}
			ORDER BY starts_at DESC, id DESC LIMIT ?`,
		)
		.bind(...bindings, query.limit + 1)
		.all<MaintenanceRow>();
	return toPage(results, query.limit, toMaintenance, (row) => ({ at: row.starts_at, id: row.id }));
}

/** Replaces the editable fields, if the maintenance is still at `version` (checked in the same statement). */
export async function updateMaintenance(
	db: D1Database,
	id: string,
	version: number,
	fields: MaintenanceFields,
	actor: Actor,
	now = Date.now(),
): Promise<EditResult<Maintenance>> {
	const row = await db
		.prepare(
			`UPDATE maintenances SET title = ?, body = ?, components = ?, starts_at = ?, ends_at = ?,
				updated_at = max(updated_at, ?), updated_by = ?, version = version + 1
			WHERE id = ? AND version = ?
			RETURNING ${COLUMNS}`,
		)
		.bind(
			fields.title,
			fields.body,
			JSON.stringify(fields.components),
			fields.startsAt,
			fields.endsAt,
			now,
			actorName(actor),
			id,
			version,
		)
		.first<MaintenanceRow>();
	if (row !== null) return { status: "updated", value: toMaintenance(row) };
	const current = await getMaintenance(db, id);
	return current === null ? { status: "not-found" } : { status: "conflict", current };
}

/** `false` when it does not exist. */
export async function deleteMaintenance(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM maintenances WHERE id = ?").bind(id).run();
	return result.meta.changes > 0;
}

/** Most current and upcoming maintenance a page's status lists, earliest start first. */
export const MAX_PUBLIC_MAINTENANCE = 200;
/** Rows read per query when collecting the maintenance of the history's window. */
const HISTORY_BATCH = 500;
/** Most maintenance the history takes into account; beyond it, a warning. */
export const MAX_HISTORY_MAINTENANCE = 10_000;

/**
 * A page's maintenance that ends after `from` and starts before `to`, earliest start first,
 * at most {@link MAX_PUBLIC_MAINTENANCE}: the current and upcoming maintenance a status
 * shows (with `to` far ahead). Walks `maintenances_by_page_end`, so it reads the maintenance
 * ending after `from` only.
 */
export async function listMaintenanceBetween(
	db: D1Database,
	pageId: string,
	from: number,
	to: number,
): Promise<Maintenance[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM maintenances WHERE page_id = ? AND ends_at > ? AND starts_at < ?
			ORDER BY starts_at, id LIMIT ?`,
		)
		.bind(pageId, from, to, MAX_PUBLIC_MAINTENANCE)
		.all<MaintenanceRow>();
	return results.map(toMaintenance);
}

/**
 * Every maintenance of a page that overlaps `[from, to)`, latest end first, for the history
 * (it is left out of uptime, so none may be missed). Walks `maintenances_by_page_end`
 * backwards in batches, up to `cap` windows; beyond it, the most recent are kept (with a
 * warning).
 */
export async function listMaintenanceOverlapping(
	db: D1Database,
	pageId: string,
	from: number,
	to: number,
	cap = MAX_HISTORY_MAINTENANCE,
): Promise<Maintenance[]> {
	const found: Maintenance[] = [];
	let before = null as { at: number; id: string } | null;
	let more = false;
	for (;;) {
		const { results }: { results: MaintenanceRow[] } = await db
			.prepare(
				`SELECT ${COLUMNS} FROM maintenances WHERE page_id = ?1 AND ends_at > ?2
				AND (?3 IS NULL OR ends_at < ?3 OR (ends_at = ?3 AND id < ?4))
				ORDER BY ends_at DESC, id DESC LIMIT ?5`,
			)
			.bind(pageId, from, before?.at ?? null, before?.id ?? "", HISTORY_BATCH)
			.all<MaintenanceRow>();
		for (const row of results) {
			if (row.starts_at >= to) continue;
			if (found.length >= cap) {
				more = true;
				break;
			}
			found.push(toMaintenance(row));
		}
		const last = results.at(-1);
		if (more || results.length < HISTORY_BATCH || last === undefined) break;
		before = { at: last.ends_at, id: last.id };
	}
	if (more) console.warn(`Page "${pageId}" has more than ${cap} maintenance windows in the history's window; using the most recent ${cap}`);
	return found;
}
