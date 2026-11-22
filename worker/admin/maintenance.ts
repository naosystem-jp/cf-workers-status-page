/** `/api/admin/maintenance`: scheduled maintenance. */
import { createMaintenanceSchema, patchMaintenanceSchema } from "../../shared/admin-api";
import {
	createMaintenance,
	deleteMaintenance,
	getMaintenance,
	listMaintenance,
	type MaintenanceFields,
	updateMaintenance,
} from "../db/maintenance";
import { type AdminContext, findPage, publicPageChanged, publicPageChanging, unknownComponents } from "./context";
import { editConflict, json, noContent, notFound, readBody, validate, validationFailed } from "./http";
import { listQuerySchema } from "./list-query";

/** Issues for components the page does not have (or for a page no longer configured). */
function componentIssues(pageId: string, components: readonly string[]) {
	const page = findPage(pageId);
	if (page === undefined) {
		return [{ path: ["components"], message: `Page "${pageId}" is no longer in status.config.ts`, code: "page_removed", params: { page: pageId } }];
	}
	return unknownComponents(page, components, (index) => ["components", index]);
}

export async function list(admin: AdminContext): Promise<Response> {
	const query = validate(listQuerySchema, Object.fromEntries(admin.url.searchParams));
	if (!query.ok) return query.response;
	const { page, limit, cursor } = query.value;
	return json(await listMaintenance(admin.env.DB, { pageId: page, limit, after: cursor }));
}

export async function create(admin: AdminContext): Promise<Response> {
	const body = await readBody(admin.request, createMaintenanceSchema);
	if (!body.ok) return body.response;
	const { pageId, ...fields } = body.value;
	if (findPage(pageId) === undefined) {
		return validationFailed([{ path: ["pageId"], message: `No page "${pageId}" in status.config.ts`, code: "unknown_page", params: { page: pageId } }]);
	}
	const issues = componentIssues(pageId, fields.components);
	if (issues.length > 0) return validationFailed(issues);
	await publicPageChanging(admin, pageId);
	const maintenance = await createMaintenance(admin.env.DB, pageId, fields, admin.actor);
	await publicPageChanged(admin, pageId);
	return json(maintenance, 201);
}

export async function get(admin: AdminContext): Promise<Response> {
	const maintenance = await getMaintenance(admin.env.DB, admin.params["id"] ?? "");
	return maintenance === null ? notFound("maintenance") : json(maintenance);
}

export async function patch(admin: AdminContext): Promise<Response> {
	const body = await readBody(admin.request, patchMaintenanceSchema);
	if (!body.ok) return body.response;
	const { version, ...changes } = body.value;
	const existing = await getMaintenance(admin.env.DB, admin.params["id"] ?? "");
	if (existing === null) return notFound("maintenance");
	// The changes apply to the version the editor saw, not to someone else's newer one.
	if (existing.version !== version) return editConflict(existing);
	const fields: MaintenanceFields = {
		title: changes.title ?? existing.title,
		body: changes.body ?? existing.body,
		startsAt: changes.startsAt ?? existing.startsAt,
		endsAt: changes.endsAt ?? existing.endsAt,
		components: changes.components ?? existing.components,
	};
	if (fields.endsAt <= fields.startsAt) {
		return validationFailed([
			{
				path: [changes.endsAt === undefined ? "startsAt" : "endsAt"],
				message: "The maintenance must end after it starts",
				code: "ends_before_start",
			},
		]);
	}
	if (changes.components !== undefined) {
		const issues = componentIssues(existing.pageId, changes.components);
		if (issues.length > 0) return validationFailed(issues);
	}
	await publicPageChanging(admin, existing.pageId);
	const result = await updateMaintenance(admin.env.DB, existing.id, version, fields, admin.actor);
	switch (result.status) {
		case "not-found":
			return notFound("maintenance");
		case "conflict":
			return editConflict(result.current);
		case "updated":
			await publicPageChanged(admin, result.value.pageId);
			return json(result.value);
	}
}

export async function remove(admin: AdminContext): Promise<Response> {
	const existing = await getMaintenance(admin.env.DB, admin.params["id"] ?? "");
	if (existing === null) return notFound("maintenance");
	await publicPageChanging(admin, existing.pageId);
	if (!(await deleteMaintenance(admin.env.DB, existing.id))) return notFound("maintenance");
	await publicPageChanged(admin, existing.pageId);
	return noContent();
}
