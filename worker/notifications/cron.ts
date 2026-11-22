/**
 * The every-minute Cron: reconciliation, `unknown` notifications, and the `down`
 * notifications that maintenance held back.
 *
 * 1. One D1 batch reads the `unknown` alerts already sent and the held-back `down` events
 *    (both usually empty).
 * 2. One call to the Reconciler reconciles and reads the snapshots needed: those monitors,
 *    and, on runs of `notifications.unknownCheckInterval`, every monitor that could have
 *    become late since it was last read (see `Reconciler.cron`).
 * 3. `unknown`: a monitor that is late, or unconfirmed for too long, is notified to
 *    administrators' targets once; the D1 record keeps it from being notified again while it
 *    stays unknown, and goes when the monitor leaves `unknown`.
 * 4. Maintenance: a held-back `down` is notified once no maintenance covers the monitor,
 *    if the monitor is still in that `down`; otherwise it is forgotten.
 * 5. Hourly, old delivery records are deleted.
 *
 * Reconciliation does not depend on D1: if the batch in step 1 fails, the Reconciler is
 * still called, without the `unknown` check.
 */
import type { ResolvedMonitor } from "@naosystem/cf-workers-status-page-core";
import { config, findMonitor } from "../config";
import {
	deleteSuppressedDown,
	deleteUnknownAlerts,
	insertUnknownAlert,
	maintenanceAt,
	purgeDeliveries,
	readCronRecords,
	recordPendingEvent,
	type SuppressedDown,
	type UnknownAlertRecord,
} from "../db/notifications";
import { ensureSchema } from "../db/schema";
import type { MonitorSnapshot } from "../monitor";
import { configuredMonitors, type CronReport, reconcilerStub } from "../reconciler";
import { afterMaintenanceEvent, type MonitorEvent } from "./events";
import { enqueue } from "./queue";
import { monitorComponents } from "./render";
import { suppressedByMaintenance } from "./rules";
import { evaluateUnknown, type UnknownAlert, unknownAction, unknownCheckDue, unknownEventId } from "./unknown";

/** Delivery records are kept this long: duplicates arrive within hours, and failures stay listed this long. */
export const DELIVERY_RETENTION_MS = 30 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;

export interface CronOutcome {
	readonly report: CronReport;
	readonly unknownNotified: readonly string[];
	readonly unknownCleared: readonly string[];
	readonly maintenanceNotified: readonly string[];
}

/** Runs the Cron's work for the run scheduled at `scheduledTime`. */
export async function runCron(env: Env, scheduledTime: number): Promise<CronOutcome> {
	let records: Awaited<ReturnType<typeof readCronRecords>> | null = null;
	try {
		await ensureSchema(env.DB);
		records = await readCronRecords(env.DB);
	} catch (error) {
		console.error("Notifications: could not read D1; skipping this run's unknown and maintenance checks", error);
	}
	const unknownCheck = records !== null && unknownCheckDue(scheduledTime, config.notifications.unknownCheckIntervalMs);
	const alwaysRead = records === null ? [] : [...(unknownCheck ? records.alerts.keys() : []), ...records.suppressed.map((down) => down.monitorId)];

	const report = await reconcilerStub(env).cron({
		versionId: env.CF_VERSION_METADATA.id,
		monitors: configuredMonitors(),
		unknownCheck,
		alwaysRead: [...new Set(alwaysRead)].filter((id) => findMonitor(id) !== undefined),
	});
	for (const failure of report.readFailures) console.warn(`Could not read monitor "${failure.monitorId}": ${failure.reason}`);
	const outcome = { report, unknownNotified: [] as string[], unknownCleared: [] as string[], maintenanceNotified: [] as string[] };
	if (records === null) return outcome;

	const snapshots = new Map(report.snapshots.map((snapshot) => [snapshot.monitorId, snapshot]));
	const now = Date.now();
	const tasks: Promise<void>[] = [];
	if (unknownCheck) tasks.push(checkUnknown(env, records.alerts, snapshots, report.unreachable, now, outcome));
	tasks.push(followUpMaintenance(env, records.suppressed, snapshots, now, outcome.maintenanceNotified));
	if (scheduledTime % HOUR_MS < 60_000) {
		tasks.push(
			purgeDeliveries(env.DB, now - DELIVERY_RETENTION_MS).then((deleted) => {
				if (deleted > 0) console.log(`Notifications: deleted ${deleted} delivery records older than 30 days`);
			}),
		);
	}
	const settled = await Promise.allSettled(tasks);
	for (const result of settled) if (result.status === "rejected") console.error("Notifications: Cron task failed", result.reason);
	return outcome;
}

/** The `unknown` event for `monitor`, as administrators' targets receive it; without a snapshot when its object does not answer. */
export function unknownEvent(monitor: ResolvedMonitor, snapshot: MonitorSnapshot | null, alert: UnknownAlert, now: number): MonitorEvent {
	const previous = snapshot?.current?.state;
	return {
		id: unknownEventId(monitor.id, alert.since),
		event: "unknown",
		monitorId: monitor.id,
		state: "unknown",
		previousState: previous === "up" || previous === "degraded" || previous === "down" ? previous : null,
		since: alert.since,
		detectedAt: now,
		previousSince: snapshot?.current?.since ?? null,
		message: snapshot?.lastCheck?.message?.slice(0, 500) ?? null,
		unknown: { reason: alert.reason, lastAt: alert.lastAt },
	};
}

async function checkUnknown(
	env: Env,
	alerts: ReadonlyMap<string, UnknownAlertRecord>,
	snapshots: ReadonlyMap<string, MonitorSnapshot>,
	unreachable: CronReport["unreachable"],
	now: number,
	outcome: { unknownNotified: string[]; unknownCleared: string[] },
): Promise<void> {
	const clear: string[] = [];
	// Records of monitors no longer configured go: they are not supposed to run.
	for (const id of alerts.keys()) if (findMonitor(id) === undefined) clear.push(id);
	const unreachableSince = new Map(unreachable.map((entry) => [entry.monitorId, entry.since]));

	for (const monitor of config.monitors) {
		const snapshot = snapshots.get(monitor.id) ?? null;
		const since = unreachableSince.get(monitor.id);
		let alert: UnknownAlert | null;
		if (snapshot !== null) {
			const evaluation = evaluateUnknown(snapshot, monitor.timeoutMs, now);
			const action = unknownAction(evaluation, alerts.has(monitor.id));
			if (action === "clear") clear.push(monitor.id);
			alert = action === "notify" ? evaluation.alert : null;
		} else if (since !== undefined && !alerts.has(monitor.id)) {
			// Its object does not answer although it could be late by now: unknown, as it cannot be checked.
			alert = { reason: "unreachable", since, lastAt: since };
		} else {
			// Not read this run: it cannot have become unknown since it was last read (see Reconciler.cron).
			continue;
		}
		if (alert === null) continue;
		// Queue first, then record: if recording fails, the next run queues the same event ID
		// again, which deliveries drop as a duplicate.
		await enqueue(env, [{ type: "event", v: 1, event: unknownEvent(monitor, snapshot, alert, now) }]);
		await insertUnknownAlert(env.DB, { monitorId: monitor.id, since: alert.since, reason: alert.reason }, now);
		outcome.unknownNotified.push(monitor.id);
		console.warn(`Monitor "${monitor.id}" is unknown (${alert.reason}); notified administrators`);
	}
	await deleteUnknownAlerts(env.DB, clear);
	outcome.unknownCleared.push(...clear);
}

async function followUpMaintenance(
	env: Env,
	suppressed: readonly SuppressedDown[],
	snapshots: ReadonlyMap<string, MonitorSnapshot>,
	now: number,
	notified: string[],
): Promise<void> {
	for (const down of suppressed) {
		const monitor = findMonitor(down.monitorId);
		if (monitor === undefined) {
			await deleteSuppressedDown(env.DB, down.monitorId, down.since);
			continue;
		}
		const snapshot = snapshots.get(monitor.id);
		if (snapshot === undefined) continue; // Not read this run (it failed): next run.
		const current = snapshot.current;
		if (current?.state !== "down" || current.since !== down.since) {
			// It recovered, or changed state, during the maintenance: nothing to notify.
			await deleteSuppressedDown(env.DB, down.monitorId, down.since);
			continue;
		}
		const refs = monitorComponents(config.pages, monitor.id);
		const windows = await maintenanceAt(env.DB, [...new Set(refs.map((ref) => ref.pageId))], now);
		if (suppressedByMaintenance(refs, windows, now)) continue; // Still under maintenance.
		const followUp = afterMaintenanceEvent(down.event, now);
		// Before it is queued: a recovery handed over by the queue before it must wait for it.
		await recordPendingEvent(env.DB, followUp, now);
		await enqueue(env, [{ type: "event", v: 1, event: followUp }]);
		await deleteSuppressedDown(env.DB, down.monitorId, down.since);
		notified.push(monitor.id);
		console.log(`Monitor "${monitor.id}" is still down after maintenance; notifying`);
	}
}
