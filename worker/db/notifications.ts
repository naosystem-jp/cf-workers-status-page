/**
 * Notification data in D1: targets (with encrypted secret options), the record of
 * each notification × target delivery, `unknown` alerts, and `down` events held back by
 * maintenance. Validation, encryption and configuration checks are the callers' job.
 */
import type {
	ComponentRef,
	DeliveryStatus,
	ListPage,
	NotificationDelivery,
	NotificationEvent,
} from "../../shared/admin-api";
import type { MonitorEvent } from "../notifications/events";
import type { MaintenanceWindow } from "../notifications/rules";
import { type Actor, actorName, type EditResult, parseJsonColumn } from "./common";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** A target as stored: secret options are encrypted (`secrets`), never plain text. */
export interface TargetRecord {
	readonly id: string;
	readonly name: string;
	readonly kind: string;
	/** Options that are not secret, as entered. */
	readonly options: Readonly<Record<string, unknown>>;
	/** Secret options, each encrypted (worker/notifications/crypto.ts). */
	readonly secrets: Readonly<Record<string, string>>;
	readonly admin: boolean;
	readonly enabled: boolean;
	readonly events: readonly NotificationEvent[];
	readonly allMonitors: boolean;
	readonly monitors: readonly string[];
	readonly components: readonly ComponentRef[];
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: string | null;
	readonly updatedBy: string | null;
	readonly version: number;
}

/** What an edit sets: everything but the identity, the kind and the bookkeeping. */
export type TargetFields = Pick<
	TargetRecord,
	"name" | "options" | "secrets" | "admin" | "enabled" | "events" | "allMonitors" | "monitors" | "components"
>;

/** An edit: `secrets` (and `options`) only when the options changed, so that an edit of other fields cannot write back secrets encrypted with an older key over a re-encryption (see `replaceSecrets`). */
export type TargetChanges = Omit<TargetFields, "options" | "secrets"> & {
	readonly options?: TargetFields["options"] | undefined;
	readonly secrets?: TargetFields["secrets"] | undefined;
};

type TargetRow = {
	id: string;
	name: string;
	kind: string;
	options: string;
	secrets: string;
	admin: number;
	enabled: number;
	events: string;
	all_monitors: number;
	monitors: string;
	components: string;
	created_at: number;
	updated_at: number;
	created_by: string | null;
	updated_by: string | null;
	version: number;
};

const TARGET_COLUMNS =
	"id, name, kind, options, secrets, admin, enabled, events, all_monitors, monitors, components, created_at, updated_at, created_by, updated_by, version";

/** Most targets read at once. A hub with more is misconfigured; the admin list and fan-out stop there. */
export const MAX_TARGETS = 500;

function toTarget(row: TargetRow): TargetRecord {
	const where = `notification target ${row.id}`;
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		options: parseJsonColumn<Record<string, unknown>>(row.options, {}, where),
		secrets: parseJsonColumn<Record<string, string>>(row.secrets, {}, where),
		admin: row.admin !== 0,
		enabled: row.enabled !== 0,
		events: parseJsonColumn<NotificationEvent[]>(row.events, [], where),
		allMonitors: row.all_monitors !== 0,
		monitors: parseJsonColumn<string[]>(row.monitors, [], where),
		components: parseJsonColumn<ComponentRef[]>(row.components, [], where),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		version: row.version,
	};
}

function fieldValues(fields: TargetFields): unknown[] {
	return [
		fields.name,
		JSON.stringify(fields.options),
		JSON.stringify(fields.secrets),
		fields.admin ? 1 : 0,
		fields.enabled ? 1 : 0,
		JSON.stringify(fields.events),
		fields.allMonitors ? 1 : 0,
		JSON.stringify(fields.monitors),
		JSON.stringify(fields.components),
	];
}

/** Stores a new target. `id` is chosen by the caller, because secrets are encrypted for it first. */
export async function insertTarget(
	db: D1Database,
	id: string,
	kind: string,
	fields: TargetFields,
	actor: Actor,
	now = Date.now(),
): Promise<TargetRecord> {
	const name = actorName(actor);
	const row = await db
		.prepare(
			`INSERT INTO notification_targets (${TARGET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
			RETURNING ${TARGET_COLUMNS}`,
		)
		.bind(id, fields.name, kind, ...fieldValues(fields).slice(1), now, now, name, name)
		.first<TargetRow>();
	if (row === null) throw new Error(`Could not insert notification target ${id}`);
	return toTarget(row);
}

export async function getTarget(db: D1Database, id: string): Promise<TargetRecord | null> {
	const row = await db.prepare(`SELECT ${TARGET_COLUMNS} FROM notification_targets WHERE id = ?`).bind(id).first<TargetRow>();
	return row === null ? null : toTarget(row);
}

/** Every target (at most {@link MAX_TARGETS}), by name; only enabled ones with `enabledOnly`. */
export async function listTargets(db: D1Database, options: { readonly enabledOnly?: boolean } = {}): Promise<TargetRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT ${TARGET_COLUMNS} FROM notification_targets ${options.enabledOnly ? "WHERE enabled = 1" : ""}
			ORDER BY name, id LIMIT ?`,
		)
		.bind(MAX_TARGETS)
		.all<TargetRow>();
	return results.map(toTarget);
}

/** Replaces a target's fields if it is still at `version` (checked in the same statement). */
export async function updateTarget(
	db: D1Database,
	id: string,
	version: number,
	fields: TargetChanges,
	actor: Actor,
	now = Date.now(),
): Promise<EditResult<TargetRecord>> {
	const row = await db
		.prepare(
			`UPDATE notification_targets SET name = ?, options = coalesce(?, options), secrets = coalesce(?, secrets), admin = ?,
				enabled = ?, events = ?, all_monitors = ?, monitors = ?, components = ?, updated_at = max(updated_at, ?),
				updated_by = ?, version = version + 1
			WHERE id = ? AND version = ?
			RETURNING ${TARGET_COLUMNS}`,
		)
		.bind(
			fields.name,
			fields.options === undefined ? null : JSON.stringify(fields.options),
			fields.secrets === undefined ? null : JSON.stringify(fields.secrets),
			fields.admin ? 1 : 0,
			fields.enabled ? 1 : 0,
			JSON.stringify(fields.events),
			fields.allMonitors ? 1 : 0,
			JSON.stringify(fields.monitors),
			JSON.stringify(fields.components),
			now,
			actorName(actor),
			id,
			version,
		)
		.first<TargetRow>();
	if (row !== null) return { status: "updated", value: toTarget(row) };
	const current = await getTarget(db, id);
	return current === null ? { status: "not-found" } : { status: "conflict", current };
}

/**
 * Replaces a target's encrypted secrets with the same values under another key, if they have
 * not changed meanwhile. Not an edit: the version stays, so editors are not interrupted.
 */
export async function replaceSecrets(
	db: D1Database,
	id: string,
	previous: Readonly<Record<string, string>>,
	secrets: Readonly<Record<string, string>>,
): Promise<boolean> {
	const result = await db
		.prepare("UPDATE notification_targets SET secrets = ? WHERE id = ? AND secrets = ?")
		.bind(JSON.stringify(secrets), id, JSON.stringify(previous))
		.run();
	return result.meta.changes > 0;
}

/** `false` when it does not exist. Its delivery records stay (they expire). */
export async function deleteTarget(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM notification_targets WHERE id = ?").bind(id).run();
	return result.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Deliveries: one record per notification × target
// ---------------------------------------------------------------------------

export interface DeliveryKey {
	readonly notificationId: string;
	readonly targetId: string;
}

export interface DeliveryInfo extends DeliveryKey {
	readonly event: NotificationEvent;
	readonly monitorId: string | null;
	readonly occurredAt: number;
}

/**
 * Statuses as stored: those the admin API shows ({@link DeliveryStatus}), and
 * - `queued`: written when the event is fanned out, before its delivery message is queued, so
 *   that a recovery processed before that message still finds the target;
 * - `fanned_out` / `suppressed`: on the row of target {@link FAN_OUT_TARGET}, the event itself
 *   was fanned out, or held back by maintenance (a recovery answering it can then go ahead);
 * - `pending`: on that row, the event was queued but not fanned out yet (the `down` the Cron
 *   queues when a maintenance ends): a recovery answering it waits for it.
 */
export type StoredDeliveryStatus = DeliveryStatus | "queued" | "fanned_out" | "suppressed" | "pending";

/** `target_id` of an event's own row: its fan-out marker, or its failure when it could not be fanned out. */
export const FAN_OUT_TARGET = "*";

export type Claim =
	/** This delivery may send now (`attempts` counts this one). */
	| { readonly claimed: true; readonly attempts: number }
	/** Another delivery of the same message sent it, or is sending it until `leaseUntil`. */
	| { readonly claimed: false; readonly status: StoredDeliveryStatus; readonly leaseUntil: number | null };

type DeliveryRow = {
	notification_id: string;
	target_id: string;
	status: DeliveryStatus;
	event: NotificationEvent;
	monitor_id: string | null;
	occurred_at: number;
	attempts: number;
	lease_until: number | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
};

/**
 * Claims a delivery before sending: the duplicate check.
 * Succeeds unless it was sent, or another delivery of the same message holds it (it is
 * `sending` and its lease has not expired); a lease outlives a crashed consumer only until
 * `leaseUntil`. A `queued` row (written by the fan-out) is claimed like a missing one. One
 * statement, so two deliveries cannot both claim it.
 */
export async function claimDelivery(db: D1Database, info: DeliveryInfo, now: number, leaseMs: number): Promise<Claim> {
	const row = await db
		.prepare(
			`INSERT INTO notification_deliveries (notification_id, target_id, status, event, monitor_id, occurred_at,
				attempts, lease_until, last_error, created_at, updated_at)
			VALUES (?1, ?2, 'sending', ?3, ?4, ?5, 1, ?6, NULL, ?7, ?7)
			ON CONFLICT (notification_id, target_id) DO UPDATE SET status = 'sending', attempts = attempts + 1,
				lease_until = excluded.lease_until, updated_at = excluded.updated_at
			WHERE notification_deliveries.status IN ('queued', 'retrying', 'failed')
				OR (notification_deliveries.status = 'sending' AND notification_deliveries.lease_until <= excluded.updated_at)
			RETURNING attempts`,
		)
		.bind(info.notificationId, info.targetId, info.event, info.monitorId, info.occurredAt, now + leaseMs, now)
		.first<{ attempts: number }>();
	if (row !== null) return { claimed: true, attempts: row.attempts };
	const existing = await db
		.prepare("SELECT status, lease_until FROM notification_deliveries WHERE notification_id = ? AND target_id = ?")
		.bind(info.notificationId, info.targetId)
		.first<{ status: StoredDeliveryStatus; lease_until: number | null }>();
	return { claimed: false, status: existing?.status ?? "sending", leaseUntil: existing?.lease_until ?? null };
}

/** Records the outcome of a claimed delivery. `error` must already be free of secrets. */
export async function finishDelivery(
	db: D1Database,
	key: DeliveryKey,
	status: "sent" | "retrying" | "failed",
	error: string | null,
	now: number,
): Promise<void> {
	await db
		.prepare(
			`UPDATE notification_deliveries SET status = ?, last_error = coalesce(?, last_error), lease_until = NULL, updated_at = ?
			WHERE notification_id = ? AND target_id = ? AND status != 'sent'`,
		)
		.bind(status, error, now, key.notificationId, key.targetId)
		.run();
}

/**
 * Records that a delivery was given up: its message reached the dead letter queue after the
 * queue's last retry. Keeps the last error recorded by the attempts; never overrides
 * `sent` (a duplicate message that reached the dead letter queue after another was sent).
 */
export async function recordDeadLetter(db: D1Database, info: DeliveryInfo, attempts: number, now: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO notification_deliveries (notification_id, target_id, status, event, monitor_id, occurred_at,
				attempts, lease_until, last_error, created_at, updated_at)
			VALUES (?1, ?2, 'failed', ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?8)
			ON CONFLICT (notification_id, target_id) DO UPDATE SET status = 'failed', lease_until = NULL,
				last_error = coalesce(notification_deliveries.last_error, excluded.last_error),
				attempts = max(notification_deliveries.attempts, excluded.attempts), updated_at = excluded.updated_at
			WHERE notification_deliveries.status != 'sent'`,
		)
		.bind(
			info.notificationId,
			info.targetId,
			info.event,
			info.monitorId,
			info.occurredAt,
			attempts,
			"Gave up after the queue's last retry",
			now,
		)
		.run();
}

export interface DeliveryQuery {
	readonly status: DeliveryStatus;
	readonly limit: number;
	/** `nextCursor` of the previous page. */
	readonly after?: DeliveryCursor | undefined;
}

/** A position in the list of deliveries: last change, then notification and target. */
export interface DeliveryCursor {
	readonly at: number;
	readonly key: string;
}

const DELIVERY_CURSOR = /^(\d{1,16})\.([0-9a-f]{2,1024})$/;

function deliveryKey(notificationId: string, targetId: string): string {
	return `${notificationId}/${targetId}`;
}

export function encodeDeliveryCursor(cursor: DeliveryCursor): string {
	const hex = [...new TextEncoder().encode(cursor.key)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${cursor.at}.${hex}`;
}

/** `undefined` when `value` is not a cursor made by {@link encodeDeliveryCursor}. */
export function decodeDeliveryCursor(value: string): DeliveryCursor | undefined {
	const match = DELIVERY_CURSOR.exec(value);
	if (match === null || (match[2] as string).length % 2 !== 0) return undefined;
	const bytes = Uint8Array.from((match[2] as string).match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
	return { at: Number(match[1]), key: new TextDecoder().decode(bytes) };
}

/** Deliveries with a status, latest change first, with the target's name. Walks `notification_deliveries_by_status`. */
export async function listDeliveries(db: D1Database, query: DeliveryQuery): Promise<ListPage<NotificationDelivery>> {
	const after = query.after;
	const { results } = await db
		.prepare(
			`SELECT d.notification_id, d.target_id, d.status, d.event, d.monitor_id, d.occurred_at, d.attempts, d.lease_until,
				d.last_error, d.created_at, d.updated_at, t.name AS target_name
			FROM notification_deliveries AS d LEFT JOIN notification_targets AS t ON t.id = d.target_id
			WHERE d.status = ?1
				AND (?2 IS NULL OR d.updated_at < ?2 OR (d.updated_at = ?2 AND d.notification_id || '/' || d.target_id < ?3))
			ORDER BY d.updated_at DESC, d.notification_id || '/' || d.target_id DESC LIMIT ?4`,
		)
		.bind(query.status, after?.at ?? null, after?.key ?? "", query.limit + 1)
		.all<DeliveryRow & { target_name: string | null }>();
	const shown = results.slice(0, query.limit);
	const last = shown.at(-1);
	return {
		items: shown.map(
			(row): NotificationDelivery => ({
				notificationId: row.notification_id,
				targetId: row.target_id,
				targetName: row.target_name,
				event: row.event,
				monitorId: row.monitor_id,
				occurredAt: row.occurred_at,
				status: row.status,
				attempts: row.attempts,
				lastError: row.last_error,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}),
		),
		nextCursor:
			results.length > query.limit && last !== undefined
				? encodeDeliveryCursor({ at: last.updated_at, key: deliveryKey(last.notification_id, last.target_id) })
				: null,
	};
}

/**
 * Records the fan-out of `event` before its delivery messages are queued: a `queued` row per
 * target, and the event's own row (`fanned_out`, or `suppressed` when maintenance held it back
 * and no target gets it; either replaces `pending`). Idempotent: a retried fan-out leaves
 * existing rows as they are.
 */
export async function recordFanOut(
	db: D1Database,
	event: { readonly id: string; readonly event: string; readonly monitorId: string; readonly since: number },
	targetIds: readonly string[],
	outcome: "fanned_out" | "suppressed",
	now: number,
): Promise<void> {
	const marker = db
		.prepare(
			`INSERT INTO notification_deliveries (notification_id, target_id, status, event, monitor_id, occurred_at,
				attempts, lease_until, last_error, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
			ON CONFLICT (notification_id, target_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
			WHERE notification_deliveries.status = 'pending'`,
		)
		.bind(event.id, FAN_OUT_TARGET, outcome, event.event, event.monitorId, event.since, now, now);
	const insert = (targetId: string) =>
		db
			.prepare(
				`INSERT INTO notification_deliveries (notification_id, target_id, status, event, monitor_id, occurred_at,
					attempts, lease_until, last_error, created_at, updated_at)
				VALUES (?, ?, 'queued', ?, ?, ?, 0, NULL, NULL, ?, ?) ON CONFLICT DO NOTHING`,
			)
			.bind(event.id, targetId, event.event, event.monitorId, event.since, now, now);
	const statements = [marker, ...targetIds.map((targetId) => insert(targetId))];
	for (let start = 0; start < statements.length; start += 100) await db.batch(statements.slice(start, start + 100));
}

/**
 * Records that `event` is about to be queued but is not fanned out yet (`pending` on its own
 * row), so that a recovery answering it waits for its fan-out instead of finding an earlier
 * event it pairs with (the held-back `down`) and going ahead without it. Idempotent.
 */
export async function recordPendingEvent(
	db: D1Database,
	event: { readonly id: string; readonly event: string; readonly monitorId: string; readonly since: number },
	now: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO notification_deliveries (notification_id, target_id, status, event, monitor_id, occurred_at,
				attempts, lease_until, last_error, created_at, updated_at)
			VALUES (?, ?, 'pending', ?, ?, ?, 0, NULL, NULL, ?, ?) ON CONFLICT DO NOTHING`,
		)
		.bind(event.id, FAN_OUT_TARGET, event.event, event.monitorId, event.since, now, now)
		.run();
}

export interface PairedTargets {
	/** Targets the answered event went to or is going to (any row but `failed`). */
	readonly targets: Set<string>;
	/**
	 * Whether the answered event was processed at all (fanned out, held back, or given up on),
	 * and none of the events it may be (`notificationIds`) is still `pending`.
	 */
	readonly processed: boolean;
}

/**
 * For a recovery: the targets that the event it answers (one of `notificationIds`) went to,
 * and whether that event was processed yet. Reads the primary key's prefix of each ID.
 */
export async function pairedTargets(db: D1Database, notificationIds: readonly string[]): Promise<PairedTargets> {
	if (notificationIds.length === 0) return { targets: new Set(), processed: true };
	const results = await db.batch(
		notificationIds.map((id) =>
			db.prepare("SELECT target_id, status FROM notification_deliveries WHERE notification_id = ?").bind(id),
		),
	);
	const rows = results.flatMap((result) => (result.results ?? []) as { target_id: string; status: StoredDeliveryStatus }[]);
	return {
		targets: new Set(rows.filter((row) => row.target_id !== FAN_OUT_TARGET && row.status !== "failed").map((row) => row.target_id)),
		// Rows of targets also mean it was processed (an event fanned out by an earlier version has no own row).
		// A `pending` one is queued and will be fanned out: e.g. the `down` queued when a maintenance
		// ended, while the `down` that maintenance held back already has its (`suppressed`) row.
		processed: rows.length > 0 && !rows.some((row) => row.target_id === FAN_OUT_TARGET && row.status === "pending"),
	};
}

/** Deletes delivery records last changed before `before`; returns how many. */
export async function purgeDeliveries(db: D1Database, before: number): Promise<number> {
	let deleted = 0;
	for (const status of ["sent", "failed", "retrying", "sending", "queued", "fanned_out", "suppressed", "pending"] satisfies StoredDeliveryStatus[]) {
		const result = await db
			.prepare("DELETE FROM notification_deliveries WHERE status = ? AND updated_at < ?")
			.bind(status, before)
			.run();
		deleted += result.meta.changes;
	}
	return deleted;
}

// ---------------------------------------------------------------------------
// The Cron's records: `unknown` alerts and `down` events held back by maintenance
// ---------------------------------------------------------------------------

export interface UnknownAlertRecord {
	readonly monitorId: string;
	readonly since: number;
	readonly reason: string;
}

export interface SuppressedDown {
	readonly monitorId: string;
	readonly since: number;
	readonly event: MonitorEvent;
}

/** Both of the Cron's lists, in one round trip. Each is usually empty. */
export async function readCronRecords(
	db: D1Database,
): Promise<{ alerts: Map<string, UnknownAlertRecord>; suppressed: SuppressedDown[] }> {
	const [alerts, suppressed] = await db.batch([
		db.prepare("SELECT monitor_id, since, reason FROM unknown_alerts"),
		db.prepare("SELECT monitor_id, since, event FROM suppressed_downs"),
	]);
	return {
		alerts: new Map(
			((alerts?.results ?? []) as { monitor_id: string; since: number; reason: string }[]).map((row) => [
				row.monitor_id,
				{ monitorId: row.monitor_id, since: row.since, reason: row.reason },
			]),
		),
		suppressed: ((suppressed?.results ?? []) as { monitor_id: string; since: number; event: string }[]).flatMap((row) => {
			const event = parseJsonColumn<MonitorEvent | null>(row.event, null, `suppressed_downs ${row.monitor_id}`);
			return event === null ? [] : [{ monitorId: row.monitor_id, since: row.since, event }];
		}),
	};
}

/** Remembers that administrators were told `monitorId` is unknown. `false` if it already was. */
export async function insertUnknownAlert(db: D1Database, alert: UnknownAlertRecord, now: number): Promise<boolean> {
	const result = await db
		.prepare("INSERT INTO unknown_alerts (monitor_id, since, reason, notified_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
		.bind(alert.monitorId, alert.since, alert.reason, now)
		.run();
	return result.meta.changes > 0;
}

export async function deleteUnknownAlerts(db: D1Database, monitorIds: readonly string[]): Promise<void> {
	if (monitorIds.length === 0) return;
	await db.batch(monitorIds.map((id) => db.prepare("DELETE FROM unknown_alerts WHERE monitor_id = ?").bind(id)));
}

/** Remembers a `down` that maintenance held back, unless a later one of the same monitor is already remembered. */
export async function recordSuppressedDown(db: D1Database, event: MonitorEvent, now: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO suppressed_downs (monitor_id, since, event, suppressed_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (monitor_id) DO UPDATE SET since = excluded.since, event = excluded.event, suppressed_at = excluded.suppressed_at
			WHERE excluded.since > suppressed_downs.since`,
		)
		.bind(event.monitorId, event.since, JSON.stringify(event), now)
		.run();
}

/** Forgets a held-back `down` (it was notified, or no longer matters), unless a later one replaced it. */
export async function deleteSuppressedDown(db: D1Database, monitorId: string, since: number): Promise<void> {
	await db.prepare("DELETE FROM suppressed_downs WHERE monitor_id = ? AND since = ?").bind(monitorId, since).run();
}

// ---------------------------------------------------------------------------
// Maintenance, for suppression
// ---------------------------------------------------------------------------

/** Most maintenance windows read per page and moment. */
const MAX_WINDOWS = 200;

/**
 * The maintenance of `pageIds` that covers `at`. Walks `maintenances_by_page_end`: per page,
 * the maintenance ending after `at`.
 */
export async function maintenanceAt(db: D1Database, pageIds: readonly string[], at: number): Promise<MaintenanceWindow[]> {
	if (pageIds.length === 0) return [];
	const results = await db.batch(
		pageIds.map((pageId) =>
			db
				.prepare(
					"SELECT page_id, components, starts_at, ends_at FROM maintenances WHERE page_id = ? AND ends_at > ? AND starts_at <= ? LIMIT ?",
				)
				.bind(pageId, at, at, MAX_WINDOWS),
		),
	);
	return results.flatMap((result) =>
		((result.results ?? []) as { page_id: string; components: string; starts_at: number; ends_at: number }[]).map((row) => ({
			pageId: row.page_id,
			components: parseJsonColumn<string[]>(row.components, [], `maintenance of page ${row.page_id}`),
			startsAt: row.starts_at,
			endsAt: row.ends_at,
		})),
	);
}
