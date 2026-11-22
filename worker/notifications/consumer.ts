/**
 * The notification queue's consumer, for both the queue and its dead letter queue.
 *
 * - `event` messages: maintenance suppression is decided, the event is fanned out to
 *   one `delivery` message per target that receives it, and automatic incidents are applied. Every step is idempotent, so a failed event message is simply retried.
 *   A recovery (`recovered`, `degraded_recovered`) goes to exactly the targets that the event
 *   it answers went to (`pairedEventIds`), whatever the maintenance and the targets' current
 *   selection of monitors; so a `down` that maintenance held back has no recovery either.
 *   `stopped` (a monitor left the configuration while down) only resolves automatic incidents.
 * - `delivery` messages: the delivery record in D1 is claimed (a duplicate message that finds it
 *   sent is dropped; one that finds it claimed and not finished waits for the claim's lease to
 *   end, as that claim may be its own earlier attempt that lost D1), the target's secrets are
 *   decrypted, the notification is rendered in `locale` and sent; the record then says
 *   `sent`, or `retrying` with the error and the message is retried with backoff, or `failed`
 *   when retrying cannot help or this was the last attempt ({@link MAX_DELIVERY_ATTEMPTS}).
 * - On the dead letter queue (a message whose consumer failed on its last attempt): the
 *   delivery is recorded as `failed`, which the admin UI lists. The dead letter queue is
 *   recognised by its name, which must end in `-dlq` (wrangler.jsonc).
 */
import {
	type NotificationEvent,
	type NotifierKind,
	NotifierError,
	redactSecrets,
} from "@naosystem/cf-workers-status-page-core";
import { translator } from "../../shared/i18n";
import { config, findMonitor, findPage } from "../config";
import {
	claimDelivery,
	finishDelivery,
	getTarget,
	listTargets,
	maintenanceAt,
	FAN_OUT_TARGET,
	pairedTargets,
	recordFanOut,
	recordDeadLetter,
	recordSuppressedDown,
	type TargetRecord,
} from "../db/notifications";
import { ensureSchema } from "../db/schema";
import { USER_AGENT } from "../runners";
import { applyAutoIncident, type AutoEvent, autoIncidentPagesOf } from "./auto-incidents";
import { DecryptionError, EncryptionKeyError } from "./crypto";
import { type MonitorEvent, pairedEventIds, parseQueueBody, type QueueBody } from "./events";
import { MAX_DELIVERY_ATTEMPTS, MAX_RETRY_DELAY_S, RETRY_BASE_S } from "./limits";
import { createIncidentLinks, monitorComponents, type NotifiedEvent, renderEvent } from "./render";
import { maintenanceApplies, suppressedByMaintenance, targetReceives } from "./rules";
import { enqueue } from "./queue";
import { decryptOptions, destinationProblem, secretValues } from "./targets";

/** How long one notification may take to send. */
export const SEND_TIMEOUT_MS = 15_000;
/** A claimed delivery is someone else's to send for this long; then it may be claimed again (a consumer that crashed). */
export const LEASE_MS = 60_000;
/** The dead letter queue's name ends with this (wrangler.jsonc). */
const DEAD_LETTER_SUFFIX = "-dlq";
export { FAN_OUT_TARGET };
/**
 * A recovery whose answered event has not been processed yet (Queues keeps no order) waits for
 * it this many attempts, {@link PAIRING_WAIT_S} apart, then goes to the targets known by then.
 */
export const PAIRING_ATTEMPTS = 5;
export const PAIRING_WAIT_S = 60;
/** On the dead letter queue, retries wait 1 minute, then twice as long each time, up to an hour. */
const DEAD_LETTER_RETRY_BASE_S = 60;
const DEAD_LETTER_MAX_RETRY_S = 3_600;

/** The event a recovery answers was not processed yet: the recovery waits for it. */
export class PairingPending extends Error {
	override readonly name = "PairingPending";
}

/** Whether a batch comes from the dead letter queue: by its name, `<queue>-dlq` in wrangler.jsonc. */
export function isDeadLetterQueue(queue: string): boolean {
	return queue.endsWith(DEAD_LETTER_SUFFIX);
}

/** Seconds until a delivery claimed until `leaseUntil` may be claimed again (a second after its lease ends). */
export function leaseWaitSeconds(leaseUntil: number | null, now: number): number {
	const remaining = Math.max(0, (leaseUntil ?? now + LEASE_MS) - now);
	return Math.ceil(remaining / 1_000) + 1;
}

/** Seconds before retrying a message after its `attempts`-th attempt (see limits.ts). */
export function retryDelaySeconds(attempts: number, retryAfterMs?: number): number {
	const backoff = RETRY_BASE_S * 2 ** Math.max(0, attempts - 1);
	const asked = retryAfterMs === undefined ? 0 : Math.ceil(retryAfterMs / 1_000);
	return Math.min(MAX_RETRY_DELAY_S, Math.max(backoff, asked));
}

/** The fetch notifier kinds use: the global fetch with the hub's User-Agent. */
export function notifierFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = new Request(input, init);
	if (!request.headers.has("User-Agent")) request.headers.set("User-Agent", USER_AGENT);
	// Looked up at call time, so that tests can replace the global fetch.
	return globalThis.fetch(request);
}

export interface Failure {
	readonly message: string;
	readonly retryable: boolean;
	readonly retryAfterMs?: number | undefined;
}

/** What went wrong, with secret values removed from the message. */
export function describeFailure(error: unknown, secrets: readonly string[]): Failure {
	const redact = (message: string) => redactSecrets(message, secrets);
	if (error instanceof NotifierError) {
		return { message: redact(error.message), retryable: error.retryable, retryAfterMs: error.retryAfterMs };
	}
	if (error instanceof EncryptionKeyError) return { message: error.message, retryable: true };
	if (error instanceof DecryptionError) return { message: error.message, retryable: false };
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return { message: `No answer within ${SEND_TIMEOUT_MS / 1_000} seconds`, retryable: true };
	}
	return { message: redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error)), retryable: true };
}

/**
 * Sends `notification` with `kind`, giving up after {@link SEND_TIMEOUT_MS} even if the kind
 * ignores the signal.
 */
export async function sendWithTimeout(
	kind: NotifierKind,
	notification: Parameters<NotifierKind["send"]>[0],
	options: unknown,
): Promise<void> {
	const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DOMException("timed out", "TimeoutError")), SEND_TIMEOUT_MS + 1_000);
	});
	try {
		await Promise.race([kind.send(notification, options, { fetch: notifierFetch as typeof fetch, signal }), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Seconds before retrying a message of the dead letter queue after its `attempts`-th attempt. */
export function deadLetterRetryDelaySeconds(attempts: number): number {
	return Math.min(DEAD_LETTER_MAX_RETRY_S, DEAD_LETTER_RETRY_BASE_S * 2 ** Math.max(0, attempts - 1));
}

/**
 * Handles a batch from the notification queue or its dead letter queue. Never throws: every
 * message is acknowledged or retried with a delay, so that a failure of D1 (an outage, the Free
 * plan's daily limit) backs off instead of using up the retries at once; on the dead letter
 * queue, messages wait for D1 for up to `max_retries` hours (wrangler.jsonc), so that their
 * failure is recorded once it is back.
 */
export async function handleNotificationBatch(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
	const deadLetter = isDeadLetterQueue(batch.queue);
	const delayOf = (attempts: number) => (deadLetter ? deadLetterRetryDelaySeconds(attempts) : retryDelaySeconds(attempts));
	try {
		await ensureSchema(env.DB);
	} catch (error) {
		console.error(`Notifications: D1 is unavailable; retrying ${batch.messages.length} messages later`, error);
		for (const message of batch.messages) message.retry({ delaySeconds: delayOf(message.attempts) });
		return;
	}
	await Promise.all(
		batch.messages.map(async (message) => {
			const body = parseQueueBody(message.body);
			if (body === null) {
				console.warn(`Dropping a notification message this version does not understand (${message.id})`);
				message.ack();
				return;
			}
			try {
				if (deadLetter) await handleDeadLetter(env, body);
				else if (body.type === "event") await handleEvent(env, ctx, body.event, message.attempts);
				else {
					await handleDelivery(env, body.event, body.targetId, message);
					return;
				}
				message.ack();
			} catch (error) {
				if (error instanceof PairingPending) {
					console.log(`Notification message ${message.id}: ${error.message}; waiting`);
					message.retry({ delaySeconds: PAIRING_WAIT_S });
					return;
				}
				console.error(`Notification message ${message.id} (${body.type} ${body.event.id}) failed; retrying`, error);
				message.retry({ delaySeconds: delayOf(message.attempts) });
			}
		}),
	);
}

/**
 * Suppression, fan-out and automatic incidents for one event. `attempts` is the message's
 * attempt: a recovery whose answered event is not processed yet waits for it (throws
 * {@link PairingPending}) during the first {@link PAIRING_ATTEMPTS}.
 */
export async function handleEvent(env: Env, ctx: ExecutionContext, event: MonitorEvent, attempts = PAIRING_ATTEMPTS): Promise<void> {
	const now = Date.now();
	if (event.event === "stopped") {
		await applyStopped(env, ctx, event, now);
		return;
	}
	const monitor = findMonitor(event.monitorId);
	if (monitor === undefined) {
		console.warn(`Dropping event ${event.id}: monitor "${event.monitorId}" is no longer in status.config.ts`);
		return;
	}
	const refs = monitorComponents(config.pages, monitor.id);
	if (maintenanceApplies(event) && refs.length > 0) {
		const pages = [...new Set(refs.map((ref) => ref.pageId))];
		const windows = await maintenanceAt(env.DB, pages, event.detectedAt);
		if (suppressedByMaintenance(refs, windows, event.detectedAt)) {
			// Held back. A `down` is notified when the maintenance ends, if still down (see cron.ts).
			if (event.event === "down") await recordSuppressedDown(env.DB, event, now);
			// Its recovery then goes to no target.
			await recordFanOut(env.DB, event, [], "suppressed", now);
			console.log(`Event ${event.id} (${event.event}) not notified: maintenance`);
			return;
		}
	}

	const enabled = await listTargets(env.DB, { enabledOnly: true });
	const paired = pairedEventIds(event);
	let targets: TargetRecord[];
	if (paired.length > 0) {
		// A recovery: to the targets that heard of what it ends, if they still take recoveries.
		const answered = await pairedTargets(env.DB, paired);
		if (!answered.processed && attempts < PAIRING_ATTEMPTS) {
			throw new PairingPending(`event ${event.id} answers ${paired[0]}, which is not processed yet`);
		}
		targets = enabled.filter((target) => answered.targets.has(target.id) && target.events.includes(event.event as NotificationEvent));
	} else {
		targets = enabled.filter((target) => targetReceives(target, event, refs));
	}
	// Recorded before the messages are queued, so that a recovery processed before them finds them.
	await recordFanOut(
		env.DB,
		event,
		targets.map((target) => target.id),
		"fanned_out",
		now,
	);
	await enqueue(
		env,
		targets.map((target) => ({ type: "delivery", v: 1, event, targetId: target.id })),
	);
	await applyAutoIncidents(env, ctx, event, monitor, now);
}

async function applyAutoIncidents(
	env: Env,
	ctx: ExecutionContext,
	event: MonitorEvent,
	monitor: { readonly id: string; readonly name: string },
	now: number,
): Promise<void> {
	if (event.event !== "down" && event.event !== "recovered" && event.event !== "degraded_recovered") return;
	const typed = event as MonitorEvent & { readonly event: AutoEvent };
	for (const page of config.pages) {
		if (!page.incidents.auto || !page.components.some((component) => component.monitors.includes(monitor.id))) continue;
		await applyAutoIncident({ env, ctx, now }, page, monitor, typed);
	}
}

/**
 * A monitor left the configuration while down: the automatic incidents its `down` opened are
 * resolved ("monitoring stopped"), unless an administrator edited them or another monitor in
 * them is still down. The monitor is on no page any more, so its pages come from D1.
 */
async function applyStopped(env: Env, ctx: ExecutionContext, event: MonitorEvent, now: number): Promise<void> {
	const typed = event as MonitorEvent & { readonly event: "stopped" };
	for (const pageId of await autoIncidentPagesOf(env.DB, event.monitorId)) {
		const page = findPage(pageId);
		if (page === undefined) continue;
		await applyAutoIncident({ env, ctx, now }, page, { id: event.monitorId, name: event.monitorId }, typed);
	}
}

/** Sends one notification to one target, at most once (see the module documentation). */
async function handleDelivery(env: Env, body: MonitorEvent, targetId: string, message: Message<unknown>): Promise<void> {
	if (body.event === "stopped") {
		// Never fanned out; a message like this did not come from this hub.
		message.ack();
		return;
	}
	const event = body as NotifiedEvent;
	const key = { notificationId: event.id, targetId };
	const claim = await claimDelivery(
		env.DB,
		{ ...key, event: event.event, monitorId: event.monitorId, occurredAt: event.since },
		Date.now(),
		LEASE_MS,
	);
	if (!claim.claimed) {
		if (claim.status === "sending") {
			// Claimed and not finished: by another copy of this message, or by an earlier attempt of
			// this very message whose consumer then lost D1 or died before recording an outcome. In
			// the second case no other message is left to finish the delivery, so this one must not
			// be dropped: it waits for the lease, then claims the delivery or finds it sent.
			message.retry({ delaySeconds: leaseWaitSeconds(claim.leaseUntil, Date.now()) });
			return;
		}
		// Sent already: a duplicate.
		message.ack();
		return;
	}

	let secrets: string[] = [];
	try {
		const target = await getTarget(env.DB, targetId);
		if (target === null || !target.enabled) {
			// Deleted or disabled after the fan-out: nothing to send.
			await finishDelivery(env.DB, key, "failed", target === null ? "The target was deleted" : "The target was disabled", Date.now());
			message.ack();
			return;
		}
		const options = await decryptOptions(env, target, config.notifiers.find((kind) => kind.type === target.kind));
		secrets = secretValues(target, options);
		await sendToTarget(target, options, event);
		await finishDelivery(env.DB, key, "sent", null, Date.now());
		message.ack();
	} catch (error) {
		const failure = describeFailure(error, secrets);
		// The last attempt records the failure itself, instead of leaving it to the dead letter queue.
		const retry = failure.retryable && message.attempts < MAX_DELIVERY_ATTEMPTS;
		if (retry) {
			await finishDelivery(env.DB, key, "retrying", failure.message, Date.now());
			message.retry({ delaySeconds: retryDelaySeconds(message.attempts, failure.retryAfterMs) });
		} else {
			await finishDelivery(env.DB, key, "failed", failure.message, Date.now());
			message.ack();
		}
		console.warn(`Notification ${event.id} to target ${targetId}: ${failure.message}${retry ? " (retrying)" : ""}`);
	}
}

/** The registered kind of `target`. @throws NotifierError (not retryable) when it is no longer registered. */
export function kindOf(target: Pick<TargetRecord, "kind">): NotifierKind {
	const kind = config.notifiers.find((candidate) => candidate.type === target.kind);
	if (kind === undefined) {
		throw new NotifierError(`Notifier kind "${target.kind}" is not in status.config.ts`, { retryable: false });
	}
	return kind;
}

/** Validates the target's options against its kind and sends the event's notification. */
async function sendToTarget(target: TargetRecord, options: Record<string, unknown>, event: NotifiedEvent): Promise<void> {
	const kind = kindOf(target);
	const parsed = kind.options.safeParse(options);
	if (!parsed.success) {
		throw new NotifierError(`The target's options are no longer valid for "${kind.type}"; edit the target`, { retryable: false });
	}
	if (destinationProblem(kind, options) !== null) {
		throw new NotifierError("The target's destination is not a public host; edit the target", { retryable: false });
	}
	const monitor = findMonitor(event.monitorId);
	const links =
		target.admin && event.event === "down"
			? createIncidentLinks(config.pages, event.monitorId, config.baseUrl, translator(config.locale))
			: [];
	const notification = renderEvent(event, {
		locale: config.locale,
		timeZone: config.timezone,
		monitorName: monitor?.name ?? event.monitorId,
		links,
	});
	await sendWithTimeout(kind, notification, parsed.data);
}

/** Records a message the queue gave up on (shown as failed in the admin UI). */
async function handleDeadLetter(env: Env, body: QueueBody): Promise<void> {
	const { event } = body;
	if (event.event === "stopped") {
		console.error(`Event ${event.id} (stopped) failed for good: automatic incidents of monitor "${event.monitorId}" stay as they are`);
		return;
	}
	const targetId = body.type === "delivery" ? body.targetId : FAN_OUT_TARGET;
	await recordDeadLetter(
		env.DB,
		{ notificationId: event.id, targetId, event: event.event, monitorId: event.monitorId, occurredAt: event.since },
		// The attempts recorded by the deliveries count; the dead letter queue's own do not.
		0,
		Date.now(),
	);
	console.error(`Notification ${event.id} ${body.type === "delivery" ? `to target ${targetId}` : "(fan-out)"} failed for good`);
}
