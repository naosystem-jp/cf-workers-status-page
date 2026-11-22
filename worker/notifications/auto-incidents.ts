/**
 * Automatic incidents (`incidents.auto`).
 *
 * For each page with `incidents.auto` that shows the monitor:
 * - on a confirmed `down`, an incident at stage "investigating" is published for the page's
 *   components that show the monitor, with the page's template texts; when an unresolved
 *   incident of one of those components exists (whoever wrote it), an automated update is
 *   added to it instead, and the missing components are added to it; when none exists but
 *   automation resolved an incident of one of those components less than `reopenWithin` before
 *   the `down` began (and no administrator ever edited it), that incident is reopened with an
 *   update instead, so that a flapping service does not fill the page with incidents;
 * - on a partial recovery (from `down` to `degraded`), the incident the `down` was announced
 *   in gets an automated update, and if automation created it, nobody edited it and no other
 *   monitor in it is still down, its components' impact goes from `down` to `degraded`;
 * - on recovery to `up` (from `down`, or from `degraded` after a partial recovery), and when
 *   the monitor leaves the configuration while down or degraded (`stopped`), that incident is
 *   resolved, if automation created it, no administrator has edited it, and no other monitor
 *   announced in it is still down or degraded. An administrator's incident is never resolved
 *   automatically.
 *
 * Queue delivery is at least once and in no particular order, so each page × monitor
 * keeps the start (`since`) of the latest state applied (`auto_incident_monitors`): an event
 * that is not newer is a duplicate, or arrived after a later one (a recovery before its
 * `down`), and is ignored. Applying an event is one D1 batch (a transaction) that first
 * claims the row with a token, conditional on the row being as it was read, and then makes
 * the incident writes, each conditional on that claim: if another consumer applied an event
 * of the same monitor meanwhile, nothing is written and the event is evaluated again.
 *
 * What other monitors' events may change at the same time is decided inside the transaction,
 * not from what was read before it: whether an unresolved incident of the components exists
 * (create one, reopen one, or add to it), which recently resolved incident may be reopened,
 * and whether another monitor announced in an incident is still down (resolve it or not). Guards also re-check what an administrator may have changed since
 * the read (an incident resolved or edited meanwhile is neither added to nor resolved).
 */
import type { ResolvedMonitor, ResolvedPage } from "@naosystem/cf-workers-status-page-core";
import type { AffectedComponent, IncidentStage } from "../../shared/admin-api";
import { config } from "../config";
import { parseJsonColumn } from "../db/common";
import { writePublicPageContent } from "../public-write";
import type { MonitorEvent } from "./events";
import { incidentTexts } from "./render";

/** What is stored per page × monitor. */
export interface AutoState {
	readonly lastSince: number;
	readonly lastState: string;
	readonly incidentId: string | null;
	readonly claim: string;
}

/** An unresolved incident of the page, as the decision needs it. */
export interface OpenIncident {
	readonly id: string;
	readonly components: readonly AffectedComponent[];
	readonly stage: IncidentStage;
	readonly autoCreated: boolean;
	readonly humanEditedAt: number | null;
	readonly version: number;
}

export type AutoDecision =
	/** Not newer than the latest event applied: a duplicate, or one that arrived late. */
	| { readonly kind: "ignore" }
	/**
	 * A `down`: publish an incident, unless the transaction finds an unresolved one of the
	 * components, which then gets an update. `existing` is the one the read found, and
	 * `components` its list with the missing components added (`null` when none were missing).
	 */
	| { readonly kind: "down"; readonly existing: OpenIncident | null; readonly components: readonly AffectedComponent[] | null }
	/** Resolve the incident the `down` was announced in, if the transaction finds it may. */
	| { readonly kind: "resolve"; readonly incidentId: string }
	/** A partial recovery: an update to the incident the `down` was announced in, which stays open. */
	| { readonly kind: "partial"; readonly incidentId: string }
	/** Record the new state; no incident changes. */
	| { readonly kind: "record" };

/** The events automatic incidents act on. */
export type AutoEvent = "down" | "recovered" | "degraded_recovered" | "stopped";

export interface AutoInput {
	readonly event: AutoEvent;
	/** The monitor's state after the event (`degraded` for a partial recovery). */
	readonly nextState?: string;
	readonly since: number;
	readonly state: AutoState | null;
	/** The page's components that show the monitor. */
	readonly componentIds: readonly string[];
	/** The page's unresolved incidents, latest first. */
	readonly openIncidents: readonly OpenIncident[];
}

/** What to do with one event on one page (pure; see the module documentation). */
export function decideAutoIncident(input: AutoInput): AutoDecision {
	if (input.state !== null && input.since <= input.state.lastSince) return { kind: "ignore" };
	if (input.event === "down") {
		const existing =
			input.openIncidents.find((incident) =>
				incident.components.some((component) => input.componentIds.includes(component.id)),
			) ?? null;
		const missing =
			existing === null
				? []
				: input.componentIds.filter((id) => !existing.components.some((component) => component.id === id));
		return {
			kind: "down",
			existing,
			components:
				existing === null || missing.length === 0
					? null
					: [...existing.components, ...missing.map((id) => ({ id, impact: "down" as const }))],
		};
	}
	const attached = input.state?.incidentId ?? null;
	const announced = attached !== null && (input.state?.lastState === "down" || input.state?.lastState === "degraded");
	if (!announced) return { kind: "record" };
	if (input.event === "recovered" && input.state?.lastState === "down" && input.nextState === "degraded") {
		return { kind: "partial", incidentId: attached };
	}
	return { kind: "resolve", incidentId: attached };
}

type IncidentRow = {
	id: string;
	components: string;
	stage: IncidentStage;
	auto_created: number;
	human_edited_at: number | null;
	version: number;
};

/** Most unresolved incidents considered per page (as the public page shows). */
const MAX_OPEN = 100;
/** Attempts when other events of the same monitor are applied at the same time. */
const MAX_ATTEMPTS = 5;

async function readState(db: D1Database, pageId: string, monitorId: string) {
	const [state, open] = await db.batch([
		db
			.prepare(
				"SELECT last_since, last_state, incident_id, claim FROM auto_incident_monitors WHERE page_id = ? AND monitor_id = ?",
			)
			.bind(pageId, monitorId),
		db
			.prepare(
				`SELECT id, components, stage, auto_created, human_edited_at, version FROM incidents
				WHERE page_id = ? AND resolved_at IS NULL ORDER BY started_at DESC, id DESC LIMIT ?`,
			)
			.bind(pageId, MAX_OPEN),
	]);
	const row = (
		(state?.results ?? []) as { last_since: number; last_state: string; incident_id: string | null; claim: string }[]
	)[0];
	return {
		state:
			row === undefined
				? null
				: { lastSince: row.last_since, lastState: row.last_state, incidentId: row.incident_id, claim: row.claim },
		openIncidents: ((open?.results ?? []) as IncidentRow[]).map(
			(incident): OpenIncident => ({
				id: incident.id,
				components: parseJsonColumn<AffectedComponent[]>(incident.components, [], `incident ${incident.id}`),
				stage: incident.stage,
				autoCreated: incident.auto_created !== 0,
				humanEditedAt: incident.human_edited_at,
				version: incident.version,
			}),
		),
	};
}

/** Pages where `monitorId`'s latest applied state is a `down` (or the `degraded` after it) announced in an incident. */
export async function autoIncidentPagesOf(db: D1Database, monitorId: string): Promise<string[]> {
	// Scans the table (one row per page × monitor that ever had an automatic incident event).
	const { results } = await db
		.prepare(
			"SELECT page_id FROM auto_incident_monitors WHERE monitor_id = ? AND last_state IN ('down', 'degraded') AND incident_id IS NOT NULL",
		)
		.bind(monitorId)
		.all<{ page_id: string }>();
	return results.map((row) => row.page_id);
}

/** A recently resolved automatic incident that a `down` may reopen, as read before the transaction. */
interface ReopenCandidate {
	readonly id: string;
	readonly components: readonly AffectedComponent[];
	readonly version: number;
}

/** Whether the incident of page `?P` aliased `r` may be reopened (SQL; see the module documentation). */
function reopenable(page: string, resolvedSince: string, componentsJson: string): string {
	return `r.page_id = ${page} AND r.auto_created = 1 AND r.human_edited_at IS NULL AND r.resolved_at IS NOT NULL
		AND r.resolved_at >= ${resolvedSince} AND EXISTS (
			SELECT 1 FROM json_each(r.components) AS c WHERE json_extract(c.value, '$.id') IN (SELECT value FROM json_each(${componentsJson}))
		)`;
}

/** The incident the transaction would reopen, if nothing changes meanwhile (for adding missing components). */
async function readReopenCandidate(
	db: D1Database,
	pageId: string,
	componentIds: readonly string[],
	resolvedSince: number,
): Promise<ReopenCandidate | null> {
	const row = await db
		.prepare(
			`SELECT r.id, r.components, r.version FROM incidents AS r WHERE ${reopenable("?1", "?2", "?3")}
			ORDER BY r.resolved_at DESC, r.id DESC LIMIT 1`,
		)
		.bind(pageId, resolvedSince, JSON.stringify(componentIds))
		.first<{ id: string; components: string; version: number }>();
	return row === null
		? null
		: { id: row.id, components: parseJsonColumn<AffectedComponent[]>(row.components, [], `incident ${row.id}`), version: row.version };
}

export interface AutoContext {
	readonly env: Env;
	readonly ctx: ExecutionContext;
	readonly now: number;
}

/** What {@link applyAutoIncident} did on a page. */
export type AutoOutcome = "ignore" | "create" | "append" | "reopen" | "partial" | "resolve" | "record";

/**
 * Applies a `down`, `recovered` or `stopped` event to `page`, which has `incidents.auto` and
 * shows the monitor (or showed it, for `stopped`). Idempotent: applying the same event again,
 * or an older one, changes nothing.
 */
export async function applyAutoIncident(
	context: AutoContext,
	page: ResolvedPage,
	monitor: Pick<ResolvedMonitor, "id" | "name">,
	event: MonitorEvent & { readonly event: AutoEvent },
): Promise<AutoOutcome> {
	const db = context.env.DB;
	const componentIds = page.components.filter((component) => component.monitors.includes(monitor.id)).map((component) => component.id);
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const { state, openIncidents } = await readState(db, page.id, monitor.id);
		const decision = decideAutoIncident({
			event: event.event,
			nextState: event.state,
			since: event.since,
			state,
			componentIds,
			openIncidents,
		});
		if (decision.kind === "ignore") return "ignore";

		const reopenWithinMs = page.incidents.reopenWithinMs;
		const candidate =
			decision.kind === "down" && decision.existing === null && reopenWithinMs > 0
				? await readReopenCandidate(db, page.id, componentIds, event.since - reopenWithinMs)
				: null;
		const plan = buildStatements(db, context.now, page, monitor, event, state, decision, componentIds, openIncidents, candidate);
		const run = () => db.batch(plan.statements);
		const results =
			decision.kind === "record"
				? await run()
				: await writePublicPageContent({ env: context.env, ctx: context.ctx, pageId: page.id }, run);
		if ((results[0]?.meta.changes ?? 0) === 0) continue; // Another event of this monitor came first: again.
		const outcome = plan.outcome(results);
		if (outcome !== "record") {
			console.log(`Automatic incident on page "${page.id}" for monitor "${monitor.id}": ${outcome} (event ${event.id})`);
		}
		return outcome;
	}
	throw new Error(`Could not apply event ${event.id} to page "${page.id}": too many concurrent changes`);
}

/** Whether an unresolved incident of page `?P` affects one of the components in the JSON array `?C` (SQL, on alias `i`). */
function openOfComponents(page: string, componentsJson: string): string {
	return `i.page_id = ${page} AND i.resolved_at IS NULL AND EXISTS (
		SELECT 1 FROM json_each(i.components) AS c WHERE json_extract(c.value, '$.id') IN (SELECT value FROM json_each(${componentsJson}))
	)`;
}

interface Plan {
	readonly statements: D1PreparedStatement[];
	/** What the batch did, from its results (the claim succeeded). */
	outcome(results: readonly D1Result[]): AutoOutcome;
}

function buildStatements(
	db: D1Database,
	now: number,
	page: ResolvedPage,
	monitor: Pick<ResolvedMonitor, "id" | "name">,
	event: MonitorEvent,
	state: AutoState | null,
	decision: Exclude<AutoDecision, { kind: "ignore" }>,
	componentIds: readonly string[],
	openIncidents: readonly OpenIncident[],
	candidate: ReopenCandidate | null,
): Plan {
	const token = crypto.randomUUID();
	const lastState = event.event === "stopped" ? "stopped" : event.state;
	// After a partial recovery the monitor stays announced in its incident (it is degraded).
	const keptIncident = decision.kind === "partial" ? decision.incidentId : null;
	// The claim: first, so that every other statement can depend on it.
	const claim =
		state === null
			? db
					.prepare(
						`INSERT INTO auto_incident_monitors (page_id, monitor_id, last_since, last_state, incident_id, claim, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
					)
					.bind(page.id, monitor.id, event.since, lastState, keptIncident, token, now)
			: db
					.prepare(
						`UPDATE auto_incident_monitors SET last_since = ?, last_state = ?, incident_id = ?, claim = ?, updated_at = ?
						WHERE page_id = ? AND monitor_id = ? AND last_since = ? AND claim = ?`,
					)
					.bind(event.since, lastState, keptIncident, token, now, page.id, monitor.id, state.lastSince, state.claim);
	const claimed = (pageParam: string, monitorParam: string, tokenParam: string) =>
		`EXISTS (SELECT 1 FROM auto_incident_monitors WHERE page_id = ${pageParam} AND monitor_id = ${monitorParam} AND claim = ${tokenParam})`;

	const nameOf = (id: string) => page.components.find((component) => component.id === id)?.name ?? id;
	const textsFor = (ids: readonly string[]) =>
		incidentTexts(page, { components: ids.map(nameOf), monitor: monitor.name, at: event.since }, config.locale, config.timezone);

	switch (decision.kind) {
		case "record":
			return { statements: [claim], outcome: () => "record" };
		case "resolve": {
			const incident = openIncidents.find((candidate) => candidate.id === decision.incidentId);
			const texts = textsFor(incident?.components.map((component) => component.id) ?? componentIds);
			const updateId = crypto.randomUUID();
			return {
				statements: [
					claim,
					// Whether another monitor announced in it is still down is decided here, inside the
					// transaction: two monitors recovering at once both see the other as recovered or not.
					db
						.prepare(
							`INSERT INTO incident_updates (id, stage, body, created_at, author, automated, incident_id)
							SELECT ?1, 'resolved', ?2, ?3, NULL, 1, i.id FROM incidents AS i
							WHERE i.id = ?4 AND i.resolved_at IS NULL AND i.auto_created = 1 AND i.human_edited_at IS NULL
							AND ${claimed("?5", "?6", "?7")}
							AND NOT EXISTS (SELECT 1 FROM auto_incident_monitors WHERE incident_id = ?4 AND last_state IN ('down', 'degraded'))`,
						)
						.bind(updateId, event.event === "stopped" ? texts.stopped : texts.resolved, now, decision.incidentId, page.id, monitor.id, token),
					db
						.prepare(
							`UPDATE incidents SET stage = 'resolved', resolved_at = ?2, updated_at = max(updated_at, ?2), updated_by = NULL
							WHERE id = ?1 AND resolved_at IS NULL AND EXISTS (SELECT 1 FROM incident_updates WHERE id = ?3)`,
						)
						.bind(decision.incidentId, now, updateId),
				],
				outcome: (results) => ((results[1]?.meta.changes ?? 0) > 0 ? "resolve" : "record"),
			};
		}
		case "partial": {
			const incident = openIncidents.find((candidate) => candidate.id === decision.incidentId);
			const texts = textsFor(incident?.components.map((component) => component.id) ?? componentIds);
			const updateId = crypto.randomUUID();
			const statements = [
				claim,
				// At the incident's current stage; it stays open while the monitor is degraded.
				db
					.prepare(
						`INSERT INTO incident_updates (id, stage, body, created_at, author, automated, incident_id)
						SELECT ?1, i.stage, ?2, ?3, NULL, 1, i.id FROM incidents AS i
						WHERE i.id = ?4 AND i.resolved_at IS NULL AND ${claimed("?5", "?6", "?7")}`,
					)
					.bind(updateId, texts.partial, now, decision.incidentId, page.id, monitor.id, token),
				db
					.prepare(
						`UPDATE incidents SET updated_at = max(updated_at, ?1), updated_by = NULL
						WHERE id = (SELECT incident_id FROM incident_updates WHERE id = ?2)`,
					)
					.bind(now, updateId),
			];
			if (incident !== undefined && incident.components.some((component) => component.impact === "down")) {
				// Its own incident shows the component degraded now, unless another monitor in it is
				// still down; never an administrator's (optimistic on the version read).
				const lowered = incident.components.map((component) =>
					component.impact === "down" ? { ...component, impact: "degraded" as const } : component,
				);
				statements.push(
					db
						.prepare(
							`UPDATE incidents SET components = ?1, version = version + 1
							WHERE id = ?2 AND version = ?3 AND resolved_at IS NULL AND auto_created = 1 AND human_edited_at IS NULL
							AND EXISTS (SELECT 1 FROM incident_updates WHERE id = ?4)
							AND NOT EXISTS (SELECT 1 FROM auto_incident_monitors WHERE incident_id = ?2 AND last_state = 'down')`,
						)
						.bind(JSON.stringify(lowered), incident.id, incident.version, updateId),
				);
			}
			return { statements, outcome: (results) => ((results[1]?.meta.changes ?? 0) > 0 ? "partial" : "record") };
		}
		case "down": {
			const texts = textsFor(componentIds);
			const newId = crypto.randomUUID();
			const appendId = crypto.randomUUID();
			const reopenId = crypto.randomUUID();
			const ids = JSON.stringify(componentIds);
			const reopenWithinMs = page.incidents.reopenWithinMs;
			const statements = [claim];
			let reopenAt = -1;
			if (reopenWithinMs > 0) {
				// Reopen the latest incident automation resolved for these components within the
				// window, unless one of them has an unresolved incident now (then it is added to).
				reopenAt = statements.length;
				statements.push(
					db
						.prepare(
							`INSERT INTO incident_updates (id, stage, body, created_at, author, automated, incident_id)
							SELECT ?1, 'investigating', ?2, ?3, NULL, 1, r.id FROM incidents AS r
							WHERE ${claimed("?4", "?5", "?6")} AND NOT EXISTS (SELECT 1 FROM incidents AS i WHERE ${openOfComponents("?4", "?8")})
							AND ${reopenable("?4", "?7", "?8")}
							ORDER BY r.resolved_at DESC, r.id DESC LIMIT 1`,
						)
						.bind(reopenId, texts.reopened, now, page.id, monitor.id, token, event.since - reopenWithinMs, ids),
					db
						.prepare(
							`UPDATE incidents SET stage = 'investigating', resolved_at = NULL, updated_at = max(updated_at, ?1), updated_by = NULL
							WHERE id = (SELECT incident_id FROM incident_updates WHERE id = ?2)`,
						)
						.bind(now, reopenId),
				);
			}
			const createAt = statements.length;
			statements.push(
				// A new incident, unless one of the components has an unresolved incident now
				// (including one just reopened).
				db
					.prepare(
						`INSERT INTO incidents (id, page_id, title, stage, components, started_at, created_at, updated_at, resolved_at,
							created_by, updated_by, auto_created, human_edited_at, version)
						SELECT ?1, ?2, ?3, 'investigating', ?4, ?5, ?6, ?6, NULL, NULL, NULL, 1, NULL, 1
						WHERE ${claimed("?2", "?7", "?8")} AND NOT EXISTS (SELECT 1 FROM incidents AS i WHERE ${openOfComponents("?2", "?9")})`,
					)
					.bind(
						newId,
						page.id,
						texts.title,
						JSON.stringify(componentIds.map((id) => ({ id, impact: "down" }))),
						Math.min(event.since, now),
						now,
						monitor.id,
						token,
						ids,
					),
				db
					.prepare(
						`INSERT INTO incident_updates (id, stage, body, created_at, author, automated, incident_id)
						SELECT ?1, 'investigating', ?2, ?3, NULL, 1, ?4 WHERE EXISTS (SELECT 1 FROM incidents WHERE id = ?4)`,
					)
					.bind(crypto.randomUUID(), texts.investigating, now, newId),
			);
			const appendAt = statements.length;
			statements.push(
				// Otherwise an update to the latest unresolved incident of the components, at its
				// current stage: an automated note must not move a person's stage back.
				db
					.prepare(
						`INSERT INTO incident_updates (id, stage, body, created_at, author, automated, incident_id)
						SELECT ?1, i.stage, ?2, ?3, NULL, 1, i.id FROM incidents AS i
						WHERE ${claimed("?4", "?5", "?6")} AND NOT EXISTS (SELECT 1 FROM incidents WHERE id = ?7)
						AND NOT EXISTS (SELECT 1 FROM incident_updates WHERE id = ?9)
						AND ${openOfComponents("?4", "?8")}
						ORDER BY i.started_at DESC, i.id DESC LIMIT 1`,
					)
					.bind(appendId, texts.update, now, page.id, monitor.id, token, newId, ids, reopenId),
				db
					.prepare(
						`UPDATE incidents SET updated_at = max(updated_at, ?1), updated_by = NULL
						WHERE id = (SELECT incident_id FROM incident_updates WHERE id = ?2)`,
					)
					.bind(now, appendId),
			);
			// The missing components, if the update went to the incident that was read and nobody
			// changed its list since (optimistic): one added to, or one reopened.
			const extend = (incident: { readonly id: string; readonly version: number }, components: readonly AffectedComponent[], updateId: string) =>
				db
					.prepare(
						`UPDATE incidents SET components = ?1, version = version + 1
						WHERE id = ?2 AND version = ?3 AND resolved_at IS NULL
						AND EXISTS (SELECT 1 FROM incident_updates WHERE id = ?4 AND incident_id = ?2)`,
					)
					.bind(JSON.stringify(components), incident.id, incident.version, updateId);
			if (decision.existing !== null && decision.components !== null) {
				statements.push(extend(decision.existing, decision.components, appendId));
			}
			const reopenMissing = candidate === null ? [] : componentIds.filter((id) => !candidate.components.some((component) => component.id === id));
			if (candidate !== null && reopenMissing.length > 0) {
				statements.push(extend(candidate, [...candidate.components, ...reopenMissing.map((id) => ({ id, impact: "down" as const }))], reopenId));
			}
			// The incident this `down` was announced in, for its recovery.
			statements.push(
				db
					.prepare(
						`UPDATE auto_incident_monitors
						SET incident_id = coalesce(
							(SELECT id FROM incidents WHERE id = ?1),
							(SELECT incident_id FROM incident_updates WHERE id = ?2),
							(SELECT incident_id FROM incident_updates WHERE id = ?6)
						)
						WHERE page_id = ?3 AND monitor_id = ?4 AND claim = ?5`,
					)
					.bind(newId, appendId, page.id, monitor.id, token, reopenId),
			);
			return {
				statements,
				outcome: (results) =>
					reopenAt >= 0 && (results[reopenAt]?.meta.changes ?? 0) > 0
						? "reopen"
						: (results[createAt]?.meta.changes ?? 0) > 0
							? "create"
							: (results[appendAt]?.meta.changes ?? 0) > 0
								? "append"
								: "record",
			};
		}
	}
}
