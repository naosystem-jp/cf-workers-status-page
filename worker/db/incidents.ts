/**
 * Incidents in D1: what the admin API writes, and what the public API and
 * automatic incidents (`incidents.auto`) build on. Validation of the input, and of
 * pages and components against the configuration, is the caller's job.
 */
import type {
	AffectedComponent,
	Incident,
	IncidentStage,
	IncidentUpdate,
	IncidentWithUpdates,
	ListPage,
} from "../../shared/admin-api";
import { type Actor, actorName, type Cursor, type EditResult, parseJsonColumn, toPage } from "./common";

type IncidentRow = {
	id: string;
	page_id: string;
	title: string;
	stage: string;
	components: string;
	started_at: number;
	created_at: number;
	updated_at: number;
	resolved_at: number | null;
	created_by: string | null;
	updated_by: string | null;
	auto_created: number;
	human_edited_at: number | null;
	version: number;
};

type UpdateRow = {
	id: string;
	stage: string;
	body: string;
	created_at: number;
	author: string | null;
	automated: number;
};

const INCIDENT_COLUMNS =
	"id, page_id, title, stage, components, started_at, created_at, updated_at, resolved_at, created_by, updated_by, auto_created, human_edited_at, version";
const UPDATE_COLUMNS = "id, stage, body, created_at, author, automated";

function toIncident(row: IncidentRow): Incident {
	return {
		id: row.id,
		pageId: row.page_id,
		title: row.title,
		stage: row.stage as IncidentStage,
		components: parseJsonColumn<AffectedComponent[]>(row.components, [], `incident ${row.id}`),
		startedAt: row.started_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		resolvedAt: row.resolved_at,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		autoCreated: row.auto_created !== 0,
		humanEditedAt: row.human_edited_at,
		version: row.version,
	};
}

function toUpdate(row: UpdateRow): IncidentUpdate {
	return {
		id: row.id,
		stage: row.stage as IncidentStage,
		body: row.body,
		createdAt: row.created_at,
		author: row.author,
		automated: row.automated !== 0,
	};
}

function selectUpdates(db: D1Database, incidentId: string): D1PreparedStatement {
	return db
		.prepare(`SELECT ${UPDATE_COLUMNS} FROM incident_updates WHERE incident_id = ? ORDER BY created_at, rowid`)
		.bind(incidentId);
}

export interface NewIncident {
	readonly pageId: string;
	readonly title: string;
	/** When it began; at most `now` (the caller checks it is not in the future). */
	readonly startedAt: number;
	readonly stage: IncidentStage;
	/** Message of the first update. */
	readonly body: string;
	readonly components: readonly AffectedComponent[];
}

/** Creates an incident with its first update. */
export async function createIncident(
	db: D1Database,
	input: NewIncident,
	actor: Actor,
	now = Date.now(),
): Promise<IncidentWithUpdates> {
	const name = actorName(actor);
	const human = actor.kind === "admin";
	const incident: Incident = {
		id: crypto.randomUUID(),
		pageId: input.pageId,
		title: input.title,
		stage: input.stage,
		components: input.components,
		startedAt: Math.min(input.startedAt, now),
		createdAt: now,
		updatedAt: now,
		resolvedAt: input.stage === "resolved" ? now : null,
		createdBy: name,
		updatedBy: name,
		autoCreated: !human,
		humanEditedAt: human ? now : null,
		version: 1,
	};
	const update: IncidentUpdate = {
		id: crypto.randomUUID(),
		stage: input.stage,
		body: input.body,
		createdAt: now,
		author: name,
		automated: !human,
	};
	await db.batch([
		db
			.prepare(`INSERT INTO incidents (${INCIDENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
				incident.id,
				incident.pageId,
				incident.title,
				incident.stage,
				JSON.stringify(incident.components),
				incident.startedAt,
				incident.createdAt,
				incident.updatedAt,
				incident.resolvedAt,
				incident.createdBy,
				incident.updatedBy,
				incident.autoCreated ? 1 : 0,
				incident.humanEditedAt,
				incident.version,
			),
		db
			.prepare(`INSERT INTO incident_updates (${UPDATE_COLUMNS}, incident_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.bind(update.id, update.stage, update.body, update.createdAt, update.author, update.automated ? 1 : 0, incident.id),
	]);
	return { ...incident, updates: [update] };
}

export async function getIncident(db: D1Database, id: string): Promise<Incident | null> {
	const row = await db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = ?`).bind(id).first<IncidentRow>();
	return row === null ? null : toIncident(row);
}

/** The incident and its timeline, read together. */
export async function getIncidentWithUpdates(db: D1Database, id: string): Promise<IncidentWithUpdates | null> {
	const [incident, updates] = await db.batch([
		db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = ?`).bind(id),
		selectUpdates(db, id),
	]);
	const row = (incident?.results as IncidentRow[] | undefined)?.[0];
	if (row === undefined) return null;
	return { ...toIncident(row), updates: ((updates?.results ?? []) as UpdateRow[]).map(toUpdate) };
}

export interface IncidentQuery {
	readonly pageId: string;
	/** `open`: not resolved yet. */
	readonly status?: "open" | "resolved" | undefined;
	readonly limit: number;
	/** Continue after this position (exclusive). */
	readonly after?: Cursor | undefined;
}

/** A page's incidents, latest start first, without their timelines. */
export async function listIncidents(db: D1Database, query: IncidentQuery): Promise<ListPage<Incident>> {
	const conditions = ["page_id = ?"];
	const bindings: unknown[] = [query.pageId];
	if (query.status === "open") conditions.push("resolved_at IS NULL");
	if (query.status === "resolved") conditions.push("resolved_at IS NOT NULL");
	if (query.after !== undefined) {
		// A row value, so that the index is entered at the cursor instead of read from the top.
		conditions.push("(started_at, id) < (?, ?)");
		bindings.push(query.after.at, query.after.id);
	}
	// Walks incidents_by_page_start (page_id, started_at, id).
	const { results } = await db
		.prepare(
			`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE ${conditions.join(" AND ")}
			ORDER BY started_at DESC, id DESC LIMIT ?`,
		)
		.bind(...bindings, query.limit + 1)
		.all<IncidentRow>();
	return toPage(results, query.limit, toIncident, (row) => ({ at: row.started_at, id: row.id }));
}

export interface IncidentChanges {
	readonly title?: string | undefined;
	/** Replaces the affected components. */
	readonly components?: readonly AffectedComponent[] | undefined;
}

/**
 * Changes the title or the affected components, if the incident is still at `version`
 * (checked in the same statement as the write).
 */
export async function patchIncident(
	db: D1Database,
	id: string,
	version: number,
	changes: IncidentChanges,
	actor: Actor,
	now = Date.now(),
): Promise<EditResult<Incident>> {
	const human = actor.kind === "admin";
	const row = await db
		.prepare(
			`UPDATE incidents SET
				title = coalesce(?, title),
				components = coalesce(?, components),
				updated_at = max(updated_at, ?),
				updated_by = ?,
				human_edited_at = CASE WHEN ? THEN ? ELSE human_edited_at END,
				version = version + 1
			WHERE id = ? AND version = ?
			RETURNING ${INCIDENT_COLUMNS}`,
		)
		.bind(
			changes.title ?? null,
			changes.components === undefined ? null : JSON.stringify(changes.components),
			now,
			actorName(actor),
			human ? 1 : 0,
			now,
			id,
			version,
		)
		.first<IncidentRow>();
	if (row !== null) return { status: "updated", value: toIncident(row) };
	const current = await getIncident(db, id);
	return current === null ? { status: "not-found" } : { status: "conflict", current };
}

export interface NewIncidentUpdate {
	readonly stage: IncidentStage;
	readonly body: string;
	/** Also replaces the affected components. */
	readonly components?: readonly AffectedComponent[] | undefined;
	/**
	 * The incident's version the editor started from: when given and the incident has another,
	 * nothing is posted (`null`), so that replacing `components` cannot undo someone else's edit.
	 */
	readonly version?: number | undefined;
}

/**
 * Adds a timeline entry. The incident's stage becomes the stage of its latest update
 * (computed in the same transaction, so concurrent posts cannot leave it behind), and the
 * incident is resolved when that stage is `resolved`, reopened otherwise. Never conflicts
 * unless `version` is given; new `components` count as an edit of them, so the version
 * goes up. `null` when the incident does not exist, or no longer has `version`.
 */
export async function postIncidentUpdate(
	db: D1Database,
	incidentId: string,
	input: NewIncidentUpdate,
	actor: Actor,
	now = Date.now(),
): Promise<IncidentWithUpdates | null> {
	const name = actorName(actor);
	const human = actor.kind === "admin";
	const latestStage =
		"(SELECT stage FROM incident_updates WHERE incident_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1)";
	const version = input.version ?? null;
	const [inserted, updated, updates] = await db.batch([
		db
			.prepare(
				`INSERT INTO incident_updates (${UPDATE_COLUMNS}, incident_id)
				SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM incidents WHERE id = ? AND (? IS NULL OR version = ?))`,
			)
			.bind(crypto.randomUUID(), input.stage, input.body, now, name, human ? 0 : 1, incidentId, incidentId, version, version),
		db
			.prepare(
				`UPDATE incidents SET
					stage = ${latestStage},
					resolved_at = CASE WHEN ${latestStage} = 'resolved' THEN coalesce(resolved_at, ?2) ELSE NULL END,
					components = coalesce(?3, components),
					updated_at = max(updated_at, ?2),
					updated_by = ?4,
					human_edited_at = CASE WHEN ?5 THEN ?2 ELSE human_edited_at END,
					version = version + CASE WHEN ?3 IS NULL THEN 0 ELSE 1 END
				WHERE id = ?1 AND (?6 IS NULL OR version = ?6)
				RETURNING ${INCIDENT_COLUMNS}`,
			)
			.bind(
				incidentId,
				now,
				input.components === undefined ? null : JSON.stringify(input.components),
				name,
				human ? 1 : 0,
				version,
			),
		selectUpdates(db, incidentId),
	]);
	const row = (updated?.results as IncidentRow[] | undefined)?.[0];
	if ((inserted?.meta.changes ?? 0) === 0 || row === undefined) return null;
	return { ...toIncident(row), updates: ((updates?.results ?? []) as UpdateRow[]).map(toUpdate) };
}

/** What a public cursor of a page's incident list must match: the incident it names. */
export interface IncidentPosition {
	readonly pageId: string;
	readonly startedAt: number;
	readonly resolved: boolean;
}

/** Where incident `id` is in its page's lists, or `null` when it does not exist (one primary-key read). */
export async function incidentPosition(db: D1Database, id: string): Promise<IncidentPosition | null> {
	const row = await db
		.prepare("SELECT page_id, started_at, resolved_at FROM incidents WHERE id = ?")
		.bind(id)
		.first<{ page_id: string; started_at: number; resolved_at: number | null }>();
	return row === null ? null : { pageId: row.page_id, startedAt: row.started_at, resolved: row.resolved_at !== null };
}

/** An incident with one page of its timeline (oldest first), for the public incident page. */
export interface IncidentWithUpdatePage extends IncidentWithUpdates {
	/** Whether older updates exist. */
	readonly olderUpdates: boolean;
	/** The position before the oldest update shown, to read the previous page; `null` without older ones. */
	readonly olderCursor: Cursor | null;
}

/** An update's position in its incident's timeline, or `null` when it does not exist (one primary-key read). */
export async function updatePosition(db: D1Database, id: string): Promise<{ incidentId: string; createdAt: number; rowid: number } | null> {
	const row = await db
		.prepare("SELECT incident_id, created_at, rowid FROM incident_updates WHERE id = ?")
		.bind(id)
		.first<{ incident_id: string; created_at: number; rowid: number }>();
	return row === null ? null : { incidentId: row.incident_id, createdAt: row.created_at, rowid: row.rowid };
}

/**
 * The incident and its latest `limit` updates before `before` (an update's position, exclusive;
 * `null` for the latest), oldest first: at most `limit + 2` rows, however long the timeline.
 */
export async function getIncidentWithUpdatePage(
	db: D1Database,
	id: string,
	limit: number,
	before: { readonly createdAt: number; readonly rowid: number } | null,
): Promise<IncidentWithUpdatePage | null> {
	const [incident, updates] = await db.batch([
		db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = ?`).bind(id),
		db
			.prepare(
				// A row value, so that incident_updates_by_incident is entered at `before`.
				`SELECT ${UPDATE_COLUMNS} FROM incident_updates WHERE incident_id = ?1
				${before === null ? "" : "AND (created_at, rowid) < (?2, ?3)"}
				ORDER BY created_at DESC, rowid DESC LIMIT ?4`,
			)
			.bind(id, before?.createdAt ?? 0, before?.rowid ?? 0, limit + 1),
	]);
	const row = (incident?.results as IncidentRow[] | undefined)?.[0];
	if (row === undefined) return null;
	const latest = ((updates?.results ?? []) as UpdateRow[]).map(toUpdate);
	const shown = latest.slice(0, limit).reverse();
	const oldest = shown[0];
	const olderUpdates = latest.length > limit;
	return {
		...toIncident(row),
		updates: shown,
		olderUpdates,
		olderCursor: olderUpdates && oldest !== undefined ? { at: oldest.createdAt, id: oldest.id } : null,
	};
}

/**
 * A page's incidents changed (created, edited, updated or resolved) at or after `since`, by
 * `incidents_by_page_updated`; `null` when more than `cap` changed (read them all instead).
 */
export async function listIncidentsChangedSince(db: D1Database, pageId: string, since: number, cap = 500): Promise<Incident[] | null> {
	const { results } = await db
		.prepare(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE page_id = ? AND updated_at >= ? ORDER BY updated_at LIMIT ?`)
		.bind(pageId, since, cap + 1)
		.all<IncidentRow>();
	return results.length > cap ? null : results.map(toIncident);
}

/** Deletes an incident and its timeline. `false` when it does not exist. */
export async function deleteIncident(db: D1Database, id: string): Promise<boolean> {
	const [, deleted] = await db.batch([
		db.prepare("DELETE FROM incident_updates WHERE incident_id = ?").bind(id),
		db.prepare("DELETE FROM incidents WHERE id = ?").bind(id),
	]);
	return (deleted?.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Reads for the public API
// ---------------------------------------------------------------------------

/** Most unresolved incidents a page shows; more than this many at once is a mistake to clean up. */
export const MAX_OPEN_INCIDENTS = 100;
/** Rows read per query when collecting the incidents of the history's window. */
const HISTORY_BATCH = 500;
/** Most incidents the history marks over its window; beyond it, a warning (older ones are left out). */
export const MAX_HISTORY_INCIDENTS = 10_000;

/** An unresolved incident with its latest updates. */
export interface IncidentWithLatestUpdates extends IncidentWithUpdates {
	/** Whether older updates were left out (the incident itself has them all). */
	readonly olderUpdates: boolean;
}

/**
 * A page's unresolved incidents, latest start first, each with its latest `updatesPerIncident`
 * updates (oldest first). Reads the open incidents through `incidents_by_page_resolved` and
 * then, in one batch, per incident at most `updatesPerIncident + 1` updates in the order of
 * `incident_updates_by_incident` (whose entries end with the rowid), so a long timeline does
 * not add to every read.
 */
export async function listOpenIncidentsWithUpdates(
	db: D1Database,
	pageId: string,
	updatesPerIncident: number,
): Promise<IncidentWithLatestUpdates[]> {
	const { results: incidents } = await db
		.prepare(
			`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE page_id = ? AND resolved_at IS NULL
			ORDER BY started_at DESC, id DESC LIMIT ?`,
		)
		.bind(pageId, MAX_OPEN_INCIDENTS)
		.all<IncidentRow>();
	if (incidents.length === 0) return [];
	const updates = await db.batch(
		incidents.map((incident) =>
			db
				.prepare(
					`SELECT ${UPDATE_COLUMNS} FROM incident_updates WHERE incident_id = ?
					ORDER BY created_at DESC, rowid DESC LIMIT ?`,
				)
				.bind(incident.id, updatesPerIncident + 1),
		),
	);
	return incidents.map((row, index) => {
		const latest = ((updates[index]?.results ?? []) as UpdateRow[]).map(toUpdate).reverse();
		return {
			...toIncident(row),
			updates: latest.slice(-updatesPerIncident),
			olderUpdates: latest.length > updatesPerIncident,
		};
	});
}

/**
 * A page's incidents that were unresolved at some time since `from`: those still open and
 * those resolved since then, for the history's markers. Both walk
 * `incidents_by_page_resolved`: the open ones latest start first, the resolved ones latest
 * resolution first, in batches, so that the whole window is covered up to `cap` incidents,
 * and beyond it the most recent are kept (with a warning).
 */
export async function listIncidentsSince(
	db: D1Database,
	pageId: string,
	from: number,
	cap = MAX_HISTORY_INCIDENTS,
): Promise<Incident[]> {
	const { results: open } = await db
		.prepare(
			`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE page_id = ? AND resolved_at IS NULL
			ORDER BY started_at DESC, id DESC LIMIT ?`,
		)
		.bind(pageId, Math.min(MAX_OPEN_INCIDENTS, cap))
		.all<IncidentRow>();
	const incidents = open.map(toIncident);
	let before = null as { at: number; id: string } | null;
	let more = false;
	for (;;) {
		const want = Math.min(HISTORY_BATCH, cap - incidents.length);
		// Each batch enters the index where the last one stopped (a row value), not at the top.
		const { results }: { results: IncidentRow[] } = await db
			.prepare(
				`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE page_id = ?1 AND resolved_at >= ?2
				${before === null ? "" : "AND (resolved_at, id) < (?3, ?4)"}
				ORDER BY resolved_at DESC, id DESC LIMIT ?5`,
			)
			.bind(pageId, from, before?.at ?? 0, before?.id ?? "", want + 1)
			.all<IncidentRow>();
		const kept = results.slice(0, want);
		incidents.push(...kept.map(toIncident));
		if (results.length <= want) break;
		if (incidents.length >= cap) {
			more = true;
			break;
		}
		const last = kept.at(-1) as IncidentRow;
		before = { at: last.resolved_at as number, id: last.id };
	}
	if (more) console.warn(`Page "${pageId}" has more than ${cap} incidents in the history's window; showing the most recent ${cap}`);
	return incidents;
}
