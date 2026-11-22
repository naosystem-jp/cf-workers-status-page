/** Sending to the notification queue. Kept apart so that the Monitor DO imports nothing else of notifications. */
import type { QueueBody } from "./events";

/**
 * Queues limits (https://developers.cloudflare.com/queues/platform/limits/): 100 messages and
 * 256 KB per `sendBatch`, 128 KB per message, each message carrying about 100 bytes of
 * metadata. Batches stay below these with a margin.
 */
export const BATCH_MESSAGES = 100;
export const BATCH_BYTES = 192 * 1024;
const MESSAGE_OVERHEAD_BYTES = 200;

const encoder = new TextEncoder();

/** `bodies` in batches of at most {@link BATCH_MESSAGES} messages and {@link BATCH_BYTES} bytes of JSON. */
export function batches(bodies: readonly QueueBody[]): QueueBody[][] {
	const result: QueueBody[][] = [];
	let current: QueueBody[] = [];
	let bytes = 0;
	for (const body of bodies) {
		const size = encoder.encode(JSON.stringify(body)).byteLength + MESSAGE_OVERHEAD_BYTES;
		if (current.length > 0 && (current.length === BATCH_MESSAGES || bytes + size > BATCH_BYTES)) {
			result.push(current);
			current = [];
			bytes = 0;
		}
		current.push(body);
		bytes += size;
	}
	if (current.length > 0) result.push(current);
	return result;
}

/** Queues `bodies` as JSON, in batches within the limits. Resolves once Queues has stored them. */
export async function enqueue(env: Env, bodies: readonly QueueBody[]): Promise<void> {
	for (const batch of batches(bodies)) {
		await env.NOTIFICATIONS.sendBatch(batch.map((body) => ({ body, contentType: "json" as const })));
	}
}
