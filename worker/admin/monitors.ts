/**
 * `/api/admin/monitors`: monitors are defined in status.config.ts, so the admin API only
 * shows them, together with the monitors that left the configuration but whose data
 * is kept, and deletes those on request.
 */
import type { AdminMonitor, AdminMonitorsResponse } from "../../shared/admin-api";
import { config } from "../config";
import { type MonitorSnapshot, monitorStub } from "../monitor";
import { forEachLimited, purgeMonitor, reconcilerStub } from "../reconciler";
import type { AdminContext } from "./context";
import { apiError, json, noContent, notFound } from "./http";

export type { AdminMonitor };

/** Monitor DOs asked for their snapshot at once. */
const SNAPSHOT_CONCURRENCY = 8;
/** Same rule as monitor IDs in status.config.ts: anything else cannot exist. */
const MONITOR_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Configured monitors and every monitor in the registry, sorted by ID, each with its current snapshot. */
export async function list(admin: AdminContext): Promise<Response> {
	const registry = await reconcilerStub(admin.env).listMonitors();
	const registered = new Map(registry.map((entry) => [entry.id, entry]));
	const configured = new Map(config.monitors.map((monitor) => [monitor.id, monitor]));
	const ids = [...new Set([...configured.keys(), ...registered.keys()])].sort();

	const snapshots = await forEachLimited(ids, SNAPSHOT_CONCURRENCY, (id) => {
		// The configured location first: a monitor not started yet is created where it belongs.
		const location = configured.get(id)?.location ?? registered.get(id)?.location ?? null;
		return monitorStub(admin.env, { id, location }).getSnapshot() as Promise<MonitorSnapshot>;
	});

	const monitors = ids.map((id, index): AdminMonitor => {
		const monitor = configured.get(id);
		const outcome = snapshots[index];
		return {
			id,
			configured: monitor !== undefined,
			config:
				monitor === undefined
					? null
					: {
							name: monitor.name,
							type: monitor.provider.type,
							intervalMs: monitor.intervalMs,
							timeoutMs: monitor.timeoutMs,
							location: monitor.location ?? null,
						},
			components: config.pages.flatMap((page) =>
				page.components
					.filter((component) => component.monitors.includes(id))
					.map((component) => ({ pageId: page.id, componentId: component.id })),
			),
			registry: registered.get(id) ?? null,
			snapshot: outcome?.status === "fulfilled" ? outcome.value : null,
			snapshotError: outcome?.status === "rejected" ? String(outcome.reason) : null,
		};
	});
	return json({ monitors } satisfies AdminMonitorsResponse);
}

/**
 * Deletes a removed monitor's results and history. Refused (409, with the reason)
 * while status.config.ts has it, while it is still running, or during a deploy.
 */
export async function purge(admin: AdminContext): Promise<Response> {
	const id = admin.params["id"] ?? "";
	if (!MONITOR_ID.test(id)) return notFound("monitor");
	const result = await purgeMonitor(admin.env, id);
	switch (result.status) {
		case "purged":
			return noContent();
		case "not-found":
			return notFound("monitor");
		case "refused":
			return apiError(409, "purge_refused", result.reason, { reason: result.code });
	}
}
