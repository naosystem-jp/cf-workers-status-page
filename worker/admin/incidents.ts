/** `/api/admin/incidents`: incidents and their timelines. */
import * as z from "zod";
import {
	type AffectedComponent,
	createIncidentSchema,
	patchIncidentSchema,
	postIncidentUpdateSchema,
	resolveIncidentSchema,
	START_TIME_TOLERANCE_MS,
} from "../../shared/admin-api";
import {
	createIncident,
	deleteIncident,
	getIncident,
	getIncidentWithUpdates,
	listIncidents,
	patchIncident,
	postIncidentUpdate,
} from "../db/incidents";
import { type AdminContext, findPage, publicPageChanged, publicPageChanging, unknownComponents } from "./context";
import { apiError, editConflict, json, noContent, notFound, readBody, validate, validationFailed } from "./http";
import { listQuerySchema } from "./list-query";

const incidentListQuerySchema = listQuerySchema.extend({
	/** `open`: not resolved yet. */
	status: z.enum(["open", "resolved"]).optional(),
});

/** Issues for affected components the incident's page does not have (or for a page no longer configured). */
function componentIssues(pageId: string, components: readonly AffectedComponent[] | undefined) {
	if (components === undefined) return [];
	const page = findPage(pageId);
	if (page === undefined) {
		return [{ path: ["components"], message: `Page "${pageId}" is no longer in status.config.ts`, code: "page_removed", params: { page: pageId } }];
	}
	return unknownComponents(
		page,
		components.map((component) => component.id),
		(index) => ["components", index, "id"],
	);
}

export async function list(admin: AdminContext): Promise<Response> {
	const query = validate(incidentListQuerySchema, Object.fromEntries(admin.url.searchParams));
	if (!query.ok) return query.response;
	const { page, status, limit, cursor } = query.value;
	return json(await listIncidents(admin.env.DB, { pageId: page, status, limit, after: cursor }));
}

export async function create(admin: AdminContext): Promise<Response> {
	const body = await readBody(admin.request, createIncidentSchema);
	if (!body.ok) return body.response;
	const input = body.value;
	const now = Date.now();
	if (findPage(input.pageId) === undefined) {
		return validationFailed([
			{ path: ["pageId"], message: `No page "${input.pageId}" in status.config.ts`, code: "unknown_page", params: { page: input.pageId } },
		]);
	}
	// In the past is fine; a little ahead is a fast clock, and is stored as now.
	if (input.startedAt !== undefined && input.startedAt > now + START_TIME_TOLERANCE_MS) {
		return validationFailed([{ path: ["startedAt"], message: "Must not be in the future", code: "start_in_future" }]);
	}
	const issues = componentIssues(input.pageId, input.components);
	if (issues.length > 0) return validationFailed(issues);
	await publicPageChanging(admin, input.pageId);
	const incident = await createIncident(admin.env.DB, { ...input, startedAt: input.startedAt ?? now }, admin.actor, now);
	await publicPageChanged(admin, incident.pageId);
	return json(incident, 201);
}

export async function get(admin: AdminContext): Promise<Response> {
	const incident = await getIncidentWithUpdates(admin.env.DB, admin.params["id"] ?? "");
	return incident === null ? notFound("incident") : json(incident);
}

export async function patch(admin: AdminContext): Promise<Response> {
	const body = await readBody(admin.request, patchIncidentSchema);
	if (!body.ok) return body.response;
	const { version, ...changes } = body.value;
	const existing = await getIncident(admin.env.DB, admin.params["id"] ?? "");
	if (existing === null) return notFound("incident");
	if (existing.version !== version) return editConflict(existing);
	const issues = componentIssues(existing.pageId, changes.components);
	if (issues.length > 0) return validationFailed(issues);
	await publicPageChanging(admin, existing.pageId);
	const result = await patchIncident(admin.env.DB, existing.id, version, changes, admin.actor);
	switch (result.status) {
		case "not-found":
			return notFound("incident");
		case "conflict":
			return editConflict(result.current);
		case "updated":
			await publicPageChanged(admin, result.value.pageId);
			return json(result.value);
	}
}

export async function remove(admin: AdminContext): Promise<Response> {
	const existing = await getIncident(admin.env.DB, admin.params["id"] ?? "");
	if (existing === null) return notFound("incident");
	await publicPageChanging(admin, existing.pageId);
	if (!(await deleteIncident(admin.env.DB, existing.id))) return notFound("incident");
	await publicPageChanged(admin, existing.pageId, { incidentsDeleted: true });
	return noContent();
}

export async function postUpdate(admin: AdminContext): Promise<Response> {
	const body = await readBody(admin.request, postIncidentUpdateSchema);
	if (!body.ok) return body.response;
	const existing = await getIncident(admin.env.DB, admin.params["id"] ?? "");
	if (existing === null) return notFound("incident");
	const issues = componentIssues(existing.pageId, body.value.components);
	if (issues.length > 0) return validationFailed(issues);
	if (body.value.version !== undefined && body.value.version !== existing.version) return editConflict(existing);
	await publicPageChanging(admin, existing.pageId);
	const incident = await postIncidentUpdate(admin.env.DB, existing.id, body.value, admin.actor);
	if (incident === null) {
		// Changed (or deleted) between the check above and the write.
		const current = await getIncident(admin.env.DB, existing.id);
		return current === null ? notFound("incident") : editConflict(current);
	}
	await publicPageChanged(admin, incident.pageId);
	return json(incident, 201);
}

export async function resolve(admin: AdminContext): Promise<Response> {
	const body = await readBody(admin.request, resolveIncidentSchema);
	if (!body.ok) return body.response;
	const existing = await getIncident(admin.env.DB, admin.params["id"] ?? "");
	if (existing === null) return notFound("incident");
	if (existing.resolvedAt !== null) {
		return apiError(409, "already_resolved", "The incident is already resolved; post an update to add to it");
	}
	await publicPageChanging(admin, existing.pageId);
	const incident = await postIncidentUpdate(
		admin.env.DB,
		existing.id,
		{ stage: "resolved", body: body.value.body },
		admin.actor,
	);
	if (incident === null) return notFound("incident");
	await publicPageChanged(admin, incident.pageId);
	return json(incident, 201);
}
