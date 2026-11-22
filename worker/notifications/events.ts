/**
 * Notification events and the queue messages that carry them.
 *
 * An event is something about one monitor that targets may be notified of. The Monitor DO
 * derives `down`, `recovered`, `degraded` and `degraded_recovered` from its confirmed state
 * changes ({@link eventsFromTransitions}), and `stopped` when a monitor leaves the configuration
 * while down (for automatic incidents only; no target receives it); the every-minute Cron emits
 * `unknown` and the `down` that maintenance held back once it ends. Every event has a
 * stable ID, derived from what it is about, so that sending it again (an alarm retrying after a
 * failed queue send, a duplicate queue delivery) is recognised downstream.
 *
 * A recovery (`recovered`, `degraded_recovered`) answers the event that began the state it
 * ends, whose ID {@link pairedEventIds} gives: it goes to the targets that event went to.
 *
 * The queue carries two kinds of message ({@link QueueBody}):
 * - `event`: one per event, sent by the Monitor DO or the Cron. The consumer applies
 *   automatic incidents, decides whether maintenance suppresses it, and fans it out;
 * - `delivery`: one per event × target (one target's failure must not affect others).
 */
import {
	isCheckState,
	type CheckState,
	type NotificationEvent,
	type NotificationState,
	type StateRecord,
} from "@naosystem/cf-workers-status-page-core";

/** What an event is about: a notification event, or `stopped` (automatic incidents only). */
export type MonitorEventType = NotificationEvent | "stopped";

/** Why a monitor is `unknown`: results late, never confirming a state, or its Durable Object not answering. */
export type UnknownReason = "late" | "unconfirmed" | "unreachable";

export interface MonitorEvent {
	/** Stable: the same each time this event is sent. */
	readonly id: string;
	readonly event: MonitorEventType;
	readonly monitorId: string;
	/** The state the event is about (for `recovered`, the state the monitor is in now). */
	readonly state: NotificationState;
	readonly previousState: NotificationState | null;
	/** When the state began: what notifications show as the time it happened. */
	readonly since: number;
	/**
	 * When the event was detected: the confirmation of the state, or the Cron's run. Maintenance
	 * suppresses an event when it covers this moment.
	 */
	readonly detectedAt: number;
	/** When the previous state began, for how long it lasted; `null` when unknown. */
	readonly previousSince: number | null;
	/** The latest check's message at the time, such as "HTTP 503". */
	readonly message: string | null;
	/** Set on the `down` notified when maintenance that suppressed it ended. */
	readonly afterMaintenance?: true;
	/** For `unknown`: why, and the latest result (or the start of the schedule) it is late from. */
	readonly unknown?: { readonly reason: UnknownReason; readonly lastAt: number };
}

/** Longest check message carried by an event, so that queue messages stay small. */
const MAX_EVENT_MESSAGE = 500;

/** A queue message (JSON). `v` is the format version, for messages queued by an older version during a deploy. */
export type QueueBody =
	| { readonly type: "event"; readonly v: 1; readonly event: MonitorEvent }
	| { readonly type: "delivery"; readonly v: 1; readonly event: MonitorEvent; readonly targetId: string };

const EVENTS: ReadonlySet<string> = new Set<MonitorEventType>([
	"down",
	"recovered",
	"degraded",
	"degraded_recovered",
	"unknown",
	"stopped",
]);

function isEvent(value: unknown): value is MonitorEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Record<string, unknown>;
	return (
		typeof event["id"] === "string" &&
		typeof event["monitorId"] === "string" &&
		typeof event["event"] === "string" &&
		EVENTS.has(event["event"]) &&
		typeof event["since"] === "number" &&
		typeof event["detectedAt"] === "number"
	);
}

/** The body if it is a message this version understands, else `null` (it is then dropped and logged). */
export function parseQueueBody(body: unknown): QueueBody | null {
	if (typeof body !== "object" || body === null) return null;
	const message = body as Record<string, unknown>;
	if (message["v"] !== 1 || !isEvent(message["event"])) return null;
	if (message["type"] === "event") return body as QueueBody;
	if (message["type"] === "delivery" && typeof message["targetId"] === "string") return body as QueueBody;
	return null;
}

/**
 * The event a change of state makes, or `null`:
 * - to `down`: `down`, unless the record before was already `down`;
 * - from `down` to `up` or `degraded`: `recovered` (a partial one to `degraded`);
 * - to `degraded` from `up` or from no confirmed state: `degraded`;
 * - from `degraded` to `up`: `degraded_recovered`;
 * - to `stopped` (the monitor left the configuration) from `down` or `degraded`: `stopped`.
 *
 * `previous` is the record just before. For a recovery, `lastConfirmed` (the latest `up`,
 * `degraded` or `down` before it, looking past `unconfirmed` and `stopped`) stands in for it,
 * so that a monitor that stopped or resumed while down still reports its recovery. A first
 * `up` with no confirmed state before is not an event; a first `down` is.
 */
export function classifyChange(previous: string | null, next: string, lastConfirmed: string | null = previous): MonitorEventType | null {
	const before: CheckState | null = previous !== null && isCheckState(previous) ? previous : null;
	// While degraded after a partial recovery, the monitor may still be announced in an incident.
	if (next === "stopped") return before === "down" || before === "degraded" ? "stopped" : null;
	if (!isCheckState(next)) return null;
	if (next === "down") return before === "down" ? null : "down";
	const base: CheckState | null = before ?? (lastConfirmed !== null && isCheckState(lastConfirmed) ? lastConfirmed : null);
	if (base === next) return null;
	if (base === "down") return "recovered";
	if (next === "degraded") return "degraded";
	if (base === "degraded") return "degraded_recovered";
	return null;
}

/** The ID of the event of the state record that began at `since`. */
export function transitionEventId(monitorId: string, since: number): string {
	return `${monitorId}:${since}`;
}

/**
 * The IDs under which the event that a recovery answers may have been sent: the change that
 * began the state it ends, and the same `down` notified once maintenance ended.
 * Empty for other events.
 */
export function pairedEventIds(event: Pick<MonitorEvent, "event" | "monitorId" | "previousSince">): string[] {
	if ((event.event !== "recovered" && event.event !== "degraded_recovered") || event.previousSince === null) return [];
	const id = transitionEventId(event.monitorId, event.previousSince);
	return event.event === "recovered" ? [id, `${id}:after-maintenance`] : [id];
}

function truncate(message: string | null): string | null {
	return message === null || message.length <= MAX_EVENT_MESSAGE ? message : `${message.slice(0, MAX_EVENT_MESSAGE - 1)}…`;
}

/**
 * The events of state records not notified yet (`pending`, oldest first), each compared with
 * the record before it: `before` for the first (the latest record already notified), with
 * `lastConfirmed` the latest confirmed record (`up`, `degraded` or `down`) at or before it.
 * `messageAt` gives the latest check's message when a record was confirmed.
 */
export function eventsFromTransitions(
	monitorId: string,
	before: StateRecord | null,
	pending: readonly StateRecord[],
	messageAt: (record: StateRecord) => string | null,
	lastConfirmed: StateRecord | null = before !== null && isCheckState(before.state) ? before : null,
): MonitorEvent[] {
	const events: MonitorEvent[] = [];
	let previous = before;
	let confirmed = lastConfirmed;
	for (const record of pending) {
		const event = classifyChange(previous?.state ?? null, record.state, confirmed?.state ?? null);
		if (event !== null) {
			// A recovery is about the confirmed state it ends, even across a stop.
			const from = event === "recovered" || event === "degraded_recovered" ? confirmed : previous;
			events.push({
				id: transitionEventId(monitorId, record.since),
				event,
				monitorId,
				// A stopped monitor shows as unknown.
				state: event === "stopped" ? "unknown" : (record.state as CheckState),
				previousState: from !== null && isCheckState(from.state) ? from.state : null,
				since: record.since,
				detectedAt: record.confirmedAt,
				previousSince: from?.since ?? null,
				message: truncate(messageAt(record)),
			});
		}
		previous = record;
		if (isCheckState(record.state)) confirmed = record;
	}
	return events;
}

/** The `down` notified when the maintenance that suppressed `event` has ended, detected at `now`. */
export function afterMaintenanceEvent(event: MonitorEvent, now: number): MonitorEvent {
	const id = event.afterMaintenance ? event.id : `${event.id}:after-maintenance`;
	return { ...event, id, detectedAt: now, afterMaintenance: true };
}
